// The hooks' fallback chain for finding the memory root: CHEAP_MEM_ROOT, then
// the user's own `$HOME/cheap-mem`, nothing else.
//
// **The defect (2026-10-10).** Six POSIX hooks and their six PowerShell twins
// carried `$HOME/cheap-mem` plus two fixed absolute locations as the default
// probe list. Those two are paths of the maintainer's machine. On a shared
// host a hook run by hand (or with `CHEAP_MEM_ROOT` unset) would read a
// stranger's memory from there, and the stop hook would push into it; on
// Windows `/work` means nothing. The overrides (`MEM_RETRIEVE_ROOTS`,
// `MEM_STOP_ROOTS`) stay: a machine with its memory elsewhere says so.
//
// **How this proves it without creating those paths.** The chain is cut out of
// each hook's source (`PROBE=` up to the first `done`) and run in bash with a
// HOME that has no cheap-mem. The two old fixed locations are relocated under
// a scratch prefix by the SAME textual substitution for the old and the new
// source: the old source (pinned commit, read with `git show`) then finds the
// foreign root, the new source has nothing to relocate and finds nothing.
// Positive controls: the old source does find it, and the new chain finds a
// memory by CHEAP_MEM_ROOT, by `$HOME/cheap-mem` and by the override.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTree } from './fixture/cleanup.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fixed commit (origin/main before the change), never a moving merge-base.
const OLD = '0de41883388c5b707c8303a846d1c191a8aa6a59';
const HOOKS = [
  { name: 'mem-retrieve', roots: 'MEM_RETRIEVE_ROOTS' },
  { name: 'mem-stop', roots: 'MEM_STOP_ROOTS' },
  { name: 'mem-before-edit', roots: 'MEM_RETRIEVE_ROOTS' },
  { name: 'mem-after-failure', roots: 'MEM_RETRIEVE_ROOTS' },
  { name: 'mem-catch-fail', roots: 'MEM_RETRIEVE_ROOTS' },
  { name: 'mem-subagent-start', roots: 'MEM_STOP_ROOTS' },
];
// The two old fixed locations, assembled so this file carries no such path.
const FIXED = [['/wo', 'rk/cheap-mem'], ['/home/', 'user/cheap-mem']].map((p) => p.join(''));
const posixOnly = { skip: process.platform === 'win32' ? 'bash chain: POSIX only' : false };

function oldSource(file) {
  const r = spawnSync('git', ['show', `${OLD}:${file}`], { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}
function chainOf(src) {
  const lines = src.split('\n');
  const a = lines.findIndex((l) => l.startsWith('PROBE='));
  assert.ok(a >= 0, 'no PROBE= line');
  const b = lines.findIndex((l, i) => i > a && l === 'done');
  assert.ok(b > a, 'no end of the root loop');
  return lines.slice(a, b + 1).join('\n');
}
function relocate(chain, fake) {
  let out = chain;
  for (const f of FIXED) out = out.split(f).join(fake + f);
  return out;
}
/** Run a chain in bash; returns { root, probe }. */
function run(chain, env) {
  const script = `to_slashes() { printf '%s' "\${1//\\\\//}"; }\n${chain}\nprintf '%s\\n%s' "$ROOT" "$PROBE"`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  const [root, probe] = r.stdout.split('\n');
  return { root, probe };
}
function memoryAt(dir) {
  fs.mkdirSync(path.join(dir, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.mem', 'config.json'), '{}');
  return dir;
}
function scratch() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-root-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  return { base, home, fake: path.join(base, 'fake') };
}

for (const h of HOOKS) {
  const file = `bin/${h.name}`;
  const now = fs.readFileSync(path.join(REPO, file), 'utf8');

  test(`${h.name}: the default chain names only $HOME/cheap-mem`, posixOnly, () => {
    for (const f of FIXED) assert.ok(!now.includes(f), `${file} still names ${f}`);
    assert.match(chainOf(now), new RegExp(`^PROBE="\\$\\{${h.roots}:-\\$HOME/cheap-mem\\}"`));
  });

  test(`${h.name}: RED on the old source, a root at an old fixed place is found; new, it is not`, posixOnly, (t) => {
    const old = oldSource(file);
    if (old === null) return t.skip(`commit ${OLD.slice(0, 7)} not in this clone`);
    const { base, home, fake } = scratch();
    try {
      for (const f of FIXED) {
        const place = memoryAt(path.join(fake, f));
        const env = { HOME: home };
        const before = run(relocate(chainOf(old), fake), env);
        assert.equal(before.root, place, `positive control: the old chain must find ${f}`);
        const after = run(relocate(chainOf(now), fake), env);
        assert.equal(after.root, '', `the new chain must not probe ${f}`);
        removeTree(place);
      }
    } finally { removeTree(base); }
  });

  test(`${h.name}: CHEAP_MEM_ROOT, $HOME/cheap-mem and the override still find a memory`, posixOnly, () => {
    const { base, home } = scratch();
    try {
      const chain = chainOf(now);
      // nothing anywhere -> nothing
      assert.equal(run(chain, { HOME: home }).root, '');
      // $HOME/cheap-mem
      const mine = memoryAt(path.join(home, 'cheap-mem'));
      assert.equal(run(chain, { HOME: home }).root, mine);
      // CHEAP_MEM_ROOT wins over $HOME/cheap-mem
      const named = memoryAt(path.join(base, 'named'));
      assert.equal(run(chain, { HOME: home, CHEAP_MEM_ROOT: named }).root, named);
      // the override replaces the default list
      const elsewhere = memoryAt(path.join(base, 'elsewhere'));
      const ov = run(chain, { HOME: home, [h.roots]: elsewhere });
      assert.equal(ov.root, elsewhere);
      assert.equal(ov.probe, elsewhere);
      const none = run(chain, { HOME: home, [h.roots]: path.join(base, 'nope') });
      assert.equal(none.root, '', 'an override that points nowhere does not fall back to $HOME');
    } finally { removeTree(base); }
  });

  test(`${h.name}.ps1: the default list is Join-Path $HOME 'cheap-mem' and nothing else`, () => {
    const ps = fs.readFileSync(path.join(REPO, `${file}.ps1`), 'utf8');
    for (const f of FIXED) assert.ok(!ps.includes(f), `${file}.ps1 still names ${f}`);
    assert.ok(ps.includes("return @(Join-Path $HOME 'cheap-mem')"), `${file}.ps1 default list`);
    const old = oldSource(`${file}.ps1`);
    if (old !== null) {
      // positive control: the pattern above does see the old defect
      assert.ok(FIXED.every((f) => old.includes(f)), 'the old twin carried both fixed places');
    }
  });
}

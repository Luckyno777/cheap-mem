// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Ratchet: no fixed machine path (`/home/user/...`, `/work/...`, `/root/...`,
// `C:\Users\...`) in the code of this repo, except in a reasoned list that
// only shrinks. Parity with lucky-mem's `test/feste-pfade-ratsche.test.mjs`.
//
// **Why it matters more here than in lucky-mem.** cheap-mem is delivered
// EMPTY, to strangers. A path that exists only in Lucky's environment (the
// cloud box `/home/user/...`, the VM `/work/...`, the agent worktrees
// `/home/user/arbeit/...`) is, in `src/` or `bin/`, either dead weight or —
// worse — a pointer at somebody else's directory. Inventory 2026-10-10:
//   * `src/sibling.mjs` probed `/home/user/lucky-mem` and `/work/lucky-mem`
//     for the sister clone: a real defect, fixed (beside the checkout, or
//     beside the main checkout of a linked worktree, nothing else).
//   * `bench/atlas/phase-real.mjs` read the sister house from a fixed
//     `/home/user/lucky-mem`: a real defect (dev tool, not shipped), fixed
//     with the same lookup. `test/real-phase-fields.test.mjs` likewise.
//   * Everything else is intent: the hooks' documented, overridable probe
//     list (`MEM_RETRIEVE_ROOTS` / `MEM_STOP_ROOTS`), its echo in the env
//     register and docs, comments, and test strings that are the input or
//     the expectation of a probe. Each stands below with its reason.
//
// **The list only shrinks.** Per file it holds the EXACT count. More is a
// new fixed path (red). Fewer is red too: whoever removes a path lowers the
// number or strikes the line (a pawl, like test/english-ratchet.test.mjs).
// A new file never joins; `/home/user/arbeit` (agent worktrees) has no
// exceptions at all.
//
// **Not counted, on purpose:** data files (`*.json`, `*.jsonl`: recorded
// measurements such as `bench/atlas-baseline.json` and the recorded model
// runs under `eval/runs/`), and this file itself (it names the patterns).
//
// **Red proof** against the FIXED commit b5959ed (not a merge-base, which
// would move): there `src/sibling.mjs` and `bench/atlas/phase-real.mjs`
// carry the paths and are on no list, and `siblingClone` finds a clone
// next to nobody. The sabotage probe covers every area and every pattern,
// with a clean tree as positive control.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'test/fixed-paths-ratchet.test.mjs';
const OLD_COMMIT = 'b5959ed';   // before the fix: pinned, never a merge-base
const AREAS = ['src', 'bin', 'bench', 'eval', 'install', 'shared', 'hooks', 'test'];

// An absolute path starts at a path boundary: `src/work/x` is relative.
const B = '(?<![\\w.\\-~}\\])])';
const PATTERNS = {
  '/home/user/': new RegExp(`${B}/home/user/`, 'g'),
  '/work/': new RegExp(`${B}/work/`, 'g'),
  '/root/': new RegExp(`${B}/root/`, 'g'),
  'C:\\Users\\': /[A-Za-z]:[\\/]+Users[\\/]/g,
};
const ARBEIT = /\/home\/user\/arbeit/g;

const WHY_COMMENT = 'Comment or prose only (an example path, a history note); no runtime path';
const WHY_FIXTURE = 'Test fixture: the path is the input or the expectation of a probe, the test never enters it';
const WHY_WIN_EXAMPLE = 'Comment/test text describing a Windows temp or profile path (the bug being guarded), '
  + 'not a path this code uses';

/** file -> { max, why } per pattern. Shrink only. */
const EXCEPTIONS = {
  '/home/user/': {
    'bench/docs-images.mjs': { max: 1, why: 'An invented archive location for the demo board image (a fixed fake, written through the real writers); never read' },
    'test/cmdguard.test.mjs': { max: 1, why: WHY_FIXTURE },
    'test/component-table.test.mjs': { max: 1, why: WHY_COMMENT },
    'test/p14-crypto-shred.test.mjs': { max: 4, why: 'Comments stating the house rule "never git inside the live clones"; the test runs in a mktemp dir' },
    'test/session-start-habits.test.mjs': { max: 1, why: WHY_COMMENT },
    'test/silent-until.test.mjs': { max: 1, why: WHY_COMMENT },
  },
  '/work/': {
    'src/commandguard.mjs': { max: 1, why: 'Comment: the example wording "git pull & /work/" of the command-guard rule syntax' },
    'test/before-edit-journal-file.test.mjs': { max: 3, why: WHY_FIXTURE },
    'test/cmdguard.test.mjs': { max: 6, why: WHY_FIXTURE },
    'test/raw.test.mjs': { max: 1, why: WHY_FIXTURE },
    'test/recall-attach.test.mjs': { max: 2, why: WHY_FIXTURE },
  },
  '/root/': {
    'test/eval-context-guard.test.mjs': { max: 1, why: WHY_COMMENT },
    'test/source-spelling.test.mjs': { max: 1, why: WHY_FIXTURE },
  },
  'C:\\Users\\': {
    'src/doctor.mjs': { max: 2, why: WHY_WIN_EXAMPLE },
    'src/redaction.mjs': { max: 1, why: WHY_WIN_EXAMPLE },
    'bin/mem-before-edit': { max: 4, why: WHY_WIN_EXAMPLE },
    'bin/mem-before-edit.ps1': { max: 1, why: WHY_WIN_EXAMPLE },
    'bin/mem-retrieve.ps1': { max: 1, why: WHY_WIN_EXAMPLE },
    'bin/mem-stop.ps1': { max: 1, why: WHY_WIN_EXAMPLE },
    'hooks/pre-commit': { max: 1, why: WHY_WIN_EXAMPLE },
    'test/before-edit.test.mjs': { max: 2, why: WHY_WIN_EXAMPLE },
    'test/hook-lock-held.test.mjs': { max: 2, why: WHY_WIN_EXAMPLE },
    'test/hook-windows-root.test.mjs': { max: 2, why: WHY_WIN_EXAMPLE },
    'test/install-hooks.test.mjs': { max: 2, why: WHY_WIN_EXAMPLE },
    'test/windows-install.test.mjs': { max: 3, why: WHY_WIN_EXAMPLE },
  },
};

const isData = (name) => /\.jsonl?$|\.(png|webp|jpe?g|gif)$/i.test(name);

/** Every counted file under `base`, relative with forward slashes. */
function collect(base) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = path.posix.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !isData(e.name) && r !== SELF) out.push(r);
    }
  };
  for (const a of AREAS) walk(a);
  return out;
}

/** Count per pattern per file, then compare with the lists. */
function check(base, lists = EXCEPTIONS) {
  const found = {};
  for (const rel of collect(base)) {
    let text;
    try { text = fs.readFileSync(path.join(base, rel), 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;
    for (const [name, re] of Object.entries(PATTERNS)) {
      const n = (text.match(re) || []).length;
      if (n) (found[name] ??= {})[rel] = n;
    }
    const arbeit = (text.match(ARBEIT) || []).length;
    if (arbeit) (found['/home/user/arbeit'] ??= {})[rel] = arbeit;
  }
  const over = [];
  const slack = [];
  for (const [name, files] of Object.entries(found)) {
    for (const [rel, n] of Object.entries(files)) {
      const a = (lists[name] ?? {})[rel];
      if (name === '/home/user/arbeit') over.push(`[${name}] ${rel}: ${n}x, agent worktree paths are never allowed`);
      else if (!a) over.push(`[${name}] ${rel}: ${n}x, not on the list`);
      else if (n > a.max) over.push(`[${name}] ${rel}: ${n}x, at most ${a.max} allowed`);
    }
  }
  for (const [name, files] of Object.entries(lists)) {
    for (const [rel, a] of Object.entries(files)) {
      const n = found[name]?.[rel] ?? 0;
      if (n < a.max) slack.push(`[${name}] ${rel}: found ${n}x, list says ${a.max} - lower the number or strike the line`);
    }
  }
  return { found, over, slack };
}

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('every exception carries a real reason and a positive count; only known patterns', () => {
  assert.deepEqual(Object.keys(EXCEPTIONS).sort(), Object.keys(PATTERNS).sort());
  for (const [name, files] of Object.entries(EXCEPTIONS)) {
    for (const [rel, a] of Object.entries(files)) {
      assert.ok(a.why && a.why.length > 20, `${name} ${rel}: reason missing`);
      assert.ok(Number.isInteger(a.max) && a.max > 0, `${name} ${rel}: max must be > 0`);
      assert.match(rel, /^(src|bin|bench|eval|install|shared|hooks|test)\//, rel);
    }
  }
});

test('the tree: no fixed path beyond the list, and the list is not too generous', () => {
  const r = check(ROOT);
  assert.deepEqual(r.over, []);
  assert.deepEqual(r.slack, []);
});

test('shipped code (src/, install/, shared/) has no fixed path of the maintainer, except documented echoes', () => {
  // src/ ships. Only two comments may name such a path; a runtime path here is a stranger's bug.
  const shippedRuntime = Object.entries(EXCEPTIONS).flatMap(([name, files]) =>
    Object.keys(files).filter((f) => f.startsWith('src/') || f.startsWith('install/') || f.startsWith('shared/'))
      .map((f) => `${name} ${f}`));
  assert.deepEqual(shippedRuntime.sort(), [
    '/work/ src/commandguard.mjs',
    'C:\\Users\\ src/doctor.mjs',
    'C:\\Users\\ src/redaction.mjs',
  ].sort());
});

test('SABOTAGE + POSITIVE CONTROL: every area and every pattern is caught, a clean tree and data files are not', () => {
  const w = scratch('cm-fixed-paths-');
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(w, rel)), { recursive: true });
    fs.writeFileSync(path.join(w, rel), text);
  };
  const areas = AREAS.map((a) => `${a}/x/probe.sh`);
  for (const rel of areas) put(rel, '# nothing here\nsrc/work/ok relative/root/ok\n');
  assert.deepEqual(check(w, {}).over, [], 'positive control: a clean tree is quiet');
  const samples = { '/home/user/': '/home/user/x', '/work/': '/work/x', '/root/': '/root/x', 'C:\\Users\\': 'C:\\\\Users\\\\x' };
  for (const [name, sample] of Object.entries(samples)) {
    for (const rel of areas) put(rel, `X='${sample}'\n`);
    const r = check(w, {});
    assert.equal(r.over.filter((v) => v.startsWith(`[${name}]`)).length, areas.length, `${name}: ${r.over.join('\n')}`);
    for (const rel of areas) put(rel, '# nothing here\n');
  }
  // forward-slash Windows spelling too
  put('src/x/probe.sh', 'D="C:/Users/runner"\n');
  assert.equal(check(w, {}).over.length, 1);
  put('src/x/probe.sh', '# nothing here\n');
  // agent worktree paths are never allowed, even if somebody lists them
  put('bin/x/probe.sh', 'W=/home/user/arbeit/wt-a\n');
  const withList = check(w, { '/home/user/': { 'bin/x/probe.sh': { max: 1, why: 'x'.repeat(30) } } });
  assert.ok(withList.over.some((v) => v.includes('/home/user/arbeit')), withList.over.join('\n'));
  put('bin/x/probe.sh', '# nothing here\n');
  // data files and this file are not counted
  put('eval/runs/r.jsonl', '{"p":"/home/user/cheap-mem"}\n');
  put('bench/base.json', '{"repo":"/home/user/cheap-mem"}\n');
  put(SELF, '/home/user/x /work/x /root/x C:\\\\Users\\\\x\n');
  assert.deepEqual(check(w, {}).over, []);
  // outside the areas nothing is looked at
  put('docs/note.md', '/home/user/cheap-mem\n');
  assert.deepEqual(check(w, {}).over, []);
  // exact count: more is red, fewer is slack
  put('src/x/probe.sh', '/work/a /work/b\n');
  const one = { '/work/': { 'src/x/probe.sh': { max: 1, why: 'x'.repeat(30) } } };
  assert.equal(check(w, one).over.length, 1);
  const three = { '/work/': { 'src/x/probe.sh': { max: 3, why: 'x'.repeat(30) } } };
  assert.equal(check(w, three).slack.length, 1);
  assert.equal(check(w, { '/work/': { 'src/x/probe.sh': { max: 2, why: 'x'.repeat(30) } } }).slack.length, 0);
});

/** Files of the OLD commit, extracted to a scratch dir; null when the clone does not have it. */
function oldStand(paths) {
  const dest = scratch('cm-fixed-paths-old-');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const tar = execFileSync('git', ['-C', ROOT, 'archive', OLD_COMMIT, ...paths], { env, maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dest], { input: tar, env });
    return dest;
  } catch { return null; }
}

test(`RED PROOF on the fixed commit ${OLD_COMMIT}: the sister-clone lookups carried the maintainer's paths`, (t) => {
  const old = oldStand(['src/sibling.mjs', 'bench/atlas/phase-real.mjs']);
  if (!old) return t.skip('commit not in this clone (shallow clone)');
  const r = check(old);
  assert.ok(r.over.some((v) => v.startsWith('[/home/user/] src/sibling.mjs')), r.over.join('\n'));
  assert.ok(r.over.some((v) => v.startsWith('[/work/] src/sibling.mjs')), r.over.join('\n'));
  assert.ok(r.over.some((v) => v.startsWith('[/home/user/] bench/atlas/phase-real.mjs')), r.over.join('\n'));
  // and the new tree is clean on exactly these two files
  const now = check(ROOT);
  assert.ok(!now.found['/home/user/']?.['src/sibling.mjs'] && !now.found['/work/']?.['src/sibling.mjs']);
  assert.ok(!now.found['/home/user/']?.['bench/atlas/phase-real.mjs']);
});

test('BEHAVIOUR: siblingClone looks beside the checkout and beside the main checkout of a worktree, nowhere else', async (t) => {
  const { siblingClone } = await import('../src/sibling.mjs');
  const w = scratch('cm-sibling-');
  const mk = (...p) => { fs.mkdirSync(path.join(w, ...p), { recursive: true }); return path.join(w, ...p); };
  // a stranger's tree with no clone next to it: nothing, whatever exists on this machine
  const lone = mk('lone', 'cheap-mem');
  assert.equal(siblingClone(lone), null);
  // positive control 1: a lucky-mem beside the checkout is found
  const beside = mk('a', 'cheap-mem');
  const sister = mk('a', 'lucky-mem');
  assert.equal(siblingClone(beside), sister);
  // positive control 2: a linked worktree elsewhere finds the sister beside its MAIN checkout
  const main = mk('b', 'cheap-mem');
  const sister2 = mk('b', 'lucky-mem');
  mk('b', 'cheap-mem', '.git', 'worktrees', 'wt-x');
  const wt = mk('elsewhere', 'wt-x');
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt-x')}\n`);
  assert.equal(siblingClone(wt), sister2);
  // a worktree whose main checkout has no sister: nothing
  const main3 = mk('c', 'cheap-mem');
  mk('c', 'cheap-mem', '.git', 'worktrees', 'wt-y');
  const wt3 = mk('elsewhere', 'wt-y');
  fs.writeFileSync(path.join(wt3, '.git'), `gitdir: ${path.join(main3, '.git', 'worktrees', 'wt-y')}\n`);
  assert.equal(siblingClone(wt3), null);
  // an explicit place wins and is checked for existence
  assert.equal(siblingClone(lone, sister), sister);
  assert.equal(siblingClone(lone, path.join(w, 'nope')), null);

  // red proof: the old module, run from a scratch dir, finds a clone for the lone tree
  // whenever one of its fixed places exists on this machine
  const old = oldStand(['src/sibling.mjs']);
  if (!old) return t.skip('commit not in this clone (shallow clone)');
  const oldMod = await import(pathToFileURL(path.join(old, 'src', 'sibling.mjs')).href);
  const fixedExists = ['/home/user/lucky-mem', '/work/lucky-mem'].some((p) => fs.existsSync(p));
  if (fixedExists) assert.notEqual(oldMod.siblingClone(lone), null, 'the old lookup invented a clone for a stranger');
  else t.diagnostic('no fixed place exists on this machine: the behaviour red proof is vacuous here, the tree check above still holds');
});

// hooks-harden-cm / D5 - a HOME with a space in it must not break the default memory search.
//
// The finding: six bash hooks (mem-before-edit, mem-retrieve, mem-after-failure, mem-catch-fail, mem-stop,
// mem-subagent-start) looked for the memory with `for k in "$CHEAP_MEM_ROOT" $PROBE` - an UNQUOTED $PROBE, whose
// default is "$HOME/cheap-mem". With HOME=/home/Max Muster that is two words, neither is a memory, and the hook
// exits 0 in silence: "nothing to report", indistinguishable from a memory with nothing to say. Installed hooks
// bake in CHEAP_MEM_ROOT and never noticed; a hand-run hook, a fresh machine without the installer's variable
// and every test that leaves it unset did. The `# shellcheck disable=SC2086` above each loop said it was known.
//
// Inventory (2026-10-14, shellcheck 0.11.0 over every hook in bin/ and install/hooks/, then grep): the six
// loops above were the only unquoted PATH expansions. Left alone on purpose, with a reason: `$CMD` in mem-digest,
// mem-handle-post, mem-reflect (a configured command LINE with flags - word splitting is its contract; a program
// path with a space cannot be written there, and no HOME is involved), `$RECORD_PATHS` in mem-stop (two repo-relative
// constants). In PowerShell: the whitespace split of MEM_RETRIEVE_ROOTS / MEM_STOP_ROOTS in six twins, and
// mem-digest.ps1's Start-Process with an argument ARRAY of paths (joined with bare spaces on Windows PowerShell 5.1).
//
// Probes: the loop of each hook, cut out of the real file and run under `set -u`, finds the memory with a space in
// HOME, with a single path with a space in the roots variable, with a list of words; an unset HOME does not crash.
// POSITIVE CONTROL: the OLD loop (unquoted) is run on the same cases and does NOT find it. MUTATION: each hook with
// the loop made unquoted again fails the probe. A real hook (before-edit) is run end to end from a HOME with a space.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import { waitForRebuildIdle } from '../src/component-table.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const sl = (p) => p.replaceAll('\\', '/');

const HOOKS = {
  'mem-before-edit': 'MEM_RETRIEVE_ROOTS', 'mem-retrieve': 'MEM_RETRIEVE_ROOTS', 'mem-after-failure': 'MEM_RETRIEVE_ROOTS',
  'mem-catch-fail': 'MEM_RETRIEVE_ROOTS', 'mem-stop': 'MEM_STOP_ROOTS', 'mem-subagent-start': 'MEM_STOP_ROOTS',
};

/** The root lookup of a hook, cut out of its real text: from `PROBE=` to the line that bails out without a root. */
function lookup(text) {
  const a = text.search(/^PROBE=/m);
  const rest = text.slice(a);
  const b = rest.search(/^\[ -z "\$ROOT" \] && /m);
  assert.ok(a >= 0 && b > 0, 'the root lookup moved - the probe cannot cut it out');
  return rest.slice(0, b);
}

/** Run a lookup snippet; returns what ROOT came out as. */
function find(snippet, env) {
  const script = `set -u\nto_slashes() { printf '%s' "\${1//\\\\//}"; }\nROOT=""\n${snippet}\nprintf '%s' "$ROOT"`;
  const full = { PATH: process.env.PATH, ...env };
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: full });
  assert.equal(r.status, 0, `${r.stderr}\n--- script ---\n${script}`);
  return r.stdout;
}

function world(t) {
  const base = tempDir('cm-spc-', t);
  const home = path.join(base, 'home with space');
  const root = path.join(home, 'cheap-mem');
  fs.mkdirSync(root, { recursive: true });
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  return { base, home, root };
}

for (const [name, rootsVar] of Object.entries(HOOKS)) {
  test(`${name}: the memory is found from a HOME with a space, with one path or a list in ${rootsVar}`, (t) => {
    const { base, home, root } = world(t);
    const text = fs.readFileSync(path.join(REPO, 'bin', name), 'utf8');
    const snippet = lookup(text).replace(/\n\s*trace "[^\n]*\n/g, '\n');
    const other = path.join(base, 'plain-root');
    fs.mkdirSync(path.join(other, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(other, '.mem', 'config.json'), '{}');

    assert.equal(find(snippet, { HOME: sl(home) }), sl(root), 'the default $HOME/cheap-mem was not found');
    assert.equal(find(snippet, { HOME: sl(home), [rootsVar]: sl(root) }), sl(root), 'one path with a space in the roots variable');
    assert.equal(find(snippet, { HOME: '/nonexistent', [rootsVar]: `/nonexistent/a ${sl(other)}` }), sl(other), 'a list of words');
    assert.equal(find(snippet, { HOME: '/nonexistent', [rootsVar]: `/nonexistent/a   ${sl(other)}  ` }), sl(other), 'extra blanks');
    assert.equal(find(snippet, { HOME: '/nonexistent' }), '', 'no memory: ROOT stays empty');
    assert.equal(find(snippet, {}), '', 'HOME unset (set -u): no crash, no memory');
    // The roots variable must not be globbed: a `*` in it is a character, not a pattern.
    assert.equal(find(snippet, { HOME: '/nonexistent', [rootsVar]: `${sl(base)}/${'*'}` }), '', 'a glob in the roots variable was expanded');
  });
}

test('POSITIVE CONTROL: the OLD loop (unquoted $PROBE) does not find the memory in the same world', (t) => {
  const { home } = world(t);
  const old = `PROBE="\${MEM_RETRIEVE_ROOTS:-$HOME/cheap-mem}"\nfor k in "\${CHEAP_MEM_ROOT:-}" $PROBE; do\n  [ -z "$k" ] && continue\n  k="$(to_slashes "$k")"\n  [ -f "$k/.mem/config.json" ] && { ROOT="$k"; break; }\ndone`;
  assert.equal(find(old, { HOME: sl(home) }), '', 'the old loop found it - the scenario does not trigger the bug, the probe measures nothing');
  assert.equal(find(old, { HOME: '/nonexistent', MEM_RETRIEVE_ROOTS: '/x' }), '');
});

test('MUTATION: each hook with the loop made unquoted again fails the probe', (t) => {
  const { home } = world(t);
  for (const [name, rootsVar] of Object.entries(HOOKS)) {
    const text = fs.readFileSync(path.join(REPO, 'bin', name), 'utf8');
    const loop = 'for k in "${CHEAP_MEM_ROOT:-}" ${PROBE_LIST[@]+"${PROBE_LIST[@]}"}; do';
    assert.equal(text.split(loop).length, 2, `${name}: the loop line the mutation hits moved`);
    const mutated = lookup(text.replace(loop, 'for k in "${CHEAP_MEM_ROOT:-}" $PROBE; do')).replace(/\n\s*trace "[^\n]*\n/g, '\n');
    assert.equal(find(mutated, { HOME: sl(home) }), '', `${name}: the mutated (unquoted) loop still found the memory`);
    assert.ok(rootsVar);
  }
});

test('no hook keeps a shellcheck waiver for unquoted word splitting on a path', () => {
  for (const name of Object.keys(HOOKS)) {
    const text = fs.readFileSync(path.join(REPO, 'bin', name), 'utf8');
    assert.doesNotMatch(text, /shellcheck disable=SC2086\nfor k in /, `${name}: the root loop is waived again`);
    assert.doesNotMatch(text, /for k in [^\n]*\s\$PROBE\b/, `${name}: an unquoted $PROBE in the root loop`);
  }
});

test('END TO END: mem-before-edit run by hand from a HOME with a space answers (no CHEAP_MEM_ROOT, no roots variable)', (t) => {
  const { home, root } = world(t);
  memory.logEntry(root, 'error', { class: 'unquoted-path', title: 'install/claude-code.sh does not quote the bash path', text: 'install/claude-code.sh breaks on a space' });
  const env = { ...process.env, HOME: home, USERPROFILE: home, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '', MEM_BEFORE_EDIT_TRACE: '1' };
  delete env.CHEAP_MEM_ROOT; delete env.MEM_RETRIEVE_ROOTS;
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'mem-before-edit')], {
    input: JSON.stringify({ session_id: 'sp', tool_name: 'Edit', tool_input: { file_path: '/p/install/claude-code.sh' } }),
    encoding: 'utf8', env, timeout: 60000,
  });
  waitForRebuildIdle(root); // a detached component-table rebuild may hold the directory
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /exit at no-root/, 'the hook found no memory');
  assert.match(r.stdout, /memory knows install\/claude-code\.sh/);
  assert.ok(fs.existsSync(path.join(root, '.pipeline', 'injections.jsonl')), 'no journal line - the hook did not get as far as a query');
});

test('PowerShell twins: the whole roots value is tried before its words; the gold spawn passes ONE quoted argument string', () => {
  const ps = (n) => fs.readFileSync(path.join(REPO, 'bin', n), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  for (const [name, rootsVar] of Object.entries(HOOKS)) {
    const text = ps(`${name}.ps1`);
    assert.match(text, new RegExp(`return @\\(\\$env:${rootsVar}\\) \\+ \\(\\$env:${rootsVar} -split '\\\\s\\+'`), `${name}.ps1 splits ${rootsVar} without trying the whole value`);
    assert.doesNotMatch(text, new RegExp(`return \\$env:${rootsVar} -split '\\\\s\\+'`), `${name}.ps1 still returns only the split words`);
    assert.match(text, /Join-Path \$HOME 'cheap-mem'/, `${name}.ps1: the default root is not built with Join-Path`);
  }
  const digest = ps('mem-digest.ps1');
  assert.match(digest, /\$GoldArgs = '"\{0\}" --root "\{1\}" gold miss daily' -f \$Mem, \$Root/);
  assert.match(digest, /Start-Process -FilePath 'node' -ArgumentList \$GoldArgs/);
  assert.doesNotMatch(digest, /-ArgumentList @\(\$Mem/, 'the gold spawn passes an argument array of paths again');
});

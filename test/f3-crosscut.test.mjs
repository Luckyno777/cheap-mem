// test/f3-crosscut.test.mjs — cross-cutting patterns from the error audit (F3).
//
//  A.3  `Date.parse(x ?? 0) || 0`: a missing time is UNKNOWN, not 2000-01-01.
//  A.5  write regex `>>?\s*\S`: `2>&1`, `2>/dev/null`, `=>` are not a write.
//  A.4  main guard `file://${process.argv[1]}` breaks on spaces in the path.
//  A.7  `Object.freeze(new Set())` does not freeze the contents.
//  A.5b default branch: bench scripts must not assume `master`.
//
// Every probe has a positive control: a case that MUST see what the fix no
// longer mistakes — otherwise the probe would be green for the wrong reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { resolveFacts } from '../src/freshness.mjs';
import { classifyCommand, COMMAND_KIND, writesViaRedirect, BOOKKEEPING } from '../src/gauges.mjs';
import { frozenSet } from '../src/frozenset.mjs';
import { MACHINE_FIELDS, coreFacts } from '../src/memory.mjs';
import { CONFIRMATION_WORDS } from '../src/recallsignal.mjs';
import { DERIVED } from '../src/dashboard-cache.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- A.3 Date.parse ----------------------------------------------------
const NOW = new Date('2026-09-01T00:00:00Z');

test('A.3 fact without a time: age unknown (null), not stale, not 2000-01-01', () => {
  const [f] = resolveFacts([{ id: 'a', key: 'k', value: 'x' }], { now: NOW, staleDays: 120 });
  assert.equal(f.ageDays, null);
  assert.equal(f.stale, false);
});

test('A.3 positive control: a dated old fact is stale, with a number', () => {
  const [f] = resolveFacts([{ id: 'a', key: 'k', value: 'x', valid_from: '2026-01-01' }], { now: NOW });
  assert.equal(f.stale, true);
  assert.equal(typeof f.ageDays, 'number');
});

test('A.3 an undated version sorts behind every dated one and never becomes "current"', () => {
  const e = [
    { id: 'u', key: 'k', value: 'undated' },
    { id: 'd', key: 'k', value: 'dated', valid_from: '2000-01-02' },
  ];
  const [f] = resolveFacts(e, { now: NOW });
  assert.equal(f.current.value, 'dated');
  assert.deepEqual(f.history.map((h) => h.value), ['undated']);
});

test('A.3 coreFacts ranks an undated fact last', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f3-core-'));
  try {
    const dir = path.join(root, 'global');
    fs.mkdirSync(dir, { recursive: true });
    const rows = [
      { id: 'u', ts: 'kaputt', key: 'zz.undated', value: 'u' },
      { id: 'd', ts: '2026-08-30T00:00:00Z', key: 'aa.dated', value: 'd' },
    ];
    fs.writeFileSync(path.join(dir, 'timeline.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const { kept } = coreFacts(root, { now: NOW, max: 1 });
    // with budget 1 the dated fact must win; the undated one used to rank as 2000-01-01
    assert.ok(kept.length <= 1);
    if (kept.length) assert.equal(kept[0].key, 'aa.dated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---- A.5 write redirect ------------------------------------------------
const NOT_WRITING = [
  ['cat src/a.mjs 2>&1', COMMAND_KIND.READ],
  ['grep -rn foo src 2>/dev/null', COMMAND_KIND.SEARCH],
  ['grep -n "=>" src/a.mjs', COMMAND_KIND.SEARCH],
  ['rg x >/dev/null 2>&1', COMMAND_KIND.SEARCH],
  ['cat a.txt 1>&2', COMMAND_KIND.READ],
  ['grep "a > b" f.txt', COMMAND_KIND.SEARCH],
  ['ls 2> /dev/null', COMMAND_KIND.SEARCH],
];
const REAL_WRITES = [
  'cat > /tmp/x.mjs', 'echo a >> log.txt', 'cmd &> out.txt', 'cmd 2> err.txt',
  "cat > \"x y\" <<'EOF'", 'echo hi >file', 'cat <<EOF',
];
for (const [cmd, kind] of NOT_WRITING) {
  test(`A.5 not a write: ${cmd}`, () => {
    assert.equal(writesViaRedirect(cmd), false);
    assert.equal(classifyCommand(cmd), kind);
  });
}
for (const cmd of REAL_WRITES) {
  test(`A.5 positive control, real redirect: ${cmd}`, () => {
    assert.equal(writesViaRedirect(cmd), true);
    assert.equal(classifyCommand(cmd), COMMAND_KIND.WRITE);
  });
}

// ---- A.4 main guard ----------------------------------------------------
const OLD = 'import.meta.url === `file://${process.argv[1]}`';
const NEW = 'process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href';

function run(guard, dir) {
  const file = path.join(dir, 'main.mjs');
  fs.writeFileSync(file, `import { pathToFileURL } from 'node:url';\nimport { resolve } from 'node:path';\n`
    + `if (${guard}) console.log('MAIN');\n`);
  return execFileSync(process.execPath, [file], { encoding: 'utf8' }).trim();
}

test('A.4 guard expression: old fails on a space in the path, new does not (red/green + positive control)', () => {
  // realpath: on macOS os.tmpdir() is under the /var -> /private/var symlink;
  // node resolves the entry file's real path for import.meta.url but leaves
  // argv[1] as typed, so the OLD guard fails even without a space there.
  const plain = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'f3-guard-'));
  const spaced = path.join(plain, 'a folder');
  fs.mkdirSync(spaced);
  try {
    // On win32 the OLD expression builds file://C:\\... while import.meta.url
    // is file:///C:/..., so it misses the entry file with or without a space:
    // the "works without a space" control is a POSIX fact, skipped there
    // (NOTICE: UNVERIFIED on Windows here; the NEW expression is what matters).
    if (process.platform !== 'win32') {
      assert.equal(run(OLD, plain), 'MAIN', 'positive control: without a space the old one works too');
    } else {
      assert.equal(run(OLD, plain), '', 'win32: the old expression never matches a drive-letter path');
    }
    assert.equal(run(OLD, spaced), '', 'the old expression misses the entry file when the path has a space');
    assert.equal(run(NEW, spaced), 'MAIN');
    assert.equal(run(NEW, plain), 'MAIN');
  } finally { fs.rmSync(plain, { recursive: true, force: true }); }
});

test('A.4 no tracked source contains the old guard any more', () => {
  const files = execFileSync('git', ['ls-files', '*.mjs', '*.js'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => !f.startsWith('test/') && !f.startsWith('assets/'));
  const old = /import\.meta\.url\s*[!=]==?\s*`file:\/\/\/?\$\{process\.argv\[1\]\}`/;
  const hits = files.filter((f) => old.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(hits, []);
});

test('A.4 positive control: the scan sees the old guard', () => {
  assert.match(`if (${OLD}) main();`, /import\.meta\.url\s*[!=]==?\s*`file:\/\/\/?\$\{process\.argv\[1\]\}`/);
});

// ---- A.5b default branch ----------------------------------------------
test('A.5b bench scripts do not assume a `master` branch', () => {
  for (const f of ['bench/overlooked.mjs', 'bench/composed.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /'checkout',\s*'-q',\s*'master'/, `${f} must ask for the default branch`);
    assert.match(src, /symbolic-ref/, `${f} asks git for the branch`);
  }
});

test('A.5b behaviour: a repo whose default branch is not master still works (git merge scenario)', () => {
  const env = { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'init.defaultBranch', GIT_CONFIG_VALUE_0: 'trunk' };
  const out = execFileSync(process.execPath, [path.join(ROOT, 'bench/overlooked.mjs')], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  assert.match(out, /\[C\] git merge/);
});

// ---- A.7 frozen sets ---------------------------------------------------
const SETS = { BOOKKEEPING, MACHINE_FIELDS, CONFIRMATION_WORDS, DERIVED };
for (const [name, set] of Object.entries(SETS)) {
  test(`A.7 ${name}: a real set with no add/delete/clear; has/size/iteration work`, () => {
    for (const fn of ['add', 'delete', 'clear']) assert.equal(set[fn], undefined, `${name}.${fn} must not exist`);
    assert.ok(set.size > 0);
    const first = [...set][0];
    assert.equal(set.has(first), true);
    assert.equal(set.has('__does-not-exist__'), false);
    assert.ok(Object.isFrozen(set.values));
    assert.throws(() => { set.values.push('x'); }, TypeError);
  });
}

test('A.7 positive control: Object.freeze(new Set()) stays mutable (that was the defect)', () => {
  const old = Object.freeze(new Set(['a']));
  old.add('b');
  assert.equal(old.has('b'), true);
  const fixed = frozenSet(['a']);
  assert.throws(() => fixed.add('b'), TypeError);
  assert.equal(fixed.has('b'), false);
});

test('A.7 no Object.freeze(new Set|Map) call left in src/', () => {
  let out = '';
  try {
    out = execFileSync('git', ['grep', '-nE', 'Object\\.freeze\\(\\s*new (Set|Map)', '--', 'src'],
      { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) { if (e.status !== 1) throw e; } // 1 = no match
  const code = out.split('\n').filter((l) => l && !/^[^:]+:\d+:\s*(\/\/|\*|\/\*)/.test(l));
  assert.deepEqual(code, []);
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Parity build for lucky-mem's M12 (BAUPLAN-mem-admin_02.md §0 rule 2):
// `mem log error --file` lays down a test scaffold
// `test/error-<id>.test.mjs` (marker `// error: <id>`, sections
// Sabotage / positive control / red on the old stand). Empty must NEVER
// pass as a green test or as F4 evidence. Measure: share of errors with
// a guard (`mem guard quote`).
//
// Red on the old stand: before this build, `mem log error --file` laid
// nothing down at all, and `mem guard quote` did not exist — every test
// below that touches either would fail outright (module not found /
// unknown subcommand) against that stand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-scaffold-'));
  const init = spawnSync('node', [MEM, '--root', r, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return r;
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
function cli(root, argv) {
  return spawnSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8' });
}
function output(r) { return `${r.stdout}\n${r.stderr}`; }
function idFrom(out) { return /id: (\S+)/.exec(out)?.[1]; }
// A run of the generated scaffold itself, without NODE_TEST_CONTEXT
// (otherwise the child reports into THIS run instead of onto its own stdout).
const childEnv = () => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e; };
const run = (p) => spawnSync(process.execPath, ['--test', '--test-reporter=tap', p],
  { encoding: 'utf8', env: childEnv() });

function logError(r, ...extra) {
  const x = cli(r, ['log', 'error', '--class', 'looks-fine-does-nothing', '--title', 'counter double-counts',
    ...extra]);
  assert.equal(x.status, 0, output(x));
  const id = idFrom(x.stdout);
  assert.ok(id, x.stdout);
  return { id, out: x.stdout };
}

test('--file lays down a scaffold with the marker and three sections', () => {
  const r = build();
  try {
    const { id, out } = logError(r, '--file', 'src/counter.mjs');
    const p = path.join(r, 'test', `error-${id}.test.mjs`);
    assert.ok(fs.existsSync(p), `no scaffold; output:\n${out}`);
    const t = fs.readFileSync(p, 'utf8');
    assert.ok(t.includes(`// error: ${id}\n`));
    for (const s of ['Sabotage', 'Positive control', 'Red on the old stand']) {
      assert.match(t, new RegExp(`--- ${s}`));
    }
    assert.match(out, /Test scaffold laid down/);
  } finally { gone(r); }
});

test('SABOTAGE: an empty scaffold never runs green — 0 pass, 3 todo', () => {
  const r = build();
  try {
    const { id } = logError(r, '--file', 'src/counter.mjs');
    const p = path.join(r, 'test', `error-${id}.test.mjs`);
    assert.ok(fs.existsSync(p), 'no scaffold laid down');
    const x = run(p);
    assert.match(x.stdout, /^# pass 0$/m, x.stdout);
    assert.match(x.stdout, /^# todo 3$/m, x.stdout);
    assert.match(x.stdout, /empty is not passing/);
  } finally { gone(r); }
});

test('SABOTAGE: an empty scaffold is not F4 evidence, even with test( left in the file', () => {
  const r = build();
  try {
    const { id } = logError(r, '--file', 'src/counter.mjs');
    const p = path.join(r, 'test', `error-${id}.test.mjs`);
    assert.ok(fs.existsSync(p), 'no scaffold laid down');
    // Somebody adds a `test(` but leaves the marker and the todos in place.
    fs.appendFileSync(p, "\n// later: test('x', () => {});\n");
    const ev = memory.dutyHasEvidence(r, { id: 'd1', error_ids: [id] });
    assert.equal(ev.ok, false, `empty scaffold counted as evidence: ${ev.why}`);
  } finally { gone(r); }
});

test('POSITIVE CONTROL: a filled scaffold without the empty marker IS evidence', () => {
  const r = build();
  try {
    const { id } = logError(r, '--file', 'src/counter.mjs');
    const p = path.join(r, 'test', `error-${id}.test.mjs`);
    assert.ok(fs.existsSync(p), 'no scaffold laid down');
    const filled = fs.readFileSync(p, 'utf8')
      .split('\n').filter((l) => l.trim() !== '// scaffold: empty').join('\n')
      .replace(/test\.todo\(("[^"]*")\);/g, 'test($1, () => { assert.equal(1, 1); });');
    fs.writeFileSync(p, filled);
    const ev = memory.dutyHasEvidence(r, { id: 'd1', error_ids: [id] });
    assert.equal(ev.ok, true, ev.why);
    const x = run(p);
    assert.match(x.stdout, /^# pass 3$/m, x.stdout);
  } finally { gone(r); }
});

test('no --file, --without-scaffold, and an existing file: never a new scaffold', async () => {
  const r = build();
  try {
    const a = logError(r);
    assert.ok(!fs.existsSync(path.join(r, 'test', `error-${a.id}.test.mjs`)));
    const b = logError(r, '--file', 'src/counter.mjs', '--without-scaffold');
    assert.ok(!fs.existsSync(path.join(r, 'test', `error-${b.id}.test.mjs`)));
    const entry = memory.readLog(r, 'error').entries.find((e) => e.id === b.id);
    assert.equal(entry['without-scaffold'], undefined, 'the switch became a field');

    // An existing file is never overwritten.
    const ps = await import('../src/probescaffold.mjs');
    const target = path.join(r, 'test', `error-${a.id}.test.mjs`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'MINE\n');
    const g = ps.lay(r, { id: a.id, file: 'src/counter.mjs', title: 't' });
    assert.equal(g.created, false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'MINE\n');
  } finally { gone(r); }
});

test('mem guard quote: counts errors with a guard and empty scaffolds', async () => {
  const r = build();
  try {
    const a = logError(r, '--file', 'src/a.mjs');
    logError(r);
    let x = cli(r, ['guard', 'quote']);
    assert.equal(x.status, 0, output(x));
    assert.match(x.stdout, /^OK {2}guardquote {2}0 of 2 errors with a guard \(0\.0%\), 1 empty scaffolds$/m,
      output(x));

    // Stalled: the same empty scaffold 20 days later is a WARNING.
    const ps = await import('../src/probescaffold.mjs');
    const all = memory.readLog(r, 'error').entries;
    const q = ps.quote(r, all, { now: new Date(Date.now() + 20 * 86400000) });
    assert.equal(q.state, 'warning');
    assert.equal(q.stale.length, 1);

    // Filling it in counts as a guard.
    const p = path.join(r, 'test', `error-${a.id}.test.mjs`);
    fs.writeFileSync(p, `// error: ${a.id}\nimport test from 'node:test';\ntest('real', () => {});\n`);
    x = cli(r, ['guard', 'quote']);
    assert.match(x.stdout, /1 of 2 errors with a guard \(50\.0%\), 0 empty/, output(x));
  } finally { gone(r); }
});

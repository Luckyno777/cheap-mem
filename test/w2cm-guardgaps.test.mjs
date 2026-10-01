// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Parity build for lucky-mem's L13 (a0403a8b): rank the errors without a
// guard. Red on the old stand (8a24c64): src/guardgaps.mjs and
// `mem guard gaps` do not exist there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as guardgaps from '../src/guardgaps.mjs';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const NOW = new Date('2026-09-27T12:00:00Z');

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-guardgaps-'));
  const init = spawnSync('node', [MEM, '--root', r, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  fs.mkdirSync(path.join(r, 'test'), { recursive: true });
  return r;
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
const write = (r, file, rows) => fs.writeFileSync(path.join(r, 'global', file),
  rows.map((z) => JSON.stringify(z)).join('\n') + (rows.length ? '\n' : ''));
const cli = (r, argv) => spawnSync('node', [MEM, '--root', r, ...argv], { encoding: 'utf8' });

test('empty log: not measurable (share null), not 0 % and not 100 %', () => {
  const r = build();
  try {
    write(r, 'errors.jsonl', []);
    const g = guardgaps.rank(r, { now: NOW });
    assert.equal(g.total, 0);
    assert.equal(g.share, null);
    assert.deepEqual(g.gaps, []);
  } finally { gone(r); }
});

test('hasGuard: guard field and a real test both cover, a bare marker does not (positive control)', () => {
  const r = build();
  try {
    write(r, 'errors.jsonl', [
      { id: 'g1', ts: '2026-09-01T00:00:00Z', class: 'x', title: 'src/a.mjs', guard: { kind: 'absent', path: 'src/a.mjs', pattern: 'q' } },
      { id: 'g2', ts: '2026-09-01T00:00:00Z', class: 'x', title: 'src/b.mjs' },
      { id: 'g3', ts: '2026-09-01T00:00:00Z', class: 'x', title: 'src/c.mjs' },
    ]);
    fs.writeFileSync(path.join(r, 'test', 'b.test.mjs'), "// error: g2\nimport test from 'node:test';\ntest('b', () => {});\n");
    fs.writeFileSync(path.join(r, 'test', 'c.test.mjs'), '// error: g3\n// TODO\n');
    assert.equal(guardgaps.hasGuard(r, 'g1').ok, true);
    assert.equal(guardgaps.hasGuard(r, 'g2').ok, true);
    assert.equal(guardgaps.hasGuard(r, 'g3').ok, false);
  } finally { gone(r); }
});

test('ranking order: repeated > open duty > only fresh > old and unremarkable', () => {
  const r = build();
  try {
    write(r, 'errors.jsonl', [
      { id: 'rep-old', ts: '2026-09-05T00:00:00Z', class: 'handling', title: 'src/hot.mjs' },
      { id: 'rep-new', ts: '2026-09-26T00:00:00Z', class: 'handling', title: 'src/hot.mjs' },
      { id: 'duty-case', ts: '2026-09-15T00:00:00Z', class: 'race', title: 'src/wait.mjs' },
      { id: 'only-fresh', ts: '2026-09-27T11:00:00Z', class: 'once', title: 'src/new.mjs' },
      { id: 'old-quiet', ts: '2026-06-01T00:00:00Z', class: 'once', title: 'src/forgot.mjs' },
    ]);
    write(r, 'duties.jsonl', [
      { id: 'p1', ts: '2026-09-15T01:00:00Z', title: 'guard for race', text: 't', file: 'src/wait.mjs', error_ids: ['duty-case'] },
    ]);
    const g = guardgaps.rank(r, { now: NOW });
    assert.equal(g.total, 5);
    assert.equal(g.guarded, 0);
    assert.deepEqual(g.gaps.map((x) => x.id), ['rep-new', 'duty-case', 'only-fresh', 'rep-old', 'old-quiet']);
  } finally { gone(r); }
});

test('weights: repetition > duty > fresh, the named order itself', () => {
  assert.ok(guardgaps.WEIGHT_REPETITION > guardgaps.WEIGHT_DUTY);
  assert.ok(guardgaps.WEIGHT_DUTY > guardgaps.WEIGHT_FRESH_MAX);
});

test('abort criterion: a guarded error is never listed, however repeated it is', () => {
  const r = build();
  try {
    write(r, 'errors.jsonl', [
      { id: 'a', ts: '2026-09-05T00:00:00Z', class: 'handling', title: 'src/hot.mjs' },
      { id: 'b', ts: '2026-09-27T00:00:00Z', class: 'handling', title: 'src/hot.mjs', guard: { kind: 'absent', path: 'src/hot.mjs', pattern: 'x' } },
      { id: 'weak', ts: '2026-01-01T00:00:00Z', class: 'once', title: 'src/cold.mjs' },
    ]);
    const g = guardgaps.rank(r, { now: NOW });
    assert.ok(!g.gaps.some((x) => x.id === 'b'));
    assert.equal(g.guarded, 1);
    assert.equal(g.share, 1 / 3);
  } finally { gone(r); }
});

test('CLI: guard gaps --json and --top, empty log, help', () => {
  const r = build();
  try {
    let w = cli(r, ['guard', 'gaps']);
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, /not measurable/);
    write(r, 'errors.jsonl', [
      { id: 'k1', ts: '2026-09-20T00:00:00Z', class: 'x', title: 'src/k1.mjs' },
      { id: 'k2', ts: '2026-09-21T00:00:00Z', class: 'x', title: 'src/k2.mjs' },
    ]);
    w = cli(r, ['guard', 'gaps', '--json']);
    assert.equal(w.status, 0, w.stderr);
    const d = JSON.parse(w.stdout);
    assert.equal(d.total, 2);
    assert.equal(d.share, 0);
    assert.equal(d.gaps.length, 2);
    w = cli(r, ['guard', 'gaps', '--top', '1']);
    assert.match(w.stdout, /k2/);
    assert.ok(!/k1/.test(w.stdout), w.stdout);
    w = cli(r, ['guard', '--help']);
    assert.match(w.stdout, /guard gaps/);
  } finally { gone(r); }
});

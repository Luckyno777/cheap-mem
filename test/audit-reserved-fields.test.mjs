// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Audit F03 (2026-10-06): `id` and `ts` are protected at the write core.
// Passed invalid (null, empty, object, bad time) -> refusal with nothing
// written; valid original values (import) stay; normal logging makes both
// itself; `undefined` counts as absent.
//
// Red proof: the FIXED state before the change (git archive) writes
// `id: null` / `ts: null` into the drawer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// FIXED state before the change (never a moving ref).
const OLD = '4bbca612f0f087aec290ff7fbe210f0ecd2b42b0';

function root(t) {
  const r = tempDir('cm-reserved-', t);
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.mkdirSync(path.join(r, 'projects'), { recursive: true });
  return r;
}
const drawer = (r) => path.join(r, 'global', 'decisions.jsonl');
const rows = (r) => (fs.existsSync(drawer(r))
  ? fs.readFileSync(drawer(r), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const INVALID = [
  ['id null', { id: null }], ['ts null', { ts: null }], ['both null', { id: null, ts: null }],
  ['id empty', { id: '' }], ['ts empty', { ts: '' }], ['id object', { id: {} }], ['ts object', { ts: { a: 1 } }],
  ['ts invalid', { ts: 'tomorrow' }], ['ts number', { ts: 12345 }], ['ts month 13', { ts: '2026-13-01T00:00:00Z' }],
];

for (const [name, extra] of INVALID) {
  test(`green: ${name} is refused, nothing written (logCheckedEntry and logEntry)`, (t) => {
    const r = root(t);
    assert.throws(() => memory.logCheckedEntry(r, 'decision', { text: 'probe', ...extra }), { code: 'RESERVED_FIELD' });
    assert.throws(() => memory.logEntry(r, 'decision', { text: 'probe', ...extra }), { code: 'RESERVED_FIELD' });
    assert.equal(rows(r).length, 0);
  });
}

test('green: a duplicate id is still refused', (t) => {
  const r = root(t);
  memory.logCheckedEntry(r, 'decision', { text: 'one', id: 'orig-0001' });
  assert.throws(() => memory.logCheckedEntry(r, 'decision', { text: 'two', id: 'orig-0001' }), /already taken/);
  assert.equal(rows(r).length, 1);
});

test('positive control: normal logging makes id and ts itself; undefined counts as absent', (t) => {
  const r = root(t);
  memory.logCheckedEntry(r, 'decision', { text: 'a' });
  memory.logCheckedEntry(r, 'decision', { text: 'b', id: undefined, ts: undefined });
  const got = rows(r);
  assert.equal(got.length, 2);
  for (const e of got) {
    assert.match(e.id, /^[a-z0-9]{12}$/);
    assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
});

test('positive control: a valid import with original id and ts is kept', (t) => {
  const r = root(t);
  memory.logCheckedEntry(r, 'decision', { text: 'import', id: '0b1jzkw', ts: '2025-01-02T03:04:05Z' });
  memory.logCheckedEntry(r, 'decision', { text: 'import2', ts: '2025-01-02T03:04:05.123+02:00' });
  const got = rows(r);
  assert.equal(got[0].id, '0b1jzkw');
  assert.equal(got[0].ts, '2025-01-02T03:04:05Z');
  assert.equal(got[1].ts, '2025-01-02T03:04:05.123+02:00');
});

test('red proof: the old state writes id:null / ts:null into the drawer', async (t) => {
  let dir;
  try {
    dir = tempDir('cm-reserved-old-', t);
    const tar = execFileSync('git', ['-C', REPO, 'archive', OLD, 'src', 'package.json'], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dir], { input: tar });
  } catch { return t.skip('fixed old state not in this clone'); }
  const r = root(t);
  const old = await import(pathToFileURL(path.join(dir, 'src', 'memory.mjs')).href);
  old.logEntry(r, 'decision', { text: 'probe', id: null, ts: null });
  const got = rows(r);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, null);
  assert.equal(got[0].ts, null);
});

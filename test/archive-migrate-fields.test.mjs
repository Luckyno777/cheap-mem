// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Parity item 3 (lucky-mem 68712f5a, 2026-09-27): a raw capture's count
// has to come from ONE calculation everywhere, and a capture that was
// relocated (here: migrated into the archive) must not silently lose the
// very fields that calculation depends on.
//
// **The finding in cheap-mem's own `archive.mjs`.** `migrate()` read the
// migrated capture's header back with the WRONG field names —
// `__gefangen_am`, `__ts_von`, `__ts_bis`, `__zeilen`, `__stempel` —
// leftovers that never matched `raw.mjs`'s actual header
// (`__captured_at`, `__lines`, a `__stamp` object with `ts_from`/
// `ts_to`). Every migrated capture's record row landed with
// `captured_at`, `ts_from`, `ts_to`, `lines` and `stamp` all `null`,
// silently: no error, no warning, `res.done` still listed it as migrated.
//
// Downstream that means the same class of miscount lucky-mem's fix
// addresses: `archive.inRange` (used by `mem raw export` and, when a
// range is given, `mem raw review`) drops any row without `ts_to`/
// `captured_at` — so a migrated capture with a REAL date disappears from
// a date-filtered review/export as if it never happened, purely because
// its date was lost on the way in, not because it lacks one. And
// `raw.capturesWithState()` reads `rec.stamp?.project`, so a `stamp`
// that never made it into the record also erases the capture's project
// from `mem raw review` and the dashboard.
//
// `test/archive.test.mjs`'s own `'migrate copies, verifies, and only
// then removes'` test already builds its header fixture with the
// CORRECT field names — it just never asserted on the row `migrate()`
// wrote, so the mismatch stayed invisible. The assertions below are
// exactly that missing check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as archive from '../src/archive.mjs';
import * as raw from '../src/raw.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-migrate-fields-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  return r;
}

/** A capture file laid out exactly the way `raw.mjs`'s `capture()` writes one. */
function realisticCapture(dir, rel, { ts, lines = 3, project = 'demo', sessionId = 'old-session' } = {}) {
  const header = {
    __stamp: { session_id: sessionId, surface: 'local', ts_from: ts, ts_to: ts, project },
    __captured_at: ts,
    __lines: lines,
    __offset_from: 0,
    __offset_to: 999,
    __redacted: [],
    __dropped: [],
    __dropped_bytes: 0,
  };
  const body = [header, { message: { content: 'older material about a foghorn' } }]
    .map((o) => JSON.stringify(o)).join('\n') + '\n';
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, zlib.gzipSync(Buffer.from(body, 'utf8')));
}

// --- Sabotage: a migrated capture must keep its real date, lines, project ---
test('migrate() carries the real date, line count and project over, not null', () => {
  const r = root();
  const rel = path.join('raw', '2026', '09', 'old.jsonl.gz');
  realisticCapture(r, rel, { ts: '2026-09-01T10:00:00Z', lines: 3, project: 'demo' });

  const store = archive.readConfig(process.env, r);
  const res = archive.migrate(store, r, [rel], { remove: false });
  assert.deepEqual(res.done, [rel]);

  const rec = archive.records(r).find((row) => row.path === rel);
  assert.ok(rec, 'no record row was written for the migrated capture');

  // This is the check the existing migrate test never made — and the
  // one that would have caught the field-name mismatch immediately.
  assert.equal(rec.captured_at, '2026-09-01T10:00:00Z',
    'captured_at was lost on migration — header field name mismatch');
  assert.equal(rec.ts_to, '2026-09-01T10:00:00Z',
    'ts_to was lost on migration — header field name mismatch');
  assert.equal(rec.lines, 3, 'lines was lost on migration — header field name mismatch');
  assert.equal(rec.stamp?.project, 'demo',
    'stamp/project was lost on migration — header field name mismatch');

  // The consequence that matters to a human: a migrated capture with a
  // REAL date must survive a date-filtered review, exactly like one that
  // was never migrated at all.
  const inRange = archive.inRange([rec], { from: '2026-09-01', to: '2026-09-01' });
  assert.equal(inRange.length, 1,
    'a migrated capture with a real date fell out of its own date range');
});

// --- Positive control: the probe actually distinguishes real dates ---
test('positive control: a capture genuinely outside the range still drops out', () => {
  const r = root();
  const rel = path.join('raw', '2026', '08', 'old.jsonl.gz');
  realisticCapture(r, rel, { ts: '2026-08-01T10:00:00Z', lines: 3, project: 'demo' });
  const store = archive.readConfig(process.env, r);
  archive.migrate(store, r, [rel], { remove: false });
  const rec = archive.records(r).find((row) => row.path === rel);
  const inRange = archive.inRange([rec], { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(inRange.length, 0,
    'the probe let a capture outside the range through — it proves nothing');
});

// --- The whole path: capturesWithState (what `mem raw review` shows) ---
test('capturesWithState reports the migrated capture with its real project and line count', () => {
  const r = root();
  const rel = path.join('raw', '2026', '09', 'old.jsonl.gz');
  realisticCapture(r, rel, { ts: '2026-09-01T10:00:00Z', lines: 5, project: 'demo' });
  const store = archive.readConfig(process.env, r);
  archive.migrate(store, r, [rel], { remove: false });

  const row = raw.capturesWithState(r).find((x) => x.path === rel);
  assert.ok(row, 'the migrated capture never shows up in capturesWithState()');
  assert.equal(row.project, 'demo');
  assert.equal(row.lines, 5);
  assert.equal(row.at, '2026-09-01T10:00:00Z');
});

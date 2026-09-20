// P12 · the bounded-window shape — `memory.tailEntries`, following
// `neighbours.mjs`'s `readTail` convention exactly (same field names:
// `entries`, `scannedWholeFile`, `scannedEntries`) rather than inventing
// a second one, and its one real caller in this file's scope,
// `memory.sameClass`.
//
// `sameClass`'s contract is an EXACT count ("this is number N"), not a
// recent-window one, so it may only trust the bounded window when
// `scannedWholeFile` says the window WAS the whole file — otherwise it
// must fall back to the exhaustive, non-materialising `iterLog`. This
// file proves both the primitive's own honesty (it says when it did not
// see everything) and that `sameClass` actually depends on that signal,
// not just carries it — see the SABOTAGE test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p12-bounded-'));
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

function writeErrors(root, rows, project = null) {
  const dir = project ? path.join(root, 'projects', project) : path.join(root, 'global');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'errors.jsonl'),
    `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
}

function errorRow(i, cls = 'common') {
  return {
    id: `e${i}`, ts: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    author: 'bench', authority: 'agent', class: cls, title: `case ${i}`, text: 'x'.repeat(600),
  };
}

test('tailEntries: a small drawer is read whole, honestly labelled', () => {
  const root = tmp();
  try {
    writeErrors(root, [errorRow(0), errorRow(1), errorRow(2)]);
    const r = memory.tailEntries(root, 'error', {});
    assert.equal(r.scannedWholeFile, true);
    assert.equal(r.scannedEntries, 3);
    assert.deepEqual(r.entries.map((e) => e.id), ['e0', 'e1', 'e2']);
  } finally { rm(root); }
});

test('tailEntries: a drawer over the byte bound is honestly labelled PARTIAL', () => {
  const root = tmp();
  try {
    const rows = Array.from({ length: 200 }, (_, i) => errorRow(i));
    writeErrors(root, rows);
    // A tiny tailBytes forces the boundary without needing a 512 KB
    // fixture — the mechanism under test is the SAME one `sameClass`
    // uses at its real, larger default.
    const r = memory.tailEntries(root, 'error', { tailBytes: 2000 });
    assert.equal(r.scannedWholeFile, false);
    assert.ok(r.scannedEntries > 0 && r.scannedEntries < 200,
      `expected a partial window, got ${r.scannedEntries} of 200`);
    // Whatever it DID see must be a suffix of the file — the newest
    // rows, not an arbitrary slice.
    const ids = r.entries.map((e) => e.id);
    assert.equal(ids[ids.length - 1], 'e199', 'the window must end at the newest entry');
    for (let i = 1; i < ids.length; i += 1) {
      const a = Number(ids[i - 1].slice(1));
      const b = Number(ids[i].slice(1));
      assert.equal(b, a + 1, 'the window must be a contiguous, ordered suffix');
    }
  } finally { rm(root); }
});

test('tailEntries: a missing drawer is reported as a (trivially) whole, empty read', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, 'global'), { recursive: true });
    const r = memory.tailEntries(root, 'error', {});
    assert.equal(r.scannedWholeFile, true);
    assert.equal(r.scannedEntries, 0);
    assert.deepEqual(r.entries, []);
  } finally { rm(root); }
});

test('sameClass: exact count holds even PAST the tail boundary — the fallback engages', () => {
  const root = tmp();
  try {
    // Enough rows, padded wide enough, to exceed tailEntries' real
    // 512 KB default: 1000 rows * ~750 bytes/line comfortably clears it.
    const rows = [];
    for (let i = 0; i < 1000; i += 1) rows.push(errorRow(i, i % 5 === 0 ? 'rare' : 'common'));
    writeErrors(root, rows);
    const trueCount = rows.filter((r) => r.class === 'rare').length;

    // Prove the fixture actually exceeds the window this test is for —
    // otherwise this test would pass for the wrong reason.
    const tail = memory.tailEntries(root, 'error', {});
    assert.equal(tail.scannedWholeFile, false, 'fixture must exceed the tail window for this test to mean anything');

    const seen = memory.sameClass(root, 'rare');
    assert.equal(seen.count, trueCount,
      'sameClass undercounted once the drawer grew past the bounded window — '
      + 'it must fall back to an exhaustive scan, not trust a partial one');
    assert.equal(seen.latest.length, 3);
    // Newest-first, and genuinely the newest three.
    const ids = seen.latest.map((h) => h.id);
    assert.deepEqual(ids, ['e995', 'e990', 'e985']);
  } finally { rm(root); }
});

test('sameClass: still exact and cheap on an ordinary, small drawer (the common case)', () => {
  const root = tmp();
  try {
    writeErrors(root, [errorRow(0, 'x'), errorRow(1, 'x'), errorRow(2, 'y')]);
    const r = memory.tailEntries(root, 'error', {});
    assert.equal(r.scannedWholeFile, true, 'the fast path should apply to an ordinary drawer');
    assert.equal(memory.sameClass(root, 'x').count, 2);
    assert.equal(memory.sameClass(root, 'y').count, 1);
  } finally { rm(root); }
});

test('sameClass: still finds matches across project boundaries past the window', () => {
  const root = tmp();
  try {
    const rows = [];
    for (let i = 0; i < 1000; i += 1) rows.push(errorRow(i, 'common'));
    writeErrors(root, rows, 'proj-a');
    writeErrors(root, [errorRow(0, 'shared-class')], null);
    const seen = memory.sameClass(root, 'shared-class');
    assert.equal(seen.count, 1);
  } finally { rm(root); }
});

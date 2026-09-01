// test/timesearch.test.mjs — time-window retrieval over digested entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { entriesInWindow, keywordsOf } from '../src/timesearch.mjs';

function tempMem(rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-time-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, 'global', 'events.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return root;
}

const ROWS = [
  { id: 'a', ts: '2026-08-29T13:30:00Z', title: 'A shelves cad' },
  { id: 'b', ts: '2026-08-29T17:00:00Z', title: 'B deploy prod' },
  { id: 'c', ts: '2026-08-30T10:00:00Z', title: 'C later' },
];

test('half-open window [from, to)', () => {
  const root = tempMem(ROWS);
  try {
    const r = entriesInWindow(root, { from: '2026-08-29T13:00:00Z', to: '2026-08-29T18:00:00Z' });
    assert.deepEqual(r.map((e) => e.id), ['a', 'b']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('subject word narrows', () => {
  const root = tempMem(ROWS);
  try {
    const r = entriesInWindow(root, { from: '2026-08-29T00:00:00Z', to: '2026-08-31T00:00:00Z', words: ['shelves'] });
    assert.deepEqual(r.map((e) => e.id), ['a']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('keywordsOf drops time/filler, keeps subjects', () => {
  const w = keywordsOf('what did we discuss last friday about deploy');
  assert.ok(w.includes('deploy'));
  assert.ok(!w.includes('friday'));
  assert.ok(!w.includes('did'));
});

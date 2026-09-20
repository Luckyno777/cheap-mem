// The neighbour hint reads the tail of a drawer, not all of it.
//
// **Why the bound exists.** `neighbours()` ran a full `readLog` — every
// line parsed — before every write, and it is a HINT, not a correctness
// check. Measured 2026-09-20: 2.3 ms at 1,000 rows, 15.9 ms at 10,000,
// 205.6 ms at 100,000, fitted exponent 0.96. The cost of writing one
// entry grew with everything already written.
//
// **What a bound can break, and what it cannot.** It can make the hint
// MISS an old neighbour. It cannot make it SHOW a false one, and it
// must not make a miss look like an absence. Those three sentences are
// what this file tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as neighbours from '../src/neighbours.mjs';

function drawer(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tail-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, 'global', 'decisions.jsonl'),
    lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}
const entry = (i, over = {}) => ({
  id: `e${i}`, ts: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  type: 'decision', topic: 'deploy', choice: `choice ${i}`, ...over,
});

test('POSITIVE CONTROL: a small drawer is read whole and the hint is unchanged', () => {
  const root = drawer([entry(1), entry(2), entry(3)]);
  try {
    const r = neighbours.neighbours(root, 'decision', { topic: 'deploy' });
    assert.equal(r.scannedWholeFile, true, 'a drawer under the window must be read whole');
    assert.equal(r.hits.length, 3);
    // Newest first, as before the bound.
    assert.equal(r.hits[0].id, 'e3');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a retired neighbour inside the window is still filtered out', () => {
  // The load-bearing correctness claim: a tombstone is always appended
  // AFTER the entry it retires, so an entry inside the window has its
  // tombstone inside the window too. The bound cannot resurrect a
  // withdrawn ruling.
  const root = drawer([
    entry(1),
    entry(2),
    { id: 't1', ts: '2026-09-20T00:00:00Z', type: 'decision', retires_id: 'e2', state: 'discarded' },
  ]);
  try {
    const r = neighbours.neighbours(root, 'decision', { topic: 'deploy' });
    const ids = r.hits.map((h) => h.id);
    assert.ok(!ids.includes('e2'), `a discarded ruling came back as a neighbour: ${ids.join(', ')}`);
    assert.ok(ids.includes('e1'), 'the live neighbour disappeared with it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a drawer past the window is read only in part, and says so', () => {
  const many = Array.from({ length: 400 }, (_, i) => entry(i, { topic: 'unrelated' }));
  const root = drawer(many);
  try {
    // A window far below the file size, so the bound certainly bites.
    const r = neighbours.neighbours(root, 'decision', { topic: 'unrelated' }, { tailBytes: 4096 });
    assert.equal(r.scannedWholeFile, false, 'the window did not bite — raise the fixture size');
    assert.ok(r.scannedEntries > 0 && r.scannedEntries < 400,
      `expected a partial window, read ${r.scannedEntries} of 400`);
    // The newest entries are the ones a hint is about, and they survive.
    assert.equal(r.hits[0].id, 'e399');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a MISS in a partial window does not read as "nothing stands here"', () => {
  // The one way the bound could lie. The old neighbour is out of the
  // window, so the hint cannot show it — but silence would claim the
  // subject is new, which is a different and false statement.
  const lines = [
    entry(0, { topic: 'ancient' }),
    ...Array.from({ length: 400 }, (_, i) => entry(i + 1, { topic: 'recent' })),
  ];
  const root = drawer(lines);
  try {
    const r = neighbours.neighbours(root, 'decision', { topic: 'ancient' }, { tailBytes: 4096 });
    assert.equal(r.hits.length, 0, 'the fixture did not actually push the old entry out');
    assert.equal(r.scannedWholeFile, false);
    const lines2 = neighbours.hint(r);
    assert.ok(lines2.length > 0, 'a partial miss printed nothing at all — that is the silent nothing');
    const text = lines2.join('\n');
    assert.match(text, /ancient/, `the hint does not name the subject it looked for: ${text}`);
    assert.match(text, /older ones not read|last \d+ entries/,
      `the hint does not say the scan was partial: ${text}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('COUNTER-PROBE: a whole-file miss stays silent', () => {
  // The honest note above must not fire when the drawer WAS read whole
  // — then "nothing found" really does mean nothing is there, and a
  // note on every first-of-its-subject write is noise that teaches
  // people to skip the hint.
  const root = drawer([entry(1, { topic: 'other' })]);
  try {
    const r = neighbours.neighbours(root, 'decision', { topic: 'brand-new' });
    assert.equal(r.scannedWholeFile, true);
    assert.deepEqual(neighbours.hint(r), [],
      'a complete scan that found nothing should say nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the window never splits a line', () => {
  // A mid-file read almost always lands inside a line. That half-line
  // must be dropped, not parsed into a broken entry that then counts.
  const many = Array.from({ length: 300 }, (_, i) => entry(i));
  const root = drawer(many);
  try {
    for (const tailBytes of [1000, 1001, 1337, 2048, 4096]) {
      const r = neighbours.neighbours(root, 'decision', { topic: 'deploy' }, { tailBytes });
      // The `__broken` filter would hide a kept half-line from `hits`,
      // so asserting on hits alone proves nothing about the drop. This
      // counts what the window actually read.
      assert.equal(r.brokenInWindow, 0,
        `window ${tailBytes} parsed ${r.brokenInWindow} unreadable line(s) — `
        + 'the partial first line is not being dropped');
      assert.ok(r.hits.every((h) => h.id && !h.__broken),
        `window ${tailBytes} produced a broken entry`);
      assert.equal(r.hits[0].id, 'e299', `window ${tailBytes} lost the newest entry`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

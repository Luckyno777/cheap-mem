import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE, TOLERANCE_BYTES, bookSizes, check, ratchet, run,
  readBaseline, setBaseline, save, asText,
} from '../src/shrink.mjs';

function mem(books = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-'));
  for (const [rel, body] of Object.entries(books)) {
    const t = path.join(d, rel);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, body);
  }
  return d;
}

test('a shrunken book raises an alarm', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    assert.equal(run(d).state, STATE.FIRST_RUN);
    fs.writeFileSync(path.join(d, 'global/errors.jsonl'), 'x'.repeat(400));
    const f = run(d);
    assert.equal(f.state, STATE.ALARM);
    assert.equal(f.shrunk[0].missing, 100);
    assert.match(asText(f), /ALARM/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a vanished book is a shrink to zero, not a skip', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    run(d);
    fs.rmSync(path.join(d, 'global/errors.jsonl'));
    const f = run(d);
    assert.equal(f.state, STATE.ALARM);
    assert.equal(f.vanished.length, 1);
    assert.match(asText(f), /gone \(was 500 bytes\)/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('growth and standing still are calm', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(100) });
  try {
    run(d);
    assert.equal(run(d).state, STATE.CALM, 'standing still fired');
    fs.appendFileSync(path.join(d, 'global/errors.jsonl'), 'y'.repeat(50));
    const f = run(d);
    assert.equal(f.state, STATE.CALM);
    assert.equal(f.grown, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('there is no tolerance — one byte is enough', () => {
  assert.equal(TOLERANCE_BYTES, 0);
  assert.equal(check({ now: { a: 999 }, baseline: { books: { a: 1000 } } }).state, STATE.ALARM);
});

test('the baseline only ratchets UPWARDS', () => {
  const b = ratchet({ books: { a: 1000, b: 5 } }, { a: 400, b: 50 });
  assert.equal(b.books.a, 1000, 'the baseline shrank along');
  assert.equal(b.books.b, 50);
});

test('an alarm persists and is not written away', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    run(d);
    fs.writeFileSync(path.join(d, 'global/errors.jsonl'), 'x'.repeat(100));
    assert.equal(run(d).state, STATE.ALARM);
    assert.equal(run(d).state, STATE.ALARM, 'the second run calmed down');
    assert.equal(run(d).state, STATE.ALARM, 'the third run calmed down');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a declared shrink lowers the baseline — and only that', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    run(d);
    fs.writeFileSync(path.join(d, 'global/errors.jsonl'), 'x'.repeat(100));
    assert.equal(run(d).state, STATE.ALARM);
    setBaseline(d, bookSizes(d), { why: 'digest 2026-09' });
    assert.equal(run(d).state, STATE.CALM, 'the declaration had no effect');
    assert.match(readBaseline(d).why, /digest/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the reason for a declared lowering survives the next ratchet', () => {
  // On the first test run it was lost here — and then a declared
  // digest cannot be told from silent damage afterwards.
  const b = ratchet({ books: { a: 1 }, why: 'digest 2026-09' }, { a: 2 });
  assert.equal(b.why, 'digest 2026-09');
});

test('raw/ and .pipeline/ do not count', () => {
  const d = mem({
    'global/errors.jsonl': 'x'.repeat(10),
    'raw/big.jsonl': 'y'.repeat(9000),
    '.pipeline/tmp.jsonl': 'z'.repeat(9000),
  });
  try {
    assert.deepEqual(Object.keys(bookSizes(d)), ['global/errors.jsonl']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the baseline survives save and read unchanged', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(7) });
  try {
    const state = ratchet(null, bookSizes(d));
    assert.equal(save(d, state), true);
    assert.deepEqual(readBaseline(d).books, state.books);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a baseline without a books field counts as absent', () => {
  const d = mem({ 'global/errors.jsonl': 'x' });
  try {
    fs.mkdirSync(path.join(d, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(d, '.pipeline', 'shrink-baseline.json'), '{"version":1}');
    assert.equal(readBaseline(d), null, 'half a baseline was accepted');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

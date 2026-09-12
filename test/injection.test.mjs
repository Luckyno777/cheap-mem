import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OCCASION, REASON, JOURNAL_FILE, buildLine, book, read } from '../src/injection.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'inj-'));

test('an unknown occasion or reason becomes "unknown", not free text', () => {
  const l = buildLine({ occasion: 'whenever', reason: 'because' });
  assert.equal(l.occasion, 'unknown');
  assert.equal(l.reason, 'unknown');
});

test('null reason means it WAS injected', () => {
  assert.equal(buildLine({ reason: null }).reason, null);
  assert.equal(buildLine({ reason: REASON.EMPTY }).reason, 'empty');
});

test('searched is null when not recorded — never 0', () => {
  // Otherwise an empty memory cannot be told from an unmeasured one.
  assert.equal(buildLine({}).searched, null);
  assert.equal(buildLine({ searched: 0 }).searched, 0);
});

test('sources are capped and stringified', () => {
  const l = buildLine({ sources: Array.from({ length: 40 }, (_, i) => i) });
  assert.equal(l.sources.length, 20);
  assert.equal(typeof l.sources[0], 'string');
});

test('book() appends, read() returns, broken lines are counted', () => {
  const d = tmp();
  try {
    assert.equal(book(d, { occasion: OCCASION.QUESTION, bytes: 12 }), true);
    assert.equal(book(d, { occasion: OCCASION.BEFORE_EDIT, reason: REASON.ALREADY_SHOWN }), true);
    fs.appendFileSync(path.join(d, JOURNAL_FILE), '{broken\n');
    const r = read(d);
    assert.equal(r.lines.length, 2);
    assert.equal(r.broken, 1);
    assert.equal(r.present, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a missing journal reports present:false, not an empty one', () => {
  const r = read(tmp());
  assert.equal(r.present, false);
  assert.deepEqual(r.lines, []);
});

test('book() never throws outward', () => {
  assert.equal(book(null, {}), false);
  assert.equal(book('', {}), false);
});

test('negative or absurd numbers do not get into the journal', () => {
  const l = buildLine({ bytes: -5, hits: -1 });
  assert.equal(l.bytes, 0);
  assert.equal(l.hits, 0);
});

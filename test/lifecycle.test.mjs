import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-life-'));
}

test('retiredMap covers retires_id, closes_id, replaces_id', () => {
  const map = memory.retiredMap([
    { id: 'a', text: 'content' },
    { id: 't1', retires_id: 'a', state: 'discarded', why: 'gone' },
    { id: 'b', text: 'two' },
    { id: 't2', closes_id: 'b' },
    { id: 'c2', text: 'new', replaces_id: 'c' },
  ]);
  assert.equal(map.get('a').state, 'discarded');
  assert.equal(map.get('a').why, 'gone');
  assert.equal(map.get('b').state, 'done');
  assert.equal(map.get('c').state, 'superseded');
  assert.equal(map.has('c2'), false); // the correction itself stays live
});

test('isClosingLine: only pure tombstones, not corrections', () => {
  assert.equal(memory.isClosingLine({ retires_id: 'x' }), true);
  assert.equal(memory.isClosingLine({ closes_id: 'x' }), true);
  assert.equal(memory.isClosingLine({ replaces_id: 'x', text: 'new' }), false);
  assert.equal(memory.isClosingLine({ text: 'content' }), false);
});

test('retireEntry appends a tombstone, original stays put', () => {
  const root = tmp();
  const { entry } = memory.logEntry(root, 'thought', { text: 'idea X' });
  memory.retireEntry(root, 'thought', entry.id, { state: 'discarded', why: 'nope' });
  const { entries } = memory.readLog(root, 'thought');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, 'idea X');
  assert.equal(entries[1].retires_id, entry.id);
  assert.equal(entries[1].state, 'discarded');
});

test('retireEntry rejects unknown id and bad state', () => {
  const root = tmp();
  assert.throws(() => memory.retireEntry(root, 'thought', 'nope', {}));
  const { entry } = memory.logEntry(root, 'thought', { text: 'here' });
  assert.throws(() => memory.retireEntry(root, 'thought', entry.id, { state: 'bogus' }));
});

test('findEntryLocation finds the content entry, not the tombstone', () => {
  const root = tmp();
  const { entry } = memory.logEntry(root, 'error', { class: 'x', title: 'boom' });
  memory.retireEntry(root, 'error', entry.id, { state: 'done' });
  assert.deepEqual(memory.findEntryLocation(root, entry.id), { type: 'error', project: null });
});

test('memory.find hides retired by default', () => {
  const root = tmp();
  const { entry } = memory.logEntry(root, 'thought', { text: 'thesaurus as sqlite' });
  memory.retireEntry(root, 'thought', entry.id, { state: 'discarded' });
  assert.equal(memory.find(root, 'thesaurus', {}).length, 0);
  const withR = memory.find(root, 'thesaurus', { withRetired: true });
  assert.equal(withR.length, 1);
  assert.equal(withR[0]._retired.state, 'discarded');
});

test('memory.find never returns tombstone lines', () => {
  const root = tmp();
  const { entry } = memory.logEntry(root, 'thought', { text: 'whatever' });
  memory.retireEntry(root, 'thought', entry.id, { state: 'discarded', why: 'thesaurus-reason' });
  assert.equal(memory.find(root, 'thesaurus-reason', { withRetired: true }).length, 0);
});

test('BM25 search hides retired, --with-retired brings it back', () => {
  const root = tmp();
  const { entry } = memory.logEntry(root, 'thought', { text: 'compressor experiment' });
  memory.logEntry(root, 'thought', { text: 'compressor stays important' });
  memory.retireEntry(root, 'thought', entry.id, { state: 'discarded' });
  const index = search.buildIndex(root);
  const without = search.search(index, 'compressor experiment', { top: 10 });
  assert.equal(without.some((t) => t.entry.id === entry.id), false);
  const withR = search.search(index, 'compressor experiment', { top: 10, withRetired: true });
  const hit = withR.find((t) => t.entry.id === entry.id);
  assert.ok(hit, 'back with withRetired');
  assert.equal(hit.retired.state, 'discarded');
});

test('BM25 index never ingests tombstone lines', () => {
  const root = tmp();
  const { entry } = memory.logEntry(root, 'thought', { text: 'content' });
  memory.retireEntry(root, 'thought', entry.id, { state: 'done', why: 'tombstonetext unique' });
  const index = search.buildIndex(root);
  assert.equal(search.search(index, 'tombstonetext unique', { top: 10, withRetired: true }).length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-test-'));
}

test('logEntry writes JSONL with id + ts', () => {
  const root = tmpRoot();
  const { path: p, entry } = memory.logEntry(root, 'event', { title: 'hi' });
  assert.equal(fs.existsSync(p), true);
  assert.ok(entry.id);
  assert.ok(entry.ts);
  assert.equal(entry.title, 'hi');
});

test('logEntry appends, never overwrites', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'event', { title: 'a' });
  memory.logEntry(root, 'event', { title: 'b' });
  const { entries } = memory.readLog(root, 'event');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].title, 'a');
  assert.equal(entries[1].title, 'b');
});

test('logEntry escapes newlines via JSON.stringify (stays one line)', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'event', { text: 'line1\nline2' });
  const raw = fs.readFileSync(memory.logPath(root, 'event'), 'utf8');
  assert.equal(raw.split('\n').filter((l) => l.trim()).length, 1);
  const { entries } = memory.readLog(root, 'event');
  assert.equal(entries[0].text, 'line1\nline2');
});

test('find is case-insensitive substring', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'event', { title: 'Auth flow shipped' });
  memory.logEntry(root, 'error', { class: 'timeout', text: 'auth check timed out' });
  const hits = memory.find(root, 'auth');
  assert.equal(hits.length, 2);
});

test('find respects --since', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'event', { title: 'old', ts: '2020-01-01T00:00:00Z' });
  memory.logEntry(root, 'event', { title: 'new' });
  const hits = memory.find(root, 'e', { since: new Date(Date.now() - 60_000) });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].title, 'new');
});

test('projectInit creates skeleton idempotently', () => {
  const root = tmpRoot();
  const first = memory.projectInit(root, 'my-app');
  assert.ok(first.created.includes('.'));
  assert.ok(first.created.includes('facts.yaml'));

  const second = memory.projectInit(root, 'my-app');
  assert.deepEqual(second.created, []);
  assert.ok(second.existed.includes('.'));
  assert.ok(second.existed.includes('facts.yaml'));
});

test('projectInit rejects bad names', () => {
  const root = tmpRoot();
  assert.throws(() => memory.projectInit(root, 'Bad Name'));
  assert.throws(() => memory.projectInit(root, '-leading-dash'));
  assert.throws(() => memory.projectInit(root, ''));
});

test('correctionEntry links to old id and rejects unknown', () => {
  const root = tmpRoot();
  const { entry: old } = memory.logEntry(root, 'error', { title: 'wrong' });
  const { entry: corr } = memory.correctionEntry(root, 'error', old.id, { title: 'right' });
  assert.equal(corr.replaces_id, old.id);
  assert.throws(() => memory.correctionEntry(root, 'error', 'nope', { title: 'x' }));
});

test('context returns something even on empty root', () => {
  const root = tmpRoot();
  const out = memory.context(root);
  assert.ok(out.includes('cheap-mem context'));
  assert.ok(out.includes('(none)'));
});

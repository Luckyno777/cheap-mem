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

// --- core: the always-load block of settled facts (Engram-inspired) ------
const CORE_NOW = new Date('2026-09-01T00:00:00Z');

test('core holds current, non-stale, non-conflicting facts', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'timeline', { key: 'server.users', value: '10', valid_from: '2026-08-01' });
  memory.logEntry(root, 'timeline', { key: 'server.users', value: '13', valid_from: '2026-08-20' });
  const { kept } = memory.coreFacts(root, { now: CORE_NOW });
  assert.equal(kept.length, 1);
  assert.equal(kept[0].key, 'server.users');
  assert.equal(kept[0].current.value, '13'); // newest wins
  const text = memory.core(root, { now: CORE_NOW });
  assert.match(text, /server\.users = 13/);
  assert.match(text, /always-load/);
});

test('core excludes stale and conflicting facts', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'timeline', { key: 'fresh.k', value: 'v', valid_from: '2026-08-20' });
  memory.logEntry(root, 'timeline', { key: 'old.k', value: 'x', valid_from: '2026-01-01' }); // > 120d stale
  memory.logEntry(root, 'timeline', { key: 'clash.k', value: 'a', valid_from: '2026-08-10' });
  memory.logEntry(root, 'timeline', { key: 'clash.k', value: 'b', valid_from: '2026-08-10' }); // same date, differ
  const { kept } = memory.coreFacts(root, { now: CORE_NOW, staleDays: 120 });
  const keys = kept.map((f) => f.key);
  assert.deepEqual(keys, ['fresh.k']); // old.k stale, clash.k conflict -> out
});

test('core is bounded: freshest survive, the rest are counted', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'timeline', { key: 'a', value: '1', valid_from: '2026-08-01' });
  memory.logEntry(root, 'timeline', { key: 'b', value: '2', valid_from: '2026-08-10' });
  memory.logEntry(root, 'timeline', { key: 'c', value: '3', valid_from: '2026-08-20' });
  const { kept, omitted, total } = memory.coreFacts(root, { now: CORE_NOW, max: 2 });
  assert.equal(total, 3);
  assert.equal(omitted, 1);
  assert.equal(kept.length, 2);
  // freshest two are b (08-10) and c (08-20); a (08-01) is dropped
  assert.deepEqual(kept.map((f) => f.key), ['b', 'c']); // displayed in key order
  const text = memory.core(root, { now: CORE_NOW, max: 2 });
  assert.match(text, /1 more stable fact beyond the budget of 2/);
});

test('core on an empty memory says so, does not crash', () => {
  const root = tmpRoot();
  const text = memory.core(root, { now: CORE_NOW });
  assert.match(text, /no stable facts yet/);
});

// --- topics: where a subject stands now (Gentleman/engram-inspired) ------

test('topicState folds a subject onto its newest entry, trail behind it', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision', { topic: 'arch/auth', title: 'use sessions', ts: '2026-08-01T00:00:00Z' });
  memory.logEntry(root, 'error', { topic: 'arch/auth', title: 'sessions leak on restart', ts: '2026-08-10T00:00:00Z' });
  memory.logEntry(root, 'learning', { topic: 'arch/auth', title: 'tokens beat sessions here', ts: '2026-08-20T00:00:00Z' });
  memory.logEntry(root, 'event', { topic: 'other/thing', title: 'unrelated', ts: '2026-08-21T00:00:00Z' });

  const st = memory.topicState(root, 'arch/auth');
  assert.equal(st.count, 3);
  assert.match(st.current.title, /tokens beat sessions/); // newest is the state
  assert.deepEqual(st.history.map((e) => e.title),
    ['sessions leak on restart', 'use sessions']);       // trail, newest first
});

test('topics spans every type and project, busiest/freshest first', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision', { topic: 'a', title: 'x', ts: '2026-08-01T00:00:00Z' });
  memory.logEntry(root, 'error', { topic: 'b', title: 'y', ts: '2026-08-05T00:00:00Z' });
  memory.logEntry(root, 'event', { topic: 'b', title: 'z', ts: '2026-08-09T00:00:00Z' });
  const list = memory.topics(root);
  assert.deepEqual(list.map((t) => t.topic), ['b', 'a']); // b touched more recently
  assert.equal(list[0].count, 2);
  assert.deepEqual(list[0].types, ['error', 'event']);
});

test('a retired entry drops out of its topic', () => {
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'thought', { topic: 't', title: 'half-baked', ts: '2026-08-02T00:00:00Z' });
  memory.logEntry(root, 'decision', { topic: 't', title: 'the real call', ts: '2026-08-01T00:00:00Z' });
  memory.retireEntry(root, 'thought', entry.id, { state: 'discarded', why: 'wrong turn' });
  const st = memory.topicState(root, 't');
  assert.equal(st.count, 1, 'the discarded entry must not count');
  assert.match(st.current.title, /the real call/);
});

test('entries without a topic are not swept into one', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'event', { title: 'no topic here' });
  memory.logEntry(root, 'event', { topic: '  ', title: 'blank topic' });
  assert.deepEqual(memory.topics(root), []);
});

test('same-second entries in one topic still order deterministically', () => {
  // Second-resolution timestamps tie easily: three entries logged in one
  // second must not make "the current state" a coin flip.
  const root = tmpRoot();
  const ts = '2026-08-01T00:00:00Z';
  memory.logEntry(root, 'decision', { topic: 's', title: 'first', ts });
  memory.logEntry(root, 'decision', { topic: 's', title: 'second', ts });
  memory.logEntry(root, 'decision', { topic: 's', title: 'third', ts });
  const a = memory.topicState(root, 's');
  const b = memory.topicState(root, 's');
  assert.equal(a.current.title, 'third', 'within one log, the last written wins');
  assert.deepEqual(a.history.map((e) => e.title), b.history.map((e) => e.title),
    'repeated reads must agree');
});

// --- links: the typed graph the digest earns while sorting --------------

test('linksOf reads an edge from both ends', () => {
  const root = tmpRoot();
  const { entry: dec } = memory.logEntry(root, 'decision', { title: 'ship on friday' });
  const { entry: err } = memory.logEntry(root, 'error', { title: 'weekend outage' });
  memory.logEntry(root, 'link', { from: dec.id, to: err.id, kind: 'causes' });

  const fromDecision = memory.linksOf(root, dec.id);
  assert.equal(fromDecision.out.length, 1);
  assert.equal(fromDecision.out[0].kind, 'causes');
  assert.match(fromDecision.out[0].entry.title, /weekend outage/);

  const fromError = memory.linksOf(root, err.id);
  assert.equal(fromError.incoming.length, 1, 'the same edge must be visible from the target');
  assert.match(fromError.incoming[0].entry.title, /ship on friday/);
});

test('an edge into nothing is reported, not silently skipped', () => {
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'decision', { title: 'real one' });
  memory.logEntry(root, 'link', { from: entry.id, to: 'ghost-id-999', kind: 'causes' });
  const g = memory.linksOf(root, entry.id);
  assert.equal(g.out.length, 0, 'a dangling edge must not count as a normal link');
  assert.equal(g.dangling.length, 1);
  assert.equal(g.dangling[0].to, 'ghost-id-999');
});

test('the link vocabulary stays closed', () => {
  // An open vocabulary makes the graph untraversable by code.
  assert.deepEqual(Object.keys(memory.LINK_KINDS).sort(),
    ['causes', 'contradicts', 'generalizes', 'resolves']);
});

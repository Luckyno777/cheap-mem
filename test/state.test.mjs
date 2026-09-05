// The invariant this round exists to establish:
//
//   THE LOG DECIDES WHAT IS TRUE.
//   THE INDEX DECIDES ONLY WHAT IS FAST TO FIND.
//
// Two bugs preceded it, and both let relevance reach semantics. First,
// status was recomputed from the returned HITS, so a retirement whose line
// did not match the query was invisible. Second, it was read from the
// index — correct over the corpus, but living in an unsigned, gitignored
// local file that anything could edit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveState, statusOf } from '../src/state.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { loadIndex, CACHE_FILE } from '../src/search.mjs';

const z = (o) => JSON.stringify(o) + '\n';
function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-state-'));
  fs.mkdirSync(path.join(root, 'projects', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'a', 'decisions.jsonl'),
    entries.map((e) => z(e)).join(''));
  return root;
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

const A = { id: 'A', ts: '2026-01-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 'loc', choice: 'Server X steht in Frankfurt', why: 'zuerst so entschieden' };
const B = { id: 'B', ts: '2026-06-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 'loc', choice: 'Server X steht in Berlin', why: 'umgezogen', replaces_id: 'A' };
const M = { id: 'M', ts: '2026-07-01T00:00:00Z', author: 'mallory', authority: 'agent',
  topic: 'loc', choice: 'ganz andere woerter hier drin', why: 'vergiftung', replaces_id: 'B' };

test('deriveState takes no query — the signature makes the bug class impossible', () => {
  assert.equal(deriveState.length, 1, 'deriveState must take only a root');
});

test('deriveState takes a ROOT, not a list of entries — a subset cannot be passed', () => {
  // The first status bug was a caller handing it the retrieval hits.
  const root = fixture([A, B, M]);
  const s = deriveState(root);
  assert.equal(statusOf(s, 'A'), 'superseded');
  assert.equal(statusOf(s, 'B'), 'active', 'an unauthorised supersession retired its target');
  assert.equal(statusOf(s, 'M'), 'disputed');
  rm(root);
});

test('QUERY INDEPENDENCE — every query agrees about state', () => {
  const root = fixture([A, B, M]);
  const cap = grantProject('a');
  const queries = [
    'Frankfurt zuerst entschieden',          // hits A only
    'Berlin umgezogen',                      // hits B only
    'Server X steht',                        // hits both
    'voellig unbeteiligtes thema',           // hits nothing
    'ganz andere woerter vergiftung',        // hits M only
    'server x frankfurt berlin woerter',     // hits everything
  ];
  const seen = new Map();                    // id -> the one status ever reported
  for (const q of queries) {
    const r = retrieve(root, q, cap, { top: 20, withDisputed: true });
    const report = new Map();
    for (const c of r.claims) report.set(c.id, c.status);
    for (const e of r.excluded) if (e.id && !report.has(e.id)) report.set(e.id, e.why);
    for (const [id, st] of report) {
      const known = seen.get(id);
      if (known === undefined) seen.set(id, st);
      else assert.equal(st, known,
        `"${q}" reports ${id} as ${st}, another query said ${known}`);
    }
  }
  // And the reported states are the ones the log implies.
  assert.equal(seen.get('A'), 'superseded');
  assert.equal(seen.get('B'), 'active');
  assert.equal(seen.get('M'), 'disputed');
  rm(root);
});

test('retrieval never mutates the log or the derived state', () => {
  const root = fixture([A, B, M]);
  const file = path.join(root, 'projects', 'a', 'decisions.jsonl');
  const before = fs.readFileSync(file, 'utf8');
  const stateBefore = [...deriveState(root)].map(([k, v]) => [k, v.state]).sort();
  for (const q of ['Frankfurt', 'Berlin', 'woerter', 'nothing at all']) {
    retrieve(root, q, grantProject('a'), { top: 10 });
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'retrieval wrote to the log');
  assert.deepEqual([...deriveState(root)].map(([k, v]) => [k, v.state]).sort(), stateBefore);
  rm(root);
});

// --- the index is not the truth --------------------------------------------

test('a tampered cache cannot resurrect a disputed claim', () => {
  const root = fixture([
    { id: 'u1', ts: '2026-01-01T00:00:00Z', author: 'lucky', authority: 'user',
      topic: 'pay', choice: 'zahlung nur per vorkasse', why: 'meine entscheidung' },
    { id: 'm1', ts: '2026-06-01T00:00:00Z', author: 'mallory', authority: 'agent',
      topic: 'pay', choice: 'production database kolibri', why: 'gift', replaces_id: 'u1' },
  ]);
  loadIndex(root);
  const cp = path.join(root, CACHE_FILE);
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  let removed = 0;
  for (const d of c.index.documents) { if (d.retired) { delete d.retired; removed += 1; } }
  fs.writeFileSync(cp, JSON.stringify(c));
  assert.ok(removed > 0, 'the fixture must actually have a retired document to strip');

  const r = retrieve(root, 'production database kolibri', grantProject('a'), { top: 5 });
  assert.ok(!r.claims.some((x) => x.id === 'm1'),
    'editing an unsigned local cache resurrected a disputed claim');
  rm(root);
});

test('a tampered cache cannot suppress a genuine claim', () => {
  const root = fixture([
    { id: 'u1', ts: '2026-01-01T00:00:00Z', author: 'lucky', authority: 'user',
      topic: 'pay', choice: 'zahlung nur per vorkasse', why: 'meine entscheidung' },
  ]);
  loadIndex(root);
  const cp = path.join(root, CACHE_FILE);
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  for (const d of c.index.documents) {
    if (d.entry?.id === 'u1') d.retired = { state: 'superseded', by: 'nobody', ts: '2026-06-01T00:00:00Z' };
  }
  fs.writeFileSync(cp, JSON.stringify(c));

  const r = retrieve(root, 'zahlung vorkasse entscheidung', grantProject('a'), { top: 5 });
  assert.ok(r.claims.some((x) => x.id === 'u1' && x.status === 'active'),
    'editing an unsigned local cache suppressed a genuine claim');
  rm(root);
});

test('a deleted cache changes speed, never meaning', () => {
  const root = fixture([A, B, M]);
  const withCache = retrieve(root, 'Server X steht', grantProject('a'),
    { top: 10, withDisputed: true });
  fs.rmSync(path.join(root, CACHE_FILE), { force: true });
  const without = retrieve(root, 'Server X steht', grantProject('a'),
    { top: 10, withDisputed: true });
  assert.deepEqual(
    without.claims.map((c) => `${c.id}:${c.status}`),
    withCache.claims.map((c) => `${c.id}:${c.status}`));
  rm(root);
});

test('a corrupt cache changes speed, never meaning', () => {
  const root = fixture([A, B, M]);
  loadIndex(root);
  fs.writeFileSync(path.join(root, CACHE_FILE), '{ not json at all');
  const r = retrieve(root, 'Server X steht', grantProject('a'), { top: 10, withDisputed: true });
  const byId = new Map(r.claims.map((c) => [c.id, c.status]));
  assert.equal(byId.get('B'), 'active');
  assert.ok(!byId.has('A'), 'a superseded claim came back from a corrupt cache');
  rm(root);
});

test('deriveState covers EVERY drawer, not just the first', () => {
  // A retirement can live in a different drawer than its target: a duty
  // closed by an event, a decision corrected from a project log. Deriving
  // from one file would silently keep retired claims alive.
  const root = fixture([A]);
  fs.writeFileSync(path.join(root, 'projects', 'a', 'events.jsonl'),
    z({ id: 'ev', ts: '2026-06-01T00:00:00Z', author: 'alice', authority: 'agent',
      title: 'moved', replaces_id: 'A' }));
  assert.equal(statusOf(deriveState(root), 'A'), 'superseded',
    'a retirement in another drawer was not seen');
  rm(root);
});

test('an unknown id is active — but the state map is what decides, not a constant', () => {
  const root = fixture([A, B, M]);
  const s = deriveState(root);
  assert.equal(statusOf(s, 'never-existed'), 'active');
  assert.equal(statusOf(s, 'A'), 'superseded', 'statusOf ignored the state it was given');
  rm(root);
});

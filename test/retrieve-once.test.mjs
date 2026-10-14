// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// retrieve-once.test.mjs — `mem retrieve` reads the log's retirements once,
// the log twice instead of three times, and norms each ranked vector once.
//
// cli-speed-cm, TB6. Measured at e98bf2d on a 20,000-entry scratch memory
// (5.2 MB): one `retrieve` 1,080 ms (median of 7 fresh processes); of that
// `deriveState` 141 ms per call and called TWICE (`retrieve` for its claims,
// `loadIndex` for the index's retired flags), three passes over the log each,
// and `docSimilarity` 58 ms, norming both vectors anew in every MMR comparison.
//
// Structural, not timed. What is counted: opens of the typed log files
// (`fs.openSync`, patched here for the length of one call), and calls of
// `Map.prototype.values` made by `search()`'s MMR pass.
//
// Red proof: copied onto a tree of the fixed base commit e98bf2d, tests 1, 3, 4, 5
// and 6 are red (there `deriveState` opens every log file three times, 9 not 6;
// `loadIndex` ignores a derived state; `retrieve` costs 21 opens, not 12; each vector is
// normed in every comparison, 1800 `values()` calls, not 30). Test 2 is the equivalence
// guard for the shortened read and is green on both sides, by design. Positive
// control in each: the count is not zero.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';
import * as search from '../src/search.mjs';
import * as retrieval from '../src/retrieval.mjs';
import * as capability from '../src/capability.mjs';
import { deriveState, deriveStateMaterialized } from '../src/state.mjs';

const z = (o) => `${JSON.stringify(o)}\n`;
const NOUNS = ['limiter', 'cache', 'queue', 'index', 'router', 'planner', 'backup', 'gateway'];

function put(root, rel, entries) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, entries.map(z).join(''));
}

/**
 * 320 plain decisions and learnings, then every kind of retirement line the
 * rule knows, spread over three typed files; a correction appears BEFORE its
 * target, one carries a long body.
 */
function world(t) {
  const root = tempDir('cm-retonce-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ participants: ['user'], language: 'en' }));
  const plain = [];
  for (let i = 0; i < 320; i += 1) {
    plain.push({
      id: `p${i}`, ts: `2026-01-${String((i % 27) + 1).padStart(2, '0')}T10:00:00Z`, author: 'lucky', authority: 'user',
      topic: NOUNS[i % NOUNS.length], title: `rate ${NOUNS[i % 8]} latency ${NOUNS[(i * 3) % 8]} number ${i}`,
      text: `the ${NOUNS[(i * 5) % 8]} ${i % 7 === 0 ? 'rate limiter ' : ''}latency doubled near ref${i.toString(36)}`,
    });
  }
  put(root, 'global/decisions.jsonl', plain);
  put(root, 'global/learnings.jsonl', [{ id: 'l1', ts: '2026-02-01T00:00:00Z', author: 'a1', authority: 'agent', title: 'rate limiter learned', text: 'a lesson' }]);
  put(root, 'global/duties.jsonl', [
    { id: 'du1', ts: '2026-02-02T00:00:00Z', author: 'lucky', authority: 'user', owner: 'bob', title: 'rate limiter duty', text: 'owed' },
  ]);
  put(root, 'global/decisions.jsonl', [
    // a correction BEFORE its target in file order (merge=union promises nothing about order)
    { id: 'c0', ts: '2026-03-01T00:00:00Z', author: 'lucky', authority: 'user', title: 'rate limiter fixed early', text: 'x'.repeat(4000), replaces_id: 'late-target' },
    { id: 'late-target', ts: '2026-01-01T00:00:00Z', author: 'lucky', authority: 'user', title: 'rate limiter target', text: 'old' },
    // same author discards: allowed
    { id: 'tomb1', ts: '2026-03-02T00:00:00Z', author: 'lucky', authority: 'user', retires_id: 'p3', state: 'discarded', why: 'not needed' },
    // an agent tries to discard a user claim: refused, the tombstone is disputed
    { id: 'tomb2', ts: '2026-03-03T00:00:00Z', author: 'a2', authority: 'agent', retires_id: 'p4', state: 'done', text: 'agent wants it gone' },
    // late supersede: successor with its own valid_from
    { id: 'succ', ts: '2026-03-04T00:00:00Z', valid_from: '2026-02-20T00:00:00Z', author: 'lucky', authority: 'user', title: 'rate limiter successor', text: 'new' },
    { id: 'tomb3', ts: '2026-03-05T00:00:00Z', author: 'lucky', authority: 'user', retires_id: 'p5', state: 'superseded', by_id: 'succ', why: 'replaced' },
    // origin.agent is the author; target by another author, equal tier
    { id: 'c1', ts: '2026-03-06T00:00:00Z', valid_from: '2026-03-01T00:00:00Z', origin: { agent: 'bot' }, authority: 'user', title: 'rate limiter bot fix', replaces_id: 'l1' },
    // dangling: target nowhere
    { id: 'tomb4', ts: '2026-03-07T00:00:00Z', author: 'lucky', authority: 'user', retires_id: 'ghost', state: 'discarded' },
  ]);
  put(root, 'global/duties.jsonl', [
    // the debtor closes his own duty (exception, different author name)
    { id: 'cl1', ts: '2026-03-08T00:00:00Z', author: 'bob', authority: 'agent', closes_id: 'du1', text: 'done by the debtor' },
  ]);
  return root;
}

const logFilesOf = (root) => ['decisions', 'learnings', 'duties'].map((n) => path.join(root, 'global', `${n}.jsonl`));

/** Opens of the typed logs made while `fn` runs. */
function countOpens(root, fn) {
  const logs = new Set(logFilesOf(root).map((p) => path.resolve(p)));
  const real = fs.openSync;
  let n = 0;
  fs.openSync = function patched(p, ...rest) {
    if (typeof p === 'string' && logs.has(path.resolve(p))) n += 1;
    return real.call(this, p, ...rest);
  };
  try { fn(); } finally { fs.openSync = real; }
  return n;
}

test('deriveState reads each typed log file twice, not three times', (t) => {
  const root = world(t);
  const files = logFilesOf(root).length;
  const opens = countOpens(root, () => deriveState(root));
  assert.ok(opens > 0, 'no open was counted: the patch did not bite (control)');
  assert.equal(opens, 2 * files);
});

test('the two-read result equals the whole-entry oracle, retirement kind by kind', (t) => {
  const root = world(t);
  const norm = (m) => JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  const got = deriveState(root);
  // control: the corpus really holds every state the rule can produce
  const states = new Set([...got.values()].map((v) => `${v.state}${v.unresolved ? '+unresolved' : ''}`));
  for (const want of ['discarded', 'done', 'superseded', 'disputed', 'discarded+unresolved']) {
    assert.ok(states.has(want), `the corpus no longer produces '${want}': ${[...states].join(', ')}`);
  }
  assert.ok(got.get('late-target')?.state === 'superseded' && got.get('p5')?.supersededAt === '2026-02-20T00:00:00Z'
    && got.get('l1')?.supersededAt === '2026-03-01T00:00:00Z');
  assert.equal(norm(got), norm(deriveStateMaterialized(root)));
});

test('loadIndex given a derived state does not derive its own', (t) => {
  const root = world(t);
  search.loadIndex(root, { fresh: true });   // build and write the cache
  search.loadIndex(root);                    // warm
  const D = countOpens(root, () => deriveState(root));
  const state = deriveState(root);
  const own = countOpens(root, () => search.loadIndex(root));
  const given = countOpens(root, () => search.loadIndex(root, { derivedState: state }));
  assert.ok(D > 0 && own > 0);
  assert.equal(own - given, D, `loadIndex must save exactly one derivation (${own} own, ${given} given, derive ${D})`);
});

test('one retrieve derives the retirements once, and ranks as before', (t) => {
  const root = world(t);
  search.loadIndex(root, { fresh: true });
  search.loadIndex(root);
  const cap = capability.grantAll('cli');
  const D = countOpens(root, () => deriveState(root));
  const own = countOpens(root, () => search.loadIndex(root));   // the index load AND its own derivation
  let r;
  const total = countOpens(root, () => { r = retrieval.retrieve(root, 'rate limiter latency', cap, {}); });
  assert.ok(D > 0 && own > D);
  assert.equal(total, own, `retrieve must cost no more than one index load with one derivation (total ${total}, load ${own}, derive ${D})`);
  // The ranking is the one the two-derivation path gives: the same call with the index handed in.
  const viaIndex = retrieval.retrieve(root, 'rate limiter latency', cap, { index: search.loadIndex(root) });
  assert.ok(r.claims.length > 3, 'too few claims to compare (control)');
  assert.deepEqual(r.claims.map((c) => [c.id, c.score, c.status]), viaIndex.claims.map((c) => [c.id, c.score, c.status]));
  assert.deepEqual(r.excluded, viaIndex.excluded);
  // and the retired ones stay out
  const ids = new Set(r.claims.map((c) => c.id));
  for (const gone of ['p3', 'late-target']) assert.ok(!ids.has(gone), `${gone} is retired and must not be a claim`);
});

class CountingMap extends Map {
  constructor(it) { super(it); this.valuesCalls = 0; }
  values() { this.valuesCalls += 1; return super.values(); }
}

test('docSimilarity with a norm memo: same value to the last bit, each vector normed once', () => {
  const vecs = [];
  for (let i = 0; i < 30; i += 1) {
    const m = new CountingMap();
    for (let k = 0; k < 12; k += 1) m.set(`w${(i * 7 + k * 3) % 40}`, 0.3 + ((i + k) % 5) / 7);
    vecs.push(m);
  }
  const plain = [];
  for (let i = 0; i < 30; i += 1) for (let j = 0; j < 30; j += 1) plain.push(search.docSimilarity(vecs[i], vecs[j]));
  const callsPlain = vecs.reduce((a, v) => a + v.valuesCalls, 0);
  vecs.forEach((v) => { v.valuesCalls = 0; });
  const norms = new Map();
  const memo = [];
  for (let i = 0; i < 30; i += 1) for (let j = 0; j < 30; j += 1) memo.push(search.docSimilarity(vecs[i], vecs[j], norms));
  const callsMemo = vecs.reduce((a, v) => a + v.valuesCalls, 0);
  assert.deepEqual(memo, plain);                 // identical, bit for bit
  assert.ok(plain.some((x) => x > 0 && x < 1));  // control: not all 0 or 1
  assert.equal(callsPlain, 2 * 900);             // without the memo: two norms per comparison
  assert.equal(callsMemo, 30);                   // with it: one per vector
  assert.equal(norms.size, 30);
});

test('search() with MMR norms each candidate once per ranking, not once per comparison', (t) => {
  const root = world(t);
  const index = search.loadIndex(root, { fresh: true });
  const realValues = Map.prototype.values;
  let calls = 0;
  const count = (fn) => {
    calls = 0;
    Map.prototype.values = function counted() { calls += 1; return realValues.call(this); };
    try { fn(); } finally { Map.prototype.values = realValues; }
    return calls;
  };
  const withMmr = count(() => search.search(index, 'rate limiter latency', { top: 10, mmr: true }));
  const without = count(() => search.search(index, 'rate limiter latency', { top: 10, mmr: false }));
  const pool = search.mmrPoolFor(10, true);
  assert.ok(withMmr > without, 'MMR made no norm at all: the control saw no ranking');
  assert.ok(withMmr - without <= pool, `MMR normed ${withMmr - without} times for a pool of ${pool}: it is per comparison again`);
});

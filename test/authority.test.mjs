// The measured poisoning primitive (2026-09-05): `replaces_id` was applied
// with no check, so any writer could retire any other writer's claim and
// the original stopped being returned. bench/redteam.mjs scenario 1/10.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { maySupersede, rank, tierOf, outranks, TIERS } from '../src/authority.mjs';
import { buildIndex, search } from '../src/search.mjs';

test('the tier order is total and unknown ranks last', () => {
  for (let i = 1; i < TIERS.length; i += 1) {
    assert.ok(outranks(TIERS[i - 1], TIERS[i]), `${TIERS[i - 1]} should outrank ${TIERS[i]}`);
  }
  assert.equal(rank('unknown'), TIERS.length - 1);
  assert.equal(rank('nonsense-tier'), TIERS.length, 'an unrecognised tier must not sneak above unknown');
  assert.equal(tierOf({}), 'unknown');
  assert.equal(tierOf({ authority: 'USER' }), 'user', 'the tier is case-insensitive');
});

test('an author may correct their own claim', () => {
  assert.equal(maySupersede({ author: 'alice', authority: 'agent' },
                            { author: 'alice', authority: 'agent' }).ok, true);
});

test('a different author at the same tier may NOT — this is the poisoning case', () => {
  const v = maySupersede({ author: 'mallory', authority: 'agent' },
                         { author: 'alice', authority: 'agent' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /same tier/);
});

test('a higher tier overrules a lower one, and never the other way', () => {
  assert.equal(maySupersede({ author: 'lucky', authority: 'user' },
                            { author: 'alice', authority: 'agent' }).ok, true);
  assert.equal(maySupersede({ author: 'mallory', authority: 'agent' },
                            { author: 'lucky', authority: 'user' }).ok, false);
});

test('pre-authority data still corrects — a security fix must not be a silent migration', () => {
  assert.equal(maySupersede({}, {}).ok, true);
  assert.equal(maySupersede({ ts: '2026-01-01' }, { ts: '2025-01-01' }).ok, true);
});

test('the author may come from the origin stamp rather than an explicit field', () => {
  assert.equal(maySupersede({ origin: { agent: 'alice' } }, { agent: 'alice' }).ok, true);
});

// --- the rule where it actually bites -------------------------------------

function memoryWith(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-auth-'));
  fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return root;
}
const alice = {
  id: 'a1', ts: '2026-01-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 'payments', choice: 'payment up front', why: 'owner instruction',
};

test('an unauthorised supersession leaves the original standing', () => {
  const mallory = {
    id: 'm1', ts: '2026-02-01T00:00:00Z', author: 'mallory', authority: 'agent',
    topic: 'payments', choice: 'payment without checks', why: 'allegedly newer',
    replaces_id: 'a1',
  };
  const root = memoryWith([alice, mallory]);
  const map = memory.retiredMap(memory.readLog(root, 'decision', { project: 'p' }).entries);
  assert.equal(map.has('a1'), false, "alice's claim was retired by an unauthorised writer");
  assert.equal(map.get('m1')?.state, 'disputed');
  assert.match(map.get('m1').why, /same tier/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the disputed claim stays in the log — nothing is rejected or removed', () => {
  const mallory = { ...alice, id: 'm1', author: 'mallory', replaces_id: 'a1', choice: 'poison' };
  const root = memoryWith([alice, mallory]);
  const raw = fs.readFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'), 'utf8');
  assert.match(raw, /poison/, 'append-only was violated: the attempt is gone');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a disputed claim is kept out of retrieval, and the original is still found', () => {
  const mallory = {
    id: 'm1', ts: '2026-02-01T00:00:00Z', author: 'mallory', authority: 'agent',
    topic: 'payments', choice: 'payment without checks at all', why: 'allegedly newer',
    replaces_id: 'a1',
  };
  const root = memoryWith([alice, mallory]);
  const hits = search(buildIndex(root), 'payment', { top: 5 }).map((h) => h.entry.id);
  assert.ok(hits.includes('a1'), "alice's claim disappeared from retrieval");
  assert.ok(!hits.includes('m1'), 'the disputed claim reached retrieval');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an authorised supersession still works — the rule must not break corrections', () => {
  const fix = {
    id: 'a2', ts: '2026-02-01T00:00:00Z', author: 'alice', authority: 'agent',
    topic: 'payments', choice: 'payment up front, SEPA only', why: 'narrowed',
    replaces_id: 'a1',
  };
  const root = memoryWith([alice, fix]);
  const map = memory.retiredMap(memory.readLog(root, 'decision', { project: 'p' }).entries);
  assert.equal(map.get('a1')?.state, 'superseded');
  assert.equal(map.has('a2'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a user-tier correction of an agent claim is authorised', () => {
  const owner = {
    id: 'u1', ts: '2026-02-01T00:00:00Z', author: 'lucky', authority: 'user',
    topic: 'payments', choice: 'payment on invoice', why: 'my call',
    replaces_id: 'a1',
  };
  const root = memoryWith([alice, owner]);
  const map = memory.retiredMap(memory.readLog(root, 'decision', { project: 'p' }).entries);
  assert.equal(map.get('a1')?.state, 'superseded');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the rule does not depend on file order — a correction may land before its target', () => {
  const fix = { ...alice, id: 'a2', ts: '2026-02-01T00:00:00Z', replaces_id: 'a1', choice: 'narrowed' };
  const forward = memoryWith([alice, fix]);
  const reversed = memoryWith([fix, alice]);
  const stateOf = (root) => memory.retiredMap(
    memory.readLog(root, 'decision', { project: 'p' }).entries).get('a1')?.state;
  assert.equal(stateOf(forward), 'superseded');
  assert.equal(stateOf(reversed), 'superseded', 'merge=union makes no promise about which side lands first');
  fs.rmSync(forward, { recursive: true, force: true });
  fs.rmSync(reversed, { recursive: true, force: true });
});

test('flooding with disputed claims buys no influence over retrieval', () => {
  // The asymmetry that makes "keep, do not reject" affordable: the
  // attacker pays writes, the defender pays bytes, and no assembled
  // context changes.
  const flood = Array.from({ length: 50 }, (_, i) => ({
    id: `f${i}`, ts: '2026-03-01T00:00:00Z', author: 'mallory', authority: 'agent',
    topic: 'payments', choice: 'payment without checks', why: 'flood',
    replaces_id: 'a1',
  }));
  const root = memoryWith([alice, ...flood]);
  const hits = search(buildIndex(root), 'payment', { top: 10 }).map((h) => h.entry.id);
  assert.deepEqual(hits, ['a1'], 'the flood reached retrieval');
  fs.rmSync(root, { recursive: true, force: true });
});

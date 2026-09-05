// The one place a model writes into the log had no authority ceiling.
// Found in the final verification round, 2026-09-05: `mem log` accepted
// whatever `authority` it was given, and the digest is driven by text that
// can itself be attacker-controlled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { clampTier, ceilingFromEnv, CEILING_ENV, TIERS } from '../src/authority.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ceil-'));
  fs.mkdirSync(path.join(r, 'projects', 'p'), { recursive: true });
  return r;
}
const rm = (r) => fs.rmSync(r, { recursive: true, force: true });

function withCeiling(tier, fn) {
  const before = process.env[CEILING_ENV];
  if (tier === null) delete process.env[CEILING_ENV];
  else process.env[CEILING_ENV] = tier;
  try { return fn(); } finally {
    if (before === undefined) delete process.env[CEILING_ENV];
    else process.env[CEILING_ENV] = before;
  }
}

test('clampTier lowers, never raises', () => {
  assert.deepEqual(clampTier('user', 'inferred'), { tier: 'inferred', clamped: true, from: 'user' });
  assert.deepEqual(clampTier('unknown', 'inferred'), { tier: 'unknown', clamped: false, from: 'unknown' });
  assert.deepEqual(clampTier('inferred', 'inferred'), { tier: 'inferred', clamped: false, from: 'inferred' });
  // No ceiling means no change at all.
  assert.deepEqual(clampTier('user', null), { tier: 'user', clamped: false, from: 'user' });
  // A nonsense ceiling must not become a ceiling.
  assert.deepEqual(clampTier('user', 'archbishop'), { tier: 'user', clamped: false, from: 'user' });
});

test('a nonsense tier reads as unknown rather than sneaking through', () => {
  assert.equal(clampTier('archbishop', 'agent').tier, 'unknown');
});

test('the ceiling comes from the environment, and only a real tier counts', () => {
  withCeiling('inferred', () => assert.equal(ceilingFromEnv(), 'inferred'));
  withCeiling('ARCHBISHOP', () => assert.equal(ceilingFromEnv(), null));
  withCeiling(null, () => assert.equal(ceilingFromEnv(), null));
});

test('a write that claims more than the ceiling is demoted, and the demotion is RECORDED', () => {
  const r = root();
  withCeiling('inferred', () => {
    const { entry } = memory.logEntry(r, 'decision',
      { authority: 'user', author: 'the-model', topic: 't', choice: 'c', why: 'w' },
      { project: 'p' });
    assert.equal(entry.authority, 'inferred');
    assert.equal(entry.authority_clamped_from, 'user',
      'a silent demotion hides exactly the event worth seeing');
  });
  rm(r);
});

test('a write at or below the ceiling is untouched', () => {
  const r = root();
  withCeiling('agent', () => {
    const { entry } = memory.logEntry(r, 'decision',
      { authority: 'external', topic: 't', choice: 'c', why: 'w' }, { project: 'p' });
    assert.equal(entry.authority, 'external');
    assert.ok(!('authority_clamped_from' in entry));
  });
  rm(r);
});

test('a ceiling never becomes a floor — an unstamped write stays unstamped', () => {
  // The first version of this test expected the ceiling to be stamped onto
  // an unstamped entry. That is backwards: `unknown` already ranks BELOW
  // every ceiling, so stamping would RAISE an entry of genuinely unknown
  // provenance. A ceiling only ever lowers.
  const r = root();
  withCeiling('inferred', () => {
    const { entry } = memory.logEntry(r, 'decision',
      { topic: 't', choice: 'c', why: 'w' }, { project: 'p' });
    assert.ok(!('authority' in entry), 'the ceiling acted as a floor');
  });
  rm(r);
});

test('without a ceiling nothing changes — this must not become a hidden default', () => {
  const r = root();
  withCeiling(null, () => {
    const { entry } = memory.logEntry(r, 'decision',
      { topic: 't', choice: 'c', why: 'w' }, { project: 'p' });
    assert.ok(!('authority' in entry), 'a ceiling-free write must stay unstamped');
  });
  rm(r);
});

test('a demoted claim can no longer overrule a user claim — the point of the ceiling', () => {
  const r = root();
  const p = path.join(r, 'projects', 'p', 'decisions.jsonl');
  fs.writeFileSync(p, JSON.stringify({ id: 'u1', ts: '2026-01-01T00:00:00Z',
    author: 'lucky', authority: 'user', topic: 't', choice: 'the owner decided', why: 'mine' }) + '\n');
  withCeiling('inferred', () => {
    memory.logEntry(r, 'decision', { id: 'm1', authority: 'user', author: 'the-model',
      topic: 't', choice: 'injected override', why: 'from a captured transcript',
      replaces_id: 'u1' }, { project: 'p' });
  });
  const map = memory.retiredMap(memory.readLog(r, 'decision', { project: 'p' }).entries);
  assert.equal(map.has('u1'), false, "the model's claim overruled the owner");
  assert.equal(map.get('m1')?.state, 'disputed');
  rm(r);
});

test('the digest sets the ceiling itself rather than asking the model to behave', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'bin', 'mem-digest'), 'utf8');
  assert.match(src, /export CHEAP_MEM_MAX_AUTHORITY=/);
  assert.match(src, /inferred/);
});

test('every tier name is a valid ceiling', () => {
  for (const t of TIERS) assert.equal(clampTier('user', t).tier, t === 'user' ? 'user' : t);
});

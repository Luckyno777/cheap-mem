// "Holds now" needs a time and a scope.
//
// **Where this comes from.** The external audit of 2026-09-17 logged a
// port with `valid_from 2027-01-01` and asked for the current port on
// 2026-09-16. It got the future one, flagged `stale: false`, with
// `ageDays: -107`. A negative age is the sound a sorting key makes when
// it is read as an answer: the code sorted by validity and took position
// zero, with nothing in between asking whether that version had started.
//
// Two more from the same run: three concurrent versions A, A, B reported
// no conflict, because only the first two were compared; and two
// projects that both recorded `db.engine` were folded into one fact, so
// alpha's Postgres came back as the HISTORY of beta's SQLite.
//
// invariant: drei-zustaende-nie-zwei
// invariant: annahme-statt-messung
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as fresh from '../src/freshness.mjs';
import * as memory from '../src/memory.mjs';
import * as config from '../src/config.mjs';

const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const HEUTE = new Date('2026-09-16T00:00:00Z');

test('POSITIVE: a version already in force IS the current one', () => {
  // Without this, every probe below would pass against a resolver that
  // simply never answers.
  const f = fresh.resolveFacts([
    { id: 'present', key: 'service.port', value: 8000, valid_from: '2026-09-01' },
  ], { now: HEUTE });
  assert.equal(f[0].current.id, 'present');
  assert.equal(f[0].state, fresh.LAGE.AKTUELL);
  assert.equal(f[0].ageDays, 15);
});

test('a version that starts next year does not win today', () => {
  const f = fresh.resolveFacts([
    { id: 'present', key: 'service.port', value: 8000, valid_from: '2026-09-01' },
    { id: 'future', key: 'service.port', value: 9000, valid_from: '2027-01-01' },
  ], { now: HEUTE });
  assert.equal(f[0].current.id, 'present', 'the future version is being served as current');
  assert.ok(f[0].ageDays >= 0, `negative age: ${f[0].ageDays}`);
  // And it is not swallowed either — "there is a value, it just does not
  // apply yet" is its own answer.
  assert.deepEqual(f[0].future.map((e) => e.id), ['future'],
    'the future version disappeared instead of being reported');
});

test('when everything is still in the future there is no current value, and it says so', () => {
  // Not `0`, not the future value, not silence. `ageDays: null` is the
  // house rule: a number nobody took must not look like a measurement.
  const f = fresh.resolveFacts([
    { id: 'future', key: 'service.port', value: 9000, valid_from: '2027-01-01' },
  ], { now: HEUTE });
  assert.equal(f[0].current, null);
  assert.equal(f[0].ageDays, null, 'an unmeasured age came back as a number');
  assert.equal(f[0].state, fresh.LAGE.NOCH_NICHT);
  assert.match(fresh.formatFact(f[0]), /not yet/, fresh.formatFact(f[0]));
  assert.equal(/as of/.test(fresh.formatFact(f[0])), false,
    'the line reads like a settled fact');
});

test('valid_until is respected, and it is exclusive', () => {
  const abgelaufen = fresh.resolveFacts([
    { id: 'alt', key: 'k', value: 1, valid_from: '2026-01-01', valid_until: '2026-06-01' },
  ], { now: HEUTE });
  assert.equal(abgelaufen[0].current, null, 'an expired version is still being served');
  assert.equal(abgelaufen[0].state, fresh.LAGE.ABGELAUFEN);
  // Exclusive: on the last day itself it no longer holds.
  const amTag = fresh.resolveFacts([
    { id: 'alt', key: 'k', value: 1, valid_from: '2026-01-01', valid_until: '2026-06-01' },
  ], { now: new Date('2026-06-01T00:00:00Z') });
  assert.equal(amTag[0].current, null, 'valid_until turned out to be inclusive after all');
  // One day earlier it does.
  const davor = fresh.resolveFacts([
    { id: 'alt', key: 'k', value: 1, valid_from: '2026-01-01', valid_until: '2026-06-01' },
  ], { now: new Date('2026-05-31T00:00:00Z') });
  assert.equal(davor[0].current.id, 'alt', 'a version inside its window was dropped');
});

test('a conflict among THREE concurrent versions is a conflict', () => {
  const c = fresh.resolveFacts([
    { id: 'a', key: 'x', value: 'A', ts: '2026-09-01' },
    { id: 'b', key: 'x', value: 'A', ts: '2026-09-01' },
    { id: 'c', key: 'x', value: 'B', ts: '2026-09-01' },
  ], { now: HEUTE });
  assert.equal(c[0].conflict, true, 'A, A, B reported agreement');
  // Counter-direction: three that really do agree are not a conflict.
  const einig = fresh.resolveFacts([
    { id: 'a', key: 'x', value: 'A', ts: '2026-09-01' },
    { id: 'b', key: 'x', value: 'A', ts: '2026-09-01' },
    { id: 'c', key: 'x', value: 'A', ts: '2026-09-01' },
  ], { now: HEUTE });
  assert.equal(einig[0].conflict, false, 'agreement was reported as conflict');
});

test('two projects with the same key are two facts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fakten-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    config.writeConfig(root, config.DEFAULT_CONFIG);
    memory.logEntry(root, 'timeline', {
      id: 'factaaa', key: 'db.engine', value: 'Postgres', ts: '2026-09-01T10:00:00Z',
    }, { project: 'alpha' });
    memory.logEntry(root, 'timeline', {
      id: 'factbbb', key: 'db.engine', value: 'SQLite', ts: '2026-09-02T10:00:00Z',
    }, { project: 'beta' });

    const facts = memory.currentFacts(root, { now: HEUTE });
    const nach = new Map(facts.map((f) => [f.project, f]));
    assert.equal(nach.size, 2, `the two projects collapsed into ${nach.size} fact(s)`);
    assert.equal(nach.get('alpha').current.value, 'Postgres');
    assert.equal(nach.get('beta').current.value, 'SQLite');
    // The decisive line: neither may appear as the other's history.
    for (const f of facts) {
      assert.deepEqual(f.history, [],
        `${f.project} invented a history from another project: ${JSON.stringify(f.history)}`);
    }
    // And a caller can ask for one scope on its own.
    const nurAlpha = memory.currentFacts(root, { now: HEUTE, project: 'alpha' });
    assert.deepEqual(nurAlpha.map((f) => f.current.value), ['Postgres']);
  } finally { away(root); }
});

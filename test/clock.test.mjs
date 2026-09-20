// test/clock.test.mjs — clock skew between writers (P18, 2026-09-20
// bauplan). `env/clock` used to report `unknown` forever ("no
// timestamped entry to compare against") because the old check compared
// the newest entry in the WHOLE memory — regardless of writer — against
// this process's own clock. src/clock.mjs narrows that to the newest
// FOREIGN line, and this file is the sabotage-verified probe plus the
// counter-probe the bauplan asks for: a healthy, multi-writer,
// ordinary-latency install must never be reported as skewed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as clock from '../src/clock.mjs';
import * as chain from '../src/chain.mjs';
import * as integrity from '../src/integrity.mjs';
import * as memory from '../src/memory.mjs';

const { computeSkew, measureClockSkew, collectTimestampedEntries, STATE } = clock;

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-clock-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  return root;
}
const away = (root) => fs.rmSync(root, { recursive: true, force: true });
const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------
// Third state: nothing to compare against is `unknown`, never a verdict
// ---------------------------------------------------------------------

test('no timestamped entries at all: unknown, not good', () => {
  const r = computeSkew([], { selfWriter: 'me' });
  assert.equal(r.state, STATE.UNKNOWN);
  assert.match(r.reason, /no timestamped entry/);
  assert.equal(r.sampleLines, 0);
  assert.equal(r.sampleWriters, 0);
});

test('every timestamped entry is this writer\'s own: unknown, not "no skew" — '
  + 'a single writer cannot measure skew between machines', () => {
  const now = Date.now();
  const entries = [
    { writer: 'me', ts: iso(now - 1000), t: now - 1000 },
    { writer: 'me', ts: iso(now - 2000), t: now - 2000 },
  ];
  const r = computeSkew(entries, { selfWriter: 'me', now });
  assert.equal(r.state, STATE.UNKNOWN);
  assert.match(r.reason, /single writer/);
  assert.match(r.reason, /me/, 'names the writer whose lines these all are');
});

// ---------------------------------------------------------------------
// Fixture: two writers, one deliberately skewed clock — sign reported
// ---------------------------------------------------------------------

test('a foreign line stamped well into the future is reported AHEAD, with its size', () => {
  const now = Date.now();
  const entries = [
    { writer: 'me', ts: iso(now - 500), t: now - 500 },
    { writer: 'far-machine', ts: iso(now + 15 * 60000), t: now + 15 * 60000 },
  ];
  const r = computeSkew(entries, { selfWriter: 'me', now });
  assert.equal(r.state, STATE.ERROR, 'well past the confident threshold');
  assert.equal(r.direction, 'ahead');
  assert.ok(Math.abs(r.skewMinutes - 15) < 0.01);
  assert.match(r.detail, /far-machine/);
  assert.match(r.detail, /AHEAD/);
  assert.ok(r.fix, 'a non-good finding must carry a next step');
});

test('a foreign line stamped a few minutes into the future is a WARN, below the confident line', () => {
  const now = Date.now();
  const entries = [
    { writer: 'me', ts: iso(now), t: now },
    { writer: 'far-machine', ts: iso(now + 2 * 60000), t: now + 2 * 60000 },
  ];
  const r = computeSkew(entries, { selfWriter: 'me', now });
  assert.equal(r.state, STATE.WARN);
  assert.equal(r.direction, 'ahead');
  assert.ok(r.fix);
});

test('order WITHIN a writer survives a clock that jumps backwards — it comes from the '
  + 'chain (file position + hash), never from ts', () => {
  const root = tmpRoot();
  try {
    const abs = memory.logPath(root, 'error');
    const line = (id, agent, ts) => JSON.stringify({ id, ts, title: `t-${id}`, agent });
    // Writer 'skewed' appends three real lines, in this real order, but
    // its clock jumps AROUND rather than advancing — exactly what a
    // skewed or merely unsynced clock produces. The chain only ever
    // reads file order, never ts, so it must not care.
    fs.writeFileSync(abs, [
      line('s1', 'skewed', '2026-01-01T12:00:00Z'),
      line('s2', 'skewed', '2026-01-01T09:00:00Z'),   // earlier ts, written SECOND
      line('s3', 'skewed', '2026-01-01T20:00:00Z'),   // later ts, written THIRD
    ].join('\n') + '\n');
    chain.appendSeal(abs, 'skewed');

    const before = chain.replay(fs.readFileSync(abs, 'utf8')).running.get('skewed');
    const report = integrity.checkChain(root);
    const row = report.writers.find((w) => w.writer === 'skewed');
    assert.equal(row.state, 'ok', 'the chain verifies despite the clock going backwards mid-stream');
    assert.equal(row.coveredCount, 3);

    // Reordering the SAME three lines by ts (what a naive ts-sort would
    // do) produces a different byte sequence and therefore a different
    // hash — proof the chain is not secretly deriving from ts either.
    const byTs = [
      line('s2', 'skewed', '2026-01-01T09:00:00Z'),
      line('s1', 'skewed', '2026-01-01T12:00:00Z'),
      line('s3', 'skewed', '2026-01-01T20:00:00Z'),
    ].join('\n') + '\n';
    const reorderedHash = chain.replay(byTs).running.get('skewed');
    assert.notEqual(reorderedHash, before,
      'a ts-sorted replay must NOT reach the same hash as the real append order');
  } finally { away(root); }
});

// ---------------------------------------------------------------------
// A single foreign line is an anecdote and must read as one
// ---------------------------------------------------------------------

test('one line from one writer: the report says so plainly', () => {
  const now = Date.now();
  const entries = [
    { writer: 'me', ts: iso(now), t: now },
    { writer: 'lonely-machine', ts: iso(now + 10 * 60000), t: now + 10 * 60000 },
  ];
  const r = computeSkew(entries, { selfWriter: 'me', now });
  assert.equal(r.sampleLines, 1);
  assert.equal(r.sampleWriters, 1);
  assert.match(r.detail, /single sample, not a measurement/);
});

test('several lines from several writers: the report names both counts, not an anecdote', () => {
  const now = Date.now();
  const entries = [
    { writer: 'me', ts: iso(now), t: now },
    { writer: 'w2', ts: iso(now + 8 * 60000), t: now + 8 * 60000 },
    { writer: 'w2', ts: iso(now - 1000), t: now - 1000 },
    { writer: 'w3', ts: iso(now - 2000), t: now - 2000 },
  ];
  const r = computeSkew(entries, { selfWriter: 'me', now });
  assert.equal(r.sampleLines, 3, '3 foreign lines (w2 x2, w3 x1)');
  assert.equal(r.sampleWriters, 2);
  assert.doesNotMatch(r.detail, /single sample/);
  assert.match(r.detail, /3 foreign lines from 2 writers/);
});

// ---------------------------------------------------------------------
// The abort criterion: never report a skew on a healthy installation
// ---------------------------------------------------------------------

test('COUNTER-PROBE: several writers, all in sync, ordinary write latency — reports GOOD, '
  + 'not a skew (the abort criterion this whole build answers to)', () => {
  const now = Date.now();
  // "Ordinary write latency": each writer's newest line lands a few
  // hundred milliseconds to a couple of seconds before `now`, the way a
  // real append-then-doctor-run sequence does. None of this is in the
  // future; none of it should ever escalate.
  const entries = [
    { writer: 'me', ts: iso(now - 100), t: now - 100 },
    { writer: 'w2', ts: iso(now - 900), t: now - 900 },
    { writer: 'w3', ts: iso(now - 300), t: now - 300 },
    { writer: 'w2', ts: iso(now - 4000), t: now - 4000 },
  ];
  const r = computeSkew(entries, { selfWriter: 'me', now });
  assert.equal(r.state, STATE.GOOD, 'a healthy install must never be flagged');
  assert.match(r.detail, /within ordinary clock jitter|behind this clock/);
});

test('COUNTER-PROBE: a foreign writer that has simply not written in hours stays GOOD — '
  + 'that is staleness, not measurable clock skew, and the finding says so', () => {
  const now = Date.now();
  const entries = [
    { writer: 'me', ts: iso(now), t: now },
    { writer: 'quiet-writer', ts: iso(now - 4 * 3600000), t: now - 4 * 3600000 },
  ];
  const r = computeSkew(entries, { selfWriter: 'me', now });
  assert.equal(r.state, STATE.GOOD,
    'behind, however large, is never on its own evidence of a bad clock');
  assert.equal(r.direction, 'behind');
  assert.match(r.detail, /cannot tell those apart/);
});

// ---------------------------------------------------------------------
// Sabotage: remove the skew report from the finding text
// ---------------------------------------------------------------------

test('SABOTAGE: a finding whose text drops the signed skew number makes the probe fail — '
  + 'red, then the real implementation — green', () => {
  const now = Date.now();
  const entries = [
    { writer: 'me', ts: iso(now), t: now },
    { writer: 'far-machine', ts: iso(now + 12 * 60000), t: now + 12 * 60000 },
  ];
  const real = computeSkew(entries, { selfWriter: 'me', now });

  // The probe every caller of this module actually needs to trust: the
  // finding text carries a SIGNED number, not just a verdict word.
  const probe = (text) => /-?\d+(\.\d+)?\s*min\s*(AHEAD|ahead|behind)/.test(text);

  assert.equal(probe(real.detail), true, 'GREEN: the shipped detail carries the signed number');

  // RED, by hand: a stripped report that only names the verdict, the
  // way an accidental refactor could leave it. Built here as its own
  // string, never by calling into src/clock.mjs's real path — this
  // reproduces the historical defect (a verdict with no number) on
  // purpose, the same way the house's other sabotage tests hand-build
  // the pre-fix shape instead of touching source or version control.
  const sabotaged = `${real.newestForeignWriter}'s clock does not match`;
  assert.equal(probe(sabotaged), false,
    'RED: without the signed number the probe correctly refuses to call this a measurement');
});

// ---------------------------------------------------------------------
// End to end: measureClockSkew(root) over a real memory
// ---------------------------------------------------------------------

test('measureClockSkew(root): a real two-writer memory reports the skew, signed', () => {
  const root = tmpRoot();
  try {
    const now = Date.now();
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z', agent: 'local' },
      { now: new Date(now - 1000) });
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y2', why: 'z2', agent: 'far-machine' },
      { now: new Date(now + 20 * 60000) });
    const r = measureClockSkew(root, { selfWriter: 'local', now });
    assert.equal(r.state, STATE.ERROR);
    assert.equal(r.direction, 'ahead');
    assert.equal(r.newestForeignWriter, 'far-machine');
  } finally { away(root); }
});

test('measureClockSkew(root): a single-writer memory is unknown, not "no skew"', () => {
  const root = tmpRoot();
  try {
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z', agent: 'solo' });
    const r = measureClockSkew(root, { selfWriter: 'solo' });
    assert.equal(r.state, STATE.UNKNOWN);
  } finally { away(root); }
});

test('collectTimestampedEntries(root) skips lines with no parseable ts, keeps the rest', () => {
  const root = tmpRoot();
  try {
    memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z', agent: 'a' });
    fs.appendFileSync(memory.logPath(root, 'decision'),
      `${JSON.stringify({ id: 'no-ts', title: 'nope', agent: 'a' })}\n`);
    const rows = collectTimestampedEntries(root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].writer, 'a');
  } finally { away(root); }
});

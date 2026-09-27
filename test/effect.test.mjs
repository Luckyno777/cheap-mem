// test/effect.test.mjs — M5 parity with lucky-mem's "Wirkung der
// Einblendungen" (src/effect.mjs, `mem effect`).
//
// Reuses the M18b journal (`.pipeline/injections.jsonl`) and
// `askedlearn.mjs`'s own session-reading machinery (`mentions()`, the
// 30-minute window, `selfShown()`) rather than re-implementing any of
// it — this module is entirely new, so "red on the old tree" is simply
// that it did not exist to import. The probes: a real follow-up mention
// counts, one outside the window or lacking a capture does not, a
// self-reinforced one is dropped rather than counted either way, and
// the 1000-pair floor gates the interval on and off with a synthetic
// (dependency-injected) corpus too large to build through real files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as raw from '../src/raw.mjs';
import * as injection from '../src/injection.mjs';
import * as eff from '../src/effect.mjs';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const T0 = Date.parse('2026-09-27T10:00:00Z');

function memoryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-effect-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ version: 1, language: 'en', participants: { user: 'u' } }));
  memory.logEntry(root, 'decision', { id: 'dabc0000001', title: 'moved billing to postgres', choice: 'postgres', why: 'x' }, { now: new Date('2026-09-01T00:00:00Z') });
  return root;
}

/** One turn: the person's real input, at `at`. */
function turn(session, at, text) {
  return { type: 'user', sessionId: session, timestamp: iso(at), promptId: `p${at}`, message: { role: 'user', content: text } };
}

function writeCapture(root, session, lines) {
  const tr = path.join(root, `${session}.jsonl`);
  fs.writeFileSync(tr, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = raw.capture(root, tr, { minBytes: 0 });
  assert.equal(r.status, 'captured', JSON.stringify(r));
}

function show(root, { session, at = T0, sources = ['global/decisions.jsonl:1'] } = {}) {
  injection.book(root, { ts: iso(at), session, occasion: injection.OCCASION.QUESTION, reason: null, sources });
}

test('PROBE: a follow-up mention of the injected id counts as used', () => {
  const root = memoryRoot();
  try {
    show(root, { session: 'sess-1', at: T0 });
    writeCapture(root, 'sess-1', [
      turn('sess-1', T0, 'is postgres still the choice for billing?'),
      turn('sess-1', T0 + 5 * 60_000, 'ok, opening dabc0000001 to check'),
    ]);
    const { list, counts } = eff.pairs(root);
    assert.equal(counts.shows, 1);
    assert.equal(list.length, 1);
    assert.equal(list[0].used, true, JSON.stringify(list));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no mention at all, or one outside the 30-minute window, is not used', () => {
  const root = memoryRoot();
  try {
    show(root, { session: 'sess-1', at: T0 });
    writeCapture(root, 'sess-1', [
      turn('sess-1', T0, 'is postgres still the choice for billing?'),
      turn('sess-1', T0 + 5 * 60_000, 'ok thanks'), // real capture, no mention
    ]);
    show(root, { session: 'sess-2', at: T0 });
    writeCapture(root, 'sess-2', [
      turn('sess-2', T0, 'is postgres still the choice for billing?'),
      turn('sess-2', T0 + 31 * 60_000, 'looking at dabc0000001 now'), // 31 min: outside the window
    ]);
    const { list, counts } = eff.pairs(root);
    assert.equal(list.length, 2);
    assert.ok(list.every((p) => p.used === false), JSON.stringify(list));
    assert.equal(counts.used, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('LATCH: a mention caused by the memory re-showing the place is not evidence', () => {
  const root = memoryRoot();
  try {
    show(root, { session: 'sess-1', at: T0 });
    // The memory shows the SAME place again a minute later — a second,
    // independent injection, not the one under test.
    show(root, { session: 'sess-1', at: T0 + 60_000 });
    writeCapture(root, 'sess-1', [
      turn('sess-1', T0, 'is postgres still the choice for billing?'),
      turn('sess-1', T0 + 90_000, 'thanks, dabc0000001 it is'),
    ]);
    const { list, counts } = eff.pairs(root);
    // The FIRST show's pair is dropped (self-reinforced); the second
    // show's own pair is real evidence and stays.
    assert.equal(counts.selfReinforced, 1, JSON.stringify(counts));
    assert.equal(list.length, 1);
    assert.equal(list[0].used, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a source with no resolvable id, or a session with no capture, is counted but not paired', () => {
  const root = memoryRoot();
  try {
    show(root, { session: 'sess-1', at: T0, sources: ['global/decisions.jsonl:99'] }); // no such line
    show(root, { session: 'sess-2', at: T0 }); // real source, capture never written
    const { list, counts } = eff.pairs(root);
    assert.equal(counts.noId, 1);
    assert.equal(counts.noCapture, 1);
    assert.equal(list.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('measure(): no injection on record reads as no-data, not zero', () => {
  const root = memoryRoot();
  try {
    const r = eff.measure(root);
    assert.equal(r.state, eff.STATE.NO_DATA);
    assert.match(eff.asText(r), /nothing to measure/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('measure(): under 1000 pairs is not-measurable even with a clean signal', () => {
  const root = memoryRoot();
  try {
    for (let i = 0; i < 5; i += 1) {
      show(root, { session: `s${i}`, at: T0 + i * 3_600_000 });
      writeCapture(root, `s${i}`, [
        turn(`s${i}`, T0 + i * 3_600_000, 'is postgres still the choice?'),
        turn(`s${i}`, T0 + i * 3_600_000 + 60_000, 'thanks, dabc0000001'),
      ]);
    }
    const r = eff.measure(root);
    assert.equal(r.state, eff.STATE.NOT_MEASURABLE);
    assert.equal(r.n, 5);
    assert.match(eff.asText(r), /Not measurable/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- the floor and the interval, over a corpus too large to build ------
// through real files: `pairs()` takes pre-built journal/lines/index, the
// same dependency-injection askedlearn.cases() already offers.

function syntheticIndex() {
  return { documents: [{ type: 'decision', source: 'global/decisions.jsonl', line: 1, entry: { id: 'dabc0000001' } }] };
}

/** `n` independent sessions, `used` of them naming the id afterwards. */
function syntheticCorpus(n, used) {
  const journal = [];
  const bySession = new Map();
  for (let i = 0; i < n; i += 1) {
    const session = `syn-${i}`;
    const t = T0 + i * 3_600_000;
    journal.push({ z: { ts: iso(t), session, occasion: injection.OCCASION.QUESTION, reason: null, sources: ['global/decisions.jsonl:1'] }, place: `.pipeline/injections.jsonl:${i + 1}` });
    const lines = [{ z: turn(session, t, 'is postgres still the choice?'), t }];
    if (i < used) lines.push({ z: turn(session, t + 60_000, 'yes, dabc0000001 confirmed'), t: t + 60_000 });
    bySession.set(session, lines);
  }
  return { journal, lines: { bySession, unreadable: 0 }, index: syntheticIndex() };
}

test('measure(): at exactly the floor the share and its Wilson interval are reported', () => {
  const { journal, lines, index } = syntheticCorpus(eff.MIN_PAIRS, 650);
  const r = eff.measure(null, { journal, lines, index });
  assert.equal(r.state, eff.STATE.MEASURED);
  assert.equal(r.n, eff.MIN_PAIRS);
  assert.equal(r.used, 650);
  assert.ok(Math.abs(r.rate - 0.65) < 1e-9);
  assert.ok(r.wilson.lo < r.rate && r.rate < r.wilson.hi, JSON.stringify(r.wilson));
  assert.ok(r.wilson.hi - r.wilson.lo < 0.07, 'n=1000 should already give a fairly tight interval');
});

test('measure(): one pair short of the floor is not-measurable', () => {
  const { journal, lines, index } = syntheticCorpus(eff.MIN_PAIRS - 1, 650);
  const r = eff.measure(null, { journal, lines, index });
  assert.equal(r.state, eff.STATE.NOT_MEASURABLE);
});

// --- wilson() on its own -------------------------------------------------

test('wilson(): 0 of n and n of n stay inside [0, 1] and do not collapse to a point', () => {
  const zero = eff.wilson(0, 1000);
  const all = eff.wilson(1000, 1000);
  assert.ok(zero.lo < 1e-9, zero.lo);
  assert.ok(zero.hi > 0);
  assert.ok(all.hi > 1 - 1e-9, all.hi);
  assert.ok(all.lo < 1);
});

test('wilson(): n=0 is null, not a fabricated interval', () => {
  assert.equal(eff.wilson(0, 0), null);
});

test('wilson(): a known reference value (k=50, n=100) matches the textbook interval', () => {
  // Wikipedia's own worked example for the 95% Wilson interval at
  // p-hat=0.5, n=100: approximately [0.404, 0.596].
  const w = eff.wilson(50, 100);
  assert.ok(Math.abs(w.lo - 0.404) < 0.005, w.lo);
  assert.ok(Math.abs(w.hi - 0.596) < 0.005, w.hi);
});

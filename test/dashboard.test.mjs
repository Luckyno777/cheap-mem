// The desk — and the one thing a dashboard must never do.
//
// **What this file is really guarding.** A UI export arrived on
// 2026-09-16 with five views and a hardcoded `DEMO` constant behind
// them. It fetched `/console.json`, gated the real board behind
// `Array.isArray(x.board)` — which is false, because `console.collect`
// returns an object — and so rendered invented numbers under a status
// pill reading "Daten: /console.json". Every assurance in this file
// exists because that page would have passed any test that only asked
// "does it render".
//
// So the probes here ask the two questions that separate a dashboard
// from a decoration:
//
//   1. Does a value that IS in the memory appear on the page?
//   2. Does a value that is NOT in the memory stay off it?
//
// The second one needs the first, or it is vacuous: a page that renders
// nothing at all also contains no demo strings.
//
// invariant: leer-ist-kein-bestehen
// invariant: drei-zustaende-nie-zwei
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as dashboard from '../src/dashboard.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';
import * as dashboardPage from '../src/dashboard-page.mjs';
import * as consolePage from '../src/console.mjs';
import * as memory from '../src/memory.mjs';
import * as agents from '../src/agents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');

/** Strings only this fixture can produce. Each one is checked for. */
const MINE = Object.freeze({
  learning: 'a hit is not a use',
  decision: 'no alias layer here',
  error: 'pwd answers in the MSYS form',
  duty: 'the raw captures need a delete',
  question: 'studio or the other one',
  project: 'quarry',
  agent: 'surveyor',
});

/**
 * Strings from the arriving export's `DEMO` constant.
 *
 * Not a sample — the whole distinctive set, so a re-introduced fallback
 * cannot slip in through the one field nobody listed. `lucky-mem` earns
 * its place twice: it was in the demo project list, and this repo must
 * never name the sibling project it was extracted from anyway.
 */
const THEIRS = Object.freeze([
  'Rohfang-Archiv', 'Fehlerklassen', 'MCP-Brücke', 'Fasser', 'Retrieval-Nutzung',
  'Retrieval-Verbrauch', 'Demo-Fallback', 'Demo-Daten',
  'l-001', 'd-018', 'Query darf State nicht ableiten', 'Keine allgemeine Alias-Schicht',
  'lucky-mem', 'Sitzungspost', 'Pflichten',
]);

function empty() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-desk-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'desk', participants: ['someone'], language: 'en' }));
  return r;
}

/** A memory whose every visible value is one of MINE. */
function filled({ extra = 0 } = {}) {
  const r = empty();
  agents.createAgent(r, MINE.agent, { role: 'measures things', model: 'none' });
  const learning = memory.logEntry(r, 'learning',
    { topic: 'retrieval', title: MINE.learning, text: 'a view on the log, never a second truth' });
  const decision = memory.logEntry(r, 'decision',
    { topic: 'retrieval', choice: MINE.decision, why: 'the spread was not spelling' },
    { project: MINE.project });
  const error = memory.logEntry(r, 'error',
    { klass: 'pfad-oder-arbeitsverzeichnis', title: MINE.error, text: 'so the file URL was wrong' },
    { project: MINE.project });
  memory.logEntry(r, 'duty', { title: MINE.duty, text: 'the desk should be able to remove one' });
  memory.logEntry(r, 'question', { question: MINE.question });
  // Declared edges, so the net matrix has something to draw, plus one
  // that points nowhere so the dangling counter is exercised.
  memory.logEntry(r, 'link',
    { from: learning.entry.id, to: error.entry.id, kind: 'resolves', why: 'came out of it' });
  memory.logEntry(r, 'link',
    { from: decision.entry.id, to: learning.entry.id, kind: 'contradicts', why: 'disputes it' });
  memory.logEntry(r, 'link',
    { from: learning.entry.id, to: 'zzzzzzzzzzzz', kind: 'causes', why: 'points at nothing' });
  // Filler, for probes that need to get PAST `LIST_MAX`. Without it
  // every fixture sits under the limit, the cut cuts nothing, and a
  // probe on the cut passes even when the cut is gone.
  for (let i = 0; i < extra; i += 1) {
    memory.logEntry(r, 'thought', { title: `filler thought ${i}`, text: 'filler' });
  }
  return { root: r, learning: learning.entry.id, error: error.entry.id };
}

const away = (r) => fs.rmSync(r, { recursive: true, force: true });

// --- the two questions ------------------------------------------------
//
// Since 2026-09-28 the page is the dashboard (src/dashboard-page.mjs +
// assets/dashboard/dashboard.js), built in the browser from
// /dashboard.json. The two questions are asked of what the page is made
// of: its payload, its shell and its script.
const SCRIPT = fs.readFileSync(path.join(HERE, '..', 'assets', 'dashboard', 'dashboard.js'), 'utf8');

test('POSITIVE: what is in the memory reaches the page', async () => {
  // Without this, the demo probe below is vacuous: an empty page also
  // contains no demo strings.
  const { root, learning } = filled();
  try {
    const data = dashboardData.collectDashboard(root);
    const payload = JSON.stringify(data);
    assert.ok(data.entries.length >= 6,
      `the fixture produced ${data.entries.length} entries — nothing was measured`);
    for (const [what, value] of Object.entries(MINE)) {
      assert.ok(payload.includes(value), `${what} never reached the page's data: ${value}`);
    }
    assert.ok(data.entries.some((e) => e.id === learning), 'no entry id in the data, so nothing is addressable');
  } finally { away(root); }
});

test('nothing invented: not one string of the arriving export survives', async () => {
  const { root } = filled();
  try {
    const all = JSON.stringify(dashboardData.collectDashboard(root)) + dashboardPage.asHtml({}) + SCRIPT;
    const found = THEIRS.filter((s) => all.includes(s));
    assert.deepEqual(found, [],
      `demo data on a page that claims to be measured: ${found.join(', ')}`);
  } finally { away(root); }
});

test('an empty memory says so instead of borrowing numbers', async () => {
  // The failure mode is not a crash — it is a page that looks healthy.
  const r = empty();
  try {
    const data = dashboardData.collectDashboard(r);
    assert.equal(data.entries.length, 0);
    assert.equal(data.meta.entriesTotal, 0);
    assert.match(SCRIPT, /holds no entry yet/);
    const found = THEIRS.filter((s) => JSON.stringify(data).includes(s));
    assert.deepEqual(found, [], `an empty memory rendered content: ${found.join(', ')}`);
  } finally { away(r); }
});

// --- four states, never two -------------------------------------------

test('a drawer nobody ever wrote to is unmeasured, not calm', async () => {
  // Zero-of-zero is the trap. "0 open duties" on a memory that has never
  // recorded one reads as healthy and means nothing was measured.
  const r = empty();
  try {
    const d = dashboard.collect(r);
    const duties = d.work.find((w) => w.title === 'Duties');
    assert.equal(duties.state, 'unknown', 'an empty drawer reported as measured');
    assert.equal(duties.value, null, 'an unmeasured count rendered as a number');
    // The note has to say WHY there is no number, not just that there
    // is none. "0 open" and "none was ever recorded" are the two states
    // this probe exists to keep apart.
    assert.match(duties.note, /has ever been recorded/);
  } finally { away(r); }
});

test('a drawer with entries and none open is calm, and says the difference', async () => {
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    const duties = d.work.find((w) => w.title === 'Duties');
    // The fixture leaves the one duty open, so this is the watch case —
    // what matters is that it is MEASURED, unlike the probe above.
    assert.notEqual(duties.state, 'unknown');
    assert.equal(duties.value, '1 / 1');
    assert.equal(duties.total, 1);
  } finally { away(root); }
});

test('the state vocabulary is closed in both directions', () => {
  assert.equal(dashboard.word('unknown'), 'not measured');
  assert.notEqual(dashboard.word('unknown'), dashboard.word('calm'));
  // A fifth state must not quietly pick a word or a colour. Both the
  // word and the tone are looked up, and both refuse.
  assert.throws(() => dashboard.word('ok'), /Unknown state 'ok'/);
});

test('an unreadable entry is not reported as a global one', () => {
  // `capability.scopeOf(undefined)` answers `'global'` — a confident
  // wrong answer rather than a gap. The desk records readability as its
  // own field for exactly that reason.
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    for (const e of d.entries) {
      assert.equal(typeof e.readable, 'boolean', `${e.id} does not say whether it was read`);
      if (!e.readable) assert.equal(e.scope, null, `${e.id} claims a scope it cannot have`);
    }
    assert.ok(d.entries.every((e) => e.readable),
      'this fixture should be fully readable — the probe is measuring the wrong thing');
  } finally { away(root); }
});

// --- no second truth ---------------------------------------------------

test('the board states are the console\'s, not a second derivation', async () => {
  const { root } = filled();
  try {
    const mine = dashboard.collect(root);
    const theirs = consolePage.collect(root);
    const a = Object.fromEntries(mine.system.map((t) => [t.id, t.state]));
    const b = Object.fromEntries(theirs.board.tiles.map((t) => [t.id, t.state]));
    assert.deepEqual(a, b, 'the desk and the console disagree about the same tiles');
    assert.equal(mine.system.length, theirs.board.tiles.length);
  } finally { away(root); }
});

test('attention is sorted alarm first and never hides an unmeasured tile', async () => {
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    const rank = d.attention.map((t) => dashboard.RANK[t.state]);
    assert.deepEqual(rank, [...rank].sort((x, y) => x - y), 'attention is out of order');
    assert.ok(d.attention.every((t) => t.state !== 'calm'), 'a calm tile wants attention');
    const unmeasured = d.system.filter((t) => t.state === 'unknown');
    for (const t of unmeasured) {
      assert.ok(d.attention.some((x) => x.id === t.id),
        `${t.id} is unmeasured and was left off the attention list`);
    }
  } finally { away(root); }
});

test('the net shows declared links only, and counts the ones that point nowhere', async () => {
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    assert.ok(d.net.pairs.length > 0, 'the fixture declared links and none arrived');
    assert.equal(d.net.dangling, 1, 'the link into nothing was swallowed');
    const kinds = new Set(d.net.pairs.flatMap((p) => Object.keys(p.kinds)));
    assert.ok(kinds.size > 0, 'the pairs carry no kinds — nothing was measured about them');
    // Nothing similarity-based: every kind must be one the net declares.
    const allowed = new Set(['derived_from', 'replaces', 'closes', 'causes',
      'generalises', 'resolves', 'contradicts']);
    for (const k of kinds) assert.ok(allowed.has(k), `invented link kind: ${k}`);
  } finally { away(root); }
});

// --- the tabs -----------------------------------------------------------

// --- the knowledge space ------------------------------------------------

// --- the page itself ---------------------------------------------------


// --- the routes --------------------------------------------------------

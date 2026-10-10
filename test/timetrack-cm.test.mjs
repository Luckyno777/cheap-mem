// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/timetrack-cm.test.mjs - the time track (src/timetrack.mjs): a
// time-window question reads only the blocks of a drawer that can hold a line
// in the window (port of lucky-mem's `zeitspur-lm`, 2026-10-10).
//
// Finding: `timesearch.entriesInWindow` -> `memory.find` walked every line of
// every drawer, twice (900 ms at 100,000 entries / 112 MB, bench/timetrack-
// measure.mjs). With a track the same hits come back from a fraction of the
// bytes.
//
// What is proved, and how:
//  - RED PROOF, in the file: at the FIXED commit b5959ed (cheap-mem main
//    before the track) the same question reads at least twice the bytes of
//    all drawers; today it reads at most a quarter. The probe counts bytes
//    (an `fs.readSync` spy), not the wall clock. Positive control: the spy
//    counts (the old code's two passes come out as 2x), and old and new
//    return the same non-empty hits.
//  - EQUIVALENCE: track == full scan (`track: false`), deepEqual (hits, order,
//    `_line`, `_retired`), over many windows x filters, over a corpus with a
//    late entry carrying an old ts, BOM, CRLF, blank lines, a broken line,
//    ts missing / a number / without a zone / nested / twice, duplicate ids,
//    tombstones and corrections inside and outside the windows.
//  - Mutation: a track that wrongly skips a block makes the equivalence probe
//    red (the probe can fail).
//  - THREE STATES: missing / broken / stale are answered by a full read of
//    that drawer and SAID in the report, never as an empty answer.
//  - The track is extended by appending blocks and equals a fresh build.
//  - The background build (kickBuild) and the CLI (`mem when`) end to end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as timetrack from '../src/timetrack.mjs';
import * as timesearch from '../src/timesearch.mjs';
import * as capability from '../src/capability.mjs';
import * as shardarchive from '../src/shardarchive.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// A FIXED commit, never merge-base (it moves with the merge and turns the proof red):
// cheap-mem main before the time track.
const OLD_STAND = 'b5959ed38a2d859a762df7da893f6ce17b0ee0cb';
// The first version of the track (before the review): it asked for a rebuild on every question for a giant last line.
const FIRST_TRACK = '6f54b586ccca3a89974b47d7ccc1aefc3c97a3b0';
const SMALL = { blockBytes: 4096, minBytes: 0 };
const BASE = Date.UTC(2026, 0, 1);
const HOUR = 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();

function tmpRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-timetrack-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    version: 1, language: 'en', participants: { user: { role: 'the human', human: true }, session: 'an AI session' },
  }));
  return root;
}

// A small deterministic generator (mulberry32), so every run sees the same corpus.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['alpha', 'bravo', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'harbor', 'island', 'juniper'];
const wordsOf = (r, n) => Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]).join(' ');

/** One plain line: an entry at hour `h` after BASE. */
function plain(id, h, r, extra = {}) {
  return JSON.stringify({ id, ts: iso(BASE + h * HOUR), title: wordsOf(r, 3), text: wordsOf(r, 30), ...extra });
}

function drawerFile(root, type, project = null) { return memory.logPath(root, type, project); }
function put(root, type, lines, { project = null, eol = '\n', bom = false } = {}) {
  const p = drawerFile(root, type, project);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, (bom ? '﻿' : '') + lines.join(eol) + eol);
  return p;
}

/**
 * The tricky corpus: three drawers in two scopes. Entry `i` sits at hour `i`
 * (roughly in file order) plus oddities. Returns the root and the ids that
 * the state lines name.
 */
function trickyRoot({ n = 1500, seed = 7 } = {}) {
  const root = tmpRoot();
  memory.projectInit(root, 'alpha');
  const r = rng(seed);
  const lines = { decision: [], learning: [], event: [] };
  const alpha = { decision: [], learning: [] };
  const types = ['decision', 'learning', 'event'];
  for (let i = 0; i < n; i += 1) {
    const type = types[i % 3];
    const target = (i % 7 === 0 && type !== 'event') ? alpha : lines;
    const id = `e${i}`;
    let line = plain(id, i, r);
    if (i % 97 === 5) line = plain(id, i - 600 < 0 ? 0 : i - 600, r);                 // a late entry, old ts
    if (i % 89 === 3) line = JSON.stringify({ id, title: 'no ts', text: wordsOf(r, 20) });
    if (i % 83 === 4) line = JSON.stringify({ id, ts: i, title: 'ts is a number', text: wordsOf(r, 20) });
    if (i % 79 === 6) line = JSON.stringify({ id, ts: iso(BASE + i * HOUR).slice(0, 19), title: 'zone-less', text: wordsOf(r, 20) });
    if (i % 73 === 8) line = JSON.stringify({ id, ts: iso(BASE + i * HOUR).slice(0, 10), title: 'date only', text: wordsOf(r, 20) });
    if (i % 71 === 9) line = JSON.stringify({ id, ts: iso(BASE + i * HOUR).replace('Z', '+02:00'), title: 'offset', text: wordsOf(r, 20) });
    if (i % 67 === 2) line = JSON.stringify({ id, meta: { ts: iso(BASE + (i + 300) * HOUR) }, ts: iso(BASE + i * HOUR), text: 'nested ts' });
    if (i % 61 === 1) line = JSON.stringify({ id, ts: 'soon', title: 'unreadable ts', text: wordsOf(r, 10) });
    if (i % 59 === 11) line = '{"id":"broken' + i + '","ts":"' + iso(BASE + i * HOUR) + '", "text": '; // does not parse
    if (i % 53 === 12) { target[type].push(''); }                                      // a blank line
    if (i % 101 === 13) line = plain(`e${i - 50 < 0 ? 0 : i - 50}`, i, r);             // duplicate id
    target[type].push(line);
  }
  // State lines: tombstones and corrections, some inside the windows below, some far from their targets.
  lines.decision.push(JSON.stringify({ id: 't1', ts: iso(BASE + 300 * HOUR), retires_id: 'e10', state: 'done', why: 'finished' }));
  lines.learning.push(JSON.stringify({ id: 't2', ts: iso(BASE + 1400 * HOUR), retires_id: 'e700', state: 'discarded' }));
  lines.event.push(JSON.stringify({ id: 'c1', ts: iso(BASE + 1450 * HOUR), replaces_id: 'e902', title: 'corrected', text: 'new text' }));
  lines.decision.push(JSON.stringify({ id: 't3', ts: iso(BASE + 20 * HOUR), closes_id: 'e1200' }));
  put(root, 'decision', lines.decision, { bom: true });
  put(root, 'learning', lines.learning, { eol: '\r\n' });
  put(root, 'event', lines.event);
  put(root, 'decision', alpha.decision, { project: 'alpha' });
  put(root, 'learning', alpha.learning, { project: 'alpha' });
  return root;
}

const ALL = (s = 'probe') => capability.grantAll(s);

/** Hits of one window, by the track and by the full scan, with the report of the track. */
function ask(root, from, to, extra = {}) {
  const cap = extra.capability ?? ALL();
  const common = {
    withRetired: true, windowMs: { from, to }, since: extra.since ?? null,
    projects: extra.projects ?? null,
    accept: (e) => {
      const t = e.ts ? new Date(e.ts).getTime() : NaN;
      return !(Number.isNaN(t) || t < from || t >= to);
    },
  };
  const pattern = extra.pattern ?? '';
  const report = {};
  const tracked = memory.find(root, pattern, cap, { ...common, report });
  const full = memory.find(root, pattern, cap, { ...common, track: false });
  return { tracked, full, report };
}

function windows() {
  const day = 24 * HOUR;
  const w = [
    [BASE + 100 * HOUR, BASE + 100 * HOUR + day],            // one day
    [BASE + 400 * HOUR, BASE + 400 * HOUR + 7 * day],        // one week
    [BASE + 700 * HOUR, BASE + 700 * HOUR + 1],              // exactly one ts
    [BASE + 700 * HOUR + 1, BASE + 700 * HOUR + 2],          // just after it
    [BASE + 299 * HOUR, BASE + 301 * HOUR],                  // around the first tombstone
    [BASE + 1399 * HOUR, BASE + 1401 * HOUR],                // around the second tombstone
    [BASE + 1449 * HOUR, BASE + 1451 * HOUR],                // around the correction line
    [BASE + 9 * HOUR, BASE + 11 * HOUR],                     // a retired target
    [BASE - 1000 * HOUR, BASE + 1 * HOUR],                   // before the corpus
    [BASE + 5000 * HOUR, BASE + 6000 * HOUR],                // after the corpus
    [BASE - 10 * day, BASE + 5000 * HOUR],                   // everything
    [BASE + 600 * HOUR, BASE + 610 * HOUR],                  // where the late entries with old ts live
    [BASE + 0, BASE + 12 * HOUR],                            // the start (BOM line)
    [BASE + 1490 * HOUR, BASE + 1500 * HOUR],                // the end
  ];
  return w;
}

// ---------------------------------------------------------------------------
// Equivalence
// ---------------------------------------------------------------------------

test('EQUIVALENCE: track == full scan (hits, order, _line, _retired) over many windows x filters, with built tracks', () => {
  const root = trickyRoot();
  try {
    const built = memory.buildTimeTracks(root, SMALL);
    assert.ok(built.built >= 4, `tracks built: ${JSON.stringify(built)}`);
    const filters = [
      {},
      { pattern: 'alpha' },
      { pattern: 'bravo cedar' },
      { projects: [null] },
      { projects: ['alpha'] },
      { capability: capability.grantProject('alpha', { subject: 'probe' }) },
      { since: iso(BASE + 450 * HOUR) },
    ];
    let nonEmpty = 0; let viaTrack = 0; let viaState = 0;
    for (const [from, to] of windows()) {
      for (const f of filters) {
        const { tracked, full, report } = ask(root, from, to, { ...f, root });
        assert.deepEqual(tracked, full, `window ${iso(from)}..${iso(to)} filter ${JSON.stringify(f)} way=${report.way}/${report.reason}`);
        if (full.length) nonEmpty += 1;
        if (report.way === 'track') viaTrack += 1;
        if (report.reason === 'state') viaState += 1;
      }
    }
    assert.ok(nonEmpty > 30, `the probe must see non-empty answers (${nonEmpty})`);
    assert.ok(viaTrack > 30, `most windows must be answered by the track (${viaTrack})`);
    assert.ok(viaState >= 3, `windows with a retired or corrected candidate must take the state fallback (${viaState})`);
  } finally { removeTree(root); }
});

test('EQUIVALENCE: 60 random windows over a corpus that is not ordered by ts', () => {
  const root = trickyRoot({ n: 1800, seed: 11 });
  try {
    memory.buildTimeTracks(root, SMALL);
    const r = rng(99);
    let track = 0;
    for (let i = 0; i < 60; i += 1) {
      const from = BASE + Math.floor(r() * 1900 - 50) * HOUR + Math.floor(r() * 3600000);
      const to = from + Math.floor(r() * 120 * HOUR) + 1;
      const { tracked, full, report } = ask(root, from, to, { root });
      assert.deepEqual(tracked, full, `window ${iso(from)}..${iso(to)}`);
      if (report.way === 'track') track += 1;
    }
    assert.ok(track > 20, `random windows answered by the track: ${track}`);
  } finally { removeTree(root); }
});

test('the entriesInWindow wrapper gives the same answer with and without the track, sorted, with a report', () => {
  const root = trickyRoot();
  try {
    memory.buildTimeTracks(root, SMALL);
    const cap = ALL();
    const win = { from: new Date(BASE + 200 * HOUR), to: new Date(BASE + 260 * HOUR), words: ['alpha'] };
    const report = {};
    const a = timesearch.entriesInWindow(root, cap, { ...win, report });
    const b = timesearch.entriesInWindow(root, cap, { ...win, track: false });
    assert.ok(a.length > 0);
    assert.deepEqual(a, b);
    assert.equal(report.way, 'track');
    assert.ok(report.blocksSkipped > 0 && report.blocksRead > 0, JSON.stringify(report));
  } finally { removeTree(root); }
});

test('EQUIVALENCE at every block edge: windows hugging the min and the max ts of each block (1 ms before, on, 1 ms after)', () => {
  const root = trickyRoot({ n: 1200, seed: 31 });
  try {
    memory.buildTimeTracks(root, SMALL);
    let edges = 0;
    for (const type of ['decision', 'learning', 'event']) {
      const d = JSON.parse(fs.readFileSync(timetrack.trackPath(root, drawerFile(root, type)), 'utf8'));
      for (const b of d.blocks) {
        for (const v of [b[2], b[3]]) {
          if (v === null) continue;
          for (const [from, to] of [[v - 1, v], [v, v + 1], [v + 1, v + 2], [v - 1, v + 2]]) {
            const q = ask(root, from, to, { root });
            assert.deepEqual(q.tracked, q.full, `${type} edge ${iso(v)} window ${from}..${to}`);
            edges += 1;
          }
        }
      }
    }
    assert.ok(edges > 400, `edges checked: ${edges}`);
  } finally { removeTree(root); }
});

// ---------------------------------------------------------------------------
// The state cases
// ---------------------------------------------------------------------------

test('STATE: a retired or corrected candidate is settled from a few extra blocks (exact, with its _retired note); only a correction line as candidate takes the full scan', () => {
  const root = tmpRoot();
  try {
    const r = rng(3);
    const lines = [];
    for (let i = 0; i < 600; i += 1) lines.push(plain(`x${i}`, i, r));
    lines.push(JSON.stringify({ id: 'tomb', ts: iso(BASE + 100 * HOUR), retires_id: 'x5', state: 'done' }));         // tombstone in window 100h, target at 5h
    lines.push(JSON.stringify({ id: 'tomb2', ts: iso(BASE + 500 * HOUR), retires_id: 'x300', state: 'discarded' }));  // target at 300h
    lines.push(JSON.stringify({ id: 'corr', ts: iso(BASE + 520 * HOUR), replaces_id: 'x40', title: 'fixed' }));
    // many more plain lines AFTER the state lines, so the state lines sit in closed, skipped blocks
    for (let i = 600; i < 1400; i += 1) lines.push(plain(`x${i}`, i, r));
    put(root, 'decision', lines);
    memory.buildTimeTracks(root, SMALL);

    // 1) window around hour 100: holds the tombstone line (not a hit) and plain entries -> track, nothing extra
    const a = ask(root, BASE + 98 * HOUR, BASE + 102 * HOUR, { root });
    assert.equal(a.report.way, 'track', `a tombstone in the window must not force the full scan (${a.report.reason})`);
    assert.equal(a.report.extraBlocks, 0);
    assert.deepEqual(a.tracked, a.full);
    assert.ok(a.tracked.length >= 4);

    // 2) window around hour 300: x300 is named by a tombstone far away, in a block the window does not touch
    const b = ask(root, BASE + 299 * HOUR, BASE + 301 * HOUR, { root });
    assert.equal(b.report.way, 'track', `exact: ${b.report.reason}`);
    assert.equal(b.report.stateResolved, true);
    assert.deepEqual(b.tracked, b.full);
    const x300 = b.tracked.find((e) => e.id === 'x300');
    assert.ok(x300?._retired, 'the retired entry is still annotated');
    assert.equal(x300._retired.by, 'tomb2');

    // 3) window with the correction line itself (a candidate that is a state line, not closing): full scan
    const c = ask(root, BASE + 519 * HOUR, BASE + 521 * HOUR, { root });
    assert.equal(c.report.way, 'full');
    assert.equal(c.report.reason, 'state');
    assert.deepEqual(c.tracked, c.full);
    assert.ok(c.tracked.some((e) => e.id === 'corr'));

    // 4) window around hour 40: x40 is corrected by a far line -> exact, superseded note
    const d = ask(root, BASE + 39 * HOUR, BASE + 41 * HOUR, { root });
    assert.equal(d.report.way, 'track', `exact: ${d.report.reason}`);
    assert.deepEqual(d.tracked, d.full);
    assert.equal(d.tracked.find((e) => e.id === 'x40')?._retired?.state, 'superseded');

    // 5) a window far from every named id: track, nothing extra
    const e = ask(root, BASE + 200 * HOUR, BASE + 202 * HOUR, { root });
    assert.equal(e.report.way, 'track');
    assert.equal(e.report.extraBlocks, 0);
    assert.deepEqual(e.tracked, e.full);
  } finally { removeTree(root); }
});

test('STATE exact: a state line in a closed, skipped block, window on its target (gap probe for the track\'s state ids and records)', () => {
  const root = tmpRoot();
  try {
    const r = rng(41);
    const lines = [];
    for (let i = 0; i < 300; i += 1) lines.push(plain(`m${i}`, i, r));
    lines.push(JSON.stringify({ id: 'mt1', ts: iso(BASE + 3000 * HOUR), retires_id: 'm150', state: 'done', why: 'finished' }));
    lines.push(JSON.stringify({ id: 'mc1', ts: iso(BASE + 3001 * HOUR), replaces_id: 'm200', title: 'newer' }));
    lines.push(JSON.stringify({ id: 'mt2', ts: iso(BASE + 3002 * HOUR), closes_id: 'm250' }));
    for (let i = 300; i < 900; i += 1) lines.push(plain(`m${i}`, i + 4000, r));      // pushes the state lines into closed blocks
    put(root, 'duty', lines);
    memory.buildTimeTracks(root, SMALL);
    const d = JSON.parse(fs.readFileSync(timetrack.trackPath(root, drawerFile(root, 'duty')), 'utf8'));
    const stateBlock = d.blocks.findIndex((b) => b[2] <= BASE + 3002 * HOUR && b[3] >= BASE + 3000 * HOUR);
    assert.ok(stateBlock >= 0 && stateBlock < d.blocks.length - 1, 'the state lines sit in a closed block');
    for (const [id, h] of [['m150', 150], ['m200', 200], ['m250', 250]]) {
      const q = ask(root, BASE + h * HOUR, BASE + h * HOUR + 1, { root });
      assert.equal(q.report.way, 'track', `${id}: ${q.report.reason}`);
      assert.equal(q.report.stateResolved, true, id);
      assert.deepEqual(q.tracked, q.full, id);
      assert.ok(q.tracked[0]?._retired, `${id} must carry its retired note`);
      assert.ok(q.report.extraBlocks >= 1 && q.report.extraBlocks <= 2, `${id}: only the state block is read extra (${q.report.extraBlocks})`);
    }
  } finally { removeTree(root); }
});

test('STATE falls back, never guesses: a state line with by_id, a duplicate id, a state line sharing a candidate id', () => {
  const root = tmpRoot();
  try {
    const r = rng(43);
    const lines = [];
    for (let i = 0; i < 400; i += 1) {
      // line 250: a second n20, far from the state lines; line 60: an EARLIER n61 right before the real one, outside the window
      lines.push(i === 250 ? plain('n20', 5000, r) : (i === 60 ? plain('n61', 6000, r) : plain(`n${i}`, i, r)));
    }
    lines.push(JSON.stringify({ id: 'tn61', ts: iso(BASE + 2004 * HOUR), retires_id: 'n61', state: 'done' }));
    lines.push(JSON.stringify({ id: 'sup', ts: iso(BASE + 2000 * HOUR), retires_id: 'n10', state: 'superseded', by_id: 'n11' }));   // the successor's line is needed
    lines.push(JSON.stringify({ id: 'tn20', ts: iso(BASE + 2001 * HOUR), retires_id: 'n20', state: 'done' }));
    lines.push(JSON.stringify({ id: 'n30', ts: iso(BASE + 2003 * HOUR), retires_id: 'n31', state: 'done' }));                  // a state line with a candidate's id
    for (let i = 400; i < 800; i += 1) lines.push(plain(`n${i}`, i + 3000, r));
    put(root, 'thought', lines);
    memory.buildTimeTracks(root, SMALL);
    const expectations = { 10: 'state', 20: 'state', 30: 'state', 61: 'state', 11: null, 31: null, 100: null };
    for (const [h, reason] of Object.entries(expectations)) {
      const q = ask(root, BASE + Number(h) * HOUR, BASE + Number(h) * HOUR + 1, { root });
      assert.deepEqual(q.tracked, q.full, `n${h}`);
      assert.equal(q.report.reason, reason, `n${h}: ${q.report.way}/${q.report.reason}`);
    }
    // the exact ones carry the right notes
    const n31 = ask(root, BASE + 31 * HOUR, BASE + 31 * HOUR + 1, { root });
    assert.equal(n31.tracked[0]._retired.state, 'done');
    assert.equal(n31.report.stateResolved, true);
  } finally { removeTree(root); }
});

test('STATE exact with a big tracked drawer next to a small drawer without a track (the usual shape of a real memory)', () => {
  const root = tmpRoot();
  try {
    const r = rng(71);
    const big = []; for (let i = 0; i < 1500; i += 1) big.push(plain(`b${i}`, i, r));
    big.push(JSON.stringify({ id: 'tb1', ts: iso(BASE + 3000 * HOUR), retires_id: 'b900', state: 'done' }));
    for (let i = 1500; i < 2500; i += 1) big.push(plain(`b${i}`, i, r));
    const small = []; for (let i = 0; i < 200; i += 1) small.push(plain(`s${i}`, 5000 + i, r));
    small.push(JSON.stringify({ id: 'ts1', ts: iso(BASE + 6000 * HOUR), retires_id: 's100', state: 'discarded' }));   // a small entry
    small.push(JSON.stringify({ id: 'ts2', ts: iso(BASE + 6001 * HOUR), retires_id: 'b1200', state: 'done' }));        // a big entry, retired from the small drawer
    put(root, 'learning', big);                                          // 'decision' comes before 'learning' in the file order
    put(root, 'decision', small);
    memory.buildTimeTracks(root);                                       // default sizes: only the big drawer gets a track
    assert.equal(timetrack.readTrack(root, drawerFile(root, 'learning')).status, 'valid');
    assert.equal(timetrack.readTrack(root, drawerFile(root, 'decision')).status, 'missing');
    for (const [id, h] of [['b900', 900], ['s100', 5100], ['b1200', 1200]]) {
      const q = ask(root, BASE + h * HOUR, BASE + h * HOUR + 1, { root });
      assert.equal(q.report.drawers.small, 1, JSON.stringify(q.report.drawers));
      assert.equal(q.report.way, 'track', `${id}: ${q.report.reason}`);
      assert.equal(q.report.stateResolved, true, id);
      assert.deepEqual(q.tracked, q.full, id);
      assert.equal(q.tracked[0]?._retired?.state, id === 's100' ? 'discarded' : 'done', id);
    }
    // a EARLIER line with the id b900 in the small drawer (read in full, so seen): the candidate is no longer the first line
    fs.appendFileSync(drawerFile(root, 'decision'), `${plain('b900', 7000, r)}\n`);
    const dup = ask(root, BASE + 900 * HOUR, BASE + 900 * HOUR + 1, { root });
    assert.deepEqual(dup.tracked, dup.full);
    assert.equal(dup.report.reason, 'state', 'a second line with the id b900 (in the small drawer) means the first-line proof does not hold');
  } finally { removeTree(root); }
});

test('a valid track whose side file is missing, broken, torn or of another prefix asks for a rebuild and takes the full scan; the rebuild repairs it', () => {
  const root = tmpRoot();
  try {
    const r = rng(72);
    const lines = [];
    for (let i = 0; i < 300; i += 1) lines.push(plain(`m${i}`, i, r));
    lines.push(JSON.stringify({ id: 'mt1', ts: iso(BASE + 3000 * HOUR), retires_id: 'm150', state: 'done' }));
    for (let i = 300; i < 900; i += 1) lines.push(plain(`m${i}`, i + 4000, r));
    const p = put(root, 'duty', lines);
    memory.buildTimeTracks(root, SMALL);
    const aux = timetrack.trackPath(root, p).replace(/\.json$/, '.aux.json');
    const good = fs.readFileSync(aux, 'utf8');
    const first = JSON.parse(good);
    const probe = () => ask(root, BASE + 150 * HOUR, BASE + 150 * HOUR + 1, { root });
    const ok = probe();
    assert.equal(ok.report.stateResolved, true);
    assert.equal(ok.report.buildNeeded, false);

    // an older side file: append so the track is extended, then put the old side file back (torn pair)
    fs.appendFileSync(p, `${Array.from({ length: 400 }, (_, i) => plain(`z${i}`, 9000 + i, r)).join('\n')}\n`);
    memory.buildTimeTracks(root, SMALL);
    const extended = fs.readFileSync(aux, 'utf8');
    assert.notEqual(JSON.parse(extended).covered, first.covered, 'the side file moved with the extension');
    const cases = {
      missing: null,
      'not JSON': 'torn{',
      'old prefix (torn pair)': good,
      'other fingerprint': JSON.stringify({ ...JSON.parse(extended), fp: 'deadbeef' }),
    };
    for (const [name, content] of Object.entries(cases)) {
      if (content === null) fs.rmSync(aux, { force: true }); else fs.writeFileSync(aux, content);
      const q = probe();
      assert.deepEqual(q.tracked, q.full, name);
      assert.equal(q.report.reason, 'state', `${name}: ${q.report.way}/${q.report.reason}`);
      assert.equal(q.report.buildNeeded, true, `${name}: a rebuild is asked for`);
      assert.equal(memory.buildTimeTracks(root, SMALL).built, 1, `${name}: the track is rebuilt from scratch`);
      const again = probe();
      assert.equal(again.report.stateResolved, true, `${name}: exact again after the rebuild`);
      assert.equal(again.report.buildNeeded, false);
      fs.writeFileSync(aux, fs.readFileSync(aux, 'utf8'));
    }
  } finally { removeTree(root); }
});

test('a line with two "id" keys in a skipped block switches the exact answer off for the question (it could hide a duplicate id)', () => {
  const root = tmpRoot();
  try {
    const r = rng(73);
    const lines = [];
    for (let i = 0; i < 300; i += 1) lines.push(plain(`k${i}`, i, r));
    lines[10] = `{"id":"other","id":"k150","ts":"${iso(BASE + 10 * HOUR)}","text":"two id keys: JSON.parse reads the last; its block lies outside the window"}`;
    lines.push(JSON.stringify({ id: 'kt', ts: iso(BASE + 3000 * HOUR), retires_id: 'k150', state: 'done' }));
    for (let i = 300; i < 900; i += 1) lines.push(plain(`k${i}`, i + 4000, r));
    put(root, 'duty', lines);
    memory.buildTimeTracks(root, SMALL);
    const q = ask(root, BASE + 150 * HOUR, BASE + 150 * HOUR + 1, { root });
    assert.deepEqual(q.tracked, q.full);
    assert.equal(q.report.way, 'full');
    assert.equal(q.report.reason, 'state', 'the ambiguous line makes the first-line proof impossible');
    const free = ask(root, BASE + 100 * HOUR, BASE + 100 * HOUR + 1, { root });
    assert.equal(free.report.way, 'track', 'a window without a named candidate is not affected');
  } finally { removeTree(root); }
});

test('a candidate in the TAIL that a state line in the covered prefix names is settled exactly', () => {
  const root = tmpRoot();
  try {
    const r = rng(74);
    const lines = [];
    for (let i = 0; i < 200; i += 1) lines.push(plain(`t${i}`, i, r));
    lines.push(JSON.stringify({ id: 'tt', ts: iso(BASE + 3000 * HOUR), retires_id: 'tail1', state: 'done' }));   // the tombstone comes BEFORE its target
    for (let i = 200; i < 800; i += 1) lines.push(plain(`t${i}`, i + 4000, r));
    const p = put(root, 'duty', lines);
    memory.buildTimeTracks(root, SMALL);
    fs.appendFileSync(p, `${plain('tail1', 9500, r)}\n`);                                                      // the target arrives later, in the tail
    const data = timetrack.readTrack(root, p).data;
    assert.ok(data.covered < fs.statSync(p).size);
    const q = ask(root, BASE + 9500 * HOUR, BASE + 9500 * HOUR + 1, { root });
    assert.equal(q.tracked.length, 1);
    assert.equal(q.report.way, 'track', `${q.report.reason}`);
    assert.equal(q.report.stateResolved, true);
    assert.deepEqual(q.tracked, q.full);
    assert.equal(q.tracked[0]._retired?.state, 'done');
  } finally { removeTree(root); }
});

test('STATE: a duplicate id shared with a state line is still annotated (the state line\'s own id is in the track)', () => {
  const root = tmpRoot();
  try {
    const r = rng(5);
    const lines = [];
    for (let i = 0; i < 400; i += 1) lines.push(plain(`y${i}`, i, r));
    // a refused correction (lower authority than its target) marks ITS OWN id as disputed; a plain line shares that id
    lines.push(JSON.stringify({ id: 'y50', ts: iso(BASE + 450 * HOUR), replaces_id: 'y60', authority: 'agent' }));
    put(root, 'learning', lines);
    memory.buildTimeTracks(root, SMALL);
    const q = ask(root, BASE + 49 * HOUR, BASE + 51 * HOUR, { root });
    assert.deepEqual(q.tracked, q.full);
    assert.equal(q.report.reason, 'state', 'y50 is a state line\'s own id, so the window with the plain y50 needs the full scan');
  } finally { removeTree(root); }
});

// ---------------------------------------------------------------------------
// Three states of the track
// ---------------------------------------------------------------------------

test('THREE STATES: missing / broken / stale are read in full, said in the report, and give the same hits', () => {
  const root = trickyRoot({ n: 900, seed: 21 });
  try {
    const from = BASE + 300 * HOUR; const to = BASE + 330 * HOUR;
    const reference = ask(root, from, to, { root }).full;
    assert.ok(reference.length > 5);

    // missing: no track at all (drawers are big enough for a track only with SMALL minBytes; here they are
    // 'small' under the default, so check both words)
    const none = ask(root, from, to, { root });
    assert.deepEqual(none.tracked, reference);
    assert.equal(none.report.drawers.valid, 0);
    assert.equal(none.report.way, 'full', 'nothing was skipped: that is not a track answer');
    assert.equal(none.report.reason, 'no-track');
    assert.equal(none.report.drawers.missing + none.report.drawers.small, 7, JSON.stringify(none.report.drawers)); // 5 with lines, 2 empty (projectInit)

    memory.buildTimeTracks(root, SMALL);
    const ok = ask(root, from, to, { root });
    assert.equal(ok.report.drawers.valid, 7, JSON.stringify(ok.report)); // the two empty ones get a track with nothing covered
    assert.deepEqual(ok.tracked, reference);

    // broken: garbage, wrong version, wrong file name, wrong shape
    const target = drawerFile(root, 'decision');
    const tp = timetrack.trackPath(root, target);
    const good = fs.readFileSync(tp, 'utf8');
    const parsed = JSON.parse(good);
    const breaks = {
      'not JSON': 'this is no json',
      'empty file': '',
      'wrong version': JSON.stringify({ ...parsed, version: 99 }),
      'other drawer': JSON.stringify({ ...parsed, file: 'global/other.jsonl' }),
      'bad block': JSON.stringify({ ...parsed, blocks: [[0, 0, 'x', 1, 0]] }),
      'unsorted blocks': JSON.stringify({ ...parsed, blocks: [...parsed.blocks].reverse() }),
      'array': '[]',
    };
    for (const [name, text] of Object.entries(breaks)) {
      fs.writeFileSync(tp, text);
      const r = ask(root, from, to, { root });
      assert.equal(r.report.drawers.broken, 1, `${name}: ${JSON.stringify(r.report.drawers)}`);
      assert.deepEqual(r.tracked, reference, name);
    }
    fs.writeFileSync(tp, good);

    // stale (fingerprint): the drawer was rewritten at the front (shard archiving removes the oldest lines)
    const original = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, original.split('\n').slice(40).join('\n'));
    const afterFront = ask(root, from, to, { root });
    assert.equal(afterFront.report.drawers.stale, 1, JSON.stringify(afterFront.report.drawers));
    assert.deepEqual(afterFront.tracked, afterFront.full);

    // stale (a line inserted in the middle, as a union merge does)
    const ls = original.split('\n');
    ls.splice(Math.floor(ls.length / 2), 0, plain('inserted', 305, rng(1)));
    fs.writeFileSync(target, ls.join('\n'));
    const afterInsert = ask(root, from, to, { root });
    assert.equal(afterInsert.report.drawers.stale, 1, JSON.stringify(afterInsert.report.drawers));
    assert.deepEqual(afterInsert.tracked, afterInsert.full);
    assert.ok(afterInsert.tracked.some((e) => e.id === 'inserted'), 'the inserted line is found');

    // stale (a shrunk drawer)
    fs.writeFileSync(target, original.slice(0, 2000));
    const shrunk = ask(root, from, to, { root });
    assert.equal(shrunk.report.drawers.stale, 1);
    assert.deepEqual(shrunk.tracked, shrunk.full);
  } finally { removeTree(root); }
});

test('STALE by block boundary: an offset that is not a line start falls back to the full scan and says so', () => {
  const root = trickyRoot({ n: 900, seed: 22 });
  try {
    memory.buildTimeTracks(root, SMALL);
    const target = drawerFile(root, 'learning');
    const tp = timetrack.trackPath(root, target);
    const d = JSON.parse(fs.readFileSync(tp, 'utf8'));
    d.blocks[3][0] += 1; // keeps order and shape, breaks the boundary; the fingerprint still matches
    fs.writeFileSync(tp, JSON.stringify(d));
    // a window that reads block 3 (the answer itself is the full scan's, whatever the block holds)
    const mid = d.blocks[3];
    const from = Math.min(...[mid[2]].filter((x) => x !== null));
    const r = ask(root, from, from + 1, { root });
    assert.equal(r.report.way, 'full');
    assert.equal(r.report.reason, 'stale');
    assert.deepEqual(r.tracked, r.full);
  } finally { removeTree(root); }
});

test('MUTATION: a track that wrongly skips a block makes the equivalence probe red', () => {
  const root = trickyRoot({ n: 900, seed: 23 });
  try {
    memory.buildTimeTracks(root, SMALL);
    const target = drawerFile(root, 'learning');
    const tp = timetrack.trackPath(root, target);
    const d = JSON.parse(fs.readFileSync(tp, 'utf8'));
    const k = d.blocks.findIndex((b) => b[2] !== null && b[4] === 0 && b[0] > 0);
    assert.ok(k > 0);
    const [from, to] = [d.blocks[k][2], d.blocks[k][3] + 1];
    const before = ask(root, from, to, { root });
    assert.deepEqual(before.tracked, before.full);
    assert.ok(before.full.length > 0);
    // lie: claim the block lies a year later
    d.blocks[k][2] += 365 * 24 * HOUR; d.blocks[k][3] += 365 * 24 * HOUR;
    fs.writeFileSync(tp, JSON.stringify(d));
    const after = ask(root, from, to, { root });
    assert.notDeepEqual(after.tracked, after.full, 'the probe must be able to fail');
  } finally { removeTree(root); }
});

test('ts as a number and as a JSON escape: such a block is open and the line is found (it cannot be read from the text)', () => {
  const root = tmpRoot();
  try {
    const r = rng(51);
    const lines = [];
    for (let i = 0; i < 500; i += 1) lines.push(plain(`q${i}`, i, r));
    const numberTs = BASE + 6000 * HOUR;
    const escapedTs = iso(BASE + 7000 * HOUR);
    lines[250] = JSON.stringify({ id: 'qnum', ts: numberTs, text: wordsOf(r, 20) });
    lines[300] = `{"id":"qesc","ts":"${escapedTs.slice(0, 4)}\\u002d${escapedTs.slice(5)}","text":"escaped"}`;
    put(root, 'learning', lines);
    memory.buildTimeTracks(root, SMALL);
    const d = JSON.parse(fs.readFileSync(timetrack.trackPath(root, drawerFile(root, 'learning')), 'utf8'));
    assert.ok(d.blocks.filter((b) => b[4] === 1).length >= 2, 'both odd lines sit in open blocks');
    for (const [id, ms] of [['qnum', numberTs], ['qesc', BASE + 7000 * HOUR]]) {
      const q = ask(root, ms - HOUR, ms + HOUR, { root });
      assert.deepEqual(q.tracked, q.full, id);
      assert.ok(q.tracked.some((e) => e.id === id), `${id} must be found`);
      assert.equal(q.report.way, 'track');
    }
  } finally { removeTree(root); }
});

test('after shard archiving (the drawer lost its oldest lines) the track is stale, said, and rebuilt', () => {
  const root = tmpRoot();
  try {
    const r = rng(52);
    const lines = [];
    for (let i = 0; i < 800; i += 1) lines.push(plain(`a${i}`, i, r));
    put(root, 'decision', lines);
    memory.buildTimeTracks(root, SMALL);
    const from = BASE + 500 * HOUR; const to = from + 6 * HOUR;
    const before = ask(root, from, to, { root });
    assert.equal(before.report.drawers.valid, 1);
    assert.equal(before.report.way, 'track');

    shardarchive.archiveOldest(root, 'decision', { count: 100 });
    const stale = ask(root, from, to, { root });
    assert.equal(stale.report.drawers.stale, 1, JSON.stringify(stale.report.drawers));
    assert.deepEqual(stale.tracked, stale.full);
    assert.ok(stale.tracked.length >= 5);
    assert.equal(stale.report.buildNeeded, false, 'the drawer is small (default minimum): no child for it');

    assert.equal(memory.buildTimeTracks(root, SMALL).built, 1, 'rebuilt from scratch, not extended');
    const after = ask(root, from, to, { root });
    assert.equal(after.report.drawers.valid, 1);
    assert.equal(after.report.way, 'track');
    assert.deepEqual(after.tracked, after.full);
  } finally { removeTree(root); }
});

// ---------------------------------------------------------------------------
// Time zone: the process that builds and the one that asks may differ
// ---------------------------------------------------------------------------

test('ZONE: a zone-less ts is never skipped; build and question in different TZ still equal the full scan', () => {
  const root = tmpRoot();
  try {
    const r = rng(8);
    const lines = [];
    for (let i = 0; i < 700; i += 1) {
      lines.push(i % 20 === 7
        ? JSON.stringify({ id: `z${i}`, ts: iso(BASE + i * HOUR).slice(0, 19), text: wordsOf(r, 25) })
        : plain(`z${i}`, i, r));
    }
    put(root, 'event', lines);
    const rootUrl = JSON.stringify(root);
    const modUrl = JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'memory.mjs')).href);
    const capUrl = JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'capability.mjs')).href);
    const build = `import(${modUrl}).then((m) => { console.log(JSON.stringify(m.buildTimeTracks(${rootUrl}, { blockBytes: 4096, minBytes: 0 }))); });`;
    const ask1 = `Promise.all([import(${modUrl}), import(${capUrl})]).then(([m, c]) => {
      const cap = c.grantAll('probe');
      const win = (from, to, track) => m.find(${rootUrl}, '', cap, { withRetired: true, windowMs: { from, to }, track,
        accept: (e) => { const t = e.ts ? new Date(e.ts).getTime() : NaN; return !(Number.isNaN(t) || t < from || t >= to); } });
      const out = [];
      for (let h = 3; h < 690; h += 37) {
        const from = ${BASE} + h * 3600000; const to = from + 5 * 3600000;
        out.push({ h, same: JSON.stringify(win(from, to, true)) === JSON.stringify(win(from, to, false)), n: win(from, to, false).length });
      }
      console.log(JSON.stringify(out));
    });`;
    const run = (tz, code) => {
      const res = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
      assert.equal(res.status, 0, res.stderr);
      return JSON.parse(res.stdout);
    };
    const built = run('Pacific/Kiritimati', build);
    assert.ok(built.built >= 1, JSON.stringify(built));
    for (const tz of ['America/Los_Angeles', 'UTC', 'Pacific/Kiritimati']) {
      const rows = run(tz, ask1);
      assert.ok(rows.some((x) => x.n > 0));
      for (const row of rows) assert.ok(row.same, `TZ=${tz} hour ${row.h}: track differs from the full scan`);
    }
    // the blocks that hold a zone-less value are marked open
    const d = JSON.parse(fs.readFileSync(timetrack.trackPath(root, drawerFile(root, 'event')), 'utf8'));
    assert.ok(d.blocks.some((b) => b[4] === 1), 'a block holding a zone-less ts is open');
    assert.ok(d.blocks.some((b) => b[4] === 0), 'a block without one is not');
  } finally { removeTree(root); }
});

// ---------------------------------------------------------------------------
// Growing drawers: extending the track
// ---------------------------------------------------------------------------

test('EXTEND: appended lines are found at once (tail), and extending equals a fresh build', () => {
  const root = tmpRoot();
  const fresh = tmpRoot();
  try {
    const r = rng(13);
    const first = []; for (let i = 0; i < 500; i += 1) first.push(plain(`g${i}`, i, r));
    const p = put(root, 'decision', first);
    const a = timetrack.buildFile(root, p, SMALL);
    assert.equal(a.action, 'built');
    const before = JSON.parse(fs.readFileSync(timetrack.trackPath(root, p), 'utf8'));
    assert.ok(before.covered > 0 && before.covered < fs.statSync(p).size, 'the open block stays in the tail');

    // append more, with a tombstone and an old-ts entry
    const more = []; for (let i = 500; i < 900; i += 1) more.push(plain(`g${i}`, i, r));
    more.push(plain('late', 20, r));
    more.push(JSON.stringify({ id: 'tb', ts: iso(BASE + 899 * HOUR), retires_id: 'g3', state: 'done' }));
    fs.appendFileSync(p, `${more.join('\n')}\n`);

    // before the track is extended: the answer already covers the new bytes
    const mid = ask(root, BASE + 850 * HOUR, BASE + 860 * HOUR, { root });
    assert.deepEqual(mid.tracked, mid.full);
    assert.ok(mid.tracked.length >= 9);
    const old = ask(root, BASE + 19 * HOUR, BASE + 21 * HOUR, { root });
    assert.deepEqual(old.tracked, old.full);
    assert.ok(old.tracked.some((e) => e.id === 'late'));
    const named = ask(root, BASE + 2 * HOUR, BASE + 4 * HOUR, { root });
    assert.equal(named.report.way, 'track', `g3 is retired by a line in the tail: exact (${named.report.reason})`);
    assert.deepEqual(named.tracked, named.full);
    assert.equal(named.tracked.find((e) => e.id === 'g3')?._retired?.state, 'done');

    const b = timetrack.buildFile(root, p, SMALL);
    assert.equal(b.action, 'extended');
    const after = JSON.parse(fs.readFileSync(timetrack.trackPath(root, p), 'utf8'));
    assert.ok(after.covered > before.covered && after.blocks.length > before.blocks.length);
    assert.deepEqual(after.blocks.slice(0, before.blocks.length), before.blocks, 'old blocks are kept as they were');

    // a fresh build over the same bytes gives the same track
    const p2 = drawerFile(fresh, 'decision');
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    fs.copyFileSync(p, p2);
    timetrack.buildFile(fresh, p2, SMALL);
    const f = JSON.parse(fs.readFileSync(timetrack.trackPath(fresh, p2), 'utf8'));
    assert.deepEqual({ ...f, file: '' }, { ...after, file: '' });

    // and nothing new to cover: kept
    assert.equal(timetrack.buildFile(root, p, SMALL).action, 'kept');
    const c = ask(root, BASE + 850 * HOUR, BASE + 860 * HOUR, { root });
    assert.deepEqual(c.tracked, c.full);
    assert.equal(c.report.drawers.valid, 1);
  } finally { removeTree(root); removeTree(fresh); }
});

test('SMALL drawers get no track (default size), an empty or missing drawer reads as nothing, not as an error', () => {
  const root = tmpRoot();
  try {
    const r = rng(2);
    put(root, 'event', [plain('s1', 1, r), plain('s2', 2, r)]);
    fs.writeFileSync(drawerFile(root, 'error'), '');           // empty file
    assert.equal(memory.buildTimeTracks(root).small, 2);
    assert.equal(fs.existsSync(path.join(root, '.mem', 'timetrack')), false);
    const q = ask(root, BASE, BASE + 10 * HOUR, { root });
    assert.equal(q.tracked.length, 2);
    assert.deepEqual(q.tracked, q.full);
    assert.equal(q.report.drawers.small, 2);
    assert.equal(q.report.buildNeeded, false, 'small drawers never ask for a build');
  } finally { removeTree(root); }
});

test('an unreadable drawer is a ReadError on both ways, not an empty answer', () => {
  const root = tmpRoot();
  try {
    fs.mkdirSync(drawerFile(root, 'event'), { recursive: true }); // a directory where the drawer should be
    for (const track of [true, false]) {
      assert.throws(() => memory.find(root, '', ALL(), { windowMs: { from: 0, to: 1e15 }, track }),
        (e) => e.name === 'ReadError', `track=${track}`);
    }
  } finally { removeTree(root); }
});

// ---------------------------------------------------------------------------
// Background build and the CLI, end to end
// ---------------------------------------------------------------------------

function bigRoot() {
  const root = tmpRoot();
  const r = rng(4);
  for (const type of ['decision', 'learning']) {
    const lines = []; for (let i = 0; i < 1500; i += 1) lines.push(plain(`${type[0]}${i}`, i, r));
    put(root, type, lines);
  }
  return root;
}

test('kickBuild: one child at a time (lock), the track appears, the lock goes away', () => {
  const root = bigRoot();
  try {
    const lock = path.join(root, timetrack.BUILD_LOCK_PATH);
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, 'someone else is building\n');
    assert.equal(timetrack.kickBuild(root), 'running', 'a fresh lock is respected');
    fs.rmSync(lock, { force: true });
    assert.equal(timetrack.kickBuild(root), 'started');
    assert.ok(timetrack.waitForBuildIdle(root, 60000), 'the build ends');
    const tr = timetrack.readTrack(root, drawerFile(root, 'decision'));
    assert.equal(tr.status, 'valid');
    assert.ok(tr.data.blocks.length >= 1);
    assert.equal(timetrack.readTrack(root, drawerFile(root, 'learning')).status, 'valid');
  } finally { removeTree(root); }
});

function giantLastLineRoot() {
  const root = tmpRoot();
  const r = rng(61);
  const lines = [];
  for (let i = 0; i < 1200; i += 1) lines.push(plain(`v${i}`, i, r));
  lines.push(JSON.stringify({ id: 'giant', ts: iso(BASE + 1300 * HOUR), text: 'x'.repeat(400 * 1024) })); // a last line of ~3 blocks
  put(root, 'decision', lines);
  return root;
}

test('a giant last line does not ask for a rebuild on every question (red at the first version of the track)', async () => {
  const win = { from: BASE + 100 * HOUR, to: BASE + 101 * HOUR };
  const askNeeded = (m, cap, root) => {
    m.buildTimeTracks(root);
    const rep = {};
    m.find(root, '', cap, { withRetired: true, windowMs: win, report: rep });
    return rep.buildNeeded;
  };
  const rootNew = giantLastLineRoot();
  const rootOld = giantLastLineRoot();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-timetrack-first-'));
  try {
    exportCommit(REPO, FIRST_TRACK, ['src', 'package.json'], tmp);
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const old = await import(pathToFileURL(path.join(tmp, 'src', 'memory.mjs')).href);
    const oldCap = (await import(pathToFileURL(path.join(tmp, 'src', 'capability.mjs')).href)).grantAll('probe');
    assert.equal(askNeeded(old, oldCap, rootOld), true, 'the first version asks again after its own build (the defect)');
    assert.equal(askNeeded(memory, ALL(), rootNew), false, 'today the same bytes do not ask again');
    // positive control: bytes that CAN be covered ask again once a block's worth has arrived
    const p = drawerFile(rootNew, 'decision');
    const r = rng(62);
    fs.appendFileSync(p, `${Array.from({ length: 700 }, (_, i) => plain(`w${i}`, 1400 + i, r)).join('\n')}\n`);
    const rep = {};
    memory.find(rootNew, '', ALL(), { windowMs: win, report: rep });
    assert.equal(rep.buildNeeded, true);
    memory.buildTimeTracks(rootNew);
    const rep2 = {};
    memory.find(rootNew, '', ALL(), { windowMs: win, report: rep2 });
    assert.equal(rep2.buildNeeded, false);
    assert.ok(timetrack.readTrack(rootNew, p).data.covered > 256 * 1024);
  } finally { removeTree(tmp); removeTree(rootOld); removeTree(rootNew); }
});

test('a failed build is written down and holds the next nudge back; a sweep removes only old orphan temp files', () => {
  const root = bigRoot();
  try {
    const dir = path.join(root, '.mem', 'timetrack');
    fs.mkdirSync(path.dirname(timetrack.trackPath(root, drawerFile(root, 'decision'))), { recursive: true });
    fs.mkdirSync(timetrack.trackPath(root, drawerFile(root, 'decision')));          // a directory where the track file belongs: the write fails
    const oldTmp = path.join(dir, 'global_x.jsonl.abcd1234.json.4242.0123456789.tmp');
    const freshTmp = path.join(dir, 'global_y.jsonl.abcd1234.json.4242.9876543210.tmp');
    const other = path.join(dir, 'keep-me.txt');
    for (const f of [oldTmp, freshTmp, other]) fs.writeFileSync(f, 'x');
    const longAgo = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(oldTmp, longAgo, longAgo);
    fs.utimesSync(other, longAgo, longAgo);

    const out = memory.buildTimeTracks(root);
    assert.ok(out.failed >= 1, JSON.stringify(out));
    assert.equal(out.swept, 1);
    assert.equal(fs.existsSync(oldTmp), false);
    assert.equal(fs.existsSync(freshTmp), true, 'a young temp file may belong to a live writer');
    assert.equal(fs.existsSync(other), true, 'only the writer\'s own pattern is swept');
    const note = JSON.parse(fs.readFileSync(path.join(dir, 'build-note.json'), 'utf8'));
    assert.equal(note.ok, false);
    assert.ok(note.failed >= 1);

    assert.equal(timetrack.kickBuild(root), 'backoff', 'no new child right after a failure');
    note.at = new Date(Date.now() - 3600 * 1000).toISOString();
    fs.writeFileSync(path.join(dir, 'build-note.json'), JSON.stringify(note));
    assert.equal(timetrack.kickBuild(root), 'started', 'after the pause it tries again');
    assert.ok(timetrack.waitForBuildIdle(root, 60000));
  } finally { removeTree(root); }
});

function mem(root, args) {
  const res = spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem'), ...args], {
    encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

test('CLI: `mem when` on a big memory starts the background build; the next question gives the same hits', () => {
  const root = bigRoot();
  try {
    const from = iso(BASE + 300 * HOUR); const to = iso(BASE + 340 * HOUR);
    const first = JSON.parse(mem(root, ['when', '--from', from, '--to', to, '--json']));
    assert.equal(first.hits.length, 20, 'the 20 newest of the 80 in the window'); // `when --json` caps at 20
    assert.ok(timetrack.waitForBuildIdle(root, 60000), 'the build ends');
    assert.equal(timetrack.readTrack(root, drawerFile(root, 'decision')).status, 'valid');
    const second = JSON.parse(mem(root, ['when', '--from', from, '--to', to, '--json']));
    assert.deepEqual(second.hits, first.hits);
    assert.equal(timetrack.waitForBuildIdle(root, 60000), true);
  } finally { removeTree(root); }
});

// ---------------------------------------------------------------------------
// RED PROOF: bytes read, old stand vs today
// ---------------------------------------------------------------------------

function countingRead(fn) {
  const original = fs.readSync;
  const count = { bytes: 0 };
  fs.readSync = function spy(...args) {
    const n = original.apply(this, args);
    if (typeof n === 'number') count.bytes += n;
    return n;
  };
  try { return { value: fn(), bytes: count.bytes }; } finally { fs.readSync = original; }
}

function bigCorpusRoot() {
  const root = tmpRoot();
  const r = rng(77);
  const types = ['decision', 'learning', 'event', 'thought'];
  const lines = Object.fromEntries(types.map((t) => [t, []]));
  for (let i = 0; i < 14000; i += 1) lines[types[i % 4]].push(plain(`b${i}`, i / 4, r, { more: wordsOf(r, 40) }));
  for (const t of types) put(root, t, lines[t]);
  return root;
}

test('RED PROOF: at the fixed old commit a one-day window reads at least 2x all drawer bytes; today at most a quarter (same hits)', async () => {
  const root = bigCorpusRoot();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-timetrack-old-'));
  try {
    const total = ['decision', 'learning', 'event', 'thought'].reduce((s, t) => s + fs.statSync(drawerFile(root, t)).size, 0);
    assert.ok(total > 3 * 1024 * 1024, `corpus ${total} bytes`);
    memory.buildTimeTracks(root); // production block size and minimum
    const from = BASE + 1000 * HOUR; const to = from + 24 * HOUR;
    const opts = {
      withRetired: true, windowMs: { from, to },
      accept: (e) => { const t = e.ts ? new Date(e.ts).getTime() : NaN; return !(Number.isNaN(t) || t < from || t >= to); },
    };

    exportCommit(REPO, OLD_STAND, ['src', 'package.json'], tmp);
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const old = await import(pathToFileURL(path.join(tmp, 'src', 'memory.mjs')).href);
    const oldCap = (await import(pathToFileURL(path.join(tmp, 'src', 'capability.mjs')).href)).grantAll('probe');

    const o = countingRead(() => old.find(root, '', oldCap, opts));
    const n = countingRead(() => memory.find(root, '', ALL(), { ...opts, report: {} }));
    // positive control: the spy counts, the old code walks everything twice, and both answers are the same non-empty list
    assert.ok(o.bytes >= 2 * total, `old stand read ${o.bytes} bytes, drawers hold ${total}: the spy must see two passes`);
    assert.ok(o.value.length >= 24, `hits ${o.value.length}`);
    assert.deepEqual(n.value, o.value);
    // the proof: today a quarter of the drawer bytes is enough
    assert.ok(n.bytes <= total / 4, `today read ${n.bytes} of ${total} bytes (one day of ${total} B is the point)`);
  } finally { removeTree(tmp); removeTree(root); }
});

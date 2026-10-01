// The viewer's per-topic quadratic, found and removed.
//
// **Where the quadratic actually was.** `collectMemory()` in
// `src/viewer.mjs` used to call `memory.topicState(root, t.topic)` once
// per topic to get that topic's current entry and its trail. Each call
// re-reads and re-scans the WHOLE corpus through `memory.topicEntries()` —
// correct for a single lookup, ruinous in a loop over every topic. That is
// one full corpus read PER TOPIC: cost topics x entries, not entries alone.
//
// `bench/atlas/phase-load.mjs` already names this exact cause in its own
// comments (`load.a.viewer-topics`), and its measurements are the proof,
// not a guess:
//   - `load.a.viewer`:        raw n^1.74, net of floor n^1.87 —
//                              318.4 ms -> 56,772.9 ms over 1,012 -> 20,012
//                              entries.
//   - `load.a.viewer-topics`: topics x4.83, entries x1.4, product model
//                              predicts x6.75, observed x5.32
//                              (752 ms -> 4,001 ms).
// Both point at the same nested pass: for each topic, walk the entries
// again. In `bench/atlas/core.mjs`'s synthetic corpus the topic count
// grows roughly with entry count too, so the topics x entries product
// alone explains the near-n^2 curve on the plain entry-count ladder —
// there is no second, separate quadratic to hunt for.
//
// The fix (in `collectMemory()`): one call to `memory.topicEntries(root)`
// (no key) already returns every entry in the exact newest-first order
// `topicState()` derives its per-topic current/history from. Grouping
// those ids by `_topic` in a single pass is O(entries) once, replacing
// O(topics) full corpus reads. `src/memory.mjs` is untouched — this is a
// caller-side fix, not a change to what `topicState`/`topicEntries`
// promise or do for anyone else who calls them once.
//
// This file carries four checks, per the house rule that a guarantee
// needs both a positive control and a sabotage counter-probe:
//   1. positive control  — the viewer runs and shows real content at all
//   2. nothing lost       — topics/current/trail/links match hand-checked
//                           expectations on a small, known corpus
//   3. the guarantee      — measured growth exponent stays under a bound
//   4. sabotage            — putting the quadratic back (by re-deriving a
//                           sabotaged copy of the real source, never
//                           `git checkout`) turns check 3 red; the
//                           checked-in file stays green
//
// invariant: kein-quadrat-je-thema
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import * as memory from '../src/memory.mjs';
import * as viewer from '../src/viewer.mjs';
import * as corpus from '../bench/atlas/core.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-viewer-scale-'));
}

/** log(t2/t1) / log(n2/n1) — same growth-exponent formula
 * `bench/atlas/phase-load.mjs` uses for its own `load.a.viewer*` records. */
function exponent(t1, n1, t2, n2) {
  if (!(t1 > 0) || !(t2 > 0) || !(n1 > 0) || !(n2 > 0) || n1 === n2) return null;
  return Math.log(t2 / t1) / Math.log(n2 / n1);
}

// The bound for the growth-exponent guarantee below.
//
// The remaining work in `collectMemory()` — embedding every entry, tallying
// counts, grouping ids by topic — is all O(entries) done a constant number
// of times, so the true asymptotic exponent is close to 1. Measured
// in-process (see the guarantee test) it comes out well under that even,
// typically 0.5-0.7, because per-call fixed costs shrink as a fraction of
// the total as the corpus grows. 1.3 sits comfortably above that measured
// range — generous enough to absorb GC pauses and machine noise — while
// staying well below the ~1.4-1.9 signature the topics x entries bug
// produces at these same corpus sizes (measured below, in the sabotage
// check). A bound at or above ~1.8 would let the original bug back in
// silently; a bound at 1.0 would flake on ordinary timing noise.
const EXPONENT_BOUND = 1.3;

// Sizes for the timing checks. Small enough that the whole file finishes
// in a few seconds, which is the tradeoff the brief asks to name: at these
// sizes the exponent is measured over a 15-20x growth in entries, which is
// enough for a real O(n^2)-shaped cost to separate clearly from a linear
// one (see the numbers in the sabotage check below), but it is NOT enough
// range to distinguish, say, n^1.3 from n^1.6 with confidence — this is a
// coarse "is the bug back" tripwire, not a precise exponent measurement.
// `bench/atlas/phase-load.mjs` still owns the precise, large-N version.
const SIZES = [300, 1200, 6000];

/** Build a synthetic corpus and time collectMemory() on it, once. */
function timeCollect(builder, n) {
  const root = tmpRoot();
  corpus.buildCorpus(root, n, { seed: 42, anchors: 12 });
  const t0 = performance.now();
  const data = builder(root);
  const ms = performance.now() - t0;
  fs.rmSync(root, { recursive: true, force: true });
  return { ms, entries: data.entries.length, topics: data.topics.length };
}

/** Growth exponent of `builder` across SIZES, first point to last. */
function measureGrowth(builder) {
  const points = SIZES.map((n) => timeCollect(builder, n));
  const p0 = points[0];
  const pN = points[points.length - 1];
  return { points, exponent: exponent(p0.ms, p0.entries, pN.ms, pN.entries) };
}

/**
 * Reconstruct the pre-fix `collectMemory()` — one `memory.topicState()`
 * call per topic instead of one `memory.topicEntries()` call grouped by
 * topic — from the real, currently-checked-in `viewer.mjs`. Shared by
 * the two sabotage checks below (timing and counting) so the
 * reconstruction lives in exactly one place.
 *
 * Never a hand-maintained duplicate of viewer.mjs, never `git checkout`:
 * everything outside the marked block is the real file, symlinked in
 * unchanged; only the block between the markers is swapped.
 */
async function loadSabotagedViewer() {
  const viewerPath = fileURLToPath(new URL('../src/viewer.mjs', import.meta.url));
  const src = fs.readFileSync(viewerPath, 'utf8');

  const startMarker = '  const idsByTopic = new Map();';
  const endMarker = '  const links = [];';
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker);
  if (!(startIdx >= 0 && endIdx > startIdx)) {
    throw new Error('the topic-grouping block markers moved — update this sabotage helper to match');
  }

  const sabotagedBlock = `  const topics = memory.topics(root).map((t) => {
    const state = memory.topicState(root, t.topic);
    return {
      topic: t.topic,
      count: t.count,
      last: t.last,
      types: t.types,
      current: state.current ? state.current.id : null,
      trail: state.history.map((e) => e.id).filter(Boolean),
    };
  });

`;
  const sabotaged = src.slice(0, startIdx) + sabotagedBlock + src.slice(endIdx);
  if (sabotaged === src) throw new Error('sabotage produced no change — the swap did nothing');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-sabotage-'));
  const srcSiblingDir = path.join(tmpDir, 'src');
  fs.mkdirSync(srcSiblingDir);
  const realSrcDir = path.dirname(viewerPath);
  for (const name of fs.readdirSync(realSrcDir)) {
    if (name === 'viewer.mjs') continue;
    fs.symlinkSync(path.join(realSrcDir, name), path.join(srcSiblingDir, name));
  }
  const sabotagedInSrc = path.join(srcSiblingDir, 'viewer.mjs');
  fs.writeFileSync(sabotagedInSrc, sabotaged, 'utf8');

  const mod = await import(pathToFileURL(sabotagedInSrc).href);
  return { module: mod, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------
// 1. Positive control
// ---------------------------------------------------------------------

test('positive control: the viewer runs and shows real content', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision',
    { topic: 'infra/db', choice: 'sqlite', why: 'one file, positive-control marker zqx' });
  const { html, count } = viewer.build(root, { title: 'control' });
  assert.equal(count, 1);
  assert.match(html, /^<!doctype html>/i);
  assert.equal(html.includes('positive-control marker zqx'), true,
    'the seeded entry must actually appear — otherwise every timing below '
    + 'would be measuring an empty file');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 2. Nothing lost — topics, current/trail and links on a known corpus
// ---------------------------------------------------------------------

test('nothing lost: topic grouping, current/trail and links match a hand-checked corpus', () => {
  const root = tmpRoot();
  // One topic with three entries over time — current must be the newest,
  // trail the rest, newest-first, exactly what topicState() promised.
  const d1 = memory.logEntry(root, 'decision',
    { topic: 'auth/redesign', choice: 'jwt', why: 'first pass' },
    { now: new Date('2026-01-01T00:00:00Z') }).entry;
  const d2 = memory.logEntry(root, 'error',
    { topic: 'auth/redesign', class: 'security', title: 'jwt leaked in logs' },
    { now: new Date('2026-01-05T00:00:00Z') }).entry;
  const d3 = memory.logEntry(root, 'learning',
    { topic: 'auth/redesign', title: 'redact tokens before logging' },
    { now: new Date('2026-01-10T00:00:00Z') }).entry;
  // A second, unrelated topic with one entry — must not bleed into the
  // first topic's trail.
  const billing = memory.logEntry(root, 'decision',
    { topic: 'billing/provider', choice: 'stripe', why: 'existing account' },
    { now: new Date('2026-01-02T00:00:00Z') }).entry;
  // A link between two entries, so the "nothing lost" check also covers
  // backlink resolution, not just topic grouping.
  memory.logEntry(root, 'link', { from: d3.id, to: d2.id, kind: 'causes' });

  const data = viewer.collectMemory(root);

  assert.equal(data.entries.length, 5); // 3 + 1 + 1 link entry
  assert.equal(data.topics.length, 2);

  const authTopic = data.topics.find((t) => t.topic === 'auth/redesign');
  assert.ok(authTopic, 'auth/redesign topic present');
  assert.equal(authTopic.count, 3);
  assert.equal(authTopic.current, d3.id, 'current is the newest entry');
  assert.deepEqual(authTopic.trail, [d2.id, d1.id], 'trail is the rest, newest-first');
  assert.deepEqual([...authTopic.types].sort(), ['decision', 'error', 'learning']);

  const billingTopic = data.topics.find((t) => t.topic === 'billing/provider');
  assert.ok(billingTopic, 'billing/provider topic present, unaffected by the other topic');
  assert.equal(billingTopic.count, 1);
  assert.equal(billingTopic.current, billing.id);
  assert.deepEqual(billingTopic.trail, []);

  assert.equal(data.links.length, 1);
  assert.equal(data.links[0].from, d3.id);
  assert.equal(data.links[0].to, d2.id);
  assert.equal(data.links[0].fromKnown, true);
  assert.equal(data.links[0].toKnown, true);

  // And it all actually reaches the rendered page, not just the data model.
  const { html } = viewer.build(root, { title: 'nothing-lost' });
  for (const needle of ['jwt leaked in logs', 'redact tokens before logging',
    'auth/redesign', 'billing/provider', 'stripe']) {
    assert.equal(html.includes(needle), true, `page is missing "${needle}"`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------
// 3. The guarantee — growth exponent stays under the bound
// ---------------------------------------------------------------------

// P8 (2026-09-28): both checks below time `collectMemory()` with
// `performance.now()` (see the section-5 comment further down, written
// for the SAME reason: "noisy on a machine shared with other work").
// `betrieb/volle-suite.sh` no longer serialises this house's full suite
// against the other one's (I8), so that sharing is now routine, not an
// edge case — gate on the same quiet-machine signal
// `test/p16-append-exponent.test.mjs`'s `measureUnderLoadGate` already
// uses (`bench/atlas/core.mjs`, imported here as `corpus`), rather than
// leaving checks 3-4 as the two un-gated wall-clock probes in this file.
// Check 5 (counting, below) already never needed this — it stays as is.
function measurementUnderLastGate(work) {
  const calibBaseline = corpus.captureQuietCalibrationBaseline();
  const before = corpus.captureForeignLoad(calibBaseline);
  const result = work();
  const after = corpus.captureForeignLoad(calibBaseline);
  const load = corpus.foreignLoadDelta(before, after, calibBaseline);
  if (!calibBaseline.trustworthy) {
    return {
      result,
      notMeasuredReason: `this run's own quiet-calibration baseline never stabilised in `
        + `${calibBaseline.attempts} attempt(s) — the machine cannot be shown quiet here.`,
    };
  }
  const stealCgroupOver = load.deniedMsPerSec !== null && load.deniedMsPerSec > corpus.FOREIGN_LOAD_DENIED_MS_PER_SEC;
  const psiOver = load.psiMsPerSec !== null && load.psiMsPerSec > corpus.FOREIGN_LOAD_DENIED_MS_PER_SEC;
  if (stealCgroupOver || psiOver) {
    return {
      result,
      notMeasuredReason: `foreign load was measured during this window (deniedMsPerSec=${load.deniedMsPerSec}, `
        + `psiMsPerSec=${load.psiMsPerSec}, threshold ${corpus.FOREIGN_LOAD_DENIED_MS_PER_SEC} ms/s) — this `
        + 'window\'s timings cannot be trusted to reflect the real cost being measured.',
    };
  }
  return { result, notMeasuredReason: null };
}

test('the guarantee: viewer build time grows sub-quadratically with corpus size', (t) => {
  const gate = measurementUnderLastGate(() => measureGrowth((root) => viewer.collectMemory(root)));
  if (gate.notMeasuredReason) {
    t.skip(`not measured: ${gate.notMeasuredReason} points: ${JSON.stringify(gate.result.points)} `
      + '(the load-immune counting probe below still covers this guarantee unconditionally)');
    return;
  }
  const { points, exponent: e } = gate.result;
  const report = points.map((p) => `${p.entries} entries, ${p.topics} topics: ${p.ms.toFixed(1)} ms`).join(' | ');
  assert.ok(e !== null, `could not compute an exponent — ${report}`);
  assert.ok(e < EXPONENT_BOUND,
    `growth exponent ${e.toFixed(3)} >= bound ${EXPONENT_BOUND} — the topics x `
    + `entries quadratic may be back. Measured: ${report}`);
});

// ---------------------------------------------------------------------
// 4. Sabotage — put the quadratic back (never `git checkout`), confirm
//    red, then confirm the checked-in file is green.
// ---------------------------------------------------------------------

test('sabotage: reintroducing per-topic topicState() makes the exponent check fail', async (t) => {
  const { module: sabotagedModule, cleanup } = await loadSabotagedViewer();

  const redGate = measurementUnderLastGate(() => measureGrowth((root) => sabotagedModule.collectMemory(root)));
  if (redGate.notMeasuredReason) {
    cleanup();
    t.skip(`not measured (RED half): ${redGate.notMeasuredReason} `
      + `points: ${JSON.stringify(redGate.result.points)}`);
    return;
  }
  const before = redGate.result;
  const beforeReport = before.points
    .map((p) => `${p.entries} entries, ${p.topics} topics: ${p.ms.toFixed(1)} ms`).join(' | ');
  assert.ok(before.exponent !== null, `sabotage: could not compute an exponent — ${beforeReport}`);
  assert.ok(before.exponent >= EXPONENT_BOUND,
    `sabotage should have gone RED (exponent >= ${EXPONENT_BOUND}) but measured `
    + `${before.exponent.toFixed(3)} — ${beforeReport}`);

  // Restore: the real, checked-in module (never modified on disk) is
  // green again. No git command involved anywhere in this test — the
  // "restore" is simply using the untouched file.
  const greenGate = measurementUnderLastGate(() => measureGrowth((root) => viewer.collectMemory(root)));
  if (greenGate.notMeasuredReason) {
    cleanup();
    t.skip(`not measured (GREEN half): ${greenGate.notMeasuredReason} `
      + `points: ${JSON.stringify(greenGate.result.points)}`);
    return;
  }
  const after = greenGate.result;
  const afterReport = after.points
    .map((p) => `${p.entries} entries, ${p.topics} topics: ${p.ms.toFixed(1)} ms`).join(' | ');
  assert.ok(after.exponent !== null, `restore: could not compute an exponent — ${afterReport}`);
  assert.ok(after.exponent < EXPONENT_BOUND,
    `restore should be GREEN (exponent < ${EXPONENT_BOUND}) but measured `
    + `${after.exponent.toFixed(3)} — ${afterReport}`);

  cleanup();
});

// ---------------------------------------------------------------------
// 5. Counting probe — the same guarantee, pinned without a wall clock
// ---------------------------------------------------------------------
//
// Checks 3 and 4 time collectMemory() with `performance.now()`, which is
// the right unit for "does a user actually wait longer" but is noisy on
// a machine shared with other work — a busy box can blur a real
// regression into ordinary jitter, or fail a green build on nothing.
// This pins the identical guarantee a second way, by COUNTING instead of
// timing, so it cannot flake on load at all.
//
// The invariant: one `collectMemory()` call reads each on-disk log file
// (one per project x type in `memory.TYPES`) exactly once, no matter how
// many distinct topics live inside those files — `topicEntries(root)`
// with no key is a single pass. So raising the topic count WITHOUT
// adding a new project or type must not add a single extra
// `fs.readFileSync` call. A per-topic full-corpus rescan (the bug this
// file is named for) breaks that immediately: it adds one rescan's
// worth of reads PER topic.
function countReadFileSyncCalls(root) {
  const orig = fs.readFileSync;
  let calls = 0;
  fs.readFileSync = (...args) => { calls += 1; return orig(...args); };
  let data;
  try { data = viewer.collectMemory(root); } finally { fs.readFileSync = orig; }
  return { calls, topics: data.topics.length, entries: data.entries.length };
}

/** Append `count` entries that are new TOPICS but not a new project/type. */
function appendExtraTopics(root, count) {
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      id: `probe${i.toString(36)}`, ts: '2026-03-01T00:00:00Z',
      topic: `probe-extra-topic/${i}`, choice: 'a', why: 'counting-probe filler',
      title: `probe extra topic ${i}`, text: 'deploy cache index entry',
    }));
  }
  fs.appendFileSync(path.join(root, 'global', 'decisions.jsonl'), `${lines.join('\n')}\n`);
}

test('counting probe: the viewer reads the corpus once per render, not once per topic', () => {
  const root = tmpRoot();
  corpus.buildCorpus(root, 500, { seed: 42, anchors: 12 });

  const before = countReadFileSyncCalls(root);
  const EXTRA_TOPICS = 2000;
  appendExtraTopics(root, EXTRA_TOPICS);
  const after = countReadFileSyncCalls(root);

  const gainedTopics = after.topics - before.topics;
  assert.ok(gainedTopics >= EXTRA_TOPICS - 100,
    `expected the appended lines to add ~${EXTRA_TOPICS} topics, only got ${gainedTopics} `
    + '— the corpus fixture changed, this probe needs updating');
  assert.equal(after.calls, before.calls,
    `fs.readFileSync calls grew from ${before.calls} to ${after.calls} after adding `
    + `${gainedTopics} topics to the SAME on-disk files (no new project, no new type) — `
    + 'the viewer is reading the corpus once per topic again, not once per render');

  fs.rmSync(root, { recursive: true, force: true });
});

test('sabotage (counting probe): per-topic topicState() makes reads scale with topic count', async () => {
  const root = tmpRoot();
  corpus.buildCorpus(root, 500, { seed: 42, anchors: 12 });
  const { module: sabotagedModule, cleanup } = await loadSabotagedViewer();

  const countReadsOf = (mod) => {
    const orig = fs.readFileSync;
    let calls = 0;
    fs.readFileSync = (...args) => { calls += 1; return orig(...args); };
    let data;
    try { data = mod.collectMemory(root); } finally { fs.readFileSync = orig; }
    return { calls, topics: data.topics.length };
  };

  const before = countReadsOf(sabotagedModule);
  const EXTRA_TOPICS = 2000;
  appendExtraTopics(root, EXTRA_TOPICS);
  const after = countReadsOf(sabotagedModule);

  const gainedTopics = after.topics - before.topics;
  assert.ok(gainedTopics >= EXTRA_TOPICS - 100,
    `expected ~${EXTRA_TOPICS} new topics, got ${gainedTopics}`);
  assert.ok(after.calls > before.calls,
    `sabotage should have gone RED (reads should scale with topic count) but calls stayed `
    + `at ${after.calls} after adding ${gainedTopics} topics — before was ${before.calls}`);

  // Restore: on this same, now topic-heavy corpus, the real checked-in
  // module must still match the flat-reads guarantee the check above
  // pins on a fresh corpus — no git command involved, "restore" is
  // simply using the untouched, real module.
  const restored = countReadFileSyncCalls(root);
  assert.ok(restored.calls < after.calls,
    `restore should be GREEN (fewer reads than the sabotaged module's ${after.calls}) `
    + `but the real module also took ${restored.calls} reads`);

  cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

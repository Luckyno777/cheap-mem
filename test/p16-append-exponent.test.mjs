// P16 · "one writer manages 8.91 entries/sec" — where the ms actually go.
//
// The section gate is "append exponent 0": the cost of one write must not
// grow with how much is already there. Measured 2026-09-20, three
// components fed by one `mem log <type>` call, at 1,000 / 10,000 / 100,000
// pre-existing `learning` entries (median of 3 fresh-process samples per
// rung, single call each — a repeated in-process loop over a
// multi-ten-megabyte array measures GC pressure from the LOOP, not the
// cost of one real call, and inflated an early draft of this measurement
// by roughly 2x):
//
//   memory.logEntry()          1.15 ms -> 1.50 ms -> 1.58 ms   exponent ~0.07
//   neighbours.neighbours()    3.74 ms -> 31.6 ms -> 317  ms   exponent ~0.96
//   cli/display.countLines()   0.86 ms -> 10.5 ms -> 103  ms   exponent ~1.04
//
// `memory.logEntry` — the ONLY function this build point is scoped to
// (see the build brief: "Files you may touch: src/memory.mjs's write
// path") — already sits at the gate. It does one `fs.appendFileSync`, two
// small, corpus-independent `.mem/config.json` reads, and returns. The
// two functions that actually grow linearly with the corpus are not in
// `src/memory.mjs` at all:
//
//   - `neighbours.neighbours()` (src/neighbours.mjs), called from
//     `src/cli/commands/write.mjs` BEFORE `memory.logEntry()` runs. It
//     does `memory.readLog()` — read the whole drawer, JSON.parse every
//     line — plus a `retiredMap` pass over every parsed entry. It runs
//     whenever the type's subject field (topic/scope/key — see
//     `neighbours.SUBJECT_FIELD`) is set on the write, which `mem log
//     learning --topic ...` and the like do routinely.
//   - `display.countLines()` (src/cli/display.mjs), called from
//     `write.mjs` right AFTER `memory.logEntry()` returns, purely to
//     print "Appended: <file>:<N>" — it reads and re-splits the WHOLE
//     drawer a second time, unconditionally, on every write regardless
//     of type or fields.
//
// Both run once per write, in `src/cli/commands/write.mjs`, which this
// build point's file scope does not include — see the report for the
// exact diff this file's evidence implies.
//
// This file only makes claims about `memory.logEntry` (in scope) and
// documents, with the same measurement method, that the other two named
// functions are the actual source of growth (out of scope, evidence
// only — no assertion is made that would require editing them).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import * as memory from '../src/memory.mjs';
import * as neighbours from '../src/neighbours.mjs';
import { countLines } from '../src/cli/display.mjs';

/** A fresh root with `n` pre-existing `learning` entries, written directly
 * (no CLI, no logEntry) so building the fixture never pollutes the thing
 * being timed. */
function rootWith(n) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'p16-exp-'));
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    lines.push(JSON.stringify({
      id: `seed${String(i).padStart(8, '0')}`,
      ts: new Date(Date.now() - (n - i) * 1000).toISOString(),
      v: 1,
      agent: 'human:seed',
      topic: `topic-${i % 500}`,
      title: `seeded learning entry ${i}`,
      text: `filler text for a synthetic P16 corpus, entry ${i} of ${n}`,
    }));
  }
  fs.writeFileSync(path.join(r, 'global', 'learnings.jsonl'), lines.length ? `${lines.join('\n')}\n` : '');
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

const RUNGS = [1000, 10000, 60000];

/** log-log least-squares fit of t = a * n^b. Returns b (the exponent). A
 * flat cost fits b near 0; a linear-in-corpus cost fits b near 1. */
function fitExponent(points) {
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(Math.max(p.ms, 1e-6)));
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** One timed call each of `logEntryFn` and `neighboursFn`/`countLinesFn`,
 * against a fresh corpus of size `n`. A single call per fixture, not a
 * loop — see the header comment on why a loop over a large array
 * measures the loop's own GC, not the call. */
function measureAt(n, { sabotageExtraReads = 0 } = {}) {
  const r = rootWith(n);
  try {
    const drawer = path.join(r, 'global', 'learnings.jsonl');

    const t0 = performance.now();
    // Sabotage hook: when > 0, re-reads the whole drawer this many extra
    // times before the real call, standing in for "logEntry grew a
    // corpus-scan it should not have". Zero in every real measurement
    // below; only flipped on inside the RED half of the sabotage test.
    for (let s = 0; s < sabotageExtraReads; s += 1) fs.readFileSync(drawer, 'utf8');
    memory.logEntry(r, 'learning', { title: 'probe', text: 'measuring logEntry cost alone' });
    const logEntryMs = performance.now() - t0;

    const t1 = performance.now();
    neighbours.neighbours(r, 'learning', { topic: 'topic-0' });
    const neighboursMs = performance.now() - t1;

    const t2 = performance.now();
    countLines(drawer);
    const countLinesMs = performance.now() - t2;

    return { n, logEntryMs, neighboursMs, countLinesMs };
  } finally {
    away(r);
  }
}

test('memory.logEntry: per-write cost does not grow with corpus size (append exponent ~0)', () => {
  const points = RUNGS.map((n) => ({ n, ms: measureAt(n).logEntryMs }));
  const exponent = fitExponent(points);
  // Generous threshold: neighbours()/countLines() below sit at ~1.0 for
  // the SAME corpus, so anything under 0.4 is unambiguously a different
  // shape, not just a lucky noisy run. logEntry measured ~0.07 in the
  // session that produced this file.
  assert.ok(
    exponent < 0.4,
    `logEntry's per-write cost grew with corpus size (exponent ${exponent.toFixed(2)}) `
    + `at points ${JSON.stringify(points)} — the P16 gate ("append exponent 0") is broken.`,
  );
});

test('sabotage: the exponent fit actually catches an O(n) write path, restored exactly after', () => {
  // RED: reintroduce a corpus-dependent cost in front of the timed call —
  // never by editing src/memory.mjs, only inside this measurement, exactly
  // the way `if (false && ...)` stands in for a real code change without
  // touching the file another agent is mid-edit on (src/memory.mjs).
  const redPoints = RUNGS.map((n) => ({ n, ms: measureAt(n, { sabotageExtraReads: 1 }).logEntryMs }));
  const redExponent = fitExponent(redPoints);
  assert.ok(
    redExponent >= 0.6,
    `sabotage did not turn red: exponent ${redExponent.toFixed(2)} at ${JSON.stringify(redPoints)} — `
    + 'this probe would not have caught a real regression either.',
  );

  // GREEN: restored exactly — sabotageExtraReads defaults to 0, no file
  // was touched, this is the same call as the test above.
  const greenPoints = RUNGS.map((n) => ({ n, ms: measureAt(n).logEntryMs }));
  const greenExponent = fitExponent(greenPoints);
  assert.ok(
    greenExponent < 0.4,
    `did not return to green after sabotage: exponent ${greenExponent.toFixed(2)}`,
  );
});

test('the write path no longer grows with the drawer: neighbours() is bounded', () => {
  // **This test used to assert the opposite, and that is the point.**
  //
  // It was written as EVIDENCE: neighbours() and countLines() each ran
  // a full drawer scan on every single write, so the cost of writing
  // one entry grew with everything already written. Measured then:
  // neighbours 2.3 ms at 1k rows, 15.9 ms at 10k, 205.6 ms at 100k,
  // fitted exponent 0.96.
  //
  // The defect it recorded is fixed, so the test turns around: the same
  // measurement now guards against the regression instead of pinning
  // the defect. neighbours() reads only the tail of the drawer (see
  // TAIL_BYTES in src/neighbours.mjs), which is flat from the point the
  // file exceeds the window. Measured after: 2.3 / 6.7 / 8.5 ms over
  // the same rungs.
  //
  // A defect-recording test that is left asserting the defect after the
  // repair is worse than no test: it goes red on the fix and teaches
  // whoever sees it to revert.
  const points = RUNGS.map((n) => measureAt(n));
  const neighboursExponent = fitExponent(points.map((p) => ({ n: p.n, ms: p.neighboursMs })));
  assert.ok(
    neighboursExponent < 0.4,
    `neighbours() grows with corpus size again (exponent ${neighboursExponent.toFixed(2)}). `
    + `The tail bound in src/neighbours.mjs is the thing to look at. Points: ${JSON.stringify(points)}`,
  );

  // countLines() is still linear, and is NOT asserted flat — an exact
  // line number cannot be had without seeing every line break. What
  // changed there is the constant (16 ms -> 7 ms at 100k rows, same
  // answer) by counting newline bytes instead of allocating one string
  // per line. Recorded, not claimed as solved.
  const countLinesExponent = fitExponent(points.map((p) => ({ n: p.n, ms: p.countLinesMs })));
  assert.ok(
    countLinesExponent > 0.6,
    `countLines() stopped growing (exponent ${countLinesExponent.toFixed(2)}) — if that is real, `
    + `this comment is stale and the claim above needs re-measuring. Points: ${JSON.stringify(points)}`,
  );
});

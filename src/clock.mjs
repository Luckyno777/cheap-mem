// src/clock.mjs — clock skew between writers, measured from the log
// itself, never used to reorder anything.
//
// ---------------------------------------------------------------------
// What this answers, and what it does not
// ---------------------------------------------------------------------
//
// `env/clock` (src/doctor.mjs) used to compare the single NEWEST entry
// in the whole memory against `Date.now()` — regardless of who wrote
// it. On an empty memory that is honestly `unknown` ("no timestamped
// entry to compare against"), which is the right answer as far as it
// goes, but the comparison itself never distinguished "my own last
// write" from "a line from another machine": comparing your own clock
// to your own clock's own recent output tells you nothing about
// cross-machine skew, only that you did not write in the future.
//
// This module narrows the comparison to what actually matters for
// ordering across a fleet: the newest line from a FOREIGN writer,
// against this process's own clock, right now. That is the number
// recency weighting and the `ts`-based ordering BETWEEN writers
// actually rests on (see the module doc on src/chain.mjs for the
// ordering WITHIN one writer, which this module does not touch and does
// not need to — it comes from the chain, not the clock).
//
// ---------------------------------------------------------------------
// The asymmetry a threshold has to respect
// ---------------------------------------------------------------------
//
// Clock skew and write latency are NOT distinguishable from inside one
// process, in general. A line written 3 s ago by a machine 3 s behind
// looks exactly like a line written now by a machine in sync — both
// hand this process a `ts` a few seconds before `Date.now()`. So a
// "behind" reading, of ANY size, is never on its own evidence of a bad
// clock: a writer that simply has not appended in an hour looks
// identical to a writer whose clock is an hour slow. Escalating on
// "behind" would report a skew on installations where nothing is
// wrong — every idle writer would eventually look "behind" by however
// long it has been quiet — which is exactly the false alarm this
// module exists to avoid (see the counter-probe in
// test/clock.test.mjs).
//
// "Ahead" is different, and this is the one fact the design leans on:
// ordinary write latency can only push an observed `ts` INTO the past
// relative to `Date.now()` — a line cannot be appended before it is
// written, so latency alone can never produce a timestamp that lands
// in this process's future. A foreign line stamped in the future is
// therefore never explained by lag; it can only mean that writer's
// clock reads later than this one. That is a clean, latency-proof
// signal, and it is the only direction this module ever escalates past
// GOOD.
//
// This is a deliberate, asymmetric design, not an oversight: a memory
// with one writer chronically hours behind will keep reading GOOD here
// forever (with an honest caveat in the text — see `computeSkew`), and
// that is the correct trade for a check whose one hard rule is "never
// alarm on a healthy install".
//
// ---------------------------------------------------------------------
// Sample size is part of the report, not an afterthought
// ---------------------------------------------------------------------
//
// The skew number always comes from exactly one line — the newest
// foreign one — because that is the line whose `ts` actually competes
// with this writer's own newest line for "which is more recent". But a
// single line from a single writer, at one moment, is an anecdote, and
// the finding says so plainly rather than presenting one sample dressed
// up as a trend: every report names how many foreign lines and how many
// distinct foreign writers were AVAILABLE, so a reader can see how thin
// or thick the ground under the number is.

import fs from 'node:fs';
import * as integrity from './integrity.mjs';
import { writerOf } from './chain.mjs';
import { agentDefault } from './memory.mjs';

export const STATE = Object.freeze({
  GOOD: 'good',
  WARN: 'warn',
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

/** Minutes. Below this, an "ahead" reading is clock jitter / rounding,
 *  not a fact worth a doctor line. */
export const WARN_AHEAD_MINUTES = 1;

/** Minutes. At or above this, a foreign line in this process's future
 *  is a confident fault — see the module doc on why "ahead" cannot be
 *  latency. */
export const ERROR_AHEAD_MINUTES = 5;

/**
 * Every `{ writer, ts, t }` triple across every log under `root` that
 * carries a parseable `ts`. `t` is the parsed epoch millisecond value,
 * kept alongside the original string so a finding can quote the exact
 * `ts` it reasoned about.
 *
 * Reads raw bytes itself rather than calling `integrity.scanIntegrity`
 * — that function's job is to report BROKEN lines, and a line with a
 * bad `ts` is exactly its business, not this module's; this one only
 * needs the lines that parse.
 */
export function collectTimestampedEntries(root) {
  const out = [];
  for (const f of integrity.logFiles(root)) {
    let raw;
    try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      if (typeof e.ts !== 'string') continue;
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t)) continue;
      out.push({ writer: writerOf(e), ts: e.ts, t });
    }
  }
  return out;
}

/**
 * The pure core: given already-collected `{ writer, ts, t }` entries (no
 * filesystem here — a test hands this a hand-built array), compute the
 * clock-skew finding.
 *
 * Returns one of the house's four states:
 *
 *   unknown  no foreign-writer line exists to compare against — either
 *            no timestamped entry at all, or every one belongs to
 *            `selfWriter`. "Not measurable is not zero": this is never
 *            reported as "no skew detected".
 *   good     either no foreign line reads as ahead beyond jitter, or
 *            the foreign newest reads behind — which this measurement
 *            cannot tell apart from ordinary write latency, so it is
 *            never treated as a fault (see the module doc).
 *   warn     a foreign line reads ahead of this clock by at least
 *            `WARN_AHEAD_MINUTES` but under `ERROR_AHEAD_MINUTES`.
 *   error    a foreign line reads ahead of this clock by at least
 *            `ERROR_AHEAD_MINUTES` — a reading that cannot be latency.
 */
export function computeSkew(entries, { selfWriter, now = Date.now() } = {}) {
  if (!selfWriter || typeof selfWriter !== 'string') {
    throw new Error('computeSkew: selfWriter (a non-empty string) is required');
  }
  const foreign = entries.filter((e) => e.writer !== selfWriter);

  if (foreign.length === 0) {
    return {
      state: STATE.UNKNOWN,
      reason: entries.length === 0
        ? 'no timestamped entry to compare against'
        : `every timestamped entry belongs to this writer (${selfWriter}) — a single writer `
          + 'cannot measure clock skew between machines',
      sampleLines: 0,
      sampleWriters: 0,
    };
  }

  const distinctWriters = new Set(foreign.map((e) => e.writer));
  let newest = foreign[0];
  for (const e of foreign) if (e.t > newest.t) newest = e;

  // >0: the foreign `ts` lands in THIS process's future.
  const rawSkewMinutes = (newest.t - now) / 60000;
  const skewMinutes = Math.round(rawSkewMinutes * 100) / 100;
  const direction = skewMinutes >= 0 ? 'ahead' : 'behind';
  const magnitude = Math.abs(skewMinutes);

  const anecdote = foreign.length === 1 && distinctWriters.size === 1;
  const sample = `${foreign.length} foreign line${foreign.length === 1 ? '' : 's'} from `
    + `${distinctWriters.size} writer${distinctWriters.size === 1 ? '' : 's'}`
    + (anecdote ? ' — a single sample, not a measurement' : '');

  const base = {
    sampleLines: foreign.length,
    sampleWriters: distinctWriters.size,
    skewMinutes: magnitude,
    direction,
    newestForeignWriter: newest.writer,
    newestForeignTs: newest.ts,
  };

  if (direction === 'ahead' && magnitude >= ERROR_AHEAD_MINUTES) {
    return {
      ...base,
      state: STATE.ERROR,
      detail: `newest foreign line (writer ${newest.writer}, ts ${newest.ts}) is `
        + `${magnitude} min AHEAD of this clock — sample: ${sample}. A line cannot be `
        + 'timestamped in the future by ordinary write latency, so this direction is not '
        + `explained by lag: ${newest.writer}'s clock reads ahead of this one.`,
      fix: `Correct ${newest.writer}'s clock. Until then, its lines can sort as newer than `
        + 'lines actually written after them, which corrupts recency weighting across writers.',
    };
  }
  if (direction === 'ahead' && magnitude >= WARN_AHEAD_MINUTES) {
    return {
      ...base,
      state: STATE.WARN,
      detail: `newest foreign line (writer ${newest.writer}, ts ${newest.ts}) is `
        + `${magnitude} min ahead of this clock — sample: ${sample}. Below the `
        + `${ERROR_AHEAD_MINUTES}-minute confident threshold, but a future timestamp is still `
        + 'not explained by write latency.',
      fix: `Worth checking ${newest.writer}'s clock before this grows.`,
    };
  }

  const detail = direction === 'behind'
    ? `newest foreign line (writer ${newest.writer}, ts ${newest.ts}) is ${magnitude} min `
      + `behind this clock — sample: ${sample}. A line can look old either because that `
      + 'writer\'s clock is behind or because it simply has not written in a while; this '
      + 'measurement cannot tell those apart, so it is never reported as a fault, however '
      + 'large it grows.'
    : `newest foreign line (writer ${newest.writer}, ts ${newest.ts}) is ${magnitude} min `
      + `ahead of this clock — sample: ${sample}, within ordinary clock jitter.`;
  return { ...base, state: STATE.GOOD, detail };
}

/**
 * `computeSkew` over the real memory at `root`.
 *
 * `selfWriter` defaults to `agentDefault()` — the same identity
 * `memory.logEntry` would stamp on a line written right now from this
 * process/environment — so "foreign" means exactly what it means to the
 * writer partition `src/chain.mjs` already uses (`writerOf`), not a
 * second, competing notion of identity.
 *
 * `entries` lets a caller (a test, or a future combined pass that
 * already has the parsed lines) skip the filesystem read.
 */
export function measureClockSkew(root, { now = Date.now(), selfWriter = agentDefault(), entries = null } = {}) {
  const all = entries ?? collectTimestampedEntries(root);
  return computeSkew(all, { selfWriter, now });
}

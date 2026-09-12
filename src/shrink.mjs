/**
 * The shrink guard — an append-only memory must not get smaller.
 *
 * Everything in here appends. A book can grow, and it can stay the
 * same. If it gets SMALLER, something happened that nobody wanted: an
 * overwritten clone, a half-finished migration, a lost push, a `>`
 * where a `>>` belonged. Nobody notices, because a smaller memory
 * answers just as willingly as a full one — it just knows less.
 *
 * ## Why growth against a baseline and not a size
 *
 * The obvious build would be "below X bytes, alarm". That is wrong in
 * two ways at once: it fires constantly on a young memory, and never
 * again on an old one, because X eventually sits far below the stock.
 *
 * So a BASELINE: the highest level this memory ever had, recorded per
 * book. The comparison is against the baseline, not against a number
 * out of the air. And it only ratchets UPWARDS — a baseline that
 * shrinks along is not one.
 *
 * ## Fail closed, with leniency for the one honest case
 *
 * There is exactly one way a book legitimately shrinks: a digest that
 * trades raw material for a summary. That case is not guessed, it is
 * DECLARED — `setBaseline` writes the new baseline explicitly.
 * Anything undeclared is an alarm.
 *
 * This is the inverse of the convenient design where a guard switches
 * itself off after a few false alarms. A guard that can switch itself
 * off is not there the third time.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the baseline lives. Runtime state, per machine. */
export const BASELINE_FILE = path.join('.pipeline', 'shrink-baseline.json');

/** Findings. Closed list, four states. */
export const STATE = Object.freeze({
  CALM: 'calm',
  ALARM: 'alarm',
  FIRST_RUN: 'first-run',
  UNKNOWN: 'unknown',
});

/**
 * How much shrinking passes as noise: none.
 *
 * There is no tolerance, and that is deliberate. In an append-only
 * file a single missing byte is already an event nobody ordered. A
 * tolerance would be the place where the guard later lets through
 * "only a little".
 */
export const TOLERANCE_BYTES = 0;

const OUTSIDE = new Set(['.git', '.pipeline', 'raw', 'node_modules', '.github']);

/** The size of every append-only book, keyed by path relative to root. */
export function bookSizes(root) {
  const out = {};
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (OUTSIDE.has(e.name)) continue;
      const w = path.join(dir, e.name);
      if (e.isDirectory()) { walk(w, depth + 1); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try { out[path.relative(root, w)] = fs.statSync(w).size; } catch { /* gone */ }
    }
  };
  walk(root, 0);
  return out;
}

/** The stored baseline. `null` means unreadable or absent. */
export function readBaseline(root) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(root, BASELINE_FILE), 'utf8'));
    return (o && typeof o === 'object' && o.books && typeof o.books === 'object') ? o : null;
  } catch { return null; }
}

/**
 * Form the finding — without writing, so it is testable without side
 * effects.
 *
 * A VANISHED file is a shrink to zero and is reported as such.
 * Skipping it quietly would be the most convenient gap: it is exactly
 * the case you catch when a clone was half overwritten.
 */
export function check({ now = {}, baseline = null }) {
  if (baseline === null) {
    return { state: STATE.FIRST_RUN, shrunk: [], vanished: [], grown: 0 };
  }
  const was = baseline.books ?? {};
  const shrunk = [];
  const vanished = [];
  let grown = 0;
  for (const [book, wasBytes] of Object.entries(was)) {
    const isBytes = now[book];
    if (isBytes === undefined) { vanished.push({ book, was: wasBytes }); continue; }
    if (isBytes < wasBytes - TOLERANCE_BYTES) {
      shrunk.push({ book, was: wasBytes, is: isBytes, missing: wasBytes - isBytes });
    } else if (isBytes > wasBytes) grown += 1;
  }
  const state = (shrunk.length || vanished.length) ? STATE.ALARM : STATE.CALM;
  return { state, shrunk, vanished, grown };
}

/**
 * Ratchet the baseline — UPWARDS only.
 *
 * Even after an alarm: the old baseline stays for the shrunken book so
 * the next run raises the same alarm again. A guard that writes away
 * its own finding reports every damage exactly once — and whoever is
 * not looking at that moment never learns of it.
 */
export function ratchet(baseline, now = {}) {
  const books = { ...(baseline?.books ?? {}) };
  for (const [book, bytes] of Object.entries(now)) {
    if (!(book in books) || bytes > books[book]) books[book] = bytes;
  }
  return {
    version: 1,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    // The reason for a DECLARED lowering travels along. On the first
    // test run it was lost at the next ratchet — and then a declared
    // digest cannot be told from silent damage afterwards, which is
    // the whole point of declaring.
    ...(baseline?.why ? { why: baseline.why } : {}),
    books,
  };
}

/**
 * Set the baseline explicitly — the declared case.
 *
 * After a digest that trades raw material for a summary the book IS
 * smaller and should stay that way. This is the only way to lower a
 * baseline, and it is a call, not an assumption.
 */
export function setBaseline(root, now = {}, { why = '' } = {}) {
  const state = {
    version: 1,
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    why: String(why || '').slice(0, 200),
    books: { ...now },
  };
  const where = path.join(root, BASELINE_FILE);
  fs.mkdirSync(path.dirname(where), { recursive: true });
  fs.writeFileSync(where, JSON.stringify(state, null, 1));
  return state;
}

/** Save without lowering. */
export function save(root, state) {
  const where = path.join(root, BASELINE_FILE);
  try {
    fs.mkdirSync(path.dirname(where), { recursive: true });
    fs.writeFileSync(where, JSON.stringify(state, null, 1));
    return true;
  } catch { return false; }
}

/** One run: measure, check, ratchet. */
export function run(root, { write = true } = {}) {
  const now = bookSizes(root);
  const baseline = readBaseline(root);
  const finding = check({ now, baseline });
  if (write) save(root, ratchet(baseline, now));
  return { ...finding, books: Object.keys(now).length };
}

/** Human text. The contract is the object. */
export function asText(f) {
  if (f.state === STATE.FIRST_RUN) {
    return `Shrink guard: first run over ${f.books ?? 0} books — `
      + 'no baseline yet, so no verdict yet.';
  }
  if (f.state === STATE.UNKNOWN) {
    return 'Shrink guard: baseline unreadable — UNKNOWN, not fine.';
  }
  if (f.state === STATE.CALM) {
    return `Shrink guard: calm (${f.books ?? 0} books, ${f.grown} grew).`;
  }
  const z = ['Shrink guard: ALARM — an append-only book got smaller.'];
  for (const s of f.shrunk) z.push(`  ${s.book}: ${s.was} -> ${s.is} bytes (${s.missing} missing)`);
  for (const v of f.vanished) z.push(`  ${v.book}: gone (was ${v.was} bytes)`);
  z.push('  To shrink on purpose (after a digest): mem shrink --new-baseline --why "..."');
  return z.join('\n');
}

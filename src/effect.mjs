// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * effect — did an injection get used? (M5 parity with lucky-mem's
 * "Wirkung der Einblendungen", `mem wirkung`.)
 *
 * **What this is not.** `gauges.mjs`'s Allocation already asks a
 * related question for ONE session's raw capture — of the injected
 * places, which did the very next tool call read. This module asks a
 * different, aggregate one, over EVERY session the journal knows
 * about at once: of all the (injection, entry) pairs recorded, in
 * what SHARE was the entry named, opened, or edited afterwards — with
 * a confidence interval on that share, and a floor below which the
 * question is not answered at all rather than answered on too little.
 * The two do not compete; Allocation is a per-run diagnostic, this is
 * a standing measurement.
 *
 * **The pair.** Every source `mem find --journal-session` actually
 * showed (`.pipeline/injections.jsonl`, occasion `question`, a
 * non-empty `sources`) is one pair: (this place, was it used within
 * {@link WINDOW_MS} of being shown). "Used" is read off what the
 * session did next — reusing `askedlearn.mjs`'s own machinery: the
 * SAME real-input-or-tool-call scan (`mentions()`) over the SAME
 * 30-minute window (`MENTION_WINDOW_MS`). Self-reinforcement — a
 * mention that only happened because the memory showed the place AGAIN
 * before the session named it — is the same idea M18b's `selfShown()`
 * latch already stands for, ported here as `reshownBetween()` rather
 * than called directly: `selfShown()` assumes the line it is asked
 * about carries no sources of its own (true for a miss, never true for
 * a show), and calling it as-is would find every show reinforced by
 * itself.
 *
 * **The floor.** Below {@link MIN_PAIRS} pairs the share is not
 * reported at all — `state: 'not-measurable'` — because a Wilson
 * interval on a handful of pairs is wide enough to say nothing. Below
 * one pair (`state: 'no-data'`) there has never been an injection to
 * ask about; that is a different statement from "not enough yet".
 *
 * **What this changes: nothing.** A finding, never a rank. No caller
 * anywhere feeds this back into `search()`.
 */
import * as injection from './injection.mjs';
import * as askedlearn from './askedlearn.mjs';
import * as search from './search.mjs';

/** How long after being shown a place still counts as its outcome. */
export const WINDOW_MS = askedlearn.MENTION_WINDOW_MS;

/** Fewer pairs than this and the share is not reported. */
export const MIN_PAIRS = 1000;

/** 95 % two-sided z. */
const Z95 = 1.959963984540054;

/**
 * The Wilson score interval for `k` of `n`, `null` when `n` is 0.
 *
 * Chosen over the plain normal approximation for the same reason every
 * standard reference gives: it does not run outside [0, 1] and it does
 * not collapse to a zero-width interval at k=0 or k=n, both of which a
 * measurement over real, sparse counts will hit.
 */
export function wilson(k, n, z = Z95) {
  if (!n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    p,
    lo: Math.max(0, (centre - margin) / denom),
    hi: Math.min(1, (centre + margin) / denom),
  };
}

/**
 * Every (place, session) an injection actually showed — the raw
 * candidate pairs, before self-reinforcement is filtered out.
 */
/**
 * Was `place` shown to this session again, strictly after `t` and no
 * later than `mentionT`? If so, the mention that followed is not
 * evidence for THIS show — it may just be the session repeating what
 * was put in front of it a second time.
 */
function reshownBetween(journal, session, t, mentionT, place) {
  return journal.some(({ z }) => {
    if (z.session !== session || !Array.isArray(z.sources) || !z.sources.includes(place)) return false;
    const at = Date.parse(z.ts ?? '');
    return Number.isFinite(at) && at > t && at <= mentionT;
  });
}

function shows(journal) {
  return journal.filter(({ z }) => z.occasion === injection.OCCASION.QUESTION
    && z.session && Array.isArray(z.sources) && z.sources.length
    && Number.isFinite(Date.parse(z.ts ?? '')));
}

/**
 * The pairs, with their outcome — nothing is written, nothing ranked.
 *
 * `counts` is the funnel denominator, so "0 pairs" reads as a
 * measurement ("no session had a readable capture") and not as
 * silence — the same three-states discipline `askedlearn.cases()`
 * already follows, ported here rather than re-invented.
 */
export function pairs(root, { journal = null, lines = null, index = null } = {}) {
  const j = journal ?? askedlearn.journalWithPlace(root);
  const shown = shows(j);
  const sessions = new Set(shown.map((s) => s.z.session));
  const { bySession, unreadable } = lines ?? askedlearn.sessionLines(root, sessions);
  const idx = index ?? search.loadIndex(root);
  const placeToId = new Map();
  for (const d of idx.documents) {
    if (d.type === 'raw' || !d.entry?.id) continue;
    placeToId.set(`${d.source}:${d.line}`, d.entry.id);
  }
  const counts = {
    shows: shown.length, sourcesTotal: 0, noId: 0, noCapture: 0,
    selfReinforced: 0, pairs: 0, used: 0, unreadableCaptures: unreadable,
  };
  const out = [];
  for (const s of shown) {
    const sl = bySession.get(s.z.session);
    const t = Date.parse(s.z.ts);
    const knownHere = new Map();
    for (const place of s.z.sources) {
      counts.sourcesTotal += 1;
      const id = placeToId.get(place);
      if (!id) { counts.noId += 1; continue; }
      knownHere.set(id, place);
    }
    if (!knownHere.size) continue;
    if (!sl?.length) { counts.noCapture += knownHere.size; continue; }
    // One scan per SHOW, not per place: `mentions()` already walks the
    // session once and returns the first mention of every id `known()`
    // admits, inside the same 30-minute window this module reuses.
    const named = askedlearn.mentions(sl, { t }, (id) => knownHere.has(id));
    const mentionedAt = new Map(named.map((n) => [n.id, n.t]));
    for (const [id, place] of knownHere) {
      const mentionT = mentionedAt.get(id) ?? null;
      // `askedlearn.selfShown()` is not reusable AS IS here: it is built
      // for a "current line has no sources of its own" caller (a miss
      // never has any), and this show's OWN line always does — passing
      // its own timestamp as `from` would find itself every time. The
      // idea it ports is the same one M18b already named for this exact
      // shape of question: a mention only counts if it is not explained
      // by the memory showing the place AGAIN in the meantime.
      if (mentionT != null && reshownBetween(j, s.z.session, t, mentionT, place)) {
        counts.selfReinforced += 1;
        continue;
      }
      const used = mentionT != null;
      if (used) counts.used += 1;
      counts.pairs += 1;
      out.push({ place, id, session: s.z.session, ts: s.z.ts, used });
    }
  }
  return { list: out, counts };
}

/** The state a measurement is in. Closed list, same discipline as `injection.mjs`. */
export const STATE = Object.freeze({
  /** Never a single injection on record — nothing to ask about yet. */
  NO_DATA: 'no-data',
  /** Some pairs, but fewer than {@link MIN_PAIRS} — an interval this narrow says nothing. */
  NOT_MEASURABLE: 'not-measurable',
  /** Enough pairs for the share and its interval to mean something. */
  MEASURED: 'measured',
});

/**
 * The measurement. Read-only: computing it changes nothing about how
 * `search()` ranks anything.
 */
export function measure(root, opts = {}) {
  const { list, counts } = pairs(root, opts);
  const n = list.length;
  const k = counts.used;
  if (!counts.shows) {
    return { state: STATE.NO_DATA, n: 0, used: 0, minPairs: MIN_PAIRS, counts };
  }
  if (n < MIN_PAIRS) {
    return { state: STATE.NOT_MEASURABLE, n, used: k, minPairs: MIN_PAIRS, counts };
  }
  return { state: STATE.MEASURED, n, used: k, rate: k / n, wilson: wilson(k, n), minPairs: MIN_PAIRS, counts };
}

/** Short report for the CLI. */
export function asText(r) {
  const lines = [`INJECTION EFFECT: ${r.counts.shows} injection(s) shown, ${r.n} pair(s) measurable`];
  lines.push(`  ${r.counts.noId} without a resolvable id, ${r.counts.noCapture} without a readable capture, `
    + `${r.counts.selfReinforced} dropped as self-reinforcement.`);
  if (r.counts.unreadableCaptures) lines.push(`  ${r.counts.unreadableCaptures} capture(s) unreachable (archive offline?).`);
  if (r.state === STATE.NO_DATA) {
    lines.push('  No injection on record. The recall hook books them (`mem find --journal-session`);');
    lines.push('  a machine whose hook predates that has nothing to measure yet.');
    return lines.join('\n');
  }
  if (r.state === STATE.NOT_MEASURABLE) {
    lines.push(`  Not measurable: ${r.n} pair(s), need at least ${r.minPairs} for the interval to mean anything.`);
    return lines.join('\n');
  }
  const pct = (x) => `${(x * 100).toFixed(1)} %`;
  lines.push(`  ${r.used} of ${r.n} used (${pct(r.rate)}), 95 % Wilson interval `
    + `[${pct(r.wilson.lo)}, ${pct(r.wilson.hi)}]`);
  lines.push('  A finding, not a ranking signal — nothing here feeds back into `mem find`.');
  return lines.join('\n');
}

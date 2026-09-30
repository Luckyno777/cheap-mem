// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * latencybudget — ONE budget per occasion, in exactly this place
 * (Bauplan P2; the sibling house's `latenzbudget.mjs`).
 *
 * **Why it exists.** The injection journal (`.pipeline/injections.jsonl`)
 * carries `duration_ms` per line — the wall time of the process that
 * booked it, from its start to the booking (`src/injection.mjs`). A
 * number nobody holds against anything is decoration: a session that
 * turns slow looks like a fast one from outside until a doctor finding
 * says so. `mem doctor` finding `hook-latency` and the dashboard's
 * "Hook time" panel both read THIS module and no other.
 *
 * **Data choice (house rule: better nothing than something false).**
 * p50/p95 per occasion over the last {@link WINDOW_DAYS} days — and,
 * because the field is new, over the last {@link WINDOW_LINES} lines
 * whenever the window holds fewer. Below {@link MIN_LINES} lines an
 * occasion is `unknown`, never `good` for lack of data. Lines without
 * `duration_ms` (older ones, or a writer that cannot time itself) are
 * NOT counted as fast: they are not in the sample at all.
 *
 * **The budget is a design limit, not a measurement.** cheap-mem ships
 * empty and this module was built without a real memory in reach (the
 * tests never touch one), so there is no measured percentile to quote.
 * What holds instead: the recall hook (`bin/mem-retrieve`) runs `mem
 * find` under a 5 s cap and gives up silently past it — a `question`
 * whose p95 sits AT that cap is a hook that is being killed. The
 * budget sits under it, at {@link BUDGET_MS}.question, and above what a
 * cold index rebuild costs. `before-edit` is a literal path lookup that
 * runs before EVERY edit; its budget is small. When a real journal has
 * enough lines, replace the numbers with measured ones and write the
 * table here — a budget that is never re-measured is a guess that
 * looks like a fact.
 *
 * Over budget is `warn`, over {@link ERROR_FACTOR} times the budget is
 * `error`, too few lines is `unknown`.
 *
 * {@link withinBudget} is PURE (nothing is read from disk): `false`
 * means at least one occasion is on `error` — `warn` and `unknown` let
 * it pass, because a gate that blocks on thin data would cause the
 * outage it guards against.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { OCCASION } from './injection.mjs';

export const LEVEL = Object.freeze({ GOOD: 'good', WARN: 'warn', ERROR: 'error', UNKNOWN: 'unknown' });
export const WINDOW_DAYS = 7;
export const WINDOW_LINES = 200;
export const MIN_LINES = 20;
export const ERROR_FACTOR = 2;

/** One budget per occasion — the only place a latency limit is written. */
export const BUDGET_MS = Object.freeze({
  [OCCASION.QUESTION]: 4000,
  [OCCASION.BEFORE_EDIT]: 1000,
  // After a failed tool call (X2b): the hook runs one `mem find` under a
  // 5 s cap plus a parse and a render; the sibling house budgets 2500 ms.
  [OCCASION.AFTER_ERROR]: 2500,
});

/**
 * **Measured P95 beside the design limit.** The limits above stay a
 * design limit; next to them stands what `bench/cold-find.mjs` measured
 * (artifact `bench/cold-find.json`: commit, hardware, corpus size,
 * cold = a fresh `mem find` process — what the recall hook runs).
 * Only `question` has such a measurement; `before-edit` is a different
 * command and stays `unknown`. No artifact (it is a bench file and does
 * not ship in the npm package), a broken one, or a size that was not
 * measured is `unknown` — never 0.
 */
export const ARTIFACT_PATH = fileURLToPath(new URL('../bench/cold-find.json', import.meta.url));

/** The parsed artifact, or `null` when it is missing or unreadable. */
export function loadArtifact(file = ARTIFACT_PATH) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Cold P95 rows of the artifact (`[{ entries, p95Ms, n }]`), empty when none. Pure. */
export function measuredColdP95(artifact) {
  const rows = Array.isArray(artifact?.results) ? artifact.results : [];
  return rows.filter((r) => r && r.state === 'cold' && Number.isFinite(r.p95Ms))
    .map((r) => ({ entries: r.entries, p95Ms: r.p95Ms, n: r.n }));
}

/** One row per budgeted occasion: the design limit and the measured P95 (or `unknown`). Pure. */
export function budgetTable(artifact = loadArtifact()) {
  const cold = measuredColdP95(artifact);
  return Object.keys(BUDGET_MS).map((occasion) => {
    const measured = occasion === OCCASION.QUESTION && cold.length ? cold : null;
    return {
      occasion, designLimitMs: BUDGET_MS[occasion],
      measuredP95: measured ?? 'unknown',
      commit: measured ? (artifact.environment?.gitCommit ?? 'unknown') : null,
    };
  });
}

/** Human line for the doctor: `question measured cold P95 …` or `… unknown`. */
export function measuredNote(artifact = loadArtifact()) {
  const q = budgetTable(artifact).find((r) => r.occasion === OCCASION.QUESTION);
  if (q.measuredP95 === 'unknown') return 'measured cold find P95: unknown (no bench/cold-find.json)';
  return `measured cold find P95 (commit ${q.commit}): ` + q.measuredP95.map((r) => `${r.entries} entries ${r.p95Ms} ms`).join(', ');
}

/** Percentile `p` (0-100), nearest rank; `null` for an empty list, never NaN. */
export function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * The journal lines of one occasion that carry a duration: the last
 * {@link WINDOW_DAYS} days, or — when that is fewer than
 * {@link WINDOW_LINES} — the last {@link WINDOW_LINES} lines regardless
 * of date. Pure: `lines` is already parsed.
 */
export function linesFor(lines, occasion, now = new Date()) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const own = (Array.isArray(lines) ? lines : [])
    .filter((l) => l && l.occasion === occasion && Number.isFinite(l.duration_ms))
    .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
  const from = at - WINDOW_DAYS * 86400000;
  const inWindow = own.filter((l) => { const t = Date.parse(l.ts); return Number.isFinite(t) && t >= from && t <= at; });
  return inWindow.length >= WINDOW_LINES ? inWindow : own.slice(-WINDOW_LINES);
}

/** p50 / p95 / level for ONE occasion. */
export function judge(lines, occasion, now = new Date()) {
  const budget = BUDGET_MS[occasion] ?? null;
  const own = linesFor(lines, occasion, now);
  const n = own.length;
  if (n < MIN_LINES || budget == null) return { occasion, n, p50: null, p95: null, budget, level: LEVEL.UNKNOWN };
  const values = own.map((l) => l.duration_ms);
  const p50 = percentile(values, 50);
  const p95 = percentile(values, 95);
  const level = p95 <= budget ? LEVEL.GOOD : (p95 <= budget * ERROR_FACTOR ? LEVEL.WARN : LEVEL.ERROR);
  return { occasion, n, p50, p95, budget, level };
}

export function judgeAll(lines, now = new Date()) {
  return Object.keys(BUDGET_MS).map((o) => judge(lines, o, now));
}

const RANK = { [LEVEL.ERROR]: 3, [LEVEL.WARN]: 2, [LEVEL.GOOD]: 1 };

/** Worst MEASURED level; all `unknown` stays `unknown`, never `good`. */
export function worstLevel(results) {
  const measured = (results ?? []).filter((r) => r.level !== LEVEL.UNKNOWN);
  if (!measured.length) return LEVEL.UNKNOWN;
  return measured.reduce((m, r) => (RANK[r.level] > RANK[m] ? r.level : m), LEVEL.GOOD);
}

export function withinBudget(lines, now = new Date()) {
  return !judgeAll(lines, now).some((r) => r.level === LEVEL.ERROR);
}

/**
 * Per-day series for the dashboard: for each UTC day with at least one
 * timed line, count / p50 / p95 / max over ALL occasions' timed lines
 * of that day. A day without a timed line is simply absent — never 0 ms.
 */
export function perDay(lines, { days = 14, now = new Date() } = {}) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const from = at - days * 86400000;
  const by = new Map();
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l || !Number.isFinite(l.duration_ms)) continue;
    const t = Date.parse(l.ts);
    if (!Number.isFinite(t) || t < from || t > at) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    if (!by.has(day)) by.set(day, []);
    by.get(day).push(l.duration_ms);
  }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({
    day, n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: Math.max(...v),
  }));
}

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * searchlevers — Block H, ported from lucky-mem (there `src/suchhebel.mjs`
 * and `src/einblendschwelle.mjs`, 2026-09-30): levers on the QUESTION and
 * on what is shown, not on the index. Everything here is deterministic and
 * model-free (no model in the recall path).
 *
 *   h1  splitQuestion() / buildQuery()   core words searched, common words
 *       (src/questionsplit.mjs)         only as by-catch
 *   h2  contextSignals() / rerank()      what the session is doing reorders
 *                                       what the question already found
 *   h3  passes() / answerHolds()         threshold by score GAP, calibrated
 *                                       per occasion
 *   h4  (src/askedlearn.mjs)             learn from misses, also shown ones
 *   h5  coreLine() / reloadBalance()     show short, load long, count loads
 *
 * **One switch, visible.** `MEM_SEARCH_LEVERS` = `off` | `all` | a comma
 * list (`h1,h3`). Unset = {@link DEFAULT_ON}. `mem search-levers` prints
 * the state and where it comes from.
 */
// This module stays LIGHT on purpose: the recall hook loads it on every
// prompt, and `search.mjs` costs ~25 ms to import. What needs the search
// module (h1) lives in `src/questionsplit.mjs`.
import path from 'node:path';
import fs from 'node:fs';
import { cutAtBoundary, renderHit } from './recallrender.mjs';

// --- the switch -----------------------------------------------------------

/** Every lever of this block. */
export const LEVERS = Object.freeze(['h1', 'h2', 'h3', 'h4', 'h5']);

/**
 * The levers that run without an explicit setting. A lever joins only
 * after a measurement on cheap-mem's own value report
 * (`bench/value-report.mjs --sizes 10000 --only recall`), not because the
 * sibling house turned it on. See the commit that sets this list for the
 * numbers.
 */
const DEFAULT_ON = Object.freeze(['h3']);

/** The env variable that switches the levers. */
export const ENV = 'MEM_SEARCH_LEVERS';

/**
 * `{ on: Set, source }` — `source` says WHERE the state comes from
 * (`default` or `env`), so `mem search-levers` can say "on, because
 * default" rather than just "on".
 */
export function leverState(env = process.env) {
  const raw = String(env?.[ENV] ?? '').trim().toLowerCase();
  if (!raw) return { on: new Set(DEFAULT_ON), source: 'default' };
  if (raw === 'off' || raw === '0' || raw === 'none') return { on: new Set(), source: 'env' };
  if (raw === 'all') return { on: new Set(LEVERS), source: 'env' };
  return { on: new Set(raw.split(/[\s,]+/).filter((h) => LEVERS.includes(h))), source: 'env' };
}

export function active(name, env = process.env) {
  return leverState(env).on.has(name);
}

// --- H3: threshold by score gap -------------------------------------------
//
// **The finding behind it (lucky-mem journal, 2026-09-30).** The fixed bar
// of 5.0 stopped being a hurdle: the median best score of a question rose
// from 7.6 to 66.6 while the share of "too weak" fell from 18 % to 0.06 %.
// The bar let nearly everything through; 12 of 12 decoy questions showed
// something. The lever is not "show more" but "do not show noise".
//
// **The rule.** A hit passes when it is
//   - exact (the identifier lane goes past the bar, unchanged), OR
//   - whole: it carries EVERY typed word of the question (`covered` = 1,
//     when the caller asked `search()` for it), OR, at or over the bar,
//   - strong: score >= `strong` x bar, OR
//   - clearly ahead: it is the first AND score >= `gap` x the second.
// A flat field just over the bar (9.2 / 9.0 — the two "How we deploy"
// notes answering "how tall is mount kilimanjaro" because both carry
// "how") stays silent; a single clear leader, a strong hit, or a field of
// notes that each carry the whole question does not.
//
// **"Whole" is cheap-mem's own addition (measured while porting).** The
// gap rule alone cannot tell a field of equally WRONG notes from a field
// of equally RIGHT ones: three versions of one payment decision tie as
// flat as two irrelevant "how" matches. The first ran through 20 tests of
// this repository (small fixtures with several matching entries) and
// withheld them all. Coverage is what separates the two: a decoy carries
// one word of the question, the versions of a decision carry all of it.
//
// **Where it acts: `mem find` as a whole, not per hit in the hook.** The
// sibling also drops single weak hits from the recall block (occasions
// `frage`, `nachher`, gap 1.15). Measured here through the real hook at
// 10k notes that cost one right-project answer, at 1k five gold answers,
// for one decoy fewer — not taken. The answer gate in `mem find` (which
// the recall hook calls) carries the decoy gain alone. The failure hooks
// keep their own lower bars and ask `mem find --weak`.
//
// **Not built: showing BELOW the bar.** Nothing records whether a silent
// turn missed something, so it cannot be calibrated.

/**
 * Per occasion: `strong` (a multiple of the bar), `gap` (first : second).
 *
 * - `find`: `mem find` as a whole — the value report's question set at
 *   10k notes (bench/value-report.mjs, 44 gold questions, 28 decoys),
 *   swept over strong 1..3 x gap 1.0..1.3. At 2 / 1.05 every gold note
 *   that was in the top 10 stays there; 2 / 1.15 (the sibling's value)
 *   cost one everyday question its top-10 place. Calibrated on one
 *   synthetic corpus: it proves "nothing lost there", not "optimal".
 *   Checked out of sample at 1k and 100k (see the commit).
 *
 * An occasion without a row keeps the old comparison (`score >= bar`).
 */
export const TABLE = Object.freeze({
  find: Object.freeze({ strong: 2, gap: 1.05 }),
});

/** The bar `mem find` holds an answer against, at the reference size: the
 * recall hook's own (`bin/mem-retrieve`, `MEM_RETRIEVE_MIN`). */
export const FIND_BAR = 5.0;
/** The corpus size the find row was calibrated at (the value report's 10k). */
export const FIND_BAR_REFERENCE_N = 10000;

/**
 * The idf of a word found in exactly one entry of `n` — the weight of one
 * perfectly rare word in THIS memory (the same formula as `idf()` in
 * src/search.mjs, df = 1).
 */
function rareWordWeight(n) {
  return Math.log(1 + (Math.max(1, n) - 0.5) / 1.5);
}

/**
 * The find bar for a memory of `n` entries: {@link FIND_BAR} scaled by how
 * heavy one rare word weighs here against the reference size.
 *
 * **Why scaled (measured while porting).** BM25 scores grow with the log
 * of the corpus size. A fixed 5.0 calibrated at 10k notes withheld real
 * answers at 1k: the same "website went dark" question scores 6.0 at 10k
 * and 4.4 at 1k, the two on-call notes 10.8 and 7.6 — every everyday
 * question of the value report fell silent there (top 3: 25 % -> 0 %).
 * Expressed in units of one rare word, the bar means the same at every
 * size — down to a memory of one entry, whose only hit is its own clear
 * leader. Without `n` (unknown size) the fixed bar holds.
 */
export function findBar(n) {
  if (!(Number(n) >= 1)) return FIND_BAR;
  return FIND_BAR * rareWordWeight(n) / rareWordWeight(FIND_BAR_REFERENCE_N);
}

const scoreOf = (h) => Number(h?.score) || 0;
const isExact = (h) => Array.isArray(h?.exact) ? h.exact.length > 0 : Boolean(h?.exact);

/** The score of the second-best hit of the list (0 when there is none). */
function secondScore(hits) {
  const s = (hits ?? []).map(scoreOf).sort((a, b) => b - a);
  return s.length > 1 ? s[1] : 0;
}

/**
 * May this hit out? `hits` is the whole list (for the gap), `hit` the one
 * asked about. With `on: false`, or an occasion without a row, this is
 * exactly the old comparison: `score >= bar || exact`.
 */
export function passes(hit, hits, { occasion = 'find', bar = FIND_BAR, on = true } = {}) {
  if (isExact(hit)) return true;
  const p = TABLE[occasion];
  if (on && p && hit?.covered === 1 && scoreOf(hit) > 0) return true;
  const score = scoreOf(hit);
  if (!(score >= bar)) return false;
  if (!on || !p) return true;
  if (score >= p.strong * bar) return true;
  const best = Math.max(...(hits ?? []).map(scoreOf));
  if (score < best) return false;
  // Ties at the top are not a lead.
  const tied = (hits ?? []).filter((h) => h !== hit && scoreOf(h) === score).length;
  if (tied) return false;
  const second = secondScore(hits);
  return second === 0 || score >= p.gap * second;
}

/**
 * Does the answer as a whole hold — does ANY hit pass? `mem find` uses
 * this: a list in which nothing passes is withheld as a whole (the hits
 * stay available with `--weak`), a list in which one hit passes is shown
 * unchanged, weaker hits included — a person reading a list judges the
 * rest themselves.
 */
export function answerHolds(hits, { occasion = 'find', bar = FIND_BAR, on = true } = {}) {
  const list = Array.isArray(hits) ? hits : [];
  if (!list.length) return true;
  return list.some((h) => passes(h, list, { occasion, bar, on }));
}

// --- H2: context signals reorder ------------------------------------------
//
// The question is ONE lane. Beside it the hook already holds context: the
// directory the session runs in, the files it touched last and the last
// error it saw (both from the end of the transcript). They do not search —
// they only REORDER what the question found. Never a new hit from context
// alone ("better nothing than something wrong").
//
// **Weights: estimated, not measured — and it says so here.** No per-lane
// hit rate exists to derive them from. Small and capped.
//
// **Words, not stems.** The sibling matches error words through the
// search tokenizer. Here the hook loads this module on every prompt, and
// the search module costs ~25 ms to import — so an error word matches a
// hit only in the same surface form (four letters or more, no digits-only
// runs). Coarser, and stated: it can only miss a reorder, never add a hit.
const LANE_WEIGHT_ESTIMATE = Object.freeze({ project: 0.1, file: 0.2, error: 0.2 });
/** No hit gets more than half again from context. */
const CONTEXT_FACTOR_MAX = 1.5;

const TAIL_BYTES = 128 * 1024;

/** Surface words of four letters or more, lower case, in order, unique. */
function signalWords(text) {
  const out = [];
  for (const w of String(text ?? '').toLowerCase()
    .replace(/\u00e4/g, 'ae').replace(/\u00f6/g, 'oe').replace(/\u00fc/g, 'ue').replace(/\u00df/g, 'ss')
    .split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !/^\d+$/.test(w) && !out.includes(w)) out.push(w);
  }
  return out;
}
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit']);

function tailLines(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const from = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift(); // the first line is cut
    return lines;
  } catch { return []; } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* fine */ }
  }
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n');
  return '';
}

/**
 * The context signals of a hook call: `{ cwd, transcript_path }` as the
 * hook JSON carries them. `null` when there is none. Reads only the end
 * of the transcript and never throws.
 *
 * @returns {{dirs:string[], files:string[], errorWords:string[]}|null}
 */
export function contextSignals({ cwd = '', transcript = '' } = {}) {
  try {
    const dirs = String(cwd ?? '').toLowerCase().split(/[\\/]+/).filter(Boolean);
    const files = [];
    let errorWords = [];
    if (transcript) {
      const lines = tailLines(String(transcript));
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        const content = o?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (b?.type === 'tool_use' && FILE_TOOLS.has(b.name) && typeof b.input?.file_path === 'string') {
            const base = path.basename(b.input.file_path).toLowerCase();
            if (base && !files.includes(base) && files.length < 3) files.push(base);
          } else if (b?.type === 'tool_result' && b.is_error === true && !errorWords.length) {
            errorWords = signalWords(resultText(b.content).slice(0, 400)).slice(0, 8);
          }
        }
        if (files.length >= 3 && errorWords.length) break;
      }
    }
    if (!dirs.length && !files.length && !errorWords.length) return null;
    return { dirs, files, errorWords };
  } catch { return null; }
}

/**
 * Reorder the hits by the context signals. A pure factor on the score,
 * capped at {@link CONTEXT_FACTOR_MAX}; a hit without a signal keeps its
 * score, so without signals the order is bit-identical. Stable: on a tie
 * the old order stays. Exact hits stay where the exact lane put them.
 */
export function rerank(hits, sig, { weights = LANE_WEIGHT_ESTIMATE } = {}) {
  if (!sig || !Array.isArray(hits) || hits.length < 2) return hits;
  const errorTokens = new Set(sig.errorWords ?? []);
  const dirs = new Set(sig.dirs ?? []);
  const scored = hits.map((h, i) => {
    const score = scoreOf(h);
    if (score <= 0 || isExact(h)) return { h, i, score, keep: true };
    const text = JSON.stringify(h.entry ?? {}).toLowerCase();
    let factor = 1;
    if (h.project && dirs.has(String(h.project).toLowerCase())) factor += weights.project;
    if (sig.files?.some((f) => text.includes(f))) factor += weights.file;
    if (errorTokens.size) {
      const tokens = new Set(signalWords(text));
      let inside = 0;
      for (const t of errorTokens) if (tokens.has(t)) inside += 1;
      factor += weights.error * (inside / errorTokens.size);
    }
    factor = Math.min(factor, CONTEXT_FACTOR_MAX);
    return { h: factor === 1 ? h : { ...h, score: score * factor }, i, score: score * factor, keep: false };
  });
  // The exact lane keeps its places; only the ranked hits are reordered
  // among the places they held.
  const ranked = scored.filter((x) => !x.keep).sort((a, b) => (b.score - a.score) || (a.i - b.i));
  let k = 0;
  return scored.map((x) => (x.keep ? x.h : ranked[k++].h));
}

// --- H5: show short, load long ---------------------------------------------
//
// The same byte budget for more, shorter lines — up to five, each with its
// `[id]` anchor and about 170 characters of core; whoever wants more loads
// the id (`mem show <id>`), and that load is counted (`reloadBalance`).
export const H5_MAX = 5;
export const H5_BUDGET_BYTES = 800;
export const H5_CHARS = 170;
/** At least this many lines, even when the budget tears (one long + one). */
export const H5_MIN = 2;
/** Added to the hook's header when H5 runs. */
export const H5_HEADER_NOTE = ' Short form: the full entry per line is `mem show <id>`.';

/** The core line of a hit: the same statement as `renderHit()`, cut at a
 * sentence or clause boundary to {@link H5_CHARS}. */
function coreLine(hit) {
  const r = renderHit(hit);
  return { ...r, line: cutAtBoundary(r.line, H5_CHARS).text };
}

/**
 * The H5 block: core lines in order, at most {@link H5_MAX}, stopping
 * when the next line would break {@link H5_BUDGET_BYTES} (but never under
 * {@link H5_MIN} lines).
 */
export function coreLines(hits, { attach = null } = {}) {
  const units = []; // per shown hit: line, source, id, bytes, and the id a solution line below it brought
  let bytes = 0;
  const size = (line) => Buffer.byteLength(line, 'utf8') + 1;
  for (const h of hits ?? []) {
    if (units.length >= H5_MAX) break;
    const r = coreLine(h);
    // `attach(hit)` (src/recallattach.mjs): a line directly below this one; it counts in the budget.
    const a = attach ? attach(h) : null;
    const line = a ? `${r.line}\n${a.line}` : r.line;
    const b = size(line);
    if (units.length >= H5_MIN && bytes + b > H5_BUDGET_BYTES) {
      // A line WITH a solution gives way last: further down, hits without a solution go first
      // (the last one first) - but only when clearing is enough, or a hit would give way for nothing.
      if (a) {
        const free = units.reduce((n, u) => n + (u.attached ? 0 : u.bytes), 0);
        if (bytes - free + b <= H5_BUDGET_BYTES) {
          for (let i = units.length - 1; i >= 0 && bytes + b > H5_BUDGET_BYTES; i -= 1) {
            if (units[i].attached) continue;
            bytes -= units[i].bytes;
            units.splice(i, 1);
          }
        }
      }
      if (units.length >= H5_MIN && bytes + b > H5_BUDGET_BYTES) break;
    }
    units.push({ line, source: r.source, id: r.id, bytes: b, attached: a ? a.id : null });
    bytes += b;
  }
  return {
    lines: units.map((u) => u.line),
    sources: units.map((u) => u.source),
    ids: units.filter((u) => u.id).map((u) => u.id),
    attached: units.filter((u) => u.attached).map((u) => u.attached),
  };
}

/**
 * Loads after a showing: of the injected recall turns in the journal, how
 * many shown entries did the SAME session then load by id (`mem show
 * <id>`, a tool call) within the mention window? Read off the session's
 * own capture, the same way `mem asked-learn` reads mentions — no new
 * write path, nothing booked twice.
 *
 * `lines` maps session -> sorted transcript lines (`{ z, t }`), `place`
 * maps an id (lower case) -> `source:line`. Pure.
 */
export function reloadBalance(journal, lines, place, { window = 30 * 60 * 1000, isToolMention } = {}) {
  let shownTurns = 0; let shownEntries = 0; let reloaded = 0; let withCapture = 0;
  for (const z of journal) {
    if (z?.occasion !== 'question' || z.reason != null || !z.session) continue;
    const src = new Set(z.sources ?? []);
    if (!src.size) continue;
    shownTurns += 1;
    shownEntries += src.size;
    const sl = lines.get(z.session);
    if (!sl?.length) continue;
    withCapture += 1;
    const t = Date.parse(z.ts ?? '');
    const seen = new Set();
    for (const x of sl) {
      if (x.t <= t) continue;
      if (x.t - t > window) break;
      const ids = isToolMention ? isToolMention(x.z) : [];
      for (const id of ids) {
        const p = place.get(id);
        if (p && src.has(p) && !seen.has(p)) { seen.add(p); reloaded += 1; }
      }
    }
  }
  return { shownTurns, shownEntries, withCapture, reloaded };
}

// --- the visible state ------------------------------------------------------

const WHAT = Object.freeze({
  h1: 'split the question (core words; common words as by-catch)',
  h2: 'context signals reorder (weights estimated)',
  h3: 'threshold by score gap: mem find withholds a flat field of weak hits',
  h4: 'learn from SHOWN misses too (mem asked-learn)',
  h5: 'show short, load long (mem show <id> is counted)',
});

/** The state of every lever, for `mem search-levers`. */
export function stateText(env = process.env, { learned = null, reloads = null } = {}) {
  const st = leverState(env);
  const lines = ['SEARCH LEVERS (Block H)',
    `  ${ENV}: ${env?.[ENV] ? `'${env[ENV]}'` : 'not set'} (source: ${st.source})`];
  for (const h of LEVERS) lines.push(`  ${h}  ${st.on.has(h) ? 'ON ' : 'off'}  ${WHAT[h]}`);
  if (learned) {
    lines.push(`  Learned (H4/M18b): ${learned.entries} entries carry learned question words, `
      + `${learned.fromShown} of them from shown misses`);
  }
  if (reloads) {
    lines.push(`  Reloads (H5): ${reloads.reloaded} shown entries loaded by id afterwards, `
      + `over ${reloads.shownTurns} recall turns with ${reloads.shownEntries} shown entries `
      + `(${reloads.withCapture} turns with a readable capture)`);
  }
  return lines.join('\n');
}

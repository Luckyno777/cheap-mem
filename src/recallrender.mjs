// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * recallrender — the ONE renderer for the lines the recall hooks put into
 * a session (Z1c).
 *
 * **The finding (external brief 2026-09-30, reproduced).** The recall
 * hook showed a learning WITH a title as its title alone: the actual
 * content was missing. Three inline copies of the line builder
 * (`bin/mem-retrieve`, `bin/mem-catch-fail`, `src/afterfailure.mjs`, the
 * two `.ps1` twins running the same code as text) each carried their own
 * short field list — six of the thirteen `BODY_FIELDS` — so `learning`,
 * `rule` and `fact` were findable, shown as a title, and unreadable. The
 * class is the one `retrieval.BODY_FIELDS` already documents:
 * `built-but-out-of-reach`. Four copies of a list is how it happened
 * again, so there is now exactly one function and every hook calls it.
 *
 * **What a line is.** `  DAY  [ID lane]  class — title — topic — <body
 * fields in BODY_FIELDS order> — because <why>`.
 *
 *  - The body comes from `retrieval.BODY_FIELDS` itself, never from a
 *    list of its own: what can be found can be shown, and a fourteenth
 *    field added there reaches every hook without anyone remembering.
 *  - The ID is in every line (`mem show <id>` loads the full entry).
 *    Without it a hit could be read but not followed up.
 *  - The reason keeps its own place FIRST in the budget (the 2026-09-06
 *    measurement: a ruling shown without its reason is followed after the
 *    reason has fallen away).
 *  - A cut is never silent and never mid-word: it falls on a sentence or
 *    clause boundary where one exists, and the line then ends with a
 *    visible marker naming the way to the full text.
 *
 * Pure functions, no I/O, no model.
 */

import path from 'node:path';
// O2: straight from the leaf module that is the ONE source for every
// display and for the indexed field set (`retrieval.mjs` re-exports it).
import { BODY_FIELDS, NON_BODY_FIELDS, bodyAsText } from './bodyfields.mjs';

/** Characters of text per hit (the line's prefix — day, id, lane — not counted). */
export const LINE_BUDGET = 300;
/** Own share of the budget for the reason. */
export const WHY_BUDGET = 100;
/** Own share of the budget for class/title/topic. */
export const HEAD_BUDGET = 110;
/** The body never gets less than this, however long head and reason are. */
export const BODY_FLOOR = 80;

/** Fields that are bookkeeping, never content — the last-resort fallback skips them. */
const META_FIELDS = new Set(['id', 'ts', 'type', 'author', 'by', 'project', 'status',
  'valid_from', 'valid_until', 'replaces_id', 'schema', 'v', 'version', 'signature']);

const squash = (t) => String(t).replace(/\s+/g, ' ').trim();
const text = (v) => (typeof v === 'string' && v.trim() ? squash(v) : '');

/**
 * Cut `t` to at most `max` characters on a sentence boundary if one is
 * there in the back half, else on a clause boundary, else on a word.
 * Returns `{ text, cut }`; a cut text ends with an ellipsis.
 */
export function cutAtBoundary(t, max) {
  const s = squash(t);
  if (s.length <= max) return { text: s, cut: false };
  const window = s.slice(0, Math.max(1, max - 1));
  const floor = Math.floor(window.length * 0.4);
  let at = -1;
  const sentence = /[.!?;:](?=\s)/g;
  for (let m = sentence.exec(window); m; m = sentence.exec(window)) at = m.index + 1;
  if (at < floor) {
    at = -1;
    const clause = /(?:,|\s[—–-])(?=\s)/g;
    for (let m = clause.exec(window); m; m = clause.exec(window)) at = m.index;
  }
  if (at < floor) at = window.lastIndexOf(' ');
  if (at < floor) at = window.length;
  const head = window.slice(0, at).replace(/[\s,;:—–-]+$/, '');
  return { text: `${head} …`, cut: true };
}

/** The lane an entry came from: `learnings` for `…/learnings.jsonl`. */
function laneOf(source) {
  const s = String(source ?? '');
  return s ? path.basename(s).replace(/\.jsonl$/, '') : '';
}

/**
 * One line for one hit. `hit` is a `mem find --json` hit
 * (`{entry, source, line, ...}`); a bare entry works too.
 * Returns `{ line, cut, id, source }`.
 */
export function renderHit(hit, { budget = LINE_BUDGET } = {}) {
  const e = (hit && hit.entry) ? hit.entry : (hit || {});
  const source = (hit && hit.entry && hit.source) ? `${hit.source}:${hit.line ?? 0}` : '';
  const day = String(e.ts || '').slice(0, 10);
  const id = typeof e.id === 'string' && e.id ? e.id : null;

  const headParts = [];
  for (const v of [e.class, e.title, e.topic]) {
    const t = text(v);
    if (t && !headParts.includes(t)) headParts.push(t);
  }
  const bodyParts = [];
  for (const f of BODY_FIELDS) {
    if (f === 'title' || f === 'why') continue;
    // `bodyAsText`: `steps` (a workflow) is an array, numbered on one line.
    const t = text(bodyAsText(e[f]));
    if (t && !bodyParts.includes(t)) bodyParts.push(t);
  }
  if (!bodyParts.length) {
    // `summary` is not an indexed field but old entries carry it.
    const t = text(e.summary);
    if (t) bodyParts.push(t);
  }
  const why = text(e.why);

  // Safe fallback: an entry of a shape nobody listed still shows what it
  // has, never an empty line and never its raw JSON.
  if (!headParts.length && !bodyParts.length && !why) {
    for (const [k, v] of Object.entries(e)) {
      if (META_FIELDS.has(k) || NON_BODY_FIELDS.includes(k)) continue;
      const t = text(v);
      if (t) bodyParts.push(`${k}: ${t}`);
    }
  }

  let cut = false;
  const fit = (t, n) => { const r = cutAtBoundary(t, n); cut = cut || r.cut; return r.text; };
  const headText = headParts.length ? fit(headParts.join(' — '), HEAD_BUDGET) : '';
  const whyText = why ? fit(why, WHY_BUDGET) : '';
  const used = headText.length + (whyText ? whyText.length + 'because '.length : 0)
    + 3 * (Number(Boolean(headText)) + Number(Boolean(whyText)));
  const bodyText = bodyParts.length
    ? fit(bodyParts.join(' — '), Math.max(BODY_FLOOR, budget - used))
    : '';

  const pieces = [headText, bodyText, whyText ? `because ${whyText}` : ''].filter(Boolean);
  let body = pieces.join(' — ');
  if (!body) body = '(no readable text)';
  if (cut && id) body += ` [cut - full text: mem show ${id}]`;
  else if (cut) body += ' [cut]';
  if (!pieces.length && id) body += ` [mem show ${id}]`;

  const lane = laneOf(hit && hit.entry ? hit.source : '');
  const tag = id ? `[${id}${lane ? ` ${lane}` : ''}]` : (lane ? `[${lane}]` : '');
  const line = `  ${day}  ${tag ? `${tag} ` : ''}${body}`.replace(/\s+$/, '');
  return { line, cut, id, source };
}

/**
 * The hits that clear the bar (or are exact), rendered.
 * `lanes` (a RegExp) restricts by source path; `seen` counts the hits
 * the search returned inside those lanes, so `too-weak` can be told
 * from `empty` by the caller.
 */
export function renderHits(hits, { min, top = Infinity, lanes = null, budget = LINE_BUDGET } = {}) {
  const lines = [];
  const sources = [];
  const ids = [];
  let seen = 0;
  for (const h of Array.isArray(hits) ? hits : []) {
    if (lanes && !lanes.test(String(h?.source ?? ''))) continue;
    seen += 1;
    if (!(Number(h.score) >= min) && !(h.exact && h.exact.length)) continue;
    if (lines.length >= top) continue;
    const r = renderHit(h, { budget });
    lines.push(r.line);
    sources.push(r.source);
    if (r.id) ids.push(r.id);
  }
  return { lines, sources, ids, seen };
}

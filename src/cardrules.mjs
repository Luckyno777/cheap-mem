// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * cardrules — the rules by which a decision card may be written, and the
 * small text tools every card needs (H11, card-core-cm). A leaf: its only import
 * is `outputguard.mjs` (itself a leaf over `redaction.mjs`, which imports nothing) and it does no I/O. It stands alone because three places need it and a
 * ring between them would be the price otherwise: the write core
 * (`memory.logEntry`, type `card`), the card itself (`decisioncard`) and the
 * card shelf (`cardstore`).
 *
 * **One check, one place.** `mem card add`, `mem log card` and the MCP bridge
 * all write through `memory.logEntry`; there the type `card` runs `checkCard`
 * (form, lengths, options, a decline option) and the target check (form, exists,
 * not locked). A card only one road checks can be had on another road.
 *
 * **Linear.** Every input is cut to `MAX_IN` characters first, and sentences are
 * only looked for in the first `SENTENCE_SOURCE_MAX`. No pattern in here has a
 * nested quantifier or an end anchor that can backtrack: a text of 60,000 dots
 * or 8,000 line breaks costs as much as a text of 8,192 plain letters.
 */

// invariant: eine-regel-eine-stelle

import { maskText, costCut } from './outputguard.mjs';

/** The three kinds of card: the human chooses between ways / releases what another prepared / a task, not a decision. */
export const KINDS = Object.freeze(['decide', 'approve', 'do-it']);

/** Lengths in characters. What is longer is cut at a word boundary on display; the write check is stricter. */
export const LIMITS = Object.freeze({
  question: 160, context: 320, advice: 200, choice: 80, effect: 240, evidence: 160, optionsMax: 6, evidenceMax: 8,
});

/** So many characters of an input text are looked at: every output is shorter, and no pattern may work longer. */
export const MAX_IN = 8192;
/** Sentences are looked for in this many characters from the start. */
const SENTENCE_SOURCE_MAX = 2000;

/**
 * One input as ONE clean line: cut to `MAX_IN`, whitespace folded, then control and format characters removed (ESC, the
 * bidi switches such as U+202E, zero-width characters). A card goes to a terminal, a page and an agent's context.
 */
export function clean(v) {
  // The cost bound comes through `costCut`, which drops the run the edge broke: the fold below squeezes white space, so a
  // plain cut at MAX_IN would leave the cut-through rest of a key at the END of the folded text, where no pattern knows
  // it (an 8160-space lead and a token over the edge did exactly that). The mask runs on what is kept, before the fold
  // and before every later cut (shorten, sentencesOf, the limits).
  const t = typeof v === 'string' ? maskText(costCut(v, MAX_IN)) : (typeof v === 'number' ? String(v) : '');
  return t.replace(/\s+/g, ' ').replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
}

// What sounds like No or "not now". The choice only, never the effect.
const DECLINE = /(^|[^\p{L}])(no|not|nothing|never|decline\w*|reject\w*|discard\w*|drop|cancel\w*|abort\w*|dismiss\w*|skip\w*|defer\w*|postpone\w*|later|leave|park|withdraw\w*|retain|hold)(?![\p{L}])/iu;

/** Does this choice read as a No or a "not now"? */
export const isDecline = (choice) => DECLINE.test(String(choice ?? ''));

/** The separator between choice and effect: an em or en dash, or a hyphen with spaces around it. */
const SEPARATOR = /\s+[—–]\s+|\s+--?\s+/;

/** An option "choice — effect" as `{choice, effect}` (effect empty when none is named). */
export function splitOption(o) {
  const m = SEPARATOR.exec(o);
  // mask-ok: `o` is an option from listOf(), which masks (clean)
  return { choice: m ? o.slice(0, m.index) : o, effect: m ? o.slice(m.index + m[0].length) : '' };
}

/** A list of texts: a list, or one text with line breaks. Empty ones drop out. */
export function listOf(v) {
  return (Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/\r?\n/) : [])).map(clean).filter(Boolean);
}

// --- text tools ----------------------------------------------------------------------------------

const ELLIPSIS = '…';

/** Cut to `max` characters at a word boundary, with "…" (only when it was cut). */
export function shorten(text, max) {
  const t = maskText(String(text ?? '')).replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  let s = t.slice(0, max - 1);
  if (!/\s/.test(t[max - 1] ?? '')) {
    const i = s.lastIndexOf(' ');
    if (i > 0) s = s.slice(0, i);
  }
  s = s.replace(/[\s,;:({[\-–—/]+$/, '');
  const open = s.lastIndexOf('(');
  if (open > 0 && s.indexOf(')', open) === -1) s = s.slice(0, open).replace(/[\s,;:\-–—/]+$/, '');
  return `${s}${ELLIPSIS}`;
}

/** Abbreviations after which a full stop is no sentence end (lower case, no dot). */
const ABBREVIATIONS = new Set(['e', 'g', 'i', 'eg', 'ie', 'etc', 'vs', 'cf', 'approx', 'incl', 'no', 'nr', 'fig', 'dr', 'mr', 'mrs', 'ms', 'st', 'z', 'b', 'bzw', 'ca']);

/** Markdown out, whitespace folded: bounded patterns only (at most a few hundred characters per link). */
function plainText(text) {
  // the cost bound drops the run the edge broke (outputguard.costCut); the mask runs on what is kept, before any sentence is cut
  return maskText(costCut(String(text ?? ''), SENTENCE_SOURCE_MAX))
    .replace(/!?\[([^\]\n]{0,200})\]\([^)\n]{0,300}\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+|>\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The index of the first real sentence end in `t` (the index of the mark), or -1. One pass. */
function sentenceEnd(t) {
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i];
    if (c !== '.' && c !== '!' && c !== '?') continue;
    if (i + 1 < t.length && t[i + 1] !== ' ') continue;
    if (c === '.') {
      // the word before the dot: at most 8 letters back
      let j = i;
      while (j > 0 && i - j < 9 && /\p{L}/u.test(t[j - 1])) j -= 1;
      // mask-ok: a lookup of the (at most 8) letters before a dot, never shown
      if (ABBREVIATIONS.has(t.slice(j, i).toLowerCase())) continue;
    }
    return i;
  }
  return -1;
}

/**
 * The first `n` whole sentences of `text` as a list, each with its mark at the end, markdown removed, from the first
 * `SENTENCE_SOURCE_MAX` characters only. Empty text gives an empty list.
 */
export function sentencesOf(text, n = 2) {
  let t = plainText(text);
  const out = [];
  while (t && out.length < n) {
    const e = sentenceEnd(t);
    if (e < 0) { out.push(t); t = ''; break; }
    // mask-ok: `t` is plainText(), which masks before the sentence is cut
    const s = t.slice(0, e + 1).trim();
    if (s) out.push(s);
    t = t.slice(e + 1).trim();
  }
  return out;
}

// --- the target of a card ---------------------------------------------------------------------------
// An entry is named by its id; targets without an entry carry a prefix. The character classes are narrow: the identifier is
// printed into hints, command lines and files (a `$(...)` or `"` in it would be an attack).
const TARGET_ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{3,63}$/;
const TARGET_PROJECT = /^project:([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)$/;
const TARGET_LETTER = /^letter:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TARGET_WORD_PAIR = /^word-pair:[\p{L}\p{N}_-]{1,40}\|[\p{L}\p{N}_-]{1,40}$/u;

/** What is wrong with a target id (one sentence) or `null`. No look at the disk. */
export function targetFormProblem(target) {
  const z = typeof target === 'string' ? target : '';
  if (!z) return 'target_id missing — which entry does the card belong to?';
  if (TARGET_ID.test(z) || TARGET_PROJECT.test(z) || TARGET_LETTER.test(z) || TARGET_WORD_PAIR.test(z)) return null;
  return 'target_id has a form that is not allowed — allowed are the id of an entry (4 to 64 letters, digits, _ and -), '
    + 'project:<name>, letter:<file name> and word-pair:<a>|<b>';
}

/** The project name of a target `project:<name>`, else `null`. */
export const projectOfTarget = (target) => TARGET_PROJECT.exec(target ?? '')?.[1] ?? null;
/** Is the target an entry id you can look up? Otherwise it is a target without an entry (a prefix). */
export const targetIsEntry = (target) => TARGET_ID.test(target ?? '');

/**
 * The content of a card (without the target): question, context, options, advice, evidence, kind. ONE check for the card on the
 * shelf (`checkCard`) and for the card an entry carries itself (`cardrule`, the write rule for a duty or question to a person).
 * `contextRequired: false` turns a missing context into a warning: on the entry the fallback card fills it, on the shelf the card
 * IS what the person reads. Pure.
 */
export function checkCardContent({ question, context, options, advice, evidence, kind } = {}, { contextRequired = true } = {}) {
  const errors = []; const warnings = [];
  const L = LIMITS;
  const q = clean(question);
  if (!q) errors.push('card_question missing — the decision question in one sentence');
  else {
    if (q.length > L.question) errors.push(`card_question is ${q.length} characters long, ${L.question} are allowed`);
    if (!q.endsWith('?')) warnings.push('the question does not end in "?" — sure it is a decision question?');
  }
  const c = clean(context);
  if (!c) {
    if (contextRequired) errors.push('card_context missing — one or two sentences: what is it about, why now');
    else warnings.push('card_context missing — one or two sentences: what is it about, why now (the fallback card fills it in)');
  } else if (c.length > L.context) errors.push(`card_context is ${c.length} characters long, ${L.context} are allowed`);
  const opt = listOf(options);
  if (opt.length < 2) errors.push(`at least two options are needed (one "choice — effect" each; \`mem card add\`: --option twice, \`mem log card\`: --card_options twice or one per line), given: ${opt.length}`);
  if (opt.length > L.optionsMax) errors.push(`at most ${L.optionsMax} options, given: ${opt.length}`);
  const read = opt.map(splitOption);
  if (opt.length && !read.some((o) => isDecline(o.choice))) {
    errors.push('no No / not-now option — every card needs one (e.g. "No — ..." or "Not now — ...")');
  }
  // mask-ok: options come from clean(), which masks
  for (const o of read) {
    if (o.choice.length > L.choice) errors.push(`option "${o.choice.slice(0, 30)}...": the choice is longer than ${L.choice} characters`);
    if (!o.effect) warnings.push(`option "${o.choice.slice(0, 40)}" names no effect ("choice — effect")`);
    else if (o.effect.length > L.effect) errors.push(`option "${o.choice.slice(0, 30)}": the effect is longer than ${L.effect} characters`);
  }
  const a = clean(advice);
  if (a && a.length > L.advice) errors.push(`card_advice is ${a.length} characters long, ${L.advice} are allowed`);
  if (listOf(evidence).length > L.evidenceMax) errors.push(`at most ${L.evidenceMax} pieces of evidence`);
  if (kind !== undefined && kind !== null && clean(kind) && !KINDS.includes(clean(kind).toLowerCase())) {
    errors.push(`card_kind '${clean(kind)}' does not exist; allowed: ${KINDS.join(', ')}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Check whether these fields may become a card on the shelf. Pure. `errors` stop the write, `warnings` do not. The lengths are
 * STRICTER than on display (which only cuts): whoever writes a card should write it so it is read in one piece.
 */
export function checkCard({ target_id: target, ...content } = {}) {
  const tp = targetFormProblem(target);
  const c = checkCardContent(content);
  const errors = tp ? [tp, ...c.errors] : c.errors;
  return { ok: errors.length === 0, errors, warnings: c.warnings };
}

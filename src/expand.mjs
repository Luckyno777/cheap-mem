// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/expand.mjs — document expansion: the field `asked_as`.
//
// **The idea.** When an entry is captured (by the digest model, or by an
// agent calling `mem log`), a list of short phrasings is written next to
// it: how someone would LATER ask for this thing, in everyday words
// instead of the note's own. No questions, no sentences copied from the
// note. The work happens at write time, in the same model call that
// writes the rest of the entry; retrieval stays free of a model.
//
// `asked_as` is not `asked`. `asked` (3 to 6 words or phrases) is indexed
// always and is the digest's older handle; `asked_as` (8 to 12 short
// phrasings) is the expansion field, read by the search ONLY behind the
// switch below.
//
// **Measured here** (branches agent/expand-measure-cm, expand-fair-cm,
// expand-gemini-cm: bench/expand*, results in bench/expand-gemini/
// results.md). Built the way that measurement settled on:
//   - weight 0.3 ({@link WEIGHT}), below every field the note's own words
//     sit in; 0.5 raised the decoys;
//   - a word the note carries ONLY through this field covers HALF a typed
//     word in the coordination factor (src/search.mjs), never a whole one,
//     and never counts for the gate's "whole question covered" rule;
//   - the phrasings are stripped of general English stop words before they
//     are indexed ({@link phrases});
//   - with the switch on, the index cache lives in its own directory
//     ({@link cacheSuffix}), so the two states never mix.
//
// **The switch.** `MEM_EXPAND=1`. Off (the default) the search does not
// read the field at all: index, scores and the exact-identifier lane are
// bit-identical to a memory without it. The field is written whenever
// somebody supplies it.
//
// Nearly a leaf on purpose: its only import is the tiny frozenSet helper.

import { frozenSet } from './frozenset.mjs';

/** The field name on the entry. */
export const FIELD = 'asked_as';

/** The switch. */
export const ENV = 'MEM_EXPAND';

/** The field's weight in the index (measured: 0.3 holds the decoys, 0.5 raises them). */
export const WEIGHT = 0.3;

/** At most this many phrasings per entry (the capture prompt asks for 8 to 12). */
export const MAX_COUNT = 12;
/** Short means: at most this many characters and words per phrasing. */
export const MAX_CHARS = 60;
const MAX_WORDS = 8;
/** From this many words on, a phrasing found verbatim in the entry counts as copied. */
const COPY_FROM_WORDS = 4;

/** Is the expansion switched on? Only `MEM_EXPAND=1`. */
export function on(env = process.env) {
  return String(env?.[ENV] ?? '').trim() === '1';
}

/**
 * Suffix for the index cache directory: empty without the switch (every
 * path stays as it was), `-expand` with it.
 */
export function cacheSuffix(env = process.env) {
  return on(env) ? '-expand' : '';
}

/**
 * The Snowball English stop word list (snowballstem.org, algorithms/
 * english/stop.txt, BSD-3-Clause), apostrophe forms included. Not chosen
 * or edited against any decoy question.
 */
export const STOP = frozenSet((
  'i me my myself we our ours ourselves you your yours yourself yourselves he him his himself '
  + 'she her hers herself it its itself they them their theirs themselves what which who whom '
  + 'this that these those am is are was were be been being have has had having do does did doing '
  + "would should could ought i'm you're he's she's it's we're they're i've you've we've they've "
  + "i'd you'd he'd she'd we'd they'd i'll you'll he'll she'll we'll they'll isn't aren't wasn't "
  + "weren't hasn't haven't hadn't doesn't don't didn't won't wouldn't shan't shouldn't can't "
  + "cannot couldn't mustn't let's that's who's what's here's there's when's where's why's how's "
  + 'a an the and but if or because as until while of at by for with about against between into '
  + 'through during before after above below to from up down in out on off over under again '
  + 'further then once here there when where why how all any both each few more most other some '
  + 'such no nor not only own same so than too very').split(' '));

/** One phrasing without the stop words above (word order stays). */
function stripStops(text) {
  return String(text).split(/\s+/)
    .filter((w) => w && !STOP.has(w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')))
    .join(' ');
}

/** The raw list of a stored value: an array, a JSON list, or `a|b|c` text. */
function rawList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const t = value.trim();
    if (t.startsWith('[')) {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) return j;
      } catch { /* fall through: read it as text */ }
    }
    return t.split(/[|\n]/);
  }
  return null;
}

/**
 * The phrasings of an entry as the index sees them: stop words stripped,
 * empty ones dropped. Empty when the entry has no such field.
 */
export function phrases(entry) {
  const list = rawList(entry?.[FIELD]);
  if (!list) return [];
  return list.filter((x) => typeof x === 'string').map(stripStops).filter(Boolean);
}

const flat = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Check the field at WRITE time. Never throws: an entry goes through with
 * fewer phrasings (or none) rather than losing its content. What is
 * dropped is returned in `dropped` and reported to the writer.
 *
 * Dropped: a non-text item, a question (contains `?`), a phrasing longer
 * than 60 characters or 8 words, a phrasing of 4 or more words that
 * stands verbatim in the entry's own text (`ownText`), a duplicate, and
 * everything from the 13th phrasing on.
 *
 * @param value   array, `a|b|c` text or JSON list
 * @param ownText the text of the entry's other content fields
 * @returns {{list: string[], dropped: {phrase: string, reason: string}[]}}
 */
export function check(value, ownText = '') {
  const raw = rawList(value);
  const dropped = [];
  if (!raw) {
    dropped.push({ phrase: String(value), reason: 'neither a list nor text' });
    return { list: [], dropped };
  }
  const own = flat(ownText);
  const seen = new Set();
  const list = [];
  for (const x of raw) {
    if (typeof x !== 'string') {
      dropped.push({ phrase: String(x), reason: 'not text' });
      continue;
    }
    const p = x.replace(/\s+/g, ' ').trim();
    if (!p) continue;
    const words = p.split(' ').length;
    let reason = null;
    if (p.includes('?')) reason = 'question form (contains ?)';
    else if (p.length > MAX_CHARS || words > MAX_WORDS) reason = `too long (at most ${MAX_CHARS} characters, ${MAX_WORDS} words)`;
    else if (words >= COPY_FROM_WORDS && own.includes(flat(p))) reason = 'copied verbatim from the entry';
    else if (seen.has(flat(p))) reason = 'duplicate';
    else if (list.length >= MAX_COUNT) reason = `more than ${MAX_COUNT} phrasings`;
    if (reason) { dropped.push({ phrase: p, reason }); continue; }
    seen.add(flat(p));
    list.push(p);
  }
  return { list, dropped };
}

/** The dropped phrasings as one warning line (or null). */
export function droppedLine(dropped) {
  if (!dropped?.length) return null;
  return 'asked_as: dropped: ' + dropped.map((d) => `"${d.phrase}" (${d.reason})`).join('; ');
}

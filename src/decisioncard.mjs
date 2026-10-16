// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * decisioncard — H11 (owner request 2026-10-13): everything a person is meant to decide or release must be readable by a
 * person. A card has five parts:
 *
 *   question   ONE sentence, the decision question ("Should a guard be built for race at src/x.mjs?")
 *   context    one or two sentences: what is it about, why now
 *   options    at least two, each with its EFFECT; among them ALWAYS a No / not-now option
 *   advice     optional, always with its author ("advice from <agent>"); never preselected
 *   evidence   ids, paths, URLs (the display makes them small)
 *
 * plus the origin `{ stage, author, rank, ts }`: WHO wrote the card, with which tier, when — and which of the three stages:
 *
 *   written    the fields `card_question`, `card_context`, `card_options`, `card_advice`, `card_evidence` (and `card_kind`)
 *              stand on the entry itself; author, tier and date are the entry's
 *   addendum   a card from the card shelf `cards.jsonl` (src/cardstore.mjs), pointing with `target_id` at an entry that
 *              was never touched; ONE card per target counts (tier first, then the youngest). It comes in through
 *              `context.cards` (Map target_id -> card); this file reads no disk
 *   fallback   made deterministically from the type, the title and the first sentence. No model. A fallback card ALWAYS has a
 *              No / not-now option, NEVER an advice (nobody gave it), and its origin is empty (author / rank / ts null): it
 *              was written by nobody and the display says so
 *
 * **Pure.** No I/O, no model, no clock.
 *
 * **Output guard.** Every text runs through `maskText` like the headline, FIRST masked and THEN cut (a key cut in the middle
 * would escape the pattern). A locked entry stays "[locked]": the card is never derived from decrypted text.
 *
 * **Three states.** An entry that cannot be read (not an object, `__broken`) is a card "unknown", never an empty one.
 *
 * Kinds: `decide` (the human chooses between ways), `approve` (the human releases what another prepared: project, letter,
 * word pair), `do-it` (a task, not a decision; agent work).
 *
 */

// invariant: eine-regel-eine-stelle
// invariant: nicht-messbar-ist-nicht-null

import * as authority from './authority.mjs';
import { maskText, costCut } from './outputguard.mjs';
import * as rules from './cardrules.mjs';

const { LIMITS: L, clean, shorten, sentencesOf, isDecline, splitOption, listOf } = rules;

/** The fields on an entry that carry a written card (flat: texts and lists of texts). */
export const CARD_FIELDS = Object.freeze({
  question: 'card_question',
  context: 'card_context',
  options: 'card_options',
  advice: 'card_advice',
  evidence: 'card_evidence',
  kind: 'card_kind',
});

export const KINDS = rules.KINDS;
export const LIMITS = L;
/** At most this many cards per list of the dashboard data; the rest is counted (`cards_omitted`). */
export const CARD_LIST_MAX = 200;

/** The marker of a locked entry: it is no question and stays as it is. */
const LOCKED_MARK = '[locked]';

const isObject = (e) => e !== null && typeof e === 'object' && !Array.isArray(e) && !e.__broken;
const isLocked = (e) => isObject(e) && Boolean(e.body_enc);

/**
 * Mask, THEN cut, and mask what is left once more (the cut can never leave half a key: nothing was left to cut). Idempotent:
 * what already reads `[REDACTED:...]` is not found again.
 */
function text(v, max) {
  const t = maskText(clean(v));
  return max ? maskText(shorten(t, max)) : t;
}

/** Strings longer than this are clipped before masking: no card text is read past `rules.MAX_IN`, and the mask costs by length. */
const MASK_CLIP = 2 * rules.MAX_IN;
/**
 * A copy of an entry with EVERY string in it masked (to a depth of 6; deeper is dropped). The fallback card cuts and splits
 * the entry's texts into sentences, a title and a question: a key must be gone BEFORE any of that, or a key straddling a cut
 * (a PEM block longer than the limit) survives as clear text. Masking each finished field afterwards is the second layer.
 */
function maskedCopy(v, depth = 0) {
  // the cost bound (MASK_CLIP) drops the run the edge broke (outputguard.costCut); what is kept is masked next
  if (typeof v === 'string') return maskText(costCut(v, MASK_CLIP));
  if (v === null || typeof v !== 'object' || depth >= 6) return depth >= 6 && typeof v === 'object' ? null : v;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => maskedCopy(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = maskedCopy(x, depth + 1);
  return out;
}

/** One option from "choice — effect" (or an object `{choice, effect}`). */
function option(raw) {
  let choice; let effect;
  if (raw && typeof raw === 'object') { choice = clean(raw.choice); effect = clean(raw.effect); } else {
    const o = splitOption(clean(raw));
    ({ choice, effect } = o);
  }
  choice = text(choice, L.choice);
  if (!choice) return null;
  const f = text(effect, L.effect);
  return { choice, effect: f || null, decline: isDecline(choice) };
}

const opt = (choice, effect, decline = false) => ({ choice, effect, decline });
const NOT_NOW = () => opt('Not now', 'Nothing changes. The matter stays open and comes back.', true);

// --- is it a decision (and not a task) -----------------------------------------------------

/** Tags that mark a duty as "waits for a decision / release". */
const DECISION_TAGS = Object.freeze(['approval', 'decision', 'decision-form', 'open-question']);
/** Stems in the title (word start). */
const DECISION_WORD = /\b(decid\w*|decision\w*|approv\w*|sign-?off)/i;

/**
 * Is a duty a decision (and not a task)? Deterministic and named: a tag from DECISION_TAGS OR a stem in the title. An aid for
 * the display, not a verdict.
 */
function isDecisionDuty(p) {
  const tags = Array.isArray(p?.tags) ? p.tags.map((t) => String(t).toLowerCase()) : [];
  if (tags.some((t) => DECISION_TAGS.includes(t))) return true;
  return DECISION_WORD.test(clean(p?.title ?? p?.duty ?? p?.text).slice(0, 400));
}

// --- the identifier --------------------------------------------------------------------------------

/**
 * What the target of a card is called (`target_id` on the shelf): the id of the entry; a project `project:<name>`; a letter
 * `letter:<id>`; a word pair `word-pair:<a>|<b>`. Without a handle `null` — no key is invented.
 */
export function identifierOf(e, type = null, { shown = false } = {}) {
  if (!isObject(e)) return null;
  // `shown`: for display each PART is cleaned and masked on its own, then joined (a mask over the joined text can stop at the
  // join and leave the second part in the clear). Without it: the key as written, for the lookup in the shelf.
  const s = (v) => {
    if (typeof v !== 'string' || !v.trim()) return null;
    return shown ? (text(v) || null) : v.trim();
  };
  if (type === 'project') return s(e.name) ? `project:${s(e.name)}` : null;
  if (type === 'letter') return s(e.id) ? `letter:${s(e.id)}` : null;
  if (type === 'word-pair') return s(e.a) && s(e.b) ? `word-pair:${s(e.a)}|${s(e.b)}` : null;
  return s(e.id);
}

// --- fallback cards -----------------------------------------------------------------------------

const GUARD_TITLE = /^Guard for (.+?) at (.+)$/;
/** `mem guard run --duty` (src/cli/commands/setup.mjs): "Latch red: <class>" / "Latch broken: <class>"; the text names the entry. */
const LATCH_TITLE = /^Latch (red|broken): (.+)$/;
const BELONGS_TO = /Belongs to entry ([A-Za-z0-9_-]{1,64})\./;
const REPORT_PREFIX = /^Open from agent report [^:]+:\s*/;
const REPORT_REVIEW = /^Review report (\S+)(?::\s*(\d+) open)?/;
const DUTY_TITLE_FIELDS = Object.freeze(['title', 'duty', 'text']);

/** The title of a duty or '' — the fallback text of a missing title is NOT a title. */
function titleOf(p) {
  for (const f of DUTY_TITLE_FIELDS) {
    const w = clean(p?.[f]);
    if (w) return f === 'text' ? (sentencesOf(w, 1)[0] ?? w) : w;
  }
  return '';
}

/** Without the ellipsis at the end (`...` or the sign), LINEAR: an end-anchored pattern would be quadratic here. */
function withoutEllipsis(t) {
  let end = t.length;
  for (;;) {
    if (t[end - 1] === '…') end -= 1;
    else if (end >= 3 && t.startsWith('...', end - 3)) end -= 3;
    else break;
  }
  // mask-ok: callers hand in clean() output, which is masked
  return t.slice(0, end);
}
// Question marks of other scripts count as the end mark too (full-width, Arabic, interrobang and the double forms): the card
// ends in exactly one ASCII "?".
const END_MARKS = new Set(['.', '!', '?', ':', ';', ',', ' ', '？', '؟', '‽', '！', '⁇', '⁈', '⁉', '՞', '﹖']);
function withoutEnd(t) {
  const a = withoutEllipsis(clean(t));
  let end = a.length;
  while (end > 0 && END_MARKS.has(a[end - 1])) end -= 1;
  return a.slice(0, end).trim();
}

const norm = (t) => withoutEllipsis(clean(t).toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
/** Does the sentence repeat the title? */
function repeats(sentence, title) {
  const a = norm(sentence); const b = norm(title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * The text without the appended source line (`Source: ...`). LINEAR: a pattern like /\n\s*\n\s*Source:/ is cubic (8,000 line
 * breaks took minutes in the sibling house). "Source:" is searched, then the whitespace before it is counted backwards; the
 * runs are disjoint.
 */
function textWithoutSource(t) {
  // a cost bound that drops the run the edge broke; clean() masks and bounds again at MAX_IN
  const raw = costCut(String(t ?? ''), 2 * rules.MAX_IN);
  let from = raw.indexOf('Source:');
  while (from !== -1) {
    let start = from; let breaks = 0;
    while (start > 0 && /\s/.test(raw[start - 1])) { start -= 1; if (raw[start] === '\n') breaks += 1; }
    // mask-ok: cut at the blank space before `Source:`, never inside a key; clean() masks
    if (breaks >= 2) return clean(raw.slice(0, start));
    from = raw.indexOf('Source:', from + 1);
  }
  return clean(raw);
}

/** Up to two sentences from `sources` (in order) that do not repeat the title. */
function contextFromTexts(sources, title) {
  for (const q of sources) {
    const s = sentencesOf(q, 4).filter((x) => !repeats(x, title));
    if (s.length) return s.slice(0, 2).join(' ');
  }
  return '';
}

function evidenceList(...parts) {
  const out = [];
  for (const t of parts.flat()) {
    const s = text(t, L.evidence);
    if (s && !out.includes(s)) out.push(s);
  }
  // mask-ok: a list of evidence lines
  return out.slice(0, L.evidenceMax);
}

function fallbackDuty(p) {
  const id = clean(p.id) || '<id>';
  const title = titleOf(p);
  const tags = Array.isArray(p.tags) ? p.tags.map((t) => String(t).toLowerCase()) : [];

  // Guard duty (errorcontext.mjs): class and file stand as fields, otherwise in the title.
  const gm = GUARD_TITLE.exec(title);
  if (gm || ((p.automatic === true || tags.includes('auto-duty')) && clean(p.class) && clean(p.file))) {
    const className = clean(p.class) || (gm ? gm[1] : '');
    const file = clean(p.file) || (gm ? gm[2] : '');
    if (className && file) {
      const ids = (Array.isArray(p.error_ids) ? p.error_ids : []).map(clean).filter(Boolean);
      return {
        kind: 'do-it',
        question: `${shorten(`Should a guard be built for ${className} at ${file}`, L.question - 1)}?`,
        context: `The error class “${className}” has recurred at ${file}${ids.length ? ` (errors ${ids.slice(0, 3).join(', ')})` : ''}. A guard checks that it does not come back.`,
        options: [
          opt('Build the guard', 'An agent builds the check; the duty closes only with evidence (a guard on the error or a test under test/).'),
          opt('Discard', `The duty is closed with a reason (mem discard ${id}); no guard is built.`, true),
          NOT_NOW(),
        ],
        evidence: evidenceList(id, file, ids),
      };
    }
  }

  // Duty from `mem guard run --duty` (setup.mjs): a latch that went red (the error is back) or broken (it checks nothing). The
  // addressee comes from the command, not from a decision; the card says what is to be done.
  const lm = LATCH_TITLE.exec(title);
  if (lm) {
    const red = lm[1] === 'red';
    const className = lm[2];
    const entryId = BELONGS_TO.exec(clean(p.text))?.[1] ?? '';
    const why = sentencesOf(clean(p.text).replace(BELONGS_TO, ''), 2).join(' ');
    return {
      kind: 'do-it',
      question: red
        ? `${shorten(`Should the error “${className}” be fixed that a red latch shows`, L.question - 1)}?`
        : `${shorten(`Should the broken latch for “${className}” be repaired`, L.question - 1)}?`,
      context: why || (red ? 'A latch that was made for a logged error trips again: the error is back.' : 'A latch for a logged error checks nothing any more.'),
      options: [
        opt(red ? 'Fix the error' : 'Repair the latch', red
          ? 'An agent removes the cause; the latch turns green again.'
          : 'An agent corrects the path or the pattern of the latch so that it checks again.'),
        opt('Discard', `The duty is closed with a reason (mem discard ${id}); nothing changes about the latch.`, true),
        NOT_NOW(),
      ],
      evidence: evidenceList(id, entryId),
    };
  }

  // Report duty (an agent report booked as a duty): the sentence of the report is the context, the question is always the same.
  const rm = REPORT_REVIEW.exec(title);
  const report = clean(p.report) || (rm ? rm[1] : '');
  if (rm || clean(p.report_key) || REPORT_PREFIX.test(title) || tags.includes('agent-report')) {
    const sentence = textWithoutSource(p.text).replace(REPORT_PREFIX, '') || title.replace(REPORT_PREFIX, '');
    const sentences = sentencesOf(sentence, 2).join(' ');
    const context = [sentences, report && !rm ? `(from ${report})` : ''].filter(Boolean).join(' ');
    return {
      kind: 'do-it',
      question: rm
        ? `${shorten(rm[2] ? `Are the ${rm[2]} open points from report ${rm[1]} still valid` : `Are the open points from report ${rm[1]} still valid`, L.question - 1)}?`
        : 'Is this open point still valid?',
      context,
      options: [
        opt('Still valid', 'The point stays open and gets worked off.'),
        opt('Report done', `The duty is closed with evidence (mem done ${id}).`),
        opt('Discard', `The duty is closed with a reason (mem discard ${id}); the point counts as no longer needed.`, true),
      ],
      evidence: evidenceList(id, report ? `reports/${report}.md` : ''),
    };
  }

  // Everything else: the first sentence of the title (or of the text) as a task; a question in the title stays the question.
  const rawSentence = title || sentencesOf(textWithoutSource(p.text), 1)[0] || '';
  let question;
  if (/[?？؟‽]\s*$/.test(rawSentence)) question = shorten(clean(rawSentence), L.question);
  else {
    const sentence = withoutEnd(rawSentence);
    question = sentence
      ? `${shorten(`Do or decide: ${sentence}`, L.question - 1)}?`
      : 'Open duty without a description: what is to be done?';
  }
  return {
    kind: isDecisionDuty(p) ? 'decide' : 'do-it',
    question,
    context: contextFromTexts([textWithoutSource(p.text), clean(p.why)], title),
    options: [
      opt('Report done', `The duty is closed with evidence (mem done ${id}); it leaves the list.`),
      opt('Discard', `The duty is closed with a reason (mem discard ${id}); nothing is done.`, true),
      NOT_NOW(),
    ],
    evidence: evidenceList(id, p.file),
  };
}

function fallbackQuestion(f) {
  const id = clean(f.id) || '<id>';
  const q = clean(f.question) || clean(f.title) || clean(f.text);
  const title = clean(f.title);
  const parts = [];
  if (title && norm(title) !== norm(q)) parts.push(`Topic: ${withoutEnd(title)}.`);
  const why = sentencesOf(clean(f.why), 2).join(' ');
  if (why) parts.push(why);
  else if (!title || norm(title) === norm(q)) {
    const t = contextFromTexts([textWithoutSource(f.text)], q);
    if (t) parts.push(t);
  }
  return {
    kind: 'decide',
    question: q ? shorten(q, L.question) : 'Open question without text: what is to be clarified?',
    context: parts.join(' '),
    options: [
      opt('Answer', `An entry with the answer is linked to the question (mem answer ${id} --with <entry-id>); the question then counts as answered.`),
      opt('Discard', `The question is closed without an answer (mem discard ${id}).`, true),
      NOT_NOW(),
    ],
    evidence: evidenceList(id),
  };
}

function fallbackProject(p) {
  const name = clean(p.name) || '<name>';
  const parts = [];
  if (clean(p.title)) parts.push(`${withoutEnd(p.title)}.`);
  if (clean(p.reason)) parts.push(`Reason: ${withoutEnd(p.reason)}.`);
  if (p.kind === 'hand') parts.push('Made by hand, past the command (mem project new was not used).');
  else if (p.kind === 'new') parts.push(`Newly made${clean(p.createdOn) ? ` on ${clean(p.createdOn)}` : ''}${clean(p.createdBy) ? ` by ${clean(p.createdBy)}` : ''}; waits for your confirmation.`);
  return {
    kind: 'approve',
    question: `${shorten(`Take over project ${name}`, L.question - 1)}?`,
    context: parts.join(' '),
    options: [
      opt('Take over', `The project counts as confirmed (mem project confirm ${name}) and leaves the waiting list.`),
      opt('Do not take over', 'The project stays unconfirmed and is shown as waiting; nothing is deleted.', true),
      NOT_NOW(),
    ],
    evidence: evidenceList(`projects/${name}/`),
  };
}

function fallbackLetter(b) {
  const subject = withoutEnd(b.title ?? b.subject) || '(no subject)';
  const from = clean(b.from);
  return {
    kind: 'approve',
    question: `${shorten(`Approve the letter${from ? ` from ${from}` : ''}: “${subject}”`, L.question - 1)}?`,
    context: 'The letter asks for a release before it goes on.',
    options: [
      opt('Approve', 'You approve the letter (reply in the letter); the sender can go on.'),
      opt('Decline', 'You decline; the matter does not go on.', true),
      NOT_NOW(),
    ],
    evidence: evidenceList(b.id),
  };
}

function fallbackReview(v, context) {
  const ids = (Array.isArray(v.ids) ? v.ids : []).map(clean).filter(Boolean);
  const titleOfId = (id) => {
    const t = context?.titles;
    const r = t instanceof Map ? t.get(id) : (typeof t === 'function' ? t(id) : null);
    return maskText(clean(r));
  };
  const command = clean(v.command);
  const merge = v.kind === 'merge';
  const titles = merge ? ids.map(titleOfId).filter(Boolean) : [];
  let question;
  if (merge) {
    question = titles.length >= 2
      ? `Do “${withoutEnd(shorten(titles[0], 50))}” and “${withoutEnd(shorten(titles[1], 50))}” belong together?`
      : 'Do these entries belong together?';
  } else question = `${shorten(`Carry out the review suggestion “${clean(v.kind) || 'unknown'}”`, L.question - 1)}?`;
  return {
    kind: 'approve',
    question,
    context: clean(v.evidence),
    options: merge ? [
      opt('Merge', `The entries are merged${command ? ` (${command})` : ''}.`),
      opt('Keep apart', 'Both entries stay as they are.', true),
      NOT_NOW(),
    ] : [
      opt('Carry out', command ? `The suggestion is carried out (${command}).` : 'The suggestion is carried out.'),
      opt('Do not carry out', 'Everything stays as it is.', true),
      NOT_NOW(),
    ],
    evidence: evidenceList(ids),
  };
}

function fallbackWordPair(w) {
  const a = clean(w.a) || '?'; const b = clean(w.b) || '?';
  const how = [];
  if (Number.isFinite(w.count) && Number.isFinite(w.sessions)) how.push(`The words came up ${w.count} times in ${w.sessions} sessions as a rephrasing.`);
  const command = clean(w.command);
  return {
    kind: 'approve',
    question: `${shorten(`Should “${a}” and “${b}” count as the same in search`, L.question - 1)}?`,
    context: how.join(' '),
    options: [
      opt('Link them', `Search links the two words from now on${command ? ` (${command})` : ''}.`),
      opt('Do not link', 'Search stays as it is; the suggestion stays on the list for now.', true),
    ],
    evidence: [],
  };
}

function fallbackGeneral(e) {
  const rawSentence = clean(e.title) || clean(e.question) || sentencesOf(textWithoutSource(e.text), 1)[0] || '';
  const sentence = withoutEnd(rawSentence);
  const id = clean(e.id) || '<id>';
  return {
    kind: 'do-it',
    question: sentence ? `${shorten(`Do or decide: ${sentence}`, L.question - 1)}?` : 'Open entry without a description: what is to be done?',
    context: contextFromTexts([textWithoutSource(e.text), clean(e.why)], rawSentence),
    options: [opt('Report done', `The entry is closed with evidence (mem done ${id}).`), NOT_NOW()],
    evidence: evidenceList(e.id),
  };
}

function fallbackOf(entry, type, context) {
  const e = isObject(entry) ? maskedCopy(entry) : entry;
  if (!isObject(e)) {
    return {
      kind: 'do-it', question: 'Entry not readable, content unknown: what is to be done?',
      context: 'The entry cannot be read; it is not known what is to be decided here.',
      options: [opt('Check the entry', 'A person or an agent looks into the file to see what stands there.'), NOT_NOW()], evidence: [],
    };
  }
  if (isLocked(e)) {
    return {
      kind: 'do-it', question: LOCKED_MARK, context: 'The entry is encrypted; only after opening it can one say what is to be decided here.',
      options: [opt('Open the entry', 'Readable only with the key.'), NOT_NOW()], evidence: evidenceList(e.id),
    };
  }
  switch (type) {
    case 'duty': return fallbackDuty(e);
    case 'question': return fallbackQuestion(e);
    case 'project': return fallbackProject(e);
    case 'letter': return fallbackLetter(e);
    case 'review': return fallbackReview(e, context);
    case 'word-pair': return fallbackWordPair(e);
    default: return fallbackGeneral(e);
  }
}

// --- the card -----------------------------------------------------------------------------------

/** The parts of a written card (entry or addendum), cleaned; missing parts are null / empty. */
function partsOf({ question, context, options, advice, evidence, kind }) {
  const o = listOf(options).map(option).filter(Boolean).slice(0, L.optionsMax);
  const k = clean(kind).toLowerCase();
  return {
    question: text(question, L.question) || null,
    context: text(context, L.context) || null,
    options: o,
    advice: text(advice, L.advice) || null,
    evidence: evidenceList(listOf(evidence)),
    kind: KINDS.includes(k) ? k : null,
  };
}

function fallbackCleaned(f) {
  return {
    kind: f.kind,
    question: text(f.question, L.question),
    context: text(f.context, L.context) || null,
    options: f.options.map((x) => ({ choice: text(x.choice, L.choice), effect: text(x.effect, L.effect) || null, decline: Boolean(x.decline) })),
    advice: null,
    evidence: evidenceList(f.evidence),
  };
}

/** The tier of a card row as a known tier name ('unknown' for a missing or foreign one). */
const tierName = (t) => {
  const s = String(t ?? '').toLowerCase().trim();
  return authority.TIERS.includes(s) ? s : authority.DEFAULT_TIER;
};

/**
 * Does card `a` count before card `b`? The higher tier first (`authority.rank`: smaller = more entitled; an unknown or missing
 * tier stands last), at equal tier the youngest; an unreadable ts is older than any readable one; on a tie `a` counts. The card
 * shelf (`cardstore.readCards`) folds with this one rule too.
 */
export function precedes(a, b) {
  const ra = authority.rank(tierName(a?.rank)); const rb = authority.rank(tierName(b?.rank));
  if (ra !== rb) return ra < rb;
  const ta = Date.parse(a?.ts ?? ''); const tb = Date.parse(b?.ts ?? '');
  const va = Number.isFinite(ta) ? ta : -Infinity; const vb = Number.isFinite(tb) ? tb : -Infinity;
  return va >= vb;
}

/** Of a displaced card `{author, rank, ts}` (or null). */
export function summary(h) {
  if (!h || typeof h !== 'object') return null;
  return { author: text(h.author) || null, rank: h.rank ? text(h.rank) : null, ts: text(h.ts) || null };
}

/**
 * Of two summaries of displaced cards the HIGHEST-TIER one (at equal tier the younger): `replaced` names the most important
 * card that lost, not the one read last. A missing one gives the other.
 */
export function highest(a, b) {
  if (!a || !b) return a ?? b ?? null;
  return precedes(a, b) ? a : b;
}

/** A question ends in EXACTLY one "?" and is at most `L.question` long; marks and ellipses at the end drop, cut BEFORE the "?". */
function asQuestion(t) {
  const s = withoutEnd(shorten(withoutEnd(t), L.question - 1));
  return s ? `${s}?` : '';
}

/**
 * Is the explanation missing from this card? (H11, stage 1 of the write rule.) Yes when nobody wrote the card (stage `fallback`),
 * when there is no readable card at all (not measurable is no explanation), and when a written card (entry or addendum) had its
 * OPTIONS or its No option filled in from the fallback card (`supplemented`): a question without ways and effects explains
 * nothing. A missing CONTEXT does not count: the decision then still stands there with its ways and effects.
 *
 * THE one derivation of "explanation missing": the write rule (`cardrule`) marks with it, `mem today` names it, and the doctor
 * finding `decision-without-explanation` counts with it. There is no field on the entry for it (a second field would be a second
 * truth next to the stage of the card).
 */
export function lacksExplanation(c) {
  if (!(c && c.origin && (c.origin.stage === 'written' || c.origin.stage === 'addendum'))) return true;
  return Array.isArray(c.supplemented) && (c.supplemented.includes('options') || c.supplemented.includes('decline-option'));
}

/**
 * Who wrote a card, for the display: NAME and RANK, not one of them (Lucky decision 2026-10-14, port of lucky-mem
 * `entscheidungskarte.verfasserVon`). `{ name, rank, rank_state, text, by_human }`:
 *
 *   name         the author, cleaned and masked (the field is set by whoever writes); null when none is recorded
 *   rank         the tier the LINE carries (`user`, `system`, `agent`, ...); null when it carries none - never `unknown` made up
 *   rank_state   `set` | `missing` | `empty` | `broken` (the field absent / blank / no tier), null on a replacement card
 *   text         "name (rank)", e.g. "builder-x (agent)"; what is not recorded reads "unknown" / "rank unknown"
 *   by_human     the rank is `user`. ONLY then the display drops "written by an agent, not checked by you". The name alone does NOT
 *                count: a CLI write stamps `human:<os user>` on every line written at that account - an agent in a cloud session
 *                included - and tier `agent`, so a name rule would show an agent's card as a person's. The write path gives `user`
 *                only on an explicit `--authority user` behind `authority.checkUserWrite`, never through a bridge.
 *
 * A replacement card has no author: everything null, `by_human` false (the display says "replacement card", never a name).
 */
function bylineOf(stage, from, rankState) {
  if (stage === 'fallback' || !from) return { name: null, rank: null, rank_state: null, text: null, by_human: false };
  const name = from.author || null;
  const set = rankState === 'set' && authority.TIERS.includes(from.rank);
  const rank = set ? from.rank : null;
  return {
    name, rank, rank_state: rankState ?? 'missing',
    text: `${name ?? 'unknown'} (${rank ?? 'rank unknown'})`,
    by_human: Boolean(name) && rank === 'user',
  };
}

/**
 * The card for an entry. Order of the stages: addendum (the better card from the shelf), then the fields on the entry, then the
 * fallback.
 *
 * @param entry         the line (duty, question) or a Today item (project `{name, kind, ...}`, letter `{id, title, from}`,
 *                      review suggestion `{kind, ids, evidence, command}`, word pair `{a, b, count, sessions, command}`)
 * @param opts.type     `duty` | `question` | `project` | `letter` | `review` | `word-pair`; otherwise a general card
 * @param opts.context.cards   Map target_id -> card (from the shelf)
 * @param opts.context.titles  Map or function id -> headline (only for review questions with titles)
 * @param opts.context.human   no longer read: a name never makes a card a person's, the rank does (`byline.by_human`); callers may still pass it
 * @returns {{kind, question, context, options, advice, evidence, origin, byline, replaced, identifier, supplemented}}
 *   `byline` is `{name, rank, rank_state, text, by_human}` (see `bylineOf`): author name AND rank, for the display.
 *   `replaced` is `{author, rank, ts}` of the card this one beat (tier, then age), else null. `advice` is `{text, author}` (its rank is the card's: `byline`) or
 *   null; `supplemented` names what was filled from the fallback card.
 */
export function cardOf(entry, { type = null, context = {} } = {}) {
  const c = cardWithoutNorm(entry, { type, context });
  // Every question ends in exactly one "?"; the mark of a locked entry is no question.
  return c.question === LOCKED_MARK ? c : { ...c, question: asQuestion(c.question) || 'What is to be done here?' };
}

function cardWithoutNorm(entry, { type = null, context = {} } = {}) {
  const identifier = identifierOf(entry, type);
  // The lookup in the shelf uses the identifier as written; what the card SHOWS is cleaned and masked like every other text.
  const shownId = identifier === null ? null : identifierOf(entry, type, { shown: true });
  const readable = isObject(entry);
  const locked = readable && isLocked(entry);

  let stage = 'fallback';
  let parts = null;
  let from = { author: null, rank: null, ts: null };
  let fromState = null;
  let replaced = null;

  if (readable && !locked) {
    const addendum = identifier && context?.cards instanceof Map ? context.cards.get(identifier) : null;
    const addendumHere = isObject(addendum) && clean(addendum.question);
    const inlineHere = Boolean(clean(entry[CARD_FIELDS.question]));
    const addendumFrom = addendumHere ? { author: text(addendum.author) || null, rank: tierName(addendum.rank), ts: text(addendum.ts) || null } : null;
    const inlineFrom = inlineHere ? { author: text(authority.authorOf(entry)) || null, rank: authority.tierOf(entry), ts: text(entry.ts) || null } : null;
    // The rank in three states (set / missing / empty / broken), kept apart from `rank` (which says `unknown` for all of them): the
    // display names an author together with the rank the LINE carries and invents none (`byline`).
    const addendumState = addendumHere ? (typeof addendum.rank_state === 'string' ? addendum.rank_state : authority.tierState({ authority: addendum.rank }).state) : null;
    const inlineState = inlineHere ? authority.tierState(entry).state : null;
    // Two cards for one target: the HIGHER tier counts (authority order), at equal tier the youngest, at equal ts the addendum.
    // The card that loses stands as `replaced`: an agent's addendum never silently displaces the card the owner wrote himself.
    const takeAddendum = addendumHere && (!inlineHere || precedes(addendumFrom, inlineFrom));
    if (takeAddendum) {
      stage = 'addendum';
      parts = partsOf(addendum);
      from = addendumFrom;
      fromState = addendumState;
      replaced = highest(inlineHere ? summary(inlineFrom) : null, summary(addendum.replaced));
    } else if (inlineHere) {
      stage = 'written';
      parts = partsOf({
        question: entry[CARD_FIELDS.question], context: entry[CARD_FIELDS.context], options: entry[CARD_FIELDS.options],
        advice: entry[CARD_FIELDS.advice], evidence: entry[CARD_FIELDS.evidence], kind: entry[CARD_FIELDS.kind],
      });
      from = inlineFrom;
      fromState = inlineState;
      replaced = addendumHere ? summary(addendumFrom) : null;
    }
  }

  const fb = fallbackCleaned(fallbackOf(entry, type, context));
  if (!parts) {
    return { kind: fb.kind, question: fb.question, context: fb.context, options: fb.options, advice: null, evidence: fb.evidence,
      origin: { stage: 'fallback', author: null, rank: null, ts: null }, byline: bylineOf('fallback', from, null), replaced: null,
      identifier: shownId, supplemented: [] };
  }

  // A card with gaps is filled from the fallback card, visibly (`supplemented`). The ADVICE never.
  const supplemented = [];
  const k = { ...parts };
  if (!k.context && fb.context) { k.context = fb.context; supplemented.push('context'); }
  if (!k.evidence.length && fb.evidence.length) { k.evidence = fb.evidence; supplemented.push('evidence'); }
  if (!k.kind) { k.kind = fb.kind; supplemented.push('kind'); }
  if (!k.options.length) { k.options = fb.options; supplemented.push('options'); }
  else if (!k.options.some((x) => x.decline)) {
    k.options = [...k.options, { ...NOT_NOW(), supplemented: true }];
    supplemented.push('decline-option');
  }
  if (k.options.length < 2) {
    const add = fb.options.find((x) => !x.decline && !k.options.some((y) => y.choice === x.choice));
    if (add) { k.options = [{ ...add, supplemented: true }, ...k.options]; supplemented.push('options'); }
  }
  // The author with name AND rank (Lucky decision 2026-10-14, port of lucky-mem `verfasserVon`): `byline`. `origin.by_human` is the
  // flag of the SAME derivation, so there is one truth: see `bylineOf` for why the name alone never makes a card a person's.
  const byline = bylineOf(stage, from, fromState);
  return {
    kind: k.kind, question: k.question, context: k.context, options: k.options,
    advice: k.advice ? { text: k.advice, author: from.author } : null,
    evidence: k.evidence, origin: { stage, ...from, by_human: byline.by_human }, byline, replaced, identifier: shownId, supplemented,
  };
}

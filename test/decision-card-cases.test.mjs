// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/decision-card-cases.test.mjs — H11: the shared decision-card cases, run against THIS house's card.
//
// **Decision** (2026-09-28, "common core: option 2"): the two houses share the SPECIFICATION and the test cases, not the
// code. `shared/entscheidungskarten.jsonl` is the same file as lucky-mem's `geteilt/entscheidungskarten.jsonl`
// (BYTE-identical, not reformatted); both houses pin the same sha256 below. Each house keeps its own runner, in its own
// language, against its own code: this one is cheap-mem's.
//
// The field names in the cases are English (`title`, `question`, `card_options`, ...); this runner maps them to the fields of
// this house (`rank` -> `authority`, `guard_title` -> "Guard for <class> at <file>", ...). The expectations never name a
// sentence of a language: only stage, kind, identifiers from the input (class, path, name), "ends in ?", "has a No option",
// "no advice". What a house words for its fallback card stays with it.
//
// What the cases hold: the three stages (written, addendum, fallback); a fallback card ALWAYS has a No / not-now option and
// NEVER an advice; keys are masked; a locked entry stays locked; an unreadable entry is "unknown", not empty; the higher tier
// wins over the younger card.
//
// Red proof: before the build there was no src/decisioncard.mjs (the import fails); the positive controls below show that
// the runner sees a broken card (without a No option, with an invented advice, with a passed-through key).
//
// invariant: nicht-messbar-ist-nicht-null
// invariant: kein-rueckfall-auf-erfundene-daten
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as card from '../src/decisioncard.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CASES_FILE = path.join(REPO, 'shared', 'entscheidungskarten.jsonl');

/** The pin: the same hash stands in lucky-mem's test of the cases. */
const CASES_SHA256 = '37da67a8eaf3790ea72a629760437f27f60b2604fe57d80cc0633ef99dde1ec3';
const TOPICS = ['stages', 'fallback', 'protection', 'unknown', 'rank'];
/** The neutral topic of a case -> the id of the shared invariant it serves (this house's register), where there is one. */
const INVARIANT_OF = { unknown: 'nicht-messbar-ist-nicht-null', protection: 'kein-rueckfall-auf-erfundene-daten' };
/** The tiers in the neutral language of the cases -> this house's (authority.mjs). */
const RANK = { user: 'user', system: 'system', agent: 'agent', external: 'external', derived: 'inferred', unknown: 'unknown' };

const cases = fs.readFileSync(CASES_FILE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// --- this house's words for the neutral vocabulary ---------------------------------------------
const TYPE = { duty: 'duty', question: 'question', project: 'project', letter: 'letter', review: 'review', 'word-pair': 'word-pair', other: undefined };
const PREFIX = { project: 'project', letter: 'letter', 'word-pair': 'word-pair' };
const FIELD = {
  id: 'id', ts: 'ts', agent: 'agent', title: 'title', text: 'text', why: 'why', who: 'who', class: 'class', file: 'file',
  error_ids: 'error_ids', tags: 'tags', report: 'report', report_key: 'report_key',
  card_question: 'card_question', card_context: 'card_context', card_options: 'card_options', card_advice: 'card_advice',
  card_evidence: 'card_evidence', card_kind: 'card_kind',
};
const LOCKED = '[locked]';
const SECRET = `sk-${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`;
/** This house's word for "No" — the placeholder `{NO}` in the options of the cases (each house recognises its own decline option). */
const NO_WORD = 'No';

/** `{SECRET}` becomes a key shape (the file never carries a real key), `{NO}` this house's No word. */
function withSecret(value) {
  if (typeof value === 'string') return value.replaceAll('{SECRET}', SECRET).replaceAll('{NO}', NO_WORD);
  if (Array.isArray(value)) return value.map(withSecret);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withSecret(v)]));
  return value;
}

/** The neutral entry as an entry of this house. */
function entryFor(type, neutral) {
  if (neutral.missing) return undefined;
  if (neutral.unreadable) return { __broken: true, raw: '{', reason: 'not JSON' };
  const e = {};
  for (const [k, v] of Object.entries(neutral)) {
    if (k === 'locked') { if (v) e.body_enc = { cipher: 'x' }; continue; }
    // Marks each house writes in ITS form: the auto marks of the guard duty, its title, the source line, the decision tag.
    if (k === 'auto_tag') { if (v) { e.tags = [...(e.tags ?? []), 'auto-duty', 'guard-missing']; e.automatic = true; } continue; }
    if (k === 'decision_tag') { if (v) e.tags = [...(e.tags ?? []), 'decision']; continue; }
    if (k === 'guard_title') { e.title = `Guard for ${v.class} at ${v.file}`; continue; }
    if (k === 'source_note') { e.text = `${e.text ?? neutral.text}\n\nSource: ${v}`; continue; }
    if (type === 'project') {
      const M = { name: 'name', variety: 'kind', created_at: 'createdOn', created_by: 'createdBy', title: 'title', reason: 'reason' };
      if (k === 'variety') e.kind = { new: 'new', 'by-hand': 'hand' }[v]; else e[M[k]] = v;
    } else if (type === 'letter') {
      e[{ id: 'id', subject: 'title', from: 'from' }[k]] = v;
    } else if (type === 'review') {
      e[{ kind: 'kind', ids: 'ids', evidence: 'evidence', command: 'command' }[k]] = v;
    } else if (type === 'word-pair') {
      e[{ a: 'a', b: 'b', count: 'count', sessions: 'sessions', command: 'command' }[k]] = v;
    } else if (k === 'question') e.question = v;
    else if (k === 'rank') e.authority = RANK[v];
    else e[FIELD[k]] = v;
  }
  return e;
}

/** This house's identifier for a neutral target (a text or `{prefix, value}`). */
const identifierFor = (target) => (typeof target === 'string' ? target : `${PREFIX[target.prefix]}:${target.value}`);

function contextFor(ctx) {
  const context = {};
  if (ctx?.cards) {
    context.cards = new Map(ctx.cards.map((k) => [identifierFor(k.target), {
      author: k.author, rank: k.rank ? RANK[k.rank] : undefined, ts: k.ts, question: k.question, context: k.context, options: k.options,
      advice: k.advice, evidence: k.evidence, kind: k.kind,
    }]));
  }
  if (ctx?.titles) context.titles = new Map(Object.entries(ctx.titles));
  return context;
}

/** A case against this house's card: the list of violations (empty = holds). `cardFn` is swappable (positive control). */
function check(f, cardFn = card.cardOf) {
  const raw = withSecret(f);
  const type = TYPE[f.type];
  const e = entryFor(f.type, raw.entry);
  const k = cardFn(e, { type, context: contextFor(raw.context) });
  const x = raw.expect;
  const v = [];
  const is = JSON.stringify(k);
  const decline = (k.options ?? []).some((o) => o.decline);
  for (const [name, want] of Object.entries(x)) {
    const say = (ok, what) => { if (!ok) v.push(`${f.id}: ${name} -- ${what}`); };
    switch (name) {
      case 'stage': say(k.origin?.stage === want, `stage is '${k.origin?.stage}', expected '${want}'`); break;
      case 'kind': say(k.kind === want, `kind is '${k.kind}', expected '${want}'`); break;
      case 'question': say(k.question === want, `question is '${k.question}'`); break;
      case 'question_contains': for (const s of want) say(String(k.question).includes(s), `question '${k.question}' does not name '${s}'`); break;
      case 'question_ends_with': say(String(k.question).endsWith(want), `question '${k.question}' does not end in '${want}'`); break;
      case 'question_differs_from_title': say(k.question !== e?.title, 'the question is the keyword title'); break;
      case 'question_max_chars': say(String(k.question).length <= want, `question is ${String(k.question).length} characters long`); break;
      case 'context_contains': for (const s of want) say(String(k.context ?? '').includes(s), `context '${k.context}' does not name '${s}'`); break;
      case 'context_excludes': for (const s of want) say(!String(k.context ?? '').includes(s), `context '${k.context}' names '${s}'`); break;
      case 'context_null': say(k.context === null, `context is '${k.context}'`); break;
      case 'option_choices': say(JSON.stringify((k.options ?? []).map((o) => o.choice)) === JSON.stringify(want), `choices ${JSON.stringify((k.options ?? []).map((o) => o.choice))}`); break;
      case 'options_count_min': say((k.options ?? []).length >= want, `only ${(k.options ?? []).length} options`); break;
      case 'has_decline': say(decline === want, 'No / not-now option missing'); break;
      case 'every_option_has_effect': say((k.options ?? []).every((o) => o.effect) === want, 'an option names no effect'); break;
      case 'advice':
        say(want === null ? k.advice === null : JSON.stringify(k.advice) === JSON.stringify({ text: want.text, author: want.author }), `advice is ${JSON.stringify(k.advice)}`);
        break;
      case 'author': say(k.origin?.author === want, `author is '${k.origin?.author}'`); break;
      case 'replaced':
        say(JSON.stringify(k.replaced) === JSON.stringify(want === null ? null : { author: want.author, rank: RANK[want.rank], ts: want.ts }), `replaced is ${JSON.stringify(k.replaced)}`);
        break;
      case 'rank': say(k.origin?.rank === (want === null ? null : RANK[want]), `rank is '${k.origin?.rank}'`); break;
      case 'ts': say(k.origin?.ts === want, `ts is '${k.origin?.ts}'`); break;
      case 'evidence': say(JSON.stringify(k.evidence) === JSON.stringify(want), `evidence is ${JSON.stringify(k.evidence)}`); break;
      case 'evidence_contains': for (const s of want) say((k.evidence ?? []).includes(s), `evidence ${JSON.stringify(k.evidence)} does not name '${s}'`); break;
      case 'identifier': say(k.identifier === (want === null ? null : identifierFor(want)), `identifier is '${k.identifier}'`); break;
      case 'supplemented': say(JSON.stringify(k.supplemented) === JSON.stringify(want), `supplemented is ${JSON.stringify(k.supplemented)}`); break;
      case 'supplemented_contains': for (const s of want) say((k.supplemented ?? []).includes(s), `supplemented ${JSON.stringify(k.supplemented)} does not name '${s}'`); break;
      case 'no_leak': for (const s of want) say(!is.includes(String(withSecret(s))), 'a key was passed through'); break;
      case 'no_leak_text': for (const s of want) say(!is.includes(s), `'${s}' stands in the card`); break;
      case 'locked_marker': say((k.question === LOCKED) === want, `question is '${k.question}'`); break;
      case 'unknown_signal': say(/unknown/.test(String(k.question)) === want, `question '${k.question}' does not say "unknown"`); break;
      default: v.push(`${f.id}: unknown expectation '${name}' -- an expectation nobody can check is no pass`);
    }
  }
  return v;
}

// --- the file itself ---------------------------------------------------------------------------------

test('the shared card cases are byte-identical with the sibling house (sha256 pinned)', () => {
  const sha = createHash('sha256').update(fs.readFileSync(CASES_FILE)).digest('hex');
  assert.equal(sha, CASES_SHA256, 'shared/entscheidungskarten.jsonl changed: pin here AND the copy with its pin in lucky-mem together');
});

test('the cases are not empty, every topic and stage occurs, ids are unique, every type has a runner', () => {
  assert.ok(cases.length >= 30, `only ${cases.length} cases`);
  assert.equal(new Set(cases.map((f) => f.id)).size, cases.length, 'duplicate case id');
  for (const t of TOPICS) assert.ok(cases.some((f) => f.topic === t), `topic '${t}' has no case`);
  for (const s of ['written', 'addendum', 'fallback']) assert.ok(cases.some((f) => f.expect.stage === s), `stage '${s}' has no case`);
  for (const t of Object.keys(TYPE)) assert.ok(cases.some((f) => f.type === t), `type '${t}' has no case`);
  for (const f of cases) assert.ok(TOPICS.includes(f.topic), `${f.id}: topic '${f.topic}' unknown`);
  const inv = new Set(fs.readFileSync(path.join(REPO, 'shared', 'invariants.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id));
  for (const id of Object.values(INVARIANT_OF)) assert.ok(inv.has(id), `invariant '${id}' is missing in shared/invariants.jsonl`);
});

test('every shared case holds against this house\'s card', () => {
  const violations = cases.flatMap((f) => check(f));
  assert.deepEqual(violations, [], `${violations.length} violations in ${cases.length} cases`);
});

test('no real key stands in the file (the placeholder {SECRET} is replaced only in the runner)', () => {
  assert.ok(!fs.readFileSync(CASES_FILE, 'utf8').includes('sk-'));
  assert.ok(cases.some((f) => JSON.stringify(f).includes('{SECRET}')));
});

// --- positive controls: the runner sees a broken card -------------------------------------------------

const without = (fn) => (e, opt) => fn(card.cardOf(e, opt));

test('positive control: a card without a No option is seen by the cases', () => {
  const broken = without((k) => ({ ...k, options: k.options.filter((o) => !o.decline) }));
  assert.ok(cases.flatMap((f) => check(f, broken)).some((s) => /has_decline/.test(s)), 'no case saw the missing No option');
});

test('positive control: an invented advice on the fallback card is seen', () => {
  const broken = without((k) => (k.origin.stage === 'fallback' ? { ...k, advice: { text: 'Do it.', author: 'nobody' } } : k));
  assert.ok(cases.flatMap((f) => check(f, broken)).some((s) => /advice/.test(s)));
});

test('positive control: a card that passes a key through is seen', () => {
  const broken = (e, opt) => {
    const k = card.cardOf(e, opt);
    return { ...k, context: `${k.context ?? ''} ${SECRET}` };
  };
  assert.ok(cases.flatMap((f) => check(f, broken)).some((s) => /no_leak/.test(s)));
});

test('positive control: an expectation without a runner shows up instead of passing silently', () => {
  const v = check({ id: 'x', type: 'duty', entry: { id: 'd1', title: 'Task' }, expect: { does_not_exist: 1 } });
  assert.match(v.join(), /unknown expectation 'does_not_exist'/);
});

test('positive control: an unreadable entry does not become an empty card (unknown, not empty)', () => {
  const k = card.cardOf({ __broken: true, raw: '{' }, { type: 'duty' });
  assert.ok(k.question && /unknown/.test(k.question));
  assert.ok(k.options.length >= 2);
});

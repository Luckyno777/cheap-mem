// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/decision-card.test.mjs — H11 (card-core-cm): src/decisioncard.mjs, the pure card, and src/cardrules.mjs.
//
// Ported from the sibling's cross-check of its card core (2026-10-13): linear work (no ReDoS), control and bidi characters
// gone, masked then cut, the higher tier counts before the youngest card, every question ends in exactly one "?", a locked
// entry stays locked. The shared cases (stages, fallback texts, masking, unknown) run in test/decision-card-cases.test.mjs.
//
// Red proof: before this build src/decisioncard.mjs did not exist (every import fails). The sections below name the finding
// they hold; the long-input probes were measured red in the sibling house at 71 s and 276 s before its fix.
// Positive controls: a normal-length input gives a whole card; a locked entry stays locked while the same entry unlocked
// gives a card from its text; a card by a person is not displaced by an agent's.
//
// invariant: nicht-messbar-ist-nicht-null
// invariant: eine-regel-eine-stelle
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as card from '../src/decisioncard.mjs';
import * as rules from '../src/cardrules.mjs';
import * as bidi from '../src/bidi.mjs';
import * as bodyfields from '../src/bodyfields.mjs';
import * as shred from '../src/shred.mjs';

const TS = '2026-10-13T08:00:00.000Z';
const entry = (extra = {}) => ({ id: 'abc123def456', ts: TS, agent: 'builder-x', authority: 'agent', ...extra });
const ms = (fn) => { const t = performance.now(); const r = fn(); return { ms: performance.now() - t, r }; };
const BOTH = ['Yes — it happens', 'No — it stays'];

// --- B1: linear -----------------------------------------------------------------------------------

// The inputs that cost minutes in the sibling before its fix. Source text, so the same set runs in a child (deadline) and here (budget).
const LONG_CASES = `
  const entry = (extra) => ({ id: 'abc123def456', ts: '2026-10-13T08:00:00Z', agent: 'builder-x', authority: 'agent', ...extra });
  export const cases = {
    'line breaks in the text': entry({ title: 'Task', text: 'x' + '\\n'.repeat(5000) + 'y', who: 'u' }),
    'line breaks with blanks': entry({ title: 'Task', text: 'x' + '\\n \\r\\n'.repeat(2500) + 'y', who: 'u' }),
    '60k dots in the title': entry({ title: '.'.repeat(60000) + 'x', who: 'u' }),
    '20k ellipses in the title': entry({ title: 'a' + '...'.repeat(20000), who: 'u' }),
    '60k marks before x': entry({ title: '?!.;:, '.repeat(9000) + 'x', who: 'u' }),
    '60k dots in the question': entry({ question: '.'.repeat(60000) + 'x', title: '.'.repeat(60000) + 'y' }),
    '8k brackets in the text': entry({ title: 'Task', text: '['.repeat(8192), who: 'u' }),
    'abbreviation dots in the text': entry({ title: 'Task', text: 'a. '.repeat(20000), who: 'u' }),
    'guard title with many " at "': entry({ title: 'Guard for a' + ' at '.repeat(15000) + '\\n', who: 'u' }),
    'source marker repeated': entry({ title: 'Task', text: 'Source:'.repeat(5000), who: 'u' }),
  };
`;

test('B1: the inputs that cost minutes elsewhere finish in a child process in seconds (deadline 30 s)', () => {
  const code = `import * as card from ${JSON.stringify(new URL('../src/decisioncard.mjs', import.meta.url).href)};
    ${LONG_CASES.replace('export const cases', 'const cases')}
    let n = 0;
    for (const e of Object.values(cases)) for (const type of ['duty', 'question']) { card.cardOf(e, { type }); n += 1; }
    console.log('done ' + n);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.error, undefined, `the inputs took too long (deadline 30 s): ${r.error?.message}`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /done 20/);
  // positive control: the same kind of input at normal length gives a whole card
  const k = card.cardOf(entry({ title: 'Task', text: 'First sentence. Second sentence.', who: 'u' }), { type: 'duty' });
  assert.match(k.context, /First sentence/);
});

test('B1: each long input is one card in well under a second (budget 500 ms each)', async () => {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(LONG_CASES).toString('base64')}`);
  for (const [name, e] of Object.entries(mod.cases)) {
    for (const type of ['duty', 'question']) {
      const { ms: took } = ms(() => card.cardOf(e, { type }));
      assert.ok(took < 500, `${name} (${type}): ${took.toFixed(0)} ms`);
    }
  }
});

test('B1: the source line is still cut off (two line breaks, then "Source:"), a single break is not', () => {
  const k = card.cardOf(entry({ title: 'Task', text: 'The sentence in the text.\n  \n Source: branch agent/x, report.' }), { type: 'duty' });
  assert.ok(!/Source/.test(k.context), k.context);
  const one = card.cardOf(entry({ title: 'Task', text: 'The sentence in the text.\nSource: stays.' }), { type: 'duty' });
  assert.match(one.context, /Source/);
});

// --- control and bidi characters -------------------------------------------------------------------

test('control and bidi characters appear in no card (fallback, written, addendum)', () => {
  const bad = (t) => t.replace('#', '\u001b[31m').replace('@', '‮').replace('%', '​');
  const nasty = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
  const fallback = card.cardOf(entry({ title: bad('Alarm# yellow@ message%'), text: bad('Text# of@ it. Second%'), who: 'u' }), { type: 'duty' });
  const written = card.cardOf(entry({ card_question: bad('Should# it@ be%?'), card_context: bad('W#'), card_options: [bad('Yes# — f@'), bad('No% — g')], card_advice: bad('E@') }), { type: 'duty' });
  const addendum = card.cardOf(entry({}), { type: 'duty', context: { cards: new Map([['abc123def456', { question: bad('N#?'), options: [bad('a@'), 'No'], evidence: [bad('b%')] }]]) } });
  for (const [name, k] of Object.entries({ fallback, written, addendum })) {
    assert.ok(!nasty.test(JSON.stringify(k).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))), name);
    assert.equal(bidi.has(JSON.stringify(k).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))), false, name);
  }
  assert.match(fallback.question, /Alarm\[31m yellow message/);
});

// --- masking: first mask, then cut ----------------------------------------------------------------

test('a key is masked BEFORE the cut: a key that straddles the cut cannot slip through half-written', () => {
  const key = `sk-${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`;
  // the key starts shortly before the 320-character cut of the context
  // (no blank before the cut: the cut at a word boundary cannot save a key inside one long word)
  for (const text of [`${'y'.repeat(305)}=${key} and more words after it.`, `${'word '.repeat(60)}${key} and more words after it.`]) {
    const k = card.cardOf(entry({ card_question: 'Q?', card_context: text, card_options: BOTH }), { type: 'duty' });
    assert.ok(!k.context.includes('sk-a1B2'), k.context);
    assert.ok(!JSON.stringify(k).includes('a1B2c3D4e5F6'));
  }
});

// --- the higher tier counts, then the youngest -----------------------------------------------------

const ADD = (extra = {}) => ({ author: 'orch', rank: 'agent', ts: '2026-10-15T00:00:00Z', question: 'Addendum question?', options: ['A — a', 'No — b'], ...extra });
const INLINE = (extra = {}) => entry({ ts: '2026-10-10T00:00:00Z', card_question: 'Inline question?', card_options: ['A — a', 'No — b'], ...extra });
const withCards = (c) => ({ type: 'duty', context: { cards: new Map([['abc123def456', c]]) } });

test('S1: a card the person wrote (tier user) stays even if an agent adds one later, and the result names who it displaced', () => {
  const k = card.cardOf(INLINE({ authority: 'user', agent: 'human:alex' }), withCards(ADD()));
  assert.equal(k.origin.stage, 'written');
  assert.equal(k.question, 'Inline question?');
  assert.deepEqual(k.origin, { stage: 'written', author: 'human:alex', rank: 'user', ts: '2026-10-10T00:00:00Z', by_human: true });
  assert.deepEqual(k.replaced, { author: 'orch', rank: 'agent', ts: '2026-10-15T00:00:00Z' });
});

test('S1: equal tier -> the youngest counts either way; a higher addendum beats a younger inline card', () => {
  const addendumNewer = card.cardOf(INLINE(), withCards(ADD()));
  assert.equal(addendumNewer.origin.stage, 'addendum');
  assert.deepEqual(addendumNewer.replaced, { author: 'builder-x', rank: 'agent', ts: '2026-10-10T00:00:00Z' });
  const inlineNewer = card.cardOf(INLINE({ ts: '2026-10-20T00:00:00Z' }), withCards(ADD()));
  assert.equal(inlineNewer.origin.stage, 'written');
  assert.deepEqual(inlineNewer.replaced, { author: 'orch', rank: 'agent', ts: '2026-10-15T00:00:00Z' });
  const higher = card.cardOf(INLINE({ ts: '2026-10-20T00:00:00Z' }), withCards(ADD({ rank: 'user', ts: '2026-10-01T00:00:00Z' })));
  assert.equal(higher.origin.stage, 'addendum');
  assert.equal(higher.origin.rank, 'user');
});

test('S1: without a second card `replaced` is null (not missing, not empty)', () => {
  assert.equal(card.cardOf(INLINE(), { type: 'duty' }).replaced, null);
  assert.equal(card.cardOf(entry({ title: 'x' }), { type: 'duty' }).replaced, null);
  assert.equal(card.cardOf(entry({}), withCards(ADD())).replaced, null);
});

test('`replaced` names the HIGHEST-tier card that lost, not the youngest', () => {
  const nach = ADD({ author: 'human:alex', rank: 'user', ts: '2026-10-16T00:00:00Z', replaced: { author: 'sys', rank: 'system', ts: '2026-10-14T00:00:00Z' } });
  const k = card.cardOf(INLINE(), withCards(nach));
  assert.deepEqual(k.replaced, { author: 'sys', rank: 'system', ts: '2026-10-14T00:00:00Z' });
});

test('precedes(): tier first, then age; an unknown tier or an unreadable date stands last; a tie goes to the first', () => {
  const p = card.precedes;
  assert.equal(p({ rank: 'user', ts: '2020-01-01' }, { rank: 'agent', ts: '2030-01-01' }), true);
  assert.equal(p({ rank: 'agent', ts: '2020-01-01' }, { rank: 'user', ts: '2030-01-01' }), false);
  assert.equal(p({ rank: 'agent', ts: '2026-02-01' }, { rank: 'agent', ts: '2026-01-01' }), true);
  assert.equal(p({ rank: 'agent', ts: '2026-01-01' }, { rank: 'agent', ts: '2026-02-01' }), false);
  assert.equal(p({ rank: 'agent', ts: 'nonsense' }, { rank: 'agent', ts: '2026-02-01' }), false);
  assert.equal(p({ rank: 'made-up', ts: '2026-02-01' }, { rank: 'unknown', ts: '2026-02-01' }), true, 'foreign tier is read as unknown');
  assert.equal(p({ rank: 'agent', ts: TS }, { rank: 'agent', ts: TS }), true);
});

// --- every question ends in exactly one "?" ---------------------------------------------------------

test('S7: every question (fallback, written, addendum) ends in exactly one "?" and is at most 160 characters', () => {
  const long = 'a long sentence '.repeat(30);
  const stock = [
    ['duty', entry({ title: 'Decide which of the two details wins - TRANSFER in src/transfer.mjs or PROVIDER.transfer in payment.mjs and much more text behind it that goes on', who: 'u' })],
    ['duty', entry({ title: 'Open from agent report h7: `mem_skill_get` books nothing in the journal; the fetch ...', who: 'o' })],
    ['duty', entry({ title: 'Check whether it works…', who: 'u' })],
    ['duty', entry({ title: 'Check whether it works...', who: 'u' })],
    ['duty', entry({ title: 'Is that so??', who: 'u' })],
    ['duty', entry({ title: 'Really?!', who: 'u' })],
    ['duty', entry({ title: long, who: 'u' })],
    ['question', entry({ question: 'unclear whether the tunnel hangs twice' })],
    ['question', entry({ question: 'An equivalence run of three differed and could not be reproduced...' })],
    ['question', entry({ question: `${long}?` })],
    ['question', entry({ question: long })],
    ['question', entry({ title: 'Vector logo' })],
    ['duty', entry({ card_question: 'Is that so', card_options: BOTH })],
    ['duty', entry({ card_question: `${long}...`, card_options: BOTH })],
    ['duty', entry({ card_question: 'Does it hold?!?', card_options: BOTH })],
    ['project', { name: 'x' }],
    ['letter', { id: 'b.md', title: 'Approve the release...', from: 'a' }],
    ['review', { kind: 'merge', ids: ['a'] }],
    ['word-pair', { a: 'x', b: 'y' }],
    ['duty', null],
  ];
  const contexts = [undefined, { cards: new Map([['abc123def456', { question: `${long}...`, options: ['a', 'No'] }]]) }];
  for (const [type, e] of stock) {
    for (const context of contexts) {
      const k = card.cardOf(e, { type, context });
      assert.match(k.question, /[^?]\?$/, `${type} ${JSON.stringify(e)?.slice(0, 50)}: '${k.question}'`);
      assert.ok(k.question.length <= 160, `${k.question.length} characters`);
      assert.ok(!/…\?$|\.\.\.\?$|\?\?/.test(k.question), `double in '${k.question}'`);
    }
  }
  assert.equal(card.cardOf({ id: 'v', body_enc: { cipher: 'x' } }, { type: 'duty' }).question, '[locked]');
  // positive control: a whole question stays unchanged
  assert.equal(card.cardOf(entry({ question: 'Where do we back up the source build?' }), { type: 'question' }).question, 'Where do we back up the source build?');
});

// --- locked and unreadable ----------------------------------------------------------------------------

test('a locked entry keeps its mark and shows no word of its text, even with a card written on it; the same entry unlocked gives a card', () => {
  const secret = 'Plaintext must not appear';
  const locked = entry({ title: secret, text: `${secret}. Second.`, card_question: `${secret}?`, card_options: BOTH, body_enc: { cipher: 'x' } });
  const k = card.cardOf(locked, { type: 'duty', context: { cards: new Map([['abc123def456', ADD({ question: `${secret}?` })]]) } });
  assert.equal(k.question, '[locked]');
  assert.equal(k.origin.stage, 'fallback');
  assert.ok(!JSON.stringify(k).includes(secret));
  assert.ok(k.options.some((o) => o.decline));
  const { body_enc: _drop, ...open } = locked;
  assert.match(card.cardOf(open, { type: 'duty' }).question, /Plaintext/);
});

test('an unreadable or missing entry is the card "unknown" with a decline option, never an empty one', () => {
  for (const e of [{ __broken: true, raw: '{' }, undefined, null, 'text', 42, ['a']]) {
    const k = card.cardOf(e, { type: 'duty' });
    assert.match(k.question, /unknown/);
    assert.ok(k.options.length >= 2 && k.options.some((o) => o.decline));
    assert.equal(k.identifier, null);
  }
});

// --- the card keeps its promises ------------------------------------------------------------------------

test('a fallback card always has a decline option and never an advice; its origin is empty', () => {
  const stock = [entry({ title: 'Switch the alias', who: 'u' }), entry({}), entry({ question: 'Which?' })];
  for (const [i, e] of stock.entries()) {
    const k = card.cardOf(e, { type: i === 2 ? 'question' : 'duty' });
    assert.equal(k.advice, null);
    assert.deepEqual(k.origin, { stage: 'fallback', author: null, rank: null, ts: null });
    assert.ok(k.options.some((o) => o.decline));
    assert.ok(k.options.every((o) => o.effect));
  }
});

test('a written card with gaps is filled visibly from the fallback card; the advice never', () => {
  const k = card.cardOf(entry({ title: 'Task', text: 'A sentence about the task. More.', card_question: 'Do it?' }), { type: 'duty' });
  assert.deepEqual(k.supplemented.sort(), ['context', 'evidence', 'kind', 'options'].sort());
  assert.equal(k.advice, null);
  const withAdvice = card.cardOf(entry({ card_question: 'Do it?', card_options: BOTH, card_advice: 'Do it.' }), { type: 'duty' });
  assert.deepEqual(withAdvice.advice, { text: 'Do it.', author: 'builder-x' });
});

test('limits: a long question is cut at a word boundary with an ellipsis, options beyond 6 are dropped', () => {
  const k = card.cardOf(entry({ card_question: 'word '.repeat(100), card_options: ['No — x'].concat(Array.from({ length: 9 }, (_, i) => `Choice ${i} — effect`)) }), { type: 'duty' });
  assert.ok(k.question.length <= 160);
  assert.equal(k.options.length, 6);
  assert.deepEqual(k.supplemented, ['evidence', 'kind']);
});

test('options as one text with line breaks are read as a list; dash, en dash and spaced hyphens separate choice and effect', () => {
  const k = card.cardOf(entry({ card_question: 'Which?', card_options: 'A — first\nB – second\nC - third\nNo' }), { type: 'duty' });
  assert.deepEqual(k.options.map((o) => o.choice), ['A', 'B', 'C', 'No']);
  assert.deepEqual(k.options.map((o) => o.effect), ['first', 'second', 'third', null]);
  assert.ok(k.options[3].decline);
});

test('isDecline: reads No and not-now words, not words that merely contain them', () => {
  for (const yes of ['No', 'No, keep it', 'Not now', 'Do not build', 'Discard', 'Decline', 'Later', 'Leave as is', 'Nothing']) assert.equal(rules.isDecline(yes), true, yes);
  for (const no of ['Notify the team', 'Know more', 'Build it', 'Yes', 'Notebook', 'Another']) assert.equal(rules.isDecline(no), false, no);
});

test('the card prose fields of an entry are the ones a shredded entry encrypts (no card text beside body_enc in the clear)', () => {
  const F = card.CARD_FIELDS;
  for (const f of bodyfields.CARD_PROSE_FIELDS) assert.ok(shred.SHREDDABLE_FIELDS.includes(f), `${f} is not shreddable`);
  assert.deepEqual([...bodyfields.CARD_PROSE_FIELDS, 'card_kind'].sort(), Object.values(F).sort());
});

// --- the rules a write is held to -----------------------------------------------------------------------

test('checkCard: what must be there, the lengths, the decline option, the kinds', () => {
  const good = { target_id: 'abc123def456', question: 'Should it?', context: 'Because.', options: BOTH };
  assert.equal(rules.checkCard(good).ok, true);
  const bad = (extra, re) => { const r = rules.checkCard({ ...good, ...extra }); assert.equal(r.ok, false); assert.match(r.errors.join('\n'), re); };
  bad({ question: '' }, /card_question missing/);
  bad({ question: 'x'.repeat(161) }, /161 characters/);
  bad({ context: '' }, /card_context missing/);
  bad({ options: ['Only — one'] }, /at least two options/);
  bad({ options: ['Yes — a', 'Maybe — b'] }, /No \/ not-now option/);
  bad({ options: Array.from({ length: 7 }, (_, i) => `No ${i} — x`) }, /at most 6/);
  bad({ kind: 'maybe' }, /card_kind/);
  bad({ target_id: 'a b' }, /target_id/);
  bad({ target_id: undefined }, /target_id missing/);
  assert.match(rules.checkCard({ ...good, options: ['Yes', 'No'] }).warnings.join(), /names no effect/);
  assert.match(rules.checkCard({ ...good, question: 'Statement' }).warnings.join(), /"\?"/);
});

test('targetFormProblem: ids and the three prefixes pass; shell characters, blanks, dots, path steps and too long ones do not', () => {
  for (const ok of ['abc123def456', 'project:garden-plan', 'letter:mail-1.md', 'word-pair:alarm|clock']) assert.equal(rules.targetFormProblem(ok), null, ok);
  for (const bad of ['letter:$(id)"; echo X; "', 'letter:a b', 'project:../x', 'word-pair:a;b|c', 'abc123; rm -rf', 'a`id`', "letter:'x", 'letter:', 'x'.repeat(200), 'abc', '', null]) {
    assert.ok(rules.targetFormProblem(bad), String(bad));
  }
});

test('origin.by_human: the author is the configured human participant (from the context) or a person by the one rule; never a name in the code', () => {
  const entry = { id: 'e1', title: 'T', card_question: 'Which one?', card_options: ['A — a', 'Not now — b'] };
  const by = (agent, human) => card.cardOf({ ...entry, agent }, { type: 'duty', context: human === undefined ? {} : { human } }).origin.by_human;
  assert.equal(by('anna', 'anna'), true, 'the configured human');
  assert.equal(by('anna', 'bob'), false, 'another participant');
  assert.equal(by('anna'), false, 'no human configured: nobody is guessed');
  assert.equal(by('human:anna'), true, 'a person by the one rule (authority.isHumanName)');
  assert.equal(by('owner'), true);
  assert.equal(by('anna', null), false);
  assert.equal(card.cardOf({ id: 'e2', title: 'T' }, { type: 'duty', context: { human: 'anna' } }).origin.by_human, undefined, 'a replacement card has no author, so no flag');
});

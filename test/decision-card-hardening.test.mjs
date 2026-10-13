// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/decision-card-hardening.test.mjs — the review of card-core-cm (e73f830), findings B2, B3, B4.
//
// B2  A fallback card cut and split the texts of an entry BEFORE it masked them: a key (a PEM block above all) that straddled
//     the cut survived as clear text in the question, the context or an effect. Now every string of the entry is masked first,
//     each finished field once more.
// B3  The author of a card, the author of its advice and the identifier were shown raw: an ESC or bidi switch in an agent name
//     (or in a project name, a letter id, a word) went to the terminal. Now cleaned and masked like every other text.
// B4  Only the ASCII "?" counted as an end mark: a question ending in "？", "؟" or "‽" got a second "?" appended.
//
// Red proof: on e73f830 each probe below fails (the PEM probes with a leak in the fallback question, the author probes with the
// ESC in `origin.author`, the question-mark probes with "？?"). Positive controls: the same inputs at a harmless place give
// whole, clean cards; the intrinsic limit of the mask (a pattern it does not know) is not held against the card.
//
// invariant: nicht-messbar-ist-nicht-null
import test from 'node:test';
import assert from 'node:assert/strict';
import * as card from '../src/decisioncard.mjs';
import { maskText } from '../src/outputguard.mjs';

const BODY = 'uxjIfjh5Wle0hxEwzuAyEEtYs03CoaK5p9Wzpci55ILzFDuxQz1ZLFHN5Z8d';
const PEM = `-----BEGIN ${'PRIVATE KEY'}-----${BODY}-----END ${'PRIVATE KEY'}-----`;
const KEY = `sk-${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6'}`;
const leaks = (out, body) => { for (let i = 0; i + 8 <= body.length; i += 1) if (out.includes(body.slice(i, i + 8))) return true; return false; };
const base = { id: 'abcd1234', ts: '2026-10-01T00:00:00Z', agent: 'x', authority: 'agent' };

// --- B2 ----------------------------------------------------------------------------------------------

test('B2: a key or PEM block that straddles the cut of a fallback card is masked in every field (title, text, why, question, project, letter, word pair, report)', () => {
  const secrets = [[PEM, BODY], [KEY, KEY.slice(3)]];
  const places = [
    ['duty title', (v) => card.cardOf({ ...base, title: v }, { type: 'duty' })],
    ['duty text', (v) => card.cardOf({ ...base, text: v }, { type: 'duty' })],
    ['duty why', (v) => card.cardOf({ ...base, title: 'T', why: v }, { type: 'duty' })],
    ['question', (v) => card.cardOf({ ...base, question: v }, { type: 'question' })],
    ['question title+why', (v) => card.cardOf({ ...base, title: v, why: v }, { type: 'question' })],
    ['project', (v) => card.cardOf({ name: v, title: v, reason: v, kind: 'new', createdBy: v }, { type: 'project' })],
    ['letter', (v) => card.cardOf({ id: v, title: v, from: v }, { type: 'letter' })],
    ['word pair', (v) => card.cardOf({ a: v, b: v, command: v }, { type: 'word-pair' })],
    ['general', (v) => card.cardOf({ id: v, title: v, text: v }, {})],
    ['report', (v) => card.cardOf({ ...base, title: `Review report ${v}`, report: v, text: v, tags: ['agent-report'] }, { type: 'duty' })],
    ['guard', (v) => card.cardOf({ ...base, automatic: true, class: v, file: v, error_ids: [v] }, { type: 'duty' })],
  ];
  let checked = 0;
  for (const [name, make] of places) {
    for (const [secret, body] of secrets) {
      for (const pre of [0, 1, 20, 29, 40, 100, 140, 150, 155, 157, 159, 200, 300, 310, 318]) {
        for (const tail of ['', ' end of the sentence.']) {
          const input = `${'w'.repeat(Math.max(0, pre - 1))}${pre ? ' ' : ''}${secret}${tail}`;
          if (leaks(maskText(input), body)) continue; // the mask itself does not know this shape: not the card's fault
          const out = JSON.stringify(make(input));
          checked += 1;
          assert.ok(!leaks(out, body), `${name} pre=${pre}: a key stands in the clear: ${out.slice(0, 300)}`);
        }
      }
    }
  }
  assert.ok(checked > 500, `only ${checked} cases were held to the rule`);
  // positive control: at a harmless place the text is still a whole card
  assert.match(card.cardOf({ ...base, title: 'Rotate the thing', text: 'It is old. Do it.', who: 'u' }, { type: 'duty' }).question, /^Do or decide: Rotate the thing\?$/);
});

test('B2: the review titles handed in by the caller are masked too', () => {
  const k = card.cardOf({ kind: 'merge', ids: ['a1', 'b2'] }, { type: 'review', context: { titles: new Map([['a1', `Key ${KEY}`], ['b2', 'Plain']]) } });
  assert.ok(!k.question.includes(KEY.slice(3)), k.question);
});

// --- B3 ----------------------------------------------------------------------------------------------

const NASTY = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/;
const seen = (v) => JSON.stringify(v).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

test('B3: control and bidi characters in an author name never reach origin.author, advice.author or replaced', () => {
  const bad = 'bad\u001b[2J‮name​';
  const written = card.cardOf({ ...base, agent: bad, card_question: 'Q?', card_context: 'c', card_options: ['A — a', 'No — b'], card_advice: 'adv' }, { type: 'duty' });
  assert.ok(!NASTY.test(seen(written)), seen(written));
  assert.match(written.origin.author, /^bad\[2Jname$/);
  assert.equal(written.advice.author, written.origin.author);
  const add = { author: bad, rank: 'agent', ts: '2026-10-05T00:00:00Z', question: 'Q2?', options: ['A — a', 'No — b'], advice: 'x', replaced: { author: bad, rank: 'system', ts: '2026-10-02T00:00:00Z' } };
  const k = card.cardOf({ ...base, card_question: 'Q?', card_options: ['A — a', 'No — b'], agent: bad }, { type: 'duty', context: { cards: new Map([['abcd1234', add]]) } });
  assert.equal(k.origin.stage, 'addendum');
  assert.ok(!NASTY.test(seen(k)), seen(k));
  assert.ok(k.replaced.author && !NASTY.test(k.replaced.author));
  // positive control: a plain name is unchanged
  assert.equal(card.cardOf({ ...base, agent: 'builder-x', card_question: 'Q?', card_options: ['A — a', 'No — b'] }, { type: 'duty' }).origin.author, 'builder-x');
});

test('B3: control and bidi characters and keys in the identifier (id, project name, letter id, word pair) are cleaned and masked; the shelf lookup still uses the key as written', () => {
  const bad = 'x\u001b[31m‮y';
  for (const [e, type] of [[{ id: bad, title: 't' }, 'duty'], [{ name: bad, kind: 'new' }, 'project'], [{ id: bad, title: 't' }, 'letter'], [{ a: bad, b: bad }, 'word-pair']]) {
    const k = card.cardOf(e, { type });
    assert.ok(!NASTY.test(seen(k)), `${type}: ${seen(k)}`);
    assert.ok(k.identifier && !NASTY.test(k.identifier), type);
  }
  const secret = card.cardOf({ a: `w --token ${KEY.slice(3)}`, b: `w --token ${KEY.slice(3)}` }, { type: 'word-pair' });
  assert.ok(!JSON.stringify(secret).includes(KEY.slice(3, 20)), secret.identifier);
  // the lookup: an addendum stored under the key as written is still found
  const k = card.cardOf({ name: 'garden-plan', kind: 'new' }, { type: 'project', context: { cards: new Map([['project:garden-plan', { question: 'Q?', options: ['A — a', 'No — b'], rank: 'agent', ts: '2026-10-01T00:00:00Z' }]]) } });
  assert.equal(k.origin.stage, 'addendum');
  assert.equal(k.identifier, 'project:garden-plan');
});

// --- B4 ----------------------------------------------------------------------------------------------

test('B4: a question mark of another script is the end mark: the question ends in exactly one ASCII "?"', () => {
  const ends = ['Go？', 'Go؟', 'Go‽', 'Go？？', 'Go?？', 'Go？?', 'Go؟?', 'Go ‽ ', 'Go！', 'Go⁇', 'Go⁈', 'Go⁉', 'Go?‽', 'Go…？', 'Go?...'];
  const make = [
    (q) => card.cardOf({ ...base, card_question: q, card_context: 'c', card_options: ['A — a', 'No — b'] }, { type: 'duty' }),
    (q) => card.cardOf({ ...base, question: q }, { type: 'question' }),
    (q) => card.cardOf({ ...base, title: q }, { type: 'duty' }),
    (q) => card.cardOf({ id: 'abcd1234' }, { type: 'duty', context: { cards: new Map([['abcd1234', { question: q, options: ['A — a', 'No — b'], rank: 'agent', ts: '2026-10-01T00:00:00Z' }]]) } }),
  ];
  for (const q of ends) {
    for (const mk of make) {
      const s = mk(q).question;
      assert.match(s, /^[^?？؟‽！⁇⁈⁉]*[^?？؟‽！⁇⁈⁉]\?$/, `${JSON.stringify(q)} -> ${JSON.stringify(s)}`);
    }
  }
  // positive control: a plain question is unchanged
  assert.equal(make[1]('Where do we back up?').question, 'Where do we back up?');
});

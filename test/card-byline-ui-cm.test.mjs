// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/card-byline-ui-cm.test.mjs - the logic half of test/card-byline-ui-cm-browser.test.mjs: the card's origin line names
// the author AND the rank in the words of `authority.rankWord`, a rank the line does not carry reads "unknown (missing)",
// "unknown (empty)" or "unknown (broken)", and the configured human's NAME at tier agent keeps the agent hint - on the
// ORIGINAL `cardOriginHtml` and `rankWord` out of assets/dashboard/dashboard.js (cut out by test/fixture/dash-run-cm.mjs),
// fed with cards the server side really builds (`cardOf` from src/decisioncard.mjs).
//
// Why a second probe of the same guarantee (CI run 1141): the browser probe needs Chromium, and the guarantees job of CI has
// none. There it skipped, its three mutants in bench/mutation.mjs ("BYLINE-UI ...") looked like survivors of their own suite,
// and the harness re-ran the WHOLE suite for each to find out (about 7 minutes apiece, three of them): the job ran into its
// 25-minute limit and was cancelled - the same way as CI run 1103 (test/dash-later-once-cm.test.mjs). This probe needs no
// browser, so the mutants are caught where they are checked.
//
// Measure:          the text of the origin line and whether the agent hint follows it.
// Starting value:   the state BEFORE the byline branch (9a10bf6): every rank the line does not carry reads "tier unknown".
// Expected change:  "tier unknown (missing)" / "(empty)" / "(broken)"; the human's name at tier agent keeps the hint; rank
//                   user carries none.
// Abort criterion:  any of these false.
//
// Red proof: DASH_JS=<dashboard.js of 9a10bf6> node --test test/card-byline-ui-cm.test.mjs - the three states fall together
// as "tier unknown"; the positive control below shows that the cut-out function renders a line at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from './fixture/dash-run-cm.mjs';
import { cardOf } from '../src/decisioncard.mjs';

const ts = '2026-10-02T09:00:00Z';
// The same entries as the browser probe (the configured human of a fresh `mem init` is the participant `user`).
const entry = (id, author, authority, q) => ({
  id, ts, title: q, who: 'user', agent: author, ...(authority === undefined ? {} : { authority }),
  card_question: q, card_options: ['Yes - it goes ahead', 'No - it stays as it is', 'Not now - nothing changes'], card_kind: 'decide',
});

function page() {
  // `when` is a multi-line arrow in the page and not cut out; the date is not what this probe measures.
  const preamble = "const when = () => '02 Oct 2026';";
  const api = build({
    preamble,
    constants: ['esc', 'plain', 'ce', 'CARD_STAGE', 'rankWord'],
    functions: ['cardOriginHtml'],
    expose: ['cardOriginHtml', 'rankWord'],
  });
  return api;
}

/** The origin line as text (tags out) and the number of agent hints after it. */
function origin(api, e) {
  const html = api.cardOriginHtml(cardOf(e, { type: 'duty' }));
  const line = /<p class="dcard-origin[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1].replace(/<[^>]+>/g, '') ?? null;
  return { line, hints: (html.match(/data-card-agent/g) || []).length };
}

test('POSITIVE CONTROL: the original functions were cut out and render an origin line', () => {
  const api = page();
  assert.equal(typeof api.cardOriginHtml, 'function', 'cardOriginHtml was not cut out of dashboard.js - the fixture names moved');
  const v = origin(api, entry('dnameag001', 'user', 'agent', 'Should the newsletter go out on Monday?'));
  assert.match(String(v.line), /^Written by user · tier /, JSON.stringify(v));
});

test('the origin line: name AND rank in the words of rankWord; a rank the line does not carry is named by its state', () => {
  const api = page();
  assert.equal(origin(api, entry('dnameag001', 'user', 'agent', 'Q?')).line, 'Written by user · tier agent · 02 Oct 2026 · written on the entry');
  assert.match(origin(api, entry('dhuman0001', 'user', 'user', 'Q?')).line, /^Written by user · tier user · /);
  assert.match(origin(api, entry('dmissin001', 'alex-planner', undefined, 'Q?')).line, /^Written by alex-planner · tier unknown \(missing\) · /);
  assert.match(origin(api, entry('dempty0001', 'orch-2', '', 'Q?')).line, /^Written by orch-2 · tier unknown \(empty\) · /);
  assert.match(origin(api, entry('dbroke0001', 'orch-3', 'boss', 'Q?')).line, /^Written by orch-3 · tier unknown \(broken\) · /);
});

test('the agent hint: the human\'s NAME at tier agent keeps it, rank user carries none, a card without a rank keeps it', () => {
  const api = page();
  assert.equal(origin(api, entry('dnameag001', 'user', 'agent', 'Q?')).hints, 1, 'the human\'s name at tier agent carries the hint');
  assert.equal(origin(api, entry('dhuman0001', 'user', 'user', 'Q?')).hints, 0, 'a card of rank user carries no hint');
  for (const [author, authority] of [['alex-planner', undefined], ['orch-2', ''], ['orch-3', 'boss']]) {
    assert.equal(origin(api, entry('dx', author, authority, 'Q?')).hints, 1, `a card without a rank carries the hint: ${author}`);
  }
});

test('rankWord in the page speaks like authority.rankWord: a tier stands, an absent state reads as set', () => {
  const api = page();
  assert.equal(api.rankWord('agent', 'set'), 'agent');
  assert.equal(api.rankWord('agent'), 'agent', 'an older payload without rank_state reads as set');
  assert.equal(api.rankWord(null, 'missing'), 'unknown (missing)');
  assert.equal(api.rankWord(null, 'broken'), 'unknown (broken)');
  assert.equal(api.rankWord(null), 'unknown');
});

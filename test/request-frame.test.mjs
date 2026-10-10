// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// The request frame is not the subject -- port of lucky-mem's "Bitt-Rahmen"
// (src/suche.mjs#ohneBittRahmen, finding zcq542jvmifj).
//
// Asked "explain the theory of relativity", the word "explain" carried the
// search and brought up entries about an "explainer page"; the model then
// built an HTML page. A request verb that OPENS the question (after a few
// courtesy words) or follows "can you" as the one closing infinitive is not a
// subject word; in the middle of a sentence it stays one (src/requestframe.mjs).
// It acts on the recall hook's own call (`mem find --recall`) and on the
// content-word query (`retrievalQuery`). Switch: MEM_RETRIEVE_REQUEST_FRAME=0.
//
//   A. the pure rule, positive AND negative controls (where it must NOT act);
//   B. `mem find` as the hook calls it, on a fixture: the relativity question
//      finds nothing now, the old way finds the explainer page (precondition);
//      a question that merely contains the verb finds what it found before;
//   C. the content-word query;
//   D. the REAL hook script: old state (pinned commit) against now.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dropRequestFrame, requestFrameOn } from '../src/requestframe.mjs';
import { contentWords, retrievalQuery } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';
import { CODE, emptyMemory, find, hookIds, oldTree, oldStateMissing, drop } from './fixture/recall-parity.mjs';

// --- A. the pure rule ----------------------------------------------------

const words = (q) => contentWords(q, { withoutRequest: true });

test('rule: the imperative at the start falls away (German)', () => {
  assert.deepEqual(words('erklaer mir die relativitaetstheorie'), ['relativitaetstheorie']);
  assert.deepEqual(words('Erkläre mir die Relativitätstheorie'), ['relativitaetstheorie']);
  assert.deepEqual(words('uebersetze guten morgen ins spanische'), ['guten', 'morgen', 'spanische']);
  assert.deepEqual(words('zeig mir die markentrennung'), ['markentrennung']);
  assert.deepEqual(words('nenne die gruende fuer die schranke'), ['gruende', 'fuer', 'schranke']);
  assert.deepEqual(words('beschreibe die schranke'), ['schranke']);
  assert.deepEqual(words('hilf mir beim umzug'), ['beim', 'umzug']);
});

test('rule: the imperative at the start falls away (English)', () => {
  assert.deepEqual(words('explain relativity'), ['relativity']);
  assert.deepEqual(words('explain the gate rule'), ['gate', 'rule']);
  assert.deepEqual(words('translate good morning into spanish'), ['morning', 'spanish']);
  assert.deepEqual(words('show me the brand separation'), ['brand', 'separation']);
  assert.deepEqual(words('describe the nightly job'), ['nightly']);
  assert.deepEqual(words('write a test for the hook'), ['test', 'hook']);
});

test('rule: courtesy words and "can you" count with the frame', () => {
  assert.deepEqual(words('bitte erklaer mir die markentrennung'), ['markentrennung']);
  assert.deepEqual(words('kannst du mir bitte die markentrennung erklaeren'), ['markentrennung']);
  assert.deepEqual(words('koenntest du die markentrennung beschreiben'), ['markentrennung']);
  assert.deepEqual(words('can you explain the gate rule'), ['gate', 'rule']);
  assert.deepEqual(words('Could you please show the nightly job'), ['nightly']);
});

test('control: in the middle of a sentence the verb stays a subject word', () => {
  assert.ok(words('how does the doc explain the brand separation').includes('explain'));
  assert.ok(words('why do I never explain this in the text').includes('explain'));
  assert.ok(words('what does the rule say about the gate').includes('rule'));
  assert.ok(words('how does mem show behave at the start').includes('show'));
  assert.ok(words('where is the write ahead rule').includes('write'));
  assert.ok(words('why does the hook help nothing here').includes('help'));
});

test('control: the infinitive counts only behind "can you"', () => {
  assert.ok(words('how long may one explain the page').includes('page'));
  assert.ok(words('wie lange darf man die seite erklaeren').includes('erklaeren'));
  assert.ok(words('wer soll das zeigen').includes('zeigen'));
  assert.ok(!words('kannst du das zeigen').includes('zeigen'));
  // no addressee: "kann" is no request to the session
  assert.ok(words('wie kann ich das zeigen').includes('zeigen'));
  assert.ok(words('can I show the page').includes('show'));
});

test('control: words that merely contain a verb, and other verbs, stay', () => {
  assert.ok(words('erklaerseite fuer den start').includes('erklaerseite'));
  assert.ok(words('zeigefinger geste am bildschirm').includes('zeigefinger'));
  assert.ok(words('schreibtisch im keller').includes('schreibtisch'));
  assert.ok(words('baue den riegel fuer die schranke').includes('baue'));
  assert.ok(words('pruefe die schranke').includes('pruefe'));
  assert.ok(words('showcase of the nightly job').includes('showcase'));
});

test('rule: behind "can you" only the ONE closing verb falls; nouns stay (capital, article, "das" not last)', () => {
  assert.ok(words('Kannst du das Schreiben der Sitzungspost erklaeren').includes('schreiben'));
  assert.ok(!words('Kannst du das Schreiben der Sitzungspost erklaeren').includes('erklaeren'));
  assert.ok(words('kannst du mir sagen wie das Zeigen im Dashboard geht').includes('zeigen'));
  assert.ok(!words('kannst du mir sagen wie das Zeigen im Dashboard geht').includes('sagen'));
  assert.ok(words('kannst du das schreiben der sitzungspost erklaeren').includes('schreiben'));
  assert.ok(!words('kannst du das schreiben der sitzungspost erklaeren').includes('erklaeren'));
  assert.ok(words('kannst du beim zeigen im dashboard helfen').includes('zeigen'));
  assert.ok(!words('kannst du beim zeigen im dashboard helfen').includes('helfen'));
  assert.ok(words('kannst du mir erklaeren und zeigen wie der hook laeuft').includes('zeigen'));
  // right behind the addressee there is no article: "ihr" is the addressee here, not "your"
  assert.ok(!words('koennt ihr zeigen wie der hook laeuft').includes('zeigen'));
});

test('rule: the text is cut where the words stand, the rest keeps its form; nothing to cut = the same text', () => {
  assert.equal(dropRequestFrame('Explain the Gate Rule'), 'the Gate Rule');
  assert.equal(dropRequestFrame('kannst du mir das erklaeren'), 'das');
  assert.equal(dropRequestFrame('how does the doc explain the rule'), 'how does the doc explain the rule');
  assert.equal(dropRequestFrame('src/search.mjs holds it'), 'src/search.mjs holds it');
  assert.equal(dropRequestFrame(''), '');
  assert.equal(dropRequestFrame(undefined), '');
});

test('rule: only the frame is left (no subject word) -- the content-word query keeps the text as typed', () => {
  assert.equal(retrievalQuery('explain that', { requestFrame: true }), 'explain that');
  assert.equal(retrievalQuery('bitte zeig', { requestFrame: true }), 'bitte zeig');
});

test('switch: MEM_RETRIEVE_REQUEST_FRAME=0 is the old way', () => {
  assert.equal(requestFrameOn({}), true);
  assert.equal(requestFrameOn({ MEM_RETRIEVE_REQUEST_FRAME: '1' }), true);
  assert.equal(requestFrameOn({ MEM_RETRIEVE_REQUEST_FRAME: '0' }), false);
});

// --- C. the content-word query --------------------------------------------

test('retrievalQuery: the frame is no word of the query; requestFrame false and the switch give the old query', () => {
  const q = 'explain the theory of relativity';
  assert.equal(retrievalQuery(q), 'theory relativity');
  assert.equal(retrievalQuery(q, { requestFrame: true }), 'theory relativity');
  assert.equal(retrievalQuery(q, { requestFrame: false }), 'explain theory relativity');
  const was = process.env.MEM_RETRIEVE_REQUEST_FRAME;
  process.env.MEM_RETRIEVE_REQUEST_FRAME = '0';
  try { assert.equal(retrievalQuery(q), 'explain theory relativity'); } finally {
    if (was === undefined) delete process.env.MEM_RETRIEVE_REQUEST_FRAME; else process.env.MEM_RETRIEVE_REQUEST_FRAME = was;
  }
});

// --- B. `mem find` as the hook calls it -----------------------------------

/** 60 fillers, three entries about an explainer page ("explain" in them), ONE about the brand separation (the gold). */
function fixture() {
  const root = emptyMemory('cm-frame-');
  for (let i = 0; i < 60; i += 1) {
    memory.logEntry(root, 'event', { title: `filler number ${i} for padding`, text: `something else entirely ${i} weather garden` }, { project: null });
  }
  memory.logEntry(root, 'decision', { id: 'fr-0', topic: 'explain explain', choice: 'explain page explain html', why: 'explain' });
  for (let i = 1; i <= 2; i += 1) {
    memory.logEntry(root, 'decision', {
      id: `fr-${i}`, topic: 'page html', choice: `page ${i} as html and explain`,
      why: `html onboarding display users see the page at the start ${'filler '.repeat(i * 3)}`,
    });
  }
  memory.logEntry(root, 'decision', {
    id: 'fr-gold', topic: 'brand separation', choice: 'brand separation between the two houses', why: 'brand separation keeps the houses clean',
  });
  return root;
}
const RELATIVITY = 'explain the theory of relativity';
const GOLD = 'explain the brand separation';
const MIDDLE = 'how does the doc explain the brand separation';
const PAGE = 'how is the explain page built';
const OFF = { MEM_RETRIEVE_REQUEST_FRAME: '0' };

test('find --recall: the relativity question finds nothing now, the old way finds the explainer page (precondition)', () => {
  const root = fixture();
  const old = find(CODE, root, RELATIVITY, { recall: true, weak: true, env: OFF });
  assert.ok(old.ids.length >= 1, 'precondition: with the switch at 0 the by-catch is there');
  assert.ok(old.ids.some((id) => id.startsWith('fr-') && id !== 'fr-gold'), `${old.ids}`);
  assert.deepEqual(find(CODE, root, RELATIVITY, { recall: true, weak: true }).ids, []);
  // the same question typed by hand (no --recall) keeps the words it was given
  assert.deepEqual(find(CODE, root, RELATIVITY, { weak: true }).ids, old.ids);
  drop(root);
});

test('find --recall, control: the gold question with a request verb finds its entry as before', () => {
  const root = fixture();
  const old = find(CODE, root, GOLD, { recall: true, weak: true, env: OFF });
  const now = find(CODE, root, GOLD, { recall: true, weak: true });
  assert.ok(now.ids.includes('fr-gold'), `${now.ids}`);
  assert.ok(old.ids.includes('fr-gold'), 'precondition: the old way finds it');
  assert.equal(now.ids[0], old.ids[0]);
  drop(root);
});

test('find --recall, control: a question that merely contains the verb, and the explainer page itself, are untouched', () => {
  const root = fixture();
  for (const q of [MIDDLE, PAGE]) {
    const old = find(CODE, root, q, { recall: true, weak: true, env: OFF });
    const now = find(CODE, root, q, { recall: true, weak: true });
    assert.ok(now.ids.length >= 1, `${q}: something`);
    assert.deepEqual(now.ids, old.ids, q);
  }
  drop(root);
});

test('find --recall with lever h1: the split question follows the frame, too', () => {
  const root = fixture();
  const h1 = { MEM_SEARCH_LEVERS: 'h1,h3' };
  assert.deepEqual(find(CODE, root, RELATIVITY, { recall: true, weak: true, env: h1 }).ids, []);
  assert.ok(find(CODE, root, RELATIVITY, { recall: true, weak: true, env: { ...h1, ...OFF } }).ids.length >= 1);
  assert.ok(find(CODE, root, GOLD, { recall: true, weak: true, env: h1 }).ids.includes('fr-gold'));
  drop(root);
});

test('find --recall: only the frame typed = searched as typed (better vague than none)', () => {
  const root = fixture();
  const now = find(CODE, root, 'explain that please', { recall: true, weak: true });
  const old = find(CODE, root, 'explain that please', { recall: true, weak: true, env: OFF });
  assert.deepEqual(now.ids, old.ids);
  drop(root);
});

// --- D. the real hook, old state against now --------------------------------

test('hook: the OLD state shows the explainer page for the relativity question, the hook now nothing (RED on the old state)', (t) => {
  const missing = oldStateMissing();
  if (missing) { t.skip(`unknown, not green: ${missing}`); return; }
  const root = fixture();
  const old = oldTree();
  try {
    const before = hookIds(old, root, RELATIVITY, { session: 'old' });
    const after = hookIds(CODE, root, RELATIVITY, { session: 'new' });
    assert.ok(/fr-\d/.test(before.text), `RED: the old hook is led by "explain" (${JSON.stringify(before.text)})`);
    assert.equal(after.text, '', 'the hook now shows nothing');
    // positive control: the gold question is shown by both, and the switch gives the old picture on the new code
    assert.ok(/fr-gold/.test(hookIds(old, root, GOLD, { session: 'old2' }).text));
    assert.ok(/fr-gold/.test(hookIds(CODE, root, GOLD, { session: 'new2' }).text));
    assert.ok(/fr-\d/.test(hookIds(CODE, root, RELATIVITY, { session: 'off', env: OFF }).text));
  } finally { drop(root); drop(old); }
});

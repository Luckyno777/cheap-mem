// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// verfahren-zeiger-cm (2026-10-17): the order of giving way in the SubagentStart text. Port of the sibling house's
// rule (a decision of the owner): the PROCEDURES get room for their full text first, in their own order, and each
// stays at least a pointer with its id. The workflow card gives way FIRST: it stands whole only if, next to the
// procedures and the assignment block, the whole recap still fits; otherwise it is its pointer. Only then is the
// recap shortened. Before, the card was allocated first and whole, and the last procedures were pointers behind it.
//
//   A. the selection (`answerbudget.compose`, `holdBack`): a better form is taken only if the bytes stay free for the
//      parts after it; the pointer and a single form are not held back;
//   B. the start (`subagentstart.select`) against the fixed old commit (RED there): procedures whole and card a pointer,
//      still tighter and the recap goes (every procedure stays at least a pointer with its id), a start that fits is
//      byte for byte the old one, the assignment block outranks the card;
//   C. source guards: the ranks are the ones named here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as answerbudget from '../src/answerbudget.mjs';
import * as subagentstart from '../src/subagentstart.mjs';
import * as subagenttask from '../src/subagenttask.mjs';
import * as workflowdetect from '../src/workflowdetect.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
// The fixed old commit (tip of agent/k1-teilwort-cm): the card was allocated before the procedures. Never a merge-base.
const BASE = '71be9cfe0a269932fd1c51bd889f5ea378b745ad';
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const plain = (s) => s;

// --- A. the selection ------------------------------------------------------------------------------------------

test('A1: holdBack - a form better than the last is taken only if the bytes stay free for what follows; the pointer is not held back', () => {
  const recap = 'c'.repeat(300);
  const parts = (hold) => [
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
    { id: 'card', kind: 'workflow', rank: 30, order: 1, forms: ['W'.repeat(500), 'wf ptr'], holdBack: hold, how: 'mem workflow show <id>' },
    { id: 'rc', kind: 'recap', rank: 40, order: 2, fill: (room) => (room >= recap.length ? recap : '') },
  ];
  const sep = 2;
  // Card whole + recap whole + header + two separators: the exact size at which both fit.
  const exact = 4 + sep + 500 + sep + recap.length;
  for (const [budget, wantCard, wantRecap] of [[exact, 0, true], [exact - 1, 1, true], [exact + 50, 0, true]]) {
    const sel = answerbudget.compose(parts(recap.length + sep), { budget, sanitize: plain });
    assert.equal(sel.chosen.find((c) => c.id === 'card')?.form, wantCard, `budget ${budget}: the card's form`);
    assert.equal(sel.chosen.some((c) => c.id === 'rc'), wantRecap, `budget ${budget}: the recap stands`);
    assert.ok(sel.bytes <= budget, `${sel.bytes} <= ${budget}`);
  }
  // Positive control: without holdBack the card takes the room and the recap is the one that is lost.
  const squeezed = answerbudget.compose(parts(0), { budget: exact - 1, sanitize: plain });
  assert.equal(squeezed.chosen.find((c) => c.id === 'card').form, 0, 'without holdBack the card stays whole');
  assert.equal(squeezed.chosen.some((c) => c.id === 'rc'), false, 'and the recap is lost (the probe measures something)');
  // A part with ONE form is not held back (nothing to step down to); a pointer-only choice is never refused for it.
  const single = answerbudget.compose([
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
    { id: 'card', kind: 'workflow', rank: 30, order: 1, forms: ['W'.repeat(100)], holdBack: 10000 },
  ], { budget: 400, sanitize: plain });
  assert.equal(single.chosen.some((c) => c.id === 'card'), true, 'a single form ignores holdBack');
});

// --- B. the start ------------------------------------------------------------------------------------------------

function world(t, { procedures = 0, learnings = 12 } = {}) {
  const root = tempDir('cm-vz-', t);
  const run = (...a) => {
    const r = spawnSync(process.execPath, [MEM, '--root', root, ...a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  run('init');
  for (let i = 0; i < procedures; i += 1) {
    run('log', 'procedure', '--title', `Rule number ${i}`, '--rule', `Rule ${i}: ${'keep the tree clean and the branch small. '.repeat(13)}`,
      '--issued-by', 'owner', '--tags', 'subagent-start', '--start-as', 'released');
  }
  for (let i = 0; i < learnings; i += 1) run('log', 'learning', '--title', `Learning ${i}`, '--text', 'some detail '.repeat(30));
  return root;
}
const card = () => workflowdetect.cardText({ id: 'wf000001', title: 'Release procedure', issued_by: 'owner', status: 'released',
  steps: Array.from({ length: 9 }, (_, i) => `Step ${i} ${'does a thing '.repeat(8)}`) });
const ruleText = (i) => `Rule ${i}: ${'keep the tree clean and the branch small. '.repeat(13)}`.trimEnd();
const wholeRules = (text, n) => Array.from({ length: n }, (_, i) => i).filter((i) => text.includes(ruleText(i)));

async function baseModules(t) {
  const old = tempDir('cm-vz-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], old);
  return import(pathToFileURL(path.join(old, 'src', 'subagentstart.mjs')).href);
}
const cardBlock = () => `${subagentstart.WORKFLOW_LEAD}\n${card()}`;
const cardWhole = (text) => text.includes('Step 8');
const cardPointer = (text) => /mem workflow show wf000001/.test(text) && !text.includes('Step 8');

test('B1: procedures and a large card, the card does not fit next to them: the procedures stand whole, the card is its pointer, the recap still stands (RED at the old commit)', async (t) => {
  const root = world(t, { procedures: 3 });
  const sel = subagentstart.select(root, { workflowBlock: cardBlock() });
  assert.ok(sel.bytes <= answerbudget.ANSWER_BYTES, `${sel.bytes} bytes`);
  assert.deepEqual(wholeRules(sel.text, 3), [0, 1, 2], 'every rule stands whole');
  assert.equal(cardPointer(sel.text), true, 'the card is its pointer');
  assert.match(sel.text, /cheap-mem context/, 'the recap stands');
  assert.match(sel.note, /1 workflow as a pointer only/);
  assert.equal(sel.chosen.find((c) => c.kind === 'workflow').form, 1);
  // RED at the old commit: the card stood whole and the last rule was only a pointer. Positive control: the old text
  // is a start that does exceed what the card plus the rules leave (a rule as a pointer), so the probe measures something.
  const old = await baseModules(t);
  const was = old.select(root, { workflowBlock: cardBlock() });
  assert.equal(cardWhole(was.text), true, 'old: the card stood whole');
  assert.ok(wholeRules(was.text, 3).length < 3, `old: ${wholeRules(was.text, 3).length} of 3 rules whole`);
  assert.match(was.text, /pointer - the rule did not fit this block/, 'old: a rule was a pointer');
});

test('B2: still tighter: the card is its pointer and the recap is shortened away FIRST; the procedures stay whole', async (t) => {
  const root = world(t, { procedures: 4 });
  const sel = subagentstart.select(root, { workflowBlock: cardBlock() });
  assert.ok(sel.bytes <= answerbudget.ANSWER_BYTES, `${sel.bytes} bytes`);
  assert.deepEqual(wholeRules(sel.text, 4), [0, 1, 2, 3], 'every rule stands whole');
  assert.equal(cardPointer(sel.text), true, 'the card is its pointer');
  assert.equal(sel.chosen.some((c) => c.kind === 'recap'), false, 'the recap gave way');
  assert.match(sel.note, /recap left out/);
  const old = await baseModules(t);
  const was = old.select(root, { workflowBlock: cardBlock() });
  assert.equal(cardWhole(was.text), true, 'old: the card stood whole');
  assert.ok(wholeRules(was.text, 4).length < 4, 'old: a rule was only a pointer');
});

test('B3: many procedures: the first ones whole, the rest at least a pointer with its id, the card a pointer, the recap gone; nothing left out', (t) => {
  const root = world(t, { procedures: 12 });
  const sel = subagentstart.select(root, { workflowBlock: cardBlock() });
  const whole = wholeRules(sel.text, 12);
  assert.deepEqual(sel.omitted.filter((o) => o.kind === 'procedure'), [], 'no procedure fell away');
  assert.ok(whole.length >= 1 && whole.length < 12, `${whole.length} whole: the case must make some pointers to prove anything`);
  assert.deepEqual(whole, whole.map((_, i) => i), 'the whole ones are the first ones, in their own order');
  const procs = sel.chosen.filter((c) => c.kind === 'procedure');
  assert.equal(procs.length, 12, 'every procedure is in the text');
  assert.equal(procs.filter((c) => c.form === 0).length, whole.length);
  for (const c of procs.filter((x) => x.form === 1)) assert.ok(sel.text.includes(`mem show ${c.id}`), `the pointer of ${c.id} names its id`);
  assert.equal(cardPointer(sel.text), true);
  assert.match(sel.text, /component <path>/, 'the hint is in');
});

test('B4: a start that fits is byte for byte the old one (card whole, nothing stepped down, no note)', async (t) => {
  const root = world(t, { procedures: 2 });
  const old = await baseModules(t);
  const want = old.select(root, { workflowBlock: cardBlock() });
  const got = subagentstart.select(root, { workflowBlock: cardBlock() });
  assert.ok(want.bytes <= answerbudget.ANSWER_BYTES && want.note === null, `the case fits the old budget: ${want.bytes}`);
  // The closing hint names the path of the tool; the old code was exported to another directory, so that path (and with it
  // the number in the recap's footer) differs by exactly its length. Nothing else may differ.
  const tool = (x) => x.replace(/node \S+ --root/, 'node TOOL --root').replace(/--- budget \d+ chars \(~\d+ tokens/, '--- budget N chars (~N tokens');
  assert.equal(tool(got.text), tool(want.text));
  assert.equal(got.note, null);
  assert.equal(cardWhole(got.text), true, 'the card is whole');
  assert.equal(got.chosen.find((c) => c.kind === 'workflow').form, 0);
});

test('B5: the assignment block outranks the card: its lines stay whole and the card is its pointer (RED at the old commit)', async (t) => {
  const root = world(t, { procedures: 2, learnings: 0 });
  const items = [0, 1, 2, 3].map((i) => ({ id: `ord${i}aaaa`, line: `- [error ord${i}aaaa] ${'text '.repeat(60)}`,
    pointer: `- [error ord${i}aaaa] t [pointer - full text: mem show ord${i}aaaa]` }));
  const opts = { workflowBlock: cardBlock(), taskForms: subagenttask.blockForms({ items }) };
  const sel = subagentstart.select(root, opts);
  assert.ok(sel.bytes <= answerbudget.ANSWER_BYTES, `${sel.bytes} bytes`);
  assert.deepEqual(wholeRules(sel.text, 2), [0, 1]);
  assert.equal(items.filter((i) => sel.text.includes(i.line)).length, 4, 'every assignment line is whole');
  assert.equal(cardPointer(sel.text), true, 'the card is its pointer');
  const old = await baseModules(t);
  const was = old.select(root, opts);
  assert.equal(cardWhole(was.text), true, 'old: the card stood whole');
  assert.ok(items.filter((i) => was.text.includes(i.line)).length < 4, 'old: assignment lines had stepped down to pointers');
});

test('B6: the workflow mark is taken back when the card came as a pointer (hookResultFor path keeps working with the new order)', (t) => {
  const root = world(t, { procedures: 4 });
  const sel = subagentstart.select(root, { workflowBlock: cardBlock() });
  const seen = sel.chosen.find((c) => c.ref === 'workflow');
  assert.ok(seen && seen.form > 0, 'the card is a pointer here: hookResultFor sees form > 0 and forgets the mark');
});

// --- C. source guards --------------------------------------------------------------------------------------------

test('C1: the ranks are the sibling\'s order: procedures, assignment block, card (held back for the recap), recap', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'subagentstart.mjs'), 'utf8');
  const rank = (name) => Number(new RegExp(`const RANK_${name} = (\\d+);`).exec(src)?.[1]);
  assert.ok(rank('PROCEDURE') < rank('ASSIGNMENT') && rank('ASSIGNMENT') < rank('WORKFLOW') && rank('WORKFLOW') < rank('RECAP'),
    `procedure ${rank('PROCEDURE')}, assignment ${rank('ASSIGNMENT')}, workflow ${rank('WORKFLOW')}, recap ${rank('RECAP')}`);
  assert.match(src, /card\.holdBack = /, 'the card holds back the bytes of the whole recap');
  assert.doesNotMatch(src, /rank: 20 \+ i/, 'the procedures no longer rank one after the other (the 11th would fall behind the assignment block)');
});

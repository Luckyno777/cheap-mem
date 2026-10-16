// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// abruf-budget-cm (recall trunk, steps 4 and 5): ONE final selection under ONE byte budget for the answer of the
// prompt hook and of the SubagentStart hook (src/answerbudget.mjs), and `mem_find` on the core of `mem find`
// (src/findcore.mjs).
//
// The finding. The prompt hook put header, clone line, hit lines, skill offer and workflow block together with no
// budget common to them; the subagent start capped only its recap (characters) and its assignment block (1,500
// bytes) and joined the workflow block, the procedures and the hint in front without a bound. And the MCP tool
// `mem_find` carried its own copy of "ask the index": no exact lane, no echo filter, no MMR, the query pinned to
// the memory's configured language: the same question gave other hits at the other door.
//
//   A. the selection itself (pure): fits, steps down to pointers in rank order, the note, fixed parts, elastic part,
//      mask before measure, order independence;
//   B. the prompt hook against the base (`recallhook.recall`): equal under the budget, RED at the base over it;
//   C. the subagent start against the base: the same;
//   D. the workflow mark: a card that did not arrive whole is not marked as seen;
//   E. `mem_find` and `mem find` answer the same question with the same hits (RED at the base);
//   F. source guards (one place decides).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as answerbudget from '../src/answerbudget.mjs';
import * as recallhook from '../src/recallhook.mjs';
import * as subagentstart from '../src/subagentstart.mjs';
import * as subagenttask from '../src/subagenttask.mjs';
import * as workflowdetect from '../src/workflowdetect.mjs';
import * as wfpointer from '../src/workflowpointer.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
// The base: the tip of kette/cm before this work (the budget did not exist).
const BASE = 'f5ee47b42e60119c0b54a46506db399883e08b62';
const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const ctx = (r) => r?.out?.hookSpecificOutput?.additionalContext ?? '';

// --- A. the selection --------------------------------------------------------------

const plain = (s) => s;

test('A1: under the budget the text is the parts joined with their own separators, in text order, with no note', () => {
  const sel = answerbudget.compose([
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
    { id: 'a', kind: 'hit', rank: 10, order: 10, sep: '\n', forms: ['line a', 'ptr a'] },
    { id: 'b', kind: 'hit', rank: 11, order: 11, sep: '\n', forms: ['line b', 'ptr b'] },
    { id: 'w', kind: 'workflow', rank: 50, order: 110, forms: ['WF', 'wf ptr'] },
  ], { sanitize: plain });
  assert.equal(sel.text, 'HEAD\nline a\nline b\n\nWF');
  assert.equal(sel.note, null);
  assert.deepEqual(sel.pointers, []);
  assert.deepEqual(sel.omitted, []);
});

test('A2: over the budget the part allocated LAST steps down first; a pointer, then nothing; one note says how many and how to fetch', () => {
  const big = (n) => `line ${n} ${'x'.repeat(400)}`;
  const parts = [
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
    ...[0, 1, 2, 3].map((i) => ({ id: `e${i}`, kind: 'hit', rank: 10 + i, order: 10 + i, sep: '\n',
      forms: [big(i), `ptr e${i}`], how: 'mem show <id>' })),
    { id: 'w', kind: 'workflow', rank: 50, order: 110, forms: ['W'.repeat(900), 'wf pointer'], how: 'mem workflow show <id>' },
  ];
  const sel = answerbudget.compose(parts, { budget: 1000, sanitize: plain });
  assert.ok(sel.bytes <= 1000, `${sel.bytes} bytes`);
  assert.deepEqual(sel.chosen.filter((c) => c.kind === 'hit').map((c) => [c.id, c.form]), [['e0', 0], ['e1', 0], ['e2', 1], ['e3', 1]],
    'the best-ranked hits stay whole, the later ones are pointers');
  assert.equal(sel.chosen.find((c) => c.kind === 'workflow').form, 1, 'the workflow card is a pointer');
  assert.match(sel.text, /ptr e3/);
  assert.match(sel.note, /3 as a pointer only|2 hits, 1 workflow as a pointer only/);
  assert.match(sel.note, /mem show <id>/);
  assert.match(sel.note, /mem workflow show <id>/);
  assert.ok(sel.text.endsWith(sel.note), 'the note closes the text');
  // Even smaller: pointers fall away too, and the note counts them as left out.
  const tiny = answerbudget.compose(parts, { budget: 150, sanitize: plain });
  assert.ok(tiny.bytes <= 150 + bytes('HEAD'), `${tiny.bytes} bytes`);
  assert.ok(tiny.omitted.length >= 1, 'something fell away');
  assert.match(tiny.note, /left out/);
});

test('A3: a fixed part is always in; only fixed parts can push the text over the budget', () => {
  const sel = answerbudget.compose([
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['H'.repeat(300)] },
    { id: 'x', kind: 'hit', rank: 1, order: 1, sep: '\n', forms: ['y'.repeat(50)] },
  ], { budget: 100, sanitize: plain });
  assert.ok(sel.text.startsWith('H'.repeat(300)), 'the fixed part is in');
  assert.equal(sel.over, true, 'and it is reported as over');
  assert.deepEqual(sel.omitted.map((o) => o.id), ['x']);
});

test('A4: an elastic part takes what is left, counted in BYTES (a multi-byte text is refused when it overruns)', () => {
  const sel = answerbudget.compose([
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['H'.repeat(100)] },
    { id: 'r', kind: 'recap', rank: 40, order: 1, fill: (room) => 'e'.repeat(Math.max(0, room - 10)) },
  ], { budget: 500, sanitize: plain });
  assert.ok(sel.bytes <= 500);
  const wide = answerbudget.compose([
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['H'.repeat(100)] },
    { id: 'r', kind: 'recap', rank: 40, order: 1, fill: (room) => 'ä'.repeat(room) }, // 2 bytes each: twice the room
  ], { budget: 500, sanitize: plain });
  assert.ok(wide.bytes <= 500, `${wide.bytes} bytes`);
  assert.deepEqual(wide.omitted.map((o) => o.id), ['r'], 'a fill that overruns its room in bytes is not taken');
});

test('A5: mask, then measure, then never cut: a key shape is masked before its bytes are counted and no stump of it ever stands', () => {
  const key = `ghp_${'a1B2c3D4e5'.repeat(4)}`; // 44 characters, a token shape the output guard knows
  const form = `note ${key} end`;
  for (const budget of [40, 60, 80, 120, 400]) {
    const sel = answerbudget.compose([
      { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
      { id: 'k', kind: 'hit', rank: 1, order: 1, sep: '\n', forms: [form, `ptr ${key}`] },
    ], { budget });
    assert.ok(!/ghp_/.test(sel.text), `budget ${budget}: no key prefix in ${JSON.stringify(sel.text)}`);
    assert.ok(!/a1B2c3D4e5/.test(sel.text), `budget ${budget}: no part of the key`);
    assert.ok(sel.bytes <= Math.max(budget, bytes('HEAD')) || sel.omitted.length, `budget ${budget}: ${sel.bytes} bytes`);
    if (sel.chosen.some((c) => c.id === 'k')) assert.match(sel.text, /\[REDACTED/, 'what is shown is the masked form');
  }
});

test('A6: the same parts in any input order give the same text', () => {
  const parts = [
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
    ...[0, 1, 2].map((i) => ({ id: `e${i}`, kind: 'hit', rank: 10 + i, order: 10 + i, sep: '\n', forms: [`line ${'x'.repeat(300)}${i}`, `ptr ${i}`] })),
  ];
  const a = answerbudget.compose(parts, { budget: 700, sanitize: plain });
  const b = answerbudget.compose([...parts].reverse(), { budget: 700, sanitize: plain });
  assert.equal(a.text, b.text);
});

test('A7: the note counts in the budget (a degraded text, note included, is within the budget)', () => {
  for (let budget = 150; budget <= 900; budget += 37) {
    const sel = answerbudget.compose([
      { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
      ...[0, 1, 2, 3, 4].map((i) => ({ id: `e${i}`, kind: 'hit', rank: 10 + i, order: 10 + i, sep: '\n',
        forms: [`line ${i} ${'x'.repeat(170)}`, `ptr ${i} ${'y'.repeat(40)}`], how: 'mem show <id>' })),
    ], { budget, sanitize: plain });
    assert.ok(sel.bytes <= budget, `budget ${budget}: ${sel.bytes} bytes`);
  }
});

// --- B. the prompt hook against the base -----------------------------------------------

function hitFor(i, { size = 200 } = {}) {
  return { score: 20 - i, source: 'global/learnings.jsonl', line: i + 1, entry: {
    id: `lrn${i}aaaa`, ts: '2026-09-01T00:00:00Z', title: `Learning number ${i}`, text: `${'detail '.repeat(Math.ceil(size / 7))}`.trim(), class: 'wrong-cause' } };
}
const hitsJson = (n, opts) => JSON.stringify({ hits: Array.from({ length: n }, (_, i) => hitFor(i, opts)) });
const bigCard = (steps) => {
  const e = { id: 'wf000001', title: 'Release procedure', steps: Array.from({ length: steps }, (_, i) => `Step ${i} ${'does a thing '.repeat(8)}`),
    issued_by: 'owner', status: 'released' };
  return workflowdetect.cardText(e);
};
const OFFER = { line: 'Skill release-notes fits (mem_skill_fetch release-notes)\n  Account: it works when the tag is set first.\n  Account: it fails on a dirty tree.',
  ids: ['skl000001'], names: ['release-notes'], accountIds: ['acc000001', 'acc000002'] };

async function baseModules(t) {
  const old = tempDir('cm-ab-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], old);
  return {
    dir: old,
    recallhook: await import(pathToFileURL(path.join(old, 'src', 'recallhook.mjs')).href),
    subagentstart: await import(pathToFileURL(path.join(old, 'src', 'subagentstart.mjs')).href),
  };
}

test('B1: under the budget the hook answer is byte for byte the base\'s (nothing is cut that fitted)', async (t) => {
  const base = await baseModules(t);
  for (const n of [1, 3, 5]) {
    for (const env of [{}, { MEM_SEARCH_LEVERS: 'h5' }, { MEM_RH_WORKFLOW: bigCard(3) }]) {
      for (const offer of [null, OFFER]) {
        const e = { ...env };
        const want = base.recallhook.recall('/nonexistent-root', hitsJson(n, { size: 120 }), e, { offer });
        const got = recallhook.recall('/nonexistent-root', hitsJson(n, { size: 120 }), e, { offer });
        assert.ok(bytes(ctx(want)) < answerbudget.ANSWER_BYTES, 'the case is under the budget');
        assert.equal(ctx(got), ctx(want), `${n} hits, ${JSON.stringify(Object.keys(env))}, offer ${Boolean(offer)}`);
      }
    }
  }
});

test('B2: RED at the base - a long workflow card, long hits and a skill offer made the answer grow past any bound; now it is held to 3200 bytes with pointers and a note', async (t) => {
  const base = await baseModules(t);
  const env = { MEM_RH_WORKFLOW: bigCard(10) };
  assert.ok(bytes(env.MEM_RH_WORKFLOW) > 1000 && bytes(env.MEM_RH_WORKFLOW) < 1500, `the card: ${bytes(env.MEM_RH_WORKFLOW)} bytes`);
  const was = base.recallhook.recall('/nonexistent-root', hitsJson(5, { size: 290 }), { ...env }, { offer: OFFER });
  const now = recallhook.recall('/nonexistent-root', hitsJson(5, { size: 290 }), { ...env }, { offer: OFFER });
  assert.ok(bytes(ctx(was)) > answerbudget.ANSWER_BYTES, `base: ${bytes(ctx(was))} bytes (the case must exceed the budget to prove anything)`);
  assert.ok(bytes(ctx(now)) <= answerbudget.ANSWER_BYTES, `now: ${bytes(ctx(now))} bytes`);
  const text = ctx(now);
  assert.match(text, /Held to 3200 bytes/, 'a note says it');
  for (let i = 0; i < 5; i += 1) assert.ok(text.includes(`lrn${i}aaaa`), `hit ${i} is still named by its id (whole or as a pointer)`);
  assert.match(text, /mem show lrn4aaaa/, 'the last hit is a pointer with the way to the full entry');
  assert.ok(text.includes('lrn0aaaa') && /Learning number 0/.test(text), 'the best hit stays whole');
});

test('B3: the hits are the core: they step down before the workflow card is touched only when the card is smaller; the order of giving way is skill hint, workflow, then the later hits', () => {
  // A card of ~1.4 KB with three whole hits would not fit: the later hits become pointers FIRST (they are allocated
  // before the workflow in the rank order), the card is a pointer only when even that does not leave room.
  const env = { MEM_RH_WORKFLOW: bigCard(10) };
  const r = recallhook.recall('/nonexistent-root', hitsJson(3, { size: 290 }), env, { offer: OFFER });
  const text = ctx(r);
  assert.ok(text.includes('Release procedure'), 'the workflow is named');
  // Starve the budget further: more hits of full size push the skill hint out before the workflow.
  const r2 = recallhook.recall('/nonexistent-root', hitsJson(5, { size: 290 }), { ...env }, { offer: OFFER });
  assert.ok(bytes(ctx(r2)) <= answerbudget.ANSWER_BYTES);
  const hasHint = ctx(r2).includes('Skill release-notes fits');
  const hasWf = ctx(r2).includes('Release procedure');
  assert.ok(hasWf || !hasHint, 'the skill hint never outlasts the workflow');
});

test('B4: the journal line says what was DELIVERED: hits as pointers count (their id stands in the text), hits that fell away do not', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ab-journal-'));
  try {
    const env = { MEM_RH_SESSION: 's-ab4', MEM_RH_TURNS: path.join(root, 'turns'), MEM_RH_WORKFLOW: bigCard(10) };
    const r = recallhook.recall(root, hitsJson(5, { size: 290 }), env, { offer: OFFER });
    const text = ctx(r);
    r.book();
    const lines = fs.readFileSync(path.join(root, '.pipeline', 'injections.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const line = lines.find((l) => l.occasion === 'question');
    assert.ok(line, 'a question line was booked');
    const named = ['lrn0aaaa', 'lrn1aaaa', 'lrn2aaaa', 'lrn3aaaa', 'lrn4aaaa'].filter((id) => text.includes(id));
    assert.equal(line.hits, named.length, 'hits = the hits whose id stands in the text');
    for (const id of named) assert.ok(JSON.stringify(line).includes(id), `${id} is booked`);
    assert.ok(line.bytes <= answerbudget.ANSWER_BYTES + 200, `${line.bytes} bytes (JSON envelope)`);
    // Many more hits than the budget has room for even as pointers: those that fell away are NOT booked as shown.
    const env2 = { ...env, MEM_RH_SESSION: 's-ab4b', MEM_RH_TURNS: path.join(root, 'turns2') };
    const wide = JSON.stringify({ hits: Array.from({ length: 60 }, (_, i) => hitFor(i, { size: 120 })) });
    const r2 = recallhook.recall(root, wide, env2, {});
    const text2 = ctx(r2);
    r2.book();
    const named2 = Array.from({ length: 60 }, (_, i) => `lrn${i}aaaa`).filter((id) => text2.includes(id));
    assert.ok(named2.length > 5 && named2.length < 60, `${named2.length} of 60 named: the case must drop some to prove anything`);
    const line2 = fs.readFileSync(path.join(root, '.pipeline', 'injections.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((l) => l.occasion === 'question').pop();
    assert.equal(line2.hits, named2.length, 'booked hits = hits named in the text');
    assert.match(text2, /left out/, 'and the note says some were left out');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- C. the subagent start against the base --------------------------------------------------

function agentWorld(t) {
  const root = tempDir('cm-ab-agent-', t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return root;
}
const logProcedure = (root, title, rule) => {
  const r = spawnSync(process.execPath, [MEM, '--root', root, 'log', 'procedure', '--title', title, '--rule', rule,
    '--issued-by', 'owner', '--tags', 'subagent-start', '--start-as', 'released'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};

test('C1: a small start is byte for byte the base\'s (nothing is cut that fitted)', async (t) => {
  const base = await baseModules(t);
  const root = agentWorld(t);
  logProcedure(root, 'Own worktree', 'Every assignment gets its own worktree and branch.');
  const want = base.subagentstart.buildContext(root);
  const got = subagentstart.buildContext(root);
  assert.ok(bytes(want) < answerbudget.ANSWER_BYTES);
  // The recap prints the budget it was handed ("--- budget N chars ..."): 3200 bytes for the whole start instead of
  // 4000 characters changes that one number and nothing else when everything fitted.
  const footer = (x) => x.replace(/--- budget \d+ chars \(~\d+ tokens/, '--- budget N chars (~N tokens').replace(/node \S+ --root/, 'node TOOL --root');
  assert.equal(footer(got), footer(want));
  assert.match(got, /everything fitted/);
});

test('C2: RED at the base - a long workflow card, a long procedure and an assignment block summed past any bound; now the start is held to 3200 bytes', async (t) => {
  const base = await baseModules(t);
  const root = agentWorld(t);
  logProcedure(root, 'Release rule', `Check the changelog. ${'Then check it again. '.repeat(60)}`);
  const workflowBlock = `${subagentstart.WORKFLOW_LEAD}\n${bigCard(10)}`;
  const items = Array.from({ length: 4 }, (_, i) => ({ id: `tsk${i}aaaa`, line: `- [error tsk${i}aaaa] ${'long error text '.repeat(18)}`, pointer: `- [error tsk${i}aaaa] long error text [pointer - full text: mem show tsk${i}aaaa]` }));
  const taskBlock = `${subagenttask.HEADER}\n${items.map((i) => i.line).join('\n')}`;
  const was = base.subagentstart.buildContext(root, { workflowBlock, taskBlock });
  const now = subagentstart.buildContext(root, { workflowBlock, taskBlock, taskForms: subagenttask.blockForms({ items }) });
  assert.ok(bytes(was) > answerbudget.ANSWER_BYTES, `base: ${bytes(was)} bytes (the case must exceed the budget to prove anything)`);
  assert.ok(bytes(now) <= answerbudget.ANSWER_BYTES, `now: ${bytes(now)} bytes`);
  assert.match(now, /component <path>/, 'the closing hint is always in');
  assert.match(now, /Held to 3200 bytes/, 'and a note says what stepped down');
});

test('C3: a procedure longer than the whole budget comes as a pointer with its id (it was shown whole and uncapped before); the hint and the marking stay', async (t) => {
  const root = agentWorld(t);
  logProcedure(root, 'Huge rule', 'x'.repeat(subagentstart.CAP_BYTES * 2));
  const text = subagentstart.buildContext(root);
  assert.ok(bytes(text) <= subagentstart.CAP_BYTES, `${bytes(text)} bytes`);
  assert.match(text, /Procedure, issued by owner/, 'the marking stays');
  assert.match(text, /Huge rule/);
  assert.match(text, /pointer - the rule did not fit this block: mem show [a-z0-9]+/);
  assert.match(text, /component <path>/);
});

test('C4: the order of giving way: the recap first (it takes what is left), then the assignment lines, then procedures, then the workflow', async (t) => {
  const root = agentWorld(t);
  logProcedure(root, 'Rule A', 'Keep the tree clean.');
  const items = [0, 1, 2, 3].map((i) => ({ id: `ord${i}aaaa`, line: `- [error ord${i}aaaa] ${'text '.repeat(60)}`, pointer: `- [error ord${i}aaaa] t [pointer - full text: mem show ord${i}aaaa]` }));
  const withTask = subagentstart.buildContext(root, { taskForms: subagenttask.blockForms({ items }) });
  const withoutTask = subagentstart.buildContext(root);
  assert.ok(bytes(withTask) <= subagentstart.CAP_BYTES);
  assert.ok(withTask.includes('Keep the tree clean.'), 'the procedure stays whole');
  for (const i of [0, 1, 2, 3]) assert.ok(withTask.includes(`ord${i}aaaa`), 'every assignment line is named');
  assert.ok(withTask.includes(`${'text '.repeat(60)}`.trim().slice(0, 40)), 'the first line is whole');
  assert.ok(bytes(withoutTask) <= subagentstart.CAP_BYTES);
});

test('C6: the recap is asked in BYTES: a memory of multi-byte text still ends within the budget', (t) => {
  const root = agentWorld(t);
  for (let i = 0; i < 12; i += 1) {
    const r = spawnSync(process.execPath, [MEM, '--root', root, 'log', 'error', '--class', 'wrong-cause', '--title', `\u8a2d\u5b9a\u30a8\u30e9\u30fc ${i}`,
      '--text', '\u8a2d\u5b9a\u30d5\u30a1\u30a4\u30eb\u304c\u58ca\u308c\u3066\u3044\u308b'.repeat(40)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  const text = subagentstart.buildContext(root);
  assert.ok(bytes(text) <= subagentstart.CAP_BYTES, `${bytes(text)} bytes`);
  assert.match(text, /cheap-mem context/, 'the recap is there (it took what was left)');
});

test('C5: the pointer form of a workflow card round-trips (title and id come back out of the card text)', () => {
  const card = bigCard(2);
  assert.equal(wfpointer.isCard(card), true);
  const ptr = wfpointer.pointerForm(card);
  assert.match(ptr, /Release procedure/);
  assert.match(ptr, /mem workflow show wf000001/);
  assert.equal(wfpointer.isCard(ptr), false, 'a pointer is not a card');
  assert.match(wfpointer.pointerForm(workflowdetect.tieText([{ id: 'a1', title: 'A' }, { id: 'b2', title: 'B' }])), /^2 workflows match this message equally well/);
  assert.equal(wfpointer.pointerForm('some other text'), null);
});

// --- D. the workflow mark ------------------------------------------------------------------------

function markWorld(t) {
  const root = tempDir('cm-ab-mark-', t);
  const marks = path.join(root, 'marks');
  fs.mkdirSync(marks, { recursive: true });
  return { root, marks, file: wfpointer.markFile(root, 's-mark', 'wf000001', { MEM_WORKFLOW_MARKS: marks }) };
}

test('D1: a card the selection turned into a pointer was NOT seen: its mark is taken back, the next message offers it again', (t) => {
  const { root, marks, file } = markWorld(t);
  const env = { MEM_RH_SESSION: 's-mark', MEM_RH_TURNS: path.join(root, 'turns'), MEM_WORKFLOW_MARKS: marks, MEM_RH_WORKFLOW: bigCard(10) };
  fs.writeFileSync(file, JSON.stringify({ level: 1, fingerprint: 'x', shown: 1 }));
  const r = recallhook.recall(root, hitsJson(5, { size: 290 }), env, { offer: OFFER });
  assert.ok(r.out, 'an answer');
  assert.equal(r.out && ctx(r).includes('Step 9'), false, 'the card did not arrive whole');
  r.book();
  assert.equal(fs.existsSync(file), false, 'its mark is gone');
});

test('D2: a card that arrived whole keeps its mark', (t) => {
  const { root, marks, file } = markWorld(t);
  const env = { MEM_RH_SESSION: 's-mark', MEM_RH_TURNS: path.join(root, 'turns'), MEM_WORKFLOW_MARKS: marks, MEM_RH_WORKFLOW: bigCard(3) };
  fs.writeFileSync(file, JSON.stringify({ level: 1, fingerprint: 'x', shown: 1 }));
  const r = recallhook.recall(root, hitsJson(1, { size: 100 }), env, {});
  assert.ok(ctx(r).includes('Step 2'), 'the whole card is in');
  r.book();
  assert.equal(fs.existsSync(file), true, 'the mark stays');
});

test('D3: the workflow alone (no hits) is held to the budget too: a tie list of many titles becomes one line; the mark of a lost card is taken back', (t) => {
  const { root, marks } = markWorld(t);
  const many = Array.from({ length: 120 }, (_, i) => ({ id: `wfx${String(i).padStart(5, '0')}`, title: `Workflow title number ${i} ${'padding '.repeat(4)}` }));
  const env = { MEM_RH_SESSION: 's-tie', MEM_RH_TURNS: path.join(root, 'turns'), MEM_WORKFLOW_MARKS: marks, MEM_RH_WORKFLOW: workflowdetect.tieText(many) };
  assert.ok(bytes(env.MEM_RH_WORKFLOW) > answerbudget.ANSWER_BYTES, 'the tie list alone is over the budget');
  const r = recallhook.recall(root, JSON.stringify({ hits: [] }), env, {});
  assert.ok(r.out, 'an answer');
  assert.ok(bytes(ctx(r)) <= answerbudget.ANSWER_BYTES, `${bytes(ctx(r))} bytes`);
  assert.match(ctx(r), /120 workflows match this message equally well/);
});

test('D4: a card over its own limit comes as a pointer from the start (and is marked as shown, so it comes once)', async (t) => {
  const root = agentWorld(t);
  const steps = Array.from({ length: 40 }, (_, i) => `Step ${i} ${'does a thing '.repeat(6)}`);
  memory.logEntry(root, 'workflow', { title: 'Huge flow', steps, triggers: ['ship the huge flow'], issued_by: 'owner' });
  const env = { MEM_WORKFLOW_MARKS: path.join(root, 'marks') };
  const run = () => workflowdetect.forText(root, 'please ship the huge flow now', { session: 's-size', env });
  const first = await run();
  assert.ok(first, 'a workflow matched');
  assert.ok(bytes(first.text) < workflowdetect.CARD_MAX_BYTES, `${bytes(first.text)} bytes: a pointer, not the card`);
  assert.match(first.text, /too long for this block/);
  assert.match(first.text, /mem workflow show /);
  const second = await run();
  assert.match(second.text, /already shown in this session/, 'the second time is the usual back-reference');
});

// --- E. mem_find and mem find answer the same ----------------------------------------------------------

function mcpFind(codeDir, root, args) {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_find', arguments: args } }),
  ];
  const r = spawnSync(process.execPath, [path.join(codeDir, 'bin', 'mem-mcp')], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  const reply = String(r.stdout).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === 2);
  const text = reply?.result?.content?.map((c) => c.text).join('\n') ?? '';
  return [...text.matchAll(/^(\S+:\d+)\s+\[[^\]]*\]\s+([\d.]+)/gm)].map((m) => `${m[1]}@${m[2]}`);
}
function cliFind(codeDir, root, query, extra = []) {
  const r = spawnSync(process.execPath, [path.join(codeDir, 'bin', 'mem'), '--root', root, 'find', query, '--json', ...extra], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hits.map((h) => `${h.source}:${h.line}@${h.score.toFixed(2)}`);
}

function findWorld(t) {
  const root = tempDir('cm-ab-find-', t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const log = (...a) => { const r = spawnSync(process.execPath, [MEM, '--root', root, 'log', ...a], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  for (let i = 0; i < 6; i += 1) log('learning', '--title', `Retry the flaky upload variant ${i}`, '--text', 'The flaky upload retries three times with a growing pause and then gives up with a clear error.');
  log('decision', '--topic', 'upload pause', '--choice', 'growing pause', '--why', 'a fixed pause hammered the server');
  log('error', '--class', 'wrong-cause', '--title', 'Upload failed with code E4471 on the second retry', '--text', 'identifier E4471 appears only here');
  log('learning', '--title', 'Unrelated note about colours', '--text', 'blue is calmer than red');
  log('learning', '--title', 'Der Upload bricht ab', '--text', 'Beim Hochladen grosser Dateien bricht die Verbindung ab, dann hilft ein neuer Versuch.');
  log('learning', '--title', 'Zweiter Hinweis zum Hochladen', '--text', 'Dateien hochladen: die Verbindung wird getrennt, wenn der Versuch zu lange dauert.');
  return root;
}

test('E1: the same question over the CLI and over MCP gives the same hits in the same order (an exact identifier, near-duplicates, another language than the configured one, a type filter, a small top); ids, order and scores', (t) => {
  const root = findWorld(t);
  const cases = [
    ['flaky upload retry pause', []],
    ['upload', []],
    ['Datei hochladen Verbindung', []],
    ['Hochladen Verbindung abgebrochen', []],
    ['E4471', []],
    ['what happened with E4471 on the retry', []],
    ['flaky upload', ['--top', '3']],
    ['flaky upload', ['--type', 'learning']],
  ];
  const mcpArgs = (q, extra) => {
    const o = { query: q };
    for (let i = 0; i < extra.length; i += 2) o[extra[i].slice(2)] = extra[i] === '--top' ? Number(extra[i + 1]) : extra[i + 1];
    return o;
  };
  let compared = 0;
  for (const [q, extra] of cases) {
    const cli = cliFind(REPO, root, q, extra);
    const mcp = mcpFind(REPO, root, mcpArgs(q, extra));
    assert.ok(cli.length >= 1, `the case finds something: ${q}`);
    assert.deepEqual(mcp, cli, `${q} ${extra.join(' ')}`);
    compared += 1;
  }
  assert.equal(compared, cases.length);
  // MMR is on at BOTH doors: for a question with near-duplicates the default order differs from pure BM25 order (the
  // positive control), and the tool answers the default one.
  const mmr = cliFind(REPO, root, 'upload');
  const pure = cliFind(REPO, root, 'upload', ['--no-mmr']);
  assert.notDeepEqual(mmr, pure, 'MMR changes the order here (else this probe proves nothing)');
  assert.deepEqual(mcpFind(REPO, root, { query: 'upload' }), mmr);
});

test('E2: RED at the base - the MCP tool answered another list than the CLI for the same question (no exact lane, no MMR, other language handling)', async (t) => {
  const root = findWorld(t);
  const old = tempDir('cm-ab-find-base-', t);
  exportCommit(REPO, BASE, ['src', 'bin', 'package.json'], old);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules'), 'junction');
  let differ = 0;
  for (const q of ['what happened with E4471 on the retry', 'Datei hochladen Verbindung', 'Hochladen Verbindung abgebrochen', 'upload']) {
    const cli = cliFind(old, root, q);
    const mcp = mcpFind(old, root, { query: q });
    if (JSON.stringify(cli) !== JSON.stringify(mcp)) differ += 1;
  }
  assert.ok(differ >= 1, 'at the base at least one of these questions got different hits at the two doors');
});

// --- F. one place decides ---------------------------------------------------------------------------

const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('F1: both answers are put together by answerbudget.compose; mem find and mem_find call the one core', () => {
  assert.match(code('src/recallhook.mjs'), /answerbudget\.compose\(/);
  assert.match(code('src/subagentstart.mjs'), /answerbudget\.compose\(/);
  assert.match(code('src/cli/commands/search.mjs'), /findcore\.rankedFind\(/);
  assert.match(code('bin/mem-mcp'), /findcore\.rankedFind\(/);
  // No second copy of the search in either door: the MCP tool no longer calls the index search itself.
  const mcp = code('bin/mem-mcp');
  const toolBody = mcp.slice(mcp.indexOf("case 'mem_find':"), mcp.indexOf("case 'mem_duties':"));
  assert.doesNotMatch(toolBody, /search\.search\(/, 'mem_find calls the core, not search.search');
  assert.doesNotMatch(toolBody, /searchWithVariants\(/);
  const cli = code('src/cli/commands/search.mjs');
  const findBody = cli.slice(cli.indexOf('find: async'), cli.indexOf("'find-embed'"));
  assert.doesNotMatch(findBody, /searchFind\(|search\.exactHits\(|isEchoHit\(/, 'mem find calls the core for the ranked lane');
});

test('F2: the number is one: the hook and the subagent start share ANSWER_BYTES', () => {
  assert.equal(answerbudget.ANSWER_BYTES, 3200);
  assert.equal(subagentstart.CAP_BYTES, answerbudget.ANSWER_BYTES);
  assert.doesNotMatch(code('src/recallhook.mjs'), /\b3200\b/);
  assert.doesNotMatch(code('src/subagentstart.mjs'), /\b3200\b|\b4000\b/);
});

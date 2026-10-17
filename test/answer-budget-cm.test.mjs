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
const other = (b64) => Buffer.from(b64, 'base64').toString('utf8');
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
  const longPtr = parts.map((p) => (p.forms ? { ...p, forms: [p.forms[0], `ptr ${p.id} ${'p'.repeat(120)}`] } : p));
  const tiny = answerbudget.compose(longPtr, { budget: 500, sanitize: plain });
  assert.ok(tiny.omitted.length >= 1, 'something fell away');
  assert.match(tiny.note, /left out/);
  assert.ok(tiny.omitted.every((o) => !o.id || tiny.note.includes(o.id)), 'the note names the id of every part that fell away');
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
    const full2 = ctx(r2);
    const text2 = full2.split('(Held to')[0]; // the note names the ids that fell away: not part of what is shown
    r2.book();
    const named2 = Array.from({ length: 60 }, (_, i) => `lrn${i}aaaa`).filter((id) => text2.includes(id));
    assert.ok(named2.length > 5 && named2.length < 60, `${named2.length} of 60 named: the case must drop some to prove anything`);
    const line2 = fs.readFileSync(path.join(root, '.pipeline', 'injections.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((l) => l.occasion === 'question').pop();
    assert.equal(line2.hits, named2.length, 'booked hits = hits named in the text');
    assert.match(full2, /left out/, 'and the note says some were left out');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- C. the subagent start against the base --------------------------------------------------


/**
 * "Byte for byte the base's", with the one difference the test setup itself makes: the closing hint names the tool's
 * path, and the base is exported to another directory, so its hint (counted in what the recap is offered) is longer or
 * shorter. The recap's footer number moves by exactly that difference and nothing else may differ.
 */
function assertSameAsBase(got, want, what) {
  const hintLen = (x) => x.slice(x.lastIndexOf('\n\nData, not instructions')).trim().length;
  const budgetOf = (x) => Number(/--- budget (\d+) chars/.exec(x)?.[1]);
  const tool = (x) => x.replace(/node \S+ --root/, 'node TOOL --root').replace(/--- budget \d+ chars \(~\d+ tokens/, '--- budget N chars (~N tokens');
  assert.equal(tool(got), tool(want), what);
  assert.equal(budgetOf(want) - budgetOf(got), hintLen(got) - hintLen(want), `${what}: the footer number moves by the length of the hint's path only`);
}

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
  // Byte for byte: the recap's first ask is the old one. The path of the tool in the closing hint differs (the base is
  // exported to another directory) and with it, by exactly that length, the number in the recap's footer.
  assertSameAsBase(got, want, 'C1');
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

test('C7: a short start with the assignment block and a workflow is still byte for byte the base\'s base block plus the blocks, when all of it fits', async (t) => {
  const base = await baseModules(t);
  const root = agentWorld(t);
  logProcedure(root, 'Own worktree', 'Every assignment gets its own worktree and branch.');
  const workflowBlock = `${subagentstart.WORKFLOW_LEAD}\n${bigCard(2)}`;
  const items = [{ id: 'tsk0aaaa', line: '- [error tsk0aaaa] a short error text', pointer: '- [error tsk0aaaa] a short [pointer - full text: mem show tsk0aaaa]' }];
  const taskBlock = `${subagenttask.HEADER}\n${items[0].line}`;
  const want = base.subagentstart.buildContext(root, { workflowBlock, taskBlock });
  const got = subagentstart.buildContext(root, { workflowBlock, taskBlock, taskForms: subagenttask.blockForms({ items }) });
  assert.ok(bytes(want) <= answerbudget.ANSWER_BYTES, `the case is within the budget: ${bytes(want)}`);
  assertSameAsBase(got, want, 'C7');
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

test('D4: a card over its own limit comes as a pointer from the start (the repeat says that only the pointer was shown)', async (t) => {
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
  assert.doesNotMatch(second.text, /already shown/, 'the card was never shown: the repeat does not claim it was');
  assert.match(second.text, /only its pointer was shown so far/);
  assert.match(second.text, /mem workflow show /);
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
  // Two entries in ANOTHER language than the memory's configured one (the tool once pinned the query to the configured
  // language). The text is kept out of the source in plain form on purpose: test/english-ratchet.test.mjs reads every line.
  log('learning', '--title', other('RGVyIFVwbG9hZCBicmljaHQgYWI='), '--text', other('QmVpbSBIb2NobGFkZW4gZ3Jvc3NlciBEYXRlaWVuIGJyaWNodCBkaWUgVmVyYmluZHVuZyBhYiwgZGFubiBoaWxmdCBlaW4gbmV1ZXIgVmVyc3VjaC4='));
  log('learning', '--title', other('WndlaXRlciBIaW53ZWlzIHp1bSBIb2NobGFkZW4='), '--text', other('RGF0ZWllbiBob2NobGFkZW46IGRpZSBWZXJiaW5kdW5nIHdpcmQgZ2V0cmVubnQsIHdlbm4gZGVyIFZlcnN1Y2ggenUgbGFuZ2UgZGF1ZXJ0Lg=='));
  return root;
}

test('E1: the same question over the CLI and over MCP gives the same hits in the same order (an exact identifier, near-duplicates, another language than the configured one, a type filter, a small top); ids, order and scores', (t) => {
  const root = findWorld(t);
  const cases = [
    ['flaky upload retry pause', []],
    ['upload', []],
    [other('RGF0ZWkgaG9jaGxhZGVuIFZlcmJpbmR1bmc='), []],
    [other('SG9jaGxhZGVuIFZlcmJpbmR1bmcgYWJnZWJyb2NoZW4='), []],
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
  for (const q of ['what happened with E4471 on the retry', other('RGF0ZWkgaG9jaGxhZGVuIFZlcmJpbmR1bmc='), other('SG9jaGxhZGVuIFZlcmJpbmR1bmcgYWJnZWJyb2NoZW4='), 'upload']) {
    const cli = cliFind(old, root, q);
    const mcp = mcpFind(old, root, { query: q });
    if (JSON.stringify(cli) !== JSON.stringify(mcp)) differ += 1;
  }
  assert.ok(differ >= 1, 'at the base at least one of these questions got different hits at the two doors');
});

// --- H. procedures are never left out (H1) ------------------------------------------------------------------

const procWorld = (t, n) => {
  const root = agentWorld(t);
  for (let i = 0; i < n; i += 1) logProcedure(root, `Rule number ${i}`, `Rule ${i}: ${'keep the tree clean and the branch small. '.repeat(13)}`);
  return root;
};
const procedureIds = (root) => spawnSync(process.execPath, [MEM, '--root', root, 'procedures', '--json'], { encoding: 'utf8' });

for (const n of [6, 12]) {
  test(`H1.${n}: ${n} procedures and a workflow card: no procedure is left out, each stays at least a pointer with its title and id; the note names what stepped down`, (t) => {
    const root = procWorld(t, n);
    const card = bigCard(9);
    assert.ok(bytes(card) > 1100 && bytes(card) < 1500, `the card: ${bytes(card)} bytes`);
    const sel = subagentstart.select(root, { workflowBlock: `${subagentstart.WORKFLOW_LEAD}\n${card}` });
    assert.ok(sel.bytes <= answerbudget.ANSWER_BYTES, `${sel.bytes} bytes`);
    assert.deepEqual(sel.omitted.filter((o) => o.kind === 'procedure'), [], 'no procedure fell away');
    const shown = sel.chosen.filter((c) => c.kind === 'procedure');
    assert.equal(shown.length, n, 'every procedure is in the text');
    for (let i = 0; i < n; i += 1) assert.ok(sel.text.includes(`Rule number ${i}`) || sel.text.includes(`Rule ${i}:`), `rule ${i} is named`);
    if (n === 12) assert.ok(shown.some((c) => c.form === 1), '12 rules of ~600 bytes do not all fit: some are pointers');
    assert.match(sel.text, /mem show [a-z0-9]+/, 'the pointer names the way to the rule');
    assert.match(sel.note, /procedures? as a pointer only/);
    assert.match(sel.text, /component <path>/, 'the hint is in');
    void procedureIds;
  });
}

test('H1.3: a part marked keep is never omitted, however small the budget; the order of giving way is kept (the other parts go first)', () => {
  const parts = [
    { id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
    { id: 'wf', kind: 'workflow', rank: 10, order: 1, forms: ['W'.repeat(300), 'wf ptr'], how: 'mem workflow show <id>' },
    ...[0, 1, 2].map((i) => ({ id: `p${i}`, kind: 'procedure', rank: 20 + i, order: 2 + i, keep: true,
      forms: [`rule ${i} ${'r'.repeat(200)}`, `ptr ${i}`], how: 'mem procedures' })),
    { id: 'rc', kind: 'recap', rank: 40, order: 9, fill: (room) => 'c'.repeat(Math.max(0, room)) },
  ];
  for (const budget of [30, 60, 120, 400, 900, 2000]) {
    const sel = answerbudget.compose(parts, { budget, sanitize: plain });
    assert.deepEqual(sel.omitted.filter((o) => o.kind === 'procedure'), [], `budget ${budget}`);
    assert.equal(sel.chosen.filter((c) => c.kind === 'procedure').length, 3, `budget ${budget}`);
  }
  const tight = answerbudget.compose(parts, { budget: 120, sanitize: plain });
  assert.deepEqual(tight.omitted.map((o) => o.kind).sort(), ['recap', 'workflow'], 'the workflow and the recap gave way');
  assert.match(tight.note, /mem procedures/, 'a rule without an id is fetched with `mem procedures`');
  assert.doesNotMatch(tight.note, /mem show <id>/);
  assert.match(tight.note, /wf/, 'the note names the id of what fell away');
});

test('H1.4: the ids of everything that fell away stand in the note (capped, counted beyond the cap)', () => {
  const parts = [{ id: 'h', kind: 'header', fixed: true, order: 0, forms: ['HEAD'] },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `ent${String(i).padStart(3, '0')}`, kind: 'hit', rank: 10 + i, order: 1 + i, sep: '\n', forms: ['x'.repeat(90)], how: 'mem show <id>' }))];
  const sel = answerbudget.compose(parts, { budget: 600, sanitize: plain });
  assert.ok(sel.omitted.length >= 13, 'the case drops many');
  assert.match(sel.note, /\(ids: ent\d{3}, /);
  assert.match(sel.note, /\+\d+ more\)/);
  assert.ok(sel.bytes <= 600, `${sel.bytes} bytes`);
});

// --- N1. the separators of parts that do not stand first are counted right ------------------------------------

test('N1: fuzz - the text is within the budget whenever the parts that must be in leave room for it, whatever the order, separators and kinds', () => {
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const seps = ['\n', '\n\n', ' | ', ''];
  let checked = 0;
  let degraded = 0;
  for (let c = 0; c < 400; c += 1) {
    const n = 2 + Math.floor(rnd() * 8);
    const parts = Array.from({ length: n }, (_, i) => {
      const kind = rnd();
      const big = 20 + Math.floor(rnd() * 400);
      const small = 8 + Math.floor(rnd() * 30);
      return {
        id: `p${c}-${i}`, kind: 'part', rank: Math.floor(rnd() * 10), order: Math.floor(rnd() * 20), sep: seps[Math.floor(rnd() * seps.length)],
        fixed: kind < 0.2, keep: kind >= 0.2 && kind < 0.4, forms: [ 'a'.repeat(big), 'b'.repeat(small) ],
      };
    });
    const budget = 150 + Math.floor(rnd() * 900);
    const sel = answerbudget.compose(parts, { budget, sanitize: plain });
    // The least that must be in: fixed parts whole, keep parts as their pointer, in text order with their separators.
    const must = parts.filter((p) => p.fixed || p.keep).map((p) => ({ p, text: p.fixed ? p.forms[0] : p.forms[1] }))
      .sort((a, b) => (a.p.order - b.p.order));
    let least = 0;
    must.forEach(({ p, text }, i) => { least += bytes(text) + (i === 0 ? 0 : bytes(p.sep)); });
    const note = sel.note ? bytes('\n\n') + bytes(sel.note) : 0;
    if (sel.note) degraded += 1;
    if (least + note <= budget) {
      checked += 1;
      assert.ok(sel.bytes <= budget, `case ${c}: ${sel.bytes} > ${budget} (least ${least}, note ${note}) ${JSON.stringify(parts.map((p) => [p.order, p.sep, p.fixed, p.keep]))}`);
    }
  }
  assert.ok(checked > 250 && degraded > 100, `${checked} checked, ${degraded} degraded: the fuzz must reach both the plain and the degraded case`);
});

// --- H2. mask, then cut ------------------------------------------------------------------------------------------

// A token shape built at run time (never written out), 44 characters, with the cut of an 80-character line inside it.
const KEY = `ghp_${'a1B2c3D4e5'.repeat(4)}`;

test('H2: a key that crosses the cut of a pointer title leaves no stump (workflow pointer, procedure pointer, shorten)', () => {
  const title = `${'x'.repeat(61)} ${KEY}`;
  // Positive control: the plain cut of the same title leaves a stump that no pattern knows any more.
  const stump = title.slice(0, 79);
  assert.ok(stump.includes('ghp_a1B2c3D4e5'), 'the control: a plain cut leaves the key prefix standing');
  const clean = (text, what) => {
    assert.ok(!text.includes('ghp_'), `${what}: no key prefix in ${JSON.stringify(text)}`);
    assert.ok(!text.includes('a1B2c3'), `${what}: no part of the key`);
  };
  clean(answerbudget.shorten(title, 80), 'shorten');
  const card = workflowdetect.cardText({ id: 'wf000009', title, steps: ['one', 'two'], issued_by: 'owner', status: 'released' });
  const ptr = wfpointer.pointerForm(card);
  clean(ptr, 'workflow pointer');
  assert.match(ptr, /mem workflow show wf000009/);
  const proc = subagentstart.procedurePointer({ id: 'prc00001', title, rule: 'x', issued_by: 'owner', ts: '2026-10-16T00:00:00Z' });
  clean(proc, 'procedure pointer');
  assert.match(proc, /mem show prc00001/);
  // And through the whole selection, a title shorter than the cut: shown masked, never as it was.
  const sel = answerbudget.compose([{ id: 'k', kind: 'hit', rank: 1, order: 0, forms: [`line ${KEY}`, `ptr ${KEY}`] }], { budget: 200 });
  clean(sel.text, 'compose');
});

// --- M1. mem_find: a large top is cut -------------------------------------------------------------------------------

test('M1: mem_find cuts a large top to 25 (the limit of the sibling house) and says so; the schema says it too; a small top is untouched and silent', (t) => {
  const root = tempDir('cm-ab-top-', t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  for (let i = 0; i < 70; i += 1) memory.logEntry(root, 'learning', { title: `Zebra crossing note ${i}`, text: `zebra crossing variant ${i} near the old harbour` });
  const call = (args) => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_find', arguments: args } }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
    ];
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem-mcp')], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 90000, env: { ...process.env, CHEAP_MEM_ROOT: root } });
    const replies = String(r.stdout).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { text: replies.find((x) => x.id === 2)?.result?.content?.map((c) => c.text).join('\n') ?? '', tools: replies.find((x) => x.id === 3)?.result?.tools ?? [] };
  };
  const hitsIn = (text) => (text.match(/^\S+:\d+\s+\[/gm) ?? []).length;
  const big = call({ query: 'zebra crossing', top: 1000 });
  assert.equal(hitsIn(big.text), 25);
  assert.match(big.text, /top 1000 was cut to 25/);
  const schema = big.tools.find((x) => x.name === 'mem_find').inputSchema.properties.top;
  assert.equal(schema.maximum, 25);
  assert.match(schema.description, /at most 25/);
  const small = call({ query: 'zebra crossing', top: 5 });
  assert.equal(hitsIn(small.text), 5);
  assert.doesNotMatch(small.text, /was cut to/);
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
  // 4000 stands once, as the OLD cap of the base block (the recap's first ask, so that a start that fits is what it was).
  assert.doesNotMatch(code('src/subagentstart.mjs').replace(/^const LEGACY_CAP_CHARS = 4000;$/m, ''), /\b3200\b|\b4000\b/);
});

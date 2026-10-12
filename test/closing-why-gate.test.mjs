// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Second review of the shape rule (2026-10-12), blocker L1: `mem done <id> --why`, `mem discard <id> --why`,
// `mem supersede <id> --by <id2> --why`, `mem duties close <id> --why` (and `mem_duty_close` with `why: true` / `why: 5`)
// reported success and wrote `"why": true` on the closing line. That line is broken since the strict shape rule (why is
// text), so the target stayed OPEN and the doctor failed. Nothing at the write door checked the shape: `logEntry(root,
// 'decision', {topic: {a: 1}})` wrote as well.
//
// One write gate: `memory.logEntry` runs `fieldshape.shapeProblem` and refuses, so every door (CLI, bridge, API) is covered;
// the CLI also names the flag. Every probe checks that NOTHING was written and the target is unchanged; a real `why` closes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

const cli = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a],
  { encoding: 'utf8', input: '', timeout: 60000, env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root } });

function bridge(root, calls) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  let id = 10;
  for (const [name, a] of calls) lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  const r = spawnSync(process.execPath, [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0' },
  });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  if (replies.length < calls.length + 1) throw new Error(`bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 800)}`);
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

/** A memory with one open duty, two thoughts and two decisions; returns the ids. */
function world(t) {
  const root = tempDir('cm-closegate-', t);
  const init = cli(root, 'init', '--participants', 'lucky,session', '--human', 'lucky');
  assert.equal(init.status, 0, init.stderr);
  const ids = {};
  ids.duty = memory.logEntry(root, 'duty', { title: 'open duty', duty: 'do it', owner: 'lucky', agent: 'lucky' }).entry.id;
  ids.thoughtA = memory.logEntry(root, 'thought', { title: 'old thought', text: 'alpha', agent: 'lucky' }).entry.id;
  ids.thoughtB = memory.logEntry(root, 'thought', { title: 'new thought', text: 'beta', agent: 'lucky' }).entry.id;
  ids.decA = memory.logEntry(root, 'decision', { title: 'old decision', choice: 'a', why: 'w', agent: 'lucky' }).entry.id;
  ids.decB = memory.logEntry(root, 'decision', { title: 'new decision', choice: 'b', why: 'w', agent: 'lucky' }).entry.id;
  return { root, ids };
}
const drawers = (root) => {
  const out = {};
  for (const f of fs.readdirSync(path.join(root, 'global'))) out[f] = fs.readFileSync(path.join(root, 'global', f), 'utf8');
  return out;
};
const noWhyTrue = (root) => {
  for (const [f, text] of Object.entries(drawers(root))) assert.ok(!/"why":\s*(true|5|\{)/.test(text), `${f} carries a non-text why`);
};
const openIds = (root) => memory.openDuties(root).open.map((d) => d.id);

test('CLI: a value-less --why on done / discard / supersede / duties close is refused, nothing written, targets unchanged', (t) => {
  const { root, ids } = world(t);
  const before = drawers(root);
  const cases = [
    ['done', ids.thoughtA, '--why'],
    ['discard', ids.thoughtA, '--why'],
    ['supersede', ids.decA, '--by', ids.decB, '--why'],
    ['duties', 'close', ids.duty, '--why'],
    ['restore', ids.thoughtA, '--why'],
    ['merge', ids.thoughtA, ids.thoughtB, '--why'],
    ['topic-merge', 'alpha', 'beta', '--to', 'gamma', '--why'],
  ];
  for (const c of cases) {
    const r = cli(root, ...c);
    assert.notEqual(r.status, 0, `${c.join(' ')} reported success: ${r.stdout}`);
    assert.match(r.stderr, /--why/, `${c.join(' ')}: the refusal does not name the flag: ${r.stderr}`);
    assert.doesNotMatch(r.stderr, /TypeError|Cannot read/);
  }
  assert.deepEqual(drawers(root), before, 'something was written');
  noWhyTrue(root);
  assert.deepEqual(openIds(root), [ids.duty], 'the duty is no longer open');
  const doc = cli(root, 'doctor', '--json');
  assert.doesNotMatch(doc.stdout, /unparsable|"level":\s*"error"[^}]*drawers/);
});

test('positive control: the same commands with a real --why close their targets', (t) => {
  const { root, ids } = world(t);
  for (const c of [
    ['done', ids.thoughtA, '--why', 'finished'],
    ['discard', ids.thoughtB, '--why', 'wrong'],
    ['supersede', ids.decA, '--by', ids.decB, '--why', 'replaced'],
    ['duties', 'close', ids.duty, '--why', 'done it'],
  ]) {
    const r = cli(root, ...c);
    assert.equal(r.status, 0, `${c.join(' ')}: ${r.stderr}`);
  }
  assert.deepEqual(openIds(root), [], 'the duty stayed open');
  const lines = fs.readFileSync(path.join(root, 'global', 'thoughts.jsonl'), 'utf8').trim().split('\n').map((z) => JSON.parse(z));
  assert.ok(lines.some((l) => l.retires_id === ids.thoughtA && l.why === 'finished'));
});

test('bridge: mem_duty_close with why true / 5 / an object is refused, the duty stays open and nothing is written', (t) => {
  const { root, ids } = world(t);
  const before = drawers(root);
  const res = bridge(root, [true, 5, { a: 1 }].map((why) => ['mem_duty_close', { id: ids.duty, why }]));
  res.forEach((r, i) => {
    assert.ok(r.isError || /refus|not|text/i.test(textOf(r)), `call ${i} answered: ${textOf(r)}`);
    assert.doesNotMatch(textOf(r), /^Closed/, `call ${i} reported success: ${textOf(r)}`);
  });
  assert.deepEqual(drawers(root), before, 'something was written');
  assert.deepEqual(openIds(root), [ids.duty]);
  const ok = bridge(root, [['mem_duty_close', { id: ids.duty, why: 'really done' }]]);
  assert.match(textOf(ok[0]), /^Closed/, 'positive control: a real why closes');
  assert.deepEqual(openIds(root), []);
});

test('bridge: mem_log tombstones (retires_id, by_id) with a non-text why are refused', (t) => {
  const { root, ids } = world(t);
  const before = drawers(root);
  const res = bridge(root, [true, 5].flatMap((why) => [
    ['mem_log', { type: 'thought', retires_id: ids.thoughtA, state: 'discarded', why }],
    ['mem_log', { type: 'decision', retires_id: ids.decA, state: 'superseded', by_id: ids.decB, why }],
  ]));
  for (const r of res) assert.ok(r.isError || /refus|text/i.test(textOf(r)), textOf(r));
  assert.deepEqual(drawers(root), before, 'something was written');
});

test('the write gate: memory.logEntry refuses a wrongly shaped field at the door, whatever the caller', (t) => {
  const { root, ids } = world(t);
  const before = drawers(root);
  assert.throws(() => memory.logEntry(root, 'decision', { topic: { a: 1 }, choice: 'c', why: 'w' }), /topic/);
  assert.throws(() => memory.logEntry(root, 'thought', { title: 't', text: 5 }), /text/);
  assert.throws(() => memory.logEntry(root, 'thought', { title: 't', text: 'x', tags: [{ a: 1 }] }), /tags/);
  assert.throws(() => memory.closeDuty(root, ids.duty, { why: true }), /why/);
  assert.throws(() => memory.closeDuty(root, ids.duty, { why: 5 }), /why/);
  assert.throws(() => memory.retireEntry(root, 'thought', ids.thoughtA, { why: true }), /why/);
  assert.throws(() => memory.retireEntry(root, 'thought', ids.thoughtA, { why: 5 }), /why/);
  assert.throws(() => memory.supersedeEntry(root, 'decision', ids.decA, { by: ids.decB, why: true }), /why/);
  assert.deepEqual(drawers(root), before, 'something was written');
  // positive control: a well-formed entry with a structured field still goes through
  const ok = memory.logEntry(root, 'thought', { title: 't', text: 'x', tags: ['a'], origin: { surface: 'cloud', derived_from: { id: 'abc' } } });
  assert.ok(ok.entry.id);
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// lucky-mem error 3fv0k9q6t3c0 (Fable B1)
// B1 (external security review, 2026-10-11): `replaces_id` on a DUTY.
//
// The hole: `openDuties` dropped the predecessor of any `replaces_id` line without an authority check, so one
// `mem_log` made a user duty or an auto-duty vanish, and the replacing stage carried no `error_ids`, so it closed
// without the F4 proof. `mem doctor` said nothing about it.
//
// Now: (1) the fold judges a replacement with the same rule as a close (`authority.mayChangeState`);
// (2) a duty that grew out of errors is replaced only by a stage that stays open and keeps its error_ids,
// the chain walked BACK to the stage that carries them (the newest stage inherits them for the F4 check);
// (3) the bridge does not offer `replaces_id` on a duty at all (`mem_duty_close` / a new duty instead);
// (4) `mem doctor` (contested-claims) counts the F4 refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as doctor from '../src/doctor.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

function world(t) {
  const root = tempDir('cm-b1-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    version: 1, name: 'b1', participants: { user: { human: true }, foreign: 'agent', digest: 'agent' },
    language: 'en', timezone: 'UTC',
  }));
  return root;
}

function bridge(root, calls) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  let id = 10;
  for (const [name, a] of calls) lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  const r = spawnSync(process.execPath, [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0', MEM_HEADLESS: '' },
  });
  return String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z))
    .filter((x) => x.id >= 10).sort((a, b) => a.id - b.id)
    .map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

function seed(root) {
  const user = memory.logEntry(root, 'duty', { title: 'pay the rent', duty: 'pay', owner: 'user', agent: 'user', authority: 'user' }).entry;
  const err = memory.logEntry(root, 'error', { title: 'e1', text: 'x', class: 'c', file: 'a.js', agent: 'digest' }).entry;
  const auto = memory.logEntry(root, 'duty', {
    title: 'Guard for c at a.js', text: 'auto', owner: 'digest', agent: 'digest', error_ids: [err.id], automatic: true,
  }).entry;
  return { user, auto, err };
}

test('B1: a foreign line cannot replace a user duty (the fold keeps it open and reports the refusal)', (t) => {
  const root = world(t);
  const { user } = seed(root);
  memory.logEntry(root, 'duty', { title: 'harmless', duty: 'noop', agent: 'foreign', replaces_id: user.id });
  const d = memory.openDuties(root);
  assert.ok(d.open.some((x) => x.id === user.id), 'the user duty vanished');
  assert.ok(d.refused.some((r) => r.target === user.id && r.field === 'replaces_id'), JSON.stringify(d.refused));
});

test('B1: a replacement of an auto-duty may not close it, and may not drop its error_ids', (t) => {
  const root = world(t);
  const { auto } = seed(root);
  memory.logEntry(root, 'duty', { title: 'fixed', duty: 'x', agent: 'foreign', replaces_id: auto.id, state: 'done' });
  memory.logEntry(root, 'duty', { title: 'other ids', duty: 'x', agent: 'foreign', replaces_id: auto.id, error_ids: ['zzzzzzzz1111'] });
  const d = memory.openDuties(root);
  assert.ok(d.open.some((x) => x.id === auto.id), 'the auto-duty vanished');
  assert.equal(d.refused.filter((r) => r.target === auto.id && /^F4/.test(r.reason)).length, 2, JSON.stringify(d.refused));
  assert.ok(d.refused.every((r) => typeof r.field === 'string'));
});

test('B1: an open replacement of an auto-duty carries the error_ids on, so closing it still needs evidence', (t) => {
  const root = world(t);
  const { auto } = seed(root);
  const stage = memory.logEntry(root, 'duty', { title: 'reworded', duty: 'x', agent: 'foreign', replaces_id: auto.id }).entry;
  const stage2 = memory.logEntry(root, 'duty', { title: 'reworded again', duty: 'x', agent: 'foreign', replaces_id: stage.id }).entry;
  const d = memory.openDuties(root);
  const newest = d.open.find((x) => x.id === stage2.id);
  assert.ok(newest, 'the newest stage is the open one');
  assert.deepEqual(newest.error_ids, auto.error_ids, 'the chain walk back to the original is missing');
  assert.ok(!d.open.some((x) => x.id === auto.id || x.id === stage.id));
  assert.throws(() => memory.closeDuty(root, stage2.id, { state: 'done', agent: 'foreign' }), /no evidence|F4/);
  assert.ok(memory.openDuties(root).open.some((x) => x.id === stage2.id), 'it closed without evidence');
});

test('B1 positive control: the library path an auto-duty uses (correctionEntry, ids kept) still replaces', (t) => {
  const root = world(t);
  const { auto } = seed(root);
  memory.correctionEntry(root, 'duty', auto.id, { error_ids: [...auto.error_ids, 'extra0000001'] });
  const d = memory.openDuties(root);
  assert.equal(d.open.filter((x) => x.title === 'Guard for c at a.js').length, 1);
  assert.ok(!d.open.some((x) => x.id === auto.id), 'the old stage should be folded away');
  assert.deepEqual(d.refused, []);
});

test('B1 positive control: an author corrects its own plain duty', (t) => {
  const root = world(t);
  const mine = memory.logEntry(root, 'duty', { title: 'v1', duty: 'x', agent: 'foreign' }).entry;
  memory.logEntry(root, 'duty', { title: 'v2', duty: 'x', agent: 'foreign', replaces_id: mine.id });
  const d = memory.openDuties(root);
  assert.deepEqual(d.open.map((x) => x.title), ['v2']);
});

test('B1: the bridge refuses replaces_id on a duty and writes nothing; a new duty and other types still go', (t) => {
  const root = world(t);
  const { user, auto } = seed(root);
  const before = memory.readLog(root, 'duty').entries.length;
  const [a, b, c, e] = bridge(root, [
    ['mem_log', { type: 'duty', title: 'x', duty: 'noop', replaces_id: user.id }],
    ['mem_log', { type: 'duty', title: 'y', duty: 'noop', replaces_id: auto.id, state: 'done' }],
    ['mem_log', { type: 'duty', title: 'fresh', duty: 'new thing', owner: 'foreign' }],
    ['mem_log', { type: 'decision', title: 'd', choice: 'a', why: 'w' }],
  ]);
  for (const r of [a, b]) {
    assert.equal(r.isError, true, textOf(r));
    assert.match(textOf(r), /replaces_id/);
    assert.match(textOf(r), /mem_duty_close/);
  }
  assert.ok(!c.isError, textOf(c));
  assert.ok(!e.isError, textOf(e));
  assert.equal(memory.readLog(root, 'duty').entries.length, before + 1, 'something else than the fresh duty was written');
  const d = memory.openDuties(root);
  assert.ok(d.open.some((x) => x.id === user.id) && d.open.some((x) => x.id === auto.id));
});

test('B1: mem doctor counts an F4-refused replacement as a contested claim', (t) => {
  const root = world(t);
  const { auto } = seed(root);
  // The same author as the auto-duty: the authority rule lets it through, only the F4 rule refuses it.
  memory.logEntry(root, 'duty', { title: 'fixed', duty: 'x', agent: 'digest', replaces_id: auto.id, state: 'done' });
  const f = doctor.checkContestedClaims(root);
  assert.equal(f.level, 'warn', JSON.stringify(f));
  assert.match(f.text, /^1 contested claim of 1 state pointer/);
  assert.match(f.text, /F4/);
});

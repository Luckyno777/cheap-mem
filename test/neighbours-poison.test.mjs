// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Review of the port of the Fable run (2026-10-12), blocker 1: the write-time neighbour hints (`neighbours.neighbours` for
// topic and key, `neighbours.similarDecisions` for a decision without a topic) read the tail of the drawer with their own
// JSON.parse and so bypassed `memory.parseLine`. One poisoned topic / key / title / choice in the last 256 KB of decisions or
// timeline made `mem log decision` / `mem log timeline` (CLI and mem_log) fail with "Cannot convert object to primitive
// value" - and nothing was written. A line that is wrongly shaped is BROKEN (it is no neighbour), the write goes through.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as neighbours from '../src/neighbours.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

function world(t) {
  const root = tempDir('cm-neighbours-', t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root, '--participants', 'lucky,session', '--human', 'lucky'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  // healthy neighbours first (the positive control: they must still be found as neighbours)
  memory.logEntry(root, 'decision', { topic: 'database', choice: 'postgres for the billing store', why: 'speed', agent: 'lucky' });
  memory.logEntry(root, 'timeline', { key: 'db.engine', value: 'postgres', text: 'engine', agent: 'lucky' });
  const poison = (file, o) => fs.appendFileSync(path.join(root, 'global', file), `${JSON.stringify({ ts: '2026-10-11T22:30:00Z', v: 1, agent: 'x', authority: 'agent', ...o })}\n`);
  poison('decisions.jsonl', { id: '9poison0001', topic: { toString: 'x' }, choice: 'c', why: 'w' });
  poison('decisions.jsonl', { id: '9poison0002', title: { toString: 'x' }, choice: ['postgres', 'billing'], why: 'w' });
  poison('decisions.jsonl', { id: '9poison0003', topic: 'database', choice: { a: 1 }, why: 'w' });
  poison('timeline.jsonl', { id: '9poison0004', key: { toString: 'x' }, value: 'v' });
  poison('timeline.jsonl', { id: '9poison0005', subject: ['db.engine'], value: 'v' });
  return root;
}
const cli = (root, ...args) => spawnSync(process.execPath, [MEM, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root } });
const CRASH = /Cannot convert object to primitive value|is not a function|TypeError|Cannot read properties/;

test('neighbours: a poisoned line in the tail is no neighbour and no crash; the healthy neighbour is still found', (t) => {
  const root = world(t);
  const n = neighbours.neighbours(root, 'decision', { topic: 'database' });
  assert.deepEqual(n.hits.map((e) => e.choice), ['postgres for the billing store'], 'only the healthy decision is a neighbour');
  const k = neighbours.neighbours(root, 'timeline', { key: 'db.engine' });
  assert.equal(k.hits.length, 1);
});

test('similarDecisions: a poisoned line is skipped, the healthy similar decision is still named', (t) => {
  const root = world(t);
  const s = neighbours.similarDecisions(root, 'decision', { title: 'postgres billing store', choice: 'postgres billing store' });
  assert.equal(s.hits.length, 1, JSON.stringify(s));
  assert.equal(s.hits[0].topic, 'database');
});

test('mem log decision / timeline still write, with the poison in the tail (CLI)', (t) => {
  const root = world(t);
  for (const args of [
    ['log', 'decision', '--topic', 'database', '--choice', 'sqlite for tests', '--why', 'fast'],
    ['log', 'decision', '--choice', 'postgres billing store again', '--title', 'postgres billing store', '--why', 'again'],
    ['log', 'timeline', '--key', 'db.engine', '--value', 'sqlite', '--text', 'x'],
  ]) {
    const r = cli(root, ...args);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, CRASH, `mem ${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.status, 0, `mem ${args.join(' ')}: ${r.stderr}`);
  }
  const decisions = memory.readLog(root, 'decision').entries.filter((e) => !e.__broken);
  assert.ok(decisions.some((e) => e.choice === 'sqlite for tests'), 'the decision was written');
});

test('mem_log over the bridge still writes, with the poison in the tail', (t) => {
  const root = world(t);
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'mem_log', arguments: { type: 'decision', topic: 'database', choice: 'bridge decision', why: 'w' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'mem_log', arguments: { type: 'timeline', key: 'db.engine', value: 'bridge', text: 'x' } } })];
  const r = spawnSync(process.execPath, [MCP], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0', MEM_HEADLESS: '' } });
  const out = r.stdout.split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z)).filter((x) => x.id >= 10);
  for (const x of out) assert.doesNotMatch(JSON.stringify(x), CRASH, JSON.stringify(x).slice(0, 300));
  assert.ok(memory.readLog(root, 'decision').entries.some((e) => e.choice === 'bridge decision'));
  assert.ok(memory.readLog(root, 'timeline').entries.some((e) => e.value === 'bridge'));
});

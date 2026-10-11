// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Review of the B1 fix (2026-10-11), blocker 3: `type` as an array or an object bypassed the bridge locks.
// `mem_log {type: ["duty"], replaces_id}` passed `type === 'duty'` in bridgefields.refuse (so replaces_id on a duty
// went through) and `["procedure"]` / `["workflow"]` passed the norm locks in bin/mem-mcp, while the write path
// turned the array into the string and wrote the entry. Now: `mem_log` wants a string type, and every tool
// refuses an array or an object where its schema says string (`bridgefields.shapeCheck`) - over stdio and --http.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as bridgefields from '../src/bridgefields.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');

function world(t) {
  const root = tempDir('cm-shape-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    version: 1, name: 'x', participants: { user: { human: true }, foreign: 'agent', digest: 'agent' }, language: 'en', timezone: 'UTC',
  }));
  const err = memory.logEntry(root, 'error', { title: 'e1', text: 'x', class: 'c', file: 'a.js', agent: 'digest' }).entry;
  const auto = memory.logEntry(root, 'duty', { title: 'Guard', text: 'auto', owner: 'digest', agent: 'digest', error_ids: [err.id], automatic: true }).entry;
  return { root, auto };
}

const hostile = (auto) => [
  ['mem_log', { type: ['duty'], title: 'stage2', replaces_id: auto.id }],
  ['mem_log', { type: ['workflow'], title: 'w', text: 'do bad things' }],
  ['mem_log', { type: ['procedure'], title: 'p', text: 'do bad things', rule: 'x' }],
  ['mem_log', { type: { a: 'duty' }, title: 'o', text: 'x' }],
  ['mem_show', { id: [auto.id] }],
  ['mem_find', { query: { q: 'x' } }],
];

const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');
function untouched(root, auto) {
  const duties = memory.readLog(root, 'duty').entries;
  assert.equal(duties.length, 1, `a duty line was written: ${JSON.stringify(duties.map((d) => d.title))}`);
  assert.equal(memory.openDuties(root).open[0].id, auto.id);
  for (const type of ['workflow', 'procedure']) {
    const r = memory.readLog(root, type);
    assert.ok(r.missing || (r.entries ?? []).length === 0, `${type} was written`);
  }
}

test('stdio: type as an array or an object, and arrays in string fields, are refused and write nothing', (t) => {
  const { root, auto } = world(t);
  const calls = [...hostile(auto), ['mem_log', { type: 'decision', title: 'ok', choice: 'a', why: 'w' }]];
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  calls.forEach(([name, a], i) => lines.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: a } })));
  const r = spawnSync(process.execPath, [MCP], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0', MEM_HEADLESS: '' } });
  const res = String(r.stdout).split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z)).filter((x) => x.id >= 10).sort((a, b) => a.id - b.id).map((x) => x.result);
  assert.equal(res.length, calls.length, r.stderr);
  res.slice(0, -1).forEach((x, i) => {
    assert.equal(x.isError, true, `${calls[i][0]} ${JSON.stringify(calls[i][1])} -> ${textOf(x)}`);
    assert.match(textOf(x), /must be a string/);
  });
  assert.ok(!res.at(-1).isError, `positive control: ${textOf(res.at(-1))}`);
  untouched(root, auto);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => (e ? reject(e) : resolve(port))); });
  });
}
function post(port, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.once('error', reject); req.end(JSON.stringify(body));
  });
}

test('--http: the same refusals over the network door (full profile)', async (t) => {
  const { root, auto } = world(t);
  const port = await freePort();
  let errors = '';
  const child = spawn(process.execPath, [MCP, '--http'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_MCP_PORT: String(port), CHEAP_MEM_MCP_READONLY: '0', CHEAP_MEM_AGENT: 'foreign' } });
  child.stderr.setEncoding('utf8'); child.stderr.on('data', (c) => { errors += c; });
  try {
    for (let i = 0; i < 200; i += 1) {
      if (child.exitCode !== null) throw new Error(`mem-mcp exited: ${errors}`);
      try { await new Promise((ok, no) => { http.get({ host: '127.0.0.1', port, path: '/health' }, (r) => { r.resume(); r.on('end', ok); }).once('error', no); }); break; } catch { await new Promise((ok) => setTimeout(ok, 50)); }
    }
    let id = 100;
    for (const [name, args] of hostile(auto)) {
      const r = await post(port, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } });
      assert.equal(r.status, 200, r.text);
      const out = JSON.parse(r.text).result;
      assert.equal(out.isError, true, `${name} ${JSON.stringify(args)} -> ${textOf(out)}`);
      assert.match(textOf(out), /must be a string/);
    }
    untouched(root, auto);
  } finally {
    child.kill('SIGTERM');
    await new Promise((ok) => { if (child.exitCode !== null) ok(); else child.once('exit', ok); });
  }
});

test('shapeCheck: strings, numbers, null and absent fields pass; arrays, objects and a non-object call do not', () => {
  const schema = { properties: { a: { type: 'string' }, n: { type: 'number' }, l: { type: 'array' } } };
  assert.doesNotThrow(() => bridgefields.shapeCheck(schema, { a: 'x', n: 3, l: ['x'] }));
  assert.doesNotThrow(() => bridgefields.shapeCheck(schema, { a: null }));
  assert.doesNotThrow(() => bridgefields.shapeCheck(schema, {}));
  assert.doesNotThrow(() => bridgefields.shapeCheck(undefined, { a: ['x'] }));
  assert.throws(() => bridgefields.shapeCheck(schema, { a: ['x'] }), /'a' must be a string, not an array/);
  assert.throws(() => bridgefields.shapeCheck(schema, { a: { b: 1 } }), /not an object/);
  assert.throws(() => bridgefields.shapeCheck(schema, ['x']), /must be an object/);
});

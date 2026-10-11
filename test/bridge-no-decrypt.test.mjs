// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Fable security run 2026-10-11, ported from lucky-mem ("the bridge never decrypts without a switch"): an entry written
// with `shred` carries its body encrypted (`body_enc`), the key sits in `.mem/keyring.json` beside the data. The bridge
// process can read that keyring, so every connected foreign agent got the plaintext through `mem_find`, `mem_show`,
// `mem_context`, `mem_retrieve` - a clone that holds only the git data cannot. Now the bridge shows such an entry as
// unreadable ("not shown over the MCP bridge") unless the operator sets CHEAP_MEM_MCP_DECRYPT=1. The CLI is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const MEM = path.join(REPO, 'bin', 'mem');
const CANARY = ['KANARIE', '77', 'zq'].join('');

function world(t) {
  const root = tempDir('cm-nodecrypt-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    version: 1, name: 'nd', participants: { user: { human: true }, foreign: 'agent' }, language: 'en', timezone: 'UTC',
  }));
  const sealed = memory.logEntry(root, 'thought', { title: `private ${CANARY} thought`, text: `the body names ${CANARY}`, agent: 'user', shred: true }).entry;
  const plain = memory.logEntry(root, 'thought', { title: 'open pelican note', text: 'readable pelican body', agent: 'user' }).entry;
  return { root, sealed, plain };
}

function bridge(root, calls, env = {}) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  let id = 10;
  for (const [name, a] of calls) lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  const r = spawnSync(process.execPath, [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0', MEM_HEADLESS: '', ...env },
  });
  return String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z))
    .filter((x) => x.id >= 10).sort((a, b) => a.id - b.id)
    .map((x) => (x.result?.content ?? []).map((c) => c.text).join('\n') + (x.error ? `ERROR ${x.error.message}` : ''));
}

const calls = (sealed) => [
  ['mem_find', { query: CANARY }],
  ['mem_find', { query: 'encrypted' }],
  ['mem_show', { id: sealed.id }],
  ['mem_context', {}],
  ['mem_retrieve', { query: `what is ${CANARY}` }],
  ['mem_find', { query: 'pelican' }],
  ['mem_find', { query: 'private thought' }],
];

test('the bridge does not decrypt by default: no plaintext of an encrypted entry in any read tool', (t) => {
  const { root, sealed } = world(t);
  const out = bridge(root, calls(sealed));
  const all = out.join('\n----\n');
  // (the tools echo the query, so the canary word itself may stand in "No hits for ..."; the BODY must not)
  assert.ok(!all.includes('the body names') && !/private \w+ thought/.test(all), `plaintext came over the bridge:\n${all.slice(0, 600)}`);
  assert.match(out[6], /No hits/, 'the encrypted title is not searchable either');
  assert.match(out[0], /No hits/, 'the encrypted entry does not answer to its plaintext words');
  // positive control: the same bridge still serves entries that are not encrypted
  assert.match(out[5], /pelican/);
});

test('with CHEAP_MEM_MCP_DECRYPT=1 the operator opts in: the bridge decrypts as before', (t) => {
  const { root, sealed } = world(t);
  const out = bridge(root, calls(sealed), { CHEAP_MEM_MCP_DECRYPT: '1' });
  assert.ok(out[0].includes('the body names'), `the opt-in bridge finds the plaintext:\n${out[0].slice(0, 400)}`);
  assert.ok(out[4].includes('the body names'), 'mem_retrieve shows it as well');
  assert.match(out[0], /private .* thought/, 'found by its (encrypted) title');
});

test('the CLI decrypts as before (the switch is about the bridge only)', (t) => {
  const { root } = world(t);
  const r = spawnSync(process.execPath, [MEM, '--root', root, 'find', CANARY], { encoding: 'utf8', env: { ...process.env, MEM_HEADLESS: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(CANARY), r.stdout);
});

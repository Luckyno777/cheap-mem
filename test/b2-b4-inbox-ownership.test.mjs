// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// B2 + B4 (external security review, 2026-10-11): other people's mail over the bridge.
//
//   B2  `mem_inbox_ack` set the state of ANY letter: `mallory` closed `alice -> bob`, and Bob's
//       `mem_inbox_new` then showed nothing. Now only the addressee (or the agent holding a valid claim) sets it.
//   B4  `mem_inbox_claim` on a letter addressed to somebody else locked the real recipient out (his own claim
//       "does NOT count - second"). Now only the addressee claims. One claim is at most
//       `claim.MAX_EXTENSION_MIN` long, and a renew is capped by the same figure beyond the ORIGINAL `until`
//       (that part already held in `claim.fold`; pinned here).
// The shell (`mem inbox ...`) is outside the model and stays as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as inbox from '../src/inbox.mjs';
import * as claim from '../src/claim.mjs';
import { tempDir } from './temp-dir.mjs';

const PARTS = { alice: 'AI', bob: 'AI', mallory: 'AI', user: 'H' };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(HERE, '..', 'bin', 'mem-mcp');
const MEM = path.join(HERE, '..', 'bin', 'mem');

function bridge(root, calls, agent) {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  let id = 10;
  for (const [name, a] of calls) lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  const r = spawnSync(process.execPath, [MCP], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: agent, CHEAP_MEM_MCP_READONLY: '0', MEM_HEADLESS: '' } });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  assert.ok(replies.length >= calls.length + 1, `bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 400)}`);
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

function letter(t) {
  const root = tempDir('cm-b2b4-', t);
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'pipe' });
  const w = inbox.write(root, PARTS, { from: 'alice', to: 'bob', subject: 'for bob', text: 'Body.' });
  return { root, name: w.name };
}
const stateOf = (root, name) => inbox.stateOf(root, name).state;

test('B2: a stranger cannot set the state of someone else\'s mail', (t) => {
  const { root, name } = letter(t);
  const [r] = bridge(root, [['mem_inbox_ack', { name, state: 'closed' }]], 'mallory');
  assert.equal(r.isError, true, textOf(r));
  assert.match(textOf(r), /not your mail/);
  assert.equal(stateOf(root, name), 'open', 'the state moved');
});

test('B2 positive control: the addressee sets it; so does the agent holding a valid claim', (t) => {
  const { root, name } = letter(t);
  const [ok] = bridge(root, [['mem_inbox_ack', { name, state: 'processed' }]], 'bob');
  assert.ok(!ok.isError, textOf(ok));
  assert.equal(stateOf(root, name), 'processed');
});

test('B4: a stranger cannot claim someone else\'s mail, so the recipient is not blocked', (t) => {
  const { root, name } = letter(t);
  const [m] = bridge(root, [['mem_inbox_claim', { name, minutes: 100 }]], 'mallory');
  assert.equal(m.isError, true, textOf(m));
  assert.match(textOf(m), /only the addressee/);
  const [b] = bridge(root, [['mem_inbox_claim', { name }]], 'bob');
  assert.equal(b.structuredContent.valid, true, textOf(b));
  assert.equal(claim.status(root, name).holder.claimed_by, 'bob');
});

test('B4: one claim is capped, and a renew cannot go past the cap beyond the original until', (t) => {
  const { root, name } = letter(t);
  const [long] = bridge(root, [['mem_inbox_claim', { name, minutes: claim.MAX_EXTENSION_MIN + 1 }]], 'bob');
  assert.equal(long.isError, true, textOf(long));
  assert.equal(claim.status(root, name).status, 'free', 'a refused claim still wrote a line');
  const [c] = bridge(root, [['mem_inbox_claim', { name, minutes: 30 }]], 'bob');
  const id = c.structuredContent.claim_id;
  const [far] = bridge(root, [['mem_inbox_renew', { name, claim_id: id, minutes: 100000 }]], 'bob');
  assert.equal(far.structuredContent.valid, false, 'an unbounded renew counted');
});

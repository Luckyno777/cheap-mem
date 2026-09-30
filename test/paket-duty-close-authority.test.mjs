// Paket (2026-09-30): `mem_duty_close` over MCP takes an optional
// `authority`, capped like `mem_log` (Y4b: over the bridge never above
// `agent`; the demotion is recorded in `authority_clamped_from`).
//
// Red on the old state: the tool ignored the argument, so a claimed lower
// tier ('external') was not written and a claimed 'user' left no record of
// the demotion. Positive control: a call without `authority` still closes
// with the write path's default tier, and a lower claim is kept as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-paket-duty-'));
  assert.equal(spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8' }).status, 0);
  return root;
}

function openDuty(root, title) {
  const r = spawnSync('node', [MEM, '--root', root, 'log', 'duty', '--title', title, '--json'], {
    encoding: 'utf8', env: { ...process.env, CHEAP_MEM_AGENT: 'foreign' },
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = fs.readFileSync(path.join(root, 'global', 'duties.jsonl'), 'utf8').trim().split('\n').map((z) => JSON.parse(z));
  return lines.at(-1).id;
}

function bridge(root, calls) {
  const msgs = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  calls.forEach(([name, a], i) => msgs.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: a } })));
  const env = { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign' };
  delete env.CHEAP_MEM_MAX_AUTHORITY;
  const r = spawnSync(process.execPath, [MCP], { input: `${msgs.join('\n')}\n`, encoding: 'utf8', timeout: 40000, env });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  return calls.map((_, i) => {
    const x = replies.find((y) => y.id === 10 + i);
    if (!x) throw new Error(`no reply: ${String(r.stderr).slice(0, 600)}`);
    return x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] };
  });
}

test('mem_duty_close: authority is optional and capped at agent like mem_log', () => {
  const root = world();
  try {
    const [d1, d2, d3] = ['claims user', 'claims less', 'claims nothing'].map((t) => openDuty(root, t));
    const res = bridge(root, [
      ['mem_duty_close', { id: d1, why: 'done', authority: 'user' }],
      ['mem_duty_close', { id: d2, why: 'done', authority: 'external' }],
      ['mem_duty_close', { id: d3, why: 'done' }],
    ]);
    for (const x of res) assert.ok(!x.isError, JSON.stringify(x));
    const lines = fs.readFileSync(path.join(root, 'global', 'duties.jsonl'), 'utf8').trim().split('\n').map((z) => JSON.parse(z));
    const close = (id) => lines.find((e) => e.closes_id === id);
    assert.equal(close(d1)?.authority, 'agent', 'the bridge never mints user');
    assert.equal(close(d1)?.authority_clamped_from, 'user', 'the demotion is recorded');
    assert.equal(close(d2)?.authority, 'external', 'POSITIVE CONTROL: a lower claim is kept');
    assert.ok(!('authority_clamped_from' in close(d2)));
    assert.equal(close(d3)?.authority, 'agent', 'no tier: the write path default');
    assert.ok(!('authority_clamped_from' in close(d3)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_duty_close advertises the authority parameter', () => {
  const src = fs.readFileSync(MCP, 'utf8');
  const def = src.slice(src.indexOf("name: 'mem_duty_close'"), src.indexOf("name: 'mem_context'"));
  assert.match(def, /authority: \{/);
});

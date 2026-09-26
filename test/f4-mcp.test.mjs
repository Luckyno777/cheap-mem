// test/f4-mcp.test.mjs — F1/F2 at the MCP bridge (BAUPLAN-mem-admin_02.md
// Block F, ported as F4): `mem_log` shows the same file history and
// opens the same duty on repetition as the CLI; `mem_duty_close`
// refuses one with no evidence, through the very same
// `memory.closeDuty()` the CLI calls.
//
// **Why the earlier error is seeded through the CLI, not the bridge.**
// `mem_log`'s handler deliberately drops a caller-supplied `ts`
// (`ts: _neither` in bin/mem-mcp) — a foreign agent cannot backdate its
// own writes. So the ONLY controllable timestamp in this file is the
// CLI-seeded earlier error; the triggering one goes over the bridge with
// its real, current `ts`, and the earlier one is dated relative to NOW
// (a few days back) rather than to a fixed calendar date, so this file
// keeps working whenever it is actually run.
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

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString();

function readReplies(r, what) {
  const lines = String(r.stdout ?? '').split('\n').filter((z) => z.trim());
  if (!lines.length) {
    throw new Error(`${what}: the MCP server produced no reply.\n`
      + `  status: ${r.status}  stderr: ${String(r.stderr ?? '').trim().slice(0, 1000)}`);
  }
  return lines.map((z, i) => {
    try { return JSON.parse(z); } catch (e) {
      throw new Error(`${what}: reply line ${i + 1} is not JSON: ${e.message}`);
    }
  });
}

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f4-mcp-'));
  const init = spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

/** Seed an earlier error through the CLI, where --ts is actually honoured. */
function seedEarlier(root, { klass, file, ts }) {
  const r = spawnSync('node', [MEM, '--root', root, 'log', 'error',
    '--class', klass, '--title', 'earlier one', '--text', `found in ${file}`, '--ts', ts],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

function bridge(root, calls, env = {}) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  let id = 10;
  for (const [name, a] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  }
  const r = spawnSync('node', [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...env },
  });
  return readReplies(r, 'bridge');
}

function resultText(reply) {
  return JSON.stringify(reply?.result ?? reply);
}

/** Reads the open duties straight off disk via the CLI's own view. */
function openDutyIds(root) {
  const r = spawnSync('node', [MEM, '--root', root, 'duties'], { encoding: 'utf8' });
  return [...r.stdout.matchAll(/\[([a-z0-9]+)\]/g)].map((m) => m[1]);
}

test('a first mem_log error over the bridge shows no history and opens no duty', () => {
  const root = world();
  try {
    const res = bridge(root, [['mem_log', {
      type: 'error', class: 'wrong-cause', title: 'first', text: 'found in src/bridge.mjs',
    }]]);
    const log = res.find((x) => x.id === 10);
    assert.ok(log && !log.result?.isError, resultText(log));
    assert.ok(!/Earlier for/.test(resultText(log)), resultText(log));
    assert.ok(!/Repetition \(/.test(resultText(log)), resultText(log));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: a repeat over the bridge shows history and opens a duty, like the CLI', () => {
  const root = world();
  try {
    seedEarlier(root, { klass: 'wrong-cause', file: 'src/bridge.mjs', ts: daysAgo(5) });
    const res = bridge(root, [['mem_log', {
      type: 'error', class: 'wrong-cause', title: 'second', text: 'again in src/bridge.mjs',
    }]]);
    const second = res.find((x) => x.id === 10);
    assert.ok(second && !second.result?.isError, resultText(second));
    assert.match(resultText(second), /Earlier for src\/bridge\.mjs/, resultText(second));
    assert.match(resultText(second), /Repetition \(file-class-30-days\) — opened duty/, resultText(second));

    const duties = bridge(root, [['mem_duties', {}]]);
    assert.match(resultText(duties.find((x) => x.id === 10)), /Guard for wrong-cause at src\/bridge\.mjs/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_duty_close refuses an error-derived duty with no evidence, same as `mem duties close`', () => {
  const root = world();
  try {
    seedEarlier(root, { klass: 'wrong-cause', file: 'src/bridge.mjs', ts: daysAgo(5) });
    bridge(root, [['mem_log', {
      type: 'error', class: 'wrong-cause', title: 'second', text: 'again in src/bridge.mjs',
    }]]);
    const [id] = openDutyIds(root);
    assert.ok(id, 'no open duty found — the repetition did not fire, so this test proves nothing');
    const close = bridge(root, [['mem_duty_close', { id, state: 'done' }]]);
    const reply = close.find((x) => x.id === 10);
    assert.ok(reply.result?.isError, resultText(reply));
    assert.match(resultText(reply), /has no evidence/, resultText(reply));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL: mem_duty_close succeeds once the guard is real', () => {
  const root = world();
  try {
    seedEarlier(root, { klass: 'wrong-cause', file: 'src/bridge.mjs', ts: daysAgo(5) });
    // The guard lands directly on the triggering error, as a plain
    // field — the bridge composes no --guard-* flags the way the CLI's
    // `log` command does, so the object is passed as-is.
    bridge(root, [['mem_log', {
      type: 'error', class: 'wrong-cause', title: 'second', text: 'again in src/bridge.mjs',
      guard: { kind: 'file-gone', path: 'src/bridge-guarded.mjs' },
    }]]);
    const [id] = openDutyIds(root);
    assert.ok(id, 'no open duty found — the repetition did not fire, so this test proves nothing');
    const close = bridge(root, [['mem_duty_close', { id, state: 'done', why: 'fixed' }]]);
    const reply = close.find((x) => x.id === 10);
    assert.ok(!reply.result?.isError, resultText(reply));
    assert.match(resultText(reply), /Closed/, resultText(reply));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

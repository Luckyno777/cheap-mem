// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/mcplive.test.mjs — the MCP live probe (mirrors lucky-mem's
// dash-fix3 "MCP-Live-Probe").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import http from 'node:http';
import * as mcplive from '../src/mcplive.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');

test.afterEach(() => mcplive._clearCache());

// --- Pure logic: verdicts(), cache/kick, config -----------------------

test('verdicts(): present -> good, missing -> error, unreachable -> unknown with reason', () => {
  const reachable = { reachable: true, names: ['mem_board', 'mem_log'], checkedAt: 't' };
  const v = mcplive.verdicts(reachable, ['mem_board', 'mem_log', 'mem_ghost']);
  assert.equal(v.mem_board.state, 'good');
  assert.equal(v.mem_log.state, 'good');
  assert.equal(v.mem_ghost.state, 'error');

  const down = { reachable: false, reason: 'timed out' };
  const v2 = mcplive.verdicts(down, ['mem_board']);
  assert.equal(v2.mem_board.state, 'unknown');
  assert.equal(v2.mem_board.reason, 'timed out');
});

test('probeNow() reads only the cache — no network, ever', async () => {
  assert.equal(mcplive.probeNow(), null, 'nothing cached yet');
  await mcplive.probe({
    getClient: async () => ({
      Client: class { constructor() {} async connect() {} async listTools() { return { tools: [{ name: 'mem_board' }] }; } close() { return Promise.resolve(); } },
      StreamableHTTPClientTransport: class {},
    }),
  });
  const now = mcplive.probeNow();
  assert.ok(now, 'the probe just ran and should be cached');
  assert.equal(now.reachable, true);
  assert.deepEqual(now.names, ['mem_board']);
});

test('kickProbe() runs at most one probe at a time, in the background', async () => {
  let starts = 0;
  const getClient = async () => {
    starts += 1;
    await new Promise((r) => setTimeout(r, 30));
    return {
      Client: class { constructor() {} async connect() {} async listTools() { return { tools: [] }; } close() { return Promise.resolve(); } },
      StreamableHTTPClientTransport: class {},
    };
  };
  mcplive.kickProbe({ getClient, noCache: true });
  mcplive.kickProbe({ getClient, noCache: true }); // must be a no-op: one is already in flight
  assert.equal(mcplive.probeNow(), null, 'the background probe has not resolved yet — this call must not wait for it');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(starts, 1, 'a second kickProbe() while one is in flight must not start a second probe');
  assert.ok(mcplive.probeNow(), 'after it resolves, the result is cached');
});

test('an unreachable bridge reports reachable:false with a reason, never throws', async () => {
  const result = await mcplive.probe({
    getClient: async () => ({
      Client: class { constructor() {} async connect() { throw new Error('ECONNREFUSED'); } },
      StreamableHTTPClientTransport: class {},
    }),
  });
  assert.equal(result.reachable, false);
  assert.match(result.reason, /ECONNREFUSED/);
});

// --- The real thing: a genuine local bridge, over real HTTP -----------

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close((e) => e ? reject(e) : resolve(port)); });
  });
}

async function withBridge(fn) {
  const memory = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mcplive-'));
  fs.mkdirSync(path.join(memory, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(memory, '.mem', 'config.json'), JSON.stringify({ version: 1 }));
  const port = await freePort();
  let stderr = '';
  const child = spawn(process.execPath, [MCP, '--http'], {
    cwd: ROOT,
    env: { ...process.env, CHEAP_MEM_ROOT: memory, CHEAP_MEM_MCP_PORT: String(port) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  try {
    const until = Date.now() + 10000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`mem-mcp --http exited early: ${stderr}`);
      try {
        await new Promise((resolve, reject) => {
          const req = http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
            res.resume();
            res.on('end', () => (res.statusCode === 200 ? resolve() : reject(new Error(String(res.statusCode)))));
          });
          req.once('error', reject);
        });
        break;
      } catch {
        if (Date.now() > until) throw new Error(`mem-mcp --http never became ready: ${stderr}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    await fn(port);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
    fs.rmSync(memory, { recursive: true, force: true });
  }
}

test('POSITIVE CONTROL: probe() against a REAL bridge sees its real tools', { timeout: 20000 }, async () => {
  await withBridge(async (port) => {
    const result = await mcplive.probe({ env: { CHEAP_MEM_MCP_PORT: String(port) }, noCache: true });
    assert.equal(result.reachable, true, result.reason);
    assert.ok(result.names.length > 10, `expected many tools, got ${result.names.length}`);
    assert.ok(result.names.includes('mem_board'));
  });
});

test('with nothing listening on the configured port, the probe says unreachable, not thrown', { timeout: 10000 }, async () => {
  const port = await freePort(); // free, so guaranteed nothing is listening
  const result = await mcplive.probe({ env: { CHEAP_MEM_MCP_PORT: String(port) }, timeoutMs: 500, noCache: true });
  assert.equal(result.reachable, false);
  assert.ok(result.reason);
});

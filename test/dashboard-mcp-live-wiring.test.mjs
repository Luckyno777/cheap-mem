// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/dashboard-mcp-live-wiring.test.mjs — `/dashboard.json`'s
// `catalog.mcp` carries the live probe (src/mcplive.mjs) and the
// client-visibility journal (src/mcpvisibility.mjs), mirroring
// lucky-mem's dash-fix3.
//
// Red proof pinned to a FIXED commit (this agent's starting point,
// never `git merge-base` — see the agent frame): on
// ddca89d5430b7c2866a93788edd6fe14822af337, `catalog.mcp` has only
// `reading`/`writing`/`findings` — no `live`, no `clientVisible`,
// however many entries a real mcp-visibility journal already holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as mcpvisibility from '../src/mcpvisibility.mjs';
import * as mcplive from '../src/mcplive.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';

function memoryRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dash-mcplive-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'mcplivetest', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  // A real visibility journal, so the red proof and the green proof
  // read the SAME underlying data — only the wiring differs.
  mcpvisibility.record(r, { method: 'tools/list', tool: 'mem_board', client: 'probe-client' });
  return r;
}

async function start(scriptPath, root, env = {}) {
  const mod = await import(`${pathToFileURL(scriptPath).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '', ...env });
  const port = server.address().port;
  return {
    port, base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}

test.afterEach(() => mcplive._clearCache());

test('RED on the old commit: catalog.mcp carries no live/clientVisible field at all', { timeout: 20000 }, async () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:bin/mem-serve`], { cwd: REPO, encoding: 'utf8' });
  const tmpScript = path.join(REPO, 'bin', '.dash-mcplive-old-mem-serve.mjs');
  fs.writeFileSync(tmpScript, old);
  const root = memoryRoot();
  let s;
  try {
    s = await start(tmpScript, root);
    const res = await fetch(`${s.base}/dashboard.json`);
    const body = await res.json();
    assert.ok(body.catalog?.mcp, 'precondition: catalog.mcp must exist at all for this to be a meaningful red proof');
    assert.equal('live' in body.catalog.mcp, false, 'the old commit must not carry catalog.mcp.live');
    assert.equal('clientVisible' in body.catalog.mcp, false, 'the old commit must not carry catalog.mcp.clientVisible');
  } finally {
    await s?.stop();
    fs.rmSync(tmpScript, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GREEN on this commit: catalog.mcp carries live (cached/unknown, synchronous) and clientVisible (from the journal)', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root);
    const res = await fetch(`${s.base}/dashboard.json`);
    const body = await res.json();
    const mcp = body.catalog.mcp;
    assert.ok(mcp.live, 'catalog.mcp.live must be present');
    assert.ok(mcp.live.mem_board, 'a defined tool must have a live verdict');
    assert.ok(['good', 'error', 'unknown'].includes(mcp.live.mem_board.state));
    // Nothing was listening on the (default, unset) bridge port in this
    // test — so "unknown", never a guessed "good".
    assert.equal(mcp.live.mem_board.state, 'unknown');
    assert.ok(mcp.clientVisible, 'catalog.mcp.clientVisible must be present');
    assert.equal(mcp.clientVisible.mem_board.client, 'probe-client');
  } finally {
    await s?.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

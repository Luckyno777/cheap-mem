// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/mcp-visibility-journal.test.mjs — the MCP bridge writes a
// client-visibility journal (mirrors lucky-mem's dash-fix3, part 1b).
//
// Red proof pinned to a FIXED commit (never `git merge-base`, see the
// agent frame: a merge-base moves after the merge and would make this
// probe red again): on cm-spiegel2's starting commit
// (origin/main, ddca89d5430b7c2866a93788edd6fe14822af337) `bin/mem-mcp`
// logs nothing at all — `.pipeline/mcp-visibility.jsonl` never appears,
// however many tools were listed or called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { oldBinCopy } from './helpers/old-source-copy.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as mcpvisibility from '../src/mcpvisibility.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
// The commit this agent's worktree started from (agent/cm-spiegel2 off
// origin/main) — a fixed hash, never `git merge-base HEAD origin/main`.
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';
const SECRET = 'probe-must-not-leak-into-the-journal-8271';

function memory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mcpvis-'));
  spawnSync('node', [path.join(REPO, 'bin', 'mem'), 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return root;
}

function readReplies(r, what) {
  const lines = String(r.stdout ?? '').split('\n').filter((z) => z.trim());
  if (!lines.length) {
    throw new Error(`${what}: the MCP server produced no reply.\n`
      + `  status: ${r.status}  signal: ${r.signal ?? '(none)'}  spawn error: ${r.error?.message ?? '(none)'}\n`
      + `  stderr: ${String(r.stderr ?? '').trim().slice(0, 2000) || '(empty)'}`);
  }
  return lines.map((z) => JSON.parse(z));
}

/** Talk to a given mem-mcp SCRIPT (so the old-commit test can point at a
 *  temp copy while still resolving its relative `../src/...` imports). */
function bridge(script, root, extraEnv = {}) {
  const lines = [
    JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'mem_board', arguments: { note: SECRET } },
    }),
  ];
  const r = spawnSync('node', [script], {
    input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...extraEnv },
  });
  return { r, replies: readReplies(r, 'bridge') };
}

test('POSITIVE CONTROL: the probe really sees something — tools/list answers with tools', () => {
  const root = memory();
  try {
    const { replies } = bridge(MCP, root);
    const list = replies.find((a) => a.id === 2);
    assert.ok(list?.result?.tools?.length > 0, 'tools/list must return tools, or the probe below is blind');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('RED on the old commit (before this port): no visibility journal is written', () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:bin/mem-mcp`], { cwd: REPO, encoding: 'utf8' });
  // A throwaway package with its own bin/, so the relative imports
  // (`../src/...`) resolve through links to the live tree and nothing is
  // written into the live bin/. Removed in `finally` regardless of outcome.
  const copy = oldBinCopy(REPO, 'mem-mcp.mjs', old);
  const tmpScript = copy.script;
  const root = memory();
  try {
    const { r } = bridge(tmpScript, root);
    assert.equal(r.status, 0, `the old mem-mcp should run cleanly: ${r.stderr}`);
    const journal = path.join(root, mcpvisibility.LOG);
    assert.equal(fs.existsSync(journal), false,
      'the old commit must not produce a visibility journal at all — otherwise this red proof shows nothing');
  } finally {
    fs.rmSync(copy.dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GREEN on this commit: tools/list and tools/call each journal client + tool + time, never content', () => {
  const root = memory();
  try {
    bridge(MCP, root);
    const { rows, broken } = mcpvisibility.read(root);
    assert.equal(broken, 0);
    assert.ok(rows.length > 1, 'expected at least one tools/list row and the tools/call row');
    const listRow = rows.find((z) => z.method === 'tools/list' && z.tool === 'mem_board');
    const callRow = rows.find((z) => z.method === 'tools/call' && z.tool === 'mem_board');
    assert.ok(listRow, 'mem_board should appear in a tools/list row');
    assert.ok(callRow, 'mem_board should appear in a tools/call row');
    assert.equal(listRow.client, 't');
    assert.equal(callRow.client, 't');
    assert.ok(listRow.ts && callRow.ts);
    for (const z of rows) {
      assert.equal(Object.keys(z).sort().join(','), 'client,method,tool,ts',
        'a visibility row must carry ONLY tool, client, time and method — no call content');
    }
    const raw = fs.readFileSync(path.join(root, mcpvisibility.LOG), 'utf8');
    assert.ok(!raw.includes(SECRET), 'call arguments must never reach the visibility journal');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

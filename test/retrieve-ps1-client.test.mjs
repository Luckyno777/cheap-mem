// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// The PowerShell recall hook asks the warm recall server the same way the
// bash hook does: through the SAME Node client, with the same exit-code
// meaning, the same fallback (server gone -> direct) and the same ONE time
// budget. No pwsh in the environment that wrote this, so the twin is held
// by a static parity probe (this file reads both hooks) plus a probe of the
// client itself. UNVERIFIED on real Windows PowerShell - the CI job
// "powershell · windows" runs the parse; nothing here runs the .ps1.
//
// History: bin/mem-retrieve.ps1 asked the server since 34b7034, but
// docs/dashboard.md still said "does not ask it yet" and the commit 0ab25c7
// repeated "still always goes direct" - and nothing pinned the twin to the
// client, so a gate that quietly stops calling it would have looked the
// same as one that never did. The hook also never set MEM_HOOK_START_MS,
// so "one budget" was two clocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as place from '../src/recallserver-place.mjs';
import * as injection from '../src/injection.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASH = fs.readFileSync(path.join(REPO, 'bin', 'mem-retrieve'), 'utf8');
const PS1 = fs.readFileSync(path.join(REPO, 'bin', 'mem-retrieve.ps1'), 'utf8');
const CLIENT = path.join(REPO, 'bin', 'mem-retrieve-client.mjs');

/** exit code -> journal reason, as the bash `case "$FIND_RC" in` spells it. */
function bashMap(text) {
  const block = /case "\$FIND_RC" in([\s\S]*?)esac/.exec(text)?.[1] ?? '';
  const map = {};
  for (const m of block.matchAll(/^\s*([\d|]+)\)\s*RECALL_REASON=([\w-]+)/gm)) {
    for (const code of m[1].split('|')) map[code] = m[2];
  }
  return map;
}
/** the same, as the PowerShell `switch ($LASTEXITCODE)` spells it. */
function psMap(text) {
  const block = /switch \(\$LASTEXITCODE\) \{([\s\S]*?)\n\s*\}\n/.exec(text)?.[1] ?? '';
  const map = {};
  for (const m of block.matchAll(/^\s*(\d+)\s*\{\s*\$RecallReason = '([\w-]+)'/gm)) map[m[1]] = m[2];
  return map;
}

test('POSITIVE: both readers find the exit-code table at all', () => {
  assert.deepEqual(bashMap('case "$FIND_RC" in\n    3) RECALL_REASON=a ;;\n    4|124) RECALL_REASON=b ;;\n  esac'), { 3: 'a', 4: 'b', 124: 'b' });
  assert.deepEqual(psMap("switch ($LASTEXITCODE) {\n    3 { $RecallReason = 'a' }\n    4 { $RecallReason = 'b' }\n  }\n"), { 3: 'a', 4: 'b' });
  assert.ok(Object.keys(bashMap(BASH)).length >= 5, 'bash table not read');
  assert.ok(Object.keys(psMap(PS1)).length >= 4, 'ps1 table not read');
});

test('both hooks call the SAME client with the same arguments', () => {
  assert.match(BASH, /bin\/mem-retrieve-client\.mjs" "\$ROOT" "\$PROMPT" "\$TOP"/);
  assert.match(PS1, /\$ClientJs = Join-Path \$ToolRoot 'bin\/mem-retrieve-client\.mjs'/);
  assert.match(PS1, /& node \$ClientJs \$Root \$Prompt \$Top/);
  // Neither hook searches the server itself: no socket code in the hooks.
  for (const text of [BASH, PS1]) assert.doesNotMatch(text, /NamedPipeClientStream|net\.connect|nc -U/);
});

test('the exit codes the client can return map to the same reasons in both hooks', () => {
  const rcs = place.CLIENT_RC;
  const want = {
    [rcs.NO_SERVER]: injection.PATH_REASON.SERVER_GONE,
    [rcs.TIMEOUT]: injection.PATH_REASON.SERVER_TIMEOUT,
    [rcs.REFUSED]: injection.PATH_REASON.SERVER_REFUSED,
    [rcs.STALE]: injection.PATH_REASON.SERVER_STALE,
  };
  const b = bashMap(BASH);
  const p = psMap(PS1);
  for (const [code, reason] of Object.entries(want)) {
    assert.equal(b[code], reason, `bash: exit ${code}`);
    assert.equal(p[code], reason, `ps1: exit ${code}`);
  }
  // Everything else is an error in both, never a silent "fine".
  assert.match(BASH, /\*\) RECALL_REASON=server-error/);
  assert.match(PS1, /default \{ \$RecallReason = 'server-error' \}/);
});

test('both hooks honour the same switch and the same directory and key names', () => {
  assert.match(BASH, /"\$\{MEM_RECALL_SERVER:-\}" != "0"/);
  assert.match(PS1, /\$env:MEM_RECALL_SERVER -ne '0'/);
  assert.match(BASH, /MEM_RECALL_SERVER_DIR:-\$ROOT\/\.pipeline\/recall/);
  assert.match(PS1, /\$env:MEM_RECALL_SERVER_DIR/);
  assert.match(PS1, /\.pipeline\/recall\/key/);
  assert.equal(place.KEY_NAME, 'key');
  // Server gone / not answering -> the direct `find` runs (same line in both, no early exit between).
  assert.match(PS1, /if \(\$RecallPath -ne 'server'\) \{\s*\n\s*\$Hits = \(& node @MemArgv find \$Prompt --top \$Top --json/);
});

test('one budget: the .ps1 sets the hook start BEFORE its first node call', () => {
  const start = PS1.indexOf('$env:MEM_HOOK_START_MS');
  const startRh = PS1.indexOf('$env:MEM_RH_START_MS');
  const firstNode = PS1.search(/& node /);
  assert.ok(start > 0 && startRh > 0, 'MEM_HOOK_START_MS / MEM_RH_START_MS are not set');
  assert.ok(start < firstNode && startRh < firstNode, 'the clock starts after a node call already ran');
  assert.match(PS1, /\[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\)/);
  // No clock is overwritten later on.
  assert.equal(PS1.split('$env:MEM_HOOK_START_MS =').length, 2);
});

function runClient(root, env) {
  return new Promise((resolve) => {
    const k = spawn(process.execPath, [CLIENT, root, 'a question long enough to search', '3'], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    k.stdout.on('data', (s) => { out += s; });
    const t0 = Date.now();
    k.on('exit', (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

test('client probe: no server -> exit 3, nothing on stdout (the hook then goes direct)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ps1c-'));
  try {
    const r = await runClient(root, { MEM_RECALL_SERVER_DIR: path.join(root, 'nothing-here') });
    assert.equal(r.code, place.CLIENT_RC.NO_SERVER);
    assert.equal(r.out, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('client probe: the budget counts from MEM_HOOK_START_MS, which is what the .ps1 now sets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ps1c-'));
  const w = place.place(root, {});
  fs.mkdirSync(w.dir, { recursive: true });
  fs.writeFileSync(w.key, 'x'.repeat(64));
  // Accepts and never answers (resume: a paused socket never sees the client hang up,
  // and close() below would wait for it forever).
  const hang = net.createServer((s) => { s.on('error', () => {}); s.resume(); });
  await new Promise((r) => hang.listen(w.socket, r));
  try {
    // The hook started 4.8 s ago of a 5 s budget: little is left, the client must not
    // wait its full 60 s (or even its default 2.5 s) - a second clock would.
    const r = await runClient(root, {
      MEM_RETRIEVE_TIME: '5', MEM_RECALL_SERVER_WAIT_MS: '60000',
      MEM_HOOK_START_MS: String(Date.now() - 4800),
    });
    assert.equal(r.code, place.CLIENT_RC.TIMEOUT, r.out);
    assert.equal(r.out, '');
    assert.ok(r.ms < 1500, `waited ${r.ms} ms although the budget was spent`);
    // Positive control: a fresh start gives it real time to wait (and then it times out at the cap).
    const fresh = await runClient(root, {
      MEM_RETRIEVE_TIME: '2.5', MEM_RECALL_SERVER_WAIT_MS: '60000', MEM_HOOK_START_MS: String(Date.now()),
    });
    assert.equal(fresh.code, place.CLIENT_RC.TIMEOUT);
    assert.ok(fresh.ms > r.ms + 200, `a fresh budget waited only ${fresh.ms} ms vs ${r.ms} ms`);
  } finally {
    await new Promise((r) => hang.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

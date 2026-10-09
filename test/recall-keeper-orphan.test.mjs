// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// recall-keeper-orphan.test.mjs — `mem serve` must not leave its recall
// server child behind (M10 follow-up).
//
// Chain run 2026-10-01: test/cli-contract.test.mjs SIGTERMs `mem serve`.
// The keeper had no signal handler, so the child (bin/mem-recall-server.mjs)
// survived as an orphan, kept the test's stdout/stderr pipes open, and the
// whole suite hung for 30 minutes. Two guards now: the keeper takes the
// child down on SIGTERM/SIGINT, and the child stops by itself when its
// parent is gone (the only guard that also holds for SIGKILL).
//
// Red on the state before the fix: both tests time out with the child alive.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const linux = process.platform === 'linux';

function childrenOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
  } catch { return []; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function startServe() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orphan-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  const sock = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-orphan-sock-'));
  const serve = spawn(process.execPath, [MEM, 'serve', '--port', '0', '--root', root], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MEM_RECALL_SERVER_DIR: sock },
  });
  let out = '';
  serve.stdout.on('data', (b) => { out += b; });
  serve.stderr.on('data', (b) => { out += b; });
  // `mem serve` may run the server in a further node process; find the
  // recall server anywhere below it.
  const bis = Date.now() + 15000;
  let kid = null;
  while (!kid && Date.now() < bis) {
    await new Promise((r) => setTimeout(r, 100));
    const queue = [serve.pid];
    while (queue.length && !kid) {
      const p = queue.shift();
      for (const c of childrenOf(p)) {
        let cmd = '';
        try { cmd = fs.readFileSync(`/proc/${c}/cmdline`, 'utf8'); } catch { /* gone */ }
        if (cmd.includes('mem-recall-server')) { kid = c; break; }
        queue.push(c);
      }
    }
  }
  return { serve, kid, root, sock, out: () => out };
}

async function gone(pid, ms) {
  const bis = Date.now() + ms;
  while (alive(pid) && Date.now() < bis) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

for (const sig of ['SIGTERM', 'SIGKILL']) {
  test(`${sig} to mem serve: the recall server child does not survive`, { skip: linux ? false : 'needs /proc' }, async () => {
    const s = await startServe();
    try {
      assert.ok(s.kid, `positive control: a recall server child runs under mem serve\n${s.out()}`);
      assert.ok(alive(s.kid));
      // Kill every process from mem serve down to (excluding) the child —
      // the keeper is whichever of them holds it.
      const keeper = Number(fs.readFileSync(`/proc/${s.kid}/stat`, 'utf8').split(') ')[1].split(' ')[1]);
      process.kill(keeper, sig);
      if (keeper !== s.serve.pid) { try { s.serve.kill(sig); } catch { /* gone */ } }
      assert.ok(await gone(s.kid, 8000), `the child ${s.kid} outlived its keeper after ${sig}`);
    } finally {
      try { if (s.kid && alive(s.kid)) process.kill(s.kid, 'SIGKILL'); } catch { /* gone */ }
      try { s.serve.kill('SIGKILL'); } catch { /* gone */ }
      fs.rmSync(s.root, { recursive: true, force: true });
      fs.rmSync(s.sock, { recursive: true, force: true });
    }
  });
}

// Windows: an orphaned child keeps `process.ppid` of the dead parent, so the keeper-run server must
// also ask whether the parent pid still exists (src/recallserver.mjs parentGone).
test('parentGone: a changed ppid, a dead parent pid with an unchanged ppid (Windows), but not a live or foreign-owned one', async () => {
  const { parentGone } = await import('../src/recallserver.mjs');
  const dead = () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; };
  const foreign = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
  assert.equal(parentGone(100, 1, () => true), true, 'POSIX: reparented');
  assert.equal(parentGone(100, 100, dead), true, 'Windows: ppid unchanged but the parent is gone');
  assert.equal(parentGone(100, 100, () => true), false, 'positive control: a live parent');
  assert.equal(parentGone(100, 100, foreign), false, 'EPERM means it exists');
  assert.equal(parentGone(process.ppid), false, 'the real probe on the real parent');
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// @ts-check
/**
 * recallserver-keeper.mjs — keeps the warm recall server running (M10 follow-up).
 *
 * **Why a child process.** An update (a pull, a release) puts new code
 * under `src/`. A server inside the `mem serve` process could only stop
 * then — ESM loads each module once per process, a fresh import needs a
 * new process. So the server runs as a child (bin/mem-recall-server.mjs);
 * when it exits with STALE_RC, this keeper starts a new one. Until that one
 * listens there is no socket, and the hook runs direct (as without a server).
 *
 * **Rate limit.** At most one start per MEM_RECALL_SERVER_RESTART_MS
 * (default 60000): an update that lands in several steps cannot make the
 * server spin. Every restart writes a log line (stderr, i.e. serve.log /
 * the service journal).
 *
 * **Only on `stale`.** A child that exits 1 (start failed: path too long,
 * foreign directory, a server already there) stays off — repeating a
 * failure every 60 s only hides it. A crash (signal, other code) is
 * treated like `stale`: restarted, under the same rate limit.
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STALE_RC } from './recallserver.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem-recall-server.mjs');

export function keep(root, { env = process.env, log = null, now = () => Date.now() } = {}) {
  const say = log ?? ((t) => process.stderr.write(`recall server: ${t}\n`));
  const gapMs = Number(env.MEM_RECALL_SERVER_RESTART_MS) > 0 ? Number(env.MEM_RECALL_SERVER_RESTART_MS) : 60000;
  let child = null;
  let off = false;
  let lastStart = -Infinity;
  let timer = null;
  const starts = [];

  const launch = (reason) => {
    if (off) return;
    timer = null;
    lastStart = now();
    starts.push(lastStart);
    if (reason) say(`restart (${reason})`);
    child = spawn(process.execPath, [CHILD], {
      // MEM_RECALL_SERVER_PARENT: the child watches this pid and stops when it
      // is gone — the only guard that also holds when `mem serve` is SIGKILLed.
      env: { ...env, CHEAP_MEM_ROOT: root, MEM_RECALL_SERVER_PARENT: String(process.pid) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (off) return;
      if (code === 1) { say('recall server did not start (see the line above) — no restart'); return; }
      const why = code === STALE_RC ? 'code under src/ changed' : `child exited with ${signal ?? code}`;
      const wait = Math.max(0, lastStart + gapMs - now());
      if (wait > 0) say(`${why} — restart in ${Math.ceil(wait / 1000)} s (at most one per ${Math.round(gapMs / 1000)} s); the hook runs direct until then`);
      // A timer may fire up to 1 ms early against now() (the timer clock and
      // Date.now are different clocks; seen in lucky-mem's chain run: 1999 ms
      // for a 2000 ms gap). So check again on firing and wait out the rest.
      const wake = () => {
        const rest = lastStart + gapMs - now();
        if (rest > 0) { timer = setTimeout(wake, rest); timer.unref?.(); return; }
        launch(why);
      };
      timer = setTimeout(wake, wait);
      timer.unref?.();
    });
  };
  launch(null);

  // A SIGTERM/SIGINT to `mem serve` ends the process without closing the
  // HTTP server, so `stop()` never ran and the child was left behind as an
  // orphan, holding the parent's stdout/stderr open (chain run 2026-10-01:
  // test/cli-contract.test.mjs hung for 30 minutes on exactly that). Take
  // the child down, then re-raise the signal so the default exit stays.
  const onSignal = (sig) => {
    unhook();
    off = true;
    if (timer) clearTimeout(timer);
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
    process.kill(process.pid, sig);
  };
  const onTerm = () => onSignal('SIGTERM');
  const onInt = () => onSignal('SIGINT');
  const onExit = () => { try { child?.kill('SIGTERM'); } catch { /* already gone */ } };
  const unhook = () => {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt); process.off('exit', onExit);
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  process.on('exit', onExit);

  return {
    starts,
    stop: () => new Promise(/** @type {(resolve: (v?: any) => void) => void} */ ((resolve) => {
      unhook();
      off = true;
      if (timer) clearTimeout(timer);
      if (!child) { resolve(); return; }
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
    })),
  };
}

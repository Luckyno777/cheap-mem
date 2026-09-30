// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * tasks.mjs — long CLI work as tasks (Bauplan E1.7, English mirror).
 *
 * Mirrors lucky-mem's `src/vorgaenge.mjs` (its commit `d6880335`, section
 * "E1.7 Datenvertrag Vorgaenge" in its own dashboard coverage notes) —
 * same shape, cheap-mem's own commands.
 *
 * **What does NOT happen here: a second code path.** A task is a child
 * process of an EXISTING CLI command — `bin/mem raw export`, `bin/mem
 * chain`. This module invents no export or verification logic of its
 * own; it starts, follows and ends exactly the command a person would
 * type on the CLI.
 *
 * **The inventory before this work (checked against the source, not
 * guessed).** cheap-mem has two real long-running CLI paths that match
 * what the plan asks for:
 *
 *   export                    -> `mem raw export --into <dir> --json`
 *                                 (`src/cli/commands/capture.mjs`, branch
 *                                 `sub === 'export'`)
 *   deep integrity check       -> `mem chain --json`
 *                                 (`src/cli/commands/admin.mjs`, `chain:`;
 *                                 `src/chain.mjs:verifyChain()` reads
 *                                 every drawer file in full and recomputes
 *                                 every sealed hash from the current
 *                                 content — the same idea as lucky-mem's
 *                                 tief check, just without a `--tief`
 *                                 flag of its own: `chain` has only the
 *                                 one, always-full mode)
 *
 * A THIRD kind — an index rebuild — has NO clean equivalent and is
 * deliberately left out rather than invented. `mem find --fresh` does
 * force `search.loadIndex()` to rebuild, but `find` also REQUIRES a
 * query and returns THAT query's hits — coupling "rebuild the index" to
 * an arbitrary search would give this module a second job it did not
 * ask for. `mem browse --fresh` has the same rebuild but needs a
 * terminal (interactive; no `--json`, unusable headless). `mem embed
 * backfill --force` rebuilds an index (the optional vector store), but
 * that store is off by default, needs optional dependencies
 * (`better-sqlite3`, `sqlite-vec`) and, for most providers, an API key —
 * naming it "the" index rebuild would suggest it covers the everyday
 * BM25 search index, which it does not. None of the three is a fit;
 * The long-running kinds in `KINDS` below stay at two, not three, on purpose
 * (the two parameterised kinds added on 2026-09-28 — `raw-delete`, `done` —
 * are short, one-shot CLI calls the dashboard runs, not index work). See
 * `docs/dashboard-tasks.md` for the same finding written out.
 *
 * **Progress only where the command really reports one.** Neither
 * `raw export` nor `chain` writes an intermediate line anywhere — no
 * module in this codebase does (checked: no `stderr.write` call in
 * `src/*.mjs` reports fractional progress). So `progressPattern` below
 * is `null` for both, honestly, and `read()` answers `'running (no
 * progress measurable)'` for the whole time a task runs — never an
 * invented percentage or bar.
 *
 * **Resume, for all kinds, is honestly "restart".** Neither command has
 * a partial state to resume FROM: `raw export` writes files one at a
 * time but keeps no resume pointer of its own, `chain` is a single,
 * stateless read pass. Restarting either with the same inputs is safe
 * (idempotent, or read-only in `chain`'s case) — this module claims no
 * resume-from-the-break ability that neither command has.
 *
 * **The lock is per running server instance.** At most one task per
 * kind at a time, held in an in-memory `Map` (`ACTIVE`), not in the
 * state file — the file knows the history, the map knows the live
 * child handle (needed to cancel it). A second `start()` of the same
 * kind, while the first has not fired its `close` event yet, throws
 * `LOCK_ACTIVE`. The lock is free again the instant `close` fires,
 * whatever the outcome.
 *
 * **A server restart mid-task never reads back as `running` forever.**
 * `SERVER_EPOCH` is created fresh once per process start and written
 * into every `started` event. `read()` only calls a task `running` when
 * (a) THIS instance's `ACTIVE` map still holds that exact id for that
 * kind, AND (b) the epoch in the `started` line matches the epoch
 * running right now. After a restart `ACTIVE` is empty, so any task
 * that never reached a terminal event reads back `state:'unknown'`,
 * `running:'unknown'` — never `running:true` for a process nobody here
 * is watching any more, and never `running:false` either (that would
 * claim to know it finished, which nobody here saw happen).
 *
 * **Cancel is a confirmed end, not a signal sent into the unknown.**
 * Every child is spawned in its own process group (POSIX: `detached:
 * true`, so its pgid equals its own pid). `cancel()` signals `-pid`
 * (the whole group) with SIGTERM, waits with `process.kill(pid, 0)` in
 * a loop for the real end (no `pgrep`, no trusting a service manager),
 * and escalates to SIGKILL after 4 seconds. Windows has no POSIX
 * process groups; there, `taskkill /pid <pid> /t /f` is asked to end
 * the whole tree instead, and the same `process.kill(pid, 0)` wait
 * follows (Node implements the existence check with signal `0` on every
 * platform). Only once the child's own `close` event fires does
 * `start()`'s own handler write the `cancelled` line — the proof is the
 * process actually being gone, never this function's return value.
 *
 * **Children start without an inherited lock fd.** cheap-mem's own lock
 * helper (`mem_take_lock` in `bin/_portable.sh`, used by `bin/mem-digest`
 * and `bin/mem-watch`) holds its exclusive claim on fd 9 via `exec 9>
 * "$lock"` in a bash process — a bash-opened fd carries no
 * close-on-exec flag by default, so if `mem-serve` itself were ever
 * started from under such a claim, fd 9 would otherwise travel into
 * every child this module spawns. `spawnChild()` below does not need a
 * shell wrapper for this the way lucky-mem's bash-based fix did: Node's
 * `child_process.spawn` never hands a child any fd beyond what `stdio`
 * names, so naming fds 3 through 9 as `'ignore'` (bound to `/dev/null`
 * instead of inherited) closes the one that matters — and a few either
 * side of it, for the same reason — without touching `_portable.sh` at
 * all.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { appendLine } from './append.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM_BIN = path.join(HERE, '..', 'bin', 'mem');

/** Created fresh once per process start — the restart detector. */
const SERVER_EPOCH = `${process.pid}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/** kind -> { id, child, epoch, ended, cancelReason } — only a task THIS
 * server instance itself started ever lands here. */
const ACTIVE = new Map();

function nowIso() { return new Date().toISOString(); }

function newId() {
  return `${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
}

/** Only `[a-z0-9]`, else an id could walk out of the tasks directory via
 * `..`/`/` — the id arrives raw, from a URL query. */
export function validId(id) {
  return typeof id === 'string' && /^[a-z0-9]{6,40}$/.test(id);
}

function tasksDir(root) { return path.join(root, '.mem', 'tasks'); }
export function statePath(root, id) { return path.join(tasksDir(root), `${id}.jsonl`); }
function exportTarget(root, id) { return path.join(tasksDir(root), id, 'export'); }

/**
 * The closed list of kinds this route can start. Leaving a kind out of
 * here means it cannot be reached over `/task` at all — the same
 * pattern `src/console.mjs`'s `SETTINGS` already uses: a fixed table,
 * never an open field name.
 */
export const KINDS = Object.freeze({
  export: {
    title: 'Raw capture export',
    description: 'mem raw export --into <dir> --json — decompresses every '
      + 'raw capture the record still names, over the full range (no '
      + '--from/--to).',
    resume: 'restart',
    command(root, id) {
      return { file: MEM_BIN, args: ['raw', 'export', '--into', exportTarget(root, id), '--json'] };
    },
    progressPattern: null,
    classify(json) {
      if (Array.isArray(json?.missing) && json.missing.length > 0) {
        return {
          state: 'warning',
          reason: `${json.missing.length} capture(s) recorded but not reachable `
            + '(archive not mounted?)',
        };
      }
      return { state: 'ok', reason: null };
    },
  },
  integrity: {
    title: 'Per-writer hash chain check',
    description: 'mem chain --json — recomputes every sealed hash from the '
      + 'current file content and compares it against what was sealed; '
      + 'reads every drawer file in full.',
    resume: 'restart',
    command() {
      return { file: MEM_BIN, args: ['chain', '--json'] };
    },
    progressPattern: null,
    // `verifyChain()`'s own `state` is 'ok' | 'unknown' (no seal ever
    // written -- unverifiable, not a clean bill of health) | 'error'
    // (a sealed line changed). Both non-'ok' cases are a REPORT the
    // command finished and produced, not a crash of this module -- so,
    // same rule lucky-mem's own `pruefung` classify follows, both land
    // on task-level 'warning', never 'error'. 'error' here is reserved
    // for "the process produced nothing usable", see classifyResult().
    classify(json) {
      if (json?.state === 'error') {
        return {
          state: 'warning',
          reason: `${(json.tampered ?? []).length} writer(s) failed hash verification`,
        };
      }
      if (json?.state === 'unknown') {
        return {
          state: 'warning',
          reason: 'no seal has ever been written -- nothing here can be verified '
            + '(sealing is off unless chainSealCadence is set in .mem/config.json)',
        };
      }
      return { state: 'ok', reason: null };
    },
  },
  // **Two kinds that TAKE PARAMETERS (2026-09-28, the dashboard port).**
  // The sibling house deletes a raw capture and marks an entry done from
  // its dashboard exactly this way: as a task — a child process of the
  // existing CLI command, behind the same write gate as every task. No
  // new write route, no second deletion code path. The parameters are a
  // CLOSED list per kind (`params`), each validated before anything is
  // spawned; an unknown or malformed field is refused with
  // `INVALID_PARAMS`, never passed through to a command line.
  'raw-delete': {
    title: 'Delete one raw capture',
    description: 'mem raw delete <path> --reason "..." --by dashboard --yes --json — removes the '
      + 'BYTES of one capture from the archive (irreversible) and appends a tombstone to the '
      + 'register. The dashboard runs it once per capture, after a preview and a confirmation.',
    resume: 'restart',
    params: {
      path: { required: true, check: (v) => /^[A-Za-z0-9._/-]{1,300}$/.test(v) && !v.includes('..') && !v.startsWith('/'),
        why: 'a relative capture path as `mem raw review` lists it' },
      reason: { required: true, check: (v) => v.trim().length >= 3 && v.length <= 500 && !/[\u0000-\u001f]/.test(v),
        why: 'a reason of 3 to 500 characters, one line' },
    },
    command(root, id, p) {
      return { file: MEM_BIN, args: ['raw', 'delete', p.path, '--reason', p.reason, '--by', 'dashboard', '--yes', '--json'] };
    },
    progressPattern: null,
    classify(json) {
      return Number.isFinite(json?.freed) || json?.path || json?.at
        ? { state: 'ok', reason: null }
        : { state: 'warning', reason: 'delete answered, but not with the expected shape' };
    },
  },
  done: {
    title: 'Mark an entry done',
    description: 'mem done <id> --why "..." — appends a tombstone line with state done; the '
      + 'original stays in the log (append-only).',
    resume: 'restart',
    params: {
      id: { required: true, check: (v) => /^[A-Za-z0-9_-]{4,64}$/.test(v), why: 'an entry id' },
      why: { required: false, check: (v) => v.length <= 2000 && !/[\u0000-\u0008\u000b-\u001f]/.test(v), why: 'up to 2000 characters' },
    },
    command(root, id, p, context) {
      return { file: MEM_BIN, args: ['done', p.id, ...(p.why ? ['--why', p.why] : []), ...authorityArgs(context)] };
    },
    progressPattern: null,
    // `mem done` prints one plain line ("done: <id> (...)"), no JSON.
    plainOk: /^done: /m,
    classify() { return { state: 'ok', reason: null }; },
  },
});

/**
 * Check a kind's parameters against its closed list. Throws
 * `INVALID_PARAMS` naming the field — never passes an unknown field on.
 */
export function checkParams(kind, params = {}) {
  const spec = KINDS[kind];
  const allowed = spec?.params ?? {};
  const out = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (!Object.hasOwn(allowed, k)) {
      const e = new Error(`task '${kind}' takes no parameter '${k}'. Known: ${Object.keys(allowed).join(', ') || 'none'}`);
      e.code = 'INVALID_PARAMS';
      throw e;
    }
    const val = String(v ?? '');
    if (!allowed[k].check(val)) {
      const e = new Error(`task '${kind}': parameter '${k}' must be ${allowed[k].why}`);
      e.code = 'INVALID_PARAMS';
      throw e;
    }
    out[k] = val;
  }
  for (const [k, def] of Object.entries(allowed)) {
    if (def.required && !(k in out)) {
      const e = new Error(`task '${kind}': parameter '${k}' is required (${def.why})`);
      e.code = 'INVALID_PARAMS';
      throw e;
    }
  }
  return out;
}

/**
 * The last complete JSON value out of a child's stdout.
 *
 * **Why not "split on newlines, parse the last one"**, the way
 * lucky-mem's `aus()` convention allows (every CLI tool there prints
 * ONE compact line for `--json`). cheap-mem's own commands do not agree
 * with each other: `raw export --json` prints one compact line
 * (`JSON.stringify({...})`), but `chain --json` prints
 * `JSON.stringify(verdict, null, 2)` — pretty, multi-line. A per-line
 * parse would see only fragments of that second shape and find nothing.
 * So: try the WHOLE trimmed output first (covers both --json forms,
 * since neither command writes anything else to stdout once --json
 * short-circuits it); only if that fails, fall back to scanning lines
 * from the end backwards, for a future kind that prints compact JSON
 * after other prose.
 */
function lastJsonPayload(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* not one whole value -- try per line */ }
  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking backwards */ }
  }
  return null;
}

function classifyResult(kind, { code, stdout, stderrTail }) {
  const json = lastJsonPayload(stdout);
  const spec = KINDS[kind];
  if (json) {
    const verdict = spec.classify(json) ?? { state: 'ok', reason: null };
    if (code !== 0 && verdict.state === 'ok') {
      // The JSON reads fine, but the process still reported a nonzero
      // exit — never silently 'ok' over that disagreement.
      return { state: 'warning', result: json, reason: `exit code ${code}` };
    }
    return { state: verdict.state, result: json, reason: verdict.reason };
  }
  if (code === 0 && spec.plainOk && spec.plainOk.test(String(stdout ?? ''))) {
    return { state: 'ok', result: { output: String(stdout).trim().slice(0, 2000) }, reason: null };
  }
  // No JSON at all. Exit 0 without JSON is NOT automatically a failure
  // of this module — `raw export` returns `out('No captures in that
  // range.')` and BEFORE its own `--json` check when the range is
  // empty (found reading `src/cli/commands/capture.mjs`, branch
  // `sub === 'export'`: the `!hit.length` return sits ahead of the
  // `args.json` check). That is a legitimate, non-error outcome — only
  // without structure, so honestly 'warning', never 'error' for a
  // process that ran cleanly.
  if (code === 0) {
    return {
      state: 'warning',
      result: null,
      reason: 'process finished successfully, but without usable JSON: '
        + `${String(stdout ?? '').trim().slice(0, 500) || '(empty output)'}`,
    };
  }
  return {
    state: 'error',
    result: null,
    reason: stderrTail ? stderrTail.slice(-2000) : `exit code ${code}, no usable output`,
  };
}

/**
 * Spawn a child of `file` with `args` — always via `process.execPath`,
 * never by executing `file` itself. Two independent reasons: it is
 * exactly how this project's own tests already invoke `bin/mem` (see
 * e.g. `test/console.test.mjs`), and it sidesteps a `noexec`-mounted
 * working tree the same way `bin/_portable.sh`'s header comment
 * documents for its own hooks — a file that may not be EXECUTED may
 * still be READ.
 *
 * `stdio` closes fds 3 through 9 rather than inherit them (see the file
 * header on why fd 9 in particular matters), and `detached: true` on
 * POSIX gives the child its own process group so `cancel()` can signal
 * the whole group without touching this server's own.
 */
function spawnChild(file, args, root) {
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (process.platform !== 'win32') {
    for (let fd = 3; fd <= 9; fd += 1) stdio.push('ignore');
  }
  return spawn(process.execPath, [file, ...args], {
    cwd: root,
    env: { ...process.env, CHEAP_MEM_ROOT: root },
    stdio,
    detached: process.platform !== 'win32',
  });
}

/**
 * Start a task. Throws with `e.code`:
 *  - 'UNKNOWN_KIND'   — `kind` is not in `KINDS`
 *  - 'LOCK_ACTIVE'     — the same kind is already running in this server
 *                         instance (`e.runningId` names the id)
 *  - 'INVALID_PARAMS'  — a parameter is unknown, malformed or missing
 */
/**
 * Y4b: `--authority user` for a kind that writes a state change (`done`),
 * ONLY when the caller — the dashboard server — has established that a
 * signed-in person triggered it (`context.user === true`: a valid
 * PASSWORD session, see bin/mem-serve). Never from the form parameters:
 * those are a closed list without `authority`, or anyone with a write
 * path could make themselves the user. Without it the line gets the
 * write path's default (`agent`).
 */
function authorityArgs(context) {
  return context?.user === true ? ['--authority', 'user'] : [];
}

export function start(root, kind, params = {}, context = {}) {
  const spec = KINDS[kind];
  if (!spec) {
    const e = new Error(`unknown kind '${kind}'. Known: ${Object.keys(KINDS).join(', ')}`);
    e.code = 'UNKNOWN_KIND';
    throw e;
  }
  const checked = checkParams(kind, params);
  const running = ACTIVE.get(kind);
  if (running && running.epoch === SERVER_EPOCH && !running.ended) {
    const e = new Error(`task '${kind}' is already running (id=${running.id}).`);
    e.code = 'LOCK_ACTIVE';
    e.runningId = running.id;
    throw e;
  }

  const id = newId();
  fs.mkdirSync(tasksDir(root), { recursive: true });
  const file = statePath(root, id);
  const { file: prog, args } = spec.command(root, id, checked, context);

  const child = spawnChild(prog, args, root);
  const ts = nowIso();
  appendLine(file, `${JSON.stringify({
    event: 'started', ts, id, kind, pid: child.pid, serverEpoch: SERVER_EPOCH,
    command: [prog, ...args], params: checked,
    ...(context?.user === true ? { user: true } : {}),
  })}\n`);

  const entry = { id, child, epoch: SERVER_EPOCH, ended: false, cancelReason: null };
  ACTIVE.set(kind, entry);

  let stdout = '';
  let stderrTail = '';
  const CAP = 4 * 1024 * 1024;
  child.stdout.on('data', (chunk) => {
    if (stdout.length < CAP) stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-8000);
    if (!spec.progressPattern) return;
    for (const line of String(chunk).split('\n')) {
      const s = line.trim();
      if (s && spec.progressPattern.test(s)) {
        appendLine(file, `${JSON.stringify({ event: 'progress', ts: nowIso(), text: s })}\n`);
      }
    }
  });
  child.on('error', (e) => {
    appendLine(file, `${JSON.stringify({
      event: 'result', ts: nowIso(), state: 'error', result: null,
      reason: `child process could not be started: ${e.message}`, exitCode: null,
    })}\n`);
    entry.ended = true;
    if (ACTIVE.get(kind) === entry) ACTIVE.delete(kind);
  });
  child.on('close', (code) => {
    entry.ended = true;
    if (entry.cancelReason) {
      appendLine(file, `${JSON.stringify({
        event: 'cancelled', ts: nowIso(), reason: entry.cancelReason, exitCode: code,
      })}\n`);
    } else {
      const verdict = classifyResult(kind, { code, stdout, stderrTail });
      appendLine(file, `${JSON.stringify({
        event: 'result', ts: nowIso(), state: verdict.state,
        result: verdict.result, reason: verdict.reason, exitCode: code,
      })}\n`);
    }
    if (ACTIVE.get(kind) === entry) ACTIVE.delete(kind);
  });

  return { id, kind, started: ts };
}

/** Wait for `pid` to be really gone, with `process.kill(pid, 0)` (no
 * `pgrep`, no trusting a service manager). Resolves `true` the instant
 * ESRCH (or Windows' equivalent) comes back, else `false` once
 * `timeoutMs` has passed. */
async function waitForExit(pid, timeoutMs) {
  const started = Date.now();
  for (;;) {
    try { process.kill(pid, 0); } catch { return true; }
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((r) => { setTimeout(r, 50); });
  }
}

/** Signal the whole process tree, not just the one pid — a command that
 * itself starts a grandchild must not be left behind. POSIX: the
 * negative pid addresses the whole process group `spawnChild()` gave
 * the child its own copy of. Windows has no such group; `taskkill
 * /t /f` is asked to end the tree instead, and SIGTERM/SIGKILL collapse
 * to the one thing Windows has (TerminateProcess) either way. */
function signalTree(pid, signal) {
  if (process.platform === 'win32') {
    try { spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' }); }
    catch { /* already gone */ }
    return;
  }
  try { process.kill(-pid, signal); return; } catch { /* group already gone, or never had one */ }
  try { process.kill(pid, signal); } catch { /* process already gone */ }
}

/**
 * End the kind's running task — really, not only a signal sent.
 * Throws with `e.code`:
 *  - 'UNKNOWN_KIND'    — `kind` is not in `KINDS`
 *  - 'NOTHING_ACTIVE'  — no task of this kind, started by THIS server
 *                         instance, is still running
 */
export async function cancel(root, kind) {
  if (!KINDS[kind]) {
    const e = new Error(`unknown kind '${kind}'.`);
    e.code = 'UNKNOWN_KIND';
    throw e;
  }
  const entry = ACTIVE.get(kind);
  if (!entry || entry.epoch !== SERVER_EPOCH || entry.ended) {
    const e = new Error(`no running task '${kind}' in this server instance.`);
    e.code = 'NOTHING_ACTIVE';
    throw e;
  }
  const { id, child } = entry;
  const pid = child.pid;

  entry.cancelReason = 'SIGTERM';
  signalTree(pid, 'SIGTERM');
  let dead = await waitForExit(pid, 4000);
  if (!dead) {
    entry.cancelReason = 'SIGTERM was not enough -- SIGKILL';
    signalTree(pid, 'SIGKILL');
    dead = await waitForExit(pid, 4000);
  }
  // `close` (in start(), above) writes the 'cancelled' line only once
  // the child fires it itself -- THAT is the proof of a real end, not
  // this function's return value.
  return { id, kind, reallyEnded: dead, how: entry.cancelReason };
}

/**
 * Read one task's state.
 *
 * ```
 * unknown (id never seen)      { state:'unknown', id, reason }               -> 404
 * unknown (server restarted)   { state:'unknown', kind, started,
 *                                 running:'unknown', reason }                -> 200
 * running                      { state:'ok', kind, started, running:true,
 *                                 progress }                                 -> 200
 * finished, nothing to flag    { state:'ok', ..., running:false, result }    -> 200
 * finished, with a finding     { state:'warning', ..., result, reason }      -> 200
 * cancelled                    { state:'ok', ..., cancelled:true, reason }   -> 200
 * unreadable state file        { state:'error', id, reason }                 -> 500
 * ```
 */
export function read(root, id) {
  if (!validId(id)) return { state: 'unknown', id, reason: 'id does not have the expected shape' };
  const file = statePath(root, id);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { state: 'unknown', id, reason: 'no task with this id' };
    return { state: 'error', id, reason: e.message };
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* one broken line must not drag the readable ones down */ }
  }
  const started = events.find((e) => e.event === 'started');
  if (!started) return { state: 'error', id, reason: 'state file has no started line' };
  const terminal = [...events].reverse().find((e) => e.event === 'result' || e.event === 'cancelled');
  const base = { id, kind: started.kind, started: started.ts, command: started.command, params: started.params ?? null };

  if (terminal?.event === 'cancelled') {
    return { ...base, state: 'ok', running: false, cancelled: true, ended: terminal.ts, reason: terminal.reason };
  }
  if (terminal?.event === 'result') {
    return {
      ...base, state: terminal.state, running: false, cancelled: false,
      ended: terminal.ts, result: terminal.result, reason: terminal.reason ?? null,
    };
  }

  // No terminal event yet -- is it really still running, or do we just
  // not know any more (server restart)? Only the SAME server instance
  // that started it may say "running".
  const entry = ACTIVE.get(started.kind);
  const stillTracked = entry && entry.id === id
    && entry.epoch === SERVER_EPOCH && started.serverEpoch === SERVER_EPOCH;
  if (!stillTracked) {
    return {
      ...base, state: 'unknown', running: 'unknown',
      reason: 'server restarted -- this task is no longer tracked',
    };
  }
  const lastProgress = [...events].reverse().find((e) => e.event === 'progress');
  return {
    ...base, state: 'ok', running: true,
    progress: lastProgress?.text ?? 'running (no progress measurable)',
  };
}

/** For an overview without a known id: the running (this server
 * instance's) or most recently started id per kind, where known. Purely
 * a read -- no second source, the same `.jsonl` files `read()` reads. */
export function overview(root) {
  const result = {};
  for (const kind of Object.keys(KINDS)) {
    const running = ACTIVE.get(kind);
    if (running && running.epoch === SERVER_EPOCH && !running.ended) {
      result[kind] = { id: running.id, ...read(root, running.id) };
      continue;
    }
    let latestId = null;
    let latestTs = '';
    try {
      for (const name of fs.readdirSync(tasksDir(root))) {
        if (!name.endsWith('.jsonl')) continue;
        const id = name.slice(0, -'.jsonl'.length);
        if (!validId(id)) continue;
        const b = read(root, id);
        if (b.kind !== kind) continue;
        if (!b.started || b.started <= latestTs) continue;
        latestTs = b.started; latestId = id;
      }
    } catch { /* directory does not exist yet -- nothing ever started */ }
    result[kind] = latestId ? { id: latestId, ...read(root, latestId) } : null;
  }
  return result;
}

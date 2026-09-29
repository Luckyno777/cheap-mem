// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * checkrecord.mjs — the tracked, append-only proof that a full test run
 * was green for a given tree.
 *
 * Ported from the sibling house's `betrieb/geprueft.jsonl` +
 * `betrieb/geprueft-vermerken.mjs` (Bauplan Block I, I2b) — cm-release,
 * Bauplan item P1.
 *
 * **Why one tier here, not two.** lucky-mem carries TWO belief layers:
 * a machine-local stamp (`.pipeline/gruenstempel.jsonl`, gitignored,
 * written right after a suite run on the SAME machine — used by the
 * push guard) and a tracked, committed ledger (`betrieb/geprueft.jsonl`)
 * that stands in for the local stamp on a machine that never runs a
 * suite of its own (their VM, which only ever pulls code, never tests
 * it). cheap-mem has no such machine in this role: it is a single-
 * install product, and the person who cuts a release runs the tests on
 * their own box — the tree they are about to release is the tree they
 * just tested. A local-stamp layer here would only be a second copy of
 * the same fact with nothing new to say, so this house keeps ONE tier:
 * the tracked ledger itself IS the proof, written directly after a
 * green `node --test` run (see `bin/mem-check-record`, the wrapper that
 * runs the suite and calls {@link recordCheck}).
 *
 * **The fields, and why they match the sibling's naming where the
 * concept is the same.** `tree`/`commit`/`tests`/`ts`/`machine`/`house`
 * are the sibling's own field names verbatim — a reader who knows one
 * ledger format reads the other. `passed`/`failed` replace `bestanden`/
 * `rot` in English; `failed` is always `0` here for the same reason
 * `rot` is always `0` there (see {@link recordCheck}: a row is never
 * written for a red or partial run — nothing is better than something
 * wrong).
 *
 * invariant: append-only
 * invariant: drei-zustaende-nie-zwei
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendLine } from './append.mjs';

function git(root, argv) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
}

/** Where the ledger lives — overridable per env (tests, an alternate layout). */
export function recordPath(root, env = process.env) {
  return env.CHEAP_MEM_CHECK_FILE || path.join(root, 'checked.jsonl');
}

/** Is the working tree clean (no staged, unstaged or untracked difference to HEAD)? */
export function isTreeClean(root) {
  try { return git(root, ['status', '--porcelain']) === ''; }
  catch { return false; } // no/broken repo — treat as dirty, same caution as baumHash() below.
}

/**
 * The tree hash of the current state: `HEAD^{tree}` when the tree is
 * clean, `git write-tree` (the index) otherwise. Ported verbatim from
 * `gruenstempel.mjs: baumHash()` — same known limit (write-tree reads
 * the INDEX, not the working directory; a dirty-but-unstaged change is
 * invisible to it), same reason for not closing it: {@link recordCheck}
 * always runs right after a real test run, in the exact tree the suite
 * just saw.
 */
export function treeHash(root) {
  if (isTreeClean(root)) {
    try { return git(root, ['rev-parse', 'HEAD^{tree}']); } catch { /* fall through to write-tree */ }
  }
  return git(root, ['write-tree']);
}

/** Parse ledger text into rows, oldest first. Broken lines are skipped, never thrown. */
export function parseRecords(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && typeof r.tree === 'string') rows.push(r);
    } catch { /* broken line — next */ }
  }
  return rows;
}

/** Every row at `target`, oldest first. Missing file reads as no rows, never a throw. */
export function readRecords(target) {
  let text;
  try { text = fs.readFileSync(target, 'utf8'); } catch { return []; }
  return parseRecords(text);
}

/** `"cloud"` / a short, secret-free hostname. `CHEAP_MEM_CHECK_MACHINE` overrides, for tests. */
export function machineName(env = process.env) {
  if (env.CHEAP_MEM_CHECK_MACHINE) return env.CHEAP_MEM_CHECK_MACHINE;
  if (env.CLAUDE_CODE_REMOTE) return 'cloud';
  let h = '';
  try { h = os.hostname(); } catch { h = ''; }
  h = String(h).split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
  return h || 'unknown';
}

/** `package.json`'s `name`, else the directory name. `CHEAP_MEM_CHECK_HOUSE` overrides. */
export function houseName(root, env = process.env) {
  if (env.CHEAP_MEM_CHECK_HOUSE) return env.CHEAP_MEM_CHECK_HOUSE;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg && typeof pkg.name === 'string' && pkg.name) return pkg.name;
  } catch { /* fall through to directory name */ }
  return path.basename(path.resolve(root));
}

/**
 * Append ONE row for the current `HEAD` tree — but ONLY when `failed`
 * is exactly `0` and a full run is confirmed by the caller (`full`):
 * both conditions live HERE, at one place, not scattered over callers
 * (parity with `gruenstempel.mjs: schreibeStempel()`'s own reasoning).
 *
 * Idempotent: a tree already on the ledger is not appended twice
 * (`{ written: false, reason: 'already-recorded' }`) — harmless if it
 * ever raced, never wrong.
 */
export function recordCheck(root, {
  passed = 0, failed = 0, full = true, env = process.env, now = new Date(),
} = {}) {
  if (!Number.isFinite(passed) || !Number.isFinite(failed)) return { written: false, reason: 'no-summary' };
  if (failed !== 0) return { written: false, reason: 'red' };
  if (!full) return { written: false, reason: 'partial' };

  let commit;
  let tree;
  try {
    commit = git(root, ['rev-parse', 'HEAD']);
    tree = treeHash(root);
  } catch (e) {
    return { written: false, reason: 'no-head', error: String(e?.message ?? e) };
  }

  const target = recordPath(root, env);
  const already = readRecords(target).find((r) => r.tree === tree);
  if (already) return { written: false, reason: 'already-recorded', row: already };

  const row = {
    tree,
    commit,
    tests: passed + failed,
    passed,
    failed: 0,
    ts: now.toISOString(),
    machine: machineName(env),
    house: houseName(root, env),
  };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    appendLine(target, `${JSON.stringify(row)}\n`);
  } catch (e) {
    return { written: false, reason: 'write-failed', error: String(e?.message ?? e) };
  }
  return { written: true, row };
}

/**
 * The same "# pass N" / "# fail N" TAP-summary regex the sibling's
 * `stempel-nach-suite.mjs: ausTapAusgabe()` uses — not reinvented, so a
 * reader of one recognises the other. `node --test` prints this
 * trailer regardless of reporter.
 */
export function fromTapOutput(text) {
  const pass = /^# pass (\d+)/m.exec(String(text ?? ''));
  const fail = /^# fail (\d+)/m.exec(String(text ?? ''));
  return {
    passed: pass ? Number(pass[1]) : null,
    failed: fail ? Number(fail[1]) : null,
  };
}

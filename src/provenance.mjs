// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Borrowed memory — which clone answered, and how old is it?
 *
 * This memory exists more than once: a clone on the server, one in
 * each container, one in every cloud session. They all look alike,
 * they are all called the same, and they all answer willingly. What
 * none of them says is whether it is the one that was meant — and
 * whether its state is still worth anything.
 *
 * That is not an invented danger. The retrieval hook refreshes at most
 * every ten minutes, detached: a session whose pull fails (dirty tree,
 * no network, someone else's lock) works for hours against a frozen
 * state and gets the same confident answers as one with a fresh clone.
 *
 * So provenance becomes a finding with FOUR states, not a reassurance
 * with two:
 *
 *   fresh     the state is younger than the limit, OR it is older but
 *             the clone is level with what it last saw of its origin
 *             (behind = 0): a quiet stretch with nothing new to pull is
 *             not a defect, and a barrier that reports the innocent
 *             gets switched off
 *   stale     older than the limit AND (behind > 0 OR behind unknown) —
 *             with how much. Unknown lag counts against it: "old and
 *             cannot tell whether anything newer exists" is not fine
 *   no_git    a memory directory without provenance
 *   unknown   git does not answer (and that does not mean "fine")
 *
 * `unknown` is expressly not `fresh`. A checker that reports the
 * unchecked as healthy is worse than none.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** States. Closed list. */
export const STATE = Object.freeze({
  FRESH: 'fresh',
  STALE: 'stale',
  NO_GIT: 'no-git',
  UNKNOWN: 'unknown',
});

/** When a state counts as stale. The hook pulls every 10 minutes. */
export const LIMIT_MINUTES = 90;

function git(root, ...a) {
  const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 4000 });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/**
 * How many commits is the clone behind what it last saw of its origin?
 *
 * The ONE implementation of `HEAD..origin/<branch>`: `mem doctor`'s
 * `behind` finding and the provenance gate both use it, so there is no
 * second truth about "behind". No network — only the already-fetched
 * ref. Returns `{ branch, behind, why }`; `behind` is `null` (never 0)
 * whenever it cannot be told, and `why` says which step failed:
 * 'git-not-runnable' | 'no-origin-ref' | 'count-unreadable'.
 */
export function behindOrigin(root) {
  const branch = git(root, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (branch === null) return { branch: null, behind: null, why: 'git-not-runnable' };
  const count = git(root, 'rev-list', '--count', `HEAD..origin/${branch}`);
  if (count === null) return { branch, behind: null, why: 'no-origin-ref' };
  if (!/^\d+$/.test(count)) return { branch, behind: null, why: 'count-unreadable' };
  return { branch, behind: Number(count), why: null };
}

/**
 * The provenance of a memory directory.
 *
 * It does NOT go to the network. The comparison is against what the
 * clone last saw of its own branch on origin — without a call it knows no more,
 * and claiming more would be guessing. If origin is ahead of
 * `HEAD`, that is already a finding without a call.
 */
export function provenance(root, { now = Date.now(), limit = LIMIT_MINUTES } = {}) {
  const base = { root: root ? path.resolve(root) : null };
  if (!root || !fs.existsSync(root)) return { ...base, state: STATE.UNKNOWN, why: 'no-directory' };
  if (!fs.existsSync(path.join(root, '.git'))) return { ...base, state: STATE.NO_GIT, why: 'no-provenance' };

  const head = git(root, 'rev-parse', '--short', 'HEAD');
  const when = git(root, 'log', '-1', '--format=%cI');
  if (!head || !when) return { ...base, state: STATE.UNKNOWN, why: 'git-silent' };

  const ageMin = Math.round((now - Date.parse(when)) / 60000);

  // `null` means the lag cannot be told (no remote tracking, ...).
  const { behind } = behindOrigin(root);

  const dirty = (git(root, 'status', '--porcelain') ?? '') !== '';

  return {
    ...base,
    // The gate: age alone never makes a clone stale. Old AND level with
    // origin is a quiet stretch; old AND behind (or unable to tell) is not.
    state: ageMin > limit && (behind === null || behind > 0) ? STATE.STALE : STATE.FRESH,
    head,
    when,
    age_minutes: ageMin,
    behind,
    dirty,
    limit_minutes: limit,
  };
}

/**
 * One line for a person. It ALWAYS says which directory answered, even
 * when everything is fine. That is exactly when it is worth something:
 * whoever first learns which clone answers when something breaks has
 * already made the mistake.
 */
export function asLine(p) {
  const where = p.root ?? '(no directory)';
  if (p.state === STATE.NO_GIT) return `Memory: ${where} — no provenance (not a git tree)`;
  if (p.state === STATE.UNKNOWN) return `Memory: ${where} — provenance UNKNOWN (${p.why})`;
  const parts = [`Memory: ${where}`, `${p.head}`, `${p.age_minutes} min old`];
  if (p.behind) parts.push(`${p.behind} commits behind origin`);
  if (p.dirty) parts.push('tree dirty — the hook does NOT pull then');
  if (p.state === STATE.FRESH && p.age_minutes > p.limit_minutes) parts.push('old but level with origin');
  if (p.state === STATE.STALE && p.behind === null) parts.push('lag unknown');
  if (p.state === STATE.STALE) parts.push(`STALE (limit ${p.limit_minutes} min)`);
  return parts.join(' \u00b7 ');
}

/**
 * Is the line worth printing at all? Yes, when something stands out —
 * and always at session start, because that is where the question
 * "which clone" gets answered before anyone asks it.
 */
export function notable(p) {
  return p.state !== STATE.FRESH || p.dirty === true || (p.behind ?? 0) > 0;
}

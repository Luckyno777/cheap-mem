// src/environment.mjs — the guarantees cheap-mem does NOT provide itself.
//
// Round two of the 2026-09-05 audit found the failure class behind all the
// others: correctness here rests on properties that live outside the
// codebase, are stated nowhere, and are verified by nothing.
//
//   O_APPEND write atomicity   concurrent writers do not corrupt.
//                              A kernel + filesystem property. POSIX
//                              guarantees it only to PIPE_BUF (4096);
//                              Linux on ext4 holds the inode lock for the
//                              whole write, which is why 60 kB lines from
//                              four processes came through intact. On NFS
//                              they would not.
//
//   *.jsonl merge=union        distributed appends merge without loss.
//                              One line in .gitattributes. Without it a
//                              merge turns three of six valid lines into
//                              conflict markers — and invalid lines are
//                              skipped, so the loss is silent. Measured.
//
//   core.hooksPath             secrets do not reach git. A LOCAL git
//                              config that a fresh clone does not carry.
//
// Each is invisible when present and silent when absent. That is the whole
// problem: nothing ever says the property is gone. This module says it.
//
// The checks are cheap and read-only. They report a LAYER as well as a
// verdict, because "who is responsible" is the useful half — cheap-mem
// cannot fix a filesystem, only refuse to pretend it checked one.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const LAYER = Object.freeze({
  APP: 'application',      // cheap-mem's own code
  GIT: 'git',              // repository configuration
  OS: 'os/filesystem',     // kernel and mount
  OPS: 'operational',      // deployment, backups, humans
});

const git = (root, ...args) => {
  try {
    return execFileSync('git', ['-C', root, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
};

const check = (name, layer, ok, detail, fix = null) => ({ name, layer, ok, detail, fix });

// Is this root a git working tree at all? Both git-layer checks below are
// about repository CONFIGURATION, and a memory that is not a repository
// has no configuration to be wrong. Reporting a FAILURE there says the
// environment is broken when nothing is: a freshly initialised memory with
// no git in sight is a correct state, and `mem doctor` calling it an error
// is how CI stayed red on three platforms without anyone reading it.
const isRepo = (root) => git(root, 'rev-parse', '--git-dir') !== null;

/**
 * The merge driver. Without it, a git merge of two independently appended
 * logs produces conflict markers, and the parser then drops those lines
 * without a word.
 */
export function checkMergeDriver(root) {
  if (!isRepo(root)) {
    return check('merge-driver', LAYER.GIT, null, 'not a git repository — nothing to configure',
      'Only relevant once the memory is versioned. `git init` here, then re-check.');
  }
  const p = path.join(root, '.gitattributes');
  if (!fs.existsSync(p)) {
    return check('merge-driver', LAYER.GIT, false, '.gitattributes is missing',
      'Add `*.jsonl merge=union`. Without it a merge silently destroys entries.');
  }
  const text = fs.readFileSync(p, 'utf8');
  const ok = /^\s*\*\.jsonl\s+merge=union\s*$/m.test(text);
  return check('merge-driver', LAYER.GIT, ok,
    ok ? '*.jsonl merge=union declared' : '.gitattributes exists but does not declare the driver',
    ok ? null : 'Add the line `*.jsonl merge=union`.');
}

/**
 * The pre-commit hook. `core.hooksPath` is local configuration: cloning
 * the repository does NOT bring it, so a fresh clone commits secrets that
 * the original refused.
 */
export function checkPreCommitHook(root) {
  if (!isRepo(root)) {
    return check('pre-commit', LAYER.GIT, null, 'not a git repository — no commits to guard',
      'Only relevant once the memory is versioned. `git init` here, then run the hook installer.');
  }
  const configured = git(root, 'config', '--get', 'core.hooksPath');
  if (!configured) {
    return check('pre-commit', LAYER.GIT, false, 'core.hooksPath is not set',
      'Run the hook installer. A clone does not inherit this setting.');
  }
  const hook = path.isAbsolute(configured)
    ? path.join(configured, 'pre-commit')
    : path.join(root, configured, 'pre-commit');
  if (!fs.existsSync(hook)) {
    return check('pre-commit', LAYER.GIT, false, `core.hooksPath=${configured} but no pre-commit in it`,
      'Point core.hooksPath at the directory that holds the hook.');
  }
  // Executable is not required — a hook invoked as `bash <path>` works
  // without the bit, and losing that bit is a documented failure mode.
  return check('pre-commit', LAYER.GIT, true, `pre-commit present (${configured})`);
}

/**
 * Append atomicity. Not probed with real concurrency — that costs
 * hundreds of milliseconds at every startup, and a probe that passes once
 * proves nothing about the next write anyway. What is checked is the
 * thing that actually predicts it: the filesystem under the repository.
 *
 * Reported as UNKNOWN rather than OK where it cannot be determined. An
 * environment check that guesses is worse than none, because it converts
 * an unknown into a false assurance.
 */
export function checkAppendAtomicity(root) {
  let fsType = null;
  try {
    const out = execFileSync('stat', ['-f', '-c', '%T', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    fsType = out || null;
  } catch { /* stat -f is not portable; absence is not a failure */ }

  if (!fsType) {
    return check('append-atomicity', LAYER.OS, null,
      'filesystem type could not be determined — atomicity unverified',
      'On Linux, `stat -f -c %T .` names it. Avoid NFS for the memory root.');
  }
  const unsafe = /^(nfs|smb|cifs|fuseblk|9p|virtiofs)/i.test(fsType);
  if (unsafe) {
    return check('append-atomicity', LAYER.OS, false,
      `filesystem is ${fsType} — concurrent appends may interleave`,
      'Move the memory root onto a local filesystem, or serialise writers.');
  }
  return check('append-atomicity', LAYER.OS, true,
    `filesystem is ${fsType} — O_APPEND writes are atomic here`);
}

/**
 * Clock sanity. Ordering across machines rests on `ts`, which comes from
 * whichever machine wrote the line. A wrong clock does not corrupt
 * anything, but it does make "newest" wrong, so it is worth saying.
 */
export function checkClock(root, { newestTs = null } = {}) {
  if (!newestTs) {
    return check('clock', LAYER.OPS, null, 'no timestamped entry to compare against');
  }
  const t = Date.parse(newestTs);
  if (!Number.isFinite(t)) {
    return check('clock', LAYER.OPS, false, 'the newest entry has an unparseable timestamp',
      'Find it with `mem doctor` and correct it with a new entry.');
  }
  const aheadMin = (t - Date.now()) / 60000;
  if (aheadMin > 5) {
    return check('clock', LAYER.OPS, false,
      `the newest entry is ${Math.round(aheadMin)} min in the future`,
      'Either this clock is behind or an entry was written with a wrong one.');
  }
  return check('clock', LAYER.OPS, true, 'system clock is consistent with the newest entry');
}

/** Every environment check, in one call. */
export function checkEnvironment(root, opts = {}) {
  return [
    checkMergeDriver(root),
    checkPreCommitHook(root),
    checkAppendAtomicity(root),
    checkClock(root, opts),
  ];
}

/**
 * Strict means: an unverifiable guarantee is a failure.
 *
 * Deliberately separate from `ok === false`. In normal use an unknown is
 * an unknown; in CI, where the environment is supposed to be fixed and
 * known, refusing to determine it IS the defect.
 */
export function environmentOk(checks, { strict = false } = {}) {
  return checks.every((c) => (strict ? c.ok === true : c.ok !== false));
}

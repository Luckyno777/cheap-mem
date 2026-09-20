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
 *
 * ## Allow-list, not a deny-list (fixed 2026-09-19)
 *
 * The previous version matched a short deny-list of unsafe names and
 * called *everything else* atomic — including a filesystem type it had
 * never seen. That inverts the doc comment above it: "reported as
 * UNKNOWN where it cannot be determined" only holds if the unknown case
 * actually reaches UNKNOWN. Measured against `overlay`, `overlayfs`,
 * `sshfs`, `vfat` and a made-up `unknown-0x1234`: all five came back
 * "OK, O_APPEND writes are atomic here". `overlay`/`overlayfs` is the
 * filesystem of every Docker container — including the one cheap-mem
 * itself typically runs in — so this was not a corner case, it was the
 * common case reporting a guarantee nobody had checked.
 *
 * So: three lists. GOOD only for names this comment can back with a
 * reason; BAD only for names with a documented failure mode; UNKNOWN —
 * the safe default — for everything else, the type string named
 * verbatim so a human can look it up.
 *
 * `stat -f -c %T` on Linux reports the *statfs magic number's* name, not
 * the driver: ext2, ext3 and ext4 all carry magic `0xEF53` and are all
 * printed as `ext2/ext3` (confirmed on this machine: `/` is mounted
 * `ext4` per `mount`, `stat -f -c %T /` prints `ext2/ext3`). The GOOD
 * list accounts for that; it is not a gap in coverage.
 */

/**
 * Local filesystems whose regular (buffered, non-`O_DIRECT`) write path
 * is documented to hold the inode exclusive-lock (`i_rwsem`) for the
 * whole `write()` call when `O_APPEND` is set — the mechanism the
 * `open(2)` man page's atomicity guarantee rests on for "local
 * filesystems". `fs.appendFileSync` uses exactly that path (buffered,
 * not `O_DIRECT`), which is what cheap-mem does everywhere.
 *
 *   ext2/ext3   `stat -f -c %T` name for magic 0xEF53 — covers ext2,
 *               ext3 AND ext4 (they share the magic; ext4 never prints
 *               as "ext4"). ext4_file_write_iter -> inode_lock().
 *   ext4        kept as a second key in case some other tool ever
 *               surfaces the driver name rather than the magic name —
 *               same code path, same guarantee.
 *   xfs         xfs_file_write_iter takes XFS_IOLOCK_EXCL for buffered
 *               writes for the duration of the call.
 *   btrfs       btrfs_file_write_iter takes inode_lock() for buffered
 *               writes (COW affects block layout, not this lock).
 *   f2fs        f2fs_file_write_iter takes inode_lock() the same way.
 *   tmpfs       shmem_file_write_iter takes inode_lock() the same way;
 *               it is memory-backed (a reboot loses it), but that is a
 *               PERSISTENCE property, a different guarantee from
 *               atomicity, which is all this check reports on.
 *
 * Deliberately NOT here without a specific reason found for it: jfs,
 * reiserfs, zfs, ufs and any other local filesystem. They may well be
 * fine — but "may well be" is a guess, and a guess reported as OK is
 * the exact defect this list replaces. They fall through to UNKNOWN.
 */
const ATOMIC_APPEND_OK = new Set(['ext2/ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'tmpfs']);

/**
 * Filesystems with a DOCUMENTED failure mode for concurrent O_APPEND,
 * not merely "not on the good list".
 *
 *   nfs, nfs4    the `open(2)` man page names this exact case: NFS does
 *                not support appending server-side, so the client
 *                kernel simulates it, and two clients doing that race.
 *   smb, smb2,
 *   smb3, cifs   same architecture as NFS — the client simulates append
 *                against a network protocol with no atomic append
 *                primitive — so the same failure mode applies.
 *   sshfs        FUSE over SFTP: measured directly (see module doc
 *                block above `checkAppendAtomicity`'s test fixtures) —
 *                `FEHLER … concurrent appends may interleave` is the
 *                correct call, not a guess.
 *
 * `fuseblk`, `fuse`, `9p` and `virtiofs` used to be on this list too.
 * They are pulled off it here: each CAN be backed by something that
 * forwards straight through to a locking filesystem, and each can also
 * be backed by something that does not, and `stat -f -c %T` cannot
 * tell the two apart. Calling them unsafe was as much a guess as
 * calling them safe — they belong in UNKNOWN, named, not in either
 * list.
 */
const ATOMIC_APPEND_BAD = new Set(['nfs', 'nfs4', 'smb', 'smb2', 'smb3', 'cifs', 'sshfs']);

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
  const key = fsType.toLowerCase();
  if (ATOMIC_APPEND_BAD.has(key)) {
    return check('append-atomicity', LAYER.OS, false,
      `filesystem is ${fsType} — concurrent appends may interleave`,
      'Move the memory root onto a local filesystem, or serialise writers.');
  }
  if (ATOMIC_APPEND_OK.has(key)) {
    return check('append-atomicity', LAYER.OS, true,
      `filesystem is ${fsType} — O_APPEND writes are atomic here`);
  }
  // Includes `overlay`/`overlayfs` (the type this check itself most
  // often meets — see the module doc block above): whether it forwards
  // to a filesystem in ATOMIC_APPEND_OK depends on the storage driver
  // (overlay2 vs. fuse-overlayfs vs. a sandbox's own overlay), which
  // `stat -f -c %T` does not reveal. Not measurable here is not zero.
  return check('append-atomicity', LAYER.OS, null,
    `filesystem is ${fsType} — atomicity neither verified safe nor documented unsafe`,
    'On Linux, only ext2/ext3/ext4, xfs, btrfs, f2fs and tmpfs are treated '
    + 'as verified here. Confirm this one directly or move the memory root '
    + 'onto one of those.');
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

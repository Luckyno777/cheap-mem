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
import { Worker } from 'node:worker_threads';

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
 * Append atomicity. MEASURED, not guessed from a name (rewritten
 * 2026-09-20).
 *
 * ## The incident this replaces
 *
 * The benchmark record `robust.concurrency.filesystem` sits at
 * not-measured because three tools disagree about the SAME filesystem,
 * on the SAME machine, at the SAME moment:
 *
 *     doctor (this check, old version):  ext2/ext3
 *     df -T:                             ext4
 *     stat -f -c %T:                     ext2/ext3
 *
 * `doctor` and `stat -f -c %T` "agree" only because the old version of
 * this check was itself just `stat -f -c %T` fed through an allow-list
 * — it is one source wearing two names, not two sources agreeing. `df`
 * names the actual driver; `stat -f` names the statfs *magic number*,
 * and ext2/ext3/ext4 share magic `0xEF53`, so `stat -f` can never spell
 * "ext4" no matter which of the three is actually mounted. Three
 * strings, one measurement, and the old check turned that single
 * measurement into a guarantee — "ext2/ext3 -> O_APPEND is atomic here"
 * — without ever performing the write it was making a claim about.
 * That is `Behauptet statt gemessen`: a guarantee derived from a label
 * instead of from an observation, and the label was disputed by the
 * system's own other tools.
 *
 * ## What changed
 *
 * This check now does what `test/concurrent-append.test.mjs` and
 * `bench/atlas/phase-robust.mjs`'s `partConcurrency` already do to
 * establish the same property: spawn several writers, have them append
 * to the same file at once, then read the file back and look for torn
 * (unparseable), missing and duplicated lines. Reusing that shape
 * rather than inventing a second one — `Zwei Implementierungen einer
 * Wahrheit` is its own named failure here. The difference from those
 * two is budget: they can afford full OS processes and ten-plus rounds
 * because they run in CI or a benchmark, not on every `mem doctor`.
 * This one runs on every `mem doctor`, so it uses `node:worker_threads`
 * (threads inside THIS process, no second Node startup) and a single
 * round, with a hard time budget — see `runAppendAtomicityProbe` below.
 * `fs.appendFileSync` inside a worker thread still opens its own fd
 * with `O_APPEND` and takes the OS-level path being tested; the kernel
 * lock this rests on (`inode_lock()` / `XFS_IOLOCK_EXCL`, whichever the
 * filesystem uses) is a property of the file and the syscall, not of
 * whether the caller happens to share a process with other callers.
 *
 * ## The verdict boundary — the name explains, it never decides
 *
 * `stat -f -c %T` is still read, but ONLY for two things now: (1)
 * deciding whether to measure at all, and (2) being printed alongside
 * the verdict as context. It is never again the thing that PRODUCES
 * `ok`. Search for "context only" below — everything past that comment
 * is measurement, nothing past it is a name lookup.
 *
 * A small set of mount types skip the measurement and return UNKNOWN:
 * NFS/SMB/CIFS (the `open(2)` man page names these explicitly — the
 * client kernel simulates append against a protocol with no atomic
 * append primitive) and FUSE/9p/virtiofs mounts (a passthrough layer
 * whose backing store this process cannot see, and whose latency can
 * make a quick local round-trip pass for reasons that will not hold up
 * under real concurrent load). These are reported as UNKNOWN, not as a
 * failure: this check does not run the probe there, so it has not
 * measured anything, and a claim of "fails" without a measurement would
 * be the same `Behauptet statt gemessen` mistake pointed the other way.
 * The advice text says the guarantee "cannot be established", not that
 * it "fails".
 *
 * Everything else — ext4, xfs, btrfs, overlay, an fs type this file has
 * never seen, a `stat -f -c %T` that returns nothing at all — is
 * measured. There is no more allow-list to keep in sync with reality:
 * the measurement IS the reality.
 *
 * ## What this still cannot see
 *
 * One round, small volume, one moment in time. It cannot see a defect
 * that only shows up under sustained load, on a cold page cache, or
 * under memory pressure, and a PASS here is a statement about the
 * moment `mem doctor` ran, not a lifetime guarantee — the same
 * limitation `bench/atlas/phase-robust.mjs` names for its own (larger,
 * repeated) version of this probe. It also cannot see failures that a
 * network mount could exhibit while behaving perfectly on a fast, empty
 * local link during the probe.
 */

/**
 * Mounts where measuring would be misleading rather than merely slow:
 * a network protocol with no atomic-append primitive of its own (NFS,
 * SMB/CIFS — `open(2)` names this failure mode directly), or a
 * passthrough layer this process cannot see through to the real backing
 * store (FUSE, 9p, virtiofs). A clean local round-trip against one of
 * these proves nothing about the real link under real concurrency, so
 * the probe is skipped rather than run and trusted.
 *
 * This is the ONLY place a filesystem name is allowed to decide
 * anything in this file. It decides "skip, report unknown" — never
 * "ok".
 */
/**
 * Filesystems where O_APPEND atomicity is DOCUMENTED not to hold.
 *
 * `open(2)`: "O_APPEND may lead to corrupted files on NFS filesystems if
 * more than one process appends data to a file at once." That is a
 * published property of the protocol, not a guess from a name — so the
 * verdict here is `false`, not `unknown`. "Nicht messbar ist nicht null"
 * governs what we could not determine; this we can determine, from the
 * documentation, without measuring.
 *
 * And it is deliberately NOT measured: the race is rare, not impossible,
 * so a clean run of a few dozen lines would be evidence of nothing while
 * looking like evidence of something. A green probe here would be worse
 * than no probe.
 */
const DOCUMENTED_UNSAFE_FS = new Set([
  'nfs', 'nfs4', 'smb', 'smb2', 'smb3', 'cifs', 'sshfs',
]);

/**
 * Filesystems that forward to another one, so nothing about them
 * decides the question either way.
 *
 * FUSE, 9p and virtiofs may sit on top of a perfectly safe local disk or
 * on top of something arbitrary. Unknown is the honest answer, and it
 * stays unknown even when the probe finds nothing — see `AFFIRMS_APPEND`.
 */
const PASSTHROUGH_FS = new Set(['fuse', 'fuseblk', '9p', 'virtiofs']);

/**
 * Filesystems whose own documentation affirms atomic O_APPEND.
 *
 * **Why a passing probe is not enough on its own.** Six writers and
 * forty-eight lines that come back whole prove that no tearing HAPPENED,
 * not that none CAN happen. A measurement of this shape can only ever
 * falsify the guarantee; it cannot establish it. So `ok` needs two
 * independent sources that agree — the documented property of the
 * filesystem, and a run that did not contradict it. One source alone
 * leaves the third state.
 *
 * `stat -f -c %T` reports the statfs MAGIC name, not the mount driver:
 * ext2, ext3 and ext4 all share magic 0xEF53, so this can only ever
 * print `ext2/ext3` for any of them. That is why the entry below covers
 * the family rather than naming ext4 (verified 2026-09-20: `mount` says
 * ext4 on this machine, `stat -f` says ext2/ext3 — one filesystem, two
 * labels, not two sources disagreeing).
 */
const AFFIRMS_APPEND = new Set([
  'ext2/ext3', 'ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'f2fs', 'tmpfs', 'zfs', 'jfs', 'reiserfs',
]);

const APPEND_PROBE_DEFAULTS = Object.freeze({
  workers: 6, perWorker: 8, padBytes: 6000, timeoutMs: 400,
});

// Runs inside a worker thread, evaluated as CommonJS (the `eval: true`
// Worker default) so it needs no build step and no module resolution.
// Deliberately padded past PIPE_BUF (4096 B) — below that, an atomic
// append is the easy case every filesystem gets right (see the same
// comment in `test/concurrent-append.test.mjs`).
const APPEND_PROBE_WORKER_SRC = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const { file, id, lines, pad, sab } = workerData;
const doneFlag = new Int32Array(sab);
const filler = pad > 0 ? 'x'.repeat(pad) : '';
for (let i = 0; i < lines; i += 1) {
  const line = JSON.stringify({ w: id, i, marker: 'w' + id + 'e' + i, filler });
  fs.appendFileSync(file, line + '\\n');
}
Atomics.add(doneFlag, 0, 1);
Atomics.notify(doneFlag, 0);
`;

/**
 * The verdict logic on its own, fed a file path and the count of
 * markers that should be in it. Deliberately separate from the
 * orchestration below: a sabotage counter-probe must be able to break
 * the VERDICT without needing to win an actual race, by handing this
 * function a file it wrote itself. Mirrors `inspectLog` in
 * `bench/atlas/phase-robust.mjs` — torn (unparseable) lines, missing
 * markers, duplicated markers.
 */
export function analyzeAppendProbe(filePath, expectedCount) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = text.split('\n').filter((l) => l.trim().length > 0);
  let torn = 0;
  const seen = new Map();
  for (const row of rows) {
    let entry;
    try { entry = JSON.parse(row); } catch { torn += 1; continue; }
    const marker = entry && typeof entry === 'object' ? entry.marker : null;
    if (!marker) { torn += 1; continue; }
    seen.set(marker, (seen.get(marker) ?? 0) + 1);
  }
  const duplicates = [...seen.values()].filter((n) => n > 1).length;
  const missing = Math.max(expectedCount - seen.size, 0);
  return {
    ok: torn === 0 && duplicates === 0 && missing === 0,
    torn, missing, duplicates, found: seen.size, expected: expectedCount, rows: rows.length,
  };
}

/**
 * The orchestration: spawn `workers` threads, each appending
 * `perWorker` lines to one shared file, wait for all of them (bounded
 * by `timeoutMs`), then hand the file to `analyzeAppendProbe`.
 *
 * Runs the probe file INSIDE `root`, not in a shared temp directory —
 * the property under test belongs to the filesystem the memory root
 * lives on, and `os.tmpdir()` is frequently a different mount (tmpfs on
 * many Linux setups) that would silently answer a different question.
 *
 * Synchronisation uses `Atomics.wait`/`Atomics.notify` on a
 * `SharedArrayBuffer`, not `worker.on('message', …)`: a worker's
 * `postMessage` is delivered through the event loop, and the caller
 * here is a synchronous function with no `await` — it cannot let the
 * event loop turn to receive it. Direct atomics on shared memory are
 * visible to `Atomics.wait` immediately, independent of the event loop,
 * which is what makes a synchronous wait with a real timeout possible
 * at all. (Confirmed the hard way: an earlier version of this used
 * `postMessage` and hung to its timeout on every run, despite the
 * writes themselves completing in milliseconds — the file was already
 * correct while the caller still had no way to know it.)
 *
 * Never throws. Every failure path — cannot write into `root`, worker
 * threads unavailable, timeout — comes back as `{ measured: false,
 * reason }`, which `checkAppendAtomicity` turns into UNKNOWN, never OK.
 */
export function runAppendAtomicityProbe(root, opts = {}) {
  const { workers, perWorker, padBytes, timeoutMs } = { ...APPEND_PROBE_DEFAULTS, ...opts };

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(root, '.append-atomicity-'));
  } catch (err) {
    return { measured: false, reason: `could not create a probe file under ${root}: ${err.message}` };
  }

  try {
    const file = path.join(dir, 'probe.jsonl');
    fs.writeFileSync(file, '');
    const sab = new SharedArrayBuffer(4);
    const doneFlag = new Int32Array(sab);

    const handles = [];
    try {
      for (let w = 0; w < workers; w += 1) {
        handles.push(new Worker(APPEND_PROBE_WORKER_SRC, {
          eval: true,
          workerData: { file, id: w, lines: perWorker, pad: padBytes, sab },
        }));
      }
    } catch (err) {
      for (const h of handles) h.terminate().catch(() => {});
      return { measured: false, reason: `could not start writer threads: ${err.message}` };
    }

    const deadline = Date.now() + timeoutMs;
    while (Atomics.load(doneFlag, 0) < workers && Date.now() < deadline) {
      const remaining = Math.max(deadline - Date.now(), 1);
      Atomics.wait(doneFlag, 0, Atomics.load(doneFlag, 0), Math.min(20, remaining));
    }
    const finishedCount = Atomics.load(doneFlag, 0);
    for (const h of handles) h.terminate().catch(() => {});

    if (finishedCount < workers) {
      return {
        measured: false,
        reason: `${finishedCount}/${workers} writer threads finished within ${timeoutMs}ms`,
      };
    }

    const result = analyzeAppendProbe(file, workers * perWorker);
    return { measured: true, workers, perWorker, ...result };
  } catch (err) {
    return { measured: false, reason: err.message };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Is a concurrent append safe on the mount this memory sits on?
 *
 * `opts.probe` replaces the measurement itself. It is there so the
 * VERDICT can be tested apart from the run — "a torn line outranks a
 * reassuring filesystem name" is a rule about judgement, and forcing a
 * real filesystem to tear a line on demand is not something a test can
 * arrange. It is a collaborator, not a switch: the default is the real
 * probe, nothing in the product passes it, and passing a made-up result
 * does not make the verdict any less strict.
 */
export function checkAppendAtomicity(root, opts = {}) {
  const { probe: probeFn = runAppendAtomicityProbe, ...probeOpts } = opts;
  let fsType = null;
  try {
    const out = execFileSync('stat', ['-f', '-c', '%T', root],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    fsType = out || null;
  } catch { /* stat -f is not portable; absence is not a failure to measure */ }
  const key = fsType ? fsType.toLowerCase() : null;

  // Documented unsafe: answered from the documentation, not measured.
  if (key && DOCUMENTED_UNSAFE_FS.has(key)) {
    return check('append-atomicity', LAYER.OS, false,
      `filesystem is ${fsType} — O_APPEND is documented NOT to be atomic here `
      + '(open(2)). Not measured: the race is rare rather than impossible, so a '
      + 'clean short run would look like evidence and be none.',
      'Move the memory root onto a local filesystem (ext4, xfs, btrfs, f2fs, '
      + 'tmpfs, …), or serialise writers if it must stay on this mount.');
  }

  const probe = probeFn(root, probeOpts);
  const fsNote = fsType ? ` [filesystem: ${fsType}]` : ' [filesystem name unavailable]';

  if (!probe.measured) {
    return check('append-atomicity', LAYER.OS, null,
      `could not measure concurrent O_APPEND writes — ${probe.reason}${fsNote}`,
      'Re-run `mem doctor`. If this persists, the memory root may not allow '
      + 'spawning worker threads or writing temporary files.');
  }

  const found = `${probe.workers} concurrent writers x ${probe.perWorker} lines `
    + `(${probe.expected} total)`;

  // **Tearing found: the name does not get a vote.** A measurement of
  // this shape can only falsify, and here it did. Whatever the
  // filesystem calls itself, concurrent appends are not safe on this
  // mount.
  if (!probe.ok) {
    return check('append-atomicity', LAYER.OS, false,
      `measured: ${found} — ${probe.torn} torn, ${probe.missing} missing, `
      + `${probe.duplicates} duplicated${fsNote}`,
      'Concurrent O_APPEND writes are not safe on this filesystem or mount as '
      + 'measured. Move the memory root, or serialise writers.');
  }

  // Nothing torn. That is only half an answer: it says no tearing
  // HAPPENED, not that none CAN happen. The guarantee is affirmed only
  // where the filesystem's own documentation affirms it too.
  if (key && AFFIRMS_APPEND.has(key)) {
    return check('append-atomicity', LAYER.OS, true,
      `measured: ${found} — none torn, none missing, none duplicated${fsNote}, `
      + 'and this filesystem documents atomic O_APPEND. Two sources agree.');
  }

  const warum = key && PASSTHROUGH_FS.has(key)
    ? `${fsType} forwards to another filesystem, so its name says nothing either way`
    : `${fsType ?? 'this filesystem'} is not one whose documentation affirms atomic O_APPEND`;
  return check('append-atomicity', LAYER.OS, null,
    `measured: ${found} — none torn, none missing, none duplicated, but ${warum}. `
    + 'A short clean run shows that no tearing happened, not that none can: this '
    + 'measurement can falsify the guarantee, never establish it.',
    'If this mount must carry the memory, serialise writers — or run the '
    + 'measurement under real load for long enough that a passing result means '
    + 'something.');
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

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * release.mjs — the release rail: a frozen, verified copy of the code
 * that a long-running service (`bin/mem-watch`, wired up by
 * `install/linux.sh` and kin) starts from, instead of the live git
 * checkout a person keeps pulling into while the service keeps running
 * out of it.
 *
 * Ported from the sibling house's `betrieb/release.sh` (Bauplan Block
 * I, I2/I2b) — cm-release, Bauplan item P1. See `src/checkrecord.mjs`
 * for why this house's proof ledger has one tier where the sibling has
 * two; everything below builds on that single tier.
 *
 * **`git archive`, not a worktree or a plain copy.** Same reasoning as
 * the sibling: a release is a pure READ snapshot that a service only
 * ever opens as files — nothing here needs `git` inside the frozen
 * copy, so `git archive <commit> | tar -x` gives ordinary files with no
 * `.git`, cleanable with a plain `rm -rf`.
 *
 * **Code path vs. data path.** A release directory holds only what
 * `git archive` exports — no `.pipeline/`, no `checked.jsonl` growth,
 * no logs. A service that moves onto the release rail keeps reading and
 * writing its DATA (the memory root) exactly where it always did; only
 * which FILE it starts from ({@link codePath}) changes.
 *
 * **Where a release lives.** `<root>-release`, a directory next to the
 * source checkout — never inside it (so it needs no `.gitignore` entry
 * and a stray `git add .` in the checkout can never pick it up).
 *
 * **The proof gate.** {@link createRelease} accepts a target commit
 * only when {@link checkProof} finds a `checked.jsonl` row, READ AS IT
 * STANDS AT THAT COMMIT (the henne-ei problem: a row proving tree T
 * cannot sit IN the commit with tree T, since writing the row changes
 * the tree — so it always lands in a LATER commit), whose own commit is
 * an ancestor-or-equal of the release commit AND whose changes up to
 * the release commit touch only non-code paths ({@link CODE_PATTERNS}).
 * `allowUnproven` forces it through anyway, loud on stderr — a warning,
 * never a silent downgrade.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendLine } from './append.mjs';
import * as checkrecord from './checkrecord.mjs';

function git(root, argv) {
  return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Which changed paths count as CODE — the rest ("innocent" changes,
 * the sibling's term) do not invalidate a proof row. Ported from
 * `release.sh`'s `CODE_MUSTER`, adapted to this house's own layout:
 * `src/`, `bin/`, `hooks/`, `assets/` and `test/` are code wholesale;
 * under `install/` only the executable extensions count (the installers
 * carry both prose docs and real scripts); `package.json` /
 * `package-lock.json` are code (they gate what actually runs).
 * `checked.jsonl` itself is deliberately NOT on this list — a JSONL
 * ledger append is exactly the kind of "innocent" change a release must
 * tolerate, same as the sibling's own ledger file falls outside its
 * `CODE_MUSTER` by construction (no `.jsonl` pattern in it).
 */
export const CODE_PATTERNS = Object.freeze([
  /^src\//, /^bin\//, /^hooks\//, /^assets\//, /^test\//,
  /^install\/.*\.(sh|ps1|mjs)$/,
  /^package\.json$/, /^package-lock\.json$/,
]);

/** Is `p` (a repo-relative path, forward slashes) a code path? */
export function isCodePath(p) {
  return CODE_PATTERNS.some((m) => m.test(p));
}

/** `ref` resolved to a full commit hash, or `null` if it does not resolve. */
export function resolveCommit(root, ref) {
  try { return git(root, ['rev-parse', ref]); } catch { return null; }
}

/** The tree hash of `commit`, or `null`. */
export function resolveTree(root, commit) {
  try { return git(root, ['rev-parse', `${commit}^{tree}`]); } catch { return null; }
}

/** Is `a` an ancestor of, or equal to, `b`? */
export function isAncestorOrEqual(root, a, b) {
  if (a === b) return true;
  try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/**
 * Which paths differ between two commit-ish (or tree-ish) values — or
 * `null` when that cannot be determined any more (an object git no
 * longer has). `null` is deliberately not `[]`: "nothing changed" and
 * "not checkable" must never look the same, or a stale reference would
 * pass as an innocent one.
 */
export function changedPaths(root, a, b) {
  if (a === b) return [];
  try {
    const out = git(root, ['diff', '--name-only', a, b]);
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return null; }
}

/**
 * The ledger text AS IT STOOD AT `commit` (`git show commit:<relative
 * ledger path>`) — never the working copy, never a separately-fetched
 * `origin/main`: the release commit already carries the exact ledger
 * fassung a proof for it must be read from. `null` when the file does
 * not exist at that commit (no ledger yet, or a commit older than this
 * mechanism).
 */
export function ledgerAtCommit(root, commit, env = process.env) {
  const rel = path.relative(root, checkrecord.recordPath(root, env)).split(path.sep).join('/');
  if (rel.startsWith('..')) return null; // ledger lives outside the repo — nothing to read from a commit
  try { return git(root, ['show', `${commit}:${rel}`]); } catch { return null; }
}

/**
 * Does a valid proof cover `commit`? Reads newest rows first (the
 * candidate most likely to match today's tree). See the module
 * docblock for the henne-ei reasoning this mirrors from `release.sh`.
 */
export function checkProof(root, commit, { env = process.env } = {}) {
  const text = ledgerAtCommit(root, commit, env);
  if (text == null) return { valid: false, reason: 'no-ledger' };
  const rows = checkrecord.parseRecords(text);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!row || row.failed !== 0 || typeof row.commit !== 'string' || typeof row.tree !== 'string') continue;
    if (!isAncestorOrEqual(root, row.commit, commit)) continue;
    const changed = changedPaths(root, row.commit, commit);
    if (changed == null) continue; // unresolvable — try an older row
    if (changed.every((p) => !isCodePath(p))) return { valid: true, row, changed };
  }
  return { valid: false, reason: 'no-matching-record' };
}

/** `<root>-release` unless overridden. */
export function defaultBase(root, env = process.env) {
  return env.CHEAP_MEM_RELEASE_BASE || `${root}-release`;
}

function historyPath(base) { return path.join(base, 'history.jsonl'); }
function currentLink(base) { return path.join(base, 'current'); }

function readHistory(base) {
  let text;
  try { text = fs.readFileSync(historyPath(base), 'utf8'); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && typeof r === 'object') rows.push(r); } catch { /* skip */ }
  }
  return rows;
}

/** Atomic pointer swap: symlink a temp name, then rename over the real one (same filesystem). */
function switchCurrent(base, targetDir) {
  const tmp = path.join(base, `.current-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.symlinkSync(targetDir, tmp);
  fs.renameSync(tmp, currentLink(base));
}

/** Keep only the last `keep` distinct short-hash directories (by history order) plus whichever is current. */
function pruneOld(base, { keep = 3 } = {}) {
  const history = readHistory(base);
  let currentHash = null;
  try {
    const target = fs.readlinkSync(currentLink(base));
    currentHash = path.basename(path.isAbsolute(target) ? target : path.join(base, target));
  } catch { /* no current pointer yet */ }

  const keepSet = new Set(currentHash ? [currentHash] : []);
  for (let i = history.length - 1; i >= 0 && keepSet.size < keep; i -= 1) {
    if (history[i]?.kurzhash) keepSet.add(history[i].kurzhash);
  }

  let entries = [];
  try { entries = fs.readdirSync(base); } catch { return; }
  for (const name of entries) {
    if (!/^[0-9a-f]{12}$/.test(name)) continue;
    if (keepSet.has(name)) continue;
    fs.rmSync(path.join(base, name), { recursive: true, force: true });
  }
}

/**
 * Create (or reuse) a frozen, verified copy of `ref` (default
 * `origin/main`) under `<root>-release`, and atomically point `current`
 * at it. Requires a matching proof row unless `allowUnproven` is set —
 * then it proceeds with a loud stderr warning, never silently.
 */
export function createRelease(root, {
  ref = 'origin/main', allowUnproven = false, fetch = true, keep = 3, env = process.env, now = new Date(),
} = {}) {
  const base = defaultBase(root, env);
  fs.mkdirSync(base, { recursive: true });

  // One creation at a time — best-effort only (an exclusive lock file),
  // same posture as the sibling's `flock`: `createRelease` is a rare,
  // human/cron-triggered action, not a standing service; losing the
  // lock on a platform without one is an acceptable, explained gap, not
  // silent corruption (two runs would at worst race the same atomic
  // rename, which itself never leaves a half-written symlink).
  const lockFile = path.join(base, '.creating.lock');
  let lockFd;
  try { lockFd = fs.openSync(lockFile, 'wx'); }
  catch (e) {
    if (e && e.code === 'EEXIST') return { created: false, reason: 'busy' };
    lockFd = null; // could not lock at all — proceed best-effort rather than block a rare admin action
  }
  try {
    if (fetch) {
      try { execFileSync('git', ['fetch', '--quiet', 'origin', 'main'], { cwd: root, stdio: 'ignore' }); }
      catch { /* offline/no remote — try to resolve locally */ }
    }

    const commit = resolveCommit(root, ref);
    if (!commit) return { created: false, reason: 'unresolvable-ref', ref };
    const tree = resolveTree(root, commit);
    if (!tree) return { created: false, reason: 'unresolvable-tree', commit };

    const proof = checkProof(root, commit, { env });
    if (!proof.valid && !allowUnproven) {
      return { created: false, reason: 'no-proof', commit, tree };
    }
    if (!proof.valid) {
      process.stderr.write(`mem-release: WARNING — no matching checked.jsonl row for ${commit.slice(0, 12)} `
        + '— releasing anyway because allowUnproven was set. This is a forced, unverified release.\n');
    }

    const shortHash = git(root, ['rev-parse', '--short=12', commit]);
    const target = path.join(base, shortHash);
    if (!fs.existsSync(target)) {
      const tmp = fs.mkdtempSync(path.join(base, '.building-'));
      // Piped through Node itself (`execFileSync` for the archive bytes,
      // `spawnSync` with those bytes as `input` for the extraction) —
      // no shell string interpolation of `commit`/`tmp`, unlike the
      // sibling's bash `git archive ... | tar -x ...`, which is safe
      // there only because both values are shell-quoted by the caller.
      let archiveBytes;
      try {
        archiveBytes = execFileSync('git', ['archive', commit], { cwd: root, maxBuffer: 1024 * 1024 * 1024 });
      } catch (e) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return { created: false, reason: 'archive-failed', error: String(e?.message ?? e) };
      }
      const tar = spawnSync('tar', ['-x', '-C', tmp], { input: archiveBytes });
      if (tar.status !== 0 || tar.error) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return {
          created: false, reason: 'extract-failed',
          error: tar.error ? String(tar.error.message) : String(tar.stderr || `tar exit ${tar.status}`),
        };
      }
      fs.renameSync(tmp, target);
    }

    fs.writeFileSync(path.join(target, '.release-meta.json'), JSON.stringify({
      commit, kurzhash: shortHash, tree, createdAt: now.toISOString(),
      proven: proof.valid, proofKind: proof.valid ? 'ledger' : 'forced',
      sourceRoot: root,
    }, null, 2));

    switchCurrent(base, target);

    appendLine(historyPath(base), `${JSON.stringify({
      action: 'create', ts: now.toISOString(), commit, kurzhash: shortHash, tree, target, proven: proof.valid,
    })}\n`);

    pruneOld(base, { keep });

    return { created: true, commit, tree, kurzhash: shortHash, path: target, proven: proof.valid };
  } finally {
    if (lockFd != null) { try { fs.closeSync(lockFd); fs.unlinkSync(lockFile); } catch { /* already gone */ } }
  }
}

/**
 * Point `current` at the state immediately before the one now active —
 * the second-to-last row in `history.jsonl` (the same "last row is now,
 * the one before is before" reading the sibling's `zurueck` uses, so a
 * `create → create → rollback → create` sequence rolls back to the
 * right place instead of ping-ponging between only two states).
 */
export function rollback(root, { env = process.env, now = new Date() } = {}) {
  const base = defaultBase(root, env);
  const history = readHistory(base);
  if (history.length < 2) return { rolledBack: false, reason: 'no-prior-state' };
  const prior = history[history.length - 2];
  if (!prior?.kurzhash) return { rolledBack: false, reason: 'no-prior-state' };
  const target = path.join(base, prior.kurzhash);
  if (!fs.existsSync(target)) return { rolledBack: false, reason: 'prior-state-gone', kurzhash: prior.kurzhash };

  switchCurrent(base, target);
  appendLine(historyPath(base), `${JSON.stringify({
    action: 'rollback', ts: now.toISOString(), commit: prior.commit ?? null, kurzhash: prior.kurzhash,
    tree: prior.tree ?? null, target,
  })}\n`);
  return { rolledBack: true, kurzhash: prior.kurzhash, path: target };
}

/**
 * Which directory a service should start its CODE from: `current`
 * under `<root>-release` when it is a usable release (has a `bin/`
 * directory — the same "contains the thing a service actually loads"
 * marker the sibling checks for `betrieb/`), else `root` itself, with a
 * reason a caller can log (mirrors `release.sh code-pfad`'s one-line
 * stderr fallback note).
 */
export function codePath(root, { env = process.env } = {}) {
  const base = defaultBase(root, env);
  const current = currentLink(base);
  let real = null;
  try { real = fs.realpathSync(current); } catch { /* no current pointer yet */ }
  if (real && fs.existsSync(path.join(real, 'bin'))) {
    return { path: real, fromRelease: true, reason: null };
  }
  return {
    path: root,
    fromRelease: false,
    reason: `no usable release under ${current} — falling back to the source checkout ${root} `
      + '(run `mem-release create` once to enable this)',
  };
}

/** Read `.release-meta.json` of whatever `current` points at — the live release state, for the dashboard. */
export function currentState(root, { env = process.env } = {}) {
  const base = defaultBase(root, env);
  const current = currentLink(base);
  let target;
  try { target = fs.readlinkSync(current); } catch {
    return { readable: false, reason: 'unknown — no release yet', base };
  }
  const targetAbs = path.isAbsolute(target) ? target : path.join(base, target);
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(targetAbs, '.release-meta.json'), 'utf8')); } catch (e) {
    return { readable: false, base, reason: `"current" points at ${targetAbs}, but .release-meta.json is not readable: ${e?.message || e}` };
  }
  return { readable: true, base, path: targetAbs, ...meta };
}

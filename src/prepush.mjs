// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * prepush — the pre-push WARNING: is there a green CI run for what is
 * about to land on the default branch?
 *
 * **Where it comes from.** The sibling house (lucky-mem) has a pre-push
 * BLOCK (its "Riegel B", 2026-10-01): after two sessions pushed code
 * straight to main past the full suite, its hook refuses a push to main
 * unless a tracked ledger row proves the pushed tree was tested green
 * locally. This house was decided to get the guard too (2026-10-01) — but
 * as a warning that reads CI, not as a block that reads a local stamp.
 *
 * **Why a warning, and why CI instead of a local stamp.**
 *   - `src/checkrecord.mjs` says why this house keeps no machine-local
 *     green stamp: there is no second machine here that only pulls code,
 *     the person who pushes is the person who tested. A local stamp would
 *     be a second copy of a fact with nothing new to say. What IS
 *     independent of the pusher's own box is CI (`.github/workflows/
 *     ci.yml` runs on every push to every branch), so that is the
 *     evidence this hook asks for.
 *   - A block needs an answer it can trust every time. CI status comes
 *     over the network through `gh`, which may be missing, logged out or
 *     offline. Blocking on "could not ask" would lock people out for a
 *     reason that has nothing to do with their code; letting it through
 *     silently would claim a check that never happened. So: never block,
 *     always say what is known.
 *
 * **Five states, and "green" only when CI said so.**
 *   green    at least one CI run for this exact commit, all finished,
 *            none failed
 *   red      a run for this commit finished with failure/cancel/timeout
 *   pending  runs exist, none failed yet, at least one still running
 *   none     `gh` answered, and there is no run for this commit at all
 *   unknown  `gh` missing, not logged in, offline, timed out, the remote
 *            is not on GitHub, or the answer did not parse
 * `unknown` is never shown as green, and never as "no runs" either —
 * "could not ask" and "asked, nothing there" are different findings.
 *
 * **What is checked.** Only pushes to the remote's default branch
 * (`refs/remotes/<remote>/HEAD`, else `main`/`master`): a feature-branch
 * push is exactly how a commit GETS its CI run, so warning there would be
 * noise on every push. A branch deletion is skipped. The exact commit is
 * checked; a fresh merge commit has no run of its own yet, and the hook
 * says so — that tree has not been through CI.
 *
 * **It writes nothing** and only runs read-only `git` and `gh` calls.
 * The hook script (`hooks/pre-push`) exits 0 no matter what this prints.
 *
 * invariant: nothing-rather-than-wrong
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Every state the hook can report — the list, in one place. */
export const STATES = Object.freeze(['green', 'red', 'pending', 'none', 'unknown']);

/** The marker the hook script waits for: no marker, no answer (reported as unknown). */
export const END_MARK = 'PREPUSH-END';

/** How long one `gh` call may take before the answer is "unknown". */
export const GH_TIMEOUT_MS = 15000;

const ZERO_SHA = /^0+$/;
const FAILED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const PASSED = new Set(['success', 'skipped', 'neutral']);

/** The lines git hands a pre-push hook on stdin: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function parsePushLines(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 4) continue;
    const [localRef, localSha, remoteRef, remoteSha] = parts;
    out.push({ localRef, localSha, remoteRef, remoteSha });
  }
  return out;
}

/** `owner/repo` from a GitHub remote URL (https or ssh), else `null`. */
export function githubRepo(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(String(url ?? ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The branch names that count as "the default branch" of this remote. */
export function defaultBranches(root, remote) {
  if (remote) {
    const head = git(root, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]);
    if (head && head.startsWith(`${remote}/`)) return [head.slice(remote.length + 1)];
  }
  return ['main', 'master'];
}

/**
 * The state from the list `gh run list --json status,conclusion` gives.
 * Pure, so every state can be probed without a network.
 */
export function verdictFromRuns(runs) {
  if (!Array.isArray(runs)) return 'unknown';
  if (runs.length === 0) return 'none';
  let running = false;
  for (const r of runs) {
    if (r?.status !== 'completed') { running = true; continue; }
    if (FAILED.has(r.conclusion)) return 'red';
    if (!PASSED.has(r.conclusion)) running = true; // an unknown conclusion is not a pass
  }
  return running ? 'pending' : 'green';
}

/**
 * Ask `gh` for the CI runs of one commit. Never throws.
 * Returns `{state, runs, detail}`.
 */
export function ciStatus(root, sha, { repo = null, gh = 'gh', timeoutMs = GH_TIMEOUT_MS } = {}) {
  const args = ['run', 'list', '--commit', sha, '--json', 'status,conclusion,workflowName,url', '--limit', '100'];
  if (repo) args.push('--repo', repo);
  let r;
  try {
    r = spawnSync(gh, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs });
  } catch (e) {
    return { state: 'unknown', runs: null, detail: `gh could not be started: ${e.message}` };
  }
  if (r.error) {
    const why = r.error.code === 'ENOENT' ? 'gh is not installed'
      : (r.error.code === 'ETIMEDOUT' ? `gh did not answer within ${Math.round(timeoutMs / 1000)} s` : r.error.message);
    return { state: 'unknown', runs: null, detail: why };
  }
  if (r.status !== 0) {
    const first = String(r.stderr ?? '').trim().split('\n')[0] || `exit ${r.status}`;
    return { state: 'unknown', runs: null, detail: `gh failed (${first})` };
  }
  let runs;
  try { runs = JSON.parse(r.stdout); } catch { return { state: 'unknown', runs: null, detail: 'gh answer is not JSON' }; }
  if (!Array.isArray(runs)) return { state: 'unknown', runs: null, detail: 'gh answer is not a list' };
  return { state: verdictFromRuns(runs), runs, detail: null };
}

const SAY = {
  green: 'CI is green for this commit.',
  red: 'CI FAILED for this commit.',
  pending: 'CI is still running for this commit — not green yet.',
  none: 'no CI run for this exact commit yet — it has not been through CI.',
  unknown: 'CI status unknown',
};

/**
 * The whole check for one push: which refs matter, their state, and the
 * lines to print. Never throws; anything unexpected becomes `unknown`.
 */
export function checkPush(root, { remote = '', url = '', input = '', gh = 'gh', timeoutMs = GH_TIMEOUT_MS } = {}) {
  const branches = defaultBranches(root, remote);
  const repo = githubRepo(url);
  const results = [];
  for (const p of parsePushLines(input)) {
    if (!p.remoteRef.startsWith('refs/heads/')) continue;
    const branch = p.remoteRef.slice('refs/heads/'.length);
    if (!branches.includes(branch)) continue;
    if (ZERO_SHA.test(p.localSha)) continue; // a deletion pushes no commit
    const status = repo
      ? ciStatus(root, p.localSha, { repo, gh, timeoutMs })
      : { state: 'unknown', runs: null, detail: `the remote is not on GitHub (${url || 'no URL'}), so CI cannot be asked` };
    results.push({ branch, sha: p.localSha, ...status });
  }
  const lines = [];
  for (const r of results) {
    const head = `pre-push (cheap-mem): ${r.branch} @ ${r.sha.slice(0, 12)}: ${SAY[r.state]}`;
    if (r.state === 'green') { lines.push(head); continue; }
    lines.push(`${head}${r.state === 'unknown' && r.detail ? ` — ${r.detail}` : ''}`);
    if (r.state === 'red') {
      for (const run of (r.runs ?? []).filter((x) => FAILED.has(x.conclusion)).slice(0, 3)) {
        lines.push(`  ${run.workflowName ?? 'workflow'}: ${run.conclusion}  ${run.url ?? ''}`.trimEnd());
      }
    }
    lines.push('  This is a warning, not a block: the push goes ahead.');
    lines.push(r.state === 'unknown'
      ? '  Check by hand before relying on it: gh run list --commit <sha>'
      : '  Safer: push the branch first, let CI run green, then move it to the default branch.');
  }
  return { results, lines };
}

// Hook entry: `node src/prepush.mjs <remote-name> <remote-url>` with git's
// push lines on stdin. Prints to stdout, ends with END_MARK, always exit 0.
const direct = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (direct) {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', () => {
    let lines;
    try {
      const root = git(process.cwd(), ['rev-parse', '--show-toplevel']) ?? process.cwd();
      ({ lines } = checkPush(root, {
        remote: process.argv[2] ?? '', url: process.argv[3] ?? '',
        input: Buffer.concat(chunks).toString('utf8'),
      }));
    } catch (e) {
      lines = [`pre-push (cheap-mem): CI status unknown — the check failed (${e.message}). The push goes ahead.`];
    }
    process.stdout.write(`${lines.map((l) => `${l}\n`).join('')}${END_MARK}\n`);
  });
}

#!/usr/bin/env node
/**
 * Parity counter (mem-admin_02 L5): how many commits since the cutoff
 * carry `Parity: lm=yes|no|open`? Turns "both houses always kept level"
 * (BAUPLAN-mem-admin_02.md L5, BAUWEISE.md rule 15) into a number
 * instead of a claim.
 *
 * **The cutoff.** `CUTOFF` is this repo's HEAD on 2026-09-26, the day
 * this line was introduced (commit 667576f...). Commits BEFORE it are
 * excluded, and that is a reasoned exclusion, not convenience: the line
 * did not exist back then, nobody could have carried it, and rewriting
 * history is forbidden (BAUPLAN §0.5, mirrored here). Checking those
 * commits would either raise a false alarm against every old code
 * commit or force a history rewrite. From the cutoff on, "no trailer"
 * is a real finding.
 *
 * **One truth, not two** (same reasoning as bench/readme-numbers.mjs):
 * the cutoff, the trailer shape and the classification (touches src/
 * or bin/? merge? doc/log/test only?) live HERE; test/parity-gate.test.mjs
 * imports them instead of writing them a second time.
 *
 * This is cheap-mem's own copy of lucky-mem's `bench/paritaet.mjs` — a
 * fresh build, not a port, per BAUPLAN §0.1 ("Portieren heisst neu
 * bauen, nie cherry-pick"). Same shape, English words, its own trailer
 * key and cutoff.
 *
 * Usage:
 *   node bench/parity.mjs                  # count from the cutoff
 *   node bench/parity.mjs --cutoff <hash>   # a different cutoff (tests)
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// HEAD of cheap-mem on 2026-09-26, before L5 was built. See the header
// comment above: everything before it is excluded, on record, not
// silently skipped.
export const CUTOFF = '667576f944532155a951de0e2de1b5d9fb1d286a';

const STX = '\x02'; // separates commits in the raw log output
const US = '\x1f'; // separates hash from raw body within one commit
const ETX = '\x03'; // separates the header (hash+body) from the --name-only file list

export const TRAILER_PATTERN = /^Parity:\s*lm=(yes|no|open)\s*$/m;

function git(args, root) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/**
 * Is the cutoff even present in local history? A shallow clone (the
 * default `actions/checkout` behaviour — effectively `fetch-depth: 1`)
 * does not have it — that is "not measurable", not a failure (the
 * four-state rule this repo mirrors from lucky-mem: measurable-good,
 * measurable-bad, and unmeasurable are three different things).
 */
export function cutoffMeasurable(root, cutoff) {
  try {
    git(['cat-file', '-e', `${cutoff}^{commit}`], root);
  } catch {
    return false;
  }
  try {
    git(['merge-base', '--is-ancestor', cutoff, 'HEAD'], root);
    return true;
  } catch (e) {
    // Exit 1: object exists but is not an ancestor of HEAD (e.g. cutoff
    // on an unrelated branch) — measurable, the range below is just
    // empty or nonsensical. Anything else: objects are genuinely gone.
    return e.status === 1;
  }
}

/**
 * Reads `git log <cutoff>..HEAD --name-only --format=...` in ONE call.
 * `--no-merges` drops merge commits right here (BAUPLAN L5: "merge
 * commits ... are excluded") instead of filtering them out afterwards.
 */
export function commitsSince(root, cutoff) {
  const raw = git(
    ['log', `${cutoff}..HEAD`, '--no-merges', '--name-only', `--format=${STX}%H${US}%B${ETX}`],
    root,
  );
  const commits = [];
  for (const chunk of raw.split(STX)) {
    if (!chunk.trim()) continue;
    const etxAt = chunk.indexOf(ETX);
    if (etxAt === -1) continue;
    const head = chunk.slice(0, etxAt);
    const fileTail = chunk.slice(etxAt + 1);
    const usAt = head.indexOf(US);
    const hash = head.slice(0, usAt);
    const body = head.slice(usAt + 1);
    const files = fileTail
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    commits.push({ hash, body, files });
  }
  return commits;
}

export const TOUCHES_CODE = (file) => file.startsWith('src/') || file.startsWith('bin/');

/**
 * A commit needs the line when it changes at least one file under
 * `src/` or `bin/`. A pure doc/log/test commit never does, so it is
 * excluded by construction — the positive control for that lives in
 * test/parity-gate.test.mjs.
 */
export function needsLine(commit) {
  return commit.files.some(TOUCHES_CODE);
}

export function hasLine(commit) {
  return TRAILER_PATTERN.test(commit.body);
}

/** Core evaluation, shared by the counter and the gate test. */
export function evaluate(root = DEFAULT_ROOT, cutoff = CUTOFF) {
  if (!cutoffMeasurable(root, cutoff)) {
    return {
      measurable: false,
      reason: `cutoff ${cutoff.slice(0, 12)} not reachable in local history (shallow?)`,
    };
  }
  const commits = commitsSince(root, cutoff);
  const codeCommits = commits.filter(needsLine);
  const counts = { yes: 0, no: 0, open: 0 };
  const violations = [];
  for (const c of codeCommits) {
    const m = c.body.match(TRAILER_PATTERN);
    if (m) counts[m[1]] += 1;
    else violations.push({ hash: c.hash.slice(0, 12), subject: c.body.split('\n')[0] });
  }
  return {
    measurable: true,
    totalCommits: commits.length,
    codeCommits: codeCommits.length,
    counts,
    violations,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--cutoff');
  const cutoff = i === -1 ? CUTOFF : argv[i + 1];
  const r = evaluate(DEFAULT_ROOT, cutoff);
  if (!r.measurable) {
    console.log(`Parity: not measurable (${r.reason})`);
    return;
  }
  console.log(`Parity since ${cutoff.slice(0, 12)}: ${r.codeCommits} code commits (src/ or bin/)`);
  console.log(`  yes:  ${r.counts.yes}`);
  console.log(`  no:   ${r.counts.no}`);
  console.log(`  open: ${r.counts.open}`);
  console.log(`  missing the line: ${r.violations.length}`);
  for (const v of r.violations) console.log(`    ${v.hash} ${v.subject}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

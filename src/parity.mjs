// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Parity core (mem-admin_02 L5): how many commits since the cutoff
 * carry `Parity: lm=yes|no|open`? Turns "both houses always kept level"
 * (BAUPLAN-mem-admin_02.md L5, BAUWEISE.md rule 15) into a number
 * instead of a claim.
 *
 * **Moved here from `bench/parity.mjs` (agent/parity-to-src, 2026-09-29).**
 * `src/doctor.mjs` needs `debtList` (W9) for `mem doctor`, and `src/`
 * must never import from `bench/` — `bench/` is not in the published
 * npm package (see `test/package-contents.test.mjs`), so an installed
 * `mem doctor` crashed with `ERR_MODULE_NOT_FOUND` the moment it tried.
 * `bench/parity.mjs` is now the thin CLI: `--debt`/plain counting,
 * importing and re-exporting everything below so existing callers and
 * tests keep working unchanged.
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
 * This is cheap-mem's own copy of lucky-mem's `src/paritaet.mjs` — a
 * fresh build, not a port, per BAUPLAN §0.1 ("Portieren heisst neu
 * bauen, nie cherry-pick"). Same shape, English words, its own trailer
 * key and cutoff.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { siblingClone } from './sibling.mjs';

export const DEFAULT_ROOT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

// HEAD of cheap-mem on 2026-09-26, before L5 was built. See the header
// comment above: everything before it is excluded, on record, not
// silently skipped.
export const CUTOFF = '667576f944532155a951de0e2de1b5d9fb1d286a';

const STX = '\x02'; // separates commits in the raw log output
const US = '\x1f'; // separates hash from raw body within one commit
const ETX = '\x03'; // separates the header (hash+body) from the --name-only file list

// Named exceptions, each with its reason. Only for commits that were
// already merged AND pushed before the rule reached their branch, so the
// line can no longer be added without rewriting pushed history (forbidden).
// Adding an entry here is a decision, not a convenience: one hash, one why.
export const EXEMPT = new Map([
  ['8201ff4ef856', 'N4, merged and pushed on the integration branch (de588b8) before the L5 merge 7f1d479 brought the rule there; parity: lucky-mem has its own N1 (mem_nutzer), so the honest value would have been lm=yes'],
]);

export const TRAILER_PATTERN = /^Parity:\s*lm=(yes|no|open)\s*$/m;

/**
 * Addendum (2026-09-29, mirror of lucky-mem's Paritaet-Nachtrag): a later
 * commit supplies the line for an earlier, already pushed one —
 * `Parity-Addendum: <hash> lm=yes|no|open`, one commit per line. History is
 * never rewritten; this is append-only like a correction line. The hash
 * needs at least 7 characters.
 */
export const ADDENDUM_PATTERN = /^Parity-Addendum:\s*([0-9a-f]{7,40})\s+lm=(yes|no|open)\s*$/gm;

export function addenda(commits) {
  const list = [];
  for (const c of commits) {
    for (const m of c.body.matchAll(ADDENDUM_PATTERN)) list.push({ prefix: m[1], value: m[2], from: c.hash });
  }
  return list;
}

function git(args, root) {
  // maxBuffer raised (default 1 MB): readDoneLines (W9) scans the WHOLE
  // history with full commit bodies, no cutoff — lucky-mem alone is
  // past 5000 commits and blew the default (ENOBUFS, 2026-09-29).
  //
  // **stderr stays in the process (2026-10-02).** Without `stdio` an
  // `execFileSync` child INHERITS its stderr: an expected failure such as
  // `cat-file -e <cutoff>^{commit}` in a fresh or shallow clone printed a raw
  // `fatal: Not a valid object name ...` line from `mem doctor`, although the
  // finding reports the case properly as "not measurable". The caller sees the
  // failure as an exception; the child's message sits in `e.stderr`.
  return execFileSync('git', args, {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** The reason when the cutoff is missing from this history (fresh or shallow clone). */
function cutoffMissingReason(cutoff) {
  return `cutoff ${cutoff.slice(0, 12)} not reachable in local history (fresh or shallow clone: `
    + '`git fetch --unshallow` makes the parity debt measurable) — not measurable, not zero';
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
    ['log', `${cutoff}..HEAD`, '--no-merges', '--name-only', `--format=${STX}%H${US}%cI${US}%B${ETX}`],
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
    const usAt2 = head.indexOf(US, usAt + 1);
    const hash = head.slice(0, usAt);
    const date = head.slice(usAt + 1, usAt2);
    const body = head.slice(usAt2 + 1);
    const files = fileTail
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    commits.push({ hash, date, body, files });
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

/**
 * Commits brought in by a merge commit that DOES carry the parity line.
 *
 * **Why (2026-09-26, first real hit, ported from lucky-mem).** Agents
 * work on their own branches, often started before the cutoff, and do
 * not know the rule while working; the orchestrator decides parity at
 * merge time. If merge commit M carries the line, it applies to every
 * commit in M^1..M^2 — exactly the ones it brings in. A merge WITHOUT
 * the line covers nothing; every code commit in it stays a violation.
 */
export function coveredByMerge(root, cutoff) {
  const map = new Map();
  let merges;
  try {
    merges = git(['log', `${cutoff}..HEAD`, '--merges', `--format=${STX}%H${US}%B${ETX}`], root);
  } catch { return map; }
  for (const block of merges.split(STX).filter(Boolean)) {
    const [hash, rest = ''] = block.split(US);
    const body = rest.split(ETX)[0];
    const hit = body.match(TRAILER_PATTERN);
    if (!hit) continue;
    let list = '';
    try { list = git(['rev-list', `${hash}^1..${hash}^2`], root); } catch { continue; }
    for (const h of list.split('\n').map((z) => z.trim()).filter(Boolean)) {
      if (!map.has(h)) map.set(h, hit);
    }
  }
  return map;
}

/**
 * Resolves the value (yes/no/open) for ONE code commit — direct line,
 * merge coverage, or addendum, in that order. `null` when none apply
 * (a violation). Factored out of `evaluate()` so `openItems()` (W9)
 * shares the same resolution instead of writing it twice.
 */
export function resolveValue(commit, covered, added) {
  const a = added.filter((x) => commit.hash.startsWith(x.prefix));
  const suppliedByAddendum = a.length ? [null, a[a.length - 1].value] : null;
  return commit.body.match(TRAILER_PATTERN) ?? covered.get(commit.hash) ?? suppliedByAddendum ?? null;
}

/** Core evaluation, shared by the counter and the gate test. */
export function evaluate(root = DEFAULT_ROOT, cutoff = CUTOFF) {
  if (!cutoffMeasurable(root, cutoff)) {
    return {
      measurable: false,
      reason: cutoffMissingReason(cutoff),
    };
  }
  const commits = commitsSince(root, cutoff);
  const codeCommits = commits.filter(needsLine);
  const covered = coveredByMerge(root, cutoff);
  const added = addenda(commits);
  const counts = { yes: 0, no: 0, open: 0 };
  const violations = [];
  for (const c of codeCommits) {
    const m = resolveValue(c, covered, added);
    if (m) counts[m[1]] += 1;
    else if (EXEMPT.has(c.hash.slice(0, 12))) continue;
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

/**
 * W9 — parity debt: every code commit since the cutoff whose resolved
 * value is `open` (directly, via merge coverage, or via an addendum —
 * same resolution as `evaluate()`) is an open item. Plain list, no
 * closing check — `debtList()` checks closure against lucky-mem.
 */
export function openItems(root = DEFAULT_ROOT, cutoff = CUTOFF) {
  if (!cutoffMeasurable(root, cutoff)) {
    return { measurable: false, reason: cutoffMissingReason(cutoff) };
  }
  const commits = commitsSince(root, cutoff);
  const codeCommits = commits.filter(needsLine);
  const covered = coveredByMerge(root, cutoff);
  const added = addenda(commits);
  const items = [];
  for (const c of codeCommits) {
    const m = resolveValue(c, covered, added);
    if (m && m[1] === 'open') items.push({ cm_hash: c.hash, subject: c.body.split('\n')[0], date: c.date });
  }
  return { measurable: true, items };
}

// The closing counter-line on the lm side: `Paritaet-Erledigt: <cm-hash>`,
// one hash per line, at least 7 hex characters.
export const DONE_PATTERN = /^Paritaet-Erledigt:\s*([0-9a-f]{7,40})\s*$/gm;

/**
 * Reads ALL `Paritaet-Erledigt: <hash>` lines from the given repo's
 * history (here: the lucky-mem clone). No cutoff — closing can happen
 * at any time, even for an old open item. `null` when that repo is not
 * readable there.
 */
export function readDoneLines(root) {
  let raw;
  try {
    raw = git(['log', `--format=${STX}%H${US}%B${ETX}`], root);
  } catch {
    return null;
  }
  const hits = [];
  for (const chunk of raw.split(STX)) {
    if (!chunk.trim()) continue;
    const etxAt = chunk.indexOf(ETX);
    if (etxAt === -1) continue;
    const head = chunk.slice(0, etxAt);
    const usAt = head.indexOf(US);
    const hash = head.slice(0, usAt);
    const body = head.slice(usAt + 1);
    for (const m of body.matchAll(DONE_PATTERN)) {
      hits.push({ prefix: m[1].toLowerCase(), from: hash });
    }
  }
  return hits;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * W9 baseline date (coordinator, 2026-09-29): from when an open item
 * counts as NEW debt instead of backlog.
 *
 * **Why this exists.** On the day this was built, 7 open `lm=open`
 * items already sat in the history — a warning over their age could
 * never clear (the oldest only gets older), which would be pure noise.
 * An item whose commit date is BEFORE this instant is legacy: still
 * counted and fully listed by `--debt` (hiding it is not allowed), but
 * it does not drive the WARN threshold in `checkParityDebt()`. An item
 * FROM this instant on is new and counts against the age threshold.
 */
export const W9_BASELINE = '2026-09-29T00:00:00Z';

/**
 * W9 — the parity debt list: every open `lm=open` item since the cutoff
 * that is NOT closed by a `Paritaet-Erledigt: <cm-hash>` line on the
 * lucky-mem side. Reads lucky-mem through the sibling clone
 * (`siblingClone`, the same lookup the `finding-parity` doctor check
 * uses) — no separate config path.
 *
 * If the sibling clone is absent or unreadable: "not measurable:
 * sibling not readable", NEVER an empty list.
 *
 * Each item also carries `legacy` (commit date before `W9_BASELINE`) —
 * the list itself stays complete, legacy items are never filtered out,
 * only marked.
 */
export function debtList(root = DEFAULT_ROOT, cutoff = CUTOFF, { sibling = null, now = Date.now() } = {}) {
  const open = openItems(root, cutoff);
  if (!open.measurable) return { measurable: false, reason: open.reason };
  const lmRoot = sibling ?? siblingClone(root);
  if (!lmRoot) return { measurable: false, reason: 'not measurable: sibling not readable' };
  const done = readDoneLines(lmRoot);
  if (done === null) return { measurable: false, reason: 'not measurable: sibling not readable' };
  const baseline = Date.parse(W9_BASELINE);
  const remaining = open.items
    .filter((it) => !done.some((d) => it.cm_hash.startsWith(d.prefix)))
    .map((it) => ({
      ...it,
      ageDays: Math.floor((now - Date.parse(it.date)) / DAY_MS),
      legacy: Date.parse(it.date) < baseline,
    }))
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  return { measurable: true, items: remaining };
}

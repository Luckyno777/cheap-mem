// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * agentledger.mjs — count jobs, do not claim strengths.
 *
 * **The problem this answers.** An agent registry that BELIEVES a
 * strength ("the Sonnet agent is strong at design" — plausible and
 * unproven) is assumption dressed as measurement. This module counts
 * the opposite: per agent kind/model, only what the job journal can
 * show — jobs in three stages (confirmed / rework or error evidenced /
 * unknown), the share of unknown with its denominator, and packages
 * with a real revert. There is no verdict word at all.
 *
 * **The data source is not a new file.** There is no separate ledger
 * on disk — it is the set of `event` entries tagged `job`, in
 * `global/events.jsonl` and `projects/*\/events.jsonl` (the same log
 * `mem log event` already writes to). This module writes NOTHING new;
 * it only reads, through `memory.iterLog()` / `memory.listProjects()`
 * — the same path `mem log` itself uses.
 *
 * ## The logging convention (documented here, not enforced by a writer)
 *
 * A job entry is an ordinary `mem log event`, with five extra fields —
 * English names, the only convention this module reads:
 *
 *   mem log event --project <name> --tags job,agents,<package> \
 *     --title "..." --package <package> --agent_kind <kind> \
 *     --model <model> --first_try yes|no --follow_ups <n>
 *
 * `mem log` turns every `--flag` into a JSON field (see
 * `src/cli/commands/write.mjs`), so those five names land verbatim in
 * the entry. `buildJobFields()` below only shapes and validates that
 * object — the write itself stays the existing `mem log event` (or
 * `mem_log` at the bridge) path. There is no `logJob()` here on
 * purpose: a second writer for the same log is a second place for the
 * shape to drift from what this module reads.
 *
 * A `package` field missing means the entry cannot be attributed to a
 * job at all — it counts in `unassigned`, never guessed at. A missing
 * `agent_kind` or `model` is recorded as the string `'unknown'`, never
 * left null and never inferred.
 *
 * ## Three stages, no verdict (Z1a, 2026-09-30, decision E5a)
 *
 * Every job is exactly one of:
 *
 *   confirmed  — a POSITIVE evidence (`first_try=yes` in the entry) and
 *                NO counter-evidence;
 *   rework     — rework or error EVIDENCED: `first_try=no`, `follow_ups`
 *                greater than 0, a follow-up word in the entry's own
 *                text/title, or a commit on `git log --all` (every branch)
 *                whose subject starts `<package>-followup` or
 *                `<package>-rework`. A counter-evidence always beats a
 *                "yes". (A real revert stays its OWN count, as before,
 *                and is not a stage evidence.)
 *   unknown    — no signal. NEVER success: not measurable is not "yes".
 *
 * Before, a job without any follow-up evidence counted as first-try
 * usable ("a floor"); 20 jobs with `follow_ups: 3` and no `first_try`
 * came out as 20 successes, 0 follow-ups and "notably strong", and
 * `follow_ups` was never read. The ledger now reports only numbers and
 * the share of "unknown" with its denominator (all attributed jobs of
 * the group) — no verdict vocabulary, no thresholds.
 *
 * **A revert** counts only a real `git revert` commit (subject
 * `Revert "..."`), across all branches, deduplicated by commit hash (the
 * same commit can appear on several branches through shared ancestry).
 */

import { execFileSync } from 'node:child_process';
import * as memory from './memory.mjs';

/** The three stages per job (Z1a, E5a). A word not listed here does not exist. */
export const STAGE = Object.freeze({
  CONFIRMED: 'confirmed',
  REWORK: 'rework',
  UNKNOWN: 'unknown',
});

const UNKNOWN = 'unknown';

/** A follow-up named in free text (evidence b, see module head). */
const FOLLOW_UP_TEXT_RE = /follow-?up\w*|rework\w*|reworked|redo(?:ne|s)?\b/i;

/** Package prefix of a commit subject ("Q1-followup: ..." -> "q1"). */
const COMMIT_PACKAGE_PREFIX_RE = /^([A-Za-z][A-Za-z0-9]*(?:\s*\+\s*[A-Za-z0-9]+)*)[\s-]+/;

/** A number >= 0 or null — never guessed, never 0 for "not there". */
function numberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizePackage(p) {
  return String(p ?? '').trim().replace(/\s*\+\s*/g, '+').replace(/\s+and\s+/gi, '+');
}

/**
 * Shapes and validates the five job fields — the convention documented
 * at the top of this file. It does NOT write anything: pass the result
 * as extra `--flag value` pairs to `mem log event` (or as extra fields
 * to `memory.logEntry`/`mem_log`), unchanged.
 */
export function buildJobFields({
  package: pkg, agent_kind: agentKind = null, model = null, first_try: firstTry, follow_ups: followUps = 0,
} = {}) {
  if (!pkg || !String(pkg).trim()) throw new Error('buildJobFields: package is missing.');
  if (typeof firstTry !== 'boolean') {
    throw new Error("buildJobFields: first_try must be true/false ('yes'/'no' in the entry).");
  }
  const n = Number(followUps);
  return {
    package: String(pkg).trim(),
    agent_kind: agentKind && String(agentKind).trim() ? String(agentKind).trim() : UNKNOWN,
    model: model && String(model).trim() ? String(model).trim() : UNKNOWN,
    first_try: firstTry ? 'yes' : 'no',
    follow_ups: Number.isFinite(n) && n >= 0 ? n : 0,
  };
}

/** `git log --all`, once — the same quiet-failure shape as doctor.mjs. */
function gitAllCommits(root, git) {
  const g = git ?? ((args) => execFileSync('git', ['-C', root, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    return g(['log', '--all', '--format=%H|%s']).trim();
  } catch { return null; }
}

/**
 * Follow-up and revert signals from the commit history, across ALL
 * branches (`--all`), not only the default one — a job's follow-up
 * commit may sit on an open branch that never merged.
 *
 * The same commit hash can appear on several branches (shared
 * ancestors); it is deduplicated by hash.
 */
export function commitSignals(root, { git = null } = {}) {
  const raw = gitAllCommits(root, git);
  const followUp = new Map();
  const revert = new Map();
  if (raw === null) return { followUp, revert, git: false };
  const seen = new Set();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf('|');
    if (i < 0) continue;
    const hash = line.slice(0, i);
    const subject = line.slice(i + 1);
    if (seen.has(hash)) continue;
    seen.add(hash);

    if (FOLLOW_UP_TEXT_RE.test(subject)) {
      const m = subject.match(COMMIT_PACKAGE_PREFIX_RE);
      const pkg = m ? normalizePackage(m[1]).toLowerCase() : '(unnamed)';
      if (!followUp.has(pkg)) followUp.set(pkg, []);
      followUp.get(pkg).push({ hash, subject });
    }
    // Only a REAL `git revert` commit counts — its automatic subject
    // shape is `Revert "<original subject>"`. A word like "reverted"
    // inside an unrelated entry's text is not evidence of a package
    // revert (see module head).
    const rm = subject.match(/^revert\s+"([^"]+)"/i);
    if (rm) {
      const pm = rm[1].match(COMMIT_PACKAGE_PREFIX_RE);
      const pkg = pm ? normalizePackage(pm[1]).toLowerCase() : '(unnamed)';
      if (!revert.has(pkg)) revert.set(pkg, []);
      revert.get(pkg).push({ hash, subject });
    }
  }
  return { followUp, revert, git: true };
}

/** Every `event` line tagged `job`, global + every project. */
export function readJobJournal(root) {
  const hits = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    let it;
    try { it = memory.iterLog(root, 'event', { project }); } catch { continue; }
    for (const e of it) {
      if (e.__broken) continue;
      const tags = Array.isArray(e.tags) ? e.tags : [];
      if (!tags.includes('job')) continue;
      hits.push({ ...e, __project: project });
    }
  }
  return hits;
}

/**
 * One journal entry as a job record — or `null` when it carries no
 * `package` field at all (then it counts in `unassigned`, see
 * `extractJobs()`). No prose fallback: cheap-mem's job journal starts
 * with the structured convention, so nothing here is guessed from
 * free text except the follow-up signal, which is additive evidence
 * only (see module head, evidence b).
 */
export function jobFromEntry(e) {
  if (typeof e.package !== 'string' || !e.package.trim()) return null;
  const text = typeof e.text === 'string' ? e.text : '';
  const title = typeof e.title === 'string' ? e.title : '';
  const structuredFirstTry = e.first_try === 'no' ? false
    : e.first_try === 'yes' ? true : null;
  return {
    package: normalizePackage(e.package),
    agent_kind: typeof e.agent_kind === 'string' && e.agent_kind.trim() ? e.agent_kind.trim() : UNKNOWN,
    model: typeof e.model === 'string' && e.model.trim() ? e.model.trim() : UNKNOWN,
    firstTryEvidence: structuredFirstTry,
    followUpsField: numberOrNull(e.follow_ups),
    textFollowUp: FOLLOW_UP_TEXT_RE.test(text) || FOLLOW_UP_TEXT_RE.test(title),
  };
}

/**
 * Every job in the journal, enriched with the commit signals.
 *
 * Returns `{jobs, unassigned, git}`. `jobs` carries per entry `{id, ts,
 * project, package, agent_kind, model, firstTry, evidence, reverted}` —
 * `firstTry` is a bool, `evidence` says WHAT it rests on (for the
 * `--json` report, never a bare number with nothing behind it).
 */
export function extractJobs(root, { git = null } = {}) {
  const journal = readJobJournal(root);
  const signals = commitSignals(root, { git });
  const jobs = [];
  let unassigned = 0;

  for (const e of journal) {
    const j = jobFromEntry(e);
    if (!j) { unassigned += 1; continue; }
    // A job can bundle SEVERAL packages under one label
    // ("S6+L6+F3+L1"), while a commit subject usually names only ONE
    // ("S6-followup"). Each part-package is checked against the commit
    // signals separately, not only the whole label.
    const parts = j.package.toLowerCase().split('+').filter((t) => t);
    const commitHits = parts.flatMap((t) => signals.followUp.get(t) ?? []);
    const revertHits = parts.flatMap((t) => signals.revert.get(t) ?? []);

    // Stage per job (see module head): a COUNTER-evidence always wins, a
    // positive evidence is the only way to become "confirmed", and
    // without any signal it stays "unknown".
    const followUpsField = j.followUpsField ?? null;
    const counterEvidence = j.firstTryEvidence === false
      || (followUpsField !== null && followUpsField > 0)
      || j.textFollowUp === true
      || commitHits.length > 0;
    let stage;
    if (counterEvidence) stage = STAGE.REWORK;
    else if (j.firstTryEvidence === true) stage = STAGE.CONFIRMED;
    else stage = STAGE.UNKNOWN;

    let evidence;
    if (j.firstTryEvidence === false) evidence = 'structured field first_try=no';
    else if (followUpsField !== null && followUpsField > 0) evidence = `structured field follow_ups=${followUpsField}`;
    else if (j.textFollowUp) evidence = 'follow-up word in the event text';
    else if (commitHits.length) evidence = `commit: ${commitHits[0].subject}`;
    else if (j.firstTryEvidence === true) evidence = 'structured field first_try=yes';
    else evidence = 'no signal in the entry (neither confirmation nor rework evidenced)';

    jobs.push({
      id: e.id ?? null,
      ts: e.ts ?? null,
      project: e.__project,
      package: j.package,
      agent_kind: j.agent_kind,
      model: j.model,
      stage,
      followUps: followUpsField,
      evidence,
      reverted: revertHits.length > 0,
    });
  }
  return { jobs, unassigned, git: signals.git };
}

/**
 * The ledger: grouped by agent kind/model. Numbers only: jobs, the three
 * stages (confirmed / rework / unknown), the share of "unknown" with its
 * denominator (all attributed jobs), the sum of evidenced follow-ups
 * (the `follow_ups` field) and packages with a revert. No verdict word
 * (Z1a, E5a).
 */
export function ledger(root, { git = null } = {}) {
  const { jobs, unassigned, git: gitRan } = extractJobs(root, { git });
  const blank = () => ({
    jobs: 0, confirmed: 0, rework: 0, unknown: 0, followUpsSum: 0, packagesReverted: new Set(),
  });
  const count = (g, j) => {
    g.jobs += 1;
    if (j.stage === STAGE.CONFIRMED) g.confirmed += 1;
    else if (j.stage === STAGE.REWORK) g.rework += 1;
    else g.unknown += 1;
    if (typeof j.followUps === 'number') g.followUpsSum += j.followUps;
  };
  const share = (g) => ({
    unknown: g.unknown, of: g.jobs,
    share: g.jobs > 0 ? g.unknown / g.jobs : null,
  });
  const groups = new Map();
  const total = blank();
  for (const j of jobs) {
    const key = `${j.agent_kind}\u0000${j.model}`;
    if (!groups.has(key)) groups.set(key, { agent_kind: j.agent_kind, model: j.model, ...blank() });
    const g = groups.get(key);
    count(g, j);
    count(total, j);
    if (j.reverted) g.packagesReverted.add(j.package);
  }

  const rows = [...groups.values()].map((g) => ({
    agent_kind: g.agent_kind,
    model: g.model,
    jobs: g.jobs,
    confirmed: g.confirmed,
    rework: g.rework,
    unknown: g.unknown,
    unknownShare: share(g),
    followUpsSum: g.followUpsSum,
    packagesReverted: g.packagesReverted.size,
  })).sort((x, y) => y.jobs - x.jobs
    || x.agent_kind.localeCompare(y.agent_kind) || x.model.localeCompare(y.model));

  return {
    rows,
    unassigned,
    totalJobs: total.jobs,
    confirmed: total.confirmed,
    rework: total.rework,
    unknown: total.unknown,
    // With no attributed job the share is not 0/0 but null (not
    // measurable is not zero).
    unknownShare: share(total),
    git: gitRan,
  };
}

/** The share of "unknown" as text, with its denominator — never '0/0'. */
export function unknownShareText(s) {
  if (!s || s.of === 0) return 'unknown (no job attributed in the journal)';
  return `${s.unknown} of ${s.of} (${(s.share * 100).toFixed(1)} %)`;
}

/** Text report — a table, never a prose claim, no verdict word. */
export function reportText(result) {
  const head = [
    'Agent ledger by job (journal: tag "job").',
    `${result.totalJobs} job(s) attributed, ${result.unassigned} unassigned (no package recognisable).`,
    result.git ? '' : 'git could not run — follow-up/revert signals from commits are missing.',
    'Stages: confirmed = positive evidence and no counter-evidence; rework = rework or error evidenced;',
    'unknown = no signal (never success).',
  ].filter((l) => l !== '');
  if (!result.rows.length) {
    return [...head, '', '(no jobs recorded)'].join('\n');
  }
  const body = [
    '',
    'Agent kind      Model             Jobs  Confirmed  Rework  Unknown (share of jobs)           Follow-ups  Reverted',
    ...result.rows.map((r) => `${r.agent_kind.padEnd(15)} ${r.model.padEnd(17)} ${String(r.jobs).padStart(4)}  `
      + `${String(r.confirmed).padStart(9)}  ${String(r.rework).padStart(6)}  `
      + `${unknownShareText(r.unknownShare).padEnd(32)}  `
      + `${String(r.followUpsSum).padStart(10)}  ${String(r.packagesReverted).padStart(8)}`),
    '',
    `Total: ${result.confirmed} confirmed, ${result.rework} rework evidenced, ${result.unknown} unknown — `
      + `share unknown: ${unknownShareText(result.unknownShare)}.`,
  ];
  return [...head, ...body].join('\n');
}

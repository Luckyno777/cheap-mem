/**
 * doctor — is this memory healthy?
 *
 * **Every check measures an EFFECT, never a setting.** That rule was
 * learned the expensive way, three times in one deployment:
 *
 *   - The digest wrapper trusted the model call's exit code. A session
 *     that failed on permissions explains itself and exits 0. It
 *     reported "done" and had done nothing.
 *   - This file's git-hook check read `core.hooksPath` and said "ok"
 *     while the hook could not execute at all (a noexec mount). A
 *     planted test token was committed straight through.
 *   - A size cap read an env var that was passed as an argument, so it
 *     was undefined, so every file counted as zero bytes, so the cap
 *     never applied.
 *
 * All three looked healthy from the outside. So: run the hook, count
 * the captures, build the index. If a check cannot measure, it says
 * UNKNOWN — it does not guess.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import * as memory from './memory.mjs';
import * as integrity from './integrity.mjs';
import * as mirror from './findingmirror.mjs';
import * as environment from './environment.mjs';
import * as clock from './clock.mjs';
import * as epoch from './epoch.mjs';
import * as agents from './agents.mjs';
import * as inbox from './inbox.mjs';
import * as raw from './raw.mjs';
import * as archive from './archive.mjs';
import * as search from './search.mjs';
import * as redaction from './redaction.mjs';
import * as cfgmod from './config.mjs';
import * as thesaurus from './thesaurus.mjs';
import { pack } from './language.mjs';

export const LEVEL = Object.freeze({
  GOOD: 'good',
  WARN: 'warn',
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

/**
 * A finding. `advice` is mandatory for anything that is not good — a
 * complaint without a next step just makes people feel bad.
 */
function finding(name, level, text, advice = null) {
  if (level !== LEVEL.GOOD && !advice && level !== LEVEL.UNKNOWN) {
    // Caught by a test rather than thrown at runtime: a doctor that
    // crashes is worse than one that nags.
    return { name, level, text, advice: '(no advice — that is a bug in doctor.mjs)' };
  }
  return { name, level, text, advice };
}

function quietRun(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

/**
 * Where does the sibling house's clone live — if it sits beside us at all?
 *
 * Returns the root path or `null`. `null` means "not here", not "does
 * not exist": the cross-house check then stays quiet instead of raising
 * a warning that would fire without cause on every CI machine. A
 * warning that keeps coming for no reason teaches people to skip the
 * output.
 *
 * No configuration: a path you have to enter is a path nobody enters.
 */
export function siblingClone(root, given = null) {
  const places = given ? [given] : [
    path.join(path.dirname(root), 'lucky-mem'),
    '/home/user/lucky-mem',
    '/work/lucky-mem',
  ];
  return places.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

/**
 * Do both houses know the same doctor findings — and where they do not,
 * does anybody know about it?
 *
 * **Why this is a finding and not a test.** A test runs in ONE repo, and
 * in CI the other one is not sitting next to it. The doctor runs where
 * both clones are and stays quiet everywhere else.
 *
 * **Why this finding exists at all.** Because a tool nobody calls IS the
 * error class it is meant to find. On 2026-09-18 it turned out that
 * `bench/invariants.mjs` ran in NO pipeline: it reported an orphaned
 * marker perfectly correctly with exit code 1, and nobody was listening
 * — under the headline "Covered 16 of 16". `bench/finding-mirror.mjs`
 * would have been born with the same fate on the same day.
 *
 * Only the UNJUDGED remainder is reported: a finding one of the houses
 * has gained or lost that nobody has looked at. What is in
 * `shared/finding-map.jsonl` — mapped or explained as one-sided — is
 * settled and stays quiet.
 */
export function checkFindingParity(root, { sibling = null } = {}) {
  const here = mirror.readHouse(root);
  if (here.missing || here.empty) {
    return finding('finding-parity', LEVEL.UNKNOWN,
      'our own doctor source yields no finding names — did the call name change?',
      "bench/finding-mirror.mjs, SOURCES: the call name 'finding(' must match the source.");
  }
  const clone = sibling ?? siblingClone(root);
  if (!clone) {
    return finding('finding-parity', LEVEL.UNKNOWN,
      `${here.names.size} findings here; no sibling clone beside us, nothing to compare`);
  }
  const there = mirror.readHouse(clone);
  if (there.missing || there.empty) {
    return finding('finding-parity', LEVEL.UNKNOWN,
      `${clone} yields no finding names — no comparison possible`);
  }
  const map = mirror.readMap(root);
  const g = mirror.compare(here, there, map);
  const gaps = [...g.explainedHere, ...g.explainedThere].filter((e) => e.gap).length;
  const core = `${g.both.length} findings in both houses`
    + `${gaps ? `, ${gaps} known gap(s)` : ''}`;

  const agree = mirror.mapsAgree(root, clone);
  const open = [
    ...g.onlyHere.map((n) => `only here: ${n}`),
    ...g.onlyThere.map((n) => `only there: ${n}`),
    ...g.stale.map((x) => `mapping '${x.id}' points into the void (${x.field}: ${x.name})`),
    ...g.incomplete.map((x) => `mapping '${x.id}' incomplete`),
    ...g.ambiguous.map((x) => `mapping ambiguous: ${x.field} '${x.name}'`),
    ...(agree.same === true ? [] : [`the two mapping copies: ${agree.why}`]),
  ];
  if (!open.length) return finding('finding-parity', LEVEL.GOOD, `${core}, all judged`);
  return finding('finding-parity', LEVEL.WARN,
    `${core}; ${open.length} unjudged: ${open.slice(0, 6).join('; ')}`
    + `${open.length > 6 ? ` ... and ${open.length - 6} more` : ''}`,
    'Add to shared/finding-map.jsonl: either as a pair '
    + '{"befund":..., "finding":...} or as reasoned one-sided '
    + '{"nur":"befund"|"finding", "warum":...}. What is missing is allowed '
    + 'to be missing — but somebody has to have looked at it once.');
}

/**
 * Findings allowed to report `ok` over a count of zero — with the reason.
 *
 * **Why this lives in the product and not in a test.** Three places ask
 * the same question: the guarantee in `test/no-empty-green.test.mjs`,
 * the `doctor.ok-on-empty` record in the atlas, and anyone reading a
 * doctor run. Before 2026-09-20 each answered it for itself, and the
 * atlas answered it with a word list — `/(0|no|nothing|empty)/` over the
 * finding's text — which flags `corpus-size` ("0 entries, under the
 * 50000-entry sharding line") as a check that measured nothing. It
 * measured; the answer was zero.
 *
 * The rule, stated once: **a finding may report `ok` only if it can say
 * what it INSPECTED.** A zero in the text is not the test — an honest
 * zero over something that was looked at is a measurement.
 *
 * Every name here needs a reason, and `test/no-empty-green.test.mjs`
 * refuses a reason that names a category instead of making an argument.
 * A list without arguments is how a guarantee quietly stops
 * guaranteeing.
 */
export const OK_OVER_ZERO = Object.freeze({
  'archive-backlog': 'inspected the folder and found it empty, which answers "is anything '
    + 'piling up"; and if captures stop arriving, `capture` warns — a finding that stays '
    + 'quiet because a neighbour speaks hides nothing',
  drawers: 'inspected every known drawer file and reports how many lines each holds, '
    + 'which is a measurement whose answer happens to be zero',
  integrity: 'read every line of every log and found none broken — zero broken lines out '
    + 'of zero lines is the honest result of a scan that ran',
  'corpus-size': 'compared the entry count against the sharding line; the count is an '
    + 'input to that comparison, and the comparison was made',
  'append-only-git': 'compared each log against what git already holds, which is a real '
    + 'comparison over the skeleton `mem init` writes',
  root: 'checked that the directory exists, which is the whole of its question',
});

export function checkAll(root) {
  const f = [];
  f.push(checkRoot(root));
  f.push(checkConfig(root));
  f.push(checkRedaction());
  f.push(checkGitHook(root));
  f.push(...checkDrawers(root));
  f.push(checkOrphanDrawers(root));
  f.push(checkCaptures(root));
  f.push(checkArchiveBacklog(root));
  f.push(checkDigest(root));
  f.push(checkDigestYield(root));
  f.push(checkFactConflicts(root));
  f.push(checkOrphans(root));
  f.push(checkTopicQuality(root));
  f.push(checkDelivery(root));
  f.push(checkIndex(root));
  f.push(checkSynonyms(root));
  f.push(checkStopHook(root));
  f.push(checkLegacyLeaks(root));
  f.push(checkBehind(root));
  f.push(checkGitState(root));
  f.push(checkIntegrity(root));
  f.push(checkEntryForm(root));
  f.push(checkGitignoreEffective(root));
  f.push(checkRollback(root));
  f.push(...checkEnvironmentContract(root));
  f.push(checkCorpusSize(root));
  f.push(checkAppendOnlyGit(root));
  f.push(checkFindingParity(root));

  // UNKNOWN ranks BELOW good. Some checks are permanently unmeasurable
  // where they run — a timer on the host is invisible from inside a
  // container. If that decided the verdict, a perfectly healthy memory
  // would report "unknown" forever, and people would learn to ignore
  // the output. Only warnings and errors lower the grade.
  const rank = { error: 3, warn: 2, good: 1, unknown: 0 };
  const worst = f.reduce((max, x) => (rank[x.level] > rank[max] ? x.level : max), LEVEL.GOOD);

  const count = { good: 0, warn: 0, error: 0, unknown: 0 };
  for (const x of f) count[x.level] += 1;
  return { findings: f, worst, summary: count };
}

// Digest yield: makes the silent loss measurable. The digest (lane 2)
// is the net under discipline — when I forget to log, IT should pull the
// decision/error out of the raw material. An unmeasured net is as good
// as none. So count: how many digested captures produced NO entry (no
// entry's origin.raw points at them)? A high ratio is the signal that
// the digest is dropping content.
function checkDigestYield(root) {
  const ratioThreshold = 0.4;
  let captures = [];
  try { captures = raw.listCaptures(root); } catch { /* no raw/ */ }
  // Without any record, which captures are digested is unknowable — same
  // boundary as checkDigest, and it narrows the same way: the ledger is
  // tracked, so where it exists the state is readable from any clone and
  // the yield is computable. Otherwise the ledger would have answered one
  // finding and left the one beside it at `?`, over the same data. With no
  // raw material at all there is provably nothing to measure (GOOD, below).
  const watermarkHere = fs.existsSync(path.join(root, raw.WATERMARK_FILE));
  const ledgerHere = fs.existsSync(path.join(root, raw.LEDGER_FILE));
  if (captures.length > 0 && !watermarkHere && !ledgerHere) {
    return finding('digest-yield', LEVEL.UNKNOWN,
      'no digest record in this clone — which captures are digested is not known from here',
      'Measure on the machine that digests, or digest once and commit there: '
      + `${raw.LEDGER_FILE} travels, ${raw.WATERMARK_FILE} is gitignored.`);
  }
  let open = new Set();
  try { open = new Set(raw.pending(root).open); } catch { /* no watermark */ }
  const digested = captures.filter((f) => !open.has(f));
  // Denominator: digested captures. Zero digested is not zero gaps — it
  // is nothing to divide by. `nothing to measure` was already honest
  // about that; it just used to report it as a pass. leer-ist-kein-bestehen.
  if (digested.length === 0) {
    return finding('digest-yield', LEVEL.UNKNOWN, 'nothing digested yet — nothing to measure');
  }
  const referenced = new Set();
  let withOrigin = 0;
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      const { entries } = memory.readLog(root, type, { project });
      for (const e of entries) {
        const src = e && e.origin && e.origin.raw;
        if (src) { withOrigin += 1; referenced.add(src); }
      }
    }
  }
  const gaps = digested.filter((f) => !referenced.has(f));
  const ratio = gaps.length / digested.length;
  const core = `digest yield: ${withOrigin} entries from ${digested.length} digested `
    + `captures; ${gaps.length} produced nothing (${Math.round(ratio * 100)}%).`;
  if (digested.length >= 3 && ratio > ratioThreshold) {
    return finding('digest-yield', LEVEL.WARN, core,
      'Many digested captures produced no entry — the digest may be dropping '
      + `content (or it was just tool noise). Spot-check: ${gaps.slice(0, 2).join(', ')}`);
  }
  return finding('digest-yield', LEVEL.GOOD, core);
}

// Fact conflicts: two versions of the same living fact carry the SAME
// valid_from but disagree on the value. That is not a normal update (a new
// date superseding an old one) — it is a contradiction the memory cannot
// resolve on its own, and everyday recall would surface one or the other
// at random. Deterministic; reuses the freshness resolver.
export function checkFactConflicts(root) {
  let facts = [];
  try { facts = memory.currentFacts(root); }
  catch { return finding('fact-conflicts', LEVEL.UNKNOWN, 'could not resolve timeline facts'); }
  // Denominator: tracked facts. With none, "no conflicts" is not a clean
  // bill of health — there was nothing to disagree about.
  // The house rule, in the original: "nicht messbar ist nicht null".
  if (facts.length === 0) {
    return finding('fact-conflicts', LEVEL.UNKNOWN, 'no timeline facts recorded — nothing to check for conflicts');
  }
  const clashes = facts.filter((f) => f.conflict);
  if (clashes.length === 0) {
    return finding('fact-conflicts', LEVEL.GOOD, `${facts.length} tracked facts, no conflicts`);
  }
  const keys = clashes.map((f) => f.key).slice(0, 5).join(', ');
  return finding('fact-conflicts', LEVEL.WARN,
    `${clashes.length} fact${clashes.length === 1 ? '' : 's'} have two versions with the same date but different values: ${keys}`,
    'Resolve each with a newer `mem log timeline --key <k> --value <correct> --valid_from <later date>`, '
    + 'or retire the wrong version with `mem discard <id>`.');
}

// Topic quality: does `topic` carry a thread, or duplicate the title?
//
// Measured on 2026-09-05 against a real 553-entry memory: 69 entries with
// a topic produced 69 distinct topics — a ratio of exactly 1.00. A topic
// with exactly one entry is not a topic, it is a second title field; the
// thread it is meant to carry (a decision, later the error against it,
// later the lesson) only exists once a LATER entry reuses it.
//
// The cause was a missing rule, not a model failure: the digest spec
// listed `topic` as required without ever saying what a topic is. The
// rule is in the spec now; this check measures whether it works.
// Deterministic.
export function checkTopicQuality(root) {
  let q;
  try { q = memory.topicQuality(root); }
  catch { return finding('topic-quality', LEVEL.UNKNOWN, 'topics unreadable'); }
  // Denominator: topics assigned at all. Zero topics means the ratio
  // below has nothing to divide by — the text already said so
  // honestly, it only used to grade that as a pass.
  if (q.topics === 0) {
    return finding('topic-quality', LEVEL.UNKNOWN, 'no topics assigned yet');
  }
  const parts = [`${q.topics} topics across ${q.areas} areas`,
    `${q.entriesPerTopic} entries per topic`];
  if (q.malformed) parts.push(`${q.malformed} malformed`);
  // Below 1.2 essentially no topic carries more than one entry. The
  // threshold sits deliberately just above 1.0: a few real threads lift
  // it, a single outlier does not.
  if (q.entriesPerTopic >= 1.2 && q.malformed === 0) {
    return finding('topic-quality', LEVEL.GOOD, parts.join(', '));
  }
  return finding('topic-quality', LEVEL.WARN, parts.join(', '),
    `${q.singleTopics} of ${q.topics} topics have exactly one entry`
    + `${q.orphanAreas ? `, ${q.orphanAreas} areas have a single child` : ''}. `
    + 'The digest should reuse existing topics instead of inventing new ones: '
    + 'run `mem topics --names-only` before a pass, rule in the digest spec.');
}

// Delivery: is there mail for a recipient nobody reads?
//
// The inbox can address a specific recipient, and at multi-agent scale
// that is exactly where things vanish quietly: a recipient who was valid
// once and is not any more, and the message sits in the drawer forever
// with no exception and no log. Nobody ever collects it.
//
// A recipient counts as known if it is registered under agents/ or has
// written something itself (then it exists, folder or not).
// Deterministic.
export function checkDelivery(root) {
  let messages = [];
  let broken = [];
  try {
    const drawer = inbox.read(root, {});
    messages = drawer.messages ?? [];
    broken = drawer.broken ?? [];
  } catch (e) {
    // Still reachable: the DIRECTORY itself can be unreadable
    // (permissions, a dangling symlink). That is genuinely "we cannot
    // tell", so it stays UNKNOWN — but it now says why instead of
    // shrugging.
    return finding('delivery', LEVEL.UNKNOWN, `drawer unreadable: ${e.message}`);
  }

  // **An unreadable message is the most expensive kind of undelivered
  // mail (2026-09-19).** It is not merely sitting there, it cannot be
  // read at all — and until today nobody counted it. `inbox.read` threw
  // for the whole drawer, this catch turned that into one blanket
  // UNKNOWN, and a Windows user's two intact messages were reported as
  // 'drawer unreadable' while the channel to ChatGPT went quiet.
  //
  // ERROR, not UNKNOWN: UNKNOWN says "not measured". This IS measured —
  // we know exactly which files and why. A silent drawer must not look
  // like an empty one.
  //
  // It stays inside `delivery` and does not become its own finding: it
  // is the same question ("does mail get through?"), only the worse
  // answer, and both houses have to keep the same finding set (lucky-mem
  // put its half inside the existing `post-liegt` for the same reason).
  // It comes BEFORE every other branch, because a report about
  // unread recipients is worthless while the drawer swallows messages.
  if (broken.length) {
    return finding('delivery', LEVEL.ERROR,
      `${broken.length} message${broken.length === 1 ? '' : 's'} in the drawer `
      + `${broken.length === 1 ? 'is' : 'are'} unreadable: `
      + broken.map((b) => `${b.name} (${b.reason})`).join('; '),
      'They count in no other number here — whoever does not look at them takes '
      + 'a silent drawer for an empty one. Open them by hand; the commonest cause '
      + 'is a header with no blank line after it.');
  }

  // Denominator: messages ever placed in the drawer. None means
  // delivery was never exercised here, not that it is confirmed working.
  if (!messages.length) {
    return finding('delivery', LEVEL.UNKNOWN, 'no messages in the drawer — delivery is unexercised, not confirmed');
  }

  const registered = new Set(agents.listAgents(root).map((a) => a.name));
  const senders = new Set(messages.map((m) => m.from).filter(Boolean));
  // 'done' and 'answered' stood here and are not states of this
  // module at all — the filter matched every message, so all four
  // states were reported as open. It has never excluded anything
  // since it was written.
  const open = messages.filter((m) => !inbox.isDone(m.state));

  const unknown = new Map();
  for (const m of open) {
    const to = m.to;
    if (!to || registered.has(to) || senders.has(to)) continue;
    unknown.set(to, (unknown.get(to) ?? 0) + 1);
  }
  if (!unknown.size) {
    return finding('delivery', LEVEL.GOOD,
      `${messages.length} messages, ${open.length} open, every recipient known`);
  }
  const list = [...unknown.entries()].map(([a, n]) => `${a} (${n})`).join(', ');
  return finding('delivery', LEVEL.WARN,
    `mail for ${unknown.size} unknown recipients: ${list}`,
    'Nobody collects these. Register the recipient (`mem agent new <name>`) '
    + 'or fix the name in the message.');
}

// Orphans: a correction or a duty-closing line that points at an id which
// does not exist in the corpus. The pointer resolves to nothing, so the
// supersede/close silently never takes effect. Deterministic.
export function checkOrphans(root) {
  const ids = new Set();
  const pointers = []; // { field, to }
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let entries;
      try { ({ entries } = memory.readLog(root, type, { project })); } catch { continue; }
      for (const e of entries) {
        if (e.__broken || !e.id) continue;
        ids.add(e.id);
        if (e.replaces_id) pointers.push({ field: 'replaces_id', to: e.replaces_id });
        if (e.closes_id) pointers.push({ field: 'closes_id', to: e.closes_id });
        // A link is two pointers. An edge into nothing is exactly the same
        // defect as an orphaned correction: it resolves to no entry, so it
        // silently does nothing — and a graph is only worth walking if its
        // edges are known to land.
        if (type === 'link') {
          const from = e.from ?? e.source ?? null;
          const to = e.to ?? e.target ?? null;
          if (from) pointers.push({ field: 'link.from', to: from });
          if (to) pointers.push({ field: 'link.to', to: to });
        }
      }
    }
  }
  // Denominator: correction/close/link pointers. None means there is
  // nothing here that COULD dangle — "all resolve" over zero edges is
  // not the same claim as "all resolve" over a real graph.
  if (pointers.length === 0) {
    return finding('orphans', LEVEL.UNKNOWN,
      'no correction, close or link pointers exist yet — nothing to check for orphans');
  }
  const orphans = pointers.filter((p) => !ids.has(p.to));
  if (orphans.length === 0) {
    return finding('orphans', LEVEL.GOOD, `${pointers.length} correction/close links, all resolve`);
  }
  const sample = orphans.slice(0, 3).map((o) => `${o.field}->${o.to}`).join(', ');
  const one = orphans.length === 1;
  return finding('orphans', LEVEL.WARN,
    `${orphans.length} pointer${one ? '' : 's'} (correction, close or link edge) `
    + `${one ? 'points' : 'point'} at a missing id: ${sample}`,
    'The target was never written or the id is mistyped, so the supersede/close does not take effect. '
    + 'Check the id, or write the correction against the real entry.');
}

function checkRoot(root) {
  if (!fs.existsSync(root)) {
    return finding('root', LEVEL.ERROR, `${root} does not exist`,
      'Point --root at a memory, or run `mem init` there.');
  }
  return finding('root', LEVEL.GOOD, root);
}

function checkConfig(root) {
  try {
    const cfg = cfgmod.readConfig(root);
    const who = Object.keys(cfg.participants ?? {}).length;
    return finding('config', LEVEL.GOOD,
      `${who} participants, language ${cfg.language ?? 'en'}, branch ${cfg.defaultBranch}`);
  } catch (e) {
    return finding('config', LEVEL.ERROR, e.message, 'Run `mem init` in the memory root.');
  }
}

function checkRedaction() {
  const t = redaction.selfTest();
  if (t.ok) return finding('redaction', LEVEL.GOOD, `intact, ${t.checked} canaries`);
  return finding('redaction', LEVEL.ERROR,
    `FAILING: ${t.failed.map((a) => `${a.type}:${a.reason}`).join(', ')}`,
    'Capture refuses to run while this is broken — on purpose. '
    + 'A gap in the memory beats a secret in the version history.');
}

/**
 * The git hook, checked by STARTING it.
 *
 * Reading `core.hooksPath` proves nothing. On a mount with `noexec`
 * the file is 0755, the config is right, and git still cannot run it —
 * it prints "hook was ignored because it's not set as executable" and
 * commits anyway.
 */
function checkGitHook(root) {
  const set = quietRun('git', ['-C', root, 'config', '--get', 'core.hooksPath']);
  if (!set || !set.trim()) {
    return finding('git-hook', LEVEL.WARN, 'core.hooksPath is not set',
      'mem hooks install — it also proves the hook actually fires.');
  }

  // Start the hook git would start, not the file in the repo. On a
  // noexec mount those are two different things.
  const p = set.trim();
  const hookPath = path.isAbsolute(p) ? path.join(p, 'pre-commit') : path.join(root, p, 'pre-commit');
  if (!fs.existsSync(hookPath)) {
    return finding('git-hook', LEVEL.ERROR, `core.hooksPath=${p}, but ${hookPath} is missing`,
      'mem hooks install');
  }
  // On Windows git runs hooks through its bundled bash, so that is
  // what has to be probed; starting the file itself would always fail
  // and report a broken hook that works perfectly.
  let attempt;
  try {
    attempt = process.platform === 'win32'
      ? spawnSync('bash', [hookPath], { encoding: 'utf8', timeout: 10000 })
      : spawnSync(hookPath, [], { encoding: 'utf8', timeout: 10000 });
  } catch (e) { attempt = { error: e }; }
  if (attempt.error) {
    const reason = attempt.error.code === 'EACCES'
      ? 'execve refused (noexec mount? container volume?)'
      : `could not start: ${attempt.error.message}`;
    return finding('git-hook', LEVEL.ERROR,
      `core.hooksPath=${p}, but the hook does not run — ${reason}`,
      'mem hooks install — it detects this and puts the hook somewhere '
      + 'executable, then proves the result with a decoy secret.');
  }
  return finding('git-hook', LEVEL.GOOD, `core.hooksPath=${p}, hook starts (exit ${attempt.status})`);
}

/**
 * How many logs are there, and does every line parse?
 *
 * **Both numbers come from `src/integrity.mjs`, not from here.** Until
 * 2026-09-18 this function walked the drawers itself and counted its
 * own unparsable lines — four hundred lines below `checkIntegrity`,
 * which calls `scanIntegrity` for the very same walk. Two calculations
 * of one question, in one file.
 *
 * Neither was wrong. That is what makes the shape dangerous: they only
 * drift apart later, and then you believe the wrong one. The sister
 * house hit this three times in a single day and built a catalogue
 * against it; `shared/calculations.jsonl` is this house's copy, and
 * `bench/calculations.mjs` is the latch.
 *
 * The rebuilt version is also strictly better advice: `scanIntegrity`
 * knows the FILE and LINE of every broken entry, so this finding can
 * name the first one instead of handing out a grep recipe.
 */
function* checkDrawers(root) {
  let files;
  let scan;
  try {
    files = integrity.logFiles(root);
    scan = integrity.scanIntegrity(root);
  } catch (e) {
    // Not measurable is not zero drawers, and not health.
    yield finding('drawers', LEVEL.UNKNOWN, `logs unreadable: ${e.message}`);
    return;
  }

  if (files.length === 0) {
    yield finding('drawers', LEVEL.WARN, 'no log files yet',
      'Fine for a fresh memory. Otherwise check that `mem log` writes where you expect.');
    return;
  }
  if (scan.broken.length > 0) {
    const first = scan.broken[0];
    const where = first.line ? `${first.file}:${first.line}` : first.file;
    yield finding('drawers', LEVEL.ERROR,
      `${scan.broken.length} unparsable lines in ${files.length} files, first at ${where} (${first.why})`,
      'A JSONL line that is not JSON was hand-edited or half-written. '
      + 'The answer to a broken line in an append-only log is a new line, never a repair.');
    return;
  }
  yield finding('drawers', LEVEL.GOOD, `${files.length} files, ${scan.lines} lines`);
}

/**
 * `.jsonl` files under `global/` or `projects/<name>/` that no reading
 * path in this system will ever open, because their NAME is not one of
 * `memory.TYPES`'s files — see `integrity.orphanJsonlFiles`.
 *
 * **A separate finding, not folded into `drawers` (decided 2026-09-19).**
 * `drawers` answers one question — "of the logs this system KNOWS about,
 * does every line parse" — and that question is sourced from
 * `integrity.logFiles`, which is itself built by iterating
 * `memory.TYPES`. Folding this check in there would mean computing it
 * from the very iteration that cannot see the problem, which is the bug
 * repeating one layer up. This finding reads the directory instead, so
 * it can report on a file none of `drawers`, `mem find` or the index
 * will ever touch.
 *
 * ERROR, not WARN: this is not a style nit like topic quality — it is
 * entries that exist on disk and answer no search, no `mem find`, no
 * doctor count, ever, until the name is fixed. `mem doctor` reporting
 * "healthy" over exactly that is the failure this whole assignment
 * measures.
 */
function checkOrphanDrawers(root) {
  let orphans;
  try { orphans = integrity.orphanJsonlFiles(root); }
  catch (e) { return finding('orphan-drawers', LEVEL.UNKNOWN, `could not scan global/ or projects/: ${e.message}`); }
  if (orphans.length === 0) {
    // Denominator: entries actually written. `mem init` pre-creates the
    // known .jsonl files empty, so counting FILES would call a fresh,
    // untouched memory "scanned" — the stub files exist, nothing is in
    // them. The real question this finding answers ("did anything get
    // filed under a name nothing reads") only has an answer once
    // something has been filed at all.
    let entries = 0;
    try { ({ entries } = integrity.scanIntegrity(root)); } catch { /* fall through to unknown below */ }
    if (entries === 0) {
      return finding('orphan-drawers', LEVEL.UNKNOWN,
        'no entries in any log yet — nothing has been filed anywhere to check for orphans');
    }
    return finding('orphan-drawers', LEVEL.GOOD, 'no .jsonl files outside the known types');
  }
  const names = orphans.map((o) => o.rel).slice(0, 5).join(', ')
    + (orphans.length > 5 ? ' ...' : '');
  return finding('orphan-drawers', LEVEL.ERROR,
    `${orphans.length} .jsonl file${orphans.length === 1 ? '' : 's'} in global/ or projects/ `
    + `match${orphans.length === 1 ? 'es' : ''} no known type, and are read by nothing: ${names}`,
    `Rename to one of ${Object.keys(memory.TYPES).map((t) => memory.TYPES[t]).join(', ')} if that is what `
    + 'it should have been, or move it out of global//projects/<name> if it is not a log at all. '
    + '`mem find`, the search index and this doctor all iterate the type map, so nothing short of the '
    + 'right filename makes these entries findable.');
}

function checkCaptures(root) {
  const list = raw.listCaptures(root);
  if (list.length === 0) {
    return finding('capture', LEVEL.WARN, 'no captures at all',
      'Is the Stop hook wired up? See the "stop-hook" finding below.');
  }
  let bytes = 0;
  for (const c of list) {
    try { bytes += fs.statSync(path.join(root, c)).size; } catch { /* gone */ }
  }
  // Did the redaction actually catch anything lately? A capture run
  // with a dead redaction looks exactly like a clean one.
  let withRedactions = 0;
  const recent = list.slice(-5);
  for (const c of recent) {
    try {
      const { header } = raw.readCapture(root, c);
      if ((header?.__redacted ?? []).length > 0) withRedactions += 1;
    } catch { /* a broken capture is reported elsewhere */ }
  }
  return finding('capture', LEVEL.GOOD,
    `${list.length} captures, ${Math.round(bytes / 1024)} KB, `
    + `${withRedactions} of the last ${recent.length} carry redactions`);
}

function checkDigest(root) {
  // Without the watermark, this check cannot judge the digest state — and
  // the watermark (.mem/, gitignored) does not travel with the repo. Every
  // checked-in capture then looks pending. A clone that captures locally
  // even writes its own bell, so "bell present" cannot separate a real
  // backlog from git-imported captures: that exact confusion once made a
  // cloud session report "87 pending, 19.8 MB, 41 h" while the digesting
  // machine was healthy with 3 truly-open captures. So: no watermark ->
  // `?`, never a fabricated count. With no raw material at all there is
  // provably nothing pending (handled after the guard).
  // The ledger is tracked, so when it exists the digest state IS knowable
  // from any clone — that is the whole point of it, and the `?` below
  // narrows to the case where neither record is present.
  const ledgerHere = fs.existsSync(path.join(root, raw.LEDGER_FILE));
  const watermarkHere = fs.existsSync(path.join(root, raw.WATERMARK_FILE));
  if (!watermarkHere && !ledgerHere) {
    let count = 0;
    try { count = raw.listCaptures(root).length; } catch { /* no raw/ */ }
    // Denominator: captures that exist to be pending. Zero captures is
    // not the same fact as "checked, none pending" — no digest ever ran
    // here, because there was nothing to run it against.
    if (count === 0) {
      return finding('digest', LEVEL.UNKNOWN,
        'no captures exist in this clone — there is nothing to measure a digest backlog against');
    }
    const bell = raw.bellState(root);
    return finding('digest', LEVEL.UNKNOWN,
      bell
        ? `no watermark in this clone — it captures here (bell is set), but which of the ${count} `
          + 'checked-in captures are already digested is not judgeable from here'
        : `no digest state on this machine — the ${count} captures came in via git, nothing is `
          + 'captured or digested here',
      'Neither ' + raw.LEDGER_FILE + ' (tracked) nor ' + raw.WATERMARK_FILE
      + ' (gitignored, .mem/) is here. The ledger travels with the repo, so once the '
      + 'digest has run once and committed, this question is answerable from any clone. '
      + 'Until then the watermark does not travel with '
      + 'the repo. Without it every checked-in capture looks pending, even long-digested ones — '
      + 'neither the count nor the age of a backlog can be derived. Measure on the digesting '
      + 'machine: mem raw due.');
  }
  const st = raw.pending(root);
  if (st.open.length === 0) {
    return finding('digest', LEVEL.GOOD,
      st.last ? `nothing pending, last run ${st.last}` : 'nothing pending');
  }
  const d = raw.due(root);
  const kb = Math.round(st.bytes / 1024);
  // Since 2026-09-06 a backlog is no longer only untidy — it is material
  // the agent CANNOT SEE. The gateway treats raw captures as a reserve
  // lane: they fill only what the curated entries leave empty, and five
  // curated entries matching the question are enough to leave nothing.
  // So an undigested capture is, for retrieval purposes, not in the
  // memory at all. That belongs in the advice, or the check reports a
  // hygiene problem while the real one is a gap in what can be recalled.
  const invisibleNote = 'Until the digest runs, these captures are effectively invisible to '
    + 'retrieval: the gateway fills the answer from curated entries first and only falls '
    + 'back to captures for the slots they leave — five matching entries are enough to '
    + 'leave none. `mem find --only-raw` still reads them directly.';
  if (d.due) {
    return finding('digest', LEVEL.WARN,
      `${st.open.length} pending (${kb} KB), due since ${d.reason}`,
      'The timer should pick this up within minutes. If it does not, '
      + 'check that the digest job is installed and running. ' + invisibleNote);
  }
  return finding('digest', LEVEL.GOOD,
    `${st.open.length} pending (${kb} KB), not due yet (${d.reason})`,
    invisibleNote);
}


/**
 * Do the curated synonyms engage for THIS memory?
 *
 * `THESAURUS` in thesaurus.mjs is English — 39 groups, 188 words.
 * Measured on 2026-09-06: a German-language memory gets zero synonyms
 * from it (0 hits from 198 query terms over 21 questions; English gets
 * 53 of 44). Retrieval still runs, only one of its three expansion
 * layers is mute — and nothing says so.
 *
 * Exactly the kind of gap this project otherwise campaigns against:
 * invisible when present, silent when absent. So it is measured.
 *
 * Counted over the memory's own most frequent vocabulary, not over
 * queries — the doctor has none, and the entries say the same thing.
 */
function checkSynonyms(root) {
  let cfg; try { cfg = cfgmod.readConfig(root); } catch { cfg = { language: 'en' }; }
  let idx;
  try { idx = search.loadIndex(root, { language: cfg.language }); }
  catch { return finding('synonyms', LEVEL.UNKNOWN, 'index not readable'); }
  const docs = idx.documents ?? [];
  if (docs.length < 5) return finding('synonyms', LEVEL.UNKNOWN, 'too few entries to judge');

  // Haeufigste Inhaltswoerter der Memory.
  const df = new Map();
  for (const d of docs) {
    const text = JSON.stringify(d.entry ?? d).toLowerCase();
    for (const w of new Set(text.match(/[a-z][a-z0-9]{3,}/g) ?? [])) df.set(w, (df.get(w) ?? 0) + 1);
  }
  const top = [...df.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([w]) => w);
  const cov = thesaurus.curatedCoverage(top, pack(cfg.language ?? 'en'));
  const eigene = thesaurus.loadUserGroups(root, fs, path).loaded ?? 0;
  const pct = cov.fraction === null ? 0 : Math.round(cov.fraction * 100);

  if (cov.covered === 0 && eigene === 0) {
    return finding('synonyms', LEVEL.WARN,
      `the curated synonyms match NONE of this memory's 60 commonest words (language ${cfg.language ?? 'en'})`,
      'The built-in list is English. Retrieval still works, but one of its '
      + 'three expansion layers is silent here. Add your own groups in '
      + '.mem/thesaurus.json — an array of arrays, e.g. '
      + '[["auslieferung","deploy","ausrollen"]]. No word may appear twice.');
  }
  if (eigene > 0) {
    return finding('synonyms', LEVEL.GOOD,
      `${eigene} own group(s), curated list covers ${pct}% of the commonest words`);
  }
  if (pct < 10) {
    return finding('synonyms', LEVEL.WARN,
      `the curated synonyms cover only ${pct}% of this memory's commonest words`,
      'Mostly an English list against a vocabulary it does not know. '
      + 'Add your own groups in .mem/thesaurus.json.');
  }
  return finding('synonyms', LEVEL.GOOD, `curated list covers ${pct}% of the commonest words`);
}

function checkIndex(root) {
  try {
    const cfg = (() => { try { return cfgmod.readConfig(root); } catch { return { language: 'en' }; } })();
    const t0 = Date.now();
    const idx = search.loadIndex(root, { language: cfg.language });
    const ms = Date.now() - t0;
    if (idx.N === 0) {
      return finding('index', LEVEL.WARN, 'empty index — nothing to search',
        'Normal for a fresh memory. Otherwise check that the drawers are really filled.');
    }
    return finding('index', LEVEL.GOOD,
      `${idx.N} documents, ${idx.docFreq.size} terms, ${idx.tagGraph.size} tags in the graph, `
      + `${ms}ms${idx.fromCache ? ' (cached)' : ' (fresh build)'}`);
  } catch (e) {
    return finding('index', LEVEL.ERROR, e.message, '`mem find --fresh` forces a rebuild.');
  }
}

export function checkStopHook(root) {
  const candidates = [
    // `process.env.HOME ?? ''` stood here until 2026-09-19. On Windows
    // HOME is normally unset, so path.join('', '.claude', 'settings.json')
    // produced the RELATIVE path `.claude\settings.json` — resolved
    // against whatever directory the doctor happened to run in. The
    // check then looked at the wrong file, or at none, and reported
    // "no Stop hook found" for a machine where one was wired up.
    // `os.homedir()` reads $HOME on POSIX and USERPROFILE on Windows.
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.json'),
  ];
  for (const p of candidates) {
    if (!p || !fs.existsSync(p)) continue;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const asText = JSON.stringify(cfg.hooks?.Stop ?? []);
    if (asText.includes('mem-capture')) {
      return finding('stop-hook', LEVEL.GOOD, `mem-capture is wired up (${p})`);
    }
    if (asText.includes('mem-reflect')) {
      return finding('stop-hook', LEVEL.WARN, `still the old reflector (${p})`,
        'Switch to bin/mem-capture — it starts no model.');
    }
  }
  return finding('stop-hook', LEVEL.UNKNOWN,
    'no Stop hook found in the settings files I know about',
    'Without it nothing is captured. See docs/capture.md.');
}

function checkGitState(root) {
  const branch = quietRun('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return finding('git', LEVEL.UNKNOWN, 'not a git clone (or git missing)');
  const dirty = quietRun('git', ['-C', root, 'status', '--porcelain']);
  const lines = dirty ? dirty.split('\n').filter(Boolean) : [];
  if (lines.length === 0) return finding('git', LEVEL.GOOD, `${branch.trim()}, clean`);

  // Uncommitted MEMORY is the visible end of a silent failure. The Stop
  // hook and the digest both commit best-effort and swallow what goes
  // wrong — two sessions sharing a clone collide on git's index lock,
  // one of them writes its capture and never commits it, and the hook
  // still reports success. In an environment that gets reclaimed, that
  // capture is simply gone.
  //
  // This check used to report GOOD no matter how much was uncommitted,
  // which made the one place that could have surfaced the loss stay
  // quiet about it. Content is now a warning; a dirty working copy of
  // the tooling is not.
  const CONTENT = /^..\s+(raw\/|global\/|projects\/|inbox\/|digested\.jsonl|FACTS\.md)/;
  const content = lines.filter((l) => CONTENT.test(l));
  if (content.length === 0) {
    return finding('git', LEVEL.GOOD,
      `${branch.trim()}, ${lines.length} uncommitted (none of them memory)`);
  }
  return finding('git', LEVEL.WARN,
    `${branch.trim()}, ${content.length} uncommitted memory files`,
    'Memory that is not committed does not travel and does not survive a '
    + 'rebuilt container. Commit and push them: git add -A && git commit && git push. '
    + `First: ${content.slice(0, 2).map((l) => l.slice(3)).join(', ')}`);
}

/** Findings as text. `problemsOnly` hides what is fine. */
/**
 * Only what is down RIGHT NOW — for a start banner, not for an
 * examination. Returns an array of lines; empty means nothing is red.
 *
 * **The finding (2026-09-17, on the sibling house's machine.)** A VM
 * reboot wiped three systemd units together with a door secret, because
 * `/etc` on that OS is an overlay backed by `/tmp`. The dashboard, the
 * mail poller and a public server were down for 52 minutes. The doctor
 * HAD the answer the whole time: two findings at level ERROR, both
 * correct. Nobody heard them, because the doctor only runs when someone
 * types it. The gap was never detection.
 *
 * Three decisions, each against being skimmed past:
 *
 * 1. **Level ERROR only.** `--quiet` printed 27 lines that evening,
 *    seven of them WARN. A warning is backlog — it will still be there
 *    tomorrow. An error means something that should be running is not.
 *    Nine lines in a start banner get skimmed; two get read.
 * 2. **No advice lines.** Advice belongs in the examination. Whoever
 *    needs it types `mem doctor` — the alarm only says THAT.
 * 3. **Nothing red means no output at all.** A banner that shows up on
 *    every start becomes background within three days.
 *
 * `limit` caps the lines: if half the machine is down, a list of twenty
 * findings helps nobody — then all that counts is that something broke
 * and where to look.
 */
export function alarm({ findings }, { limit = 6, width = 120 } = {}) {
  const red = (findings ?? []).filter((f) => f?.level === LEVEL.ERROR);
  const short = (t) => {
    const first = String(t ?? '').split('\n')[0];
    return first.length > width ? `${first.slice(0, width - 1)}…` : first;
  };
  const lines = red.slice(0, limit).map((f) => `FAIL  ${f.name}  ${short(f.text)}`);
  if (red.length > limit) {
    lines.push(`…and ${red.length - limit} more — details with: node bin/mem doctor --quiet`);
  }
  return lines;
}

export function report({ findings, worst, summary }, { problemsOnly = false } = {}) {
  const mark = { good: 'ok  ', warn: 'WARN', error: 'FAIL', unknown: '?   ' };
  const lines = [];
  for (const b of findings) {
    if (problemsOnly && b.level === LEVEL.GOOD) continue;
    lines.push(`${mark[b.level]}  ${b.name.padEnd(12)} ${b.text}`);
    if (b.advice) lines.push(`      ${' '.repeat(12)} -> ${b.advice}`);
  }
  lines.push('');
  lines.push(`${summary.good} good, ${summary.warn} warnings, ${summary.error} errors, `
    + `${summary.unknown} unchecked  —  overall: ${worst}`
    + (worst === LEVEL.GOOD && summary.unknown
      ? ` (${summary.unknown} not checkable from here)` : ''));
  return lines.join('\n');
}

/**
 * Do already-captured files contain secrets that TODAY's rules would
 * catch?
 *
 * The redaction only protects what was captured after it. Every gap
 * closed later leaves material behind that was written under weaker
 * rules — and nobody looks again.
 *
 * That is not hypothetical: in the private ancestor, a capture made at
 * 05:52 held three dashboard tokens in URLs; the gap was closed at
 * 06:37, and the values stayed in the repository. It surfaced only
 * because a human grepped by hand.
 *
 * **The finding never names a value.** Only kind and count.
 */
function checkLegacyLeaks(root) {
  let captures;
  try { captures = raw.listCaptures(root); }
  catch { return finding('legacy', LEVEL.UNKNOWN, 'raw material unreadable'); }
  // Denominator: captures to scan. None means the scan never ran, not
  // that it ran clean.
  if (captures.length === 0) return finding('legacy', LEVEL.UNKNOWN, 'no raw material');

  const CAP = 8 * 1024 * 1024;
  let read = 0;
  let truncated = false;
  const hits = new Map();

  for (const rel of captures) {
    if (read >= CAP) { truncated = true; break; }
    let lines;
    try { ({ lines } = raw.readCapture(root, rel)); }
    catch { continue; }
    for (const l of lines) {
      const text = JSON.stringify(l);
      read += text.length;
      if (read >= CAP) { truncated = true; break; }
      for (const f of redaction.redact(text).found) {
        hits.set(f.type, (hits.get(f.type) ?? 0) + f.count);
      }
    }
  }

  const total = [...hits.values()].reduce((a, b) => a + b, 0);
  if (total === 0) {
    return finding('legacy', LEVEL.GOOD,
      `${captures.length} captures checked${truncated ? ' (cap reached)' : ''}, nothing found`);
  }
  const kinds = [...hits].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`).join(', ');
  return finding('legacy', LEVEL.ERROR,
    `${total} spots in old raw material that today's rules would catch: ${kinds}`,
    'These values were written under weaker rules and sit unredacted in the repository. '
    + 'Rotate the affected keys — cheaper and safer than rewriting git history. '
    + 'Locations without values: mem raw check');
}

/**
 * Is this clone behind origin?
 *
 * **Pushed is not fixed.** Capture loads src/redaction.mjs from THIS
 * clone and never pulls by itself. A security fix sitting on main takes
 * effect here only after a pull — and in between, the machine keeps
 * capturing with the old rules.
 *
 * Uses only `git rev-list` against the already-fetched origin: no
 * network, so doctor does not hang offline.
 */
function checkBehind(root) {
  const branch = quietRun('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return finding('behind', LEVEL.UNKNOWN, 'git not runnable');
  const b = branch.trim();
  const count = quietRun('git', ['-C', root, 'rev-list', '--count', `HEAD..origin/${b}`]);
  if (count === null) {
    return finding('behind', LEVEL.UNKNOWN, `no origin/${b} known — never fetched?`,
      `git -C ${root} fetch origin ${b}`);
  }
  const n = Number(count.trim());
  if (!Number.isFinite(n)) return finding('behind', LEVEL.UNKNOWN, 'count unreadable');
  if (n === 0) return finding('behind', LEVEL.GOOD, `up to date with origin/${b}`);
  return finding('behind', LEVEL.WARN, `${n} commits behind origin/${b}`,
    'Capture uses the redaction from THIS clone. While it lags, it captures with '
    + `old rules: git -C ${root} pull`);
}


// --- integrity of the log itself -------------------------------------------

/**
 * Broken lines, duplicate ids, impossible timestamps, and the shape of the
 * replacement graph.
 *
 * Until 2026-09-05 an unparseable line was stepped over without a word, so
 * a truncated file or a bad merge lost entries and nothing said so.
 * Skipping is still the right recovery — refusing to open a memory over
 * one bad byte is worse — but it is now counted and located.
 *
 * Never prints line content: a half-written line can hold a half-written
 * secret, and a diagnostic that quotes it turns a corruption report into a
 * leak.
 */
export function checkIntegrity(root) {
  let r;
  try { r = integrity.scanIntegrity(root); }
  catch { return finding('integrity', LEVEL.UNKNOWN, 'logs unreadable'); }

  const parts = [`${r.entries} entries in ${r.lines} lines`];
  const problems = [];
  if (r.broken.length) {
    problems.push(`${r.broken.length} unparseable line(s): `
      + r.broken.slice(0, 5).map((b) => `${b.file}:${b.line}`).join(', ')
      + (r.broken.length > 5 ? ' ...' : ''));
  }
  if (r.duplicateIds.length) {
    problems.push(`${r.duplicateIds.length} duplicate id(s): `
      + r.duplicateIds.slice(0, 3).map((d) => d.id).join(', '));
  }
  if (r.replacement.missing.length) {
    problems.push(`${r.replacement.missing.length} replacement(s) point at an id that does not exist`);
  }
  if (r.replacement.cycles.length) {
    problems.push(`${r.replacement.cycles.length} replacement cycle(s)`);
  }
  if (r.replacement.tooDeep) {
    problems.push(`a replacement chain is ${r.replacement.maxDepth} deep`);
  }
  // `valid_until before valid_from` is pulled out of the generic
  // "questionable timestamp(s)" bucket and named on its own.
  //
  // **Why it earns its own line (decided 2026-09-17, building
  // `valid_until` as one truth with supersession — see
  // `retrieval.validAt`).** A clock 5 minutes fast is noise; a
  // `valid_until` that precedes its own `valid_from` is not — it makes
  // `validAt` return `false` for EVERY possible `--as-of`, forever. The
  // claim is unconditionally unrecoverable by time, and nothing else
  // says so: the entry is not `broken` (it parses fine), not a
  // `duplicateId`, not a bad `replacement` — every other check in this
  // function is silent about it. Before this, it sat inside the same
  // count as an unparseable `ts` or a five-minute clock skew, both of
  // which are genuinely minor, so a real defect and a shrug shared one
  // number and neither reader could tell which they had.
  const nonsensical = r.badTimestamp.filter((b) => b.why === 'valid_until before valid_from');
  const otherBadTs = r.badTimestamp.filter((b) => b.why !== 'valid_until before valid_from');
  if (otherBadTs.length) {
    parts.push(`${otherBadTs.length} questionable timestamp(s)`);
  }
  if (r.replacement.forks.length) {
    // Not a defect: merge=union produces a fork whenever two sessions
    // correct the same entry without seeing each other.
    parts.push(`${r.replacement.forks.length} fork(s) — two claims replacing one target`);
  }

  const nonsensicalNote = nonsensical.length
    ? `${nonsensical.length} entr${nonsensical.length === 1 ? 'y has' : 'ies have'} `
      + `valid_until before valid_from (never valid at any --as-of): `
      + nonsensical.slice(0, 5).map((b) => b.id ?? `${b.file}:${b.line}`).join(', ')
      + (nonsensical.length > 5 ? ' ...' : '')
    : null;
  const nonsensicalAdvice = 'The log is append-only, so the bad line stays. Fix it forward with '
    + '`mem correction <type> <id> --valid_until <a date after its valid_from>` — the new line wins '
    + 'over the old one exactly the way any other correction does.';

  if (problems.length) {
    return finding('integrity', LEVEL.ERROR,
      `${parts[0]}; ${problems.join('; ')}${nonsensicalNote ? `; ${nonsensicalNote}` : ''}`,
      'A broken line cannot be repaired in place — the log is append-only. '
      + 'Recover the entry from git history and append it again, or accept the '
      + `loss knowingly. Duplicate ids and cycles need a correcting entry.${
        nonsensicalNote ? ` ${nonsensicalAdvice}` : ''}`);
  }
  if (nonsensicalNote) {
    return finding('integrity', LEVEL.WARN, `${parts.join(', ')}; ${nonsensicalNote}`, nonsensicalAdvice);
  }
  return finding('integrity', LEVEL.GOOD, parts.join(', '));
}

// --- guarantees that are not ours ------------------------------------------

/**
 * The properties cheap-mem depends on but does not provide: the merge
 * driver, the pre-commit hook, append atomicity, the clock.
 *
 * These were the failure class behind the others — invisible when present,
 * silent when absent. Each finding names the LAYER responsible, because
 * cheap-mem cannot fix a filesystem, only refuse to pretend it checked
 * one.
 *
 * **`clock` is handled separately from the other three (2026-09-20).**
 * `environment.checkClock` compares the single newest entry in the
 * WHOLE memory against this process's own clock — which, on a memory
 * with one writer, is really "my clock vs. my own last write" and
 * proves nothing about skew between machines. `src/clock.mjs` narrows
 * that to the newest FOREIGN line specifically (see its module doc for
 * why "ahead" and "behind" are not symmetric evidence), so its finding
 * replaces `environment.checkClock`'s entry here rather than being
 * folded into the generic mapping below. `environment.checkEnvironment`
 * still runs its own `checkClock` as part of the four-check array it
 * always returns — that result is simply not the one this function
 * reports under `env/clock`.
 */
export function checkEnvironmentContract(root) {
  let checks;
  try { checks = environment.checkEnvironment(root, {}); }
  catch { return [finding('environment', LEVEL.UNKNOWN, 'environment could not be checked')]; }

  const mapped = checks.filter((c) => c.name !== 'clock').map((c) => {
    const name = `env/${c.name}`;
    if (c.ok === true) return finding(name, LEVEL.GOOD, `[${c.layer}] ${c.detail}`);
    if (c.ok === null) return finding(name, LEVEL.UNKNOWN, `[${c.layer}] ${c.detail}`, c.fix);
    return finding(name, LEVEL.ERROR, `[${c.layer}] ${c.detail}`,
      c.fix ?? 'This guarantee is not cheap-mem\'s to provide — fix it in that layer.');
  });

  return [...mapped, checkClockSkew(root)];
}

/**
 * The `env/clock` finding, built from `src/clock.mjs`'s cross-writer
 * skew measurement. Kept as its own function (rather than inlined
 * above) so a doctor test can call it directly without wading through
 * the other three environment checks.
 */
export function checkClockSkew(root, opts = {}) {
  let result;
  try { result = clock.measureClockSkew(root, opts); }
  catch { return finding('env/clock', LEVEL.UNKNOWN, 'clock skew could not be measured'); }

  const tag = `[${environment.LAYER.OPS}]`;
  if (result.state === clock.STATE.UNKNOWN) {
    return finding('env/clock', LEVEL.UNKNOWN, `${tag} ${result.reason}`);
  }
  if (result.state === clock.STATE.ERROR) {
    return finding('env/clock', LEVEL.ERROR, `${tag} ${result.detail}`, result.fix);
  }
  if (result.state === clock.STATE.WARN) {
    return finding('env/clock', LEVEL.WARN, `${tag} ${result.detail}`, result.fix);
  }
  return finding('env/clock', LEVEL.GOOD, `${tag} ${result.detail}`);
}


// --- did the memory go backwards? ------------------------------------------

/**
 * Rollback and resurrection.
 *
 * Check out an older commit, or restore a stale backup, and a claim that
 * had been superseded is active again — and from inside that state
 * everything looks correct, because it WAS correct then. The only way to
 * know is to have seen further, which is what the local watermark records.
 *
 * Reported as an ERROR rather than a warning: silently answering from a
 * rolled-back memory is the failure this exists to prevent.
 */
export function checkRollback(root) {
  let state;
  try { state = epoch.checkEpoch(root); }
  catch { return finding('rollback', LEVEL.UNKNOWN, 'could not compare against the watermark'); }

  if (state.status === 'semantics-changed') {
    return finding('rollback', LEVEL.WARN,
      `watermark predates a rules change (${state.detail})`,
      'The derived state is not comparable across a semantic version bump, so a '
      + 'rollback cannot be detected until the mark is retaken: `mem epoch record --force`.');
  }
  if (state.status === 'first') {
    return finding('rollback', LEVEL.UNKNOWN,
      'no watermark yet — this run cannot detect a rollback, only establish the mark',
      'Run `mem epoch record` once on a state you trust. A fresh clone always starts here.');
  }
  if (state.status === 'rollback') {
    const names = state.resurrected.slice(0, 5).join(', ');
    return finding('rollback', LEVEL.ERROR,
      `the memory went BACKWARDS: ${state.lostClaims > 0 ? `${state.lostClaims} claim(s) gone, ` : ''}`
      + `${state.resurrected.length} retired claim(s) active again${names ? ` (${names})` : ''}`,
      'An older checkout or a stale backup. Restore the newer state, or — if the '
      + 'rollback was intended — accept it deliberately with `mem epoch record --force`.');
  }
  return finding('rollback', LEVEL.GOOD,
    `${state.current.claims} claims, ${state.current.retiredCount} retired `
    + `(watermark from ${state.mark.seenAt})`);
}

/**
 * Advance the watermark automatically — the missing tick (P21,
 * 2026-09-20). `mem epoch record` has existed since the watermark was
 * designed, but nothing ever called it on its own: the mark could only
 * move by an operator remembering to type one more command, so on every
 * memory in this house it never moved. "no watermark yet" was not a
 * fact about any particular memory — it was a fact about the command
 * never having been run.
 *
 * **What the "tick" is.** `checkAll()` — the very self-check `mem
 * doctor` already runs, on whatever already wakes that up. No new
 * timer, no new schedule: a caller that runs `checkAll` and then this
 * function right after it has just made every doctor run BE the tick.
 * See the CLI wiring in `src/cli/commands/admin.mjs`'s `doctor` command
 * for the one caller this house has today.
 *
 * **What "passed" means, precisely: `worst !== LEVEL.ERROR`.** The same
 * line `mem doctor`'s own exit code already draws for pass/fail without
 * `--strict` (0 or 1, never 2). Two things this is deliberately NOT:
 *
 *   - **not zero-WARN.** A warning means "look at this", not "this
 *     state is too broken to trust as a reference". Most memories carry
 *     at least one WARN somewhere in this file's 25+ checks on any
 *     given day (git-hook not installed, index empty, digest backlog);
 *     gating the mark on zero-WARN would mean it advances only on the
 *     rare day nothing at all needs attention, which is a bad day to
 *     hang the one rollback detector this house has.
 *   - **not zero-UNKNOWN.** `checkRollback` above reports UNKNOWN on
 *     every machine that has never recorded a mark — which, before this
 *     function is wired in anywhere, is every machine that exists.
 *     Requiring zero UNKNOWN would mean the very first tick can never
 *     fire, because the one finding this feature exists to eventually
 *     turn green is itself blocking its own first green. `--strict`
 *     (the CLI's separate, opt-in "unknown counts as failure" bar for
 *     CI) is not consulted here on purpose.
 *
 * An ERROR blocks the tick unconditionally — including one that has
 * nothing to do with rollback at all. A memory with a leaked credential
 * is not a state worth enshrining as "the reference to roll back to
 * safely", even though nothing about ITS claim count is wrong. That is
 * the reason this is coupled to the FULL self-check (`doctorResult`)
 * and not to `checkRollback`'s own verdict alone.
 *
 * An in-progress rollback is caught twice, on purpose. `checkRollback`
 * itself already returns LEVEL.ERROR when `state.status === 'rollback'`
 * (above), which makes `doctorResult.worst` `'error'` and this function
 * return before `recordEpoch` is even called. `recordEpoch`'s own
 * refusal to lower the mark (src/epoch.mjs) is the second, independent
 * guard, for any caller that reaches it a different way (e.g. `mem
 * epoch record` run by hand on a rolled-back state).
 */
export function tickEpoch(root, doctorResult) {
  if (doctorResult.worst === LEVEL.ERROR) {
    return { advanced: false, reason: 'doctor found an error; not enshrining this state as the reference' };
  }
  const r = epoch.recordEpoch(root);
  return { advanced: r.written, epoch: r };
}

/**
 * The SHAPE of an entry — is it still the thing someone meant to write?
 *
 * `checkIntegrity` already covers unparseable lines, duplicate ids and
 * the replacement graph. What it does not see is an entry that parses
 * perfectly and is nonetheless destroyed. Two forms, both silent, both
 * observed in the sibling project lucky-mem:
 *
 *   {"title": true, "--flag-ish text": true}      a swallowed value
 *   {"tags": ["[\"a\"", "\"b\"]"]}                half-parsed JSON
 *
 * Valid JSON, exit 0, nothing said. The first destroys the content; the
 * second makes the entry unfindable by any of its tags. lucky-mem
 * carries two of the first and seventeen of the second.
 *
 * Both write paths are closed since 2026-09-07 (`fieldsFrom` in
 * bin/mem), so new ones cannot appear. This check is the other half:
 * what is already written STAYS written — rewriting a jsonl line is
 * backwards redaction — and is therefore reported instead of removed.
 *
 * **Why the cap.** A finding that can never go green again does not get
 * read; that is a failure mode, not diligence. So an appended entry of
 * class `entry-form` caps everything written before it: the damage is
 * on the record, still counted, no longer nagged about. Anything AFTER
 * the cap cannot exist since the write path closed, and is a real
 * warning.
 */
/**
 * Does the memory's .gitignore actually ignore what it claims?
 *
 * **Asked of git, not of the file.** The file looked right for weeks
 * and ignored nothing: `writeMemoryGitignore` wrote
 * `<rule><padding># <why>` on one line, and git has no trailing
 * comments — `#` only starts a comment at the start of a line. All nine
 * rules were patterns matching nothing, the first of them
 * `.mem/embed.env`, whose entire job is to keep an API key out of the
 * repository. Found 2026-09-07 on a fresh Windows install, by someone
 * who read the file and then asked git.
 *
 * That is why this check shells out to `git check-ignore` instead of
 * parsing the file: a parser of ours would have made the same
 * assumption the writer made. The authority on what git ignores is git.
 *
 * Silent (UNKNOWN) where there is no git repository — a memory that is
 * not versioned cannot fail this, and a check that fires there would
 * train people to ignore the output.
 */
export function checkGitignoreEffective(root) {
  const PFLICHT = ['.mem/embed.env', '.mem/epoch.json', '.mem/search-index.json'];
  if (!fs.existsSync(path.join(root, '.git'))) {
    return finding('gitignore', LEVEL.UNKNOWN, 'no git repository — nothing to ignore');
  }
  const offen = [];
  for (const regel of PFLICHT) {
    const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', '--no-index', regel],
      { encoding: 'utf8' });
    // 0 = ignored, 1 = not ignored, anything else = git could not answer.
    if (r.status === 1) offen.push(regel);
    else if (r.status !== 0) {
      return finding('gitignore', LEVEL.UNKNOWN,
        `git check-ignore could not answer (${r.status})`);
    }
  }
  if (!offen.length) {
    return finding('gitignore', LEVEL.GOOD,
      `git ignores all ${PFLICHT.length} required paths`);
  }
  const geheim = offen.includes('.mem/embed.env');
  return finding('gitignore', geheim ? LEVEL.ERROR : LEVEL.WARN,
    `git does NOT ignore: ${offen.join(', ')}`
    + (geheim ? ' — embed.env holds API keys' : ''),
    'run `mem init` again in this memory: it rewrites the block and repairs broken lines');
}

export function checkEntryForm(root) {
  const TEXT_FIELDS = ['title', 'text', 'topic', 'choice', 'why', 'fact', 'summary'];
  const broken = [];
  let cap = null;
  let total = 0;

  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      const { entries, path: p } = memory.readLog(root, type, { project });
      total += entries.length;
      const rel = path.relative(root, p);
      entries.forEach((e, i) => {
        if (!e || typeof e !== 'object' || e.__broken) return;
        if (e.class === 'entry-form' && e.ts && (!cap || String(e.ts) > cap)) {
          cap = String(e.ts);
        }
        const where = `${rel}:${i + 1}`;
        const ts = e.ts ? String(e.ts) : null;
        const spaced = Object.keys(e).find((k) => /\s/.test(k));
        if (spaced) {
          broken.push({ where, ts, what: `field name with whitespace: "${spaced.slice(0, 40)}…"` });
          return;
        }
        const empty = TEXT_FIELDS.find((f) => e[f] === true);
        if (empty) {
          broken.push({ where, ts, what: `${empty} is true instead of text` });
          return;
        }
        if (Array.isArray(e.tags)
          && e.tags.some((t) => typeof t === 'string' && /["[\]{}]/.test(t))) {
          broken.push({ where, ts, what: 'half-parsed JSON in tags' });
        }
      });
    }
  }

  // No ts counts as open. Better once too loud than quietly filed under a
  // cap it may not belong to.
  const open = cap ? broken.filter((b) => !b.ts || b.ts > cap) : broken;
  const capped = broken.length - open.length;

  // Denominator: entries to check the shape of. None means the shape
  // was never examined — "no malformed entries" over an empty memory
  // proves nothing about the write path.
  if (total === 0) {
    return finding('entry-form', LEVEL.UNKNOWN, 'no entries in any log — entry shape cannot be checked');
  }

  if (!open.length) {
    const extra = capped
      ? `, ${capped} on the record (an entry-form note exists; the lines stay — append-only)`
      : '';
    return finding('entry-form', LEVEL.GOOD, `no malformed entries${extra}`);
  }

  return finding('entry-form', LEVEL.WARN,
    `${open.length} malformed entr${open.length === 1 ? 'y' : 'ies'} (e.g. ${open[0].where}: ${open[0].what})`
    + (capped ? `, ${capped} already on the record` : ''),
    'The lines stay — rewriting one would be backwards redaction. Append a correction '
    + 'with `mem correction <type> <id> --title ...` carrying the FULL content: a '
    + 'correction writes only the fields you give it, so a partial one replaces the '
    + 'entry with a stub. The write paths closed on 2026-09-07, so no new ones can '
    + 'appear. To put the existing ones on the record: '
    + '`mem log error --class entry-form --title "..." --text "..."` — that caps '
    + 'everything written before it.');
}

/**
 * How much raw material sits in the TRACKED capture folder and never drains?
 *
 * **The finding that was missing on 2026-09-19.** In the sibling house
 * the drain command — the one that pulls captures out of the clone into
 * the machine archive, verifies them by checksum and only then removes
 * the originals — was built on 2026-09-18. Built, tested, documented.
 * And then nobody ever called it: no unit, no timer, no hook. Measured
 * on 2026-09-19: 1382 captures, 85.5 MB in the tracked folder, the
 * oldest from 2026-08-30 — twenty days. The git pack was 86.6 MiB, so
 * the memory consisted almost entirely of its own raw material.
 *
 * Without this finding a drain that has not run for weeks is
 * indistinguishable from one that ran a minute ago: both look the same
 * from outside. cheap-mem has the identical shape — `archive.DEFAULT_LOCATION`
 * is a folder inside the repository — and it matters more here, because
 * this is the copy strangers install.
 *
 * **Why the AGE counts and not the amount.** On an ephemeral machine
 * fresh material in the tracked folder is exactly right: it is the only
 * storage that outlives the container, so there the repository is
 * TRANSPORT, not a warehouse. An amount threshold cannot tell those
 * apart and would report innocents — and a bolt that reports innocents
 * gets switched off. A capture that has been lying around for days is
 * the same finding on every machine: nobody is collecting it.
 *
 * Three states:
 *
 *   GOOD     nothing here, or only fresh material (< BACKLOG_LATE_DAYS)
 *   WARN     the oldest has been lying longer than BACKLOG_LATE_DAYS
 *   ERROR    the oldest has been lying longer than BACKLOG_DEAD_DAYS —
 *            the drain is not happening, not merely late
 */
export const BACKLOG_LATE_DAYS = 2;
export const BACKLOG_DEAD_DAYS = 7;

/**
 * The timestamp out of a capture name: `2026-09-19T10-49-48Z--120l0a8.jsonl.gz`.
 * Returns ms, or null when the name does not match — null means "not
 * measurable", never "now".
 */
function timeFromCaptureName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z/.exec(name);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  return Number.isNaN(ms) ? null : ms;
}

// Denominator: captures this memory has EVER recorded, drained or not —
// `archive.records()` is the tracked, append-only ledger written on
// every capture, so it survives a migrate that empties raw/ back out.
// Has anything ever been captured into this memory?
//
// **Why this does NOT make the finding unknown (decided 2026-09-20).**
// The first cut turned "empty and nothing ever captured" into UNKNOWN,
// on the rule that `ok` over a zero count claims a check that did not
// happen. The sister house pushed back with a better argument, written
// into its own test months earlier — quoted here in the original:
// "Ein leerer Ordner ist messbar leer, daraus ein UNBEKANNT zu machen waere ein falsches nicht messbar."
//
// It is right, and the difference is which question the finding asks.
// This one asks "is anything piling up here?" — and an empty folder
// answers it. The folder WAS inspected. What was wrong was never the
// level; it was the sentence "the drain has taken everything", which
// reports a drain that never ran.
//
// The other half of why GOOD is safe here: if captures stop arriving,
// the silence is not this finding's to catch — `capture` says "no
// captures at all" and warns. A finding that stays quiet because a
// NEIGHBOUR speaks is not a finding that hides something. `topic-quality`
// has no such neighbour, which is why that one really is unknown on an
// empty memory.
function everCaptured(root) {
  try { return archive.records(root).length > 0; } catch { return false; }
}

export function checkArchiveBacklog(root, { env = process.env, now = Date.now() } = {}) {
  const dir = path.join(root, archive.DEFAULT_LOCATION);
  if (!fs.existsSync(dir)) {
    return finding('archive-backlog', LEVEL.GOOD,
      `no ${archive.DEFAULT_LOCATION}/ in the clone — nothing is lying here`
      + (everCaptured(root) ? '' : ', and no capture has ever been recorded'));
  }

  // Only what REALLY lies here. The record travels with the repository
  // and knows captures of other machines too; those are not this
  // clone's ballast.
  let count = 0; let bytes = 0; let oldestMs = null;
  const stack = [dir];
  while (stack.length) {
    let entries;
    try { entries = fs.readdirSync(stack.pop(), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(e.parentPath ?? e.path, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      // Only `.jsonl.gz` is a capture; the folder carries other files too.
      if (!e.isFile() || !e.name.endsWith('.jsonl.gz')) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      count += 1; bytes += st.size;
      // The timestamp comes from the FILENAME, not from the mtime: a
      // fresh clone sets every mtime to the clone time, so an
      // mtime-based finding would report "all fresh" in every container
      // — exactly the situation in which it gets read.
      const ms = timeFromCaptureName(e.name);
      if (ms != null && (oldestMs == null || ms < oldestMs)) oldestMs = ms;
    }
  }

  if (count === 0) {
    return finding('archive-backlog', LEVEL.GOOD, everCaptured(root)
      ? `${archive.DEFAULT_LOCATION}/ is empty — the drain has taken everything`
      // Not "the drain has taken everything": nothing ever arrived for
      // one to take, and claiming a successful drain there is the
      // sentence this finding was corrected for.
      : `${archive.DEFAULT_LOCATION}/ is empty, and no capture has ever been recorded — `
        + 'nothing is lying here because nothing has arrived, not because a drain ran');
  }

  const mb = (bytes / 1048576).toFixed(1);
  const store = (() => { try { return archive.readConfig(env, root); } catch { return null; } })();
  const target = store ? store.location : '(archive location not readable)';
  const drain = 'mem raw migrate --remove, then commit and push';

  if (oldestMs == null) {
    // Files without a readable timestamp in the name. Not measurable is
    // not zero: that is UNKNOWN, not "fresh".
    return finding('archive-backlog', LEVEL.UNKNOWN,
      `${count} captures (${mb} MB) in ${archive.DEFAULT_LOCATION}/, but not one with a readable `
      + 'timestamp in its name — how long they have been lying was not determinable',
      `Look by hand: ls ${archive.DEFAULT_LOCATION}/*/*/ | head`);
  }

  const days = (now - oldestMs) / 86400000;
  const since = new Date(oldestMs).toISOString().slice(0, 10);
  const state = `${count} captures (${mb} MB) lie in the tracked ${archive.DEFAULT_LOCATION}/, `
    + `the oldest since ${since} (${days.toFixed(1)} days). Archive of this machine: ${target}`;

  if (days >= BACKLOG_DEAD_DAYS) {
    return finding('archive-backlog', LEVEL.ERROR,
      `${state} — the drain is not happening.`,
      `After ${BACKLOG_DEAD_DAYS} days this is no longer lateness. On the machine that holds `
      + `the archive: ${drain}. If nothing calls it on a schedule, nobody collects it, ever.`);
  }
  if (days >= BACKLOG_LATE_DAYS) {
    return finding('archive-backlog', LEVEL.WARN,
      `${state} — the drain is behind.`,
      `On the machine that holds the archive: ${drain}`);
  }
  return finding('archive-backlog', LEVEL.GOOD,
    `${count} captures (${mb} MB) in transit in the tracked ${archive.DEFAULT_LOCATION}/, `
    + `oldest ${days.toFixed(1)} days — the drain is running`);
}

// --- corpus size against the sharding line ---------------------------

/**
 * Past this many entries, `docs/scale.md` says split rather than tune.
 * Configurable via `.mem/config.json`'s `corpusWarnThreshold` — the
 * same ad-hoc-optional-key shape as `maxEntryBytes` in memory.mjs, not
 * a new pattern.
 */
export const CORPUS_WARN_THRESHOLD = 50000;

/**
 * Total entries against the sharding line — with the MEASURED cost of
 * ignoring it, not a guess.
 *
 * **Why cheap-mem gets a real threshold and the sibling house does
 * not.** lucky-mem holds one person's memory (2094 entries measured
 * 2026-09-07 — see `shared/finding-map.jsonl`'s `nur-startlast` entry
 * for the shape difference between the houses); it is 24x away from the
 * line below and would never trip it in practice. cheap-mem is the copy
 * strangers install (see `checkArchiveBacklog`'s docstring, the same
 * reasoning) — foreign users bring their own corpora, and some of those
 * are already large. A threshold that fires for nobody teaches nobody
 * to look; this one exists because it is expected to actually fire for
 * someone.
 *
 * **The number in the warning is the audit's own measurement, not this
 * file's estimate.** External audit, 2026-09-19: 400,000 entries, 1237
 * MB heap, 746 ms search latency. `docs/scale.md`'s own table stops at
 * 200,000 (247 ms search, per its own numbers) precisely because nobody
 * had pushed a real corpus further than that before. Quoting the 400k
 * point rather than extrapolating the existing curve keeps the warning
 * honest about what was actually measured versus what is inferred.
 *
 * **WARN, never ERROR.** A large corpus is not broken — search still
 * returns correct answers, only slower, and heap is a resource cost,
 * not a correctness one. Sharding is a real migration a team schedules
 * on its own time; `mem doctor` should not be able to fail a build over
 * it. See `docs/scale.md` ("Sharding is the answer, not a bigger
 * index") for the actual fix.
 *
 * **The count is named even when it is nowhere near the line.** A
 * number that appears only once it is a problem cannot be watched
 * growing towards one.
 */
export function checkCorpusSize(root) {
  let entries;
  try { ({ entries } = integrity.scanIntegrity(root)); }
  catch { return finding('corpus-size', LEVEL.UNKNOWN, 'logs unreadable'); }

  let threshold = CORPUS_WARN_THRESHOLD;
  try {
    const cfg = cfgmod.readConfig(root);
    const v = Number(cfg.corpusWarnThreshold);
    if (Number.isFinite(v) && v > 0) threshold = v;
  } catch { /* no config yet (bare tmp dir, mid `mem init`) — use the floor */ }

  if (entries <= threshold) {
    return finding('corpus-size', LEVEL.GOOD,
      `${entries} entries, under the ${threshold}-entry sharding line`);
  }
  return finding('corpus-size', LEVEL.WARN,
    `${entries} entries, over the ${threshold}-entry sharding line. Measured at `
    + '400,000 entries (external audit, 2026-09-19): 1237 MB heap, 746 ms search '
    + 'latency — not an estimate.',
    'Split this memory: one per team, product or client, not a bigger index — '
    + 'see docs/scale.md ("Sharding is the answer, not a bigger index"). '
    + 'Raise or lower the line for this memory via .mem/config.json '
    + '"corpusWarnThreshold" if it genuinely needs to run larger.');
}

// --- append-only, checked against git, not against a hash chain ------

/**
 * Above this many bytes a file is skipped rather than fully diffed
 * against its git blob — `git show` buffers the whole blob into memory
 * as a string, and so does the working-tree read this compares it
 * against, so an unbounded file here is two full in-memory copies of
 * whatever a corpus grows into. Generous relative to anything this
 * repo's own logs have ever reached (the largest tracked .jsonl in this
 * repo is under 200 KB, measured 2026-09-19) — this is a safety valve
 * for a pathological corpus, not a normal-case limiter.
 */
export const APPEND_ONLY_GIT_CAP_BYTES = 8 * 1024 * 1024;

/**
 * Is every append-only log still a pure extension of what git already
 * has committed for it — checked against GIT, not against a hash chain.
 *
 * **Why git and not a hash chain (the audit's own proposal).** A hash
 * chain answers "has any line changed since the file was written",
 * which is exactly what a recomputable checksum answers too — and
 * against the realistic adversary here, it adds nothing a chain would
 * not also fail to catch: someone with filesystem access can rewrite a
 * line AND recompute every hash after it in the same edit, and a chain
 * gives no way to tell that apart from an untouched file. What a chain
 * is actually good against — an adversary who can edit the file but NOT
 * recompute checksums — is not this project's threat model; the
 * realistic failure here is carelessness, not a targeted attacker with
 * disk access. And carelessness is exactly what a tool we already run
 * on every write already has a complete, append-only, cryptographically
 * chained log of: git itself. Building a second, weaker version of the
 * same guarantee is a maintenance cost for no new coverage, plus a
 * migration for every existing entry the moment the chain is
 * introduced.
 *
 * **What this actually checks.** For every append-only log
 * (`integrity.logFiles`, the same enumeration `checkIntegrity` uses):
 * the current WORKING TREE content against `git show HEAD:<path>`. The
 * old (committed) content must be a byte-for-byte PREFIX of the new
 * (working-tree) content — that is what "only appended since the last
 * commit" means. When it is not a prefix, the first line where they
 * diverge is reported (1-indexed, matching an editor's line numbers).
 *
 * Three states, not two:
 *   - not a git clone, or a file not yet tracked in HEAD (new, never
 *     committed) -> UNKNOWN for that file. A brand-new file has no
 *     history to check against, and reporting it GOOD would credit git
 *     with a guarantee it is not yet holding.
 *   - tracked, and the old content is a prefix of the new -> GOOD.
 *   - tracked, and it is not a prefix -> ERROR, naming the file and the
 *     first differing line.
 *
 * **The honest limit of this, stated plainly.** This compares the
 * working tree to the CURRENT HEAD. It catches an edit to a historical
 * line made in the working tree before it is committed — which is where
 * carelessness actually happens: `sed -i` on the wrong file, a manual
 * "fix" of an old entry, a bad merge resolved by hand. It does NOT
 * catch a rewrite that has already been committed (HEAD then IS the
 * rewritten content, and comparing HEAD to HEAD is trivially clean), and
 * it does not catch a force-pushed history this clone has since pulled.
 * Whoever can commit — or rewrite and push — gets through. That is not
 * a defect in the check; it is the actual shape of "checked against
 * git": git's own history is the append-only log here, and this reads
 * it, it does not re-implement it.
 *
 * `root` is assumed to be inside a git worktree but not necessarily its
 * TOPLEVEL (a memory can be nested in a larger repo) — the git pathspec
 * for `show` is resolved against the toplevel, not against `root`,
 * because `git show HEAD:<path>` reads `<path>` relative to the
 * repository root unless prefixed with `./`. Measured directly
 * (2026-09-19): `git -C <subdir> show HEAD:file.txt` for a file that
 * exists at `<subdir>/file.txt` answers "path 'sub/file.txt' exists,
 * but not 'file.txt'" — using `path.relative(root, ...)` here without
 * this correction would make every file in a nested memory read as
 * untracked.
 */
export function checkAppendOnlyGit(root) {
  const top = quietRun('git', ['-C', root, 'rev-parse', '--show-toplevel']);
  if (top === null || !top.trim()) {
    return finding('append-only-git', LEVEL.UNKNOWN,
      'not a git clone (or git missing) — append-only cannot be checked against history');
  }
  const toplevel = top.trim();

  const files = integrity.logFiles(root);
  if (!files.length) return finding('append-only-git', LEVEL.GOOD, 'no append-only logs yet');

  const errors = [];      // { rel, line }
  const untracked = [];   // rel
  const capped = [];      // rel
  let checked = 0;

  for (const f of files) {
    let stat;
    try { stat = fs.statSync(f.abs); } catch { untracked.push(f.rel); continue; }
    if (stat.size > APPEND_ONLY_GIT_CAP_BYTES) { capped.push(f.rel); continue; }

    const gitRel = path.relative(toplevel, f.abs).split(path.sep).join('/');
    const committed = quietRun('git', ['-C', root, 'show', `HEAD:${gitRel}`]);
    if (committed === null) { untracked.push(f.rel); continue; }

    let current;
    try { current = fs.readFileSync(f.abs, 'utf8'); } catch { untracked.push(f.rel); continue; }

    checked += 1;
    if (current.startsWith(committed)) continue;   // only appended — good

    const oldLines = committed.split('\n');
    const newLines = current.split('\n');
    let bad = 1;
    while (bad <= oldLines.length && newLines[bad - 1] === oldLines[bad - 1]) bad += 1;
    errors.push({ rel: f.rel, line: bad });
  }

  const cappedNote = capped.length ? `, ${capped.length} file(s) skipped (over ${
    (APPEND_ONLY_GIT_CAP_BYTES / 1048576).toFixed(0)} MB, not checked)` : '';
  const untrackedNote = untracked.length
    ? `, ${untracked.length} not tracked in HEAD (new, unjudged)` : '';

  if (errors.length) {
    return finding('append-only-git', LEVEL.ERROR,
      `${errors.length} file(s) changed a line git already has committed: `
      + errors.slice(0, 5).map((e) => `${e.rel}:${e.line}`).join(', ')
      + (errors.length > 5 ? ' ...' : '') + cappedNote + untrackedNote,
      'A committed line was edited in the working tree instead of appended to. '
      + 'If this was a deliberate correction, append a new line instead and leave '
      + 'the old one — append-only means the fix is a new line, not an edit. If it '
      + 'was accidental (a bad merge, a stray `sed`), restore the file from HEAD and '
      + 're-apply only the intended new lines: '
      + `git -C ${root} diff HEAD -- <file> first, to see exactly what moved.`);
  }
  if (checked === 0) {
    return finding('append-only-git', LEVEL.UNKNOWN,
      `${files.length} append-only log(s), none of them checkable against history yet`
      + `${untrackedNote}${cappedNote}`);
  }
  return finding('append-only-git', LEVEL.GOOD,
    `${checked} append-only log(s) hold everything git already has, only appended`
    + `${untrackedNote}${cappedNote}`);
}

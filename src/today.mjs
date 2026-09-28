// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * today.mjs — mirrors lucky-mem's `src/heute.mjs`: "what does the
 * owner need TODAY?", one function, every surface (`mem today`, the
 * dashboard's "Today" card, the session-start line) reading the SAME
 * answer instead of each computing its own.
 *
 * Five parts, `a`-`e`, matching the sibling's own lettering:
 *
 *   (a) operations   `doctor.checkAll()` — only the findings at WARN or
 *                     ERROR (a `good`/`unknown` finding has nothing
 *                     to act on today). `advice` already carries the
 *                     fix (every non-good finding in doctor.mjs must
 *                     carry one — see its own `finding()` helper), so
 *                     there is no second "what to do" field to invent.
 *   (b) decisions     open duties addressed to the configured human
 *                     participant — see {@link decisionsForHuman} for
 *                     why this is narrower than the sibling's part (b).
 *   (c) verify        uncertain facts to confirm — see {@link
 *                     verifyCandidates} for why this is NOT the
 *                     sibling's gold-question queue, and what it is
 *                     instead.
 *   (d) review        NOT BUILT — see the module doc below the
 *                     function for what would be needed and why it is
 *                     honestly "unknown", not invented.
 *   (e) word pairs    NOT BUILT — same reasoning, own function.
 *
 * **What does NOT go in here.** `question.open()` (this house's
 * `questions.jsonl`, no address field — same reasoning the sibling's
 * heute.mjs gives for excluding `fragen.jsonl` from part (b): an
 * unaddressed question is everyone's business, not specifically the
 * human's, and counting it as "a decision for the human" would be
 * invention, not a finding.
 */

import * as memory from './memory.mjs';
import * as doctorMod from './doctor.mjs';
import * as cfgmod from './config.mjs';
import * as verifylog from './verifylog.mjs';

/** At most this many verify candidates shown at once (N9 parity: "up to 3"). */
export const VERIFY_MAX = 3;

// =========================================================================
// (a) Operations — doctor.checkAll(), only what is not calm
// =========================================================================

const RANK = { error: 0, warn: 1, unknown: 2, good: 3 };

/**
 * Only the findings at WARN/ERROR, worst first. `doctorResult` is
 * injectable so a caller that already paid for `doctor.checkAll()` this
 * tick (the dashboard's own 60-second cache, `dashboardState`'s
 * `doctorState()`) hands it in instead of a second full run — the same
 * reason the sibling's `betriebsStand()` reads a cached file rather
 * than recomputing.
 */
export function operations(root, { check = doctorMod.checkAll, doctorResult = null } = {}) {
  let result = doctorResult;
  if (!result) {
    try { result = check(root); } catch (e) {
      return { readable: false, reason: `doctor.checkAll() failed: ${e?.message || e}`, notable: [] };
    }
  }
  const notable = (result.findings || [])
    .filter((f) => f.level === 'warn' || f.level === 'error')
    .sort((a, b) => (RANK[a.level] ?? 9) - (RANK[b.level] ?? 9))
    .map((f) => ({ name: f.name, level: f.level, text: f.text, advice: f.advice ?? null }));
  return { readable: true, reason: null, worst: result.worst, summary: result.summary, notable };
}

// =========================================================================
// (b) Decisions for the human
// =========================================================================

/**
 * **Narrower than the sibling's part (b), and said so out loud.**
 * lucky-mem's `entscheidungenAnLucky()` has TWO sources: open duties
 * addressed to Lucky, and sitzungspost with `Freigabe-Noetig: ja`
 * (a header meaning, in as many words, "a human must decide here" —
 * distinct from merely wanting a reply). cheap-mem's `src/inbox.mjs`
 * (checked 2026-09-28, `STATE`/`REQUEST` exports) has no such field at
 * all: a message is `new`/`read`/`replied`/`processed`/`closed`, never
 * marked "needs human approval to proceed". Inventing that distinction
 * here — say, "every unread message to the human" — would count things
 * the sibling's own rule does not count (a plain FYI is not a
 * decision), so this function stays to the ONE real source cheap-mem
 * has: open duties whose `who` names the configured human participant.
 */
export function decisionsForHuman(root, { human = null } = {}) {
  let who = human;
  if (who === null) {
    let cfg;
    try { cfg = cfgmod.readConfig(root); } catch (e) {
      return { readable: false, reason: `config not readable: ${e?.message || e}`, list: [] };
    }
    const h = cfgmod.humanParticipant(cfg.participants);
    if (!h.name) return { readable: false, reason: h.reason, list: [] };
    who = h.name;
  }
  let open;
  try { open = memory.openDuties(root).open; } catch (e) {
    return { readable: false, reason: `duties not readable: ${e?.message || e}`, list: [] };
  }
  const list = open
    .filter((p) => (p.who ?? p.owner ?? p.to ?? null) === who)
    .map((p) => ({ id: p.id, title: p.title ?? p.text ?? p.id, due: p.due ?? p.by ?? null, since: p.ts ?? null }))
    .sort((a, b) => String(a.since ?? '').localeCompare(String(b.since ?? '')));
  return { readable: true, reason: null, who, list };
}

// =========================================================================
// (c) Verify candidates — the honest equivalent of the sibling's
//     gold-question queue
// =========================================================================

/**
 * **What this is not.** cheap-mem has no `mem-gold-ziehen.mjs`
 * counterpart — no external raw-capture-to-question pipeline, so there
 * is no real quiz text to show. Faking one (synthesising a question
 * from a fact) would be exactly the "never fake data" the task rules
 * out.
 *
 * **What this is instead.** `memory.currentFacts()` already resolves
 * every tracked (`timeline`, keyed) fact and flags two REAL
 * uncertainty signals (src/freshness.mjs, unchanged here):
 *
 *   `stale`     the current version is more than staleDays (120) old
 *               with nothing newer on record — it may no longer hold.
 *   `conflict`  two versions dated the same day disagree — a real
 *               contradiction, not a normal update.
 *
 * Both are things a human is the only one who can resolve (only they
 * know whether the old value still holds). This function surfaces the
 * worst of them, capped at {@link VERIFY_MAX} — same cap as the
 * sibling's "up to 3" gold questions, same reasoning: a card that asks
 * for ten judgements a day gets none of them.
 */
export function verifyCandidates(root, { now = new Date(), max = VERIFY_MAX, currentFacts = memory.currentFacts } = {}) {
  let facts;
  try { facts = currentFacts(root, { now }); } catch (e) {
    return { readable: false, reason: `facts not readable: ${e?.message || e}`, totalUncertain: 0, list: [] };
  }
  const uncertain = facts.filter((f) => f.stale || f.conflict);
  const list = uncertain
    // conflicts first (a live contradiction), then staler first.
    .sort((a, b) => (b.conflict - a.conflict) || (b.ageDays ?? 0) - (a.ageDays ?? 0))
    .slice(0, max)
    .map((f) => ({
      key: f.key, project: f.project ?? null, conflict: Boolean(f.conflict),
      ageDays: f.ageDays ?? null,
      value: f.current ? (f.current.value ?? f.current.fact ?? null) : null,
      source: f.current?.source ?? null,
      asOf: f.current ? (f.current.valid_from ?? f.current.ts ?? null) : null,
    }));
  return { readable: true, reason: null, totalUncertain: uncertain.length, list };
}

// =========================================================================
// (d) Review suggestions — NOT BUILT
// =========================================================================

/**
 * lucky-mem's part (d) reads the LAST WRITTEN weekly review report
 * (`betrieb/messung/rueckblick-<week>.json`) rather than recomputing —
 * because the full scan (duplicates, twins, orphans, staleness) is too
 * expensive for every `/dashboard.json` poll and every session start.
 *
 * cheap-mem has no counterpart to that scan OR to a persisted report
 * that "today" could cheaply read. `doctor.checkOrphans()` and
 * `doctor.checkRepetition()` cover part of the same GROUND live (and
 * already surface through part (a) above when they are not calm), but
 * there is no separate, actionable SUGGESTION queue behind them — no
 * "fold entry X into Y" verdict a person clicks through. Building one
 * here would be new product surface, not a mirror of something that
 * exists; the honest state is "unknown — no source yet", not an
 * invented analogue.
 */
export function reviewSuggestions() {
  return {
    readable: false,
    reason: 'unknown — no source yet: cheap-mem has no persisted weekly review report to read '
      + '(the sibling reads betrieb/messung/rueckblick-<week>.json rather than rescanning on every '
      + 'request; this house has neither the scan nor the report). doctor.checkOrphans() and '
      + 'doctor.checkRepetition() already surface the live equivalent under "operations" above.',
    list: [],
  };
}

// =========================================================================
// (e) Word-pair suggestions — NOT BUILT
// =========================================================================

/**
 * lucky-mem's part (e) reads a PERSISTED, human-approvable queue of
 * observed synonym pairs (`src/umformulierung.mjs`, `gefaltet()`) —
 * pairs a person can `mem umformulierung gib-frei` one at a time.
 * `src/thesaurus.mjs` here builds a term/tag GRAPH from the corpus at
 * read time (`buildTagGraph`/`buildTermGraph`) for search expansion —
 * a live structure, not an open queue of individual pairs waiting for
 * a yes/no. There is nothing to read a "queue" FROM without inventing
 * one, so this stays honestly unmeasured rather than repurposing the
 * graph as if it were the same kind of thing.
 */
export function wordPairSuggestions() {
  return {
    readable: false,
    reason: 'unknown — no source yet: cheap-mem\'s src/thesaurus.mjs builds a live term/tag graph for '
      + 'search, not a persisted, human-approvable queue of individual word-pair suggestions like the '
      + "sibling's src/umformulierung.mjs. Repurposing the graph as if it were that queue would be "
      + 'inventing a feature, not mirroring one.',
    list: [],
  };
}

// =========================================================================
// Everything together, and the one-line summary
// =========================================================================

export function today(root, { env = process.env, now = new Date(), doctorResult = null } = {}) {
  const ops = operations(root, { doctorResult });
  const decisions = decisionsForHuman(root);
  const verify = verifyCandidates(root, { now });
  const review = reviewSuggestions();
  const wordPairs = wordPairSuggestions();

  const reasons = [
    ...(ops.readable ? [] : [ops.reason]),
    ...(decisions.readable ? [] : [decisions.reason]),
    ...(verify.readable ? [] : [verify.reason]),
  ];

  return {
    at: now.toISOString(),
    // "warning" only for what could not be READ — reviewSuggestions()/
    // wordPairSuggestions() being honestly not-built is a documented
    // gap, not a read failure, so it never lowers this state.
    state: reasons.length ? 'warning' : 'ok',
    reasons,
    operations: ops,
    decisions,
    verify,
    review,
    wordPairs,
    verifyTarget: verifylog.targetPath(env),
  };
}

/**
 * "Today: 2 decisions open · operations warn · 1 to verify" — ONE line,
 * `null` when there is nothing worth a line (same rule as the
 * sibling's `zeile()`: silence beats a banner nobody reads).
 */
export function line(result) {
  const parts = [];
  const nDec = result.decisions?.list?.length ?? 0;
  if (nDec > 0) parts.push(`${nDec} decision${nDec === 1 ? '' : 's'} open`);

  const worst = result.operations?.readable ? result.operations.worst : null;
  let opsNotable = false;
  if (worst === 'error' || worst === 'warn') {
    parts.push(`operations ${worst}`);
    opsNotable = true;
  }

  const nVerify = result.verify?.list?.length ?? 0;
  if (nVerify > 0) parts.push(`${nVerify} to verify`);

  const notable = nDec > 0 || opsNotable || nVerify > 0;
  if (!notable || !parts.length) return null;
  return `Today: ${parts.join(' · ')}`;
}

// --- CLI text -----------------------------------------------------------

export function asText(result) {
  const lines = [`TODAY — state: ${result.state.toUpperCase()}`, ''];

  if (result.operations.readable) {
    lines.push(`OPERATIONS (${result.operations.notable.length} not calm, worst: ${result.operations.worst}):`);
    for (const f of result.operations.notable) lines.push(`  [${f.level}] ${f.name}: ${f.text}`);
  } else {
    lines.push(`OPERATIONS: unknown — ${result.operations.reason}`);
  }
  lines.push('');

  lines.push(`DECISIONS FOR THE HUMAN: ${result.decisions.readable ? result.decisions.list.length : 'unknown'}`);
  if (!result.decisions.readable) lines.push(`  ${result.decisions.reason}`);
  for (const d of result.decisions.list ?? []) lines.push(`  [duty] ${d.id}  ${d.title}${d.due ? `  (due ${d.due})` : ''}`);
  lines.push('');

  lines.push(`TO VERIFY: ${result.verify.readable ? result.verify.list.length : 'unknown'} (of ${result.verify.totalUncertain ?? 0} uncertain)`);
  for (const v of result.verify.list ?? []) {
    lines.push(`  [${v.conflict ? 'conflict' : 'stale'}] ${v.key}${v.project ? ` (${v.project})` : ''} = ${v.value ?? '(no current value)'}`
      + `${v.ageDays != null ? `  ${v.ageDays}d old` : ''}`);
  }
  lines.push('');

  lines.push(`REVIEW SUGGESTIONS: ${result.review.reason}`);
  lines.push(`WORD-PAIR SUGGESTIONS: ${result.wordPairs.reason}`);

  return lines.join('\n');
}

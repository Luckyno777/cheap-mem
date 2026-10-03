// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * today.mjs — mirrors lucky-mem's `src/heute.mjs`: "what does the
 * owner need TODAY?", one function, every surface (`mem today`, the
 * dashboard's "Today" card, the session-start line) reading the SAME
 * answer instead of each computing its own.
 *
 * Six parts, `a`-`f`, matching the sibling's own lettering:
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
 *   (f) projects      awaiting a person's confirmation
 *                     ({@link projectsAwaiting}): status `new` (made with
 *                     `mem project new`) and those made past the command
 *                     (`projectnew.handmade`). Read only; nothing open =
 *                     an empty list and the card takes no room.
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
import * as goldlog from './goldlog.mjs';
import * as injection from './injection.mjs';
import * as projectnew from './projectnew.mjs';
import { isoWeek } from './measurements.mjs';

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
// (f) "Rate today" — N9 parity, the sibling's REAL gold-question queue
// (not to be confused with (c) verify above, which grades a different
// thing — see src/goldlog.mjs header for the full reasoning).
// =========================================================================

/** At most this many gold questions shown per day (N9 parity: "up to 3"). */
export const GOLD_MAX = 3;

/** UTC calendar day (`YYYY-MM-DD`) — the seed for {@link pickDaily}. */
export function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Small, deterministic unsigned 32-bit hash (FNV-1a-ish) — no
 *  randomness, only a reproducible spread for the daily rotation. */
function seedNumber(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Up to `max` candidates for TODAY — deterministic by calendar day
 * (same day + same pool -> same picks, always; a later day rotates on
 * if a bucket holds more than one candidate), preferring a MIXED set
 * of outcomes (one hit, one near-miss, one no-hit) over simply the
 * three most recent. Mirrors the sibling's `waehleTaeglich`.
 *
 * **N18 parity: gap candidates go first.** `kind: 'gap'` rows
 * (`src/gap.mjs` — a closed knowledge gap, R1) are a stronger signal
 * than a drawn hit/near-miss/no-hit: a human already, structurally,
 * wrote the answer, so confirming it is the cheapest gold this house
 * can collect. They are picked deterministically (same seed, sorted by
 * `source`) BEFORE the mixed-outcome pass below runs on whatever slots
 * remain.
 */
export function pickDaily(candidates, { max = GOLD_MAX, now = new Date() } = {}) {
  const seed = seedNumber(dayKey(now));
  const gaps = candidates.filter((c) => c.kind === 'gap').sort((a, b) => String(a.source).localeCompare(String(b.source)));
  const rest0 = candidates.filter((c) => c.kind !== 'gap');
  const picked0 = gaps.slice(0, max);
  if (picked0.length >= max) return picked0;
  return picked0.concat(pickDailyDrawn(rest0, { max: max - picked0.length, now, seed }));
}

function pickDailyDrawn(candidates, { max, seed }) {
  const buckets = new Map();
  for (const c of candidates) {
    const outcome = c.source?.startsWith('raw-capture:hit:') ? 'hit'
      : c.source?.startsWith('raw-capture:near-miss:') ? 'near-miss'
        : c.source?.startsWith('raw-capture:no-hit:') ? 'no-hit' : 'other';
    if (!buckets.has(outcome)) buckets.set(outcome, []);
    buckets.get(outcome).push(c);
  }
  for (const list of buckets.values()) list.sort((a, b) => String(a.source).localeCompare(String(b.source)));

  const picked = [];
  const pickedSources = new Set();
  for (const outcome of ['hit', 'near-miss', 'no-hit']) {
    const list = buckets.get(outcome);
    if (!list || !list.length) continue;
    const c = list[seed % list.length];
    picked.push(c);
    pickedSources.add(c.source);
    if (picked.length >= max) break;
  }
  if (picked.length < max) {
    const rest = candidates.filter((c) => !pickedSources.has(c.source))
      .sort((a, b) => String(a.source).localeCompare(String(b.source)));
    const start = rest.length ? seed % rest.length : 0;
    for (let i = 0; i < rest.length && picked.length < max; i += 1) {
      picked.push(rest[(start + i) % rest.length]);
    }
  }
  return picked;
}

/** "rated: N total, M this week" — counted at the external gold file,
 *  only rows with a set `verdict`, after {@link goldlog.resolved} (a
 *  correction never counts twice). "this week" = the same ISO week key
 *  as `now` (measurements.isoWeek — one truth for the week concept). */
export function ratedCounts(rowsResolved, { now = new Date(), isoWeek } = {}) {
  const thisWeek = isoWeek(now);
  let total = 0;
  let week = 0;
  for (const r of rowsResolved) {
    if (!r || r.verdict === null || r.verdict === undefined) continue;
    total += 1;
    if (thisWeek && isoWeek(new Date(r.ts)) === thisWeek) week += 1;
  }
  return { total, thisWeek: week };
}

/**
 * Up to {@link GOLD_MAX} UNRATED gold candidates for today, drawn from
 * `src/goldlog.mjs`'s external file (populated by `mem gold today
 * --draw` / `goldlog.draw()`). Read-only — writing is `mem gold rate` /
 * POST /dashboard/gold-verdict.
 *
 * **"not measured: no injection journal" — only when there is truly
 * nothing to draw from** (neither a live journal NOR an already-drawn
 * gold file): an existing gold file stays usable even if the LIVE
 * journal on this machine is not readable right now (archived,
 * different root) — same reasoning as the sibling's goldFragen().
 */
export function goldQuestions(root, { env = process.env, max = GOLD_MAX, now = new Date() } = {}) {
  const filePath = goldlog.targetPath(env);
  let read;
  try { read = goldlog.read(filePath); } catch (e) {
    read = { rows: [], broken: 0, present: false, error: e?.message || String(e) };
  }
  let journalPresent;
  try { journalPresent = injection.read(root).present; } catch { journalPresent = false; }

  let drawn;
  if (!read.present) {
    drawn = !journalPresent
      ? { readable: false, reason: 'not measured: no injection journal' }
      : { readable: false, reason: `no gold file yet at ${filePath} — run \`mem gold today --draw\` (or goldlog.draw()) first` };
  } else {
    drawn = { readable: true, reason: null };
  }

  const resolvedRows = goldlog.resolved(read.rows);
  const unrated = resolvedRows.filter((r) => r.verdict === null);
  const picked = drawn.readable ? pickDaily(unrated, { max, now }) : [];
  const rated = ratedCounts(resolvedRows, { now, isoWeek });

  return {
    filePath, drawn, candidatesTotal: unrated.length, candidates: picked, rated,
  };
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
// (f) Projects awaiting confirmation
// =========================================================================

/**
 * Projects that wait for a person: status `new` (`kind: 'new'`, made with
 * `mem project new`) and projects made past the command (`kind: 'hand'`,
 * `projectnew.handmade`). Read only. Nothing open: `list` is empty and the
 * card shows nothing. Unreadable: `readable: false` with a reason — never
 * an invented 0.
 */
function projectsAwaiting(root) {
  try {
    const list = [];
    for (const name of memory.listProjects(root)) {
      const st = projectnew.projectStatus(root, name);
      if (st.isNew) list.push({ name, kind: 'new', createdOn: st.created_on, createdBy: st.created_by });
    }
    for (const h of projectnew.handmade(root)) {
      list.push({ name: h.name, kind: 'hand', createdOn: String(h.firstEntry ?? '').slice(0, 10) || null, createdBy: null });
    }
    list.sort((a, b) => String(a.createdOn ?? '').localeCompare(String(b.createdOn ?? '')) || a.name.localeCompare(b.name));
    return { readable: true, reason: null, list };
  } catch (e) {
    return { readable: false, reason: `not measurable: projects not readable (${e?.message || e})`, list: [] };
  }
}

// =========================================================================
// Everything together, and the one-line summary
// =========================================================================

/**
 * THE numbers of the day, computed in ONE place. The CLI text, the
 * dashboard card (`result.counts` / `result.line`) and the session-start
 * line all read this object — no surface counts on its own. `null` =
 * not measurable (never 0). `login` is always `null` here: unlike the
 * sibling (`betrieb/betriebs-stand.json` -> `anmeldung`), cheap-mem has
 * no login-state source, and inventing one would be a made-up finding.
 */
export function counts(result) {
  const ops = result.operations;
  return {
    decisions: result.decisions?.readable ? result.decisions.list.length : null,
    login: null,
    operations: ops?.readable ? ops.notable.length : null,
    operationsWorst: ops?.readable ? ops.worst : null,
    verify: result.verify?.readable ? result.verify.list.length : null,
    goldQuestions: (result.gold?.candidates?.length ?? 0) > 0 ? result.gold.candidates.length
      : (result.gold?.drawn?.readable ? 0 : null),
    review: null,
    wordPairs: null,
    projectsAwaiting: result.projects?.readable ? result.projects.list.length : null,
  };
}

export function today(root, { env = process.env, now = new Date(), doctorResult = null } = {}) {
  const ops = operations(root, { doctorResult });
  const decisions = decisionsForHuman(root);
  const verify = verifyCandidates(root, { now });
  const review = reviewSuggestions();
  const wordPairs = wordPairSuggestions();
  const gold = goldQuestions(root, { env, now });
  const projects = projectsAwaiting(root);

  const reasons = [
    ...(ops.readable ? [] : [ops.reason]),
    ...(decisions.readable ? [] : [decisions.reason]),
    ...(verify.readable ? [] : [verify.reason]),
    ...(gold.drawn.readable ? [] : [gold.drawn.reason]),
    ...(projects.readable ? [] : [projects.reason]),
  ];

  const result = {
    at: now.toISOString(),
    // "warning" only for what could not be READ — reviewSuggestions()/
    // wordPairSuggestions() being honestly not-built is a documented
    // gap, not a read failure, so it never lowers this state.
    state: reasons.length ? 'warning' : 'ok',
    reasons,
    login: { readable: false, reason: 'unknown — no login-state source in this house' },
    operations: ops,
    decisions,
    verify,
    gold,
    review,
    wordPairs,
    projects,
    verifyTarget: verifylog.targetPath(env),
  };
  result.counts = counts(result);
  result.line = line(result);
  return result;
}

/** Longest allowed session-start line (characters) — one line stays one line. */
export const LINE_MAX = 120;

/**
 * "Today: 2 decisions open · operations warn · 1 to verify" — ONE line
 * from {@link counts}, counts only (never entry content). What could not
 * be measured says "unknown", never 0. `null` only when everything is
 * measured AND calm. Capped at {@link LINE_MAX}.
 */
export function line(result) {
  const c = result.counts ?? counts(result);
  const parts = [];
  let notable = false;
  if (c.decisions === null) { parts.push('decisions unknown'); notable = true; }
  else if (c.decisions > 0) { parts.push(`${c.decisions} decision${c.decisions === 1 ? '' : 's'} open`); notable = true; }

  if (c.operationsWorst === null) { parts.push('operations unknown'); notable = true; }
  else if (c.operationsWorst === 'error' || c.operationsWorst === 'warn') { parts.push(`operations ${c.operationsWorst}`); notable = true; }

  if (c.verify === null) { parts.push('verify unknown'); notable = true; }
  else if (c.verify > 0) { parts.push(`${c.verify} to verify`); notable = true; }

  if (c.goldQuestions === null) { parts.push('gold questions unknown'); notable = true; }
  else if (c.goldQuestions > 0) { parts.push(`${c.goldQuestions} gold question${c.goldQuestions === 1 ? '' : 's'}`); notable = true; }

  if (c.projectsAwaiting > 0) { parts.push(`${c.projectsAwaiting} project${c.projectsAwaiting === 1 ? '' : 's'} awaiting confirmation`); notable = true; }

  if (!notable || !parts.length) return null;
  const text = `Today: ${parts.join(' · ')}`;
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 1)}…` : text;
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

  lines.push(`LOGIN: ${result.login.reason}`);
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

  lines.push(`GOLD QUESTIONS TO RATE: ${result.gold.drawn.readable ? result.gold.candidates.length : 'unknown'} (of ${result.gold.candidatesTotal} open)`);
  lines.push(`  rated: ${result.gold.rated.total} total, ${result.gold.rated.thisWeek} this week`);
  if (!result.gold.drawn.readable) lines.push(`  ${result.gold.drawn.reason}`);
  for (const c of result.gold.candidates) {
    lines.push(`  [${c.source?.split(':')[1] ?? '?'}] ${c.id}  ${c.question ?? '(no question text known)'}`);
  }
  lines.push('');

  lines.push(`PROJECTS AWAITING CONFIRMATION: ${result.projects?.readable ? result.projects.list.length : 'unknown'}`);
  for (const p of result.projects?.list ?? []) {
    lines.push(`  [${p.kind === 'hand' ? 'by hand' : 'new'}] ${p.name}  `
      + `${p.kind === 'hand' ? '(made past the command, see mem project suggestions)' : `mem project confirm ${p.name}`}`);
  }
  lines.push('');

  lines.push(`REVIEW SUGGESTIONS: ${result.review.reason}`);
  lines.push(`WORD-PAIR SUGGESTIONS: ${result.wordPairs.reason}`);

  return lines.join('\n');
}

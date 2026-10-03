// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard-data.mjs — the data for the dashboard, the one UI.
//
// **What happens here, and what does not.** The dashboard
// (`src/dashboard-page.mjs`, `assets/dashboard/dashboard.js`) is the
// sibling house's Dashboard-Muster-3, ported: the same views, the same
// shapes, English field names, fed by cheap-mem's own sources. This
// module computes NOTHING another module already computes. It calls
// `dashboard.collect()` (the old desk's one pass: board tiles, agents
// with their two liveness signals, the human's tray, the net, the raw
// review, settings, tasks) and lays beside it only what the old desk did
// not carry but the dashboard shows:
//
//   1. a short excerpt per entry, its capture (`origin.raw`) and its
//      validity window, read from the SAME pass (`dashboard.readPass`),
//   2. how often each entry was injected into a session (the injection
//      journal, `src/injection.mjs`) — it carries the brightness of the
//      energy cores in the 3D network,
//   3. the whole inbox as a list without bodies (a body comes one at a
//      time through `/dashboard/message.json`, the same rule the sibling
//      follows: an overview carries no letters),
//   4. the doctor (cached for a minute), the weekly measurement series,
//      the injection usage, the store, the user habits, the job ledger,
//      the invariants, and the command catalogue.
//
// **Not measurable is not null's cousin zero.** Every value that could
// not be read travels as `null` with a reason, never as 0. `recall` on an
// entry stays `null` when the journal is unreadable (unknown) and is
// `{ sessions: 0 }` when it was read and the entry was never injected
// (measured: never).
//
// **Not available in cheap-mem is said out loud.** Three views of the
// sibling have no counterpart here — books (a stored digest volume),
// the digester's per-run yield counters, and the 1M/5M/10M scale gate
// (VM tooling). The owner decided (2026-09-28) that they are SHOWN
// as "not available in cheap-mem", never as an empty list — and, since
// Bauplan Block P (2026-09-29), each WITH the reason it is a difference
// of design, not a gap — see `NOT_AVAILABLE` below. Restore, merge, hook
// time and the live injection view are built (P2-P4).
//
// invariant: drei-zustaende-nie-zwei
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isMainThread, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import * as writegate from './writegate.mjs';
import * as dashboard from './dashboard.mjs';
import * as memory from './memory.mjs';
import { projectStatus } from './projectnew.mjs';
import * as categoriesMod from './categories.mjs';
import * as question from './question.mjs';
import * as inbox from './inbox.mjs';
import * as injection from './injection.mjs';
import * as tasks from './tasks.mjs';
import * as doctor from './doctor.mjs';
import * as measurements from './measurements.mjs';
import * as mcpprofile from './mcpprofile.mjs';
import * as clihelp from './clihelp.mjs';
import * as cfgmod from './config.mjs';
import * as integrity from './integrity.mjs';
import * as agentledger from './agentledger.mjs';
import * as userhabits from './userhabits.mjs';
import * as freshness from './freshness.mjs';
import * as retrieval from './retrieval.mjs';
import * as bodyfields from './bodyfields.mjs';
import * as search from './search.mjs';
import * as capability from './capability.mjs';
import * as viewer from './viewer.mjs';
import * as raw from './raw.mjs';
import * as modelcost from './modelcost.mjs';
import * as effect from './effect.mjs';
import * as today from './today.mjs';
import * as release from './release.mjs';
import * as checkrecord from './checkrecord.mjs';
import * as latencybudget from './latencybudget.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The cheap-mem package itself — where the code, not the memory, lives. */
export const PACKAGE_ROOT = path.join(HERE, '..');

/** The longest excerpt per entry (characters). */
export const EXCERPT_MAX = 220;

/** The singular names of the types, keyed by `memory.TYPES`. */
export const TYPE_NAME = Object.freeze({
  decision: 'Decision',
  error: 'Error',
  event: 'Event',
  timeline: 'Fact',
  thought: 'Thought',
  learning: 'Learning',
  duty: 'Duty',
  question: 'Question',
  skill: 'Skill',
  procedure: 'Procedure',
  source: 'Source',
  update: 'Update',
  link: 'Link',
});

/**
 * The three sibling views with no counterpart here — shown, not hidden
 * (owner decision 2026-09-28, port spec §2 and §6.5).
 */
export const NOT_AVAILABLE = Object.freeze({
  // Explained differences (Bauplan Block P): each says WHY, never just
  // "missing". The built ones (restore, merge, hook time, live injection
  // view) are not in this list any more — they are real functions.
  books: {
    title: 'Books',
    reason: 'Not available in cheap-mem, by design: a book is the sibling\'s stored condensation '
      + 'over many entries, written by a model (its background digest service). Here the recall path uses no model and '
      + 'the logs are the only store — a condensed volume beside them would be a second truth that '
      + 'drifts from the entries. `mem digest` prints a session-start summary and keeps nothing; '
      + 'every entry stays reachable by topic and project.',
  },
  digesterYield: {
    title: 'Digester yield per run',
    reason: 'Not available in cheap-mem, by design: there is no background digest service here — the digest '
      + 'runs by hand or from CI (`mem digest`), so nothing keeps per-run counters (entries '
      + 'rejected, cleaned or dropped by a write guard) or a knowledge-gap register. What IS '
      + 'measured is the doctor\'s digest-yield finding: digested captures that produced no entry.',
  },
  scaleGate: {
    title: 'Scale gate 1M / 5M / 10M',
    reason: 'Not available in cheap-mem, by design: the gate is the sibling\'s VM tooling — a service '
      + 'that builds synthetic memories of 1M/5M/10M entries on one server and times recall. '
      + 'cheap-mem ships empty and never measures a memory that is not yours. Its equivalents: '
      + 'the doctor\'s corpus-size finding (warns at the 50,000-entry sharding line, docs/scale.md), '
      + 'the hook-time finding and the weekly series below, which run on YOUR memory.',
  },
});

function excerpt(s, max = EXCERPT_MAX) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Leave empty fields out — a list of thousands of entries otherwise
 * carries a half megabyte of `null`. `keep` names the fields whose
 * `null` IS a statement (not measurable) and must travel.
 */
function withoutEmpty(o, keep = []) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (keep.includes(k)) { out[k] = v; continue; }
    if (v === null || v === undefined || v === false || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (k === 'cited' && v === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The field that carries an entry's content, in the order a person would read it.
 *
 * The body fields and their order per type come from ONE place,
 * `src/bodyfields.mjs` (O2). Until 2026-09-30 this was a list of its own
 * without `duty`, `skill`, `description`, `steps` and `body` — a duty
 * without `text` showed as an empty card. What stays here is only the
 * fallback for entries with no body field at all: `summary`/`value`
 * (older shapes), then the handles.
 */
export function textOf(e, type = null) {
  if (!e || typeof e !== 'object') return '';
  const main = bodyfields.mainText(e, type);
  if (main.trim()) return main;
  for (const k of ['summary', 'value', 'title', 'topic', 'class']) {
    if (typeof e[k] === 'string' && e[k].trim()) return e[k];
  }
  return '';
}

/** The entry's own validity window, if it declares one. */
function validFromOf(e) { return e?.valid_from ?? null; }
function validUntilOf(e) { return e?.valid_until ?? null; }

/**
 * How often (in how many sessions) each place was injected.
 *
 * The journal names places as `source:line` (the ranked lane and the
 * time lane both write that shape). Counted like the sibling counts its
 * own journal: only lines that really showed something (`reason ===
 * null`), sessions rather than mentions.
 */
export function recallCount(root, { read = injection.read } = {}) {
  let got;
  try { got = read(root); } catch (e) {
    return { measurable: false, reason: `injection journal not readable: ${e?.message || e}`, byPlace: new Map() };
  }
  if (!got?.present) {
    return { measurable: false, absent: true, reason: 'no injection journal on this machine', byPlace: new Map() };
  }
  const byPlace = new Map();
  let since = null;
  let until = null;
  let shown = 0;
  for (const l of got.lines) {
    const ts = String(l?.ts ?? '');
    if (ts && (!since || ts < since)) since = ts;
    if (ts && (!until || ts > until)) until = ts;
    if (l?.reason != null) continue;
    const places = Array.isArray(l?.sources) ? l.sources : [];
    if (!places.length) continue;
    shown += 1;
    for (const p of places) {
      if (typeof p !== 'string' || !p) continue;
      let s = byPlace.get(p);
      if (!s) { s = { sessions: new Set(), mentions: 0, last: null }; byPlace.set(p, s); }
      s.mentions += 1;
      if (l?.session) s.sessions.add(l.session);
      if (ts && (!s.last || ts > s.last)) s.last = ts;
    }
  }
  return { measurable: true, reason: null, byPlace, since, until, rows: got.lines.length, shown, broken: got.broken ?? 0 };
}

/**
 * Usage figures from the same journal: why nothing was injected, by
 * occasion, the bytes, and the last injections that really showed
 * something. `null` where a field was never measured — the journal's
 * `bytes` is `null` for lines booked before the hook rendered its text.
 */
export function usageFromJournal(root, { read = injection.read } = {}) {
  let got;
  try { got = read(root); } catch (e) {
    return { measurable: false, reason: `injection journal not readable: ${e?.message || e}` };
  }
  if (!got?.present) return { measurable: false, reason: 'no injection journal on this machine' };
  const reasons = {};
  const occasions = {};
  const reasonsByOccasion = {};
  let shown = 0;
  let bytesMeasured = 0;
  let bytesSum = 0;
  let searchedMeasured = 0;
  for (const l of got.lines) {
    const r = l?.reason ?? null;
    const o = l?.occasion ?? 'unknown';
    occasions[o] = (occasions[o] ?? 0) + 1;
    if (r === null) {
      shown += 1;
      if (Number.isFinite(l?.bytes)) { bytesMeasured += 1; bytesSum += l.bytes; }
    } else {
      reasons[r] = (reasons[r] ?? 0) + 1;
      if (!reasonsByOccasion[o]) reasonsByOccasion[o] = {};
      reasonsByOccasion[o][r] = (reasonsByOccasion[o][r] ?? 0) + 1;
    }
    if (Number.isFinite(l?.searched)) searchedMeasured += 1;
  }
  const recent = got.lines.filter((l) => l?.reason == null && Array.isArray(l?.sources) && l.sources.length)
    .slice(-40).reverse()
    .map((l) => ({ ts: l.ts ?? null, session: l.session ?? null, occasion: l.occasion ?? null,
      bytes: Number.isFinite(l.bytes) ? l.bytes : null, sources: l.sources.slice(0, 12) }));
  // Live injection view (Bauplan P4): the newest booked lines of EVERY
  // kind — what was injected AND why nothing was — so a quiet hook is
  // told apart from a hook that never ran. Same journal, same lines as
  // above; nothing is recomputed or simulated.
  const live = got.lines.filter((l) => l && typeof l === 'object').slice(-30).reverse()
    .map((l) => ({
      ts: l.ts ?? null, session: typeof l.session === 'string' ? l.session.slice(0, 8) : null,
      occasion: l.occasion ?? null, reason: l.reason ?? null,
      hits: Number.isFinite(l.hits) ? l.hits : null,
      bytes: Number.isFinite(l.bytes) ? l.bytes : null,
      durationMs: Number.isFinite(l.duration_ms) ? l.duration_ms : null,
      searched: Number.isFinite(l.searched) ? l.searched : null,
      sources: Array.isArray(l.sources) ? l.sources.slice(0, 5) : [],
    }));
  return {
    measurable: true,
    rows: got.lines.length,
    shown,
    broken: got.broken ?? 0,
    bytes: { measured: bytesMeasured, sum: bytesSum },
    reasons,
    reasonsByOccasion,
    occasions,
    // Hook time (Bauplan P2): from the timed lines only (`duration_ms`).
    // A line without a duration is not counted as fast — `measured` says
    // how many lines carry one, `null` p50/p95 says "not measurable".
    hookTime: hookTimeOf(got.lines),
    searched: { measured: searchedMeasured },
    recent,
    live,
  };
}

/** Timed-line figures over the whole journal (the judged window is latencybudget's). */
function usageFromJournalHook(root, read, now) {
  try {
    const got = read(root);
    if (!got?.present) return { measured: 0, reason: 'no injection journal on this machine', perDay: [], budget: [], level: 'unknown' };
    return hookTimeOf(got.lines, now);
  } catch (e) {
    return { measured: 0, reason: `injection journal not readable: ${e?.message || e}`, perDay: [], budget: [], level: 'unknown' };
  }
}

function hookTimeOf(lines, now = new Date()) {
  const timed = lines.filter((l) => l && Number.isFinite(l.duration_ms));
  const judged = latencybudget.judgeAll(lines, now);
  const all = timed.map((l) => l.duration_ms);
  return {
    measured: timed.length,
    p50: all.length >= latencybudget.MIN_LINES ? latencybudget.percentile(all, 50) : null,
    p95: all.length >= latencybudget.MIN_LINES ? latencybudget.percentile(all, 95) : null,
    reason: timed.length ? null : 'no journal line carries a duration yet (duration_ms is written by `mem find --journal-session`)',
    perDay: latencybudget.perDay(lines, { now }),
    budget: judged,
    level: latencybudget.worstLevel(judged),
  };
}

/**
 * dash-fix3 parity (part 2a): "Model cost" for Work & Agents -> Usage.
 * Reads ONLY src/modelcost.mjs (the journal rows bin/mem-digest appends
 * on an `--output-format json` run) — nothing is recomputed. With no
 * row at all (a fresh clone, a CLI without the field) this stays
 * explicitly `measurable:false` with a reason — "not measured yet",
 * never the old invented dash.
 */
export function modelCostOverview(root, {
  now = new Date(), sumByCaller = modelcost.sumByCaller,
} = {}) {
  let last7; let last30;
  try {
    last7 = sumByCaller(root, { sinceDays: 7, now });
    last30 = sumByCaller(root, { sinceDays: 30, now });
  } catch (e) {
    return { measurable: false, reason: e?.message || String(e) };
  }
  if (!last7.length && !last30.length) {
    return { measurable: false, reason: `no row in the cost journal yet (${modelcost.LOG})` };
  }
  // Estimate, not a bill (dash-fix3 wording, part 2a): total_cost_usd
  // from the CLI is a model-side estimate for the account's plan.
  return { measurable: true, last7, last30, costLabel: 'estimate, not a bill' };
}

// dash-fix3 parity (part 2b): effect.measure() reads the WHOLE search
// index once per call (loadIndex) — not cheap, and /dashboard.json is
// polled often. A few minutes of cache, per root, exactly like the MCP
// live probe (src/mcplive.mjs) for the same reason.
const EFFECT_TTL_MS = 5 * 60 * 1000;
const effectCache = new Map(); // root -> { until, result }

/** Tests only: clear the effect cache. */
export function _clearEffectCache() { effectCache.clear(); }

/**
 * dash-fix3 parity (part 2b): "Application" for Work & Agents -> Usage.
 * Previously always "unknown" — not measured, only written that way.
 * `effect.measure()` (M5) really asks whether an injected place was
 * named again afterwards — but ONLY when the injection journal itself
 * is readable (`journalMeasurable`, the SAME precondition
 * `usage.measurable` on this page already needs: without a journal
 * there is no shown-place to ask about at all). A machine with no
 * processed capture yet is explicitly "not measurable HERE" (sounds
 * like: elsewhere it would be), never "no such telemetry" (sounds
 * like: does not exist at all).
 */
export function effectOverview(root, {
  now = new Date(), measure = effect.measure, journalMeasurable, ttlMs = EFFECT_TTL_MS,
} = {}) {
  if (!journalMeasurable) {
    return { measurable: false, reason: 'not measurable here — no injection journal on this machine' };
  }
  const nowMs = new Date(now).getTime();
  const cached = effectCache.get(root);
  if (cached && cached.until > nowMs) return cached.result;
  let result;
  try {
    const r = measure(root);
    result = r.state === effect.STATE.MEASURED
      ? { measurable: true, state: r.state, n: r.n, used: r.used, rate: r.rate, wilson: r.wilson, minPairs: r.minPairs }
      : {
        measurable: false, state: r.state, n: r.n, minPairs: r.minPairs,
        reason: r.state === effect.STATE.NO_DATA
          ? 'no injection on record yet'
          : `not enough measurable pairs yet (${r.n} of ${r.minPairs} needed)`,
      };
  } catch (e) {
    result = { measurable: false, reason: e?.message || String(e) };
  }
  effectCache.set(root, { until: nowMs + ttlMs, result });
  return result;
}

/** The commands the CLI dispatches, read from the group modules themselves. */
export function cliCommands(pkgRoot = PACKAGE_ROOT) {
  try {
    const names = clihelp.allTableCommands((rel) => fs.readFileSync(path.join(pkgRoot, rel), 'utf8'));
    return names.length ? names : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------
// The doctor, cached for a minute — the sibling's `doctorState` shape.
// ---------------------------------------------------------------------

export const DOCTOR_TTL_MS = 60 * 1000;
const DOCTOR_CACHE = new Map();

/** `{ result, computedAt, ageMin, fromCache }`, or `{ result:null, reason }`. */
export function doctorState(root, { now = new Date(), check = doctor.checkAll, ttlMs = DOCTOR_TTL_MS } = {}) {
  const key = path.resolve(root);
  const hit = DOCTOR_CACHE.get(key);
  if (hit && now.getTime() - hit.at < ttlMs) {
    return { result: hit.result, computedAt: new Date(hit.at).toISOString(), ageMin: (now.getTime() - hit.at) / 60000, fromCache: true };
  }
  let result;
  try { result = check(root); } catch (e) {
    return { result: null, reason: `doctor could not run: ${e?.message || e}`, computedAt: null, ageMin: null, fromCache: false };
  }
  DOCTOR_CACHE.set(key, { at: now.getTime(), result });
  return { result, computedAt: now.toISOString(), ageMin: 0, fromCache: false };
}

/** One doctor finding by name, or `null` when the doctor did not report it. */
function findingNamed(state, name) {
  const list = state?.result?.findings;
  if (!Array.isArray(list)) return null;
  return list.find((f) => f?.name === name) ?? null;
}

// ---------------------------------------------------------------------
// Pieces the old desk did not carry
// ---------------------------------------------------------------------

/** The whole inbox, every recipient, without bodies. */
function inboxList(root, now) {
  let participants = null;
  let cfgReason = null;
  try { participants = cfgmod.readConfig(root).participants ?? null; } catch (e) { cfgReason = e?.message || String(e); }
  let got;
  try { got = inbox.read(root, participants ?? {}, {}); } catch (e) {
    return { readable: false, reason: `inbox not readable: ${e?.message || e}`, messages: [], participants: [], broken: [] };
  }
  const nowMs = now.getTime();
  const messages = got.messages.map((m) => {
    const t = Date.parse(m.time ?? '');
    const ageMin = Number.isFinite(t) ? (nowMs - t) / 60000 : null;
    const done = inbox.isDone(m.state);
    // Three situations: done, waiting too long (older than 48 h and not
    // done), open. The same line the sibling draws.
    const situation = done ? 'done' : (ageMin ?? 0) >= 48 * 60 ? 'waiting' : 'open';
    return {
      name: m.name, from: m.from ?? null, to: m.to ?? null, subject: m.subject || '(no subject)',
      state: m.state ?? inbox.STATE.OPEN, time: Number.isFinite(t) ? new Date(t).toISOString() : null,
      ageMin, situation, requestId: m.requestId ?? null,
    };
  }).sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
  const names = participants && typeof participants === 'object' ? Object.keys(participants).sort() : [];
  let human = null;
  let humanReason = null;
  try {
    const hp = cfgmod.humanParticipant(participants);
    human = hp.name ?? null;
    humanReason = hp.reason ?? null;
  } catch (e) { humanReason = e?.message || String(e); }
  let me = null;
  try { me = inbox.whoAmI(root); } catch { me = null; }
  return {
    readable: true,
    present: got.dir !== null,
    reason: cfgReason,
    me,
    human,
    humanReason,
    participants: names.map((name) => ({ name })),
    states: Object.values(inbox.STATE),
    messages,
    broken: got.broken.map((b) => ({ name: b.name, reason: b.reason })),
    duplicates: (got.duplicates ?? []).map((d) => ({
      name: d.name, duplicateOf: d.duplicateOf, sameText: d.sameText, requestId: d.requestId ?? null,
    })),
  };
}

/** One message, whole, and the replies that point at it by subject. Read-only. */
export function messageWhole(root, name) {
  let participants = {};
  try { participants = cfgmod.readConfig(root).participants ?? {}; } catch { participants = {}; }
  const text = inbox.readMessage(root, name);
  const m = inbox.parse(text);
  const all = inbox.read(root, participants, {}).messages;
  const replySubject = inbox.replySubject(m.subject);
  const replies = all.filter((x) => x.name !== name && x.subject === replySubject
    && x.from === m.to && x.to === m.from)
    .map((x) => ({ name: x.name, from: x.from, to: x.to, subject: x.subject, state: x.state, time: x.time, text: x.text }));
  let human = null;
  try { human = cfgmod.humanParticipant(participants).name ?? null; } catch { human = null; }
  return { state: 'ok', message: { name, ...m, done: inbox.isDone(m.state) }, replies, human };
}

/** Per project: which drawers are filled, empty, missing — and its companion files. */
function projectShelf(root) {
  const types = Object.keys(memory.TYPES);
  const out = [];
  for (const project of memory.listProjects(root)) {
    let filled = 0; let empty = 0; let missing = 0;
    for (const t of types) {
      const file = memory.logPath(root, t, project);
      let st = null;
      try { st = fs.statSync(file); } catch { st = null; }
      if (!st) missing += 1; else if (st.size === 0) empty += 1; else filled += 1;
    }
    const dir = path.dirname(memory.logPath(root, 'decision', project));
    let files = [];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile() && !d.name.endsWith('.jsonl'))
        .map((d) => ({ name: d.name, where: 'present' }));
    } catch { files = []; }
    // `isNew`: created by an agent or the digest and not yet confirmed by a
    // person (facts.yaml `status: new`, src/projectnew.mjs). Old projects: false.
    const st = projectStatus(root, project);
    out.push({
      name: project, filled, empty, missing, drawersTotal: types.length, files,
      isNew: st.isNew, createdOn: st.created_on, createdBy: st.created_by,
    });
  }
  return { projects: out };
}

/** The measured git state of the CODE (the package), at start and now. */
// A background build runs in a worker that imports this module FRESH, so
// evaluating the head here would give the worker's own start, never the
// server's: `stale` could then never be true on that path. The server
// hands its start head over through `workerData`; only a process that
// was given none measures its own.
const CODE_HEAD_AT_START = (!isMainThread && workerData && 'codeHeadAtStart' in workerData)
  ? workerData.codeHeadAtStart
  : gitHead(PACKAGE_ROOT);
/** The code's git head when THIS server process started (handed to workers). */
export function codeHeadAtStart() { return CODE_HEAD_AT_START; }
function gitHead(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 4000 });
    return r.status === 0 ? String(r.stdout).trim() || null : null;
  } catch { return null; }
}
export function codeState() {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? null; } catch { version = null; }
  const headNow = gitHead(PACKAGE_ROOT);
  return {
    version,
    headAtStart: CODE_HEAD_AT_START,
    headNow,
    // Only a stated difference is "stale"; two unknowns are not.
    stale: Boolean(CODE_HEAD_AT_START && headNow && CODE_HEAD_AT_START !== headNow),
  };
}

/**
 * The release rail's own state (Bauplan P1, `src/release.mjs`) — real
 * reads, four states, never the old "not available in cheap-mem": a
 * fresh install (nobody ever ran `mem-release create`) reads `unknown`
 * with "unknown — no release yet", not an empty panel.
 */
export function releaseState(env = process.env) {
  let cur;
  try { cur = release.currentState(PACKAGE_ROOT, { env }); }
  catch (e) { return { state: 'unknown', readable: false, reason: `release state not readable: ${e?.message || e}` }; }
  if (!cur.readable) {
    return {
      state: cur.reason === 'unknown — no release yet' ? 'unknown' : 'error',
      readable: false,
      reason: cur.reason,
    };
  }
  const headNow = gitHead(PACKAGE_ROOT); // short hash of the LIVE checkout, same measurement as versions.code
  const commit = typeof cur.commit === 'string' ? cur.commit : null;
  const stale = Boolean(headNow && commit && !commit.startsWith(headNow));
  const state = !cur.proven ? 'warn' : (stale ? 'warn' : 'good');
  return {
    state,
    readable: true,
    commit,
    kurzhash: cur.kurzhash ?? null,
    tree: cur.tree ?? null,
    createdAt: cur.createdAt ?? null,
    proven: Boolean(cur.proven),
    proofKind: cur.proofKind ?? null,
    path: cur.path ?? null,
    stale,
    reason: !cur.proven
      ? 'this release was created with --allow-unproven — forced, unverified.'
      : stale
        ? `the code on disk has moved past this release (now ${headNow ?? 'unknown'}) — run \`mem-release create\` to refresh it.`
        : null,
  };
}

/**
 * The last recorded green suite run (Bauplan P1, `src/checkrecord.mjs`,
 * `checked.jsonl`) — real reads, four states. A fresh install (nobody
 * ever ran `bin/mem-check-record`) reads `unknown` with the same
 * "unknown — no release yet" phrase the release panel uses: a check
 * record is what makes a release possible in the first place, so an
 * absent one IS "no release yet" from this reader's point of view too.
 */
export function checkRecordState(env = process.env) {
  const target = checkrecord.recordPath(PACKAGE_ROOT, env);
  let text;
  try { text = fs.readFileSync(target, 'utf8'); } catch {
    return { state: 'unknown', readable: false, reason: 'unknown — no release yet' };
  }
  const rawLines = text.split('\n').filter((l) => l.trim()).length;
  const rows = checkrecord.parseRecords(text);
  if (!rows.length) {
    return {
      state: rawLines ? 'error' : 'unknown',
      readable: false,
      reason: rawLines ? `checked.jsonl has ${rawLines} line(s) but none parse` : 'unknown — no release yet',
    };
  }
  const last = rows[rows.length - 1];
  const broken = Math.max(0, rawLines - rows.length);
  let headTree = null;
  try { headTree = checkrecord.treeHash(PACKAGE_ROOT); } catch { headTree = null; }
  const matches = headTree != null && last.tree === headTree;
  return {
    state: matches ? 'good' : 'warn',
    readable: true,
    tree: last.tree ?? null,
    commit: last.commit ?? null,
    tests: last.tests ?? null,
    passed: last.passed ?? null,
    failed: last.failed ?? 0,
    ts: last.ts ?? null,
    machine: last.machine ?? null,
    house: last.house ?? null,
    broken,
    matchesCurrentTree: matches,
    reason: matches
      ? (broken ? `${broken} broken line(s) elsewhere in the ledger` : null)
      : 'the last recorded check does not match the current code tree — run `bin/mem-check-record` again.',
  };
}

/** The invariants this house keeps with its sibling, and the doctor's parity finding. */
function invariantsState(doc) {
  const file = path.join(PACKAGE_ROOT, 'shared', 'invariants.jsonl');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return { measurable: false, reason: `shared/invariants.jsonl not readable: ${e?.message || e}` };
  }
  const ids = [];
  let broken = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o?.id) ids.push(o.id); } catch { broken += 1; }
  }
  return {
    measurable: true,
    count: ids.length,
    broken,
    ids,
    parity: findingNamed(doc, 'finding-parity'),
  };
}

/** The types with display names — one place for the build, the placeholder and the light head. */
export function typesList() {
  return Object.keys(memory.TYPES).map((type) => ({ type, name: TYPE_NAME[type] ?? type, label: viewer.TYPE_LABEL[type] ?? type }));
}

/**
 * The first answer while NOTHING is built yet (board-tempo-cm): a cold start
 * without a stored head on a large store. No counter, no list — only the
 * honest state "unknown" with a reason; the page asks again until the
 * background build is done (src/dashboard-cache.mjs).
 */
export function placeholder({ title = 'cheap-mem', writesAllowed = false } = {}) {
  const reason = 'The first build since the start is running in the background; no stored state yet. Nothing here is measured.';
  return {
    state: 'unknown',
    placeholder: true,
    reasons: [reason],
    at: null,
    meta: { title, writesAllowed, git: {}, inventory: null, entriesTotal: null },
    types: typesList(),
    entries: [],
    overview: null,
    inbox: { readable: false, reason: 'not built yet', error: 'not built yet' },
    raw: { readable: false, reason: 'not built yet', error: 'not built yet' },
    parts: {},
  };
}

function safe(fn, what) {
  try { return { readable: true, ...fn() }; } catch (e) {
    return { readable: false, reason: `${what} not measurable: ${e?.message || e}` };
  }
}

/**
 * One entry of `/dashboard.json`, from the row of `dashboard.collect()` (`z`),
 * the raw line (`e`, or null when there is none) and its injection count.
 * Shared with the pages of the condensed atlas (bin/mem-serve), which hold
 * the same rows without a raw line.
 */
export function entryRow(z, e, count, capture = z.capture ?? null, aliases = null) {
  // dash-paket-cm: the entry's topic (alias-resolved), so the Topics page can filter a thread.
  const rawTopic = typeof e?.topic === 'string' ? e.topic.trim() : '';
  return withoutEmpty({
    id: z.id,
    type: z.type,
    title: z.headline || z.id,
    // X3b: rule status (proposed/trial/withdrawn); absent otherwise.
    status: z.status ?? null,
    project: z.project || 'global',
    tags: z.tags ?? [],
    topic: rawTopic ? (aliases?.get(rawTopic) ?? rawTopic) : null,
    ts: z.ts ?? null,
    agent: z.author ?? (e?.agent ?? null),
    state: z.retired?.state ?? 'active',
    why: z.retired?.why ?? null,
    out: (z.links ?? []).map((l) => [l.kind, l.id, l.known ? 1 : 0]),
    text: e ? excerpt(textOf(e, z.type)) : null,
    source: z.source ?? null,
    line: z.line ?? null,
    readable: Boolean(z.readable),
    cited: z.cited ?? 0,
    contested: Boolean(z.contested),
    replaces: z.replaces ?? null,
    capture,
    validFrom: validFromOf(e),
    validUntil: validUntilOf(e),
    fact: e && (e.value != null || e.fact != null) ? excerpt(String(e.value ?? e.fact), 240) : null,
    key: e?.key ?? null,
    basis: z.basis ?? null,
    authority: z.authority ?? null,
    scope: z.scope ?? null,
    derivedFrom: z.derivedFrom ?? [],
    // `recall` ALWAYS travels, `null` included: missing would read as
    // "never shown" and "not measurable" at once.
    recall: count,
  }, ['recall']);
}

/**
 * Everything for `/dashboard.json`.
 *
 * `collect` is injectable so a probe can run without the full desk pass;
 * in service it is `dashboard.collect`.
 */
export function collectDashboard(root, {
  env = process.env, now = new Date(), cfg = {}, title = 'cheap-mem', writesAllowed = false,
  collect = dashboard.collect, readPass = dashboard.readPass, readJournal = injection.read,
  doctorCheck = doctor.checkAll,
  // The compact build (src/dashboard-compact.mjs) answers these from its single
  // pass or marks them unknown; in service they read the whole store.
  dutiesOpen = memory.openDuties, questionsOpen = question.open,
  todayOf = today.today, integrityOf = integrity.scanIntegrity,
} = {}) {
  const d = collect(root, { env, now, cfg });
  const reasons = [];

  // --- 1. excerpt, capture and validity per entry, from one pass ---------
  const rawById = new Map();
  let pass = { rows: [], broken: 0 };
  try { pass = readPass(root); } catch (e) { reasons.push(`drawers not readable: ${e?.message || e}`); }
  for (const { entry } of pass.rows) if (entry?.id && !rawById.has(entry.id)) rawById.set(entry.id, entry);

  // --- 2. the injection journal ------------------------------------------
  // An ABSENT journal (nothing was ever injected on this machine — a
  // fresh install) is not an unreadable one: the brightness stays "not
  // measurable", but completeness of the drawers is not in doubt. Only a
  // journal that exists and cannot be read joins `reasons`.
  const recall = recallCount(root, { read: readJournal });
  if (!recall.measurable && !recall.absent) reasons.push(recall.reason);

  const topicsByCapture = new Map();
  const entriesByCapture = new Map();

  let topicAliases = new Map();
  try { topicAliases = memory.topicAliases(root); } catch { /* without aliases: the raw name */ }
  const entries = d.entries.map((z) => {
    const e = rawById.get(z.id) ?? null;
    let count = null;
    if (recall.measurable) {
      const place = z.source && z.line ? recall.byPlace.get(`${z.source}:${z.line}`) : null;
      count = { sessions: place ? place.sessions.size : 0, mentions: place ? place.mentions : 0, last: place ? place.last : null };
    }
    const capture = typeof e?.origin?.raw === 'string' ? e.origin.raw : null;
    if (capture) {
      if (!topicsByCapture.has(capture)) topicsByCapture.set(capture, new Set());
      for (const t of z.tags ?? []) topicsByCapture.get(capture).add(t);
      if (e?.topic) topicsByCapture.get(capture).add(String(e.topic));
      entriesByCapture.set(capture, [...(entriesByCapture.get(capture) ?? []), z.id]);
    }
    return entryRow(z, e, count, capture, topicAliases);
  });

  // --- 3. work: what is open is decided by memory/question, not here ----
  const openDuties = [];
  const openQuestions = [];
  try {
    for (const p of dutiesOpen(root).open) {
      if (p?.id) openDuties.push({ id: p.id, who: p.who ?? p.owner ?? p.to ?? null, due: p.due ?? p.by ?? null });
    }
  } catch (e) { reasons.push(`duties not readable: ${e?.message || e}`); }
  try {
    for (const q of questionsOpen(root)) if (q?.id) openQuestions.push({ id: q.id });
  } catch (e) { reasons.push(`questions not readable: ${e?.message || e}`); }

  // --- 4. the raw capture: the old desk's four-state review + topics ------
  const rawCounts = d.raw.counts;
  const rawOut = d.raw.readable
    ? {
      readable: true,
      error: null,
      counts: rawCounts,
      bytes: d.raw.captures.reduce((n, r) => n + (r.bytes ?? 0), 0),
      projects: [...d.raw.captures.reduce((m, r) => m.set(r.project ?? null, (m.get(r.project ?? null) ?? 0) + 1), new Map())]
        .map(([project, count]) => ({ project, count })),
      captures: d.raw.captures.map((r) => ({
        path: r.path, state: r.state, at: r.at ?? null, project: r.project ?? null,
        surface: r.surface ?? null, session: r.session ?? null, lines: r.lines ?? null,
        bytes: r.bytes ?? null, deleted: r.deleted ?? null,
        topics: [...(topicsByCapture.get(r.path) ?? [])].slice(0, 12),
        entries: entriesByCapture.get(r.path) ?? [],
      })),
    }
    : { readable: false, error: d.raw.error, counts: rawCounts, captures: [] };

  // --- 5. the doctor, cached --------------------------------------------
  const doc = doctorState(root, { now, check: doctorCheck });
  if (!doc.result) reasons.push(doc.reason);

  // N8/N21 parity: "Today" — one source, read here (dashboard card),
  // by `mem today`, and by the session-start line — see src/today.mjs.
  // Reuses the doctor result already computed above instead of running
  // doctor.checkAll() a second time.
  let todayResult;
  try { todayResult = todayOf(root, { env, now, doctorResult: doc.result }); } catch (e) {
    todayResult = { state: 'unknown', reasons: [`today() failed: ${e?.message || e}`] };
  }

  // --- 6. tasks: kinds and what runs --------------------------------------
  const kinds = {};
  for (const [k, spec] of Object.entries(tasks.KINDS)) {
    kinds[k] = { title: spec.title, description: spec.description, resume: spec.resume, params: spec.params ? Object.keys(spec.params) : [] };
  }
  let running = {};
  try { running = tasks.overview(root); } catch (e) { reasons.push(`tasks not readable: ${e?.message || e}`); }

  // --- 7. the catalogue, from living counters -----------------------------
  const cli = cliCommands();

  // --- 8. store, user habits, job ledger — each unknown-capable -----------
  const lenses = d.lenses ?? {};
  const st = lenses.storeState;
  const store = st
    ? {
      readable: true,
      entries: (lenses.store ?? []).slice(0, 40).map((z) => ({
        name: z.name ?? null, ts: z.ts ?? null, size: z.size ?? null, purpose: z.purpose ?? null,
        agent: z.agent ?? null, deleted: z.deleted_at ?? null, reason: z.delete_reason ?? null,
        checked: z.checked ?? null, sha: String(z.sha256 ?? '').slice(0, 12),
      })),
      registered: st.registered, deleted: st.deleted, bytes: st.bytes, unchecked: st.unchecked,
      missing: (st.missing ?? []).length, changed: (st.changed ?? []).length, orphans: (st.orphans ?? []).length,
    }
    : { readable: false, reason: 'store register not readable' };
  const user = safe(() => {
    const a = userhabits.analyze(root, { timeCapMs: 400 });
    return {
      capturesReadable: a.capturesReadable, capturesUnreadable: a.capturesUnreadable,
      total: a.total, reason: a.reason ?? null,
      observations: a.observations.map((o) => ({ id: o.id, title: o.title, state: o.state, count: o.count ?? null })),
    };
  }, 'user habits');
  const ledger = safe(() => {
    const l = agentledger.ledger(root);
    return { rows: l.rows, totalJobs: l.totalJobs, unassigned: l.unassigned, confirmed: l.confirmed, rework: l.rework, unknown: l.unknown, unknownShare: l.unknownShare };
  }, 'job ledger');

  // --- 9. versions, integrity, performance --------------------------------
  const versions = {
    code: codeState(),
    hookState: findingNamed(doc, 'stop-hook'),
    release: releaseState(env),
    checkRecord: checkRecordState(env),
  };
  const integrityState = safe(() => {
    const s = integrityOf(root);
    return {
      lines: s.lines, entries: s.entries, broken: s.broken.length, badTimestamp: s.badTimestamp.length,
      duplicateIds: s.duplicateIds.length, replacement: {
        missing: s.replacement.missing.length, cycles: s.replacement.cycles.length,
        forks: s.replacement.forks.length, maxDepth: s.replacement.maxDepth,
      },
      chain: { state: s.chain.state, filesChecked: s.chain.filesChecked, sealsFound: s.chain.sealsFound,
        tampered: s.chain.tampered.length, unsealed: s.chain.unsealed.length },
    };
  }, 'integrity scan');
  const performance = {
    weeks: measurements.read(root),
    metrics: measurements.METRICS,
    hook: { ...usageFromJournalHook(root, readJournal, now), finding: findingNamed(doc, 'hook-latency') },
    gate: { readable: false, reason: NOT_AVAILABLE.scaleGate.reason },
  };

  // --- 10. workspace: names come from the config, never from code --------
  let cfgName = null;
  let human = null;
  try {
    const c = cfgmod.readConfig(root);
    cfgName = c.name ?? null;
    human = cfgmod.humanParticipant(c.participants).name ?? null;
  } catch { /* stays null: shown as "not configured" */ }
  const workspace = { name: cfgName || lenses.name || path.basename(path.resolve(root)), human };

  // --- 11. the digest bell and the human's tray, for the agents view -----
  let bell;
  try {
    const b = raw.bellState(root);
    bell = { checkable: true, rung: Boolean(b), last: b?.last ?? null, reason: b?.reason ?? null };
  } catch (e) { bell = { checkable: false, reason: e?.message || String(e) }; }
  const tray = d.humanInbox?.readable
    ? (() => {
      const open = d.humanInbox.messages.filter((m) => !inbox.isDone(m.state));
      const oldest = open.map((m) => Date.parse(m.time)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      return { checkable: true, who: d.humanInbox.who, count: open.length, oldestMin: oldest ? (now.getTime() - oldest) / 60000 : null };
    })()
    : { checkable: false, reason: d.humanInbox?.reason ?? 'no human participant configured' };

  const usage = usageFromJournal(root, { read: readJournal });
  // dash-fix3 parity: these are their OWN sources (the cost journal /
  // effect.measure()), only laid BESIDE the injection-journal usage
  // figures above — not recomputed from them.
  usage.modelCost = modelCostOverview(root, { now });
  usage.effect = effectOverview(root, { now, journalMeasurable: usage.measurable });

  return {
    state: reasons.length ? 'warning' : 'ok',
    reasons,
    at: now.toISOString(),
    meta: {
      title,
      writesAllowed,
      // The switch, and — whenever it is not on — the two ways to turn it
      // on, in words (the old console said them; the dashboard does too).
      writes: d.writes ? { ...d.writes, howTo: d.writes.state === 'on' || d.writes.source === 'readonly' ? null : writegate.HOW_TO } : d.writes,
      git: d.git,
      code: versions.code,
      inventory: d.inventory,
      // **The canonical "entries total"** — `console.inventory()`, the
      // same number the old desk and `mem board` show. NOT the same as
      // `entries.length` below, which is the full history list for the
      // view (retired ones included, marked).
      entriesTotal: Number.isFinite(d.inventory?.total) ? d.inventory.total : null,
      workspace,
      root: d.root,
    },
    types: typesList(),
    today: todayResult,
    entries,
    brokenLines: pass.broken,
    recall: recall.measurable
      ? { measurable: true, since: recall.since, until: recall.until, rows: recall.rows, shown: recall.shown }
      : { measurable: false, reason: recall.reason },
    net: {
      boxes: d.net.boxes, pairs: d.net.pairs, links: d.net.links, dangling: d.net.dangling,
      layers: d.net.layers,
      // Derived links (src/netderive.mjs): auto ones drawn dashed, borderline ones listed for review.
      derived: d.net.derived ?? { unknown: true, reason: 'not computed' },
    },
    work: d.work,
    openDuties,
    openQuestions,
    agents: d.agents,
    bell,
    humanTray: tray,
    humanInbox: d.humanInbox,
    inbox: inboxList(root, now),
    projects: d.projects,
    projectShelf: projectShelf(root),
    raw: rawOut,
    digester: { ...NOT_AVAILABLE.digesterYield, available: false, yieldFinding: findingNamed(doc, 'digest-yield') },
    notAvailable: NOT_AVAILABLE,
    versions,
    integrity: integrityState,
    performance,
    doctor: doc,
    system: d.system,
    attention: d.attention,
    invariants: invariantsState(doc),
    settings: d.settings,
    log: d.log,
    connections: d.connections,
    setup: d.setup,
    stores: d.stores,
    facts: d.facts,
    tasks: { kinds, running },
    usage,
    store,
    user,
    ledger,
    topics: { list: lenses.topics ?? [], areas: lenses.areas ?? [], quality: lenses.quality ?? null },
    // Categories above topics (src/categories.mjs): contract in categoriesState().
    categories: categoriesState(root),
    experiences: lenses.experiences ?? [],
    links: lenses.links ?? [],
    catalog: {
      cli: cli ?? null,
      cliReason: cli ? null : 'the CLI group modules were not readable',
      mcp: { reading: [...mcpprofile.READING], writing: [...mcpprofile.WRITING] },
      findings: Array.isArray(doc.result?.findings) ? doc.result.findings.length : null,
    },
  };
}

/**
 * The categories view for the dashboard:
 * `{list, topics, unassigned, proposals, new, wishes, threshold}`.
 * `list`: [{key, label, status automatic|confirmed, source, topics, entries}];
 * `topics`: [{topic, count, category: {key, label, status confirmed|proposal, source} | null}];
 * `unassigned`: {topics, entries, names}; `proposals`: [{topic, category, label, source}];
 * `new`: [{key, label}] (created automatically, not yet acknowledged);
 * `wishes`: [{key, label, topics}] (below the threshold). Read only; never throws
 * (a read error becomes `{error}`). A memory that ships empty: all lists empty.
 */
function categoriesState(root, { topicList } = {}) {
  try {
    return categoriesMod.view(root, topicList ? { topicList } : {});
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

/**
 * The categories view LIVE on top of a stored state (cat-confirm-cm, 2026-10-03). The cache holds
 * `categories` until the next build; a click (confirm, assign ...) used to be invisible after a reload
 * for up to a minute and more. Computed from the four small category logs only; the topic list (name,
 * count) stays that of the stored state. Without a usable stored state it comes back unchanged.
 */
export function categoriesLive(root, stored) {
  if (!stored || stored.error || !Array.isArray(stored.topics)) return stored;
  const live = categoriesState(root, { topicList: stored.topics.map((t) => ({ topic: t.topic, count: t.count })) });
  return live.error ? stored : live;
}

/** Stamp of the files `categoriesLive` reads: a change in any of them changes the answer. */
export function categoriesStamp(root) {
  return [...Object.values(memory.CATEGORY_TABLES), memory.ALIAS_LOG].map((rel) => {
    try { const s = fs.statSync(path.join(root, rel)); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; }
  }).join('|');
}

/**
 * One entry whole, for the dashboard's detail drawer: the card from
 * `dashboard.getEntryFast()` (state, backlink index — the same path as
 * `/entry.json`) plus the RAW line, so the full text and the raw fields
 * are visible. Read-only.
 */
export function entryWhole(root, id, { getCard = dashboard.getEntryFast } = {}) {
  const card = getCard(root, id);
  if (card.state === 'unknown' || card.state === 'error') return card;
  let rawLine = null;
  try { rawLine = memory.getEntry(root, id) ?? null; } catch { rawLine = null; }
  return { ...card, raw: rawLine, text: rawLine ? textOf(rawLine, card.type ?? null) : null };
}

// ---------------------------------------------------------------------
// knowledge/facts: "what did the memory know on day X about day Y".
// Real bitemporality over the `timeline` drawer: `valid_from` (when a
// version holds) and `ts` (when the line was written — "known on").
// ---------------------------------------------------------------------

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function factsAt(root, { known, valid } = {}, { readAll = null } = {}) {
  const knownDay = String(known ?? '').trim();
  const validDay = String(valid ?? '').trim();
  if (!DAY.test(knownDay) || !DAY.test(validDay)) {
    return { state: 'error', reason: 'known/valid missing or not a date (YYYY-MM-DD)' };
  }
  const knownUntilMs = Date.parse(`${knownDay}T23:59:59.999Z`);
  const validUntilMs = Date.parse(`${validDay}T23:59:59.999Z`);

  let rows;
  try {
    rows = readAll ? readAll() : (() => {
      const out = [];
      for (const project of [null, ...memory.listProjects(root)]) {
        let res;
        try { res = memory.readLog(root, 'timeline', { project }); } catch { continue; }
        res.entries.forEach((e, i) => {
          if (e.__broken) return;
          out.push({ ...e, _source: memory.asSource(root, memory.logPath(root, 'timeline', project)), _line: i + 1 });
        });
      }
      return out;
    })();
  } catch (e) {
    return { state: 'error', reason: `timeline not readable: ${e?.message || e}` };
  }

  const knownMs = (e) => (e?.ts ? Date.parse(e.ts) : NaN);
  const validMs = (e) => Date.parse(e?.valid_from ?? e?.ts ?? '') || NaN;
  const untilMs = (e) => (e?.valid_until ? Date.parse(e.valid_until) : null);

  const knownThen = rows.filter((e) => Number.isFinite(knownMs(e)) && knownMs(e) <= knownUntilMs);
  // Ids a correction already known by `known` had replaced.
  const replaced = new Set(knownThen.map((e) => e.replaces_id).filter(Boolean));

  const groups = new Map();
  const single = [];
  for (const e of knownThen) {
    if (e.id && replaced.has(e.id)) continue;
    if (e.closes_id || e.retires_id) continue;
    const wms = validMs(e);
    if (!Number.isFinite(wms) || wms > validUntilMs) continue;
    const until = untilMs(e);
    if (Number.isFinite(until) && until <= validUntilMs) continue;
    const k = freshness.subjectKey(e);
    if (!k) { single.push(e); continue; }
    const before = groups.get(k);
    if (!before || wms > before.wms) groups.set(k, { e, wms });
  }
  const holds = [...single, ...[...groups.values()].map((g) => g.e)]
    .sort((a, b) => validMs(b) - validMs(a));

  return {
    state: 'ok',
    known: knownDay,
    valid: validDay,
    factsTotal: rows.length,
    writtenByThen: knownThen.length,
    withoutOwnValidity: holds.filter((e) => e.valid_from == null).length,
    holds: holds.map((e) => ({
      id: e.id ?? null,
      key: freshness.subjectKey(e) ?? null,
      title: excerpt(e.title || `${e.key ?? ''}${e.key ? ' = ' : ''}${e.value ?? e.fact ?? textOf(e, 'timeline')}`, 160) || e.id,
      value: e.value ?? e.fact ?? null,
      validFrom: e.valid_from ?? null,
      ts: e.ts ?? null,
      source: e._source ?? null,
      line: e._line ?? null,
    })),
  };
}

// ---------------------------------------------------------------------
// The retrieval probe: what `mem retrieve` answers for a question, now.
// Read-only: the question is not stored, not journaled, not observed
// (`observations.record` is deliberately NOT called, unlike the CLI).
// ---------------------------------------------------------------------

export function retrievalProbe(root, questionText, {
  top = 10, retrieve = retrieval.retrieve, loadIndex = search.loadIndex,
} = {}) {
  const q = String(questionText ?? '').trim();
  if (!q) return { state: 'error', reason: 'no question' };
  let r;
  let wildcardNotes = [];
  try {
    // The `word*` prefix operator: a MANUAL feature of this probe, not
    // of the gateway it calls. This is the person at the dashboard
    // typing a question by hand — same status as `mem find` — not the
    // automatic retrieval hook, which calls `retrieval.retrieve()`
    // directly and never resolves a `*` at all. See
    // `search.resolveWildcards()`'s doc comment.
    let query = q;
    let extraTerms = null;
    if (q.includes('*')) {
      const idx = loadIndex(root);
      const resolved = search.resolveWildcards(idx, q);
      query = resolved.query;
      extraTerms = resolved.extraTerms;
      wildcardNotes = resolved.notes;
    }
    r = retrieve(root, query, capability.grantAll('dashboard-probe'), { top, extraTerms });
  } catch (e) {
    return { state: 'error', reason: e?.message || String(e) };
  }
  return {
    state: 'ok',
    shown: r.claims.length > 0,
    ...(wildcardNotes.length ? { wildcardNotes } : {}),
    hits: r.claims.map((c, i) => ({
      rank: i + 1, id: c.id, authority: c.authority ?? null, author: c.author ?? null,
      scope: c.scope ?? null, ts: c.ts ?? null,
      score: Number.isFinite(c.score) ? c.score : null,
      body: excerpt(c.body ?? '', 300),
    })),
    excluded: r.excluded.length,
    excludedByKind: r.excluded.reduce((m, x) => { m[x.kind ?? 'eligibility'] = (m[x.kind ?? 'eligibility'] ?? 0) + 1; return m; }, {}),
    hasMore: Boolean(r.hasMore),
    coverage: r.coverage ?? { state: 'unknown_coverage', reasons: [] },
  };
}

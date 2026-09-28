// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard.mjs — the desk: five views over one memory, no demo data.
//
// **Where this came from.** A UI export arrived that proposed five
// views — desk, knowledge, projects, agents, net — and it proposed them
// well: the information architecture here is that export's. What it
// could not bring was data. It fetched `/console.json` and then gated
// every board tile behind `Array.isArray(x.board)`, which is false,
// because `console.collect()` returns `board` as an OBJECT. So the page
// fell back to a hardcoded `DEMO` constant while its own status pill
// read "Daten: /console.json". Measured, not assumed: a live server on
// port 8899 against this repo answered `board keys: tiles, at, alarm,
// watch, unknown`.
//
// That is the defect family this project spends its time on — a check
// that silently does nothing, reporting into a channel that says
// "measured". So this module is built the other way round:
//
//  1. **There is no fallback.** The page is rendered from collected
//     data and the data is embedded in it. There is no fetch, so there
//     is no failed fetch, so there is nothing to fall back TO. A page
//     that cannot be built throws, and the server answers 500.
//  2. **Nothing is derived a second time.** Every number comes from a
//     function that already owns it: `console.collect` for the board,
//     `viewer.collectMemory` for entries, agents and facts, `net.build`
//     for the matrix, `memory.openDuties` and `question.all` for the
//     work. This file assembles; it does not compute a truth of its own.
//  3. **Four states, never two.** `calm` is measured-and-in-order,
//     `unknown` is NOT MEASURED, and the two never share a colour, a
//     word or a sort position. A count that could not be taken reads
//     `null` and renders as "not measured" — never as zero.
//
// invariant: drei-zustaende-nie-zwei
// invariant: leer-ist-kein-bestehen
import fs from 'node:fs';
import * as consolePage from './console.mjs';
import * as viewer from './viewer.mjs';
import * as memory from './memory.mjs';
import * as net from './net.mjs';
import * as backlinkIndex from './backlinks.mjs';
import * as question from './question.mjs';
import * as basis from './basis.mjs';
import * as authority from './authority.mjs';
import * as capability from './capability.mjs';
// Named `rawCapture`, not `raw`: `collect()` below already has a local
// `const raw` (the entry map) — two bindings of the same name in one
// module is exactly the kind of silent confusion this codebase avoids.
import * as rawCapture from './raw.mjs';
// D5 (2026-09-27): the agents view's own four honest fields, and the
// human's read-only tray. Read-only dependencies — this file never
// writes agents/, heartbeat.jsonl or inbox/.
import * as agentsModule from './agents.mjs';
import * as heartbeatModule from './heartbeat.mjs';
import * as inboxModule from './inbox.mjs';
import * as cfgmod from './config.mjs';
import * as tasksModule from './tasks.mjs';

export const VIEWS = Object.freeze(['desk', 'knowledge', 'space', 'projects', 'agents', 'net', 'set']);

/**
 * The state vocabulary, in ONE place.
 *
 * `board.STATE` is already closed — calm/watch/alarm/unknown. The
 * arriving export carried a second one (ok/watch/error/unknown/info)
 * whose badge map had no entry for `calm` or `alarm`, so the two states
 * that matter most would have rendered as bare uncoloured words. A
 * vocabulary retyped by a second reader is the recurring defect here,
 * so this one REFUSES an unknown state rather than passing it through.
 */
export const WORD = Object.freeze({
  calm: 'in order',
  watch: 'wants someone',
  alarm: 'broken',
  unknown: 'not measured',
});

/** Alarm first, then watch, then unmeasured, then calm. Not alphabetical. */
export const RANK = Object.freeze({ alarm: 0, watch: 1, unknown: 2, calm: 3 });

export function word(state) {
  const w = WORD[state];
  if (!w) {
    throw new Error(`Unknown state '${state}'. Known: ${Object.keys(WORD).join(', ')}`);
  }
  return w;
}

/**
 * Read every drawer of every project once.
 *
 * `net.build` wants this shape, and so does the per-entry enrichment
 * below — reading twice would be two answers to one question. Retired
 * entries are KEPT and marked: the knowledge view shows the whole
 * history, and "was retracted" is a measured fact, not an absence.
 * Broken lines are counted rather than skipped (I19).
 */
export function readPass(root) {
  const rows = [];
  let broken = 0;
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const drawer of Object.keys(memory.TYPES)) {
      let res;
      try { res = memory.readLog(root, drawer, { project }); } catch { continue; }
      const retired = memory.retiredMap(res.entries);
      for (const e of res.entries) {
        if (e.__broken) { broken += 1; continue; }
        rows.push({
          project: project ?? 'global',
          drawer,
          entry: e,
          held: memory.holds(e, retired),
        });
      }
    }
  }
  return { rows, broken };
}

/**
 * One count with its denominator, or an honest nothing.
 *
 * Zero-of-zero is the trap: a drawer nobody has ever written to answers
 * "0 open" and looks healthy. So a total of zero is `unknown`, not
 * `calm`, and says which of the two it is.
 */
function workTile(title, open, total, { noun, whenEmpty }) {
  if (total === 0) {
    return { title, value: null, state: 'unknown', note: whenEmpty, open: null, total: 0 };
  }
  return {
    title,
    value: `${open} / ${total}`,
    state: open > 0 ? 'watch' : 'calm',
    note: `${open} of ${total} ${noun} still open`,
    open,
    total,
  };
}

/** The global drawer is `global` in this file and `(global)` in agentState. */
export const agentKey = (project) => (project === 'global' ? '(global)' : project);

// -----------------------------------------------------------------------
// D5 (2026-09-27): four honest, differentiated agent fields
// -----------------------------------------------------------------------
//
// `mem.agents` (built in `viewer.collectMemory`, above, unchanged by this
// section) already answers "registered vs. seen in the log" — the same
// question `board.tileAgents` answers off a SINGLE source (`heartbeat.
// jsonl` alone), and that tile deliberately never reports CALM from it:
// "an agent with an old heartbeat is not necessarily broken — it may
// have had nothing to do." This view claims something stronger than that
// tile does — "alive" — and a stronger claim needs a stronger
// measurement, not a louder word over the same one signal.
//
// So `activity` below demands TWO INDEPENDENT sources that agree:
// `heartbeat.jsonl` (a deliberate pulse call, its own file) and the
// memory's own drawers/inbox (what the agent actually produced — read
// through entirely separate modules, at an entirely different write
// rate). One fresh source alone could just as well mean the OTHER source
// broke, not that the agent did — so one source is `unknown`, never
// `alive`; two agreeing is `alive`; none is `not seen`. The freshness
// window reuses `board.mjs`'s OWN `tileAgents` default (`quietMin =
// 60 * 24`, one day) rather than inventing a second threshold beside it.
//
// The other three fields are each answerable from ONE real check and
// never invent a value past what that check actually saw:
//   `startable` — a plain file check (does `agents.readAgent` find
//                 PROMPT.md/START.md for this name, right here, right
//                 now?), always answerable, never `unknown`.
//   `pause`     — `agents.silentStatus()`, unchanged; `unknown` only
//                 when there is no AGENT.yaml to read it from.
//   `channel`   — `ok` only when at least one message TO this agent's
//                 own inbox has actually moved past `open`
//                 (`inbox.isDone`) — proof something on the other end
//                 reads it. Configured-but-never-answered and
//                 not-configured-at-all both read `unknown`: this field
//                 is `ok`/`unknown` only, on purpose — a channel nobody
//                 has proven working does not get to be green.
//
// This resolution happens HERE, at collection time, not in the view:
// `astra/agents.mjs` stays a pure function of what this file hands it —
// same contract `renderHtml` already promises the whole page ("no I/O,
// so a test can hand it a fixture").
const ACTIVITY_WINDOW_MIN = 60 * 24;

/** Minutes since an ISO timestamp, or `null` when there is nothing to age. */
function minutesSince(ts, now) {
  if (!ts) return null;
  const t = Date.parse(String(ts));
  if (Number.isNaN(t)) return null;
  return Math.max(0, (now.getTime() - t) / 60000);
}

/** The two-source "alive" decision. See the section header above. */
function agentActivity(root, agent, { now, participants, inboxMessages }) {
  let heartbeatAgeMin = null;
  try { heartbeatAgeMin = heartbeatModule.ageMin(root, agent.name, { now }); }
  catch { /* stays null: unmeasurable, not zero */ }
  const heartbeatFresh = heartbeatAgeMin !== null && heartbeatAgeMin <= ACTIVITY_WINDOW_MIN;

  const sentByThis = (participants && Object.hasOwn(participants, agent.name))
    ? inboxMessages.filter((m) => m.from === agent.name).map((m) => m.time)
    : [];
  const lastSent = sentByThis.length ? [...sentByThis].sort().at(-1) : null;
  const writeAgeMin = minutesSince(agent.last || null, now);
  const sentAgeMin = minutesSince(lastSent, now);
  const contentAges = [writeAgeMin, sentAgeMin].filter((x) => x !== null);
  const contentAgeMin = contentAges.length ? Math.min(...contentAges) : null;
  const contentFresh = contentAgeMin !== null && contentAgeMin <= ACTIVITY_WINDOW_MIN;

  const freshCount = (heartbeatFresh ? 1 : 0) + (contentFresh ? 1 : 0);
  const state = freshCount === 2 ? 'alive' : freshCount === 1 ? 'unknown' : 'not seen';

  return {
    state,
    windowMin: ACTIVITY_WINDOW_MIN,
    heartbeat: { ageMin: heartbeatAgeMin, fresh: heartbeatFresh },
    content: { ageMin: contentAgeMin, fresh: contentFresh },
  };
}

/** Can `mem` find this agent's own start instructions locally, right now? */
function agentStartable(full, agent) {
  if (!agent.registered) {
    return { local: false, reason: 'no agents/<name>/ folder in this memory — nothing to start' };
  }
  if (!full) return { local: false, reason: 'the folder could not be read' };
  if (!full.prompt) return { local: false, reason: `${full.content}/ has no PROMPT.md or START.md` };
  return { local: true, reason: `instructions at ${full.prompt}` };
}

/** `agents.silentStatus()`, unchanged — `unknown` only without an AGENT.yaml. */
function agentPause(full, now) {
  if (!full) {
    return { state: 'unknown', reason: 'not registered — no AGENT.yaml to read silent_until from' };
  }
  const st = agentsModule.silentStatus(full, now);
  if (st.invalid) {
    return {
      state: 'unknown', until: st.until, why: st.why,
      reason: `silent_until '${st.until}' is not a readable date`,
    };
  }
  if (st.silent) return { state: 'paused', until: st.until, why: st.why };
  if (st.expired) return { state: 'expired', until: st.until, why: st.why };
  return { state: 'active' };
}

/** `ok` only once a message to this agent has actually been acted on. */
function agentChannel(agent, participants, inboxMessages) {
  const known = Boolean(participants) && Object.hasOwn(participants, agent.name);
  if (!known) return { state: 'unknown', reason: 'not a configured inbox participant' };
  const toThis = inboxMessages.filter((m) => m.to === agent.name);
  if (!toThis.length) return { state: 'unknown', reason: 'no message has ever reached this inbox' };
  const answered = toThis.filter((m) => inboxModule.isDone(m.state));
  if (!answered.length) {
    return {
      state: 'unknown',
      reason: `${toThis.length} message(s) waiting here, none answered or processed yet`,
    };
  }
  return { state: 'ok', reason: `${answered.length} of ${toThis.length} messages were answered or processed` };
}

/** The four D5 fields for one agent, all with a real data path. */
function agentSignals(root, agent, ctx) {
  let full = null;
  try { full = agentsModule.readAgent(root, agent.name); } catch { full = null; }
  return {
    activity: agentActivity(root, agent, ctx),
    startable: agentStartable(full, agent),
    pause: agentPause(full, ctx.now),
    channel: agentChannel(agent, ctx.participants, ctx.inboxMessages),
  };
}

/**
 * The human's own tray — read-only (E5.4). Built from the SAME
 * `inbox.read` pass `agentChannel` above already paid for, never a
 * second read, and never `inbox.newFor`/`markSeen`/`watch`: those write
 * a seen-list or touch git, and opening this page must not change a
 * delivery attempt or a re-surfacing state just because someone looked.
 *
 * Who the human IS comes from `cfgmod.humanParticipant()` — the
 * participant marked `"human": true` in `.mem/config.json`, never a
 * name this file assumes. A memory with none marked (or two) reports
 * that honestly below rather than guessing.
 *
 * `name` is carried so the desk can offer a reply under each message
 * (P1b). Replying is a separate POST (`/inbox/reply` in bin/mem-serve,
 * behind `writegate.refusal()`); collecting this tray still writes
 * nothing.
 */
function humanInboxState(participants, inboxMessages, inboxBroken) {
  const { name: who, reason } = cfgmod.humanParticipant(participants);
  if (!who) return { readable: false, reason, messages: [] };
  return {
    readable: true,
    who,
    messages: inboxMessages.filter((m) => m.to === who)
      .map((m) => ({
        name: m.name, from: m.from, time: m.time, subject: m.subject, state: m.state,
      })),
    broken: inboxBroken.length,
  };
}

/**
 * Everything the desk shows — as data, not as HTML.
 *
 * Separate for the same reason `console.collect` is: it goes out as
 * JSON too, and the tests can then check numbers without reaching
 * through markup.
 */

/**
 * What an entry claims it was built on — its own field, never an
 * inference. Pulled out to its own function (2026-09-27, D1) so
 * `getEntryFast()` below can read the exact same rule instead of the
 * ternary being written out a second time; `collect()`'s entry map
 * calls this too now, so the two can never disagree about one entry.
 */
export function declaredDerivedFrom(e) {
  if (e && Array.isArray(e.origin?.derived_from)) return e.origin.derived_from;
  if (e && Array.isArray(e.provenance?.derived_from)) return e.provenance.derived_from;
  return [];
}

function collectTasks(root) {
  const kinds = Object.entries(tasksModule.KINDS).map(([kind, spec]) => ({
    kind, title: spec.title, description: spec.description, resume: spec.resume,
  }));
  try {
    return { readable: true, error: null, kinds, latest: tasksModule.overview(root) };
  } catch (e) {
    return { readable: false, error: e?.message || String(e), kinds, latest: {} };
  }
}

export function collect(root, { env = process.env, now = new Date(), cfg = {} } = {}) {
  const con = consolePage.collect(root, { env, now, cfg });
  const mem = viewer.collectMemory(root);
  const pass = readPass(root);

  // --- D5: agent signals + the human's own tray -----------------------
  // `cfg` above is the SERVER's config (host, port, token) — a different
  // object from the MEMORY's `.mem/config.json` (participants), which is
  // read here on its own. Absence is a legitimate, honestly-reported gap
  // (a bare memory before `mem init`'s config exists), never a crash.
  let participants = null;
  try { participants = cfgmod.readConfig(root).participants; } catch { participants = null; }
  // One `inbox.read` pass, shared by every agent's `channel` field and by
  // the human's tray below — never a second read, and never a WRITE:
  // `inbox.read` only ever reads a directory it is handed.
  let inboxMessages = [];
  let inboxBroken = [];
  try {
    const ib = inboxModule.read(root, participants ?? {}, {});
    inboxMessages = ib.messages;
    inboxBroken = ib.broken;
  } catch { /* stays empty: an unreadable inbox has no messages to show */ }
  const agentCtx = { now, participants, inboxMessages };
  const agentsOut = mem.agents.map((a) => ({ ...a, ...agentSignals(root, a, agentCtx) }));
  const humanInbox = humanInboxState(participants, inboxMessages, inboxBroken);

  // --- the net -------------------------------------------------------
  // Built from the same pass, in the shape `mem net` already uses, so
  // the page and the CLI cannot disagree about an edge.
  const graph = net.build({
    readAll: () => pass.rows.map(({ project, drawer, entry }) => ({ project, drawer, entry })),
  });

  // --- per-entry enrichment ------------------------------------------
  // The raw entry, retired ones included. `memory.entriesById` filters
  // them out — correct for recall, wrong here: an entry whose basis
  // could not be read and one that was retracted would then look the
  // same, and only one of those is a gap.
  const raw = new Map();
  for (const { entry } of pass.rows) if (entry.id && !raw.has(entry.id)) raw.set(entry.id, entry);

  const stand = memory.standing(root);

  // Both directions of every declared edge, once. `memory.linksOf`
  // answers for ONE id and rebuilds the whole map each time it is
  // called — fine for a CLI question, quadratic for a page.
  const out = new Map();
  const into = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const { entry } of pass.rows) {
    for (const l of net.linksOf(entry)) {
      const known = raw.has(l.to);
      push(out, l.from, { kind: l.kind, id: l.to, known });
      if (known) push(into, l.to, { kind: l.kind, id: l.from, known: true });
    }
  }

  // **D3 (2026-09-27): the type vocabulary the knowledge view filters by,
  // from ONE source.** `Object.keys(memory.TYPES)` — never derived from
  // which types happen to appear in `entries` below. Deriving it from
  // `entries` was the actual defect this replaces: a type with zero
  // entries (or every one of them retired away later) would silently
  // lose its chip, and nobody filtering by it could tell "this type does
  // not exist" apart from "this type happens to be empty right now".
  // `astra/knowledge.mjs` reads this list and hand-types no type of its
  // own — a type this file forgets to add here is a type the view never
  // learns about either, which is the point: one truth, one place that
  // can be wrong.
  const types = Object.keys(memory.TYPES).map((type) => ({
    type, label: viewer.TYPE_LABEL[type] || type,
  }));

  const entries = mem.entries.map((r) => {
    const e = raw.get(r.id) ?? null;
    const s = stand.get(r.id) ?? null;
    const links = out.get(r.id) ?? [];
    const back = into.get(r.id) ?? [];
    return {
      id: r.id,
      ts: r.ts,
      day: r.day,
      type: r.type,
      typeLabel: r.typeLabel,
      project: r.project || 'global',
      tags: r.tags,
      headline: r.headline,
      source: r.source,
      line: r.line,
      // **Three states, and the first one is its own field.** `markOf`
      // answers `null` for "carries no mark" — deliberately, so an old
      // entry does not retroactively gain one. Handing an ABSENT entry
      // to it answers `null` as well, and the page would then print
      // "not declared" for something it simply could not read. Worse,
      // `capability.scopeOf(undefined)` answers `'global'`: a confident
      // wrong answer, not a gap. So readability is recorded once, here,
      // and the field values below are only meaningful when it is true.
      readable: Boolean(e),
      basis: e ? basis.markOf(e) : null,
      authority: e ? authority.tierOf(e) : null,
      author: e ? (authority.authorOf(e) || null) : null,
      scope: e ? capability.scopeOf(e) : null,
      // What it was built on — the entry's own claim, not an inference.
      derivedFrom: declaredDerivedFrom(e),
      cited: s ? s.cited : 0,
      contested: s ? Boolean(s.contested) : false,
      // Retired is a MEASURED state. Absent means "not retracted", which
      // this pass really did check — so it is not `unknown`.
      retired: r.retired,
      replaces: e?.replaces_id ? String(e.replaces_id) : null,
      contradicts: links.filter((l) => l.kind === 'contradicts'),
      contradictedBy: back.filter((l) => l.kind === 'contradicts'),
      links,
      backlinks: back,
    };
  });

  // --- the work ------------------------------------------------------
  let duties = null;
  try {
    const d = memory.openDuties(root);
    duties = workTile('Duties', d.open.length, d.open.length + d.done.length,
      { noun: 'duties', whenEmpty: 'no duty has ever been recorded' });
  } catch (e) {
    duties = { title: 'Duties', value: null, state: 'unknown', note: `not measurable: ${e.message}`, open: null, total: null };
  }

  let questions = null;
  try {
    const qs = question.all(root);
    questions = workTile('Questions', qs.filter((q) => q.open).length, qs.length,
      { noun: 'questions', whenEmpty: 'no question has ever been asked' });
  } catch (e) {
    questions = { title: 'Questions', value: null, state: 'unknown', note: `not measurable: ${e.message}`, open: null, total: null };
  }

  // The agent tile shows the GAP the viewer exists to show: registered
  // and seen are two different sets, and the interesting ones are the
  // entries in exactly one of them.
  const seen = mem.agents.filter((a) => a.count > 0);
  const unregistered = mem.agents.filter((a) => !a.registered && a.count > 0);
  const idle = mem.agents.filter((a) => a.registered && a.count === 0);
  const agentTile = mem.agents.length === 0
    ? { title: 'Agents', value: null, state: 'unknown', note: 'none registered and none seen in the log', open: null, total: 0 }
    : {
      title: 'Agents',
      value: `${seen.length} / ${mem.agents.length}`,
      state: (unregistered.length || idle.length) ? 'watch' : 'calm',
      note: [
        `${seen.length} of ${mem.agents.length} have written something`,
        unregistered.length ? `${unregistered.length} write without a folder` : null,
        idle.length ? `${idle.length} registered but never wrote` : null,
      ].filter(Boolean).join(' · '),
      open: seen.length,
      total: mem.agents.length,
    };

  // --- the projects --------------------------------------------------
  const perProject = new Map();
  for (const { project, drawer, entry, held } of pass.rows) {
    if (!perProject.has(project)) {
      perProject.set(project, { name: project, entries: 0, retired: 0, drawers: new Set(), last: '' });
    }
    const p = perProject.get(project);
    p.entries += 1;
    if (!held) p.retired += 1;
    p.drawers.add(drawer);
    const ts = String(entry.ts || '');
    if (ts > p.last) p.last = ts;
  }
  let openPerProject = new Map();
  try {
    for (const q of question.open(root)) {
      const k = q._project ?? 'global';
      openPerProject.set(k, (openPerProject.get(k) ?? 0) + 1);
    }
  } catch { openPerProject = new Map(); }

  const projects = [...perProject.values()].map((p) => ({
    name: p.name,
    entries: p.entries,
    retired: p.retired,
    drawers: [...p.drawers].sort(),
    last: p.last || null,
    // `agentState().projects` is a TALLY keyed by project, and it spells
    // the global drawer `(global)` while this pass spells it `global`.
    // Two spellings for one place: translated here, once, rather than
    // compared hopefully at four call sites.
    agents: mem.agents
      .filter((a) => Object.keys(a.projects || {}).includes(agentKey(p.name)))
      .map((a) => ({ name: a.name, entries: (a.projects || {})[agentKey(p.name)] ?? 0 })),
    openQuestions: openPerProject.get(p.name) ?? 0,
  })).sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name));

  const tiles = [...con.board.tiles]
    .map((t) => ({ ...t, word: word(t.state) }))
    .sort((a, b) => RANK[a.state] - RANK[b.state]);

  // --- the raw-capture review -----------------------------------------
  // `rawCapture.capturesWithState` already owns the four-state truth
  // (present/deleted/unreachable/elsewhere) that `mem raw review` shows
  // on the command line — this page displays it, it does not recompute
  // it. `elsewhere` means the record points into another machine's
  // store: its bytes are missing here entirely correctly, and counting
  // it as `unreachable` would make this tile a standing alarm.
  // Newest first, same order the CLI review uses.
  // **Four states, not three.** The first version caught the read error
  // and fell back to an empty list — and an empty list on this page is
  // indistinguishable from "nothing has been captured yet". That is the
  // house's oldest defect (`assumption instead of measurement`): a
  // number that was never taken must not arrive looking like zero. So
  // the failure travels as its own field, and the counts go to `null`,
  // which this page renders as "not measured" rather than "0".
  let rawCaptures = [];
  let rawReadable = true;
  let rawError = null;
  try { rawCaptures = rawCapture.capturesWithState(root); }
  catch (e) { rawReadable = false; rawError = String(e?.message ?? e); }
  // The counters are always present — never omitted when zero, because
  // a missing key would read as "not measured" and zero really was
  // measured. When the register could not be read, they ARE null.
  //
  // The list comes from `raw.CAPTURE_STATES` rather than being typed out
  // here: a state the page cannot count would vanish from it silently,
  // which is precisely the defect the four states exist to prevent.
  const rawCounts = {};
  for (const st of rawCapture.CAPTURE_STATES) rawCounts[st] = rawReadable ? 0 : null;
  if (rawReadable) for (const r of rawCaptures) rawCounts[r.state] = (rawCounts[r.state] ?? 0) + 1;

  return {
    at: con.at,
    root: con.root,
    git: con.git,
    inventory: con.inventory,
    // The board, unchanged in substance — only the sort and the word are
    // this page's. The states themselves come from `board.board`.
    system: tiles,
    attention: tiles.filter((t) => t.state !== 'calm'),
    work: [duties, questions, agentTile],
    entries,
    // D3: the closed type vocabulary — see the comment above `types`.
    types,
    counts: mem.counts,
    broken: pass.broken,
    projects,
    // D5: `mem.agents` enriched with the four fields above, never a
    // second, disagreeing copy of the name/count/model/role part.
    agents: agentsOut,
    // The human's own tray, read-only — E5.4: nothing above this line
    // marks a message seen or attempts delivery; opening the page never
    // changes what `mem post` shows next.
    humanInbox,
    facts: mem.facts,
    net: { ...graph, layers: net.layers(graph) },
    // What the console could set and this page could not. Carried
    // through unchanged rather than re-derived: two places computing
    // "is this writable" would eventually disagree, and the one that
    // shows an enabled button while the server refuses the POST is the
    // one people believe.
    settings: con.settings,
    writes: con.writes,
    setup: con.setup,
    connections: con.connections,
    stores: con.stores,
    log: con.log,
    // E1.7: the long jobs, read through `tasks.overview()` — the same
    // `.mem/tasks/*.jsonl` files `/task.json` reads, never a second copy.
    // `latest[kind]` is null when that kind never ran.
    tasks: collectTasks(root),
    views: VIEWS,
    raw: { captures: rawCaptures, counts: rawCounts, readable: rawReadable, error: rawError },
    // **Additive, 2026-09-28 (the dashboard port).** The lenses the old
    // viewer page showed beside the entries — topics and their tree,
    // experiences, hand-drawn links, the store register — were computed
    // above by `viewer.collectMemory()` and then dropped. The new
    // dashboard (`src/dashboard-data.mjs`) shows every one of them, so
    // they travel on from the SAME pass instead of being read twice.
    lenses: {
      topics: mem.topics,
      areas: mem.areas,
      quality: mem.quality,
      experiences: mem.experiences,
      links: mem.links,
      store: mem.store,
      storeState: mem.storeState,
      name: mem.name,
    },
  };
}

// -----------------------------------------------------------------------
// D1 single-entry contract (2026-09-27)
// -----------------------------------------------------------------------
//
// Mirrors lucky-mem's `schreibtisch.holeEintragSchnell()` (its commit
// 6f5280f0, section "D1 Datenvertrag Einzelabruf" in its own dashboard
// coverage notes): one id resolved directly, never `collect()`'s full
// pass over every drawer of every project just to hand back one row.
//
//   found      { state:'ok',      entry, source:{file,line}, asOf }      -> 200
//   not found  { state:'unknown', id, reason? }                         -> 404
//   unreadable { state:'error',   id, reason }                          -> 500
//   partial    { state:'warning', entry, source, asOf, reason }         -> 200
//
// `state:'unknown'` means every drawer this function searched was
// readable, and none of them carried the id — never a guess dressed up
// as a clean miss. `state:'error'`/`'warning'` mean at least one source
// line could not be read WHILE the answer was being built; that gap
// travels in `reason`, it is never swallowed into a silent not-found or
// a silently thinner answer. `asOf` is the mtime of the drawer actually
// read (`fs.statSync`), not an invented cache timestamp.
//
// `entry` carries exactly the fields `collect()`'s own `entries` array
// shows for that id, from the SAME functions — `viewer.TYPE_LABEL` /
// `viewer.headline` for the label and headline, `basis.markOf` /
// `authority.tierOf` / `authority.authorOf` / `capability.scopeOf` for
// the three per-entry marks, `declaredDerivedFrom()` above for what the
// entry claims it was built on, `memory.retiredMap` for whether a later
// line superseded it, and `net.linksOf` for every declared edge this
// function actually reads. None of that is computed a second way here;
// see `test/dashboard-entry-fast.test.mjs`'s probe (3) for the check
// that this and `collect()` cannot quietly disagree about one id.
//
// **Incoming edges come from the backlink index (D1b, E1.4).** Until
// D1b, `cited`/`backlinks`/`contradictedBy` here saw only this id's own
// drawer and the `link` drawer; an incoming `derived_from` edge declared
// in a DIFFERENT drawer was not searched, and every answer carried a
// fixed `graphNote` saying so. Now this reads `backlinks.backlinks()` —
// ONE file, built from the SAME `net.linksOf()` in the same order
// (project, drawer, line) as `collect()`'s own pass, so the same list
// as its `into`.
//
// When the index is not fresh (never built, corrupt, stale, or a broken
// line seen while building it), this falls back to the locally visible
// edges and answers `warning` with the index's own reason — a gap
// disclosed, never swallowed. The read path never rebuilds the index
// itself; `bin/mem-serve`'s `/entry.json` branch runs `backlinks.
// update()` first (rebuild only when the corpus changed).

/**
 * Which drawer holds `id`, stopping the instant it turns up — and
 * whether a broken line turned up on the way there.
 *
 * Built from the same three primitives `memory.findEntryLocation` uses
 * (`memory.listProjects`, `memory.TYPES`, `memory.iterLog`), walked in
 * the same order, so this can never settle on a different drawer than
 * that function would for the same id — one id path, not a second one
 * invented beside it. It is its own function rather than a change to
 * `findEntryLocation` only because that function has no way to hand
 * back "did a line fail to parse on the way" without changing what
 * every one of its OTHER callers receives; that signal is the whole
 * reason this one exists.
 */
function locateDrawer(root, id) {
  let sawBroken = false;
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      let it;
      try { it = memory.iterLog(root, type, { project }); } catch { continue; }
      for (const e of it) {
        if (e.__broken) { sawBroken = true; continue; }
        if (e.id === id && !memory.isClosingLine(e)) return { drawer: { type, project }, sawBroken };
      }
    }
  }
  return { drawer: null, sawBroken };
}

/**
 * A bounded "does this id exist anywhere" check, for the `known` flag
 * on a declared OUTGOING edge. `memory.findEntryLocation` already IS
 * that check — reused, not re-implemented — and it stays cheap here
 * specifically because it only ever runs once per edge THIS id
 * actually has, never once per entry in the whole memory.
 */
function knownChecker(root) {
  const cache = new Map();
  return (targetId) => {
    if (!cache.has(targetId)) cache.set(targetId, Boolean(memory.findEntryLocation(root, targetId)));
    return cache.get(targetId);
  };
}

/**
 * One entry for GENUINELY one id — never `collect()`'s pass over every
 * drawer of every project.
 *
 * Reads: (a) drawers, stopping the instant `id` turns up (`locateDrawer`
 * above); (b) the ONE drawer it lives in, read in full (for its line
 * number and any tombstone/correction of it — both live in that same
 * drawer by the convention `retireEntry`/`correctionEntry` follow); (c)
 * the `link` drawer, once per project (every hand-drawn edge touching
 * `id`, in either direction); (d) the backlink index, ONE file (see
 * the header comment above). Never every type of every project.
 */
export function getEntryFast(root, id) {
  if (typeof id !== 'string' || !id) return { state: 'unknown', id: id ?? '' };

  const { drawer, sawBroken } = locateDrawer(root, id);
  if (!drawer) {
    // A not-found next to corruption THIS SAME SEARCH actually saw is
    // not an established not-found — the line that failed to parse
    // could have been the one being asked for.
    return sawBroken
      ? {
        state: 'error',
        id,
        reason: 'At least one source line could not be read while searching for this '
          + 'id — a not-found cannot be established this way.',
      }
      : { state: 'unknown', id };
  }

  const file = memory.logPath(root, drawer.type, drawer.project);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    return { state: 'error', id, reason: `Drawer not readable: ${err?.message || err}` };
  }

  const rows = []; // { entry, line }
  let ownDrawerBroken = false;
  const rawLines = raw.split('\n');
  for (let i = 0; i < rawLines.length; i += 1) {
    const text = rawLines[i];
    if (!text.trim()) continue;
    let entry;
    try { entry = JSON.parse(text); } catch { ownDrawerBroken = true; continue; }
    rows.push({ entry, line: i + 1 });
  }
  const hit = rows.find((r) => r.entry.id === id && !memory.isClosingLine(r.entry));
  if (!hit) {
    // The drawer changed between (a) and (b) (a rare race with a
    // concurrent writer) — an honest 'unknown', never a guess at what
    // it used to hold.
    return { state: 'unknown', id };
  }
  const { entry: e, line } = hit;
  const retired = memory.retiredMap(rows.map((r) => r.entry)).get(id) ?? null;

  // --- (c) declared edges: this drawer's own fields, plus the `link`
  // drawer across every project ---------------------------------------
  const known = knownChecker(root);
  const out = [];   // this id's outgoing edges, any kind
  const into = [];  // incoming edges from the local drawers, any kind EXCEPT derived_from (fallback only)
  let cited = 0;
  let contested = false;

  // Display edges (`links`/`backlinks`/`contradicts`/`contradictedBy`):
  // exactly `net.linksOf`, the same function `collect()`'s own net pass
  // uses, so an edge kind added there is never missed here.
  function collectDisplay(entries) {
    for (const entry of entries) {
      for (const l of net.linksOf(entry)) {
        if (l.from === id) out.push({ kind: l.kind, id: l.to, known: known(l.to) });
        if (l.to === id && l.kind !== 'derived_from') into.push({ kind: l.kind, id: l.from, known: true });
      }
    }
  }
  // Standing (`cited`/`contested`): mirrors `memory.standing()`'s OWN
  // `link`-drawer loop field for field (`to`/`target`, any kind), not
  // `net.linksOf`'s stricter shape — `standing()` does not check a
  // kind against the closed vocabulary before counting it, and `cited`
  // here has to be the SAME number `collect()` shows, not a stricter
  // reading of the same lines.
  function collectStanding(entries) {
    for (const l of entries) {
      if (memory.isClosingLine(l)) continue;
      const to = l.to ?? l.target ?? null;
      if (to !== id) continue;
      if (l.kind === 'contradicts') contested = true;
      else cited += 1;
    }
  }

  collectDisplay(rows.map((r) => r.entry));
  // `id`'s own drawer IS the `link` drawer when `id` names a hand-drawn
  // edge itself — `standing()` would still read those same lines (as
  // part of that project's `link` drawer), so this has to as well.
  if (drawer.type === 'link') collectStanding(rows.map((r) => r.entry));

  let linkDrawerBroken = false;
  for (const project of [null, ...memory.listProjects(root)]) {
    if (drawer.type === 'link' && project === drawer.project) continue; // already read as `rows`
    let it;
    try { it = memory.iterLog(root, 'link', { project }); } catch { continue; }
    const linkEntries = [];
    for (const l of it) {
      if (l.__broken) { linkDrawerBroken = true; } else linkEntries.push(l);
    }
    collectDisplay(linkEntries);
    collectStanding(linkEntries);
  }

  // Incoming edges: from the index when it is fresh — otherwise the
  // locally visible ones above, and a warning with the index's reason.
  const bl = backlinkIndex.backlinks(root, id);
  const indexFresh = bl.state === 'ok';
  const backlinks = indexFresh
    ? bl.sources.map((l) => ({ kind: l.kind, id: l.id, known: true }))
    : into;
  // Same as `memory.standing()`: every derived_from edge onto this id
  // counts, plus every hand-drawn link except 'contradicts' (above).
  if (indexFresh) cited += bl.sources.filter((l) => l.kind === 'derived_from').length;

  // A retired id never accumulates standing, in `collect()` either: it
  // is not in `memory.entriesById()` (the substrate `memory.standing()`
  // walks), because `holds()` excludes it — so nothing can be counted
  // AS citing or contesting IT. Same rule, applied without walking the
  // whole substrate to reach it.
  if (retired) { cited = 0; contested = false; }

  let asOf = null;
  try { asOf = fs.statSync(file).mtime.toISOString(); } catch { /* no evidence -> null */ }

  const source = memory.asSource(root, file);
  const entry = {
    id,
    ts: e.ts,
    day: String(e.ts || '').slice(0, 10),
    type: drawer.type,
    typeLabel: viewer.TYPE_LABEL[drawer.type] || drawer.type,
    project: drawer.project || 'global',
    tags: Array.isArray(e.tags) ? e.tags : [],
    headline: viewer.headline(e),
    source,
    line,
    readable: true,
    basis: basis.markOf(e),
    authority: authority.tierOf(e),
    author: authority.authorOf(e) || null,
    scope: capability.scopeOf(e),
    derivedFrom: declaredDerivedFrom(e),
    cited,
    contested,
    retired: retired ? { state: retired.state, why: retired.why || null } : null,
    replaces: e.replaces_id ? String(e.replaces_id) : null,
    contradicts: out.filter((l) => l.kind === 'contradicts'),
    contradictedBy: backlinks.filter((l) => l.kind === 'contradicts'),
    links: out,
    backlinks,
  };

  const reasons = [];
  if (ownDrawerBroken) {
    reasons.push("this id's own drawer carries at least one line that could not be read");
  }
  if (!indexFresh) {
    reasons.push("backlinks only from the 'link' drawer and this id's own drawer — "
      + `backlink index ${bl.state}: ${bl.reason}`);
  }
  if (linkDrawerBroken) {
    reasons.push("the 'link' drawer carries at least one line that could not be read — "
      + 'cited/contested/links/backlinks/contradictedBy can undercount because of it');
  }

  return {
    state: reasons.length ? 'warning' : 'ok',
    id,
    asOf,
    source: { file: source, line },
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    entry,
  };
}

// ---------------------------------------------------------------------
// The page lives in `astra.mjs`
// ---------------------------------------------------------------------
//
// Until 2026-09-16 the markup, the stylesheet and the browser script
// stood right here. They moved to `src/astra.mjs` when the workspace
// was rebuilt to Lucky's study — not for tidiness, but because two
// renderers is two answers: a selector renamed in one and not the
// other fails silently, and the copy nobody routes to is the copy
// nobody notices is wrong.
//
// So this file is the DATA layer, and it has no opinion about markup.
// `astra.build(root)` collects through `collect()` here and renders
// there. Anything that used `dashboard.build` calls `astra.build`.

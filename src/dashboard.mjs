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
import * as consolePage from './console.mjs';
import * as viewer from './viewer.mjs';
import * as memory from './memory.mjs';
import * as net from './net.mjs';
import * as question from './question.mjs';
import * as basis from './basis.mjs';
import * as authority from './authority.mjs';
import * as capability from './capability.mjs';
// Named `rawCapture`, not `raw`: `collect()` below already has a local
// `const raw` (the entry map) — two bindings of the same name in one
// module is exactly the kind of silent confusion this codebase avoids.
import * as rawCapture from './raw.mjs';

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

/**
 * Everything the desk shows — as data, not as HTML.
 *
 * Separate for the same reason `console.collect` is: it goes out as
 * JSON too, and the tests can then check numbers without reaching
 * through markup.
 */
export function collect(root, { env = process.env, now = new Date(), cfg = {} } = {}) {
  const con = consolePage.collect(root, { env, now, cfg });
  const mem = viewer.collectMemory(root);
  const pass = readPass(root);

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
      derivedFrom: e && Array.isArray(e.origin?.derived_from) ? e.origin.derived_from
        : (e && Array.isArray(e.provenance?.derived_from) ? e.provenance.derived_from : []),
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
  // `rawCapture.capturesWithState` already owns the three-state truth
  // (present/deleted/unreachable) that `mem raw review` shows on the
  // command line — this page displays it, it does not recompute it.
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
  // Three counters, always present — never omitted when zero, because a
  // missing key would read as "not measured" and zero really was
  // measured. When the register could not be read, they ARE null.
  const rawCounts = rawReadable
    ? { present: 0, deleted: 0, unreachable: 0 }
    : { present: null, deleted: null, unreachable: null };
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
    counts: mem.counts,
    broken: pass.broken,
    projects,
    agents: mem.agents,
    facts: mem.facts,
    net: { ...graph, layers: net.layers(graph) },
    // What the console could set and this page could not. Carried
    // through unchanged rather than re-derived: two places computing
    // "is this writable" would eventually disagree, and the one that
    // shows an enabled button while the server refuses the POST is the
    // one people believe.
    settings: con.settings,
    setup: con.setup,
    connections: con.connections,
    stores: con.stores,
    log: con.log,
    views: VIEWS,
    raw: { captures: rawCaptures, counts: rawCounts, readable: rawReadable, error: rawError },
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

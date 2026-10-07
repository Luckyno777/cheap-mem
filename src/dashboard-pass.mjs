// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard-pass.mjs — ONE pass over the drawers that feeds the dashboard's
// counters and the condensed 3D atlas for a store the full build cannot
// handle (task atlas-pass-cm, 2026-10-02; the sibling's
// `src/dashboard-durchgang.mjs`, same design).
//
// **The finding (measured, bench/board-tempo.mjs, old state).** Above 64 MB
// of drawers the server built only a light head: counters per type and
// project plus the newest titles, nothing else. The tiles, the net, the
// agents, the open questions and the 3D atlas were unknown, and at 1M
// entries the page could not show a single topic. The full build reads the
// store a dozen times and keeps all of it in memory (100,000 entries: 43 s
// and 1.2 GB peak, 250,000 entries: 99 s and 2.9 GB).
//
// **What happens here.** `runPass()` reads every drawer file ONCE, line by
// line, and keeps nothing that grows with the store except a fingerprint
// table (two 32-bit hashes and three 16-bit fields per id, about 14 bytes an
// entry). It yields:
//
//   - `overview`    counters per type and project, as the full build counts
//                   them (every line that is not a closing line),
//   - `total`       the lines of all drawers (what `console.inventory()` says),
//   - `held`        the entries that still count (not a closing line, not
//                   retired, one per id),
//   - `window`      the newest WINDOW entries (the pages of the list),
//   - `net`         boxes, box pairs, links and dangling links, by the same
//                   rule as `net.build`,
//   - `questions`   which questions are open (the rule of `question.all`),
//   - `agents`      live counters per agent (the rule of `agentState`),
//   - `projects`    entries, retired, drawers, newest, per project,
//   - `atlas`       the condensed 3D atlas: the THEMES_MAX largest topics
//                   (tags) and every drawer with counters, the strongest
//                   topic pairs, and the newest SAMPLE entries of each topic
//                   and drawer as the first page when the page zooms in.
//
// **Nothing is decrypted.** Locked lines are read raw; their title and tags
// stand in clear, the envelope stays shut. The result may therefore go to
// disk as the head (dashboard-head.mjs). Free texts are not part of it.
//
// **Retired entries.** A drawer with closing or correcting lines
// (`retires_id`, `closes_id`, `replaces_id`) is read a second time, but only
// for those lines and the first line of every id they name — exactly the
// input `memory.retiredMapFromFiles` uses, so the map is the same one as over
// the whole drawer.
//
// invariant: three-states-never-two
// invariant: no-fallback-to-invented-data

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import * as memory from './memory.mjs';
import * as net from './net.mjs';
import * as authority from './authority.mjs';
import * as basis from './basis.mjs';
import * as capability from './capability.mjs';
import { headline, TYPE_LABEL } from './viewer.mjs';
import { declaredDerivedFrom } from './dashboard.mjs';

/** The newest entries the pass keeps for the pages of the list. */
export const WINDOW = 30000;
/** The newest entries per topic and per drawer: the first page when zooming in. */
export const SAMPLE = 60;
/** How many topics (the largest) the condensed atlas shows. */
const THEMES_MAX = 240;
/** How many topic pairs (the strongest between shown topics). */
const EDGES_MAX = 600;
/** At most this many topics get a sample of their own (the rest: a page by search). */
const SAMPLE_THEMES_MAX = 600;
/** Caps of the tag and pair counters (above: the figures become lower bounds). */
const TAGS_MAX = 50000;
const PAIRS_MAX = 100000;
/** The topic of an entry without a tag. */
export const NO_THEME = '(no topic)';

/** The hand-drawn links the answer lists (the newest). */
const LINKS_MAX = 2000;

const NONE = 0xffff;

// --- the fingerprint table ----------------------------------------------------

function hash32(s, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return h >>> 0;
}

/**
 * id -> (where, countedIn, agent) in open-addressed arrays. `where` is the
 * drawer of the LAST line with this id (as in `net.build`), `countedIn` the
 * drawer in which it was counted as holding (NONE = not counted).
 */
class IdTable {
  constructor(capacity = 1 << 16) { this.#alloc(capacity); this.n = 0; }

  #alloc(capacity) {
    this.capacity = capacity;
    this.a = new Uint32Array(capacity);
    this.b = new Uint32Array(capacity);
    this.where = new Uint16Array(capacity).fill(NONE);
    this.countedIn = new Uint16Array(capacity).fill(NONE);
    this.agent = new Uint16Array(capacity).fill(NONE);
  }

  #slot(a, b) {
    const mask = this.capacity - 1;
    let i = (a ^ Math.imul(b, 0x9e3779b1)) & mask;
    for (;;) {
      if (this.a[i] === 0) return i;
      if (this.a[i] === a && this.b[i] === b) return i;
      i = (i + 1) & mask;
    }
  }

  static key(id) { return [hash32(id, 2166136261) || 1, hash32(id, 0x811c9dc5 ^ 0x5bd1e995)]; }

  /** The slot of an id; created when `create`. -1 = not there. */
  slot(id, create = false) {
    const [a, b] = IdTable.key(id);
    return this.slotOf(a, b, create);
  }

  slotOf(a, b, create = false) {
    let i = this.#slot(a, b);
    if (this.a[i] === 0) {
      if (!create) return -1;
      if ((this.n + 1) * 10 > this.capacity * 6) { this.#grow(); i = this.#slot(a, b); }
      this.a[i] = a; this.b[i] = b; this.n += 1;
    }
    return i;
  }

  #grow() {
    const { a, b, where, countedIn, agent, capacity } = this;
    this.#alloc(capacity * 2);
    for (let j = 0; j < capacity; j += 1) {
      if (a[j] === 0) continue;
      const i = this.#slot(a[j], b[j]);
      this.a[i] = a[j]; this.b[i] = b[j]; this.where[i] = where[j]; this.countedIn[i] = countedIn[j]; this.agent[i] = agent[j];
    }
  }

  bytes() { return this.capacity * 14; }
}

// --- lines with their number ------------------------------------------------------

/**
 * Like `memory.iterLogFile()`, but with the line number that `memory.find()`
 * sets as `_line` (index in `split('\n')` + 1, blank lines counted) — the
 * injection journal names places as `file:line`.
 */
function* numberedLines(file, { chunkBytes = 256 * 1024 } = {}) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return; }
  try {
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(chunkBytes);
    let rest = '';
    let nr = 0;
    for (;;) {
      let got;
      try { got = fs.readSync(fd, buf, 0, chunkBytes, null); } catch { break; }
      if (got === 0) break;
      rest += decoder.write(buf.subarray(0, got));
      let start = 0;
      let nl = rest.indexOf('\n', start);
      while (nl !== -1) {
        nr += 1;
        const line = rest.slice(start, nl);
        if (line.trim()) {
          let e;
          try { e = JSON.parse(line); } catch { e = { __broken: true }; }
          yield [e, nr];
        }
        start = nl + 1;
        nl = rest.indexOf('\n', start);
      }
      rest = rest.slice(start);
    }
    rest += decoder.end();
    if (rest.trim()) {
      nr += 1;
      let e;
      try { e = JSON.parse(rest); } catch { e = { __broken: true }; }
      yield [e, nr];
    }
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

// --- small helpers ----------------------------------------------------------------------

// Newest first; without a time at the end, then by id. A plain comparison
// (ISO times sort right so) — localeCompare measured as the dearest part.
const newestFirst = (a, b) => {
  const x = a.ts ?? ''; const y = b.ts ?? '';
  if (x !== y) return x > y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * Keeps the `max` newest. A candidate comes as `(ts, id, make)`: the row is
 * only built (`make`) when it can enter — once the holder is full, most lines
 * fall out at the boundary without costing a row.
 */
class Newest {
  constructor(max) { this.max = max; this.list = []; this.edge = null; }

  wants(ts, id) {
    const e = this.edge;
    if (e === null) return true;
    const y = e.ts ?? '';
    return ts !== y ? ts > y : id < e.id;
  }

  offer(ts, id, make) {
    if (!this.wants(ts, id)) return;
    this.list.push(make());
    if (this.list.length >= 2 * this.max) this.trim();
  }

  trim() {
    this.list.sort(newestFirst);
    if (this.list.length > this.max) this.list.length = this.max;
    if (this.list.length === this.max) this.edge = this.list[this.max - 1];
    return this.list;
  }
}

/** A counter with a cap: above `max` the smallest 20 % drop out (then the figures are lower bounds). */
class Counter {
  constructor(max) { this.max = max; this.m = new Map(); this.dropped = 0; }

  add(k, n = 1) {
    const v = this.m.get(k);
    if (v !== undefined) { this.m.set(k, v + n); return; }
    this.m.set(k, n);
    if (this.m.size > this.max) {
      const sorted = [...this.m].sort((x, y) => x[1] - y[1]);
      const cut = Math.ceil(this.m.size * 0.2);
      for (let i = 0; i < cut; i += 1) this.m.delete(sorted[i][0]);
      this.dropped += cut;
    }
  }
}

const withoutZero = (o) => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0));

const agentOf = (e) => {
  const a = e.agent ?? (e.origin && (e.origin.agent ?? e.origin.agent_name));
  return typeof a === 'string' && a.trim() ? a.trim() : null;
};

/** The headline of a RAW line — a locked envelope is never opened. */
function headlineOf(e) {
  if (e && e.body_enc) {
    const t = typeof e.title === 'string' ? e.title.trim() : '';
    return t ? `${t} [locked]` : '[locked]';
  }
  return headline(e);
}

/**
 * The row of one line, in the shape `dashboard.collect()` gives its entries
 * (so `dashboard-data` maps it like any other) — without free text and
 * without anything only the whole store can say (`cited`, `contested`).
 */
function rowOf(e, { id, type, project, source, line, tags, count, drawer }) {
  const ts = e.ts ? String(e.ts) : '';
  return {
    id, ts, day: ts.slice(0, 10), type, typeLabel: TYPE_LABEL[type] || type, project,
    tags: tags.slice(0, 12), headline: headlineOf(e).slice(0, 240), source, line,
    readable: true,
    basis: basis.markOf(e), authority: authority.tierOf(e), author: authority.authorOf(e) || null,
    scope: capability.scopeOf(e), derivedFrom: declaredDerivedFrom(e),
    cited: 0, contested: false, retired: null,
    replaces: e.replaces_id ? String(e.replaces_id) : null,
    contradicts: [], contradictedBy: [], links: [], backlinks: [],
    // Own declared links; whether the end is known is settled at the end.
    own: net.linksOf(e).filter((l) => l.from === id).map((l) => [l.kind, l.to]),
    count, drawer,
  };
}

/**
 * The retirement map of ONE drawer from a second, targeted read: the lines
 * that carry a state field, and the first line of every id they name, in file
 * order — the input of `memory.retiredMapFromFiles`, so the same map.
 */
function retirementOf(file, wanted) {
  const subset = [];
  const seen = new Set();
  for (const [e] of numberedLines(file)) {
    if (!e || e.__broken) continue;
    let claim = false;
    for (const f of authority.STATE_FIELDS) if (e[f]) claim = true;
    const id = typeof e.id === 'string' ? e.id : null;
    if (claim || (id && wanted.has(id) && !seen.has(id))) {
      subset.push(e);
      if (id) seen.add(id);
    }
  }
  return memory.retiredMap(subset);
}

// --- the pass ---------------------------------------------------------------------------

/**
 * The one pass. Read only, writes nothing.
 *
 * @param opt.openIds      ids of open duties (their rows are kept even when old)
 * @param opt.themeHints   topics of the last atlas: they get their sample from the first line on
 * @param opt.recall       `dashboard-data.recallCount()` result or null
 */
export function runPass(root, {
  openIds = new Set(), themeHints = [], recall = null, window = WINDOW,
  themesMax = THEMES_MAX, edgesMax = EDGES_MAX, sample = SAMPLE,
} = {}) {
  const t0 = performance.now();
  const types = Object.keys(memory.TYPES);
  const projects = [null, ...memory.listProjects(root)];
  const table = new IdTable();
  const reasons = [];

  const fresh = () => ({ count: 0, readable: 0, perType: {} });
  const overview = { ...fresh(), perProject: {} };
  let total = 0;
  let broken = 0;
  let held = 0;
  let secondReads = 0;

  const windowKeep = new Newest(window);
  const openRows = new Map(); // id -> row of an open duty
  const questionRows = new Newest(2000);
  const questionList = []; // { id, project }
  const resolves = []; // { id, from, to } — `resolves` lines of the link drawers
  const captures = new Map(); // origin.raw -> { topics:Set, ids:[] (capped), count }

  // atlas
  const tagCount = new Counter(TAGS_MAX);
  const pairCount = new Counter(PAIRS_MAX);
  const tagProject = new Map(); // tag -> { project: n }
  const tagRecall = new Map(); // tag -> [measured, sum of sessions]
  const drawerCount = new Map(); // drawer index -> n
  const drawerKeep = new Map(); // drawer index -> Newest
  const pinned = new Set(themeHints);
  const themeKeep = new Map(); // tag -> Newest

  // agents, projects
  const agents = new Map();
  const agentNames = [];
  const retiredIds = new Set();
  const projectStat = new Map();

  // edges (compact): from/to as fingerprints, the kind as an index
  const kindIndex = new Map();
  const kindName = [];
  let edgeN = 0;
  let edgeCap = 1 << 14;
  let fromA = new Uint32Array(edgeCap); let fromB = new Uint32Array(edgeCap);
  let toA = new Uint32Array(edgeCap); let toB = new Uint32Array(edgeCap);
  let edgeKind = new Uint8Array(edgeCap);
  const addEdge = (from, to, kind) => {
    if (edgeN === edgeCap) {
      edgeCap *= 2;
      const widen = (old, Type) => { const x = new Type(edgeCap); x.set(old); return x; };
      fromA = widen(fromA, Uint32Array); fromB = widen(fromB, Uint32Array);
      toA = widen(toA, Uint32Array); toB = widen(toB, Uint32Array); edgeKind = widen(edgeKind, Uint8Array);
    }
    let k = kindIndex.get(kind);
    if (k === undefined) { k = Math.min(255, kindName.length); if (kindName.length < 255) { kindIndex.set(kind, k); kindName.push(kind); } }
    const [fa, fb] = IdTable.key(from); const [ta, tb] = IdTable.key(to);
    fromA[edgeN] = fa; fromB[edgeN] = fb; toA[edgeN] = ta; toB[edgeN] = tb; edgeKind[edgeN] = k;
    edgeN += 1;
  };

  const recallOf = (place) => {
    if (!recall?.measurable) return null;
    const p = recall.byPlace.get(place);
    return { sessions: p ? p.sessions.size : 0, mentions: p ? p.mentions : 0, last: p ? p.last : null };
  };

  const drawers = [];
  const retirement = new Map(); // drawer index -> retirement map (only drawers with claim lines)
  const linkDrawers = []; // { d, file }
  if (projects.length * types.length >= NONE) reasons.push(`more than ${NONE - 1} drawers: the ones beyond are not tracked`);

  for (let pi = 0; pi < projects.length; pi += 1) {
    const project = projects[pi];
    const p = project ?? 'global';
    for (let ti = 0; ti < types.length; ti += 1) {
      const type = types[ti];
      const d = pi * types.length + ti;
      drawers[d] = { project: p, type };
      let file;
      try { file = memory.logPath(root, type, project); } catch (e) {
        reasons.push(`${p}/${type} not readable: ${e?.message || e}`);
        continue;
      }
      if (!fs.existsSync(file)) continue;
      const source = memory.asSource(root, file);
      const wanted = new Set();
      let claims = 0;
      const ps = projectStat.get(p) ?? { name: p, entries: 0, retired: 0, drawers: new Set(), last: '' };
      projectStat.set(p, ps);
      if (type === 'link') linkDrawers.push({ d, file });
      for (const [e, line] of numberedLines(file)) {
        total += 1;
        if (!e || e.__broken) {
          broken += 1;
          // As the full build lists it: a line that cannot be read is an entry, not readable.
          const tp = (overview.perProject[p] ??= fresh());
          for (const z of [overview, tp]) { z.count += 1; z.perType[type] = (z.perType[type] ?? 0) + 1; }
          continue;
        }
        let claim = false;
        for (const f of authority.STATE_FIELDS) if (e[f]) { claim = true; wanted.add(String(e[f])); }
        if (claim) {
          claims += 1;
          if (e.by_id) wanted.add(String(e.by_id));
        }
        const id = e.id ? String(e.id) : null;
        for (const l of net.linksOf(e)) addEdge(l.from, l.to, l.kind);
        let slot = -1;
        if (id) {
          slot = table.slot(id, true);
          table.where[slot] = d;
        }
        ps.entries += 1; ps.drawers.add(type);
        const ts = e.ts ? String(e.ts) : '';
        if (ts > ps.last) ps.last = ts;
        if (memory.isClosingLine(e)) { ps.retired += 1; continue; }
        // A resolving link: whether it counts is settled at the end.
        if (type === 'link' && e.kind === 'resolves') {
          const from = e.from ?? e.source ?? null; const to = e.to ?? e.target ?? null;
          if (from && to) resolves.push({ id: id ?? '', from: String(from), to: String(to) });
        }
        // An entry (also without an id: it counts in the overview).
        const tp = (overview.perProject[p] ??= fresh());
        for (const z of [overview, tp]) {
          z.count += 1; if (id) z.readable += 1;
          z.perType[type] = (z.perType[type] ?? 0) + 1;
        }
        if (id) {
          if (table.countedIn[slot] === NONE) { table.countedIn[slot] = d; held += 1; }
        } else held += 1;
        const agent = agentOf(e);
        if (agent) {
          let a = agents.get(agent);
          if (!a) {
            a = { agent, count: 0, retired: 0, last: '', types: {}, projects: {}, topics: new Set(), nr: agentNames.length, newest: new Newest(16) };
            agents.set(agent, a); agentNames.push(agent);
          }
          // The newest lines per agent: when the very newest is retired, the next live one counts.
          if (ts) a.newest.offer(ts, id ?? '', () => ({ id: id ?? '', ts }));
          if (slot >= 0) table.agent[slot] = a.nr < NONE ? a.nr : NONE;
          a.count += 1; if (ts > a.last) a.last = ts;
          a.types[type] = (a.types[type] ?? 0) + 1;
          const pk = project ?? '(global)'; a.projects[pk] = (a.projects[pk] ?? 0) + 1;
          if (typeof e.topic === 'string' && e.topic.trim() && a.topics.size < 200) a.topics.add(e.topic.trim());
        }
        if (!id) continue;
        const tags = [...new Set((Array.isArray(e.tags) ? e.tags : []).filter((t) => typeof t === 'string' && t))];
        const place = `${source}:${line}`;
        const count = recallOf(place);
        let row = null;
        const make = () => (row ??= rowOf(e, { id, type, project: p, source, line, tags, count, drawer: d }));
        windowKeep.offer(ts, id, make);
        if (openIds.has(id) && !openRows.has(id)) openRows.set(id, make());
        if (type === 'question' && e.question) { questionList.push({ id, project: p }); questionRows.offer(ts, id, make); }
        // The capture an entry came from -> its topics (the raw capture list)
        const capture = typeof e.origin?.raw === 'string' ? e.origin.raw : null;
        if (capture) {
          const c = captures.get(capture) ?? { topics: new Set(), ids: [], count: 0 };
          captures.set(capture, c);
          c.count += 1;
          for (const t of tags) if (c.topics.size < 12) c.topics.add(t);
          if (typeof e.topic === 'string' && e.topic && c.topics.size < 12) c.topics.add(e.topic);
          if (c.ids.length < 20) c.ids.push(id);
        }
        // atlas: drawer
        drawerCount.set(d, (drawerCount.get(d) ?? 0) + 1);
        let dk = drawerKeep.get(d);
        if (!dk) { dk = new Newest(sample); drawerKeep.set(d, dk); }
        dk.offer(ts, id, make);
        // atlas: topics
        const themes = tags.length ? tags : [NO_THEME];
        for (const t of themes) {
          tagCount.add(t);
          let tpz = tagProject.get(t);
          if (!tpz && tagProject.size < TAGS_MAX) { tpz = {}; tagProject.set(t, tpz); }
          if (tpz) tpz[p] = (tpz[p] ?? 0) + 1;
          if (count) {
            let h = tagRecall.get(t);
            if (!h && tagRecall.size < TAGS_MAX) { h = [0, 0]; tagRecall.set(t, h); }
            if (h) { h[0] += 1; h[1] += count.sessions; }
          }
          let tk = themeKeep.get(t);
          if (!tk && (pinned.has(t) || themeKeep.size < SAMPLE_THEMES_MAX)) { tk = new Newest(sample); themeKeep.set(t, tk); }
          if (tk) tk.offer(ts, id, make);
        }
        for (let x = 0; x < tags.length; x += 1) {
          for (let y = x + 1; y < tags.length && y < 12; y += 1) {
            const [u, w] = tags[x] < tags[y] ? [tags[x], tags[y]] : [tags[y], tags[x]];
            pairCount.add(`${u}\u001f${w}`);
          }
        }
      }
      if (!claims) continue;
      // The second read: only for the lines that retire something and their targets.
      secondReads += 1;
      const map = retirementOf(file, wanted);
      retirement.set(d, map);
      for (const id of map.keys()) {
        const i = table.slot(id);
        if (i < 0) continue;
        if (table.countedIn[i] === d) { table.countedIn[i] = NONE; held -= 1; }
        if (table.where[i] === d) ps.retired += 1;
        retiredIds.add(id);
      }
    }
  }

  // --- the end: states, the net, questions ----------------------------------------
  const retiredIn = (row) => retirement.get(row.drawer)?.get(row.id) ?? null;
  const rowsSeen = new Set(); // row objects (one id can have several lines)
  const note = (list) => { for (const r of list) rowsSeen.add(r); };
  const windowList = windowKeep.trim();
  const questionTop = questionRows.trim();
  note(windowList);
  for (const dk of drawerKeep.values()) note(dk.trim());
  for (const tk of themeKeep.values()) note(tk.trim());
  note([...openRows.values()]);
  note(questionTop);
  const known = (id) => table.slot(id) >= 0;
  const byId = new Map(); // id -> its rows: where a link-drawer line hangs its link
  for (const r of rowsSeen) {
    const u = retiredIn(r);
    if (u) { r.retired = { state: u.state ?? 'superseded', why: u.why ?? null }; }
    r.links = r.own.map(([kind, id]) => ({ kind, id, known: known(id) }));
    delete r.own;
    delete r.drawer;
    const same = byId.get(r.id);
    if (same) same.push(r); else byId.set(r.id, [r]);
  }
  // The link drawers, once more and only they: a line declares a link that
  // hangs on its `from` entry, and the list of hand-drawn links (newest
  // LINKS_MAX) with whether both ends are known.
  const linkKeep = new Newest(LINKS_MAX);
  let linksTotal = 0;
  for (const { file } of linkDrawers) {
    for (const [e] of numberedLines(file)) {
      if (!e || e.__broken || memory.isClosingLine(e) || !e.from || !e.to) continue;
      const from = String(e.from); const to = String(e.to);
      // The declared links of this line (net.linksOf: only the known kinds) hang on their `from` entry.
      for (const l of net.linksOf(e)) {
        if (l.from === String(e.id ?? '')) continue; // an own link, already on the row
        for (const r of byId.get(l.from) ?? []) {
          if (r.links.length < 40) r.links.push({ kind: l.kind, id: l.to, known: known(l.to) });
        }
      }
      linksTotal += 1;
      const ts = e.ts ? String(e.ts) : '';
      linkKeep.offer(ts, String(e.id ?? ''), () => ({
        id: String(e.id ?? ''), from, to, kind: String(e.kind || 'related'),
        why: e.why == null ? null : String(e.why), ts, fromKnown: known(from), toKnown: known(to),
      }));
    }
  }

  // The net, by the rule of `net.build`: both ends must have a line in the store.
  let links = 0; let dangling = 0;
  const pairs = new Map();
  const nameOf = (i) => `${drawers[table.where[i]].project}/${drawers[table.where[i]].type}`;
  for (let i = 0; i < edgeN; i += 1) {
    const f = table.slotOf(fromA[i], fromB[i]); const t = table.slotOf(toA[i], toB[i]);
    if (f < 0 || t < 0) { dangling += 1; continue; }
    links += 1;
    const from = nameOf(f); const to = nameOf(t);
    const key = JSON.stringify([from, to]);
    let pr = pairs.get(key);
    if (!pr) { pr = { from, to, count: 0, kinds: {} }; pairs.set(key, pr); }
    pr.count += 1;
    const kind = kindName[edgeKind[i]] ?? '?';
    pr.kinds[kind] = (pr.kinds[kind] ?? 0) + 1;
  }
  const perBox = new Map();
  for (let i = 0; i < table.capacity; i += 1) {
    if (table.a[i] !== 0 && table.where[i] !== NONE) perBox.set(table.where[i], (perBox.get(table.where[i]) ?? 0) + 1);
  }
  const boxes = [...perBox].map(([d, n]) => ({ name: `${drawers[d].project}/${drawers[d].type}`, project: drawers[d].project, drawer: drawers[d].type, entries: n }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const netOut = {
    boxes,
    pairs: [...pairs.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    links, dangling,
  };

  // Questions (the rule of `question.all`): a question that still holds is open
  // when no `resolves` line whose ends both land points at it. A line withdrawn
  // in its own drawer is no edge.
  const holdsId = (id) => { const i = table.slot(id); return i >= 0 && table.countedIn[i] !== NONE; };
  const lands = (id) => holdsId(id) || memory.isOutsideEvidence(id);
  const withdrawn = (line) => {
    if (!line.id) return false;
    for (const { d } of linkDrawers) if (retirement.get(d)?.has(line.id)) return true;
    return false;
  };
  const answered = new Set();
  for (const l of resolves) if (lands(l.from) && lands(l.to) && !withdrawn(l)) answered.add(l.to);
  const heldQuestions = questionList.filter((q) => holdsId(q.id));
  const openQuestions = heldQuestions.filter((q) => !answered.has(q.id));
  const openPerProject = {};
  for (const q of openQuestions) openPerProject[q.project] = (openPerProject[q.project] ?? 0) + 1;
  const openQuestionIds = new Set(openQuestions.map((q) => q.id));

  // Agents: live counts (the rule of `agentState`: without the retired ids).
  for (const id of retiredIds) {
    const i = table.slot(id);
    if (i < 0 || table.agent[i] === NONE) continue;
    const a = agents.get(agentNames[table.agent[i]]);
    if (!a) continue;
    a.retired += 1;
    const dr = drawers[table.where[i]];
    if (dr) {
      if (a.types[dr.type]) a.types[dr.type] -= 1;
      const pk = dr.project === 'global' ? '(global)' : dr.project;
      if (a.projects[pk]) a.projects[pk] -= 1;
    }
  }
  const lastLive = (a) => {
    const list = a.newest.trim();
    const x = list.find((j) => !retiredIds.has(j.id));
    if (x) return x.ts;
    // Every one of the newest 16 is retired: older than the list reaches, honestly unknown.
    return list.length < 16 ? '' : null;
  };
  const agentList = [...agents.values()].map((a) => ({
    agent: a.agent, count: a.count - a.retired, retired: a.retired, last: lastLive(a),
    types: withoutZero(a.types), projects: withoutZero(a.projects), topics: [...a.topics].sort(),
  })).sort((x, y) => y.count - x.count || x.agent.localeCompare(y.agent));

  // --- the condensed atlas ----------------------------------------------------------
  const themesSorted = [...tagCount.m].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], 'en'));
  const shown = themesSorted.slice(0, themesMax);
  const shownSet = new Set(shown.map(([t]) => t));
  const samples = new Map(); // 'theme:<tag>' | 'drawer:<p/t>' -> rows
  const themes = shown.map(([tag, count]) => {
    const tk = themeKeep.get(tag);
    const h = tagRecall.get(tag);
    // A sample arises only at the FIRST appearance of its topic (later there is
    // no room left; pinned ones stand from the start): whoever has one has it whole.
    const list = tk ? tk.list.slice(0, sample) : [];
    samples.set(`theme:${tag}`, list);
    return {
      tag, count, perProject: tagProject.get(tag) ?? null,
      recall: recall?.measurable ? { measured: h?.[0] ?? 0, sessions: h?.[1] ?? 0 } : null,
      sample: list.length, sampleWhole: Boolean(tk),
    };
  });
  const edges = [...pairCount.m]
    .map(([k, n]) => { const [from, to] = k.split('\u001f'); return { from, to, count: n }; })
    .filter((x) => shownSet.has(x.from) && shownSet.has(x.to))
    .sort((x, y) => y.count - x.count || x.from.localeCompare(y.from) || x.to.localeCompare(y.to))
    .slice(0, edgesMax);
  const atlasDrawers = [...drawerCount].map(([d, n]) => {
    const list = drawerKeep.get(d)?.list.slice(0, sample) ?? [];
    const key = `${drawers[d].project}/${drawers[d].type}`;
    samples.set(`drawer:${key}`, list);
    return { drawer: key, project: drawers[d].project, type: drawers[d].type, count: n, sample: list.length, sampleWhole: true };
  }).sort((x, y) => y.count - x.count || x.drawer.localeCompare(y.drawer));
  const exact = tagCount.dropped === 0 && pairCount.dropped === 0;
  const atlas = {
    themesTotal: tagCount.m.size + tagCount.dropped,
    themesShown: themes.length,
    themes, edges, drawers: atlasDrawers, sampleEach: sample, exact,
    ...(exact ? {} : { reason: `counters capped (${tagCount.dropped} topics, ${pairCount.dropped} pairs dropped): the figures are lower bounds` }),
  };
  // The kept rows once per id: the sample entries point at them by key only.
  const rowsById = new Map();
  for (const list of samples.values()) for (const r of list) rowsById.set(r.id, r);

  return {
    reasons, broken, linesRead: total, secondReads,
    total, held, overview,
    window: windowList,
    openRows: [...openRows.values()],
    questions: {
      total: heldQuestions.length, open: openQuestions.length, openIds: openQuestionIds, openPerProject,
      rows: questionTop.filter((r) => openQuestionIds.has(r.id)),
    },
    agents: agentList,
    projects: [...projectStat.values()].map((x) => ({ name: x.name, entries: x.entries, retired: x.retired, drawers: [...x.drawers].sort(), last: x.last || null }))
      .sort((a, b) => b.entries - a.entries || a.name.localeCompare(b.name)),
    captures,
    links: linkKeep.trim(), linksTotal,
    net: netOut,
    atlas, samples,
    ids: table.n,
    memory: { tableBytes: table.bytes(), edgeBytes: edgeCap * 18 },
    ms: Math.round(performance.now() - t0),
  };
}

// --- one page of the atlas ----------------------------------------------------------------

/**
 * A page of the atlas when the pass's sample does not reach: the newest `max`
 * entries of a topic (`theme`; NO_THEME for entries without a tag) or of a
 * drawer (`drawer` = 'project/type'), optionally only from `project`. One pass
 * over the drawers concerned, memory held to 2·`max` rows; retired entries
 * as in the pass. Runs in the build worker, never in the server thread.
 */
export function atlasSearch(root, { theme = null, drawer = null, project = null, max = SAMPLE, recall = null } = {}) {
  const types = Object.keys(memory.TYPES);
  const cut = drawer ? drawer.lastIndexOf('/') : -1;
  const [dp, dt] = cut >= 0 ? [drawer.slice(0, cut), drawer.slice(cut + 1)] : [null, null];
  const only = dp ?? project;
  const projects = [null, ...memory.listProjects(root)].filter((x) => !only || (x ?? 'global') === only);
  const keep = new Newest(max);
  let read = 0;
  let hits = 0;
  for (const pr of projects) {
    const p = pr ?? 'global';
    for (const type of types) {
      if (dt && type !== dt) continue;
      let file;
      try { file = memory.logPath(root, type, pr); } catch { continue; }
      if (!fs.existsSync(file)) continue;
      const source = memory.asSource(root, file);
      const here = [];
      const wanted = new Set();
      let claims = 0;
      for (const [e, line] of numberedLines(file)) {
        read += 1;
        if (!e || e.__broken) continue;
        for (const f of authority.STATE_FIELDS) if (e[f]) { claims += 1; wanted.add(String(e[f])); }
        if (e.by_id && e.retires_id) wanted.add(String(e.by_id));
        if (memory.isClosingLine(e) || !e.id) continue;
        const tags = [...new Set((Array.isArray(e.tags) ? e.tags : []).filter((t) => typeof t === 'string' && t))];
        if (theme && !(theme === NO_THEME ? tags.length === 0 : tags.includes(theme))) continue;
        hits += 1;
        const id = String(e.id);
        let count = null;
        if (recall?.measurable) {
          const q = recall.byPlace.get(`${source}:${line}`);
          count = { sessions: q ? q.sessions.size : 0, mentions: q ? q.mentions : 0, last: q ? q.last : null };
        }
        const row = rowOf(e, { id, type, project: p, source, line, tags, count, drawer: -1 });
        row.links = row.own.map(([kind, to]) => ({ kind, id: to, known: true }));
        delete row.own;
        here.push(row);
        keep.offer(row.ts, id, () => row);
      }
      if (claims && here.length) {
        const map = retirementOf(file, wanted);
        for (const r of here) {
          const u = map.get(r.id);
          if (u) r.retired = { state: u.state ?? 'superseded', why: u.why ?? null };
        }
      }
    }
  }
  return { rows: keep.trim(), total: hits, read };
}

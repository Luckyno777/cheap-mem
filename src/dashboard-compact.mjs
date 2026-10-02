// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard-compact.mjs — the build of `/dashboard.json` for a store the full
// build cannot handle (task atlas-pass-cm, 2026-10-02; the sibling's
// `src/dashboard-kompakt.mjs`).
//
// **Why a second build.** `collectDashboard()` keeps the WHOLE store several
// times in memory and reads it a dozen times (100,000 entries: 43 s and
// 1.2 GB peak; 250,000: 99 s and 2.9 GB). Above `FULL_BUILD_UP_TO_BYTES`
// (src/dashboard-head.mjs) the server used to build only a light head:
// counters and newest titles, everything else unknown. The compact build
// replaces that head with a real answer:
//
//   1. ONE pass over the drawers (`runPass()`, src/dashboard-pass.mjs) feeds
//      what the store decides: counters, the line total, the net, the open
//      questions, the agents, the projects, the newest entries and the
//      condensed 3D atlas. Memory: counters, bounded lists and a fingerprint
//      table (about 14 bytes an entry).
//   2. Everything else comes from the SAME `collectDashboard()` as the full
//      build — the answer has the same shape, so every view that does not need
//      the whole store works unchanged. `dashboard.collect()` is handed the
//      pass's results instead of reading the store itself (its `pre`).
//   3. The modules that read the whole store on their own (the integrity scan,
//      the duties, the facts, topics and learnings) run only up to
//      `MODULES_UP_TO_BYTES`. Above, each is "unknown" with its reason — never
//      an empty list, never 0. The doctor and the today card read the store
//      several times (measured, see DOCTOR_REASON) and never run here: they are
//      "unknown" with that reason; `mem doctor` runs the doctor.
//
// Every part's time stands in `build.parts` (ms), so a measurement shows where
// the time goes.
//
// invariant: three-states-never-two
// invariant: no-fallback-to-invented-data

import path from 'node:path';
import * as memory from './memory.mjs';
import * as board from './board.mjs';
import * as dashboard from './dashboard.mjs';
import * as consolePage from './console.mjs';
import * as viewer from './viewer.mjs';
import * as agentsModule from './agents.mjs';
import * as injection from './injection.mjs';
import * as dd from './dashboard-data.mjs';
import { runPass } from './dashboard-pass.mjs';

/**
 * Up to this size of the drawers (bytes) the modules that read the whole
 * store on their own still run in the compact build. Above, they are
 * "unknown" with a reason. Measured: see the changelog entry of 2026-10-02.
 */
const MODULES_UP_TO_BYTES = 128 * 1024 * 1024;

const DOCTOR_REASON = 'the doctor reads the whole store several times (measured: 8.6 s at 20,000 entries, 98 s and 1.4 GB at 250,000); it runs only in the full build, `mem doctor` runs it from the command line';

const newestFirst = (a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')) || String(a.id).localeCompare(String(b.id));

/**
 * The compact build. `bytes` is the size of the drawers (measured by the
 * caller, `dashboard-cache.storeBytes`); `themeHints` the topics of the
 * last atlas (they get their sample from the first line on).
 */
export function collectCompact(root, {
  env = process.env, now = new Date(), cfg = {}, title = 'cheap-mem', writesAllowed = false,
  bytes = null, themeHints = [], modulesUpTo = MODULES_UP_TO_BYTES, why = null, window = undefined,
} = {}) {
  const t0 = performance.now();
  const parts = {};
  const time = (name, fn) => {
    const t = performance.now();
    try { return fn(); } finally { parts[name] = Math.round(performance.now() - t); }
  };
  const modulesOn = bytes !== null && bytes <= modulesUpTo;
  const mb = (n) => Math.round(n / 1048576);
  const notRun = `not computed in the compact build: drawers ${bytes === null ? 'of unknown size' : `${mb(bytes)} MB`} over the ${mb(modulesUpTo)} MB up to which a module that reads the whole store runs`;
  const unknown = {}; // lens -> reason

  // The injection journal: read once, for everything below.
  let journalGot; let journalError = null;
  time('journal', () => { try { journalGot = injection.read(root); } catch (e) { journalError = e; } });
  const readJournal = () => { if (journalError) throw journalError; return journalGot; };
  const recall = dd.recallCount(root, { read: readJournal });

  // Duties: one drawer, read in full — a module like the others.
  let duties = null; let dutiesError = null;
  time('duties', () => {
    if (!modulesOn) { dutiesError = notRun; return; }
    try { duties = memory.openDuties(root); } catch (e) { dutiesError = `duties not readable: ${e?.message || e}`; }
  });
  const openIds = new Set((duties?.open ?? []).map((x) => x.id).filter(Boolean));

  // --- 1. the single pass -----------------------------------------------------------
  const p = time('pass', () => runPass(root, { openIds, themeHints, recall, ...(window ? { window } : {}) }));

  // --- 2. what the answer takes from the pass --------------------------------------
  // The list is the newest window; the open duties and questions older than
  // it travel apart (`extras`) — they are for the start page's head only, never
  // part of the pages of the list (those would then not be contiguous).
  const rowsAll = [...p.window].sort(newestFirst);
  const inWindow = new Set(rowsAll.map((r) => r.id));
  const extraRows = [];
  for (const r of [...p.openRows, ...p.questions.rows]) {
    if (!inWindow.has(r.id)) { inWindow.add(r.id); extraRows.push(r); }
  }

  let registered = [];
  try { registered = agentsModule.listAgents(root); } catch { registered = []; }
  const inPass = new Map(p.agents.map((a) => [a.agent, a]));
  const names = new Set([...registered.map((a) => a.name), ...inPass.keys()]);
  const agents = [...names].sort().map((n) => {
    const a = registered.find((x) => x.name === n) ?? null;
    const st = inPass.get(n) ?? { count: 0, last: '', types: {}, projects: {}, topics: [] };
    return {
      name: n, role: a ? a.role : '', model: a ? a.model : '', active: a ? a.active : true, registered: Boolean(a),
      knowledge: a ? a.knowledge : [], skills: a ? a.skills : [], folder: a ? a.content : null,
      count: st.count, last: st.last, types: st.types, projects: st.projects, topics: st.topics,
    };
  });

  const guarded = (name, fn, empty) => {
    if (!modulesOn) { unknown[name] = notRun; return empty; }
    try { return time(name, fn); } catch (e) { unknown[name] = `${name} not readable: ${e?.message || e}`; return empty; }
  };
  const topicsLens = guarded('topics', () => viewer.topicsLens(root), { topics: [], areas: [], quality: null });
  const experiences = guarded('experiences', () => viewer.experiencesLens(root), []);
  const facts = guarded('facts', () => viewer.factsLens(root), []);
  const { storeList, storeState } = viewer.storeRegister(root);

  const questions = p.questions;
  const questionsTile = () => ({
    id: 'questions', title: 'Open questions', state: board.STATE.CALM,
    line: questions.open ? `${questions.open} open` : 'none open',
    numbers: { count: questions.open },
  });
  const pre = {
    console: time('console', () => consolePage.collect(root, {
      env, now, cfg,
      boardOf: (r, o) => board.board(r, { ...o, questionsTile }),
      inventoryOf: (r) => consolePage.inventory(r, { known: p.total }),
    })),
    memory: {
      name: path.basename(path.resolve(root)),
      entries: [],
      topics: topicsLens.topics, areas: topicsLens.areas, quality: topicsLens.quality,
      agents, store: storeList, storeState,
      links: p.links,
      experiences, facts,
      counts: {
        total: p.overview.count, perType: p.overview.perType,
        perProject: Object.fromEntries(Object.entries(p.overview.perProject).map(([k, v]) => [k, v.count])), perDay: {},
      },
    },
    pass: { rows: [], broken: p.broken },
    net: {
      graph: p.net,
      derived: { unknown: true, reason: 'derived links need the whole store; not computed in the compact build' },
    },
    entries: rowsAll,
    work: {
      duties: duties
        ? dashboard.workTile('Duties', duties.open.length, duties.open.length + duties.done.length, { noun: 'duties', whenEmpty: 'no duty has ever been recorded' })
        : { title: 'Duties', value: null, state: 'unknown', note: dutiesError, open: null, total: null },
      questions: dashboard.workTile('Questions', questions.open, questions.total, { noun: 'questions', whenEmpty: 'no question has ever been asked' }),
    },
    projects: (agentList) => p.projects.map((x) => ({
      name: x.name, entries: x.entries, retired: x.retired, drawers: x.drawers, last: x.last,
      agents: agentList.filter((a) => Object.keys(a.projects || {}).includes(dashboard.agentKey(x.name)))
        .map((a) => ({ name: a.name, entries: (a.projects || {})[dashboard.agentKey(x.name)] ?? 0 })),
      openQuestions: questions.openPerProject[x.name] ?? 0,
    })),
  };

  // --- 3. the answer, from the same collector as the full build --------------------
  const unavailable = (what) => () => { throw new Error(`${what}: ${notRun}`); };
  const data = time('collect', () => dd.collectDashboard(root, {
    env, now, cfg, title, writesAllowed,
    collect: (r, o) => dashboard.collect(r, { ...o, pre }),
    readPass: () => pre.pass,
    readJournal,
    doctorCheck: () => { throw new Error(DOCTOR_REASON); },
    dutiesOpen: () => { if (duties) return duties; throw new Error(dutiesError); },
    questionsOpen: () => questions.rows,
    todayOf: () => { throw new Error(`the today card needs the doctor: ${DOCTOR_REASON}`); },
    ...(modulesOn ? {} : { integrityOf: unavailable('the integrity scan') }),
  }));

  // The capture list: the topics and entries of each capture from the pass.
  for (const c of data.raw?.captures ?? []) {
    const x = p.captures.get(c.path);
    if (!x) continue;
    c.topics = [...x.topics].slice(0, 12);
    c.entries = x.ids;
    if (x.count > x.ids.length) c.entriesTotal = x.count;
  }

  data.extras = extraRows.map((z) => dd.entryRow(z, null, z.count ?? null));

  // The pages of the atlas: rows in the shape of `entries`, kept by the server.
  const samples = new Map();
  for (const [key, list] of p.samples) samples.set(key, list.map((z) => dd.entryRow(z, null, z.count ?? null)));

  const reasonWhy = why ?? `Drawers ${bytes === null ? '(size unknown)' : `${mb(bytes)} MB`}: the compact build runs (one pass over the drawers, bounded memory). Entries are the newest ${rowsAll.length.toLocaleString('en-US')} without free text; the 3D atlas is condensed.`;
  data.reasons = [reasonWhy, ...p.reasons, ...data.reasons];
  data.reasons.push(`Doctor and today: ${DOCTOR_REASON}.`);
  if (!modulesOn) data.reasons.push(`Integrity, duties, facts, topics and learnings: ${notRun}`);
  data.state = 'warning';
  data.compact = {
    bytes, modulesUpTo, modules: modulesOn, unknown,
    window: rowsAll.length, entriesTotal: p.overview.count, held: p.held,
    openQuestions: questions.open, derivedLinks: 'not computed',
    citations: 'not computed',
  };
  data.overview = p.overview;
  data.atlas = { ...p.atlas, condensed: true };
  data.samples = samples;
  data.openQuestionsTotal = questions.open;
  data.build = {
    kind: 'compact', ms: Math.round(performance.now() - t0), parts,
    lines: p.linesRead, secondReads: p.secondReads, ids: p.ids, memory: p.memory, modules: modulesOn,
  };
  return data;
}

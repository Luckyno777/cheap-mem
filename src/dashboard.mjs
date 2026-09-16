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

export const VIEWS = Object.freeze(['desk', 'knowledge', 'projects', 'agents', 'net', 'set']);

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
  };
}

// ---------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------
//
// **Dark first, and both themes real.** The house tokens live in
// `docs/viewer-design-tokens.json` and the viewer mirrors them; this
// page uses the same values, only the other way round — the complete
// palette sits on the bare `:root` in its dark spelling and the light
// one redefines every token inside `@media (prefers-color-scheme:
// light)`. Not one colour is declared in only one of the two blocks,
// which is the classic bug that leaves one theme's text on the other
// theme's ground.
//
// **No shadow, no webfont, no pill radius** — the token file names all
// three as deliberate absences. The arriving export had all three.
//
// **No network.** Everything the page needs is inside it: no CDN, no
// fetch, no `/console.json` round trip. That is what makes the page
// usable on a plane, and it is also what makes a demo fallback
// impossible — there is no failing request to fall back from.

/** HTML special characters. Everything here is memory content or a path. */
function h(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** JSON that cannot break out of the <script> element it sits in. */
function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

/** How many knowledge rows the list renders before it says so out loud. */
export const LIST_MAX = 400;

/** The key of one matrix cell. Not a separator a drawer name can contain. */
const CELL = (from, to) => `${from} >> ${to}`;

const TABS = Object.freeze({
  desk: 'Desk',
  knowledge: 'Knowledge',
  projects: 'Projects',
  agents: 'Agents',
  net: 'Net',
  set: 'Set',
});

const DARK = {
  paper: '#141716', raised: '#1B1F1D', sunk: '#202523', ink: '#E7EAE6',
  muted: '#B4BBB5', faint: '#8B9089', rule: '#2C332F', 'rule-soft': '#242A27',
  accent: '#7FC3D4', 'accent-soft': '#172C32', warn: '#D9A758', 'warn-soft': '#2B2416',
  gone: '#E08C85', 'gone-soft': '#2E1D1C', fresh: '#6FBF97',
};
const LIGHT = {
  paper: '#FAF9F6', raised: '#FFFFFF', sunk: '#F1EFE9', ink: '#1A1C1B',
  muted: '#4D5350', faint: '#696E6B', rule: '#E4E1D9', 'rule-soft': '#EFECE5',
  accent: '#1F5E70', 'accent-soft': '#E1EDF0', warn: '#8A5A12', 'warn-soft': '#F6EEDE',
  gone: '#8C3A34', 'gone-soft': '#F6E6E4', fresh: '#2C6B4F',
};
const vars = (t) => Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';');

/** State to token. One map, so a fifth state cannot quietly pick a colour. */
const TONE = Object.freeze({
  calm: 'fresh', watch: 'warn', alarm: 'gone', unknown: 'faint',
});
function tone(state) {
  const t = TONE[state];
  if (!t) throw new Error(`No tone for state '${state}'. Known: ${Object.keys(TONE).join(', ')}`);
  return t;
}

const CSS = `
:root{color-scheme:dark light;${vars(DARK)};
  --ui:system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;
  --prose:Charter,'Bitstream Charter','Sitka Text',Cambria,Georgia,serif;
  --code:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}
@media (prefers-color-scheme:light){:root{${vars(LIGHT)}}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.45 var(--ui)}
/* Not sticky, deliberately: the shared nav bar that console.insertNav
   puts above this one is, at top:0. Two stuck bars fighting for the
   same edge is a layout that works until someone scrolls. */
.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;padding:10px 20px;
  background:var(--raised);border-bottom:1px solid var(--rule)}
.brand{font-size:20px;font-weight:700;letter-spacing:-0.015em;margin-right:8px}
.brand span{display:block;font:11px/1.3 var(--code);letter-spacing:0.03em;
  color:var(--faint);font-weight:400}
.tabs{display:flex;gap:2px;flex:1 1 auto;overflow-x:auto}
.tab{border:0;background:transparent;color:var(--muted);font:14px var(--ui);
  padding:9px 12px;border-radius:6px;cursor:pointer;
  border-bottom:2px solid transparent;white-space:nowrap}
.tab:hover{background:var(--sunk);color:var(--ink)}
.tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--accent)}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.asof{font:12px var(--code);color:var(--faint)}
main{max-width:1080px;margin:0 auto;padding:24px 20px 64px}
h1{font-size:20px;font-weight:700;letter-spacing:-0.015em;margin:0 0 4px}
h2{font-size:13px;font-weight:400;text-transform:uppercase;letter-spacing:0.08em;
  color:var(--faint);margin:28px 0 10px;display:flex;gap:10px;flex-wrap:wrap;
  align-items:baseline}
h2 em{font-style:normal;text-transform:none;letter-spacing:0;font-size:12px}
.lead{max-width:70ch;color:var(--muted);margin:0 0 4px}
.grid{display:grid;gap:10px;grid-template-columns:repeat(auto-fill,minmax(250px,1fr))}
.card{background:var(--raised);border:1px solid var(--rule);
  border-left:2px solid var(--c,var(--rule));border-radius:8px;padding:12px 14px}
.card .name{font-weight:600;font-size:15px}
.card .st{font:11px var(--code);letter-spacing:0.03em;color:var(--c,var(--faint))}
.card .big{font-size:17px;font-weight:600;margin:6px 0 2px}
.card p{margin:4px 0 0;color:var(--muted);font-size:13px}
.card .why{color:var(--faint);font:12px var(--code);word-break:break-word}
.kv{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px}
.kv b{font:11px var(--code);letter-spacing:0.03em;color:var(--faint);font-weight:400;
  text-transform:uppercase;display:block}
.kv>div{min-width:72px}
.chip{display:inline-block;font:11px var(--code);letter-spacing:0.03em;
  background:var(--sunk);color:var(--muted);border:1px solid var(--rule-soft);
  border-radius:3px;padding:1px 5px;margin:2px 3px 0 0}
.chip.on{background:var(--accent-soft);color:var(--accent);border-color:var(--accent)}
.none{color:var(--faint);background:var(--sunk);border:1px solid var(--rule-soft);
  border-radius:8px;padding:12px 14px;max-width:70ch}
.missing{color:var(--faint);font-style:italic}
.split{display:grid;grid-template-columns:minmax(300px,40%) 1fr;gap:12px;
  align-items:start}
.pane{background:var(--raised);border:1px solid var(--rule);border-radius:8px;padding:12px}
#q{width:100%;padding:8px 10px;border:1px solid var(--rule);border-radius:6px;
  background:var(--paper);color:var(--ink);font:15px var(--prose)}
#q:focus{outline:2px solid var(--accent);outline-offset:1px}
.filters{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
button.chip{cursor:pointer}
button.chip:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.list{max-height:70vh;overflow:auto;border-top:1px solid var(--rule-soft);margin-top:8px}
.item{display:block;width:100%;text-align:left;background:transparent;border:0;
  border-bottom:1px solid var(--rule-soft);padding:10px 8px;cursor:pointer;color:inherit}
.item:hover{background:var(--sunk)}
.item[aria-current=true]{background:var(--accent-soft)}
.item:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.item .h{font:600 15px/1.35 var(--prose);letter-spacing:-0.005em;display:block}
.item .m{font:11px var(--code);letter-spacing:0.03em;color:var(--faint);
  margin-top:2px;display:block}
.item.gone .h{color:var(--gone);text-decoration:line-through}
.detail h3{font:600 17px/1.35 var(--prose);margin:0 0 2px}
.detail .m{font:12px var(--code);color:var(--faint)}
.detail dl{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:14px 0 0;
  font-size:13px}
.detail dt{font:11px var(--code);letter-spacing:0.03em;text-transform:uppercase;
  color:var(--faint)}
.detail dd{margin:0;word-break:break-word}
.wrap{overflow-x:auto;background:var(--raised);border:1px solid var(--rule);
  border-radius:8px}
table{border-collapse:collapse;font:13px var(--ui);width:100%}
th,td{padding:7px 10px;border-bottom:1px solid var(--rule-soft);
  border-right:1px solid var(--rule-soft);text-align:center;white-space:nowrap}
th{font:11px var(--code);letter-spacing:0.03em;color:var(--faint);font-weight:400;
  background:var(--sunk)}
td.row-h,th.row-h{text-align:left;font:11px var(--code);color:var(--muted)}
td.hit{background:var(--accent-soft);color:var(--accent);cursor:pointer;font-weight:600}
td.hit:hover{background:var(--sunk)}
td.hit:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
td.nil{color:var(--faint)}
form.set{background:var(--raised);border:1px solid var(--rule);border-radius:8px;
  padding:12px 14px;margin:0 0 10px}
form.set .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
form.set input{flex:1 1 180px;padding:7px 9px;border:1px solid var(--rule);
  border-radius:6px;background:var(--paper);color:var(--ink);font:14px var(--code)}
form.set input:focus{outline:2px solid var(--accent);outline-offset:1px}
form.set button{padding:7px 14px;border:1px solid var(--accent);border-radius:6px;
  background:var(--accent-soft);color:var(--accent);font:14px var(--ui);cursor:pointer}
form.set button:hover:not(:disabled){background:var(--accent);color:var(--paper)}
form.set button:disabled,form.set input:disabled{opacity:.5;cursor:not-allowed}
form.set .src{font:11px var(--code);color:var(--faint);margin:8px 0 0}
form.set .eff{color:var(--muted);font-size:13px;margin:4px 0 0}
ol.steps{list-style:none;padding:0;margin:0}
ol.steps li{background:var(--raised);border:1px solid var(--rule);
  border-left:2px solid var(--c,var(--rule));border-radius:8px;padding:10px 12px;
  margin:0 0 8px}
ol.steps b{font-size:15px}
@media (max-width:620px){
  main{padding:18px 16px 56px}
  .tab{padding:13px 12px}
  .split{grid-template-columns:1fr}
  .grid{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

/** A tile: state spine, state word, the measured line, the detail. */
function tileCard(t) {
  return `<article class="card" style="--c:var(--${tone(t.state)})">
    <div class="name">${h(t.title)}</div>
    <div class="st">${h(t.word ?? word(t.state))}</div>
    <p>${h(t.line)}</p>
    ${t.detail ? `<p class="why">${h(t.detail)}</p>` : ''}
  </article>`;
}

/** A work tile. `value === null` prints the reason, never a zero. */
function workCard(w) {
  return `<article class="card" style="--c:var(--${tone(w.state)})">
    <div class="name">${h(w.title)}</div>
    <div class="st">${h(word(w.state))}</div>
    <div class="big">${w.value === null
    ? '<span class="missing">not measured</span>' : h(w.value)}</div>
    <p>${h(w.note)}</p>
  </article>`;
}

function deskView(d) {
  const attention = d.attention.length
    ? `<div class="grid">${d.attention.map(tileCard).join('')}</div>`
    // Three states here too: "nothing wants attention" is not the same
    // sentence as "nothing was measured", and the second one is the one
    // worth noticing.
    : `<p class="none">Every one of the ${d.system.length} tiles reports
       <b>${h(WORD.calm)}</b>. Nothing is unmeasured and nothing is broken.</p>`;
  return `<h1>Desk</h1>
    <p class="lead">What was measured, what wants someone, and what is still open.
      Warnings and unmeasured states come first — a tile that could not be taken
      never sorts below one that is in order.</p>
    <h2>System state <em>${d.system.length} tiles · ${d.attention.length} not in order</em></h2>
    <div class="grid">${d.system.map(tileCard).join('')}</div>
    <h2>Attention <em>alarm first, then unmeasured</em></h2>
    ${attention}
    <h2>Active work <em>open against the total that was recorded</em></h2>
    <div class="grid">${d.work.map(workCard).join('')}</div>`;
}

function knowledgeView(d) {
  const types = [...new Set(d.entries.map((e) => e.type))].sort();
  const shown = d.entries.slice(0, LIST_MAX);
  const cut = d.entries.length - shown.length;
  const rows = shown.map((e) => `<button class="item${e.retired ? ' gone' : ''}"
      data-id="${h(e.id)}" data-type="${h(e.type)}"
      data-find="${h(`${e.headline} ${e.type} ${e.project} ${e.author ?? ''} ${e.tags.join(' ')}`.toLowerCase())}">
      <span class="h">${h(e.headline)}</span>
      <span class="m">${h(e.type)} · ${h(e.project)} · ${h(e.author ?? 'no author recorded')}${
  e.retired ? ` · ${h(e.retired.state)}` : ''}</span>
    </button>`).join('');
  return `<h1>Knowledge</h1>
    <p class="lead">Every entry this memory holds, retracted ones included and marked.
      Picking one shows what it was built on and what stands against it.</p>
    <h2>Entries <em>${d.entries.length} total${
  cut > 0 ? ` · showing the newest ${LIST_MAX}, ${cut} not listed` : ''}${
  d.broken ? ` · ${d.broken} unreadable line${d.broken === 1 ? '' : 's'}` : ''}</em></h2>
    <div class="split">
      <div class="pane">
        <label class="m" for="q">Search</label>
        <input id="q" type="search" placeholder="headline, type, project, author, tag"
          autocomplete="off">
        <div class="filters">
          <button class="chip on" data-type="">all</button>
          ${types.map((t) => `<button class="chip" data-type="${h(t)}">${h(t)}</button>`).join('')}
        </div>
        <div class="list" id="list">${rows
    || '<p class="none">This memory holds no entries yet.</p>'}</div>
        <p class="m" id="hits"></p>
      </div>
      <div class="pane detail" id="detail">
        <p class="none">Pick an entry. Basis, authority, scope, standing, what it
          replaces and what contradicts it appear here.</p>
      </div>
    </div>`;
}

function projectsView(d) {
  if (!d.projects.length) {
    return '<h1>Projects</h1><p class="none">No project drawer has been written to yet.</p>';
  }
  const cards = d.projects.map((p) => `<article class="card">
    <div class="name">${h(p.name)}</div>
    <div class="st">last entry ${p.last
    ? h(p.last.replace('T', ' ').replace('Z', '')) : 'never'}</div>
    <div class="kv">
      <div><b>entries</b>${p.entries}</div>
      <div><b>retracted</b>${p.retired}</div>
      <div><b>drawers</b>${p.drawers.length}</div>
      <div><b>open questions</b>${p.openQuestions}</div>
    </div>
    <p>${p.drawers.map((x) => `<span class="chip">${h(x)}</span>`).join('')}</p>
    <p class="why">${p.agents.length
    ? `written by ${p.agents.map((a) => `${h(a.name)} (${a.entries})`).join(', ')}`
    : 'no agent recorded on any entry here'}</p>
  </article>`).join('');
  return `<h1>Projects</h1>
    <p class="lead">One card per drawer group, with what is actually in it. The counts
      come from the same single read the net and the knowledge list come from.</p>
    <h2>Workspaces <em>${d.projects.length}</em></h2>
    <div class="grid">${cards}</div>`;
}

function agentsView(d) {
  if (!d.agents.length) {
    return '<h1>Agents</h1><p class="none">Nobody is registered and nobody appears in the log.</p>';
  }
  // Registered and seen are two different sets, and the page shows both
  // sides rather than their intersection: an agent writing without a
  // folder is the gap nobody notices otherwise.
  const cards = d.agents.map((a) => {
    const state = (a.registered && a.count > 0) ? 'calm' : 'watch';
    const note = !a.registered ? 'writes without a folder under agents/'
      : a.count === 0 ? 'registered, has never written anything'
        : 'registered and writing';
    return `<article class="card" style="--c:var(--${tone(state)})">
      <div class="name">${h(a.name)}</div>
      <div class="st">${h(note)}</div>
      <div class="kv">
        <div><b>entries</b>${a.count}</div>
        <div><b>retracted</b>${a.retired ?? 0}</div>
        <div><b>model</b>${a.model
    ? h(a.model) : '<span class="missing">none recorded</span>'}</div>
        <div><b>role</b>${a.role
    ? h(a.role) : '<span class="missing">none recorded</span>'}</div>
      </div>
      <p class="why">last ${a.last
    ? h(String(a.last).replace('T', ' ').replace('Z', '')) : 'never'}</p>
      <p>${Object.keys(a.projects || {}).map((x) => `<span class="chip">${h(x)}</span>`).join('')
      || '<span class="missing">no project</span>'}</p>
    </article>`;
  }).join('');
  return `<h1>Agents</h1>
    <p class="lead">Registered and actually observed in the memory, shown side by side.
      No capability rating is invented — only what a folder or an entry says.</p>
    <h2>Known <em>${d.agents.length}</em></h2>
    <div class="grid">${cards}</div>`;
}

function netView(d) {
  const { boxes, pairs, dangling } = d.net;
  if (!pairs.length) {
    return `<h1>Net</h1>
      <p class="lead">Only declared links. Nothing is inferred from similarity.</p>
      <p class="none">${boxes.length} drawer${boxes.length === 1 ? '' : 's'} hold entries and
        <b>not one declared link</b> runs between them${dangling
  ? `, though ${dangling} link${dangling === 1 ? '' : 's'} point${
    dangling === 1 ? 's' : ''} at an entry that is not here`
  : ''}. The matrix is empty because nothing was linked — not because nothing
        was measured.</p>`;
  }
  // Only the drawers that actually carry an edge get a row: an N-by-N
  // grid of mostly dots hides the few cells that say something. How many
  // were left out is stated rather than silently dropped.
  const live = [...new Set(pairs.flatMap((p) => [p.from, p.to]))].sort();
  const map = new Map(pairs.map((p) => [CELL(p.from, p.to), p]));
  const head = `<tr><th class="row-h">from \\ to</th>${
    live.map((n) => `<th>${h(n)}</th>`).join('')}</tr>`;
  const body = live.map((r) => `<tr><td class="row-h">${h(r)}</td>${live.map((c) => {
    const p = map.get(CELL(r, c));
    return p
      ? `<td class="hit" tabindex="0" data-cell="${h(CELL(r, c))}">${p.count}</td>`
      : '<td class="nil">·</td>';
  }).join('')}</tr>`).join('');
  return `<h1>Net</h1>
    <p class="lead">Only declared links — <code>${h(net.LINK_KINDS.join(', '))}</code>.
      Nothing is inferred from similarity.</p>
    <h2>Drawer matrix <em>${live.length} of ${boxes.length} drawers carry an edge · ${
  d.net.links} link${d.net.links === 1 ? '' : 's'} · ${dangling} dangling</em></h2>
    <div class="wrap"><table>${head}${body}</table></div>
    <p class="none" id="netdetail">Pick a filled cell.</p>`;
}

/**
 * The sixth tab, and the reason there are six.
 *
 * The console could SET things; this page could only look. Shipping a
 * desk that replaces the front door while quietly dropping the forms
 * would be the capability-without-reach this project keeps building
 * against: built, documented, and absent where someone is standing.
 *
 * The forms post to `/setting`, the same address as before, so the
 * origin check and the write lock keep applying unchanged.
 */
function setView(d, { writable }) {
  const forms = d.settings.map((s) => `
    <form class="set" method="post" action="/setting">
      <input type="hidden" name="id" value="${h(s.id)}">
      <input type="hidden" name="from" value="/">
      <label for="f-${h(s.id)}"><strong>${h(s.title)}</strong></label>
      <p class="eff">${h(s.description)}</p>
      <div class="row">
        <input id="f-${h(s.id)}" name="value" value="${h(s.value ?? '')}"
          ${s.kind === 'number' ? 'type="number" min="1"' : 'type="text" spellcheck="false"'}
          ${writable && s.writable !== false ? '' : 'disabled'}>
        <button type="submit"${writable && s.writable !== false ? '' : ' disabled'}>Set</button>
      </div>
      <p class="src">Source: <b>${h(s.source)}</b>${
  s.writable === false ? ' · <b>not writable</b>' : ''}${s.note ? ` · ${h(s.note)}` : ''}</p>
      <p class="eff">${h(s.effect)}</p>
    </form>`).join('');

  // Three states per step, and the colour comes from the same TONE map
  // the tiles use — a second colour table would drift from the first.
  const steps = d.setup.map((s) => `
    <li style="--c:var(--${tone(s.state === 'done' ? 'calm'
    : s.state === 'open' ? 'watch' : 'unknown')})">
      <b>${h(s.title)}</b><br><span class="why">${h(s.detail)}</span>
      ${s.fix ? `<br><span class="why">→ <code>${h(s.fix)}</code></span>` : ''}</li>`).join('');

  const doors = d.connections.map((c) => `<article class="card"
    style="--c:var(--${c.open ? 'warn' : 'fresh'})">
    <div class="name">${h(c.title)}</div>
    <div class="st">${h(c.door)}</div>
    <p><code>${h(c.address)}</code></p>
    <p class="why">${h(c.note)}</p>
  </article>`).join('');

  const stores = d.stores.length
    ? `<p class="none">Found on this machine: ${d.stores.map((x) =>
      `<code>${h(x.id)}</code>${x.found.length > 1
        ? ` (${x.found.length} candidates — ambiguous)` : ''}`).join(', ')
    } — usable as a value above.</p>`
    : '<p class="none">No cloud store found on this machine. A folder path works, '
      + 'and so does <code>local</code> with one.</p>';

  return `<h1>Set</h1>
    <p class="lead">${writable
    ? 'What is set here takes effect at once and is written down as a line.'
    : 'This server runs READ ONLY. The fields are disabled, and the page says so '
      + 'rather than pretending.'}
      Every setting names its source and its effect.</p>
    <h2>Settings <em>${d.settings.length}</em></h2>
    ${forms || '<p class="none">Nothing here can be set.</p>'}
    ${stores}
    <h2>Setup <em>${d.setup.filter((s) => s.state !== 'done').length} of ${
  d.setup.length} still open</em></h2>
    <ol class="steps">${steps}</ol>
    <h2>Doors <em>of which only WHETHER a token is set is shown</em></h2>
    <div class="grid">${doors}</div>`;
}

/** The browser half. A string constant, so nothing in it is interpolated. */
const SCRIPT = String.raw`
(function () {
  function q(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  q('.tab').forEach(function (b) {
    b.onclick = function () {
      q('.tab').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      q('main > section').forEach(function (s) { s.hidden = (s.id !== 'v-' + b.dataset.view); });
    };
  });

  var box = document.getElementById('q'), hits = document.getElementById('hits'), type = '';
  function filter() {
    if (!box) return;
    var t = (box.value || '').toLowerCase(), n = 0, items = q('#list .item');
    items.forEach(function (el) {
      var ok = (!type || el.dataset.type === type) && (!t || el.dataset.find.indexOf(t) >= 0);
      el.hidden = !ok;
      if (ok) n += 1;
    });
    // Zero hits is stated. An empty box with no line under it reads like
    // a page that has not finished loading.
    hits.textContent = items.length ? (n + ' of ' + items.length + ' shown') : '';
  }
  if (box) box.addEventListener('input', filter);
  q('.filters .chip').forEach(function (c) {
    c.onclick = function () {
      type = c.dataset.type || '';
      q('.filters .chip').forEach(function (x) { x.classList.toggle('on', x === c); });
      filter();
    };
  });

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  // Missing and empty print differently on purpose: "none declared" is a
  // fact about the entry, "not readable" is a fact about this page.
  function val(v, none) {
    return (v === null || v === undefined || v === '')
      ? '<span class="missing">' + esc(none) + '</span>' : esc(v);
  }
  function ids(list) {
    return list.length
      ? list.map(function (l) {
        return esc(l.kind) + ' -> ' + esc(l.id) + (l.known ? '' : ' (dangling)');
      }).join('<br>')
      : '<span class="missing">none</span>';
  }
  q('.item').forEach(function (el) {
    el.onclick = function () {
      var e = ENTRIES[el.dataset.id];
      if (!e) return;
      q('.item').forEach(function (x) { x.setAttribute('aria-current', String(x === el)); });
      document.getElementById('detail').innerHTML =
        '<h3>' + esc(e.headline) + '</h3>'
        + '<div class="m">' + esc(el.dataset.id) + ' &middot; ' + esc(e.ts) + '</div>'
        + (e.readable ? '' : '<p class="none">This entry could not be read back, so every '
          + 'field below is unknown rather than empty.</p>')
        + '<dl>'
        + '<dt>basis</dt><dd>' + val(e.basis, 'none declared') + '</dd>'
        + '<dt>authority</dt><dd>' + val(e.authority, 'none declared') + '</dd>'
        + '<dt>author</dt><dd>' + val(e.author, 'none recorded') + '</dd>'
        + '<dt>scope</dt><dd>' + val(e.scope, 'not readable') + '</dd>'
        + '<dt>type</dt><dd>' + esc(e.typeLabel || e.type) + '</dd>'
        + '<dt>project</dt><dd>' + esc(e.project) + '</dd>'
        + '<dt>standing</dt><dd>' + e.cited + ' citation' + (e.cited === 1 ? '' : 's')
          + (e.contested ? ' &middot; <b>contested</b>' : '') + '</dd>'
        + '<dt>validity</dt><dd>' + (e.retired
          ? 'retracted (' + esc(e.retired.state)
            + (e.retired.why ? ': ' + esc(e.retired.why) : '') + ')'
          : 'not retracted') + '</dd>'
        + '<dt>replaces</dt><dd>' + val(e.replaces, 'nothing') + '</dd>'
        + '<dt>built on</dt><dd>' + (e.derivedFrom.length
          ? e.derivedFrom.map(esc).join('<br>')
          : '<span class="missing">nothing declared</span>') + '</dd>'
        + '<dt>contradicted by</dt><dd>' + ids(e.contradictedBy) + '</dd>'
        + '<dt>links out</dt><dd>' + ids(e.links) + '</dd>'
        + '<dt>links in</dt><dd>' + ids(e.backlinks) + '</dd>'
        + '<dt>source</dt><dd>' + esc(e.source) + ':' + e.line + '</dd>'
        + '</dl>';
    };
  });

  function cell(td) {
    var p = PAIRS[td.dataset.cell];
    if (!p) return;
    var kinds = Object.keys(p.kinds).map(function (k) {
      return esc(k) + ' x ' + p.kinds[k];
    }).join(', ');
    document.getElementById('netdetail').innerHTML =
      '<b>' + esc(p.from) + ' -&gt; ' + esc(p.to) + '</b><br>' + p.count
      + ' declared link' + (p.count === 1 ? '' : 's') + ': ' + kinds;
  }
  q('td.hit').forEach(function (td) {
    td.onclick = function () { cell(td); };
    td.onkeydown = function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); cell(td); }
    };
  });
}());
`;

/**
 * The whole page, as one string. Pure function of the collected data —
 * no I/O, so a test can hand it a fixture and read the result.
 */
export function renderHtml(d, { title = 'cheap-mem', writable = true } = {}) {
  const tabs = Object.entries(TABS).map(([id, label], i) =>
    `<button class="tab" role="tab" id="tab-${id}" data-view="${id}"
      aria-controls="v-${id}" aria-selected="${i === 0}">${h(label)}</button>`).join('');
  const views = {
    desk: deskView(d),
    knowledge: knowledgeView(d),
    projects: projectsView(d),
    agents: agentsView(d),
    net: netView(d),
    set: setView(d, { writable }),
  };
  const sections = Object.entries(views).map(([id, html], i) =>
    `<section id="v-${id}" role="tabpanel" aria-labelledby="tab-${id}"${
      i === 0 ? '' : ' hidden'}>${html}</section>`).join('');
  // Only what the detail pane needs, and only for the rows that really
  // made it onto the page.
  //
  // The list cuts at `LIST_MAX`; this used to carry every entry. On the
  // sibling project's real memory that was 1.4 MB for 1426 entries
  // where 400 are drawn — half the weight for rows no click reaches, on
  // a phone that loads it over mobile data. Both sides cut at the same
  // constant, and a probe holds them to it.
  const payload = Object.fromEntries(d.entries.slice(0, LIST_MAX).map((e) => [e.id, {
    headline: e.headline, type: e.type, typeLabel: e.typeLabel, project: e.project,
    ts: e.ts, source: e.source, line: e.line, readable: e.readable, basis: e.basis,
    authority: e.authority, author: e.author, scope: e.scope, cited: e.cited,
    contested: e.contested, retired: e.retired, replaces: e.replaces,
    derivedFrom: e.derivedFrom, links: e.links, backlinks: e.backlinks,
    contradictedBy: e.contradictedBy, tags: e.tags,
  }]));
  const pairs = Object.fromEntries(d.net.pairs.map((p) => [CELL(p.from, p.to), p]));

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} — desk</title>
<style>${CSS}</style>
</head><body>
<header class="top">
  <div class="brand">${h(title)}<span>desk · measured ${h(d.at)}</span></div>
  <div class="tabs" role="tablist" aria-label="views">${tabs}</div>
  <div class="asof">${h(d.git.branch ?? 'no branch')} @ ${h(d.git.head ?? '?')} · ${
  d.inventory.total} entries</div>
</header>
<main>${sections}</main>
<script>
var ENTRIES = ${safeJson(payload)};
var PAIRS = ${safeJson(pairs)};
${SCRIPT}
</script>
</body></html>
`;
}

/** Collect and render in one call, the way `viewer.build` does. */
export function build(root, {
  title = 'cheap-mem', env = process.env, now = new Date(), cfg = {}, writable = true,
} = {}) {
  const data = collect(root, { env, now, cfg });
  return { data, html: renderHtml(data, { title, writable }) };
}

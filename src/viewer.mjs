// viewer.mjs — the "rummage through the memory" view.
//
// A memory nobody can look at is a memory nobody trusts. People want to
// open a lid and SEE what is in there — even the ones who never act on
// what they find. That trust is worth a feature, but only if the feature
// keeps cheap-mem's promises: no model, no daemon, no new dependency, no
// leak.
//
// So the viewer is not a server and not an app. It is ONE self-contained
// HTML file: every entry embedded, all search and filtering done in the
// browser. You run `mem viewer`, a file appears, you open it. Offline,
// no network, nothing to keep running. The same shape as a printed
// report — generated on demand, thrown away when stale.
//
// It shows the STRUCTURE, not just the entries. A flat, chronological
// list is what a log file is; what makes this a memory sits beside that
// list — a subject over months, the edges the digest drew between
// entries, which learnings the rest of the memory leans on, what is true
// now and since when. Those are lenses on the same entries, never
// separate lists that could drift: picking a topic filters the timeline
// to its thread, following an edge jumps to the entry it points at.
//
// The payload holds a LIST of memories even though `mem viewer <root>`
// passes one. Past 50k entries docs/scale.md tells teams to shard, and a
// team with five memories wants them side by side; allowing for that now
// costs a nesting level, retrofitting it later costs the format.
//
// Two safety properties are load-bearing, not decoration:
//
//  1. It reads ONLY the redacted JSONL fächer (via memory.find with an
//     empty needle). It never touches raw/ — the un-redacted capture
//     material — so whatever the redaction layer and the canaries keep
//     out of the logs stays out of the viewer too.
//
//  2. The generated file carries real memory content. It is written
//     OUTSIDE the memory (default: the OS temp dir), never committed,
//     never published. The public repo ships this CODE, never a file.

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';

// Human labels for the fächer, so the chips read like language, not
// like filenames. Unknown types fall back to their own key.
const TYPE_LABEL = Object.freeze({
  decision: 'Decisions',
  error: 'Errors',
  event: 'Events',
  timeline: 'Timeline',
  thought: 'Thoughts',
  learning: 'Learnings',
  duty: 'Duties',
  skill: 'Skills',
  update: 'Updates',
});

// Fields that carry the meaning of an entry, best first. The headline
// picks the first few that are present; everything else shows in the
// detail table. Kept in sync by intent with the retrieve hook's own
// preference order — both answer "what is this entry, in one line?".
const HEADLINE_FIELDS = ['class', 'title', 'topic', 'choice', 'text', 'summary', 'fact'];

// Which JSON keys are bookkeeping, not content — hidden from the detail
// table (they are shown as chips/meta instead), so the table is signal.
const META_KEYS = new Set(['ts', 'id', 'type', 'tags', '_source', '_line']);

// _source comes from path.relative, so on Windows it carries backslashes.
// Normalise to forward slashes before matching, or type/project mapping
// silently fails there (and the viewer mislabels every entry).
function typeOfEntry(e) {
  // find() annotates _source like "global/decisions.jsonl" or
  // "projects/x/errors.jsonl". Map the filename back to a type key.
  const file = String(e._source || '').replace(/\\/g, '/').split('/').pop();
  for (const [type, fname] of Object.entries(memory.TYPES)) {
    if (fname === file) return type;
  }
  return e.type || 'entry';
}

function projectOfEntry(e) {
  const src = String(e._source || '').replace(/\\/g, '/');
  const m = src.match(/^projects\/([^/]+)\//);
  return m ? m[1] : null;
}

function headline(e) {
  const bits = [];
  for (const k of HEADLINE_FIELDS) {
    if (e[k] != null && String(e[k]).trim()) bits.push(String(e[k]).trim());
    if (bits.length >= 2) break;
  }
  let s = bits.length ? bits.join(' — ') : '';
  if (!s) {
    // Nothing named: show whatever content the entry has, so an
    // unfamiliar shape still reads as something, not "[object]".
    const rest = Object.entries(e)
      .filter(([k]) => !META_KEYS.has(k) && !k.startsWith('_'))
      .map(([, v]) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .filter(Boolean);
    s = rest.join(' — ') || '(empty entry)';
  }
  return s;
}

/**
 * Collect every entry, newest first, shaped for the view.
 *
 * The empty needle is deliberate: memory.find matches every line when
 * the pattern is "", across global + all projects, and only across the
 * TYPES logs — never raw/. That is exactly the corpus the viewer should
 * show, gathered by the same code the search uses.
 */
/**
 * Everything one memory has to show, as data.
 *
 * The old viewer collected a flat list of entries — which is what a log
 * file is. Everything that makes this a MEMORY rather than a log lives
 * beside that list and was invisible: what a topic looks like over
 * months, which entries the digest connected and how, which learnings
 * the rest of the memory actually leans on, what is true right now and
 * since when. A prettier flat list is still a flat list, so this
 * gathers the structure too.
 *
 * Shaped for MANY memories from the start (`collectAll` wraps this in a
 * list) even though today there is one. A team that shards per project —
 * which is what docs/scale.md tells them to do past 50k entries — needs
 * the cross-memory view, and retrofitting the data shape later is far
 * more expensive than allowing for it now.
 */
export function collectMemory(root, { name = null } = {}) {
  const rows = collect(root);
  const byId = new Map(rows.map((r) => [r.id, r]));

  const topics = memory.topics(root).map((t) => {
    const state = memory.topicState(root, t.topic);
    return {
      topic: t.topic,
      count: t.count,
      last: t.last,
      types: t.types,
      // Only ids: the entries themselves are already in `rows`, and
      // repeating them would double the size of a file that is meant to
      // be opened, not downloaded.
      current: state.current ? state.current.id : null,
      trail: state.history.map((e) => e.id).filter(Boolean),
    };
  });

  const links = [];
  for (const r of rows) {
    if (r.type !== 'link') continue;
    const d = r.details || {};
    if (!d.from || !d.to) continue;
    links.push({
      id: r.id, from: d.from, to: d.to, kind: d.kind || 'related',
      why: d.why || null, ts: r.ts,
      // A link whose endpoints are not in this memory is dangling — the
      // doctor reports it, and the viewer should not pretend otherwise.
      fromKnown: byId.has(d.from), toKnown: byId.has(d.to),
    });
  }

  const experiences = memory.experiences(root).map((e) => ({
    id: e.id, title: e.title || e.learning || '', cited: e.cited || 0,
    contested: Boolean(e.contested), backedBy: e.backedBy || [], ts: e.ts || '',
  }));

  // A living fact resolves to { key, current, history, stale, conflict } —
  // the value sits on `current`, and the history is what makes it a
  // timeline rather than a setting. Both are shown: what is true now, and
  // what it used to be.
  const facts = memory.currentFacts(root).map((f) => ({
    key: f.key,
    value: f.current ? String(f.current.value ?? f.current.fact ?? '') : '',
    validFrom: f.current ? (f.current.valid_from || String(f.current.ts || '').slice(0, 10)) : '',
    ageDays: typeof f.ageDays === 'number' ? Math.round(f.ageDays) : null,
    stale: Boolean(f.stale),
    conflict: Boolean(f.conflict),
    history: (f.history || []).map((h) => ({
      value: String(h.value ?? h.fact ?? ''),
      validFrom: h.valid_from || String(h.ts || '').slice(0, 10),
    })),
  }));

  return {
    name: name || path.basename(path.resolve(root)),
    entries: rows,
    topics,
    links,
    experiences,
    facts,
    counts: summarize(rows),
  };
}

/**
 * One or many memories, in the shape the page renders from.
 *
 * Pass several roots and the page gets a switcher; pass one and it stays
 * out of the way. The important part is that the page never has to know
 * which case it is in.
 */
export function collectAll(roots, { names = null } = {}) {
  const list = Array.isArray(roots) ? roots : [roots];
  return {
    generatedAt: new Date().toISOString(),
    memories: list.map((r, i) => collectMemory(r, { name: names ? names[i] : null })),
  };
}

export function collect(root) {
  // withRetired: the viewer shows the WHOLE history — done/discarded/
  // superseded too, just marked. Everyday recall hides the same ones;
  // here, rummaging, you want them.
  const all = memory.find(root, '', { withRetired: true });
  const rows = all.map((e) => {
    const type = typeOfEntry(e);
    const project = projectOfEntry(e);
    const details = {};
    for (const [k, v] of Object.entries(e)) {
      if (META_KEYS.has(k) || k.startsWith('_')) continue;
      details[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return {
      ts: e.ts || '',
      day: String(e.ts || '').slice(0, 10),
      type,
      typeLabel: TYPE_LABEL[type] || type,
      project,
      tags: Array.isArray(e.tags) ? e.tags : [],
      id: e.id || '',
      source: e._source || '',
      line: e._line || 0,
      headline: headline(e),
      retired: e._retired ? { state: e._retired.state, why: e._retired.why || null } : null,
      details,
    };
  });
  // Newest first. Entries without a ts sort to the end.
  rows.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return rows;
}

function summarize(rows) {
  const perType = {};
  const perProject = {};
  const perDay = {};
  for (const r of rows) {
    perType[r.type] = (perType[r.type] || 0) + 1;
    if (r.project) perProject[r.project] = (perProject[r.project] || 0) + 1;
    if (r.day) perDay[r.day] = (perDay[r.day] || 0) + 1;
  }
  return { total: rows.length, perType, perProject, perDay };
}

// Embed JSON safely inside <script>. The only sequence that can break
// out of a script element is "</" (case-insensitive, e.g. </script>);
// escaping the slash neutralises it while staying valid JSON. Also guard
// against a lone "<!--" starting a comment.
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/<!--/g, '<\\!--');
}

/**
 * Render the whole viewer as one HTML string. Pure function of the rows
 * and a title — no I/O, so it is trivial to test.
 */
/**
 * One self-contained page for one or many memories.
 *
 * The layout follows what the data actually is: entries are the atoms,
 * and topics, links, experiences and facts are LENSES on the same
 * entries — never separate lists that could drift out of sync. Picking a
 * topic filters the timeline to its thread; following a link jumps to
 * the entry it points at. That is the difference between showing the
 * structure and merely listing more things.
 *
 * No framework, no CDN, no network. Everything the page needs is in the
 * file, which is what lets it work on a plane and what stops it phoning
 * anywhere with your memory in the payload.
 */
export function renderHtml(data, { title = 'cheap-mem', generatedAt = new Date() } = {}) {
  // Accept the old shape (a bare array of rows) so a caller that still
  // passes rows keeps working instead of rendering an empty page.
  const payload = Array.isArray(data)
    ? { generatedAt: generatedAt.toISOString(),
      memories: [{ name: title, entries: data, topics: [], links: [], experiences: [], facts: [], counts: summarize(data) }] }
    : data;
  const total = payload.memories.reduce((n, m) => n + m.entries.length, 0);
  const when = new Date(payload.generatedAt || generatedAt).toISOString().replace('T', ' ').slice(0, 16);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
/* System fonts only. This page shows private memory content and is meant
   to work on a plane; a webfont request would both break that and tell a
   font host, with a referrer, that someone is reading their memory.
   Three roles, three stacks: chrome, the remembered prose, identifiers. */
:root{
  --ui:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --prose:Charter,"Bitstream Charter","Sitka Text",Cambria,Georgia,serif;
  --code:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --paper:#FAF9F6; --raised:#FFFFFF; --sunk:#F1EFE9;
  --ink:#1A1C1B; --muted:#4D5350; --faint:#696E6B;
  --rule:#E4E1D9; --rule-soft:#EFECE5;
  --accent:#1F5E70; --accent-soft:#E1EDF0;
  --warn:#8A5A12; --warn-soft:#F6EEDE;
  --gone:#8C3A34; --gone-soft:#F6E6E4;
  --fresh:#2C6B4F;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme="light"]){
    --paper:#141716; --raised:#1B1F1D; --sunk:#202523;
    --ink:#E7EAE6; --muted:#B4BBB5; --faint:#8B9089;
    --rule:#2C332F; --rule-soft:#242A27;
    --accent:#7FC3D4; --accent-soft:#172C32;
    --warn:#D9A758; --warn-soft:#2B2416;
    --gone:#E08C85; --gone-soft:#2E1D1C;
    --fresh:#6FBF97;
  }
}
:root[data-theme="dark"]{
  --paper:#141716; --raised:#1B1F1D; --sunk:#202523;
  --ink:#E7EAE6; --muted:#B4BBB5; --faint:#8B9089;
  --rule:#2C332F; --rule-soft:#242A27;
  --accent:#7FC3D4; --accent-soft:#172C32;
  --warn:#D9A758; --warn-soft:#2B2416;
  --gone:#E08C85; --gone-soft:#2E1D1C;
  --fresh:#6FBF97;
}
*{box-sizing:border-box}
html,body{margin:0}
body{
  background:var(--paper); color:var(--ink);
  font-family:var(--ui);
  font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased;
}
.mono{font-family:var(--code)}

/* ---- top bar ---- */
header{
  position:sticky; top:0; z-index:20; background:var(--paper);
  border-bottom:1px solid var(--rule);
}
.bar{max-width:1080px; margin:0 auto; padding:14px 20px 0}
.brand{display:flex; align-items:baseline; gap:12px; flex-wrap:wrap}
h1{font-size:20px; font-weight:700; margin:0; letter-spacing:-.015em}
.meta{font-family:var(--code); font-size:11px; color:var(--faint)}
.tools{display:flex; gap:10px; align-items:center; margin:12px 0 0; flex-wrap:wrap}
#q{
  flex:1 1 260px; min-width:200px; padding:8px 12px;
  border:1px solid var(--rule); border-radius:6px;
  background:var(--raised); color:var(--ink);
  font-family:inherit; font-size:15px;
}
#q:focus{outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent}
select{
  padding:7px 10px; border:1px solid var(--rule); border-radius:6px;
  background:var(--raised); color:var(--ink); font-family:inherit; font-size:13px;
}
.live{display:flex; align-items:center; gap:6px; font-size:13px; color:var(--muted); cursor:pointer; user-select:none}
.live input{accent-color:var(--accent); cursor:pointer}
.tabs{display:flex; gap:2px; margin:12px 0 0; overflow-x:auto}
/* This page is driven from the keyboard (/ jumps to search, Esc clears).
   Without a visible focus ring you lose your place while tabbing — until
   now only the search field had one. :focus-visible so the ring does not
   show up on a mouse click. */
.tab:focus-visible,.item:focus-visible,select:focus-visible,
summary:focus-visible,.live input:focus-visible{
  outline:2px solid var(--accent); outline-offset:2px; border-radius:4px;
}
.tab{
  appearance:none; border:0; background:none; cursor:pointer;
  font-family:inherit; font-size:14px; color:var(--muted);
  padding:9px 13px; border-bottom:2px solid transparent; white-space:nowrap;
}
.tab:hover{color:var(--ink)}
.tab[aria-selected="true"]{color:var(--accent); border-bottom-color:var(--accent); font-weight:700}
.tab .n{font-family:var(--code); font-size:11px; color:var(--faint); margin-left:5px}

/* ---- body ---- */
main{max-width:1080px; margin:0 auto; padding:22px 20px 80px}
.lead{color:var(--muted); font-size:14px; margin:0 0 18px; max-width:70ch}
.empty{color:var(--faint); text-align:center; padding:56px 20px; font-size:14px}

/* ---- entry card ---- */
.card{
  background:var(--raised); border:1px solid var(--rule); border-radius:8px;
  padding:14px 16px; margin:0 0 10px;
}
.card.gone{background:var(--sunk); border-style:dashed}
.card h2{
  font-family:var(--prose); font-size:17px; font-weight:600;
  margin:0 0 7px; line-height:1.35; letter-spacing:-.005em;
}
.card.gone h2{color:var(--muted); text-decoration:line-through}
.row{display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:0 0 6px}
.chip{
  font-family:var(--code); font-size:11px; letter-spacing:.03em;
  padding:2px 7px; border-radius:3px; background:var(--sunk); color:var(--muted);
  border:1px solid var(--rule-soft);
}
.chip.type{background:var(--accent-soft); color:var(--accent); border-color:transparent; font-weight:500}
.chip.gone{background:var(--gone-soft); color:var(--gone); border-color:transparent}
.chip.warn{background:var(--warn-soft); color:var(--warn); border-color:transparent}
.chip.tag{background:none; border-color:var(--rule)}
.chip.act{cursor:pointer}
.chip.act:hover{border-color:var(--accent); color:var(--accent)}
.prose{font-family:var(--prose); font-size:15px; color:var(--muted); margin:6px 0 0}
details{margin-top:9px}
summary{cursor:pointer; color:var(--faint); font-size:12px; font-family:var(--code)}
summary:hover{color:var(--accent)}
table{width:100%; border-collapse:collapse; margin-top:8px; font-size:13px}
td{border-top:1px solid var(--rule-soft); padding:6px 8px; vertical-align:top}
td.k{color:var(--faint); width:110px; white-space:nowrap; font-family:var(--code); font-size:12px}
td.v{white-space:pre-wrap; word-break:break-word; font-family:var(--prose)}
mark{background:var(--warn-soft); color:var(--ink); padding:0 1px; border-radius:2px}

/* ---- lists that are not cards ---- */
.list{display:grid; gap:0; border:1px solid var(--rule); border-radius:8px; background:var(--raised); overflow:hidden}
.item{padding:13px 16px; border-top:1px solid var(--rule-soft); cursor:pointer; background:none; border-left:0; border-right:0; border-bottom:0; text-align:left; width:100%; font-family:inherit; color:inherit; font-size:inherit}
.item:first-child{border-top:0}
.item:hover{background:var(--sunk)}
.item h3{font-size:15px; margin:0 0 4px; font-weight:700; letter-spacing:-.005em}
.item .sub{color:var(--muted); font-size:14px; font-family:var(--prose)}
.bar-wrap{display:flex; align-items:center; gap:10px; margin-top:6px}
.bar-track{flex:0 0 96px; height:5px; background:var(--sunk); border-radius:3px; overflow:hidden}
.bar-fill{height:100%; background:var(--accent)}
.edge{display:grid; grid-template-columns:1fr auto 1fr; gap:10px; align-items:center}
.edge .side{min-width:0}
.edge .side b{display:block; font-weight:400; font-family:var(--prose); font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.edge .kind{font-family:var(--code); font-size:11px; color:var(--accent); padding:2px 8px; background:var(--accent-soft); border-radius:3px; white-space:nowrap}
.edge .kind.contradicts{color:var(--warn); background:var(--warn-soft)}
.fact{display:grid; grid-template-columns:minmax(120px,auto) 1fr auto; gap:14px; align-items:baseline}
.fact .key{font-family:var(--code); font-size:13px; color:var(--muted)}
.fact .val{font-family:var(--prose); font-size:15px}
.fact .since{font-family:var(--code); font-size:11px; color:var(--faint); white-space:nowrap}
.trail{margin:8px 0 0; padding:0 0 0 14px; border-left:2px solid var(--rule); display:grid; gap:5px}
.trail div{font-size:13px; color:var(--muted)}
.trail .when{font-family:var(--code); font-size:11px; color:var(--faint); margin-right:7px}
@media (max-width:620px){
  /* ~36px tall tabs are a poor thumb target; 44px is the usual floor. At
     a desk it stays compact. */
  .tab{padding:13px 14px}
  .edge{grid-template-columns:1fr; gap:5px}
  .fact{grid-template-columns:1fr; gap:2px}
}
</style>
</head>
<body>
<header>
  <div class="bar">
    <div class="brand">
      <h1>${escapeHtml(title)}</h1>
      <span class="meta">${escapeHtml(String(total))} entries &middot; ${escapeHtml(when)}</span>
    </div>
    <div class="tools">
      <input id="q" type="search" placeholder="Search everything — filters as you type" autocomplete="off">
      <select id="mem"></select>
      <select id="type"><option value="">all drawers</option></select>
      <label class="live"><input type="checkbox" id="live"> only live</label>
    </div>
    <div class="tabs" role="tablist" id="tabs"></div>
  </div>
</header>
<main>
  <p class="lead" id="lead"></p>
  <div id="view"></div>
  <p class="meta" style="margin-top:40px;padding-top:14px;border-top:1px solid var(--rule)">
    one file, no network, no model &middot; generated by <code>mem viewer</code> &middot; not committed
  </p>
</main>
<script id="data" type="application/json">${safeJson(payload)}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('data').textContent);
  var VIEWS = [
    { id: 'timeline', label: 'Timeline',
      lead: 'Everything, newest first. The drawers as they were written.' },
    { id: 'topics', label: 'Topics',
      lead: 'A subject over time: where it stands now, and how it got there. Pick one to see its thread.' },
    { id: 'links', label: 'Links',
      lead: 'What the digest connected, and how. The vocabulary is closed on purpose, so these can be walked by code.' },
    { id: 'experiences', label: 'Experience',
      lead: 'Learnings ranked by how much of the rest of the memory leans on them \\u2014 citations, not how often they were read.' },
    { id: 'facts', label: 'Facts',
      lead: 'What is true right now, and since when. A fact that changed keeps its earlier values.' }
  ];
  var state = { mem: 0, view: 'timeline', q: '', type: '', topic: null, focus: null, live: false };

  function mem() { return DATA.memories[state.mem]; }
  function byId(id) {
    var m = mem();
    if (!m._byId) {
      m._byId = {};
      for (var i = 0; i < m.entries.length; i++) m._byId[m.entries[i].id] = m.entries[i];
    }
    return m._byId[id] || null;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hay(e) {
    if (e._hay) return e._hay;
    var parts = [e.headline, e.type, e.project, e.id, (e.tags || []).join(' ')];
    for (var k in e.details) parts.push(k, e.details[k]);
    e._hay = parts.join(' ').toLowerCase();
    return e._hay;
  }
  function mark(text, q) {
    var out = esc(text);
    if (!q) return out;
    try {
      // The dollar-brace here is escaped because this whole page is built
      // inside a template literal: unescaped, the outer literal would eat
      // it and the module would not even parse.
      return out.replace(new RegExp('(' + q.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&') + ')', 'ig'), '<mark>\$1</mark>');
    } catch (err) { return out; }
  }
  function when(ts) { return String(ts || '').slice(0, 10) || '\\u2014'; }

  // --- views -----------------------------------------------------------
  function entriesNow() {
    var m = mem(), q = state.q.toLowerCase(), out = [];
    for (var i = 0; i < m.entries.length; i++) {
      var e = m.entries[i];
      // Everyday recall hides retired entries; the viewer shows them,
      // marked, because rummaging is exactly when you want the history.
      // This is the switch back to the recall view.
      if (state.live && e.retired) continue;
      if (state.type && e.type !== state.type) continue;
      if (state.topic && (e.details || {}).topic !== state.topic) continue;
      if (state.focus && e.id !== state.focus) continue;
      if (q && hay(e).indexOf(q) === -1) continue;
      out.push(e);
    }
    return out;
  }
  // A link entry's own fields are two ids and a verb, so its headline
  // reads "0s1zt2l - 10jlybo - causes" — true, and useless to a human.
  // In the timeline it is resolved to what those ids actually say; in
  // the Links view the same edge gets its own layout.
  function headlineOf(e) {
    if (e.type !== 'link') return e.headline;
    var d = e.details || {}, a = byId(d.from), b = byId(d.to);
    if (!a && !b) return e.headline;
    return (a ? a.headline : d.from) + '  \u2192 ' + (d.kind || 'related') + ' \u2192  ' + (b ? b.headline : d.to);
  }
  // A headline is two fields joined with " \u2014 ": for a learning, the
  // title and the text. Both short, and it reads as one line. When the
  // second is a paragraph \u2014 and real learnings often are \u2014 the
  // heading becomes six lines and the card has no head left to skim. So it
  // breaks at exactly that seam: title above, body as prose below.
  var BREAK_OVER = 160;   // past this, the line is no longer a heading
  var HEAD_MAX = 240;     // and past this, neither is the head
  function headAndBody(e) {
    var s = headlineOf(e), i = s.indexOf(' \u2014 ');
    // No separator, short enough, or a head that is itself a paragraph:
    // nothing to gain, so the line stays as it is.
    if (s.length <= BREAK_OVER || i < 1 || i > HEAD_MAX) return { head: s, body: '' };
    return { head: s.slice(0, i), body: s.slice(i + 3) };
  }
  function card(e) {
    var parts = headAndBody(e);
    var h = '<article class="card' + (e.retired ? ' gone' : '') + '" id="e-' + esc(e.id) + '">';
    h += '<h2>' + mark(parts.head, state.q) + '</h2><div class="row">';
    h += '<span class="chip type">' + esc(e.typeLabel || e.type) + '</span>';
    h += '<span class="chip mono">' + esc(when(e.ts)) + '</span>';
    if (e.project) h += '<span class="chip">' + esc(e.project) + '</span>';
    if (e.retired) h += '<span class="chip gone">' + esc(e.retired.state) + '</span>';
    var tags = e.tags || [];
    for (var i = 0; i < tags.length; i++) h += '<span class="chip tag">' + esc(tags[i]) + '</span>';
    if (e.id) h += '<span class="chip mono">' + esc(e.id) + '</span>';
    h += '</div>';
    if (parts.body) h += '<p class="prose">' + mark(parts.body, state.q) + '</p>';
    if (e.retired && e.retired.why) h += '<p class="prose">Retired: ' + mark(e.retired.why, state.q) + '</p>';
    var keys = Object.keys(e.details || {});
    if (keys.length) {
      h += '<details><summary>' + keys.length + ' fields &middot; ' + esc(e.source) + ':' + esc(e.line) + '</summary><table>';
      for (var j = 0; j < keys.length; j++) {
        h += '<tr><td class="k">' + esc(keys[j]) + '</td><td class="v">' + mark(e.details[keys[j]], state.q) + '</td></tr>';
      }
      h += '</table></details>';
    }
    return h + '</article>';
  }
  function viewTimeline() {
    var rows = entriesNow();
    if (!rows.length) return '<p class="empty">Nothing matches.</p>';
    var h = '';
    for (var i = 0; i < rows.length && i < 500; i++) h += card(rows[i]);
    if (rows.length > 500) h += '<p class="empty">' + (rows.length - 500) + ' more \\u2014 narrow the search.</p>';
    return h;
  }
  function viewTopics() {
    var m = mem(), q = state.q.toLowerCase();
    var list = m.topics.filter(function (t) { return !q || t.topic.toLowerCase().indexOf(q) !== -1; });
    if (!list.length) {
      return '<p class="empty">No topics yet. Give an entry a <code>--topic</code> and every later entry with the same one joins its thread.</p>';
    }
    var h = '<div class="list">';
    for (var i = 0; i < list.length; i++) {
      var t = list[i], cur = byId(t.current);
      h += '<button class="item" data-topic="' + esc(t.topic) + '">';
      h += '<h3>' + esc(t.topic) + '</h3>';
      // For a topic entry the headline starts with the topic itself (it is
      // the second-best headline field). Under a heading that already IS
      // the topic, that is a repetition.
      var sub = cur ? cur.headline : '(nothing current)';
      if (cur && sub.indexOf(t.topic + ' \u2014 ') === 0) sub = sub.slice(t.topic.length + 3);
      h += '<div class="sub">' + esc(sub) + '</div>';
      h += '<div class="row" style="margin-top:7px">';
      h += '<span class="chip mono">' + t.count + (t.count === 1 ? ' entry' : ' entries') + '</span>';
      h += '<span class="chip mono">last ' + esc(when(t.last)) + '</span>';
      for (var j = 0; j < t.types.length; j++) h += '<span class="chip">' + esc(t.types[j]) + '</span>';
      h += '</div>';
      if (t.trail.length) {
        h += '<div class="trail">';
        for (var k = 0; k < t.trail.length && k < 4; k++) {
          var p = byId(t.trail[k]);
          if (!p) continue;
          h += '<div><span class="when">' + esc(when(p.ts)) + '</span>' + esc(p.headline) + '</div>';
        }
        if (t.trail.length > 4) h += '<div><span class="when"></span>' + (t.trail.length - 4) + ' earlier \\u2026</div>';
        h += '</div>';
      }
      h += '</button>';
    }
    return h + '</div>';
  }
  function viewLinks() {
    var m = mem(), q = state.q.toLowerCase();
    var list = m.links.filter(function (l) {
      if (!q) return true;
      var a = byId(l.from), b = byId(l.to);
      return (l.kind + ' ' + (l.why || '') + ' ' + (a ? a.headline : '') + ' ' + (b ? b.headline : '')).toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) {
      return '<p class="empty">No links yet. The digest draws them while it sorts \\u2014 <code>causes</code>, <code>generalizes</code>, <code>contradicts</code>, <code>resolves</code> \\u2014 and prefers none to a guess.</p>';
    }
    var h = '<div class="list">';
    for (var i = 0; i < list.length; i++) {
      var l = list[i], a = byId(l.from), b = byId(l.to);
      h += '<button class="item" data-focus="' + esc(l.to) + '"><div class="edge">';
      h += '<div class="side"><b>' + esc(a ? a.headline : l.from) + '</b>';
      h += '<span class="chip mono">' + (a ? esc(when(a.ts)) : 'not in this memory') + '</span></div>';
      h += '<span class="kind ' + esc(l.kind) + '">' + esc(l.kind) + '</span>';
      h += '<div class="side"><b>' + esc(b ? b.headline : l.to) + '</b>';
      h += '<span class="chip mono">' + (b ? esc(when(b.ts)) : 'not in this memory') + '</span></div>';
      h += '</div>';
      if (l.why) h += '<p class="prose">' + mark(l.why, state.q) + '</p>';
      if (!l.fromKnown || !l.toKnown) h += '<div class="row" style="margin-top:6px"><span class="chip gone">dangling</span></div>';
      h += '</button>';
    }
    return h + '</div>';
  }
  function viewExperiences() {
    var m = mem(), q = state.q.toLowerCase();
    var list = m.experiences.filter(function (x) { return !q || x.title.toLowerCase().indexOf(q) !== -1; });
    if (!list.length) return '<p class="empty">Nothing is cited yet. An experience is a learning the rest of the memory leans on.</p>';
    // When everything leans equally hard (the normal case in a young
    // memory: exactly one citation each), a bar draws a ranking that is
    // not there. Then it stays away.
    var max = 1;
    for (var i = 0; i < list.length; i++) if (list[i].cited > max) max = list[i].cited;
    var ranked = max > 1;
    var h = '<div class="list">';
    for (var j = 0; j < list.length; j++) {
      var x = list[j];
      h += '<button class="item" data-focus="' + esc(x.id) + '">';
      h += '<h3>' + mark(x.title, state.q) + '</h3><div class="bar-wrap">';
      if (ranked) h += '<span class="bar-track"><span class="bar-fill" style="width:' + Math.round(x.cited / max * 100) + '%"></span></span>';
      h += '<span class="chip mono">' + x.cited + (x.cited === 1 ? ' citation' : ' citations') + '</span>';
      if (x.contested) h += '<span class="chip warn">contested</span>';
      h += '</div></button>';
    }
    return h + '</div>';
  }
  function viewFacts() {
    var m = mem(), q = state.q.toLowerCase();
    var list = m.facts.filter(function (f) {
      return !q || (f.key + ' ' + f.value).toLowerCase().indexOf(q) !== -1;
    });
    if (!list.length) return '<p class="empty">No living facts yet. <code>mem log timeline --key role --value \\u2026 --valid_from \\u2026</code> starts one.</p>';
    var h = '<div class="list">';
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      h += '<div class="item" style="cursor:default"><div class="fact">';
      h += '<span class="key">' + mark(f.key, state.q) + '</span>';
      h += '<span class="val">' + mark(f.value, state.q) + '</span>';
      h += '<span class="since">since ' + esc(f.validFrom || '?') + '</span></div>';
      if (f.stale || f.conflict) {
        h += '<div class="row" style="margin-top:6px">';
        if (f.stale) h += '<span class="chip warn">not confirmed for ' + esc(f.ageDays) + ' days</span>';
        if (f.conflict) h += '<span class="chip gone">two values, same date</span>';
        h += '</div>';
      }
      if (f.history.length) {
        h += '<div class="trail">';
        for (var j = 0; j < f.history.length; j++) {
          h += '<div><span class="when">' + esc(f.history[j].validFrom || '?') + '</span>was ' + esc(f.history[j].value) + '</div>';
        }
        h += '</div>';
      }
      h += '</div>';
    }
    return h + '</div>';
  }
  var RENDER = { timeline: viewTimeline, topics: viewTopics, links: viewLinks, experiences: viewExperiences, facts: viewFacts };

  // --- chrome ----------------------------------------------------------
  function counts() {
    var m = mem();
    return { timeline: m.entries.length, topics: m.topics.length, links: m.links.length,
      experiences: m.experiences.length, facts: m.facts.length };
  }
  function drawTabs() {
    var c = counts(), h = '';
    for (var i = 0; i < VIEWS.length; i++) {
      var v = VIEWS[i];
      h += '<button class="tab" role="tab" data-view="' + v.id + '" aria-selected="' +
        (state.view === v.id ? 'true' : 'false') + '">' + v.label +
        '<span class="n">' + c[v.id] + '</span></button>';
    }
    document.getElementById('tabs').innerHTML = h;
  }
  function drawSelects() {
    var sel = document.getElementById('mem');
    sel.style.display = DATA.memories.length > 1 ? '' : 'none';
    var h = '';
    for (var i = 0; i < DATA.memories.length; i++) {
      h += '<option value="' + i + '"' + (i === state.mem ? ' selected' : '') + '>' +
        esc(DATA.memories[i].name) + '</option>';
    }
    sel.innerHTML = h;

    var seen = {}, m = mem(), t = document.getElementById('type');
    var opts = '<option value="">all drawers</option>';
    for (var j = 0; j < m.entries.length; j++) {
      var e = m.entries[j];
      if (seen[e.type]) continue;
      seen[e.type] = 1;
      opts += '<option value="' + esc(e.type) + '"' + (state.type === e.type ? ' selected' : '') +
        '>' + esc(e.typeLabel || e.type) + '</option>';
    }
    t.innerHTML = opts;
    t.style.display = state.view === 'timeline' ? '' : 'none';
    document.querySelector('.live').style.display = state.view === 'timeline' ? '' : 'none';
  }
  function draw() {
    drawTabs();
    drawSelects();
    var v = null;
    for (var i = 0; i < VIEWS.length; i++) if (VIEWS[i].id === state.view) v = VIEWS[i];
    var lead = v ? v.lead : '';
    if (state.topic) lead = 'Thread of \\u201c' + state.topic + '\\u201d \\u2014 click Topics to go back.';
    if (state.focus) lead = 'One entry \\u2014 clear the search to see everything again.';
    document.getElementById('lead').textContent = lead;
    document.getElementById('view').innerHTML = RENDER[state.view]();
  }

  document.getElementById('q').addEventListener('input', function (ev) {
    state.q = ev.target.value.trim();
    state.focus = null;
    draw();
  });
  document.getElementById('mem').addEventListener('change', function (ev) {
    state.mem = Number(ev.target.value); state.topic = null; state.focus = null; draw();
  });
  document.getElementById('type').addEventListener('change', function (ev) {
    state.type = ev.target.value; draw();
  });
  document.getElementById('live').addEventListener('change', function (ev) {
    state.live = ev.target.checked; draw();
  });
  document.addEventListener('click', function (ev) {
    var tab = ev.target.closest ? ev.target.closest('.tab') : null;
    if (tab) { state.view = tab.getAttribute('data-view'); state.topic = null; state.focus = null; draw(); return; }
    var it = ev.target.closest ? ev.target.closest('[data-topic]') : null;
    if (it) { state.topic = it.getAttribute('data-topic'); state.view = 'timeline'; state.focus = null; draw(); return; }
    var f = ev.target.closest ? ev.target.closest('[data-focus]') : null;
    if (f) { state.focus = f.getAttribute('data-focus'); state.view = 'timeline'; state.topic = null; draw(); }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && document.activeElement.id !== 'q') { ev.preventDefault(); document.getElementById('q').focus(); }
    if (ev.key === 'Escape') { state.topic = null; state.focus = null; document.getElementById('q').value = ''; state.q = ''; draw(); }
  });
  draw();
})();
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[c]);
}

/**
 * Build the viewer for a memory and return the HTML. Thin wrapper over
 * collect + renderHtml so the CLI is one call.
 */
export function build(roots, { title = 'cheap-mem', names = null } = {}) {
  const data = collectAll(roots, { names });
  const count = data.memories.reduce((n, m) => n + m.entries.length, 0);
  return { html: renderHtml(data, { title }), count, memories: data.memories.length };
}

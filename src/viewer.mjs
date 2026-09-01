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
export function renderHtml(rows, { title = 'cheap-mem', generatedAt = new Date() } = {}) {
  const stats = summarize(rows);
  const payload = safeJson({ rows, stats, title, generatedAt: generatedAt.toISOString() });

  // The page is deliberately dependency-free: inline CSS and JS, no CDN,
  // no fonts fetched. It must open from a file:// URL with no network.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — memory</title>
<style>
  :root {
    --bg:#f7f7f5; --card:#ffffff; --ink:#1c1b19; --muted:#6b6a66;
    --line:#e6e5e1; --accent:#3a6ea5; --chip:#eeede9;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#17171a; --card:#1f1f23; --ink:#e9e8e4; --muted:#9a988f;
      --line:#2c2c31; --accent:#6ea3d6; --chip:#26262b;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { position:sticky; top:0; z-index:5; background:var(--bg);
    border-bottom:1px solid var(--line); padding:14px 18px; }
  h1 { margin:0 0 2px; font-size:17px; }
  .sub { color:var(--muted); font-size:12px; }
  .wrap { max-width:900px; margin:0 auto; padding:18px; }
  .controls { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:10px; }
  #q { flex:1 1 220px; min-width:180px; padding:8px 10px; border:1px solid var(--line);
    border-radius:8px; background:var(--card); color:var(--ink); font-size:14px; }
  .chip { border:1px solid var(--line); background:var(--chip); color:var(--ink);
    border-radius:999px; padding:4px 10px; font-size:12px; cursor:pointer; user-select:none; }
  .chip.on { background:var(--accent); color:#fff; border-color:var(--accent); }
  .spark { display:flex; align-items:flex-end; gap:1px; height:34px; margin-top:10px; }
  .spark i { flex:1; background:var(--accent); opacity:.55; min-height:1px; border-radius:1px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px;
    padding:12px 14px; margin:10px 0; }
  .card h2 { margin:0; font-size:14px; font-weight:600; }
  .meta { color:var(--muted); font-size:12px; margin-top:4px;
    display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .badge { border-radius:6px; padding:1px 7px; font-size:11px; background:var(--chip); }
  .badge.gone { background:#c0392b; color:#fff; }
  .card.gone { opacity:.6; }
  .card.gone h2 { text-decoration:line-through; }
  .tag { color:var(--accent); font-size:11px; }
  details { margin-top:8px; }
  summary { cursor:pointer; color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; margin-top:6px; font-size:13px; }
  td { border-top:1px solid var(--line); padding:5px 6px; vertical-align:top; }
  td.k { color:var(--muted); width:120px; white-space:nowrap; }
  td.v { white-space:pre-wrap; word-break:break-word; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }
  .count { color:var(--muted); font-size:12px; margin:6px 0 0; }
  mark { background:#ffe08a; color:#000; }
</style>
</head>
<body>
<header>
  <div class="wrap" style="padding-top:0;padding-bottom:0">
    <h1>${escapeHtml(title)} — memory</h1>
    <div class="sub" id="sub"></div>
    <div class="spark" id="spark" title="entries per day"></div>
    <div class="controls">
      <input id="q" type="search" placeholder="rummage… (searches everything)" autocomplete="off">
      <span class="chip" id="live"></span>
      <span id="types"></span>
    </div>
    <div class="controls" id="projects"></div>
  </div>
</header>
<div class="wrap">
  <div class="count" id="count"></div>
  <div id="list"></div>
</div>
<script id="data" type="application/json">${payload}</script>
<script>
(function () {
  var DATA = JSON.parse(document.getElementById('data').textContent);
  var rows = DATA.rows;
  var stats = DATA.stats;
  var state = { q: '', type: null, project: null, onlyLive: false };

  var goneCount = rows.filter(function (r) { return r.retired; }).length;
  document.getElementById('sub').textContent =
    stats.total + ' entries' + (goneCount ? ' (' + goneCount + ' retired)' : '')
    + ' · generated ' + new Date(DATA.generatedAt).toLocaleString();

  // "only live" toggle: hides retired (done/discarded/superseded) — the
  // same view everyday recall has.
  var liveEl = document.getElementById('live');
  if (goneCount) {
    liveEl.textContent = 'only live';
    liveEl.onclick = function () {
      state.onlyLive = !state.onlyLive;
      liveEl.classList.toggle('on', state.onlyLive);
      render();
    };
  } else {
    liveEl.style.display = 'none';
  }

  // Activity sparkline: one bar per day between first and last entry.
  (function () {
    var days = Object.keys(stats.perDay).sort();
    var spark = document.getElementById('spark');
    if (!days.length) { spark.style.display = 'none'; return; }
    var max = 1;
    for (var d in stats.perDay) if (stats.perDay[d] > max) max = stats.perDay[d];
    var start = new Date(days[0]); var end = new Date(days[days.length - 1]);
    for (var t = start.getTime(); t <= end.getTime(); t += 86400000) {
      var key = new Date(t).toISOString().slice(0, 10);
      var n = stats.perDay[key] || 0;
      var bar = document.createElement('i');
      bar.style.height = Math.round((n / max) * 100) + '%';
      if (!n) bar.style.opacity = '.12';
      bar.title = key + ': ' + n;
      spark.appendChild(bar);
    }
  })();

  // Type chips (with counts). Clicking toggles a single-type filter.
  var typesEl = document.getElementById('types');
  Object.keys(stats.perType).sort().forEach(function (type) {
    var label = (rows.find(function (r) { return r.type === type; }) || {}).typeLabel || type;
    var c = document.createElement('span');
    c.className = 'chip'; c.dataset.type = type;
    c.textContent = label + ' ' + stats.perType[type];
    c.onclick = function () {
      state.type = state.type === type ? null : type;
      syncChips(); render();
    };
    typesEl.appendChild(c);
  });

  // Project chips, only if there are projects.
  var projEl = document.getElementById('projects');
  var projs = Object.keys(stats.perProject).sort();
  if (projs.length) {
    var lbl = document.createElement('span');
    lbl.className = 'sub'; lbl.style.marginRight = '2px'; lbl.textContent = 'projects:';
    projEl.appendChild(lbl);
    projs.forEach(function (p) {
      var c = document.createElement('span');
      c.className = 'chip'; c.dataset.project = p;
      c.textContent = p + ' ' + stats.perProject[p];
      c.onclick = function () {
        state.project = state.project === p ? null : p;
        syncChips(); render();
      };
      projEl.appendChild(c);
    });
  }

  function syncChips() {
    document.querySelectorAll('.chip[data-type]').forEach(function (el) {
      el.classList.toggle('on', el.dataset.type === state.type);
    });
    document.querySelectorAll('.chip[data-project]').forEach(function (el) {
      el.classList.toggle('on', el.dataset.project === state.project);
    });
  }

  var qEl = document.getElementById('q');
  qEl.addEventListener('input', function () { state.q = qEl.value.trim().toLowerCase(); render(); });

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function hay(r) {
    var parts = [r.headline, r.type, r.project || '', r.id, (r.tags || []).join(' ')];
    for (var k in r.details) parts.push(k + ' ' + r.details[k]);
    return parts.join(' \\n ').toLowerCase();
  }
  function highlight(s, q) {
    if (!q) return esc(s);
    var i = s.toLowerCase().indexOf(q);
    if (i < 0) return esc(s);
    return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
  }

  var listEl = document.getElementById('list');
  var countEl = document.getElementById('count');

  function render() {
    var q = state.q;
    var shown = rows.filter(function (r) {
      if (state.onlyLive && r.retired) return false;
      if (state.type && r.type !== state.type) return false;
      if (state.project && r.project !== state.project) return false;
      if (q && hay(r).indexOf(q) < 0) return false;
      return true;
    });
    countEl.textContent = shown.length + ' of ' + rows.length + ' entries';
    if (!shown.length) { listEl.innerHTML = '<div class="empty">nothing matches</div>'; return; }
    var html = '';
    for (var i = 0; i < shown.length; i++) {
      var r = shown[i];
      html += '<div class="card' + (r.retired ? ' gone' : '') + '"><h2>' + highlight(r.headline, q) + '</h2>';
      html += '<div class="meta"><span class="badge">' + esc(r.typeLabel) + '</span>';
      if (r.retired) html += '<span class="badge gone">' + esc(r.retired.state) + '</span>';
      if (r.day) html += '<span>' + esc(r.day) + '</span>';
      if (r.project) html += '<span>· ' + esc(r.project) + '</span>';
      if (r.id) html += '<span>· ' + esc(r.id) + '</span>';
      (r.tags || []).forEach(function (t) { html += '<span class="tag">#' + esc(t) + '</span>'; });
      html += '</div>';
      var keys = Object.keys(r.details);
      if (keys.length) {
        html += '<details><summary>details</summary><table>';
        keys.forEach(function (k) {
          html += '<tr><td class="k">' + esc(k) + '</td><td class="v">' + highlight(r.details[k], q) + '</td></tr>';
        });
        html += '<tr><td class="k">source</td><td class="v">' + esc(r.source) + ':' + esc(r.line) + '</td></tr>';
        html += '</table></details>';
      }
      html += '</div>';
    }
    listEl.innerHTML = html;
  }

  render();
})();
</script>
</body>
</html>
`;
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
export function build(root, { title = 'cheap-mem' } = {}) {
  const rows = collect(root);
  return { html: renderHtml(rows, { title }), count: rows.length };
}

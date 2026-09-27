// astra — the workspace, as Lucky and ChatGPT drew it.
//
// **What this file is.** The desk's presentation layer, rebuilt to the
// study published at cheap-mem-neural: a fixed sidebar, a top bar with
// breadcrumb, and a workspace that fills the window. Palette, spacing,
// glyphs and wording follow the study; the DATA is this project's, read
// through `dashboard.collect()`, so there is exactly one source for
// every number on screen.
//
// **Two house rules were changed for it, by decision, not by drift.**
// `docs/viewer-design-tokens.json` forbade a webfont and demanded both
// themes. The study is dark-only and sets DM Sans. Lucky decided on
// 2026-09-16 to follow the study and move the rules, rather than ship a
// near-miss. Both changes are written into the token file with that
// date and that reason — a rule that quietly stops applying is worse
// than one that visibly changed.
//
// What did NOT change: no second data source, no demo fallback, three
// states where there are three, and a caption never claims more than
// the picture under it shows.
import * as dashboard from './dashboard.mjs';
import { LIST_MAX, h, safeJson, CELL, INK, NAV } from './astra/shared.mjs';
import { deskView } from './astra/desk.mjs';
import { knowledgeView } from './astra/knowledge.mjs';
import { spaceView } from './astra/space.mjs';
import { projectsView } from './astra/projects.mjs';
import { agentsView } from './astra/agents.mjs';
import { netView } from './astra/net.mjs';
import { setView } from './astra/set.mjs';

export const VIEWS = dashboard.VIEWS;

// `LIST_MAX` moved to `astra/shared.mjs` with the rest of the presentation
// helpers (dashboard block D2-D8: one view per module, so several agents
// can extend one each without meeting in the same file). Re-exported here
// unchanged so `astra.LIST_MAX` keeps working for every existing caller.
export { LIST_MAX };

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap');
:root{color-scheme:dark;
  --bg:${INK.bg};--panel:${INK.panel};--raised:${INK.raised};--line:${INK.line};
  --muted:${INK.muted};--text:${INK.text};--violet:${INK.violet};--green:${INK.green};
  --orange:${INK.orange};--blue:${INK.blue};
  --raised-on:${INK['raised-on']};--line-on:${INK['line-on']};
  --font:'DM Sans',-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
  --code:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --rail:248px;
  /* Motion as its OWN token layer, not as patches. The names and values
     live in docs/viewer-design.md, section 2.8: named after the DISTANCE
     travelled, not after importance. */
  --instant:100ms;--quick:160ms;--normal:220ms;--slow:320ms;
  --ease-standard:cubic-bezier(.2,0,0,1);
  --ease-in:cubic-bezier(.05,.7,.1,1);
  --ease-crisp:cubic-bezier(.19,1,.22,1)}
/* Whoever asked for calm gets THE SAME page with duration 0 — not a
   second, half-maintained version. The knowledge space reads the same
   setting and then drops the pulses by itself. */
@media (prefers-reduced-motion:reduce){
  :root{--instant:0ms;--quick:0ms;--normal:0ms;--slow:0ms}
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);
  -webkit-font-smoothing:antialiased}
a{color:inherit}
/* --- the rail ----------------------------------------------------- */
.sidebar{position:fixed;inset:0 auto 0 0;width:var(--rail);background:var(--panel);
  border-right:1px solid var(--line);display:flex;flex-direction:column;gap:22px;
  padding:22px 16px;overflow-y:auto;z-index:20}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;
  letter-spacing:-.015em;text-decoration:none}
.brand-symbol{width:28px;height:28px;border-radius:8px;display:grid;place-items:center;
  background:linear-gradient(145deg,var(--violet),var(--blue));color:#0a0b0e;
  font-size:15px;font-weight:700}
.workspace{display:flex;align-items:center;gap:10px;padding:10px;border-radius:10px;
  background:var(--raised);border:1px solid var(--line)}
.workspace-icon{width:26px;height:26px;border-radius:7px;display:grid;place-items:center;
  background:var(--violet);color:#0a0b0e;font-weight:700;font-size:12px}
.workspace b{display:block;font-size:13px;line-height:1.2}
.workspace span.sub{display:block;font-size:11px;color:var(--muted)}
.nav-caption{font:500 10px/1 var(--code);letter-spacing:.14em;text-transform:uppercase;
  color:var(--muted);padding:0 8px;margin-bottom:-12px}
.rail-nav{display:flex;flex-direction:column;gap:2px}
.nav{display:flex;align-items:center;gap:10px;width:100%;text-align:left;border:0;
  background:transparent;color:var(--muted);font:15px var(--font);padding:9px 10px;
  border-radius:9px;cursor:pointer}
.nav{transition:background var(--quick) var(--ease-standard),
  color var(--instant) var(--ease-standard)}
.nav:hover{background:var(--raised);color:var(--text)}
.nav[aria-selected=true]{background:var(--raised-on);color:var(--text)}
.nav[aria-selected=true] .nav-glyph{color:var(--violet)}
.nav:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.nav-glyph{width:18px;text-align:center;color:var(--muted);font-size:14px}
.nav-count{margin-left:auto;font:11px var(--code);color:var(--muted);
  background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:1px 6px}
.sidebar-note{margin-top:auto;font-size:11px;line-height:1.5;color:var(--muted);
  border-top:1px solid var(--line);padding-top:16px}
.profile{display:flex;align-items:center;gap:10px}
.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;
  background:var(--raised);border:1px solid var(--line);font-size:12px;font-weight:700;
  color:var(--violet)}
.profile b{display:block;font-size:13px;line-height:1.2}
.profile span{display:block;font-size:11px;color:var(--muted)}
/* --- the workspace ------------------------------------------------ */
.shell{margin-left:var(--rail);min-height:100vh;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:16px;
  padding:14px 32px;background:rgba(10,11,14,.86);backdrop-filter:blur(8px);
  border-bottom:1px solid var(--line)}
.breadcrumb{font-size:13px;color:var(--muted)}
.breadcrumb strong{color:var(--text);font-weight:500}
.header-right{margin-left:auto;display:flex;align-items:center;gap:12px}
/* The design study uses NO pill radius — measured: radii 2 to 13px,
   strictly growing from inside out, never 999px. The first version here
   used a pill out of habit and then wrote that in as a deviation in the
   token file. Both reverted: faithful to the original is also compliant
   with the design system here. */
.snapshot-badge{font:11px var(--code);color:var(--muted);border:1px solid var(--line);
  border-radius:7px;padding:4px 11px}
/* The stop button. WCAG 2.2.2 requires a way to STOP movement that runs
   past five seconds — not a ban. Without this button the knowledge
   space would not be allowed to pulse at all; with it, it may. */
.icon-button{border:1px solid var(--line);border-radius:7px;background:var(--raised);
  color:var(--muted);font:11px var(--code);padding:4px 12px;cursor:pointer;
  transition:color var(--instant) var(--ease-standard),
    border-color var(--instant) var(--ease-standard)}
.icon-button:hover{color:var(--text);border-color:var(--muted)}
.icon-button:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.icon-button[aria-pressed=true]{color:var(--violet);border-color:var(--violet)}
main{padding:30px 32px 80px;width:100%;max-width:1600px;margin:0 auto}
.eyebrow{font:500 10px/1 var(--code);letter-spacing:.16em;text-transform:uppercase;
  color:var(--violet);margin-bottom:10px}
h1{font-size:30px;line-height:1.15;letter-spacing:-.025em;margin:0 0 8px;font-weight:700;
  text-wrap:balance}
.page-subtitle{color:var(--muted);max-width:74ch;margin:0 0 26px;font-size:15px}
h2{font:500 10px/1 var(--code);letter-spacing:.16em;text-transform:uppercase;
  color:var(--muted);margin:34px 0 14px;display:flex;gap:12px;flex-wrap:wrap;
  align-items:baseline}
h2 em{font-style:normal;letter-spacing:0;text-transform:none;font-family:var(--font);
  font-size:12px}
/* --- cards -------------------------------------------------------- */
.metrics{display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(224px,1fr))}
.metric{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:18px 20px}
.metric-label{font:500 10px/1 var(--code);letter-spacing:.13em;text-transform:uppercase;
  color:var(--muted);display:flex;align-items:center;gap:8px}
.metric strong{display:block;font-size:30px;font-weight:700;letter-spacing:-.03em;
  margin-top:14px;line-height:1}
.metric strong.unknown{font-size:19px;color:var(--muted);font-weight:500}
.metric p{margin:8px 0 0;font-size:12px;color:var(--muted)}
.cards{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(282px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:16px 18px;border-left:2px solid var(--c,var(--line));
  transition:border-color var(--quick) var(--ease-standard),
    background var(--quick) var(--ease-standard)}
.card:hover{border-color:var(--line-on)}
.card .name{font-weight:500;font-size:15px}
.card .state{font:11px var(--code);letter-spacing:.04em;color:var(--c,var(--muted));
  margin-top:2px}
.card .big{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:10px 0 2px}
.card p{margin:6px 0 0;color:var(--muted);font-size:13px}
.card .why{color:var(--muted);font:11px var(--code);word-break:break-word;margin-top:6px}
.kv{display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:12px}
.kv b{display:block;font:10px var(--code);letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted);font-weight:400;margin-bottom:2px}
.kv>div{min-width:76px;font-size:14px}
.chip{display:inline-block;font:11px var(--code);color:var(--muted);background:var(--raised);
  border:1px solid var(--line);border-radius:7px;padding:2px 7px;margin:3px 4px 0 0}
.chip{transition:background var(--instant) var(--ease-standard),
  color var(--instant) var(--ease-standard),
  border-color var(--instant) var(--ease-standard)}
.chip.on{background:rgba(181,160,250,.14);color:var(--violet);border-color:var(--violet)}
.none{color:var(--muted);background:var(--panel);border:1px solid var(--line);
  border-radius:14px;padding:16px 18px;max-width:82ch}
/* "Not measured" is not a quieter version of "none" — it is a different
   answer, so it gets a different HUE at the same lightness, the way the
   study separates states (227-240 deg neutral vs 250-272 deg active).
   #2e2427 is #24262e turned toward red; brightening it instead would
   read as emphasis rather than as a different kind of statement.
   The TEXT stays muted on purpose: TONE above says unmeasured is muted,
   never alarm-coloured, and a second opinion about that written here
   would be the "rule not where it applies" defect all over again. The
   colour comes from that one map, inline, not from a literal here. */
.none.unmeasured{border-color:#2e2427}
.missing{color:var(--muted);font-style:italic}
/* --- knowledge ---------------------------------------------------- */
.split{display:grid;grid-template-columns:minmax(340px,44%) 1fr;gap:16px;align-items:start}
/* **Grid children must be allowed to shrink.** A grid item defaults to
   min-width:auto, i.e. at least the width of its longest unbreakable
   word — and this list holds entry ids and file paths. At 390px that
   pushed the page past the right edge. Measured in a browser
   afterwards: scrollWidth 390 at viewport 390, on every view. */
.split>*{min-width:0}
.item .h,.item .m,.detail dd{overflow-wrap:anywhere}
.pane{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
#q{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;
  background:var(--bg);color:var(--text);font:15px var(--font)}
#q:focus{outline:2px solid var(--violet);outline-offset:1px}
.filters{display:flex;flex-wrap:wrap;gap:5px;margin:12px 0}
button.chip{cursor:pointer}
button.chip:focus-visible{outline:2px solid var(--violet);outline-offset:2px}
.list{max-height:72vh;overflow:auto;margin-top:6px}
.item{display:flex;align-items:center;gap:12px;width:100%;text-align:left;
  background:transparent;border:0;border-bottom:1px solid var(--line);padding:12px 8px;
  cursor:pointer;color:inherit}
.item{transition:background var(--instant) var(--ease-standard)}
.item:hover{background:var(--raised)}
.item[aria-current=true]{background:var(--raised-on)}
.item:focus-visible{outline:2px solid var(--violet);outline-offset:-2px}
.item .glyph{width:26px;height:26px;flex:0 0 26px;border-radius:8px;display:grid;
  place-items:center;background:var(--raised);border:1px solid var(--line);
  color:var(--c,var(--muted));font-size:12px}
.item .h{display:block;font-size:14px;line-height:1.35}
.item .m{display:block;font:11px var(--code);color:var(--muted);margin-top:3px}
.item.gone .h{color:var(--muted);text-decoration:line-through}
.detail h3{font-size:19px;letter-spacing:-.02em;margin:0 0 4px;font-weight:700}
.detail .m{font:11px var(--code);color:var(--muted)}
.detail dl{display:grid;grid-template-columns:auto 1fr;gap:7px 18px;margin:18px 0 0;
  font-size:14px}
.detail dt{font:10px var(--code);letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted);padding-top:3px}
.detail dd{margin:0;word-break:break-word}
/* --- the neural stage --------------------------------------------- */
.stage-bar{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:0 0 12px}
.stage-bar select{padding:8px 11px;border:1px solid var(--line);border-radius:9px;
  background:var(--raised);color:var(--text);font:13px var(--font)}
.stage-bar select:focus-visible,select:focus-visible{outline:2px solid var(--violet);
  outline-offset:1px}
.stage-bar .count{font:11px var(--code);color:var(--muted)}
.stage{position:relative;background:
  radial-gradient(120% 90% at 50% 0%,rgba(181,160,250,.07),transparent 62%),var(--panel);
  border:1px solid var(--line);border-radius:16px;overflow:hidden}
#space{display:block;width:100%;height:min(68vh,660px);touch-action:none;cursor:grab}
#space:active{cursor:grabbing}
#space:focus-visible{outline:2px solid var(--violet);outline-offset:-2px}
.stage-note{position:absolute;left:18px;right:18px;bottom:14px;margin:0;font:11px var(--code);
  color:var(--muted);pointer-events:none}
.stage-pick{margin-top:14px}
/* --- tables ------------------------------------------------------- */
.wrap{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;font-size:13px;width:100%}
th,td{padding:9px 12px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);
  text-align:center;white-space:nowrap}
th{font:10px var(--code);letter-spacing:.1em;text-transform:uppercase;color:var(--muted);
  font-weight:400;background:var(--raised)}
td.row-h,th.row-h{text-align:left;font:11px var(--code);color:var(--muted)}
td.hit{background:rgba(181,160,250,.13);color:var(--violet);cursor:pointer;font-weight:500}
td.hit:hover{background:var(--raised)}
td.hit:focus-visible{outline:2px solid var(--violet);outline-offset:-2px}
td.nil{color:var(--line)}
/* --- forms -------------------------------------------------------- */
form.set{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:16px 18px;margin:0 0 12px}
form.set .row{display:flex;gap:10px;margin-top:12px;flex-wrap:wrap}
form.set input{flex:1 1 220px;padding:10px 12px;border:1px solid var(--line);border-radius:9px;
  background:var(--bg);color:var(--text);font:13px var(--code)}
form.set input:focus{outline:2px solid var(--violet);outline-offset:1px}
form.set button{padding:10px 18px;border:1px solid var(--violet);border-radius:9px;
  background:rgba(181,160,250,.14);color:var(--violet);font:14px var(--font);cursor:pointer}
form.set button{transition:background var(--quick) var(--ease-crisp),
  color var(--quick) var(--ease-crisp)}
form.set button:hover:not(:disabled){background:var(--violet);color:#0a0b0e}
form.set button:disabled,form.set input:disabled{opacity:.45;cursor:not-allowed}
form.set .src{font:11px var(--code);color:var(--muted);margin:12px 0 0}
form.set .eff{color:var(--muted);font-size:13px;margin:6px 0 0}
ol.steps{list-style:none;padding:0;margin:0}
ol.steps li{background:var(--panel);border:1px solid var(--line);
  border-left:2px solid var(--c,var(--line));border-radius:12px;padding:13px 16px;margin:0 0 9px}
ol.steps b{font-size:15px;font-weight:500}
/* --- narrow ------------------------------------------------------- */
@media (max-width:980px){
  :root{--rail:0px}
  .sidebar{position:static;width:auto;inset:auto;flex-direction:row;flex-wrap:wrap;
    align-items:center;gap:12px;border-right:0;border-bottom:1px solid var(--line);
    padding:12px 16px}
  .sidebar-note,.workspace,.nav-caption,.profile{display:none}
  .rail-nav{flex-direction:row;overflow-x:auto;gap:4px}
  .nav{padding:13px 14px}
  .icon-button{padding:11px 14px}
  .shell{margin-left:0}
  .topbar{padding:12px 16px}
  main{padding:22px 16px 64px}
  .split{grid-template-columns:1fr}
  h1{font-size:24px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

// ---------------------------------------------------------------------
// The views — deskView, knowledgeView, spaceView, projectsView,
// agentsView, netView, setView — live one-per-module under `src/astra/`
// (dashboard block D2-D8: one view per module, so several agents can
// extend one each without meeting in the same file). This file is the
// facade: it imports them, and nothing else here builds a view's markup.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// The browser half
// ---------------------------------------------------------------------
//
// A string constant, so nothing in it is interpolated. It moved here
// with the rest of the presentation: `dashboard.mjs` is the data layer
// now and knows nothing about markup, which is why there is exactly one
// copy of every selector.
const SCRIPT = String.raw`
(function () {
  function q(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
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

  // --- the rail ------------------------------------------------------
  var crumb = document.getElementById('crumb');
  q('.nav').forEach(function (b) {
    b.onclick = function () {
      q('.nav').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); });
      q('main > section').forEach(function (s) { s.hidden = (s.id !== 'v-' + b.dataset.view); });
      if (crumb) crumb.textContent = b.dataset.label;
      if (b.dataset.view === 'space') {
        setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 0);
      }
    };
  });

  // --- the knowledge list --------------------------------------------
  var box = document.getElementById('q'), hits = document.getElementById('hits'), type = '';
  function filter() {
    if (!box) return;
    var t = (box.value || '').toLowerCase(), n = 0, items = q('#list .item');
    items.forEach(function (el) {
      var ok = (!type || el.dataset.type === type) && (!t || el.dataset.find.indexOf(t) >= 0);
      el.hidden = !ok;
      if (ok) n += 1;
    });
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
        + '<dt>drawer</dt><dd>' + esc(e.typeLabel || e.type) + '</dd>'
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

  // --- the link matrix -----------------------------------------------
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

  // --- the knowledge space -------------------------------------------
  var canvas = document.getElementById('space');
  if (canvas) (function () {
    var ctx = canvas.getContext('2d');
    var CORE = 'core:memory';
    var nodes = [], edges = [], byId = {};
    function put(n) { nodes.push(n); byId[n.id] = n; return n; }
    function link(a, b, kind) { edges.push({ from: a, to: b, kind: kind }); }
    function h32(str) {
      var x = 2166136261, i;
      for (i = 0; i < str.length; i += 1) { x = Math.imul(x ^ str.charCodeAt(i), 16777619); }
      return (x >>> 0) / 4294967295;
    }
    // One place that knows which line a mode shows. Two copies of this
    // rule drift apart the day a third kind of edge arrives.
    function shows(e, m) {
      return m === 'declared' ? e.kind === 'declared' : e.kind === 'structure';
    }

    var keys = Object.keys(ENTRIES);
    var types = [];
    keys.forEach(function (id) {
      if (types.indexOf(ENTRIES[id].type) < 0) types.push(ENTRIES[id].type);
    });
    types.sort();
    put({ id: CORE, label: 'memory', x: 0, y: 0, z: 0, r: 8, kind: 'core' });
    types.forEach(function (t, i) {
      var a = i / types.length * Math.PI * 2 - 0.5;
      put({ id: 'type:' + t, label: t, x: Math.cos(a) * 150, y: Math.sin(a) * 102,
        z: Math.sin(a * 2) * 74, r: 5.5, kind: 'type' });
      link(CORE, 'type:' + t, 'structure');
    });
    types.forEach(function (t) {
      var mine = keys.filter(function (id) { return ENTRIES[id].type === t; });
      var parent = byId['type:' + t];
      mine.forEach(function (id, k) {
        var a = k * 2.399 + h32(id) * 0.8, rad = 38 + Math.sqrt(k) * 18;
        put({ id: id, label: ENTRIES[id].headline, x: parent.x + Math.cos(a) * rad,
          y: parent.y + Math.sin(a) * rad * 0.74,
          z: parent.z + (h32(id + 'z') - 0.5) * 170, r: 3.4, kind: 'entry' });
        link(parent.id, id, 'structure');
      });
    });
    var tags = {};
    keys.forEach(function (id) {
      (ENTRIES[id].tags || []).forEach(function (t) {
        if (!tags[t]) tags[t] = [];
        tags[t].push(id);
      });
    });
    Object.keys(tags).forEach(function (t) {
      if (tags[t].length < 2) return;
      var a = h32(t) * Math.PI * 2, rad = 200 + h32(t + 'r') * 76;
      put({ id: 'tag:' + t, label: '#' + t, x: Math.cos(a) * rad,
        y: Math.sin(a) * rad * 0.68, z: (h32(t + 'z') - 0.5) * 260, r: 1.8, kind: 'tag' });
      tags[t].forEach(function (id) { link('tag:' + t, id, 'structure'); });
    });
    var declared = 0;
    keys.forEach(function (id) {
      (ENTRIES[id].links || []).forEach(function (l) {
        if (!byId[l.id]) return;
        link(id, l.id, 'declared');
        declared += 1;
      });
    });

    // The glow budget, computed once: the node count does not change
    // after the layout is built.
    var glanz = Math.min(1, Math.sqrt(220 / Math.max(1, nodes.length)));
    var glanzAlpha = ('0' + Math.round(0x44 * glanz).toString(16)).slice(-2);

    var W = 0, H = 0, dpr = 1, ry = 0.6, rx = 0.32, zoom = 1;
    var picked = null, drag = null, raf = null;
    // **Motion, and why it is allowed here at all.**
    //
    // docs/viewer-design.md says for the viewer: nothing moves forever,
    // no shimmer, no pulsing dot — because of WCAG 2.2.2. That rule is
    // not a ban; it demands a way to STOP. So this has both: the pulse
    // runs, and a button in the header halts it.
    //
    // Three latches make that hold:
    //   1. Whoever set prefers-reduced-motion starts PAUSED. Calm is the
    //      default for the person who asked for it.
    //   2. With the tab in the background nothing runs — an animation
    //      for nobody is only electricity.
    //   3. The pulse runs ONLY on declared edges. It shows the direction
    //      of a reference somebody wrote down; on membership lines it
    //      would be ornament and would attribute a statement to them
    //      that they do not make.
    var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var paused = calm;
    var phase = 0, last = 0, painted = 0, ticker = null;
    var motionBtn = document.getElementById('motion');
    function setMotion(an) {
      paused = !an;
      if (motionBtn) {
        motionBtn.setAttribute('aria-pressed', String(!paused));
        motionBtn.textContent = paused ? '\u25b6 motion' : '\u25ae\u25ae motion';
      }
      if (!paused) tick();
    }
    function tick(t) {
      if (paused || document.hidden) { ticker = null; return; }
      var now = t || performance.now();
      var dt = Math.min(64, now - (last || now));
      last = now;
      // **The speeds come from the study, not from a feeling.**
      // Recomputed: a pulse phase of 0.00016/ms is 6.25 s for one edge
      // traversal, a rotation of 0.000027/ms is 233 s — just under four
      // minutes — for one turn. The first version here ran at 4.5 s and
      // 97 s, almost twice as fast. That is the difference between "the
      // space breathes" and "something is moving over there".
      phase = (phase + dt * 0.00016) % 1;
      if (!drag) ry += dt * 0.000027;
      // Frame gate as in the study: ~33 frames per second are enough for
      // these distances and cost a third less, which is noticeable on two
      // cores next to the CI.
      if (now - painted < 30) { ticker = requestAnimationFrame(tick); return; }
      painted = now;
      paint();
      ticker = requestAnimationFrame(tick);
    }
    var modeEl = document.getElementById('space-mode');
    var noteEl = document.getElementById('space-note');
    var countEl = document.getElementById('space-count');
    function mode() { return modeEl.value; }
    function css(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }
    function sizeUp() {
      var rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      W = rect.width; H = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint();
    }
    function project(n) {
      var cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
      var x = n.x * cy + n.z * sy, z = -n.x * sy + n.z * cy;
      var y = n.y * cx - z * sx, z2 = n.y * sx + z * cx;
      var s = 760 / (760 + z2) * Math.min(W / 700, H / 430) * zoom;
      // Optical centre, not geometric. The study says this three times
      // independently and in the same direction: canvas centre at 0.49 of
      // the height, the space label at 47 %, the stage gradient at 51/45.
      // A field with a caption under it reads as too low at exactly 0.5.
      return { x: W * 0.5 + x * s, y: H * 0.49 + y * s, z: z2, s: s };
    }
    function paint() {
      if (!W) return;
      var m = mode();
      var text = css('--text'), muted = css('--muted'), violet = css('--violet');
      var blue = css('--blue');
      ctx.clearRect(0, 0, W, H);
      nodes.forEach(function (n) { n.p = project(n); });
      var near = {};
      if (picked) {
        near[picked] = true;
        edges.forEach(function (e) {
          if (!shows(e, m)) return;
          if (e.from === picked || e.to === picked) { near[e.from] = true; near[e.to] = true; }
        });
      }
      edges.forEach(function (e, edgeIx) {
        if (!shows(e, m)) return;
        var a = byId[e.from].p, b = byId[e.to].p;
        var lit = picked && (e.from === picked || e.to === picked);
        // Damping, not hiding: uninvolved edges go to .055 and not to 0,
        // so the overall shape stays as a ghost image. Whoever makes a
        // selection should see WHERE in the structure they are — a
        // cleared surface takes exactly that away.
        ctx.globalAlpha = lit ? 0.75 : picked ? 0.055 : (e.kind === 'declared' ? 0.6 : 0.16);
        ctx.lineWidth = lit ? 1.2 : 0.7;
        // Structure lines are violet-tinted, as in the study. The first
        // version took --line (#24262e) and they vanished on this ground
        // — a rendered screenshot showed it; the code read fine.
        ctx.strokeStyle = e.kind === 'declared' ? blue : violet;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        if (e.kind === 'declared') {
          var ang = Math.atan2(b.y - a.y, b.x - a.x);
          var px = b.x - Math.cos(ang) * 9, py = b.y - Math.sin(ang) * 9;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px - Math.cos(ang - 0.45) * 7, py - Math.sin(ang - 0.45) * 7);
          ctx.lineTo(px - Math.cos(ang + 0.45) * 7, py - Math.sin(ang + 0.45) * 7);
          ctx.closePath(); ctx.fillStyle = blue; ctx.fill();
          // The surge: a point of light travels from source to target.
          // It says the same thing as the arrowhead, only over time — and
          // it says it ONLY where somebody declared the reference.
          // **Three rules from the study, and every one of them carries.**
          //
          //   1. With nothing selected only EVERY SEVENTH edge carries a
          //      dot. All of them at once is noise, not signal — that is
          //      the difference between a living network and a chase
          //      light. With something selected, every involved edge
          //      carries one.
          //   2. The offset 'i * 0.177' prevents lockstep. Without it all
          //      dots march in rank and file, and that reads immediately
          //      as an animation instead of a flow.
          //   3. An involved dot is BRIGHTER (#e3caff instead of
          //      #b499c9) — the same emphasis as on the edges, only at
          //      the moving end.
          if (!paused && (lit || edgeIx % 7 === 0)) {
            var tt = (phase + edgeIx * 0.177) % 1;
            var gx = a.x + (b.x - a.x) * tt, gy = a.y + (b.y - a.y) * tt;
            var farbe = lit ? '#e3caff' : '#b499c9';
            var gl = ctx.createRadialGradient(gx, gy, 0, gx, gy, 6);
            gl.addColorStop(0, farbe);
            gl.addColorStop(1, farbe + '00');
            ctx.globalAlpha = 1;
            ctx.fillStyle = gl;
            ctx.beginPath(); ctx.arc(gx, gy, 6, 0, Math.PI * 2); ctx.fill();
          }
        }
      });
      var live = m === 'declared'
        ? nodes.filter(function (n) { return n.kind === 'entry'; }) : nodes;
      live.slice().sort(function (a, b) { return b.p.z - a.p.z; }).forEach(function (n) {
        ctx.globalAlpha = picked && !near[n.id] ? 0.23 : 1;
        var r = Math.max(1, n.r * n.p.s);
        var col = n.kind === 'entry' ? text : n.kind === 'tag' ? muted : violet;
        if (n.kind !== 'tag') {
          // **The glow scales with density, and that is measured.** The
          // study puts about a hundred nodes on the stage; there a glow
          // of r*6 at alpha 0x44 carries the depth. A real memory in
          // the sibling project laid out 605 — and at 605 the glows
          // overlap into a white cloud with no structure left in it.
          // Seen on a rendered screenshot; the source read fine. Not
          // switched off (the stage would lose its depth), divided.
          var g = ctx.createRadialGradient(n.p.x, n.p.y, 0, n.p.x, n.p.y, r * 6 * glanz);
          g.addColorStop(0, col + glanzAlpha); g.addColorStop(1, col + '00');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(n.p.x, n.p.y, r * 6 * glanz, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(n.p.x, n.p.y, r, 0, Math.PI * 2); ctx.fill();
        if (n.kind === 'type' && m === 'structure') {
          ctx.font = '500 11px ' + css('--font');
          ctx.textAlign = 'center';
          ctx.fillStyle = muted;
          ctx.fillText(n.label, n.p.x, n.p.y + r + 19);
        }
      });
      ctx.globalAlpha = 1;
      if (m === 'declared' && declared === 0) {
        ctx.font = '13px ' + css('--font');
        ctx.textAlign = 'center';
        ctx.fillStyle = muted;
        ctx.fillText('Not one declared link runs between these entries.', W / 2, H / 2);
      }
      countEl.textContent = m === 'declared'
        ? (keys.length + ' entries, ' + declared + ' declared')
        : (nodes.length + ' nodes, ' + keys.length + ' entries');
      noteEl.textContent = m === 'declared'
        ? 'Arrows: a link somebody wrote down. Nothing here is inferred.'
        : 'Lines: where an entry sits - its drawer, its tags. No claim about meaning.';
    }
    function ask() {
      if (!raf) raf = requestAnimationFrame(function () { raf = null; paint(); });
    }
    function nearest(ev) {
      var rect = canvas.getBoundingClientRect();
      var mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
      var best = null, bestD = 20 * 20, m = mode();
      nodes.forEach(function (n) {
        if (!n.p) return;
        if (m === 'declared' && n.kind !== 'entry') return;
        var dx = n.p.x - mx, dy = n.p.y - my, dd = dx * dx + dy * dy;
        if (dd < bestD) { bestD = dd; best = n; }
      });
      return best;
    }
    function near2(list) {
      return list.length
        ? list.map(function (l) { return esc(l.kind) + ' -> ' + esc(l.id); }).join('<br>')
        : '<span class="missing">none on this page</span>';
    }
    function show(n) {
      var pane = document.getElementById('space-pick');
      if (!n) { picked = null; ask(); return; }
      picked = n.id;
      if (n.kind !== 'entry') {
        pane.innerHTML = '<p class="none">' + esc(n.label) + ' - '
          + (n.kind === 'tag' ? 'a tag. The lines say which entries carry it, nothing more.'
            : n.kind === 'type' ? 'a drawer. The lines say which entries are in it.'
              : 'this memory.') + '</p>';
        ask(); return;
      }
      var e = ENTRIES[n.id];
      var out = (e.links || []).filter(function (l) { return byId[l.id]; });
      var into = (e.backlinks || []).filter(function (l) { return byId[l.id]; });
      pane.innerHTML = '<h3>' + esc(e.headline) + '</h3>'
        + '<div class="m">' + esc(n.id) + ' &middot; ' + esc(e.typeLabel || e.type)
        + ' &middot; ' + esc(e.project) + '</div>'
        + '<dl><dt>declared out</dt><dd>' + near2(out) + '</dd>'
        + '<dt>declared in</dt><dd>' + near2(into) + '</dd>'
        + '<dt>tags</dt><dd>' + ((e.tags || []).length
          ? e.tags.map(esc).join(', ') : '<span class="missing">none</span>') + '</dd></dl>';
      ask();
    }
    canvas.onpointerdown = function (ev) {
      canvas.setPointerCapture(ev.pointerId);
      drag = { x: ev.clientX, y: ev.clientY, moved: false };
    };
    canvas.onpointermove = function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      ry += dx * 0.006;
      rx = Math.max(-1.2, Math.min(1.2, rx + dy * 0.004));
      drag.x = ev.clientX; drag.y = ev.clientY;
      ask();
    };
    canvas.onpointerup = function (ev) {
      var wasDrag = drag && drag.moved;
      drag = null;
      if (!wasDrag) show(nearest(ev));
    };
    canvas.onwheel = function (ev) {
      ev.preventDefault();
      zoom = Math.max(0.4, Math.min(3, zoom * (ev.deltaY < 0 ? 1.12 : 0.89)));
      ask();
    };
    // A view you can only reach by dragging is a view some people
    // cannot reach at all.
    canvas.onkeydown = function (ev) {
      var step = 0.12;
      if (ev.key === 'ArrowLeft') ry -= step;
      else if (ev.key === 'ArrowRight') ry += step;
      else if (ev.key === 'ArrowUp') rx = Math.max(-1.2, rx - step);
      else if (ev.key === 'ArrowDown') rx = Math.min(1.2, rx + step);
      else if (ev.key === '+' || ev.key === '=') zoom = Math.min(3, zoom * 1.12);
      else if (ev.key === '-') zoom = Math.max(0.4, zoom * 0.89);
      else if (ev.key === 'Escape') { show(null); return; }
      else return;
      ev.preventDefault();
      ask();
    };
    modeEl.onchange = function () { picked = null; ask(); };
    if (motionBtn) motionBtn.onclick = function () { setMotion(paused); };
    // Nothing runs in the background, and on coming back it starts again
    // — without anyone having to press the button a second time.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !paused && !ticker) { last = 0; tick(); }
    });
    if (window.ResizeObserver) new ResizeObserver(sizeUp).observe(canvas);
    window.addEventListener('resize', sizeUp);
    sizeUp();
    setMotion(!calm);
  }());
}());
`;

/**
 * The whole page, as one string. Pure function of the collected data —
 * no I/O, so a test can hand it a fixture and read the result.
 */
export function renderHtml(d, { title = 'cheap-mem', writable = true } = {}) {
  const views = {
    desk: deskView(d),
    knowledge: knowledgeView(d),
    space: spaceView(d),
    projects: projectsView(d),
    agents: agentsView(d),
    net: netView(d),
    set: setView(d, { writable }),
  };
  const order = [...VIEWS];
  const counts = {
    knowledge: d.entries.length,
    projects: d.projects.length,
    agents: d.agents.length,
    net: d.net.links,
  };
  const rail = order.map((id, i) => {
    const [glyph, label] = NAV[id];
    const n = counts[id];
    return `<button class="nav" role="tab" id="tab-${id}" data-view="${id}"
      data-label="${h(label)}" aria-controls="v-${id}" aria-selected="${i === 0}">
      <span class="nav-glyph">${glyph}</span>${h(label)}${
  n === undefined ? '' : `<span class="nav-count">${n}</span>`}</button>`;
  }).join('');
  const sections = order.map((id, i) =>
    `<section id="v-${id}" role="tabpanel" aria-labelledby="tab-${id}"${
      i === 0 ? '' : ' hidden'}>${views[id]}</section>`).join('');

  // Only what the detail pane needs, and only for the rows that really
  // made it onto the page. Both sides cut at the same constant.
  const payload = Object.fromEntries(d.entries.slice(0, LIST_MAX).map((e) => [e.id, {
    headline: e.headline, type: e.type, typeLabel: e.typeLabel, project: e.project,
    ts: e.ts, source: e.source, line: e.line, readable: e.readable, basis: e.basis,
    authority: e.authority, author: e.author, scope: e.scope, cited: e.cited,
    contested: e.contested, retired: e.retired, replaces: e.replaces,
    derivedFrom: e.derivedFrom, links: e.links, backlinks: e.backlinks,
    contradictedBy: e.contradictedBy, tags: e.tags,
  }]));
  const pairs = Object.fromEntries(d.net.pairs.map((p) => [CELL(p.from, p.to), p]));
  const initial = NAV[order[0]][1];
  const mark = h((title[0] || 'm').toUpperCase());

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${INK.bg}">
<title>${h(title)} — workspace</title>
<style>${CSS}</style>
</head><body>
<aside class="sidebar">
  <a class="brand" href="/"><span class="brand-symbol">&#8984;</span>${h(title)}</a>
  <div class="workspace">
    <span class="workspace-icon">${mark}</span>
    <span><b>${h(title)}</b><span class="sub">personal knowledge system</span></span>
  </div>
  <div class="nav-caption">Workspace</div>
  <div class="rail-nav" role="tablist" aria-label="views">${rail}</div>
  <div class="sidebar-note">
    Context that connects. Every number on this page was measured in one
    pass over the log — nothing here is a sample, and nothing falls back
    to one.
  </div>
  <div class="profile">
    <span class="avatar">${mark}</span>
    <span><b>${h(d.git.branch ?? 'no branch')}</b><span>@ ${h(d.git.head ?? '?')}</span></span>
  </div>
</aside>
<div class="shell">
  <header class="topbar">
    <div class="breadcrumb">${h(title)} / <strong id="crumb">${h(initial)}</strong></div>
    <div class="header-right">
      <span class="snapshot-badge">measured ${h(d.at)}</span>
      <span class="snapshot-badge">${d.inventory.total} entries</span>
      <button id="motion" class="icon-button" aria-pressed="false"
        title="Pause or resume the movement in the knowledge space">&#9646;&#9646; motion</button>
    </div>
  </header>
  <main>${sections}</main>
</div>
<script>
var ENTRIES = ${safeJson(payload)};
var PAIRS = ${safeJson(pairs)};
${SCRIPT}
</script>
</body></html>
`;
}

/** Collect and render in one call. */
export function build(root, {
  title = 'cheap-mem', env = process.env, now = new Date(), cfg = {}, writable = true,
} = {}) {
  const data = dashboard.collect(root, { env, now, cfg });
  return { data, html: renderHtml(data, { title, writable }) };
}

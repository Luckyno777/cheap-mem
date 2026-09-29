/* SPDX-FileCopyrightText: 2026 Lucky H.
 * SPDX-License-Identifier: MIT
 *
 * cheap-mem · Dashboard — the script of the one UI.
 *
 * The sibling house's dashboard (Dashboard-Muster-3), ported
 * view for view: the same areas, tabs, ids, click delegation, keyboard,
 * dialogs, animations and the 3D energy-core network. Owner decision
 * 2026-09-28: the two houses are functionally and visually identical —
 * English here, cheap-mem's own C mark, an empty store on a fresh
 * install. What the mockup read from its demo array comes from
 * /dashboard.json (src/dashboard-data.mjs); single entries from
 * /dashboard/entry.json, single messages from /dashboard/message.json.
 *
 * House rules that become visible here:
 *  - four states good/warning/error/unknown; "unknown" has its own
 *    neutral tone (class .unknown), never the warning's;
 *  - not measurable is not null's cousin zero: a missing measurement
 *    shows "—" or "unknown" with a reason, never 0;
 *  - "not available in cheap-mem" is shown, never an empty list, for the
 *    three sibling views with no counterpart here (books, digester yield
 *    per run, scale gate) — each with the reason it is a difference of
 *    design; restore, merge, hook time and the live injection view are
 *    built and read the injection journal / the append-only logs;
 *  - writing happens ONLY through the existing routes and their gate:
 *    POST /inbox/reply, POST /inbox/state, POST /setting, POST /task.
 *    Everything else is visibly "read only" and names the CLI route.
 *  - no address outside: every fetch() goes to one of this server's own
 *    routes (test/dashboard-page.test.mjs holds the list).
 */
'use strict';
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = {
  home: 'M3 10l9-7 9 7v10h-6v-6H9v6H3z',
  knowledge: 'M4 4h6l2 2 2-2h6v15h-6l-2 2-2-2H4z M12 6v15',
  work: 'M8 6V3h8v3 M3 7h18v13H3z M3 12h18 M10 12v3h4v-3',
  sources: 'M3 7V4h7l3 3h8v13H3z',
  ops: 'M3 17l4-7 4 4 5-10 5 7 M3 21h18',
  settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
};
const icon = (k) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[k] || icons.knowledge}"/></svg>`;
const sections = {
  home: { name: 'Overview', tabs: [] },
  knowledge: {
    name: 'Knowledge',
    tabs: [['entries', 'Entries'], ['network', 'Knowledge space'], ['topics', 'Topics'], ['facts', 'Facts & time'], ['learnings', 'Learnings'], ['skills', 'Skills & procedures'], ['books', 'Books']],
  },
  work: {
    name: 'Work & agents',
    tabs: [['tasks', 'Duties & questions'], ['agents', 'Agents'], ['inbox', 'Inbox'], ['context', 'Agent context'], ['usage', 'Usage'], ['understanding', 'User & ledger']],
  },
  sources: {
    name: 'Sources & archive',
    tabs: [['projects', 'Projects'], ['files', 'Sources & store'], ['raw', 'Raw capture'], ['digest', 'Digest'], ['export', 'Export studio']],
  },
  ops: {
    name: 'Operations',
    tabs: [['shards', 'Storage & drawers'], ['operations', 'Tasks'], ['doctor', 'Diagnosis'], ['performance', 'Performance'], ['integrity', 'Integrity'], ['versions', 'Versions'], ['mcp', 'MCP tools']],
  },
  settings: {
    name: 'Settings',
    tabs: [['appearance', 'Appearance'], ['access', 'Access'], ['system', 'System settings'], ['catalog', 'Function catalogue'], ['projectstate', 'Project state']],
  },
};
// The names of the 13 types (singular) — keys from memory.TYPES; the
// list itself comes with the data (D.types), this is only the fallback
// for the moment before the first load.
let types = {
  decision: 'Decision', error: 'Error', event: 'Event', timeline: 'Fact', thought: 'Thought', learning: 'Learning', duty: 'Duty',
  question: 'Question', skill: 'Skill', procedure: 'Procedure', source: 'Source', update: 'Update', link: 'Link',
};
const edgeLabels = {
  derived_from: 'Origin', replaces: 'Replaces', closes: 'Closes', causes: 'Causes', generalizes: 'Generalizes',
  contradicts: 'Contradicts', resolves: 'Resolves',
};

// --- Data ---------------------------------------------------------------------
let D = null; // the answer of /dashboard.json
let entries = [];
let messages = [];

// The renameable core label (setting 'core-name'; default = today's fixed
// text, so nothing changes visually until someone sets it). Read from
// D.settings, the same closed list dashboard-page.mjs and console.mjs
// serve for every other setting.
function coreName() {
  const s = (D?.settings || []).find((x) => x.id === 'core-name');
  const v = s && s.value != null ? String(s.value).trim() : '';
  return v || 'CHEAP MEM';
}
// Same name, in the breadcrumb's lowercase-hyphenated house style. For the
// unchanged default this reduces to exactly the old hardcoded 'cheap-mem'.
function coreSlug() {
  return coreName().toLowerCase().replace(/\s+/g, '-');
}
let rawSamples = [];
let entryIndex = new Map();
let incomingIndex = new Map();
let loadError = null;
const serverWrites = document.body.dataset.writes === '1';
// The password in front of the dashboard (src/login.mjs) — display only;
// the server decides on its own.
const loginEnabled = document.body.dataset.login === '1';
const PW_MIN = 10; // = login.MIN_LENGTH; the server checks for itself

const state = {
  area: 'home', tab: '', memory: 'local', project: 'all', query: '', type: 'all', status: 'all', sort: 'new', page: 1,
  graphMode: 'storage', motion: !matchMedia('(prefers-reduced-motion: reduce)').matches, light: false,
  readonly: !serverWrites, missing: false, drawerTab: 'content', selected: null, context: 'all', trail: null,
  inboxTo: null, inboxAll: false, inboxQuery: '',
};
let raf = 0, graphCleanup = () => {}, toastTimer;
let graphRun = 0; // tempo: counter for the deferred initGraph() in render()
let refetchTimer = 0; // tempo: quiet refetch while the server rebuilds
// no-jump (2026-09-29): a background refetch must never draw — that
// replaces #screen entirely and throws away scroll, open <details>,
// inputs and selection. Background calls only remember WHETHER the
// content really changed (lastContentKey), and show a quiet marker when
// it did; render() (every navigation, every user action) shows the
// newest state anyway and hides the marker in the same pass — a
// showNewDataMark() followed by a render() in the same tick never
// visibly flickers.
let lastContentKey = null;
let newDataReady = false;
// Test-only: shortens the intervals below so a probe does not have to
// wait the real 5000/20000 ms. Without the data attribute in the page
// head (normal operation) this stays null. See src/switches.mjs
// CHEAP_MEM_SERVE_TEMPO_TEST_MS.
const TEMPO_TEST_MS = Number(document.body.dataset.tempoTestMs || 0) || null;
// Fields in the /dashboard.json answer that do NOT count when asking
// "did the content really change" — they change on EVERY fetch, even
// without a real change in the memory (the build timestamp, the MCP
// live probe, the bridge tile's relative "reported X ago" line), and
// would otherwise show the marker on every quiet refetch.
function contentKey(d) {
  try {
    const copy = JSON.parse(JSON.stringify(d));
    delete copy.cache; // the cache's own build metadata, not content
    delete copy.at; // the timestamp of THIS build, not content
    if (copy.catalog?.mcp) {
      // MCP live probe: its own cadence (every few minutes), independent
      // of real memory changes — its verdict and reason too, not only the
      // time. `clientVisible` (real MCP client sightings) stays content.
      delete copy.catalog.mcp.liveCheckedAt;
      delete copy.catalog.mcp.live;
      delete copy.catalog.mcp.liveReason;
    }
    if (Array.isArray(copy.system)) for (const t of copy.system) if (t?.id === 'bridge') delete t.line; // "reported X ago"
    return JSON.stringify(copy);
  } catch {
    return null; // not comparable -> rather nothing than something wrong (house rule)
  }
}
function showNewDataMark() {
  newDataReady = true;
  const el = $('#newDataMark');
  if (el) el.hidden = false;
}
function hideNewDataMark() {
  newDataReady = false;
  const el = $('#newDataMark');
  if (el) el.hidden = true;
}
const byId = (id) => entryIndex.get(id);
const when = (t) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const whenTime = (t) => {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const num = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-GB'));
const pluralEntries = (count) => (count === 1 ? '1 entry' : num(count) + ' entries');
// ONE label for "how many entries are there in total", not `entries.length`
// (the full history list for the view — retired and replaced lines
// included, marked) under the same bare label as the HOLDING count
// (`D.meta.entriesTotal`, the same number `mem board` and the old desk
// show). Present -> the holding count, with no suffix; missing (meta not
// readable) -> the full list, but WITH the suffix that names the
// difference, never silently.
const entriesTotalText = () => {
  const g = D?.meta?.entriesTotal;
  return g != null ? `${num(g)} entries` : `${num(entries.length)} entries (incl. history)`;
};
const mb = (b) => (b === null || b === undefined ? '—' : (b / 1048576).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' MB');
const age = (min) => {
  if (min === null || min === undefined || !Number.isFinite(min)) return '—';
  if (min < 60) return Math.round(min) + ' min';
  if (min < 1440) return Math.round(min / 60) + ' h';
  const t = Math.round(min / 1440);
  return t + (t === 1 ? ' day' : ' days');
};
const scope = (x) => (state.memory === 'all' || (x.memory || 'local') === state.memory) && (state.project === 'all' || x.project === state.project);
const scoped = () => entries.filter(scope);
const drawerOf = (e) => e.project + '/' + e.type;

function statusOf(id) {
  const e = byId(id);
  if (!e) return 'unknown';
  if (e.state && e.state !== 'active') return e.state;
  if (e.type === 'duty') return D && D._openDuty.has(id) ? 'open' : 'done';
  if (e.type === 'question') return D && D._openQuestion.has(id) ? 'open' : 'answered';
  return 'active';
}
// Four states: "unknown" gets its own neutral tone (decision 2026-09-27
// in the sibling house: house rule before pixel fidelity).
function badge(s, label) {
  const tone = ['active', 'complete', 'answered', 'done', 'present', 'good', 'ok', 'alive', 'calm', 'configured', 'measured', 'running', 'finished', 'checked', 'ready', 'in order', 'on', 'current', 'known_complete'].includes(s)
    ? 'good'
    : ['open', 'stale', 'draft', 'partial', 'replaced', 'superseded', 'digested', 'warning', 'warn', 'watch', 'waiting', 'waiting too long', 'elsewhere', 'other machine', 'paused', 'cancelled', 'expired', 'off', 'known_partial', 'too_little_evidence'].includes(s)
      ? 'warn'
      : ['missing', 'discarded', 'damaged', 'error', 'alarm', 'unreachable', 'deleted', 'broken', 'dropped', 'obsolete'].includes(s)
        ? 'bad'
        : ['unknown', 'not seen', 'not measurable', 'never shown', 'not measured', 'not available', 'unknown_coverage'].includes(s)
          ? 'unknown'
          : '';
  return `<span class="badge ${tone}"><i class="dot"></i>${esc(label ?? s)}</span>`;
}
// The old desk's four board states, as one word each.
const boardWord = { calm: 'in order', watch: 'wants someone', alarm: 'broken', unknown: 'not measured' };
const levelWord = { good: 'good', warn: 'warning', error: 'error', unknown: 'unknown' };
const btn = (text, action, extra = '', cls = '') => `<button class="btn ${cls}" data-action="${action}" ${extra}>${text}</button>`;
const link = (text, to) => `<button class="textlink" data-route="${to}">${text} ↗</button>`;
const open = (id, text, cls = 'btn small') => `<button class="${cls}" data-entry="${esc(id)}">${esc(text || byId(id)?.title || id)}</button>`;
const panel = (title, body, sub = '', extra = '') =>
  `<article class="panel pad ${extra}"><div class="panelhead"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div></div>${body}</article>`;
// Machine reasons from the server turned into a sentence with the remedy
// (dash-fix4: "foreign-host" alone told nobody anything on a phone).
function reasonPlain(r) {
  if (!r) return 'unknown';
  if (r === 'foreign-host') return 'foreign-host — the server does not know this host name. On the host: add it to CHEAP_MEM_SERVE_HOSTS (or its origin to CHEAP_MEM_SERVE_ORIGINS), then restart mem serve.';
  return r;
}
function note(t, kind = '') {
  return `<div class="callout ${kind}">${t}</div>`;
}
function empty(t = 'Nothing in this area matches the selection.') {
  return `<div class="empty">${t}</div>`;
}
// "Not available in cheap-mem": a sibling view with no counterpart here,
// shown with its reason — never an empty list (owner decision 2026-09-28).
function notAvailable(key) {
  const n = D?.notAvailable?.[key];
  return `<div class="row"><div><strong>${esc(n?.title || key)}</strong><p>${esc(n?.reason || 'Not available in cheap-mem.')}</p></div>${badge('not available', 'not available in cheap-mem')}</div>`;
}
// Release rail (Bauplan P1, src/release.mjs) — four real states, never
// "not available": a fresh install reads `unknown` with "unknown — no
// release yet", the same phrasing the check-record row below uses.
function releaseRow(r) {
  if (!r || !r.readable) {
    return `<div class="row"><div><strong>Release state</strong><p>${esc(r?.reason || 'unknown')}</p></div>${badge(r?.state || 'unknown', levelWord[r?.state] || 'unknown')}</div>`;
  }
  const bits = [r.kurzhash ? `commit ${esc(r.kurzhash)}` : null, r.createdAt ? `created ${esc(whenTime(r.createdAt))}` : null,
    r.proven ? 'proven by a checked.jsonl row' : 'forced (--allow-unproven)'];
  const text = bits.filter(Boolean).join(' · ') + (r.reason ? ` — ${r.reason}` : '');
  return `<div class="row"><div><strong>Release state</strong><p>${esc(text)}</p></div>${badge(r.state, levelWord[r.state] || r.state)}</div>`;
}
// The last recorded green suite run (Bauplan P1, src/checkrecord.mjs,
// checked.jsonl) — same four-state shape as releaseRow above.
function checkRecordRow(c) {
  if (!c || !c.readable) {
    return `<div class="row"><div><strong>Last test receipt</strong><p>${esc(c?.reason || 'unknown')}</p></div>${badge(c?.state || 'unknown', levelWord[c?.state] || 'unknown')}</div>`;
  }
  const bits = [Number.isFinite(c.passed) ? `${num(c.passed)} passed` : null, c.ts ? esc(whenTime(c.ts)) : null,
    c.machine ? `machine ${esc(c.machine)}` : null];
  const text = bits.filter(Boolean).join(' · ') + (c.reason ? ` — ${c.reason}` : '');
  return `<div class="row"><div><strong>Last test receipt</strong><p>${esc(text)}</p></div>${badge(c.state, levelWord[c.state] || c.state)}</div>`;
}
// "Read only": visible, but with the route that really does it.
function readonlyMark(cli) {
  return `<span class="badge unknown read-only"><i class="dot"></i>read only</span>${cli ? ` <span class="small quiet">CLI: <code class="mono">${esc(cli)}</code></span>` : ''}`;
}
function toast(t) {
  $('#toast').textContent = t;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('#toast').hidden = true), 3500);
}
function heading(k, title, desc, action = '') {
  return `<div class="pageheading"><div><div class="label">${k}</div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
}
function metrics(items) {
  return `<div class="metrics">${items.map(([a, b, c]) => `<div class="metric"><span class="name">${a}</span><strong>${b}</strong><small>${c}</small></div>`).join('')}</div>`;
}
function entryRows(list, emptyText) {
  return (
    list
      .map(
        (e) =>
          `<div class="row"><div class="row-main"><span class="entry-icon">${esc(types[e.type]?.[0])}</span><div>${open(e.id, e.title, 'open-entry textlink')}<p>${esc(types[e.type])} · ${esc(e.project)} · ${esc(e.agent)}</p></div></div>${badge(statusOf(e.id))}</div>`,
      )
      .join('') || empty(emptyText)
  );
}
const limitNote = (shown, all, route) =>
  all > shown ? `<p class="small quiet" style="margin-top:12px">${num(shown)} of ${num(all)} shown — ${route ? link('all in the list', route) : 'all through the search'}</p>` : '';

// --- Loading ------------------------------------------------------------------
function prepare(d) {
  D = d;
  types = Object.fromEntries((d.types || []).map((t) => [t.type, t.name]));
  D._openDuty = new Set((d.openDuties || []).map((p) => p.id));
  D._dutyWho = new Map((d.openDuties || []).map((p) => [p.id, p.who]));
  D._openQuestion = new Set((d.openQuestions || []).map((f) => f.id));
  entries = (d.entries || []).map((e) => ({
    id: e.id, type: e.type, title: e.title, project: e.project, text: e.text || '', tags: e.tags || [], rels: e.out || [],
    refs: (e.out || []).map((r) => r[1]), agent: e.agent || '—', ts: e.ts || '', memory: 'local', state: e.state || 'active',
    why: e.why || null, source: e.source ? e.source + (e.line ? ':' + e.line : '') : '—', readable: !!e.readable, recall: e.recall ?? null,
    capture: e.capture || null, validFrom: e.validFrom || null, validUntil: e.validUntil || null, fact: e.fact || null, replaces: e.replaces || null,
    cited: e.cited || 0, contested: !!e.contested, basis: e.basis || null, authority: e.authority || null, scope: e.scope || null,
    derivedFrom: e.derivedFrom || [], key: e.key || null,
  }));
  entries.sort((a, b) => b.ts.localeCompare(a.ts));
  entryIndex = new Map(entries.map((e) => [e.id, e]));
  incomingIndex = new Map();
  for (const e of entries) for (const [kind, id] of e.rels) {
    if (!incomingIndex.has(id)) incomingIndex.set(id, []);
    incomingIndex.get(id).push({ kind, id: e.id });
  }
  for (const e of entries) e._s = (e.id + ' ' + e.title + ' ' + e.text + ' ' + e.tags.join(' ') + ' ' + e.agent + ' ' + e.project + ' ' + (types[e.type] || '')).toLowerCase();
  // tempo: messages and captures arrive deferred (`d.parts`, loadParts()) —
  // if they are in the answer after all (older server), they count as before.
  if (!d.parts?.inbox) setMessages(d.inbox?.messages || []);
  if (!d.parts?.raw) setCaptures(d.raw?.readable ? d.raw.captures || [] : []);
  // A drawer that was not readable makes the coverage unclear — then
  // every view shows the mockup's note, this time with the real reason.
  state.missing = d.state !== 'ok' || entries.some((e) => !e.readable);
  if (state.inboxTo === null) state.inboxTo = d.inbox?.human || d.inbox?.me || 'all';
  if (!serverWrites) state.readonly = true;
  const ps = $('#projectScope');
  const known = new Set([...ps.options].map((o) => o.value));
  for (const p of d.projects || []) if (!known.has(p.name)) ps.insertAdjacentHTML('beforeend', `<option value="${esc(p.name)}">${esc(p.name)}</option>`);
  const g = d.meta?.git || {};
  const c = d.meta?.code || {};
  // tempo: /dashboard.json comes from the server's cache and says itself
  // whether it is fresh. Not fresh is never shown as fresh.
  const ca = d.cache || null;
  const caText = !ca || ca.fresh ? ''
    : ca.refreshing ? ` · refreshing (built ${whenTime(ca.built_at)})`
      : ` · not fresh: ${ca.reason || 'unknown'}`;
  $('#stateMark').innerHTML = `<span class="dot"></span> State ${esc(whenTime(d.at))}${esc(caText)}`;
  $('#stateMark').className = 'badge ' + (d.state === 'ok' && (!ca || ca.fresh) ? 'good' : 'warn');
  $('#versionMark').textContent = `${g.branch || '—'} ${g.head || ''} · cheap-mem ${c.version || '—'}${c.headAtStart ? ' · process ' + c.headAtStart : ''}${c.stale ? ' · process stale' : ''}`;
  $('#liveMark').textContent = '● LIVE · ' + (d.meta?.title || 'cheap-mem');
  $('#dataMark').textContent = serverWrites ? 'LIVE DATA' : 'LIVE · READ ONLY';
  $('#footLeft').textContent = `cheap-mem · ${entriesTotalText()} · state ${whenTime(d.at)} · memory ${g.head || '—'}.`;
}
// --- tempo: deferred parts ---------------------------------------------------
// What the start page does not need (messages, captures) the page fetches
// after the first draw through /dashboard/part.json. Until it is there the
// tab says "loading" — an empty list would be a false statement.
const partState = {}; // name -> 'loading' | 'ok' | 'error'
const partReason = {};
const partContentKey = {}; // name -> last JSON.stringify(b.data) (no-jump)
function setMessages(list) { messages = (list || []).map((m) => ({ ...m, id: m.name, title: m.subject })); }
function setCaptures(list) { rawSamples = list || []; }
const PART_TAB = { inbox: 'inbox', raw: 'raw' };
// no-jump point 3: render() only when a part turns 'ok' for the FIRST
// time and its tab is currently open (before that it said "loading" —
// that MUST be shown). Every later refetch of the same part is a quiet
// background sync like loadData() — a marker on a real change, never its
// own render().
async function loadParts() {
  const parts = Object.keys(D?.parts || {});
  const firstOk = [];
  let otherChanged = false;
  await Promise.all(parts.map(async (name) => {
    const wasOk = partState[name] === 'ok';
    if (!wasOk) partState[name] = 'loading';
    try {
      // Literal, not a computed path — the closed route list (test/dashboard-page.test.mjs) sees literal ones only.
      const r = await fetch('/dashboard/part.json?part=' + encodeURIComponent(name), { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('answer ' + r.status);
      const b = await r.json();
      if (b.state !== 'ok' || !Array.isArray(b.data)) throw new Error(b.reason || 'state ' + b.state);
      const key = JSON.stringify(b.data);
      const changed = partContentKey[name] !== undefined && partContentKey[name] !== key;
      partContentKey[name] = key;
      if (name === 'inbox') setMessages(b.data);
      else if (name === 'raw') setCaptures(b.data);
      partState[name] = 'ok';
      partReason[name] = null;
      if (!wasOk) firstOk.push(name);
      else if (changed) otherChanged = true;
    } catch (e) {
      partReason[name] = e?.message || String(e);
      if (partState[name] !== 'ok') partState[name] = 'error';
    }
  }));
  if (firstOk.some((name) => PART_TAB[name] === state.tab)) render();
  else if (otherChanged) showNewDataMark();
}
function partNotice(name, title) {
  if (!D?.parts?.[name] || partState[name] === 'ok') return null;
  if (partState[name] === 'error') return panel(title, note('Not loaded: ' + esc(partReason[name] || 'unknown') + ' — an empty list would be a false statement here.', 'bad') + `<p style="margin-top:12px">${btn('Load again', 'reload', '', 'primary')}</p>`);
  return panel(title, note(`Loading … (${num(D.parts[name].count)} items)`));
}
async function loadData({ quiet = false } = {}) {
  try {
    const r = await fetch('/dashboard.json', { credentials: 'same-origin', cache: 'no-store' });
    // Session expired or ended (another device, a password change): go to
    // the sign-in instead of an error over empty data.
    if (r.status === 401) { location.href = '/login'; return false; }
    if (!r.ok) throw new Error('answer ' + r.status);
    const body = await r.json();
    // no-jump: build the content key BEFORE prepare() (that mutates fields
    // onto `d` itself) and only flag a real change once there is already
    // a baseline to compare against (not on the very first load).
    const newKey = contentKey(body);
    const changed = lastContentKey !== null && newKey !== null && newKey !== lastContentKey;
    if (newKey !== null) lastContentKey = newKey;
    prepare(body);
    loadError = null;
    loadParts();
    // Whether THIS call gets drawn is always the caller's decision (a user
    // action calls render() right after — rahmen/task point 5). A real
    // change here shows the quiet marker — if a render() follows right
    // away (any user action), render() hides it again in the same pass,
    // so it never visibly flickers.
    if (changed) showNewDataMark();
    // tempo: when the answer is not fresh, ask again quietly until it is —
    // soon when the server already rebuilds, otherwise less often (it
    // rebuilds at most every 20 s). At most one refetch waits.
    // no-jump: this refetch no longer draws by itself — it would replace
    // #screen no matter where the human is reading/typing/scrolling.
    // Paused while the tab is not visible (point 4).
    if (D?.cache && !D.cache.fresh && !refetchTimer && !document.hidden) {
      refetchTimer = setTimeout(async () => {
        refetchTimer = 0;
        await loadData({ quiet: true });
      }, TEMPO_TEST_MS ?? (D.cache.refreshing ? 5000 : 20000));
    }
  } catch (e) {
    loadError = e?.message || String(e);
    if (!D) {
      $('#screen').innerHTML = `<div class="screen-enter">${note('The data could not be loaded: ' + esc(loadError) + '. Nothing invented is shown.', 'bad')}${btn('Load again', 'reload', '', 'primary')}</div>`;
      $('#liveMark').textContent = '○ NO CONNECTION';
      return false;
    }
    if (!quiet) toast('Reload failed: ' + loadError);
    return false;
  }
  return true;
}
// no-jump point 4: no quiet refetch while the tab is not visible (nothing
// to gain, only load) — and EXACTLY ONE quiet refetch once it is visible
// again (no render(), marker only on a real change, like any background
// call).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(refetchTimer);
    refetchTimer = 0;
  } else {
    loadData({ quiet: true });
  }
});

// --- Page frame ---------------------------------------------------------------
function route(path) {
  const [a, t] = path.split('/');
  if (!sections[a]) return;
  state.area = a;
  state.tab = sections[a].tabs.some((x) => x[0] === t) ? t : sections[a].tabs[0]?.[0] || '';
  state.page = 1;
  document.body.classList.remove('nav-open');
  $('#mobileMenu').setAttribute('aria-expanded', 'false');
  const hash = '#' + a + (state.tab ? '/' + state.tab : '');
  if (location.hash !== hash) history.pushState({}, '', hash);
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function render() {
  // no-jump point 2: every render() shows the newest D anyway (the
  // background keeps it current) — the marker would be wrong from here
  // on, whether this is a navigation, a user action, or the click on the
  // marker itself.
  hideNewDataMark();
  graphCleanup();
  cancelAnimationFrame(raf);
  $('#crumb').textContent = sections[state.area].name;
  $('#nav').innerHTML = Object.entries(sections)
    .map(
      ([k, v]) =>
        `<button data-route="${k}" class="${state.area === k ? 'active' : ''}" ${state.area === k ? 'aria-current="page"' : ''}>${icon(k)}${v.name}${state.area === k ? '<span class="chev">›</span>' : ''}</button>`,
    )
    .join('');
  if (!D) return;
  const s = sections[state.area];
  let html = '';
  if (state.area === 'home') html = home();
  else {
    html = heading(s.name, pageTitle(), pageDesc());
    html += `<nav class="tabs" aria-label="Sub-views">${s.tabs.map(([k, n]) => `<button data-route="${state.area}/${k}" class="${state.tab === k ? 'active' : ''}" ${state.tab === k ? 'aria-current="page"' : ''}>${n}</button>`).join('')}</nav>`;
    // A renderer that throws (a field missing or renamed) must not leave
    // a silent blank: the sub-view says "unknown" with the reason (house
    // rule "not measurable is not zero", dash-fix4).
    try {
      html += pages[state.tab]();
    } catch (e) {
      html += panel('View cannot be drawn', note('This sub-view could not be drawn: ' + esc(e?.message || String(e)) + '. State: unknown — an empty area would be a false statement here.', 'bad'));
    }
  }
  $('#screen').innerHTML = `<div class="screen-enter">${state.missing ? note('Not every source was readable: ' + esc((D.reasons || []).join(' · ') || entries.filter((e) => !e.readable).length + ' entries without a readable line') + '. Completeness unknown.', 'bad') : ''}${html}</div>`;
  // tempo (2026-09-28): draw the overview FIRST, the 3-D network one frame
  // later. `initGraph()` compiles the shaders (measured in the sibling's
  // Chromium profile: ~4–6 s with software GL under load) — synchronous
  // here, it kept the already finished numbers of the start page invisible
  // that long. `graphRun` drops a deferred build when a newer render came
  // in between (it would otherwise build onto a replaced <canvas>).
  const run = ++graphRun;
  if ($('#brain')) {
    const canvas = $('#brain');
    requestAnimationFrame(() => setTimeout(() => {
      if (run === graphRun && document.contains(canvas)) initGraph();
    }, 0));
  }
  if ($('#exportPreview')) updateExportPreview();
  if ($('#timeResult')) factsAtLoad($('#validDate').value, $('#knownDate').value);
  decoratePage();
}
function pageTitle() {
  return (
    {
      entries: 'Everything that stays.', network: 'Knowledge has connections.', topics: 'The common thread.', facts: 'What holds. And since when.',
      learnings: 'Better from experience.', skills: 'Knowledge that turns into doing.', books: 'Many entries. One context.',
      tasks: 'What still needs someone.', agents: 'Thinking further, together.', inbox: 'Every handover traceable.',
      context: 'Before the next step.', usage: 'What really arrives.', understanding: 'Understanding needs observation.',
      projects: 'A place for every project.', files: 'The sources behind it.', raw: 'Back to the original.', digest: 'From transcript to knowledge.',
      export: 'Your project. To take along.', shards: 'Many parts. One memory.', operations: 'Work that visibly moves forward.',
      doctor: 'Nothing stays invisible.', performance: 'Performance needs evidence.', integrity: 'Trust can be checked.',
      versions: 'Which state is answering?', mcp: 'Capabilities that arrive.', appearance: 'Your workspace.', access: 'Only for you.', system: 'Set deliberately.',
      catalog: 'No function forgotten.', projectstate: 'Aligned with the current state.',
    }[state.tab] || ''
  );
}
function pageDesc() {
  const cli = D?.catalog?.cli;
  return (
    {
      entries: 'All types, sources and states. One click opens the full entry.',
      network: 'Structure, declared relations and storage are three different perspectives.',
      inbox: 'Every recipient\'s messages: read, reply, acknowledge — through the same routes as the command line.',
      context: 'What the hooks really injected last — from the injection journal, no simulation.',
      export: 'Check the scope and understand the dependencies. A package download is not built into the product yet.',
      shards: 'The drawers of this memory: project × type. Counted from the store, not estimated.',
      operations: 'Tasks with a provable end, result and confirmed cancel — child processes of the CLI.',
      understanding: 'Measured habits and job ledgers – no ascribed traits.',
      projectstate: 'Where every view reads from, and which code is answering right now.',
      access: 'Change the password in front of this dashboard, or sign out this device.',
      catalog: cli ? `All ${cli.length} commands from the CLI's own tables, sorted into their work areas.` : 'The CLI tables were not readable — command count unknown.',
      raw: 'Review and delete by period, topic and project — through "mem raw review" and "mem raw delete".',
    }[state.tab] || 'Live from this memory. What is not measurable says unknown.'
  );
}

// --- Overview -----------------------------------------------------------------
function openWork(es) {
  return es.filter((e) => ['duty', 'question'].includes(e.type) && statusOf(e.id) === 'open');
}

// --- Today (N8/N21 parity: one source, three surfaces — src/today.mjs) -------
function todayOperationsPart(notable) {
  if (!notable.length) return '';
  return `<div class="label" style="margin:16px 0 6px">Operations</div>${notable
    .map((f) => `<div class="row"><div><strong>${esc(f.name)}</strong><p>${esc(f.text)}</p>${f.advice ? `<p class="small quiet">${esc(f.advice)}</p>` : ''}</div>${badge(f.level)}</div>`)
    .join('')}`;
}
function todayDecisionsPart(list) {
  if (!list.length) return '';
  return `<div class="label" style="margin:16px 0 6px">Decisions for you</div>${list
    .map((dt) => `<button class="attention" data-entry="${esc(dt.id)}"><span class="sym">↗</span><div><strong>${esc(dt.title)}</strong><p>Duty${dt.due ? ' · due ' + esc(when(dt.due)) : ''}</p></div><span class="arrow">↗</span></button>`)
    .join('')}`;
}
// N9 parity: a candidate is NEVER written here, only shown (the value
// comes from this memory's own timeline facts, src/today.mjs part c —
// never a fabricated question) and rated through POST
// /dashboard/verify-verdict, the same gate as every other write route.
function todayVerifyRow(v, i) {
  const attr = (verdict) => `data-verdict="${esc(verdict)}" data-key="${esc(v.key)}" `
    + `data-project="${esc(v.project || '')}" data-age-days="${v.ageDays != null ? v.ageDays : ''}" `
    + `data-conflict="${v.conflict ? '1' : '0'}"`;
  return `<div class="row today-verify-row" data-verify-row="${i}"><div>`
    + `<strong>${esc(v.key)}</strong>${v.project ? ` <span class="small quiet">(${esc(v.project)})</span>` : ''}`
    + `<p class="detailtext" style="margin:6px 0">${v.value != null ? esc(String(v.value)) : '<span class="quiet">(no current value)</span>'}</p>`
    + `<p class="small quiet">${v.conflict ? 'conflicting versions on record' : `${v.ageDays != null ? num(v.ageDays) + ' day(s) old' : 'stale'}`}${v.source ? ` · <code class="mono">${esc(v.source)}</code>` : ''}</p>`
    + `</div><div class="drawer-actions" data-verify-actions>`
    + `${btn('still current', 'today-verify-verdict', attr('still-current'), 'small ghost')}`
    + `${btn('outdated', 'today-verify-verdict', attr('outdated'), 'small ghost')}`
    + `${btn('can’t tell', 'today-verify-verdict', attr('cannot-tell'), 'small ghost')}`
    + `</div></div>`;
}
function todayVerifyPart(list) {
  if (!list.length) return '';
  return `<div class="label" style="margin:16px 0 6px">To verify</div>${list.map((v, i) => todayVerifyRow(v, i)).join('')}`
    + '<p class="small quiet" style="margin-top:8px">A verdict appends ONE line to a file OUTSIDE this memory — never a change here, never the entry itself.</p>';
}
// Honest "unknown, no source yet" — this house never had a persisted
// weekly review report or an open word-pair-suggestion queue to read
// (see src/today.mjs for why), and an unmeasured state is shown, never
// hidden as if it were calm.
function todayUnknownPart(title, info) {
  return `<div class="label" style="margin:16px 0 6px">${esc(title)}</div><div class="row"><div><p class="small quiet">${esc(info?.reason || 'unknown')}</p></div>${badge('unknown')}</div>`;
}
// N9 parity ("gold nebenbei"/"Rate today"): a REAL retrieval question,
// never written here — only shown (src/goldlog.mjs draws it from the
// injection journal + a real message) — rated through POST
// /dashboard/gold-verdict, the same gate as every other write route.
function todayGoldRow(c, i) {
  // N18 parity: a `kind:'gap'` row (src/gap.mjs — a closed knowledge
  // gap) has its own source shape (`gap-closed:<session>:<ts>`), so the
  // outcome label is read from `kind` first rather than guessing at a
  // `raw-capture:<outcome>:...` split that does not apply to it.
  const outcome = c.kind === 'gap' ? 'gap' : (c.source?.split(':')[1] || 'unknown');
  const canHitMiss = (c.expected || []).length > 0;
  const attr = (verdict) => `data-verdict="${esc(verdict)}" data-id="${esc(c.id || '')}" `
    + `data-occasion="${esc(c.occasion)}" data-source="${esc(c.source)}" `
    + `data-expected="${esc(JSON.stringify(verdict === 'empty-correct' ? [] : (c.expected || [])))}"`;
  return `<div class="row today-gold-row" data-gold-row="${i}"><div>`
    + `<span class="small quiet">${esc(outcome)} · ${esc(whenTime(c.ts))}</span>`
    + `<p class="detailtext" style="margin:6px 0">${c.question ? esc(c.question) : '<span class="quiet">(no question text known)</span>'}</p>`
    + `${c.expected?.length ? `<p class="small mono quiet">expected: ${c.expected.map(esc).join(', ')}</p>` : ''}`
    + `</div><div class="drawer-actions" data-gold-actions>`
    + `${btn('correct', 'today-gold-verdict', attr('correct') + (canHitMiss ? '' : ' disabled'), 'small ghost')}`
    + `${btn('wrong', 'today-gold-verdict', attr('wrong') + (canHitMiss ? '' : ' disabled'), 'small ghost')}`
    + `${btn('should be empty', 'today-gold-verdict', attr('empty-correct'), 'small ghost')}`
    + `</div></div>`;
}
function todayGoldPart(gold) {
  const list = gold?.candidates || [];
  if (!gold?.drawn?.readable && !list.length) {
    return `<div class="label" style="margin:16px 0 6px">Rate today</div>`
      + note(esc(gold?.drawn?.reason || 'not measured: no injection journal'), 'warn');
  }
  if (!list.length) return '';
  const r = gold?.rated || { total: 0, thisWeek: 0 };
  return `<div class="label" style="margin:16px 0 6px">Rate today</div>`
    + `<p class="small quiet">rated: ${num(r.total)} total, ${num(r.thisWeek)} this week</p>`
    + list.map((c, i) => todayGoldRow(c, i)).join('')
    + '<p class="small quiet" style="margin-top:8px">A verdict appends ONE line to a file OUTSIDE this memory — never a change here, never the question text.</p>';
}
function todayCard() {
  const t = D.today;
  if (!t) return '';
  const ops = t.operations?.notable || [];
  const decisions = t.decisions?.list || [];
  const verify = t.verify?.list || [];
  const gold = t.gold?.candidates || [];
  const c = t.counts || {};
  const anyUnknown = c.decisions === null || c.operations === null || c.verify === null || c.goldQuestions === null;
  const nothingPressing = !anyUnknown && !ops.length && !decisions.length && !verify.length && !gold.length;
  const unknownNote = [['decisions', 'Decisions'], ['operations', 'Operations'], ['verify', 'Verify'], ['goldQuestions', 'Gold questions']]
    .filter(([k]) => c[k] === null).map(([, n]) => n);
  const body = (t.line ? `<p class="small mono" data-today-line>${esc(t.line)}</p>` : '')
    + (unknownNote.length ? `<p class="small quiet">unknown: ${unknownNote.map(esc).join(', ')}</p>` : '')
    + todayUnknownPart('Login', t.login)
    + (nothingPressing
    ? empty('Nothing pressing today — operations calm, no decisions open, nothing uncertain to verify, no gold questions.')
    : todayOperationsPart(ops) + todayDecisionsPart(decisions) + todayVerifyPart(verify) + todayGoldPart(t.gold))
    + todayUnknownPart('Review suggestions', t.review) + todayUnknownPart('Word-pair suggestions', t.wordPairs);
  return `<div class="today-card" style="margin-bottom:22px">${panel('Today', body, 'Operations, decisions, facts to verify and gold questions — the same source as `mem today`.')}</div>`;
}

function home() {
  const es = scoped(),
    todo = openWork(es),
    skills = es.filter((e) => e.type === 'skill'),
    readable = es.filter((e) => e.readable).length;
  const coverage = state.missing ? 'Unclear' : !es.length ? 'Empty' : readable === es.length ? 'Complete' : 'Partial';
  return (
    heading(
      'Your memory, in context',
      'Knowledge stays.<br><span class="hero-word">Connections grow.</span>',
      'One place for memories, decisions and the people and agents who work with them.',
      `<div class="hero-actions">${btn('Drawers in the network ↗', 'show-shards', '', 'ghost')}${btn('Project package ↗', 'goto-export', '', 'ghost')}</div>`,
    ) +
    todayCard() +
    metrics([
      ['Knowledge in view', num(es.length), 'entries in the chosen scope'],
      ['Open work', num(todo.length), 'duties & unanswered questions'],
      ['Skills & procedures', num(skills.length + es.filter((e) => e.type === 'procedure').length), 'with origin and validity'],
      ['Data coverage', coverage, es.length ? `${num(readable)} of ${num(es.length)} entries readable` : 'no entry written yet'],
    ]) +
    `<div class="home-layout"><div class="graph-block">${brainBlock()}</div><article class="panel pad"><div class="panelhead"><h2>Your next look</h2><span class="badge warn">${num(todo.length)} open</span></div>${
      todo
        .slice(0, 3)
        .map(
          (e) =>
            `<button class="attention" data-entry="${esc(e.id)}"><span class="sym">${e.type === 'question' ? '?' : '↗'}</span><div><strong>${esc(e.title)}</strong><p>${esc(e.text.slice(0, 110))}</p><span class="label">${esc(e.project)}${D._dutyWho.get(e.id) ? ' · ' + esc(D._dutyWho.get(e.id)) : ''}</span></div><span class="arrow">↗</span></button>`,
        )
        .join('') || empty(es.length ? 'No duty and no question is open right now.' : 'Nothing is open — this memory holds no entry yet. <code class="mono">mem log duty "…"</code> records the first duty.')
    }<div class="smallstats"><span>Originals stay intact</span><span class="green">Append-only</span></div></article></div><div class="sectionline"><h2>Recently connected</h2>${link('See all', 'knowledge/entries')}</div><div class="grid two">${panel('Memories with origin', entryRows(es.slice(0, 3), 'Your first entries will appear here. <code class="mono">mem log learning "…"</code> writes one.'))}${panel(
      'From occasion to memory',
      `<div class="flow"><span>Question</span><i>→</i><span>Fitting context</span><i>→</i><span>Evidence</span></div><p class="muted small">See what an agent last really received before a change – and what can be observed from it.</p><div style="margin-top:22px">${btn('Explore agent context ↗', 'goto-context', '', 'ghost')}</div>`,
      D.recall?.measurable ? `${num(D.usage?.shown)} injections in the journal since ${when(D.recall.since)}` : 'Injection journal not measurable — nothing injected on this machine yet',
    )}</div>${boardPanel()}`
  );
}
// `mem board`, folded into the overview (owner decision 2026-09-28): the
// same tiles, the same four states, worst first. The CLI stays.
function boardPanel() {
  const tiles = D.system || [];
  const notCalm = tiles.filter((t) => t.state !== 'calm').length;
  return `<div class="sectionline"><h2>System state</h2>${link('Diagnosis', 'ops/doctor')}</div><div class="grid three">${tiles
    .map((t) => panel(esc(t.title), `${badge(t.state === 'calm' ? 'calm' : t.state === 'watch' ? 'watch' : t.state === 'alarm' ? 'alarm' : 'unknown', t.word || boardWord[t.state] || t.state)}<p class="small muted" style="margin-top:12px">${esc(t.line)}</p>${t.detail ? `<p class="small quiet" style="margin-top:6px">${esc(t.detail)}</p>` : ''}`))
    .join('') || empty('No tile was measured.')}</div><p class="small quiet" style="margin-top:12px">${num(tiles.length)} tiles · ${num(notCalm)} not in order — the same board as <code class="mono">mem board</code>, worst first.</p>`;
}

// --- Knowledge ----------------------------------------------------------------
function filtered() {
  const q = state.query.toLocaleLowerCase();
  const es = scoped().filter(
    (e) => (state.type === 'all' || e.type === state.type) && (state.status === 'all' || statusOf(e.id) === state.status) && (!q || e._s.includes(q)),
  );
  return es.sort((a, b) => (state.sort === 'title' ? a.title.localeCompare(b.title, 'en') : state.sort === 'old' ? a.ts.localeCompare(b.ts) : b.ts.localeCompare(a.ts)));
}
function projectMatrix() {
  // The drawer pairs from net.mjs, condensed to projects: row = source,
  // column = target. Only SHOW what net.pairs counts — nothing recomputed.
  const pairs = D.net?.pairs || [];
  const count = new Map();
  for (const p of pairs) {
    const a = p.from.split('/')[0], b = p.to.split('/')[0];
    count.set(a + '>' + b, (count.get(a + '>' + b) || 0) + p.count);
  }
  const names = (D.projects || []).map((p) => p.name).filter((n) => state.project === 'all' || n === state.project).slice(0, 6);
  if (!names.length) return empty('No project holds an entry yet — the matrix appears with the first one.');
  return `<div class="matrix" style="grid-template-columns:repeat(${names.length + 1},1fr)"><div class="quiet">from / to</div>${names.map((n) => `<div class="small">${esc(n)}</div>`).join('')}${names
    .map((n) => `<div class="small">${esc(n)}</div>${names.map((m) => { const c = count.get(n + '>' + m) || 0; return `<div class="${c ? 'heat' : ''}">${c || '·'}</div>`; }).join('')}`)
    .join('')}</div><p class="small quiet" style="margin-top:14px">Row = source · column = target. ${num(D.net?.links)} declared links in ${num(pairs.length)} drawer pairs (net.mjs)${D.net?.dangling ? ` · ${num(D.net.dangling)} into the void` : ''}.</p>`;
}
function drawerMatrix() {
  // The second matrix of the old net view: drawers per project and type.
  const ks = D.net?.boxes || [];
  const projects = [...new Set(ks.map((k) => k.project))].filter((p) => state.project === 'all' || p === state.project);
  const drawers = Object.keys(types).filter((t) => ks.some((k) => k.drawer === t));
  if (!projects.length) return empty('No drawer holds an entry yet.');
  const n = new Map(ks.map((k) => [k.project + '/' + k.drawer, k.entries]));
  return `<div class="tablewrap"><table class="table drawer-matrix"><thead><tr><th>Project / type</th>${drawers.map((f) => `<th>${esc(types[f])}</th>`).join('')}</tr></thead><tbody>${projects
    .map((p) => `<tr><td>${esc(p)}</td>${drawers.map((f) => { const c = n.get(p + '/' + f); return `<td>${c ? `<button class="textlink" data-action="shard-detail" data-value="${esc(p + '/' + f)}">${num(c)}</button>` : '<span class="quiet">·</span>'}</td>`; }).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}
// The layers of the old links view (net.layers): what points at others
// stands on top; cycles and self-references are REPORTED, not cut; a
// drawer without any declared link is unconnected, not "on top".
function netLayers() {
  const l = D.net?.layers || {};
  const byName = new Map((D.net?.boxes || []).map((b) => [b.name, b]));
  const rows = (l.assignment || []).map(({ name, level }) => `<div class="row"><span class="mono small">${'&nbsp;&nbsp;'.repeat(level)}${esc(name)}</span><span class="small quiet">level ${num(level)} · ${num(byName.get(name)?.entries)} entries</span></div>`).join('');
  return `${rows || empty('No layered drawer — all unconnected or in a cycle.')}${(l.unlinked || []).length ? `<div class="row"><span class="small">Without any declared link</span><span class="small">${(l.unlinked || []).map(esc).join(', ')}</span></div>` : ''}${(l.in_cycle || []).length ? `<div class="row"><span class="small">In a cycle (not layered, not cut)</span>${badge('warning', (l.in_cycle || []).join(', '))}</div>` : ''}${(l.self_reference || []).length ? `<div class="row"><span class="small">Self-reference</span><span class="small">${(l.self_reference || []).map(esc).join(', ')}</span></div>` : ''}`;
}
// knowledge/facts: the bitemporal comparison runs on the SERVER
// (/dashboard/facts-at.json -> factsAt()), not as a client filter over
// the loaded entries: a naive "validFrom <= day" filter would show ALL
// not-yet-expired versions of a fact with several versions at once —
// exactly the "two truths" class this house avoids. The server resolves
// per key only the YOUNGEST version valid on that day.
let factsAtRun = 0;
async function factsAtLoad(valid, known) {
  const mine = ++factsAtRun;
  if (!$('#timeResult')) return;
  $('#timeResult').innerHTML = '<p class="small quiet">Comparing knowledge states …</p>';
  let b = null;
  let ok = false;
  try {
    const r = await fetch(`/dashboard/facts-at.json?known=${encodeURIComponent(known)}&valid=${encodeURIComponent(valid)}`, { credentials: 'same-origin', cache: 'no-store' });
    ok = r.ok;
    b = await r.json().catch(() => null);
  } catch { /* b stays null — shown below as "not determinable" */ }
  if (mine !== factsAtRun || !$('#timeResult')) return; // a newer input overtook this answer
  $('#timeResult').innerHTML = factsAtHtml(b, ok);
}
function factsAtHtml(b, ok) {
  if (!ok || !b || b.state !== 'ok') return empty(`Knowledge state not determinable: ${esc(b?.reason || 'the server\'s answer was unreadable')}.`);
  if (!b.factsTotal) return empty('No fact has been recorded yet. <code class="mono">mem log timeline --key role --value … --valid_from …</code> starts one.');
  return `<div class="grid two"><div class="panel pad"><div class="label">Held on ${esc(b.valid)}, known on ${esc(b.known)}</div><h2 style="margin-top:10px">${num(b.holds.length)} facts</h2><p class="small muted" style="margin-top:8px">${num(b.writtenByThen)} of ${num(b.factsTotal)} timeline lines were written down by then${b.withoutOwnValidity ? ` · ${num(b.withoutOwnValidity)} without their own valid_from (hold from the day they were written)` : ''}.</p></div><div class="panel pad"><div class="label">Evidence</div><div style="margin-top:13px">${b.holds
    .slice(0, 5)
    .map((e) => `<p style="margin:6px 0">${e.id && byId(e.id) ? open(e.id, e.title, 'textlink') : esc(e.title)}</p>`)
    .join('') || '<p class="small quiet">None.</p>'}</div>${limitNote(Math.min(5, b.holds.length), b.holds.length)}</div></div>`;
}
// ops/integrity: the log's own integrity scan (src/integrity.mjs) — the
// same reader `mem doctor` uses for its integrity finding — as a table
// instead of one summarised line.
function integrityPanel() {
  const k = D.integrity || {};
  if (!k.readable) return panel('Integrity scan', empty(`Not measurable: ${esc(k.reason || 'unknown')}.`));
  const row = (name, n, text) => `<div class="row"><div><strong>${esc(name)}</strong><p>${esc(text)}</p></div>${badge(n ? 'warning' : 'good', n ? num(n) : 'none')}</div>`;
  return panel(
    'Integrity scan · the same reader as mem doctor',
    `${row('Broken lines', k.broken, 'lines that do not parse — counted, never skipped silently')}${row('Bad timestamps', k.badTimestamp, 'missing, unreadable or in the future')}${row('Duplicate ids', k.duplicateIds, 'one id in more than one line')}${row('Replacements into the void', k.replacement?.missing, 'a correction pointing at an id that is not there')}${row('Replacement cycles', k.replacement?.cycles, 'A replaces B replaces A')}<div class="row"><div><strong>Hash chain</strong><p>${num(k.chain?.filesChecked)} files checked · ${num(k.chain?.sealsFound)} seals${k.chain?.tampered ? ` · ${num(k.chain.tampered)} tampered` : ''}</p></div>${badge(k.chain?.state === 'ok' ? 'good' : k.chain?.state === 'error' ? 'error' : 'unknown', k.chain?.state === 'unknown' ? 'no seal written' : k.chain?.state)}</div>${note('"No seal written" is not "verified": sealing is off unless chainSealCadence is set, and an unsealed log cannot be checked for later edits.')}`,
    `${num(k.lines)} lines · ${num(k.entries)} entries`,
  );
}
const pages = {
  entries: () => {
    const es = filtered(),
      n = 8,
      pg = Math.min(state.page, Math.max(1, Math.ceil(es.length / n)));
    state.page = pg;
    return `<div class="toolbar"><input class="field searchfield" id="entrySearch" placeholder="Content, ID, agent or tag …" value="${esc(state.query)}" aria-label="Search entries"><select class="field" id="typeFilter" aria-label="Entry type"><option value="all">All types</option>${Object.entries(types)
      .map(([k, n]) => `<option value="${k}" ${state.type === k ? 'selected' : ''}>${n}</option>`)
      .join('')}</select><select class="field" id="statusFilter" aria-label="Entry state">${['all', 'active', 'open', 'superseded', 'done', 'discarded', 'answered']
      .map((x) => `<option value="${x}" ${state.status === x ? 'selected' : ''}>${x === 'all' ? 'All states' : x}</option>`)
      .join('')}</select><select class="field" id="sortFilter" aria-label="Sort">${[['new', 'Newest first'], ['old', 'Oldest first'], ['title', 'Title A–Z']]
      .map(([k, n]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${n}</option>`)
      .join('')}</select>${btn('Reset filters', 'reset-filters', '', 'ghost')}</div><article class="panel"><div class="tablewrap"><table class="table"><thead><tr><th>Entry / origin</th><th>Type</th><th>Project</th><th>State</th><th>Date</th></tr></thead><tbody>${es
      .slice((pg - 1) * n, pg * n)
      .map(
        (e) =>
          `<tr><td>${open(e.id, e.title, 'open-entry')}<span class="sub">${esc(e.id)} · ${esc(e.agent)} · ${esc(e.memory)} / ${esc(drawerOf(e))}</span></td><td><span class="type">${esc(types[e.type])}</span></td><td>${esc(e.project)}</td><td>${badge(statusOf(e.id))}</td><td class="quiet small">${when(e.ts)}</td></tr>`,
      )
      .join('')}</tbody></table>${!es.length ? empty(entries.length ? undefined : 'This memory holds no entry yet. <code class="mono">mem log learning "…"</code> writes the first one; it appears here on the next load.') : ''}</div><div class="tablefoot"><span>${num(es.length)} hits · page ${pg} / ${Math.max(1, Math.ceil(es.length / n))}</span><div>${btn('←', 'prev', pg === 1 ? 'disabled' : '', 'small ghost')} ${btn('→', 'next', pg >= Math.ceil(es.length / n) ? 'disabled' : '', 'small ghost')}</div></div></article>`;
  },
  network: () => {
    const focus = graphListEntries();
    // The old button row here duplicated #graphModeSelect inside the atlas
    // panel (same modes, incl. the "Further modes" optgroup) and the ↺
    // reset control in the zoom toolbar — removed 2026-09-29, select stays
    // the single control (see brainBlock()).
    return `${brainBlock(true)}<div class="grid two">${panel(
      'Open nodes directly',
      '<div class="graph-entry-list">' + entryRows(focus.slice(0, 80), 'Your first entries will appear here.') + '</div>' + limitNote(Math.min(80, focus.length), focus.length, 'knowledge/entries'),
      'An alternative to spatial navigation',
    )}${panel('Project matrix', projectMatrix(), 'Stored links between the projects, from the drawer pairs')}</div><div class="grid two" style="margin-top:18px">${panel('Drawers · project × type', drawerMatrix(), `${num(D.net?.boxes?.length)} drawers · one click shows their entries (the old net view's overview)`)}${panel('Layers', netLayers(), `depth ${num(D.net?.layers?.depth)} · what points at others stands on top (net.layers)`)}</div><div style="margin-top:18px">${panel('Hand-drawn links', (D.links || []).slice(0, 40).map((l) => `<div class="row"><div><strong>${esc(edgeLabels[l.kind] || l.kind)}</strong><p>${byId(l.from) ? open(l.from, byId(l.from).title, 'textlink') : esc(l.from)} → ${byId(l.to) ? open(l.to, byId(l.to).title, 'textlink') : esc(l.to)}${l.why ? ' · ' + esc(l.why) : ''}</p></div>${l.fromKnown && l.toKnown ? badge('present', 'both ends known') : badge('missing', 'dangling')}</div>`).join('') || empty('No link has been drawn by hand yet. <code class="mono">mem log link --from … --to … --kind causes</code> draws one.'), 'Typed relations from the links drawer, with their reason')}</div>`;
  },
  topics: () => {
    const counts = new Map();
    for (const e of scoped()) for (const t of e.tags) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'));
    const shown = tags.slice(0, 24);
    const tp = D.topics || {};
    return `<div class="grid three">${shown
      .map(([t, c]) =>
        panel(
          esc(t),
          `<div class="number">${num(c)}</div><p class="small muted" style="margin:8px 0 18px">entries from ${new Set(scoped().filter((e) => e.tags.includes(t)).map((e) => e.type)).size} types</p>${btn('Open thread ↗', 'topic', `data-value="${esc(t)}"`, 'ghost')}`,
        ),
      )
      .join('') || empty('No entry carries a tag yet — topics appear with the first tagged entry.')}</div>${tags.length > shown.length ? `<p class="small quiet" style="margin-top:14px">The ${shown.length} most frequent of ${num(tags.length)} topics. Every topic is reachable through the search.</p>` : ''}<div class="grid two" style="margin-top:18px">${panel('Topic tree', (tp.areas || []).map((a) => `<div class="row"><div><strong>${esc(a.area)}</strong><p>${(a.children || []).slice(0, 8).map(esc).join(', ')}${(a.children || []).length > 8 ? ' …' : ''}</p></div><span class="small">${num(a.count)} · ${a.orphan ? badge('warning', 'one child') : badge('good', num((a.children || []).length) + ' children')}</span></div>`).join('') || empty('No topic yet.'), 'Grouped by area from the topic names alone (mem topics)')}${panel('Topic quality', tp.quality ? `<div class="row"><span class="small">Topics / entries with a topic</span><span class="small">${num(tp.quality.topics)} / ${num(tp.quality.entriesWithTopic)}</span></div><div class="row"><span class="small">Entries per topic</span><span class="small">${tp.quality.topics ? Number(tp.quality.entriesPerTopic).toFixed(2) : '—'}</span></div><div class="row"><span class="small">Single-entry topics</span><span class="small">${num(tp.quality.singleTopics)}${tp.quality.topics ? ` (${Math.round(tp.quality.singleShare * 100)} %)` : ''}</span></div><div class="row"><span class="small">Areas / orphan areas / malformed</span><span class="small">${num(tp.quality.areas)} / ${num(tp.quality.orphanAreas)} / ${num(tp.quality.malformed)}</span></div><p class="small quiet" style="margin-top:10px">A topic with exactly one entry is not a topic but a second title field — the doctor's topic-quality finding reads the same numbers.</p>` : badge('unknown'), 'The same measure as mem doctor')}</div>${note('Topics here are the entries\' tags and topic names. Merging topics needs its own traceable step ("mem topic-merge").')}`;
  },
  facts: () => {
    const today = new Date().toISOString().slice(0, 10);
    return `${panel(
      'Two times, two questions',
      `<div class="formgrid"><label class="formfield">Valid on<input class="field" id="validDate" type="date" value="${today}"></label><label class="formfield">Known on<input class="field" id="knownDate" type="date" value="${today}"></label></div>${btn('Compare knowledge states', 'time-compare', '', 'primary')}<div id="timeResult" style="margin-top:20px"><p class="small quiet">Comparing knowledge states …</p></div>`,
      'Time travel over the bitemporal entries of the timeline drawer (valid_from, known since written)',
    )}${note('Historical reconstruction needs fitting validity and knowledge times. Missing values are not invented: without valid_from a fact holds from the day it was written down.')}<div style="margin-top:18px">${panel(
      'Stable facts',
      (D.facts || []).map((f) => `<div class="row"><div><strong class="mono">${esc(f.key)}</strong><p>${esc(String(f.value))} · holds since ${esc(f.validFrom || '—')}${f.ageDays != null ? ` · ${f.ageDays} days` : ''}</p></div>${f.conflict ? badge('error', 'conflict') : f.stale ? badge('stale') : badge('active')}</div>`).join('') || empty('No living fact yet. <code class="mono">mem log timeline --key role --value … --valid_from …</code> starts one.'),
      'Current, contradiction-free timeline facts (the same core as "mem core")',
    )}</div>`;
  },
  learnings: () => {
    const es = scoped().filter((e) => e.type === 'learning');
    const ex = new Map((D.experiences || []).map((x) => [x.id, x]));
    const rows = es.slice(0, 40).map((e) => {
      const x = ex.get(e.id);
      return `<div class="row"><div class="row-main"><span class="entry-icon">${esc(types[e.type]?.[0])}</span><div>${open(e.id, e.title, 'open-entry textlink')}<p>${esc(e.project)} · ${esc(e.agent)}${x ? ` · cited ${num(x.cited)}×${(x.backedBy || []).length ? ` · backed by ${num(x.backedBy.length)}` : ''}` : ''}</p></div></div>${x?.contested ? badge('warning', 'contested') : badge(statusOf(e.id))}</div>`;
    }).join('');
    return panel('Learnings with an evidence trail', (rows || empty('No learning recorded yet. <code class="mono">mem log learning "…"</code> writes one.')) + limitNote(Math.min(40, es.length), es.length, 'knowledge/entries'), 'References show support. The count alone proves no independent sources.');
  },
  skills: () =>
    `<div class="grid two">${scoped()
      .filter((e) => ['skill', 'procedure'].includes(e.type))
      .map((e) =>
        panel(
          esc(e.title),
          `<span class="badge">${esc(types[e.type])}</span><p class="muted" style="margin:16px 0">${esc(e.text)}</p><div class="row"><span class="small quiet">Author</span><span class="small">${esc(e.agent)}</span></div><div class="row"><span class="small quiet">Provision</span><span class="small">${e.type === 'skill' ? 'In context · through recall' : 'Procedure (issued by a human)'}</span></div><div class="row"><span class="small quiet">Injected</span><span class="small">${e.recall ? (e.recall.sessions ? `in ${num(e.recall.sessions)} sessions` : 'never') : 'not measurable'}</span></div><div style="margin-top:17px">${open(e.id, 'Content & history ↗')}</div>`,
        ),
      )
      .join('') || empty('No skill and no procedure recorded yet. A skill is acquired (<code class="mono">mem log skill …</code>), a procedure is issued by a human (<code class="mono">mem log procedure …</code>).')}</div>${note('An injected skill does not count as applied. The usage view keeps delivery and observed effect apart.')}`,
  books: () =>
    panel('Books', notAvailable('books') + note('The originals stay where they are either way: every entry is reachable in the entries list, grouped by topic and project.'), 'A second condensation level over many entries'),

  // --- Work & agents ----------------------------------------------------------
  tasks: () => {
    const es = scoped().filter((e) => ['duty', 'question'].includes(e.type));
    const openOnes = es.filter((e) => statusOf(e.id) === 'open'), closed = es.filter((e) => statusOf(e.id) !== 'open');
    const row = (e) =>
      `<div class="row"><div><div class="small quiet">${esc(types[e.type])} · ${esc(e.project)}</div><h3 style="margin:6px 0">${esc(e.title)}</h3><p>${e.type === 'duty' ? 'Owed by: ' + esc(D._dutyWho.get(e.id) || (statusOf(e.id) === 'open' ? 'not named' : '—')) : 'Link an answer through a concrete entry'}</p></div><div>${badge(statusOf(e.id))}<div style="margin-top:8px">${open(e.id, 'Open ↗')}</div></div></div>`;
    return panel('Open and finished work', (openOnes.map(row).join('') || empty(es.length ? 'Nothing open.' : 'No duty and no question recorded yet.')) + (closed.length ? `<details class="accordion"><summary>${num(closed.length)} finished</summary>${closed.slice(0, 60).map(row).join('')}${limitNote(Math.min(60, closed.length), closed.length, 'knowledge/entries')}</details>` : ''), `${num(openOnes.length)} open · decided by memory.openDuties and question.open`);
  },
  agents: () => {
    const as = D.agents || [];
    const bell = D.bell || {};
    const tray = D.humanTray || {};
    return `<div class="grid three">${as
      .map((a) => {
        const es = scoped().filter((e) => e.agent === a.name);
        const p = a.pause || {};
        const pause = p.state === 'paused' ? `until ${esc(p.until || '—')}${p.why ? ' · ' + esc(p.why) : ''}` : p.state === 'expired' ? 'expired' : p.state === 'unknown' ? 'unknown' : 'none';
        const act = a.activity || {};
        return panel(
          esc(a.name),
          `<div class="row-main" style="margin-bottom:22px"><div class="avatar">${esc(a.name.split(/[-_: ]/).map((x) => x[0] || '').join('').slice(0, 2).toUpperCase())}</div><div><strong>${a.name.startsWith('human') ? 'Human' : a.registered ? 'Agent' : 'Unregistered writer'}</strong><p class="small quiet">${esc(a.role || 'no role recorded')}${a.model ? ' · ' + esc(a.model) : ''}</p></div></div><div class="number">${num(a.count ?? 0)}</div><p class="small muted">entries in total${state.project !== 'all' ? ` · ${num(es.length)} in the chosen project` : ''}</p><div class="stats-list"><div class="row"><span>Registration</span>${a.registered ? badge('present') : badge('missing', 'no folder')}</div><div class="row"><span>Alive (two sources)</span>${badge(act.state || 'unknown')}</div><div class="row"><span>Heartbeat / activity</span><span class="small">${act.heartbeat?.ageMin != null ? age(act.heartbeat.ageMin) : 'never'} / ${act.content?.ageMin != null ? age(act.content.ageMin) : 'never'}</span></div><div class="row"><span>Pause (silent_until)</span><span class="small">${pause}</span></div><div class="row"><span>Locally startable</span><span class="small">${a.startable ? (a.startable.local ? 'yes' : 'no') : 'unknown'}</span></div><div class="row"><span>Inbox bell</span>${badge(a.channel?.state || 'unknown')}</div><div class="row"><span>Last entry</span><span>${a.last ? when(a.last) : '—'}</span></div></div>${btn('Open contributions', 'agent-entries', `data-value="${esc(a.name)}"`, 'ghost')}`,
          a.channel?.reason ? esc(a.channel.reason) : '',
        );
      })
      .join('') || empty('No agent registered and none seen in the log. <code class="mono">mem agent create &lt;name&gt;</code> registers one.')}</div>${panel(
      'Reachability needs independent sources',
      `<div class="tablewrap"><table class="table"><thead><tr><th>Signal</th><th>Source</th><th>Here</th></tr></thead><tbody><tr><td>Own heartbeat</td><td>heartbeat.jsonl (mem heartbeat)</td><td>per agent, see the cards</td></tr><tr><td>Observed activity</td><td>the drawers and the inbox</td><td>per agent, see the cards</td></tr><tr><td>Deliberate pause</td><td>silent_until in AGENT.yaml</td><td>${num(as.filter((a) => a.pause?.state === 'paused').length)} paused</td></tr><tr><td>Locally startable</td><td>agents/&lt;name&gt;/PROMPT.md or START.md</td><td>${num(as.filter((a) => a.startable?.local).length)} of ${num(as.length)}</td></tr><tr><td>Digest bell</td><td>.mem/digest-bell.json</td><td>${bell.checkable ? (bell.rung ? 'rung · ' + esc(whenTime(bell.last)) : 'not rung') : badge('unknown')}</td></tr><tr><td>The human's tray (show only)</td><td>inbox/ addressed to the human participant</td><td>${tray.checkable === false ? badge('unknown', esc(tray.reason || 'unknown')) : `${num(tray.count)} open${tray.count ? ' · oldest ' + age(tray.oldestMin) : ''}`}</td></tr></tbody></table></div>${note('Two confirming sources: alive. One source: unknown. No observable signal: not seen. An announced pause is not an outage. The bell only reads ok once a message was actually answered.')}`,
    )}`;
  },
  inbox: () => partNotice('inbox', 'Inbox') ?? inboxPage(),
  context: () => contextPage(),
  usage: () => usagePage(),
  understanding: () => {
    const u = D.user || {};
    const l = D.ledger || {};
    return `<div class="grid two">${panel(
      'User habits with evidence',
      `${u.readable ? `<span class="badge">${num(u.capturesReadable)} readable captures · ${num(u.capturesUnreadable)} not readable</span>` : badge('unknown')}${(u.observations || []).map((b) => `<div class="row"><span>${esc(b.title)}</span>${badge(b.state === 'measured' ? 'measured' : b.state === 'too_little_evidence' ? 'too_little_evidence' : 'unknown', b.state === 'too_little_evidence' ? 'too little evidence' : b.state)}</div>`).join('')}${u.reason ? note(esc(u.reason)) : ''}<p class="muted small" style="margin-top:10px">Nothing enters the user profile without evidence in a capture (mem user).</p>`,
    )}${panel(
      'Job ledger',
      l.readable
        ? `<div class="tablewrap"><table class="table"><thead><tr><th>Agent / model</th><th>Jobs</th><th>First try</th><th>Verdict</th></tr></thead><tbody>${(l.rows || []).map((z) => `<tr><td>${esc(z.agent_kind)} / ${esc(z.model)}</td><td>${num(z.jobs)}</td><td>${num(z.firstTryOk)} of ${num(z.jobs)}</td><td>${esc(z.verdict)}</td></tr>`).join('') || '<tr><td colspan="4">No jobs in the journal.</td></tr>'}</tbody></table></div>${note(`${num(l.totalJobs)} jobs attributed, ${num(l.unassigned)} unassigned. Under 20 jobs the verdict stays unknown — no ranking of alleged model strengths.`)}`
        : note(esc(l.reason || 'not measurable'), 'bad'),
    )}</div>`;
  },

  // --- Sources & archive ------------------------------------------------------
  projects: () => {
    const ps = (D.projects || []).filter((p) => state.project === 'all' || p.name === state.project);
    const shelf = new Map((D.projectShelf?.projects || []).map((p) => [p.name, p]));
    return `<div class="grid three">${ps
      .map((p) => {
        const r = shelf.get(p.name);
        return panel(
          esc(p.name),
          `<div class="number">${num(p.entries)}</div><p class="small muted" style="margin:5px 0 20px">entries · ${p.drawers.length} filled types${p.retired ? ` · ${num(p.retired)} retired` : ''}${p.openQuestions ? ` · ${num(p.openQuestions)} open questions` : ''}</p>${p.drawers.map((t) => `<span class="tag">${esc(types[t] || t)}</span>`).join('')}${r ? `<div class="stats-list" style="margin-top:14px"><div class="row"><span class="small">Shelf</span><span class="small">${num(r.filled)} filled · ${num(r.empty)} empty · ${num(r.missing)} missing of ${num(r.drawersTotal)}</span></div>${(r.files || []).map((f) => `<div class="row"><span class="small mono">${esc(f.name)}</span>${badge(f.where)}</div>`).join('')}</div>` : ''}${p.agents?.length ? `<p class="small quiet" style="margin-top:12px">Agents: ${p.agents.map((a) => esc(a.name) + ' (' + num(a.entries) + ')').join(', ')}</p>` : ''}<div class="drawer-actions">${btn('Open project', 'project', `data-value="${esc(p.name)}"`, 'ghost')}${btn('Export', 'export-project', `data-value="${esc(p.name)}"`, 'ghost')}</div>`,
          p.last ? 'Newest entry ' + when(p.last) : '',
        );
      })
      .join('') || empty('No project yet. <code class="mono">mem project init &lt;name&gt;</code> creates one; the global drawer needs none.')}</div>${note('Missing and empty project drawers stand on the shelf: filled, empty and missing are three different findings.')}`;
  },
  files: () => {
    const st = D.store || {};
    return panel(
      'Source register',
      entryRows(scoped().filter((e) => e.type === 'source'), 'No source recorded yet. <code class="mono">mem sources add &lt;file|url&gt;</code> indexes one.') +
        `<div class="sectionline"><h2>Store check</h2>${st.readable ? badge(st.missing || st.changed || st.orphans ? 'warning' : 'good') : badge('unknown')}</div>${
          st.readable
            ? `<div class="row"><span class="small">Registered / deleted</span><span class="small">${num(st.registered)} / ${num(st.deleted)} · ${num(st.bytes)} bytes</span></div><div class="row"><span class="small">Missing / changed / orphaned</span><span class="small">${num(st.missing)} / ${num(st.changed)} / ${num(st.orphans)}</span></div>${(st.entries || [])
              .map((z) => `<div class="row"><div><strong>${esc(z.name || z.sha)}</strong><p>${esc(z.purpose || 'no purpose')} · ${esc(z.agent || '—')} · ${when(z.ts)} · ${num(z.size)} bytes</p></div>${z.deleted ? `<span class="badge">Deleted with reason: ${esc(z.reason || '—')}</span>` : badge(z.checked ? 'checked' : 'unknown', z.checked ? 'checked' : 'unchecked')}</div>`)
              .join('') || empty('The store holds no file yet. <code class="mono">mem store put &lt;file&gt;</code> adds one.')}`
            : note(esc(st.reason || 'Store not readable'), 'bad')
        }`,
      'Source pointers, register entries and available bytes stay distinguishable.',
    );
  },
  raw: () => partNotice('raw', 'Raw capture review') ?? rawPage(),
  digest: () => {
    const tile = (D.system || []).find((k) => k.id === 'digest');
    const withCapture = scoped().filter((e) => e.capture).length;
    const ex = scoped().find((e) => e.capture && e.rels.length);
    const yf = D.digester?.yieldFinding;
    return (
      panel(
        'From raw capture to entry',
        `<div class="flow"><span>${ex ? esc(ex.capture.split('/').pop().slice(0, 28)) : 'Capture'} · original</span><i>→</i><span>${ex ? esc(ex.id) : 'Entry'} · ${ex ? esc(types[ex.type]) : 'knowledge'}</span><i>→</i><span>${ex ? esc(ex.rels[0][1]) + ' · ' + esc(edgeLabels[ex.rels[0][0]] || ex.rels[0][0]) : 'later use'}</span></div><p class="muted">The chain is real: a digested entry carries the path of its capture (origin.raw), and its links show the later use.</p><div class="row"><span>Digest / last run</span>${tile ? `<span class="small">${esc(tile.line)}</span>` : badge('unknown')}</div><div class="row"><span>State</span>${tile ? badge(tile.state === 'calm' ? 'calm' : tile.state === 'watch' ? 'watch' : tile.state === 'alarm' ? 'alarm' : 'unknown', tile.word) : badge('unknown')}</div>${ex ? btn('See the evidence trail', 'raw-open', `data-id="${esc(ex.capture)}"`, 'ghost') : ''}`,
      ) +
      panel(
        'Origin per capture',
        `<div class="row"><span>Every digested entry</span><span class="small">a pointer to its original capture</span></div><div class="row"><span>Entries with a capture pointer</span><span class="small">${num(withCapture)} of ${num(scoped().length)}</span></div><div class="row"><span>Mapping complete?</span>${scoped().length ? badge(withCapture === scoped().length ? 'complete' : 'partial') : badge('unknown', 'nothing to map yet')}</div><div class="row"><div><strong>Digest yield (doctor)</strong><p>${esc(yf?.text || 'the doctor did not report digest-yield')}</p></div>${badge(yf ? levelWord[yf.level] || yf.level : 'unknown')}</div>${notAvailable('digesterYield')}${note('A run with many entries can still map its sources badly. The view keeps both questions apart; older entries written by hand naturally have no capture.')}`,
      )
    );
  },
  export: () =>
    `<div class="grid two">${panel(
      'Assemble a package',
      `<label class="formfield">Project<select class="field" id="exportProject">${['global', ...(D.projects || []).map((p) => p.name).filter((n) => n !== 'global')].map((n) => `<option ${n === (state.project === 'all' ? 'global' : state.project) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><label class="check"><input type="checkbox" id="exportGlobal" checked> Add the global foundations</label><label class="check"><input type="checkbox" id="exportHistory" checked> Include historical / retired entries</label><p class="muted small" style="margin:12px 0">Raw captures, messages and file bytes stay excluded. Relations across the package boundary appear as references.</p><div class="drawer-actions">${btn('Load JSON package ↓ (not built)', 'export-json', 'aria-disabled="true"', 'ghost')}${btn('Offline reading view ↓ (not built)', 'export-html', 'aria-disabled="true"', 'ghost')}</div>`,
      'The selection shows the scope a package would have.',
    )}${panel('Content preview', '<div id="exportPreview"></div>', 'State of the loaded data')}</div>${note('A project package export is not built into the product yet. The existing export is the raw capture export — below, under Sources › Raw capture and as a task under Operations › Tasks. The offline reading view is <code class="mono">mem viewer</code>, a file to take along.')}<div style="margin-top:18px">${rawExportPanel()}</div>`,

  // --- Operations -------------------------------------------------------------
  shards: () => {
    const ks = (D.net?.boxes || []).filter((k) => state.project === 'all' || k.project === state.project);
    return `${metrics([
      ['Logical entries', num(scoped().length), 'originals and states stay apart'],
      ['Drawers', num(ks.length), 'project × type, counted from the store'],
      ['Required sources', state.missing ? 'Incomplete' : 'Available', state.missing ? 'not every drawer was readable' : 'every drawer readable'],
      ['Scale gate', 'Not available', 'VM tooling of the sibling — see Performance'],
    ])}<div class="grid two">${panel(
      'Storage landscape',
      `<div class="panelhead"><span class="small muted">Every drawer is a JSONL file · append-only</span></div><div class="shards">${ks
        .map((k) => `<button class="shard" data-action="shard-detail" data-value="${esc(k.name)}"><strong>${esc(k.name)} ↗</strong><small>${num(k.entries)} entries</small><small>${esc(types[k.drawer] || k.drawer)} · ${esc(k.project)}</small></button>`)
        .join('')}</div>${ks.length ? '' : empty('No drawer holds an entry yet — the first entry creates its drawer.')}`,
    )}${panel(
      'One logical view',
      `<div class="flow"><span>JSONL drawers</span><i>→</i><span>Derived fabric</span><i>→</i><span>Views</span></div><div class="row"><span class="small">State</span><span class="mono">${esc(D.meta?.git?.head || '—')} · ${esc(whenTime(D.at))}</span></div><div class="row"><span class="small">Completeness</span>${badge(state.missing ? 'unknown' : 'complete')}</div><div class="row"><span class="small">Links into the void</span><span class="small">${num(D.net?.dangling)}</span></div>${note(state.missing ? 'A source was not readable. A complete answer is not provable right now.' : 'Drawer boundaries do not change entry ids.', state.missing ? 'bad' : 'good')}`,
    )}</div>`;
  },
  operations: () => operationsPage(),
  doctor: () => doctorPage(),
  performance: () => performancePage(),
  integrity: () => {
    const es = scoped();
    const events = es.filter((e) => e.state !== 'active').length;
    const pr = D.tasks?.running?.integrity;
    const chain = es.filter((e) => e.type === 'error' && (e.rels.length || incomingIndex.has(e.id))).slice(0, 3);
    const follow = chain.flatMap((e) => [e, ...(incomingIndex.get(e.id) || []).map((x) => byId(x.id)), ...e.rels.map((r) => byId(r[1]))]).filter(Boolean);
    const uniq = [...new Map(follow.map((e) => [e.id, e])).values()].slice(0, 6);
    return `<div class="grid two">${panel(
      'Traceability',
      `<div class="row"><span class="small">Readable originals</span>${es.length ? badge(es.every((e) => e.readable) ? 'present' : 'partial', `${num(es.filter((e) => e.readable).length)} present`) : badge('unknown', 'none yet')}</div><div class="row"><span class="small">Correction / state events</span><strong>${num(events)}</strong></div><div class="row"><span class="small">Hash chain check (last)</span>${pr ? badge(pr.running === true ? 'running' : pr.state, pr.running === true ? 'running' : `${pr.state} · ${whenTime(pr.ended || pr.started)}`) : badge('unknown', 'never started')}</div><div style="margin-top:18px">${btn('See the tasks', 'goto-operations', '', 'ghost')}</div>`,
    )}${panel(
      'Protection is a concrete state',
      `<p class="muted small">Entries are plain-text JSONL in the repository. That is a deliberate decision of this house (docs/design.md: "Why there's no encryption" — use a private repository, never put secrets in).</p><div class="row"><span class="small">Encrypted</span>${badge('not available', 'not in cheap-mem, by design')}</div><div class="row"><span class="small">Shredded</span>${badge('unknown', 'not measured')}</div><div class="row"><span class="small">Removing a body</span><span class="quiet small">through the command line, not from the browser</span></div>`,
    )}</div>${panel('Error → lesson → protection', entryRows(uniq, 'No error with a declared link yet.'), 'The relations come from the same declared links as the knowledge space.')}${integrityPanel()}`;
  },
  versions: () => {
    const g = D.meta?.git || {};
    // Four states the mockup names, here really four DIFFERENT
    // questions: the code on disk, the process actually answering, the
    // memory repository, and the hook (the doctor's stop-hook finding).
    const v = D.versions || {};
    const c = v.code || {};
    const hook = v.hookState;
    return `${panel(
      'Code state and process state',
      `<div class="row"><div><strong>This surface</strong><p>The dashboard · served by mem serve</p></div>${badge('present')}</div><div class="row"><div><strong>cheap-mem on disk</strong><p>version ${esc(c.version || '—')} · ${esc(c.headNow || 'not a git checkout')}</p></div>${c.version ? badge('present') : badge('unknown')}</div><div class="row"><div><strong>Running process</strong><p>Loaded: ${esc(c.headAtStart || '—')}. A commit on disk proves no loaded process version.${c.stale ? ' A restart is due so the process loads what is on disk.' : ''}</p></div>${c.headAtStart ? (c.stale ? badge('stale') : badge('good', 'current')) : badge('unknown')}</div><div class="row"><div><strong>Memory repository</strong><p>${esc(g.branch || '—')} · ${esc(g.head || '—')} · state ${esc(g.at || '—')}${g.changed ? ` · ${num(g.changed)} changed files` : ''}${g.remote ? ' · ' + esc(g.remote) : ''}</p></div>${g.head ? badge('present') : badge('unknown')}</div><div class="row"><div><strong>Data state</strong><p>${esc(whenTime(D.at))} · ${num(D.meta?.inventory?.total)} lines in ${num(D.meta?.inventory?.projects)} projects</p></div><span class="mono">${entriesTotalText()}</span></div>${(D.connections || []).map((r) => `<div class="row"><div><strong>${esc(r.title)}</strong><p>${esc(r.address)} · ${esc(r.door)}${r.note ? ' · ' + esc(r.note) : ''}</p></div>${badge(r.open ? 'open' : 'present', r.open ? 'no token' : 'door set')}</div>`).join('')}`,
    )}${panel(
      'Hook state and release rail',
      `<div class="row"><div><strong>Stop hook</strong><p>${esc(hook?.text || 'The doctor\'s "stop-hook" finding was not read.')}</p></div>${badge(hook ? levelWord[hook.level] || hook.level : 'unknown')}</div>${releaseRow(v.release)}${checkRecordRow(v.checkRecord)}${note('The hook state comes from the same doctor run as "Operations › Diagnosis". Release state and the last test receipt come from src/release.mjs and src/checkrecord.mjs (Bauplan P1) — checked.jsonl and <cheap-mem>-release/current, read straight off disk.')}`,
    )}`;
  },
  mcp: () => mcpPage(),

  // --- Settings ---------------------------------------------------------------
  appearance: () =>
    panel(
      'Calm, readable, personal',
      `<div class="row"><div><strong>Colour scheme</strong><p>All surfaces switch together; the knowledge space stays a dark stage.</p></div>${btn(state.light ? 'Switch to dark' : 'Switch to light', 'theme', '', 'ghost')}</div><div class="row"><div><strong>Motion</strong><p>Stops rotation, pulses, energy cores and wandering points of light completely.</p></div>${btn(state.motion ? 'Pause' : 'Resume', 'motion', '', 'ghost')}</div><div class="row"><div><strong>Read only</strong><p>${serverWrites ? 'Locks every button that writes in this tab. The server checks on its own regardless.' : 'Set by the server (writing is off) — not switchable here.'}</p></div><label class="check"><input type="checkbox" id="readOnly" ${state.readonly ? 'checked' : ''} ${serverWrites ? '' : 'disabled'}> Active</label></div><div class="row"><div><strong>Print</strong><p>A clean printout of the current view.</p></div>${btn('Print / PDF', 'print', '', 'ghost')}</div>`,
    ),
  // Access: change the password (current + new twice) and sign out.
  access: () => {
    if (!loginEnabled) return panel('Password', note('The password login is switched off on this server (CHEAP_MEM_SERVE_LOGIN=off). Access is then governed only by the tunnel and the token.'));
    const f = (id, label, ac, extra = '') => `<label class="formfield">${label}<input class="field" type="password" id="${id}" name="${id}" autocomplete="${ac}" required ${extra}></label>`;
    return `<div class="grid two">${panel(
      'Change password',
      `<form id="passwordForm" autocomplete="on"><input type="text" name="username" value="cheap-mem" autocomplete="username" hidden>${f('pwAlt', 'Current password', 'current-password')}${f('pwNeu', `New password (at least ${PW_MIN} characters)`, 'new-password', `minlength="${PW_MIN}"`)}${f('pwNeu2', 'Repeat the new password', 'new-password', `minlength="${PW_MIN}"`)}<div id="pwMeldung" role="status" aria-live="polite"></div><button class="btn primary" type="submit">Change password</button></form>${note('After the change every other signed-in device is signed out. Forgotten? On the machine: <span class="mono">mem serve reset-password</span>.')}`,
      'Current password, new one twice.',
    )}${panel(
      'Sign out',
      `<div class="row"><div><strong>Sign out this device</strong><p>Ends the session in this browser. The next visit asks for the password again.</p></div>${btn('Sign out', 'sign-out', '', 'ghost')}</div>`,
      'Sessions last 30 days and extend with use.',
    )}</div>`;
  },
  system: () => systemPage(),
  catalog: () => {
    const cli = D.catalog?.cli;
    const mcp = D.catalog?.mcp || { reading: [], writing: [] };
    const fnd = D.catalog?.findings;
    // All three numbers from living counters (the CLI tables,
    // mcpprofile.mjs, the same doctor run as "Operations › Diagnosis") —
    // no number written into the code.
    return `${metrics([
      ['Commands', cli ? num(cli.length) : '—', 'counted from the CLI group tables'],
      ['MCP tools', num(mcp.reading.length + mcp.writing.length), 'src/mcpprofile.mjs, reading + writing'],
      ['Doctor findings', fnd != null ? num(fnd) : '—', 'the same run as Operations › Diagnosis'],
    ])}${panel(
      cli ? `${cli.length} commands · fully assigned` : 'Commands · count unknown',
      `<input class="field" id="catalogSearch" placeholder="Filter by command or area …" aria-label="Filter the function catalogue" style="width:100%;margin-bottom:16px"><div id="catalogList">${catalogHtml('')}</div>${note('The catalogue comes from the CLI\'s own command tables. An entry does not mean its function is reachable from the browser. Irreversible maintenance stays a deliberately separate route.')}`,
    )}`;
  },
  projectstate: () => projectstatePage(),
};

// ops/mcp — kept as its own function so the sibling's live tools/list
// probe can be mirrored here cleanly once it lands.
// "Client sees it" (src/mcpvisibility.mjs — a client's own tools/list and
// tools/call traffic against the bridge) and "Checked live" (src/mcplive.mjs
// — this server's own tools/list probe of the local bridge) are two
// DIFFERENT measurements: the first needs a real client to have connected
// at all, the second only needs the bridge itself to be reachable. Neither
// stands in for the other — dash-fix3 parity.
function mcpPage() {
  const k = D.catalog?.mcp || { reading: [], writing: [] };
  const all = [...k.reading.map((n) => [n, 'reading']), ...k.writing.map((n) => [n, 'writing'])];
  const live = k.live || {};
  const seen = k.clientVisible || {};
  const liveWord = { good: 'present', error: 'missing live' };
  return panel(
    'Tool availability',
    `<div class="tablewrap"><table class="table"><thead><tr><th>Tool</th><th>Definition</th><th>Client sees it</th><th>Checked live</th></tr></thead><tbody>${all
      .map(([n, kind]) => {
        const s = seen[n];
        const l = live[n];
        const seenCell = s ? badge('good', `${s.client} · ${whenTime(s.ts)}`) : badge('unknown', 'not seen yet');
        const liveCell = l ? badge(l.state, liveWord[l.state] || l.reason || l.state) : badge('unknown');
        return `<tr><td class="mono">${esc(n)}</td><td><span class="badge">${kind}</span></td><td>${seenCell}</td><td>${liveCell}</td></tr>`;
      })
      .join('')}</tbody></table></div>${note(
      `${all.length} tool names from src/mcpprofile.mjs (${k.reading.length} reading, ${k.writing.length} writing). `
      + `${k.liveCheckedAt ? `Live-checked ${whenTime(k.liveCheckedAt)}.` : k.liveReason ? esc(k.liveReason) + '.' : ''} `
      + '"Client sees it" comes from the bridge\'s own client-visibility journal (real MCP traffic on this machine, never simulated).',
    )}`,
  );
}

// settings/system — the four console settings (not the sibling's three:
// cheap-mem's "quiet-hours" has no counterpart there and gets its own
// row), the write switch in four states, the setup steps, the stores
// found on this machine, and the console's change log.
function systemPage() {
  const w = D.meta?.writes || {};
  const rows = (D.settings || []).map((s) => {
    const dis = state.readonly || s.writable === false ? 'disabled' : '';
    const input = s.kind === 'number'
      ? `<input class="field setting-field" data-id="${esc(s.id)}" type="number" min="1" value="${esc(s.value ?? '')}" ${dis}>`
      : `<input class="field setting-field" data-id="${esc(s.id)}" value="${esc(s.value ?? '')}" spellcheck="false" ${dis}>`;
    return `<label class="formfield" style="margin-top:14px">${esc(s.title)}${input}</label><p class="small muted">${esc(s.description || '')} ${esc(s.effect || '')} Source: ${esc(s.source || '—')}${s.writable === false ? ' · not writable' : ''}${s.note ? ' · ' + esc(s.note) : ''}.</p>`;
  }).join('');
  const steps = (D.setup || []).map((s) => `<div class="row"><div><strong>${esc(s.title)}</strong><p>${esc(s.detail || '')}${s.fix ? ` → <code class="mono">${esc(s.fix)}</code>` : ''}</p></div>${badge(s.state === 'done' ? 'done' : s.state === 'open' ? 'open' : s.state === 'broken' ? 'broken' : 'unknown', s.state)}</div>`).join('');
  return `${panel(
    'Settings with origin and effect',
    `<div class="row"><div><strong>Writing from the dashboard</strong><p>${esc(w.reason || 'unknown')}${w.howTo ? ' ' + esc(w.howTo) : ''}</p></div>${badge(w.state === 'on' ? 'on' : w.state === 'off' ? 'off' : w.state === 'error' ? 'error' : 'unknown', w.state || 'unknown')}</div>${rows}${btn('Save settings', 'save-config', state.readonly ? 'disabled' : '', 'primary')}${note('Saved through POST /setting — the same route as the console, behind the write switch, the Host check and the Origin check, with a closed field list. No folder is created beyond the one a setting names, no service is switched.')}<div id="configHistory">${(D.log || []).map((x) => `<p class="small muted">${esc(whenTime(x.ts))} · ${esc(x.id || '')}: ${esc(x.before ?? '—')} → ${esc(x.after ?? '—')} · ${esc(x.by || '')}</p>`).join('') || '<p class="small quiet">Nothing changed yet.</p>'}</div>`,
  )}<div class="grid two" style="margin-top:18px">${panel('Installation', steps || empty('No setup step readable.'), `${num((D.setup || []).filter((s) => s.state !== 'done').length)} of ${num((D.setup || []).length)} still open`)}${panel('Stores on this machine', (D.stores || []).length ? (D.stores || []).map((x) => `<div class="row"><span class="mono small">${esc(x.id)}</span><span class="small">${esc(x.label)}${x.found.length > 1 ? ` · ${num(x.found.length)} candidates — ambiguous` : ''}</span></div>`).join('') + '<p class="small quiet" style="margin-top:10px">Usable as a raw-archive value above.</p>' : empty('No cloud store found on this machine. A folder path works.'), 'Only what was actually found')}</div>`;
}

const commandGroups = [
  ['Search & read', 'find show browse when explain retrieve', 'knowledge/entries'],
  ['Search extensions', 'find-embed find-hybrid embed thesaurus', 'knowledge/entries'],
  ['Entries & state', 'log correction discard done teach', 'knowledge/entries'],
  ['Context & lessons', 'context core digest procedures', 'work/context'],
  ['Topics', 'topics topic topic-merge', 'knowledge/topics'],
  ['Facts & relations', 'facts links experiences net', 'knowledge/network'],
  ['Work', 'duties questions answer', 'work/tasks'],
  ['Sources & files', 'sources store', 'sources/files'],
  ['Projects', 'project', 'sources/projects'],
  ['Raw capture & digest', 'raw raw-capture shrink archive', 'sources/raw'],
  ['Agents', 'agents agent whoami heartbeat onboarding', 'work/agents'],
  ['Communication', 'inbox broadcast', 'work/inbox'],
  ['Integration & hooks', 'init setup hooks guard paths bridge', 'settings/system'],
  ['Effect', 'gauges effect asked-learn observations status', 'work/usage'],
  ['User & job ledger', 'user ledger classes', 'work/understanding'],
  ['Diagnosis', 'doctor board component', 'ops/doctor'],
  ['Integrity', 'chain epoch maintenance', 'ops/integrity'],
  ['Delivery', 'viewer serve version', 'settings/appearance'],
];
function catalogHtml(q) {
  const cli = D?.catalog?.cli || [];
  const set = new Set(cli);
  const assigned = new Set();
  const groups = commandGroups.map(([n, cmds, r]) => {
    const list = cmds.split(' ').filter((c) => !cli.length || set.has(c));
    list.forEach((c) => assigned.add(c));
    return [n, list, r];
  });
  const rest = cli.filter((c) => !assigned.has(c));
  if (rest.length) groups.push(['Further commands', rest, 'settings/catalog']);
  return (
    groups
      .filter(([n, list]) => list.length && (n + ' ' + list.join(' ')).toLowerCase().includes(q.toLowerCase()))
      .map(([n, list, r]) => `<div class="row"><div><strong>${esc(n)}</strong><div>${list.map((c) => `<span class="tag mono">${esc(c)}</span>`).join('')}</div></div>${link('View', r)}</div>`)
      .join('') || empty()
  );
}
function occasionName(a) {
  return { question: 'After a question', 'before-edit': 'Before a file edit', unknown: 'Unknown occasion' }[a] || a;
}
const reasonWord = { 'no-signal': 'too short (no signal)', empty: 'empty (index without a hit)', 'too-weak': 'too weak', rebuild: 'index rebuild ran late', 'already-shown': 'already shown', off: 'recall off', unknown: 'unknown reason' };

// work/context — the retrieval probe and the recent injections.
let probeLast = null;
// The palette's ranked search: a later input must never be overwritten
// by the answer to an earlier one.
let paletteRun = 0;
function probeResultHtml(r) {
  if (!r) return '';
  if (r.state !== 'ok') return note('Probe failed: ' + esc(reasonPlain(r.reason)), 'bad');
  const head = r.shown
    ? `<div class="label" style="margin:15px 0 6px">Would answer with ${num(r.hits.length)} claim(s)${r.excluded ? ` · ${num(r.excluded)} excluded` : ''}</div>`
    : `<div class="label" style="margin:15px 0 6px">Would answer with NOTHING${r.excluded ? ` · ${num(r.excluded)} excluded` : ''}</div>`;
  const cov = `<div class="row"><span class="small">Coverage</span>${badge(r.coverage?.state || 'unknown_coverage', (r.coverage?.state || 'unknown_coverage').replace('_', ' '))}</div>${(r.coverage?.reasons || []).map((x) => `<p class="small quiet">${esc(x.why || x)}</p>`).join('')}`;
  const hits = r.hits?.length
    ? `<div class="tablewrap"><table class="table"><thead><tr><th>Rank</th><th>Claim</th><th>Authority / scope</th><th>Score</th></tr></thead><tbody>${r.hits.map((t) => `<tr><td>${t.rank}</td><td>${t.id && byId(t.id) ? open(t.id, t.body || t.id, 'textlink') : esc(t.body || t.id)}</td><td class="small">${esc(t.authority || '—')} · ${esc(t.scope || '—')}</td><td class="mono small">${t.score != null ? t.score.toFixed(2) : '—'}</td></tr>`).join('')}</tbody></table></div>`
    : '';
  return head + `<div style="margin-top:10px">${cov}</div>` + hits;
}
function contextEntries() {
  const all = D.usage?.recent || [];
  const z = all.find((x) => state.context === 'all' || x.occasion === state.context);
  if (!z) return { line: null, es: [] };
  const es = z.sources.map((q) => byId(q) || entries.find((e) => e.source === q)).filter((e) => e && scope(e));
  return { line: z, es, foreign: z.sources.length - es.length };
}
function contextContent() {
  const { line, es, foreign } = contextEntries();
  if (!line) return empty(D.recall?.measurable ? 'No injection for this occasion in the journal.' : 'Injection journal not measurable: ' + esc(D.recall?.reason || ''));
  return `<div class="label" style="margin:15px 0">${esc(occasionName(line.occasion))} · ${esc(whenTime(line.ts))} · session ${esc(line.session || 'without id')}</div>${entryRows(es)}<div class="smallstats"><span>Injected: ${num(line.sources.length)} places · ${line.bytes != null ? num(line.bytes) + ' bytes' : 'size not measured'}${foreign ? ` · ${num(foreign)} outside the selection` : ''}</span><span>From the injection journal · no model call</span></div>`;
}
// Live injection view (Bauplan P4): the newest journal lines of EVERY
// kind — injected, and why nothing was — with size and hook time. Read
// from the same journal as everything else, refreshed with the data.
function liveInjectionPanel() {
  const live = D.usage?.live;
  if (!D.usage?.measurable) return `<div style="margin-top:18px">${panel('Live injection view', empty('Injection journal not measurable: ' + esc(D.usage?.reason || 'unknown')), 'What the recall hook did, line by line')}</div>`;
  const rows = (live || []).map((l) => `<tr><td class="mono small">${esc(whenTime(l.ts))}</td><td>${esc(occasionName(l.occasion))}</td><td>${l.reason ? badge('unknown', reasonWord[l.reason] || l.reason) : badge('good', 'injected')}</td><td>${l.hits != null ? num(l.hits) : '—'}</td><td>${l.bytes != null ? num(l.bytes) + ' B' : 'not measured'}</td><td>${l.durationMs != null ? num(l.durationMs) + ' ms' : 'not measured'}</td><td class="small mono">${esc((l.sources || []).slice(0, 2).join(', ')) || '—'}</td></tr>`).join('');
  return `<div style="margin-top:18px">${panel(
    'Live injection view',
    rows ? `<div class="tablewrap"><table class="table"><thead><tr><th>When</th><th>Occasion</th><th>Result</th><th>Hits</th><th>Size</th><th>Time</th><th>Places</th></tr></thead><tbody>${rows}</tbody></table></div>${btn('Load again', 'reload', '', 'ghost')}` : empty('The journal is present but holds no line yet.'),
    'The newest 30 recalls, straight from the journal — read, never simulated',
  )}</div>`;
}
function contextPage() {
  const all = D.usage?.recent || [];
  const occ = [...new Set(all.map((z) => z.occasion).filter(Boolean))];
  return `${panel(
    'Retrieval probe',
    `<p class="muted small">Type a question and see what <code class="mono">mem retrieve</code> answers right now — the same gateway the recall uses, called read-only. The question never leaves this tab's request: it is not stored, not journaled, not observed.</p><textarea class="field" id="probeQuestion" rows="2" placeholder="Type a question, e.g. “why is writing off by default” …" aria-label="Question for the retrieval probe"></textarea><div class="drawer-actions">${btn('Send the probe', 'probe-ask', '', 'primary')}</div><div id="probeResult"></div>`,
    'Read-only: structured claims, never prose — nothing is written anywhere.',
  )}${panel(
    'Look up an injection',
    `<div class="toolbar"><select class="field" id="contextCase" aria-label="Occasion"><option value="all" ${state.context === 'all' ? 'selected' : ''}>Every occasion</option>${occ.map((a) => `<option value="${esc(a)}" ${state.context === a ? 'selected' : ''}>${esc(occasionName(a))}</option>`).join('')}</select>${D.recall?.measurable ? badge('measured', 'injection journal') : badge('unknown')}</div><div class="flow"><span>01 · Occasion</span><i>→</i><span>02 · Context</span><i>→</i><span>03 · Next step</span></div><div id="contextContent">${contextContent()}</div>`,
    'The places really injected last — read, not simulated.',
  )}${liveInjectionPanel()}<div class="grid two" style="margin-top:18px">${panel('Always present: core knowledge', entryRows(scoped().filter((e) => e.type === 'procedure' && statusOf(e.id) === 'active').slice(0, 3), 'No procedure issued yet — procedures are the knowledge every session carries.'))}${panel(
    'What the context does not prove',
    `<div class="row"><span class="small">Provided</span>${D.recall?.measurable ? badge('present') : badge('unknown')}</div><div class="row"><span class="small">Read by the agent</span>${badge('unknown')}</div><div class="row"><span class="small">Answer quality improved</span>${badge('unknown')}</div><p class="muted small" style="margin-top:13px">The journal knows what was injected — not whether it helped.</p>`,
  )}</div>`;
}

// dash-fix3 parity, part 2b: "did an injected place get named again?"
// (src/effect.mjs, wired through dashboard-data.mjs's usage.effect).
function effectSummary(ef) {
  if (!ef) return { text: 'Unknown', sub: 'not measured' };
  if (ef.measurable) {
    const pct = (x) => (x * 100).toFixed(1) + '%';
    return { text: `${pct(ef.rate)} used again`, sub: `95% CI [${pct(ef.wilson.lo)}, ${pct(ef.wilson.hi)}] · ${num(ef.n)} pairs` };
  }
  if (ef.state === 'no-data') return { text: 'No data', sub: 'no injection on record yet' };
  if (ef.state === 'not-measurable') return { text: 'Not enough data', sub: `${num(ef.n)} of ${num(ef.minPairs)} pairs needed` };
  return { text: 'Unknown', sub: ef.reason || 'not measurable here' };
}
// dash-fix3 parity, part 2a: the cost journal (src/modelcost.mjs), read
// through dashboard-data.mjs's usage.modelCost. `costUsd` is an
// ESTIMATE from the CLI, never a bill — labelled as such below.
function modelCostSummary(mc) {
  if (!mc?.measurable) return { text: 'Not measured yet', sub: mc?.reason || 'no row in the cost journal yet' };
  const runs = mc.last7.reduce((n, s) => n + s.runs, 0);
  const costed = mc.last7.filter((s) => s.costUsd != null);
  const cost = costed.length ? costed.reduce((n, s) => n + s.costUsd, 0) : null;
  return {
    text: cost != null ? `$${cost.toFixed(4)}` : `${num(runs)} run(s)`,
    sub: cost != null ? `${num(runs)} run(s), 7d · ${mc.costLabel}` : `${num(runs)} run(s), 7d · cost not reported by this CLI`,
  };
}
// work/usage — kept as its own function so the sibling's cost journal
// and effect wiring can be mirrored here cleanly once they land.
function usagePage() {
  const n = D.usage || {};
  const g = n.reasons || {};
  const ok = n.measurable;
  const cnt = (k) => (ok ? num(g[k] || 0) : '—');
  const eff = effectSummary(n.effect);
  const cost = modelCostSummary(n.modelCost);
  return `${metrics([
    ['Context occupancy', ok && n.bytes?.measured ? num(Math.round(n.bytes.sum / n.bytes.measured)) + ' B' : '—', ok ? (n.bytes?.measured ? 'mean per injection, from the journal' : 'size not recorded by the hook') : 'journal not readable'],
    ['Injections delivered', ok ? num(n.shown) : '—', ok ? `of ${num(n.rows)} recalls` : 'not measurable'],
    ['Application', eff.text, eff.sub],
    ['Model costs', cost.text, cost.sub],
  ])}<div class="grid two">${panel(
    'Narrowly missed',
    `<div class="number">${cnt('too-weak')}</div><p class="muted">Recalls where hits were there, but all below the threshold ("too-weak"). ${ok ? num(g.empty || 0) + ' more found nothing in the index at all.' : ''}</p>${btn('Open the search', 'search', '', 'ghost')}`,
  )}${panel(
    'Look at measurements apart',
    `<div class="row"><strong>Occupancy</strong><span class="small muted">How much context is taken</span></div><div class="row"><strong>Sufficiency</strong><span class="small muted">What the session does next</span></div><div class="row"><strong>Allocation</strong><span class="small muted">Which places get used</span></div><div class="row"><strong>Answer quality</strong><span class="small muted">Needs its own comparison (mem gauges)</span></div>`,
  )}</div><div class="grid two" style="margin-top:18px">${panel(
    'Recall quality rather than mere activity',
    `<div class="row"><span>Already shown / suppressed</span><span>${cnt('already-shown')}</span></div><div class="row"><span>Too weak: a search problem</span><span>${cnt('too-weak')}</span></div><div class="row"><span>Empty: a knowledge gap</span><span>${cnt('empty')}</span></div><div class="row"><span>No signal / recall off</span><span>${ok ? num((g['no-signal'] || 0) + (g.off || 0)) : '—'}</span></div><div class="row"><span>Hook time p50 / p95</span><span>${badge('unknown', 'not measured in cheap-mem')}</span></div><p class="small quiet" style="margin-top:10px">From ${ok ? num(n.rows) : '—'} journal lines${n.broken ? `, ${num(n.broken)} broken (counted, not skipped)` : ''}.</p>`,
  )}${panel(
    'Before, after and between steps',
    `<div class="flow">${Object.entries(n.occasions || {}).sort((a, b) => b[1] - a[1]).map(([a, c]) => `<span>${esc(occasionName(a))} · ${num(c)}</span>`).join('<i>→</i>') || '<span>—</span>'}</div><p class="muted small">The hooks react to visible messages and tool events. A model's internal reasoning is not an observable data source.</p>`,
  )}</div>`;
}

// --- Inbox (new in the mockup's style; the mockup had none) -------------------
//
// The same routes as the command line: read (the list from /dashboard.json,
// one message from /dashboard/message.json), reply (POST /inbox/reply) and
// acknowledge (POST /inbox/state). Replying and acknowledging are only
// possible for messages addressed to the configured human participant —
// no form field decides who speaks.
function inboxFiltered() {
  const q = state.inboxQuery.toLowerCase();
  return messages.filter(
    (m) =>
      (state.inboxTo === 'all' || m.to === state.inboxTo) &&
      (state.inboxAll || m.situation !== 'done') &&
      (!q || (m.subject + ' ' + m.from + ' ' + m.to + ' ' + m.name).toLowerCase().includes(q)),
  );
}
const situationWord = { open: 'open', waiting: 'waiting too long', done: 'done' };
function inboxRows() {
  const ms = inboxFiltered();
  return (
    ms
      .slice(0, 80)
      .map(
        (m) =>
          `<div class="row post-row sit-${m.situation}"><div><span class="small quiet">${esc(m.from)} → ${esc(m.to)} · ${esc(age(m.ageMin))}</span><h3 style="margin:5px 0">${esc(m.subject)}</h3><p>${esc(m.state)} · <span class="mono">${esc(m.name)}</span></p></div><div>${badge(situationWord[m.situation] || m.situation)}<div style="margin-top:7px">${btn('Open message', 'message', `data-id="${esc(m.name)}"`, 'small ghost')}</div></div></div>`,
      )
      .join('') + limitNote(Math.min(80, ms.length), ms.length) || empty(state.inboxAll ? 'No messages for this selection.' : 'Nothing open for this selection. "Include done" shows the rest.')
  );
}
function inboxPage() {
  const p = D.inbox || {};
  if (!p.readable) return note('Inbox not readable: ' + esc(p.reason || 'unknown'), 'bad');
  const all = messages.filter((m) => state.inboxTo === 'all' || m.to === state.inboxTo);
  const z = (l) => all.filter((m) => m.situation === l).length;
  return `${metrics([
    ['Messages', num(all.length), state.inboxTo === 'all' ? 'to every recipient' : 'to ' + esc(state.inboxTo)],
    ['Open', num(z('open')), 'younger than 48 hours'],
    ['Waiting too long', num(z('waiting')), 'older than 48 hours, not done'],
    ['Done', num(z('done')), 'replied, processed or closed'],
  ])}${p.human ? '' : note('No participant is marked human in .mem/config.json — so the inbox shows every recipient, and nothing can be answered from here. A recipient is not guessed. ' + esc(p.humanReason || ''))}${panel(
    'Messages',
    `<div class="toolbar"><select class="field" id="inboxTo" aria-label="Recipient"><option value="all" ${state.inboxTo === 'all' ? 'selected' : ''}>All recipients</option>${(p.participants || []).map((t) => `<option value="${esc(t.name)}" ${state.inboxTo === t.name ? 'selected' : ''}>${esc(t.name)}${p.human === t.name ? ' · human' : ''}</option>`).join('')}</select><input class="field searchfield" id="inboxQuery" placeholder="Subject, sender or name …" value="${esc(state.inboxQuery)}" aria-label="Filter messages"><label class="check"><input type="checkbox" id="inboxAll" ${state.inboxAll ? 'checked' : ''}> Include done</label></div><div id="inboxRows">${p.present === false && !messages.length ? empty('No inbox yet — the first message creates inbox/. <code class="mono">mem inbox write --to &lt;name&gt;</code> writes one.') : inboxRows()}</div>`,
    'Reading changes no delivery state. Acknowledging happens only on purpose.',
  )}<div style="margin-top:18px">${btn('Write a new message', 'new-message', '', 'primary')}</div>${note('Delivery happens through git (commit and push), as on the command line — never through this page. A reply lands as a new file in inbox/.')}${p.broken?.length ? note(`${num(p.broken.length)} messages not readable: ${p.broken.map((k) => esc(k.name)).join(', ')}`, 'bad') : ''}`;
}
async function showMessageLatest(name) {
  const m = messages.find((x) => x.name === name);
  if (!m) return;
  showInfo(esc(m.subject), `<p class="small muted">${esc(m.from)} → ${esc(m.to)} · ${esc(m.state)}</p><div class="loading compact"><span class="loading-core" aria-hidden="true"></span><p>Reading the message …</p></div>`);
  let b;
  try {
    const r = await fetch('/dashboard/message.json?name=' + encodeURIComponent(name), { credentials: 'same-origin', cache: 'no-store' });
    b = await r.json();
  } catch (e) {
    b = { state: 'error', reason: e?.message || String(e) };
  }
  if (!$('#info').open) return;
  if (b.state !== 'ok') {
    showInfo(esc(m.subject), note('Message not readable: ' + esc(b.reason || 'unknown'), 'bad'));
    return;
  }
  const msg = b.message;
  const mayAnswer = !state.readonly && b.human && msg.to === b.human;
  const whyNot = state.readonly ? 'Read only is active.' : !b.human ? 'No participant is marked human in .mem/config.json.' : msg.to !== b.human ? `Addressed to ${msg.to}, not to ${b.human} — only its recipient can answer or acknowledge it.` : '';
  const stateButtons = (D.inbox?.states || [])
    .filter((s) => s !== msg.state)
    .map((s) => btn(s === 'open' ? 'Reopen' : 'Mark as ' + s, 'inbox-state', `data-id="${esc(name)}" data-value="${esc(s)}" ${mayAnswer ? '' : 'disabled'}`, 'small ghost'))
    .join('');
  showInfo(
    esc(msg.subject || m.subject),
    `<p class="small muted">${esc(msg.from)} → ${esc(msg.to)} · ${esc(whenTime(msg.time))} · state ${esc(msg.state)}</p><span class="badge">${b.replies.length ? 'Answered message' : 'Message'}</span> ${badge(situationWord[m.situation] || m.situation)}<p class="detailtext">${esc(msg.text || '')}</p>${b.replies
      .map((x) => `<div class="callout good"><strong>${esc(x.from)} → ${esc(x.to)}</strong> <span class="small quiet">${esc(whenTime(x.time))} · ${esc(x.state)}</span><p style="white-space:pre-wrap">${esc(x.text)}</p></div>`)
      .join('')}<form id="replyForm" data-id="${esc(name)}"><label class="formfield">Reply to ${esc(msg.from)} (as ${esc(msg.to)})<textarea name="text" class="field" required ${mayAnswer ? '' : 'disabled'}></textarea></label><button class="btn primary" type="submit" ${mayAnswer ? '' : 'disabled'}>Store the reply</button></form>${whyNot ? `<p class="small quiet" style="margin-top:8px">${esc(whyNot)}</p>` : ''}<div class="drawer-actions">${stateButtons}</div>${note('The reply goes through POST /inbox/reply: the sender is always this message\'s recipient, never chosen freely; the subject becomes "Re: …". It is delivered with the next git commit and push.')}`,
  );
}
// Writing to /inbox/*, /setting and /task-forms: the server answers a
// success with a 303 to a page. `redirect: 'manual'` stops the redirect —
// a success is then the opaque redirect, every failure a short HTML page
// with the reason.
async function answerErrorText(r) {
  const t = await r.text().catch(() => '');
  const m = t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/back to the console/g, '').replace(/^\s*Not set\.\s*/, '').trim();
  return m || 'answer ' + r.status;
}
async function formPost(pathName, fields) {
  const r = await fetch(pathName, { method: 'POST', credentials: 'same-origin', redirect: 'manual', body: new URLSearchParams(fields), headers: { accept: 'text/html' } });
  if (r.type === 'opaqueredirect' || r.status === 303 || r.ok) return { ok: true };
  return { ok: false, reason: await answerErrorText(r) };
}
// The retrieval probe: POST rather than GET, because a question can be
// longer than a URL line — read-only anyway.
async function probeAsk(questionText) {
  const r = await fetch('/dashboard/probe.json', {
    method: 'POST', credentials: 'same-origin', body: new URLSearchParams({ question: questionText }),
    headers: { accept: 'application/json' },
  });
  let b = null;
  try { b = await r.json(); } catch { b = { state: 'error', reason: 'answer ' + r.status }; }
  return { ok: r.ok && b?.state === 'ok', ...b };
}
async function taskStart(fields) {
  const r = await fetch('/task', { method: 'POST', credentials: 'same-origin', body: new URLSearchParams(fields), headers: { accept: 'application/json' } });
  let b = null;
  try { b = await r.json(); } catch { b = { state: 'error', reason: await answerErrorText(r) }; }
  return { ok: r.status === 201, ...b };
}
async function taskCancel(kind) {
  const r = await fetch('/task/cancel', { method: 'POST', credentials: 'same-origin', body: new URLSearchParams({ kind }), headers: { accept: 'application/json' } });
  let b = null;
  try { b = await r.json(); } catch { b = { state: 'error', reason: await answerErrorText(r) }; }
  return { ok: r.ok, ...b };
}
async function taskRead(id) {
  const r = await fetch('/task.json?id=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' });
  try { return await r.json(); } catch { return { state: 'error', reason: 'answer ' + r.status }; }
}
// N9 parity: a verdict on ONE Today-card "to verify" candidate. The
// only effect (bin/mem-serve, POST /dashboard/verify-verdict,
// src/verifylog.mjs): one line appended OUTSIDE this memory. Never a
// write to the entry, never a write inside this repository.
async function verifyVerdictWrite(fields) {
  const r = await fetch('/dashboard/verify-verdict', { method: 'POST', credentials: 'same-origin', body: new URLSearchParams(fields), headers: { accept: 'application/json' } });
  let b = null;
  try { b = await r.json(); } catch { b = { state: 'error', reason: await answerErrorText(r) }; }
  return { ok: r.status === 201, ...b };
}
// N9 parity ("gold nebenbei"/"Rate today"): a verdict on ONE Today-card
// gold-question candidate. The only effect (bin/mem-serve, POST
// /dashboard/gold-verdict, src/goldlog.mjs): one line appended OUTSIDE
// this memory. Never a write to this repository, never the question
// text sent back.
async function goldVerdictWrite(fields) {
  const r = await fetch('/dashboard/gold-verdict', { method: 'POST', credentials: 'same-origin', body: new URLSearchParams(fields), headers: { accept: 'application/json' } });
  let b = null;
  try { b = await r.json(); } catch { b = { state: 'error', reason: await answerErrorText(r) }; }
  return { ok: r.status === 201, ...b };
}
async function taskOverview() {
  const r = await fetch('/task.json', { credentials: 'same-origin', cache: 'no-store' });
  try { return await r.json(); } catch { return null; }
}
async function waitForTask(id, { maxMs = 120000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const s = await taskRead(id);
    if (s.running !== true) return s;
    if (Date.now() - t0 > maxMs) return { ...s, state: 'unknown', reason: 'still running — see Operations › Tasks' };
    await new Promise((res) => setTimeout(res, 700));
  }
}

// --- Raw capture: review and delete by period, topic, project -----------------
let rawFilter = { state: 'all', query: '', since: '', until: '', project: 'all' };
let rawPicked = new Set();
const rawWord = { present: 'present', elsewhere: 'other machine', unreachable: 'unreachable', deleted: 'deleted' };
function filteredRaw() {
  const q = rawFilter.query.toLowerCase();
  return rawSamples.filter((r) => {
    const day = String(r.at || '').slice(0, 10);
    const proj = r.project ?? '(no project)';
    return (
      (state.project === 'all' || r.project === state.project) &&
      (rawFilter.project === 'all' || proj === rawFilter.project) &&
      (rawFilter.state === 'all' || r.state === rawFilter.state) &&
      (!q || (r.path + ' ' + proj + ' ' + (r.session || '') + ' ' + (r.surface || '') + ' ' + (r.topics || []).join(' ')).toLowerCase().includes(q)) &&
      (!rawFilter.since || (day && day >= rawFilter.since)) &&
      (!rawFilter.until || (day && day <= rawFilter.until))
    );
  });
}
function rawTally(list) {
  const b = {};
  for (const r of list) {
    const x = (b[r.state] ||= { n: 0, bytes: 0 });
    x.n += 1;
    x.bytes += r.bytes || 0;
  }
  return b;
}
function rawRows() {
  const rs = filteredRaw();
  const b = rawTally(rs);
  const head = `<div class="smallstats raw-tally"><span>${num(rs.length)} captures: ${Object.entries(b).map(([k, x]) => `${num(x.n)} ${esc(rawWord[k] || k)} (${mb(x.bytes)})`).join(' · ') || 'none'}</span><span>${rawPicked.size ? `${num(rawPicked.size)} selected` : ''}</span></div>`;
  return (
    head +
    (rs
      .slice(0, 50)
      .map(
        (r) =>
          `<div class="row"><div class="row-main">${r.state !== 'deleted' ? `<input type="checkbox" class="raw-pick" data-path="${esc(r.path)}" aria-label="Select capture" ${rawPicked.has(r.path) ? 'checked' : ''} ${state.readonly ? 'disabled' : ''}>` : '<span class="raw-pick-empty"></span>'}<div><strong>${esc(r.session || r.path.split('/').pop())} · ${esc((r.topics || []).slice(0, 3).join(', ') || 'no topic')}</strong><p>${esc(r.at ? whenTime(r.at) : 'no date')} · ${esc(r.project ?? 'no project')} · ${num(r.bytes)} bytes · ${num(r.lines)} lines${r.deleted ? ` · deleted: ${esc(r.deleted.reason || 'no reason')}` : ''}</p></div></div><div>${badge(rawWord[r.state] || r.state)}<div style="margin-top:8px">${btn('Review', 'raw-review', `data-id="${esc(r.path)}"`, 'small ghost')}</div></div></div>`,
      )
      .join('') || empty(rawSamples.length ? 'No capture matches these filters.' : 'No raw capture recorded yet — the stop hook writes one after every session.')) +
    limitNote(Math.min(50, rs.length), rs.length)
  );
}
// --- Raw capture export (dash-fix4) ----------------------------------------
// Before: the export studio held only two silently disabled buttons and a
// "read only" hint; a click did NOTHING, no message. Now the button starts
// the real task `export` (a child process of `mem raw export --into <dir>
// --json`, the same route as Operations › Tasks) and ALWAYS ends in a
// result: started/refused with a reason, then written/missing and the
// target folder on the server. There is deliberately no browser download:
// raw captures are unredacted and never leave the server.
function rawExportPanel() {
  return panel(
    'Raw capture export',
    `<p class="small muted">Decompresses every capture the record names into a new folder <strong>on the server</strong> (<code class="mono">tasks/&lt;id&gt;/export</code>). No download to the browser: raw captures are unredacted and never leave the server.</p><div class="drawer-actions">${btn('Export raw captures', 'raw-export', state.readonly ? 'aria-disabled="true"' : '', 'primary')}</div><div class="raw-export-state" role="status" aria-live="polite"></div>${state.readonly ? `<p style="margin-top:12px">${readonlyMark('mem raw export --into <dir>')}</p>` : ''}`,
    'Task "export" · child process of mem raw export',
  );
}
function rawExportShow(html) {
  $$('.raw-export-state').forEach((el) => { el.innerHTML = html; });
}
async function rawExport(el) {
  if (state.readonly) {
    const t = 'Raw capture export not started: read only is active. On the server: mem raw export --into <dir>';
    rawExportShow(note(esc(t), 'bad'));
    return toast(t);
  }
  if (el) el.disabled = true;
  rawExportShow('<p class="small muted">Starting …</p>');
  let s;
  try { s = await taskStart({ kind: 'export' }); } catch (e) { s = { ok: false, state: 'error', reason: 'network: ' + (e?.message || e) }; }
  if (!s.ok) {
    if (el) el.disabled = false;
    const why = reasonPlain(s.reason || s.state);
    rawExportShow(note('Raw capture export not started: ' + esc(why), 'bad'));
    return toast('Raw capture export not started: ' + why);
  }
  toast('Raw capture export started.');
  rawExportShow('<p class="small muted">Running … (no percentage measurable)</p>');
  let e;
  try { e = await waitForTask(s.id); } catch (x) { e = { state: 'unknown', reason: 'state not readable: ' + (x?.message || x) }; }
  if (el) el.disabled = false;
  const c = e.command || [];
  const target = c.includes('--into') ? c[c.indexOf('--into') + 1] : null;
  const written = Array.isArray(e.result?.written) ? e.result.written.length : null;
  const missing = Array.isArray(e.result?.missing) ? e.result.missing.length : null;
  const rows = [
    `<div class="row"><span class="small">State</span>${badge(e.state || 'unknown')}</div>`,
    `<div class="row"><span class="small">Written</span><span class="small">${written == null ? 'unknown' : num(written) + ' captures'}</span></div>`,
    `<div class="row"><span class="small">Missing</span><span class="small">${missing == null ? 'unknown' : num(missing) + ' captures'}</span></div>`,
    `<div class="row"><span class="small">Target folder (server)</span><span class="small mono" style="overflow-wrap:anywhere;min-width:0;text-align:right">${esc(target || 'unknown')}</span></div>`,
  ].join('');
  rawExportShow(rows + (e.reason ? note(esc(e.reason), e.state === 'ok' ? 'good' : e.state === 'warning' ? '' : 'bad') : ''));
  toast(`Raw capture export: ${e.state || 'unknown'}${written != null ? ` · ${written} written` : ''}${missing ? ` · ${missing} missing` : ''}${e.reason && e.state !== 'ok' ? ' · ' + e.reason : ''}`);
}
function rawPage() {
  const rf = D.raw || {};
  if (!rf.readable) return panel('Raw capture review', note('Raw capture not readable: ' + esc(rf.error || 'unknown') + ' — an empty list would be a false statement here.', 'bad'));
  const projects = [...new Set(rawSamples.map((r) => r.project ?? '(no project)'))].sort();
  return `${metrics([
    ['Captures', num(rawSamples.length), 'in the register'],
    ['Present', num(rf.counts?.present), 'bytes on this machine'],
    ['Other machine', num(rf.counts?.elsewhere), 'in another machine\'s store'],
    ['Deleted', num(rf.counts?.deleted), 'the tombstone stays in the register'],
  ])}${rawExportPanel()}<div style="height:18px"></div>${panel(
    'Raw capture review',
    `<div class="toolbar"><input class="field" id="rawQuery" value="${esc(rawFilter.query)}" placeholder="Topic or project" aria-label="Filter raw captures"><label class="small quiet">from <input class="field" type="date" id="rawSince" value="${esc(rawFilter.since)}" aria-label="Raw captures from date"></label><label class="small quiet">to <input class="field" type="date" id="rawUntil" value="${esc(rawFilter.until)}" aria-label="Raw captures to date"></label><select class="field" id="rawProject" aria-label="Raw capture project"><option value="all">All projects</option>${projects.map((p) => `<option ${rawFilter.project === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select><select class="field" id="rawState" aria-label="Raw capture state"><option value="all">All states</option>${['present', 'elsewhere', 'unreachable', 'deleted'].map((s) => `<option value="${s}" ${rawFilter.state === s ? 'selected' : ''}>${esc(rawWord[s])}</option>`).join('')}</select>${btn('Select hits', 'raw-select-all', state.readonly ? 'disabled' : '', 'ghost')}${btn('Delete selection …', 'raw-delete-preview', state.readonly ? 'disabled' : '', 'ghost danger')}</div><div id="rawRows">${rawRows()}</div>${note('Four states from the capture contract (mem raw review). A capture\'s topic is the tags of the entries digested from it. No automatic deletion date: deleting happens deliberately after review, with a reason, through "mem raw delete" — the tombstone stays in the register. Unreachable means recorded here with its bytes missing: a defect, not a decision.')}${state.readonly ? `<p>${readonlyMark('mem raw delete <path> --reason "…" --yes')}</p>` : ''}`,
    `${mb(rf.bytes)} in the register · by project: ${(rf.projects || []).map((p) => `${esc(p.project ?? 'none')} ${num(p.count)}`).join(' · ') || '—'}`,
  )}`;
}
function rawReview(path) {
  const r = rawSamples.find((x) => x.path === path);
  if (!r) return;
  const es = (r.entries || []).map(byId).filter(Boolean);
  showInfo(
    'Review · ' + esc(r.session || path.split('/').pop()),
    `<p class="muted">${esc(r.project ?? 'no project')} · ${esc((r.topics || []).join(', ') || 'no topic')} · ${esc(rawWord[r.state] || r.state)}</p><div class="row"><span>Path</span><span class="mono small">${esc(r.path)}</span></div><div class="row"><span>Captured</span><span>${esc(r.at ? whenTime(r.at) : 'no date')}</span></div><div class="row"><span>Surface / session</span><span>${esc(r.surface || '—')} / ${esc(r.session || '—')}</span></div><div class="row"><span>Lines / bytes</span><span>${num(r.lines)} / ${num(r.bytes)}</span></div>${r.deleted ? `<div class="row"><span>Deleted</span><span>${esc(r.deleted.at || '')} · ${esc(r.deleted.reason || 'no reason')} (${esc(r.deleted.by || '—')})</span></div>` : ''}<div class="row"><span>Digested from it</span><strong>${num(es.length)} entries</strong></div>${entryRows(es.slice(0, 8), 'No entry was digested from this capture.')}${
      r.state === 'elsewhere' ? note('The bytes live, according to the register, on another machine (its store). They are readable only there ("mem raw show").') : r.state === 'unreachable' ? note('Recorded, bytes not reachable right now.', 'bad') : ''
    }${r.state !== 'deleted' ? `<div class="drawer-actions">${btn('Delete preview', 'raw-delete-preview', `data-id="${esc(r.path)}" ${state.readonly ? 'disabled' : ''}`, 'ghost danger')}</div>` : ''}`,
  );
}
function rawDeletePreview(paths) {
  const list = paths.map((w) => rawSamples.find((r) => r.path === w)).filter((r) => r && r.state !== 'deleted');
  if (!list.length) return toast('Nothing selected that could be deleted.');
  const max = 50;
  const part = list.slice(0, max);
  const bytes = part.reduce((n, r) => n + (r.bytes || 0), 0);
  const affected = part.reduce((n, r) => n + (r.entries || []).length, 0);
  showInfo(
    'Delete preview · ' + num(part.length) + (part.length === 1 ? ' capture' : ' captures'),
    `<p class="muted">The bytes of ${num(part.length)} captures would be removed (${mb(bytes)} according to the register). The register keeps a tombstone; ${num(affected)} entries digested from them keep their origin pointer. The originals are not readable afterwards — this cannot be undone.</p>${list.length > max ? note(`Only the first ${max} of ${num(list.length)} are deleted; select again afterwards.`) : ''}<div style="max-height:180px;overflow:auto;margin:12px 0">${part.map((r) => `<p class="small mono" style="padding:3px 0">${esc(r.path)} · ${num(r.bytes)} B · ${esc(rawWord[r.state])}</p>`).join('')}</div><form id="rawDeleteForm" data-paths="${esc(JSON.stringify(part.map((r) => r.path)))}"><label class="formfield">Reason (required — it stands in the tombstone)<input class="field" name="reason" required minlength="3" maxlength="500"></label><label class="check"><input type="checkbox" name="yes" required> I have checked the list; the bytes are removed for good.</label><button class="btn danger" type="submit">Delete for good</button></form><div id="rawDeleteState"></div>${note('Deleted per capture through the task "raw-delete" (mem raw delete --yes), one after the other, behind the same gate as every task.')}`,
  );
}
async function rawDelete(paths, reason) {
  const out = $('#rawDeleteState');
  let ok = 0, failed = 0;
  for (const [i, p] of paths.entries()) {
    out.innerHTML = `<p class="small muted">${i + 1} / ${paths.length} · ${esc(p)}</p><div class="statbar"><i style="width:${Math.round((i / paths.length) * 100)}%"></i></div>`;
    const s = await taskStart({ kind: 'raw-delete', path: p, reason });
    if (!s.ok) {
      failed += 1;
      out.insertAdjacentHTML('beforeend', note(esc(p) + ': ' + esc(s.reason || 'refused'), 'bad'));
      if (/origin|host|Writing is off|write/i.test(s.reason || '')) break;
      continue;
    }
    const e = await waitForTask(s.id);
    if (e.state === 'ok') ok += 1;
    else {
      failed += 1;
      out.insertAdjacentHTML('beforeend', note(esc(p) + ': ' + esc(e.reason || e.state), e.state === 'warning' ? '' : 'bad'));
    }
  }
  rawPicked = new Set();
  toast(`${ok} deleted${failed ? `, ${failed} not` : ''}. Tombstones stand in the register.`);
  if (await loadData({ quiet: true })) render();
}

// --- Tasks (real: /task, /task.json, /task/cancel) ------------------------------
let taskTimer = 0;
function taskState(v) {
  if (!v) return 'ready';
  if (v.running === true) return 'running';
  if (v.running === 'unknown') return 'unknown';
  if (v.cancelled) return 'cancelled';
  return v.state === 'ok' ? 'finished' : v.state;
}
const TASK_STARTABLE = ['export', 'integrity'];
// no-jump point 6: the pieces per task kind, computed once — used by
// operationsPage() for the first draw AND by taskUpdate() for the quiet
// 2 s repatch, without redrawing the whole page.
function taskPieces(k, a) {
  const running = D.tasks?.running || {};
  const v = running[k];
  const z = taskState(v);
  const text =
    z === 'running' ? esc(v.progress || 'Running · no progress measurable')
      : z === 'cancelled' ? 'End of process confirmed · ' + esc(whenTime(v.ended))
        : z === 'unknown' ? esc(v.reason || 'Run state no longer known')
          : z === 'ready' ? 'Never started.'
            : `${esc(whenTime(v.ended || v.started))}${v.reason ? ' · ' + esc(v.reason) : ''}`;
  const button = TASK_STARTABLE.includes(k)
    ? btn(z === 'running' ? 'Running …' : 'Start', 'operation-step', `data-value="${k}" ${state.readonly || z === 'running' ? 'disabled' : ''}`, 'primary')
    : `<span class="small quiet">${k === 'raw-delete' ? 'Started in Raw capture, per capture' : 'Started at the entry (detail)'}</span>`;
  return {
    z, orbitRunning: z === 'running', orbitGlyph: z === 'running' ? '↻' : z === 'finished' ? '✓' : '◇', text,
    actions: `${button}${z === 'running' ? btn('Cancel', 'operation-stop', `data-value="${k}" ${state.readonly ? 'disabled' : ''}`, 'ghost') : ''}`,
  };
}
function operationsPage() {
  const kinds = D.tasks?.kinds || {};
  return `<div class="grid three">${Object.entries(kinds)
    .map(([k, a]) => {
      const t = taskPieces(k, a);
      return panel(
        esc(a.title),
        `<span id="task-mark-${k}">${badge(t.z)}</span><div id="task-orbit-${k}" class="operation-orbit ${t.orbitRunning ? 'running' : ''}"><i></i><b>${t.orbitGlyph}</b></div><p id="task-text-${k}" class="small muted" style="min-height:48px">${t.text}</p><div id="task-actions-${k}" class="drawer-actions">${t.actions}</div>`,
        esc(a.description),
      );
    })
    .join('')}</div>${note('Every task is a child process of the existing CLI command. None of them reports phases, so no percentage is invented. Resume means: start again from the beginning.')}<div class="toolbar">${btn('Read the state again', 'operation-refresh', '', 'ghost')}${btn('Task log', 'audit', '', 'ghost')}</div>`;
}
// no-jump: patches ONLY the status pieces per task kind (mark, orbit,
// text, button row) — no render(), so no jump, while a running task is
// polled every 2 s. If the "Tasks" tab is not open, these elements don't
// exist (id not found) — nothing happens then either, which is correct:
// nothing to patch.
function taskUpdate() {
  const kinds = D.tasks?.kinds || {};
  for (const [k, a] of Object.entries(kinds)) {
    const markEl = document.getElementById('task-mark-' + k);
    if (!markEl) continue;
    const t = taskPieces(k, a);
    markEl.innerHTML = badge(t.z);
    const orbitEl = document.getElementById('task-orbit-' + k);
    if (orbitEl) {
      orbitEl.className = 'operation-orbit' + (t.orbitRunning ? ' running' : '');
      const b = orbitEl.querySelector('b');
      if (b) b.textContent = t.orbitGlyph;
    }
    const textEl = document.getElementById('task-text-' + k);
    if (textEl) textEl.innerHTML = t.text;
    const actionsEl = document.getElementById('task-actions-' + k);
    if (actionsEl) actionsEl.innerHTML = t.actions;
  }
}
function taskPolling() {
  clearTimeout(taskTimer);
  const busy = Object.values(D?.tasks?.running || {}).some((v) => v && v.running === true);
  if (!busy) return;
  taskTimer = setTimeout(async () => {
    const u = await taskOverview();
    if (u?.running && D) {
      D.tasks.running = u.running;
      // no-jump point 6: patch the status pieces only, never render() —
      // otherwise the whole page would jump every 2 s while a task runs.
      taskUpdate();
    }
    taskPolling();
  }, 2000);
}

// --- Diagnosis ------------------------------------------------------------------
function doctorPage() {
  const ds = D.doctor || {};
  const fnd = ds.result?.findings || [];
  const sum = ds.result?.summary || {};
  const rank = { error: 0, warn: 1, unknown: 2, good: 3 };
  const sorted = [...fnd].sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9));
  const notGood = sorted.filter((b) => b.level !== 'good'), good = sorted.filter((b) => b.level === 'good');
  const line = (b) => `<div class="row"><div><strong>${esc(b.name)}</strong><p>${esc(b.text)}${b.advice ? ` → ${esc(b.advice)}` : ''}</p></div>${badge(levelWord[b.level] || b.level)}</div>`;
  const inv = D.invariants || {};
  const et = (D.system || []).find((k) => k.id === 'errors');
  return (
    panel(
      'Findings & next steps',
      `${(D.system || []).map((k) => `<div class="row"><div><strong>${esc(k.title)}</strong><p>${esc(k.line)}</p></div>${badge(k.state === 'calm' ? 'calm' : k.state === 'watch' ? 'watch' : k.state === 'alarm' ? 'alarm' : 'unknown', k.word)}</div>`).join('')}<div class="sectionline"><h2>Doctor · ${num(fnd.length)} findings</h2><span class="small quiet">${num(sum.good)} good · ${num(sum.warn)} warning · ${num(sum.error)} error · ${num(sum.unknown)} unknown</span></div>${notGood.map(line).join('') || empty('No finding other than "good".')}${good.length ? `<details class="accordion"><summary>${num(good.length)} findings good</summary>${good.map(line).join('')}</details>` : ''}${fnd.length ? '' : note('No doctor state readable — no green check is invented. ' + esc(ds.reason || ''), 'bad')}<div class="drawer-actions">${btn('Storage & drawers', 'goto-shards', '', 'ghost')}${btn('Task log', 'audit', '', 'ghost')}</div>`,
    ) +
    `<div class="grid two" style="margin-top:18px">${panel(
      'Findings with age & origin',
      `<div class="row"><span>Doctor catalogue</span><b>${num(fnd.length)} findings</b></div><div class="row"><span>Computed at</span><span>${esc(whenTime(ds.computedAt))}</span></div><div class="row"><span>Age / from cache</span><span>${ds.ageMin != null ? num(Math.round(ds.ageMin)) + ' min' : '—'} / ${ds.fromCache ? 'yes' : 'no'}</span></div><div class="row"><span>Error classes (window)</span>${et ? `<span class="small">${esc(et.line)}</span>` : badge('unknown')}</div>${note('Every finding delivered stands above, sorted by severity. Unreadable values stay unknown. UNKNOWN ranks below good: a check that cannot measure here does not lower the grade.')}`,
    )}${panel(
      'Agreement across both houses',
      inv.measurable
        ? `<div class="row"><span>Shared invariants</span><span>${num(inv.count)}${inv.broken ? ` · ${num(inv.broken)} broken lines` : ''}</span></div><div class="row"><div><span>Finding parity</span><p class="small quiet">${esc(inv.parity?.text || 'not reported')}</p></div>${badge(inv.parity ? levelWord[inv.parity.level] || inv.parity.level : 'unknown')}</div><p class="small quiet">shared/invariants.jsonl — each house tests the same invariant in its own language. cheap-mem keeps its C mark and its English surface.</p>`
        : `<div class="row"><span>Invariants</span>${badge('unknown')}</div><p class="small quiet">${esc(inv.reason || 'not measurable')}</p>`,
    )}</div>`
  );
}

// --- Performance ------------------------------------------------------------------
function hookTimeBadge(h) {
  if (!h || !h.measured || h.p50 == null) return badge('unknown', h?.reason || (h?.measured ? `only ${num(h.measured)} timed line(s) — too few for a percentile` : 'no timed line yet'));
  return `<span class="small mono">${num(h.p50)} / ${num(h.p95)} ms</span>`;
}
function hookTimePanel() {
  const h = D.performance?.hook || {};
  const lf = h.finding;
  const budget = (h.budget || []).map((r) => `<div class="row"><span>${esc(occasionName(r.occasion))}</span><span class="small">${r.level === 'unknown' ? `${num(r.n)} of 20 timed lines needed` : `p50 ${num(r.p50)} · p95 ${num(r.p95)} ms of ${num(r.budget)} ms budget (n=${num(r.n)})`}</span>${badge(levelWord[r.level] || r.level)}</div>`).join('');
  const days = (h.perDay || []).length
    ? `<div class="tablewrap"><table class="table"><thead><tr><th>Day</th><th>Timed recalls</th><th>p50 ms</th><th>p95 ms</th><th>max ms</th></tr></thead><tbody>${h.perDay.map((d) => `<tr><td class="mono">${esc(d.day)}</td><td>${num(d.n)}</td><td>${num(d.p50)}</td><td>${num(d.p95)}</td><td>${num(d.max)}</td></tr>`).join('')}</tbody></table></div>`
    : empty(esc(h.reason || 'No timed recall in the last 14 days.') + ' A day without a measurement is not 0 ms.');
  return panel(
    'Hook time per day',
    `${days}<div style="margin-top:14px">${budget}</div>${lf ? `<div class="row"><div><strong>Doctor: hook-latency</strong><p>${esc(lf.text)}</p></div>${badge(levelWord[lf.level] || lf.level)}</div>` : ''}${note('Wall time of the process that booked each line (mem find --journal-session), from the injection journal. The budget lives in src/latencybudget.mjs; under 20 timed lines an occasion reads unknown, never good.')}`,
    'How long the recall hook really takes',
  );
}
function performancePage() {
  const p = D.performance || {};
  return `${hookTimePanel()}<div style="margin-top:18px">${panel(
    'Scale gate · 1M / 5M / 10M',
    `<div class="row"><span>Gate</span>${badge('not available', 'not available in cheap-mem, by design')}</div><p class="small muted" style="margin-top:12px">${esc(p.gate?.reason || '')}</p>`,
  )}</div>${weeklyPanel()}`;
}
// The weekly measurement series (src/measurements.mjs): one line per ISO
// week, capped at 52, written by the running server — never a curve
// invented for the mockup. A missing file is honestly empty, never a
// line of zeros.
function weeklyPanel() {
  const p = D.performance || {};
  const wm = p.weeks || {};
  const weeks = wm.weeks || [];
  return `<div class="grid two" style="margin-top:20px">${panel(
    'Weekly measurement · real series',
    weeks.length ? weeklyHtml(weeks, p.metrics || []) : empty(wm.readable === false ? `Not readable: ${esc(wm.reason || '')}.` : 'No week measured yet — the running server (mem serve) records one line per week in .mem/measurements.jsonl.'),
    `one line per ISO week, at most ${num(wm.cap || 52)} · never an invented curve`,
  )}${panel(
    'Scale gate · 1M/5M/10M',
    `<div class="row"><span>Gate watcher</span>${badge('not available', 'not available in cheap-mem, by design')}</div><p class="small quiet">${esc(p.gate?.reason || '')}</p>`,
  )}</div>`;
}
function weeklyHtml(weeks, defs) {
  const ids = defs.length ? defs.map((d) => d.id) : [...new Set(weeks.flatMap((w) => Object.keys(w.metrics || {})))];
  const title = new Map(defs.map((d) => [d.id, d.title]));
  const show = (k) => (!k || k.value == null ? badge('unknown') : esc(num(k.value)));
  return `<div class="tablewrap"><table class="table"><thead><tr><th>Week</th>${ids.map((id) => `<th>${esc(title.get(id) || id)}</th>`).join('')}</tr></thead><tbody>${weeks
    .map((w) => `<tr><td class="mono">${esc(w.week)}</td>${ids.map((id) => `<td>${show(w.metrics?.[id])}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>${note(`${num(weeks.length)} weeks read from .mem/measurements.jsonl. A value missing in a week reads "unknown" — never 0.`)}`;
}

// --- Project state ------------------------------------------------------------
function projectstatePage() {
  const g = D.meta?.git || {};
  const c = D.meta?.code || {};
  const sources = [
    ['Knowledge, topics, facts', 'dashboard.collect() + readPass()', 'src/dashboard.mjs', 'entries, links, excerpts'],
    ['Knowledge space (3D)', 'the same entries + net.mjs (drawers, pairs)', 'src/net.mjs', 'energy cores: brightness from the injection journal'],
    ['Evidence trail (detail)', '/dashboard/entry.json · backlink index (D1b)', 'src/backlinks.mjs', 'with the index\'s own state'],
    ['Duties & questions', 'memory.openDuties · question.open', 'src/memory.mjs', 'open is decided by the drawer, not the surface'],
    ['Agents', 'agents.mjs · heartbeat.mjs · inbox', 'src/dashboard.mjs', 'alive only from two sources (D5)'],
    ['Inbox', 'inbox.read · /dashboard/message.json · POST /inbox/reply, /inbox/state', 'src/inbox.mjs', 'reply and acknowledge behind the write gate'],
    ['Raw capture', 'raw.capturesWithState · task raw-delete', 'src/raw.mjs', 'review and delete'],
    ['Diagnosis', 'doctor.checkAll (cached a minute) · board · invariants', 'src/doctor.mjs', 'findings with age and cache'],
    ['Tasks', '/task · /task.json · /task/cancel', 'src/tasks.mjs', 'child processes of the CLI'],
    ['Settings', 'POST /setting · console.SETTINGS', 'src/console.mjs', 'raw-archive, error-window, quiet-hours, core-name'],
    ['Weekly series', '.mem/measurements.jsonl', 'src/measurements.mjs', 'one line per ISO week, capped at 52'],
  ];
  return `${metrics([
    ['Code', esc(c.version || '—'), `${esc(c.headNow || 'not a git checkout')}`],
    ['CLI commands', D.catalog?.cli ? num(D.catalog.cli.length) : '—', 'counted from the CLI tables'],
    ['MCP definitions', num((D.catalog?.mcp?.reading || []).length + (D.catalog?.mcp?.writing || []).length), 'client visibility checked separately'],
    ['Live connection', 'Yes', 'mem serve · ' + esc(whenTime(D.at))],
  ])}${panel(
    'Where every view reads from',
    sources.map(([name, route, file, text]) => `<div class="row"><div><span class="badge good">connected</span><h3 style="margin:8px 0">${esc(name)}</h3><p>${esc(route)} — ${esc(text)}</p><p style="margin-top:8px" class="mono small quiet">${esc(file)}</p></div></div>`).join(''),
    'State ' + esc(whenTime(D.at)) + ' · memory ' + esc(g.head || '—'),
  )}<div class="grid two" style="margin-top:18px">${panel(
    'Technology of this surface',
    `<p class="small muted">The knowledge space shows every node as an energy core with plasma filaments; relations run bundled in one draw call. A light fog surrounds all nodes as an orientation hull; zooming in, it parts to the sides.</p><p class="small quiet" style="margin-top:12px">Canvas, WebGL and CSS. three.js r180 and DM Sans are vendored in the package (NOTICE); nothing is loaded from outside.</p>`,
  )}${panel(
    'Limits of this surface',
    `<p class="muted small">New entries, corrections, discarding and new messages are written by the command line only today — that is where the checks sit. This page shows them visibly as "read only". Cores and background effects are visual aids; only stored links carry a relation.</p>`,
  )}</div>`;
}

// --- The brain network (the mockup's Neural Atlas, fed by real data) ---------
//
// Built as in the mockup: a folded, decorative brain hull (no data), a
// shared core, the project cores (the mockup's "shards"), groups that
// open through subgroups down to the single entry, bundled edges with an
// arrow and a wandering point of light.
//
// Enhanced (the sibling's wish of 2026-09-27): every sphere is an energy
// core — white-hot centre, corona, slowly pulsing (4–6 s, offset per
// node), close/hovered with plasma filaments and orbits of light. All in
// ONE shader on point billboards: one draw call for every node, the
// pulse runs through `uTime` in the shader, not in JS.
// The brightness carries meaning: in how many sessions the entry was
// injected (the injection journal). Never shown = faint, not measurable
// = a matte grey core without a pulse — never the same as "rarely".
//
// An EMPTY memory (a fresh install) draws one calm, pulsing shared core
// and says where the first entries will appear — an intentional state,
// not a broken canvas.
const graphModes = {
  storage: 'Projects & drawers',
  topics: 'Topics',
  relations: 'Relation bundles',
  structure: 'Entry types',
  overview: 'Overview · drawer pairs',
  trail: 'Evidence trail · one entry',
};
const camera = { zoom: 1, angle: 0.47, tilt: 0.4, panX: 0, panY: 0, focus: null, cell: null };
let graphAPI = null;
const neuralPalette = ['#bce7a1', '#88d8cd', '#99bde9', '#c9afea', '#e4c38d', '#e3a5b1', '#a9d4c1'];
function allEdges(es = entries) {
  const rows = [];
  for (const e of es) for (const [kind, id] of e.rels) rows.push({ from: e.id, to: id, kind, record: e.id });
  return rows;
}
function trailCenter(es) {
  const ids = new Set(es.map((e) => e.id));
  if (state.trail && ids.has(state.trail)) return byId(state.trail);
  let best = null, n = -1;
  for (const e of es) {
    const k = e.rels.filter((r) => ids.has(r[1])).length + (incomingIndex.get(e.id) || []).filter((x) => ids.has(x.id)).length;
    if (k > n) { n = k; best = e; }
  }
  return best;
}
function graphListEntries() {
  const es = scoped();
  if (state.graphMode === 'trail') {
    const c = trailCenter(es);
    if (!c) return [];
    const nb = [...c.rels.map((r) => byId(r[1])), ...(incomingIndex.get(c.id) || []).map((x) => byId(x.id))].filter(Boolean);
    return [c, ...new Map(nb.map((e) => [e.id, e])).values()];
  }
  if (camera.focus && graphAPI?.inspect) {
    const g = graphAPI.inspect().model.groups.find((x) => x.key === camera.focus);
    if (g) return g.members;
  }
  return es;
}
function graphModel(es, mode) {
  const ids = new Set(es.map((e) => e.id)),
    edges = allEdges(es).filter((e) => ids.has(e.to)),
    adj = new Map(es.map((e) => [e.id, new Set()]));
  edges.forEach((e) => {
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  });
  const groups = [],
    assignment = new Map();
  const projectCount = new Map();
  for (const e of es) projectCount.set(e.project, (projectCount.get(e.project) || 0) + 1);
  const shards = [...projectCount]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p], i) => ({ key: 'shard:' + p, label: p, shard: p, color: neuralPalette[i % 7], members: es.filter((e) => e.project === p) }));
  const positions = [
    [-0.64, 0.46, 0.45],
    [0.64, 0.4, 0.39],
    [-0.7, 0.2, -0.46],
    [0.69, 0.15, -0.47],
    [-0.51, -0.49, 0.19],
    [0.54, -0.48, 0.18],
  ];
  const position = (i, n) => {
    if (n <= 6) return { x: positions[i][0], y: positions[i][1], z: positions[i][2] };
    const j = Math.floor(i / 2),
      side = i % 2 ? 1 : -1,
      a = j * 2.399963;
    return { x: side * (0.48 + 0.18 * Math.sin(a)), y: 0.66 - (1.22 * j) / Math.max(1, Math.ceil(n / 2) - 1), z: Math.cos(a) * 0.49 };
  };
  shards.forEach((s, i) => (s.center = position(i, shards.length)));
  function add(key, label, members, extra = {}) {
    if (!members.length) return;
    const g = { key, label, members, color: neuralPalette[groups.length % 7], ...extra };
    groups.push(g);
    members.forEach((e) => assignment.set(e.id, g));
  }
  if (mode === 'topics') {
    let remaining = es.slice();
    while (remaining.length) {
      if (groups.length === 5) {
        add('other-topics', 'Other topics', remaining);
        break;
      }
      const counts = new Map();
      remaining.forEach((e) => new Set(e.tags).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
      const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0];
      if (!best) {
        add('untagged', 'No topic', remaining);
        break;
      }
      add('tag:' + best[0], best[0], remaining.filter((e) => e.tags.includes(best[0])));
      remaining = remaining.filter((e) => !assignment.has(e.id));
    }
  } else if (mode === 'relations') {
    // As in the mockup: repeatedly the entry with the most still-free
    // neighbours plus its neighbours. With real amounts capped at seven
    // bundles; the rest stays complete in two collecting groups.
    const remaining = new Set(es.map((e) => e.id));
    while (remaining.size) {
      if (groups.length === 7) {
        const rest = es.filter((e) => remaining.has(e.id));
        const linked = rest.filter((e) => [...adj.get(e.id)].length);
        add('ref-rest', 'Other relations', linked);
        add('isolated', 'No internal relations', rest.filter((e) => !adj.get(e.id).size));
        break;
      }
      let top = null, n = 0;
      for (const id of remaining) {
        let k = 0;
        for (const x of adj.get(id)) if (remaining.has(x)) k++;
        if (k > n || (k === n && top && id < top)) { n = k; top = id; }
      }
      if (!top || !n) {
        add('isolated', 'No internal relations', es.filter((e) => remaining.has(e.id)));
        break;
      }
      const members = [byId(top), ...[...adj.get(top)].filter((id) => remaining.has(id)).map(byId)].filter(Boolean);
      add('ref:' + top, byId(top).title, members);
      members.forEach((e) => remaining.delete(e.id));
    }
  } else if (mode === 'storage' || mode === 'overview') shards.forEach((s) => add(s.key, s.label, s.members, { color: s.color, project: s.shard }));
  else if (mode === 'trail') {
    const c = trailCenter(es);
    if (c) {
      const out = c.rels.map((r) => ({ e: byId(r[1]), kind: r[0], dir: 'out' })).filter((x) => x.e && ids.has(x.e.id));
      const inc = (incomingIndex.get(c.id) || []).map((x) => ({ e: byId(x.id), kind: x.kind, dir: 'in' })).filter((x) => x.e && ids.has(x.e.id));
      const members = [c, ...new Map([...out, ...inc].map((x) => [x.e.id, x.e])).values()];
      add('trail:' + c.id, c.title, members, { trail: { c, out, inc } });
    }
  } else
    [...new Set(es.map((e) => e.type))].sort().forEach((t) => add('type:' + t, types[t] || t, es.filter((e) => e.type === t)));
  function splitCells(members, origin, radius, group, parent, depth = 0) {
    if (members.length <= 28) return [];
    const size = Math.ceil(members.length / Math.min(12, Math.ceil(members.length / 18))),
      count = Math.ceil(members.length / size),
      out = [];
    for (let start = 0; start < members.length; start += size) {
      const j = out.length,
        a = j * 2.399963,
        y = 1 - (2 * (j + 0.5)) / count,
        r = Math.sqrt(1 - y * y) * radius,
        cell = {
          key: parent + ':part:' + j,
          label: 'Subgroup ' + (j + 1),
          members: members.slice(start, start + size),
          center: { x: origin.x + Math.cos(a) * r, y: origin.y + y * radius, z: origin.z + Math.sin(a) * r },
          parent, group, depth, radius: radius * 0.3,
        };
      cell.cells = splitCells(cell.members, cell.center, cell.radius, group, cell.key, depth + 1);
      out.push(cell);
    }
    return out;
  }
  // Projects open first into their DRAWERS (project × type), only below
  // that into numbered subgroups — the real storage hierarchy.
  function drawerCells(g, alwaysAggregate) {
    if (!alwaysAggregate && g.members.length <= 28) return [];
    const byType = new Map();
    for (const e of g.members) {
      if (!byType.has(e.type)) byType.set(e.type, []);
      byType.get(e.type).push(e);
    }
    const kinds = [...byType].sort((a, b) => b[1].length - a[1].length);
    const count = kinds.length;
    return kinds.map(([type, members], j) => {
      const a = j * 2.399963,
        y = count === 1 ? 0 : 1 - (2 * (j + 0.5)) / count,
        r = Math.sqrt(Math.max(0, 1 - y * y)) * g.radius;
      const cell = {
        key: g.key + ':drawer:' + type,
        label: types[type] || type,
        drawer: g.project + '/' + type,
        members,
        center: { x: g.center.x + Math.cos(a) * r, y: g.center.y + y * g.radius, z: g.center.z + Math.sin(a) * r },
        parent: g.key, group: g.key, depth: 0, radius: g.radius * 0.3,
      };
      cell.cells = alwaysAggregate ? [] : splitCells(members, cell.center, cell.radius, g.key, cell.key, 1);
      return cell;
    });
  }
  groups.forEach((g, i) => {
    g.center = mode === 'trail' ? { x: 0, y: 0, z: 0 } : position(i, groups.length);
    g.radius = mode === 'trail' ? 0.62 : groups.length > 8 ? 0.19 : 0.29;
    g.cells = mode === 'trail' ? [] : mode === 'storage' ? drawerCells(g, false) : mode === 'overview' ? drawerCells(g, true) : splitCells(g.members, g.center, g.radius, g.key, g.key);
  });
  return { groups, assignment, edges, shards, records: es, mode };
}
function graphCaption() {
  return {
    storage: 'One memory, spread over projects and their drawers (project × type). The shared core connects the project cores. Topics are independent of that.',
    topics: 'Up to six topic bundles from shared tags. "Other topics" collects the rest for the overview only; every tag stays on its entry.',
    relations: 'A point of reference and its direct neighbours form a relation bundle. Every stored cross-relation is kept.',
    structure: 'Grouped by entry type within the same cheap-mem memory.',
    overview: 'Overview: every drawer a sphere, every tube a drawer pair from net.mjs — explicitly an aggregation, not a single edge.',
    trail: 'Evidence trail: one entry in the middle, on the right where it points, on the left what points at it. "Show in the network" in the detail picks the entry.',
  }[state.graphMode];
}
function recallLegend() {
  const a = D?.recall;
  return a?.measurable
    ? `Brightness = sessions with an injection (injection journal since ${when(a.since)})`
    : 'Brightness not measurable: ' + esc(a?.reason || 'no injection journal');
}
function brainBlock(large = false) {
  const es = scoped();
  const ks = new Set(es.map((e) => drawerOf(e))).size;
  const emptyHint = es.length ? '' : `<div class="graph-empty" role="note"><strong>Your first entries will appear here.</strong><span>One calm core is waiting. Every entry you log becomes an energy core around it — <code class="mono">mem log learning "…"</code></span></div>`;
  return `<article class="panel brain-panel neural-v4 ${large ? 'network-large' : ''}"><div class="brain-top"><div><div class="label">${esc(coreName())} / NEURAL ATLAS</div><h2>One memory. Many stores.</h2><p>${num(es.length)} entries incl. history · ${num(ks)} drawers · one shared knowledge structure</p></div>${btn(state.motion ? 'Ⅱ' : '▶', 'motion', 'aria-label="Toggle motion"', 'small ghost')}</div><div class="graph-tools"><select id="graphModeSelect" aria-label="Bundle the network by"><optgroup label="Knowledge network">${['storage', 'topics', 'relations', 'structure']
    .map((k) => `<option value="${k}" ${state.graphMode === k ? 'selected' : ''}>${graphModes[k]}</option>`)
    .join('')}</optgroup><optgroup label="Further modes">${['overview', 'trail'].map((k) => `<option value="${k}" ${state.graphMode === k ? 'selected' : ''}>${graphModes[k]}</option>`).join('')}</optgroup></select><div class="zoom-tools"><button data-action="graph-fullscreen" aria-label="Knowledge space in full screen" title="Full screen · Escape to close"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg></button><button data-action="graph-zoom-out" aria-label="Zoom out">−</button><output id="graphZoom" aria-live="polite">100%</output><button data-action="graph-zoom-in" aria-label="Zoom in">+</button><button data-action="graph-reset" aria-label="Fit the whole network" title="Whole view · right click or 0">↺</button></div></div><div class="graph-context"><button data-action="graph-reset" class="atlas-back" hidden>← Whole view</button><span id="graphBreadcrumb" aria-live="polite">${esc(coreSlug())} / all projects</span><span class="atlas-mode">3D · PERSPECTIVE</span></div><div class="brain-viewport"><canvas id="brain" class="brain-canvas" tabindex="0" aria-label="Spatial knowledge network. Click a group to fly in, click an entry in focus to open it. Right click or zero resets the view. Drag rotates, shift and drag pans, plus and minus zoom."></canvas><div id="graphLabels" class="graph-labels"></div><div id="graphHover" class="graph-hover" role="status" hidden></div>${emptyHint}<div class="atlas-axis" aria-hidden="true"><i></i><span>X</span><span>Y</span><span>Z</span></div><div class="graph-fallback" hidden>3D is not available here. Every entry and every link stays reachable through the lists below the view.</div></div><div class="brain-bottom"><span id="graphEdgeCount"></span><span class="core-legend" title="${recallLegend()}"><i class="cl-bright"></i>often injected<i class="cl-faint"></i>never<i class="cl-matte"></i>not measurable</span><span class="graphhint">Left click: focus · Right click: everything · Drag: rotate</span></div></article><div class="cluster-strip" id="graphGroups" aria-label="Focus groups"></div><p class="graph-description">${graphCaption()}<br>${recallLegend()}. Solid strands = stored relations; dashed branches = the storage hierarchy. The light fog is a decorative orientation hull around all nodes, not entries; its glitter only reflects the light of the cores. Large groups open through drawers and subgroups down to the single entry. Bundled strands keep every relation; the list shows them one by one. Touch: tap, zoom with two fingers; "Whole view" leads back.</p>`;
}

// The energy-core shader. One point per node; `aBright` < 0 means "not
// measurable" (matte core, no pulse). `uMotion` 0 holds everything still.
const CORE_VS = `
uniform float uTime; uniform float uScale; uniform float uMotion; uniform float uHover;
attribute vec3 aColor; attribute float aSize; attribute float aBright; attribute float aPhase; attribute float aDetail; attribute float aDim; attribute float aKind;
varying vec3 vColor; varying float vBright; varying float vPhase; varying float vDetail; varying float vDim; varying float vKind; varying float vPx; varying float vFog;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float px = aSize * uScale / max(0.0001, -mv.z);
  vPx = px;
  gl_PointSize = aKind > 1.5 ? clamp(px, 2.0, 16.0) : clamp(px, 1.5, 420.0);
  vColor = aColor; vBright = aBright; vPhase = aPhase; vDetail = aDetail; vDim = aDim; vKind = aKind;
  float d = -mv.z; vFog = 1.0 - exp(-0.065 * 0.065 * d * d * 0.6);
}`;
// Core brightness (sphaere, 2026-09-28): since the fog cloud lies additively
// behind the cores and the camera stands closer, the cores looked harsher
// than in the cloud version (owner). Measured on the demo store, share of
// blown-out pixels in the network picture: see the task report; CORE_GLOW
// brings it back to the old level while keeping each core's colour.
const CORE_GLOW = 0.62;
const CORE_FS = `
precision highp float;
uniform float uTime; uniform float uMotion;
varying vec3 vColor; varying float vBright; varying float vPhase; varying float vDetail; varying float vDim; varying float vKind; varying float vPx; varying float vFog;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; } return v; }
void main(){
  vec2 uv = gl_PointCoord * 2.0 - 1.0; uv.y = -uv.y;
  float r = length(uv);
  if (r > 1.0) discard;
  float rim = 0.25;
  vec3 col = vColor;
  vec3 c; float a;
  if (vBright < -0.5) {
    // not measurable: a matte, desaturated core with a dashed rim, no pulse
    vec3 g = mix(vec3(0.52, 0.58, 0.6), col, 0.18);
    float disk = smoothstep(rim, rim * 0.8, r);
    float rd = abs(r - rim * 1.32);
    float ang = atan(uv.y, uv.x);
    float dash = step(0.0, sin(ang * 14.0));
    c = g * disk * 0.42 + g * exp(-r * 8.0) * 0.18 + g * exp(-rd * rd * 5200.0) * 0.55 * dash;
    a = disk * 0.62 + exp(-r * 8.0) * 0.18 + exp(-rd * rd * 5200.0) * 0.55 * dash;
  } else {
    float b = clamp(vBright, 0.0, 1.0);
    float period = 3.6 + vPhase * 2.4;                       // 3.6–6 s per node
    float pulse = uMotion * sin(uTime * 6.2831853 / period + vPhase * 6.2831853);
    float lum = 1.0 + (0.06 + 0.07 * b) * pulse;             // a small, soft amplitude
    float core = exp(-pow(r / (0.07 + 0.08 * b), 2.0));
    float body = smoothstep(rim, rim * 0.78, r);
    float corona = exp(-r * (6.2 - 2.6 * b)) * (0.34 + 0.66 * b);
    vec3 hot = mix(col, vec3(1.0), 0.72);
    c = col * corona * 0.95 + mix(col * 0.75, hot, 0.55) * body * (0.35 + 0.65 * b) + vec3(1.0, 1.0, 0.98) * core * (0.45 + 1.1 * b);
    a = corona * 0.9 + body * (0.55 + 0.35 * b) + core;
    if (vDetail > 0.5 || vPx > 70.0) {
      // plasma filaments and orbits of light that fray over the rim
      float ang = atan(uv.y, uv.x);
      float t = uTime * 0.11 * uMotion + vPhase * 11.0;
      vec2 w = uv * 2.6 + vec2(fbm(uv * 3.1 + t), fbm(uv * 3.1 - t + 4.2)) * 0.9;
      float f = fbm(vec2(ang * 1.9 + fbm(w + t * 0.4) * 1.6, r * 4.4 - t * 1.15));
      float fil = pow(max(0.0, 1.0 - abs(f * 2.0 - 1.0)), 7.0) * 0.8;
      float band = smoothstep(0.1, 0.3, r) * smoothstep(1.0, 0.42, r);
      float orb = 0.0;
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float th = fi * 2.09 + t * 0.35;
        mat2 R = mat2(cos(th), -sin(th), sin(th), cos(th));
        vec2 p = R * uv; p.y *= 2.3 + fi * 0.75;
        float d = abs(length(p) - (0.3 + 0.045 * fi));
        orb += exp(-d * d * 7000.0) * 0.55;
      }
      float filament = fil * band * (0.7 + 0.9 * b) + orb * smoothstep(0.66, 0.24, r) * (0.5 + 0.7 * b);
      c += mix(col, vec3(0.86, 0.97, 1.0), 0.5) * filament * 0.95;
      a += filament;
    }
    if (vKind > 0.5 && vKind < 1.5) {
      // subgroups/drawers carry the two rings of the mockup's cores
      for (int i = 0; i < 2; i++) {
        float fi = float(i);
        float th = 0.7 + fi * 0.7 + uTime * 0.05 * uMotion;
        mat2 R = mat2(cos(th), -sin(th), sin(th), cos(th));
        vec2 p = R * uv; p.y *= 2.6 - fi * 0.5;
        float d = abs(length(p) - (0.37 + fi * 0.075));
        float ring = exp(-d * d * 9000.0) * (fi > 0.5 ? 0.35 : 0.7);
        c += col * ring; a += ring;
      }
    }
    if (vKind > 1.5) { c = col * exp(-r * 4.0) * 1.2 + vec3(1.0) * exp(-r * r * 30.0); a = exp(-r * 3.2); }
    c *= lum;
  }
  c = mix(c, vec3(0.03, 0.086, 0.1), vFog * 0.6);
  gl_FragColor = vec4(c * ${CORE_GLOW.toFixed(2)}, clamp(a, 0.0, 1.0) * vDim);
}`;
const STRAND_VS = `
attribute vec3 aColor; attribute float aAlpha;
varying vec3 vColor; varying float vAlpha; varying float vFog;
void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; vColor = aColor; vAlpha = aAlpha;
  float d = -mv.z; vFog = 1.0 - exp(-0.065 * 0.065 * d * d); }`;
const STRAND_FS = `
precision mediump float;
varying vec3 vColor; varying float vAlpha; varying float vFog;
void main(){ gl_FragColor = vec4(mix(vColor, vec3(0.031, 0.086, 0.098), vFog), vAlpha); }`;

// --- The network hull: ONE cloud of light fog (sphaere, 2026-09-28) ---------
// The owner: "the sphere looks too much like a soap bubble; we want a
// cloud-like look marked by light fog that fades out towards the edge and
// drifts a little inside, i.e. has motion, and that is 'pushed aside' when
// the camera zooms, like a windscreen in front of the camera — but the fog
// must never be too dense, just enough for a cool visual effect, and a few
// glitter particles may sit in the fog that do not glow themselves but only
// catch and reflect the light of the spheres".
// Before (huelle-wolke): a wireframe ellipsoid with a noise-deformed rim
// ("potato-like"), a skin and latitude rings.
//
// Now there is NO surface — no skin, no rim, no rings:
//   1. Fog VOLUME: per pixel a short ray march (8 steps) through a bounding
//      ellipsoid. Density = envelope CLOUD_DENSITY (calm inside, fading
//      softly and monotonically to 0 outwards — no visible edge) times
//      slowly drifting noise (fixed seed, clock uTime; without motion
//      uTime stands still). Thin: at most CLOUD_CAP. The fog catches the
//      light of the cores (colour of the nearest cores).
//   2. Windscreen: fog close to the camera is faded out (CLOUD_NEAR) and
//      pushed sideways away from the line of sight — zooming in, the fog
//      parts and streams past the edge of the picture.
//   3. Glitter: a few particles that do NOT glow themselves — brightness
//      and colour come only from the light of the cores (a specular glint
//      per particle normal).
// Both blend purely additively (the target is never darkened) and draw
// BEFORE the cores: the energy cores keep their full brightness.
// Measured: test/sphere-hull.test.mjs. 2 draw calls (before: 5).
const CLOUD_SEED = 41.17;
const CLOUD_MARGIN = 0.035; // air between the outermost support sphere and the node ellipsoid
const CLOUD_MIN = 0.46; // minimum semi-axis: a calm cloud even when empty or with 1 node
const CLOUD_OVAL = 1.18; // largest / smallest semi-axis at most
const CLOUD_REACH = 1.5; // the fog reaches 1.5 times the node ellipsoid, density 0 there
// Density envelope over the normalised radius r (0 centre, 1 fog edge).
// ONE formula for shader and test (written to be valid GLSL and JS).
const CLOUD_DENSITY = '(1.0 - smoothstep(0.34, 1.0, r)) * (0.55 + 0.45 * smoothstep(0.0, 0.34, r))';
// Windscreen: factor over the distance to the camera t (in fog radii) and
// the sideways distance s from the line of sight (likewise). Near and central: 0.
const CLOUD_NEAR = 'smoothstep(0.05, 0.55, t + 1.6 * s)';
const CLOUD_CAP = 0.3; // highest fog brightness per pixel (thin)
const CLOUD_LIGHTS = 12; // this many cores light the fog and the glitter
// The bundled three.js build (assets/three) does not export these
// constants; their values have been fixed in three.js for years (BackSide 1,
// CustomBlending 5, OneFactor 201).
const W_BACK_SIDE = 1, W_CUSTOM_BLENDING = 5, W_ONE = 201;
function cloudHash(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + CLOUD_SEED) * 43758.5453123;
  return s - Math.floor(s);
}
// Support spheres: where anything in the network can lie at all. Follows
// the layout in graphModel/initGraph (a group's nodes lie within g.radius
// of g.center, cells within c.radius of c.center, the evidence trail
// within ~0.8 of the middle, the cores with their rings).
function cloudSupports(model) {
  const st = [{ x: 0, y: -0.03, z: 0.02, r: 0.2 }];
  (model?.shards || []).forEach((s) => s.center && st.push({ ...s.center, r: 0.13 }));
  const cells2 = (cells) => (cells || []).forEach((c) => (st.push({ ...c.center, r: c.radius }), cells2(c.cells)));
  (model?.groups || []).forEach((g) => {
    if (!g.center) return;
    st.push({ ...g.center, r: g.trail ? 0.8 : g.radius || 0 });
    cells2(g.cells);
  });
  return st;
}
// Directions for the enclosure (Fibonacci sphere, fixed).
const CLOUD_DIRECTIONS = Array.from({ length: 160 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 160, r = Math.sqrt(1 - y * y), a = i * 2.399963;
  return [Math.cos(a) * r, y, Math.sin(a) * r];
});
// Node ellipsoid: gentle (at most CLOUD_OVAL), tight around all support
// spheres. It gives the camera frame; the fog reaches CLOUD_REACH times as
// far and fades to 0 there.
function cloudShape(model) {
  const st = cloudSupports(model),
    ax = ['x', 'y', 'z'],
    lo = {}, hi = {}, center = {}, axes = {};
  ax.forEach((k) => {
    lo[k] = Math.min(...st.map((p) => p[k] - p.r));
    hi[k] = Math.max(...st.map((p) => p[k] + p.r));
    center[k] = (lo[k] + hi[k]) / 2;
  });
  const hmax = Math.max(...ax.map((k) => (hi[k] - lo[k]) / 2));
  ax.forEach((k) => (axes[k] = Math.max((hi[k] - lo[k]) / 2, hmax / CLOUD_OVAL)));
  let s = 0;
  for (const p of st)
    for (const [a, b, c] of CLOUD_DIRECTIONS) {
      const r = p.r + CLOUD_MARGIN;
      s = Math.max(s, Math.hypot((p.x + a * r - center.x) / axes.x, (p.y + b * r - center.y) / axes.y, (p.z + c * r - center.z) / axes.z));
    }
  ax.forEach((k) => (axes[k] *= s * 1.004));
  const smallest = Math.min(axes.x, axes.y, axes.z);
  if (smallest < CLOUD_MIN) ax.forEach((k) => (axes[k] *= CLOUD_MIN / smallest));
  const fog = { x: axes.x * CLOUD_REACH, y: axes.y * CLOUD_REACH, z: axes.z * CLOUD_REACH };
  const point = (dx, dy, dz, depth = 1) => ({ x: center.x + fog.x * dx * depth, y: center.y + fog.y * dy * depth, z: center.z + fog.z * dz * depth });
  // Camera frame: the node ellipsoid (the fog may fade out past the edge of the picture).
  const frame = Math.hypot(center.x, center.y, center.z) + Math.max(axes.x, axes.y, axes.z);
  return { center, axes, fog, point, frame, supports: st };
}
// The light sources: shared core, project cores, groups (position + colour).
function cloudLights(model) {
  const l = [{ x: 0, y: -0.03, z: 0.02, colour: '#d9f3cf', power: 1 }];
  (model?.shards || []).forEach((s) => s.center && l.push({ ...s.center, colour: s.color, power: 0.9 }));
  (model?.groups || []).forEach((g) => g.center && l.push({ ...g.center, colour: g.color, power: 0.7 }));
  return l.slice(0, CLOUD_LIGHTS);
}
const CLOUD_GLSL = `uniform float uTime; uniform float alpha; uniform vec3 uCloudCenter; uniform vec3 uFog;
uniform vec3 uLight[${CLOUD_LIGHTS}]; uniform vec3 uLightColour[${CLOUD_LIGHTS}];
const vec3 W_TEAL = vec3(0.357, 0.675, 0.639); const vec3 W_BLUE = vec3(0.424, 0.588, 0.706);
float wH(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float wN(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wH(i), wH(i + vec3(1,0,0)), f.x), mix(wH(i + vec3(0,1,0)), wH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(wH(i + vec3(0,0,1)), wH(i + vec3(1,0,1)), f.x), mix(wH(i + vec3(0,1,1)), wH(i + vec3(1,1,1)), f.x), f.y), f.z); }
float wDensity(float r){ return ${CLOUD_DENSITY}; }
float wNear(float t, float s){ return ${CLOUD_NEAR}; }
vec4 wOut(vec3 c){ c = max(c, 0.0); return vec4(c, min(1.0, max(c.r, max(c.g, c.b)))); }`;
function buildHull(T, cortex, own, v, model, clock) {
  const shape = cloudShape(model),
    lights = cloudLights(model),
    colour = (f) => {
      const c = new T.Color();
      try { c.set(f); } catch {}
      return c;
    },
    uLight = { value: Array.from({ length: CLOUD_LIGHTS }, (_, i) => (lights[i] ? v(lights[i].x, lights[i].y, lights[i].z) : v(0, 0, 0))) },
    uLightColour = {
      value: Array.from({ length: CLOUD_LIGHTS }, (_, i) => {
        if (!lights[i]) return v(0, 0, 0);
        const c = colour(lights[i].colour);
        return v(c.r * lights[i].power, c.g * lights[i].power, c.b * lights[i].power);
      }),
    },
    uniforms = (mehr = {}) => ({
      uTime: clock.uTime, alpha: { value: 0.15 }, uCloudCenter: { value: v(shape.center.x, shape.center.y, shape.center.z) },
      uFog: { value: v(shape.fog.x, shape.fog.y, shape.fog.z) }, uLight, uLightColour, ...mehr,
    }),
    // Purely additive (target times ONE): the fog adds light and never
    // darkens — not even the energy cores. Opacity premultiplied (wOut).
    material = (o) =>
      own(new T.ShaderMaterial({ transparent: true, depthWrite: false, blending: W_CUSTOM_BLENDING, blendSrc: W_ONE, blendDst: W_ONE, blendSrcAlpha: W_ONE, blendDstAlpha: W_ONE, ...o })),
    add = (o) => ((o.renderOrder = -1), cortex.add(o), o);
  // 1) The fog volume. Only the back side of the bounding ellipsoid is
  //    rasterised (visible from inside too); the fog is drawn ALONG the
  //    ray, the surface itself is invisible (density 0).
  const geo = own(new T.SphereGeometry(1, 48, 32));
  {
    const arr = geo.attributes.position, p = v();
    for (let i = 0; i < arr.count; i++) {
      p.fromBufferAttribute(arr, i);
      const q = shape.point(p.x, p.y, p.z);
      arr.setXYZ(i, q.x, q.y, q.z);
    }
    geo.computeVertexNormals();
  }
  const FOG_VS = CLOUD_GLSL + `
varying vec3 vW; varying vec4 vClip;
void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; vClip = gl_Position; }`;
  const FOG_FS = CLOUD_GLSL + `
varying vec3 vW; varying vec4 vClip;
void main(){
  vec3 ro = (cameraPosition - uCloudCenter) / uFog, rd = normalize((vW - uCloudCenter) / uFog - ro);
  float b = dot(ro, rd), h = b * b - dot(ro, ro) + 1.0;
  if (h <= 0.0) discard;
  h = sqrt(h); float t0 = max(0.0, -b - h), t1 = -b + h, dt = (t1 - t0) / 8.0;
  float R = max(uFog.x, max(uFog.y, uFog.z));
  vec3 forward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
  float clock = uTime * 0.05;
  float j = wH(vec3(gl_FragCoord.xy, 3.7));
  float amount = 0.0; vec3 weighted = vec3(0.0), base = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    vec3 q = ro + rd * (t0 + (float(i) + j) * dt);
    vec3 p = uCloudCenter + q * uFog;
    // Windscreen: distance to the camera (t) and sideways to the line of sight (s), in fog radii.
    vec3 toP = p - cameraPosition;
    float depthAlong = max(0.0, dot(toP, forward));
    vec3 side = toP - forward * depthAlong;
    float t = depthAlong / R, s = length(side) / R;
    float near = wNear(t, s);
    if (near <= 0.0) continue;
    // Push sideways, the closer the more: the fog streams past the picture.
    vec3 away = side / max(1e-4, length(side)) * (1.0 - near) * 0.35;
    vec3 w = q * 2.1 + away + vec3(clock, -0.7 * clock, 0.45 * clock);
    w += 0.35 * vec3(sin(clock * 1.7 + q.y * 2.0), sin(clock * 1.3 + q.z * 2.0), sin(clock * 1.1 + q.x * 2.0));
    float n = 0.62 * wN(w) + 0.38 * wN(w * 2.1 + 5.3);
    // Displaced fog crowds at the edge of the cleared lane (a little denser there).
    float crowd = 1.0 + 3.0 * near * (1.0 - near);
    float d = wDensity(length(q)) * smoothstep(0.38, 0.82, n) * near * crowd * dt;
    amount += d; weighted += p * d;
    base += mix(W_TEAL, W_BLUE, 0.5 + 0.5 * q.x) * d;
  }
  if (amount <= 0.0) discard;
  // The light of the cores in the fog — once per pixel, at the density centroid along the ray.
  vec3 p = weighted / amount, light = vec3(0.0);
  for (int k = 0; k < ${CLOUD_LIGHTS}; k++) {
    vec3 toL = uLight[k] - p;
    light += uLightColour[k] * 0.9 / (1.0 + dot(toL, toL) * 9.0);
  }
  vec3 acc = base * 0.6 + light * amount;
  acc = (1.0 - exp(-acc * 4.5)) * ${CLOUD_CAP.toFixed(2)};
  // Fade softly towards the picture edge: the fog is larger than the picture but must never cut off hard.
  vec2 ndc = vClip.xy / vClip.w;
  acc *= smoothstep(1.0, 0.7, max(abs(ndc.x), abs(ndc.y)));
  gl_FragColor = wOut(acc * (alpha / 0.15)); }`;
  add(new T.Mesh(geo, material({ side: W_BACK_SIDE, uniforms: uniforms(), vertexShader: FOG_VS, fragmentShader: FOG_FS })));
  // 2) Glitter: a few particles with their own slowly tilting normal.
  //    Colour and brightness ONLY from the light of the cores: hardly any
  //    diffuse light, a specular glint towards the camera as a brief flash.
  const pos = [], normals = [], phase = [];
  const COUNT = 110;
  for (let i = 0; i < COUNT; i++) {
    const y = 1 - (2 * (i + 0.5)) / COUNT, r = Math.sqrt(Math.max(0, 1 - y * y)), a = i * 2.399963,
      z1 = cloudHash(i, 3.1, 7.7), z2 = cloudHash(i, 9.2, 1.3), z3 = cloudHash(i, 4.4, 2.2),
      depth = 0.15 + 0.6 * Math.cbrt(z1);
    pos.push(Math.cos(a) * r * depth, y * depth, Math.sin(a) * r * depth);
    const u = z2 * Math.PI * 2, c = z3 * 2 - 1, sn = Math.sqrt(1 - c * c);
    normals.push(Math.cos(u) * sn, c, Math.sin(u) * sn);
    phase.push(z1 * 6.2831853);
  }
  const pgeo = own(new T.BufferGeometry());
  pgeo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
  pgeo.setAttribute('aNormal', new T.Float32BufferAttribute(normals, 3));
  pgeo.setAttribute('aPhase', new T.Float32BufferAttribute(phase, 1));
  const glitter = new T.Points(
    pgeo,
    material({
      uniforms: uniforms({ uScale: clock.uScale || { value: 400 } }),
      vertexShader: CLOUD_GLSL + `
uniform float uScale; attribute vec3 aNormal; attribute float aPhase; varying vec3 vLight;
void main(){ float w = uTime * 0.015 + aPhase;
  vec3 q = position + 0.04 * vec3(sin(uTime * 0.11 + aPhase), sin(uTime * 0.09 + aPhase * 1.7), cos(uTime * 0.1 + aPhase));
  vec3 p = uCloudCenter + q * uFog;
  vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(0.022 * uScale / max(0.0001, -mv.z), 2.0, 7.0);
  vec3 n = normalize(aNormal + 0.6 * vec3(sin(w * 3.0), cos(w * 2.3), sin(w * 1.9)));
  vec3 V = normalize(cameraPosition - p);
  vLight = vec3(0.0);
  for (int k = 0; k < ${CLOUD_LIGHTS}; k++) {
    vec3 toL = uLight[k] - p; float d2 = dot(toL, toL); vec3 L = toL * inversesqrt(max(1e-6, d2));
    float mirror = max(0.0, dot(reflect(-L, n), V));
    float gloss = pow(mirror, 14.0), flash = pow(mirror, 60.0);
    float diffuse = 0.05 * max(0.0, dot(n, L));
    vLight += uLightColour[k] * (gloss * 9.0 + flash * 14.0 + diffuse) / (1.0 + d2 * 4.5);
  } }`,
      fragmentShader: CLOUD_GLSL + `
varying vec3 vLight;
void main(){ vec2 u = gl_PointCoord - 0.5; float r = dot(u, u) * 4.0; if (r > 1.0) discard;
  gl_FragColor = wOut(vLight * exp(-r * 3.0) * (alpha / 0.15)); }`,
    }),
  );
  glitter.frustumCulled = false;
  add(glitter);
  return shape;
}


function initGraph() {
  const T = window.MemThree,
    canvas = $('#brain'),
    viewport = canvas.parentElement,
    es = scoped(),
    model = graphModel(es, state.graphMode),
    labelLayer = $('#graphLabels'),
    tip = $('#graphHover');
  if (!model.groups.some((g) => g.key === camera.focus)) {
    camera.focus = null;
    camera.cell = null;
  }
  let renderer;
  $('#graphGroups').innerHTML =
    model.groups
      .map((g) => `<button data-action="graph-focus" data-value="${esc(g.key)}" aria-pressed="false" style="--cluster:${g.color}" title="Focus ${esc(g.label)}"><i></i><span>${esc(g.label)}</span><b>${num(g.members.length)}</b></button>`)
      .join('') || '<span>No groups in this selection.</span>';
  if (!T) {
    $('.graph-fallback').hidden = false;
    $('.atlas-mode').textContent = 'LIST VIEW';
    return;
  }
  try {
    renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (e) {
    $('.graph-fallback').hidden = false;
    $('.atlas-mode').textContent = 'LIST VIEW';
    return;
  }
  renderer.setClearColor(0x071313, 0);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new T.Scene(),
    cam = new T.PerspectiveCamera(39, 1, 0.002, 80),
    root = new T.Group(),
    cortex = new T.Group(),
    world = new T.Group(),
    dynamic = new T.Group();
  scene.add(root);
  root.add(cortex, world, dynamic);
  scene.fog = new T.FogExp2(0x081619, 0.065);
  scene.add(new T.AmbientLight(0xb6cdd2, 0.9));
  const light = new T.DirectionalLight(0xf2ffd9, 2.2);
  light.position.set(-3, 5, 4);
  scene.add(light);
  const rim = new T.DirectionalLight(0x6abcee, 1.6);
  rim.position.set(3, -1, -3);
  scene.add(rim);
  const resources = new Set(),
    own = (o) => (resources.add(o), o),
    v = (x, y, z) => new T.Vector3(x, y, z),
    vec = (p) => v(p.x, p.y, p.z),
    center = v(0, 0, 0),
    look = center.clone();
  let w = 1, h = 1, baseDistance = 6, distance = 6, dead = false, onScreen = true, frame = 0, last = 0, time = 0, transition = null,
    hoverId = null, hoverGroup = null, hoverIndex = -1, labels = [], edgeVisuals = [], units = [], pulses = [], angle = camera.angle, tilt = camera.tilt;
  let screenX = new Float32Array(0), screenY = new Float32Array(0), screenZ = new Float32Array(0), screenV = new Uint8Array(0);
  let groupHits = [];
  const pointers = new Map();
  let gesture = null, dragged = false, down = null;
  const fps = { frames: 0, t0: performance.now(), value: null };
  const coreUniforms = { uTime: { value: 0 }, uScale: { value: 400 }, uMotion: { value: state.motion ? 1 : 0 } };
  const coreMaterial = own(
    new T.ShaderMaterial({ uniforms: coreUniforms, vertexShader: CORE_VS, fragmentShader: CORE_FS, transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending }),
  );
  const strandMaterial = own(new T.ShaderMaterial({ vertexShader: STRAND_VS, fragmentShader: STRAND_FS, transparent: true, depthWrite: false }));
  const tmp = new T.Mesh(); // carries only a quaternion for the arrow heads
  function path(points, color, opacity, parent = world, dashed = false) {
    const geo = own(new T.BufferGeometry().setFromPoints(points)),
      mat = own(
        dashed
          ? new T.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.022, gapSize: 0.035, depthWrite: false })
          : new T.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      ),
      line = new T.Line(geo, mat);
    if (dashed) line.computeLineDistances();
    parent.add(line);
    return line;
  }
  // The network hull: ONE cloud of fog around all nodes (orientation, not data).
  const cloud = buildHull(T, cortex, own, v, model, coreUniforms);

  // --- Brightness from real measurement ---------------------------------------
  const maxSessions = Math.max(1, ...es.map((e) => e.recall?.sessions || 0));
  const brightness = (list) => {
    const known = list.filter((e) => e.recall);
    if (!known.length) return -1;
    const s = known.reduce((n, e) => n + (e.recall.sessions || 0), 0) / known.length;
    return s <= 0 ? 0.08 : 0.25 + 0.75 * Math.min(1, Math.log2(1 + s) / Math.log2(1 + maxSessions));
  };
  const phase = (key) => {
    let hsh = 2166136261;
    for (let i = 0; i < key.length; i++) hsh = Math.imul(hsh ^ key.charCodeAt(i), 16777619);
    return ((hsh >>> 0) % 1000) / 1000;
  };

  // --- Cores: the shared core and the project cores ---------------------------
  const hubs = [];
  function rings(pos, color, r, parent) {
    const g = new T.Group();
    g.position.copy(pos);
    parent.add(g);
    for (let j = 0; j < 2; j++) {
      const ring = new T.Mesh(own(new T.TorusGeometry(r * (1.5 + j * 0.3), r * 0.027, 6, 64)), own(new T.MeshBasicMaterial({ color, transparent: true, opacity: j ? 0.22 : 0.55 })));
      ring.rotation.set(0.7 + j * 0.7, 0.4 + j * 0.4, 0.2);
      g.add(ring);
    }
    return g;
  }
  const mainPos = v(0, -0.03, 0.02);
  const mainRing = rings(mainPos, 0xd9f3cf, 0.115, world);
  // An empty memory: the shared core alone, calm and pulsing — nothing
  // to measure yet is not the same as "not measurable".
  hubs.push({ key: 'root', pos: mainPos, color: '#d9f3cf', size: 0.115 * 9, bright: es.length ? brightness(es) : 0.32, ring: mainRing });
  const shardOrbs = model.shards.map((s) => {
    const r = state.graphMode === 'storage' || state.graphMode === 'overview' ? 0.078 : 0.047;
    const ring = rings(vec(s.center), s.color, r, world);
    const curve = new T.CubicBezierCurve3(mainPos.clone(), v(s.center.x * 0.15, 0.12, s.center.z * 0.25), v(s.center.x * 0.75, s.center.y + 0.1, s.center.z), vec(s.center));
    path(curve.getPoints(60), s.color, 0.35, world, true);
    hubs.push({ key: s.key, pos: vec(s.center), color: s.color, size: r * 9, bright: brightness(s.members), ring });
    return { ...s, ring };
  });
  const hubGeo = own(new T.BufferGeometry());
  const hubDim = new Float32Array(hubs.length).fill(1);
  {
    const P = [], C = [], S = [], B = [], PH = [], DT = [], K = [];
    for (const hb of hubs) {
      P.push(hb.pos.x, hb.pos.y, hb.pos.z);
      const c = new T.Color(hb.color);
      C.push(c.r, c.g, c.b);
      S.push(hb.size);
      B.push(hb.bright);
      PH.push(phase(hb.key));
      DT.push(1);
      K.push(0);
    }
    hubGeo.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    hubGeo.setAttribute('aColor', new T.Float32BufferAttribute(C, 3));
    hubGeo.setAttribute('aSize', new T.Float32BufferAttribute(S, 1));
    hubGeo.setAttribute('aBright', new T.Float32BufferAttribute(B, 1));
    hubGeo.setAttribute('aPhase', new T.Float32BufferAttribute(PH, 1));
    hubGeo.setAttribute('aDetail', new T.Float32BufferAttribute(DT, 1));
    hubGeo.setAttribute('aDim', new T.Float32BufferAttribute(hubDim, 1));
    hubGeo.setAttribute('aKind', new T.Float32BufferAttribute(K, 1));
  }
  const hubPoints = new T.Points(hubGeo, coreMaterial);
  hubPoints.frustumCulled = false;
  world.add(hubPoints);

  function label(text, small, color, key, kind) {
    const el = document.createElement('button');
    el.className = 'atlas-label ' + (kind || '');
    el.style.setProperty('--node-color', color);
    el.innerHTML = `<i></i><span>${esc(text)}${small ? `<small>${esc(small)}</small>` : ''}</span>`;
    el.setAttribute('aria-label', 'Focus ' + text + (small ? ' · ' + small : ''));
    el.onclick = () => (key === 'root' ? reset() : key.startsWith('entry:') ? showDetail(key.slice(6), 'content') : focus(key));
    labelLayer.append(el);
    return el;
  }
  const rootLabel = label(coreName(), es.length ? 'Shared core' : 'Shared core · empty', '#d9f3cf', 'root', 'root-label');
  const shardLabels = shardOrbs.map((s) => ({ el: label(s.label, pluralEntries(s.members.length), s.color, s.key, 'shard-label'), pos: vec(s.center), key: s.key }));

  const positions = new Map();
  model.groups.forEach((g) => {
    if (g.cells.length) return;
    if (g.trail) {
      // Evidence trail: middle = the entry, right where it points, left what points at it.
      positions.set(g.trail.c.id, v(0, 0, 0));
      const lay = (list, side) => {
        const n = list.length;
        list.forEach((x, j) => {
          if (positions.has(x.e.id)) return;
          const y = n === 1 ? 0 : 0.85 - (1.7 * j) / (n - 1),
            ring = Math.sqrt(Math.max(0, 1 - y * y)),
            a = j * 2.399963;
          positions.set(x.e.id, v(side * (0.42 + 0.3 * ring), y * 0.62, Math.sin(a) * 0.32 * ring));
        });
      };
      lay(g.trail.out, 1);
      lay(g.trail.inc, -1);
      return;
    }
    const n = g.members.length;
    g.members.forEach((e, j) => {
      const y = 1 - (2 * (j + 0.5)) / n,
        a = j * 2.399963,
        r = g.radius * (0.7 + 0.3 * (((j * 17) % 13) / 13)),
        ring = Math.sqrt(1 - y * y);
      positions.set(e.id, vec(g.center).add(v(Math.cos(a) * ring * r, y * r, Math.sin(a) * ring * r)));
    });
  });
  const cellMap = new Map();
  function indexCells(cells) {
    cells.forEach((c) => {
      cellMap.set(c.key, c);
      indexCells(c.cells);
    });
  }
  model.groups.forEach((g) => indexCells(g.cells));
  const currentCell = () => cellMap.get(camera.cell);
  function clearDynamic() {
    const old = new Set();
    dynamic.traverse((o) => {
      if (o.geometry) old.add(o.geometry);
      if (o.material && o.material !== coreMaterial && o.material !== strandMaterial) old.add(o.material);
    });
    old.forEach((o) => {
      o.dispose();
      resources.delete(o);
    });
    dynamic.clear();
    units = [];
    pulses = [];
    edgeVisuals = [];
    labels.forEach((l) => l.el.remove());
    labels = [];
  }
  let coreGeo = null, strandGeo = null, pulseGeo = null;
  function tintHierarchy() {
    const focused = !!camera.focus;
    hubs.forEach((hb, i) => {
      const dim = focused && hb.key !== camera.focus;
      hubDim[i] = dim ? 0.12 : 1;
      hb.ring.traverse((n) => {
        if (n.material) {
          if (n.userData.normalOpacity === undefined) n.userData.normalOpacity = n.material.opacity;
          n.material.opacity = dim ? n.userData.normalOpacity * 0.12 : n.userData.normalOpacity;
        }
      });
    });
    hubGeo.attributes.aDim.needsUpdate = true;
  }
  function createUnits() {
    clearDynamic();
    tintHierarchy();
    const chosenCell = currentCell(), activePath = new Set();
    let ancestor = chosenCell;
    while (ancestor) {
      activePath.add(ancestor.key);
      ancestor = cellMap.get(ancestor.parent);
    }
    function emitCells(cells, g) {
      cells.forEach((c) => {
        if (activePath.has(c.key) && !(state.graphMode === 'overview')) {
          if (c.cells.length) emitCells(c.cells, g);
          else
            c.members.forEach((e, j) => {
              const n = c.members.length, y = 1 - (2 * (j + 0.5)) / n, a = j * 2.399963, r = c.radius, q = Math.sqrt(1 - y * y);
              units.push({ key: e.id, e, g, members: [e], pos: vec(c.center).add(v(Math.cos(a) * q * r, y * r, Math.sin(a) * q * r)), radius: r * (c.depth > 0 ? 0.2 : 0.14) });
            });
        } else units.push({ key: c.key, cell: c, g, members: c.members, pos: vec(c.center), radius: c.radius * (c.depth > 0 ? 0.42 : 0.28) });
      });
    }
    model.groups.forEach((g) => {
      if (g.cells.length) emitCells(g.cells, g);
      else g.members.forEach((e) => units.push({ key: e.id, e, g, members: [e], pos: positions.get(e.id), radius: g.trail ? (e.id === g.trail.c.id ? 0.07 : 0.042) : null }));
    });
    // Nodes: one point per unit, all in one draw call.
    const n = units.length;
    const P = new Float32Array(n * 3), C = new Float32Array(n * 3), S = new Float32Array(n), B = new Float32Array(n), PH = new Float32Array(n), DT = new Float32Array(n), DM = new Float32Array(n), K = new Float32Array(n);
    units.forEach((u, i) => {
      const selected = !camera.focus || u.g.key === camera.focus;
      const col = new T.Color(u.g.color);
      P.set([u.pos.x, u.pos.y, u.pos.z], i * 3);
      C.set([col.r, col.g, col.b], i * 3);
      const r = u.radius || (u.cell ? 0.065 : 0.034);
      u.base = r * 8;
      S[i] = u.base;
      B[i] = brightness(u.members);
      PH[i] = phase(u.key);
      DT[i] = u.e && (u.e.id === state.selected || (u.g.trail && u.e.id === u.g.trail.c.id)) ? 1 : 0;
      DM[i] = selected ? 1 : 0.14;
      K[i] = u.cell ? 1 : 0;
      u.index = i;
    });
    coreGeo = own(new T.BufferGeometry());
    coreGeo.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    coreGeo.setAttribute('aColor', new T.Float32BufferAttribute(C, 3));
    coreGeo.setAttribute('aSize', new T.Float32BufferAttribute(S, 1));
    coreGeo.setAttribute('aBright', new T.Float32BufferAttribute(B, 1));
    coreGeo.setAttribute('aPhase', new T.Float32BufferAttribute(PH, 1));
    coreGeo.setAttribute('aDetail', new T.Float32BufferAttribute(DT, 1));
    coreGeo.setAttribute('aDim', new T.Float32BufferAttribute(DM, 1));
    coreGeo.setAttribute('aKind', new T.Float32BufferAttribute(K, 1));
    const corePoints = new T.Points(coreGeo, coreMaterial);
    corePoints.frustumCulled = false;
    dynamic.add(corePoints);
    screenX = new Float32Array(n); screenY = new Float32Array(n); screenZ = new Float32Array(n); screenV = new Uint8Array(n);

    // Roots at single entries (the mockup: 5 fibres per entry) — as ONE line set.
    const fibres = [];
    const fCol = [];
    const entryUnits = units.filter((u) => !u.cell);
    const withFibres = entryUnits.length <= 700 ? entryUnits : entryUnits.filter((u) => camera.focus && u.g.key === camera.focus);
    for (const u of withFibres) {
      const r = (u.radius || 0.034) * 1.0, c = new T.Color(u.g.color);
      for (let j = 0; j < 5; j++) {
        const a = j * 2.399963, p = v(Math.cos(a), Math.sin(a), Math.cos(a * 1.4)).normalize();
        const curve = new T.CatmullRomCurve3([p.clone().multiplyScalar(r * 0.7).add(u.pos), p.clone().multiplyScalar(r * 1.5).add(v(0.005, -0.005, 0.005)).add(u.pos), p.clone().multiplyScalar(r * 2.35).add(u.pos)]);
        const pts = curve.getPoints(6);
        for (let k = 0; k < pts.length - 1; k++) {
          fibres.push(pts[k].x, pts[k].y, pts[k].z, pts[k + 1].x, pts[k + 1].y, pts[k + 1].z);
          fCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
        }
      }
    }
    if (fibres.length) {
      const fg = own(new T.BufferGeometry());
      fg.setAttribute('position', new T.Float32BufferAttribute(fibres, 3));
      fg.setAttribute('aColor', new T.Float32BufferAttribute(fCol, 3));
      fg.setAttribute('aAlpha', new T.Float32BufferAttribute(new Float32Array(fibres.length / 3).fill(camera.focus ? 0.3 : 0.22), 1));
      const ls = new T.LineSegments(fg, strandMaterial);
      ls.frustumCulled = false;
      dynamic.add(ls);
    }

    // Labels: subgroups/drawers of the focused group (or a few), groups
    // outside the storage mode, every neighbour in the evidence trail.
    const cells = units.filter((u) => u.cell);
    units.forEach((u) => {
      if (u.cell && (camera.focus === u.g.key || cells.length <= 16)) {
        const el = label(u.cell.drawer ? u.cell.label : pluralEntries(u.members.length), u.cell.drawer ? pluralEntries(u.members.length) + ' · drawer' : 'Subgroup', u.g.color, u.cell.key, 'cell-label');
        labels.push({ el, pos: u.pos, key: u.key, parent: u.g.key });
      }
      if (u.e && u.g.trail) {
        const dir = u.e.id === u.g.trail.c.id ? 'Middle' : u.g.trail.out.some((x) => x.e.id === u.e.id) ? 'points to →' : '← points here';
        const el = label(u.e.title.split(/\s+/).slice(0, 5).join(' '), dir, u.g.color, 'entry:' + u.e.id, u.e.id === u.g.trail.c.id ? 'root-label' : 'cell-label');
        labels.push({ el, pos: u.pos, key: u.key, parent: u.g.key });
      }
    });
    if (state.graphMode !== 'storage' && state.graphMode !== 'overview' && state.graphMode !== 'trail')
      model.groups.forEach((g) => {
        const el = label(g.label, pluralEntries(g.members.length), g.color, g.key);
        labels.push({ el, pos: vec(g.center).add(v(0, 0.13, 0)), key: g.key, parent: g.key });
      });

    // Edges: bundled per endpoint pair as in the mockup — here every
    // bundle in ONE geometry set (tubes + arrow heads).
    const endpoint = new Map();
    units.forEach((u) => u.members.forEach((e) => endpoint.set(e.id, u)));
    const bundles = new Map();
    const sourceEdges = state.graphMode === 'overview' ? overviewEdges(units) : model.edges;
    sourceEdges.forEach((e) => {
      const a = e.a || endpoint.get(e.from), b = e.b || endpoint.get(e.to);
      if (!a || !b) return;
      const key = a.key + '>' + b.key;
      const found = bundles.get(key);
      if (found) found.edges.push(...(e.list || [e]));
      else bundles.set(key, { a, b, edges: e.list ? [...e.list] : [e], count: 0 });
      bundles.get(key).count += e.count || 1;
    });
    const PP = [], CC = [], AA = [], IDX = [];
    let base = 0;
    [...bundles.values()].forEach(({ a, b, edges, count }, i) => {
      let c1, c2;
      const same = a.key === b.key, delta = b.pos.clone().sub(a.pos), bend = v(-delta.y, delta.x, 0.18 + (i % 3) * 0.05);
      if (same) {
        c1 = a.pos.clone().add(v(0.18, 0.2, 0.08));
        c2 = a.pos.clone().add(v(-0.18, 0.2, -0.08));
      } else if (a.g.key !== b.g.key) {
        c1 = a.pos.clone().lerp(v(0, 0.04, 0.03), 0.5).add(v(0, 0.04, 0.08));
        c2 = b.pos.clone().lerp(v(0, 0.04, 0.03), 0.5).add(v(0, -0.02, -0.07));
      } else {
        c1 = a.pos.clone().addScaledVector(delta, 0.27).addScaledVector(bend, 0.23);
        c2 = a.pos.clone().addScaledVector(delta, 0.73).addScaledVector(bend, 0.23);
      }
      const curve = new T.CubicBezierCurve3(a.pos, c1, c2, b.pos),
        color = new T.Color(a.g.color).lerp(new T.Color(b.g.color), 0.45);
      const alpha = edgeBaseAlpha({ a, b });
      const tube = new T.TubeGeometry(curve, 34, 0.0018 + Math.min(0.0042, Math.log2(count + 1) * 0.0006), 5, false);
      const cone = new T.ConeGeometry(0.008, 0.03, 5);
      tmp.quaternion.setFromUnitVectors(v(0, 1, 0), curve.getTangent(0.8).normalize());
      cone.applyQuaternion(tmp.quaternion);
      const p8 = curve.getPoint(0.8);
      cone.translate(p8.x, p8.y, p8.z);
      const start = base;
      for (const geo of [tube, cone]) {
        const pos = geo.attributes.position;
        for (let k = 0; k < pos.count; k++) {
          PP.push(pos.getX(k), pos.getY(k), pos.getZ(k));
          CC.push(color.r, color.g, color.b);
          AA.push(alpha);
        }
        const ix = geo.index;
        for (let k = 0; k < ix.count; k++) IDX.push(ix.getX(k) + base);
        base += pos.count;
        geo.dispose();
      }
      edgeVisuals.push({ a, b, edges, curve, from: start, to: base, count });
      if (i < 180) pulses.push({ curve, phase: (i * 0.173) % 1, color });
    });
    if (PP.length) {
      strandGeo = own(new T.BufferGeometry());
      strandGeo.setAttribute('position', new T.Float32BufferAttribute(PP, 3));
      strandGeo.setAttribute('aColor', new T.Float32BufferAttribute(CC, 3));
      strandGeo.setAttribute('aAlpha', new T.Float32BufferAttribute(AA, 1));
      strandGeo.setIndex(IDX);
      const mesh = new T.Mesh(strandGeo, strandMaterial);
      mesh.frustumCulled = false;
      dynamic.add(mesh);
    } else strandGeo = null;
    // Wandering points of light: ONE point set, positions anew per frame.
    if (pulses.length) {
      pulseGeo = own(new T.BufferGeometry());
      const PC = [], PS = [], PB = [], PPh = [], PD = [], PDm = [], PK = [];
      pulses.forEach((p) => {
        PC.push(p.color.r, p.color.g, p.color.b);
        PS.push(0.007 * 8);
        PB.push(0.7);
        PPh.push(p.phase);
        PD.push(0);
        PDm.push(1);
        PK.push(2);
      });
      pulseGeo.setAttribute('position', new T.Float32BufferAttribute(new Float32Array(pulses.length * 3), 3));
      pulseGeo.setAttribute('aColor', new T.Float32BufferAttribute(PC, 3));
      pulseGeo.setAttribute('aSize', new T.Float32BufferAttribute(PS, 1));
      pulseGeo.setAttribute('aBright', new T.Float32BufferAttribute(PB, 1));
      pulseGeo.setAttribute('aPhase', new T.Float32BufferAttribute(PPh, 1));
      pulseGeo.setAttribute('aDetail', new T.Float32BufferAttribute(PD, 1));
      pulseGeo.setAttribute('aDim', new T.Float32BufferAttribute(PDm, 1));
      pulseGeo.setAttribute('aKind', new T.Float32BufferAttribute(PK, 1));
      const pp = new T.Points(pulseGeo, coreMaterial);
      pp.frustumCulled = false;
      dynamic.add(pp);
    } else pulseGeo = null;
    canvas.dataset.renderedEdges = state.graphMode === 'overview' ? edgeVisuals.reduce((n, e) => n + e.count, 0) : model.edges.length;
    canvas.dataset.edgeStrands = edgeVisuals.length;
    canvas.dataset.shardCores = model.shards.length;
    canvas.dataset.units = units.length;
    canvas.dataset.memoryCores = '1';
    canvas.dataset.superCore = '1';
    canvas.dataset.renderer = 'webgl-3d';
  }
  // Overview: the drawer pairs from net.mjs (aggregated, with a count) as bundles.
  function overviewEdges(us) {
    const byDrawer = new Map(us.filter((u) => u.cell?.drawer).map((u) => [u.cell.drawer, u]));
    return (D.net?.pairs || [])
      .map((p) => ({ a: byDrawer.get(p.from), b: byDrawer.get(p.to), count: p.count, list: [] }))
      .filter((x) => x.a && x.b);
  }
  // A bundle's base opacity: quiet outside the focus; in an open
  // subgroup/drawer only the bundles that touch it are loud.
  function edgeBaseAlpha(e) {
    if (!camera.focus) return 0.56;
    if (e.a.g.key !== camera.focus && e.b.g.key !== camera.focus) return 0.09;
    const c = currentCell();
    if (!c) return 0.56;
    const inside = (u) => u.cell ? u.cell.key === c.key || u.cell.parent === c.key || String(u.cell.key).startsWith(c.key + ':') : c.members.some((m) => m.id === u.e?.id);
    return inside(e.a) || inside(e.b) ? 0.56 : 0.05;
  }
  function setEdgeAlpha() {
    if (!strandGeo) return;
    const A = strandGeo.attributes.aAlpha;
    for (const e of edgeVisuals) {
      const hit = hoverId && (e.a.members.some((n) => n.id === hoverId) || e.b.members.some((n) => n.id === hoverId));
      const al = hoverId ? (hit ? 0.95 : 0.09) : edgeBaseAlpha(e);
      for (let k = e.from; k < e.to; k++) A.array[k] = al;
    }
    A.needsUpdate = true;
  }
  function updateUI() {
    camera.zoom = baseDistance / distance;
    $('#graphZoom').value = Math.round(camera.zoom * 100) + '%';
    const g = model.groups.find((g) => g.key === camera.focus), c = currentCell();
    $('#graphBreadcrumb').textContent = coreSlug() + ' / ' + (g ? g.label + (c ? ' / ' + c.label : '') : state.graphMode === 'trail' ? 'Evidence trail' : 'all projects');
    $('.atlas-back').hidden = !camera.focus;
    $$('#graphGroups button').forEach((el) => el.setAttribute('aria-pressed', el.dataset.value === camera.focus));
    const n = state.graphMode === 'overview' ? edgeVisuals.reduce((k, e) => k + e.count, 0) : model.edges.length;
    $('#graphEdgeCount').textContent = num(n) + ' relations · ' + num(model.shards.length) + ' projects · 1 memory';
    canvas.dataset.focus = camera.cell || camera.focus || '';
  }
  const _p = new T.Vector3();
  function toScreen(p) {
    const q = _p.copy(p).project(cam);
    return { x: ((q.x + 1) * w) / 2, y: ((1 - q.y) * h) / 2, z: q.z, visible: q.z > -1 && q.z < 1 && q.x > -1.1 && q.x < 1.1 && q.y > -1.1 && q.y < 1.1 };
  }
  function place(el, p, show = true, dy = 0) {
    const q = toScreen(p);
    el.hidden = !show || !q.visible;
    if (el.hidden) return;
    el.style.left = Math.max(5, Math.min(w - el.offsetWidth - 5, q.x + 12)) + 'px';
    el.style.top = Math.max(5, Math.min(h - el.offsetHeight - 5, q.y + dy)) + 'px';
  }
  function refreshProjected() {
    for (let i = 0; i < units.length; i++) {
      const q = toScreen(units[i].pos);
      screenX[i] = q.x; screenY[i] = q.y; screenZ[i] = q.z; screenV[i] = q.visible ? 1 : 0;
    }
    groupHits = model.groups.map((g) => {
      const p = toScreen(vec(g.center)), edge = toScreen(vec(g.center).add(v(g.radius, 0, 0)));
      return { ...g, ...p, r: Math.max(28, Math.abs(edge.x - p.x) + 16) };
    });
    place(rootLabel, mainPos, !camera.focus && state.graphMode !== 'trail', 18);
    shardLabels.forEach((s) => place(s.el, s.pos, (state.graphMode === 'storage' || state.graphMode === 'overview') && !camera.focus, 12));
    labels.forEach((l) => place(l.el, l.pos, (!camera.focus || camera.focus === l.parent) && l.key !== camera.cell, 12));
  }
  function draw(now = performance.now(), force = false) {
    if (dead) return;
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    fps.frames++;
    if (now - fps.t0 > 1000) {
      fps.value = (fps.frames * 1000) / (now - fps.t0);
      fps.frames = 0;
      fps.t0 = now;
      canvas.dataset.fps = fps.value.toFixed(1);
    }
    if (transition) {
      const p = Math.min(1, (now - transition.start) / transition.ms), e = 1 - (1 - p) ** 3;
      look.copy(transition.from).lerp(transition.to, e);
      distance = transition.d0 + (transition.d1 - transition.d0) * e;
      angle = transition.a0 + (transition.a1 - transition.a0) * e;
      tilt = transition.t0 + (transition.t1 - transition.t0) * e;
      if (p === 1) transition = null;
      updateUI();
    } else if (state.motion && !document.hidden && !camera.focus && !pointers.size && !hoverId && !hoverGroup) angle += dt * 0.027;
    if (state.motion) {
      time += dt;
      mainRing.rotation.y = time * 0.12;
      shardOrbs.forEach((s, i) => (s.ring.rotation.y = time * 0.1 + i));
    }
    coreUniforms.uTime.value = time;
    coreUniforms.uMotion.value = state.motion ? 1 : 0;
    if (pulseGeo) {
      const P = pulseGeo.attributes.position;
      pulses.forEach((p, i) => {
        const q = p.curve.getPoint(state.motion ? (time * 0.11 + p.phase) % 1 : p.phase);
        P.array[i * 3] = q.x; P.array[i * 3 + 1] = q.y; P.array[i * 3 + 2] = q.z;
      });
      P.needsUpdate = true;
    }
    camera.angle = angle;
    camera.tilt = tilt;
    cam.position.set(look.x + Math.sin(angle) * Math.cos(tilt) * distance, look.y + Math.sin(tilt) * distance, look.z + Math.cos(angle) * Math.cos(tilt) * distance);
    cam.lookAt(look);
    cam.updateMatrixWorld();
    renderer.render(scene, cam);
    refreshProjected();
    if (((state.motion && onScreen) || transition) && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function redraw() {
    cancelAnimationFrame(frame);
    draw(performance.now(), true);
  }
  function fly(to, dist, a = angle, t = tilt) {
    tip.hidden = true;
    hoverId = null;
    hoverGroup = null;
    transition = { from: look.clone(), to: to.clone(), d0: distance, d1: dist, a0: angle, a1: a, t0: tilt, t1: t, start: performance.now(), ms: state.motion ? 850 : 0 };
    if (!state.motion) {
      look.copy(to);
      distance = dist;
      angle = a;
      tilt = t;
      transition = null;
    }
    updateUI();
    redraw();
  }
  function cortexAlpha(focused) {
    cortex.children.forEach((o) => {
      if (o.material?.uniforms?.alpha) o.material.uniforms.alpha.value = focused ? 0.055 : 0.15;
      else if (o.material) {
        if (o.userData.normalOpacity === undefined) o.userData.normalOpacity = o.material.opacity;
        o.material.opacity = focused ? o.userData.normalOpacity * 0.4 : o.userData.normalOpacity;
      }
    });
  }
  function focus(key) {
    const cell = cellMap.get(key), g = model.groups.find((g) => g.key === (cell?.group || key));
    if (!g) return;
    if (state.graphMode === 'overview' && cell?.drawer) {
      // A drawer of the overview opens in the storage mode.
      state.graphMode = 'storage';
      camera.focus = g.key;
      camera.cell = g.key + ':drawer:' + cell.drawer.split('/').slice(1).join('/');
      render();
      return;
    }
    camera.focus = g.key;
    camera.cell = cell?.key || null;
    createUnits();
    cortexAlpha(true);
    const radius = cell ? cell.radius * 1.65 : g.radius + 0.13, dist = (radius / (Math.tan((cam.fov * Math.PI) / 360) * Math.min(1, w / h))) * 1.2;
    fly(vec(cell?.center || g.center), Math.max(0.1, dist), cell ? angle : g.center.x < 0 ? -0.32 : 0.32, 0.18);
    if (state.tab === 'network') refreshEntryList();
  }
  function reset() {
    camera.focus = null;
    camera.cell = null;
    camera.panX = camera.panY = 0;
    createUnits();
    cortexAlpha(false);
    fly(center, baseDistance, 0.47, 0.4);
    if (state.tab === 'network') refreshEntryList();
  }
  function zoom(factor) {
    transition = null;
    distance = Math.max(0.3, Math.min(baseDistance * 2, distance / factor));
    updateUI();
    redraw();
  }
  function pick(p) {
    let best = -1, bd = Infinity;
    const r0 = Math.max(11, Math.min(22, (baseDistance / distance) * 5));
    for (let i = 0; i < units.length; i++) {
      if (!screenV[i]) continue;
      const u = units[i];
      if (camera.focus && u.g.key !== camera.focus) continue;
      const d = Math.hypot(screenX[i] - p.x, screenY[i] - p.y);
      if (d < (u.cell ? 18 : r0) && (d < bd || (d === bd && screenZ[i] < screenZ[best]))) { bd = d; best = i; }
    }
    if (best >= 0) return { node: units[best], index: best };
    const g = groupHits.filter((g) => g.visible && Math.hypot(g.x - p.x, g.y - p.y) < g.r).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    return { g };
  }
  const short = (t) => String(t).trim().split(/\s+/).slice(0, 5).join(' ');
  function setHover(i) {
    if (!coreGeo || i === hoverIndex) return;
    const S = coreGeo.attributes.aSize, Dt = coreGeo.attributes.aDetail;
    if (hoverIndex >= 0 && units[hoverIndex]) {
      S.array[hoverIndex] = units[hoverIndex].base;
      const u = units[hoverIndex];
      Dt.array[hoverIndex] = u.e && (u.e.id === state.selected || (u.g.trail && u.e.id === u.g.trail.c.id)) ? 1 : 0;
    }
    hoverIndex = i;
    if (i >= 0) {
      S.array[i] = units[i].base * 1.3;
      Dt.array[i] = 1;
    }
    S.needsUpdate = true;
    Dt.needsUpdate = true;
  }
  function hoverAt(p) {
    const { node, g, index } = pick(p);
    hoverId = node?.e?.id || null;
    hoverGroup = node?.g?.key || g?.key || null;
    canvas.style.cursor = node || g ? 'pointer' : 'grab';
    tip.hidden = !node && !g;
    if (node?.e) {
      const e = node.e;
      const rc = e.recall ? (e.recall.sessions ? `injected in ${num(e.recall.sessions)} sessions` : 'never injected') : 'injection not measurable';
      tip.innerHTML = `<span class="flag-kicker">${esc(types[e.type] || e.type)} · ${esc(drawerOf(e).toUpperCase())}</span><strong>${esc(short(e.title))}</strong><span class="flag-log">Entry ${esc(e.id)} · ${esc(e.source)}</span><span class="flag-author">${esc(e.agent)} · ${rc} · ${camera.focus || node.g.trail ? 'Click: open' : 'Click: focus the group'}</span>`;
    } else if (node?.cell) {
      tip.innerHTML = `<span class="flag-kicker">${node.cell.drawer ? 'DRAWER · ' + esc(node.cell.drawer.toUpperCase()) : 'SUBGROUP'}</span><strong>${pluralEntries(node.members.length)}</strong><span>Left click: ${state.graphMode === 'overview' ? 'open the drawer' : 'next level of detail'}</span>`;
    } else if (g)
      tip.innerHTML = `<span class="flag-kicker">${state.graphMode === 'storage' || state.graphMode === 'overview' ? 'PROJECT · STORAGE' : 'KNOWLEDGE GROUP'}</span><strong>${esc(short(g.label))}</strong><span>${pluralEntries(g.members.length)} · left click to fly in</span>`;
    if (!tip.hidden) {
      tip.style.left = Math.max(8, Math.min(w - tip.offsetWidth - 8, p.x + 19)) + 'px';
      tip.style.top = Math.max(8, Math.min(h - tip.offsetHeight - 8, p.y + 17)) + 'px';
    }
    setHover(node ? index : -1);
    setEdgeAlpha();
    if (!state.motion) redraw();
  }
  function local(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function baseline() {
    const p = [...pointers.values()];
    gesture = p.length > 1 ? { kind: 'pinch', cx: (p[0].x + p[1].x) / 2, cy: (p[0].y + p[1].y) / 2, dist: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) } : p.length ? { kind: 'drag', ...p[0] } : null;
  }
  function pan(dx, dy) {
    const right = v(1, 0, 0).applyQuaternion(cam.quaternion), up = v(0, 1, 0).applyQuaternion(cam.quaternion), scale = (distance * 2 * Math.tan((cam.fov * Math.PI) / 360)) / h;
    look.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
  }
  canvas.onpointerdown = (e) => {
    if (e.button !== 0) return;
    transition = null;
    canvas.focus({ preventScroll: true });
    pointers.set(e.pointerId, local(e));
    down = local(e);
    dragged = pointers.size > 1;
    baseline();
    canvas.setPointerCapture(e.pointerId);
    tip.hidden = true;
  };
  canvas.onpointermove = (e) => {
    const p = local(e);
    if (pointers.has(e.pointerId)) {
      const old = gesture;
      pointers.set(e.pointerId, p);
      baseline();
      if (pointers.size > 1 && old?.kind === 'pinch') {
        distance = Math.max(0.3, Math.min(baseDistance * 2, (distance * old.dist) / Math.max(1, gesture.dist)));
        pan(gesture.cx - old.cx, gesture.cy - old.cy);
        dragged = true;
      } else if (old) {
        const dx = p.x - old.x, dy = p.y - old.y;
        if (Math.hypot(p.x - down.x, p.y - down.y) > 4) dragged = true;
        if (e.shiftKey) pan(dx, dy);
        else {
          angle -= dx * 0.007;
          tilt = Math.max(-1.35, Math.min(1.35, tilt + dy * 0.006));
        }
      }
      updateUI();
      redraw();
    } else hoverAt(p);
  };
  function finish(e, cancel = false) {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e), pinch = pointers.size > 1;
    pointers.delete(e.pointerId);
    if (!cancel && !dragged && !pinch) {
      const { node, g } = pick(p);
      if (node?.cell) focus(node.cell.key);
      else if (node?.e) {
        if (camera.focus === node.g.key || node.g.trail) showDetail(node.e.id, 'content');
        else focus(node.g.key);
      } else if (g) focus(g.key);
    }
    baseline();
  }
  canvas.onpointerup = (e) => finish(e);
  canvas.onpointercancel = (e) => finish(e, true);
  canvas.onpointerleave = () => {
    tip.hidden = true;
    hoverId = hoverGroup = null;
    setHover(-1);
    setEdgeAlpha();
    if (!state.motion) redraw();
  };
  const context = (e) => {
    e.preventDefault();
    reset();
  };
  viewport.addEventListener('contextmenu', context);
  const wheel = (e) => {
    e.preventDefault();
    zoom(Math.exp(-Math.max(-160, Math.min(160, e.deltaY * (e.deltaMode === 1 ? 16 : 1))) * 0.0025));
  };
  viewport.addEventListener('wheel', wheel, { passive: false });
  canvas.onkeydown = (e) => {
    if (['0', 'Escape', '+', '=', '-', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
    else return;
    if (e.key === '0' || e.key === 'Escape') reset();
    else if (e.key === '+' || e.key === '=') zoom(1.2);
    else if (e.key === '-') zoom(1 / 1.2);
    else {
      transition = null;
      if (e.shiftKey) pan(e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0, e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0);
      else {
        angle += e.key === 'ArrowLeft' ? -0.14 : e.key === 'ArrowRight' ? 0.14 : 0;
        tilt = Math.max(-1.35, Math.min(1.35, tilt + (e.key === 'ArrowUp' ? 0.12 : e.key === 'ArrowDown' ? -0.12 : 0)));
      }
      redraw();
    }
  };
  function resize() {
    const r = viewport.getBoundingClientRect();
    w = r.width;
    h = r.height;
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    coreUniforms.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const old = baseDistance;
    // The cloud's node ellipsoid fills the picture tightly (margin ~10 %, height at
    // the base tilt 0.4), so the nodes do not sink small into the fog.
    {
      const a = cloud.axes, m = Math.hypot(cloud.center.x, cloud.center.y, cloud.center.z), tan = Math.tan((cam.fov * Math.PI) / 360), across = Math.max(a.x, a.z);
      const high = Math.hypot(a.y * Math.cos(0.4), across * Math.sin(0.4)) + m;
      baseDistance = Math.max(2.2, Math.max((1.1 * high) / tan, (1.2 * (across + m)) / (tan * cam.aspect)));
    }
    if (!camera.focus && !transition) distance *= baseDistance / old;
    updateUI();
    redraw();
  }
  createUnits();
  const visibility = new IntersectionObserver((items) => {
    onScreen = items[0].isIntersecting;
    if (onScreen) redraw();
    else if (!transition) cancelAnimationFrame(frame);
  });
  visibility.observe(viewport);
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  document.addEventListener('visibilitychange', redraw);
  graphAPI = {
    zoom, reset, focus, redraw,
    inspect: () => ({
      points: units.map((u, i) => ({ id: u.e?.id, key: u.key, group: u.g.key, x: screenX[i], y: screenY[i], z: screenZ[i], visible: !!screenV[i], bright: coreGeo?.attributes.aBright.array[i] })),
      groups: groupHits.map((g) => ({ key: g.key, x: g.x, y: g.y, r: g.r })),
      edgeCount: model.edges.length,
      strands: edgeVisuals.map((e) => ({ count: e.count, from: e.a.key, to: e.b.key })),
      camera: { distance, baseDistance, angle, tilt, transitioning: !!transition, look: look.toArray() },
      fps: fps.value,
      drawCalls: renderer.info.render.calls,
      model,
    }),
  };
  graphCleanup = () => {
    graphCleanup = () => {};
    dead = true;
    graphAPI = null;
    cancelAnimationFrame(frame);
    observer.disconnect();
    visibility.disconnect();
    document.removeEventListener('visibilitychange', redraw);
    viewport.removeEventListener('contextmenu', context);
    viewport.removeEventListener('wheel', wheel);
    resources.forEach((r) => r.dispose?.());
    renderer.dispose();
    renderer.forceContextLoss();
  };
  resize();
  if (camera.focus) {
    const saved = camera.cell || camera.focus;
    focus(saved);
  } else updateUI();
}
function refreshEntryList() {
  const el = $('.graph-entry-list');
  if (!el) return;
  const focus = graphListEntries();
  el.innerHTML = entryRows(focus.slice(0, 80), 'Your first entries will appear here.');
}

// --- Detail, dialogs, forms -----------------------------------------------------
let detailCache = new Map();
async function fetchEntry(id) {
  if (detailCache.has(id)) return detailCache.get(id);
  try {
    const r = await fetch('/dashboard/entry.json?id=' + encodeURIComponent(id), { credentials: 'same-origin', cache: 'no-store' });
    const b = await r.json();
    detailCache.set(id, b);
    return b;
  } catch (e) {
    return { state: 'error', reason: e?.message || String(e) };
  }
}
async function showDetail(id, tab = 'content') {
  const e = byId(id);
  if (!e) return;
  state.selected = id;
  state.drawerTab = tab;
  const head = `<div class="drawer-head"><div class="top"><span class="label">${esc(types[e.type])} / ${esc(id)}</span><button class="iconbtn" data-close="detail" aria-label="Close the detail">✕</button></div><h2 id="detailTitle">${esc(e.title)}</h2><div class="small quiet">${esc(e.project)} · ${esc(e.agent)} · ${esc(e.source)}</div></div><nav class="tabs" aria-label="Entry details">${[['content', 'Content'], ['evidence', 'Evidence trail'], ['history', 'History'], ['raw', 'Raw fields']]
    .map(([k, n]) => `<button class="${tab === k ? 'active' : ''}" data-detail-tab="${k}" ${tab === k ? 'aria-current="page"' : ''}>${n}</button>`)
    .join('')}</nav>`;
  $('#detail').innerHTML = head + `<div class="drawer-body"><div class="loading compact"><span class="loading-core" aria-hidden="true"></span><p>Reading the entry …</p></div></div>`;
  if (!$('#detail').open) $('#detail').showModal();
  const k = await fetchEntry(id);
  if (state.selected !== id || state.drawerTab !== tab || !$('#detail').open) return;
  const text = typeof k.text === 'string' && k.text ? k.text : e.text;
  const out = e.rels, incoming = incomingIndex.get(id) || [];
  const isOpen = statusOf(id) === 'open' || statusOf(id) === 'active';
  const may = !state.readonly;
  let body = '';
  if (tab === 'content')
    body = `${badge(statusOf(id))}${e.why ? `<p class="small muted" style="margin-top:8px">${esc(e.why)}</p>` : ''}<div class="detailtext">${esc(text || '(no text)')}</div>${e.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<div class="metadata"><div><span>Author</span><b>${esc(e.agent)}</b></div><div><span>Time</span><b>${esc(e.ts)}</b></div><div><span>Memory / project</span><b>${esc(e.memory)} / ${esc(e.project)}</b></div><div><span>Drawer</span><b>${esc(drawerOf(e))}</b></div><div><span>Injected</span><b>${e.recall ? (e.recall.sessions ? num(e.recall.sessions) + ' sessions' : 'never') : 'not measurable'}</b></div><div><span>Place</span><b>${esc(e.source)}</b></div><div><span>Basis / authority</span><b>${esc(e.basis || 'not declared')} / ${esc(e.authority || '—')}</b></div><div><span>Scope / built on</span><b>${esc(e.scope || '—')} / ${e.derivedFrom.length ? e.derivedFrom.map(esc).join(', ') : 'nothing declared'}</b></div></div><div class="drawer-actions">${btn('Write a correction', 'correct', `data-id="${esc(id)}"`, 'primary')}${e.type === 'question' ? btn('Link an answer', 'answer', `data-id="${esc(id)}" ${!isOpen ? 'disabled' : ''}`, 'ghost') : btn('Mark done', 'done', `data-id="${esc(id)}" ${may && isOpen ? '' : 'disabled'}`, 'ghost')}${btn('Discard', 'retire', `data-id="${esc(id)}" ${!isOpen ? 'disabled' : ''}`, 'ghost danger')}${e.state !== 'active' ? btn('Restore', 'restore', `data-id="${esc(id)}"`, 'ghost') : ''}${btn('Merge …', 'merge', `data-id="${esc(id)}"`, 'ghost')}${btn('Show in the network', 'show-in-graph', `data-id="${esc(id)}"`, 'ghost')}</div>`;
  else if (tab === 'evidence') {
    const bi = k.entry ? { state: k.state, reason: k.reason, sources: k.entry.backlinks || [] } : null;
    const rows = (list) =>
      list.map((x) => `<div class="row"><span class="badge">${esc(edgeLabels[x.kind] || x.kind)}</span>${byId(x.id) ? open(x.id, byId(x.id).title, 'textlink') : `<span class="mono small">${esc(x.id)} · outside</span>`}</div>`).join('') || empty('No declared links.');
    body = `<div class="row"><strong>Backlink index</strong>${bi ? badge(bi.state || 'unknown') : badge('unknown')}</div>${bi?.reason ? note(esc(bi.reason)) : ''}${note('Outgoing links stand in the entry itself; incoming ones come from the maintained backlink index (D1b) and from this pass.')}<h3 style="margin-top:22px">Outgoing · ${out.length}</h3>${rows(out.map(([kind, id2]) => ({ kind, id: id2 })))}<h3 style="margin-top:22px">Incoming · ${incoming.length}</h3>${rows(incoming)}${bi?.sources?.length ? `<h3 style="margin-top:22px">According to the index · ${bi.sources.length}</h3>${rows(bi.sources)}` : ''}${e.capture ? `<div style="margin-top:18px">${btn('See the original capture', 'raw-open', `data-id="${esc(e.capture)}"`, 'ghost')}</div>` : ''}${note('Only origin links belong to the source chain. A cause, a contradiction or a resolution is not automatically independent evidence.')}`;
  } else if (tab === 'history')
    body = `<div class="timeline"><div class="event"><time>${esc(e.ts)}</time><h3>Written down</h3><p>${esc(e.agent)} · ${esc(e.id)} · ${esc(e.source)}</p></div>${e.replaces ? `<div class="event"><time>REPLACES</time><h3>Correction of ${esc(e.replaces)}</h3>${byId(e.replaces) ? open(e.replaces, 'Open the original ↗') : '<p>The original is not in this store.</p>'}</div>` : ''}${e.state !== 'active' ? `<div class="event"><time>${esc(e.state.toUpperCase())}</time><h3>State: ${esc(e.state)}</h3><p>${esc(e.why || 'no reason recorded')}</p></div>` : ''}${incoming.filter((x) => x.kind === 'replaces').map((x) => `<div class="event"><time>${esc(byId(x.id)?.ts || '')}</time><h3>Replaced by ${esc(x.id)}</h3>${open(x.id, 'Open the new entry ↗')}</div>`).join('')}${e.recall ? `<div class="event"><time>${esc(e.recall.last || 'RECALL')}</time><h3>${e.recall.sessions ? `Injected in ${num(e.recall.sessions)} sessions` : 'Never injected yet'}</h3><p>${num(e.recall.mentions)} mentions in the injection journal</p></div>` : ''}</div>${note('Entries are never overwritten. Changes appear as additional lines or new entries.')}`;
  else body = `<pre>${esc(JSON.stringify({ line: k.raw ?? null, card: k.entry ?? null, state: k.state, derivedState: statusOf(id) }, null, 2))}</pre>`;
  $('#detail .drawer-body').innerHTML = body;
}
function showInfo(title, body) {
  $('#info').innerHTML = `<header><h2 id="infoTitle">${title}</h2><button class="iconbtn" data-close="info" aria-label="Close the dialog">✕</button></header>${body}`;
  if (!$('#info').open) $('#info').showModal();
}
// New entry / correction: NO write route from the browser (the sibling's
// decision of 2026-09-27, the same here). The form stays visible as in
// the mockup, but locked, and names the route that really does it.
function newEditor(id) {
  const e = id ? byId(id) : null;
  $('#editor').innerHTML = `<header><h2 id="editorTitle">${e ? 'Write a correction' : 'Capture knowledge'}</h2><button class="iconbtn" data-close="editor" aria-label="Close the form">✕</button></header><form id="entryForm" data-original="${esc(id || '')}"><fieldset disabled class="read-only-fields"><label class="formfield">Title<input class="field" name="title" required maxlength="180" value="${esc(e?.title || '')}"></label><div class="formgrid"><label class="formfield">Type<select class="field" name="type">${Object.entries(types)
    .map(([k, n]) => `<option value="${k}" ${k === (e?.type || 'thought') ? 'selected' : ''}>${n}</option>`)
    .join('')}</select></label><label class="formfield">Project<select class="field" name="project">${['global', ...(D?.projects || []).map((p) => p.name).filter((n) => n !== 'global')].map((n) => `<option ${n === (e?.project || (state.project !== 'all' ? state.project : 'global')) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label></div><label class="formfield">Content<textarea class="field" name="text" required>${esc(e?.text || '')}</textarea></label><label class="formfield">${e ? 'Reason for the correction' : 'Tags, comma separated'}<input class="field" name="reason" ${e ? 'required' : ''}></label></fieldset>${note(e ? 'The original would stay unchanged; a correction gets a new id and a replaces link. Today it is written only through the command line, where type checks and required fields sit.' : 'New entries are written today only by the command line or the MCP bridge (mem log) — that is where type checks, required fields and redaction sit. There is no gated route for it from the browser.')}<p>${readonlyMark(e ? `mem correction ${e.id} --text "…"` : 'mem log <type> "<title>" --text "…"')}</p><button class="btn primary" type="submit" disabled>${e ? 'Save the correction' : 'Save the entry'}</button></form>`;
  $('#editor').showModal();
}
function statusDialog(id, kind) {
  const e = byId(id);
  if (!e) return;
  if (kind === 'answer' || kind === 'retire') {
    showInfo(
      kind === 'answer' ? 'Choose the answering entry' : 'Discard an entry',
      `<p class="muted small">${esc(e.title)}</p><form id="statusForm" data-id="${esc(id)}" data-kind="${kind}" style="margin-top:20px"><fieldset disabled class="read-only-fields">${kind === 'answer' ? `<label class="formfield">Answering entry<select class="field" name="answer">${entries.filter((x) => x.id !== id).slice(0, 40).map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join('')}</select></label>` : ''}<label class="formfield">Reason<input name="reason" class="field" required></label></fieldset>${note(kind === 'answer' ? 'An answer is linked today only by the command line (mem answer) — there is no task for it from the browser.' : 'Discarding goes through the command line today. A task for it would be a new write route and is not built.')}<p>${readonlyMark(kind === 'answer' ? `mem answer ${id} …` : `mem discard ${id} --why "…"`)}</p><button class="btn primary" type="submit" disabled>Append</button></form>`,
    );
    return;
  }
  if (kind === 'restore' || kind === 'merge') {
    showInfo(
      kind === 'restore' ? 'Restore an entry' : 'Merge entries',
      kind === 'restore'
        ? `<p class="muted small">${esc(e.title)}</p><p class="small">Takes a closed entry up again as a NEW line with <code class="mono">restored_from</code>; the original and its tombstone stay untouched.</p><p>${readonlyMark(`mem restore ${id} --why "…"`)}</p>${note('Command line only, like discarding: the browser has no write route for it. Refused when the entry is not closed, is superseded (use the newer version) or is already restored.')}`
        : `<p class="muted small">${esc(e.title)}</p><p class="small">Merges entries of ONE drawer: a correction of the first carries the joined content and <code class="mono">merged_from</code>; the others get an obsolete tombstone. Nothing is deleted.</p><p>${readonlyMark(`mem merge ${id} <other-id> --why "…"`)}</p>${note('Command line only: the browser has no write route for it. Both entries stay readable in the log.')}`,
    );
    return;
  }
  // Marking done: the task "done" (mem done), the same command as the CLI.
  showInfo(
    'Document the completion',
    `<p class="muted small">${esc(e.title)}</p><form id="statusForm" data-id="${esc(id)}" data-kind="${kind}" style="margin-top:20px"><label class="formfield">Reason<input name="reason" class="field" maxlength="2000"></label><button class="btn primary" type="submit" ${state.readonly ? 'disabled' : ''}>Append</button></form><div id="statusState"></div>${note('Runs as a task through POST /task (the same command as on the CLI: mem done). Only appended — the original stays.')}`,
  );
}
function search() {
  if (!$('#command').open) $('#command').showModal();
  $('#commandInput').value = '';
  renderSearch('');
  $('#commandInput').focus();
}
function renderSearch(q) {
  q = q.toLowerCase().trim();
  const es = (q ? scoped().filter((e) => e._s.includes(q)) : scoped()).slice(0, 12),
    routes = Object.entries(sections)
      .flatMap(([a, s]) => [[a, s.name], ...s.tabs.map(([t, n]) => [a + '/' + t, n])])
      .filter((x) => q && x[1].toLowerCase().includes(q)),
    ms = q ? messages.filter((m) => (m.subject + ' ' + m.from + ' ' + m.to).toLowerCase().includes(q)).slice(0, 6) : [],
    rs = q ? rawSamples.filter((r) => (r.path + ' ' + (r.topics || []).join(' ')).toLowerCase().includes(q)).slice(0, 4) : [];
  $('#commandResults').innerHTML = `${state.missing ? note('Not every source was readable. The hits are incomplete.', 'bad') : ''}${routes.map(([p, n]) => `<button class="result" data-search-route="${p}"><span>↗</span><div>${esc(n)}<small>Open the view</small></div></button>`).join('')}${ms.map((m) => `<button class="result" data-action="message" data-id="${esc(m.name)}"><span>⇄</span><div>${esc(m.subject)}<small>Message · ${esc(m.from)} → ${esc(m.to)} · ${esc(situationWord[m.situation] || m.situation)}</small></div></button>`).join('')}${rs.map((r) => `<button class="result" data-action="raw-review" data-id="${esc(r.path)}"><span>▧</span><div>${esc(r.session || r.path)}<small>Raw capture · ${esc((r.topics || []).slice(0, 3).join(', ') || 'no topic')}</small></div></button>`).join('')}${es.map((e) => `<button class="result" data-search-entry="${esc(e.id)}"><span class="entry-icon">${esc((types[e.type] || '?')[0])}</span><div>${esc(e.title)}<small>${esc(types[e.type])} · ${esc(e.project)} · ${esc(e.id)}</small></div></button>`).join('')}${!es.length && !routes.length && !ms.length && !rs.length ? empty(entries.length ? 'Nothing found.' : 'Nothing found — this memory holds no entry yet.') : ''}<div id="commandMemory"></div>`;
  // The same search as "mem find" (BM25/synonyms), through the existing
  // read-only endpoint /entries.json — the palette searches the SAME
  // memory as the command line, in addition to the plain substring
  // search over the loaded slice above.
  paletteMemorySearch(q, es);
}
async function paletteMemorySearch(q, localHits) {
  const mine = ++paletteRun;
  const target = () => $('#commandMemory');
  if (!q) { if (target()) target().innerHTML = ''; return; }
  if (target()) target().innerHTML = '<p class="small quiet" style="margin-top:10px">Searching the memory …</p>';
  let hits = [];
  try {
    const r = await fetch('/entries.json?q=' + encodeURIComponent(q) + '&n=8', { credentials: 'same-origin', cache: 'no-store' });
    const b = await r.json().catch(() => null);
    if (r.ok && b && Array.isArray(b.entries)) hits = b.entries;
  } catch { /* the ranked search stays empty — the substring hits above stay */ }
  if (mine !== paletteRun || !target()) return; // a newer input overtook this answer
  const already = new Set((localHits || []).map((e) => e.id));
  const extra = hits.filter((t) => !already.has(t.id)).slice(0, 8);
  target().innerHTML = extra.length
    ? `<div class="label" style="margin:14px 0 4px">Ranked search in the memory (like "mem find")</div>${extra
      .map((t) => `<button class="result" data-search-entry="${esc(t.id)}"><span class="entry-icon">${esc((types[t.type] || '?')[0])}</span><div>${esc(t.headline)}<small>${esc(t.typeLabel)} · ${esc(t.project)} · ${esc(t.id)}</small></div></button>`)
      .join('')}`
    : '';
}
function getExport() {
  const project = $('#exportProject')?.value || 'global',
    global = $('#exportGlobal')?.checked ?? true,
    hist = $('#exportHistory')?.checked ?? true;
  const included = entries.filter((e) => (e.project === project || (global && e.project === 'global')) && (hist || e.state === 'active'));
  const ids = new Set(included.map((e) => e.id));
  return { project, included, refs: [...new Set(allEdges(included).map((e) => e.to).filter((id) => !ids.has(id)))], hist, global };
}
function updateExportPreview() {
  const x = getExport();
  $('#exportPreview').innerHTML = `<div class="number">${num(x.included.length)}</div><p class="muted small">entries for ${esc(x.project)}</p><div class="row"><span class="small">Global foundations</span><span class="small">${x.global ? 'Included' : 'As references only'}</span></div><div class="row"><span class="small">External entry references</span><span>${num(x.refs.length)}</span></div><div class="row"><span class="small">Completeness</span>${badge(state.missing ? 'unknown' : 'complete')}</div><div style="max-height:200px;overflow:auto;margin-top:15px">${x.included.slice(0, 200).map((e) => `<p class="small muted" style="padding:5px 0">${esc(e.id)} · ${esc(e.title)}</p>`).join('')}${x.included.length > 200 ? `<p class="small quiet">… and ${num(x.included.length - 200)} more</p>` : ''}</div>`;
}

// --- The mockup's extra views -----------------------------------------------------
function shardStage() {
  const ps = (D.projects || []).filter((p) => state.project === 'all' || p.name === state.project);
  const ks = D.net?.boxes || [];
  return `<section class="fabric-stage" aria-label="Spatial overview of the projects and drawers"><div class="fabric-heading"><div><span class="label">DISTRIBUTED MEMORY</span><h2>Many stores. One context.</h2></div>${badge(state.missing ? 'partial' : 'complete', state.missing ? 'incomplete' : 'live state')}</div><div class="fabric-grid">${ps
    .map((p, i) => `<button class="fabric-node" data-action="project" data-value="${esc(p.name)}" style="--delay:${-i * 0.75}s"><span class="crystal"><i></i><i></i><i></i><b></b></span><strong>${esc(p.name.toUpperCase())}</strong><small>${num(p.entries)} entries</small><span class="fabric-state">${num(ks.filter((k) => k.project === p.name).length)} drawers</span></button>`)
    .join('')}</div><div class="fabric-line"></div><div class="fabric-root"><span class="dot"></span> ${esc(D.meta?.git?.head || '—')} · logical whole view · ${esc(whenTime(D.at))}</div></section>`;
}
function edgeInventory() {
  const selected = scoped(), ids = new Set(selected.map((e) => e.id)), edges = allEdges(selected);
  const outside = edges.filter((x) => !ids.has(x.to)).length;
  const across = edges.filter((x) => byId(x.to) && drawerOf(byId(x.from)) !== drawerOf(byId(x.to))).length;
  const kinds = [...new Set(edges.map((e) => e.kind))];
  return `<details class="edge-inventory"><summary>All stored links <span>${num(edges.length)} · ${num(across)} across drawers · ${num(outside)} outside</span></summary><div class="edge-type-legend">${kinds
    .map((k) => `<span class="tag">${esc(edgeLabels[k] || k)} · ${num(edges.filter((e) => e.kind === k).length)}</span>`)
    .join('')}</div><div class="tablewrap edge-rows" data-count="${edges.length}"></div>${!edges.length ? empty('No stored references in this selection.') : ''}</details>`;
}
function edgeTable() {
  const selected = scoped(), ids = new Set(selected.map((e) => e.id)), edges = allEdges(selected);
  return `<table class="table"><thead><tr><th>Source</th><th>Kind →</th><th>Target</th><th>Reach</th></tr></thead><tbody>${edges
    .map((x) => `<tr><td>${byId(x.from) ? open(x.from, byId(x.from).title, 'textlink') : esc(x.from)}</td><td>${esc(edgeLabels[x.kind] || x.kind)} →</td><td>${byId(x.to) ? open(x.to, byId(x.to).title, 'textlink') : esc(x.to)}</td><td>${!ids.has(x.to) ? 'Outside the selection' : drawerOf(byId(x.from)) !== drawerOf(byId(x.to)) ? 'Between drawers' : 'In the same drawer'}</td></tr>`)
    .join('')}</tbody></table>`;
}

function toggleTheme() {
  state.light = !state.light;
  document.body.classList.toggle('light', state.light);
  try { localStorage.setItem('cm-dash-light', state.light ? '1' : '0'); } catch { /* without storage it stays with the tab */ }
  render();
}
function refreshSearch() {
  const pos = $('#entrySearch')?.selectionStart;
  render();
  const el = $('#entrySearch');
  if (el) {
    el.focus();
    el.setSelectionRange(pos, pos);
  }
}
function auditHtml() {
  const runs = Object.values(D?.tasks?.running || {}).filter(Boolean).sort((a, b) => String(b.started).localeCompare(String(a.started)));
  return runs.length
    ? `<div class="timeline">${runs.map((v) => `<div class="event"><time>${esc(v.started || '')}</time><h3>${esc(D.tasks.kinds[v.kind]?.title || v.kind)} · ${esc(taskState(v))}</h3><p>${esc(v.id)}${v.reason ? ' · ' + esc(v.reason) : ''}${v.params ? ' · ' + esc(JSON.stringify(v.params)) : ''}</p></div>`).join('')}</div>`
    : empty('No task started yet.');
}

// --- Clicks -----------------------------------------------------------------------
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('button,[data-route]');
  if (!el) return;
  const d = el.dataset;
  if (d.close) {
    $('#' + d.close).close();
    return;
  }
  if (d.searchRoute) {
    $('#command').close();
    route(d.searchRoute);
    return;
  }
  if (d.searchEntry) {
    $('#command').close();
    showDetail(d.searchEntry);
    return;
  }
  if (d.route) {
    route(d.route);
    return;
  }
  if (d.entry) {
    if ($('#info').open) $('#info').close();
    showDetail(d.entry);
    return;
  }
  if (d.detailTab) {
    showDetail(state.selected, d.detailTab);
    return;
  }
  if (el.id === 'mobileMenu') {
    document.body.classList.toggle('nav-open');
    el.setAttribute('aria-expanded', document.body.classList.contains('nav-open'));
    return;
  }
  const a = d.action;
  if (!a) return;
  switch (a) {
    case 'reload':
      if (await loadData()) render();
      break;
    case 'new-data':
      // no-jump: D is already current (the background keeps it that
      // way) — just draw here, no refetch needed.
      render();
      break;
    case 'search':
      search();
      break;
    case 'new':
      newEditor();
      break;
    case 'theme':
      toggleTheme();
      break;
    case 'motion':
      state.motion = !state.motion;
      document.body.classList.toggle('reduce-motion', !state.motion);
      render();
      break;
    case 'show-shards':
      state.memory = 'local';
      state.project = 'all';
      state.graphMode = 'storage';
      camera.focus = null;
      camera.cell = null;
      $('#projectScope').value = 'all';
      route('knowledge/network');
      break;
    case 'goto-export':
      route('sources/export');
      break;
    case 'goto-context':
      route('work/context');
      break;
    case 'goto-shards':
      route('ops/shards');
      break;
    case 'goto-operations':
      route('ops/operations');
      break;
    case 'graph-fullscreen': {
      const stage = $('#brain').closest('.brain-panel');
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (stage.requestFullscreen) {
        try {
          await stage.requestFullscreen();
        } catch {
          toast('Full screen is not available here.');
        }
      } else toast('This browser does not support full screen.');
      break;
    }
    case 'graph-mode':
      state.graphMode = d.value;
      camera.focus = null;
      camera.cell = null;
      camera.zoom = 1;
      camera.panX = camera.panY = 0;
      render();
      break;
    case 'graph-reset':
      graphAPI?.reset();
      break;
    case 'graph-zoom-in':
      graphAPI?.zoom(1.2);
      break;
    case 'graph-zoom-out':
      graphAPI?.zoom(1 / 1.2);
      break;
    case 'graph-focus':
      graphAPI?.focus(d.value);
      break;
    case 'show-in-graph':
      state.trail = d.id;
      state.graphMode = 'trail';
      camera.focus = null;
      camera.cell = null;
      $('#detail').close();
      route('knowledge/network');
      break;
    case 'prev':
      state.page = Math.max(1, state.page - 1);
      render();
      break;
    case 'next':
      state.page++;
      render();
      break;
    case 'reset-filters':
      state.query = '';
      state.type = state.status = 'all';
      state.page = 1;
      render();
      break;
    case 'topic':
      state.query = d.value;
      state.type = state.status = 'all';
      route('knowledge/entries');
      break;
    case 'agent-entries':
      state.query = d.value;
      route('knowledge/entries');
      break;
    case 'time-compare':
      factsAtLoad($('#validDate').value, $('#knownDate').value);
      break;
    case 'project':
      state.project = d.value;
      $('#projectScope').value = d.value;
      route('knowledge/entries');
      break;
    case 'export-project':
      state.project = d.value;
      $('#projectScope').value = d.value;
      route('sources/export');
      break;
    case 'correct':
      newEditor(d.id);
      break;
    case 'done':
    case 'retire':
    case 'answer':
    case 'restore':
    case 'merge':
      statusDialog(d.id, a);
      break;
    case 'raw-open':
      if (d.id) rawReview(d.id);
      break;
    case 'message':
      if ($('#command').open) $('#command').close();
      showMessageLatest(d.id);
      break;
    case 'new-message':
      showInfo(
        'Write a new message',
        `<form id="messageForm"><fieldset disabled class="read-only-fields"><label class="formfield">To<select class="field" name="to">${(D.inbox?.participants || []).map((t) => `<option>${esc(t.name)}</option>`).join('')}</select></label><label class="formfield">Subject<input name="title" class="field" required></label><label class="formfield">Text<textarea name="text" class="field" required></textarea></label></fieldset>${note('New messages are written today only by the command line (mem inbox write) or the MCP bridge. From the browser the check "am I really the sender named here" is missing — so read only here. Replies to a message work: there the sender is fixed by the message.')}<p>${readonlyMark('mem inbox write --to <name> --subject "…"')}</p><button class="btn primary" type="submit" disabled>Store the message</button></form>`,
      );
      break;
    case 'inbox-state': {
      if (state.readonly) return toast('Read only is active.');
      el.disabled = true;
      const r = await formPost('/inbox/state', { name: d.id, state: d.value });
      if (!r.ok) {
        el.disabled = false;
        return toast('Not acknowledged: ' + r.reason);
      }
      toast('Message marked as ' + d.value + '.');
      if (await loadData({ quiet: true })) {
        render();
        showMessageLatest(d.id);
      }
      break;
    }
    case 'raw-export':
      await rawExport(el);
      break;
    case 'export-json':
    case 'export-html':
      toast('A project package export is not built into the product yet.');
      break;
    case 'shard-detail': {
      const es = scoped().filter((e) => drawerOf(e) === d.value);
      showInfo('Drawer ' + esc(d.value), entryRows(es.slice(0, 40)) + limitNote(Math.min(40, es.length), es.length) + note('A drawer is a JSONL file: project × type. No file is opened.'));
      break;
    }
    case 'audit':
      showInfo('Task log', auditHtml());
      break;
    case 'print':
      window.print();
      break;
    case 'sign-out': {
      el.disabled = true;
      try { await fetch('/login/logout', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } }); } catch { /* on to the sign-in */ }
      // Leave nothing protected on the device (the server also sends Clear-Site-Data).
      try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch { /* no cache access */ }
      location.href = '/login?signedout=1';
      break;
    }
    case 'save-config': {
      if (state.readonly) return;
      const current = Object.fromEntries((D.settings || []).map((x) => [x.id, x]));
      const changes = [];
      for (const f of $$('.setting-field')) {
        const id = f.dataset.id, value = f.value.trim();
        if (String(value) !== String(current[id]?.value ?? '')) changes.push([id, value]);
      }
      if (!changes.length) return toast('Nothing changed.');
      for (const [id, value] of changes) {
        const r = await formPost('/setting', { id, value });
        if (!r.ok) return toast('Not set: ' + r.reason);
      }
      toast('Settings saved and logged.');
      if (await loadData({ quiet: true })) render();
      break;
    }
    case 'probe-ask': {
      const field = $('#probeQuestion');
      const questionText = field?.value.trim();
      if (!questionText) return toast('Please type a question.');
      el.disabled = true;
      $('#probeResult').innerHTML = '<p class="small quiet">Checking …</p>';
      const r = await probeAsk(questionText);
      el.disabled = false;
      probeLast = r;
      $('#probeResult').innerHTML = probeResultHtml(r);
      break;
    }
    case 'today-verify-verdict': {
      if (state.readonly) return toast('Read only is active.');
      const rowEl = el.closest('[data-verify-row]');
      const buttons = rowEl?.querySelectorAll('button');
      buttons?.forEach((b) => { b.disabled = true; });
      const r = await verifyVerdictWrite({
        key: d.key, project: d.project || '', verdict: d.verdict,
        ageDays: d.ageDays || '', conflict: d.conflict || '0',
      });
      if (!r.ok) {
        buttons?.forEach((b) => { b.disabled = false; });
        return toast('Not recorded: ' + (r.reason || r.state));
      }
      toast('Recorded (' + d.verdict + ') — appended outside this memory.');
      if (rowEl) rowEl.innerHTML = `<div><span class="small quiet">Recorded: ${esc(d.verdict)} — thank you.</span></div>`;
      break;
    }
    case 'today-gold-verdict': {
      if (state.readonly) return toast('Read only is active.');
      const rowEl = el.closest('[data-gold-row]');
      const buttons = rowEl?.querySelectorAll('button');
      buttons?.forEach((b) => { b.disabled = true; });
      const r = await goldVerdictWrite({
        id: d.id || '', occasion: d.occasion, source: d.source, verdict: d.verdict, expected: d.expected || '[]',
      });
      if (!r.ok) {
        buttons?.forEach((b) => { b.disabled = false; });
        return toast('Not recorded: ' + (r.reason || r.state));
      }
      toast('Recorded (' + d.verdict + ') — appended outside this memory.');
      if (rowEl) rowEl.innerHTML = `<div><span class="small quiet">Recorded: ${esc(d.verdict)} — thank you.</span></div>`;
      break;
    }
    case 'operation-step': {
      if (state.readonly) return toast('Read only is active.');
      el.disabled = true;
      const s = await taskStart({ kind: d.value });
      if (!s.ok) {
        el.disabled = false;
        return toast('Not started: ' + reasonPlain(s.reason || s.state));
      }
      toast('Task started: ' + (D.tasks.kinds[d.value]?.title || d.value));
      const u = await taskOverview();
      if (u?.running) D.tasks.running = u.running;
      render();
      taskPolling();
      break;
    }
    case 'operation-stop': {
      if (state.readonly) return toast('Read only is active.');
      el.disabled = true;
      const s = await taskCancel(d.value);
      toast(s.ok ? 'Cancel confirmed: the process ended.' : 'Not cancelled: ' + (s.reason || s.state));
      const u = await taskOverview();
      if (u?.running) D.tasks.running = u.running;
      render();
      break;
    }
    case 'operation-refresh': {
      const u = await taskOverview();
      if (u?.running) D.tasks.running = u.running;
      render();
      taskPolling();
      break;
    }
    case 'raw-review':
      if ($('#command').open) $('#command').close();
      rawReview(d.id);
      break;
    case 'raw-select-all':
      for (const r of filteredRaw().slice(0, 50)) if (r.state !== 'deleted') rawPicked.add(r.path);
      $('#rawRows').innerHTML = rawRows();
      break;
    case 'raw-delete-preview':
      if (state.readonly) return toast('Read only is active.');
      rawDeletePreview(d.id ? [d.id] : [...rawPicked]);
      break;
  }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'commandInput') renderSearch(e.target.value);
  if (e.target.id === 'entrySearch') {
    state.query = e.target.value;
    state.page = 1;
    refreshSearch();
  }
  if (e.target.id === 'catalogSearch') $('#catalogList').innerHTML = catalogHtml(e.target.value);
  if (e.target.id === 'rawQuery') {
    rawFilter.query = e.target.value;
    $('#rawRows').innerHTML = rawRows();
  }
  if (e.target.id === 'inboxQuery') {
    state.inboxQuery = e.target.value;
    $('#inboxRows').innerHTML = inboxRows();
  }
});
document.addEventListener('change', (e) => {
  const id = e.target.id, v = e.target.value;
  if (id === 'graphModeSelect') {
    state.graphMode = v;
    camera.focus = null;
    camera.cell = null;
    camera.zoom = 1;
    camera.panX = camera.panY = 0;
    render();
  }
  if (id === 'memoryScope' || id === 'projectScope') {
    state[id === 'memoryScope' ? 'memory' : 'project'] = v;
    state.page = 1;
    render();
  }
  if (['typeFilter', 'statusFilter', 'sortFilter'].includes(id)) {
    state[{ typeFilter: 'type', statusFilter: 'status', sortFilter: 'sort' }[id]] = v;
    state.page = 1;
    render();
  }
  if (id === 'contextCase') {
    state.context = v;
    $('#contextContent').innerHTML = contextContent();
  }
  if (['exportProject', 'exportGlobal', 'exportHistory'].includes(id)) updateExportPreview();
  if (id === 'readOnly') {
    state.readonly = e.target.checked;
    render();
    toast(state.readonly ? 'Read only is active.' : 'Writing through the existing routes is allowed.');
  }
  if (['rawSince', 'rawUntil', 'rawState', 'rawProject'].includes(id)) {
    rawFilter[{ rawSince: 'since', rawUntil: 'until', rawState: 'state', rawProject: 'project' }[id]] = v;
    rawPicked = new Set();
    $('#rawRows').innerHTML = rawRows();
  }
  if (e.target.classList?.contains('raw-pick')) {
    if (e.target.checked) rawPicked.add(e.target.dataset.path);
    else rawPicked.delete(e.target.dataset.path);
    const k = $('.raw-tally span:last-child');
    if (k) k.textContent = rawPicked.size ? `${num(rawPicked.size)} selected` : '';
  }
  if (id === 'inboxTo') {
    state.inboxTo = v;
    render();
  }
  if (id === 'inboxAll') {
    state.inboxAll = e.target.checked;
    $('#inboxRows').innerHTML = inboxRows();
  }
});
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.classList?.contains('edge-inventory') && d.open) {
    const box = d.querySelector('.edge-rows');
    if (box && !box.dataset.filled) {
      box.innerHTML = edgeTable();
      box.dataset.filled = '1';
    }
  }
}, true);
// Change the password: /login/password (src/login.mjs). The checks here
// are only for quick feedback — the server checks everything itself.
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (f.id !== 'passwordForm') return;
  e.preventDefault();
  const say = (t, kind) => { $('#pwMeldung').innerHTML = note(esc(t), kind); };
  const current = $('#pwAlt').value, next = $('#pwNeu').value, next2 = $('#pwNeu2').value;
  if (!current) return say('Please enter the current password.', 'bad');
  if (next.length < PW_MIN) return say(`The new password needs at least ${PW_MIN} characters.`, 'bad');
  if (next !== next2) return say('The two entries of the new password do not match.', 'bad');
  const knob = f.querySelector('button[type=submit]');
  knob.disabled = true;
  let r, j = {};
  try {
    r = await fetch('/login/password', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ current, next, next2 }) });
    j = await r.json().catch(() => ({}));
  } catch (err) {
    knob.disabled = false;
    return say('No connection: ' + (err?.message || err), 'bad');
  }
  knob.disabled = false;
  if (r.status === 401 && j.reason === 'login-required') { location.href = '/login'; return; }
  if (!r.ok) return say(j.reason || `Not changed (answer ${r.status}).`, 'bad');
  f.reset();
  say('Password changed. Every other device is signed out.', 'good');
  toast('Password changed.');
});
document.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!['entryForm', 'statusForm', 'messageForm', 'replyForm', 'rawDeleteForm'].includes(f.id)) return;
  e.preventDefault();
  if (state.readonly) return toast('Read only is active.');
  const data = Object.fromEntries(new FormData(f));
  if (f.id === 'entryForm' || f.id === 'messageForm') return toast('There is no write route for that from the browser — see the CLI note.');
  if (f.id === 'statusForm') {
    const kind = f.dataset.kind, id = f.dataset.id;
    if (kind !== 'done') return toast('There is no write route for that from the browser — see the CLI note.');
    const fields = { kind: 'done', id };
    if (data.reason) fields.why = data.reason;
    const button = f.querySelector('button[type=submit]');
    button.disabled = true;
    $('#statusState').innerHTML = '<p class="small muted">The task is running …</p>';
    const s = await taskStart(fields);
    if (!s.ok) {
      button.disabled = false;
      $('#statusState').innerHTML = note('Not appended: ' + esc(s.reason || s.state), 'bad');
      return;
    }
    const res = await waitForTask(s.id);
    if (res.state !== 'ok') {
      $('#statusState').innerHTML = note(esc(res.reason || res.state), res.state === 'warning' ? '' : 'bad');
      button.disabled = false;
      return;
    }
    $('#info').close();
    detailCache.delete(id);
    toast('Appended. The original stays.');
    if (await loadData({ quiet: true })) {
      render();
      showDetail(id, 'history');
    }
    return;
  }
  if (f.id === 'replyForm') {
    const button = f.querySelector('button[type=submit]');
    button.disabled = true;
    const r = await formPost('/inbox/reply', { name: f.dataset.id, text: String(data.text || '') });
    if (!r.ok) {
      button.disabled = false;
      return toast('Not stored: ' + r.reason);
    }
    toast('Reply stored. It is delivered with the next commit and push.');
    if (await loadData({ quiet: true })) {
      render();
      showMessageLatest(f.dataset.id);
    }
    return;
  }
  if (f.id === 'rawDeleteForm') {
    const paths = JSON.parse(f.dataset.paths || '[]');
    const reason = String(data.reason || '').trim();
    if (reason.length < 3 || !data.yes) return toast('A reason and the confirmation are required.');
    f.querySelector('button[type=submit]').disabled = true;
    await rawDelete(paths, reason);
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    search();
  }
  if (e.key === 'Escape') {
    document.body.classList.remove('nav-open');
    $('#mobileMenu').setAttribute('aria-expanded', 'false');
  }
});
window.addEventListener('popstate', () => {
  const [a, t] = location.hash.slice(1).split('/');
  state.area = sections[a] ? a : 'home';
  state.tab = sections[state.area].tabs.some((x) => x[0] === t) ? t : sections[state.area].tabs[0]?.[0] || '';
  render();
});
for (const d of $$('dialog'))
  d.addEventListener('click', (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    }
  });

// --- Atmosphere: the mockup's own WebGL background, unchanged ----------------------
// Decorative pixels never stand for memory content.
let ambience = null, premiumObserver = null;
function initAtmosphere() {
  const c = document.createElement('canvas');
  c.id = 'atmosphere';
  c.setAttribute('aria-hidden', 'true');
  document.body.prepend(c);
  const gl = c.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'low-power' });
  if (!gl) return;
  const vertex = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const fragment = `precision mediump float;uniform vec2 res;uniform float time;uniform vec2 pointer;uniform vec3 tint;void main(){vec2 uv=gl_FragCoord.xy/res;vec2 p=(uv-.5)*vec2(res.x/res.y,1.);p+=pointer*.025;float a=0.;float strands=0.;for(int i=0;i<6;i++){float f=float(i);float y=.23*sin(p.x*2.8+time*.13+f*.37)+.08*cos(p.x*5.5-time*.1+f);float d=abs(p.y-y+.035*f);a+=.003/(d+.025);strands+=.00035/(abs(d-.05)+.002);}float orb=exp(-length(p-vec2(.45,.24)) * 2.8);vec3 col=tint*(a*.23+strands*.1)+vec3(.16,.3,.3)*orb*.18;float mask=smoothstep(0.,.4,uv.x);gl_FragColor=vec4(col,mask*.7);}`;
  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    return s;
  }
  const vs = shader(gl.VERTEX_SHADER, vertex), fs = shader(gl.FRAGMENT_SHADER, fragment);
  if (!vs || !fs) return;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const u = { res: gl.getUniformLocation(program, 'res'), time: gl.getUniformLocation(program, 'time'), pointer: gl.getUniformLocation(program, 'pointer'), tint: gl.getUniformLocation(program, 'tint') };
  let time = 0, frame = 0, last = 0, mx = 0, my = 0;
  function draw(now = 0) {
    cancelAnimationFrame(frame);
    if (now - last > 33 || !state.motion) {
      if (state.motion) time += 0.024;
      last = now;
      gl.uniform2f(u.res, c.width, c.height);
      gl.uniform1f(u.time, time);
      gl.uniform2f(u.pointer, mx, my);
      const hues = { home: [0.55, 0.85, 0.4], knowledge: [0.37, 0.65, 0.9], work: [0.7, 0.5, 0.86], sources: [0.73, 0.68, 0.4], ops: [0.3, 0.8, 0.65], settings: [0.55, 0.63, 0.72] };
      gl.uniform3fv(u.tint, hues[state.area]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (state.motion && !document.hidden) frame = requestAnimationFrame(draw);
  }
  function resize() {
    const ratio = Math.min(1, 1100 / innerWidth);
    c.width = Math.round(innerWidth * ratio);
    c.height = Math.round(innerHeight * ratio);
    gl.viewport(0, 0, c.width, c.height);
    draw();
  }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => draw());
  document.addEventListener('pointermove', (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; }, { passive: true });
  ambience = { draw };
  resize();
}
function decoratePage() {
  document.body.dataset.area = state.area;
  const motionButton = $('.global-motion');
  if (motionButton) {
    motionButton.textContent = state.motion ? 'Ⅱ' : '▶';
    motionButton.setAttribute('aria-label', state.motion ? 'Pause all animations' : 'Resume all animations');
  }
  document.body.classList.toggle('reduce-motion', !state.motion);
  const h = $('.pageheading');
  if (h) {
    const art = document.createElement('div');
    art.className = 'hero-art';
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML = '<i></i><i></i><i></i><span></span>';
    h.append(art);
  }
  if (state.area === 'ops' && state.tab === 'shards') $('.screen-enter').insertAdjacentHTML('beforeend', shardStage());
  if ($('#brain')) $('#graphGroups').insertAdjacentHTML('afterend', edgeInventory());
  premiumObserver?.disconnect();
  // **Threshold 0, not 0.07 (dash-fix4, 2026-09-28).** `.reveal` holds a
  // panel at opacity 0 until it is revealed. With `threshold: 0.07` a
  // panel must show 7 % of ITS OWN area — a long one (60 duties = 32 000
  // px on a phone, 40 learnings = 15 000 px, the Today card = 21 000 px)
  // never gets there in an 844 px window and stayed invisible forever:
  // heading and tabs, then nothing, no message. Threshold 0 fires as
  // soon as any pixel is on screen, whatever the height. Without
  // IntersectionObserver (old browsers) nothing is hidden at all.
  premiumObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('revealed');
            premiumObserver.unobserve(e.target);
          }
        }),
      { threshold: 0 },
    )
    : null;
  $$('#screen .panel,#screen .metrics,#screen .fabric-stage').forEach((el, i) => {
    if (!premiumObserver) return;
    el.style.setProperty('--reveal-delay', Math.min(i, 5) * 55 + 'ms');
    el.classList.add('reveal');
    premiumObserver.observe(el);
  });
  ambience?.draw();
  if (state.tab === 'operations') taskPolling();
}
document.addEventListener(
  'pointermove',
  (e) => {
    const card = e.target.closest('.panel,.metric,.fabric-node');
    if (!card || !state.motion) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', ((e.clientX - r.left) / r.width) * 100 + '%');
    card.style.setProperty('--my', ((e.clientY - r.top) / r.height) * 100 + '%');
  },
  { passive: true },
);

// --- Start ----------------------------------------------------------------------
document.fonts.ready.then(() => graphAPI?.redraw());
try {
  if (localStorage.getItem('cm-dash-light') === '1') {
    state.light = true;
    document.body.classList.add('light');
  }
} catch { /* without storage: dark like the mockup */ }
initAtmosphere();
document.body.classList.toggle('reduce-motion', !state.motion);
render();
loadData().then((ok) => {
  if (!ok) return;
  const initial = location.hash.slice(1);
  if (initial) route(initial);
  else render();
});

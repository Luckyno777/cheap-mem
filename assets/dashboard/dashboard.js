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
    tabs: [['tasks', 'Duties & questions'], ['agents', 'Agents'], ['inbox', 'Inbox'], ['calendar', 'Calendar'], ['context', 'Agent context'], ['usage', 'Usage'], ['understanding', 'User & ledger']],
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
  contradicts: 'Contradicts', resolves: 'Resolves', derived: 'Derived (a guess)',
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
  inboxTo: null, inboxAll: false, inboxQuery: '', topic: '',
};
// Full-text search (src/fulltext.mjs): the server's answer always belongs to ONE
// query (`q`). Only an answer to the CURRENT input counts; anything else is dropped.
//   ids: Set of hit ids; measurable:false = the server could not search
//   One path for every search input: each source (knowledge field, quick search) has its
//   own state but asks through the same function fulltextAsk().
function fulltextSource(current, redraw) {
  // F23: the answer comes in pages. more/cursor = there are more hits (the cursor holds only for the
  // server's index generation); loading = "load more" is running; fresh:false = the server answers from an
  // old index and rebuilds (we ask again after a short while, at most FULLTEXT_RETRIES times).
  return { q: null, ids: null, measurable: null, reason: null, timer: 0, run: 0, current, redraw, more: false, cursor: null, loading: false, fresh: true, tries: 0, triesQ: null };
}
const fulltext = fulltextSource(() => state.query, () => { if ($('#entrySearch')) redrawSearchField(); });
const fulltextPalette = fulltextSource(() => $('#commandInput')?.value ?? '', () => redrawPalette());
const FULLTEXT_DEBOUNCE_MS = 150;
const FULLTEXT_RETRIES = 6, FULLTEXT_RETRY_MS = 1500;
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
// --- run-helper-cm: request runs (audit F18-F20) --------------------------------
// No framework. One monotonically rising run number and one AbortController per
// view/request family: whoever starts a new run aborts the old one. A run may only
// take over its state while `run.holds(selectionHolds)` is true (no newer run, not
// aborted, selection still the same). Deadline (absolute time) and budget (number
// of requests) are two separate quantities: `runBudget().take()` returns null,
// 'deadline' or 'budget' — the caller then shows an end state.
const runs = new Map(); // family -> { nr, abort, signal, holds, result }
function runStart(family) {
  const old = runs.get(family);
  if (old) old.abort.abort();
  const abort = new AbortController();
  const run = { family, nr: (old?.nr || 0) + 1, abort, signal: abort.signal, result: null };
  run.holds = (selectionHolds) => runs.get(family) === run && !abort.signal.aborted && (selectionHolds ? Boolean(selectionHolds()) : true);
  runs.set(family, run);
  return run;
}
const runCancel = (family) => { runs.get(family)?.abort.abort(); };
const runResult = (family) => runs.get(family)?.result ?? null;
function runBudget({ deadlineMs, requests }) {
  const until = Date.now() + deadlineMs;
  let n = 0;
  return {
    get requests() { return n; },
    take() { if (Date.now() >= until) return 'deadline'; if (n >= requests) return 'budget'; n += 1; return null; },
  };
}
// Waits ms; false when the run was aborted in the meantime.
function runWait(run, ms) {
  return new Promise((ok) => {
    if (run.signal.aborted) { ok(false); return; }
    const t = setTimeout(() => { run.signal.removeEventListener('abort', ab); ok(true); }, ms);
    const ab = () => { clearTimeout(t); ok(false); };
    run.signal.addEventListener('abort', ab, { once: true });
  });
}
const runAborted = (e) => e?.name === 'AbortError';
// --- end run-helper-cm -----------------------------------------------------------
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
  if (g != null) return `${num(g)} entries`;
  // board-tempo-cm: only a part is loaded -> the server's number, never the length of the part.
  if (!entriesLoad.full && D?.overview) return `${num(D.overview.count)} entries (incl. history)`;
  return `${num(entries.length)} entries (incl. history)`;
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
// X3b: a rule that is not released (proposed/trial/withdrawn) carries a visible
// label in EVERY entry display. The status comes from the server (field `status`,
// the same function as in the CLI); released rules and legacy rules have no
// field and get no mark.
// X3c: "Always present" sounds like "in force". The status arrives finished
// from the server (procedure.statusFor -> `ruleStatus`, absent otherwise):
// no mark = released/legacy -> stays; "trial" stays with a visible label
// (entryRows adds ruleTag); proposed, withdrawn, unknown -> out.
const coreRuleHolds = (e) => !e.ruleStatus || e.ruleStatus === 'trial';
const ruleTag = (status) => (status ? `<span class="badge warn rule-status" data-rule-status="${esc(status)}" title="Not a rule in force: ${esc(status)}">${esc(status)}</span>` : '');
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
// --- Agents page (#work/agents, parity with the sibling house 2026-10-01) -----------
// One row per agent instead of a card with eight fields. The page measures
// nothing new: activity/pause/startable/channel arrive finished from the
// server (src/dashboard.mjs agentSignals), the open mail from the inbox list
// (the same 48 h line as the Inbox tab). Here they are only SUMMARISED.
// The one state per agent:
//   warning — mail to this agent waiting longer than 48 h, an active
//             non-human writer without registration, an expired pause,
//             a silent_until that is not a readable date
//   good    — only with positive evidence: two sources confirm "alive"
//   unknown — everything else. "unknown" and "not seen" NEVER count as good.
// cheap-mem has no watcher process, so nothing here produces "error" —
// a fourth state is not invented to fill the slot.
// No penalty by design: an agent that cannot be started locally (a foreign
// agent, a human) is not expected to send a heartbeat; an inbox bell
// nobody has proven yet ("unknown") is a note, never a reason.
const AG_MAIL_WAIT_MIN = 48 * 60;
const AG_ACTIVE_DAYS = 7;
const agentIsHuman = (a) => a.name.startsWith('human') || (D?.inbox?.human && a.name === D.inbox.human);
const agentKind = (a) => (agentIsHuman(a) ? 'Human' : a.registered ? 'Agent' : 'Unregistered writer');
function agoText(t, now = Date.now()) {
  const ms = new Date(t).getTime();
  if (!t || !Number.isFinite(ms)) return '—';
  const min = (now - ms) / 60000;
  if (min < 0) return when(t);
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  const days = Math.round(min / 1440);
  if (days < 60) return days === 1 ? '1 day ago' : `${days} days ago`;
  return when(t);
}
// Open mail per agent — only when the inbox list is really here (it arrives
// deferred); otherwise null = "not measured", never 0.
function agentMail(a) {
  const known = D?.inbox?.readable && (!D?.parts?.inbox || partState.inbox === 'ok');
  if (!known) return null;
  const mine = messages.filter((m) => m.to === a.name && m.situation !== 'done');
  const ages = mine.map((m) => m.ageMin).filter((x) => Number.isFinite(x));
  return { open: mine.length, waiting: mine.filter((m) => m.situation === 'waiting').length, oldestMin: ages.length ? Math.max(...ages) : null };
}
function agentStatus(a, now = Date.now()) {
  const reasons = [];
  const notes = [];
  const kind = agentKind(a);
  const human = kind === 'Human';
  const act = a.activity || {};
  const p = a.pause || {};
  const lastMs = a.last ? new Date(a.last).getTime() : NaN;
  const active = (Number.isFinite(lastMs) && now - lastMs <= AG_ACTIVE_DAYS * 864e5) || act.state === 'alive';
  const mail = agentMail(a);
  if (mail?.waiting) reasons.push(`${num(mail.waiting)} ${mail.waiting === 1 ? 'message' : 'messages'} waiting longer than 48 h`);
  if (active && !a.registered && !human) reasons.push('writes, but not registered (no agents/<name>/ folder)');
  if (p.state === 'expired') reasons.push('pause expired');
  if (p.state === 'unknown' && p.until) reasons.push('silent_until is not a readable date');
  if (a.startable && !a.startable.local && a.registered) notes.push('no local start, so no heartbeat expected (by design, no penalty)');
  if (human) notes.push('human: no registration or heartbeat expected (no penalty)');
  let state;
  if (reasons.length) state = 'warning';
  else if (act.state === 'alive') { state = 'good'; notes.unshift('alive: two sources confirm'); }
  else {
    state = 'unknown';
    notes.unshift(act.state === 'unknown' ? 'only one of two sources confirms' : 'no source confirms a sign of life');
  }
  if (p.state === 'paused') notes.push(`paused until ${p.until || '—'}`);
  const group = state === 'warning' ? 'attention' : active ? 'active' : 'idle';
  return { state, reasons, notes, active, group, kind, mail };
}
// "Alive" has three values from the server: alive (two sources), unknown
// (exactly ONE source), not seen (none). The bare word "unknown" next to
// "not seen" read like two kinds of not knowing — so the count stands beside it.
const aliveSources = (s) => (s === 'alive' ? '2 of 2 sources' : s === 'unknown' ? '1 of 2 sources' : s === 'not seen' ? '0 of 2 sources' : 'not measured');
function agentRow(a, l, now = Date.now()) {
  const es = state.project !== 'all' ? scoped().filter((e) => e.agent === a.name) : null;
  const p = a.pause || {};
  const act = a.activity || {};
  const pause = p.state === 'paused' ? `until ${esc(p.until || '—')}${p.why ? ' · ' + esc(p.why) : ''}` : p.state === 'expired' ? 'expired' : p.state === 'unknown' ? 'unknown' : 'none';
  const why = [...l.reasons, ...l.notes].join(' · ');
  const m = l.mail;
  const mailCell = m === null ? '<span title="the inbox list is not loaded or not readable">—</span>' : m.open ? `${num(m.open)}<span class="quiet ag-oldest"> · ${age(m.oldestMin)}</span>` : '0';
  const details = `<div class="ag-detail"><p class="small quiet">${esc(a.role || 'no role recorded')}${a.model ? ' · ' + esc(a.model) : ''}${a.channel?.reason ? ' · ' + esc(a.channel.reason) : ''}</p><div class="stats-list"><div class="row ag-state-row"><span>State</span><span>${badge(l.state)} <span class="small quiet">${esc(why) || '—'}</span></span></div><div class="row"><span>Registration</span>${a.registered ? badge('present') : badge('missing', 'no folder')}</div><div class="row"><span>Alive (two sources)</span><span>${badge(act.state || 'unknown')} <span class="small quiet">${aliveSources(act.state)}</span></span></div><div class="row"><span>Heartbeat / activity</span><span class="small">${act.heartbeat?.ageMin != null ? age(act.heartbeat.ageMin) : 'never'} / ${act.content?.ageMin != null ? age(act.content.ageMin) : 'never'}</span></div><div class="row"><span>Pause (silent_until)</span><span class="small">${pause}</span></div><div class="row"><span>Locally startable</span><span class="small">${a.startable ? (a.startable.local ? 'yes' : 'no') : 'unknown'}</span></div><div class="row"><span>Inbox bell</span>${badge(a.channel?.state || 'unknown')}</div><div class="row"><span>Open mail</span><span class="small">${m === null ? 'not measured' : m.open ? `${num(m.open)} · oldest ${age(m.oldestMin)}` : '0'}</span></div><div class="row"><span>Last entry</span><span class="small">${a.last ? `${whenTime(a.last)} · ${agoText(a.last, now)}` : '—'}</span></div>${es ? `<div class="row"><span>In the chosen project</span><span class="small">${pluralEntries(es.length)}</span></div>` : ''}</div></div>`;
  return `<details class="ag-row" data-agent="${esc(a.name)}" data-state="${l.state}"><summary><span class="ag-cell ag-name"><i class="ag-arrow" aria-hidden="true">›</i><span><strong>${esc(a.name)}</strong> <span class="tag ag-kind">${l.kind}</span></span></span><span class="ag-cell ag-state" title="${esc(why)}">${badge(l.state)}<span class="ag-why">${esc(why)}</span></span><span class="ag-cell ag-num"><span class="ag-lbl">Entries </span>${num(a.count ?? 0)}</span><span class="ag-cell ag-num" title="${a.last ? esc(whenTime(a.last)) : ''}">${a.last ? agoText(a.last, now) : '—'}</span><span class="ag-cell ag-num${m?.waiting ? ' gold' : ''}"><span class="ag-lbl">Mail </span>${mailCell}</span><span class="ag-cell ag-action">${btn('Contributions', 'agent-entries', `data-value="${esc(a.name)}"`, 'ghost small')}</span></summary>${details}</details>`;
}
function entryRows(list, emptyText) {
  return (
    list
      .map(
        (e) =>
          `<div class="row"><div class="row-main"><span class="entry-icon">${esc(types[e.type]?.[0])}</span><div>${open(e.id, e.title, 'open-entry textlink')}${ruleTag(e.ruleStatus)}<p>${esc(types[e.type])} · ${esc(e.project)} · ${esc(e.agent)}</p></div></div>${badge(statusOf(e.id))}</div>`,
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
  // board-tempo-cm: for a large store the first answer carries only the
  // newest entries (`d.parts.entries`); the rest comes page by page
  // (loadEntriesPart). A list that is already complete stays until the one of
  // the new state is here — never back to the part.
  if (!d.parts?.entries) { setEntries(d.entries || []); entriesLoad = { full: true, loaded: entries.length, total: entries.length, key: null }; }
  else if (entriesLoad.key === null) {
    setEntries(d.entries || []);
    entriesLoad = { full: false, loaded: entries.length, total: d.parts.entries.count, key: null };
  }
  // tempo: messages and captures arrive deferred (`d.parts`, loadParts()) —
  // if they are in the answer after all (older server), they count as before.
  if (!d.parts?.inbox) setMessages(d.inbox?.messages || []);
  if (!d.parts?.raw) setCaptures(d.raw?.readable ? d.raw.captures || [] : []);
  if (!d.parts?.experiences) setExperiences(D.experiences || []);
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
// One entry from the server's shape into the page's (list, net, atlas pages).
function entryOf(e) {
  const x = {
    id: e.id, type: e.type, title: e.title, project: e.project, text: e.text || '', tags: e.tags || [], topic: e.topic || null, rels: e.out || [],
    refs: (e.out || []).map((r) => r[1]), agent: e.agent || '—', ts: e.ts || '', memory: 'local', state: e.state || 'active',
    why: e.why || null, source: e.source ? e.source + (e.line ? ':' + e.line : '') : '—', readable: !!e.readable, recall: e.recall ?? null,
    capture: e.capture || null, validFrom: e.validFrom || null, validUntil: e.validUntil || null, fact: e.fact || null, replaces: e.replaces || null,
    cited: e.cited || 0, contested: !!e.contested, basis: e.basis || null, authority: e.authority || null, scope: e.scope || null,
    derivedFrom: e.derivedFrom || [], key: e.key || null, ruleStatus: e.status || null,
  };
  x._s = (x.id + ' ' + x.title + ' ' + x.text + ' ' + x.tags.join(' ') + ' ' + (x.topic || '') + ' ' + x.agent + ' ' + x.project + ' ' + (types[x.type] || '')).toLowerCase();
  return x;
}
function setEntries(list) {
  entries = (list || []).map(entryOf);
  entries.sort((a, b) => b.ts.localeCompare(a.ts));
  entryIndex = new Map(entries.map((e) => [e.id, e]));
  incomingIndex = new Map();
  for (const e of entries) for (const [kind, id] of e.rels) {
    if (!incomingIndex.has(id)) incomingIndex.set(id, []);
    incomingIndex.get(id).push({ kind, id: e.id });
  }
  // Loaded atlas pages stay findable across a new state (the detail card).
  for (const pg of atlasPages.values()) for (const e of pg.list) if (!entryIndex.has(e.id)) entryIndex.set(e.id, e);
}
// --- board-tempo-cm: entries page by page -------------------------------------
// At most this many entries does the page hold (memory, 3D net, lists). Above
// that it stays with the newest ones — with the visible figure "x of y
// loaded"; the counters then come from `D.overview` (server), the search
// goes through the server (palette and full-text search).
const ENTRIES_CAP = 30000;
let entriesLoad = { full: true, loaded: 0, total: 0, key: null };
let entriesDisturbance = null; // F19: visible end state when loading the list did not come to an end (text or null)
let entriesLoadingFor = null; // state key of the running load (no second run for the same one)
let partRetryTimer = 0;
// F19: the page loop must not start over endlessly when the state (state_id) changes between
// the pages. Restarts and deadline are separate from the request budget.
const ENTRIES_RESTARTS = 3;
const ENTRIES_DEADLINE_MS = 120000;
const ENTRIES_STATE_TEXT = 'The data is changing right now, the list was not taken over — please load again.';
const stateKey = (d) => (d?.cache ? d.cache.built_at + '|' + d.cache.source : null);
// A part that is still being built (`building`) is no error: ask again soon
// (at most one timer) — and the page never shows it as an empty list.
// Bounded (wackler repair 2026-10-07, like F20): the retries of one waiting spell share a
// deadline and a request budget (run helper); when they run out the part ends in a VISIBLE
// state with the button "Load again" instead of asking every 3 s forever.
const PART_LATER_DEADLINE_MS = 120000;
const PART_LATER_REQUESTS = 40;
let partLater = null; // { run, budget, names, ended } of the current waiting spell, null when nothing waits (reset when every part is there or by a click on "Load again")
function partLaterAgain(name) {
  if (!partLater) partLater = { run: runStart('part-later'), budget: runBudget({ deadlineMs: PART_LATER_DEADLINE_MS, requests: PART_LATER_REQUESTS }), names: new Set() };
  const spell = partLater;
  // Already ended in this round: the other parts of the same round end the same way, no new spell with a new budget.
  if (spell.ended) { partLaterEnd({ names: new Set(name ? [name] : []) }, spell.ended); return; }
  if (name) spell.names.add(name);
  if (partRetryTimer) return;
  const limit = spell.budget.take();
  if (limit) { spell.ended = limit; partLaterEnd(spell, limit); return; }
  partRetryTimer = 1;
  runWait(spell.run, TEMPO_TEST_MS ?? 3000).then((ok) => { if (partLater !== spell) return; partRetryTimer = 0; if (ok) loadParts(); });
}
function partLaterEnd(spell, limit) {
  const text = 'The part is still being built — ' + (limit === 'deadline' ? 'the time limit (' + Math.round(PART_LATER_DEADLINE_MS / 1000) + ' s) ran out.' : 'the budget of ' + PART_LATER_REQUESTS + ' requests is used up.') + ' Please load again.';
  let changed = false;
  for (const name of spell.names) {
    if (partReason[name] !== text) changed = true;
    partReason[name] = text;
    if (name === 'entries') { if (partState.entries !== 'ok') partState.entries = 'error'; if (entriesDisturbanceSet(text)) changed = true; } else if (partState[name] !== 'ok') partState[name] = 'error';
  }
  if (changed) render(); // an ended spell that is hit again by a quiet refresh draws nothing new
}
// Every part of the deferred set is there: a later "building" starts a new waiting spell with a new budget.
function partsAllThere() {
  return Object.keys(D?.parts || {}).filter((n) => n !== 'atlas').every((n) => partState[n] === 'ok' || (n === 'entries' && D.parts.entries.head_only));
}
// Reports 'error' only when the text changes (loadParts then draws once), never on every retry.
function entriesDisturbanceSet(text) {
  const fresh = entriesDisturbance !== text;
  entriesDisturbance = text;
  return fresh ? 'error' : null;
}
async function loadEntriesPart() {
  const t = D?.parts?.entries;
  const key = stateKey(D);
  // `head_only`: the server has no full list (light head for a very large store).
  if (!t || t.head_only || !key || key === entriesLoad.key || key === entriesLoadingFor) return null;
  const run = runStart('entries');
  entriesLoadingFor = key;
  const wasThere = partState.entries === 'ok';
  if (!wasThere) partState.entries = 'loading';
  const list = [];
  let from = 0;
  let stateId = null;
  let windowed = false; // atlas-pass-cm: the compact build lists only the newest window of the store
  let restarts = 0;
  const pagesMax = Math.ceil(ENTRIES_CAP / Math.max(1, t.page || 5000)) + 1;
  const budget = runBudget({ deadlineMs: ENTRIES_DEADLINE_MS, requests: pagesMax * (ENTRIES_RESTARTS + 1) });
  let end = null; // end state without an exception: 'state' | 'deadline' | 'budget'
  try {
    while (from !== null && list.length < ENTRIES_CAP) {
      const limit = budget.take();
      if (limit) { end = limit; break; }
      const n = Math.min(t.page || 5000, ENTRIES_CAP - list.length);
      // Literal, not t.path — the closed route list (test/dashboard-page.test.mjs) sees literal ones only.
      const r = await fetch('/dashboard/part.json?part=entries&from=' + from + '&n=' + n, { credentials: 'same-origin', cache: 'no-store', signal: run.signal });
      if (!r.ok) throw new Error('answer ' + r.status);
      const b = await r.json();
      if (!run.holds()) return null; // a newer run took over
      if (b.building) { partLaterAgain('entries'); return null; }
      if (b.state !== 'ok' || !Array.isArray(b.data)) throw new Error(b.reason || 'state ' + b.state);
      // Another state in the middle of the run: never mix pages of different states, at most restart a bounded number of times.
      if (stateId !== null && b.state_id !== stateId) {
        list.length = 0; from = 0; stateId = null;
        restarts += 1;
        if (restarts > ENTRIES_RESTARTS) { end = 'state'; break; }
        continue;
      }
      stateId = b.state_id;
      list.push(...b.data);
      from = b.next;
      windowed = Boolean(b.window);
      entriesLoad.total = b.total;
    }
  } catch (e) {
    if (runAborted(e) || !run.holds()) return null;
    partReason.entries = e?.message || String(e);
    if (partState.entries !== 'ok') partState.entries = 'error';
    return entriesDisturbanceSet('The entry list could not be loaded: ' + partReason.entries);
  } finally {
    if (run.holds()) entriesLoadingFor = null;
  }
  if (!run.holds()) return null;
  if (end) {
    // End state instead of a silent loop or a mixed list: a list that is already whole stays in place.
    partReason.entries = end === 'state' ? ENTRIES_STATE_TEXT : end === 'deadline' ? 'Time limit for loading the entries exceeded — please load again.' : 'Request budget for loading the entries used up — please load again.';
    if (!wasThere) partState.entries = 'error';
    return entriesDisturbanceSet(partReason.entries);
  }
  entriesDisturbance = null;
  const before = entries.length;
  setEntries(list);
  entriesLoad = { full: from === null && !windowed, loaded: entries.length, total: entriesLoad.total, key };
  partState.entries = 'ok';
  partReason.entries = null;
  return wasThere ? (entries.length !== before ? 'changed' : null) : 'first';
}
// The counters of the start page: from the loaded list when it is whole —
// otherwise from the server's overview (D.overview), never from the part.
function areaFigures(es) {
  const u = D?.overview;
  if (entriesLoad.full || !u) {
    return { count: es.length, readable: es.filter((e) => e.readable).length, skills: es.filter((e) => e.type === 'skill').length + es.filter((e) => e.type === 'procedure').length, part: false };
  }
  const z = state.project === 'all' ? u : u.perProject?.[state.project] || { count: 0, readable: 0, perType: {} };
  return { count: z.count, readable: z.readable, skills: (z.perType?.skill || 0) + (z.perType?.procedure || 0), part: true };
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
let experienceList = []; // learnings with citation counts (deferred part `experiences`)
function setExperiences(list) { experienceList = list || []; }
// The inbox list also feeds the per-agent mail column of the agents page.
const PART_TAB = { inbox: ['inbox', 'agents'], raw: ['raw'], experiences: ['learnings'] };
// no-jump point 3: render() only when a part turns 'ok' for the FIRST
// time and its tab is currently open (before that it said "loading" —
// that MUST be shown). Every later refetch of the same part is a quiet
// background sync like loadData() — a marker on a real change, never its
// own render().
async function loadParts() {
  // `entries` loads page by page, `atlas` only when the page zooms into a topic or a drawer (atlasLoad).
  const parts = Object.keys(D?.parts || {}).filter((name) => name !== 'entries' && name !== 'atlas');
  const firstOk = [];
  let otherChanged = false;
  const entriesRun1 = loadEntriesPart();
  await Promise.all(parts.map(async (name) => {
    const wasOk = partState[name] === 'ok';
    if (!wasOk) partState[name] = 'loading';
    try {
      // Literal, not a computed path — the closed route list (test/dashboard-page.test.mjs) sees literal ones only.
      const r = await fetch('/dashboard/part.json?part=' + encodeURIComponent(name), { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error('answer ' + r.status);
      const b = await r.json();
      // Not built yet (a head from disk) — no error, ask again soon.
      if (b.building) { partLaterAgain(name); return; }
      if (b.state !== 'ok' || !Array.isArray(b.data)) throw new Error(b.reason || 'state ' + b.state);
      const key = JSON.stringify(b.data);
      const changed = partContentKey[name] !== undefined && partContentKey[name] !== key;
      partContentKey[name] = key;
      if (name === 'inbox') setMessages(b.data);
      else if (name === 'raw') setCaptures(b.data);
      else if (name === 'experiences') setExperiences(b.data);
      partState[name] = 'ok';
      partReason[name] = null;
      if (!wasOk) firstOk.push(name);
      else if (changed) otherChanged = true;
    } catch (e) {
      partReason[name] = e?.message || String(e);
      if (partState[name] !== 'ok') partState[name] = 'error';
    }
  }));
  // The entries concern every view (start page, net, lists): draw once when
  // they are complete for the first time, afterwards only the marker.
  const e = await entriesRun1;
  if (!partRetryTimer && partsAllThere()) partLater = null; // everything arrived: the next spell gets a new deadline and budget (an ended spell stays until the click on "Load again")
  if (e === 'first' || e === 'error' || firstOk.some((name) => (PART_TAB[name] || []).includes(state.tab))) render();
  else if (otherChanged || e === 'changed') showNewDataMark();
}
function partNotice(name, title) {
  if (!D?.parts?.[name] || partState[name] === 'ok') return null;
  if (partState[name] === 'error') return panel(title, note('Not loaded: ' + esc(partReason[name] || 'unknown') + ' — an empty list would be a false statement here.', 'bad') + `<p style="margin-top:12px">${btn('Load again', 'reload', '', 'primary')}</p>`);
  return panel(title, note(`Loading … (${num(D.parts[name].count)} items)`));
}
// Confirmed projects: the server's cache may trail the write (under load it rebuilds in the background).
// What a click just confirmed stays confirmed on the page, also after a quiet reload with the old state:
// a project never becomes "new" again. Applied to the Today card and to the project shelf.
const projectsConfirmed = new Set();
function projectsConfirmedApply() {
  if (!projectsConfirmed.size || !D) return;
  if (D.today?.projects && Array.isArray(D.today.projects.list)) D.today.projects.list = D.today.projects.list.filter((p) => !projectsConfirmed.has(p.name));
  for (const p of D.projectShelf?.projects || []) if (projectsConfirmed.has(p.name) && p.isNew) p.isNew = false;
}
// F18: a late answer of an older request must not overwrite the newer state.
// A new call aborts the old one; the old one then returns the result of the new one
// (whoever does `await loadData()` and then render() so always draws the newest state).
function loadData({ quiet = false } = {}) {
  const run = runStart('data');
  run.result = loadDataRun(run, quiet);
  return run.result;
}
async function loadDataRun(run, quiet) {
  const newer = () => runResult('data');
  try {
    const r = await fetch('/dashboard.json', { credentials: 'same-origin', cache: 'no-store', signal: run.signal });
    if (!run.holds()) return newer();
    // Session expired or ended (another device, a password change): go to
    // the sign-in instead of an error over empty data.
    if (r.status === 401) { location.href = '/login'; return false; }
    if (!r.ok) throw new Error('answer ' + r.status);
    const body = await r.json();
    if (!run.holds()) return newer();
    // no-jump: build the content key BEFORE prepare() (that mutates fields
    // onto `d` itself) and only flag a real change once there is already
    // a baseline to compare against (not on the very first load).
    const newKey = contentKey(body);
    const changed = lastContentKey !== null && newKey !== null && newKey !== lastContentKey;
    if (newKey !== null) lastContentKey = newKey;
    prepare(body);
    catReapply();
    projectsConfirmedApply();
    loadError = null;
    loadParts();
    // Whether THIS call gets drawn is always the caller's decision (a user
    // action calls render() right after — rahmen/task point 5). A real
    // change here shows the quiet marker — if a render() follows right
    // away (any user action), render() hides it again in the same pass,
    // so it never visibly flickers.
    if (changed) showNewDataMark();
    // tempo: when the answer is not fresh, ask again quietly until it is —
    // every second while only the placeholder stands (board-tempo-cm: the quick
    // head is seconds away), soon when the server already rebuilds, otherwise less often (it
    // rebuilds at most every 20 s). At most one refetch waits.
    // no-jump: this refetch no longer draws by itself — it would replace
    // #screen no matter where the human is reading/typing/scrolling.
    // Paused while the tab is not visible (point 4).
    if (D?.cache && !D.cache.fresh && !refetchTimer && !document.hidden) {
      refetchTimer = setTimeout(async () => {
        refetchTimer = 0;
        // board-tempo-cm: what stands on the screen while only the placeholder
        // is there is NOTHING — the first real state is drawn at once (unlike a
        // later background refresh, which only sets the marker).
        const wasPlaceholder = Boolean(D?.placeholder);
        await loadData({ quiet: true });
        if (wasPlaceholder && D && !D.placeholder) render();
      }, TEMPO_TEST_MS ?? (D.placeholder ? 1000 : D.cache.refreshing ? 5000 : 20000));
    }
  } catch (e) {
    if (runAborted(e) || !run.holds()) return newer();
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
      // board-tempo-cm: before the first build nothing is measured — a view
      // over no data would say "no entry yet", which would be false.
      html += D.placeholder
        ? panel('State unknown', note('The first state is being built in the background. This page asks again by itself — until then there is nothing measured to show.'))
        : pages[state.tab]();
    } catch (e) {
      html += panel('View cannot be drawn', note('This sub-view could not be drawn: ' + esc(e?.message || String(e)) + '. State: unknown — an empty area would be a false statement here.', 'bad'));
    }
  }
  // board-tempo-cm: only a part of the entries is loaded -> every view says so (never a part as the whole).
  const disturbanceHtml = entriesDisturbance ? `<div id="entriesDisturbance">${note(esc(entriesDisturbance), 'bad')}<p style="margin:8px 0 12px">${btn('Load again', 'reload', '', 'small ghost')}</p></div>` : '';
  const partBanner = disturbanceHtml + (!D.placeholder && !entriesLoad.full && D.overview
    ? '<div id="entriesLoad">' + note(`${num(entriesLoad.loaded)} of ${num(entriesLoad.total || D.overview.count)} entries loaded${D.parts?.entries?.head_only ? ' — the server only has the counters and the newest entries for a store this large' : D.parts?.entries?.window || entriesLoad.loaded >= ENTRIES_CAP ? ' — lists show the newest, all through the search' + (D.atlas?.condensed ? '; the atlas shows all of them as topics' : '') : ' — the rest is loading, the lists are not complete yet'}.`) + '</div>'
    : '');
  // The compact build (a store the full build cannot handle) is no unreadable source but a limit: say that.
  const compactNote = D.compact ? note(esc((D.reasons || [])[0] || 'The compact build runs.') + ' What needs the whole store is unknown, not zero — each view says why.') : '';
  // A light head is no unreadable source but a limit: say that instead.
  const lightNote = D.light ? note('Only counters and the newest entries are shown: ' + esc((D.reasons || [])[0] || 'the full build did not run') + ' — the tiles of the full build are unknown, not zero.') : '';
  $('#screen').innerHTML = `<div class="screen-enter">${partBanner}${lightNote}${compactNote}${state.missing && !D.placeholder && !D.light && !D.compact ? note('Not every source was readable: ' + esc((D.reasons || []).join(' · ') || entries.filter((e) => !e.readable).length + ' entries without a readable line') + '. Completeness unknown.', 'bad') : ''}${html}</div>`;
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
  if ($('#skillCatalog')) skCatalogLoad();
  if ($('#calendarView') || $('#homeDay')) calendarLoad();
  decoratePage();
}
function pageTitle() {
  return (
    {
      entries: 'Everything that stays.', network: 'Knowledge has connections.', topics: 'The common thread.', facts: 'What holds. And since when.',
      learnings: 'Better from experience.', skills: 'Knowledge that turns into doing.', books: 'Many entries. One context.',
      tasks: 'What still needs someone.', agents: 'Thinking further, together.', inbox: 'Every handover traceable.', calendar: 'What is coming up.',
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
      calendar: 'Appointments, reminders and scheduled agent actions, read from appointments/ - the same list as mem appointment today. Written by the CLI and the agents\' proposals, never from this page.',
      context: 'What the hooks really injected last — from the injection journal, no simulation.',
      export: 'Check the scope, understand the dependencies and load the project package as JSON.',
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
// Projects that wait for a person (src/today.mjs part f): made with `mem project new` (status new) or past
// the command. The same button and task as in the Projects tab. Nothing open = nothing shown.
function todayProjectsPart(list) {
  if (!list.length) return '';
  return `<div class="label" style="margin:16px 0 6px">Projects awaiting confirmation (${num(list.length)})</div>${list
    .map((p) => `<div class="row"><div><strong>${esc(p.name)}</strong><p class="small quiet">${p.kind === 'hand' ? 'Made by hand, not through the command' : 'Newly created'}${p.createdOn ? ' · ' + esc(p.createdOn) : ''}${p.createdBy ? ' · ' + esc(p.createdBy) : ''}</p></div>${state.readonly ? `<span class="small mono quiet">mem project confirm ${esc(p.name)}</span>` : btn('Confirm project', 'project-confirm', `data-value="${esc(p.name)}"`, 'small ghost')}</div>`).join('')}`;
}
function todayCard() {
  const t = D.today;
  if (!t) return '';
  const ops = t.operations?.notable || [];
  const decisions = t.decisions?.list || [];
  const verify = t.verify?.list || [];
  const gold = t.gold?.candidates || [];
  const projects = t.projects?.list || [];
  const c = t.counts || {};
  const anyUnknown = c.decisions === null || c.operations === null || c.verify === null || c.goldQuestions === null;
  const nothingPressing = !anyUnknown && !ops.length && !decisions.length && !verify.length && !gold.length && !projects.length;
  const unknownNote = [['decisions', 'Decisions'], ['operations', 'Operations'], ['verify', 'Verify'], ['goldQuestions', 'Gold questions']]
    .filter(([k]) => c[k] === null).map(([, n]) => n);
  const body = (t.line ? `<p class="small mono" data-today-line>${esc(t.line)}</p>` : '')
    + (unknownNote.length ? `<p class="small quiet">unknown: ${unknownNote.map(esc).join(', ')}</p>` : '')
    + todayUnknownPart('Login', t.login)
    + (nothingPressing
    ? empty('Nothing pressing today — operations calm, no decisions open, nothing uncertain to verify, no gold questions.')
    : todayOperationsPart(ops) + todayDecisionsPart(decisions) + todayProjectsPart(projects) + todayVerifyPart(verify) + todayGoldPart(t.gold))
    + todayUnknownPart('Review suggestions', t.review) + todayUnknownPart('Word-pair suggestions', t.wordPairs);
  return `<div class="today-card" style="margin-bottom:22px">${panel('Today', body, 'Operations, decisions, projects awaiting confirmation, facts to verify and gold questions — the same source as `mem today`.')}</div>`;
}

// The day strip above the figures. cheap-mem has no appointment clock yet, so there is nothing to
// show and the slot stays empty (CSS `:empty` removes it); the calendar port returns its markup here.
// The day strip holds the calendar card once the store has appointments; empty it takes no room.
function homeDayHtml() { return calCache && !calCache.empty ? calendarTodayCard() : ''; }
function home() {
  // Before the first build (a cold start without a stored head) nothing is measured.
  if (D?.placeholder) {
    return heading('Your memory, in context', 'The first state is being built.', (D.reasons || []).map(esc).join(' · ')) + panel('State unknown', note('The server builds the first state in the background since its start. This page asks again by itself and shows it as soon as it is there — until then no figure, because none is measured.'));
  }
  const es = scoped(),
    todo = openWork(es),
    z = areaFigures(es);
  const skillsN = z.skills;
  const readable = z.readable;
  const coverage = state.missing ? 'Unclear' : !z.count ? 'Empty' : readable === z.count ? 'Complete' : 'Partial';
  return (
    heading(
      'Your memory, in context',
      'Knowledge stays.<br><span class="hero-word">Connections grow.</span>',
      'One place for memories, decisions and the people and agents who work with them.',
      `<div class="hero-actions">${btn('Drawers in the network ↗', 'show-shards', '', 'ghost')}${btn('Project package ↗', 'goto-export', '', 'ghost')}</div>`,
    ) +
    // dash-paket-cm: the overview's order (same order in both houses): title, the day strip (a slot the
    // calendar port fills; empty it takes no room), figures, the network with the next look, Today
    // across the full width, recently connected, system state.
    `<div class="overview-head" id="homeDay">${homeDayHtml()}</div>` +
    metrics([
      ['Knowledge in view', num(z.count), 'entries in the chosen scope'],
      ['Open work', num(todo.length), 'duties & unanswered questions'],
      ['Skills & procedures', num(skillsN), 'with origin and validity'],
      ['Data coverage', coverage, z.count ? `${num(readable)} of ${num(z.count)} entries readable` : 'no entry written yet'],
    ]) +
    `<div class="home-layout"><div class="graph-block">${brainBlock()}</div><article class="panel pad"><div class="panelhead"><h2>Your next look</h2><span class="badge warn">${num(todo.length)} open</span></div>${
      todo
        .slice(0, 3)
        .map(
          (e) =>
            `<button class="attention" data-entry="${esc(e.id)}"><span class="sym">${e.type === 'question' ? '?' : '↗'}</span><div><strong>${esc(e.title)}</strong><p>${esc(e.text.slice(0, 110))}</p><span class="label">${esc(e.project)}${D._dutyWho.get(e.id) ? ' · ' + esc(D._dutyWho.get(e.id)) : ''}</span></div><span class="arrow">↗</span></button>`,
        )
        .join('') || empty(es.length ? 'No duty and no question is open right now.' : 'Nothing is open — this memory holds no entry yet. <code class="mono">mem log duty "…"</code> records the first duty.')
    }<div class="smallstats"><span>Originals stay intact</span><span class="green">Append-only</span></div></article></div><div class="overview-today">${todayCard()}</div><div class="sectionline"><h2>Recently connected</h2>${link('See all', 'knowledge/entries')}</div><div class="grid two">${panel('Memories with origin', entryRows(es.slice(0, 3), 'Your first entries will appear here. <code class="mono">mem log learning "…"</code> writes one.'))}${panel(
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
// Hits of the server for the CURRENT input. If the answer is missing or was not
// measurable, only the local filter (the excerpt) applies — never "nothing found".
function fulltextHits(id, source = fulltext) {
  return source.q === source.current() && source.measurable === true && source.ids.has(id);
}
// Show only when the answer to the current input is here AND was not measurable.
function fulltextNotice(source = fulltext) {
  return Boolean(source.current().trim()) && source.q === source.current() && source.measurable === false;
}
function fulltextUrl(q, cursor) {
  return '/api/fulltext?q=' + encodeURIComponent(q) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
}
// Fetch one page: { measurable:true, ids:[…], more, cursor, fresh } | { expired:true } | { measurable:false, reason }.
async function fulltextFetch(q, cursor) {
  try {
    const r = await fetch(fulltextUrl(q, cursor), { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; return null; }
    const b = await r.json().catch(() => null);
    if (b && b.measurable === true && b.expired === true) return { expired: true };
    return b && b.measurable === true && Array.isArray(b.ids)
      ? { measurable: true, ids: b.ids, more: b.more === true, cursor: typeof b.cursor === 'string' ? b.cursor : null, fresh: b.fresh !== false }
      : { measurable: false, reason: (b && b.reason) || 'answer ' + r.status };
  } catch (e) {
    return { measurable: false, reason: e?.message || String(e) };
  }
}
function fulltextAsk(source = fulltext) {
  clearTimeout(source.timer);
  const q = source.current();
  if (!q.trim()) { source.q = null; source.ids = null; source.measurable = null; source.reason = null; source.more = false; source.cursor = null; source.loading = false; source.fresh = true; source.tries = 0; source.triesQ = null; ++source.run; return; }
  if (source.triesQ !== q) { source.triesQ = q; source.tries = 0; }
  const run = ++source.run;
  source.timer = setTimeout(async () => {
    const b = await fulltextFetch(q, null);
    if (b === null) return;
    // Stale: typing went on since the question (or a newer one was asked).
    if (run !== source.run || q !== source.current()) return;
    if (b.expired) { fulltextAsk(source); return; } // not expected without a cursor; ask again to be safe
    source.q = q; source.measurable = b.measurable; source.loading = false;
    source.ids = b.measurable ? new Set(b.ids) : null;
    source.reason = b.measurable ? null : b.reason;
    source.more = b.measurable ? b.more : false; source.cursor = b.measurable ? b.cursor : null;
    source.fresh = b.measurable ? b.fresh : true;
    source.redraw();
    // Old index ("is being refreshed"): ask again from the start after a short while, until the new one stands.
    if (b.measurable && !b.fresh && source.tries < FULLTEXT_RETRIES) {
      source.tries++;
      source.timer = setTimeout(() => { if (q === source.current()) fulltextAsk(source); }, FULLTEXT_RETRY_MS);
    }
  }, FULLTEXT_DEBOUNCE_MS);
}
// "Load more": append the next page for the CURRENT input. If the cursor no longer holds
// (a new index on the server), the question starts again from the front.
async function fulltextMore(source = fulltext) {
  const q = source.current();
  if (!source.more || !source.cursor || source.loading || source.q !== q || source.measurable !== true) return;
  const run = source.run;
  source.loading = true;
  source.redraw();
  const b = await fulltextFetch(q, source.cursor);
  if (b === null || run !== source.run || q !== source.current()) return;
  source.loading = false;
  if (b.expired) { fulltextAsk(source); source.redraw(); return; }
  if (!b.measurable) { source.measurable = false; source.reason = b.reason; source.more = false; source.cursor = null; source.redraw(); return; }
  for (const id of b.ids) source.ids.add(id);
  source.more = b.more; source.cursor = b.cursor; source.fresh = b.fresh;
  source.redraw();
}
// The line under the table: load more full-text hits / the note "is being refreshed".
function fulltextFoot(source = fulltext) {
  if (!source.current().trim() || source.q !== source.current() || source.measurable !== true) return '';
  const note = source.fresh ? '' : '<span class="small quiet" id="fulltextRefreshing" role="status">Full text is being refreshed …</span> ';
  const more = source.more ? btn(source.loading ? 'Loading …' : 'Load more full-text hits', 'fulltext-more', source.loading ? 'disabled' : '', 'small ghost') : '';
  return note || more ? `<div class="tablefoot" id="fulltextFoot">${note}${more}</div>` : '';
}
function filtered() {
  const q = state.query.toLocaleLowerCase();
  const es = scoped().filter(
    (e) => (!state.topic || e.topic === state.topic) && (state.type === 'all' || e.type === state.type) && (state.status === 'all' || statusOf(e.id) === state.status) && (!q || e._s.includes(q) || fulltextHits(e.id)),
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
// --- Topics list (dash-paket-cm, 2026-10-03; same list in both houses) ---------
// A list instead of one big tile per topic: topic, entries, types, "Open thread". Sortable,
// filterable, 30 rows + "Show more"; a small switch to tiles, remembered in the browser.
// The source is the real topic (field `topic`, aliases resolved; the server counts it over the
// whole store in D.topics.list); "Tags" is the small second tab with the free tags. Categories
// (`D.categories`, contract below) appear only when the data carry them.
const topicsUi = { sort: 'count', dir: -1, q: '', view: 'list', more: 0, cat: '', group: false, source: 'topics' };
try { const v = localStorage.getItem('cm-dash-topics-view'); if (v === 'list' || v === 'tiles') topicsUi.view = v; } catch { /* without storage the list stays */ }
let topicsMemo = { key: null, list: [] };
const topicsAreTopics = () => topicsUi.source === 'topics';
function topicsBase() {
  const server = topicsAreTopics() && state.project === 'all' && Array.isArray(D?.topics?.list) ? D.topics.list : null;
  const key = `${topicsUi.source}|${state.project}|${entries.length}|${entries[0]?.id ?? ''}|${entries[entries.length - 1]?.id ?? ''}|${server ? server.length : '-'}`;
  if (topicsMemo.key === key) return topicsMemo.list;
  let list;
  if (server) {
    list = server.map((t) => ({ name: String(t.topic), count: Number(t.count) || 0, types: [...(t.types || [])].sort() }));
  } else {
    const map = new Map();
    for (const e of entries) {
      if (!scope(e)) continue;
      for (const name of topicsAreTopics() ? (e.topic ? [e.topic] : []) : e.tags || []) {
        let z = map.get(name);
        if (!z) { z = { name, count: 0, types: new Set() }; map.set(name, z); }
        z.count += 1;
        z.types.add(e.type);
      }
    }
    list = [...map.values()].map((z) => ({ name: z.name, count: z.count, types: [...z.types].sort() }));
  }
  topicsMemo = { key, list };
  return list;
}
// Categories (contract of the categories port): `D.categories` = { list:[{key,label,status,topics,entries}],
// topics:[{topic,count,category:{key,label,status,source}|null}], unassigned, proposals:[{topic,category,label}],
// new:[{key,label}], wishes, threshold } or { error }. Absent or carrying `error`: no column, no filter,
// no overview — never an error on the page. cheap-mem ships empty: an empty `list` counts as no data.
// Click actions (task kinds `category-*`, password session only): see catRun() below.
const isProposal = (c) => c?.status === 'proposal' || c?.status === 'proposed';
function topicCategories() {
  const k = D?.categories;
  if (!topicsAreTopics() || !k || k.error || !Array.isArray(k.list) || !k.list.length) return { on: false, assigned: new Map(), all: new Map(), list: [], proposals: [], isNew: new Set(), unassigned: { topics: 0, entries: 0 } };
  const assigned = new Map();
  for (const t of k.topics || []) if (t?.topic && t.category?.key) assigned.set(String(t.topic), t.category);
  const u = k.unassigned;
  return {
    on: true, assigned, all: new Map(k.list.map((x) => [x.key, x.label || x.key])), list: k.list, proposals: k.proposals || [],
    isNew: new Set((k.new || []).map((x) => x.key)),
    unassigned: typeof u === 'number' ? { topics: u, entries: 0 } : { topics: u?.topics ?? 0, entries: u?.entries ?? 0 },
  };
}
function topicsFiltered() {
  const q = topicsUi.q.trim().toLowerCase();
  const cats = topicCategories();
  const list = topicsBase().filter((t) => (!q || t.name.toLowerCase().includes(q)) && (!topicsUi.cat || !cats.on || (topicsUi.cat === '__none' ? !cats.assigned.has(t.name) : cats.assigned.get(t.name)?.key === topicsUi.cat)));
  const r = topicsUi.dir;
  const rank = topicsUi.group && cats.on ? (t) => { const key = cats.assigned.get(t.name)?.key; return key ? cats.list.findIndex((x) => x.key === key) : 9999; } : null;
  return list.sort((a, b) => (rank ? rank(a) - rank(b) : 0) || (topicsUi.sort === 'name'
    ? r * a.name.localeCompare(b.name, 'en') || b.count - a.count
    : r * (a.count - b.count) || a.name.localeCompare(b.name, 'en')));
}
const topicsWindow = () => (topicsUi.view === 'tiles' ? 48 : 30);
function topicTypesHtml(t, max) {
  const word = (k) => esc(types[k] || k);
  return t.types.slice(0, max).map((k) => `<span class="tag">${word(k)}</span>`).join('')
    + (t.types.length > max ? `<span class="tag tl-more-types" title="${esc(t.types.slice(max).map((k) => types[k] || k).join(', '))}">+${t.types.length - max}</span>` : '');
}
function topicCatHtml(c) {
  if (!c) return '<span class="small quiet">—</span>';
  return `<span class="tag">${esc(c.label || c.key)}</span>${isProposal(c) ? '<span class="badge warn" title="A proposal, not yet confirmed">Proposal</span>' : ''}`;
}
const topicCatKey = (t, cats) => cats.assigned.get(t.name)?.key || '';
function topicListHtml() {
  const all = topicsFiltered();
  const shown = all.slice(0, topicsWindow() * (1 + topicsUi.more));
  if (!all.length) return empty(topicsUi.q ? 'No topic matches the filter.' : 'No topics in this scope yet.');
  const cats = topicCategories();
  const act = topicsAreTopics() ? 'topic-thread' : 'topic';
  const core = topicsUi.view === 'tiles'
    ? `<div class="tl-tiles">${shown.map((t) => `<button class="tl-tile" data-action="${act}" data-value="${esc(t.name)}" aria-label="Open thread: ${esc(t.name)}, ${t.count} entries"><strong>${esc(t.name)}</strong><span class="tl-count">${num(t.count)}</span><span class="small quiet">${t.types.length} ${t.types.length === 1 ? 'type' : 'types'}</span></button>`).join('')}</div>`
    : `<ul class="tl-list">${shown.map((t, i) => `${topicsUi.group && cats.on && (i === 0 || topicCatKey(shown[i - 1], cats) !== topicCatKey(t, cats)) ? `<li class="tl-group" role="presentation">${esc(cats.all.get(topicCatKey(t, cats)) || 'No category')}</li>` : ''}<li class="tl-row"><strong class="tl-name">${esc(t.name)}</strong>${cats.on ? `<span class="tl-cat">${topicCatCell(t, cats)}</span>` : ''}<span class="tl-count"><span class="tl-lbl">Entries </span>${num(t.count)}</span><span class="tl-types">${topicTypesHtml(t, 4)}</span><span class="tl-action">${btn('Open thread ↗', act, `data-value="${esc(t.name)}" aria-label="Open thread: ${esc(t.name)}"`, 'small ghost')}</span></li>`).join('')}</ul>`;
  const rest = all.length - shown.length;
  return `${core}<div class="tablefoot tl-foot"><span role="status">${num(shown.length)} of ${num(all.length)} ${all.length === 1 ? 'topic' : 'topics'}${topicsUi.q.trim() ? ' (filtered)' : ''}</span>${rest > 0 ? btn(`Show more (${num(Math.min(rest, topicsWindow()))})`, 'topic-more', '', 'small ghost') : ''}</div>`;
}
// Category click actions need a password session: only then is the sign-in on and the server accepts the
// `humanOnly` task kinds. Without one the CLI commands to copy stand in their place (topicCatCommands()).
const catMayClick = () => loginEnabled && serverWrites;
// The topic's category cell: the tag, or (password session) a select that assigns; a proposal gets "Confirm".
function topicCatCell(t, cats) {
  const c = cats.assigned.get(t.name);
  if (!catMayClick()) return topicCatHtml(c);
  const ro = state.readonly ? 'disabled' : '';
  const options = [...cats.all].map(([id, label]) => `<option value="${esc(id)}" ${c?.key === id ? 'selected' : ''}>${esc(label)}</option>`).join('');
  return `<select class="field tl-assign" data-cat-assign="${esc(t.name)}" data-was="${esc(c?.key || '')}" aria-label="Category of topic ${esc(t.name)}" ${ro}>${c ? '' : '<option value="" selected>— assign —</option>'}${options}</select>${isProposal(c) ? `<span class="badge warn" title="A proposal, not yet confirmed">Proposal</span>${btn('Confirm', 'cat-confirm', `data-topic="${esc(t.name)}" aria-label="Confirm the proposal for ${esc(t.name)}" ${ro}`, 'small ghost')}` : ''}`;
}
// The commands behind every click, to copy (always offered; the only route without a password session).
function topicCatCommands() {
  const cmds = ['node bin/mem category confirm <topic>', 'node bin/mem category confirm --all-proposals', 'node bin/mem category assign <topic> <category>',
    'node bin/mem category create <key> "<Label>"', 'node bin/mem category acknowledge <key>', 'node bin/mem category rename <key> "<Label>"', 'node bin/mem category merge <from> <to>'];
  return `<details class="cmd-fallback tl-cat-cmds"><summary class="small quiet">${catMayClick() ? 'Details · commands to copy' : 'Commands to copy · changing categories needs a password session'}</summary>${cmds.map(skCopy).join('')}</details>`;
}
// Create a category: one name field; the key is the name in key form (lower case, hyphens).
function topicCatCreateForm() {
  if (!catMayClick()) return '';
  const ro = state.readonly ? 'disabled' : '';
  return `<div class="tl-cat-new"><input class="field" id="catNewLabel" type="text" maxlength="40" placeholder="New category, e.g. Infrastructure" aria-label="Name of a new category" ${ro}>${btn('Create category', 'cat-create', ro, 'small ghost')}</div>`;
}
// The categories overview above the list: category, topics, entries, status; click actions with a password session.
function topicCatOverview() {
  const cats = topicCategories();
  if (!cats.on) return '';
  const ro = state.readonly ? 'disabled' : '';
  const may = catMayClick();
  const rows = cats.list.map((x) => {
    const isNew = cats.isNew.has(x.key);
    const label = x.label || x.key;
    const others = cats.list.filter((y) => y.key !== x.key);
    const tools = may ? `<div class="tl-cat-tools">${isNew ? btn('Acknowledge', 'cat-acknowledge', `data-key="${esc(x.key)}" aria-label="Acknowledge category ${esc(label)}" ${ro}`, 'small ghost') : ''}${btn('Rename', 'cat-rename', `data-key="${esc(x.key)}" data-label="${esc(label)}" aria-label="Rename category ${esc(label)}" ${ro}`, 'small ghost')}${others.length ? `<select class="field" data-cat-merge="${esc(x.key)}" aria-label="Merge ${esc(label)} into" ${ro}><option value="">Merge into …</option>${others.map((y) => `<option value="${esc(y.key)}">${esc(y.label || y.key)}</option>`).join('')}</select>` : ''}</div>` : '';
    return `<li class="tl-cat-row"><button class="tl-cat-name" data-action="cat-filter" data-value="${esc(x.key)}" aria-pressed="${topicsUi.cat === x.key}" title="Show only this category"><strong>${esc(label)}</strong></button><span class="tl-count"><span class="tl-lbl">Topics </span>${num(x.topics ?? 0)}</span><span class="tl-count"><span class="tl-lbl">Entries </span>${num(x.entries ?? 0)}</span><span class="tl-cat-status">${isNew ? '<span class="badge warn">new · created automatically</span>' : x.status === 'seed' || x.status === 'start' ? '<span class="badge">Seed</span>' : '<span class="badge good">confirmed</span>'}</span>${tools}</li>`;
  }).join('');
  const open = cats.proposals.length;
  return `<article class="panel tl-panel tl-overview"><div class="tl-overview-head"><div><h2>Categories</h2><p class="small quiet">One level above the topics. ${num(cats.unassigned.topics)} topics (${num(cats.unassigned.entries)} entries) without a category${open ? ` · ${num(open)} proposals await confirmation` : ''}.</p></div>${open && may ? btn(`Confirm all proposals (${num(open)})`, 'cat-confirm-all', ro, 'small ghost') : ''}</div><ul class="tl-cat-list">${rows}</ul>${topicCatCreateForm()}<p class="small quiet tl-cat-status-line" id="catStatus" role="status" aria-live="polite"></p>${topicCatCommands()}</article>`;
}
// Shipped empty: with a password session the overview's place offers the first category (the list stays hidden otherwise).
function topicCatSetup() {
  const k = D?.categories;
  if (!catMayClick() || !topicsAreTopics() || !k || k.error || !Array.isArray(k.list) || k.list.length) return '';
  return `<article class="panel tl-panel tl-setup"><div class="tl-overview-head"><div><h2>Categories</h2><p class="small quiet">None yet. A category sits one level above the topics; create the first one here.</p></div></div>${topicCatCreateForm()}<p class="small quiet tl-cat-status-line" id="catStatus" role="status" aria-live="polite"></p>${topicCatCommands()}</article>`;
}
// After a write, bring the loaded state in line at once: the server's cache may trail the write for a moment
// (it rebuilds in the background), and a page that still shows the old state would look like a failed click.
const catOps = [];
function catPatch(kind, f) { catOps.push([kind, f]); catApply(kind, f); }
// A later quiet refetch may still carry the old state (the server rebuilds in the background): put the writes
// back on top of it until the server's answer is fresh, i.e. built after them.
function catReapply() {
  if (!catOps.length) return;
  if (D?.cache?.fresh) { catOps.length = 0; return; }
  for (const [kind, f] of catOps) catApply(kind, f);
}
function catApply(kind, f) {
  const k = D?.categories;
  if (!k || !Array.isArray(k.list)) return;
  const topics = k.topics || (k.topics = []);
  const find = (key) => k.list.find((x) => x.key === key);
  const put = (topic, key, status) => { const x = find(key), t = topics.find((y) => y.topic === topic); if (x && t) t.category = { key, label: x.label, status, source: 'person' }; };
  if (kind === 'category-assign') put(f.topic, f.category, 'confirmed');
  else if (kind === 'category-confirm') for (const t of topics) if (isProposal(t.category) && (f.all || t.topic === f.topic)) put(t.topic, t.category.key, 'confirmed');
  else if (kind === 'category-acknowledge') { const x = find(f.key); if (x) x.status = 'confirmed'; k.new = (k.new || []).filter((y) => y.key !== f.key); }
  else if (kind === 'category-rename') { const x = find(f.key); if (x) x.label = f.label; for (const t of topics) if (t.category?.key === f.key) t.category.label = f.label; }
  else if (kind === 'category-merge') {
    const to = find(f.target);
    for (const t of topics) if (t.category?.key === f.source && to) t.category = { ...t.category, key: to.key, label: to.label };
    k.list = k.list.filter((x) => x.key !== f.source);
    k.new = (k.new || []).filter((y) => y.key !== f.source);
  } else if (kind === 'category-create') {
    const key = f.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!find(key)) k.list.push({ key, label: f.label, status: 'confirmed', topics: 0, entries: 0 });
  }
  for (const x of k.list) { const mine = topics.filter((t) => t.category?.key === x.key); x.topics = mine.length; x.entries = mine.reduce((n, t) => n + (t.count || 0), 0); }
  const none = topics.filter((t) => !t.category);
  k.unassigned = { topics: none.length, entries: none.reduce((n, t) => n + (t.count || 0), 0) };
  k.proposals = topics.filter((t) => isProposal(t.category)).map((t) => ({ topic: t.topic, category: t.category.key, label: t.category.label }));
}
// One category write: a task (password session only), feedback in the button or the status line, errors name the reason.
async function catRun(el, kind, fields, doneWord) {
  if (state.readonly) return toast('Read only is on.');
  const say = (t, tone) => { const st = $('#catStatus'); if (st) { st.textContent = t; st.className = 'small tl-cat-status-line ' + (tone || 'quiet'); } };
  const isButton = el.tagName === 'BUTTON';
  const rest = el.textContent;
  el.disabled = true;
  if (isButton) el.textContent = 'writing …';
  say('Writing …');
  let s;
  try { s = await taskStart({ kind, ...fields }); } catch (e) { s = { ok: false, reason: 'network: ' + (e?.message || e) }; }
  let done = null;
  if (s.ok) done = await waitForTask(s.id, { maxMs: 30000 });
  if (!s.ok || done.state !== 'ok') {
    const why = s.ok ? (done.reason || done.state || 'unknown') : reasonPlain(s.reason);
    el.disabled = false;
    if (isButton) { el.textContent = 'Error'; setTimeout(() => { if (el.isConnected) el.textContent = rest; }, 4000); } else el.value = el.dataset.was ?? '';
    say('Not saved: ' + why + '. Nothing was written.', 'red');
    toast('Not saved: ' + why);
    return false;
  }
  const text = done.result?.text || 'Saved.';
  if (isButton) el.textContent = doneWord;
  await loadData({ quiet: true });
  catPatch(kind, fields);
  render();
  say(text, 'green');
  toast(text);
  return true;
}
const pages = {
  entries: () => {
    const es = filtered(),
      n = 8,
      pg = Math.min(state.page, Math.max(1, Math.ceil(es.length / n)));
    state.page = pg;
    return `<div class="toolbar"><input class="field searchfield" id="entrySearch" placeholder="Content, ID, agent or tag …" value="${esc(state.query)}" aria-label="Search entries">${fulltextNotice() ? `<span class="small quiet" id="fulltextNotice" role="status" title="${esc(fulltext.reason || '')}">Full text unavailable – searching excerpts only</span>` : ''}<select class="field" id="typeFilter" aria-label="Entry type"><option value="all">All types</option>${Object.entries(types)
      .map(([k, n]) => `<option value="${k}" ${state.type === k ? 'selected' : ''}>${n}</option>`)
      .join('')}</select><select class="field" id="statusFilter" aria-label="Entry state">${['all', 'active', 'open', 'superseded', 'done', 'discarded', 'answered']
      .map((x) => `<option value="${x}" ${state.status === x ? 'selected' : ''}>${x === 'all' ? 'All states' : x}</option>`)
      .join('')}</select><select class="field" id="sortFilter" aria-label="Sort">${[['new', 'Newest first'], ['old', 'Oldest first'], ['title', 'Title A–Z']]
      .map(([k, n]) => `<option value="${k}" ${state.sort === k ? 'selected' : ''}>${n}</option>`)
      .join('')}</select>${btn('Reset filters', 'reset-filters', '', 'ghost')}${state.topic ? `<span class="badge good tl-active" role="status">Topic: ${esc(state.topic)}</span>` : ''}<a class="btn ghost" id="entriesPageLink" href="/entries${state.type && state.type !== 'all' ? '?type=' + encodeURIComponent(state.type) : ''}" target="_blank" rel="noopener" title="The same list, rendered by the server, in a new tab">Full list page ↗</a></div><article class="panel"><div class="tablewrap"><table class="table"><thead><tr><th>Entry / origin</th><th>Type</th><th>Project</th><th>State</th><th>Date</th></tr></thead><tbody>${es
      .slice((pg - 1) * n, pg * n)
      .map(
        (e) =>
          `<tr><td>${open(e.id, e.title, 'open-entry')}${ruleTag(e.ruleStatus)}<span class="sub">${esc(e.id)} · ${esc(e.agent)} · ${esc(e.memory)} / ${esc(drawerOf(e))}</span></td><td><span class="type">${esc(types[e.type])}</span></td><td>${esc(e.project)}</td><td>${badge(statusOf(e.id))}</td><td class="quiet small">${when(e.ts)}</td></tr>`,
      )
      .join('')}</tbody></table>${!es.length ? empty(entries.length ? undefined : 'This memory holds no entry yet. <code class="mono">mem log learning "…"</code> writes the first one; it appears here on the next load.') : ''}</div><div class="tablefoot"><span>${num(es.length)} hits · page ${pg} / ${Math.max(1, Math.ceil(es.length / n))}</span><div>${btn('←', 'prev', pg === 1 ? 'disabled' : '', 'small ghost')} ${btn('→', 'next', pg >= Math.ceil(es.length / n) ? 'disabled' : '', 'small ghost')}</div></div>${fulltextFoot()}</article>`;
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
    )}${panel('Project matrix', projectMatrix(), 'Stored links between the projects, from the drawer pairs')}</div><div class="grid two" style="margin-top:18px">${panel('Drawers · project × type', drawerMatrix(), `${num(D.net?.boxes?.length)} drawers · one click shows their entries (the old net view's overview)`)}${panel('Layers', netLayers(), `depth ${num(D.net?.layers?.depth)} · what points at others stands on top (net.layers)`)}</div><div style="margin-top:18px">${panel('Hand-drawn links', (D.links || []).slice(0, 40).map((l) => `<div class="row"><div><strong>${esc(edgeLabels[l.kind] || l.kind)}</strong><p>${byId(l.from) ? open(l.from, byId(l.from).title, 'textlink') : esc(l.from)} → ${byId(l.to) ? open(l.to, byId(l.to).title, 'textlink') : esc(l.to)}${l.why ? ' · ' + esc(l.why) : ''}</p></div>${l.fromKnown && l.toKnown ? badge('present', 'both ends known') : badge('missing', 'dangling')}</div>`).join('') || empty('No link has been drawn by hand yet. <code class="mono">mem log link --from … --to … --kind causes</code> draws one.'), 'Typed relations from the links drawer, with their reason')}</div><div style="margin-top:18px">${derivedPanel()}</div>`;
  },
  topics: () => {
    const tp = D.topics || {};
    const all = topicsBase();
    const sortHead = (field, text, cls) => `<button class="tl-sort ${cls}" data-action="topic-sort" data-value="${field}" aria-label="Sort by ${text}" ${topicsUi.sort === field ? `aria-pressed="true" data-dir="${topicsUi.dir > 0 ? 'asc' : 'desc'}"` : 'aria-pressed="false"'}>${text}<i aria-hidden="true">${topicsUi.sort === field ? (topicsUi.dir > 0 ? '↑' : '↓') : ''}</i></button>`;
    const cats = topicCategories();
    const noun = topicsAreTopics() ? 'Topic' : 'Tag';
    return (topicCatOverview() || topicCatSetup()) + `<div class="toolbar tl-bar"><input class="field searchfield" id="topicSearch" type="search" placeholder="Filter ${noun.toLowerCase()}s …" aria-label="Filter ${noun.toLowerCase()}s" value="${esc(topicsUi.q)}"><select class="field" id="topicSortSelect" aria-label="Sort topics"><option value="count" ${topicsUi.sort === 'count' ? 'selected' : ''}>By count</option><option value="name" ${topicsUi.sort === 'name' ? 'selected' : ''}>By name</option></select>${cats.on ? `<select class="field" id="topicCat" aria-label="Filter by category"><option value="">All categories</option><option value="__none" ${topicsUi.cat === '__none' ? 'selected' : ''}>No category</option>${[...cats.all].map(([id, label]) => `<option value="${esc(id)}" ${topicsUi.cat === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>` : ''}<div class="seg tl-source" role="group" aria-label="What is counted">${btn('Topics', 'topic-source', `data-value="topics" aria-pressed="${topicsAreTopics()}"`, 'small ghost')}${btn('Tags', 'topic-source', `data-value="tags" aria-pressed="${!topicsAreTopics()}"`, 'small ghost')}</div>${cats.on ? btn('Group by category', 'topic-group', `aria-pressed="${topicsUi.group}"`, 'small ghost tl-group-btn') : ''}<div class="seg tl-view" role="group" aria-label="Display">${btn('List', 'topic-view', `data-value="list" aria-pressed="${topicsUi.view === 'list'}"`, 'small ghost')}${btn('Tiles', 'topic-view', `data-value="tiles" aria-pressed="${topicsUi.view === 'tiles'}"`, 'small ghost')}</div></div>`
      + `<article class="panel tl-panel${cats.on ? ' tl-withcat' : ''}"><div class="tl-head${topicsUi.view === 'list' ? '' : ' tl-head-off'}">${sortHead('name', noun, 'tl-k-name')}${cats.on ? '<span class="tl-k-cat">Category</span>' : ''}${sortHead('count', 'Entries', 'tl-k-count')}<span class="tl-k-types">Types</span><span class="tl-k-action"></span></div><div id="topicList">${topicListHtml()}</div></article>`
      + `<p class="small quiet" style="margin-top:14px">${topicsAreTopics() ? `Topics are the threads of the entries (field topic); ${num(all.length)} in total. The free tags are under "Tags".` : `Tags are the free keywords of the entries (${num(all.length)} in total); topics and categories are under "Topics".`}</p>`
      + `<div class="grid two" style="margin-top:18px">${panel('Topic tree', (tp.areas || []).map((a) => `<div class="row"><div><strong>${esc(a.area)}</strong><p>${(a.children || []).slice(0, 8).map(esc).join(', ')}${(a.children || []).length > 8 ? ' …' : ''}</p></div><span class="small">${num(a.count)} · ${a.orphan ? badge('warning', 'one child') : badge('good', num((a.children || []).length) + ' children')}</span></div>`).join('') || empty('No topic yet.'), 'Grouped by area from the topic names alone (mem topics)')}${panel('Topic quality', tp.quality ? `<div class="row"><span class="small">Topics / entries with a topic</span><span class="small">${num(tp.quality.topics)} / ${num(tp.quality.entriesWithTopic)}</span></div><div class="row"><span class="small">Entries per topic</span><span class="small">${tp.quality.topics ? Number(tp.quality.entriesPerTopic).toFixed(2) : '—'}</span></div><div class="row"><span class="small">Single-entry topics</span><span class="small">${num(tp.quality.singleTopics)}${tp.quality.topics ? ` (${Math.round(tp.quality.singleShare * 100)} %)` : ''}</span></div><div class="row"><span class="small">Areas / orphan areas / malformed</span><span class="small">${num(tp.quality.areas)} / ${num(tp.quality.orphanAreas)} / ${num(tp.quality.malformed)}</span></div><p class="small quiet" style="margin-top:10px">A topic with exactly one entry is not a topic but a second title field — the doctor's topic-quality finding reads the same numbers.</p>` : badge('unknown'), 'The same measure as mem doctor')}</div>${note('Merging topics needs its own traceable step ("mem topic-merge").')}`;
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
    const ex = new Map(experienceList.map((x) => [x.id, x]));
    const exWait = D.parts?.experiences && partState.experiences !== 'ok';
    const rows = es.slice(0, 40).map((e) => {
      const x = ex.get(e.id);
      return `<div class="row"><div class="row-main"><span class="entry-icon">${esc(types[e.type]?.[0])}</span><div>${open(e.id, e.title, 'open-entry textlink')}${ruleTag(e.ruleStatus)}<p>${esc(e.project)} · ${esc(e.agent)}${x ? ` · cited ${num(x.cited)}×${(x.backedBy || []).length ? ` · backed by ${num(x.backedBy.length)}` : ''}` : ''}</p></div></div>${x?.contested ? badge('warning', 'contested') : badge(statusOf(e.id))}</div>`;
    }).join('');
    return panel('Learnings with an evidence trail', (rows || empty('No learning recorded yet. <code class="mono">mem log learning "…"</code> writes one.')) + limitNote(Math.min(40, es.length), es.length, 'knowledge/entries'), 'References show support. The count alone proves no independent sources.')
      + (exWait ? note(partState.experiences === 'error' ? 'Citation counts not loaded: ' + esc(partReason.experiences || 'unknown') : 'Citation counts are still loading — the rows show them as soon as they are here.') : '');
  },
  // The catalogue arrives on its own from /dashboard/skills.json
  // (skCatalogLoad, called from render()); a loading line until then.
  skills: () =>
    `<div id="skillCatalog">${skCat ? skCatalogHtml() : '<p class="small quiet sk-loading">Reading the catalogue …</p>'}</div>${note('An offered skill does not count as applied: "fetched" means requested, not "it helped". Status lines are history of their entry, never entries of their own.')}`,
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
  calendar: () => `<div id="calendarView">${calCache ? calendarHtml() : '<p class="small quiet">Reading the calendar …</p>'}</div>`,
  agents: () => {
    const as = D.agents || [];
    const bell = D.bell || {};
    const tray = D.humanTray || {};
    const now = Date.now();
    const rows = as.map((a) => ({ a, l: agentStatus(a, now) }));
    const group = (g) => rows.filter((x) => x.l.group === g);
    const attention = group('attention'), active = group('active'), idle = group('idle');
    const mails = rows.map((x) => x.l.mail);
    const mailTotal = mails.some((m) => m === null) ? null : mails.reduce((s, m) => s + m.open, 0);
    const head = `<div class="ag-head" aria-hidden="true"><span>Agent</span><span>State</span><span>Entries</span><span>Last entry</span><span>Open mail</span><span></span></div>`;
    const list = (xs) => `<div class="ag-list">${head}${xs.map(({ a, l }) => agentRow(a, l, now)).join('')}</div>`;
    const section = (title, xs, sub) => (xs.length ? `<section class="ag-group" data-group="${esc(title)}"><h3 class="ag-group-title">${esc(title)} <span class="quiet">· ${num(xs.length)}</span></h3>${sub ? `<p class="small quiet ag-group-sub">${sub}</p>` : ''}${list(xs)}</section>` : '');
    const board = as.length
      ? section('Needs attention', attention, 'Mail waiting longer than 48 h, an active writer without registration, an expired or unreadable pause.') +
        section('Active (7 days)', active, 'An entry in the last seven days, or confirmed alive by two sources.') +
        (idle.length ? `<details class="accordion ag-idle" data-group="Idle"><summary>Idle <span class="quiet">· ${num(idle.length)}</span></summary><p class="small quiet ag-group-sub">No entry for more than seven days and no confirmed sign of life.</p>${list(idle)}</details>` : '')
      : empty('No agent registered and none seen in the log. <code class="mono">mem agent create &lt;name&gt;</code> registers one.');
    return `${metrics([
      ['Agents', num(as.length), 'registered or seen in the log'],
      ['Active in 7 days', num(rows.filter((x) => x.l.active).length), 'an entry or a confirmed sign of life, attention included'],
      ['Need attention', num(attention.length), attention.length ? 'reasons in the row' : 'nothing stands out'],
      ['Open mail', mailTotal === null ? '—' : num(mailTotal), mailTotal === null ? 'not measured: the inbox list is not loaded or not readable' : 'messages to all agents together'],
    ])}${panel('Agents', board, 'One row per agent · click a row for every field · "unknown" never counts as good')}${panel(
      'Reachability needs independent sources',
      `<div class="tablewrap"><table class="table ag-sources"><thead><tr><th>Signal</th><th>Source</th><th>Here</th></tr></thead><tbody><tr><td>Own heartbeat</td><td>heartbeat.jsonl (mem heartbeat)</td><td>per agent, in the row details</td></tr><tr><td>Observed activity</td><td>the drawers and the inbox</td><td>per agent, in the row details</td></tr><tr><td>Deliberate pause</td><td>silent_until in AGENT.yaml</td><td>${num(as.filter((a) => a.pause?.state === 'paused').length)} paused</td></tr><tr><td>Locally startable</td><td>agents/&lt;name&gt;/PROMPT.md or START.md</td><td>${num(as.filter((a) => a.startable?.local).length)} of ${num(as.length)}</td></tr><tr><td>Digest bell</td><td>.mem/digest-bell.json</td><td>${bell.checkable ? (bell.rung ? 'rung · ' + esc(whenTime(bell.last)) : 'not rung') : badge('unknown')}</td></tr><tr><td>The human's tray (show only)</td><td>inbox/ addressed to the human participant</td><td>${tray.checkable === false ? badge('unknown', esc(tray.reason || 'unknown')) : `${num(tray.count)} open${tray.count ? ' · oldest ' + age(tray.oldestMin) : ''}`}</td></tr></tbody></table></div>${note('Two confirming sources: alive. One source: unknown. No observable signal: not seen. An announced pause is not an outage. The bell only reads ok once a message was actually answered. An agent that cannot be started locally (a foreign agent) is not expected to send a heartbeat — that is no penalty.')}`,
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
          esc(p.name) + (r?.isNew ? ' ' + badge('warning', 'new · unconfirmed') : ''),
          `${r?.isNew ? `<p class="small muted" style="margin-bottom:8px">Newly created${r.createdOn ? ' on ' + esc(r.createdOn) : ''}${r.createdBy ? ' by ' + esc(r.createdBy) : ''} — awaits confirmation.</p><div class="drawer-actions" style="margin-bottom:12px">${btn('Confirm project', 'project-confirm', `data-value="${esc(p.name)}" ${state.readonly ? 'disabled' : ''}`, 'small ghost')}</div><div class="small quiet" data-confirm-status="${esc(p.name)}" role="status" aria-live="polite"></div><details class="cmd-fallback"><summary class="small quiet">Details · command to copy</summary>${skCopy('node bin/mem project confirm ' + p.name)}</details>` : ''}<div class="number">${num(p.entries)}</div><p class="small muted" style="margin:5px 0 20px">entries · ${p.drawers.length} filled types${p.retired ? ` · ${num(p.retired)} retired` : ''}${p.openQuestions ? ` · ${num(p.openQuestions)} open questions` : ''}</p>${p.drawers.map((t) => `<span class="tag">${esc(types[t] || t)}</span>`).join('')}${r ? `<div class="stats-list" style="margin-top:14px"><div class="row"><span class="small">Shelf</span><span class="small">${num(r.filled)} filled · ${num(r.empty)} empty · ${num(r.missing)} missing of ${num(r.drawersTotal)}</span></div>${(r.files || []).map((f) => `<div class="row"><span class="small mono">${esc(f.name)}</span>${badge(f.where)}</div>`).join('')}</div>` : ''}${p.agents?.length ? `<p class="small quiet" style="margin-top:12px">Agents: ${p.agents.map((a) => esc(a.name) + ' (' + num(a.entries) + ')').join(', ')}</p>` : ''}<div class="drawer-actions">${btn('Open project', 'project', `data-value="${esc(p.name)}"`, 'ghost')}${btn('Export', 'export-project', `data-value="${esc(p.name)}"`, 'ghost')}</div>`,
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
      `<label class="formfield">Project<select class="field" id="exportProject">${['global', ...(D.projects || []).map((p) => p.name).filter((n) => n !== 'global')].map((n) => `<option ${n === (state.project === 'all' ? 'global' : state.project) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label><label class="check"><input type="checkbox" id="exportGlobal" checked> Add the global foundations</label><label class="check"><input type="checkbox" id="exportHistory" checked> Include historical / retired entries</label><p class="muted small" style="margin:12px 0">Raw captures, messages and file bytes stay excluded. Relations across the package boundary appear as references.</p><div class="drawer-actions">${btn('Load JSON package ↓', 'export-json', '', 'primary')}${btn('Offline reading view ↓', 'export-html', '', 'ghost')}</div>`,
      'Preview and package count from the same data state.',
    )}${panel('Content preview', '<div id="exportPreview"></div>', 'State of the loaded data')}</div>${note('The JSON package holds the chosen entries with their relations; entries outside the package appear only as references (id, type, title). The header names the format version, creation time, commit, counts and completeness. Encrypted entries stay encrypted (ciphertext unchanged), every plaintext runs through the redaction. Not included: raw captures, inbox mail, file bytes, key material. The offline reading view is the same package as one single HTML file: search, list, detail and references, readable without a network; encrypted entries appear there only as "encrypted". (<code class="mono">mem viewer</code> writes the file for the whole memory.) Raw captures are exported by their own flow below (also under Sources › Raw capture and Operations › Tasks).')}<div style="margin-top:18px">${rawExportPanel()}</div>`,

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
    `<div class="row"><div><strong>Writing from the dashboard</strong><p>${esc(w.reason || 'unknown')}${w.howTo ? ' ' + esc(w.howTo) : ''}</p></div>${badge(w.state === 'on' ? 'on' : w.state === 'off' ? 'off' : w.state === 'error' ? 'error' : 'unknown', w.state || 'unknown')}</div>${rows}<div class="drawer-actions">${btn('Save settings', 'save-config', state.readonly ? 'disabled' : '', 'primary')}</div><p class="small quiet" id="configStatus" role="status" aria-live="polite" style="margin-top:8px"></p>${note('Saved through POST /setting — the same route as the console, behind the write switch, the Host check and the Origin check, with a closed field list. No folder is created beyond the one a setting names, no service is switched.')}<div id="configHistory">${(D.log || []).map((x) => `<p class="small muted">${esc(whenTime(x.ts))} · ${esc(x.id || '')}: ${esc(x.before ?? '—')} → ${esc(x.after ?? '—')} · ${esc(x.by || '')}</p>`).join('') || '<p class="small quiet">Nothing changed yet.</p>'}</div>`,
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
  )}${liveInjectionPanel()}<div class="grid two" style="margin-top:18px">${panel('Always present: core knowledge', entryRows(scoped().filter((e) => e.type === 'procedure' && statusOf(e.id) === 'active' && coreRuleHolds(e)).slice(0, 3), 'No procedure issued yet — procedures are the knowledge every session carries.'))}${panel(
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
  const run = runStart('message');
  showInfo(esc(m.subject), `<p class="small muted">${esc(m.from)} → ${esc(m.to)} · ${esc(m.state)}</p><div class="loading compact"><span class="loading-core" aria-hidden="true"></span><p>Reading the message …</p></div>`);
  // Selection: the same dialog content as after our own showInfo (another dialog or closing invalidates it).
  const myInfo = infoStamp;
  const selection = () => infoStamp === myInfo && $('#info').open;
  let b;
  try {
    const r = await fetch('/dashboard/message.json?name=' + encodeURIComponent(name), { credentials: 'same-origin', cache: 'no-store', signal: run.signal });
    b = await r.json();
  } catch (e) {
    b = { state: 'error', reason: e?.message || String(e) };
  }
  if (!run.holds(selection)) return;
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

// --- Calendar (src/appointment-today.mjs overview, /dashboard/appointments.json) ----------
// Read only: appointments are written by `mem appointment` and the MCP tools. The Calendar tab and the
// "Today in the calendar" card on the overview read the SAME answer; it is fetched after the first draw.
let calCache = null;
let calRun = 0;
let calError = null;
const calKindWord = { reminder: 'reminder', before: 'ahead', briefing: 'briefing', missed: 'missed', cap: 'held (cap)', undeliverable: 'not deliverable' };
function calTag(t) {
  const bits = [];
  if (t.wake) bits.push(`<span class="badge"><i class="dot"></i>wakes ${esc(t.wake)}</span>`);
  if (t.private) bits.push('<span class="badge"><i class="dot"></i>private</span>');
  if (t.status === 'proposed') bits.push('<span class="badge warn"><i class="dot"></i>proposed</span>');
  if (t.state && t.status !== 'proposed') bits.push(`<span class="badge ${/done/.test(t.state) ? 'good' : /no-response|held|missed/.test(t.state) ? 'warn' : ''}"><i class="dot"></i>${esc(t.state)}</span>`);
  return bits.join(' ');
}
function calTodayRows(c, max) {
  const list = c.today.appointments.slice(0, max);
  if (!list.length) return empty(c.empty ? 'No appointments yet. <code class="mono">mem appointment new --at "tomorrow 9:00" --title "…"</code> makes the first one.' : 'No appointments today.');
  const more = c.today.appointments.length - list.length;
  return list.map((t) => `<div class="row"><div><strong><span class="mono">${esc(t.time)}</span> ${esc(t.title)}</strong></div><div>${calTag(t)}</div></div>`).join('')
    + (more > 0 ? `<p class="small quiet">${num(more)} more in the Calendar tab.</p>` : '');
}
function calendarTodayCard() {
  if (!D?.parts && !D) return '';
  const body = calCache ? calTodayRows(calCache, 5) + `<p style="margin-top:12px">${link('Open the calendar', 'work/calendar')}</p>`
    : (calError ? note('Calendar not readable: ' + esc(calError) + '. State: unknown.', 'bad') : '<p class="small quiet">Reading the calendar …</p>');
  return `<div id="calendarToday" style="margin-bottom:22px">${panel('Today in the calendar', body, calCache ? `${esc(calCache.today.weekday)} ${esc(calCache.today.dateText)} · ${esc(calCache.zone)}` : 'Appointments, reminders and scheduled agent actions — the same source as `mem appointment today`.')}</div>`;
}
function calendarHtml() {
  const c = calCache;
  const byDay = new Map();
  for (const o of c.occurrences) {
    if (o.status === 'cancelled' || o.kind === 'briefing' || Date.parse(o.at) < Date.parse(c.now) - 3600000) continue;
    if (!byDay.has(o.day)) byDay.set(o.day, []);
    byDay.get(o.day).push(o);
  }
  const days = [...byDay.entries()].slice(0, 14).map(([d, os]) => `<div class="label" style="margin:14px 0 4px">${esc(d)}</div>${os.map((o) => `<div class="row"><div><strong><span class="mono">${esc(o.time)}</span> ${esc(o.title)}</strong>${o.repeat ? `<p>repeats ${esc(o.repeat)}</p>` : ''}</div><div>${calTag(o)}</div></div>`).join('')}`).join('');
  const waiting = c.appointments.filter((a) => a.status === 'proposed');
  const waitingHtml = waiting.length ? waiting.map((a) => `<div class="row"><div><strong>${esc(a.title)}</strong><p>${esc(a.atText)} · proposed by ${esc(a.by || '?')}${a.wake ? ' · wakes ' + esc(a.wake) : ''}${a.quote ? ' · quote: “' + esc(a.quote) + '”' : ''}</p><p><code class="mono">mem appointment confirm ${esc(a.id)} --authority user</code></p></div></div>`).join('')
    : empty('Nothing waits for you.');
  const recent = c.banner.slice(0, 8).map((b) => `<div class="row"><div><strong>${esc(b.title)}</strong><p>${esc(b.text)}${b.late ? ' · late' : ''}</p></div><span class="badge ${b.kind === 'reminder' || b.kind === 'before' || b.kind === 'briefing' ? '' : 'warn'}"><i class="dot"></i>${esc(calKindWord[b.kind] || b.kind)}</span></div>`).join('') || empty('No fired reminder is waiting to be seen.');
  const acts = c.actions.length ? c.actions.map((a) => `<div class="row"><div><strong>${esc(a.title)}</strong><p>${esc(a.when)} → ${esc(a.to || '?')}</p></div>${badge(a.state === 'done' ? 'done' : /no-response|expired/.test(a.state) ? 'warn' : 'open', a.state)}</div>`).join('') : empty('No scheduled action fired in the last three days.');
  const o = c.outlet;
  const outlet = !o ? note('Outlet state not readable.', 'bad')
    : !o.active ? `<p class="small muted">Off (${esc(o.reason || 'not set up')}). Reminders arrive as letters only. Setup: docs/appointments.md.</p>`
      : `<p class="small muted">Route ${esc(o.route)} · ${num(o.sent)} sent · ${num(o.open)} open · ${num(o.gaveUp)} given up${o.credentialOk === false ? ' · credential file problem' : ''}</p>`;
  return metrics([
    ['Now', esc(c.nowText.split(' ')[2] || '—'), esc(c.nowText.split(' ').slice(0, 2).join(' ') + ' · ' + c.zone)],
    ['Today', num(c.today.appointments.length), 'appointments on this calendar day'],
    ['Waiting for you', num(c.proposed), 'proposals from agents (CLI: confirm)'],
    ['Wake-ups today', `${num(c.cap.today)} of ${num(c.cap.value)}`, 'daily cap for agent wake-ups'],
  ]) + `<div class="grid two">${panel('Today', calTodayRows(c, 30))}${panel('Waiting for you', waitingHtml, 'An agent only proposes; a human arms it')}</div>`
    + `<div class="grid two" style="margin-top:17px">${panel('Next days', days || empty('Nothing planned in the next two weeks.'))}${panel('Fired and not yet seen', recent)}</div>`
    + `<div class="grid two" style="margin-top:17px">${panel('Scheduled agent actions', acts, 'State from the inbox: delivered, taken, done')}${panel('Calendar outlet', outlet, 'Invitations into your own calendar (smtp or google)')}</div>`;
}
async function calendarLoad() {
  const mine = ++calRun;
  let b = null; let ok = false;
  try {
    const r = await fetch('/dashboard/appointments.json', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; return; }
    b = await r.json();
    ok = r.ok;
  } catch (e) { b = { reason: 'network: ' + (e?.message || e) }; }
  if (mine !== calRun) return;
  const fresh = ok && Array.isArray(b?.appointments);
  calError = fresh ? null : (b?.reason || 'unknown');
  const changed = fresh && JSON.stringify(b) !== JSON.stringify(calCache);
  if (fresh) calCache = b;
  const view = $('#calendarView');
  if (view) view.innerHTML = fresh ? calendarHtml() : note('Calendar not readable: ' + esc(calError) + '. State: unknown.', 'bad');
  const slot = $('#homeDay');
  if (slot && (changed || !fresh)) slot.innerHTML = homeDayHtml();
}
// --- Skill catalogue from /dashboard/skills.json (src/skillcatalog.mjs); status
// form only with a password session (task skill-status), else a CLI command to copy.
let skCat = null;
let skRun = 0;
const skFilter = { q: '', status: 'all', type: 'all' };
function skBadge(s) {
  const tone = { released: 'good', trial: 'warn', proposed: 'warn', draft: 'warn', withdrawn: 'bad', unknown: 'unknown' }[s] || 'unknown';
  return `<span class="badge ${tone}${s === 'released' ? '' : ' rule-status'}" data-sk-status="${esc(s)}"><i class="dot"></i>${esc(s)}</span>`;
}
function skEffect(w) {
  if (!w) return 'effect unknown';
  if (w.state === 'measured') return `${num(w.fetched)} of ${num(w.observed)} fetched (${Math.round(w.rate * 100)} %)`;
  if (w.offered === 0) return 'never offered · too little data';
  if (typeof w.offered === 'number') return `${num(w.offered)}× offered · ${num(w.fetched || 0)} fetched · too little data (${num(w.observed || 0)} observed)`;
  return 'effect not measurable';
}
const skDay = (ts) => (ts ? String(ts).slice(0, 10) : '—');
async function skCatalogLoad() {
  const mine = ++skRun;
  let b = null;
  let ok = false;
  try {
    const r = await fetch('/dashboard/skills.json', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) { location.href = '/login'; return; }
    b = await r.json();
    ok = r.ok;
  } catch (e) {
    b = { state: 'unknown', reason: 'network: ' + (e?.message || e) };
  }
  if (mine !== skRun) return;
  skCat = ok && Array.isArray(b?.entries) ? b : null;
  const el = $('#skillCatalog');
  if (el) el.innerHTML = skCat ? skCatalogHtml() : note(`Catalogue not readable: ${esc(reasonPlain(b?.reason))}. State: unknown.`, 'bad');
}
function skFits(x) {
  if (skFilter.status !== 'all' && x.status !== skFilter.status) return false;
  if (skFilter.type !== 'all' && x.type !== skFilter.type) return false;
  const q = skFilter.q.trim().toLowerCase();
  return !q || [x.name, x.titleFull, x.when, x.id, x.author, x.group].some((t) => String(t || '').toLowerCase().includes(q));
}
function skRow(x) {
  const d = x.drift ? `<span class="badge bad" title="${esc(x.drift.text)}"><i class="dot"></i>drift</span>` : '';
  return `<button class="sk-row" data-sk-id="${esc(x.id)}" title="${esc(x.titleFull)}" aria-label="Open ${esc(x.name)}"><span class="sk-head"><strong class="mono sk-name">${esc(x.name)}</strong>${skBadge(x.status)}${d}</span><span class="sk-when">${esc(x.when)}</span><span class="sk-meta"><span>${esc(x.author)}</span><span>${esc(skEffect(x.effect))}</span><span>changed ${esc(skDay(x.changed))}</span></span></button>`;
}
function skListHtml() {
  const byId = new Map(skCat.entries.map((x) => [x.id, x]));
  let hits = 0;
  const parts = skCat.types.map((t) => {
    const groups = t.groups.map((g) => {
      const xs = g.ids.map((id) => byId.get(id)).filter((x) => x && skFits(x));
      hits += xs.length;
      return xs.length ? `<div class="sk-group"><div class="label">${esc(g.name)} · ${num(xs.length)}</div>${xs.map(skRow).join('')}</div>` : '';
    }).join('');
    return groups ? `<section class="sk-type"><h2>${esc(t.name)}</h2>${groups}</section>` : '';
  }).join('');
  if (!skCat.entries.length) return empty('No skill, workflow, snippet or procedure recorded yet. A skill: <code class="mono">mem log skill …</code>; its status is set by a human: <code class="mono">mem skills status &lt;id&gt; released --issued-by owner</code>.');
  return parts ? `${parts}<p class="small quiet" style="margin-top:10px">${num(hits)} of ${num(skCat.entries.length)} entries.</p>` : empty('No entry matches the filter and the search.');
}
const skCopy = (cmd) => `<div class="sk-cmd"><code class="mono">${esc(cmd)}</code><button class="btn small ghost" data-sk-copy="${esc(cmd)}">Copy</button></div>`;
function skInstalledHtml() {
  const k = skCat;
  const places = k.installed.places.map((o) => {
    const files = k.installed.files.filter((d) => d.place === o.place);
    const head = `<strong>${esc(o.title)}</strong> ${o.state === 'ok' ? badge('good', num(o.count) + ' SKILL.md') : badge('unknown', o.state === 'missing' ? 'folder missing' : 'incomplete')}${o.reason ? `<p class="small quiet">${esc(o.reason)}</p>` : ''}`;
    if (!files.length) return `<div class="sk-place">${head}</div>`;
    const rows = files.map((d) => `<div class="sk-inst"><strong class="mono">${esc(d.name)}</strong>${d.memExport ? `<span class="badge good"><i class="dot"></i>from mem export${d.memExport.id ? ' · ' + esc(d.memExport.id) : ''}</span>` : '<span class="badge"><i class="dot"></i>foreign</span>'}<span class="small quiet sk-path">${esc(d.path)}</span>${d.description ? `<span class="small muted sk-when">${esc(d.description)}</span>` : ''}</div>`).join('');
    return `<details class="sk-place"${files.length <= 6 ? ' open' : ''}><summary>${head}</summary>${rows}</details>`;
  }).join('');
  const dr = k.drift;
  const drHtml = dr.length
    ? dr.map((a) => `<div class="row"><div><strong class="mono">${esc(a.name || a.id || '?')}</strong><p>${esc(a.text)}${a.status ? ' · status ' + esc(a.status) : ''}</p></div>${a.id && k.entries.some((x) => x.id === a.id) ? `<button class="btn small ghost" data-sk-id="${esc(a.id)}">Open</button>` : ''}</div>`).join('')
    : note('No drift: everything released is installed as SKILL.md, nothing withdrawn is still installed.', 'good');
  return `<div class="grid two sk-bottom">${panel('Installed', places + `<div style="margin-top:14px"><div class="small muted">Roll out (CLI only — ${esc(k.manage.exportReason)}):</div>${skCopy(k.manage.exportCommand)}</div>`, 'SKILL.md files the server sees in the skill folders of Claude Code')}${panel(`Drift · ${num(dr.length)}`, drHtml, 'Registry against installed: released but not rolled out, rolled out but withdrawn or outdated')}</div>`;
}
function skCatalogHtml() {
  const k = skCat;
  const z = k.counts || {};
  const metrics = `<div class="metrics sk-metrics">${[
    ['Entries', k.entries.length, 'skills, workflows, snippets, procedures'],
    ['Released', z.released || 0, 'in force, exported'],
    ['Trial', z.trial || 0, 'exported with a mark'],
    ['Drift', k.drift.length, 'registry ≠ installed'],
  ].map(([n, v, sub]) => `<div class="metric"><div class="name">${n}</div><strong>${num(v)}</strong><small>${sub}</small></div>`).join('')}</div>`;
  const statuses = ['all', 'released', 'trial', 'proposed', 'unknown', 'draft', 'withdrawn'];
  const typeOpts = [['all', 'All types'], ...k.types.filter((t) => t.count).map((t) => [t.type, `${t.name} · ${t.count}`])];
  const bar = `<div class="toolbar sk-bar"><input class="field searchfield" id="skSearch" type="search" placeholder="Name, trigger, author …" aria-label="Search the skills" value="${esc(skFilter.q)}"><select class="field" id="skStatus" aria-label="Filter by status">${statuses.map((s) => `<option value="${s}" ${skFilter.status === s ? 'selected' : ''}>${s === 'all' ? 'All statuses' : esc(s) + (z[s] ? ' · ' + z[s] : '')}</option>`).join('')}</select><select class="field" id="skType" aria-label="Filter by type">${typeOpts.map(([v, n]) => `<option value="${v}" ${skFilter.type === v ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>`;
  const eff = k.effect?.state === 'measured' ? '' : note(`Effect (offered → fetched): ${esc(k.effect?.reason || 'unknown')}. Below ${num(k.effect?.minN ?? 10)} observed offers it reads "too little data", never a zero rate.`);
  return `${metrics}${bar}<div id="skList">${skListHtml()}</div>${eff}${skInstalledHtml()}`;
}
function skDetail(id) {
  const x = skCat?.entries.find((e) => e.id === id);
  if (!x) return;
  const m = skCat.manage;
  const hist = x.history.map((g) => `<div class="event"><time>${esc(g.ts || '—')}</time><h3>${g.kind === 'status' ? `Status → ${esc(g.status)}` : g.kind === 'version' ? 'New version' : 'Created'}${g.counts ? '' : ' <span class="badge unknown"><i class="dot"></i>skipped: not a human</span>'}</h3><p>${esc(g.by || 'unknown')}${g.agent && g.agent !== g.by ? ' · written down by ' + esc(g.agent) : ''} · ${esc(g.id)}</p>${g.why ? `<p class="small muted">${esc(g.why)}</p>` : ''}</div>`).join('');
  let manage;
  if (!x.transitions.length) manage = note('Withdrawn is final — a successor is filed as a new entry, not revived.');
  else if (m.canSetStatus) {
    manage = `<form data-sk-form="${esc(x.id)}"><label class="formfield">New status<select class="field" name="status" required>${x.transitions.map((s) => `<option value="${s}">${esc(s)}</option>`).join('')}</select></label><label class="formfield">Why (required)<textarea class="field" name="why" required minlength="3" maxlength="2000" placeholder="e.g. tried in three sessions, release it"></textarea></label><p class="small quiet">Issued by: owner (from the password session, not selectable). One status line is appended; nothing is overwritten.</p><div class="drawer-actions"><button class="btn primary" type="submit">Set status …</button></div><div id="skStatusResult"></div></form>`;
  } else {
    manage = `${note(`No status button: ${esc(m.noButtonReason || 'no password session')}. The CLI writes the change — the same function, the same transition rules:`)}${x.transitions.map((s) => skCopy(x.commands[s])).join('')}`;
  }
  const l = x.label || {};
  $('#detail').innerHTML = `<div class="drawer-head"><div class="top"><span class="label">${esc(x.typeName)} / ${esc(x.id)}</span><button class="iconbtn" data-close="detail" aria-label="Close the detail">✕</button></div><h2 id="detailTitle" class="mono sk-detail-name">${esc(x.name)}</h2><p class="muted">${esc(x.title)}</p><div style="margin-top:10px">${skBadge(x.status)}${x.legacy ? ' <span class="badge"><i class="dot"></i>legacy</span>' : ''}${x.drift ? ` <span class="badge bad"><i class="dot"></i>${esc(x.drift.text)}</span>` : ''}</div></div><div class="drawer-body"><h3>Capability label</h3><div class="metadata" style="margin-top:8px"><div><span>What</span><b>${esc(l.what)}</b></div><div><span>For whom</span><b>${esc(l.for_whom)}</b></div><div><span>Cost</span><b>${esc(l.cost)}</b></div><div><span>Author</span><b>${esc(x.author)}</b></div><div><span>Effect</span><b>${esc(skEffect(x.effect))}${x.effect?.state === 'measured' ? '' : ` (minimum ${num(skCat.effect?.minN ?? 10)})`}</b></div><div><span>Installed as</span><b>${x.installedAs.length ? x.installedAs.map((i) => esc(i.path)).join(', ') : 'not rolled out'}</b></div><div><span>Project</span><b>${esc(x.project || 'global')}</b></div><div><span>Group</span><b>${esc(x.group)}</b></div></div><h3 style="margin-top:22px">When to use</h3><p class="muted" style="margin-top:6px">${esc(x.when)}</p>${x.triggers.slice(1).map((a) => `<span class="tag">${esc(a)}</span>`).join('')}<h3 style="margin-top:22px">Manage</h3>${manage}<h3 style="margin-top:22px">Status history</h3><div class="timeline" style="margin-top:12px">${hist || '<p class="small quiet">No lines.</p>'}</div><h3 style="margin-top:22px">Full text</h3><pre>${esc(x.fullText)}</pre></div>`;
  if (!$('#detail').open) $('#detail').showModal();
}
async function skStatusSet(form) {
  const id = form.dataset.skForm;
  const status = form.elements.status.value;
  const why = form.elements.why.value.trim();
  const outEl = $('#skStatusResult');
  if (why.length < 3) { outEl.innerHTML = note('Please give a reason (at least 3 characters).', 'bad'); return; }
  const x = skCat.entries.find((e) => e.id === id);
  if (!confirm(`${x ? x.name : id}: ${x ? x.status : '?'} → ${status}\n\nWhy: ${why}\n\nAppend the status line now?`)) return;
  outEl.innerHTML = '<p class="small quiet">Writing …</p>';
  let s;
  try { s = await taskStart({ kind: 'skill-status', id, status, why }); } catch (e) { s = { ok: false, reason: 'network: ' + (e?.message || e) }; }
  if (!s.ok) { outEl.innerHTML = note('Refused: ' + esc(reasonPlain(s.reason)) + '. Nothing was written.', 'bad'); return; }
  const done = await waitForTask(s.id, { maxMs: 30000 });
  if (done.state !== 'ok') { outEl.innerHTML = note('Not confirmed: ' + esc(done.reason || done.state || 'unknown') + '.', 'bad'); return; }
  toast(`Status set: ${status}`);
  await skCatalogLoad();
  skDetail(id);
}
document.addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-sk-copy]');
  if (c) {
    const t = c.dataset.skCopy;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(t).then(() => toast('Command copied'), () => toast('Copying not allowed — select the command and copy it'));
    else toast('Copying not available — select the command and copy it');
    return;
  }
  const z = ev.target.closest('[data-sk-id]');
  if (z && skCat) skDetail(z.dataset.skId);
});
document.addEventListener('submit', (ev) => {
  const f = ev.target.closest('[data-sk-form]');
  if (!f) return;
  ev.preventDefault();
  skStatusSet(f);
});
document.addEventListener('input', (ev) => {
  const t = ev.target;
  if (!t || !['skSearch', 'skStatus', 'skType'].includes(t.id) || !skCat) return;
  if (t.id === 'skSearch') skFilter.q = t.value;
  if (t.id === 'skStatus') skFilter.status = t.value;
  if (t.id === 'skType') skFilter.type = t.value;
  if ($('#skList')) $('#skList').innerHTML = skListHtml();
});
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
    `<p class="muted">${esc(r.project ?? 'no project')} · ${esc((r.topics || []).join(', ') || 'no topic')} · ${esc(rawWord[r.state] || r.state)}</p><div class="row"><span>Path</span><span class="mono small">${esc(r.path)}</span></div><div class="row"><span>Captured</span><span>${esc(r.at ? whenTime(r.at) : 'no date')}</span></div><div class="row"><span>Surface / session</span><span>${esc(r.surface || '—')} / ${esc(r.session || '—')}</span></div><div class="row"><span>Lines / bytes</span><span>${num(r.lines)} / ${num(r.bytes)}</span></div>${r.deleted ? `<div class="row"><span>Deleted</span><span>${esc(r.deleted.at || '')} · ${esc(r.deleted.reason || 'no reason')} (${esc(r.deleted.by || '—')})</span></div>` : ''}<div class="row"><span>Digested from it</span><strong>${num((r.entries || []).length)} entries</strong></div>${es.length ? entryRows(es.slice(0, 8)) : note((r.entries || []).length ? `${num(r.entries.length)} entries were digested from it, but none of them is in the loaded part of this view.` : 'Nothing was digested from this capture (yet). The raw text itself is never shown in the dashboard — it does not leave the server; it is readable only there, with "mem raw show".')}${
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
const TASK_WHERE = { 'raw-delete': 'Started in Raw capture, per capture', 'project-confirm': 'Started on the overview under Today and in Projects, per waiting project' };
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
    : `<span class="small quiet">${TASK_WHERE[k] || 'Started at the entry (detail)'}</span>`;
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

// --- Derived links to review (src/netderive.mjs, `mem net --derived`) ---------
// One read-only list: the borderline pairs (strong shared rare terms alone). The system does not
// decide them; a human draws the link (`mem log link`) or leaves it. Auto pairs (terms AND file
// strong) are drawn dashed in the atlas and listed below them.
function derivedPanel() {
  const d = D.net?.derived;
  if (!d || d.unknown) return panel('Derived links to review', `<p class="muted">${badge('unknown')} Not computed: ${esc(d?.reason || 'no data')}.</p>`, 'Guesses from shared evidence');
  const row = (l) => `<div class="row"><div class="row-main"><div>${open(l.from, short5(byId(l.from)?.title || l.from), 'open-entry textlink')} <span class="quiet">→</span> ${open(l.to, short5(byId(l.to)?.title || l.to), 'open-entry textlink')}<p class="small muted">${esc(l.reason)}</p></div></div><span class="badge ${l.tier === 'auto' ? '' : 'warn'}">${l.tier === 'auto' ? 'auto · dashed' : 'for you'}</span></div>`;
  const head = `<p class="small muted">${num(d.borderlineTotal)} borderline${d.borderlineTotal > d.borderline.length ? ` (${num(d.borderline.length)} strongest listed)` : ''} · ${num(d.auto.length)} auto, drawn dashed · ${num(d.linked)} already linked · over ${num(d.entries)} entries. Nothing here is stored or decided: a link you agree with is drawn with <code class="mono">mem log link --from … --to … --kind …</code>.</p>`;
  const body = [...d.borderline, ...d.auto.slice(0, 40)].map(row).join('') || empty('No pair shares enough rare evidence. With more entries the list fills by itself.');
  return panel('Derived links to review', head + body, 'Shared rare terms and files · deterministic, no model');
}
const short5 = (t) => String(t).trim().split(/\s+/).slice(0, 6).join(' ');
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
// --- atlas-pass-cm: the condensed atlas ---------------------------------------------
// For a store the full build cannot handle (the server builds compact,
// `D.atlas.condensed`) the atlas first shows only topics and drawers with their
// counters (computed by the server in one pass; the size does not grow with the
// store). The entries of a topic or a drawer come when zooming in, page by page
// through /dashboard/part.json?part=atlas. A small store keeps the full view
// (there is no `D.atlas`).
const CONDENSED_MODES = new Set(['storage', 'overview', 'topics', 'structure']);
const atlasCondensed = (mode = state.graphMode) => Boolean(D?.atlas?.condensed) && CONDENSED_MODES.has(mode);
const ATLAS_PAGE = 60;
const atlasPages = new Map(); // key -> { list, total, next, loading, searching, error, source, state }
const atlasKey = (kind, value, project) => kind + ':' + value + (kind === 'theme' ? '|' + project : '');
const atlasPageOf = (kind, value) => atlasPages.get(atlasKey(kind, value, state.project)) || null;
// The context for graphModel(): null = the full view.
function atlasContext(mode) {
  if (!atlasCondensed(mode)) return null;
  const proj = state.project;
  const loaded = (kind, value) => atlasPages.get(atlasKey(kind, value, proj))?.list || [];
  const seen = new Map();
  for (const [k, pg] of atlasPages) if (k.startsWith('drawer:') || k.endsWith('|' + proj)) for (const e of pg.list) if (scope(e)) seen.set(e.id, e);
  return { atlas: D.atlas, proj, loaded, scope, focus: camera.focus, entries: [...seen.values()] };
}
// F20: states per page: 'loading' | 'ok' | 'error' | 'expired' (deadline/budget). Only 'loading' and 'ok' keep a
// new attempt from starting; 'error' and 'expired' can be repeated (button "Try again"). A page that is still
// being built is asked for within a budget (requests) and a deadline (time) and ends visibly, never as an empty
// apparent success.
const ATLAS_DEADLINE_MS = 90000;
const ATLAS_REQUESTS = 150;
async function atlasLoad(kind, value, { more = false } = {}) {
  const project = state.project;
  const k = atlasKey(kind, value, project);
  const old = atlasPages.get(k);
  if (old?.loading) return;
  const retry = old && (old.state === 'error' || old.state === 'expired');
  if (old && !more && !retry) return;
  if (old && more && !retry && old.next === null) return;
  const pg = old || { list: [], total: null, next: 0, loading: false, searching: false, error: null, source: null, state: 'loading' };
  pg.loading = true; pg.error = null; pg.state = 'loading';
  atlasPages.set(k, pg);
  const run = runStart('atlas:' + k);
  const selection = () => state.project === project && atlasPages.get(k) === pg;
  const budget = runBudget({ deadlineMs: ATLAS_DEADLINE_MS, requests: ATLAS_REQUESTS });
  atlasStateShow();
  let done = false;
  try {
    while (!done) {
      const limit = budget.take();
      if (limit) {
        pg.state = 'expired';
        pg.error = limit === 'deadline'
          ? 'The store is still being built — the time limit (' + Math.round(ATLAS_DEADLINE_MS / 1000) + ' s) ran out.'
          : 'The store is still being built — the budget of ' + budget.requests + ' requests is used up.';
        break;
      }
      // Literal, not t.path — the closed route list (test/dashboard-page.test.mjs) sees literal ones only.
      const r = await fetch('/dashboard/part.json?part=atlas&' + kind + '=' + encodeURIComponent(value) + '&project=' + encodeURIComponent(project) + '&from=' + (pg.next || 0) + '&n=' + ATLAS_PAGE, { credentials: 'same-origin', cache: 'no-store', signal: run.signal });
      if (!r.ok) throw new Error('answer ' + r.status);
      const b = await r.json();
      if (!run.holds(selection)) break;
      // Not built yet, or the search over the store is running: ask again (within the budget), never show it empty as a success.
      if (b.searching || b.building) {
        pg.searching = true; atlasStateShow();
        if (!(await runWait(run, TEMPO_TEST_MS ?? 700))) break;
        continue;
      }
      if (b.state !== 'ok' || !Array.isArray(b.data)) throw new Error(b.reason || 'state ' + b.state);
      for (const e of b.data) {
        if (!entryIndex.has(e.id)) entryIndex.set(e.id, entryOf(e));
        const x = entryIndex.get(e.id);
        if (!pg.list.includes(x)) pg.list.push(x);
      }
      pg.total = b.total; pg.next = b.next; pg.source = b.source || null;
      pg.state = 'ok';
      done = true;
    }
  } catch (e) {
    if (!runAborted(e) && run.holds(selection)) { pg.error = e?.message || String(e); pg.state = 'error'; }
  } finally {
    pg.loading = false; pg.searching = false;
  }
  if (!run.holds(selection)) {
    // Aborted or selection changed: no state is taken over; an empty page is dropped (a new attempt stays possible).
    if (pg.state === 'loading') { pg.state = pg.list.length ? 'ok' : 'error'; if (!pg.list.length && atlasPages.get(k) === pg) atlasPages.delete(k); }
    atlasStateShow();
    return;
  }
  // Redraw only when the page still shows the same view.
  if (pg.state === 'ok' && $('#brain') && atlasCondensed() && state.project === project) render();
  else atlasStateShow();
}
// What the group/cell in focus would load: { kind, value } or null.
function atlasTarget(g, c) {
  if (c?.condensed) return c.condensed;
  return g?.condensed?.kind === 'theme' ? g.condensed : null;
}
// The state of the page in focus, under the net: "60 of 1,234 loaded · load more".
function atlasStateShow() {
  const el = $('#atlasState'), more = $('.atlas-more');
  if (!el || !more) return;
  const m = graphAPI?.model;
  const g = m?.groups.find((x) => x.key === camera.focus);
  const z = m?.condensed ? atlasTarget(g, m.cells?.get(camera.cell)) : null;
  const pg = z ? atlasPageOf(z.kind, z.value) : null;
  if (!m?.condensed) { el.textContent = ''; more.hidden = true; return; }
  if (!z) { el.textContent = `Condensed: ${num(D.overview?.count ?? 0)} entries in ${num(D.atlas.themesTotal)} topics · entries appear when zooming in`; more.hidden = true; return; }
  if (!pg || (pg.loading && !pg.list.length)) { el.textContent = pg?.searching ? 'Searching the store for entries …' : 'Loading entries …'; more.hidden = true; return; }
  if (pg.error) {
    // End state with a button to repeat (also when a partial list is already there).
    el.textContent = (pg.state === 'expired' ? 'Entries not finished: ' : 'Entries could not be loaded: ') + pg.error + (pg.list.length ? ` · ${num(pg.list.length)} loaded` : '');
    more.hidden = false; more.textContent = 'Try again';
    return;
  }
  el.textContent = `${num(pg.list.length)} of ${num(pg.total ?? countOf(g))} entries loaded` + (pg.loading ? (pg.searching ? ' · searching for more …' : ' · loading …') : '');
  more.hidden = pg.next === null || pg.loading;
  more.textContent = 'Load ' + num(ATLAS_PAGE) + ' more';
}
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
function graphModel(es, mode, vk = null) {
  // atlas-pass-cm: `vk` is the context of the condensed atlas (atlasContext()): topics and
  // drawers count from `vk.atlas`, and the net holds only the pages loaded when zooming in.
  // Without `vk` the full view as before.
  const condensed = Boolean(vk);
  const proj = vk?.proj;
  const loadedFor = (kind, value) => (vk ? vk.loaded(kind, value) : []);
  if (condensed) es = vk.entries;
  const ids = new Set(es.map((e) => e.id)),
    stored = allEdges(es).filter((e) => ids.has(e.to)),
    // The third kind (src/netderive.mjs): auto-tier derived links, drawn dashed. They join the
    // drawing, never the bundling (adjacency) and never the loops: nobody wrote them.
    derived = mode === 'trail' || typeof D !== 'object' ? [] : (D?.net?.derived?.auto || []).filter((d) => ids.has(d.from) && ids.has(d.to)).map((d) => ({ from: d.from, to: d.to, kind: 'derived', derived: d })),
    edges = stored.concat(derived),
    adj = new Map(es.map((e) => [e.id, new Set()]));
  stored.forEach((e) => {
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  });
  const groups = [],
    assignment = new Map();
  const projectCount = new Map();
  if (condensed) {
    for (const d of vk.atlas.drawers || []) if (proj === 'all' || d.project === proj) projectCount.set(d.project, (projectCount.get(d.project) || 0) + d.count);
  } else for (const e of es) projectCount.set(e.project, (projectCount.get(e.project) || 0) + 1);
  const shards = [...projectCount]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([p, n], i) => ({ key: 'shard:' + p, label: p, shard: p, color: neuralPalette[i % 7], members: es.filter((e) => e.project === p), ...(condensed ? { count: n } : {}) }));
  const positions = [
    [-0.64, 0.46, 0.45],
    [0.64, 0.4, 0.39],
    [-0.7, 0.2, -0.46],
    [0.69, 0.15, -0.47],
    [-0.51, -0.49, 0.19],
    [0.54, -0.48, 0.18],
  ];
  // Centres of the main nodes. n <= 6: the fixed spots; up to GROUPS_SHELL_FROM the double
  // surface; above that one Fibonacci shell whose radius grows with the node count.
  const position = (i, n, plan) => {
    if (n <= 6) return { x: positions[i][0], y: positions[i][1], z: positions[i][2] };
    if (n > GROUPS_SHELL_FROM) return shellPoint(plan || shellPlan(n), i);
    const j = Math.floor(i / 2),
      side = i % 2 ? 1 : -1,
      a = j * 2.399963;
    return { x: side * (0.48 + 0.18 * Math.sin(a)), y: 0.66 - (1.22 * j) / Math.max(1, Math.ceil(n / 2) - 1), z: Math.cos(a) * 0.49 };
  };
  shards.forEach((s, i) => (s.center = position(i, shards.length)));
  function add(key, label, members, extra = {}) {
    if (!members.length && !extra.condensed) return;
    const g = { key, label, members, color: neuralPalette[groups.length % 7], ...extra };
    groups.push(g);
    members.forEach((e) => assignment.set(e.id, g));
  }
  if (condensed) {
    // An entry stands in the net only ONCE (it may carry several topics): first the group in focus,
    // then the order of the nodes.
    const taken = new Set();
    const take = (list, inFocus) => list.filter((e) => vk.scope(e) && (inFocus || !taken.has(e.id)) && (taken.add(e.id), true));
    if (mode === 'topics') {
      const themes = (vk.atlas.themes || []).map((t) => ({ t, n: proj === 'all' ? t.count : t.perProject?.[proj] || 0 })).filter((x) => x.n > 0);
      const focusTag = String(vk.focus || '').startsWith('tag:') ? vk.focus.slice(4) : null;
      const first = focusTag ? new Map([[focusTag, take(loadedFor('theme', focusTag), true)]]) : new Map();
      for (const { t, n } of themes) {
        const members = first.get(t.tag) ?? take(loadedFor('theme', t.tag), false);
        const r = t.recall;
        add('tag:' + t.tag, t.tag, members, { count: n, condensed: { kind: 'theme', value: t.tag }, recallMean: r && r.measured ? r.sessions / r.measured : null });
      }
    } else if (mode === 'structure') {
      const perType = new Map();
      for (const d of vk.atlas.drawers || []) if (proj === 'all' || d.project === proj) perType.set(d.type, (perType.get(d.type) || 0) + d.count);
      [...perType].sort((a, b) => a[0].localeCompare(b[0])).forEach(([t, n]) => add('type:' + t, types[t] || t, [], { count: n, condensed: { kind: 'type', value: t } }));
    } else shards.forEach((sh) => add(sh.key, sh.label, [], { color: sh.color, project: sh.shard, count: sh.count, condensed: { kind: 'project', value: sh.shard } }));
  } else if (mode === 'topics') {
    // EVERY topic with members is a main node of its own — no cap, no collecting node
    // "Other topics" (parity with the sibling house 2026-10-01: a capped picture differs from
    // the real net). An entry lands in the topic of its most frequent still-free tag; the
    // counts are updated while assigning instead of rebuilt per round.
    const byTag = new Map(), counts = new Map(), free = new Set(es);
    for (const e of es) for (const tag of new Set(e.tags)) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(e);
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    while (free.size) {
      let best = null;
      for (const [tag, n] of counts) if (n > 0 && (!best || n > best[1] || (n === best[1] && tag.localeCompare(best[0], 'en') < 0))) best = [tag, n];
      if (!best) {
        add('untagged', 'No topic', es.filter((e) => free.has(e)));
        break;
      }
      const members = byTag.get(best[0]).filter((e) => free.has(e));
      add('tag:' + best[0], best[0], members);
      for (const e of members) {
        free.delete(e);
        for (const tag of new Set(e.tags)) counts.set(tag, counts.get(tag) - 1);
      }
    }
  } else if (mode === 'relations') {
    // As in the mockup: repeatedly the entry with the most still-free neighbours plus its
    // neighbours. WITHOUT a cap: every bundle with members is a main node. Only entries without
    // any internal relation remain, as one honestly named group.
    const remaining = new Set(es.map((e) => e.id));
    while (remaining.size) {
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
  // Centre, weight and size per main node (weight = member count, the sphere grows with its
  // root). Up to GROUPS_SHELL_FROM groups everything stays as before. Above that only the
  // heaviest topics/bundles stay main nodes (hierarchise), the rest become their subtopics, and
  // the main nodes sit on ONE shell whose radius grows with the node count; the heaviest stand
  // spread (golden step) instead of side by side.
  let topicsTotal = groups.length, tiered = false;
  if (!condensed && (mode === 'topics' || mode === 'relations') && groups.length > GROUPS_SHELL_FROM) {
    tiered = true;
    const r = hierarchise(groups, assignment, adj);
    topicsTotal = r.topics + groups.filter((g) => g.key === 'untagged' || g.key === 'isolated').length;
  }
  const groupCount = groups.length, many = mode !== 'trail' && (tiered || groupCount > GROUPS_SHELL_FROM);
  const maxWeight = Math.max(1, ...groups.map((g) => countOf(g)));
  const plan = many ? shellPlan(groupCount, topicsTotal, tiered ? SHELL_TIER_MIN : SHELL_MIN) : null;
  const step = many ? shellStep(groupCount) : 1;
  const rank = many ? new Map([...groups.keys()].sort((a, b) => countOf(groups[b]) - countOf(groups[a]) || a - b).map((gi, r) => [gi, r])) : null;
  const cellMap = new Map(); // condensed: key -> cell (a drawer or a collecting node)
  groups.forEach((g, i) => {
    g.weight = countOf(g);
    g.weightRank = many ? rank.get(i) : i;
    g.center = mode === 'trail' ? { x: 0, y: 0, z: 0 } : many && (mode === 'topics' || mode === 'relations') ? shellPoint(plan, (rank.get(i) * step) % groupCount) : position(i, groupCount, plan);
    const rel = Math.sqrt(g.weight / maxWeight);
    g.radius = mode === 'trail' ? 0.62 : many ? Math.max(0.02, Math.min(tiered ? 0.3 : 0.19, 0.42 * plan.d * (0.35 + 0.65 * rel))) : groups.length > 8 ? 0.19 : 0.29;
    g.scale = many ? Math.max(0.25, Math.min(1, (g.radius / 0.19) * 1.2)) : 1;
    g.coreRadius = many ? (tiered ? 0.03 + 0.03 * rel : 0.007 + 0.022 * rel) : null;
    g.direct = null;
    if (condensed) {
      g.cells = condensedCells(g, mode, vk);
      g.direct = mode === 'topics' && g.members.length ? g.members : null;
      g.cells.forEach((c) => cellMap.set(c.key, c));
    } else if (mode === 'topics' || (mode === 'relations' && g.attached?.length)) {
      // Subtopics from the tag bundles, radially outward; without any the subgroups stay.
      const tree = subtopicTree(g, splitCells);
      g.cells = tree.cells.length ? tree.cells : splitCells(g.members, g.center, g.radius, g.key, g.key);
      g.direct = tree.cells.length ? tree.direct : null;
      g.hull = hullOf(g.center, g.radius, g.cells);
    } else g.cells = mode === 'trail' ? [] : mode === 'storage' ? drawerCells(g, false) : mode === 'overview' ? drawerCells(g, true) : splitCells(g.members, g.center, g.radius, g.key, g.key);
  });
  // Drawing scale: when the net grows outward (a large shell, a subtopic bloom) it fills only
  // part of the fitted picture; nodes, strands and lights grow with the extent (1 = the old
  // compact net, at most 2.2). With few topics everything stays exactly as before.
  let extent = 0.9;
  const measure = (c) => { extent = Math.max(extent, Math.hypot(c.center.x - CORE_POINT.x, c.center.y - CORE_POINT.y, c.center.z - CORE_POINT.z) + (c.radius || 0)); (c.cells || []).forEach(measure); };
  if (mode !== 'trail') groups.forEach(measure);
  const bloom = groups.some((g) => g.cells.some((c) => c.topic));
  const sk = many || bloom ? Math.max(1, Math.min(2.2, Math.pow(extent / 1.25, 0.6))) : 1;
  // Loops of the STORED links (A -> B -> C -> A), deterministic.
  const cycles = mode === 'trail' ? [] : findCycles(stored, ids);
  return { groups, assignment, edges, shards, records: es, mode, many, tiered, topicsTotal, cycles, sk, extent, derivedCount: derived.length, condensed, cells: cellMap };
}
// The cells of a condensed group: in the topics mode ONE collecting node (all entries of the topic,
// the count from the server; the loaded ones lie around the middle), otherwise the drawers
// (project x type) with their counters — pages are loaded per drawer.
function condensedCells(g, mode, vk) {
  const proj = vk.proj;
  const cell = (key, label, extra, j, count) => {
    const a = j * 2.399963, y = count === 1 ? 0 : 1 - (2 * (j + 0.5)) / count, r = Math.sqrt(Math.max(0, 1 - y * y)) * g.radius;
    return { key, label, center: count === 1 && extra.collective ? { ...g.center } : { x: g.center.x + Math.cos(a) * r, y: g.center.y + y * g.radius, z: g.center.z + Math.sin(a) * r }, parent: g.key, group: g.key, depth: 0, radius: g.radius * (extra.collective ? 0.25 : 0.3), cells: [], ...extra };
  };
  if (mode === 'topics') return [cell(g.key + ':all', g.label, { collective: true, count: g.count, members: [], topic: null, recallMean: g.recallMean }, 0, 1)];
  const drawers = (vk.atlas.drawers || []).filter((d) => (proj === 'all' || d.project === proj) && (mode === 'structure' ? d.type === g.condensed.value : d.project === g.condensed.value));
  return drawers.map((d, j) => cell(g.key + ':drawer:' + (mode === 'structure' ? d.drawer : d.type), mode === 'structure' ? d.project : types[d.type] || d.type,
    { drawer: d.drawer, count: d.count, members: vk.loaded('drawer', d.drawer).filter(vk.scope), condensed: { kind: 'drawer', value: d.drawer } }, j, drawers.length));
}
// The count of a node: condensed from the server (`count`), otherwise its members.
function countOf(x) {
  return x && Number.isFinite(x.count) ? x.count : x?.members?.length ?? 0;
}
// --- Radial hierarchy (parity with the sibling house 2026-10-01) --------------
// Core inside -> main topics on the first shell -> subtopics further out (they "bloom" from
// their topic outward) -> entries outermost. The shell GROWS with its node count; subtopics
// come deterministically from the members' tag bundles, never from chunks or chance.
// From this group count on: one shell instead of the old double surface (measured by the
// sibling: the double surface becomes two flat bands, minimum gap n=221 0.109 against 0.162).
const GROUPS_SHELL_FROM = 16;
// Target gap of neighbouring main nodes on the first shell, and the smallest shell radius.
const SHELL_GAP = 0.34;
const SHELL_MIN = 0.62;
// Hierarchy: as many main topics as a share of the topics gives (7 %, at least 8, at most
// 20); the first shell then lies clearly further from the core.
const MAIN_SHARE = 0.07, MAIN_MIN = 8, MAIN_MAX = 20, SHELL_TIER_MIN = 2.2;
const SHELL_AXES = { x: 1, y: 0.86, z: 0.8 };
const CORE_POINT = { x: 0, y: -0.03, z: 0.02 };
// A topic with more members than CELL_SPLIT splits by its tags; a subtopic needs at least
// SUBTOPIC_MIN members; the recursion ends at SUBTOPIC_DEPTH. What fits no subtopic stays
// DIRECTLY at the topic.
const CELL_SPLIT = 28;
const SUBTOPIC_MIN = 4;
const SUBTOPIC_DEPTH = 3;
// Loops: stored links only, at most this long and this many.
const CYCLE_MAX_LENGTH = 8;
const CYCLES_MAX = 400;
// Label tiers with many main nodes: the heaviest always carry a label; this many more may
// appear once their sphere is large enough on screen (zooming in).
const LABEL_GROUPS_FIXED = 10;
const LABEL_GROUPS_EXTRA = 26;
const LABEL_MIN_PX = 30;
// Rings (two torus meshes per core) only for the heaviest main nodes.
const CORE_RINGS_MAX = 16;
// Below this zoom (1 = whole view) single edges inside a group are quiet; bundled strands and
// those across group borders stay loud.
const STRAND_NEAR_ZOOM = 1.6;
// At most this many loops are drawn as a path (all count; meshes are expensive).
const CYCLES_DRAWN_MAX = 60;
const PHI_GOLDEN = 0.6180339887498949;
/** Unit vector from the core outward; without a distance: forward. */
function outward(p) {
  const x = p.x - CORE_POINT.x, y = p.y - CORE_POINT.y, z = p.z - CORE_POINT.z, l = Math.hypot(x, y, z);
  return l < 1e-6 ? { x: 0, y: 0, z: 1 } : { x: x / l, y: y / l, z: z / l };
}
/** Plan of the first shell for n main nodes: the radius grows with the root of n, grid gap d. */
function shellPlan(n, total = n, minR = SHELL_MIN) {
  const R = Math.max(minR, 0.2625 * 1.1 * (minR === SHELL_TIER_MIN ? 0.55 : SHELL_GAP) * Math.sqrt(Math.max(1, total)));
  return { R, d: n <= 1 ? SHELL_GAP : Math.min(1.2, (R * 3.809) / Math.sqrt(n)) / 1.1, n };
}
function shellPoint(plan, i) {
  const n = plan.n, a = i * 2.399963, y = n === 1 ? 0 : 1 - (2 * (i + 0.5)) / n, q = Math.sqrt(Math.max(0, 1 - y * y));
  return { x: Math.cos(a) * q * plan.R * SHELL_AXES.x, y: y * plan.R * SHELL_AXES.y, z: Math.sin(a) * q * plan.R * SHELL_AXES.z };
}
/** A step coprime to n near 0.618 n: consecutive ranks spread over the whole sphere. */
function shellStep(n) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  let s = Math.max(1, Math.round(n * PHI_GOLDEN));
  while (s > 1 && gcd(s, n) !== 1) s--;
  return s;
}
/** Tag bundles of a member list: per round the most frequent free tag (tie: name), from SUBTOPIC_MIN. */
function tagBundles(members, used) {
  const byTag = new Map(), counts = new Map(), free = new Set(members);
  for (const e of members) for (const tag of new Set(e.tags)) {
    if (used.has(tag)) continue;
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push(e);
    counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  const bundles = [];
  for (;;) {
    let best = null;
    for (const [tag, n] of counts) if (n >= SUBTOPIC_MIN && (!best || n > best[1] || (n === best[1] && tag.localeCompare(best[0], 'en') < 0))) best = [tag, n];
    if (!best) break;
    const m = byTag.get(best[0]).filter((e) => free.has(e));
    counts.set(best[0], 0);
    if (m.length < SUBTOPIC_MIN) continue;
    bundles.push([best[0], m]);
    for (const e of m) {
      free.delete(e);
      for (const tag of new Set(e.tags)) if (counts.has(tag) && tag !== best[0]) counts.set(tag, counts.get(tag) - 1);
    }
  }
  return { bundles, direct: members.filter((e) => free.has(e)) };
}
/** Subtopics bloom outward: a sphere (Fibonacci, decoupled radius) behind the parent node. */
function layBloom(cells, P, rp, mp) {
  const k = cells.length, u = outward(P);
  cells.forEach((c) => { c.radius = rp * (0.3 + 0.4 * Math.sqrt(c.members.length / Math.max(1, mp))); });
  const rMean = cells.reduce((sum, c) => sum + c.radius, 0) / k;
  const blob = k === 1 ? 0 : rMean * 2.1 * Math.cbrt(k);
  const dist = rp + Math.max(blob, rMean) + 0.05;
  const B = { x: P.x + u.x * dist, y: P.y + u.y * dist, z: P.z + u.z * dist };
  cells.forEach((c, i) => {
    const a = i * 2.399963, y = k === 1 ? 0 : 1 - (2 * (i + 0.5)) / k, q = Math.sqrt(Math.max(0, 1 - y * y)), rr = blob * Math.cbrt(((i + 0.5) * PHI_GOLDEN) % 1);
    c.center = { x: B.x + Math.cos(a) * q * rr, y: B.y + y * rr, z: B.z + Math.sin(a) * q * rr };
  });
}
/**
 * Hierarchy instead of equal-ranked nodes: only the heaviest topics/bundles (a share, not a
 * fixed number) stay main nodes; each smaller one becomes a subtopic of the main node it
 * shares the most entries/links with (tie: the heavier main node, then the key; no contact:
 * the one with the fewest subtopics). Nothing is cut, no collecting node.
 */
function hierarchise(groups, assignment, adj) {
  const free = (g) => g.key === 'untagged' || g.key === 'isolated';
  const sorted = groups.filter((g) => !free(g)).sort((a, b) => b.members.length - a.members.length || (a.key < b.key ? -1 : 1));
  const k = Math.max(MAIN_MIN, Math.min(MAIN_MAX, Math.round(groups.length * MAIN_SHARE)));
  const main = sorted.slice(0, k), small = sorted.slice(k);
  const mainOfEntry = new Map(), mainOfTag = new Map();
  for (const m of main) {
    m.own = m.members.slice();
    m.attached = [];
    for (const e of m.members) mainOfEntry.set(e.id, m);
    if (m.key.startsWith('tag:')) mainOfTag.set(m.key.slice(4), m);
  }
  for (const g of small) {
    const points = new Map();
    for (const e of g.members) {
      for (const nb of adj.get(e.id) || []) { const m = mainOfEntry.get(nb); if (m) points.set(m, (points.get(m) || 0) + 1); }
      for (const t of e.tags || []) { const m = mainOfTag.get(t); if (m) points.set(m, (points.get(m) || 0) + 1); }
    }
    let target = null;
    for (const m of main) {
      const p = points.get(m) || 0, q = target ? points.get(target) || 0 : -1;
      if (p > q || (p === q && p === 0 && m.attached.length < target.attached.length)) target = m;
    }
    target.attached.push(g);
  }
  for (const m of main) {
    for (const g of m.attached) { m.members = m.members.concat(g.members); for (const e of g.members) assignment.set(e.id, m); }
  }
  const keep = new Set([...main, ...groups.filter(free)]);
  const next = groups.filter((g) => keep.has(g));
  groups.length = 0;
  groups.push(...next);
  return { topics: sorted.length + (next.length - main.length), main: main.length };
}
/** The subtopic tree of a topic (recursive): `{ cells, direct }`. */
function subtopicTree(g, splitFn) {
  const attached = g.attached || [];
  if ((!g.key.startsWith('tag:') || g.members.length <= CELL_SPLIT) && !attached.length) return { cells: [], direct: null };
  const build = (members, used, parent, depth, P, rp, mp) => {
    const first = depth === 0;
    if (!first && (members.length <= CELL_SPLIT || depth >= SUBTOPIC_DEPTH)) return { cells: [], direct: null };
    // Level 0: the smaller topics attached to it are finished subtopics; its own entries split by tags as well.
    const own = first ? g.own || members : members;
    const ahead = first ? attached.map((a) => [a.label, a.members, a.key]) : [];
    const tags = g.key.startsWith('tag:') && own.length > CELL_SPLIT ? tagBundles(own, used) : { bundles: [], direct: own };
    const bundles = [...ahead, ...tags.bundles];
    if (!bundles.length) return { cells: [], direct: null };
    const cells = bundles.map(([tag, m, k]) => ({ key: parent + ':u:' + (k || tag), label: tag, topic: true, members: m, parent, group: g.key, depth, cells: [], direct: null }));
    layBloom(cells, P, rp, mp);
    cells.forEach((c) => {
      const sub = build(c.members, new Set([...used, c.label]), c.key, depth + 1, c.center, c.radius, c.members.length);
      // No further subtopic, but still large: the existing subgroups (splitCells) as before.
      c.cells = sub.cells.length || c.members.length <= CELL_SPLIT ? sub.cells : splitFn(c.members, c.center, c.radius, g.key, c.key, depth + 1);
      c.direct = sub.cells.length ? sub.direct : null;
    });
    return { cells, direct: tags.direct };
  };
  const r = build(g.members, new Set([g.key.slice(4)]), g.key, 0, g.center, g.radius, g.members.length);
  return { cells: r.cells, direct: r.cells.length ? r.direct : null };
}
/** The enclosing sphere of a node and all its subtopics (the focus flight keeps the bloom in the picture). */
function hullOf(mid, radius, cells) {
  const spheres = [{ x: mid.x, y: mid.y, z: mid.z, r: radius }];
  const collect = (list) => (list || []).forEach((c) => { spheres.push({ x: c.center.x, y: c.center.y, z: c.center.z, r: c.radius }); collect(c.cells); });
  collect(cells);
  let c = { ...spheres[0] };
  for (const k of spheres.slice(1)) {
    const d = Math.hypot(k.x - c.x, k.y - c.y, k.z - c.z);
    if (d + k.r <= c.r) continue;
    const r = (c.r + d + k.r) / 2, t = d ? (r - c.r) / d : 0;
    c = { x: c.x + (k.x - c.x) * t, y: c.y + (k.y - c.y) * t, z: c.z + (k.z - c.z) * t, r };
  }
  return c;
}
/**
 * Loops (cycles) of the STORED links: A -> B -> C -> A. Deterministic: strongly connected
 * components (Tarjan, iterative), in them every simple cycle up to CYCLE_MAX_LENGTH, each
 * starting at its smallest id, sorted by length and ids. Derived links do not count: they
 * always point from the younger to the older entry and would never be evidence.
 */
function findCycles(links, ids) {
  const adj = new Map([...ids].sort().map((id) => [id, new Set()]));
  for (const k of links) if (k.kind !== 'derived' && k.from !== k.to && adj.has(k.from) && adj.has(k.to)) adj.get(k.from).add(k.to);
  const next = new Map([...adj].map(([id, set]) => [id, [...set].sort()]));
  let counter = 0;
  const index = new Map(), low = new Map(), on = new Set(), stack = [], comps = [];
  for (const start of next.keys()) {
    if (index.has(start)) continue;
    const work = [[start, 0]];
    index.set(start, counter); low.set(start, counter); counter++; stack.push(start); on.add(start);
    while (work.length) {
      const top = work[work.length - 1], [v, i] = top, ns = next.get(v);
      if (i < ns.length) {
        top[1]++;
        const w = ns[i];
        if (!index.has(w)) { index.set(w, counter); low.set(w, counter); counter++; stack.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      } else {
        work.pop();
        if (work.length) { const p = work[work.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
        if (low.get(v) === index.get(v)) {
          const c = []; let w;
          do { w = stack.pop(); on.delete(w); c.push(w); } while (w !== v);
          if (c.length > 1) comps.push(c.sort());
        }
      }
    }
  }
  const cycles = [];
  for (const comp of comps.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const inside = new Set(comp);
    for (const s of comp) {
      const way = [s], seen = new Set([s]);
      const walk = (v) => {
        if (cycles.length >= CYCLES_MAX) return;
        for (const w of next.get(v)) {
          if (!inside.has(w) || w < s) continue;
          if (w === s) { cycles.push(way.slice()); continue; }
          if (seen.has(w) || way.length >= CYCLE_MAX_LENGTH) continue;
          seen.add(w); way.push(w);
          walk(w);
          way.pop(); seen.delete(w);
        }
      };
      walk(s);
    }
  }
  return cycles.sort((a, b) => a.length - b.length || (a.join() < b.join() ? -1 : 1)).slice(0, CYCLES_MAX);
}
// The evidence of a shown edge (a click on a strand shows it): a stored edge stands in the
// line of its entry (file:line); a derived one carries the system's reason.
function edgeEvidence(k) {
  if (k.kind === 'derived') return k.derived ? `derived, ${k.derived.tier === 'auto' ? 'automatic guess' : 'borderline'} · ${k.derived.reason}` : 'derived (evidence not loaded)';
  const rec = byId(k.record);
  return rec ? `stored in ${rec.source}${rec.line ? ':' + rec.line : ''} (${types[rec.type] || rec.type})` : 'stored (line not loaded)';
}
function graphCaption() {
  if (atlasCondensed()) {
    const at = D.atlas;
    return `Condensed view (large store): ${num(D.overview?.count ?? 0)} entries, ${num(at.themesTotal)} topics, the ${num(at.themesShown)} largest of them as nodes. An entry counts in every topic it carries; the server computes the figures in one pass over the whole store${at.exact === false ? ' (capped: ' + esc(at.reason || 'lower bounds') + ')' : ''}. The entries of a topic or a drawer appear when zooming in, page by page.`;
  }
  return {
    storage: 'One memory, spread over projects and their drawers (project × type). The shared core connects the project cores. Topics are independent of that.',
    topics: 'Every topic with entries is a main node of its own, without a cap: an entry stands in the topic of its most frequent free tag. With many topics the heaviest are main nodes and the others bloom outward as their subtopics. The size follows the entry count; labels carry the heaviest, the rest appear when zooming in, in a focus and on hover. Every tag stays on its entry.',
    relations: 'A point of reference and its direct neighbours form a relation bundle; every bundle is a main node of its own, without a cap. Entries without any relation stand in a group of their own, named so. Every stored cross-relation is kept.',
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
// The legend under the network: two short paragraphs, every statement checked against the code.
// "What you see" (graphCaption + recallLegend + strands/fog) and "Controls". The condensed atlas
// (entries only appear when zooming in, "Load more" = atlas-more) is named ONLY when
// atlasCondensed() holds — the same condition as the button itself; full screen = the button
// `graph-fullscreen` (Escape closes).
function graphLegend() {
  const cd = atlasCondensed();
  return `<p class="graph-description"><strong>What you see</strong><br>${graphCaption()} ${recallLegend()}. Solid strands = stored relations; finely dashed strands between entries = derived links (guessed, not stored, see "Derived links to review"); dashed branches at the project cores = the storage hierarchy. The fog is orientation only, not an entry.</p>`
    + `<p class="graph-description" data-graph-controls><strong>Controls</strong><br>${cd ? 'Click a group or zoom in: entries appear only then, "Load more" fetches the next ones.' : 'Large groups open through drawers and subgroups down to the single entry.'} The full-screen button in the toolbar enlarges the network, Escape closes it. Touch: tap, zoom with two fingers; "Whole view" leads back. Bundled strands keep every relation, the list shows them one by one.</p>`;
}
function brainBlock(large = false) {
  // atlas-pass-cm: condensed, the full list exists only as a number (the server's overview) —
  // `es` then stands for exactly that number, never for the part that is loaded.
  const cd = Boolean(D?.atlas?.condensed);
  const es = cd ? { length: areaFigures(scoped()).count } : scoped();
  const ks = cd ? (D.atlas.drawers || []).filter((d) => state.project === 'all' || d.project === state.project).length : new Set(es.map((e) => drawerOf(e))).size;
  const emptyHint = es.length ? '' : `<div class="graph-empty" role="note"><strong>Your first entries will appear here.</strong><span>One calm core is waiting. Every entry you log becomes an energy core around it — <code class="mono">mem log learning "…"</code></span></div>`;
  return `<article class="panel brain-panel neural-v4 ${large ? 'network-large' : ''}"><div class="brain-top"><div><div class="label">${esc(coreName())} / NEURAL ATLAS</div><h2>One memory. Many stores.</h2><p>${num(es.length)} entries incl. history · ${num(ks)} drawers · ${cd ? 'condensed: topics and drawers, entries when zooming in' : 'one shared knowledge structure'}</p></div>${btn(state.motion ? 'Ⅱ' : '▶', 'motion', 'aria-label="Toggle motion"', 'small ghost')}</div><div class="graph-tools"><select id="graphModeSelect" aria-label="Bundle the network by"><optgroup label="Knowledge network">${['storage', 'topics', 'relations', 'structure']
    .map((k) => `<option value="${k}" ${state.graphMode === k ? 'selected' : ''}>${graphModes[k]}</option>`)
    .join('')}</optgroup><optgroup label="Further modes">${['overview', 'trail'].map((k) => `<option value="${k}" ${state.graphMode === k ? 'selected' : ''}>${graphModes[k]}</option>`).join('')}</optgroup></select><div class="zoom-tools"><button data-action="graph-fullscreen" aria-label="Knowledge space in full screen" title="Full screen · Escape to close"><svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m10-4v4h-4"/></svg></button><button data-action="graph-zoom-out" aria-label="Zoom out">−</button><output id="graphZoom" aria-live="polite">100%</output><button data-action="graph-zoom-in" aria-label="Zoom in">+</button><button data-action="graph-reset" aria-label="Fit the whole network" title="Whole view · right click or 0">↺</button></div></div><div class="graph-context"><button data-action="graph-reset" class="atlas-back" hidden>← Whole view</button><span id="graphBreadcrumb" aria-live="polite">${esc(coreSlug())} / all projects</span><span class="atlas-mode">3D · PERSPECTIVE</span><span id="atlasState" class="atlas-state" aria-live="polite"></span><button data-action="atlas-more" class="atlas-more ghost small" hidden>Load more</button></div><div class="brain-viewport"><canvas id="brain" class="brain-canvas" tabindex="0" aria-label="Spatial knowledge network. Click a group to fly in, click an entry in focus to open it. Right click or zero resets the view. Drag rotates, shift and drag pans, plus and minus zoom."></canvas><div id="graphLabels" class="graph-labels"></div><div id="graphHover" class="graph-hover" role="status" hidden></div>${emptyHint}<div class="atlas-axis" aria-hidden="true"><i></i><span>X</span><span>Y</span><span>Z</span></div><div class="graph-fallback" hidden>3D is not available here. Every entry and every link stays reachable through the lists below the view.</div></div><div class="brain-bottom"><span id="graphEdgeCount"></span><span class="core-legend" title="${recallLegend()}"><i class="cl-bright"></i>often injected<i class="cl-faint"></i>never<i class="cl-matte"></i>not measurable</span><span class="graphhint">Left click: focus · Right click: everything · Drag: rotate</span></div></article><div class="cluster-strip" id="graphGroups" aria-label="Focus groups"></div>${graphLegend()}`;
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

// Render load (parity with the sibling's 41ea1e12 + c669e71): both draw
// loops (3D network, full-screen background shader) rest while the page
// is hidden OR a dialog (palette, detail, editor) is open — nobody sees
// a moving picture behind it, and a software-GL process would otherwise
// keep several cores busy. Closing a dialog (event `close`) wakes both.
const RESTING = () => document.hidden || !!document.querySelector('dialog[open]');
// After 60 s without input (pointer, key, wheel) both loops do NOT stop but
// slow to ~10 frames/s with a real-time step (same motion per second).
// Any input lifts them back to the full rate. A full stop remains only for
// RESTING() and prefers-reduced-motion (state.motion).
// `window.CM_IDLE_MS` is only the probes' test hook.
const IDLE_FRAME_MS = 95; // minimum gap between two frames when idle (~10/s)
let lastAction = performance.now();
const THROTTLED = () => performance.now() - lastAction > (window.CM_IDLE_MS || 60000);
const wakers = new Set();
['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => {
  const idle = THROTTLED();
  lastAction = performance.now();
  if (idle) wakers.forEach((f) => f());
}, { passive: true, capture: true }));
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
const CLOUD_GLITTER = 165; // glitter particles (2026-10-02: was 110, +50 % at the owner's request); few, not self-luminous
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
/** With many topics/bundles every group is a core of its own; the project cores would float between the shells. */
const groupCoresOf = (model) => !!(model?.many && (model.mode === 'topics' || model.mode === 'relations'));
function cloudSupports(model) {
  const st = [{ x: 0, y: -0.03, z: 0.02, r: 0.2 }];
  // Project cores only where they are drawn (topics/relations with many groups: every group is a core).
  if (!groupCoresOf(model)) (model?.shards || []).forEach((s) => s.center && st.push({ ...s.center, r: 0.13 }));
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
  if (!groupCoresOf(model)) (model?.shards || []).forEach((s) => s.center && l.push({ ...s.center, colour: s.color, power: 0.9 }));
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
    uniforms = (extraUniforms = {}) => ({
      uTime: clock.uTime, alpha: { value: 0.15 }, uCloudCenter: { value: v(shape.center.x, shape.center.y, shape.center.z) },
      uFog: { value: v(shape.fog.x, shape.fog.y, shape.fog.z) }, uLight, uLightColour, ...extraUniforms,
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
  const COUNT = CLOUD_GLITTER;
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
  glitter.userData.glitter = true; // cortexAlpha dims the fog in focus, never the glitter (same brightness in every view)
  add(glitter);
  return shape;
}


// Atlas labels carry at most five words and 34 characters (a relation bundle is
// named after its hub's title, which can be a whole paragraph); the full name
// stays in the tooltip and in the breadcrumb.
const labelShort = (t) => { const k = String(t).trim().split(/\s+/).slice(0, 5).join(' '); return k.length > 34 ? k.slice(0, 33) + '…' : k; };
// <labelplace> Collision-free placement of the atlas labels (parity with the
// sibling house 2026-10-01: in a focus the labels of the subgroups piled up).
// A PURE function: rectangles in, offsets out; no DOM read, no state
// (test/board-parity-atlas-cm.test.mjs).
//  cands: [{ key, x, y, w, h, prio, depth, focus, before }] — x/y the anchor on
//         screen, w/h the label size, prio the weight (members), focus = belongs
//         to the focus, before = {dx, dy} of the last placement or null.
//  area:  { w, h, taken: [[l, t, r, b]] } — the drawing area and rectangles already taken.
//  Returns a Map key -> { label: true, dx, dy, moved } | { label: false } (then a small dot).
// Order: focus > weight (with hysteresis: what already stood counts 1.6 times)
// > depth > key. Per label 8 directions on two rings (16 spots); the previous
// spot first. Budget from the area: at most LABEL_PLACE.fill of the area carries
// labels (not a fixed count).
const LABEL_PLACE = { near: 12, far: 20, gap: 4, margin: 5, hysteresis: 1.6, fill: 0.2, anchor: 4, throttle: 120 };
function placeLabels(cands, area, opt = LABEL_PLACE) {
  const out = new Map();
  if (!cands.length) return out;
  const { near, far, gap, margin, hysteresis, fill, anchor } = opt;
  let sum = 0;
  for (const k of cands) sum += (k.w + gap) * (k.h + gap);
  const budget = Math.max(1, Math.floor((fill * area.w * area.h) / (sum / cands.length)));
  const worth = (k) => k.prio * (k.before ? hysteresis : 1);
  const order = [...cands].sort((a, b) => (b.focus ? 1 : 0) - (a.focus ? 1 : 0) || worth(b) - worth(a) || (a.depth || 0) - (b.depth || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const taken = (area.taken || []).map((r) => r.slice());
  // The anchors of all candidates: a label should, where possible, not cover another node.
  const anchors = cands.map((k) => [k.x - anchor, k.y - anchor, k.x + anchor, k.y + anchor, k.key]);
  const hits = (l, t, r, b, q) => l < q[2] + gap && r + gap > q[0] && t < q[3] + gap && b + gap > q[1];
  let count = 0;
  for (const k of order) {
    if (count >= budget) { out.set(k.key, { label: false }); continue; }
    const { w, h } = k;
    const spots = [];
    if (k.before) spots.push([k.before.dx, k.before.dy]);
    // Near ring: 8 directions close to the anchor (bottom right = the old spot first).
    spots.push([near, near], [near, -h - near / 2], [-w - near, near], [-w - near, -h - near / 2], [near, -h / 2], [-w - near, -h / 2], [-w / 2, -h - near], [-w / 2, near]);
    // Far ring: the same 8 directions one label row or column further out (then with a leader line).
    const zy = h + 2 * gap, sx = w + 2 * gap + far - near;
    spots.push([near, near + zy], [near, -h - near / 2 - zy], [-w - near, near + zy], [-w - near, -h - near / 2 - zy], [near + sx, -h / 2], [-w - near - sx, -h / 2], [-w / 2, -h - near - zy], [-w / 2, near + zy]);
    let pick = null;
    for (const strict of [true, false]) {
      for (const [dx, dy] of spots) {
        const l = k.x + dx, t = k.y + dy, r = l + w, b = t + h;
        if (l < margin || t < margin || r > area.w - margin || b > area.h - margin) continue;
        if (taken.some((q) => hits(l, t, r, b, q))) continue;
        if (strict && anchors.some((q) => q[4] !== k.key && hits(l, t, r, b, q))) continue;
        pick = [dx, dy];
        break;
      }
      if (pick) break;
    }
    if (!pick) { out.set(k.key, { label: false }); continue; }
    const [dx, dy] = pick;
    taken.push([k.x + dx, k.y + dy, k.x + dx + w, k.y + dy + h]);
    count++;
    // Moved = further from the anchor than the near ring: then a fine line leads to the node.
    const nx = Math.max(dx, Math.min(0, dx + w)), ny = Math.max(dy, Math.min(0, dy + h));
    out.set(k.key, { label: true, dx, dy, moved: Math.hypot(nx, ny) > near * 1.5 + 2 });
  }
  return out;
}
// </labelplace>
function initGraph() {
  const T = window.MemThree,
    canvas = $('#brain'),
    viewport = canvas.parentElement,
    es = scoped(),
    model = graphModel(es, state.graphMode, atlasContext(state.graphMode)),
    labelLayer = $('#graphLabels'),
    tip = $('#graphHover');
  if (!model.groups.some((g) => g.key === camera.focus)) {
    camera.focus = null;
    camera.cell = null;
  }
  let renderer;
  $('#graphGroups').innerHTML =
    model.groups
      .map((g) => `<button data-action="graph-focus" data-value="${esc(g.key)}" aria-pressed="false" style="--cluster:${g.color}" title="Focus ${esc(g.label)}"><i></i><span>${esc(g.label)}</span><b>${num(countOf(g))}</b></button>`)
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
  let fixedLabelKeys = new Set(), lazyLabels = new Map(), neighbours = new Map(), loops = [], strandNear = false;
  // Atlas labels: the result of the last placement per label, the throttle time, the camera signature.
  let labelPlaced = new Map(), labelTime = -1e9, labelSig = '', labelTimer = 0, labelVersion = 0;
  // One SVG under the labels for the leader lines (created through markup: no
  // namespace address in the source — the dashboard probes hold every URL).
  labelLayer.insertAdjacentHTML('afterbegin', '<svg class="label-lines" aria-hidden="true"></svg>');
  const labelLines = labelLayer.firstElementChild;
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
  // atlas-pass-cm, condensed: a topic carries the mean of its injections (from the server).
  const maxMean = Math.max(1, ...model.groups.map((g) => g.recallMean || 0));
  const meanBright = (x) => (x.recallMean == null ? -1 : x.recallMean <= 0 ? 0.08 : 0.25 + 0.75 * Math.min(1, Math.log2(1 + x.recallMean) / Math.log2(1 + maxMean)));
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
  // Main nodes: with MORE than GROUPS_SHELL_FROM topics/bundles every group is a core (size by
  // weight), since the project cores on their fixed spots would float between the shells. Up
  // to that everything stays as before.
  const groupCores = groupCoresOf(model);
  const shardOrbs = (groupCores ? [] : model.shards).map((s) => {
    const r = state.graphMode === 'storage' || state.graphMode === 'overview' ? 0.078 : 0.047;
    const ring = rings(vec(s.center), s.color, r, world);
    const curve = new T.CubicBezierCurve3(mainPos.clone(), v(s.center.x * 0.15, 0.12, s.center.z * 0.25), v(s.center.x * 0.75, s.center.y + 0.1, s.center.z), vec(s.center));
    path(curve.getPoints(60), s.color, 0.35, world, true);
    hubs.push({ key: s.key, pos: vec(s.center), color: s.color, size: r * 9, bright: brightness(s.members), ring });
    return { ...s, ring };
  });
  const groupOrbs = (groupCores ? model.groups : []).map((g) => {
    const r = g.coreRadius ?? 0.047;
    const ring = g.weightRank < CORE_RINGS_MAX ? rings(vec(g.center), g.color, Math.max(r, 0.03), world) : null;
    hubs.push({ key: g.key, pos: vec(g.center), color: g.color, size: r * 9 * model.sk, bright: model.condensed ? meanBright(g) : brightness(g.members), ring });
    return { key: g.key, ring };
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
    // A new label starts hidden (label-off); only the placement fades it in.
    el.className = 'atlas-label label-off ' + (kind || '');
    el.style.setProperty('--node-color', color);
    el.innerHTML = `<i></i><span>${esc(text)}${small ? `<small>${esc(small)}</small>` : ''}</span>`;
    el.setAttribute('aria-label', 'Focus ' + text + (small ? ' · ' + small : ''));
    el.onclick = () => (key === 'root' ? reset() : key.startsWith('entry:') ? showDetail(key.slice(6), 'content') : focus(key));
    labelLayer.append(el);
    return el;
  }
  const rootLabel = label(coreName(), es.length ? 'Shared core' : 'Shared core · empty', '#d9f3cf', 'root', 'root-label');
  const rootRec = { el: rootLabel, pos: mainPos, key: 'root', prio: 1e9, depth: -1 };
  const shardLabels = shardOrbs.map((s) => ({ el: label(s.label, pluralEntries(countOf(s)), s.color, s.key, 'shard-label'), pos: vec(s.center), key: s.key, prio: countOf(s), depth: 0 }));

  const positions = new Map();
  model.groups.forEach((g) => {
    // With subtopics: only the DIRECT entries of the topic lie around its centre.
    if (g.cells.length && !g.direct) return;
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
    const own = g.cells.length ? g.direct : g.members, n = own.length;
    own.forEach((e, j) => {
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
    lazyLabels.forEach((l) => l.el.remove());
    lazyLabels = new Map();
    labelLines.replaceChildren();
    labelVersion++;
  }
  let coreGeo = null, strandGeo = null, pulseGeo = null;
  function tintHierarchy() {
    const focused = !!camera.focus;
    hubs.forEach((hb, i) => {
      const dim = focused && hb.key !== camera.focus;
      hubDim[i] = dim ? 0.12 : focused && groupCores ? 0.3 : 1;
      hb.ring?.traverse((n) => {
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
    // Scale: in the whole view everything grows with the extent of the net; in a focus (close
    // up) the original sizes hold — otherwise the entries melt into a white area.
    const sk = camera.focus ? 1 : model.sk;
    const chosenCell = currentCell(), activePath = new Set();
    let ancestor = chosenCell;
    while (ancestor) {
      activePath.add(ancestor.key);
      ancestor = cellMap.get(ancestor.parent);
    }
    // Entries around an opened cell: the cell is their centre, its radius the hull.
    const entryUnits = (list, c, g) => list.forEach((e, j) => {
      const n = list.length, y = 1 - (2 * (j + 0.5)) / n, a = j * 2.399963, r = c.radius, q = Math.sqrt(1 - y * y);
      units.push({ key: e.id, e, g, members: [e], pos: vec(c.center).add(v(Math.cos(a) * q * r, y * r, Math.sin(a) * q * r)), radius: r * (c.depth > 0 ? 0.2 : 0.14) });
    });
    function emitCells(cells, g) {
      cells.forEach((c) => {
        if (activePath.has(c.key) && !(state.graphMode === 'overview') && !c.collective) {
          if (c.cells.length) {
            emitCells(c.cells, g);
            if (c.direct) entryUnits(c.direct, c, g);
          } else entryUnits(c.members, c, g);
        } else units.push({ key: c.key, cell: c, g, members: c.members, pos: vec(c.center), radius: c.radius * (c.topic ? 0.55 : c.depth > 0 ? 0.42 : 0.28) });
      });
    }
    model.groups.forEach((g) => {
      if (g.cells.length) {
        emitCells(g.cells, g);
        // The topic's direct entries (in no subtopic) lie around its centre.
        if (g.direct) g.direct.forEach((e) => units.push({ key: e.id, e, g, members: [e], pos: positions.get(e.id), radius: null }));
      } else g.members.forEach((e) => units.push({ key: e.id, e, g, members: [e], pos: positions.get(e.id), radius: g.trail ? (e.id === g.trail.c.id ? 0.07 : 0.042) : null }));
    });
    // Nodes: one point per unit, all in one draw call.
    const n = units.length;
    const P = new Float32Array(n * 3), C = new Float32Array(n * 3), S = new Float32Array(n), B = new Float32Array(n), PH = new Float32Array(n), DT = new Float32Array(n), DM = new Float32Array(n), K = new Float32Array(n);
    units.forEach((u, i) => {
      const selected = !camera.focus || u.g.key === camera.focus;
      const col = new T.Color(u.g.color);
      P.set([u.pos.x, u.pos.y, u.pos.z], i * 3);
      C.set([col.r, col.g, col.b], i * 3);
      const r = u.radius || (u.cell ? 0.065 : 0.034 * (u.g.scale ?? 1));
      u.base = r * 8 * sk;
      S[i] = u.base;
      B[i] = u.cell?.collective ? meanBright(u.cell) : brightness(u.members);
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
    const single = units.filter((u) => !u.cell);
    const withFibres = single.length <= 700 ? single : single.filter((u) => camera.focus && u.g.key === camera.focus);
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
      if (u.cell && !u.cell.collective && (camera.focus === u.g.key || (cells.length <= 16 && !model.many))) {
        const named = u.cell.drawer || u.cell.topic;
        const el = label(named ? labelShort(u.cell.label) : pluralEntries(countOf(u.cell)), u.cell.drawer ? pluralEntries(countOf(u.cell)) + ' · drawer' : u.cell.topic ? pluralEntries(countOf(u.cell)) + ' · subtopic' : 'Subgroup', u.g.color, u.cell.key, 'cell-label');
        labels.push({ el, pos: u.pos, key: u.key, parent: u.g.key, prio: countOf(u.cell), depth: (u.cell.depth || 0) + 1, cell: u.cell });
      }
      if (u.e && u.g.trail) {
        const dir = u.e.id === u.g.trail.c.id ? 'Middle' : u.g.trail.out.some((x) => x.e.id === u.e.id) ? 'points to →' : '← points here';
        const el = label(u.e.title.split(/\s+/).slice(0, 5).join(' '), dir, u.g.color, 'entry:' + u.e.id, u.e.id === u.g.trail.c.id ? 'root-label' : 'cell-label');
        labels.push({ el, pos: u.pos, key: u.key, parent: u.g.key, prio: u.e.id === u.g.trail.c.id ? 1e6 : 1, depth: 1 });
      }
    });
    // Label tiers: with many main nodes only the heaviest carry a label permanently; any other
    // group gets one once its sphere is large enough on screen (zooming in, labelCandidates),
    // in a focus and on hover (the tooltip). Up to GROUPS_SHELL_FROM groups every one has its label.
    fixedLabelKeys = new Set();
    if (state.graphMode !== 'storage' && state.graphMode !== 'overview' && state.graphMode !== 'trail') {
      const fixed = model.many ? [...model.groups].sort((a, b) => b.weight - a.weight || model.groups.indexOf(a) - model.groups.indexOf(b)).slice(0, LABEL_GROUPS_FIXED) : model.groups;
      fixed.forEach((g) => labels.push(groupLabel(g)));
      fixed.forEach((g) => fixedLabelKeys.add(g.key));
    }

    // Edges: bundled per endpoint pair as in the mockup — here every
    // bundle in ONE geometry set (tubes + arrow heads; dashed pieces for derived ones).
    const endpoint = new Map();
    units.forEach((u) => u.members.forEach((e) => endpoint.set(e.id, u)));
    const bundles = new Map();
    const sourceEdges = state.graphMode === 'overview' ? overviewEdges(units) : model.condensed && state.graphMode === 'topics' ? [...topicEdges(units), ...model.edges] : model.edges;
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
      const alpha = edgeBaseAlpha({ a, b, count });
      // The third kind: a bundle of ONLY derived links is drawn DASHED — short tube pieces with
      // gaps, no arrow head. Mixed bundles stay solid: they carry at least one stored relation.
      const dashed = edges.length > 0 && edges.every((x) => x.kind === 'derived');
      const tubeR = (0.0018 + Math.min(0.0042, Math.log2(count + 1) * 0.0006)) * sk * (model.tiered ? 1.7 : 1);
      let geos;
      if (dashed) {
        geos = [];
        const DASHES = 9;
        for (let q = 0; q < DASHES; q++) {
          const t0 = (q + 0.1) / DASHES, t1 = (q + 0.62) / DASHES;
          geos.push(new T.TubeGeometry(new T.CatmullRomCurve3([0, 1, 2, 3].map((k) => curve.getPoint(t0 + ((t1 - t0) * k) / 3))), 4, tubeR * 0.85, 4, false));
        }
      } else {
        const tube = new T.TubeGeometry(curve, 34, tubeR, 5, false);
        const cone = new T.ConeGeometry(0.008 * sk, 0.03 * sk, 5);
        tmp.quaternion.setFromUnitVectors(v(0, 1, 0), curve.getTangent(0.8).normalize());
        cone.applyQuaternion(tmp.quaternion);
        const p8 = curve.getPoint(0.8);
        cone.translate(p8.x, p8.y, p8.z);
        geos = [tube, cone];
      }
      const start = base;
      for (const geo of geos) {
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
      // pts: fixed support points per strand (14 segments); projected only on demand (hover/click).
      edgeVisuals.push({ a, b, edges, curve, from: start, to: base, count, dashed, pts: curve.getPoints(14) });
      if (i < 180 && !dashed) pulses.push({ curve, phase: (i * 0.173) % 1, color });
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
    // Neighbourhood of the units (from the strands): on hover bright, the rest dimmed.
    neighbours = new Map();
    for (const e of edgeVisuals) {
      if (e.a.key === e.b.key) continue;
      if (!neighbours.has(e.a.key)) neighbours.set(e.a.key, new Set());
      if (!neighbours.has(e.b.key)) neighbours.set(e.b.key, new Set());
      neighbours.get(e.a.key).add(e.b.key);
      neighbours.get(e.b.key).add(e.a.key);
    }
    // Loops (cycles of stored links): a closed golden path through the units of their entries.
    loops = [];
    model.cycles.slice(0, CYCLES_DRAWN_MAX).forEach((ids) => {
      const us = ids.map((id) => endpoint.get(id)).filter(Boolean);
      const pts = [];
      for (const u of us) if (!pts.length || pts[pts.length - 1].key !== u.key) pts.push({ key: u.key, p: u.pos.clone() });
      while (pts.length > 1 && pts[0].key === pts[pts.length - 1].key) pts.pop();
      const members = new Set(ids);
      if (pts.length < 2) { loops.push({ ids, members, mesh: null }); return; }
      let points = pts.map((x) => x.p);
      if (points.length === 2) {
        // Two ends: an oval instead of a line.
        const m = points[0].clone().add(points[1]).multiplyScalar(0.5), d = points[1].clone().sub(points[0]);
        const q = v(-d.y, d.x, d.z * 0.3 + 0.02).normalize().multiplyScalar(0.18 * d.length() + 0.012);
        points = [points[0], m.clone().add(q), points[1], m.clone().sub(q)];
      }
      const geo = own(new T.TubeGeometry(new T.CatmullRomCurve3(points, true, 'centripetal'), Math.max(28, points.length * 14), 0.0034 * sk, 5, true));
      const mat = own(new T.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.34, depthWrite: false }));
      const mesh = new T.Mesh(geo, mat);
      mesh.frustumCulled = false;
      dynamic.add(mesh);
      loops.push({ ids, members, mesh, mat });
    });
    setLoopAlpha();
    // Wandering points of light: ONE point set, positions anew per frame.
    if (pulses.length) {
      pulseGeo = own(new T.BufferGeometry());
      const PC = [], PS = [], PB = [], PPh = [], PD = [], PDm = [], PK = [];
      pulses.forEach((p) => {
        PC.push(p.color.r, p.color.g, p.color.b);
        PS.push(0.007 * 8 * sk);
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
    canvas.dataset.cycles = String(model.cycles.length);
    canvas.dataset.cyclesDrawn = String(loops.filter((x) => x.mesh).length);
    canvas.dataset.edgeDashed = edgeVisuals.filter((e) => e.dashed).length;
    canvas.dataset.mainNodes = model.groups.length;
    canvas.dataset.shardCores = model.shards.length;
    canvas.dataset.units = units.length;
    canvas.dataset.memoryCores = '1';
    canvas.dataset.superCore = '1';
    canvas.dataset.renderer = 'webgl-3d';
  }
  // atlas-pass-cm, condensed: topic pairs (entries that carry both; counted by the server) as
  // bundles between the collecting nodes — an aggregation, not a single edge.
  function topicEdges(us) {
    const byTheme = new Map(us.filter((u) => u.cell?.collective).map((u) => [u.g.condensed?.value, u]));
    return (D.atlas?.edges || [])
      .map((k) => ({ a: byTheme.get(k.from), b: byTheme.get(k.to), count: k.count, list: [] }))
      .filter((x) => x.a && x.b);
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
    // Far (whole view): single edges inside a group are quiet, bundled strands and all across
    // group borders loud; close up: all equally loud. Nothing disappears, nothing is invented.
    if (!camera.focus) return model.many && !strandNear && e.a.g.key === e.b.g.key && e.count < 2 ? 0.24 : 0.56;
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
    setLoopAlpha();
  }
  // Loops: a quiet golden path; in a focus (group, cell) or on hover over an entry the ones
  // touching it glow, the others step back.
  function setLoopAlpha() {
    const cell = currentCell();
    const touches = (sl) => {
      if (hoverId && sl.members.has(hoverId)) return true;
      if (cell) return cell.members.some((m) => sl.members.has(m.id));
      if (camera.focus) return [...sl.members].some((id) => model.assignment.get(id)?.key === camera.focus);
      return false;
    };
    const focused = !!(hoverId || camera.focus);
    for (const sl of loops) if (sl.mat) sl.mat.opacity = !focused ? 0.34 : touches(sl) ? 0.98 : 0.07;
  }
  function updateUI() {
    camera.zoom = baseDistance / distance;
    $('#graphZoom').value = Math.round(camera.zoom * 100) + '%';
    if ((camera.zoom >= STRAND_NEAR_ZOOM) !== strandNear) { strandNear = camera.zoom >= STRAND_NEAR_ZOOM; setEdgeAlpha(); }
    const g = model.groups.find((g) => g.key === camera.focus), c = currentCell();
    const crumbText = coreSlug() + ' / ' + (g ? g.label + (c ? ' / ' + c.label : '') : state.graphMode === 'trail' ? 'Evidence trail' : 'all projects');
    const crumb = $('#graphBreadcrumb');
    if (crumb && crumb.textContent !== crumbText) { crumb.textContent = crumbText; clampCrumb(crumb); }
    $('.atlas-back').hidden = !camera.focus;
    $$('#graphGroups button').forEach((el) => el.setAttribute('aria-pressed', el.dataset.value === camera.focus));
    if (model.condensed) {
      const at = D.atlas;
      $('#graphEdgeCount').textContent = (state.graphMode === 'topics'
        ? num(model.groups.length) + ' of ' + num(at.themesTotal) + ' topics · ' + num(edgeVisuals.reduce((k, e) => k + e.count, 0)) + ' shared entries between topics'
        : num(model.groups.length) + (state.graphMode === 'structure' ? ' entry types' : ' projects') + ' · ' + num(model.cells.size) + ' drawers') + (model.edges.length ? ' · ' + num(model.edges.length) + ' relations loaded' : '') + ' · condensed';
      canvas.dataset.focus = camera.cell || camera.focus || '';
      canvas.dataset.condensed = '1';
      return;
    }
    const derivedN = state.graphMode === 'overview' ? 0 : model.derivedCount;
    const n = state.graphMode === 'overview' ? edgeVisuals.reduce((k, e) => k + e.count, 0) : model.edges.length - derivedN;
    const loopsN = model.cycles.length;
    const where = groupCores ? num(model.tiered ? model.topicsTotal : model.groups.length) + (state.graphMode === 'topics' ? ' topics' : ' bundles') + (model.tiered ? ' (' + num(model.groups.length) + ' main)' : '') : num(model.shards.length) + ' projects';
    $('#graphEdgeCount').textContent = num(n) + ' relations' + (derivedN ? ' + ' + num(derivedN) + ' derived (dashed)' : '') + (loopsN ? ' · ' + num(loopsN) + (loopsN === 1 ? ' loop' : ' loops') : '') + ' · ' + where + ' · 1 memory';
    canvas.dataset.focus = camera.cell || camera.focus || '';
  }
  // The breadcrumb in a focus (a bundle is named after its hub's title, which
  // can be a whole paragraph): at most two lines, then "more". Measured once
  // per text change, never per frame.
  function clampCrumb(crumb) {
    const line = crumb.parentElement;
    let more = line.querySelector('.crumb-more');
    if (!more) {
      more = document.createElement('button');
      more.type = 'button';
      more.className = 'crumb-more';
      more.onclick = () => { const opened = line.classList.toggle('crumb-open'); more.textContent = opened ? 'less' : 'more'; more.setAttribute('aria-expanded', String(opened)); };
      crumb.after(more);
    }
    line.classList.remove('crumb-open');
    more.textContent = 'more';
    more.setAttribute('aria-expanded', 'false');
    more.hidden = true;
    requestAnimationFrame(() => { if (!dead) more.hidden = crumb.scrollHeight <= crumb.clientHeight + 1; });
  }
  const _p = new T.Vector3();
  function toScreen(p) {
    const q = _p.copy(p).project(cam);
    return { x: ((q.x + 1) * w) / 2, y: ((1 - q.y) * h) / 2, z: q.z, visible: q.z > -1 && q.z < 1 && q.x > -1.1 && q.x < 1.1 && q.y > -1.1 && q.y < 1.1 };
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
    // Labels: the placement does NOT run per frame, only when camera, area,
    // focus or the labels changed — throttled to LABEL_PLACE.throttle ms, with
    // a trailing run so the last state after a movement is surely placed. Per
    // frame only the anchors are projected (arithmetic) and offsets written
    // (no DOM read).
    const sig = [angle, tilt, distance, look.x, look.y, look.z].map((x) => x.toFixed(4)).join('|') + '|' + [w, h, camera.focus, camera.cell, state.graphMode, labelVersion].join('|');
    if (sig !== labelSig) {
      const nowMs = performance.now(), rebuilt = !labelSig.endsWith('|' + labelVersion);
      if (rebuilt || nowMs - labelTime >= LABEL_PLACE.throttle) {
        labelSig = sig;
        labelTime = nowMs;
        placeAllLabels();
      } else if (!labelTimer) {
        labelTimer = setTimeout(() => { labelTimer = 0; if (!dead) refreshProjected(); }, LABEL_PLACE.throttle - (nowMs - labelTime) + 5);
      }
    }
    applyLabels();
  }
  // Which labels are candidates right now (the same rules as before), with weight, depth and focus priority.
  function labelCandidates() {
    const list = [], focusCell = camera.cell;
    const inFocus = (l) => !!focusCell && !!l.cell && l.cell.key !== focusCell && (l.cell.parent === focusCell || String(l.cell.key).startsWith(focusCell + ':'));
    if (!camera.focus && state.graphMode !== 'trail') list.push({ rec: rootRec, focus: true });
    if ((state.graphMode === 'storage' || state.graphMode === 'overview') && !camera.focus) for (const s of shardLabels) list.push({ rec: s, focus: false });
    for (const l of labels) {
      if ((!camera.focus || camera.focus === l.parent) && l.key !== camera.cell) list.push({ rec: l, focus: inFocus(l) || (!!camera.focus && l.key === camera.focus) });
    }
    // Many main nodes: further group labels once their sphere is large enough on screen
    // (zooming in), created once and kept; the placement decides who stands.
    if (model.many && !camera.focus && state.graphMode !== 'trail' && state.graphMode !== 'storage' && state.graphMode !== 'overview') {
      const more = groupHits.filter((g) => !fixedLabelKeys.has(g.key) && g.visible && (g.r - 16) * 2 >= LABEL_MIN_PX).sort((a, b) => b.r - a.r).slice(0, LABEL_GROUPS_EXTRA);
      for (const hit of more) {
        let l = lazyLabels.get(hit.key);
        if (!l) {
          l = groupLabel(model.groups.find((x) => x.key === hit.key));
          lazyLabels.set(hit.key, l);
        }
        list.push({ rec: l, focus: false });
      }
    }
    return list;
  }
  // A group's label: the short form (a bundle is named after its hub's title, which can be a
  // paragraph); the full name is in the breadcrumb and the tooltip.
  function groupLabel(g) {
    const el = label(labelShort(g.label), pluralEntries(countOf(g)), g.color, g.key);
    if (labelShort(g.label) !== g.label) el.title = g.label;
    return { el, pos: vec(g.center).add(v(0, model.many ? g.radius + 0.03 : 0.13, 0)), key: g.key, parent: g.key, prio: countOf(g), depth: 0 };
  }
  // Label sizes: measured once per label, batched (write every class first,
  // then read every size, then back) — never per frame. After a resize of the
  // area they are measured again.
  function measureLabels(recs) {
    const todo = recs.filter((r) => !r.size && r.el.isConnected);
    if (!todo.length) return;
    const dots = todo.filter((r) => r.el.classList.contains('label-dot'));
    dots.forEach((r) => r.el.classList.remove('label-dot'));
    for (const r of todo) { const bw = r.el.offsetWidth, bh = r.el.offsetHeight; if (bw && bh) r.size = { w: bw, h: bh }; }
    dots.forEach((r) => r.el.classList.add('label-dot'));
  }
  function placeAllLabels() {
    const cands = labelCandidates();
    measureLabels(cands.map((k) => k.rec));
    // Invisible anchors drop out before the placement.
    const input = [];
    for (const k of cands) {
      const r = k.rec, q = toScreen(r.pos);
      if (!q.visible) continue;
      const g = r.size || { w: 110, h: 30 };
      const prev = labelPlaced.get(r.el);
      input.push({ key: r.el, x: q.x, y: q.y, w: g.w, h: g.h, prio: r.prio ?? 1, depth: r.depth ?? 1, focus: k.focus, before: prev && prev.label ? { dx: prev.dx, dy: prev.dy } : null, rec: r });
    }
    // The key is the element itself (unique, even when two labels share a key).
    const result = placeLabels(input, { w, h, taken: [] });
    const next = new Map();
    for (const x of input) next.set(x.rec.el, { ...result.get(x.key), rec: x.rec });
    labelPlaced = next;
    let n = 0;
    for (const [el, st] of next) if (st.label && el !== rootLabel && !el.classList.contains('cell-label') && !el.classList.contains('shard-label')) n++;
    canvas.dataset.groupLabels = String(n);
  }
  // Per frame: only write the offset (transform); state classes only on a change.
  function allLabelRecs() { return [rootRec, ...shardLabels, ...labels, ...lazyLabels.values()]; }
  function applyLabels() {
    for (const r of allLabelRecs()) {
      const st = labelPlaced.get(r.el);
      let mode = 'off', x = 0, y = 0;
      if (st) {
        const q = toScreen(r.pos);
        if (q.visible) {
          mode = st.label ? 'label' : 'dot';
          x = st.label ? q.x + st.dx : q.x + 3;
          y = st.label ? q.y + st.dy : q.y - 11;
          if (st.label && st.moved) leaderLine(r, q.x, q.y, x, y);
          else lineOff(r);
        }
      }
      if (mode === 'off') lineOff(r);
      if (r.mode !== mode) {
        r.el.classList.toggle('label-off', mode === 'off');
        r.el.classList.toggle('label-dot', mode === 'dot');
        r.mode = mode;
      }
      if (mode !== 'off' && (Math.abs((r.tx ?? -1e9) - x) >= 0.5 || Math.abs((r.ty ?? -1e9) - y) >= 0.5)) {
        r.tx = x; r.ty = y;
        r.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      }
    }
  }
  // Leader line from the node to the nearest point of the moved label.
  function leaderLine(r, ax, ay, l, t) {
    const g = r.size || { w: 110, h: 30 };
    const bx = Math.max(l, Math.min(ax, l + g.w)), by = Math.max(t, Math.min(ay, t + g.h));
    if (!r.line || !r.line.isConnected) {
      r.lineAt = '';
      r.line = document.createElementNS(labelLines.namespaceURI, 'line');
      r.line.setAttribute('stroke', r.el.style.getPropertyValue('--node-color') || '#9fc7b5');
      labelLines.append(r.line);
    }
    // Only write what changed (a still camera: no writing, no repaint).
    const k = ax.toFixed(1) + ',' + ay.toFixed(1) + ',' + bx.toFixed(1) + ',' + by.toFixed(1);
    if (r.lineAt !== k) {
      const [x1, y1, x2, y2] = k.split(',');
      r.line.setAttribute('x1', x1); r.line.setAttribute('y1', y1);
      r.line.setAttribute('x2', x2); r.line.setAttribute('y2', y2);
      if (!r.lineAt) r.line.style.display = '';
      r.lineAt = k;
    }
  }
  function lineOff(r) {
    if (r.line && r.lineAt) { r.line.style.display = 'none'; r.lineAt = ''; }
  }
  function draw(now = performance.now(), force = false) {
    if (dead) return;
    // Resting (no drag, no hover, no flight): the network turns only slowly
    // (0.027 rad/s) — 20 frames/s are enough. After 60 s without input only
    // ~10 frames/s (also with a pointer parked over a node).
    const idle = THROTTLED();
    if (!force && !transition && (idle || (!pointers.size && !hoverId && !hoverGroup)) && now - last < (idle ? IDLE_FRAME_MS : 45)) {
      if (((state.motion && onScreen) || transition) && !RESTING()) frame = requestAnimationFrame(draw);
      return;
    }
    const dt = Math.min(idle ? 0.2 : 0.05, (now - last) / 1000 || 0.016);
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
      groupOrbs.forEach((g, i) => { if (g.ring) g.ring.rotation.y = time * 0.1 + i; });
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
    if (((state.motion && onScreen) || transition) && !RESTING()) frame = requestAnimationFrame(draw);
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
      if (o.material?.uniforms?.alpha) o.material.uniforms.alpha.value = focused && !o.userData.glitter ? 0.055 : 0.15;
      else if (o.material) {
        if (o.userData.normalOpacity === undefined) o.userData.normalOpacity = o.material.opacity;
        o.material.opacity = focused ? o.userData.normalOpacity * 0.4 : o.userData.normalOpacity;
      }
    });
  }
  function focus(key) {
    let cell = cellMap.get(key);
    const g = model.groups.find((g) => g.key === (cell?.group || key));
    if (!g) return;
    // The collecting node of a condensed topic IS the topic.
    if (cell?.collective) cell = null;
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
    // With subtopics the whole bloom counts: the flight aims at the enclosing sphere of topic and subtopics.
    const hh = cell && cell.topic ? hullOf(cell.center, cell.radius, cell.cells) : !cell && g.hull ? g.hull : null;
    const radius = hh ? Math.max(hh.r, cell ? cell.radius : g.radius) * 1.15 + 0.06 : cell ? cell.radius * 1.65 : g.radius + 0.13, dist = (radius / (Math.tan((cam.fov * Math.PI) / 360) * Math.min(1, w / h))) * 1.2;
    fly(vec(hh || cell?.center || g.center), Math.max(0.1, dist), cell ? angle : g.center.x < 0 ? -0.32 : 0.32, 0.18);
    if (state.tab === 'network') refreshEntryList();
    // atlas-pass-cm, condensed: zooming in loads the first page of the topic or drawer.
    const target = model.condensed ? atlasTarget(g, cell) : null;
    if (target && !atlasPageOf(target.kind, target.value)) atlasLoad(target.kind, target.value);
    atlasStateShow();
  }
  function reset() {
    camera.focus = null;
    camera.cell = null;
    camera.panX = camera.panY = 0;
    createUnits();
    cortexAlpha(false);
    fly(center, baseDistance, 0.47, 0.4);
    if (state.tab === 'network') refreshEntryList();
    atlasStateShow();
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
    const strand = pickStrand(p);
    if (strand) return { strand };
    const g = groupHits.filter((g) => g.visible && Math.hypot(g.x - p.x, g.y - p.y) < g.r).sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
    return { g };
  }
  // A strand under the pointer: the nearest in screen space, at most 7 px away. Projected only
  // on demand (hover/click), never per frame.
  function pickStrand(p) {
    let best = null, bd = 7;
    for (const e of edgeVisuals) {
      if (camera.focus && e.a.g.key !== camera.focus && e.b.g.key !== camera.focus) continue;
      let prev = null;
      for (const q of e.pts) {
        const c = toScreen(q);
        if (prev && c.visible) {
          const dx = c.x - prev.x, dy = c.y - prev.y, l2 = dx * dx + dy * dy;
          const t = l2 ? Math.max(0, Math.min(1, ((p.x - prev.x) * dx + (p.y - prev.y) * dy) / l2)) : 0;
          const d = Math.hypot(p.x - (prev.x + t * dx), p.y - (prev.y + t * dy));
          if (d < bd) { bd = d; best = e; }
        }
        prev = c.visible ? { x: c.x, y: c.y } : null;
      }
    }
    return best;
  }
  // The evidence of every edge in a strand: where it stands (stored) or why the system guesses it (derived).
  function strandHtml(e) {
    return e.edges.slice(0, 40).map((k) => `<div class="row"><div class="row-main"><div><span class="badge ${k.kind === 'derived' ? 'warn' : ''}">${esc(edgeLabels[k.kind] || k.kind)}</span> ${open(k.from, short(byId(k.from)?.title || k.from), 'open-entry textlink')} <span class="quiet">→</span> ${open(k.to, short(byId(k.to)?.title || k.to), 'open-entry textlink')}<p class="small muted">Source: ${esc(edgeEvidence(k))}</p></div></div></div>`).join('')
      + (e.edges.length > 40 ? `<p class="small quiet">${num(e.edges.length)} edges, 40 shown.</p>` : '');
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
    setNeighbours(i);
  }
  // Hover over a unit: it and its neighbours (over real strands) stay bright, the rest steps back.
  function setNeighbours(i) {
    const A = coreGeo.attributes.aDim, nb = i >= 0 ? neighbours.get(units[i].key) : null;
    units.forEach((u, j) => {
      const base = !camera.focus || u.g.key === camera.focus ? 1 : 0.14;
      A.array[j] = nb && j !== i && !nb.has(u.key) ? base * 0.35 : base;
    });
    A.needsUpdate = true;
  }
  function hoverAt(p) {
    const { node, g, index, strand } = pick(p);
    hoverId = node?.e?.id || null;
    hoverGroup = node?.g?.key || g?.key || null;
    canvas.style.cursor = node || g || strand ? 'pointer' : 'grab';
    tip.hidden = !node && !g && !strand;
    if (node?.e) {
      const e = node.e;
      const rc = e.recall ? (e.recall.sessions ? `injected in ${num(e.recall.sessions)} sessions` : 'never injected') : 'injection not measurable';
      tip.innerHTML = `<span class="flag-kicker">${esc(types[e.type] || e.type)} · ${esc(drawerOf(e).toUpperCase())}</span><strong>${esc(short(e.title))}</strong><span class="flag-log">Entry ${esc(e.id)} · ${esc(e.source)}</span><span class="flag-author">${esc(e.agent)} · ${rc} · ${camera.focus || node.g.trail ? 'Click: open' : 'Click: focus the group'}</span>`;
    } else if (node?.cell) {
      tip.innerHTML = `<span class="flag-kicker">${node.cell.drawer ? 'DRAWER · ' + esc(node.cell.drawer.toUpperCase()) : node.cell.topic ? 'SUBTOPIC · ' + esc(labelShort(node.cell.label).toUpperCase()) : 'SUBGROUP'}</span><strong>${pluralEntries(countOf(node.cell))}</strong><span>Left click: ${state.graphMode === 'overview' ? 'open the drawer' : node.cell.condensed || node.cell.collective ? 'load the entries' : 'next level of detail'}</span>`;
    } else if (strand && !strand.edges.length) {
      // An aggregated bundle (drawer pair / topic pair): only the number, no single edge.
      tip.innerHTML = `<span class="flag-kicker">${state.graphMode === 'topics' ? 'TOPIC PAIR · SHARED ENTRIES' : 'DRAWER PAIR'}</span><strong>${num(strand.count)}</strong><span>${esc(short(strand.a.g.label))} ↔ ${esc(short(strand.b.g.label))}</span>`;
    } else if (strand) {
      const kinds = [...new Set(strand.edges.map((k) => edgeLabels[k.kind] || k.kind))];
      const k0 = strand.edges[0];
      tip.innerHTML = `<span class="flag-kicker">${strand.dashed ? 'DERIVED · A GUESS' : 'RELATION · ' + esc(kinds.join(', ').toUpperCase())}</span><strong>${num(strand.edges.length)} ${strand.edges.length === 1 ? 'edge' : 'edges'}</strong><span class="flag-log">${esc(short(byId(k0.from)?.title || k0.from))} → ${esc(short(byId(k0.to)?.title || k0.to))}</span><span>Source: ${esc(edgeEvidence(k0))}</span><span class="flag-author">Click: every source</span>`;
    } else if (g)
      tip.innerHTML = `<span class="flag-kicker">${state.graphMode === 'storage' || state.graphMode === 'overview' ? 'PROJECT · STORAGE' : 'KNOWLEDGE GROUP'}</span><strong>${esc(short(g.label))}</strong><span>${pluralEntries(countOf(g))} · left click to fly in</span>`;
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
      const { node, g, strand } = pick(p);
      if (strand) showInfo(esc('Connection · ' + num(strand.edges.length) + (strand.edges.length === 1 ? ' relation' : ' relations')), `<p class="muted small">Every shown edge has its evidence: a stored one stands in the named line, a derived one carries its reason (shared file, shared rare terms).</p>${strandHtml(strand)}`);
      else if (node?.cell) focus(node.cell.key);
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
    // Label sizes depend on the width (narrow view: smaller type) — measure and place again.
    for (const x of allLabelRecs()) x.size = null;
    labelVersion++;
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
  document.addEventListener('close', redraw, true);
  wakers.add(redraw);
  graphAPI = {
    zoom, reset, focus, redraw, model,
    inspect: () => ({
      points: units.map((u, i) => ({ id: u.e?.id, key: u.key, group: u.g.key, cell: u.cell?.key || null, x: screenX[i], y: screenY[i], z: screenZ[i], visible: !!screenV[i], bright: coreGeo?.attributes.aBright.array[i], pos: { x: u.pos.x, y: u.pos.y, z: u.pos.z }, dim: coreGeo?.attributes.aDim.array[i] })),
      core: { x: mainPos.x, y: mainPos.y, z: mainPos.z },
      cycles: model.cycles.map((ids) => { const sl = loops.find((x) => x.ids === ids); return { ids, drawn: !!sl?.mesh, alpha: sl?.mat ? sl.mat.opacity : null }; }),
      groups: groupHits.map((g) => ({ key: g.key, x: g.x, y: g.y, r: g.r })),
      edgeCount: model.edges.length,
      mainNodes: model.groups.length,
      strands: edgeVisuals.map((e) => {
        const m = toScreen(e.pts[7]);
        return { count: e.count, from: e.a.key, to: e.b.key, dashed: !!e.dashed, x: m.x, y: m.y, visible: m.visible, path: e.pts.map((q) => { const c = toScreen(q); return [c.x, c.y, c.visible]; }), edges: e.edges.map((k) => ({ from: k.from, to: k.to, kind: k.kind, source: edgeEvidence(k) })) };
      }),
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
    clearTimeout(labelTimer);
    observer.disconnect();
    visibility.disconnect();
    document.removeEventListener('visibilitychange', redraw);
    document.removeEventListener('close', redraw, true);
    wakers.delete(redraw);
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
  const head = `<div class="drawer-head"><div class="top"><span class="label">${esc(types[e.type])} / ${esc(id)}</span><button class="iconbtn" data-close="detail" aria-label="Close the detail">✕</button></div><h2 id="detailTitle">${esc(e.title)}</h2>${ruleTag(e.ruleStatus)}<div class="small quiet">${esc(e.project)} · ${esc(e.agent)} · ${esc(e.source)}</div></div><nav class="tabs" aria-label="Entry details">${[['content', 'Content'], ['evidence', 'Evidence trail'], ['history', 'History'], ['raw', 'Raw fields']]
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
let infoStamp = 0; // counts every refill of the dialog (run-helper-cm: selection of a late message run)
function showInfo(title, body) {
  infoStamp += 1;
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
    const restoring = kind === 'restore';
    showInfo(
      restoring ? 'Restore an entry' : 'Merge entries',
      `<p class="muted small">${esc(e.title)}</p><p class="small">${restoring
        ? 'Takes a closed entry up again as a NEW line with <code class="mono">restored_from</code>; the original and its tombstone stay untouched.'
        : 'Merges entries of ONE drawer: a correction of the first carries the joined content and <code class="mono">merged_from</code>; the others get an obsolete tombstone. Nothing is deleted.'}</p><form id="statusForm" data-id="${esc(id)}" data-kind="${kind}" style="margin-top:20px">${restoring ? '' : '<label class="formfield">Other entry ids (comma separated, same drawer)<input name="others" class="field" required maxlength="1000"></label>'}<label class="formfield">Reason<input name="reason" class="field" maxlength="2000"></label><button class="btn primary" type="submit" ${state.readonly ? 'disabled' : ''}>Append</button></form><div id="statusState"></div>${state.readonly ? `<p>${readonlyMark(restoring ? `mem restore ${id} --why "…"` : `mem merge ${id} <other-id> --why "…"`)}</p>` : ''}${note(`Runs as a task through POST /task (the same command as on the CLI: mem ${kind}). Only appended — nothing is deleted. ${restoring ? 'Refused when the entry is not closed, is superseded (use the newer version) or is already restored.' : 'Refused across drawers and for entries that no longer hold.'}`)}`,
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
  fulltextAsk(fulltextPalette);
  renderSearch('');
  $('#commandInput').focus();
}
// The full-text answer for the quick search arrived: redraw only, do not ask again.
function redrawPalette() {
  const input = $('#commandInput');
  if (!input || !$('#command').open) return;
  const old = $('#commandMemory')?.innerHTML;
  renderSearch(input.value, { redrawOnly: true });
  const target = $('#commandMemory');
  if (old && target) {
    target.innerHTML = old;
    // What the full-text answer now shows above is not repeated in the ranked search.
    const above = new Set([...$('#commandResults').querySelectorAll(':scope > [data-search-entry]')].map((x) => x.dataset.searchEntry));
    target.querySelectorAll('[data-search-entry]').forEach((x) => { if (above.has(x.dataset.searchEntry)) x.remove(); });
    if (!target.querySelector('[data-search-entry]')) target.innerHTML = '';
  }
}
function renderSearch(q, { redrawOnly = false } = {}) {
  q = q.toLowerCase().trim();
  const es = (q ? scoped().filter((e) => e._s.includes(q) || fulltextHits(e.id, fulltextPalette)) : scoped()).slice(0, 12),
    routes = Object.entries(sections)
      .flatMap(([a, s]) => [[a, s.name], ...s.tabs.map(([t, n]) => [a + '/' + t, n])])
      .filter((x) => q && x[1].toLowerCase().includes(q)),
    ms = q ? messages.filter((m) => (m.subject + ' ' + m.from + ' ' + m.to).toLowerCase().includes(q)).slice(0, 6) : [],
    rs = q ? rawSamples.filter((r) => (r.path + ' ' + (r.topics || []).join(' ')).toLowerCase().includes(q)).slice(0, 4) : [];
  $('#commandResults').innerHTML = `${state.missing ? note('Not every source was readable. The hits are incomplete.', 'bad') : ''}${fulltextNotice(fulltextPalette) ? `<p class="small quiet" id="fulltextNoticePalette" role="status" title="${esc(fulltextPalette.reason || '')}">Full text unavailable – searching excerpts only</p>` : ''}${routes.map(([p, n]) => `<button class="result" data-search-route="${p}"><span>↗</span><div>${esc(n)}<small>Open the view</small></div></button>`).join('')}${ms.map((m) => `<button class="result" data-action="message" data-id="${esc(m.name)}"><span>⇄</span><div>${esc(m.subject)}<small>Message · ${esc(m.from)} → ${esc(m.to)} · ${esc(situationWord[m.situation] || m.situation)}</small></div></button>`).join('')}${rs.map((r) => `<button class="result" data-action="raw-review" data-id="${esc(r.path)}"><span>▧</span><div>${esc(r.session || r.path)}<small>Raw capture · ${esc((r.topics || []).slice(0, 3).join(', ') || 'no topic')}</small></div></button>`).join('')}${es.map((e) => `<button class="result" data-search-entry="${esc(e.id)}"><span class="entry-icon">${esc((types[e.type] || '?')[0])}</span><div>${esc(e.title)}${ruleTag(e.ruleStatus)}<small>${esc(types[e.type])} · ${esc(e.project)} · ${esc(e.id)}</small></div></button>`).join('')}${!es.length && !routes.length && !ms.length && !rs.length ? empty(entries.length ? 'Nothing found.' : 'Nothing found — this memory holds no entry yet.') : ''}<div id="commandMemory"></div>`;
  // The same search as "mem find" (BM25/synonyms), through the existing
  // read-only endpoint /entries.json — the palette searches the SAME
  // memory as the command line, in addition to the plain substring
  // search over the loaded slice above.
  if (redrawOnly) return;
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
  const already = new Set([...(localHits || []).map((e) => e.id), ...$('#commandResults').querySelectorAll(':scope > [data-search-entry]')].map((e) => e.id || e.dataset.searchEntry));
  const extra = hits.filter((t) => !already.has(t.id)).slice(0, 8);
  target().innerHTML = extra.length
    ? `<div class="label" style="margin:14px 0 4px">Ranked search in the memory (like "mem find")</div>${extra
      .map((t) => `<button class="result" data-search-entry="${esc(t.id)}"><span class="entry-icon">${esc((types[t.type] || '?')[0])}</span><div>${esc(t.headline)}${ruleTag(t.status)}<small>${esc(t.typeLabel)} · ${esc(t.project)} · ${esc(t.id)}</small></div></button>`)
      .join('')}`
    : '';
}
// Project package (#sources/export): selection, counts and package are
// computed by the server (src/projectpackage.mjs select()) from THE SAME
// build as /dashboard.json — preview and download cannot drift apart. The
// path stands literally in every fetch() (the closed route list).
let exportPreviewNo = 0;
function getExport() {
  const project = $('#exportProject')?.value || 'global',
    global = $('#exportGlobal')?.checked ?? true,
    hist = $('#exportHistory')?.checked ?? true;
  return { project, hist, global, query: `project=${encodeURIComponent(project)}&global=${global ? 1 : 0}&history=${hist ? 1 : 0}` };
}
async function updateExportPreview() {
  if (!$('#exportPreview')) return;
  const x = getExport(), no = ++exportPreviewNo;
  $('#exportPreview').innerHTML = '<p class="small muted">Counting …</p>';
  let b;
  try {
    const r = await fetch(`/dashboard/project-package.json?${x.query}&preview=1`, { credentials: 'same-origin', cache: 'no-store' });
    b = await r.json();
    if (!r.ok) throw new Error(b?.reason || 'answer ' + r.status);
  } catch (e) {
    if (no === exportPreviewNo && $('#exportPreview')) $('#exportPreview').innerHTML = note('Preview not readable: ' + esc(e?.message || e) + '. Scope unknown.', 'bad');
    return;
  }
  if (no !== exportPreviewNo || !$('#exportPreview')) return;
  const z = b.counts, c = b.completeness || {}, list = b.list || [];
  $('#exportPreview').innerHTML = `<div class="number" id="exportCount">${num(z.entries)}</div><p class="muted small">entries for ${esc(x.project)}</p><div class="row"><span class="small">Global foundations</span><span class="small">${x.global ? 'Included' + (x.project === 'global' ? '' : ' · ' + num(z.global)) : 'As references only'}</span></div><div class="row"><span class="small">Historical / retired</span><span class="small">${x.hist ? num(z.historical) : 'Excluded'}</span></div><div class="row"><span class="small">External entry references</span><span id="exportRefs">${num(z.externalRefs)}</span></div><div class="row"><span class="small">Completeness</span>${badge(c.state === 'good' ? 'complete' : 'unknown')}</div>${c.reasons?.length ? `<p class="small quiet">${esc(c.reasons.join(' · '))}</p>` : ''}<div style="max-height:200px;overflow:auto;margin-top:15px">${list.map((e) => `<p class="small muted" style="padding:5px 0">${esc(e.id)} · ${esc(e.title)}</p>`).join('')}${z.entries > list.length ? `<p class="small quiet">… and ${num(z.entries - list.length)} more</p>` : ''}</div>`;
}
async function exportJson(format = 'json') {
  const x = getExport();
  const html = format === 'html';
  toast(html ? 'Building the offline reading view …' : 'Building the project package …');
  try {
    const r = await fetch(`/dashboard/project-package.json?${x.query}${html ? '&format=html' : ''}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) {
      let reason = 'answer ' + r.status;
      try { reason = (await r.json()).reason || reason; } catch { /* the status stays the reason */ }
      throw new Error(reason);
    }
    const name = (/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1] || `cheap-mem-${x.project}.${html ? 'html' : 'json'}`;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast((html ? 'Offline reading view loaded: ' : 'Project package loaded: ') + name);
  } catch (e) {
    toast((html ? 'Offline reading view not built: ' : 'Project package not built: ') + (e?.message || e));
  }
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
// The server's answer came later: redraw, but give focus and selection back
// only if the field had focus before.
function redrawSearchField() {
  const old = $('#entrySearch');
  const hadFocus = old && document.activeElement === old;
  const from = old?.selectionStart, to = old?.selectionEnd, dir = old?.selectionDirection;
  render();
  const el = $('#entrySearch');
  if (el && hadFocus) {
    el.focus();
    try { el.setSelectionRange(from, to, dir || 'none'); } catch { /* field without a selection */ }
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
      if (partLater) { runCancel('part-later'); partLater = null; partRetryTimer = 0; }
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
    case 'atlas-more': {
      const m = graphAPI?.model;
      const z = m?.condensed ? atlasTarget(m.groups.find((x) => x.key === camera.focus), m.cells?.get(camera.cell)) : null;
      if (z) atlasLoad(z.kind, z.value, { more: true });
      break;
    }
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
    case 'fulltext-more':
      fulltextMore();
      break;
    case 'reset-filters':
      state.query = ''; state.topic = ''; fulltextAsk();
      state.type = state.status = 'all';
      state.page = 1;
      render();
      break;
    case 'topic-thread':
      state.topic = d.value; state.query = ''; fulltextAsk();
      state.type = state.status = 'all'; state.page = 1;
      route('knowledge/entries');
      break;
    case 'topic-source':
      topicsUi.source = d.value; topicsUi.cat = ''; topicsUi.group = false; topicsUi.more = 0; topicsUi.q = '';
      render();
      setTimeout(() => document.querySelector(`.tl-source [data-value="${d.value}"]`)?.focus(), 0);
      break;
    case 'topic-sort': {
      if (topicsUi.sort === d.value) topicsUi.dir = -topicsUi.dir;
      else { topicsUi.sort = d.value; topicsUi.dir = d.value === 'name' ? 1 : -1; }
      topicsUi.more = 0;
      render();
      setTimeout(() => document.querySelector(`.tl-sort[data-value="${d.value}"]`)?.focus(), 0);
      break;
    }
    case 'topic-view':
      topicsUi.view = d.value;
      topicsUi.more = 0;
      try { localStorage.setItem('cm-dash-topics-view', d.value); } catch { /* without storage it stays with the tab */ }
      render();
      setTimeout(() => document.querySelector(`.tl-view [data-value="${d.value}"]`)?.focus(), 0);
      break;
    case 'topic-more': {
      topicsUi.more += 1;
      const at = $('#topicList').querySelectorAll('.tl-row,.tl-tile').length;
      $('#topicList').innerHTML = topicListHtml();
      $('#topicList').querySelectorAll('.tl-row button,.tl-tile')[at]?.focus();
      break;
    }
    case 'topic-group':
      topicsUi.group = !topicsUi.group;
      topicsUi.more = 0;
      render();
      setTimeout(() => document.querySelector('.tl-group-btn')?.focus(), 0);
      break;
    case 'cat-confirm': return catRun(el, 'category-confirm', { topic: d.topic }, 'confirmed ✓');
    case 'cat-confirm-all': {
      const n = topicCategories().proposals.length;
      if (!confirm(`Confirm all ${n} proposals?\n\nEvery topic gets its proposed category as a confirmed assignment (new lines in the record, nothing is rewritten). Single ones can still be moved afterwards.`)) return;
      return catRun(el, 'category-confirm', { all: 'yes' }, 'all confirmed ✓');
    }
    case 'cat-acknowledge': return catRun(el, 'category-acknowledge', { key: d.key }, 'acknowledged ✓');
    case 'cat-rename': {
      const label = (prompt('New display name (2 to 40 characters). The key stays the same.', d.label) || '').trim();
      if (!label || label === d.label) return;
      return catRun(el, 'category-rename', { key: d.key, label }, 'renamed ✓');
    }
    case 'cat-create': {
      const field = $('#catNewLabel');
      const label = (field?.value || '').trim();
      if (!label) { const st = $('#catStatus'); if (st) { st.textContent = 'Not saved: type a name for the new category first.'; st.className = 'small tl-cat-status-line red'; } return field?.focus(); }
      return catRun(el, 'category-create', { label }, 'created ✓');
    }
    case 'cat-filter':
      topicsUi.cat = topicsUi.cat === d.value ? '' : d.value;
      topicsUi.more = 0;
      render();
      break;
    case 'topic':
      state.topic = '';
      state.query = d.value; fulltextAsk();
      state.type = state.status = 'all';
      route('knowledge/entries');
      break;
    case 'agent-entries':
      state.topic = '';
      state.query = d.value; fulltextAsk();
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
      await exportJson();
      break;
    case 'export-html':
      await exportJson('html');
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
    case 'project-confirm': {
      if (state.readonly) return toast('Read only is on.');
      const name = d.value;
      const status = document.querySelector(`[data-confirm-status="${CSS.escape(name)}"]`);
      if (!confirm(`Mark project "${name}" as confirmed?\n\nThe "new" mark goes away and one event is recorded in the project.`)) return;
      el.disabled = true;
      const rest = el.textContent;
      el.textContent = 'writing …';
      let s;
      try { s = await taskStart({ kind: 'project-confirm', name }); } catch (e) { s = { ok: false, reason: 'network: ' + (e?.message || e) }; }
      let done = null;
      if (s.ok) done = await waitForTask(s.id, { maxMs: 30000 });
      if (!s.ok || done.state !== 'ok') {
        const why = s.ok ? (done.reason || done.state || 'unknown') : reasonPlain(s.reason);
        el.disabled = false;
        el.textContent = 'Error';
        setTimeout(() => { if (el.isConnected) el.textContent = rest; }, 4000);
        if (status) status.textContent = 'Not confirmed: ' + why + '. Nothing was written.';
        return toast('Not confirmed: ' + why);
      }
      el.textContent = 'confirmed ✓';
      if (status) status.textContent = 'Confirmed.';
      toast(`Project ${name} confirmed.`);
      projectsConfirmed.add(name);
      projectsConfirmedApply();
      await loadData({ quiet: true });
      render();
      break;
    }
    case 'save-config': {
      if (state.readonly) return toast('Read only is on.');
      const status = $('#configStatus');
      const say = (t, tone) => { if (status) { status.textContent = t; status.className = 'small ' + (tone || 'quiet'); } };
      const current = Object.fromEntries((D.settings || []).map((x) => [x.id, x]));
      const changes = [];
      for (const f of $$('.setting-field')) {
        if (f.disabled) continue;
        const id = f.dataset.id, value = f.value.trim();
        if (String(value) !== String(current[id]?.value ?? '')) changes.push([id, value]);
      }
      if (!changes.length) { say('Nothing changed — nothing to save.'); return toast('Nothing changed.'); }
      el.disabled = true;
      const rest = el.textContent;
      el.textContent = 'saving …';
      say('Saving …');
      const saved = [];
      let failure = null;
      for (const [id, value] of changes) {
        let r;
        try { r = await formPost('/setting', { id, value }); } catch (x) { r = { ok: false, reason: 'network: ' + (x?.message || x) }; }
        if (!r.ok) { failure = `${current[id]?.title || id}: ${r.reason}`; break; }
        saved.push(current[id]?.title || id);
      }
      el.disabled = false;
      if (failure) {
        el.textContent = 'Error — try again';
        setTimeout(() => { if (el.isConnected) el.textContent = rest; }, 5000);
        say(`Not saved: ${failure}.${saved.length ? ' Already saved: ' + saved.join(', ') + '.' : ''}`, 'red');
        return toast('Not saved: ' + failure);
      }
      el.textContent = 'saved ✓';
      setTimeout(() => { if (el.isConnected) el.textContent = rest; }, 3000);
      toast('Settings saved and logged.');
      if (await loadData({ quiet: true })) render();
      const after = $('#configStatus');
      if (after) { after.textContent = 'Saved and logged: ' + saved.join(', ') + '.'; after.className = 'small green'; }
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
  if (e.target.id === 'topicSearch') { topicsUi.q = e.target.value; topicsUi.more = 0; $('#topicList').innerHTML = topicListHtml(); }
  if (e.target.id === 'commandInput') { fulltextAsk(fulltextPalette); renderSearch(e.target.value); }
  if (e.target.id === 'entrySearch') {
    state.query = e.target.value;
    state.page = 1;
    fulltextAsk();
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
  if (e.target.dataset?.catAssign !== undefined && v) { catRun(e.target, 'category-assign', { topic: e.target.dataset.catAssign, category: v }, null); return; }
  if (e.target.dataset?.catMerge !== undefined && v) {
    const from = e.target.dataset.catMerge, all = topicCategories().all;
    if (!confirm(`Merge category "${all.get(from)}" into "${all.get(v)}"?\n\nThe topics of the first count under the second from now on (an alias; nothing is deleted).`)) { e.target.value = ''; return; }
    catRun(e.target, 'category-merge', { source: from, target: v }, null);
    return;
  }
  if (id === 'topicCat') { topicsUi.cat = v; topicsUi.more = 0; $('#topicList').innerHTML = topicListHtml(); }
  if (id === 'topicSortSelect') {
    topicsUi.sort = v;
    topicsUi.dir = v === 'name' ? 1 : -1;
    topicsUi.more = 0;
    render();
    document.getElementById('topicSortSelect')?.focus();
  }
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
    if (!['done', 'restore', 'merge'].includes(kind)) return toast('There is no write route for that from the browser — see the CLI note.');
    const fields = { kind, id };
    if (kind === 'merge') {
      delete fields.id;
      fields.ids = [id, ...String(data.others || '').split(/[\s,]+/).filter(Boolean)].join(',');
    }
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
    toast(kind === 'done' ? 'Appended. The original stays.' : 'Appended. Nothing was deleted.');
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
  if (e.key === 'Enter' && e.target.id === 'catNewLabel') { e.preventDefault(); $('[data-action=cat-create]')?.click(); }
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
    // 15 frames/s at the same running speed (double step): the weave moves
    // slowly, the fill rate of the full-screen shader is halved. Idle (60 s
    // without input): ~10 frames/s, step by real time (0.8/s).
    const idle = THROTTLED();
    if (now - last > (idle ? IDLE_FRAME_MS : 60) || !state.motion) {
      if (state.motion) time += idle ? 0.8 * Math.min(0.2, (now - last) / 1000) : 0.048;
      last = now;
      gl.uniform2f(u.res, c.width, c.height);
      gl.uniform1f(u.time, time);
      gl.uniform2f(u.pointer, mx, my);
      const hues = { home: [0.55, 0.85, 0.4], knowledge: [0.37, 0.65, 0.9], work: [0.7, 0.5, 0.86], sources: [0.73, 0.68, 0.4], ops: [0.3, 0.8, 0.65], settings: [0.55, 0.63, 0.72] };
      gl.uniform3fv(u.tint, hues[state.area]);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    if (state.motion && !RESTING()) frame = requestAnimationFrame(draw);
  }
  function resize() {
    const ratio = Math.min(1, 800 / innerWidth);
    c.width = Math.round(innerWidth * ratio);
    c.height = Math.round(innerHeight * ratio);
    gl.viewport(0, 0, c.width, c.height);
    draw();
  }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => draw());
  document.addEventListener('close', () => draw(), true);
  wakers.add(() => draw());
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
// Closing the dialog aborts a running message run (run-helper-cm).
$('#info').addEventListener('close', () => runCancel('message'));
initAtmosphere();
document.body.classList.toggle('reduce-motion', !state.motion);
render();
loadData().then((ok) => {
  if (!ok) return;
  const initial = location.hash.slice(1);
  if (initial) route(initial);
  else render();
});

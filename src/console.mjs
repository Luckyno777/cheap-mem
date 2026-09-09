// console.mjs — the console: see AND set, in one place.
//
// **What is different from the board.** `board.mjs` answers one
// question: how are things. The console answers two — how are things,
// and what can I change about them without opening a shell. That
// matters most where a shell is least available: a phone over
// browser-SSH, a tablet, somebody else's laptop. An archive path that
// can only be set by typing a long command is, in practice, not
// settable.
//
// **Three latches, because this is the first place that WRITES over
// HTTP.**
//
//  1. **A closed list.** `SETTINGS` names every knob, with its check and
//     its writer. A field name that is not in it is REFUSED, not
//     ignored. Adding one means editing this file, and that shows up in
//     a diff — the same discipline as the tool list at the bridge.
//  2. **Writes go through the same function the CLI uses.**
//     `archive.setLocation` creates the directory, writes a probe file,
//     removes it, and records the location only then. A second writer
//     here would be two truths, and the second one would not have the
//     probe.
//  3. **Every change is logged**, machine-locally, in
//     `.mem/console-log.jsonl`. A setting that changes silently is
//     exactly the state this project spends its time hunting.
//
// **What the console never shows: a secret.** Of any token, only
// WHETHER it is set. A console that prints the MCP link with the token
// in it, so you can conveniently copy it, has put that token into every
// screenshot and every browser history.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as board from './board.mjs';
import * as archive from './archive.mjs';
import * as stores from './stores.mjs';
import * as memory from './memory.mjs';
import * as setup from './setup.mjs';

/** Machine-local, gitignored: what was set here applies here. */
export const LOG_FILE = path.join('.mem', 'console-log.jsonl');

/** Equally local: the knobs that have no home of their own. */
export const STATE_FILE = path.join('.mem', 'console.json');

function readState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, STATE_FILE), 'utf8')); }
  catch { return {}; }
}

function writeState(root, part) {
  const file = path.join(root, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...readState(root), ...part }, null, 2)}\n`, 'utf8');
}

/** Can it actually be written to? Existing is not the same as writable. */
export function probeWritable(location) {
  try {
    fs.mkdirSync(location, { recursive: true });
    const p = path.join(location, `.consoleprobe-${process.pid}`);
    fs.writeFileSync(p, 'ok');
    fs.unlinkSync(p);
    return true;
  } catch { return false; }
}

/**
 * The closed list of knobs.
 *
 * Each states what it is, what it currently is, where that value came
 * from, and what happens if you change it. The last field matters most:
 * `effect` sits next to the input, so nobody sets something whose
 * consequence they have not read.
 */
export const SETTINGS = Object.freeze({
  'raw-archive': {
    title: 'Raw archive',
    kind: 'path',
    description: 'Where raw captures are written. A store id (gdrive, icloud, '
      + 'onedrive, dropbox) or a folder. Empty = back to the default.',
    effect: 'Applies from the next capture. Captures already written do NOT move — '
      + '"mem raw migrate" is for that. The location is created and probe-written; '
      + 'if the probe fails, nothing is recorded.',
    read(root, env) {
      const store = archive.readConfig(env, root);
      const syncing = stores.syncingStoreFor(store.location);
      return {
        value: store.location,
        source: store.source,
        set: store.explicit,
        // A location that exists is not yet a location you can write
        // to. Two states would be too few here.
        writable: probeWritable(store.location),
        note: syncing ? `${syncing.label} — syncing store` : null,
      };
    },
    write(root, value) {
      const v = String(value ?? '').trim();
      if (!v) {
        // Resetting means REMOVING the machine-local entry, not writing
        // the default into it. Otherwise a path is frozen that may
        // change later.
        try { fs.unlinkSync(path.join(root, archive.LOCATION_FILE)); } catch { /* none */ }
        return { location: archive.readConfig({}, root).location, reset: true };
      }
      return archive.setLocation(root, v);
    },
  },

  'error-window': {
    title: 'Error-class window',
    kind: 'number',
    description: 'How many days the error-class tile counts over.',
    effect: 'A display question only. A wide window shows the body of the log, '
      + 'a narrow one shows what is happening now.',
    read(root) {
      const s = readState(root);
      return { value: Number(s.errorWindow ?? 14),
        source: s.errorWindow ? 'console' : 'default', set: s.errorWindow != null };
    },
    write(root, value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > 3650) {
        throw new Error('Days must be between 1 and 3650.');
      }
      writeState(root, { errorWindow: Math.round(n) });
      return { days: Math.round(n) };
    },
  },

  'quiet-hours': {
    title: 'Agent quiet limit',
    kind: 'number',
    description: 'After how many hours without a heartbeat an agent counts as quiet.',
    effect: 'Only changes when the agents tile turns to WATCH. It never turns to '
      + 'ALARM: silence is not proof of breakage, an agent may have had nothing to do.',
    read(root) {
      const s = readState(root);
      return { value: Number(s.quietHours ?? 24),
        source: s.quietHours ? 'console' : 'default', set: s.quietHours != null };
    },
    write(root, value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1 || n > 8760) {
        throw new Error('Hours must be between 1 and 8760.');
      }
      writeState(root, { quietHours: Math.round(n) });
      return { hours: Math.round(n) };
    },
  },
});

/**
 * Apply one knob.
 *
 * Throws on an unknown name. Ignoring it silently would be the exact
 * construction this project builds against: the page reports success
 * and nothing happened.
 */
export function apply(root, id, value, { by = 'console' } = {}) {
  const s = SETTINGS[id];
  if (!s) throw new Error(`Unknown setting '${id}'.`);
  const before = s.read(root, process.env)?.value ?? null;
  const result = s.write(root, value);
  const after = s.read(root, process.env)?.value ?? null;
  writeLog(root, { id, before, after, by });
  return { id, before, after, result };
}

/** Appended, never overwritten — otherwise it would not be a log. */
export function writeLog(root, row) {
  const file = path.join(root, LOG_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...row,
  })}\n`, 'utf8');
}

/** The last changes, newest first. Broken lines are skipped, not swallowed. */
export function readLog(root, { max = 10 } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(root, LOG_FILE), 'utf8'); }
  catch { return []; }
  const out = [];
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* next */ }
    if (out.length >= max) break;
  }
  return out;
}

/** What git says right now. Never fatal: a console that dies on git is not one. */
export function gitState(root) {
  const run = (...a) => {
    try {
      const r = spawnSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 5000 });
      return r.status === 0 ? String(r.stdout).trim() : null;
    } catch { return null; }
  };
  const dirty = run('status', '--porcelain');
  return {
    branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
    head: run('rev-parse', '--short', 'HEAD'),
    remote: run('remote', 'get-url', 'origin'),
    at: run('log', '-1', '--format=%cI'),
    changed: dirty == null ? null : dirty.split('\n').filter(Boolean).length,
  };
}

/**
 * The connections: which link goes where, and is there a door in front?
 *
 * Of any token, only WHETHER it is set.
 */
export function connections(env = process.env, cfg = {}) {
  const host = cfg.host ?? env.CHEAP_MEM_SERVE_HOST ?? '127.0.0.1';
  const port = Number(cfg.port ?? env.CHEAP_MEM_SERVE_PORT ?? 8847);
  return [
    {
      id: 'console',
      title: 'Console / viewer',
      address: `http://${host}:${port}/`,
      door: (cfg.token ?? env.CHEAP_MEM_SERVE_TOKEN) ? 'token set' : 'no token — localhost only',
      open: !(cfg.token ?? env.CHEAP_MEM_SERVE_TOKEN),
      note: 'Without a token the server refuses to bind anywhere but localhost.',
    },
    {
      id: 'mcp',
      title: 'MCP bridge',
      address: 'bin/mem-mcp (stdio)',
      door: 'the client starts the process — no network, no port',
      open: false,
      note: 'Register it in the client config; see docs/mcp-setup.md.',
    },
  ];
}

/** How large is the memory, per drawer? */
export function inventory(root) {
  const count = (project) => {
    let n = 0;
    for (const type of Object.keys(memory.TYPES)) {
      try { n += memory.readLog(root, type, { project }).entries.length; }
      catch { /* drawer absent */ }
    }
    return n;
  };
  const projects = memory.listProjects(root);
  let total = count(null);
  for (const p of projects) total += count(p);
  let captures = 0;
  try { captures = archive.records(root).length; } catch { /* none */ }
  return { total, projects: projects.length, captures };
}

/**
 * Everything the console shows — as data, not as HTML.
 *
 * Separate so it also goes out as JSON, and so the probes can check the
 * numbers without reaching through markup.
 */
export function collect(root, { env = process.env, now = new Date(), cfg = {} } = {}) {
  const windowDays = SETTINGS['error-window'].read(root).value;
  const quietMin = SETTINGS['quiet-hours'].read(root).value * 60;
  const b = board.board(root, { env, now, windowDays, quietMin });
  const settings = Object.entries(SETTINGS).map(([id, s]) => {
    let state;
    try { state = s.read(root, env); }
    catch (e) { state = { value: null, source: 'error', error: e.message }; }
    return { id, title: s.title, kind: s.kind, description: s.description, effect: s.effect, ...state };
  });
  let steps = [];
  try { steps = setup.check(root, { env }).steps; } catch { /* reported by the tile */ }
  return {
    board: b,
    settings,
    connections: connections(env, cfg),
    setup: steps,
    git: gitState(root),
    inventory: inventory(root),
    log: readLog(root, { max: 5 }),
    // **Only what was actually FOUND.** The first draft mapped every
    // entry `discover()` returns, and `discover()` returns all five
    // stores with a `found` array that may be empty. The page then
    // announced "found on this machine: gdrive, icloud, onedrive,
    // dropbox" on a Linux container that has none of them — a claim
    // about the machine, produced by not reading the field. Exactly the
    // class this page exists to prevent, in this page's own code.
    stores: stores.discover()
      .filter((s) => (s.found ?? []).length > 0)
      .map((s) => ({ id: s.id, label: s.label, sync: s.sync, found: s.found })),
    root,
    at: b.at,
  };
}

/** HTML special characters. Everything here is memory content or a path. */
function h(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const MARK = { alarm: '!!', watch: '!', unknown: '?', calm: '·' };
const COLOUR = { alarm: '#b3261e', watch: '#8a6100', unknown: '#5f6368', calm: '#1e6b3a' };
const WORD = { alarm: 'Alarm', watch: 'Watch', unknown: 'unmeasured', calm: 'calm' };
const STEP_MARK = { ok: '·', open: '!', broken: '!!' };
const STEP_COLOUR = { ok: '#1e6b3a', open: '#8a6100', broken: '#b3261e' };

/**
 * The navigation both pages carry.
 *
 * A viewer with no way back to the console would be a dead end, and a
 * console with no way into the viewer would be exactly the separation
 * this page exists to remove.
 */
export function nav(active = 'console') {
  const item = (href, name, id) =>
    `<a href="${href}"${id === active ? ' aria-current="page"' : ''}>${h(name)}</a>`;
  return `<nav class="mem-nav">${item('/', 'Console', 'console')}${item('/viewer', 'Viewer', 'viewer')}</nav>`;
}

export const NAV_CSS = `
.mem-nav{display:flex;gap:.25rem;padding:.5rem .75rem;background:#1b1b1b;
  position:sticky;top:0;z-index:99;font:14px/1 system-ui,-apple-system,sans-serif}
.mem-nav a{color:#cfd3d8;text-decoration:none;padding:.4rem .7rem;border-radius:5px}
.mem-nav a[aria-current=page]{background:#33363b;color:#fff}
.mem-nav a:hover{background:#2a2c30;color:#fff}
`;

/**
 * Put the navigation into a finished page.
 *
 * After the opening `<body>`; otherwise it lands in the head and is
 * never shown. If there is no `<body>`, NOTHING is inserted rather than
 * guessed — a bar in the middle of a document is worse than none.
 */
export function insertNav(html, active = 'viewer') {
  const style = `<style>${NAV_CSS}</style>`;
  const i = html.search(/<body[^>]*>/i);
  if (i < 0) return html;
  const end = html.indexOf('>', i) + 1;
  return html.slice(0, end) + style + nav(active) + html.slice(end);
}

/** The console as a page. No script — forms do not need one. */
export function asHtml(d, { writable = true } = {}) {
  const tiles = d.board.tiles.map((t) => `
    <article class="t" style="--c:${COLOUR[t.state]}">
      <header><span class="m">${h(MARK[t.state])}</span><h3>${h(t.title)}</h3>
        <span class="w">${h(WORD[t.state])}</span></header>
      <p>${h(t.line)}</p>${t.detail ? `<p class="d">${h(t.detail)}</p>` : ''}
    </article>`).join('');

  const forms = d.settings.map((s) => `
    <form class="s" method="post" action="/setting">
      <input type="hidden" name="id" value="${h(s.id)}">
      <label for="f-${h(s.id)}"><strong>${h(s.title)}</strong></label>
      <p class="b">${h(s.description)}</p>
      <div class="row">
        <input id="f-${h(s.id)}" name="value" value="${h(s.value)}"
          ${s.kind === 'number' ? 'type="number" min="1"' : 'type="text" spellcheck="false"'}
          ${writable ? '' : 'disabled'}>
        <button type="submit"${writable ? '' : ' disabled'}>Set</button>
      </div>
      <p class="q">Source: <b>${h(s.source)}</b>${
  s.writable === false ? ' · <b class="red">not writable</b>' : ''}${
  s.writable === true ? ' · writable' : ''}${s.note ? ` · ${h(s.note)}` : ''}</p>
      <p class="e">${h(s.effect)}</p>
    </form>`).join('');

  const storeList = d.stores.length
    ? `<p class="d">Found on this machine: ${d.stores.map((s) =>
      `<code>${h(s.id)}</code>${s.found.length > 1 ? ` (${s.found.length} candidates — ambiguous)` : ''}`)
      .join(', ')} — usable as a value above.</p>`
    : '<p class="d">No cloud store found on this machine. A folder path works, '
      + 'and so does <code>local</code> with one.</p>';

  const steps = d.setup.map((s) => `
    <li style="--c:${STEP_COLOUR[s.state]}"><span class="m">${h(STEP_MARK[s.state])}</span>
      <b>${h(s.title)}</b><br><span class="d">${h(s.detail)}</span>
      ${s.fix ? `<br><span class="d">→ <code>${h(s.fix)}</code></span>` : ''}</li>`).join('');

  const links = d.connections.map((c) => `
    <li style="--c:${c.open ? '#8a6100' : '#1e6b3a'}"><b>${h(c.title)}</b><br>
      <code>${h(c.address)}</code><br>
      <span class="${c.open ? 'red' : 'green'}">${h(c.door)}</span>
      <span class="d">${h(c.note)}</span></li>`).join('');

  const log = d.log.length
    ? `<ul class="l">${d.log.map((p) => `<li><time>${
      h(String(p.ts).replace('T', ' ').replace('Z', ''))}</time> <b>${h(p.id)}</b>: <span class="d">${
      h(p.before)}</span> → ${h(p.after)}</li>`).join('')}</ul>`
    : '<p class="d">Nothing has been set here yet.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cheap-mem — console</title>
<style>
  :root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1b;--li:#d7d7d7;--sw:#5f6368;--fl:#f6f7f8}
  @media (prefers-color-scheme:dark){
    :root{--bg:#131315;--fg:#eceff1;--li:#33363b;--sw:#a8adb4;--fl:#1b1c1f}
  }
  body{margin:0;background:var(--bg);color:var(--fg);
    font:16px/1.5 system-ui,-apple-system,sans-serif}
  ${NAV_CSS}
  main{padding:1rem;max-width:52rem;margin:0 auto}
  h1{font-size:1.15rem;margin:0 0 .2rem}
  h2{font-size:.95rem;margin:1.6rem 0 .6rem;text-transform:uppercase;
    letter-spacing:.05em;color:var(--sw)}
  h3{font-size:.95rem;margin:0;flex:1}
  .at{color:var(--sw);font-size:.85rem;margin:0}
  .t{border:1px solid var(--li);border-left:4px solid var(--c);border-radius:6px;
    padding:.55rem .8rem;margin:0 0 .5rem}
  .t header{display:flex;align-items:baseline;gap:.5rem}
  .t p{margin:.3rem 0 0}
  .m{color:var(--c);font-weight:700}
  .w{color:var(--c);font-size:.72rem;text-transform:uppercase;letter-spacing:.04em}
  .d{color:var(--sw);font-size:.85rem;word-break:break-word}
  .s{border:1px solid var(--li);border-radius:6px;padding:.7rem .8rem;margin:0 0 .7rem;
    background:var(--fl)}
  .s label{display:block}
  .b{margin:.2rem 0 .5rem;font-size:.9rem}
  .row{display:flex;gap:.5rem;flex-wrap:wrap}
  .row input{flex:1 1 16rem;min-width:0;padding:.45rem .55rem;font:inherit;
    border:1px solid var(--li);border-radius:5px;background:var(--bg);color:var(--fg)}
  .row button{padding:.45rem 1rem;font:inherit;border:1px solid var(--li);
    border-radius:5px;background:var(--bg);color:var(--fg);cursor:pointer}
  .row button:hover{background:var(--li)}
  .q,.e{margin:.35rem 0 0;font-size:.85rem;color:var(--sw)}
  .red{color:#b3261e}.green{color:#1e6b3a}
  ul{list-style:none;padding:0;margin:0}
  ul li{border:1px solid var(--li);border-left:4px solid var(--c,var(--li));
    border-radius:6px;padding:.55rem .8rem;margin:0 0 .5rem}
  code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
  .l li{padding:.35rem .6rem;font-size:.9rem;border-left-width:1px}
  time{color:var(--sw);font-size:.8rem}
  dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem .8rem;margin:0;font-size:.9rem}
  dt{color:var(--sw)}dd{margin:0;word-break:break-all}
  .note{border:1px solid var(--li);border-left:4px solid #8a6100;border-radius:6px;
    padding:.5rem .8rem;margin:0 0 .8rem;font-size:.9rem}
</style>
</head><body>
${nav('console')}
<main>
<h1>Console</h1>
<p class="at">${d.board.alarm ? `${d.board.alarm} alarm · ` : ''}${
  d.board.watch ? `${d.board.watch} watch · ` : ''}${
  d.board.unknown ? `${d.board.unknown} unmeasured · ` : ''}as of ${h(d.at)}</p>

<h2>State</h2>
${tiles}

<h2>Settings</h2>
${writable ? '' : '<p class="note">Writing is off (<code>CHEAP_MEM_SERVE_READONLY=1</code>). The fields show the state but accept nothing.</p>'}
${forms}
${storeList}

<h2>Installation</h2>
<ul>${steps}</ul>

<h2>Connections</h2>
<ul>${links}</ul>
<p class="d">Of any token, only WHETHER it is set is shown here — never its value.</p>

<h2>Memory</h2>
<dl>
  <dt>Root</dt><dd><code>${h(d.root)}</code></dd>
  <dt>Entries</dt><dd>${d.inventory.total} across ${d.inventory.projects} project${
  d.inventory.projects === 1 ? '' : 's'} · ${d.inventory.captures} captures</dd>
  <dt>Branch</dt><dd>${h(d.git.branch ?? 'unknown')} @ ${h(d.git.head ?? '?')}</dd>
  <dt>Remote</dt><dd><code>${h(d.git.remote ?? 'none')}</code></dd>
  <dt>Last commit</dt><dd>${h(d.git.at ?? 'unknown')}</dd>
  <dt>Uncommitted</dt><dd>${d.git.changed == null ? 'not measurable'
    : `${d.git.changed} file${d.git.changed === 1 ? '' : 's'}`}</dd>
</dl>

<h2>Last set</h2>
${log}
</main>
</body></html>
`;
}

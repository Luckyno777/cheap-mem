// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// console.mjs — the console's data: see AND set, in one place.
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
import { appendLine } from './append.mjs';
import * as writegate from './writegate.mjs';

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
  'core-name': {
    title: 'Core name',
    kind: 'text',
    description: 'The name shown on the shared core in the knowledge space, and in '
      + 'the atlas header and breadcrumb.',
    effect: 'Display only — every value is escaped before it reaches the page. '
      + 'Applies from the next dashboard reload.',
    read(root) {
      const s = readState(root);
      const value = s.coreName != null ? s.coreName : 'CHEAP MEM';
      return { value, source: s.coreName != null ? 'console' : 'default', set: s.coreName != null };
    },
    write(root, value) {
      const v = String(value ?? '').trim();
      // 1-32 printable characters, no control characters or line breaks —
      // this text sits in a page header, not a log line.
      if (!v || v.length > 32 || /[\x00-\x1F\x7F]/.test(v)) {
        throw new Error('Core name must be 1–32 printable characters, with no line breaks or control characters.');
      }
      writeState(root, { coreName: v });
      return { name: v };
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
  appendLine(file, `${JSON.stringify({
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), ...row,
  })}\n`);
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

/**
 * How large is the memory, per drawer? `known` is the line total when a
 * single pass already counted it (src/dashboard-pass.mjs) — the drawers are
 * then not read a second time.
 */
export function inventory(root, { known = null } = {}) {
  const count = (project) => {
    let n = 0;
    for (const type of Object.keys(memory.TYPES)) {
      try { n += memory.readLog(root, type, { project }).entries.length; }
      catch { /* drawer absent */ }
    }
    return n;
  };
  const projects = memory.listProjects(root);
  let total = known;
  if (total === null) {
    total = count(null);
    for (const p of projects) total += count(p);
  }
  // Not `records(root).length`. Since 2026-09-16 a deletion appends a
  // TOMBSTONE to the same append-only register, so counting rows would
  // have made every delete look like a new capture — the number going
  // UP as material is removed is the most convincing kind of wrong.
  let captures = null;
  let capturesDeleted = null;
  try {
    const gone = archive.deletions(root);
    const kept = new Set();
    for (const r of archive.records(root)) {
      if (!r?.path || r.record === archive.DELETED_MARK) continue;
      kept.add(r.path);
    }
    capturesDeleted = [...kept].filter((p) => gone.has(p)).length;
    captures = kept.size - capturesDeleted;
  } catch { /* stays null: not measured, which is not zero */ }
  return { total, projects: projects.length, captures, capturesDeleted };
}

/**
 * Everything the console shows — as data, not as HTML.
 *
 * Separate so it also goes out as JSON, and so the probes can check the
 * numbers without reaching through markup.
 */
export function collect(root, {
  env = process.env, now = new Date(), cfg = {},
  // The compact build (src/dashboard-compact.mjs) brings its own board and
  // inventory: both read the whole store.
  boardOf = (r, o) => board.board(r, o), inventoryOf = inventory,
} = {}) {
  const windowDays = SETTINGS['error-window'].read(root).value;
  const quietMin = SETTINGS['quiet-hours'].read(root).value * 60;
  const b = boardOf(root, { env, now, windowDays, quietMin });
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
    // The write switch in front of every writing route — four states,
    // see `src/writegate.mjs`. The page draws it; the server enforces it.
    writes: writegate.read(root, { flag: cfg.allowWrites === true, readonly: cfg.readonly === true }),
    connections: connections(env, cfg),
    setup: steps,
    git: gitState(root),
    inventory: inventoryOf(root),
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

// **The console PAGE is gone (2026-09-28).** Its HTML — `asHtml()`, the
// shared navigation (`nav()`, `insertNav()`, `NAV_CSS`) and
// `writesNote()` — was removed when the dashboard became the only UI
// (src/dashboard-page.mjs; its Settings › System settings view shows every
// setting, the write switch, the setup steps, the stores and the change
// log from `collect()` above). What stays is the DATA: the closed
// `SETTINGS` list, `apply()` (behind POST /setting), the log, and
// `collect()` (served as /console.json). Proof that nothing was lost:
// test/dashboard-complete.test.mjs.

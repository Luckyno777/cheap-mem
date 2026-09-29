// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * skillusage — W10 (lucky-mem plan, block W; parity twin of
 * lucky-mem's `src/skillnutzung.mjs`): which skills get used? Measured
 * from the captured transcripts (the raw-capture archive, read through
 * the same `raw.capturesWithState` + `raw.readCapture` as `mem raw`).
 * No model, nothing is written.
 *
 * Two ways to invoke a skill are counted:
 *   - tool call: assistant line, `content[]` with
 *     `{type:'tool_use', name:'Skill', input:{skill:'<name>'}}`.
 *   - slash command: user line whose text carries
 *     `<command-name>/<name></command-name>` (how the transcript marks
 *     a typed `/name`).
 * Per skill: calls (both ways, and separately), last use, number of
 * DISTINCT sessions.
 *
 * **Coverage is part of every output.** Subagent sessions are not
 * captured (lucky-mem handover 5.2); a skill only a subagent pulled is
 * invisible here. So a skill without a hit is "not observed", never
 * "unused".
 *
 * **Not measurable is not zero.** Archive unreadable, no capture with
 * bytes on this machine, or the time cap (MEM_SKILLUSAGE_TIME_MS) cut
 * the run -> `state: 'unknown'` ("partially read: X of Y"); counts so
 * far are lower bounds only and no "not observed" list is offered.
 *
 * **Privacy.** Only skill names (checked against a narrow pattern; the
 * rest is only a count of "unreadable names") and counters leave. No
 * transcript text, no arguments.
 *
 * **Never removes anything.** Duplicates are proposals only.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as raw from './raw.mjs';

export const TIME_MS_DEFAULT = 8000;
export const DAYS_DEFAULT = 30;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const COMMAND_RE = /<command-name>\s*\/?([^<\s]{1,80})\s*<\/command-name>/g;

function num(v, dflt) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : dflt;
}
export const timeCapMs = (env = process.env) => num(env.MEM_SKILLUSAGE_TIME_MS, TIME_MS_DEFAULT);
export const daysThreshold = (env = process.env) => num(env.MEM_SKILLUSAGE_DAYS, DAYS_DEFAULT);

/** The inventory the house ships: `.claude/skills/<name>/SKILL.md`. */
export function inventory(root) {
  const dir = path.join(root, '.claude', 'skills');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    const name = /^name:\s*(\S+)/m.exec(head)?.[1] ?? e.name;
    const desc = /^description:\s*>?-?\s*\n?([\s\S]*?)(?=\n[A-Za-z-]+:|$)/m.exec(head)?.[1] ?? '';
    out.push({ name, description: desc.replace(/\s+/g, ' ').trim() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function textPieces(o) {
  const c = o?.message?.content;
  if (typeof c === 'string') return [c];
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text);
  return [];
}

/** Skill calls in one line: {hits:[{name, via:'tool'|'command'}], unreadable}. */
export function callsOf(o) {
  const hits = [];
  let unreadable = 0;
  const take = (name, via) => {
    if (typeof name === 'string' && NAME_RE.test(name)) hits.push({ name, via });
    else unreadable += 1;
  };
  if (!o || typeof o !== 'object') return { hits, unreadable };
  if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
    for (const x of o.message.content) {
      if (x && x.type === 'tool_use' && x.name === 'Skill') take(x.input?.skill, 'tool');
    }
  } else if (o.type === 'user' && !o.isMeta) {
    for (const t of textPieces(o)) {
      if (!t.trimStart().startsWith('<command-')) continue;
      for (const m of t.matchAll(COMMAND_RE)) take(m[1], 'command');
    }
  }
  return { hits, unreadable };
}

/** The measurement. `nowMs` only for probes. */
export function measure(root, { env = process.env, nowMs = null } = {}) {
  const inv = inventory(root);
  const base0 = { inventory: inv, skills: [], notObserved: [], proposals: [], sessions: 0, captures: 0,
    capturesTotal: 0, read: 0, from: null, to: null, days: 0, partial: false, unreadableNames: 0 };
  let states;
  try { states = raw.capturesWithState(root); }
  catch (e) { return done({ ...base0, state: 'unknown', reason: `raw-capture archive unreadable: ${e?.message || e}` }); }
  const live = states.filter((s) => s.state !== 'deleted');
  if (!live.length) return done({ ...base0, state: 'empty', reason: 'no raw-capture archive present' });
  const readable = live.filter((s) => s.state === 'present');
  const base = { ...base0, capturesTotal: live.length, captures: readable.length };
  if (!readable.length) {
    return done({ ...base, state: 'unknown',
      reason: `archive not reachable: 0 of ${live.length} captures readable on this machine` });
  }

  const cap = timeCapMs(env);
  const start = typeof nowMs === 'number' ? nowMs : Date.now();
  const per = new Map();
  const sessions = new Set();
  let from = null; let to = null; let read = 0; let unreadable = 0; let cut = false;
  const span = (t) => {
    if (typeof t !== 'string' || Number.isNaN(Date.parse(t))) return;
    if (from === null || Date.parse(t) < Date.parse(from)) from = t;
    if (to === null || Date.parse(t) > Date.parse(to)) to = t;
  };
  for (const c of readable) {
    if (Date.now() - start >= cap) { cut = true; break; }
    let cp;
    try { cp = raw.readCapture(root, c.path); } catch { continue; }
    read += 1;
    const sid = cp.header?.__stamp?.session_id ?? `capture:${c.path}`;
    sessions.add(sid);
    span(cp.header?.__stamp?.ts_from); span(cp.header?.__stamp?.ts_to);
    for (const l of cp.lines) {
      const { hits, unreadable: u } = callsOf(l);
      unreadable += u;
      const ts = typeof l.timestamp === 'string' ? l.timestamp : (cp.header?.__stamp?.ts_to ?? null);
      for (const h of hits) {
        let s = per.get(h.name);
        if (!s) { s = { tool: 0, command: 0, last: null, sessions: new Set() }; per.set(h.name, s); }
        s[h.via] += 1;
        s.sessions.add(sid);
        if (ts && (s.last === null || Date.parse(ts) > Date.parse(s.last))) s.last = ts;
      }
    }
  }
  const skills = [...per].map(([name, s]) => ({
    name, calls: s.tool + s.command, tool: s.tool, command: s.command,
    last: s.last ? s.last.slice(0, 10) : null, sessions: s.sessions.size,
    inInventory: inv.some((i) => i.name === name),
  })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
  const days = from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 86400000) : 0;
  const res = { ...base, read, sessions: sessions.size, from: from?.slice(0, 10) ?? null,
    to: to?.slice(0, 10) ?? null, days, skills, unreadableNames: unreadable };
  if (cut) {
    return done({ ...res, state: 'unknown', partial: true,
      reason: `partially read: ${read} of ${readable.length} captures — time cap ${cap} ms reached (MEM_SKILLUSAGE_TIME_MS); counts are lower bounds only` });
  }
  res.notObserved = inv.filter((i) => !per.has(i.name)).map((i) => i.name);
  res.proposals = nearDuplicates(inv);
  return done({ ...res, state: 'measured', reason: null });
}

function done(r) {
  const period = r.from && r.to ? `${r.from} .. ${r.to}` : 'no period';
  r.coverage = `measured over ${r.sessions} sessions / ${r.read} captures (${period}); `
    + 'subagents not captured (handover 5.2)';
  return r;
}

/** Proposals only: same normalised name, or a very similar description. */
export function nearDuplicates(inv) {
  const norm = (n) => n.toLowerCase().replace(/^.*:/, '').replace(/[^a-z0-9]/g, '');
  const words = (t) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const out = [];
  for (let i = 0; i < inv.length; i += 1) {
    for (let j = i + 1; j < inv.length; j += 1) {
      const a = inv[i]; const b = inv[j];
      let why = null;
      if (norm(a.name) === norm(b.name)) why = 'same name';
      else {
        const wa = words(a.description); const wb = words(b.description);
        const both = [...wa].filter((w) => wb.has(w)).length;
        const all = new Set([...wa, ...wb]).size;
        if (all >= 6 && both / all >= 0.6) why = 'similar description';
      }
      if (why) out.push({ a: a.name, b: b.name, why });
    }
  }
  return out;
}

export function asText(r) {
  const z = [`Skill usage — ${r.coverage}`];
  if (r.state === 'unknown') z.push(`State: unknown — ${r.reason}`);
  else if (r.state === 'empty') z.push(`State: unknown — ${r.reason} (nothing to measure; that is not "no use")`);
  else z.push('State: measured');
  if (r.skills.length) {
    z.push(r.partial ? 'Observed (lower bounds only):' : 'Observed:');
    for (const s of r.skills) {
      z.push(`  ${s.name}  ${s.calls}x (tool ${s.tool}, command ${s.command})  ${s.sessions} sessions  last ${s.last ?? '-'}${s.inInventory ? '' : '  (not in house inventory)'}`);
    }
  } else if (r.state === 'measured') z.push('Observed: no skill calls in the captures read.');
  if (r.state === 'measured') {
    z.push(r.notObserved.length
      ? `Not observed (house inventory, ${r.notObserved.length}): ${r.notObserved.join(', ')} — does NOT mean unused`
      : (r.inventory.length ? 'Not observed: none — every skill of the house inventory appeared.'
        : 'House inventory: no skills shipped (.claude/skills is empty or absent).'));
    for (const p of r.proposals) z.push(`Proposal (nothing is removed automatically): check ${p.a} / ${p.b} for merging (${p.why})`);
  }
  if (r.capturesTotal > r.captures) z.push(`The archive knows ${r.capturesTotal} captures, ${r.captures} are readable on this machine.`);
  if (r.unreadableNames) z.push(`${r.unreadableNames} call(s) with an unreadable name not counted.`);
  return z.join('\n');
}

export function asJson(r) {
  const { inventory: inv, ...rest } = r;
  return { ...rest, inventory: inv.map((i) => i.name) };
}

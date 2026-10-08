// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * skillcatalog — the dashboard's "Skills & procedures" catalogue (twin of
 * lucky-mem's `skillkatalog`), `GET /dashboard/skills.json`. Status lines
 * are history, never entries. One truth: it reads
 * `skillregistry.registry()`, `skilleffect.measure()` and
 * `procedure.TRANSITIONS`. "Installed" = a SKILL.md the server can read
 * where Claude Code looks (project `.claude/skills`, `~/.claude/skills`,
 * `~/.claude/plugins`, `CLAUDE_CONFIG_DIR`); READ only, unreadable is
 * `unknown`. The export marker names the registry id, so drift shows.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as reg from './skillregistry.mjs';
import * as procedure from './procedure.mjs';

const TYPE_NAMES = Object.freeze({ skill: 'Skills', workflow: 'Workflows', snippet: 'Snippets', procedure: 'Procedures' });
const MAX_DEPTH = 5;
const MAX_DIRS = 3000;
const EXPORT_COMMAND = 'mem skills export --format claude';

const q = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const transitionsOf = (status) => [...(procedure.TRANSITIONS[reg.transitionFrom(status)] ?? [])];
/** The CLI command that writes the change — the same function the dashboard task runs. */
const statusCommand = (it, next) => `mem skills status ${it.id} ${next} --issued-by owner --why ${q('<why>')}`;

function groupOf(it) {
  const e = it.entry ?? {};
  if (typeof e.family === 'string' && e.family.trim()) return `Family ${e.family.trim()}`;
  const topic = typeof e.topic === 'string' && e.topic.trim() ? e.topic.trim() : null;
  if (topic) return `Topic ${topic}`;
  return it.project ? `Project ${it.project}` : 'Global';
}

function whenOf(it) {
  const e = it.entry ?? {};
  const raw = (typeof e.when === 'string' && e.when.trim()) ? e.when
    : (it.triggers[0] ?? (typeof e.scope === 'string' && e.scope.trim() ? `applies to: ${e.scope}` : it.label.what));
  const t = String(raw).replace(/\s+/g, ' ').trim();
  return t.length > 220 ? `${t.slice(0, 219)}…` : t;
}

function shortTitle(e, fallback) {
  const t = String(e.title ?? e.rule ?? fallback ?? '').split(/:\s|\s[—–]\s/)[0].replace(/\s+/g, ' ').trim();
  return t.length > 90 ? `${t.slice(0, 89)}…` : (t || String(fallback ?? ''));
}

/**
 * The history of one entry: creation, every version (`replaces_id`
 * chain) and every status line pointing at it. A line without a human
 * `issued_by` is SHOWN with `counts: false` — the registry skips it, the
 * display does not hide it.
 */
function historyOf(it, rows) {
  const byId = new Map();
  for (const e of rows) if (e && e.id && !byId.has(e.id)) byId.set(e.id, e);
  const chain = [];
  const seen = new Set();
  for (let cur = it.entry; cur && cur.id && !seen.has(cur.id); cur = cur.replaces_id ? byId.get(cur.replaces_id) : null) {
    seen.add(cur.id);
    chain.push(cur);
  }
  const ids = new Set(chain.map((e) => e.id));
  const ev = chain.reverse().map((e) => ({
    ts: String(e.ts ?? ''), kind: e.replaces_id ? 'version' : 'created', id: e.id,
    by: procedure.isHuman(e.issued_by) ? e.issued_by : (e.agent ?? null),
    status: typeof e.start_status === 'string' ? e.start_status : null, why: null, counts: true,
  }));
  for (const e of rows) {
    if (!procedure.isStatusLine(e) || !ids.has(e.status_of)) continue;
    ev.push({ ts: String(e.ts ?? ''), kind: 'status', id: e.id, status: String(e.status), by: e.issued_by ?? null,
      agent: e.agent ?? null, why: typeof e.why === 'string' ? e.why.slice(0, 400) : null,
      counts: procedure.isHuman(e.issued_by) && procedure.STATUSES.includes(e.status) });
  }
  return ev.sort((a, b) => a.ts.localeCompare(b.ts));
}

function frontMatter(text) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const field = (n) => {
    const m = new RegExp(`^${n}:\\s*(.*)$`, 'm').exec(head);
    if (!m) return null;
    let v = m[1].trim();
    if (/^[>|]-?$/.test(v)) {
      const z = [];
      for (const r of head.slice(m.index + m[0].length).split('\n')) { if (/^\S/.test(r)) break; z.push(r.trim()); }
      v = z.join(' ').trim();
    }
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.replace(/^"|"$/g, ''); } }
    return v.replace(/^'|'$/g, '');
  };
  return { name: field('name'), description: field('description') };
}

function places(root, env) {
  const out = [{ place: 'project', title: 'Project (.claude/skills in the memory repo)', base: path.join(root, '.claude', 'skills'), shown: '.claude/skills' }];
  if (env.HOME) {
    out.push({ place: 'user', title: 'User (~/.claude/skills)', base: path.join(env.HOME, '.claude', 'skills'), shown: '~/.claude/skills' });
    out.push({ place: 'plugins', title: 'Plugins (~/.claude/plugins)', base: path.join(env.HOME, '.claude', 'plugins'), shown: '~/.claude/plugins' });
  }
  if (env.CLAUDE_CONFIG_DIR) {
    out.push({ place: 'config', title: 'CLAUDE_CONFIG_DIR/skills', base: path.join(env.CLAUDE_CONFIG_DIR, 'skills'), shown: '$CLAUDE_CONFIG_DIR/skills' });
    out.push({ place: 'config-plugins', title: 'CLAUDE_CONFIG_DIR/plugins', base: path.join(env.CLAUDE_CONFIG_DIR, 'plugins'), shown: '$CLAUDE_CONFIG_DIR/plugins' });
  }
  const seen = new Set();
  return out.filter((o) => {
    let k = path.resolve(o.base);
    try { k = fs.realpathSync(k); } catch { /* missing: the path itself */ }
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Every SKILL.md under the places. Reads only; follows no symlinked directory. */
export function installed(root, env = process.env) {
  const where = [];
  const files = [];
  for (const o of places(root, env)) {
    const base = { place: o.place, title: o.title, shown: o.shown, count: 0 };
    let st;
    try { st = fs.statSync(o.base); } catch (e) {
      const gone = e?.code === 'ENOENT';
      where.push({ ...base, state: gone ? 'missing' : 'unknown', reason: gone ? 'folder does not exist' : `not readable: ${e?.code || e}` });
      continue;
    }
    if (!st.isDirectory()) { where.push({ ...base, state: 'unknown', reason: 'not a folder' }); continue; }
    let dirs = 0; let capped = false; let failed = 0;
    const stack = [[o.base, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      if (++dirs > MAX_DIRS) { capped = true; break; }
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { failed += 1; continue; }
      if (ents.some((x) => x.isFile() && x.name === 'SKILL.md')) {
        let text = '';
        try { text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch { failed += 1; }
        const fm = frontMatter(text);
        let marker = null;
        if (ents.some((x) => x.isFile() && x.name === reg.MARKER)) {
          try { marker = JSON.parse(fs.readFileSync(path.join(dir, reg.MARKER), 'utf8')); } catch { marker = { broken: true }; }
        }
        files.push({
          place: o.place, path: `${o.shown}/${path.relative(o.base, dir).split(path.sep).join('/') || '.'}`, name: fm.name || path.basename(dir),
          description: (fm.description || '').slice(0, 300),
          memExport: marker ? { id: typeof marker.id === 'string' ? marker.id : null, type: marker.type ?? null } : null,
          _text: text,
        });
        base.count += 1;
      }
      if (depth >= MAX_DEPTH) continue;
      for (const x of ents) {
        if (x.isDirectory() && x.name !== 'node_modules' && x.name !== '.git') stack.push([path.join(dir, x.name), depth + 1]);
      }
    }
    where.push({ ...base, state: capped || failed ? 'unknown' : 'ok',
      reason: capped ? `stopped after ${MAX_DIRS} folders — the count is a lower bound`
        : (failed ? `${failed} folders/files unreadable — the count is a lower bound` : null) });
  }
  files.sort((a, b) => a.place.localeCompare(b.place) || a.path.localeCompare(b.path));
  return { places: where, files };
}

function effectFor(effect, id) {
  if (!effect || !Array.isArray(effect.skills)) return { state: 'unknown', reason: effect?.reason || 'effect not measured' };
  if (effect.state === 'unknown' && !effect.overall) return { state: 'unknown', reason: effect.reason };
  const minN = effect.minN ?? 10;
  const s = effect.skills.find((x) => x.id === id);
  if (!s) return { state: 'unknown', offered: 0, fetched: 0, observed: 0, rate: null, reason: `never offered — too little data (minimum ${minN})` };
  return { state: s.state, offered: s.offered, fetched: s.fetched, observed: s.observed, rate: s.rate,
    reason: s.state === 'measured' ? null : `too little data: ${s.observed} observed (minimum ${minN})` };
}

function driftOf(it, there) {
  if (it.status === 'released' && !there.length) return { kind: 'not-installed', text: 'released, but no SKILL.md from mem skills export found' };
  if (!there.length) return null;
  if (it.status === 'withdrawn') return { kind: 'installed-but-withdrawn', text: 'withdrawn, but still installed as SKILL.md' };
  if (!reg.EXPORTABLE.includes(it.status)) return { kind: 'installed-but-not-released', text: `status ${it.status}, but installed as SKILL.md` };
  if (there.some((d) => d._text !== reg.skillMd(it))) return { kind: 'installed-outdated', text: 'SKILL.md differs from the current registry state (export again)' };
  return null;
}

/**
 * The catalogue. `effect` (skilleffect) may be measured and cached by the
 * caller — it reads the raw capture and is the expensive part.
 * `canSetStatus` / `noButtonReason` come from the server (password session).
 */
export function catalogue(root, { env = process.env, effect = null, canSetStatus = false, noButtonReason = null } = {}) {
  let items;
  try { items = reg.registry(root); } catch (e) {
    return { state: 'unknown', reason: `registry unreadable: ${e?.message || e}`, entries: [], types: [], counts: {}, installed: { places: [], files: [] }, drift: [] };
  }
  const rowCache = new Map();
  const rows = (type, project) => {
    const k = `${type}|${project ?? ''}`;
    if (!rowCache.has(k)) {
      let es = [];
      try { es = memory.readLog(root, type, { project }).entries; } catch { es = []; }
      rowCache.set(k, es);
    }
    return rowCache.get(k);
  };
  const inst = installed(root, env);
  const byId = new Map();
  for (const d of inst.files) {
    if (!d.memExport?.id) continue;
    if (!byId.has(d.memExport.id)) byId.set(d.memExport.id, []);
    byId.get(d.memExport.id).push(d);
  }
  const drift = [];
  const entries = items.map((it) => {
    const e = it.entry;
    const history = historyOf(it, rows(it.type, it.project));
    const there = byId.get(it.id) ?? [];
    const d = driftOf(it, there);
    if (d) drift.push({ ...d, id: it.id, name: it.name, type: it.type, status: it.status });
    const next = transitionsOf(it.status);
    return {
      id: it.id, name: it.name, type: it.type, typeName: TYPE_NAMES[it.type], group: groupOf(it),
      title: shortTitle(e, it.id), titleFull: String(e.title ?? e.rule ?? it.id), when: whenOf(it),
      status: it.status, legacy: it.legacy, mark: it.mark,
      author: procedure.isHuman(e.issued_by) ? e.issued_by : String(e.agent ?? 'unknown'),
      project: it.project, created: it.ts, changed: history.reduce((m, x) => (x.ts > m ? x.ts : m), it.ts),
      label: it.label, triggers: it.triggers, fullText: reg.fullText(it), history,
      effect: effectFor(effect, it.id), installedAs: there.map((x) => ({ place: x.place, path: x.path })), drift: d,
      transitions: next, commands: Object.fromEntries(next.map((s) => [s, statusCommand(it, s)])),
    };
  });
  const known = new Set(items.map((i) => i.id));
  for (const d of inst.files) {
    if (d.memExport && (!d.memExport.id || !known.has(d.memExport.id))) {
      drift.push({ kind: 'installed-without-registry', id: d.memExport.id, name: d.name, type: d.memExport.type, status: null, text: `${d.path}: the marker points at no registry entry` });
    }
  }
  const types = reg.TYPES.map((type) => {
    const mine = entries.filter((x) => x.type === type);
    const groups = new Map();
    for (const x of mine) { if (!groups.has(x.group)) groups.set(x.group, []); groups.get(x.group).push(x.id); }
    return { type, name: TYPE_NAMES[type], count: mine.length,
      groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, ids]) => ({ name, ids })) };
  });
  const counts = {};
  for (const x of entries) counts[x.status] = (counts[x.status] ?? 0) + 1;
  return {
    state: inst.places.some((o) => o.state === 'unknown') ? 'warning' : 'ok',
    entries, types, counts,
    installed: { places: inst.places, files: inst.files.map(({ _text, ...x }) => x) },
    drift,
    effect: effect ? { state: effect.state, reason: effect.reason ?? null, minN: effect.minN, windowMin: effect.windowMin } : { state: 'unknown', reason: 'not measured' },
    manage: {
      canSetStatus: Boolean(canSetStatus), noButtonReason: canSetStatus ? null : (noButtonReason || 'no password session'),
      exportCommand: EXPORT_COMMAND,
      exportReason: 'rolling out has no path through the dashboard server — only the CLI writes SKILL.md files.',
    },
  };
}

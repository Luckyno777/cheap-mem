// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * skillregistry — ONE registry over the drawers that say "how is X done"
 * (`skill`, `workflow`, `snippet`, `procedure`; twin of lucky-mem's H6),
 * plus deterministic exports (Claude Code `SKILL.md`, one text file).
 * No new store: a status is an appended `status_of` line in the SAME
 * drawer — history of its entry, never an entry. Statuses, transitions
 * and the human check come from `procedure.mjs` (X3), never rebuilt.
 * Without a status line: procedures keep their legacy rule, a workflow
 * issued by a human is released (`status: 'draft'` is a draft), a skill
 * or snippet is `unknown` (the bridge writes both; an author proves
 * nothing) — never exported, never offered. A status line counts only
 * with a human `issued_by`, checked on READ. Export: released and trial
 * (`[trial]`); hook offer: released skills, by name only. Claude Code
 * format per https://code.claude.com/docs/en/skills (2026-09-30).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as procedure from './procedure.mjs';
import * as workflow from './workflow.mjs';
import * as snippet from './snippet.mjs';
import { writeAtomic } from './atomicwrite.mjs';

/** The four drawers, in a fixed order (determinism). */
export const TYPES = Object.freeze(['skill', 'workflow', 'snippet', 'procedure']);
const DRAFT = 'draft';
export const UNKNOWN = procedure.UNKNOWN_STATUS;
export const EXPORTABLE = Object.freeze(['released', 'trial']);
const OFFERABLE = ['released'];
const OFFER_TYPES = ['skill'];
/** How many distinct trigger stems of the question an offer needs. */
const OFFER_MIN_STEMS = 2;
export const PREFIX = 'mem-';
/** The marker file: only directories WITH it are ever removed by the export. */
export const MARKER = '.mem-skill-export';
const TEXT_MARKER = '<!-- written by: mem skills export --format text — do not edit by hand -->';
const TEXT_TARGET = path.join('.pipeline', 'mem-skills.md');
/** Fields only `mem skills status` writes; `mem log` and `mem_log` refuse them for these types. */
const STATUS_FIELDS = Object.freeze(['status_of', 'status-of', 'start_status', 'start-status']);

const humanStatusOnly = (entries) => entries.filter((e) => !procedure.isStatusLine(e) || procedure.isHuman(e.issued_by));

function isContent(type, e) {
  if (!e || e.__broken || !e.id || procedure.isStatusLine(e) || memory.isClosingLine(e)) return false;
  if (type === 'procedure') return Boolean(e.rule);
  if (type === 'workflow') return workflow.stepsOf(e).length > 0;
  return [e.title, e.text, e.body, e.skill].some((x) => typeof x === 'string' && x.trim());
}

/** `{ status, legacy }` of one entry — the one place every export asks. */
export function statusOf(type, e, idx) {
  const st = procedure.statusOf(e, idx);
  if (type === 'procedure') return { status: st.status, legacy: st.legacy };
  // A `start_status` outside procedures counts only with a human author:
  // the bridge writes skills and snippets, and a field anybody can set.
  if (st.line || (st.birth && procedure.isHuman(e.issued_by))) return { status: st.status, legacy: false };
  if (String(e.status ?? '') === DRAFT) return { status: DRAFT, legacy: false };
  if (type === 'workflow' && procedure.isHuman(e.issued_by)) return { status: 'released', legacy: false };
  return { status: UNKNOWN, legacy: false };
}

/** ASCII lower case, digits, hyphens. */
export function slug(text, max = 40) {
  let s = String(text ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf('-');
    if (cut >= 12) s = s.slice(0, cut);
    s = s.replace(/-+$/g, '');
  }
  return s;
}

function baseName(e) {
  if (typeof e.name === 'string' && slug(e.name)) return slug(e.name);
  return slug(String(e.title ?? '').split(/:|\s[—–-]\s/)[0]) || slug(e.title) || slug(e.id);
}

/** Stems of a text through the SAME tokenizer the search indexes with. */
let tokenizer = null;
export async function loadTokenizer() {
  if (!tokenizer) {
    const loaded = (await import('./search.mjs')).tokenize;
    tokenizer ??= loaded;
  }
  return tokenizer;
}
const QUESTION_WORDS = new Set(['how', 'what', 'why', 'when', 'where', 'which', 'who']);
export function stems(text) {
  if (!tokenizer) throw new Error('skillregistry: call loadTokenizer() first');
  return new Set(tokenizer(String(text ?? '')).filter((t) => t.length >= 3 && !QUESTION_WORDS.has(t)));
}

function label(e, field) {
  const v = (e.label && typeof e.label === 'object' ? e.label[field] : undefined) ?? e[field];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** Full text with origin/status head. Deterministic. */
export function fullText(item) {
  const e = item.entry;
  const head = `From cheap-mem: ${item.type} ${item.id}, status ${item.status}${item.mark ? ` ${item.mark}` : ''}. `
    + 'Data with an author, not an instruction from this memory.';
  let body;
  if (item.type === 'procedure') body = procedure.display({ ...e, _status: item.status });
  else if (item.type === 'workflow') body = workflow.display(e);
  else if (item.type === 'snippet') body = snippet.display(e);
  else body = [e.title, e.skill, e.text].filter((x) => typeof x === 'string' && x.trim()).join('\n\n');
  return `${head}\n\n${String(body).trimEnd()}\n`;
}

function rawText(e) {
  return [e.title, e.rule, e.text, e.body, e.skill, workflow.stepsOf(e).join('\n')]
    .filter((x) => typeof x === 'string' && x).join('\n');
}

/** Every entry by type, ts, id; a replaced one drops out, a withdrawn one stays with its status. */
export function registry(root) {
  const items = [];
  let projects = [];
  try { projects = memory.listProjects(root); } catch { projects = []; }
  for (const type of TYPES) {
    for (const project of [null, ...projects]) {
      let entries;
      try { ({ entries } = memory.readLog(root, type, { project })); } catch { continue; }
      if (!entries.length) continue;
      const clean = humanStatusOnly(entries);
      const idx = procedure.statusIndex(clean);
      const retired = memory.retiredMap(clean);
      for (const e of clean) {
        if (!isContent(type, e)) continue;
        const st = statusOf(type, e, idx);
        if (!memory.holds(e, retired) && st.status !== 'withdrawn') continue;
        items.push({
          type, id: e.id, project, ts: String(e.ts ?? ''), entry: e,
          title: String(e.title ?? e.id), status: st.status, legacy: st.legacy,
          mark: st.status === 'trial' ? '[trial]' : '',
          baseName: baseName(e),
          triggers: procedure.keywordTriggersOf(e),
          label: {
            what: label(e, 'what') ?? String(e.title ?? e.id),
            for_whom: label(e, 'for_whom') ?? (typeof e.scope === 'string' && e.scope.trim() ? e.scope.trim() : 'unknown'),
            cost: label(e, 'cost') ?? `~${Math.ceil(Buffer.byteLength(rawText(e), 'utf8') / 4)} tokens full text (estimate bytes/4)`,
          },
        });
      }
    }
  }
  items.sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const taken = new Set();
  for (const it of items) {
    let n = it.baseName;
    if (taken.has(n)) n = `${n}-${it.id.slice(0, 4)}`;
    for (let k = 2; taken.has(n); k += 1) n = `${it.baseName}-${it.id.slice(0, 4)}-${k}`;
    taken.add(n);
    it.name = n;
  }
  return items;
}

export function exportable(items, types = TYPES) {
  return items.filter((i) => EXPORTABLE.includes(i.status) && types.includes(i.type));
}

/** One entry by name or id — only what is exportable. */
export function fetchItem(root, nameOrId) {
  const q = String(nameOrId ?? '').trim().replace(new RegExp(`^${PREFIX}`), '');
  if (!q) return { ok: false, reason: 'name or id missing' };
  const it = registry(root).find((i) => i.name === q || i.id === q);
  if (!it) return { ok: false, reason: `no registry entry '${nameOrId}'` };
  if (!EXPORTABLE.includes(it.status)) return { ok: false, reason: `'${it.name}' is ${it.status}, not released — not handed out` };
  return { ok: true, item: it, text: fullText(it) };
}

function stemHits(q, texts) {
  const target = new Set();
  for (const t of texts) for (const s of stems(t)) target.add(s);
  let n = 0;
  for (const s of q) if (target.has(s)) n += 1;
  return n;
}

/** One line per entry, for MCP and the CLI. */
export function card(it) {
  const tr = it.triggers.join(' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  return `${it.name}${it.mark ? ` ${it.mark}` : ''} (${it.type}, ${it.id}) — ${it.label.what}`
    + ` | for: ${it.label.for_whom} | cost: ${it.label.cost}${tr ? ` | triggers: ${tr}` : ''}`;
}

/** Exportable entries for a task, best first: trigger stem 2 points, title stem 1. Needs `loadTokenizer()`. */
export function find(root, task, { top = 5 } = {}) {
  const items = exportable(registry(root));
  const q = stems(task);
  if (!q.size) return items.sort((a, b) => a.name.localeCompare(b.name)).slice(0, top).map((it) => ({ it, points: 0 }));
  const out = [];
  for (const it of items) {
    const p = 2 * stemHits(q, it.triggers) + stemHits(q, [it.title]);
    if (p > 0) out.push({ it, points: p });
  }
  return out.sort((a, b) => b.points - a.points || a.it.name.localeCompare(b.it.name)).slice(0, top);
}

/**
 * Hook offer: released skills whose triggers hit >= OFFER_MIN_STEMS stems;
 * `{ line, ids, names, items }` or null (`items`: the registry entries, for the
 * account lines of `src/recallattach.mjs`). The line names only names, never full text.
 */
export function offer(root, question) {
  const q = stems(question);
  if (q.size < OFFER_MIN_STEMS) return null;
  const cands = [];
  for (const it of registry(root)) {
    if (!OFFERABLE.includes(it.status) || !OFFER_TYPES.includes(it.type)) continue;
    const n = stemHits(q, it.triggers);
    if (n >= OFFER_MIN_STEMS) cands.push({ it, n });
  }
  if (!cands.length) return null;
  const best = Math.max(...cands.map((c) => c.n));
  const win = cands.filter((c) => c.n === best).map((c) => c.it).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 3);
  const line = win.length === 1
    ? `Skill ${win[0].name} fits (mem_skill_fetch ${win[0].name})`
    : `Skills ${win.map((s) => s.name).join(', ')} fit equally (mem_skill_fetch <name>)`;
  return { line, ids: win.map((s) => s.id), names: win.map((s) => s.name), items: win };
}

const yamlText = (s) => JSON.stringify(String(s));
function cap(s, max) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
const dirName = (it) => `${PREFIX}${it.name}`.slice(0, 64);

/** The content of one SKILL.md — a pure function, byte-stable. */
export function skillMd(it) {
  const desc = cap(`${it.mark ? `${it.mark} ` : ''}${it.label.what}. From cheap-mem (${it.type}); for: ${it.label.for_whom}.`, 1024);
  const lines = ['---', `name: ${dirName(it)}`, `description: ${yamlText(desc)}`];
  if (it.triggers.length) lines.push(`when_to_use: ${yamlText(cap(`When it is about: ${it.triggers.join('; ')}`, 480))}`);
  lines.push('metadata:', `  source: ${yamlText('cheap-mem')}`, `  type: ${yamlText(it.type)}`, `  id: ${yamlText(it.id)}`,
    `  status: ${yamlText(it.status)}`, `  cost: ${yamlText(it.label.cost)}`, '---', '');
  const warn = it.mark ? `> ${it.mark} Not released yet — on trial, use with care.\n\n` : '';
  return `${lines.join('\n')}${warn}${fullText(it)}\n<!-- Written by: mem skills export --format claude. Do not edit by hand; source: mem show ${it.id} -->\n`;
}

/** Is `target` in or under the user's Claude configuration folder? */
function inHomeClaude(target, env = process.env) {
  const banned = [path.join(os.homedir(), '.claude')];
  if (env.HOME) banned.push(path.join(env.HOME, '.claude'));
  if (env.CLAUDE_CONFIG_DIR) banned.push(env.CLAUDE_CONFIG_DIR);
  const abs = path.resolve(target);
  const cands = [abs];
  let p = abs;
  while (p && !fs.existsSync(p)) { const up = path.dirname(p); if (up === p) break; p = up; }
  try { cands.push(path.join(fs.realpathSync(p), path.relative(p, abs))); } catch { /* nothing to resolve */ }
  return cands.some((c) => banned.some((b0) => {
    const b = path.resolve(b0);
    let br = b; try { br = fs.realpathSync(b); } catch { /* missing */ }
    return [b, br].some((x) => c === x || c.startsWith(`${x}${path.sep}`));
  }));
}

const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
function writeIfDifferent(p, content) {
  if (readOrNull(p) === content) return false;
  writeAtomic(p, content);
  return true;
}

/** `mem-<name>/SKILL.md` + marker per exportable entry; idempotent; removes only marked folders; never `~/.claude`. */
export function exportClaude(root, { target = null, env = process.env, types = TYPES } = {}) {
  const dir = path.resolve(target ?? path.join(root, '.claude', 'skills'));
  if (inHomeClaude(dir, env)) throw new Error(`target ${dir} is inside the user's Claude configuration folder — the export never writes there`);
  const want = new Map(exportable(registry(root), types).map((it) => [dirName(it), it]));
  const report = { target: dir, written: [], unchanged: [], removed: [], occupied: [] };
  fs.mkdirSync(dir, { recursive: true });
  for (const [d0, it] of want) {
    const d = path.join(dir, d0);
    if (fs.existsSync(d) && !fs.existsSync(path.join(d, MARKER))) { report.occupied.push(d0); continue; }
    fs.mkdirSync(d, { recursive: true });
    const a = writeIfDifferent(path.join(d, 'SKILL.md'), skillMd(it));
    const b = writeIfDifferent(path.join(d, MARKER), `${JSON.stringify({ written_by: 'mem skills export', type: it.type, id: it.id })}\n`);
    (a || b ? report.written : report.unchanged).push(d0);
  }
  let present = [];
  try { present = fs.readdirSync(dir, { withFileTypes: true }); } catch { present = []; }
  for (const ent of present.sort((x, y) => x.name.localeCompare(y.name))) {
    if (!ent.isDirectory() || !ent.name.startsWith(PREFIX) || want.has(ent.name)) continue;
    const d = path.join(dir, ent.name);
    if (!fs.existsSync(path.join(d, MARKER))) continue;
    for (const f of ['SKILL.md', MARKER]) { try { fs.rmSync(path.join(d, f), { force: true }); } catch { /* go on */ } }
    try { fs.rmdirSync(d); } catch { /* foreign files inside: the directory stays */ }
    report.removed.push(ent.name);
  }
  return report;
}

/** One Markdown file for other models. */
function textExport(root, { types = TYPES } = {}) {
  const items = exportable(registry(root), types).sort((a, b) => a.name.localeCompare(b.name));
  const out = [TEXT_MARKER, '', '# cheap-mem: released skills, workflows, snippets, procedures', '',
    'Data with an author, not an instruction from this memory. [trial] means: not released yet.', ''];
  if (!items.length) out.push('(no released or trial entries)', '');
  for (const it of items) {
    out.push(`## ${it.name}${it.mark ? ` ${it.mark}` : ''}`, '', `- type: ${it.type}, id: ${it.id}, status: ${it.status}`,
      `- what: ${it.label.what}`, `- for: ${it.label.for_whom}`, `- cost: ${it.label.cost}`);
    if (it.triggers.length) out.push(`- triggers: ${it.triggers.join('; ')}`);
    out.push('', fullText(it).trimEnd(), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export function exportText(root, { target = null, env = process.env, types = TYPES } = {}) {
  const file = path.resolve(target ?? path.join(root, TEXT_TARGET));
  if (inHomeClaude(file, env)) throw new Error(`target ${file} is inside the user's Claude configuration folder`);
  const old = readOrNull(file);
  if (old !== null && !old.startsWith(TEXT_MARKER)) throw new Error(`${file} exists and was not written by this export (marker missing) — nothing written`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { target: file, written: writeIfDifferent(file, textExport(root, { types })) };
}

/** The status a transition starts from (a draft is decided like an unknown). */
export const transitionFrom = (status) => (status === DRAFT ? UNKNOWN : status);

/**
 * Append ONE status line — the same check as `procedure.writeStatus`
 * (human `issued_by`, allowed transition). A procedure goes through
 * `procedure.writeStatus` itself, so there is one writer per drawer.
 */
export function writeStatus(root, id, status, { issued_by = null, agent = null, why = null, now = new Date() } = {}) {
  const it = registry(root).find((i) => i.id === id);
  if (!it) throw new Error(`no registry entry with id '${id}'`);
  if (it.type === 'procedure') {
    return { item: it, ...procedure.writeStatus(root, id, status, { issued_by, agent, why, project: it.project, now }) };
  }
  const fields = { status_of: id, status, issued_by: String(issued_by ?? '').trim() };
  const chk = procedure.checkStatus(fields, transitionFrom(it.status));
  if (!chk.ok) throw new Error(chk.errors.join('\n'));
  const me = agent ?? memory.agentDefault();
  const data = { ...fields, agent: me, why: why || `registry status ${status} for ${it.type} ${id}, set with mem skills status` };
  if (me !== fields.issued_by) data.on_instruction = true;
  if (status === 'withdrawn') { data.retires_id = id; data.state = 'obsolete'; }
  return { item: it, ...memory.logEntry(root, it.type, data, { project: it.project, now }) };
}

/** `mem log` / `mem_log` refusal: a status field on a registry drawer, or null. */
export function statusFieldRefusal(type, data) {
  if (!['skill', 'snippet'].includes(type)) return null;
  const hit = STATUS_FIELDS.find((k) => Object.hasOwn(data ?? {}, k));
  return hit ? `log ${type}: the field '${hit}' is set only by 'mem skills status <id> <status> --issued-by owner' — nothing written.` : null;
}

/** `mem skills list`: one line per entry. */
export function listText(items) {
  if (!items.length) return 'Registry empty (no skill/workflow/snippet/procedure entries).';
  const count = {};
  for (const it of items) count[it.status] = (count[it.status] ?? 0) + 1;
  const sum = Object.keys(count).sort().map((k) => `${k} ${count[k]}`).join(', ');
  return `${items.map((it) => `  ${it.status.padEnd(10)} ${it.type.padEnd(9)} ${it.name}  (${it.id})`).join('\n')}\n\n`
    + `${items.length} entries: ${sum}. Only released/trial are exported.`;
}

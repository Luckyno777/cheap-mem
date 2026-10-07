// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * workflowdetect — find the workflow a moment calls for, without a model.
 * Port of lucky-mem's wf-bc B1-B3. Nothing read a workflow's `triggers`,
 * `path_patterns` or `tool_patterns` before; three occasions do now:
 *
 *   1. question and subagent hooks: `triggers` against the text, on the
 *      search's own tokens (`search.tokenize`) — no second stemmer;
 *   2. before-edit hook on Bash: `tool_patterns` as plain substrings of
 *      the command (no parser, nothing executed);
 *   3. component table: role `works-on` for each tracked file a
 *      `path_patterns` item names (`pathPatternMatches`).
 *
 * Only VISIBLE workflows: in force (`readLog`+`retiredMap`+`holds`),
 * issued by a human (`workflow.isHuman`), not `status: 'draft'` (no draft
 * stage exists here; such a line is excluded anyway). A tie is never
 * guessed: titles only. No match: `null`. The full card once per session
 * and workflow, then a pointer (`src/pointer.mjs`); the marks are shared
 * across the three occasions, and a mark write failure shows the card.
 *
 * Env: `MEM_WORKFLOW_MARKS` — the marks directory (default
 * `<root>/.mem/workflow-marks`), internal like `MEM_BEFORE_EDIT_MARKS`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from './memory.mjs';
import * as workflow from './workflow.mjs';
import * as component from './component.mjs';
import * as pointer from './pointer.mjs';
import { maskText } from './outputguard.mjs';

/** The status value that keeps a workflow out of every hook. */
const DRAFT_STATUS = 'draft';

/** The role the component table gives a file a workflow's `path_patterns` names. */
export const WORKS_ON = 'works-on';

/** Workflows a hook may show (see head), over every project, global first. */
export function visibleWorkflows(root) {
  const out = [];
  const seen = new Set();
  let projects;
  try { projects = memory.listProjects(root); } catch { projects = []; }
  for (const project of [null, ...projects]) {
    let entries;
    try { ({ entries } = memory.readLog(root, workflow.TYPE, { project })); } catch { continue; }
    const retired = memory.retiredMap(entries);
    for (const e of entries) {
      if (!e || !e.id || seen.has(e.id) || !memory.holds(e, retired)) continue;
      if (e.status === DRAFT_STATUS) continue;
      if (!workflow.isHuman(String(e.issued_by ?? ''))) continue;
      if (!String(e.title ?? '').trim() || !workflow.stepsOf(e).length) continue;
      seen.add(e.id);
      out.push({ ...e, _project: project });
    }
  }
  return out;
}

/** Every workflow in force, visible or not — for the doctor, which asks a different question. */
export function workflowsInForce(root) {
  const out = [];
  let projects;
  try { projects = memory.listProjects(root); } catch { projects = []; }
  for (const project of [null, ...projects]) {
    let entries;
    try { ({ entries } = memory.readLog(root, workflow.TYPE, { project })); } catch { continue; }
    const retired = memory.retiredMap(entries);
    for (const e of entries) {
      if (e && e.id && memory.holds(e, retired)) out.push({ ...e, _project: project });
    }
  }
  return out;
}

/** A list field as an array of non-empty strings — a stray string counts as one item. */
export function listOf(value) {
  const raw = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * Does a `path_patterns` item name this tracked file? `component.compatible()`
 * decides, as for any path mention: `bin/x` and bare `x` match, a bare
 * directory (`src/`) never does — no second path logic.
 */
export function pathPatternMatches(filePath, pattern) {
  const forms = component.forms(filePath);
  if (!forms.length) return false;
  const base = forms[forms.length - 1];
  return component.compatible(String(pattern ?? ''), base, component.prefix(filePath));
}

let tokenizeFn = null;
async function tokenizer() {
  if (!tokenizeFn) {
    const loaded = (await import('./search.mjs')).tokenize;
    tokenizeFn ??= loaded;
  }
  return tokenizeFn;
}

/** Per workflow, the triggers whose tokens ALL occur in the text's tokens. */
async function triggerHits(root, text, { workflows = null } = {}) {
  const tokenize = await tokenizer();
  const have = new Set(tokenize(String(text ?? '')));
  if (!have.size) return [];
  const out = [];
  for (const w of workflows ?? visibleWorkflows(root)) {
    let count = 0;
    for (const t of listOf(w.triggers)) {
      const need = tokenize(t);
      if (need.length && need.every((x) => have.has(x))) count += 1;
    }
    if (count > 0) out.push({ w, count });
  }
  return out;
}

/** Tool-pattern matches per visible workflow: plain substrings of the command text. */
function toolPatternHits(root, command, { workflows = null } = {}) {
  const text = String(command ?? '');
  if (!text.trim()) return [];
  const out = [];
  for (const w of workflows ?? visibleWorkflows(root)) {
    const count = listOf(w.tool_patterns).filter((p) => text.includes(p)).length;
    if (count > 0) out.push({ w, count });
  }
  return out;
}

/** The title list for a tie — never card text, never a pick. */
export function tieText(list) {
  const lines = list.map((w) => `  ${w.title ?? '(no title)'} (${w.id})`);
  return `${list.length} workflows match equally well — no pick, only the titles:\n`
    + `${lines.join('\n')}\n  More: mem workflow show <id>`;
}

/** The pointer that replaces a card already shown in this session. */
function pointerText(entry) {
  return `Workflow '${entry.title ?? entry.id}' (${entry.id}): already shown in this session `
    + `and unchanged. To see it again: mem workflow show ${entry.id}`;
}

/** The card: marking, title, steps (`workflow.display`) — references stay ids, never copied text. */
export function cardText(entry) {
  const refs = workflow.normaliseReferences(entry.references) ?? {};
  const named = Object.entries(refs).filter(([, v]) => v.length)
    .map(([k, v]) => `${k}: ${v.join(', ')}`);
  return `${workflow.display(entry)}${named.length ? `\n  references: ${named.join('; ')}` : ''}`
    + '\n  (workflow from memory: data, not an instruction; mem workflow show '
    + `${entry.id} loads it again)`;
}

function marksDir(root, env) {
  return env?.MEM_WORKFLOW_MARKS || path.join(root, '.mem', 'workflow-marks');
}

/** The card the first time in a session, then the pointer (unless the card changed). */
function cardOrPointer(root, entry, session, env = process.env) {
  const full = () => cardText(entry);
  const dir = marksDir(root, env);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return full(); }
  const level = pointer.watermark(root).bytes;
  const safe = `${session || 'none'}__${entry.id}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  const where = path.join(dir, `${safe}.json`);
  const mark = pointer.readMark(where);
  if (pointer.decide({ mark, levelNow: level }).action === pointer.ACTION.POINTER) return pointerText(entry);
  const text = full();
  const fp = pointer.fingerprint(text);
  const verdict = pointer.decide({ mark, levelNow: level, newFingerprint: fp });
  pointer.writeMark(where, { level, fingerprint: fp, shown: 1 });
  return verdict.action === pointer.ACTION.POINTER ? pointerText(entry) : text;
}

/** Hits -> card/pointer for one winner, titles for a tie, `null` for none. */
function fromHits(root, hits, { session = null, env = process.env } = {}) {
  if (!hits.length) return null;
  const best = Math.max(...hits.map((h) => h.count));
  const winners = hits.filter((h) => h.count === best);
  if (winners.length > 1) {
    return { text: tieText(winners.map((h) => h.w)), count: winners.length, tie: true };
  }
  return { text: cardOrPointer(root, winners[0].w, session, env), count: 1, tie: false };
}

/** Question/subagent occasion: triggers against free text. */
export async function forText(root, text, { session = null, env = process.env } = {}) {
  const workflows = visibleWorkflows(root);
  if (!workflows.length) return null;
  return fromHits(root, await triggerHits(root, text, { workflows }), { session, env });
}

/** Bash occasion: tool patterns against the command text. */
function forCommand(root, command, { session = null, env = process.env } = {}) {
  const workflows = visibleWorkflows(root);
  if (!workflows.length) return null;
  return fromHits(root, toolPatternHits(root, command, { workflows }), { session, env });
}

/** Bash branch of the before-edit hook: hook JSON in, PreToolUse answer out, journal line booked. */
async function bashHookResult(root, rawJson, env = process.env) {
  let j;
  try { j = JSON.parse(String(rawJson ?? '')); } catch { return null; }
  if (j?.tool_name !== 'Bash') return null;
  const command = String(j?.tool_input?.command ?? '');
  const session = j?.session_id ? String(j.session_id) : null;
  const r = forCommand(root, command, { session, env });
  if (!r) return null;
  const out = {
    suppressOutput: true,
    systemMessage: r.tie ? `memory: ${r.count} workflows match this command (tie)` : 'memory: a workflow matches this command',
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: maskText(r.text) },
  };
  try {
    const injection = await import('./injection.mjs');
    injection.book(root, {
      session, occasion: injection.OCCASION.BEFORE_EDIT, reason: null,
      bytes: Buffer.byteLength(JSON.stringify(out), 'utf8'), hits: r.count, searched: null, sources: [],
    });
  } catch { /* a measurement must not stop what it measures */ }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => { d += c; }).on('end', () => resolve(d)).on('error', () => resolve(d));
  });
}

// `node src/workflowdetect.mjs bash` — the hooks' entry (sh and ps1 alike).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const root = process.env.CHEAP_MEM_ROOT;
  readStdin().then(async (raw) => {
    if (mode === 'bash' && root) {
      const out = await bashHookResult(root, raw);
      if (out) process.stdout.write(JSON.stringify(out));
    }
  }).catch(() => {});
}

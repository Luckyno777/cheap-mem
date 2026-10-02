// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * workflowdetect — find the workflow a moment calls for, without a model.
 *
 * **The gap this closes.** `workflow` has been a type here since A1-A3:
 * a human writes down "this is how a task like this goes", with
 * `triggers`, `path_patterns` and `tool_patterns` saying WHEN it
 * applies. Nothing ever read those three fields. A workflow was only
 * ever seen by whoever already knew its id — the one person who did not
 * need reminding.
 *
 * **Three fixed occasions, one shared basis here.** Parity build for
 * lucky-mem's wf-bc B1-B3 (`bauteil-tabelle.sichtbareWorkflows`, the
 * workflow block in its `hook.mjs`):
 *
 *   1. the question hook (UserPromptSubmit, `src/recallhook.mjs`) and
 *      the subagent hook (SubagentStart, `src/subagentstart.mjs`) match
 *      `triggers` against the text, word by word on the SAME tokens the
 *      search uses (`search.tokenize`: lower case, stop words out, base
 *      forms) — so "releasing" meets a trigger "release" the way a search
 *      would, and no second stemmer exists to drift from the first;
 *   2. the before-edit hook on a Bash call (`bin/mem-before-edit`)
 *      matches `tool_patterns` against the command text as plain
 *      substrings — no shell parser, nothing executed, the same blunt
 *      text check `prepush.mjs` applies to a push command;
 *   3. the component table (`src/component-table.mjs`) maps every
 *      tracked file a workflow's `path_patterns` names to that workflow,
 *      role `works-on`, through `pathPatternMatches()` below.
 *
 * **Only VISIBLE workflows.** In force (not retired, not superseded —
 * the same `readLog` + `retiredMap` + `holds` every procedure lane uses),
 * issued by a human (`workflow.isHuman`, the one authority check), and
 * not a draft (`status: 'draft'`). This house has no draft stage — a
 * workflow is issued by a human or not written at all (`workflow.mjs`'s
 * head comment) — but a line carrying `status: 'draft'` (imported, or
 * written around the CLI) is excluded anyway, so a later draft stage
 * cannot leak into the hooks without this file being asked.
 *
 * **A tie is never guessed.** Two or more workflows with the same,
 * highest number of matches yield a title list and NO card text of any
 * of them. No match yields `null` — never a "closest" substitute.
 *
 * **Full card once per session, then a pointer** (`src/pointer.mjs`,
 * the same watermark/fingerprint mechanism the before-edit hook uses).
 * The marks are per session and workflow, SHARED across all three
 * occasions: the same workflow seen first at a question and then at a
 * Bash call is "already shown". A write failure on the mark directory
 * shows the full card every time — failing open towards showing.
 *
 * Env: `MEM_WORKFLOW_MARKS` — where the once-per-session marks live
 * (default `<root>/.mem/workflow-marks`). Internal to the hooks and the
 * tests, like `MEM_BEFORE_EDIT_MARKS`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from './memory.mjs';
import * as workflow from './workflow.mjs';
import * as component from './component.mjs';
import * as pointer from './pointer.mjs';

/** The status value that keeps a workflow out of every hook. */
export const DRAFT_STATUS = 'draft';

/** The role the component table gives a file a workflow's `path_patterns` names. */
export const WORKS_ON = 'works-on';

/**
 * Every workflow a hook may show: in force, issued by a human, not a
 * draft, with a title and at least one step. Across every project, the
 * first occurrence of an id wins (global first).
 */
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
 * Does `pattern` (one `path_patterns` item) name `filePath` (a tracked
 * repo file)? No new path logic: the file is treated like a component
 * QUESTION (`component.forms()`/`prefix()`), the pattern like the TEXT
 * that has to name its base name compatibly (`component.compatible()`).
 * So `bin/mem-before-edit` and bare `mem-before-edit` both match that
 * file; a bare directory (`src/`) matches nothing — the same deliberate
 * limit every other use of `compatible()` in this house keeps: a narrower,
 * honest hit set over a guessed directory reach.
 */
export function pathPatternMatches(filePath, pattern) {
  const forms = component.forms(filePath);
  if (!forms.length) return false;
  const base = forms[forms.length - 1];
  return component.compatible(String(pattern ?? ''), base, component.prefix(filePath));
}

let tokenizeFn = null;
async function tokenizer() {
  if (!tokenizeFn) tokenizeFn = (await import('./search.mjs')).tokenize;
  return tokenizeFn;
}

/**
 * Trigger matches per visible workflow. A trigger counts when EVERY one
 * of its tokens is among the text's tokens (a one-word trigger is a
 * plain stem match; "release notes" needs both words). A trigger made
 * only of stop words has no tokens and never counts. `[]` = no match.
 */
export async function triggerHits(root, text, { workflows = null } = {}) {
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
export function toolPatternHits(root, command, { workflows = null } = {}) {
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
export function pointerText(entry) {
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

/**
 * Full card the first time this workflow is shown in this session, a
 * one-line pointer after that (unless the memory changed AND the card
 * with it). See the head comment for why the marks are shared.
 */
export function cardOrPointer(root, entry, session, env = process.env) {
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

/**
 * From a hit list `{w, count}[]` to the text a hook adds: the card (or
 * its pointer) for a single winner, the title list for a tie, `null`
 * for no hit. The one decision rule for all three occasions.
 */
export function fromHits(root, hits, { session = null, env = process.env } = {}) {
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
export function forCommand(root, command, { session = null, env = process.env } = {}) {
  const workflows = visibleWorkflows(root);
  if (!workflows.length) return null;
  return fromHits(root, toolPatternHits(root, command, { workflows }), { session, env });
}

/**
 * The before-edit hook's Bash branch, as one call: hook JSON in, the
 * PreToolUse answer out (or `null`), and the journal line booked
 * (occasion `before-edit`, `reason: null` — something WAS shown).
 */
export async function bashHookResult(root, rawJson, env = process.env) {
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
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: r.text },
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

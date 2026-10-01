// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * repetitionhint — from the THIRD repetition of an error class, or of
 * the same normalised title, a draft for a procedure (parity with the
 * sibling's W11, commit 9847a03).
 *
 * The threshold is a plain count over the WHOLE log, no time window: at
 * three repetitions a window is not precision, only a chance to just
 * miss the third. Two ways to repeat: the error CLASS, or the same
 * TITLE, normalised — two errors with the same title may carry
 * different classes (a title is often written before a clean
 * classification) and would stay invisible to a class count alone.
 *
 * **No model.** The draft text comes ONLY from the newest error of the
 * group: its `remedy` / `correct` field if set, else the first sentence
 * of its `text` that carries a correction marker ("fixed", "guard",
 * "corrected", "resolved", "the right way is"), else the plain first
 * sentence, marked as an unchecked excerpt. Nothing is summarised or
 * invented. A procedure is a human's act (`mem log procedure --issued-by
 * owner`): this module writes NOTHING, it only prints the command.
 *
 * **Skip rule.** A class that already has a procedure in force
 * (`procedure.forClass`) is not proposed, neither as its own candidate
 * nor as a title candidate whose errors ALL belong to covered classes.
 */
import * as memory from './memory.mjs';
import * as errorclass from './errorclass.mjs';
import * as procedure from './procedure.mjs';

export const THRESHOLD = 3;

/** Marker words that make a sentence "names the right way". */
const CORRECTION_SENTENCE = /[^.?!\n]*\b(fixed|remedy|guard|corrected|resolved|improved|the right way is|right way)\b[^.?!\n]*[.?!]?/i;

/**
 * The sentence that names the right way — never invented, only quoted
 * or cut out.
 */
export function correctPathText(entry) {
  for (const f of ['remedy', 'correct']) {
    if (typeof entry?.[f] === 'string' && entry[f].trim()) return entry[f].trim();
  }
  const text = String(entry?.text ?? '').trim();
  if (!text) return '(no text in the newest error)';
  const hit = CORRECTION_SENTENCE.exec(text);
  if (hit) return hit[0].trim();
  const first = text.split(/(?<=[.?!])\s+/)[0] ?? text;
  return `(no correction marker found, first sentence) ${first}`;
}

/** Title reduced to a comparable core: case, punctuation, runs of blanks gone. */
function normaliseTitle(title) {
  return String(title ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function allErrors(root) {
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    let entries;
    try { ({ entries } = memory.readLog(root, 'error', { project })); } catch { continue; }
    for (const e of entries) {
      if (!e || e.__broken || memory.isClosingLine(e)) continue;
      out.push(e);
    }
  }
  return out;
}

const newest = (list) => [...list].sort((a, b) => Date.parse(b.ts ?? 0) - Date.parse(a.ts ?? 0))[0];

/** Does a procedure in force already name this class? */
export function covered(root, cls) {
  try { return procedure.forClass(root, cls).length > 0; } catch { return false; }
}

/**
 * Candidates: `{ kind: 'class' | 'title', key, count, newest }`, plus
 * the totals. `total === 0` means nothing to measure, not "no candidate".
 */
export function candidates(root, { all = null } = {}) {
  const errors = all ?? allErrors(root);
  const byClass = new Map();
  const byTitle = new Map();
  for (const e of errors) {
    const c = errorclass.normalise(e.class);
    if (c) { if (!byClass.has(c)) byClass.set(c, []); byClass.get(c).push(e); }
    const t = normaliseTitle(e.title);
    if (t) { if (!byTitle.has(t)) byTitle.set(t, []); byTitle.get(t).push(e); }
  }
  const out = [];
  for (const [cls, list] of byClass) {
    if (list.length < THRESHOLD || covered(root, cls)) continue;
    out.push({ kind: 'class', key: cls, count: list.length, newest: newest(list) });
  }
  for (const [title, list] of byTitle) {
    if (list.length < THRESHOLD) continue;
    const classes = [...new Set(list.map((e) => errorclass.normalise(e.class)).filter(Boolean))];
    if (classes.length && classes.every((c) => covered(root, c))) continue;
    // Already reported as a class candidate? Then not twice.
    if (out.some((k) => k.kind === 'class' && classes.includes(k.key)
      && list.every((e) => errorclass.normalise(e.class) === k.key))) continue;
    out.push({ kind: 'title', key: title, count: list.length, newest: newest(list) });
  }
  return { total: errors.length, classes: byClass.size, titles: byTitle.size, list: out };
}

/**
 * The ready `mem log procedure ...` draft for one class — the same
 * source the doctor finding shows, here on its own. Writes nothing.
 */
export function suggestProcedure(root, rawClass) {
  const cls = errorclass.normalise(rawClass);
  if (!cls) {
    return { ok: false, reason: `'${rawClass}' is not a valid error class (mem classes lists the twelve).` };
  }
  if (covered(root, cls)) {
    return { ok: false, reason: `class '${cls}' already has a procedure in force (mem procedures shows it).` };
  }
  const hits = allErrors(root).filter((e) => errorclass.normalise(e.class) === cls);
  if (!hits.length) return { ok: false, reason: `no error entries of class '${cls}'.` };
  const latest = newest(hits);
  const q = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  const rule = q(correctPathText(latest));
  const title = q(latest.title ?? cls);
  const command = `mem log procedure --title "${q(cls)}: ${title}" --rule "${rule}" `
    + `--on-class ${cls} --issued-by owner`;
  return { ok: true, command, source: latest.id, count: hits.length };
}

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/probescaffold.mjs — an error logged with a file brings its own
// test scaffold along.
//
// Parity build for lucky-mem's M12 (BAUPLAN-mem-admin_02.md §0 rule 2,
// commit range around 2026-09-27): measured there, only 4 of 849 errors
// carried a latch. The step from error to probe is its own handgrip
// (create a file, set the marker, think through three sections), and
// that is exactly the step that gets skipped. `mem log error --file
// <path>` therefore lays down `test/error-<id>.test.mjs` immediately:
// the marker `// error: <id>` and the three sections F4
// (`memory.dutyHasEvidence`) already asks for — sabotage, positive
// control, red on the old stand.
//
// **Empty is not passing.** A scaffold that would read as a green test
// would be worse than none: it would look like a latch and catch
// nothing. So two things:
//   1. All three sections are `test.todo(...)` with a reason — the test
//      run shows them as open (todo), never as passed.
//   2. The line `// scaffold: empty` (and any remaining `test.todo(`)
//      keeps the file worthless for F4 (`memory.dutyHasEvidence`): a
//      duty grown from this error does not close on an empty scaffold.
// The rule "is this scaffold still empty" lives in exactly ONE place,
// `isEmpty()` here; `guardShare()`/`quote()` below ask it, and nothing
// else re-derives it.

import fs from 'node:fs';
import path from 'node:path';

/** The marker that flags a scaffold as not yet filled in. */
export const EMPTY_MARK = '// scaffold: empty';

/** Where one error's scaffold lives (relative to the memory root). */
export function relPath(id) {
  return path.join('test', `error-${String(id)}.test.mjs`);
}

/**
 * Empty means: the marker is still there, OR a section is still
 * `test.todo(`. Either counts on its own — deleting the marker and
 * leaving the todos in place has still proven nothing.
 */
export function isEmpty(text) {
  const t = String(text ?? '');
  return t.split('\n').some((l) => l.trim() === EMPTY_MARK || l.trim().startsWith(`${EMPTY_MARK} `))
    || /\btest\.todo\(/.test(t);
}

const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/** The scaffold's text. A pure function — writes nothing. */
export function text(entry) {
  const id = String(entry.id);
  const title = oneLine(entry.title ?? entry.text ?? '(no title)').slice(0, 160);
  const file = oneLine(entry.file ?? (Array.isArray(entry.files) ? entry.files.join(', ') : ''));
  const why = 'scaffold empty — empty is not passing';
  const q = (s) => JSON.stringify(s);
  return [
    `// Test scaffold for error ${id} (created by \`mem log error\`, ${oneLine(entry.ts)}).`,
    `// Title: ${title}`,
    `// File: ${file}`,
    `// error: ${id}`,
    EMPTY_MARK,
    '//   As long as this line or a todo section is still here, the file does',
    '//   NOT count as evidence (F4): a duty grown from this error does not',
    '//   close on it. Fill all three sections, then delete this line.',
    "import test from 'node:test';",
    "import assert from 'node:assert/strict'; // eslint-disable-line no-unused-vars",
    '',
    '// --- Sabotage --------------------------------------------------------',
    '// Bring the error about on purpose (input, state, file). The probe',
    '// MUST catch it, i.e. go red.',
    `test.todo(${q(`Sabotage: ${title} — ${why}`)});`,
    '',
    '// --- Positive control -------------------------------------------------',
    '// The healthy case right next to it MUST be green — otherwise the',
    '// probe is only ever red and proves nothing.',
    `test.todo(${q(`Positive control: healthy case for ${id} — ${why}`)});`,
    '',
    '// --- Red on the old stand ---------------------------------------------',
    '// The SAME probe on the stand BEFORE the fix (own worktree, never',
    "// stash) has to be red. Note the old stand's commit here.",
    `test.todo(${q(`Red on the old stand: probe for ${id} before the fix — ${why}`)});`,
    '',
  ].join('\n');
}

/**
 * Lays down the scaffold, when the entry carries an EXPLICIT file
 * (`file`/`files` — a statement, not a guessed path pattern). Never
 * overwrites: if the file is already there, it stays, and that is
 * reported.
 *
 * Returns `{ created, path?, why? }`.
 */
export function lay(root, entry) {
  const hasFile = (typeof entry?.file === 'string' && entry.file.trim())
    || (Array.isArray(entry?.files) && entry.files.some((f) => typeof f === 'string' && f.trim()));
  if (!entry?.id) return { created: false, why: 'entry without id' };
  if (!hasFile) return { created: false, why: 'no file given (--file)' };
  const rel = relPath(entry.id);
  const full = path.join(root, rel);
  if (fs.existsSync(full)) return { created: false, path: rel, why: 'already there, not overwritten' };
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text(entry), { flag: 'wx' });
  return { created: true, path: rel };
}

/**
 * The measure: share of errors carrying a guard.
 *
 * An error has a guard when it carries a `guard` field OR a NON-empty
 * test file under `test/` contains its marker `// error: <id>` AND
 * `test(` — the same rule `dutyHasEvidence` (F4) uses. Empty scaffolds
 * are counted separately — they are the stall condition ("scaffolds
 * sit there empty").
 *
 * `errorIter` gives every error entry (the caller decides across which
 * projects); this stays free of `memory.mjs` that way.
 */
export function guardShare(root, errorIter, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const ids = new Set();
  const withField = new Set();
  for (const e of errorIter) {
    if (!e?.id) continue;
    ids.add(e.id);
    if (e.guard && typeof e.guard === 'object') withField.add(e.id);
  }
  const marked = new Set();
  const empty = [];
  let files = [];
  try { files = fs.readdirSync(path.join(root, 'test')); } catch { files = []; }
  for (const f of files) {
    const full = path.join(root, 'test', f);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.size > maxBytes) continue;
    let t;
    try { t = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const marks = [...t.matchAll(/\/\/ error: (\S+)/g)].map((m) => m[1]);
    if (!marks.length) continue;
    if (isEmpty(t)) { empty.push({ path: `test/${f}`, ids: marks, mtimeMs: st.mtimeMs }); continue; }
    if (!/\btest\(/.test(t)) continue;
    for (const id of marks) marked.add(id);
  }
  let withGuard = 0;
  for (const id of ids) if (withField.has(id) || marked.has(id)) withGuard += 1;
  return { errors: ids.size, withGuard, emptyScaffolds: empty };
}

/** From this many days on, an empty scaffold counts as stalled. */
export const STALE_DAYS = 14;

/**
 * The measure as a report: share, empty and stalled scaffolds.
 * `state` is `'ok'` or `'warning'` (stalled), `'unknown'` when nothing
 * was readable — never silently `'ok'`.
 */
export function quote(root, errorIter, { now = new Date() } = {}) {
  let m;
  try { m = guardShare(root, errorIter); }
  catch (e) { return { state: 'unknown', text: `errors/scaffolds not readable: ${e?.message || e}`, stale: [] }; }
  if (!m.errors) return { state: 'ok', text: 'no errors on record — nothing to measure', stale: [], ...m };
  const pct = ((100 * m.withGuard) / m.errors).toFixed(1);
  const cutoff = new Date(now).getTime() - STALE_DAYS * 86400000;
  const stale = m.emptyScaffolds.filter((s) => s.mtimeMs < cutoff);
  const line = `${m.withGuard} of ${m.errors} errors with a guard (${pct}%), `
    + `${m.emptyScaffolds.length} empty scaffolds`
    + (stale.length ? `, ${stale.length} of them stalled for > ${STALE_DAYS} days` : '');
  return { state: stale.length ? 'warning' : 'ok', text: line, stale, ...m };
}

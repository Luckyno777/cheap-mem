// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * ruledraft.mjs - AU6 (parity with the sibling's `regelentwurf.mjs`; owner
 * decision A, 2026-10-11): from repeated errors, a weekly collection list of rule
 * DRAFTS, stored as a `thought` tagged `rule-proposal`.
 *
 * **What this is, and is not.** It writes thoughts. It enacts no procedure: "a
 * procedure stays a human's act" (`src/procedure.mjs`). The draft is not a rule,
 * applies nowhere, is shown as a thought (authority `inferred`) and says
 * "not a procedure" in its title. Approving means the owner enacts the rule
 * himself (`mem log procedure ... --issued-by owner`); `mem suggest procedure
 * <class>` prints the command. The command is deliberately NOT in the thought: a
 * ready `--issued-by owner` in a text that sessions read invites forging the
 * owner's approval.
 *
 * **What a repetition pattern is (and the threshold).** Two kinds, both already
 * used in this house:
 *   - `file`:  the same error class AND the same file (`src/errorfile.mjs`, as
 *     the doctor's `repetition`): "the guard is missing, not the care".
 *   - `title`: the same error class AND the same normalised title (as the
 *     doctor's `repetition-hint`): the same error under the same name.
 * A pattern counts from `THRESHOLD` = 3 errors within `WINDOW_DAYS` = 14 days.
 * The 3 is the house's "third repetition" (`repetitionhint.THRESHOLD`); 14 days is
 * the sibling's rule-suggestion window. Why NOT simply "the same class >= 3":
 * measured on 2026-10-12 in the sibling's memory (the five youngest weekly
 * 14-day windows), the class alone reaches the threshold for ALL twelve classes
 * in EVERY window - a list that always carries the same twelve lines says
 * nothing. With a file or a title as the second feature it was 3 and 7 patterns
 * in 6 classes in the youngest window. The numbers are counts, not rates; the
 * threshold stays in ONE place.
 *
 * **Idempotent per class and week.** A run writes at most one thought per class
 * per ISO week (key: tag + fields `class` and `week`); a second run in the same
 * week writes nothing. A class with a procedure in force gets no draft
 * (`repetitionhint.covered`, the same coverage as the doctor finding). No class,
 * no pattern.
 *
 * **No model, nothing invented.** The proposed text is the sentence from the
 * newest error of the class (`repetitionhint.correctPathText`), quoted and cut.
 */

import * as memory from './memory.mjs';
import * as errorclass from './errorclass.mjs';
import * as errorfile from './errorfile.mjs';
import * as repetitionhint from './repetitionhint.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { weekKey } from './gap.mjs';
import { writeAtomic } from './atomicwrite.mjs';
import { maskText } from './outputguard.mjs';

export const TAG = 'rule-proposal';
export const WINDOW_DAYS = 14;
export const THRESHOLD = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PATTERN_LINES = 5;
const MAX_QUOTE = 300;

const clip = (s, n) => {
  const t = maskText(String(s ?? '')).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const newestFirst = (a, b) => {
  const x = Date.parse(a?.ts); const y = Date.parse(b?.ts);
  const xo = !Number.isFinite(x); const yo = !Number.isFinite(y);
  if (xo || yo) return xo - yo;   // an unreadable time goes last
  return y - x;
};

/**
 * The repetition patterns in the window, grouped by class:
 * `[{ cls, count, ids, patterns: [{ kind, key, count }], newest }]`, biggest
 * class first. Only classes with at least one pattern at THRESHOLD or more.
 */
export function patterns(root, { now = new Date() } = {}) {
  const at = new Date(now).getTime();
  const from = at - WINDOW_DAYS * DAY_MS;
  const inWindow = repetitionhint.allErrors(root).filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && t > from && t <= at;
  });

  const perClass = new Map();   // class -> { file: Map, title: Map }
  for (const e of inWindow) {
    const cls = errorclass.normalise(e.class);
    if (!cls) continue;   // no class, no pattern - nothing guessed
    if (!perClass.has(cls)) perClass.set(cls, { file: new Map(), title: new Map() });
    const k = perClass.get(cls);
    const f = errorfile.files(e)[0];
    if (f) { if (!k.file.has(f)) k.file.set(f, []); k.file.get(f).push(e); }
    const t = repetitionhint.normaliseTitle(e.title);
    if (t) { if (!k.title.has(t)) k.title.set(t, []); k.title.get(t).push(e); }
  }

  const out = [];
  for (const [cls, k] of perClass) {
    const hits = [];
    for (const kind of ['file', 'title']) {
      for (const [key, list] of k[kind]) {
        if (list.length >= THRESHOLD) hits.push({ kind, key, count: list.length, list });
      }
    }
    if (!hits.length) continue;
    hits.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const all = new Map();
    for (const h of hits) for (const e of h.list) all.set(e.id, e);
    const entries = [...all.values()].sort(newestFirst);
    out.push({
      cls,
      count: all.size,
      ids: entries.map((e) => e.id).filter(Boolean),
      patterns: hits.map(({ kind, key, count }) => ({ kind, key, count })),
      newest: entries[0],
    });
  }
  out.sort((a, b) => b.count - a.count || a.cls.localeCompare(b.cls));
  return out;
}

/** Drafts already written (tag `rule-proposal`), whatever the week. */
function existing(root) {
  const out = [];
  try {
    for (const e of memory.iterLog(root, 'thought', { project: null })) {
      if (!e || e.__broken || memory.isClosingLine(e)) continue;
      if (Array.isArray(e.tags) && e.tags.includes(TAG)) out.push(e);
    }
  } catch { /* no drawer yet: no drafts */ }
  return out;
}

function draftText(p, week) {
  const lines = p.patterns.slice(0, MAX_PATTERN_LINES)
    .map((x) => `- ${x.count}x ${x.kind === 'file' ? `file ${x.key}` : `title "${clip(x.key, 80)}"`}`);
  if (p.patterns.length > MAX_PATTERN_LINES) lines.push(`- ... and ${p.patterns.length - MAX_PATTERN_LINES} more`);
  const quote = clip(repetitionhint.correctPathText(p.newest), MAX_QUOTE);
  return [
    `DRAFT, not a procedure and not a rule (AU6, week ${week}). The error class ${p.cls} repeats: `
      + `${p.count} errors in ${WINDOW_DAYS} days, pattern from ${THRESHOLD}x:`,
    ...lines,
    `Errors: ${p.ids.slice(0, 8).join(', ')}${p.ids.length > 8 ? ', ...' : ''}.`,
    `Quote from the newest error (${p.newest.id}, unchecked, not invented): "${quote}"`,
    `Only the owner can approve or drop it: mem suggest procedure ${p.cls} prints the draft of the command `
      + '(writes nothing); only a rule the owner enacts (mem log procedure) becomes a procedure.',
  ].join('\n');
}

/**
 * Compute the drafts and, with `write`, store them as `thought`s.
 * Returns `{ week, created: [...], skipped: [{class, reason}], candidates }`.
 */
export function run(root, { now = new Date(), write = false } = {}) {
  const week = weekKey(new Date(now).toISOString());
  if (!week) throw new Error('ruledraft: time not readable');
  const found = patterns(root, { now });
  const have = existing(root);

  const created = [];
  const skipped = [];
  for (const p of found) {
    if (repetitionhint.covered(root, p.cls)) { skipped.push({ class: p.cls, reason: 'procedure-in-force' }); continue; }
    if (have.some((e) => e.class === p.cls && e.week === week)) {
      skipped.push({ class: p.cls, reason: 'already-this-week' });
      continue;
    }
    const entry = {
      title: `Rule draft (not a procedure): ${p.cls} repeats`,
      text: draftText(p, week),
      why: `AU6: class ${p.cls} has at least one repetition pattern of ${THRESHOLD}x or more (file or title) `
        + `in ${WINDOW_DAYS} days and no procedure yet; weekly collection list, owner decision A.`,
      topic: 'rule-proposal',
      tags: [TAG, 'auto-proposal'],
      class: p.cls,
      week,
      error_ids: p.ids.slice(0, 20),
      authority: 'inferred',
    };
    if (write) {
      const { entry: stored } = memory.logEntry(root, 'thought', entry, { now });
      created.push({ class: p.cls, id: stored.id, count: p.count });
    } else {
      created.push({ class: p.cls, id: null, count: p.count, dry: true });
    }
  }
  return { week, threshold: THRESHOLD, windowDays: WINDOW_DAYS, candidates: found.length, created, skipped };
}

/** Where the weekly tick remembers which week it already did (machine-local, gitignored under .mem/). */
export const STAMP_FILE = path.join('.mem', 'rule-draft-week');

/**
 * The weekly tick (`mem suggest rules --weekly`, called from `bin/mem-digest` on
 * its 10-minute rhythm): a cheap no-op on every call but the first of an ISO week.
 * The stamp only saves work - the idempotence per class and week lives in
 * {@link run}, so a lost or wrong stamp costs one extra read, never a double draft.
 * The stamp is written only after a successful run.
 */
export function runWeekly(root, { now = new Date() } = {}) {
  const week = weekKey(new Date(now).toISOString());
  if (!week) throw new Error('ruledraft: time not readable');
  const stampPath = path.join(root, STAMP_FILE);
  let seen = '';
  try { seen = fs.readFileSync(stampPath, 'utf8').trim(); } catch { /* no stamp yet */ }
  if (seen === week) return { week, ranNow: false, reason: 'stamp-this-week' };
  const result = run(root, { now, write: true });
  writeAtomic(stampPath, `${week}\n`);
  return { ...result, ranNow: true };
}

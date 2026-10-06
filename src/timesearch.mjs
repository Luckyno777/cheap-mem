// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/timesearch.mjs — retrieval by time window (no model).
//
// Digested entries carry `ts`; raw captures carry a per-line `timestamp`. So
// "what did we discuss <window>" is answerable in pure code — chronological,
// no network, no cost. This is the lane the time router (src/timeexpr.mjs)
// feeds.

import path from 'node:path';
import { find } from './memory.mjs';
import * as raw from './raw.mjs';

// Words that are time/filler, not subject keywords. If anything survives the
// cut, the window is narrowed to entries mentioning it.
const TIME_STOP = new Set([
  'last', 'past', 'previous', 'since', 'between', 'and', 'to', 'until', 'from',
  'hour', 'hours', 'day', 'days', 'week', 'weeks', 'today', 'yesterday',
  'morning', 'forenoon', 'noon', 'midday', 'afternoon', 'evening', 'night',
  'overnight', 'am', 'pm', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'before',
  'what', 'did', 'we', 'have', 'was', 'were', 'built', 'build', 'discussed',
  'discuss', 'about', 'the', 'a', 'an', 'on', 'in', 'our', 'when', 'which',
]);

/** Subject words (≥3 chars, not time/filler) from a query. */
export function keywordsOf(query) {
  return String(query || '').toLowerCase()
    .replace(/[0-9]+([.:-][0-9]+)*/g, ' ')
    .split(/[^a-z]+/i)
    .filter((w) => w.length >= 3 && !TIME_STOP.has(w));
}

/**
 * Digested entries in [from, to), chronological. Optional narrowing by
 * subject words.
 *
 * **`capability`, required (issue #136).** Which projects this can see is
 * decided entirely by `capability` now, handed straight to `memory.find`
 * — there used to be a `project` option here too, translated by hand into
 * `[project === 'global' ? null : project]`, and it was NARROWER than the
 * lattice: a real project name saw only that project, never `global`,
 * unlike every other scoped lane (`mem find`, `mem retrieve`, `mem
 * component`), which all read that project's drawer PLUS `global` — the
 * lattice root every capability with read inherits (`capability.mjs`'s
 * `admits()`). That made `mem find "<time phrase>" --project X` and `mem
 * when ... --project X` answer with LESS than `mem find X --literal
 * --project X` did, for the same memory, same project, same everything
 * except which lane happened to run — a live disagreement, found while
 * wiring this parameter, not introduced by it. Passing a capability
 * instead of a hand-rolled project list fixes it as a side effect: the
 * caller (`cli/display.mjs`'s `showWindow`) mints the SAME capability
 * every other lane mints from `--project`, and `memory.find` alone
 * decides what that admits.
 */
export function entriesInWindow(root, capability, {
  from, to, words = [],
} = {}) {
  const fMs = from ? new Date(from).getTime() : -Infinity;
  const tMs = to ? new Date(to).getTime() : Infinity;
  const w = words.map((x) => x.toLowerCase());
  // STREAMING: `find` keeps only what the window and filters pass. It used to
  // load every line into one array and filter afterwards (memory grew with the
  // entry count).
  const hits = find(root, '', capability, {
    since: from || null, withRetired: true,
    windowMs: { from: fMs, to: tMs },
    accept: (e) => {
      const t = e.ts ? new Date(e.ts).getTime() : NaN;
      if (Number.isNaN(t) || t < fMs || t >= tMs) return false;
      if (w.length) {
        const hay = JSON.stringify(e).toLowerCase();
        if (!w.some((x) => hay.includes(x))) return false;
      }
      return true;
    },
  });
  return hits.sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

// "2026-09-01T18-35-16Z" (filename) → ms. The capture time is the UPPER bound of
// the lines it holds: a capture written before `from` can hold no line in range.
function captureMs(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function shortContent(o) {
  let c = o.content ?? o.message?.content ?? '';
  if (Array.isArray(c)) c = c.map((x) => (typeof x === 'string' ? x : x?.text || '')).join(' ');
  if (typeof c !== 'string') c = JSON.stringify(c);
  c = c.replace(/\s+/g, ' ').trim();
  return c.length > 240 ? `${c.slice(0, 240)}…` : c;
}

/**
 * Redacted raw conversation lines in [from, to), chronological. `maxLines` caps
 * the output (the result says when it was capped). This is the "what was
 * discussed" layer — raw text, not digested.
 */
export function rawInWindow(root, { from, to, maxLines = 200 } = {}) {
  const fMs = new Date(from).getTime();
  const tMs = new Date(to).getTime();
  // The captures come from the SAME list the index uses (`raw.listCaptures`)
  // and are read through the archive (`raw.readCapture`). This function used
  // to read only `raw/*.jsonl.gz` inside the repository: since the move into
  // the archive (2026-09-08) every archived capture was MISSING silently, and
  // a time question looked like "nothing discussed" (audit B#45). A capture
  // that is listed but unreachable is COUNTED (`unreachable`), never read as empty.
  let listed = [];
  try { listed = raw.listCaptures(root); } catch { /* no raw/: nothing to read */ }
  const files = [];
  for (const rel of listed) {
    const cap = captureMs(path.basename(rel));
    if (cap !== null && cap < fMs) continue;
    files.push(rel);
  }
  files.sort();

  const lines = [];
  let capped = false;
  let unreachable = 0;
  for (const rel of files) {
    let cap;
    try { cap = raw.readCapture(root, rel); } catch { unreachable += 1; continue; }
    for (const o of cap.lines) {
      const ts = o.timestamp ?? o.time ?? o.ts;
      if (!ts) continue;
      const t = new Date(ts).getTime();
      if (Number.isNaN(t) || t < fMs || t >= tMs) continue;
      lines.push({ ts, source: rel, type: o.type ?? null, text: shortContent(o) });
      if (lines.length >= maxLines) { capped = true; break; }
    }
    if (capped) break;
  }
  lines.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return { lines, capped, files: files.length, unreachable };
}

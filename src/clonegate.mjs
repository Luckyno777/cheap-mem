// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The gate "which clone answered": one line above a recall when the clone
 * that answers is STALE (src/provenance.mjs).
 *
 * **Why a gate and not just the doctor finding.** `mem doctor` already
 * reports `provenance` - to whoever asks. The case it exists for is the
 * one where nobody asks: the recall hook refreshes the clone at most every
 * ten minutes, detached, and a pull that fails (dirty tree, no network,
 * somebody else's lock) leaves a session working for hours against a frozen
 * state while every answer reads as confident as the first. The gate puts the
 * clone's name and age into the answer exactly then - and only then. A hint
 * that appears on every turn is skipped by the third.
 *
 * **What is cheap and what is not.** `provenance()` runs three to four git
 * processes (measured 2026-10-14, Linux 4 cores: median 24 ms for the whole
 * of it, 10 ms for the lag count alone) - fine once, too much on every
 * prompt of a hook that answers in 60 ms against a warm server. So the result
 * is kept in `.pipeline/clone-gate.json` (runtime state, git-ignored):
 * looked at again after CHECK_EVERY_MS, and a STALE verdict is SHOWN at most
 * every SHOW_EVERY_MS. A directory that is not a git tree is left alone
 * (nothing to say per turn; the session start names it once).
 *
 * **What it cannot know.** Same limit as the module it wraps: no network.
 * A clone whose fetches ALL fail keeps its last-fetched view of origin and
 * reads as "level with origin"; `git fetch` touches FETCH_HEAD even when it
 * fails (measured 2026-10-14), so even that file cannot tell. The gate
 * catches the clone that is behind what it has SEEN, or cannot tell.
 *
 * Off with `MEM_CLONE_GATE=0`.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as provenance from './provenance.mjs';
import { writeAtomic, readStateFile } from './atomicwrite.mjs';
import { cutMasked } from './outputguard.mjs';
import * as bidi from './bidi.mjs';

/** The verdict is worked out again after this long. */
export const CHECK_EVERY_MS = 5 * 60 * 1000;
/** A STALE verdict is shown at most this often. */
export const SHOW_EVERY_MS = 30 * 60 * 1000;
/** Where the verdict is kept, relative to the memory root. */
export const CACHE_FILE = path.join('.pipeline', 'clone-gate.json');

/**
 * N2: the line comes out of a FILE in the clone (`.pipeline/clone-gate.json`), which anybody who can write there can
 * change - and it goes into the model's context. It is shown only in the shape `provenance.asLine` makes ("Memory: ..."),
 * on one line, without control characters, bidi marks or secret shapes, at most 300 characters; anything else is not shown.
 */
function cleanLine(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('Memory: ')) return null;
  const one = raw.replace(/\p{Cc}+/gu, ' ').trim();
  // Mask FIRST, cut the masked text (a plain slice before the mask leaves the front half of a token at the edge, and no
  // pattern knows half a token): `cutMasked` is `maskText(text).slice(0, n)` and never ends inside a marker.
  return cutMasked(bidi.visible(one), 300) || null;
}

/** The cached verdict, or null (missing, unreadable, broken). A Windows refusal during a replace is tried again first. */
export function readCache(file, opt = {}) {
  const r = readStateFile(file, opt);
  if (r.state !== 'ok') return null;
  try {
    const c = JSON.parse(r.text);
    return c && typeof c === 'object' && Number.isFinite(c.checked) && typeof c.state === 'string' ? c : null;
  } catch { return null; }
}

/**
 * @returns {{ line: string|null, state: string }} `line` is set when the
 *   clone is STALE and the verdict is due to be shown; otherwise null.
 */
export function gate(root, { env = process.env, now = Date.now() } = {}) {
  if (env.MEM_CLONE_GATE === '0') return { line: null, state: 'off' };
  if (!root || !fs.existsSync(path.join(root, '.git'))) return { line: null, state: provenance.STATE.NO_GIT };
  const file = path.join(root, CACHE_FILE);
  let c = readCache(file);
  const fresh = c && c.checked <= now && now - c.checked < CHECK_EVERY_MS;
  let dirty = false;
  if (!fresh) {
    const p = provenance.provenance(root, { now });
    c = { checked: now, state: p.state, line: provenance.asLine(p), shown: c && Number.isFinite(c.shown) ? c.shown : 0 };
    dirty = true;
  }
  let line = null;
  if (c.state === provenance.STATE.STALE && (c.shown > now || now - c.shown >= SHOW_EVERY_MS)) {
    line = cleanLine(c.line);
    c.shown = now;
    dirty = true;
  }
  if (dirty) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, JSON.stringify(c)); }
    catch {
      // N1: a verdict that cannot be remembered cannot be throttled: it would be shown on EVERY prompt. Show nothing -
      // the session start and `mem doctor` still name the clone; a hint that repeats every turn is skipped by the third.
      line = null;
    }
  }
  return { line, state: c.state };
}

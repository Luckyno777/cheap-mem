// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/epoch.mjs — noticing that the memory went backwards.
//
// The hole (documented as unsolved after round three): check out an older
// commit, or restore a stale backup, and a claim that had been superseded
// or revoked is active again. Nothing notices. Every read afterwards is
// confidently wrong, and the log itself cannot tell — from inside t1,
// the state of t1 is simply correct.
//
// **Why detection has to live outside the tracked tree.** A git checkout
// reverts everything git tracks. Any marker committed alongside the log
// travels back with it and says exactly what the rolled-back state says.
// So the marker is a LOCAL, gitignored file: `.mem/epoch.json`, next to
// the search cache, never merged, never pushed.
//
// **Why that is not a second source of truth.** It stores no memory
// content and answers no question about what is true. It records the
// high-water mark of what this machine has ALREADY SEEN — an observation
// about history, not a claim about the world. Delete it and you lose
// detection, not data; the log remains the only source of truth, exactly
// as before.
//
// Three designs were weighed:
//
//   A  no detection                  what was shipped until now
//   B  monotonic epoch in the log    travels back with the checkout: useless
//   C  local high-water mark         this
//
// C is the smallest thing that yields a real gain, and its limits are
// sharp enough to state in one line each:
//
//   - a FRESH CLONE has no watermark, so the first observation cannot
//     detect anything. It establishes the mark instead.
//   - an attacker who can write the repository can delete `.mem/epoch.json`.
//     This detects accidents and stale restores, not a determined
//     adversary with filesystem access.
//   - it is per machine. Two clones each keep their own view.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as memory from './memory.mjs';
import * as integrity from './integrity.mjs';
import * as drawermemo from './drawermemo.mjs';
import * as semantics from './semantics.mjs';
import { writeAtomic, readStateFile } from './atomicwrite.mjs';

export const EPOCH_FILE = path.join('.mem', 'epoch.json');
export const EPOCH_VERSION = 1;

/**
 * What this machine can see right now.
 *
 * `retiredIds` is the load-bearing part. A rollback that merely removes
 * recent claims shows up in the count; a rollback that resurrects a
 * SUPERSEDED claim may leave the count unchanged (if it also drops the
 * superseding line) — but the set of retired ids shrinks, and that is the
 * thing an operator actually needs told.
 */
export function observe(root) {
  const retired = new Set();
  let claims = 0;
  let newestTs = null;

  for (const f of integrity.logFiles(root)) {
    const entries = [];
    // Inside a doctor run the drawer was parsed once already (src/drawermemo.mjs).
    const memoRows = drawermemo.rowsOf(f.abs);
    if (memoRows) {
      for (const e of memoRows.vals) if (e !== drawermemo.NOT_JSON) entries.push(drawermemo.copyOf(e));
    } else {
      let raw;
      try { raw = memory.withoutBom(fs.readFileSync(f.abs, 'utf8')); } catch { continue; }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const e = memory.parseLine(line);
        if (!e?.__broken) entries.push(e); // unreadable or wrongly shaped: integrity reports this
      }
    }
    claims += entries.length;
    for (const e of entries) {
      if (typeof e.ts === 'string' && (!newestTs || e.ts > newestTs)) newestTs = e.ts;
    }
    for (const id of memory.retiredMap(entries).keys()) retired.add(id);
  }

  const ids = [...retired].sort();
  return {
    version: EPOCH_VERSION,
    // Which rules produced the retired set below. A watermark taken under
    // different semantics describes a different derived state, so
    // comparing across a bump would report a rollback that is really a
    // rule change — and hide a real one behind the noise.
    semantics: semantics.SEMANTIC_VERSION,
    claims,
    newestTs,
    retiredCount: ids.length,
    retiredHash: crypto.createHash('sha256').update(ids.join('\n'), 'utf8').digest('hex').slice(0, 32),
    retiredIds: ids,
    seenAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/**
 * The mark in three states: `{ state: 'ok', mark }`, `{ state: 'missing' }` (no file: the first observation) and
 * `{ state: 'unreadable', error }` (a file that is there and could not be read - on Windows a refusal that did not let
 * up while a writer replaced it). A refusal is tried again first (`readStateFile`). Content that is not a mark of this
 * version (broken JSON, an older version) reads as `missing`, as it always did: the next record replaces it.
 */
export function readEpochState(root, opt = {}) {
  const r = readStateFile(path.join(root, EPOCH_FILE), opt);
  if (r.state !== 'ok') return r;
  try {
    const e = JSON.parse(r.text);
    return e && e.version === EPOCH_VERSION ? { state: 'ok', mark: e } : { state: 'missing' };
  } catch { return { state: 'missing' }; }
}

/** The mark, or `null` (missing, unreadable, not this version) - `readEpochState` tells the cases apart. */
export function readEpoch(root, opt = {}) {
  const r = readEpochState(root, opt);
  return r.state === 'ok' ? r.mark : null;
}

/**
 * Compare what is here against the high-water mark.
 *
 * Returns `{ status, ... }` where status is one of:
 *   `first`     no mark yet — this observation becomes it
 *   `unreadable` a mark is there and could not be read: NOT `first` - the mark is not replaced on a guess
 *   `ahead`     the memory grew, as it should
 *   `same`      nothing changed
 *   `rollback`  claims disappeared, or retirements were undone
 */
export function checkEpoch(root, now = null, opt = {}) {
  const cur = now ?? observe(root);
  const found = readEpochState(root, opt);
  if (found.state === 'unreadable') {
    return { status: 'unreadable', current: cur, mark: null, resurrected: [], detail: found.code || found.error };
  }
  const mark = found.mark;
  if (!mark) return { status: 'first', current: cur, mark: null, resurrected: [] };
  if (!semantics.comparable(mark.semantics)) {
    return { status: 'semantics-changed', current: cur, mark, resurrected: [],
      detail: semantics.describe(mark.semantics) };
  }

  // A resurrection is a retirement the mark had and the tree no longer
  // does. Compared as a SET, not a count: a rollback that both drops a
  // tombstone and adds an unrelated one keeps the count identical.
  const nowRetired = new Set(cur.retiredIds);
  const resurrected = (mark.retiredIds ?? []).filter((id) => !nowRetired.has(id));
  const lostClaims = mark.claims - cur.claims;

  if (resurrected.length || lostClaims > 0) {
    return { status: 'rollback', current: cur, mark, resurrected, lostClaims };
  }
  if (cur.claims > mark.claims || cur.retiredIds.length > (mark.retiredIds ?? []).length) {
    return { status: 'ahead', current: cur, mark, resurrected: [] };
  }
  return { status: 'same', current: cur, mark, resurrected: [] };
}

/**
 * Move the mark forward. Never backward.
 *
 * Refusing to lower it is the whole point: an operator who has decided a
 * rollback was intentional says so explicitly with `{ force: true }`, and
 * that decision is a deliberate act rather than a side effect of running
 * a read command.
 */
export function recordEpoch(root, { force = false, ...opt } = {}) {
  const state = checkEpoch(root, null, opt);
  if (state.status === 'rollback' && !force) {
    return { written: false, ...state };
  }
  // A mark that is there but cannot be read right now is not a mark that is not there: writing over it on a guess
  // could lower the high-water mark. Only an explicit force replaces it.
  if (state.status === 'unreadable' && !force) {
    return { written: false, ...state };
  }
  const p = path.join(root, EPOCH_FILE);
  writeAtomic(p, JSON.stringify(state.current, null, 2) + '\n');
  return { written: true, ...state };
}

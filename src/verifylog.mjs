// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// verifylog.mjs — the human's verdict on an uncertain fact, appended
// OUTSIDE this memory (N9 parity: the sibling's gold-verdict set).
//
// **Why a verdict never touches an entry.** cheap-mem has no gold-set
// pipeline (no external question-grading harness): there is nothing
// here that plays lucky-mem's `frage` (an actual quiz question) or
// `erwartet` (an expected id set). What this house DOES have is
// `memory.currentFacts()` — every `timeline` fact, resolved, each with
// its own `stale`/`conflict` signal (src/freshness.mjs). Those are real
// uncertainty, not invented: a `stale` fact has gone `staleDays` (120)
// without a newer version, a `conflict` fact has two versions dated the
// same day that disagree. src/today.mjs turns the worst of those into
// "to verify" candidates.
//
// A person looking at one of those candidates can say "still holds",
// "outdated" or "can't tell" — and that verdict is worth recording, but
// NOT as a correction on the entry (that would need the actual new
// value, which a rating button does not have) and NOT anywhere inside
// this repository (an agent working in a worktree must never be able
// to make this memory say something different about itself). So it
// goes to ONE line, appended to a file OUTSIDE the memory root — same
// boundary lucky-mem's gold-urteil route draws, checked the same way
// (`checkTargetOutsideRoot`, called from the write route before any
// append).
//
// invariant: not-measured-is-not-zero
// invariant: append-only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendLine } from './append.mjs';

/** 12 base36 characters — the same shape as this house's other ids,
 *  in its own namespace (never a memory entry id). */
export function newId() {
  let out = '';
  while (out.length < 12) out += BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36);
  return out.slice(0, 12);
}

/** The verdicts a person can give on an uncertain fact. Closed list. */
export const VERDICT = Object.freeze(['still-current', 'outdated', 'cannot-tell']);

/** Where a verdict line goes without an explicit path — mirrors the
 *  sibling's `~/.lucky-mem-gold/`, in this house's own directory. */
export function defaultTarget() {
  return path.join(os.homedir(), '.cheap-mem-verify', 'facts-verdict.jsonl');
}

/** The real target: `CHEAP_MEM_VERIFY_FILE`, else {@link defaultTarget}. */
export function targetPath(env = process.env) {
  return env.CHEAP_MEM_VERIFY_FILE ? path.resolve(env.CHEAP_MEM_VERIFY_FILE) : defaultTarget();
}

/**
 * Refuse a target that sits inside the memory root — writing a human
 * judgement into the repository under review is exactly the shape a
 * worktree agent must never be able to produce on its own.
 */
export function checkTargetOutsideRoot(target, root) {
  const t = path.resolve(target);
  const r = path.resolve(root);
  if (t === r || t.startsWith(`${r}${path.sep}`)) {
    throw new Error(`the verify-verdict target (${t}) sits inside the memory root (${r}) — `
      + 'it must be outside, or this route would write a human judgement into the repository it is about.');
  }
}

/** Build a canonical verdict line. Writes nothing — the caller appends. */
export function buildRow({
  ts = new Date().toISOString(), key, project = null, verdict, ageDays = null, conflict = false, note = null,
} = {}) {
  return {
    id: newId(), ts, key: key ?? null, project, verdict: verdict ?? null,
    ageDays, conflict: Boolean(conflict), note,
  };
}

/** What a row must have to be usable. Returns a list of defects (empty = fine). */
export function checkRow(row) {
  const defects = [];
  if (!row.key || typeof row.key !== 'string') defects.push('key is missing');
  if (!VERDICT.includes(row.verdict)) defects.push(`verdict must be one of ${VERDICT.join(', ')}`);
  if (!row.ts || Number.isNaN(Date.parse(row.ts))) defects.push('ts is not a valid timestamp');
  return defects;
}

/** Every row at a target path, oldest first. Broken lines are counted. */
export function read(target) {
  let raw;
  try { raw = fs.readFileSync(target, 'utf8'); } catch { return { rows: [], broken: 0, present: false }; }
  const rows = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && e.id && e.key) rows.push(e); else broken += 1;
    } catch { broken += 1; }
  }
  return { rows, broken, present: true };
}

/** Append one row to `target`, after the outside-root check. */
export function append(target, root, row) {
  checkTargetOutsideRoot(target, root);
  const defects = checkRow(row);
  if (defects.length) return { written: false, defects };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  appendLine(target, `${JSON.stringify(row)}\n`);
  return { written: true, row };
}

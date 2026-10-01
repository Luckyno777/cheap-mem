// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// measurements.mjs — a small, persisted weekly measurement series.
//
// **Why it exists (owner decision 2026-09-28, port spec §6.6).** The
// dashboard's Operations › Performance view shows a real series over
// weeks in the sibling house (its weekly measurement service writes one
// file per week). cheap-mem had nothing persisted — every number was
// measured per run and thrown away — so the view could only have shown
// one point, or a fabricated curve. Neither is allowed here. So: one
// line per ISO week, capped at 52 weeks, machine-local.
//
// **What is measured — only counts other modules already own.** Every
// value below is read through the function that already answers it
// (`console.inventory`, `net.build`, `memory.openDuties`, `question.open`,
// `injection.read`, `doctor.checkAll`). Nothing is estimated. A count
// that could not be taken is `null` — never 0 (not measurable is not
// null's cousin zero).
//
// **Who writes, and when.** Never a page read: looking at the dashboard
// changes nothing. The server (`bin/mem-serve`) calls `recordIfDue()` at
// start and then every few hours while it runs; a week that already has
// its line is left alone. The file lives under `.mem/` — gitignored,
// about THIS machine, like the console log.
//
// **The cap.** At most `MAX_WEEKS` lines. The file is not a memory log
// (those are append-only, forever); it is a bounded instrument trace, so
// when a 53rd week arrives the oldest line goes — rewritten through a
// temporary file and a rename, so a crash never leaves half a file.
//
import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as question from './question.mjs';
import * as net from './net.mjs';
import * as injection from './injection.mjs';
import * as consolePage from './console.mjs';
import * as doctor from './doctor.mjs';
import { writeAtomic } from './atomicwrite.mjs';

export const FILE = path.join('.mem', 'measurements.jsonl');
export const MAX_WEEKS = 52;

/** The metrics, in display order, with their unit. A closed list. */
export const METRICS = Object.freeze([
  { id: 'entries', unit: 'count', title: 'Entries' },
  { id: 'links', unit: 'count', title: 'Declared links' },
  { id: 'dangling', unit: 'count', title: 'Links into the void' },
  { id: 'captures', unit: 'count', title: 'Raw captures' },
  { id: 'openDuties', unit: 'count', title: 'Open duties' },
  { id: 'openQuestions', unit: 'count', title: 'Open questions' },
  { id: 'injectionsShown', unit: 'count', title: 'Injections shown (this week)' },
  { id: 'doctorProblems', unit: 'count', title: 'Doctor warnings + errors' },
]);

/** ISO-8601 week key, `YYYY-Www`, in UTC. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** One measured value, or `null` with the reason — never a silent 0. */
function take(fn) {
  try {
    const v = fn();
    return Number.isFinite(v) ? { value: v } : { value: null, reason: 'not a number' };
  } catch (e) {
    return { value: null, reason: e?.message || String(e) };
  }
}

/** Every metric for this moment. Pure reads. */
export function snapshot(root, { now = new Date(), doctorResult = null } = {}) {
  const week = isoWeek(now);
  const rows = () => {
    const out = [];
    for (const project of [null, ...memory.listProjects(root)]) {
      for (const drawer of Object.keys(memory.TYPES)) {
        let res;
        try { res = memory.readLog(root, drawer, { project }); } catch { continue; }
        for (const e of res.entries) if (!e.__broken) out.push({ project: project ?? 'global', drawer, entry: e });
      }
    }
    return out;
  };
  let graph = null;
  const g = () => { graph = graph ?? net.build({ readAll: rows }); return graph; };
  const metrics = {
    entries: take(() => consolePage.inventory(root).total),
    links: take(() => g().links),
    dangling: take(() => g().dangling),
    captures: take(() => {
      const c = consolePage.inventory(root).captures;
      if (c === null) throw new Error('capture register not readable');
      return c;
    }),
    openDuties: take(() => memory.openDuties(root).open.length),
    openQuestions: take(() => question.open(root).length),
    injectionsShown: take(() => {
      const j = injection.read(root);
      if (!j.present) throw new Error('no injection journal on this machine');
      return j.lines.filter((l) => l?.reason == null && isoWeek(new Date(l.ts)) === week).length;
    }),
    doctorProblems: take(() => {
      const r = doctorResult ?? doctor.checkAll(root);
      return (r.summary?.warn ?? 0) + (r.summary?.error ?? 0);
    }),
  };
  return { week, at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), metrics };
}

/**
 * The series. Four states, never two: no file (`readable:true`, empty —
 * nothing recorded yet, said as such), readable lines, broken lines
 * (counted, not skipped), unreadable file (`readable:false` + reason).
 */
export function read(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, FILE), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { readable: true, present: false, weeks: [], broken: 0, cap: MAX_WEEKS };
    return { readable: false, reason: `${FILE} not readable: ${e.message}`, weeks: [], broken: 0, cap: MAX_WEEKS };
  }
  const byWeek = new Map();
  let broken = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (!o?.week || !o.metrics) { broken += 1; continue; }
      byWeek.set(o.week, o);
    } catch { broken += 1; }
  }
  const weeks = [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week)).slice(-MAX_WEEKS);
  return { readable: true, present: true, weeks, broken, cap: MAX_WEEKS };
}

/**
 * Append this week's line unless it is there already; keep at most
 * `MAX_WEEKS`. Never throws outward — a measurement must not stop the
 * server it runs in. Returns what happened.
 */
export function recordIfDue(root, { now = new Date(), doctorResult = null } = {}) {
  try {
    const have = read(root);
    if (!have.readable) return { recorded: false, reason: have.reason };
    const week = isoWeek(now);
    if (have.weeks.some((w) => w.week === week)) return { recorded: false, reason: 'this week is measured already' };
    const line = snapshot(root, { now, doctorResult });
    const file = path.join(root, FILE);
    const keep = [...have.weeks, line].slice(-MAX_WEEKS);
    writeAtomic(file, keep.map((w) => JSON.stringify(w)).join('\n') + '\n');
    return { recorded: true, week, kept: keep.length };
  } catch (e) {
    return { recorded: false, reason: e?.message || String(e) };
  }
}

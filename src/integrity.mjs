// src/integrity.mjs — what is wrong with the log itself.
//
// Two failure classes that used to be invisible.
//
// **Broken lines were skipped silently.** A file truncated mid-write, a
// bad merge, a partial copy: the parser stepped over the line and search
// kept working, so nothing ever said that entries had been lost. Skipping
// is the right recovery — a memory that refuses to open because of one bad
// byte is worse than one that opens without it — but skipping *silently*
// turns data loss into a non-event. Here the same lines are counted and
// located.
//
// **The replacement graph was never checked.** `replaces` points at
// another claim's id, which makes it a graph, and graphs have cycles,
// forks and dangling edges. Resolution walked it without a depth cap, so
// a cycle was an unbounded loop waiting for the right two lines.
//
// Nothing here reads or returns line CONTENT. A broken line may hold a
// half-written secret, and a diagnostic that prints it turns a corruption
// report into a leak. File and line number only.

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';

/** Longest supersession chain we follow before calling it pathological. */
export const MAX_CHAIN = 64;

/** Every versioned JSONL log, as `{ rel, abs, type, project }`. */
export function logFiles(root) {
  const out = [];
  const scopes = [null, ...memory.listProjects(root)];
  for (const project of scopes) {
    for (const type of Object.keys(memory.TYPES)) {
      const abs = memory.logPath(root, type, project);
      if (!fs.existsSync(abs)) continue;
      out.push({ rel: path.relative(root, abs), abs, type, project });
    }
  }
  return out;
}

/**
 * Walk every log once and report what does not hold.
 *
 * Pure: reads, never writes, never repairs. Repair of an append-only log
 * is a contradiction — the answer to a broken line is a new line, and
 * only a human knows what it should say.
 */
export function scanIntegrity(root) {
  const broken = [];          // { file, line }        — unparseable
  const badTimestamp = [];    // { file, line, id, why }
  const duplicateIds = [];    // { id, files: [...] }
  const seen = new Map();     // id -> [{ file, line }]
  const claims = new Map();   // id -> { replaces, file, line }
  let lines = 0;
  let entries = 0;

  const now = Date.now();
  const FUTURE_SLACK_MS = 5 * 60 * 1000;   // clock skew, not time travel

  for (const f of logFiles(root)) {
    let raw;
    try { raw = fs.readFileSync(f.abs, 'utf8'); }
    catch { broken.push({ file: f.rel, line: 0, why: 'unreadable' }); continue; }

    const rows = raw.split('\n');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!row.trim()) continue;
      lines += 1;
      let e;
      try { e = JSON.parse(row); }
      catch { broken.push({ file: f.rel, line: i + 1, why: 'not JSON' }); continue; }
      if (!e || typeof e !== 'object' || Array.isArray(e)) {
        broken.push({ file: f.rel, line: i + 1, why: 'not an object' });
        continue;
      }
      entries += 1;

      if (typeof e.id === 'string' && e.id) {
        const at = seen.get(e.id);
        if (at) at.push({ file: f.rel, line: i + 1 });
        else seen.set(e.id, [{ file: f.rel, line: i + 1 }]);
        claims.set(e.id, { replaces: e.replaces_id ?? e.replaces ?? null, file: f.rel, line: i + 1 });
      }

      // Timestamps. A missing one is not an error for every drawer, but a
      // present-and-unparseable one always is, and a far-future one is
      // either a wrong clock or an attempt to look newest forever.
      if (e.ts !== undefined) {
        const t = Date.parse(e.ts);
        if (!Number.isFinite(t)) {
          badTimestamp.push({ file: f.rel, line: i + 1, id: e.id ?? null, why: 'unparseable ts' });
        } else if (t > now + FUTURE_SLACK_MS) {
          badTimestamp.push({ file: f.rel, line: i + 1, id: e.id ?? null, why: 'ts in the future' });
        }
      }
      if (e.valid_from && e.valid_until) {
        const a = Date.parse(e.valid_from);
        const b = Date.parse(e.valid_until);
        if (Number.isFinite(a) && Number.isFinite(b) && b < a) {
          badTimestamp.push({ file: f.rel, line: i + 1, id: e.id ?? null, why: 'valid_until before valid_from' });
        }
      }
    }
  }

  for (const [id, at] of seen) {
    if (at.length > 1) duplicateIds.push({ id, at });
  }

  return { lines, entries, broken, badTimestamp, duplicateIds, replacement: replacementGraph(claims) };
}

/**
 * The supersession graph: dangling edges, cycles, forks, depth.
 *
 * A **fork** is two claims replacing the same target. That is not
 * corruption — two sessions can correct the same entry without seeing each
 * other, and `merge=union` will keep both — but it is ambiguous, and
 * ambiguity resolved silently is how a memory starts lying. Reported, not
 * repaired.
 */
export function replacementGraph(claims) {
  const missing = [];
  const cycles = [];
  const forks = [];
  const replacedBy = new Map();   // target -> [ids replacing it]

  for (const [id, c] of claims) {
    if (!c.replaces) continue;
    if (!claims.has(c.replaces)) {
      missing.push({ id, replaces: c.replaces, file: c.file, line: c.line });
      continue;
    }
    const arr = replacedBy.get(c.replaces) ?? [];
    arr.push(id);
    replacedBy.set(c.replaces, arr);
  }

  for (const [target, ids] of replacedBy) {
    if (ids.length > 1) forks.push({ target, by: ids.slice().sort() });
  }

  // Depth and cycles in one walk, with an explicit cap.
  //
  // The first version memoised only "seen", which made the walk stop at
  // the first already-visited node — so a chain a<-b<-c reported depth 1
  // instead of 3, and the cap it was supposed to enforce was never
  // approached. Depth has to be memoised as a NUMBER, not as a flag.
  //
  // Colours: absent = untouched, 'grey' = on the current path (a second
  // visit is a cycle), a number = settled depth.
  const depth = new Map();
  const grey = new Set();
  let maxDepth = 0;
  let hitCap = false;

  const walk = (id, budget) => {
    // Budget is a backstop, not the cycle detector. It used to be
    // MAX_CHAIN, and a ring LONGER than MAX_CHAIN then exhausted it
    // before the grey set could close the ring: the walk returned a
    // fabricated finite depth, memoised it, and reported "deep chain"
    // for what was actually a cycle. Caught by test, 2026-09-05.
    //
    // A simple path cannot be longer than the number of nodes, so the
    // budget is now claims.size + 1 and only an implementation error can
    // reach it. MAX_CHAIN keeps its real job: saying when a legitimate
    // chain has grown pathological.
    if (budget <= 0) { hitCap = true; return Infinity; }
    const known = depth.get(id);
    if (typeof known === 'number') return known;
    if (grey.has(id)) {
      // Close the ring at the node we came back to.
      const ring = [...grey].slice([...grey].indexOf(id)).sort();
      if (!cycles.some((c) => c.join() === ring.join())) cycles.push(ring);
      return Infinity;                       // a cycle has no finite depth
    }
    const next = claims.get(id)?.replaces;
    if (!next || !claims.has(next)) { depth.set(id, 1); return 1; }
    grey.add(id);
    const d = walk(next, budget - 1);
    grey.delete(id);
    const own = Number.isFinite(d) ? d + 1 : Infinity;
    depth.set(id, own);
    return own;
  };

  // A simple path visits at most `claims.size` nodes; the step that
  // CLOSES a ring is one more, and the guard is checked before that step
  // is taken — so the backstop needs size + 2. Off by one here means a
  // ring exactly as long as the graph is reported as a deep chain
  // instead of a cycle, which is the bug the long-ring test caught.
  const BUDGET = claims.size + 2;
  for (const id of claims.keys()) {
    const d = walk(id, BUDGET);
    if (Number.isFinite(d) && d > maxDepth) maxDepth = d;
  }

  return { missing, cycles, forks, maxDepth, tooDeep: hitCap || maxDepth >= MAX_CHAIN };
}

/** Is anything here bad enough that a strict run should fail? */
export function isClean(report) {
  return report.broken.length === 0
    && report.duplicateIds.length === 0
    && report.replacement.cycles.length === 0
    && report.replacement.missing.length === 0
    && !report.replacement.tooDeep;
}

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
// **A `.jsonl` under an unknown name was invisible, not merely
// unchecked (found 2026-09-19, self-reproduced).** `logFiles` above,
// `memory.find` and `search.buildIndex` all iterate over
// `memory.TYPES` — a closed map of type name -> filename, by design (see
// the docstring on `memory.TYPES`: forcing an entry into the wrong
// drawer is worse than a new one). But that means a FILENAME the map
// does not know, sitting right next to the files it does — `dutys.jsonl`
// for `duties.jsonl`, one missed keystroke — is opened by NOTHING: not
// `mem find`, not the index, not `mem doctor`'s own drawer count. Every
// one of those answered "243 entries" while 42 more sat on disk,
// unparsed, unmentioned, in a repo `mem doctor` called healthy.
//
// `orphanJsonlFiles` below does not read those files — that would be
// the same mistake as the first failure class here in different
// clothes, guessing at meaning the type map deliberately does not
// grant. It only says how many there are and where, so the gap is a
// finding instead of a silence.
//
// Nothing here reads or returns line CONTENT. A broken line may hold a
// half-written secret, and a diagnostic that prints it turns a corruption
// report into a leak. File and line number only.

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as chain from './chain.mjs';

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
 * `.jsonl` files that sit in `global/` or a `projects/<name>/` directory
 * but whose basename is not one of `memory.TYPES`'s files — so no
 * reading path in this system (find, the index, doctor's own drawer
 * count) will ever open them, no matter how many valid entries they
 * hold.
 *
 * **Exemptions, and why each one is safe.** A handful of `.jsonl` files
 * are deliberately NOT a `memory.TYPES` drawer and just as deliberately
 * live beside them:
 *
 *   - `global/topic-aliases.jsonl` (`memory.ALIAS_LOG`) — a second,
 *     append-only log with its own reader (`memory.topicAliases`),
 *     read on every topic lookup. Not a mistyped drawer.
 *
 * Every other `.jsonl` this codebase writes on purpose — `digested.jsonl`,
 * `raw-record.jsonl` / the legacy `raw-nachweis.jsonl`, `heartbeat.jsonl`,
 * `.mem/bridge-reports.jsonl`, `.mem/console-log.jsonl`,
 * `.pipeline/injections.jsonl`, `.pipeline/observations.jsonl`,
 * `shared/finding-map.jsonl` — is checked (2026-09-19, against every
 * `path.join(root, ...)` call site for a `.jsonl` name in `src/`) to sit
 * at the memory root, under `.mem/`, `.pipeline/` or `shared/`, never
 * under `global/` or `projects/<name>/`. So scanning exactly those two
 * places, with the one exemption above, does not fire on a single file
 * this codebase itself creates — confirmed by running this against a
 * fresh `mem init` and against this repo's own memory, both silent.
 *
 * Directories under `projects/` are read directly with `fs.readdirSync`,
 * not through `memory.listProjects` — a project folder whose NAME is
 * itself invalid is already invisible to every normal path for that
 * reason, and hiding it here too would let a second, compounding way to
 * go unread escape a check built specifically to catch that shape of
 * bug.
 */
export function orphanJsonlFiles(root) {
  const known = new Set(Object.values(memory.TYPES));
  const exempt = new Set([path.basename(memory.ALIAS_LOG)]);
  const out = [];
  const scan = (dir, project) => {
    let entries;
    // `withFileTypes` rather than plain names: a DIRECTORY called
    // `something.jsonl` holds no unread entries, and a finding that
    // names it would be a wrong report under a message that says
    // "files ... read by nothing". A check that accuses the innocent is
    // a check somebody switches off, and then the real one goes with it.
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      if (known.has(e.name) || exempt.has(e.name)) continue;
      out.push({ rel: path.relative(root, path.join(dir, e.name)), project, name: e.name });
    }
  };
  scan(path.join(root, 'global'), null);
  const projectsDir = path.join(root, 'projects');
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* no projects/ yet */ }
  for (const p of projectDirs) scan(path.join(projectsDir, p), p);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
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
  // Fed to `chain.verifyChain` once at the end, reusing the bytes this
  // loop already read rather than opening every file a second time.
  const chainFiles = [];
  let lines = 0;
  let entries = 0;

  const now = Date.now();
  const FUTURE_SLACK_MS = 5 * 60 * 1000;   // clock skew, not time travel

  for (const f of logFiles(root)) {
    let raw;
    try { raw = fs.readFileSync(f.abs, 'utf8'); }
    catch { broken.push({ file: f.rel, line: 0, why: 'unreadable' }); continue; }
    chainFiles.push({ rel: f.rel, raw, project: f.project, type: f.type });

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

      // Timestamps.
      //
      // **A missing `ts` used to fall through every check here (found
      // 2026-09-19).** `logEntry` (memory.mjs) stamps every line it
      // writes, with no way to opt out — so a line with no `ts` at all
      // can only be a hand-edit, a bad merge or a partial write, never
      // ordinary use. The three checks below were each guarded with
      // `if (e.ts !== undefined)`, which was written to skip entries that
      // legitimately never carry a timestamp — but no such entry exists
      // in this schema, so the guard only ever hid the worst case: an
      // absent `ts` is caught by NONE of "unparseable", "in the future"
      // or the `valid_until`-ordering check, while a present-but-garbled
      // one is caught by the first. Missing is strictly worse than
      // malformed and was the one case reported as if it were fine.
      //
      // Reported the same way an unparseable `ts` already is — one more
      // `why` in the same bucket, not a new severity — because it is the
      // same class of defect (a timestamp that cannot be trusted), and a
      // corpus made entirely of `logEntry` writes will never trip this
      // by construction: nothing here fires on ordinary use.
      if (e.ts === undefined) {
        badTimestamp.push({ file: f.rel, line: i + 1, id: e.id ?? null, why: 'missing ts' });
      } else {
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

  return {
    lines,
    entries,
    broken,
    badTimestamp,
    duplicateIds,
    replacement: replacementGraph(claims),
    // See `src/chain.mjs` for what this checks and its honest limits.
    // `state: 'unknown'` here is the correct, expected answer for every
    // corpus written before chaining existed — it is not a lesser result
    // that a future change is expected to turn into 'ok' on its own; a
    // seal has to actually be written for that to happen.
    chain: chain.verifyChain(chainFiles),
  };
}

/**
 * The chain check alone, for a caller that wants it without the rest of
 * `scanIntegrity` — same enumeration `scanIntegrity` itself uses
 * (`logFiles`), so the two never disagree about which files exist.
 */
export function checkChain(root) {
  const files = logFiles(root).map((f) => {
    let raw = '';
    try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { /* absent/unreadable: an empty file has no chain either */ }
    return { rel: f.rel, raw, project: f.project, type: f.type };
  });
  return chain.verifyChain(files);
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
    && !report.replacement.tooDeep
    // A corpus with no seal at all (`chain.state === 'unknown'`) is NOT a
    // failure here — the house rule against a bolt that reports the
    // innocent: "Ein Riegel, der Unschuldige meldet, wird abgeschaltet."
    // Every corpus written before chaining existed would otherwise fail
    // a strict run forever, for a gap that is this module's own, not the
    // memory's. An actual hash mismatch (`chain.tampered`) is a failure
    // regardless of that. `report.chain` is optional so a hand-built
    // report from before this field existed still evaluates.
    && (report.chain?.tampered?.length ?? 0) === 0;
}

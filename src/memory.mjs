/**
 * memory — append-only JSONL log per type, per project.
 *
 * Ported from lucky-mem/src/memory.mjs (originally in German).
 * The code is deliberately small: the structure and the append-only
 * discipline are the system, this file is the thin glue.
 *
 * Format: JSONL for append-only logs (decisions/errors/events/timeline),
 * YAML for stable snapshots (facts/people/sources — human-edited, not
 * touched by this CLI).
 *
 * Time: ISO-UTC with second resolution.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as freshness from './freshness.mjs';

/**
 * Known log types. Each has its own JSONL per project + global.
 *
 * Five of these exist because a digest run kept producing entries that
 * did not fit the original four. A `thought` is not an `event`; a
 * `duty` is not a `decision`. Forcing them into the wrong drawer makes
 * the search worse, because the field weights stop meaning anything.
 *
 * All of them are append-only. A correction is a NEW line carrying
 * `replaces_id` — never an edit. Rewriting history is how a memory
 * starts lying.
 */
export const TYPES = Object.freeze({
  decision: 'decisions.jsonl',   // a choice, with the reason for it
  error: 'errors.jsonl',         // something broke, and why
  event: 'events.jsonl',         // it happened: a release, a hire, a start
  timeline: 'timeline.jsonl',    // a fact that changes over time
  thought: 'thoughts.jsonl',     // reasoning worth keeping, not yet a decision
  learning: 'learnings.jsonl',   // what to do differently next time
  duty: 'duties.jsonl',          // something owed to someone
  skill: 'skills.jsonl',         // a capability acquired, with evidence
  update: 'updates.jsonl',       // a version, a dependency, a config change
});

/**
 * Duty is the ONLY type with a lifecycle.
 *
 * Closing one does not overwrite the original line; it appends a new
 * line carrying `closes_id`. `openDuties()` folds the two into a
 * current view. That keeps the append-only rule intact while still
 * answering "what do I still owe?" — the one question a flat log
 * cannot answer.
 */
export const DUTY_STATE = Object.freeze({
  OPEN: 'open',
  DONE: 'done',
  DROPPED: 'dropped',
});

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

export function checkProjectName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Project name missing');
  }
  if (name.length > 40) {
    throw new Error(`Project name '${name}' too long (>40 chars)`);
  }
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error(
      `Project name '${name}' invalid — allowed: lowercase a-z, 0-9, hyphen; must start and end with alphanumeric`);
  }
}

export function logPath(root, type, project = null) {
  if (!Object.hasOwn(TYPES, type)) {
    throw new Error(`Unknown type '${type}'. Known: ${Object.keys(TYPES).join(', ')}`);
  }
  const file = TYPES[type];
  return project
    ? path.join(root, 'projects', project, file)
    : path.join(root, 'global', file);
}

/**
 * Append a line to a JSONL log. Never modifies an existing line.
 * If an entry needs correction, a new line with `replaces_id` is written.
 */
export function logEntry(root, type, data, { project = null, now = new Date() } = {}) {
  const p = logPath(root, type, project);
  const ts = data.ts ?? new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const id = data.id ?? shortId(ts, type);
  const entry = { id, ts, ...data };

  fs.mkdirSync(path.dirname(p), { recursive: true });

  const line = JSON.stringify(entry);
  if (line.includes('\n')) {
    throw new Error('Newline in log entry — would break JSONL format');
  }
  fs.appendFileSync(p, `${line}\n`, 'utf8');
  return { path: p, entry };
}

function shortId(ts, type) {
  const raw = `${ts}|${type}|${Math.random()}`;
  let h = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    h = ((h * 33) ^ raw.charCodeAt(i)) & 0xffffffff;
  }
  return (h >>> 0).toString(36).padStart(7, '0').slice(0, 8);
}

/**
 * Read a JSONL log. Three states: missing file, empty log, has entries.
 */
export function readLog(root, type, { project = null } = {}) {
  const p = logPath(root, type, project);
  if (!fs.existsSync(p)) return { path: p, missing: true, entries: [] };
  const raw = fs.readFileSync(p, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      entries.push({ __broken: true, raw: line });
    }
  }
  return { path: p, missing: false, entries };
}

/**
 * Search across many log files. Case-insensitive substring match.
 * Returns entries annotated with `_source` (relative path) and `_line`.
 */
export function find(root, pattern, {
  types = Object.keys(TYPES),
  projects = null,   // null = global + all projects
  since = null,
  withRetired = false,  // include retired (done/discarded/superseded)?
} = {}) {
  const needle = String(pattern).toLowerCase();
  const scopes = projects === null ? [null, ...listProjects(root)] : projects;

  // Pass 1: parse every line of the target logs. Only after that is it
  // known what is retired — a tombstone sits in the same log as its
  // target, but possibly further down.
  const raw = [];
  for (const project of scopes) {
    for (const type of types) {
      const p = logPath(root, type, project);
      if (!fs.existsSync(p)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); }
        catch { entry = { __broken: true, raw: line }; }
        raw.push({ entry, p, line: i + 1, text: line });
      }
    }
  }
  const retired = retiredMap(raw.map((r) => r.entry));

  // Pass 2: filter and emit. Tombstone lines never surface as hits;
  // retired entries only with withRetired (then annotated _retired).
  const hits = [];
  const sinceTs = since ? (since instanceof Date ? since.toISOString() : String(since)) : null;
  for (const { entry, p, line, text } of raw) {
    if (isClosingLine(entry)) continue;
    if (needle && !text.toLowerCase().includes(needle)) continue;
    if (sinceTs && (!entry.ts || entry.ts < sinceTs)) continue;
    const info = entry.id ? retired.get(entry.id) : null;
    if (info && !withRetired) continue;
    hits.push({
      ...entry,
      _source: path.relative(root, p),
      _line: line,
      ...(info ? { _retired: info } : {}),
    });
  }
  return hits;
}

export function listProjects(root) {
  const dir = path.join(root, 'projects');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Compact context dump for session start.
 * Recent errors, decisions, and events across global + all projects.
 */
/**
 * Current facts across global + every project, resolved for freshness.
 * Reads only the `timeline` log — facts meant to change — and folds each
 * `key` down to its current value, dropping retired versions. Pure over
 * the files it reads; no model, no network.
 */
export function currentFacts(root, { now = new Date(), staleDays = 120 } = {}) {
  const all = [];
  for (const project of [null, ...listProjects(root)]) {
    for (const e of readLog(root, 'timeline', { project }).entries) {
      if (!e.__broken) all.push(e);
    }
  }
  return freshness.resolveFacts(all, { now, staleDays, retired: retiredMap(all) });
}

/**
 * Every entry that belongs to a topic, across all types and projects.
 *
 * **Why topics exist.** `timeline` already folds a changing FACT onto its
 * current value via `key`. But most knowledge is not a fact with a value —
 * it is a subject that keeps developing: `architecture/auth-model` gathers
 * a decision, later an error against it, later a learning. Without a
 * handle for that, the only way to see "where does X stand now" is to
 * search and read everything. A `topic` is that handle: entries of ANY
 * type that share one, read newest-first, are the thread of a subject.
 *
 * Append-only stays intact — nothing is updated in place. The newest entry
 * is simply the current state, the rest is how it got there. Retired
 * (done/discarded/superseded) entries and closing lines drop out.
 *
 * Pure over the logs: no model, no network, no write.
 */
export function topicEntries(root, key = null) {
  const all = [];
  const seen = [];
  let seq = 0;
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      for (let i = 0; i < res.entries.length; i += 1) {
        const e = res.entries[i];
        seen.push(e);
        seq += 1;
        if (e.__broken || isClosingLine(e)) continue;
        const t = typeof e.topic === 'string' ? e.topic.trim() : '';
        if (!t) continue;
        if (key !== null && t !== key) continue;
        all.push({ ...e, _type: type, _project: project, _topic: t, _seq: seq });
      }
    }
  }
  const retired = retiredMap(seen);
  const live = all.filter((e) => !(e.id && retired.has(e.id)));
  // Timestamps are second-resolution, so three entries logged in one second
  // tie — and "what is the current state of this topic" must not then be
  // decided at random. `_seq` is the read order, which inside one log file
  // IS the write order. Across files within the same second it is merely
  // stable, not chronological; sub-second timestamps would be the real fix.
  live.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')) || (b._seq - a._seq));
  return live;
}

/** All topics with how big and how fresh they are, busiest first. */
export function topics(root) {
  const byKey = new Map();
  for (const e of topicEntries(root)) {
    if (!byKey.has(e._topic)) {
      byKey.set(e._topic, { topic: e._topic, count: 0, last: '', types: new Set() });
    }
    const t = byKey.get(e._topic);
    t.count += 1;
    t.types.add(e._type);
    if (String(e.ts ?? '') > t.last) t.last = String(e.ts ?? '');
  }
  return [...byKey.values()]
    .map((t) => ({ ...t, types: [...t.types].sort() }))
    .sort((a, b) => (b.last.localeCompare(a.last)) || (b.count - a.count));
}

/** One topic folded to its current state plus the trail that led there. */
export function topicState(root, key) {
  const entries = topicEntries(root, key);
  return {
    topic: key,
    current: entries[0] ?? null,
    history: entries.slice(1),
    count: entries.length,
  };
}

/**
 * The always-load core — cheap-mem's answer to "bake context into the
 * model" (Engram), minus the training. Instead of retraining weights or
 * re-retrieving every turn, it distills the *settled* facts worth carrying
 * in EVERY session into a small, bounded block you load once at the top.
 *
 * A fact belongs in the core when it is current, not stale, and not in
 * conflict — a truth that has stopped moving. The block is bounded (`max`)
 * so it stays cheap enough to always load; when more stable facts exist
 * than the budget, the *freshest* survive and the rest are counted, never
 * silently dropped.
 *
 * Pure over the `timeline` log: no model, no network, no write. Same
 * contract as search and facts.
 */
export function coreFacts(root, { now = new Date(), staleDays = 120, max = 40 } = {}) {
  const stable = currentFacts(root, { now, staleDays })
    .filter((f) => !f.stale && !f.conflict);
  const when = (f) => Date.parse(f.current.valid_from ?? f.current.ts ?? 0) || 0;
  // Rank by recency so the budget keeps the freshest truths ...
  const byFresh = [...stable].sort((a, b) => when(b) - when(a));
  const kept = byFresh.slice(0, Math.max(0, max));
  // ... but present in key order, so the block reads like a settled table.
  kept.sort((a, b) => a.key.localeCompare(b.key));
  return { kept, omitted: Math.max(0, stable.length - kept.length), total: stable.length };
}

export function core(root, { now = new Date(), staleDays = 120, max = 40 } = {}) {
  const { kept, omitted } = coreFacts(root, { now, staleDays, max });
  const out = [];
  out.push('=== cheap-mem core (stable facts, always-load) ===');
  out.push('# Current, non-stale, non-conflicting timeline facts. Deterministic, no model.');
  out.push('');
  if (kept.length === 0) {
    out.push('(no stable facts yet — log some with '
      + '`mem log timeline --key ... --value ... --valid_from ...`)');
  } else {
    for (const f of kept) out.push(freshness.formatFact(f));
  }
  if (omitted > 0) {
    out.push('');
    out.push(`(${omitted} more stable fact${omitted === 1 ? '' : 's'} beyond the budget `
      + `of ${max}; raise --max to include them)`);
  }
  return out.join('\n');
}

export function context(root, { n = 20 } = {}) {
  const half = Math.max(1, Math.floor(n / 2));
  const out = [];

  out.push('=== cheap-mem context ===');
  out.push('');
  out.push('Facts snapshot: see FACTS.md and global/facts.yaml');
  out.push('People:         see global/people.yaml');
  out.push('');

  const errors = recentEntries(root, 'error', n);
  out.push(`--- last ${errors.length} errors ---`);
  if (errors.length === 0) out.push('  (none)');
  for (const e of errors) {
    out.push(`  [${e.ts}] ${e._source}:${e._line}`);
    const short = shortText(e);
    if (short) out.push(`    ${short}`);
  }
  out.push('');

  const decisions = recentEntries(root, 'decision', half);
  out.push(`--- last ${decisions.length} decisions ---`);
  if (decisions.length === 0) out.push('  (none)');
  for (const e of decisions) {
    out.push(`  [${e.ts}] ${e._source}:${e._line}`);
    const short = shortText(e);
    if (short) out.push(`    ${short}`);
  }
  out.push('');

  const events = recentEntries(root, 'event', half);
  out.push(`--- last ${events.length} events ---`);
  if (events.length === 0) out.push('  (none)');
  for (const e of events) {
    out.push(`  [${e.ts}] ${e._source}:${e._line}`);
    const short = shortText(e);
    if (short) out.push(`    ${short}`);
  }
  out.push('');

  const facts = currentFacts(root);
  if (facts.length) {
    out.push(`--- current facts (${facts.length}) ---`);
    for (const f of facts.slice(0, n)) out.push('  ' + freshness.formatFact(f));
    out.push('');
  }

  const projects = listProjects(root);
  out.push(`--- projects (${projects.length}) ---`);
  if (projects.length === 0) out.push('  (none)');
  for (const p of projects) out.push(`  ${p}`);

  return out.join('\n');
}

export function recentEntries(root, type, n) {
  const all = [];
  for (const project of [null, ...listProjects(root)]) {
    const p = logPath(root, type, project);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); }
      catch { e = { __broken: true, raw: line, ts: '0' }; }
      all.push({ ...e, _source: path.relative(root, p), _line: i + 1 });
    }
  }
  all.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  return all.slice(0, n);
}

function shortText(e) {
  const parts = [];
  if (e.title) parts.push(e.title);
  if (e.topic) parts.push(`[${e.topic}]`);
  if (e.class) parts.push(`[${e.class}]`);
  if (e.text) parts.push(e.text.slice(0, 120).replace(/\s+/g, ' '));
  if (e.choice) parts.push(`→ ${e.choice}`);
  if (e.why) parts.push(`because ${e.why.slice(0, 80)}`);
  if (e.tags && Array.isArray(e.tags) && e.tags.length) parts.push(`#${e.tags.join(' #')}`);
  return parts.join(' — ');
}

/**
 * Create a project directory idempotently.
 * Missing files get written, existing files stay untouched.
 */
export function projectInit(root, name, { title = null } = {}) {
  checkProjectName(name);
  const dir = path.join(root, 'projects', name);
  const created = [];
  const existed = [];

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    created.push('.');
  } else {
    existed.push('.');
  }

  const files = [
    ['README.md', defaultReadme(name, title)],
    ['facts.yaml', `# stable facts about ${name}\nname: ${name}\n${title ? `title: ${JSON.stringify(title)}\n` : ''}`],
    ['sources.yaml', '# pointers to external files\nrepos: []\ndrives: []\n'],
    ['decisions.jsonl', ''],
    ['errors.jsonl', ''],
    ['events.jsonl', ''],
  ];

  for (const [name2, content] of files) {
    const p = path.join(dir, name2);
    if (fs.existsSync(p)) {
      existed.push(name2);
    } else {
      fs.writeFileSync(p, content, 'utf8');
      created.push(name2);
    }
  }

  return { dir, created, existed };
}

function defaultReadme(name, title) {
  const t = title ?? name;
  return `# Project: ${t}

- **key**: \`${name}\`
- **purpose**: TBD (fill in during first substantive session)
- **repos / sources**: see \`sources.yaml\`

Log entries land in the three JSONL files here.
`;
}

/**
 * Write a correction entry that supersedes an earlier one.
 *
 * Backwards-editing is forbidden: the wrong line stays visible; the
 * correction is a NEW line with `replaces_id: <old-id>`.
 */
export function correctionEntry(root, type, oldId, newData, { project = null } = {}) {
  if (typeof oldId !== 'string' || !oldId) {
    throw new Error('Correction needs an old id');
  }
  const { entries } = readLog(root, type, { project });
  const old = entries.find((e) => e.id === oldId);
  if (!old) {
    throw new Error(
      `Old id '${oldId}' not found in ${type}${project ? ` (project ${project})` : ''}. Correction without original is not allowed.`);
  }
  return logEntry(root, type, { ...newData, replaces_id: oldId }, { project });
}


/**
 * Fold the duty log into "still open" and "closed".
 *
 * A line with `closes_id` closes the duty with that id. The original
 * line stays exactly where it is — this function is a view, not a
 * mutation. It is the only folded view in the whole memory, and it
 * exists because an unfolded duty list is useless: nobody can read
 * fifty lines to work out which three things they still owe.
 */
export function openDuties(root, { project = undefined } = {}) {
  const targets = project === undefined
    ? [null, ...listProjects(root)]
    : [project === 'global' ? null : project];

  const all = new Map();      // id -> entry
  const closed = new Map();   // id -> {state, by, ts}

  for (const p of targets) {
    const file = logPath(root, 'duty', p);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trim()) continue;
      let e;
      try { e = JSON.parse(lines[i]); } catch { continue; }
      if (e.closes_id) {
        closed.set(e.closes_id, {
          state: e.state ?? DUTY_STATE.DONE,
          by: e.id,
          ts: e.ts,
          why: e.why ?? e.text ?? null,
        });
        continue;
      }
      if (!e.id) continue;
      all.set(e.id, {
        ...e,
        _source: path.relative(root, file),
        _line: i + 1,
        _project: p,
      });
    }
  }

  const open = [];
  const done = [];
  for (const [id, e] of all) {
    const shut = closed.get(id);
    if (shut) done.push({ ...e, _closed: shut });
    else open.push(e);
  }
  open.sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
  done.sort((a, b) => (b._closed.ts ?? '').localeCompare(a._closed.ts ?? ''));
  return { open, done };
}

/**
 * Close a duty. Appends a line; never touches the original.
 * Refuses if the id does not exist — closing a duty that was never
 * opened means someone mistyped, and a memory that accepts that is
 * quietly wrong.
 */
export function closeDuty(root, id, { state = DUTY_STATE.DONE, why = null, project = null } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('closeDuty needs an id');
  if (!Object.values(DUTY_STATE).includes(state)) {
    throw new Error(`Unknown duty state '${state}'. Known: ${Object.values(DUTY_STATE).join(', ')}`);
  }
  const { open } = openDuties(root, { project: project ?? undefined });
  if (!open.some((d) => d.id === id)) {
    throw new Error(`No open duty with id '${id}'.`);
  }
  return logEntry(root, 'duty', { closes_id: id, state, why }, { project });
}

// --- Lifecycle: discarded / done / superseded ----------------------
//
// A memory that shows the user stale material in everyday recall loses
// its trust. A discarded thought or a finished task must stop surfacing
// as if it were still live — but append-only means never delete, never
// rewrite. So: append a "tombstone" line pointing at the id. The
// original stays put (the viewer still shows it, marked); recall hides
// it from here on.
//
// Three sources of a retirement, all append-only, all in the SAME log
// as their target:
//   - retires_id  : the general tombstone (mem discard / mem done)
//   - closes_id   : closing a duty (already existed)
//   - replaces_id : a correction supersedes the original (already existed)

/**
 * Build the map of retired ids from parsed entries:
 * id -> { state, why, by, ts }. Pure, no I/O, so the BM25 index
 * (search.mjs), memory.find and the viewer share one truth.
 */
export function retiredMap(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!e) continue;
    if (e.retires_id) {
      map.set(e.retires_id, {
        state: e.state ?? DUTY_STATE.DONE,
        why: e.why ?? e.text ?? null, by: e.id ?? null, ts: e.ts ?? null,
      });
    }
    if (e.closes_id) {
      map.set(e.closes_id, {
        state: e.state ?? DUTY_STATE.DONE,
        why: e.why ?? e.text ?? null, by: e.id ?? null, ts: e.ts ?? null,
      });
    }
    if (e.replaces_id) {
      map.set(e.replaces_id, {
        state: 'superseded', why: null, by: e.id ?? null, ts: e.ts ?? null,
      });
    }
  }
  return map;
}

/**
 * Is this a pure closing/tombstone line with no content of its own?
 * (Correction lines carrying `replaces_id` DO carry the new content and
 * do NOT count — they are the current truth.)
 */
export function isClosingLine(e) {
  return Boolean(e && (e.retires_id || e.closes_id));
}

/** Allowed states when retiring an entry. */
export const RETIRE_STATE = Object.freeze(['done', 'discarded', 'obsolete']);

/**
 * Retire an entry — mark it done/discarded/obsolete without deleting it.
 * Appends a tombstone line into the SAME log:
 *   { id, ts, retires_id: <id>, state, why? }
 */
export function retireEntry(root, type, id, { state = 'done', why = null, project = null } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('Retiring needs an id');
  if (!RETIRE_STATE.includes(state)) {
    throw new Error(`Unknown state '${state}'. Allowed: ${RETIRE_STATE.join(', ')}`);
  }
  const { entries } = readLog(root, type, { project });
  const target = entries.find((e) => e.id === id && !isClosingLine(e));
  if (!target) {
    throw new Error(`id '${id}' not found in ${type}${project ? ` (project ${project})` : ''}.`);
  }
  const data = { retires_id: id, state };
  if (why) data.why = why;
  return logEntry(root, type, data, { project });
}

/**
 * Where does this id live? Scans every log (global + projects) for the
 * CONTENT entry with this id (not a tombstone). Returns { type, project }
 * or null.
 */
export function findEntryLocation(root, id) {
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      const { entries } = readLog(root, type, { project });
      if (entries.some((e) => e.id === id && !isClosingLine(e))) {
        return { type, project };
      }
    }
  }
  return null;
}

/**
 * Fetch one entry by id — the second stage of retrieval. `find` returns
 * compact hits; when the caller wants the FULL text of one of them, it
 * pulls it here instead of every hit landing full in the prompt. Returns
 * the entry (with _source/_type/_project) or null.
 */
export function getEntry(root, id) {
  const loc = findEntryLocation(root, id);
  if (!loc) return null;
  const { entries } = readLog(root, loc.type, { project: loc.project });
  const e = entries.find((x) => x.id === id && !isClosingLine(x));
  if (!e) return null;
  return { ...e, _type: loc.type, _project: loc.project,
    _source: `${loc.type}${loc.project ? `/${loc.project}` : ''}` };
}

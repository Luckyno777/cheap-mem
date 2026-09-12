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
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import * as freshness from './freshness.mjs';
import * as authority from './authority.mjs';

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
  question: 'questions.jsonl',   // something we do NOT know. No debtor and
                                 // no lifecycle of its own: it closes over
                                 // the existing `resolves` edge. See
                                 // src/question.mjs.
  skill: 'skills.jsonl',         // a capability acquired, with evidence
  procedure: 'procedures.jsonl', // a norm for ALL — "this is how we do it
                                 // here". NOT the same as `skill`: a
                                 // capability is acquired, a procedure is
                                 // issued. Only a human can issue one and
                                 // the MCP bridge does not write it at all.
                                 // See src/procedure.mjs.
  source: 'sources.jsonl',       // a pointer at knowledge that already exists —
                                 // indexed, not copied. Local files live in
                                 // the store, the entry carries the hash and
                                 // a capped, redacted excerpt. See
                                 // src/source.mjs.
  update: 'updates.jsonl',       // a version, a dependency, a config change
  link: 'links.jsonl',           // a typed relation between two entries
});

/**
 * The closed vocabulary of relations between entries.
 *
 * Deliberately small. An open vocabulary would let every digest run invent
 * a new verb, and a graph whose edges mean whatever the writer felt that
 * day cannot be traversed by code — only re-read by a model, which is the
 * cost this whole design exists to avoid.
 */
export const LINK_KINDS = Object.freeze({
  causes: 'the source brought the target about',
  generalizes: 'the source is the lesson drawn from the target(s)',
  contradicts: 'the source and target cannot both be right',
  resolves: 'the source closed the target out',
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

/**
 * Names a project may not take, because something else already means
 * them. `global` is the sharp one: every filter treats `project:
 * 'global'` as "the root bucket, not a project", so a project actually
 * named global becomes unreachable through its own name — the query
 * silently answers about somewhere else.
 */
export const RESERVED_PROJECT_NAMES = Object.freeze(['global', 'raw', 'inbox']);

export function checkProjectName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Project name missing');
  }
  if (RESERVED_PROJECT_NAMES.includes(name)) {
    throw new Error(
      `Project name '${name}' is reserved — it already means something else `
      + `in every filter. Reserved: ${RESERVED_PROJECT_NAMES.join(', ')}`);
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
  // The project name is validated HERE, not only where a project is
  // created. checkProjectName existed from the start but was called
  // only from projectInit, so `mem log --project ../../../../tmp/x`
  // walked straight out of the memory and logEntry created the
  // directories on the way: verified, a file landed outside the root.
  //
  // It matters more than a stray file. The permission the docs describe
  // as narrow — `Bash(node <root>/bin/mem:*)`, granted to the unattended
  // digest — was enough on its own to write anywhere the process can
  // reach, with no git or file permission at all. This is the one place
  // every caller (CLI, MCP server, library) funnels through.
  if (project !== null && project !== undefined) checkProjectName(project);
  const file = TYPES[type];
  return project
    ? path.join(root, 'projects', project, file)
    : path.join(root, 'global', file);
}

/**
 * Append a line to a JSONL log. Never modifies an existing line.
 * If an entry needs correction, a new line with `replaces_id` is written.
 */
/**
 * Who is writing, when nobody said.
 *
 * **The finding (2026-09-08, reference deployment).** 855 of 1081
 * entries carried no agent field — 79 %. Only the MCP bridge stamped
 * one; the CLI never did. A field that is absent three quarters of the
 * time is not an axis, it is an anecdote: `mem agents`, every
 * authority comparison and the error broadcast all rest on it.
 *
 * **Why never a fallback to 'session'.** That would be an INVENTED
 * origin, and an invented origin is worse than none — it looks
 * credible, so a later reader takes it for evidence. `human:<user>` is
 * true: somebody typed this at a shell. The prefix keeps the human and
 * machine sets disjoint so the agent board can show both without
 * confusing them.
 *
 * **Old entries are NOT backfilled.** Stamping them now would be
 * inventing origin at scale. The corpus heals forward.
 */
export function agentDefault(env = process.env) {
  const set = String(env.CHEAP_MEM_AGENT ?? env.MEM_AGENT ?? '').trim();
  if (set) return set;
  let user = String(env.USER ?? env.LOGNAME ?? env.USERNAME ?? '').trim();
  if (!user && env === process.env) {
    try { user = String(os.userInfo().username ?? '').trim(); } catch { /* no account readable */ }
  }
  return user ? `human:${user}` : 'human:unnamed';
}

export function logEntry(root, type, data, { project = null, now = new Date() } = {}) {
  // The agent comes from the origin stamp when it is not set explicitly.
  // Two routes, so the second axis fills itself without every caller
  // having to remember:
  //   origin.agent    what the digest writes in
  //   origin.surface  vm -> vm-admin, cloud -> session
  // Without this the agent board stays empty while several agents write —
  // and then nobody can see who actually contributed what.
  if (!data.agent && data.origin && typeof data.origin === 'object') {
    const o = data.origin;
    const derived = o.agent ?? ({ vm: 'vm-admin', cloud: 'session' })[o.surface];
    if (typeof derived === 'string' && derived.trim()) {
      data = { ...data, agent: derived.trim() };
    }
  }
  // **Only now the default** — after the explicit field and after the
  // origin stamp have had their turn. The first version of this stamped
  // it FIRST and thereby won every time: `origin.surface` never derived
  // anything again, and a digest run's entries came out as
  // `human:<whoever ran it>`. A default that runs before the real
  // sources is not a default, it is an override. Caught by the existing
  // agents test, not by reading the code.
  if (!data.agent) data = { ...data, agent: agentDefault() };

  // Authority: normalised if given, left ABSENT if not.
  //
  // Deliberately not defaulted to a tier here. A CLI write could be the
  // owner typing or an agent scripting, and this function cannot tell —
  // guessing 'user' would hand every script the top tier, and stamping
  // 'unknown' on everything would make legacy and new data
  // indistinguishable. An absent field reads as `unknown` at comparison
  // time, which is the same conservative answer without pretending the
  // question was asked.
  if (data.authority !== undefined) {
    const t = String(data.authority).toLowerCase().trim();
    data = { ...data, authority: authority.TIERS.includes(t) ? t : authority.DEFAULT_TIER };
  }

  // Ceiling on the write path.
  //
  // A process may be run with CHEAP_MEM_MAX_AUTHORITY, and then no entry
  // it writes can claim a higher tier than that — whatever it puts in the
  // field. The digest sets it to `inferred`, because a model's output IS
  // an inference over other claims, and because text inside a captured
  // transcript can steer what the digest emits. Without the ceiling a
  // sentence in someone else's document could mint a `user`-tier claim.
  //
  // Enforced here rather than by instructing the writer: an instruction is
  // a request, and the thing being constrained is precisely a process that
  // may have been told otherwise. The demotion is RECORDED, never silent.
  const ceiling = authority.ceilingFromEnv();
  if (ceiling) {
    const c = authority.clampTier(data.authority ?? authority.DEFAULT_TIER, ceiling);
    // Only ever LOWERS. An unstamped write stays unstamped — stamping it
    // with the ceiling would turn a ceiling into a floor and raise an
    // entry of genuinely unknown provenance above `unknown`, which is the
    // opposite of what this is for.
    if (c.clamped) {
      data = { ...data, authority: c.tier, authority_clamped_from: c.from };
    }
  }

  const p = logPath(root, type, project);
  const ts = data.ts ?? new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  // A SUPPLIED id is checked against the whole corpus; a generated one is
  // not. That asymmetry is deliberate.
  //
  // Ids are unique across types and projects, and every resolver takes the
  // FIRST match. A second line with the same id therefore does not surface
  // an error — it silently moves what every link points at. The sibling
  // project lucky-mem carries exactly one such duplicate, and it came in
  // on this path: copied or migrated, not rolled.
  //
  // For generated ids the check would be theatre. At ~62 bits and a
  // million entries the collision probability is around 1e-7, and putting
  // an O(n) scan on the hot path would make a batch write O(n^2) for a
  // case that does not occur. The doctor catches it if the maths ever
  // surprises us.
  if (data.id && takenIds(root).has(data.id)) {
    throw new Error(
      `The id '${data.id}' is already taken. Ids are unique across types and `
      + 'projects; otherwise resolvers take the first match and every link '
      + 'points somewhere else depending on scan order. Omit --id and one is '
      + 'generated.');
  }
  const id = data.id ?? shortId();
  const entry = { id, ts, ...data };

  fs.mkdirSync(path.dirname(p), { recursive: true });

  const line = JSON.stringify(entry);
  if (line.includes('\n')) {
    throw new Error('Newline in log entry — would break JSONL format');
  }
  fs.appendFileSync(p, `${line}\n`, 'utf8');
  return { path: p, entry };
}

/** Length of a generated id. Always this, never "usually this". */
export const ID_LENGTH = 12;

/**
 * A generated id: ~62 bits of real randomness, base36, fixed length.
 *
 * The previous version hashed `ts|type|Math.random()` with djb2 and masked
 * the result to 32 bits. Two problems, and the second is the bad one:
 *
 *   - 32 bits is not enough. The birthday bound puts a collision at
 *     roughly 1 % by 10k entries and about 69 % by 100k — for a memory
 *     that is meant to be kept for years, that is a matter of when.
 *   - `Math.random()` is not a source anyone should build identity on.
 *
 * The sibling project lucky-mem found a duplicate id in 874 entries and
 * moved to this scheme; the same arithmetic applies to any corpus.
 *
 * Leading zeros are padded so the length is ALWAYS 12. Otherwise it would
 * be 12 *most of the time*, and "most of the time" is exactly the kind of
 * promise that surprises someone later.
 */
function shortId() {
  let out = '';
  while (out.length < ID_LENGTH) {
    out += BigInt(`0x${randomBytes(8).toString('hex')}`).toString(36);
  }
  return out.slice(0, ID_LENGTH);
}

/**
 * Every id already handed out. Only used when a caller SUPPLIES an id —
 * see the note at the call site for why generated ids skip it.
 */
function takenIds(root) {
  const all = new Set();
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      for (const e of readLog(root, type, { project }).entries) {
        if (e && e.id) all.add(e.id);
      }
    }
  }
  return all;
}

/**
 * Read a JSONL log. Three states: missing file, empty log, has entries.
 */
/**
 * What has already happened under this error class?
 *
 * **Why this exists.** On 2026-09-07 a first-time install on someone
 * else's machine turned up four defects in one hour. Three of them fell
 * into classes the memory already held — one with the same root cause,
 * six days old, written down in the sibling repository and explicitly
 * marked as a lesson. The knowledge was there every time. Nobody asked,
 * because asking is a separate act.
 *
 * An archive you MUST query does not get queried. So it queries itself,
 * at the moment of logging — when the class is being typed anyway and
 * the head is already on the subject. One pass over the error drawers;
 * no model, no network.
 *
 * `except` takes the id that was just written. Without it every log
 * call would report itself as a repeat, and a warning that always fires
 * is not a warning.
 */
export function sameClass(root, className, { except = null, max = 3 } = {}) {
  const wanted = String(className ?? '').trim();
  if (!wanted) return { className: wanted, count: 0, latest: [] };
  const hits = [];
  for (const project of [null, ...listProjects(root)]) {
    let entries = [];
    try { ({ entries } = readLog(root, 'error', { project })); } catch { continue; }
    for (const e of entries) {
      if (e?.class !== wanted) continue;
      if (except && e.id === except) continue;
      hits.push({ id: e.id, ts: e.ts ?? '', title: e.title ?? '', project });
    }
  }
  // Newest first: the last case is the one still likely to hold.
  hits.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { className: wanted, count: hits.length, latest: hits.slice(0, max) };
}

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
    // A directory whose name logPath would reject must not be handed
    // back either — enumeration would otherwise feed an invalid name
    // straight into the function that refuses it, and every read across
    // all projects (context, core, search) would throw on one stray
    // directory rather than skip it.
    .filter((name) => { try { checkProjectName(name); return true; } catch { return false; } })
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
 * Every entry in the memory, indexed by id — the substrate the link graph
 * is traversed against. Ids are unique across types, so one flat map is
 * enough. Closing lines are bookkeeping, not content, and stay out.
 */
export function entriesById(root) {
  const byId = new Map();
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      // Retirement is per log file, so the map is built from the same
      // lines. Everything downstream of this — links, standing,
      // experiences, and through them `mem core` — inherits the answer,
      // which is why a retired learning used to keep showing up as
      // something the memory stands behind.
      const retired = retiredMap(res.entries);
      for (const e of res.entries) {
        if (!e.id || !holds(e, retired)) continue;
        if (!byId.has(e.id)) byId.set(e.id, { ...e, _type: type, _project: project });
      }
    }
  }
  return byId;
}

/**
 * The link graph around one entry: what points at it, and what it points
 * at. Both directions, because "why did this break" and "what did this
 * cause" are the same edge read from opposite ends.
 *
 * **Model-free.** The edges were written by the digest — the one place a
 * model runs — but walking them is pure code. That is the whole trade:
 * pay a model once, at sorting time, to earn a structure that costs
 * nothing to use forever after.
 *
 * A link whose `from`/`to` does not resolve is reported as `dangling`
 * rather than silently skipped: an edge into nothing is a real defect,
 * and hiding it would make the graph look healthier than it is.
 */
export function linksOf(root, id) {
  const byId = entriesById(root);
  const out = [];
  const incoming = [];
  const dangling = [];
  for (const project of [null, ...listProjects(root)]) {
    let res;
    try { res = readLog(root, 'link', { project }); } catch { continue; }
    for (const l of res.entries) {
      if (l.__broken || isClosingLine(l)) continue;
      const from = l.from ?? l.source ?? null;
      const to = l.to ?? l.target ?? null;
      if (!from || !to) continue;
      if (from !== id && to !== id) continue;
      const other = from === id ? to : from;
      const rec = { link: l, kind: l.kind ?? '?', from, to, other, entry: byId.get(other) ?? null };
      if (!byId.has(from) || !byId.has(to)) dangling.push(rec);
      else if (from === id) out.push(rec);
      else incoming.push(rec);
    }
  }
  return { id, entry: byId.get(id) ?? null, out, incoming, dangling };
}

/**
 * How well each entry is BACKED by the rest of the memory.
 *
 * **What makes an experience real.** A conclusion drawn once is a guess.
 * It becomes experience when reality keeps re-confirming it — so strength
 * here is not a usage counter and not a model's opinion, it is simply
 * *how many other entries lean on this one*: entries that cite it in
 * `origin.derived_from`, and link edges that point at it.
 *
 * That choice matters. Counting how often something is *retrieved* would
 * reward popularity, not usefulness, and would need per-machine telemetry
 * that never travels with the repo. Citations are already in the corpus,
 * are written deliberately, and every clone computes the same number.
 *
 * `contested` is the falsifiability half: a `contradicts` edge pointing at
 * an entry does NOT delete or weaken it silently — it flags it, so the
 * claim keeps standing in the open, with its challenge attached. An
 * experience you cannot argue with is a dogma.
 */
export function standing(root) {
  const byId = entriesById(root);
  const rec = new Map();
  const of = (id) => {
    if (!rec.has(id)) rec.set(id, { id, cited: 0, contested: false, by: [] });
    return rec.get(id);
  };

  for (const [, e] of byId) {
    const from = e.origin && e.origin.derived_from;
    if (Array.isArray(from)) {
      for (const src of from) {
        if (typeof src !== 'string' || !byId.has(src)) continue;
        const r = of(src);
        r.cited += 1;
        r.by.push(e.id);
      }
    }
  }

  for (const project of [null, ...listProjects(root)]) {
    let res;
    try { res = readLog(root, 'link', { project }); } catch { continue; }
    for (const l of res.entries) {
      if (l.__broken || isClosingLine(l)) continue;
      const to = l.to ?? l.target ?? null;
      const fromId = l.from ?? l.source ?? null;
      if (!to || !byId.has(to)) continue;
      const r = of(to);
      if (l.kind === 'contradicts') r.contested = true;
      else { r.cited += 1; if (fromId) r.by.push(fromId); }
    }
  }
  return rec;
}

/**
 * The experiences the memory is prepared to stand behind: learnings,
 * strongest first, each with what backs it and whether anything disputes
 * it. Deterministic — no model, no telemetry.
 */
export function experiences(root, { minCited = 0, type = 'learning' } = {}) {
  const back = standing(root);
  const out = [];
  for (const [, e] of entriesById(root)) {
    if (e._type !== type) continue;
    const r = back.get(e.id) ?? { cited: 0, contested: false, by: [] };
    if (r.cited < minCited) continue;
    out.push({ ...e, cited: r.cited, contested: r.contested, backedBy: r.by });
  }
  out.sort((a, b) => (b.cited - a.cited)
    || String(b.ts ?? '').localeCompare(String(a.ts ?? '')));
  return out;
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
  const alias = topicAliases(root);
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
        const raw = typeof e.topic === 'string' ? e.topic.trim() : '';
        if (!raw) continue;
        // Merged topics resolve on READ. The line on disk stays exactly
        // as it was written.
        const t = alias.get(raw) ?? raw;
        if (key !== null && t !== key) continue;
        all.push({ ...e, _type: type, _project: project, _topic: t, _topic_raw: raw, _seq: seq });
      }
    }
  }
  const retired = retiredMap(seen);
  const live = all.filter((e) => holds(e, retired));
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
      byKey.set(e._topic, {
        topic: e._topic, count: 0, last: '', types: new Set(), projects: new Map(),
      });
    }
    const t = byKey.get(e._topic);
    t.count += 1;
    t.types.add(e._type);
    // The project of an entry IS the topic's area — not a prefix somebody
    // has to type into the name. See topicTree(): this is what the
    // grouping hangs off.
    const pj = e._project ?? '(global)';
    t.projects.set(pj, (t.projects.get(pj) ?? 0) + 1);
    if (String(e.ts ?? '') > t.last) t.last = String(e.ts ?? '');
  }
  return [...byKey.values()]
    .map((t) => ({
      ...t,
      types: [...t.types].sort(),
      // The area is whichever project contributes most of the topic's
      // entries. A topic that spans projects belongs where its centre of
      // gravity is, and `projects` stays beside it so you can see the rest.
      area: [...t.projects.entries()].sort((a, b) => b[1] - a[1])[0][0],
      projects: Object.fromEntries(t.projects),
    }))
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

export function core(root, {
  now = new Date(), staleDays = 120, max = 40, maxExperiences = 8,
} = {}) {
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

  // Backed experience rides the same rail as the facts: a lesson the rest
  // of the memory keeps leaning on belongs in EVERY session, not only in
  // the one that happens to search for it. Only cited ones — an uncited
  // learning is still just a claim — and a contested one says so rather
  // than quietly passing as settled.
  if (maxExperiences > 0) {
    const exp = experiences(root, { minCited: 1 }).slice(0, maxExperiences);
    if (exp.length) {
      out.push('');
      out.push('--- experience (backed by the rest of the memory) ---');
      for (const e of exp) {
        const mark = e.contested ? '  [CONTESTED]' : '';
        out.push(`${e.title ?? e.text ?? e.id}  (backed x${e.cited})${mark}`);
      }
    }
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

  // Retired entries and their tombstones are BOTH dropped here, and that
  // is not tidiness. This feeds `mem context` and `mem core`, which the
  // SessionStart hook prints into every session — so without it, advice
  // the user explicitly discarded keeps being loaded as current, while
  // `mem find` correctly hides it. Two answers from one memory about the
  // same entry is worse than either answer alone.
  //
  // The tombstone has to go too: it carries only `why`, so it rendered
  // as an entry of its own ("because vendor X shut down") with no hint
  // that it is a retraction of the line above it.
  const retired = retiredMap(all);
  const live = all.filter((e) => holds(e, retired));

  live.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  return live.slice(0, n);
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

  // A supersession has to be checked against the claim it supersedes, so
  // the log is indexed first. Two passes, because a correction may appear
  // before its target in file order — merge=union makes no promise about
  // which side lands first.
  const byId = new Map();
  for (const e of entries) {
    if (e && typeof e.id === 'string' && e.id && !byId.has(e.id)) byId.set(e.id, e);
  }

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
      const target = byId.get(e.replaces_id);

      // Target not in this set: a drawer read in isolation cannot see a
      // correction that lives elsewhere. Allowing it preserves the
      // behaviour every caller had before the rule existed; the GLOBAL
      // check, where every entry is visible, is `mem doctor` (integrity).
      // Refusing here would break legitimate cross-drawer corrections to
      // catch an attacker who can simply write in the same drawer anyway.
      const verdict = target
        ? authority.maySupersede(e, target)
        : { ok: true, reason: 'target not in this view — checked globally by doctor' };

      if (verdict.ok) {
        map.set(e.replaces_id, {
          state: 'superseded', why: null, by: e.id ?? null, ts: e.ts ?? null,
        });
      } else if (e.id) {
        // Append-only: the attempt is NOT rejected and NOT removed. The
        // target simply stays active, and the attempting claim is marked
        // disputed — which keeps it out of retrieval while leaving it
        // fully readable in the log, in `doctor`, and in the viewer.
        //
        // That asymmetry is the defence against flooding: writing
        // disputed claims costs the attacker writes and the defender
        // bytes, and buys no influence over any assembled context.
        map.set(e.id, {
          state: 'disputed', why: verdict.reason,
          by: e.replaces_id, ts: e.ts ?? null,
        });
      }
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

/**
 * Does this entry still count? — THE one derivation.
 *
 * Three reasons an entry stops being an answer, and until now they
 * were assembled by hand at twelve call sites:
 *
 *   __broken           the line would not parse
 *   isClosingLine      it is a tombstone, not a statement
 *   retired.has(id)    a later line replaced it
 *
 * Counted on 2026-09-12: twelve sites, writing the filter in three
 * different combinations. Checked one by one they agreed — most had
 * already handled two of the three a loop earlier. Agreeing by
 * accident is not a guarantee, though: whoever adds the next condition
 * (and the supersession chain has gained two in half a year) adds it
 * in one place and not in eleven. Then the memory gives two answers
 * about the same entry, and a reader holding both cannot say which one
 * is lying.
 *
 * So the verdict lives here, once, and every surface renders it. The
 * conditions are deliberately NOT individually switchable: a switch
 * would be the twelve versions coming back through the side door.
 */
export function holds(e, retired = null) {
  if (!e || e.__broken) return false;
  if (isClosingLine(e)) return false;
  if (retired && e.id && retired.has(e.id)) return false;
  return true;
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

// ---------------------------------------------------------------------
// Topics: the shape, not just the content
//
// **Measured on 2026-09-05, on a real 553-entry memory.** 69 entries
// carried a `topic`, and those produced 69 distinct topics. Ratio 1.00.
// Of 65 first-path-segment roots, 63 had exactly one child. Several
// "topics" were whole sentences.
//
// A topic with exactly one entry is not a topic. It is a second title
// field. The thread a topic is supposed to carry — a decision, later the
// error against it, later the lesson from that — only exists once a LATER
// entry reuses the same topic.
//
// The cause was a missing rule, not a model failure: the digest spec
// listed `topic` as required without ever saying what a topic IS. Given a
// required field and no definition, a model fills it per entry. That is
// rational behaviour.
//
// What follows is the deterministic half of the repair: a check that
// reports broken shapes at write time, and a tree that makes an existing
// pile of singletons legible without rewriting one line of history.

// --- Merging topics without rewriting history -------------------------
//
// Even after deriving the area from the project, one memory still had 40
// topics for 40 entries in a single area — four of which (`payments`,
// `payment-transfer`, `payment-details`, `payment-class`) were plainly the
// same subject. Renaming them would mean touching lines that were already
// written; the memory is append-only, and that is precisely what makes it
// trustworthy.
//
// So: a second log rather than a correction. A merge is a NEW line saying
// "these two names mean the same thing". It is applied on READ; nothing
// about writing changes. Whoever opens the raw file still sees what stood
// there at the time — and, beside it, how it reads today.

export const ALIAS_LOG = 'global/topic-aliases.jsonl';

/**
 * The merges as a resolved map: old name -> final name.
 *
 * Chains are followed (a->b, b->c yields a->c); cycles stop instead of
 * spinning. A cycle is an operator mistake, not a reason to crash.
 */
export function topicAliases(root) {
  const p = path.join(root, ALIAS_LOG);
  const raw = new Map();
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (typeof e.from === 'string' && typeof e.to === 'string' && e.from !== e.to) {
          raw.set(e.from, e.to);
        }
      } catch { /* skip a broken line */ }
    }
  }
  const resolved = new Map();
  for (const start of raw.keys()) {
    let target = raw.get(start);
    const seen = new Set([start]);
    while (raw.has(target) && !seen.has(target)) { seen.add(target); target = raw.get(target); }
    resolved.set(start, target);
  }
  return resolved;
}

/** Fold two or more topics into one name. */
export function mergeTopics(root, from, to, { why = '', agent = null, now = new Date() } = {}) {
  const target = String(to ?? '').trim();
  if (!target) throw new Error('mergeTopics: no target topic.');
  const sources = (Array.isArray(from) ? from : [from]).map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!sources.length) throw new Error('mergeTopics: no source topic.');
  const p = path.join(root, ALIAS_LOG);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ts = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const written = [];
  for (const src of sources) {
    if (src === target) continue;
    const line = { ts, from: src, to: target, why: String(why || ''), ...(agent ? { agent } : {}) };
    fs.appendFileSync(p, `${JSON.stringify(line)}\n`, 'utf8');
    written.push(line);
  }
  return { target, written };
}

/** A topic is at most this long. Past it, it is a title. */
export const TOPIC_MAX = 40;

/**
 * Checks the SHAPE of a topic — not whether it is the right one.
 *
 * Deliberately a warning and never an abort: `mem log` is the path along
 * which things get saved that would otherwise be forgotten. A write that
 * fails on a naming rule loses the content. Better recorded and flagged
 * than clean and gone.
 */
export function checkTopic(topic, { area = null } = {}) {
  const t = String(topic ?? '').trim();
  if (!t) return { ok: true, warnings: [] };
  const w = [];
  if (t.length > TOPIC_MAX) {
    w.push(`${t.length} characters (over ${TOPIC_MAX}) — that is a title, not a topic`);
  }
  if (/[.!?,;:]|\s\(/.test(t)) {
    w.push('punctuation — a topic is a handle like "viewer/design", not a sentence');
  }
  if (t.split(/\s+/).length > 4) {
    w.push('more than four words — shorter, and split it with /');
  }
  // No "/" is NOT an error any more. Until 2026-09-05 this check demanded
  // a prefix — and that was backwards: the area comes from the entry's
  // project, not from the name. A prefix repeating the project is, if
  // anything, noise.
  if (area && t.startsWith(`${area}/`)) {
    w.push(`repeats the project ('${area}') — the area already comes from there, `
      + `shorter: '${t.slice(area.length + 1)}'`);
  }
  return { ok: w.length === 0, warnings: w, topic: t };
}

/**
 * Topics as a TREE over their path segments, biggest branch first.
 *
 * Why this is half the fix: `viewer/design`, `viewer/motion` and
 * `viewer/pwa` are three rows among sixty-six in a flat list. As a branch
 * they are one row with three children — and you can see at a glance what
 * is actually a thread and what is orphaned.
 *
 * Computed purely from the existing names. No model, no rewriting, no new
 * field: today's singletons become legible immediately rather than after
 * a cleanup pass.
 */
export function topicTree(root) {
  const flat = topics(root);
  const branches = new Map();
  for (const t of flat) {
    // The area comes from the PROJECT, not from a prefix in the name.
    // That is the 2026-09-05 correction: 72 topics looked like 72 areas
    // when in truth there were four. The grouping people were asking for
    // had been there all along — it was called `project`. A prefix in the
    // topic name was a duplicate of it (`cheap-mem/retrieval` inside
    // `project: cheap-mem`) and helped precisely where it was not needed.
    const area = t.area;
    // If the name repeats the area, the prefix goes — otherwise the same
    // word would stand twice in one row.
    const parts = t.topic.split('/');
    const leaf = (parts.length > 1 && parts[0] === area) ? parts.slice(1).join('/') : t.topic;
    if (!branches.has(area)) {
      branches.set(area, { area, count: 0, last: '', children: [] });
    }
    const b = branches.get(area);
    b.children.push({ ...t, leaf });
    b.count += t.count;
    if (String(t.last ?? '') > b.last) b.last = String(t.last ?? '');
  }
  return [...branches.values()]
    .map((b) => ({
      ...b,
      // A branch with one child is itself a singleton — the tree should
      // show that, not hide it.
      orphan: b.children.length === 1,
      children: b.children.sort((x, y) => String(y.last ?? '').localeCompare(String(x.last ?? ''))),
    }))
    .sort((x, y) => y.children.length - x.children.length
      || String(y.last ?? '').localeCompare(String(x.last ?? '')));
}

/**
 * What there is to say about the topic landscape, as numbers.
 *
 * So that "the digest slices topics too finely" stops being taste and
 * becomes a figure you measure before and after a change. `mem doctor`
 * reads this.
 */
export function topicQuality(root) {
  const flat = topics(root);
  const tree = topicTree(root);
  const withTopic = topicEntries(root).length;
  const singles = flat.filter((t) => t.count === 1).length;
  const malformed = flat.filter((t) => !checkTopic(t.topic, { area: t.area }).ok).length;
  return {
    topics: flat.length,
    entriesWithTopic: withTopic,
    // 1.00 means every topic has exactly one entry — then the field
    // carries no thread, it duplicates the title.
    entriesPerTopic: flat.length ? Number((withTopic / flat.length).toFixed(2)) : 0,
    singleTopics: singles,
    singleShare: flat.length ? Number((singles / flat.length).toFixed(2)) : 0,
    areas: tree.length,
    orphanAreas: tree.filter((b) => b.orphan).length,
    malformed,
  };
}


// ---------------------------------------------------------------------
// Agents as a second axis
//
// `project` says WHAT ABOUT, `agent` says WHO. Two axes, not substitutes:
// the same entry belongs to `project: payments` and to `agent: vm-admin`.
// The field is an address, not a fence — every agent still reads
// everything, and the single digest still sees it all together.
//
// It is read from the entry itself (`agent`) or, failing that, from the
// origin stamp (`origin.agent`). The stamp is the older form and is never
// rewritten after the fact.

const agentOf = (e) => {
  const a = e.agent ?? (e.origin && (e.origin.agent ?? e.origin.agent_name));
  return typeof a === 'string' && a.trim() ? a.trim() : null;
};

/**
 * What the memory knows about ONE agent: what it contributed, what it
 * works on, when it last left something behind.
 *
 * This is the data behind the agent board. Deliberately from the same
 * logs as everything else — an agent gets no store of its own, only its
 * own view of the shared one.
 */
export function agentState(root, name) {
  const wanted = String(name ?? '').trim();
  const entries = [];
  const seen = [];
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      for (const e of res.entries) {
        seen.push(e);
        if (e.__broken || isClosingLine(e)) continue;
        if (agentOf(e) !== wanted) continue;
        entries.push({ ...e, _type: type, _project: project });
      }
    }
  }
  const retired = retiredMap(seen);
  const live = entries.filter((e) => holds(e, retired));
  live.sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')));

  const types = {};
  const projects = {};
  const topicSet = new Set();
  for (const e of live) {
    types[e._type] = (types[e._type] ?? 0) + 1;
    const p = e._project ?? '(global)';
    projects[p] = (projects[p] ?? 0) + 1;
    if (typeof e.topic === 'string' && e.topic.trim()) topicSet.add(e.topic.trim());
  }
  return {
    agent: wanted,
    count: live.length,
    retired: entries.length - live.length,
    last: live[0] ? String(live[0].ts ?? '') : '',
    types,
    projects,
    topics: [...topicSet].sort(),
    newest: live.slice(0, 10).map((e) => e.id).filter(Boolean),
  };
}

/**
 * Every agent that APPEARS in the memory — even without a folder under
 * `agents/`.
 *
 * That is the whole point: the board should show the difference. An agent
 * with a folder but no entries has never worked. An agent with entries but
 * no folder writes into the memory without anyone knowing its
 * instructions — at multi-agent scale, the more uncomfortable of the two
 * gaps.
 */
export function agentsInLog(root) {
  const tally = new Map();
  for (const project of [null, ...listProjects(root)]) {
    for (const type of Object.keys(TYPES)) {
      let res;
      try { res = readLog(root, type, { project }); } catch { continue; }
      for (const e of res.entries) {
        if (e.__broken || isClosingLine(e)) continue;
        const a = agentOf(e);
        if (!a) continue;
        if (!tally.has(a)) tally.set(a, { agent: a, count: 0, last: '' });
        const t = tally.get(a);
        t.count += 1;
        if (String(e.ts ?? '') > t.last) t.last = String(e.ts ?? '');
      }
    }
  }
  return [...tally.values()].sort((a, b) => b.count - a.count);
}

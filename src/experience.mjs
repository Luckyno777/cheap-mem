// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * experience — errors, fixes and learnings as the EXPERIENCE of a skill,
 * workflow, snippet or procedure (port of lucky-mem's L3 + L2b,
 * `src/erfahrung.mjs`). A VIEW over drawers that already exist — the
 * registry (skillregistry.mjs), errors, learnings and the `resolves` /
 * `generalizes` / `contradicts` links (errorfixes.mjs) — no new store and
 * no model call: the code names evidence ids, sessions write the prose.
 *
 * **The system proposes, the owner decides.** Nothing here changes a
 * released skill, workflow or procedure by itself. The only writer,
 * `writeVersion`, needs a human (`--authority user` AND a human
 * `--issued-by`) and files the new version as a correction line
 * (`replaces_id`) with `start_status: trial` — never `released`; releasing
 * stays `mem skills status`. Nothing feeds a number back into ranking.
 *
 * **Scope (the causality gate).** An error counts for an entry only when
 * the entry itself DECLARED what it is for:
 *
 *   classes  subset of `errorclass.NAMES` (aliases normalised; a
 *            procedure's `on_class` counts too)
 *   files    paths or folders (`src/doctor.mjs`, `src/` = everything below)
 *   topics   words that hit an error's `topic` or `tags`
 *
 * With several axes ALL must hit. Without any axis the entry has no scope
 * and gets NO errors: an error that only sounds similar is no experience
 * of this skill. The outcome of a use (did the skill help?) is written
 * nowhere, so it stays `unknown` and is never a trigger.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as memory from './memory.mjs';
import * as procedure from './procedure.mjs';
import * as errorclass from './errorclass.mjs';
import * as errorfile from './errorfile.mjs';
import * as errorfixes from './errorfixes.mjs';
import * as repetition from './repetition.mjs';
import * as probescaffold from './probescaffold.mjs';
import * as skillregistry from './skillregistry.mjs';
import * as authority from './authority.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The gate: from this many cases in scope within the window a proposal EXISTS (one is an event, two a pattern). */
export const CASES_MIN = 2;
export const CASES_WINDOW_DAYS = 30;
/** A package is ripe from this many evidenced points … */
export const RIPE_POINTS_MIN = 3;
/** … of at least this many kinds (a flood of traps without a fix or lesson is a situation, not a package). */
export const RIPE_KINDS_MIN = 2;
/** A fix counts as proven only this long after its source (days). */
export const PROVEN_DAYS = procedure.EFFECT_WINDOW_DAYS;
/** Before/after around a version: window per side and the minimum cases before. */
export const COMPARE_WINDOW_DAYS = procedure.EFFECT_WINDOW_DAYS;
export const COMPARE_MIN_BEFORE = 3;
/** Procedure effect: minimum errors of the class before release, and after it for "ineffective". */
export const EFFECT_MIN_BEFORE = 3;
export const EFFECT_MIN_AFTER = 3;

const time = (ts) => { const t = Date.parse(ts ?? ''); return Number.isFinite(t) ? t : null; };
const list = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  // Old stock: a list stored as JSON TEXT (`"[\"mcp\",\"skill\"]"`) is a list, not two fragments at the comma.
  if (/^\s*\[/.test(v)) {
    try { const j = JSON.parse(v); if (Array.isArray(j)) return j; } catch { /* not JSON: a comma list as before */ }
  }
  return v.split(',');
};

// --- scope -----------------------------------------------------------------

/** The declared scope `{ classes, files, topics, invalid, empty }` of a registry entry; unknown classes land in `invalid`. */
export function scopeOf(entry = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const classes = [];
  const invalid = [];
  for (const k of [...list(e.classes), ...list(e.on_class)]) {
    const n = String(k ?? '').trim();
    if (!n) continue;
    const norm = errorclass.normalise(n);
    if (norm) { if (!classes.includes(norm)) classes.push(norm); } else invalid.push(n);
  }
  const files = [...new Set(list(e.files).map((d) => String(d ?? '').trim().replace(/^\.\//, '')).filter(Boolean))];
  const topics = [...new Set(list(e.topics).map((t) => String(t ?? '').trim().toLowerCase()).filter(Boolean))];
  return { classes, files, topics, invalid, empty: !classes.length && !files.length && !topics.length };
}

function fileHits(errFiles, patterns) {
  return errFiles.some((d) => patterns.some((m) => (m.endsWith('/') ? d.startsWith(m) : (d === m || d.startsWith(`${m}/`)))));
}

/** Is the error in scope? Without a scope: never. */
export function inScope(err, scope) {
  if (!err || !scope || scope.empty) return false;
  if (scope.classes.length) {
    const k = errorclass.normalise(err.class);
    if (!k || !scope.classes.includes(k)) return false;
  }
  if (scope.files.length && !fileHits(errorfile.files(err), scope.files)) return false;
  if (scope.topics.length) {
    const has = new Set([...list(err.tags), err.topic].map((x) => String(x ?? '').trim().toLowerCase()).filter(Boolean));
    if (!scope.topics.some((t) => has.has(t))) return false;
  }
  return true;
}

// --- the stock (one reading) ------------------------------------------------

/**
 * What every view computes from: errors (closed ones too — a fixed error
 * is exactly experience; superseded ones drop out, errorfixes' reading),
 * the links, and an id index for the times of link sources.
 */
export function stock(root) {
  const errors = [...errorfixes.errorMap(root).values()];
  const links = errorfixes.allLinks(root);
  let byId;
  try { byId = memory.entriesById(root); } catch { byId = new Map(); }
  return { root, errors, links, byId, errorById: new Map(errors.map((f) => [f.id, f])), commitTimes: new Map() };
}

/**
 * When was the SOURCE of a link? An entry: its `ts`. A `Fixes:` edge
 * (`from: commit:<hash>`, errorfixes.mjs) can be written days after the
 * commit by `mem error-fixes backfill` — then the commit time counts, not
 * the time the edge was written, or an old fix would look new.
 * Unreadable -> the edge's own time.
 */
function sourceTime(s, l) {
  const t = s.byId.get(l.from)?.ts;
  if (t) return t;
  const m = new RegExp(`^${memory.COMMIT_EVIDENCE_PREFIX}([0-9a-f]{7,40})$`).exec(String(l.evidence ?? l.from ?? ''));
  if (m && s.root) {
    if (!s.commitTimes.has(m[1])) {
      const r = spawnSync('git', ['show', '-s', '--format=%cI', m[1]], { cwd: s.root, encoding: 'utf8', timeout: 10000 });
      s.commitTimes.set(m[1], !r.error && r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null);
    }
    const c = s.commitTimes.get(m[1]);
    if (c) return c;
  }
  return l.ts ?? null;
}

// --- the account -------------------------------------------------------------

function usageOf(item, usage) {
  if (!usage || !Array.isArray(usage.skills)) {
    return { calls: null, outcome: 'unknown', note: 'usage not measured; the outcome of a use is in no journal' };
  }
  const n = usage.skills.find((x) => x.name === `${skillregistry.PREFIX}${item.name}` || x.name === item.name);
  return { calls: n ? n.calls : 0, outcome: 'unknown', note: 'calls from the raw capture; the outcome of a use is in no journal' };
}

/** The account of one registry item over `s` (= {@link stock}); `usage` optional (skillusage.measure). */
export function account(item, s, { now = new Date(), usage = null } = {}) {
  const scope = scopeOf(item.entry);
  const nowMs = new Date(now).getTime();
  const base = { name: item.name, id: item.id, type: item.type, status: item.status, scope, usage: usageOf(item, usage) };
  if (scope.empty) {
    return { ...base, withoutScope: true, traps: [], cases: [], fixes: [], learnings: [], contradictions: [], openTraps: [],
      proposal: false, reason: 'without scope — no errors assigned (classes/files/topics not declared)' };
  }
  const traps = s.errors.filter((f) => inScope(f, scope))
    .sort((x, y) => String(x.ts).localeCompare(String(y.ts)) || x.id.localeCompare(y.id));
  const ids = new Set(traps.map((f) => f.id));
  const fixes = [];
  const learnings = [];
  const contradictions = [];
  const fixed = new Set();
  for (const l of s.links) {
    if (l.kind === 'resolves' && ids.has(l.to)) { fixes.push({ fix: l.from, error: l.to, link: l.id, ts: sourceTime(s, l) }); fixed.add(l.to); }
    else if (l.kind === 'generalizes' && ids.has(l.to)) learnings.push({ learning: l.from, error: l.to, link: l.id, ts: sourceTime(s, l) });
    else if (l.kind === 'contradicts' && (ids.has(l.from) || ids.has(l.to))) contradictions.push({ from: l.from, to: l.to, link: l.id });
  }
  const cutoff = nowMs - CASES_WINDOW_DAYS * DAY_MS;
  const cases = traps.filter((f) => { const t = time(f.ts); return t !== null && t >= cutoff && t <= nowMs; }).map((f) => f.id);
  const proposal = cases.length >= CASES_MIN;
  return {
    ...base, withoutScope: false,
    traps: traps.map((f) => ({ id: f.id, ts: f.ts, class: f.class ?? null })),
    cases, fixes, learnings, contradictions,
    openTraps: traps.filter((f) => !fixed.has(f.id)).map((f) => f.id),
    proposal,
    reason: `${cases.length} case(s) in scope in ${CASES_WINDOW_DAYS} days — ${proposal ? 'gate met' : 'below the gate'} (${CASES_MIN})`,
  };
}

/** Every account (withdrawn entries left out), in registry order. */
export function accounts(root, { now = new Date(), usage = null } = {}) {
  const s = stock(root);
  return skillregistry.registry(root).filter((i) => i.status !== 'withdrawn').map((i) => account(i, s, { now, usage }));
}

// --- "review" marks (L2b) -----------------------------------------------------

/**
 * A NEW learning (`generalizes`) over errors that already have a fix
 * (`resolves`) OLDER than the learning: that fix deserves a look — maybe
 * it was a one-off. It stays a "review" mark; only a human calls a fix
 * obsolete, nothing is written. `[{ fix, learning, error }]`.
 */
export function reviewMarks(root, s = null) {
  s = s ?? stock(root);
  const fixesOf = new Map();
  for (const l of s.links) if (l.kind === 'resolves') { if (!fixesOf.has(l.to)) fixesOf.set(l.to, []); fixesOf.get(l.to).push(l); }
  const per = new Map();
  for (const l of s.links) {
    if (l.kind !== 'generalizes' || !s.errorById.has(l.to)) continue;
    const learnTs = time(sourceTime(s, l));
    if (learnTs === null) continue;
    for (const fx of fixesOf.get(l.to) ?? []) {
      const fixTs = time(sourceTime(s, fx));
      if (fixTs === null || learnTs <= fixTs) continue;
      const prev = per.get(fx.from);
      if (!prev || learnTs > prev._t) per.set(fx.from, { fix: fx.from, learning: l.from, error: l.to, _t: learnTs });
    }
  }
  return [...per.values()].map(({ _t, ...r }) => r).sort((a, b) => a.fix.localeCompare(b.fix));
}

// --- the sharpening package ----------------------------------------------------

/**
 * What is NEW since the item's last version — each point with an evidence
 * id. Output only. `ripe` needs BOTH RIPE_POINTS_MIN points of
 * RIPE_KINDS_MIN kinds AND the gate (CASES_MIN cases in scope in
 * CASES_WINDOW_DAYS days). Without a scope: never a package.
 */
export function sharpen(item, s, { now = new Date(), all = [] } = {}) {
  const k = account(item, s, { now });
  // content_since: a version that only set the scope does not move the start.
  const since = item.entry?.content_since || item.ts || null;
  const baseTs = time(since);
  const nowMs = new Date(now).getTime();
  const empty = { name: item.name, id: item.id, type: item.type, status: item.status, since, points: [], ripe: false, gate: false, count: 0 };
  if (k.withoutScope) return { ...empty, withoutScope: true, reason: k.reason };
  const fresh = (ts) => { const t = time(ts); return t !== null && (baseTs === null || t > baseTs); };
  const points = [];
  for (const f of k.traps.filter((x) => fresh(x.ts))) points.push({ kind: 'new-trap', evidence: f.id, class: f.class });
  for (const fx of k.fixes) {
    const ft = time(fx.ts);
    if (!fresh(fx.ts) || ft === null || nowMs - ft < PROVEN_DAYS * DAY_MS) continue;
    const e0 = s.errorById.get(fx.error);
    const back = k.traps.some((f) => {
      const t = time(f.ts);
      if (t === null || t <= ft || f.id === fx.error) return false;
      const ex = s.errorById.get(f.id);
      if (!e0 || !ex || ex.class !== e0.class) return false;
      const d0 = errorfile.files(e0); const dx = errorfile.files(ex);
      return (!d0.length && !dx.length) || d0.some((d) => dx.includes(d));
    });
    if (!back) points.push({ kind: 'proven-fix', evidence: fx.fix, error: fx.error });
  }
  for (const l of k.learnings) if (fresh(l.ts)) points.push({ kind: 'new-learning', evidence: l.learning, error: l.error });
  const classesInScope = new Set(k.traps.map((f) => errorclass.normalise(f.class)).filter(Boolean));
  for (const r of all) {
    if (r.type !== 'procedure' || r.id === item.id || !skillregistry.EXPORTABLE.includes(r.status) || !fresh(r.ts)) continue;
    if (procedure.triggersOf(r.entry).some((c) => classesInScope.has(c))) points.push({ kind: 'new-rule', evidence: r.id });
  }
  const trapIds = new Set(k.traps.map((f) => f.id));
  const fixIds = new Set(k.fixes.map((f) => f.fix));
  for (const m of reviewMarks(null, s)) {
    if (fixIds.has(m.fix)) points.push({ kind: 'questionable-step', evidence: m.fix, why: 'review', learning: m.learning, error: m.error });
  }
  for (const c of k.contradictions) {
    if ([c.from, c.to].some((x) => trapIds.has(x) || fixIds.has(x))) {
      points.push({ kind: 'questionable-step', evidence: c.link, why: 'contradicts', from: c.from, to: c.to });
    }
  }
  points.sort((x, y) => x.kind.localeCompare(y.kind) || String(x.evidence).localeCompare(String(y.evidence)));
  const kinds = new Set(points.map((x) => x.kind)).size;
  const ripe = k.proposal && points.length >= RIPE_POINTS_MIN && kinds >= RIPE_KINDS_MIN;
  return {
    ...empty, withoutScope: false, points, count: points.length, gate: k.proposal, ripe, cases: k.cases.length, kinds,
    reason: `${ripe ? 'ripe' : 'not ripe'}: ${points.length} evidenced point(s) of ${kinds} kind(s) (from ${RIPE_POINTS_MIN} points of `
      + `${RIPE_KINDS_MIN} kinds); gate ${k.proposal ? 'met' : 'missing'} (${k.reason})`,
    note: 'a falling success rate is not measurable (the outcome of a use is in no journal) and therefore no trigger',
  };
}

/** Packages of every registry item (withdrawn left out); a name or id filters. */
export function packages(root, { now = new Date(), name = null } = {}) {
  const s = stock(root);
  const items = skillregistry.registry(root).filter((i) => i.status !== 'withdrawn');
  const q = name ? String(name).replace(new RegExp(`^${skillregistry.PREFIX}`), '') : null;
  return (q ? items.filter((i) => i.name === q || i.id === q) : items).map((i) => sharpen(i, s, { now, all: items }));
}

// --- versions -------------------------------------------------------------------

/** Fields a version never copies from its predecessor (machine and status fields). */
const NOT_COPIED = new Set([...memory.MACHINE_FIELDS, 'start_status', 'status_of', 'issued_by', 'on_instruction', 'why',
  'version_of', 'version_prior_status', 'content_since', 'origin', 'chain', 'hash', 'prev']);

/**
 * A new version of a skill, workflow or snippet as a correction line
 * (`replaces_id`) with `start_status: trial`. Refused BEFORE anything is
 * written without `authority: 'user'` and a human `issued_by` (and in a
 * headless run, or under an authority ceiling below `user`). `trial` is
 * the ceiling: releasing stays `mem skills status`. The scope fields
 * carry over unless `classes`/`files`/`topics` are given (`[]` clears).
 */
export function writeVersion(root, nameOrId, {
  title = null, text = null, why = null, authority: claimed = null, issued_by = null,
  agent = null, env = process.env, now = new Date(), classes = null, files = null, topics = null,
} = {}) {
  if (env.MEM_HEADLESS) throw new Error(`a headless run (${env.MEM_HEADLESS}) files no version — nothing written.`);
  if (String(claimed ?? '').trim().toLowerCase() !== 'user') {
    throw new Error('only the owner files a new version: --authority user and --issued-by owner required — nothing written.');
  }
  const ceiling = authority.ceilingFromEnv(env);
  if (ceiling && ceiling !== 'user') throw new Error(`authority ceiling ${authority.CEILING_ENV}=${ceiling} — nothing written.`);
  const by = String(issued_by ?? '').trim();
  if (!procedure.isHuman(by)) throw new Error(`issued_by '${by}' is not a human (allowed: owner, human:<name>) — nothing written.`);
  const scopeNew = { classes, files, topics };
  const changesScope = Object.values(scopeNew).some((v) => Array.isArray(v));
  const hasContent = Boolean(String(text ?? '').trim() || String(title ?? '').trim());
  if (!hasContent && !changesScope) throw new Error('a version without --text, --title or a scope changes nothing — nothing written.');
  const q = String(nameOrId ?? '').trim().replace(new RegExp(`^${skillregistry.PREFIX}`), '');
  const it = skillregistry.registry(root).find((i) => i.name === q || i.id === q);
  if (!it) throw new Error(`no registry entry '${nameOrId}'`);
  if (it.type === 'procedure') throw new Error(`'${it.name}' is a procedure — a rule is replaced by a NEW rule (mem log procedure).`);
  if (it.status === 'withdrawn') throw new Error(`'${it.name}' is withdrawn — a withdrawn entry is not revived.`);
  const old = it.entry;
  const data = {};
  for (const [f, v] of Object.entries(old)) if (!f.startsWith('_') && !NOT_COPIED.has(f)) data[f] = v;
  if (String(title ?? '').trim()) data.title = String(title).trim();
  if (String(text ?? '').trim()) data.text = String(text);
  for (const [f, v] of Object.entries(scopeNew)) {
    if (!Array.isArray(v)) continue;
    const l = v.map((x) => String(x).trim()).filter(Boolean);
    if (l.length) data[f] = l; else delete data[f];
  }
  // A scope-only version is no new CONTENT: the package keeps counting from
  // the last content (lucky-mem measured 17 cases -> 0 points without this).
  if (!hasContent) data.content_since = old.content_since ?? old.ts ?? it.ts ?? null;
  const probe = scopeOf(data);
  if (probe.invalid.length) throw new Error(`scope with unknown values: ${probe.invalid.join(', ')} — nothing written.`);
  const me = agent ?? memory.agentDefault();
  Object.assign(data, {
    replaces_id: it.id, start_status: 'trial', issued_by: by, authority: 'user',
    version_of: it.id, version_prior_status: it.status, agent: me,
    why: why || `New version of ${it.type} ${it.id} filed as trial (L3); release only with mem skills status`,
  });
  if (me !== by) data.on_instruction = true;
  const verdict = authority.mayChangeState(data, old, 'replaces_id');
  if (!verdict.ok) throw new Error(`the authority rule refuses the correction: ${verdict.reason} — nothing written.`);
  return { item: it, ...memory.logEntry(root, it.type, data, { project: it.project, now }) };
}

/**
 * Errors in scope before/after a version (moment = the version's `ts`).
 * `unknown` while the after-window is not full, without a scope, or with
 * fewer than COMPARE_MIN_BEFORE cases before. A count, not proof.
 */
export function compare(item, s, { now = new Date() } = {}) {
  const scope = scopeOf(item.entry);
  if (!item.entry?.version_of && !item.entry?.replaces_id) return { state: 'unknown', reason: 'no version (never replaced)' };
  if (scope.empty) return { state: 'unknown', reason: 'without scope' };
  const at = time(item.ts);
  if (at === null) return { state: 'unknown', reason: 'version time unreadable' };
  const span = COMPARE_WINDOW_DAYS * DAY_MS;
  const gone = new Date(now).getTime() - at;
  if (gone < span) return { state: 'unknown', reason: `window not full (day ${Math.max(0, Math.floor(gone / DAY_MS))} of ${COMPARE_WINDOW_DAYS})` };
  const count = (from, to) => s.errors.filter((f) => { const t = time(f.ts); return t !== null && t >= from && t < to && inScope(f, scope); }).length;
  const before = count(at - span, at);
  const after = count(at, at + span);
  if (before < COMPARE_MIN_BEFORE) return { state: 'unknown', reason: `only ${before} case(s) before (minimum ${COMPARE_MIN_BEFORE})`, before, after };
  return { state: 'measured', before, after, window: COMPARE_WINDOW_DAYS };
}

// --- test <-> error ("guards") ----------------------------------------------------

function firstCommitTime(root, file, id) {
  const r = spawnSync('git', ['log', '--reverse', '--format=%cI', `-S// error: ${id}`, '--', file], { cwd: root, encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return r.stdout.split('\n').map((x) => x.trim()).find(Boolean) ?? null;
}

/** Pairs (test file, error id) from `// error: <id>` marks in non-empty tests; null when test/ is unreadable. */
export function markPairs(root) {
  let names;
  try { names = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.mjs')).sort(); } catch { return null; }
  const pairs = [];
  for (const f of names) {
    let t; try { t = fs.readFileSync(path.join(root, 'test', f), 'utf8'); } catch { continue; }
    if (!/\btest\(/.test(t) || probescaffold.isEmpty(t)) continue;
    for (const id of new Set([...t.matchAll(/\/\/\s*error:\s*([0-9a-z]+)/g)].map((m) => m[1]))) pairs.push({ test: `test/${f}`, error: id });
  }
  return pairs;
}

/**
 * Which error does which test guard — and did the error come back AFTER
 * the test commit? A return is `explicit` (a later error names the id in
 * `related` / `derived_from`) or `file-class` (same class and a shared
 * file, the repetition rule). Both are a SUSPICION, not a verdict.
 * `commitTime(test, id)` can be injected (probes without git).
 */
export function guards(root, { s = null, commitTime = null } = {}) {
  const pairs = markPairs(root);
  if (pairs === null) return { readable: false, pairs: [] };
  s = s ?? stock(root);
  const timeOf = commitTime ?? ((t, id) => firstCommitTime(root, t, id));
  const out = [];
  for (const p of pairs) {
    const f = s.errorById.get(p.error);
    if (!f) { out.push({ ...p, state: 'id-unknown', back: [] }); continue; }
    const cts = timeOf(p.test, p.error);
    const ct = time(cts);
    if (ct === null) { out.push({ ...p, state: 'time-unknown', back: [] }); continue; }
    const d0 = errorfile.files(f);
    const back = [];
    for (const z of s.errors) {
      const t = time(z.ts);
      if (z.id === f.id || t === null || t <= ct) continue;
      const rel = [...list(z.related), ...memory.derivedFrom(z)].map(String);
      if (rel.includes(f.id)) { back.push({ id: z.id, via: 'explicit' }); continue; }
      if (z.class && z.class === f.class && d0.length && errorfile.files(z).some((d) => d0.includes(d))) back.push({ id: z.id, via: 'file-class' });
    }
    out.push({ ...p, commit: cts, state: back.length ? 'suspicion' : 'guarded', back });
  }
  return { readable: true, pairs: out };
}

// --- procedure <-> error class ("prevents") ------------------------------------------

function rateIn(errors, classes, from, to) {
  const inside = errors.filter((e) => {
    const t = time(e.ts); const k = errorclass.normalise(e.class);
    return t !== null && t >= from && t < to && k && classes.includes(k);
  });
  const rep = inside.filter((e) => repetition.check(e, errors, { now: time(e.ts) }).is).length;
  return { errors: inside.length, repetitions: rep, rate: inside.length ? rep / inside.length : null };
}

/**
 * Repetition rate of the error classes of a RELEASED procedure in the
 * EFFECT_WINDOW_DAYS before and after its release (procedure.effectOf
 * counts errors; this adds repetitions). `effective`: at least
 * EFFECT_MIN_BEFORE errors before and none after, or the rate at least
 * halved; `ineffective`: at least EFFECT_MIN_AFTER after and the rate not
 * lower; otherwise `unknown`. Numbers, not a causal proof.
 */
export function procedureEffect(root, { now = new Date(), s = null } = {}) {
  s = s ?? stock(root);
  const nowMs = new Date(now).getTime();
  const span = procedure.EFFECT_WINDOW_DAYS * DAY_MS;
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    let entries; try { ({ entries } = memory.readLog(root, procedure.TYPE, { project })); } catch { continue; }
    const clean = entries.filter((e) => !procedure.isStatusLine(e) || procedure.isHuman(e.issued_by));
    const idx = procedure.statusIndex(clean);
    const retired = memory.retiredMap(clean);
    for (const e of clean) {
      if (!e || e.__broken || !e.id || !e.rule || procedure.isStatusLine(e) || !memory.holds(e, retired)) continue;
      const st = procedure.statusOf(e, idx);
      const classes = procedure.triggersOf(e);
      const head = { id: e.id, name: skillregistry.slug(e.title ?? e.id, 40) || e.id, status: st.status, classes };
      if (st.status !== 'released' || st.legacy || !st.since) { out.push({ ...head, verdict: 'unknown', reason: st.legacy ? 'legacy — no release moment' : `not released (${st.status})` }); continue; }
      if (!classes.length) { out.push({ ...head, verdict: 'unknown', reason: 'the rule names no error class' }); continue; }
      const at = time(st.since);
      if (at === null) { out.push({ ...head, verdict: 'unknown', reason: 'release moment unreadable' }); continue; }
      if (nowMs - at < span) { out.push({ ...head, verdict: 'unknown', reason: `window not full (day ${Math.max(0, Math.floor((nowMs - at) / DAY_MS))} of ${procedure.EFFECT_WINDOW_DAYS})`, released: st.since }); continue; }
      const before = rateIn(s.errors, classes, at - span, at);
      const after = rateIn(s.errors, classes, at, at + span);
      let verdict = 'unknown'; let reason;
      if (before.errors < EFFECT_MIN_BEFORE) reason = `only ${before.errors} error(s) of the class before (minimum ${EFFECT_MIN_BEFORE})`;
      else if (after.errors === 0 || (after.rate !== null && before.rate !== null && after.rate <= before.rate / 2 && after.errors < before.errors)) { verdict = 'effective'; reason = 'errors of the class gone or rate at least halved'; }
      else if (after.errors >= EFFECT_MIN_AFTER && after.rate >= before.rate) { verdict = 'ineffective'; reason = 'rate after not lower'; }
      else reason = 'neither clearly lower nor clearly the same';
      out.push({ ...head, verdict, reason, released: st.since, before, after });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// --- text ---------------------------------------------------------------------------

export function accountText(k) {
  const z = [`${k.name} (${k.type}, ${k.id}, ${k.status})`];
  if (k.withoutScope) { z.push(`  ${k.reason}`); return z.join('\n'); }
  z.push(`  scope: classes ${k.scope.classes.join(',') || '-'} | files ${k.scope.files.join(',') || '-'} | topics ${k.scope.topics.join(',') || '-'}`);
  z.push(`  traps ${k.traps.length} (without a fix ${k.openTraps.length}) | fixes ${k.fixes.length} | learnings ${k.learnings.length} | contradictions ${k.contradictions.length}`);
  z.push(`  ${k.reason}`);
  z.push(`  usage: ${k.usage.calls === null ? 'not measured' : `${k.usage.calls} call(s)`}, outcome unknown`);
  return z.join('\n');
}

const CAP_PER_KIND = 6;

export function packageText(p) {
  const z = [`${p.name} (${p.type}, ${p.id}, ${p.status}) — sharpening package since ${p.since ?? 'unknown'}`];
  if (p.withoutScope) { z.push(`  ${p.reason}`); return z.join('\n'); }
  const per = new Map();
  for (const x of p.points) { if (!per.has(x.kind)) per.set(x.kind, []); per.get(x.kind).push(x); }
  for (const [kind, xs] of per) {
    z.push(`  ${kind} (${xs.length}):`);
    for (const x of xs.slice(0, CAP_PER_KIND)) z.push(`    - ${x.evidence}${x.error ? ` (error ${x.error})` : ''}${x.why ? ` [${x.why}]` : ''}`);
    if (xs.length > CAP_PER_KIND) z.push(`    … and ${xs.length - CAP_PER_KIND} more (--json names all)`);
  }
  if (!p.points.length) z.push('  (no new evidenced points)');
  z.push(`  ${p.reason}`);
  z.push(`  Note: ${p.note}. Proposal only — nothing is changed; a session writes the prose, only the owner releases.`);
  return z.join('\n');
}

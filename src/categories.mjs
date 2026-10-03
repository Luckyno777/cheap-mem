// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * categories — a layer ABOVE topics (ported from the sibling house,
 * 2026-10-03; owner decision "option a", plus the rider: categories
 * create themselves).
 *
 * ## Why
 *
 * A few hundred topics without a level above them are a stretch of
 * names, not an overview. Entries are NEVER touched for this: everything
 * here is its own append-only line, applied on READ (the same build as
 * `topic-aliases.jsonl`).
 *
 * ## Four logs (all under global/, the last line per key wins)
 *
 *   categories.jsonl        {key, label, status, source, ts}
 *                           status automatic|confirmed. Renaming = a new
 *                           line with the same key and another label.
 *   category-aliases.jsonl  {from, to, why, source, ts}: a merge, resolved
 *                           on read (chains followed, cycles broken).
 *   topic-category.jsonl    {topic, category, source, status, ts}
 *                           source person|digest|reflector|agent|initial-assign,
 *                           status confirmed|proposal.
 *   category-wishes.jsonl   {topic, key, label, source, ts}: a writer's
 *                           proposal for a NEW category that is not
 *                           created yet.
 *
 * ## Ships EMPTY
 *
 * No category exists until somebody makes one. `SUGGESTED` below is only
 * a neutral list the person may ADOPT in one go (`mem category create
 * --suggested`); nothing reads it implicitly, nothing is enforced, and
 * the same names can be created, renamed or merged like any others. Why
 * a list at all: an empty layer asks every new user to invent eight
 * words before the first topic can be filed, and the first eight are
 * almost always the same; why not baked in: a memory is the user's own
 * data, and a vocabulary somebody else chose has no business appearing
 * in it unasked.
 *
 * Topic aliases: an assignment holds for the TARGET of the alias; a line
 * on the target itself beats one on the alias name (the alias inherits).
 *
 * ## Creating categories automatically
 *
 * A new category arises when at least `CREATE_THRESHOLD` (3) DIFFERENT
 * topics (resolved through their aliases) were independently proposed it;
 * spelling variants ("Wood_Work", "woodwork") count together, persisted
 * wishes count across runs. Topics, not an entry sum: one big topic is ONE
 * thread, not a field; and 3 is the threshold of a new project
 * (`projectnew`, `mem project suggestions`). The protection is the one
 * `mem project new` uses (`projectnew.similarReason`, against key AND
 * label): a near-duplicate of an existing category lands on the existing
 * one, a project name is never a category, the shape is checked. A
 * created category is usable at once (status automatic); a person
 * acknowledges it, renames it or merges it. Nothing is deleted.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import { similarReason } from './projectnew.mjs';

const CATEGORIES_LOG = memory.CATEGORY_TABLES.categories;
const ASSIGNMENT_LOG = memory.CATEGORY_TABLES.assignments;
const CATEGORY_ALIAS_LOG = memory.CATEGORY_TABLES.aliases;
const WISH_LOG = memory.CATEGORY_TABLES.wishes;

/** How many different topics must have proposed the same new category. */
export const CREATE_THRESHOLD = 3;

/** A neutral list a person may adopt (`mem category create --suggested`). Never applied by itself. */
export const SUGGESTED = Object.freeze([
  ['coding', 'Coding'],
  ['design', 'Design'],
  ['testing', 'Testing'],
  ['operations', 'Operations'],
  ['security', 'Security'],
  ['ai-agents', 'AI & Agents'],
  ['media', 'Media'],
  ['personal', 'Personal'],
]);

const KEY_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_MAX = 30;
const LABEL_MAX = 40;

/** Key form of a name: lower case, ASCII, hyphens ("AI & Agents" -> "ai-agents"). */
export function keyOf(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function readJsonl(root, rel) {
  let text;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const o = JSON.parse(line); if (o && typeof o === 'object') out.push(o); } catch { /* skip a broken line */ }
  }
  return out;
}

function appendLines(root, rel, lines) {
  if (!lines.length) return;
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** Who is writing, for the `source` of a proposal: the unattended digest or reflector, else any agent. */
export function writerSource(headless) {
  return headless === 'digest' || headless === 'reflector' ? headless : 'agent';
}

function stamp(now) { return new Date(now).toISOString(); }

/** Append finished assignment lines (the initial assignment). */
export function appendAssignments(root, lines) { appendLines(root, ASSIGNMENT_LOG, lines); }

/**
 * Categories and category aliases, resolved.
 * Returns `{cats: Map key -> {key, label, status, source, ts}, alias: Map from -> final target}`.
 * A missing file means NO categories.
 */
export function readCategories(root) {
  const cats = new Map();
  for (const l of readJsonl(root, CATEGORIES_LOG)) {
    if (typeof l.key !== 'string' || !KEY_SHAPE.test(l.key)) continue;
    const old = cats.get(l.key) ?? {};
    const next = { ...old, key: l.key };
    if (typeof l.label === 'string' && l.label.trim()) next.label = l.label.trim();
    if (typeof l.status === 'string') next.status = l.status;
    if (typeof l.source === 'string' && !old.source) next.source = l.source;
    if (typeof l.ts === 'string') next.ts = l.ts;
    if (!next.label) continue;
    cats.set(l.key, next);
  }
  const rawAlias = new Map();
  for (const l of readJsonl(root, CATEGORY_ALIAS_LOG)) {
    if (typeof l.from === 'string' && typeof l.to === 'string' && l.from !== l.to) rawAlias.set(l.from, l.to);
  }
  const alias = new Map();
  for (const start of rawAlias.keys()) {
    let target = rawAlias.get(start);
    const seen = new Set([start]);
    while (rawAlias.has(target) && !seen.has(target)) { seen.add(target); target = rawAlias.get(target); }
    alias.set(start, target);
  }
  return { cats, alias };
}

/** A category by key OR label (equal up to spelling); an alias is resolved. */
export function findCategory(state, name) {
  const k = keyOf(name);
  if (!k) return null;
  let hit = state.cats.has(k) ? k : null;
  if (!hit) for (const x of state.cats.values()) if (keyOf(x.label) === k) { hit = x.key; break; }
  if (!hit && state.alias.has(k)) hit = k;
  if (!hit) return null;
  const target = state.alias.get(hit) ?? hit;
  return state.cats.get(target) ?? null;
}

/**
 * Topic -> category, the last line per (resolved) topic.
 * Returns Map topic -> {topic, category (resolved), source, status, ts}.
 */
export function readAssignments(root, { state = readCategories(root), topicAliases = memory.topicAliases(root) } = {}) {
  const per = new Map();
  for (const l of readJsonl(root, ASSIGNMENT_LOG)) {
    if (typeof l.topic !== 'string' || typeof l.category !== 'string') continue;
    const k = state.alias.get(l.category) ?? l.category;
    if (!state.cats.has(k)) continue;
    const canon = topicAliases.get(l.topic) ?? l.topic;
    const direct = canon === l.topic;
    const old = per.get(canon);
    // A line on an alias name never displaces one on the target itself: the alias inherits.
    if (old && old.direct && !direct) continue;
    per.set(canon, { topic: canon, category: k, source: l.source ?? null, status: l.status === 'confirmed' ? 'confirmed' : 'proposal', ts: l.ts ?? null, direct });
  }
  for (const v of per.values()) delete v.direct;
  return per;
}

function checkShape(key, label) {
  if (!KEY_SHAPE.test(key) || key.length > KEY_MAX) return 'shape-key';
  const a = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (a.length < 2 || a.length > LABEL_MAX || a.split(' ').length > 5 || /[.!?;:]/.test(a)) return 'shape-label';
  return null;
}

function isProjectName(root, key) {
  const parts = new Set(key.split('-'));
  for (const p of memory.listProjects(root)) {
    const pk = keyOf(p);
    if (!pk) continue;
    if (key === pk || key.startsWith(`${pk}-`) || key.endsWith(`-${pk}`) || (!pk.includes('-') && parts.has(pk))) return true;
  }
  return false;
}

/** An existing category that `key`/`label` is too like (key and label, as for projects), else null. */
function similarCategory(state, key, label) {
  const la = keyOf(label);
  for (const k of state.cats.values()) {
    const ka = keyOf(k.label);
    for (const [a, b] of [[key, k.key], [key, ka], [la, k.key], [la, ka]]) {
      if (a && b && similarReason(a, b)) return state.alias.get(k.key) ? state.cats.get(state.alias.get(k.key)) ?? k : k;
    }
  }
  for (const from of state.alias.keys()) {
    if (similarReason(key, from)) return state.cats.get(state.alias.get(from)) ?? null;
  }
  return null;
}

function mostCommon(list) {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  let best = null; let top = 0;
  for (const [x, c] of n) if (c > top) { best = x; top = c; }
  return best;
}

/**
 * Decide on proposals of a category for topics: the ONE way for the
 * digest/reflector (`mem log --category`), the tests and a dry run.
 * `wishes` = [{topic, category?, fresh?: {key, label}, source}].
 *
 *   category  an existing category (key or label, equal up to spelling)
 *   fresh     a NEW category; created only by the rule in the head
 *
 * With `write: false` it only computes (a preview); persisted wishes
 * count too. A topic that already has a category is skipped, and a
 * repeated call changes nothing (idempotent).
 * Returns `{created:[{key, label, topics}], assigned:[{topic, category,
 * label, source, fresh}], waiting:[{key, label, topics}],
 * rejected:[{topic, reason}]}`.
 */
export function decide(root, wishes, { write = false, now = new Date() } = {}) {
  const state = readCategories(root);
  const assigned0 = readAssignments(root, { state });
  const topicAliases = memory.topicAliases(root);
  const ts = stamp(now);
  const out = { created: [], assigned: [], waiting: [], rejected: [] };
  const assignedNow = new Set();
  const plan = [];
  const newWishes = [];
  const priorWishes = readJsonl(root, WISH_LOG).filter((w) => typeof w.topic === 'string' && typeof w.key === 'string');

  const assignTo = (topic, cat, source, fresh = false) => {
    out.assigned.push({ topic, category: cat.key, label: cat.label, source, fresh });
    assignedNow.add(topic);
  };

  for (const w of wishes) {
    const topic = topicAliases.get(w.topic) ?? w.topic;
    if (!topic || assigned0.has(topic) || assignedNow.has(topic)) { out.rejected.push({ topic: w.topic, reason: 'already-assigned' }); continue; }
    const source = w.source ?? 'agent';
    if (w.category) {
      const k = findCategory(state, w.category);
      if (k) { assignTo(topic, k, source); continue; }
      if (!w.fresh) { out.rejected.push({ topic, reason: 'category-unknown' }); continue; }
    }
    if (!w.fresh) { out.rejected.push({ topic, reason: 'no-category' }); continue; }
    const key = keyOf(w.fresh.key);
    const label = String(w.fresh.label ?? '').replace(/\s+/g, ' ').trim();
    const shape = checkShape(key, label);
    if (shape) { out.rejected.push({ topic, reason: shape }); continue; }
    const existing = findCategory(state, key) ?? similarCategory(state, key, label);
    if (existing) { assignTo(topic, existing, source); continue; }
    if (isProjectName(root, key)) { out.rejected.push({ topic, reason: 'project-name' }); continue; }
    newWishes.push({ topic, key, label, source });
  }

  // Group the wishes: persisted ones (topic still without a category, key not yet there) plus new ones.
  const all = [];
  const seen = new Set();
  for (const w of [...priorWishes, ...newWishes]) {
    const topic = topicAliases.get(w.topic) ?? w.topic;
    if (assigned0.has(topic) || assignedNow.has(topic)) continue;
    if (findCategory(state, w.key)) continue;
    const id = `${topic}\u0000${keyOf(w.key)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    all.push({ topic, key: keyOf(w.key), label: w.label ?? w.key, source: w.source ?? 'agent' });
  }
  const groups = [];
  for (const w of all) {
    const g = groups.find((x) => similarReason(w.key, x.key));
    if (g) g.members.push(w); else groups.push({ key: w.key, members: [w] });
  }
  const storedWish = new Set(priorWishes.map((w) => `${topicAliases.get(w.topic) ?? w.topic}\u0000${keyOf(w.key)}`));
  for (const g of groups) {
    const topics = [...new Set(g.members.map((m) => m.topic))];
    const key = mostCommon(g.members.map((m) => m.key));
    const label = mostCommon(g.members.filter((m) => m.key === key).map((m) => m.label));
    if (topics.length >= CREATE_THRESHOLD) {
      const cat = { key, label, status: 'automatic', source: 'automatic', ts };
      state.cats.set(key, cat);
      plan.push(cat);
      out.created.push({ key, label, topics });
      for (const t of topics) assignTo(t, cat, g.members.find((x) => x.topic === t).source, true);
    } else {
      out.waiting.push({ key, label, topics: topics.length });
    }
  }

  if (write) {
    const wishLines = newWishes.filter((w) => {
      const id = `${w.topic}\u0000${w.key}`;
      if (storedWish.has(id)) return false;
      storedWish.add(id);
      return true;
    }).map((w) => ({ topic: w.topic, key: w.key, label: w.label, source: w.source, ts }));
    appendLines(root, WISH_LOG, wishLines);
    appendLines(root, CATEGORIES_LOG, plan);
    appendLines(root, ASSIGNMENT_LOG, out.assigned.map((a) => ({ topic: a.topic, category: a.category, source: a.source, status: 'proposal', ts })));
  }
  return out;
}

/** A person assigns a topic (status confirmed). Throws on an unknown category. */
export function assign(root, topic, category, { now = new Date() } = {}) {
  const state = readCategories(root);
  const k = findCategory(state, category);
  if (!k) throw new Error(`No category '${category}'. Known: ${[...state.cats.keys()].filter((x) => !state.alias.has(x)).join(', ') || '(none yet, see mem category create)'}.`);
  const canon = memory.topicAliases(root).get(topic) ?? topic;
  appendLines(root, ASSIGNMENT_LOG, [{ topic: canon, category: k.key, source: 'person', status: 'confirmed', ts: stamp(now) }]);
  return { topic: canon, category: k.key, label: k.label };
}

/** Confirm proposals: one topic or all (`topic === null`). Returns the confirmed topics. */
export function confirm(root, topic, { now = new Date() } = {}) {
  const state = readCategories(root);
  const assignments = readAssignments(root, { state });
  const targets = topic === null
    ? [...assignments.values()].filter((z) => z.status === 'proposal')
    : [assignments.get(memory.topicAliases(root).get(topic) ?? topic)].filter(Boolean);
  if (topic !== null && !targets.length) throw new Error(`Topic '${topic}' has no category - assign it first: mem category assign <topic> <category>.`);
  const open = targets.filter((z) => z.status === 'proposal');
  if (topic !== null && !open.length) throw new Error(`Topic '${topic}' is already confirmed (${targets[0].category}).`);
  const ts = stamp(now);
  appendLines(root, ASSIGNMENT_LOG, open.map((z) => ({ topic: z.topic, category: z.category, source: 'person', status: 'confirmed', ts })));
  return open.map((z) => z.topic);
}

/** A person creates a category by hand or acknowledges an automatic one (status confirmed). */
export function createCategory(root, key, label, { now = new Date() } = {}) {
  const k = keyOf(key);
  const state = readCategories(root);
  const existing = state.cats.get(k);
  const l = String(label ?? existing?.label ?? '').replace(/\s+/g, ' ').trim();
  const shape = checkShape(k, l);
  if (shape) throw new Error(`Category '${key}' / '${l}': ${shape === 'shape-key' ? `key lower case a-z0-9 with hyphens, at most ${KEY_MAX} characters` : `label 2 to ${LABEL_MAX} characters, at most 5 words, no punctuation`}.`);
  if (!existing) {
    const near = similarCategory(state, k, l);
    if (near) throw new Error(`'${k}' is too like the category '${near.key}'. Nothing created - use the existing one or merge them.`);
  }
  appendLines(root, CATEGORIES_LOG, [{ key: k, label: l, status: 'confirmed', source: existing ? existing.source : 'person', ts: stamp(now) }]);
  return { key: k, label: l, fresh: !existing };
}

/** Adopt the suggested list: creates the ones that do not exist yet (confirmed, source suggested). */
export function adoptSuggested(root, { now = new Date() } = {}) {
  const state = readCategories(root);
  const ts = stamp(now);
  const lines = SUGGESTED.filter(([k]) => !state.cats.has(k) && !state.alias.has(k))
    .map(([key, label]) => ({ key, label, status: 'confirmed', source: 'suggested', ts }));
  appendLines(root, CATEGORIES_LOG, lines);
  return lines.map((l) => l.key);
}

/** Merge: `from` counts as `to` from now on (an alias line, nothing deleted). */
export function mergeCategories(root, from, to, { why = '', now = new Date() } = {}) {
  const state = readCategories(root);
  const a = findCategory(state, from);
  const z = findCategory(state, to);
  if (!a) throw new Error(`No category '${from}'.`);
  if (!z) throw new Error(`No category '${to}'.`);
  if (a.key === z.key) throw new Error('From and to are the same category.');
  appendLines(root, CATEGORY_ALIAS_LOG, [{ from: a.key, to: z.key, why: String(why), source: 'person', ts: stamp(now) }]);
  return { from: a.key, to: z.key };
}

/**
 * The topics of a category as a set of RAW names (target AND alias names), so the search can look up
 * an entry's `topic` unchanged. Null when there is no such category.
 */
export function topicsOfCategory(root, category) {
  const state = readCategories(root);
  const k = findCategory(state, category);
  if (!k) return null;
  const assignments = readAssignments(root, { state });
  const set = new Set();
  const targets = new Set([...assignments.values()].filter((z) => z.category === k.key).map((z) => z.topic));
  for (const t of targets) set.add(t);
  for (const [from, to] of memory.topicAliases(root)) if (targets.has(to)) set.add(from);
  return { category: k, topics: set };
}

/**
 * The whole view for CLI, dashboard data and doctor: categories with topic and
 * entry counts, topics with their category, open proposals, wishes.
 * `topicList` (optional) = `memory.topics(root)`, so the caller does not read twice.
 */
export function view(root, { topicList = memory.topics(root) } = {}) {
  const state = readCategories(root);
  const assignments = readAssignments(root, { state });
  const visible = [...state.cats.values()].filter((k) => !state.alias.has(k.key));
  const per = new Map(visible.map((k) => [k.key, { key: k.key, label: k.label, status: k.status, source: k.source, topics: 0, entries: 0 }]));
  const topics = [];
  const unassigned = { topics: 0, entries: 0, names: [] };
  const proposals = [];
  for (const t of topicList) {
    const z = assignments.get(t.topic);
    const k = z ? state.cats.get(z.category) : null;
    if (k && per.has(k.key)) {
      const e = per.get(k.key);
      e.topics += 1; e.entries += t.count;
      topics.push({ topic: t.topic, count: t.count, category: { key: k.key, label: k.label, status: z.status, source: z.source } });
      if (z.status === 'proposal') proposals.push({ topic: t.topic, category: k.key, label: k.label, source: z.source });
    } else {
      unassigned.topics += 1; unassigned.entries += t.count; unassigned.names.push(t.topic);
      topics.push({ topic: t.topic, count: t.count, category: null });
    }
  }
  const wish = new Map();
  const topicAliases = memory.topicAliases(root);
  for (const w of readJsonl(root, WISH_LOG)) {
    if (typeof w.topic !== 'string' || typeof w.key !== 'string') continue;
    const t = topicAliases.get(w.topic) ?? w.topic;
    if (assignments.has(t) || findCategory(state, w.key)) continue;
    const g = wish.get(w.key) ?? { key: w.key, label: w.label, topics: new Set() };
    g.topics.add(t);
    wish.set(w.key, g);
  }
  return {
    list: [...per.values()],
    topics,
    unassigned,
    proposals,
    new: visible.filter((k) => k.status === 'automatic').map((k) => ({ key: k.key, label: k.label })),
    wishes: [...wish.values()].map((g) => ({ key: g.key, label: g.label, topics: g.topics.size })),
    threshold: CREATE_THRESHOLD,
  };
}

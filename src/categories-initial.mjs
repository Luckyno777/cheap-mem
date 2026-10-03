// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * categories-initial — the first assignment of existing topics to categories.
 *
 * Deterministic, no model. A topic gets a category only when the rules
 * name it UNAMBIGUOUSLY, otherwise it stays without one (never guessed).
 * The rules are keyed by the keys of the suggested list
 * (`categories.SUGGESTED`); a category whose key is not among them has no
 * rule and receives nothing here. Nothing is applied to a category that
 * does not exist: on a memory that ships empty this reports "no
 * categories yet" and writes nothing.
 *
 * Points per category:
 *   +3  a word of the topic name hits a keyword of the category (once per category)
 *   +1  per distinct tag of the topic's entries that hits one
 * Assigned when the best category has at least 3 points AND leads the
 * second by at least 2. A keyword ending in `*` hits every word that
 * starts so; without `*` the word must be equal.
 *
 * Not counted: tags that hang on almost everything and say nothing about
 * the field - the names of the projects (read from the memory, none is
 * known here).
 *
 * The result is status proposal, source initial-assign; a person confirms.
 */

import * as memory from './memory.mjs';
import * as categories from './categories.mjs';

const RULES = {
  coding: ['git', 'merge', 'cli', 'lint', 'refactor*', 'code*', 'compiler', 'typescript', 'javascript', 'python', 'api', 'sdk',
    'branch*', 'commit*', 'build*', 'bug*', 'library', 'dependenc*', 'package*', 'schema', 'sqlite', 'cache', 'parser', 'worktree', 'installer'],
  design: ['design*', 'ui', 'ux', 'layout', 'css', 'brand*', 'logo', 'typography', 'font*', 'colour*', 'color*', 'dashboard*', 'viewer', 'theme*', 'icon*'],
  testing: ['test*', 'bench*', 'benchmark*', 'measure*', 'measurement*', 'probe*', 'gate*', 'ci', 'flaky', 'coverage', 'fixture*', 'regression*',
    'gold', 'verify', 'verification', 'ratchet*', 'fuzz*', 'proof'],
  operations: ['ops', 'operations', 'server', 'deploy*', 'systemd', 'service*', 'cron', 'backup*', 'docker', 'monitor*', 'watcher',
    'runner', 'release*', 'install*', 'infra*', 'uptime', 'restart*', 'vm'],
  security: ['security', 'secret*', 'encrypt*', 'crypto*', 'privacy', 'redaction', 'redact*', 'token*', 'login', 'auth*', 'permission*',
    'vulnerab*', 'threat*', 'shred*', 'retention'],
  'ai-agents': ['agent*', 'recall', 'digest', 'reflector', 'memory', 'mcp*', 'skill*', 'prompt*', 'model*', 'llm', 'embedding*',
    'claude', 'assistant*', 'librarian', 'inbox', 'orchestrat*', 'retrieval', 'capture*'],
  media: ['video*', 'image*', 'audio', 'photo*', 'film*', 'media', 'music', 'podcast*', 'animation*', 'render*', 'screenshot*'],
  personal: ['personal', 'family', 'health', 'travel', 'hobby', 'home', 'diary', 'finance*', 'recipe*', 'interview'],
};

function words(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hits(word, keyword) {
  return keyword.endsWith('*') ? word.startsWith(keyword.slice(0, -1)) : word === keyword;
}

function hitsAny(list, keywords) {
  return list.some((w) => keywords.some((k) => hits(w, k)));
}

/** The verdict for ONE topic among the given category keys: `{category|null, points, second, reason}`. Pure, no disk. */
export function judgeTopic({ topic, tags = [], keys = Object.keys(RULES), ignoreTags = new Set() }) {
  const nameWords = words(topic);
  const points = {};
  for (const k of keys) {
    const kw = RULES[k];
    if (!kw) continue;
    let p = 0;
    if (hitsAny(nameWords, kw)) p += 3;
    for (const t of tags) if (!ignoreTags.has(t) && hitsAny(words(t), kw)) p += 1;
    points[k] = p;
  }
  const rank = Object.entries(points).sort((a, b) => b[1] - a[1]);
  if (!rank.length) return { category: null, points: 0, second: 0, reason: 'no-rules' };
  const [best, bp] = rank[0];
  const sp = rank[1] ? rank[1][1] : 0;
  if (bp >= 3 && bp - sp >= 2) return { category: best, points: bp, second: sp, reason: 'clear' };
  return { category: null, points: bp, second: sp, reason: bp < 3 ? 'too-few-hints' : 'not-clear' };
}

/**
 * Judge every topic that has no category yet. With `write` the lines are appended as
 * status proposal / source initial-assign. Repeatable: assigned topics are skipped.
 * Returns `{assigned:[{topic, category}], unassigned:[{topic, reason}], perCategory:{}, noCategories}`.
 */
export function initialAssign(root, { write = false, now = new Date() } = {}) {
  const state = categories.readCategories(root);
  const live = [...state.cats.keys()].filter((k) => !state.alias.has(k) && RULES[k]);
  const result = { assigned: [], unassigned: [], perCategory: {}, noCategories: state.cats.size === 0 };
  const tagsOf = new Map();
  for (const e of memory.topicEntries(root)) {
    const s = tagsOf.get(e._topic) ?? new Set();
    for (const t of Array.isArray(e.tags) ? e.tags : []) if (typeof t === 'string') s.add(t.toLowerCase());
    tagsOf.set(e._topic, s);
  }
  const ignoreTags = new Set(memory.listProjects(root).map((p) => p.toLowerCase()));
  const already = categories.readAssignments(root, { state });
  for (const t of memory.topics(root)) {
    if (already.has(t.topic)) continue;
    const v = judgeTopic({ topic: t.topic, tags: [...(tagsOf.get(t.topic) ?? [])], keys: live, ignoreTags });
    if (!v.category) { result.unassigned.push({ topic: t.topic, reason: v.reason }); continue; }
    result.assigned.push({ topic: t.topic, category: v.category });
    result.perCategory[v.category] = (result.perCategory[v.category] ?? 0) + 1;
  }
  if (write && result.assigned.length) {
    const ts = new Date(now).toISOString();
    categories.appendAssignments(root, result.assigned.map((z) => ({ topic: z.topic, category: z.category, source: 'initial-assign', status: 'proposal', ts })));
  }
  return result;
}

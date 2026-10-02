// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bodyfields — the ONE answer to "which fields carry an entry's content,
 * per type, in reading order" (O2, 2026-09-30).
 *
 * **The finding (fact check 2026-09-30).** Every surface had its own list:
 * the recall hooks read `retrieval.BODY_FIELDS`, the dashboard (`textOf`)
 * a list of its own, `mem find` (`display.compactLine`) and the MCP line
 * (`shortLine` in `bin/mem-mcp`) a third one without `learning` and
 * `fact` — a learning with a title showed there as its title alone — and
 * the indexer (`search.FIELD_WEIGHTS`) a fourth. `steps`, the actual
 * sequence of a workflow, was in none of them, and `body`, the snippet
 * itself, was neither indexed nor shown.
 *
 * Now: `BODY_FIELDS_BY_TYPE` says it per type, `BODY_FIELDS` is its
 * union (the old order unchanged, new fields at the back), and every
 * display plus the SET of indexed fields (`search.FIELD_WEIGHTS`) is
 * derived from here. Probes: test/o2-body-fields-index.test.mjs (every
 * type in `memory.TYPES` maps to at least one field; every body field has
 * a weight), test/o2-body-fields-display.test.mjs (every surface shows
 * the main text).
 *
 * A leaf module on purpose: no imports. `search.mjs` needs this list and
 * `retrieval.mjs` imports `search.mjs`, so the list cannot live in
 * `retrieval.mjs` without a cycle (`retrieval.mjs` re-exports it, so
 * `retrieval.BODY_FIELDS` keeps working).
 */

export const BODY_FIELDS_BY_TYPE = Object.freeze({
  decision: Object.freeze(['title', 'choice', 'why', 'text', 'rejected']),
  error: Object.freeze(['title', 'text', 'why']),
  event: Object.freeze(['title', 'text']),
  timeline: Object.freeze(['title', 'fact', 'text']),
  thought: Object.freeze(['title', 'text', 'why']),
  learning: Object.freeze(['title', 'learning', 'text', 'why']),
  duty: Object.freeze(['title', 'duty', 'text', 'why']),
  question: Object.freeze(['title', 'question', 'text', 'why']),
  skill: Object.freeze(['title', 'skill', 'text']),
  procedure: Object.freeze(['title', 'rule', 'text']),
  source: Object.freeze(['title', 'excerpt', 'description', 'text']),
  update: Object.freeze(['title', 'text']),
  link: Object.freeze(['why']),
  workflow: Object.freeze(['title', 'steps']),
  snippet: Object.freeze(['title', 'description', 'body', 'text']),
});

/**
 * Fields that carry an entry's CONTENT, in the order they are read —
 * the union of `BODY_FIELDS_BY_TYPE`. The first thirteen are the order
 * `retrieval.BODY_FIELDS` had before (see the history there); `steps`
 * and `body` are O2.
 */
export const BODY_FIELDS = Object.freeze([
  'choice', 'learning', 'duty', 'rule', 'question', 'skill',
  'why', 'title', 'text', 'fact', 'description', 'excerpt', 'rejected',
  'steps', 'body',
]);

/**
 * Indexed, on purpose not part of the body: access words, not prose.
 *
 * `tags`, `asked`, `symbols` and `class` are handles somebody attached
 * so the entry can be FOUND; repeating them in the body spends context
 * on words the reader did not ask for. `topic` is carried as its own
 * field on the claim already.
 */
// MEASUREMENT ONLY (agent/expand-measure-cm): `asked_as` is a write-time
// expansion field (everyday phrasings a model added at capture/digest).
// Indexed only behind MEM_EXPAND=1; never merged as product code.
const EXPAND_ON = process.env.MEM_EXPAND === '1';
export const NON_BODY_FIELDS = Object.freeze(['topic', 'class', 'tags', 'asked', 'symbols', ...(EXPAND_ON ? ['asked_as'] : [])]);

// The union and the table must not drift: a field in the table missing
// here would be neither searchable nor shown; one here no type carries
// is a dead list.
{
  const inTable = new Set(Object.values(BODY_FIELDS_BY_TYPE).flat());
  const missing = [...inTable].filter((f) => !BODY_FIELDS.includes(f));
  const dead = BODY_FIELDS.filter((f) => !inTable.has(f));
  if (missing.length || dead.length) {
    throw new Error('bodyfields: BODY_FIELDS and BODY_FIELDS_BY_TYPE drifted apart: '
      + `missing from BODY_FIELDS [${missing.join(', ')}], carried by no type [${dead.join(', ')}]`);
  }
}

const ORDERED = Object.freeze(Object.fromEntries(Object.entries(BODY_FIELDS_BY_TYPE)
  .map(([type, own]) => [type, Object.freeze([...own, ...BODY_FIELDS.filter((f) => !own.includes(f))])])));

/**
 * The body fields of a type in reading order: the type's own first
 * (`BODY_FIELDS_BY_TYPE`), then the rest of `BODY_FIELDS` — older entries
 * sometimes carry a field of another type, and showing one field too
 * many beats swallowing content. Unknown or missing type: `BODY_FIELDS`.
 */
export function bodyFieldsFor(type) {
  return (type && Object.hasOwn(ORDERED, type)) ? ORDERED[type] : BODY_FIELDS;
}

/** A body field's value as text — `steps` (an array) numbered on one line. */
export function bodyAsText(value) {
  if (Array.isArray(value)) {
    return value.filter((s) => typeof s === 'string' && s.trim())
      .map((s, i) => `${i + 1}. ${s.trim()}`).join(' ');
  }
  return typeof value === 'string' ? value : '';
}

/**
 * An entry's main text: the first non-empty body field of its type other
 * than the title (every display shows the title beside it anyway). None:
 * '' — the display then shows the title alone, not twice.
 */
export function mainText(e, type = null) {
  if (!e || typeof e !== 'object') return '';
  for (const f of bodyFieldsFor(type ?? e._type ?? null)) {
    if (f === 'title') continue;
    const t = bodyAsText(e[f]);
    if (t.trim()) return t;
  }
  return '';
}

/**
 * The body fields a one-line renderer has NOT given a form of its own,
 * as short texts in reading order — the loop `display.compactLine` and
 * the MCP `shortLine` share, so a body field added above reaches both
 * without anyone remembering. `handled` names the fields the caller
 * renders itself (with a prefix, an arrow, a mark). A rejected road is
 * labelled: shown bare it would read like the choice.
 */
export function restOfBody(e, handled, { type = null, max = 120 } = {}) {
  const out = [];
  if (!e || typeof e !== 'object') return out;
  const skip = new Set(handled);
  for (const f of bodyFieldsFor(type ?? e._type ?? null)) {
    if (skip.has(f)) continue;
    const t = bodyAsText(e[f]).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t;
    out.push(f === 'rejected' ? `rejected: ${cut}` : cut);
  }
  return out;
}

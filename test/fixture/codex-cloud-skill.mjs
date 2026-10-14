// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Reading helpers for test/codex-cloud-skill.test.mjs - pure functions, no probes.
 *
 * Lives under test/fixture/ and not in the test file, because every
 * `*.test.mjs` is an executable module.
 *
 * Every function takes the tool list (what the server itself answers to
 * `tools/list`) as a parameter. The truth stays the code, and the positive
 * controls can hand in a falsified list.
 */

/** Codex shows the connector's tools with this prefix (the skill names it as an example). */
const PREFIX = 'mcp__codex_apps__cheap_mem_';

/** Every `mem_...` name a text mentions (with and without the connector prefix). */
export function namedTools(text) {
  const bare = text.split(PREFIX).join('').replace(/(?<![A-Za-z0-9_])mem_[a-z0-9_]*_\*/g, '');
  return [...new Set(bare.match(/(?<![A-Za-z0-9_])mem_[a-z0-9_]*[a-z0-9]/g) ?? [])];
}

/** Families such as `mem_inbox_*`: the prefix before `_*`. */
export function families(text) {
  return [...text.matchAll(/(?<![A-Za-z0-9_])(mem_[a-z0-9_]*)_\*/g)].map((m) => m[1]);
}

/** Named tools the list does not have, and families nothing belongs to. */
export function unknownTools(text, tools) {
  const have = new Set(tools.map((t) => t.name));
  const empty = families(text).filter((f) => !tools.some((t) => t.name.startsWith(`${f}_`)));
  return [...namedTools(text).filter((n) => !have.has(n)), ...empty.map((f) => `${f}_*`)];
}

/**
 * Calls of the form `mem_name(param=value, param)`. Values may hold spaces and
 * line breaks but no commas and no parentheses - the notation is simple on purpose.
 */
export function calls(text) {
  const found = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9_])(mem_[a-z0-9_]*[a-z0-9])\(([^()]*)\)/g)) {
    const raw = m[2].trim();
    const entries = raw === '' ? [] : raw.split(',').map((p) => {
      const [k, ...v] = p.split('=');
      return { name: k.trim(), value: v.join('=').trim() };
    });
    found.push({ name: m[1], params: entries.map((e) => e.name), values: Object.fromEntries(entries.map((e) => [e.name, e.value])) });
  }
  return found;
}

/** Calls with a parameter the tool does not have, or without one of its required parameters. */
export function wrongCalls(text, tools) {
  const schemas = new Map(tools.map((t) => [t.name, t.inputSchema ?? {}]));
  const bad = [];
  for (const c of calls(text)) {
    const schema = schemas.get(c.name);
    if (!schema) { bad.push(`${c.name}: unknown tool`); continue; }
    const known = Object.keys(schema.properties ?? {});
    for (const p of c.params) {
      if (!known.includes(p)) bad.push(`${c.name}: no parameter '${p}' (known: ${known.join(', ') || 'none'})`);
    }
    for (const req of schema.required ?? []) {
      if (!c.params.includes(req)) bad.push(`${c.name}: required parameter '${req}' is missing from the call`);
    }
  }
  return bad;
}

/** The text under a heading (`## Name`, any depth of `#` from 2 to 3) up to the next heading of the same or higher rank. */
export function section(text, name, depth = 2) {
  const hashes = '#'.repeat(depth);
  const m = text.match(new RegExp(`^${hashes} ${name}[^\\n]*\\n([\\s\\S]*?)(?=^#{1,${depth}} |(?![\\s\\S]))`, 'm'));
  return m ? m[1] : null;
}

/** Flat frontmatter keys of a skill (`>-` blocks folded). */
export function frontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const out = {};
  let key = null;
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (m) {
      key = m[1];
      out[key] = m[2] === '>-' || m[2] === '>' ? '' : m[2];
    } else if (key) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

/** Whitespace made uniform: the same rule may be wrapped differently in two files. */
export const norm = (text) => text.replace(/\s+/g, ' ').trim();

/** Does this whole sentence (wrapping aside) stand in the text? */
export const hasSentence = (text, sentence) => norm(text).includes(norm(sentence));

/** The text with one replacement, wrapping aside; throws when there was nothing to replace (else the mutation would be none). */
export function mutate(text, from, to) {
  const t = norm(text);
  if (!t.includes(norm(from))) throw new Error(`mutation hits nothing: "${from}"`);
  return t.replace(norm(from), to);
}

/** Positions of several phrases in a text, or null when one is missing or they are out of order. */
export function inOrder(text, phrases) {
  let last = -1;
  for (const p of phrases) {
    const i = text.indexOf(p);
    if (i <= last) return null;
    last = i;
  }
  return true;
}

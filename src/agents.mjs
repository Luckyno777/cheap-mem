// agents.mjs — the per-agent layer.
//
// **Why this is its own axis and not another project.** `project` answers
// WHAT something is about (payments, the viewer). An agent answers WHO
// did it. Those are two axes, not one: the same entry belongs to
// `project: payments` AND to `agent: vm-admin`. Squeeze the agent into
// the project field and you lose exactly the query that matters at
// multi-agent scale — "what does this agent know, and from where".
//
// **The layer does NOT partition the memory.** That is the most important
// decision here. Every agent still reads everything; `agent` is an
// address, not a fence. A memory that splits per agent is N small
// memories with N copies of the same gap — and the whole advantage of one
// digest seeing it all together would be gone. Splitting starts at ~50k
// entries, and then by team, not by agent (docs/scale.md).
//
// **What belongs to an agent** lives under `agents/<name>/`:
//
//     AGENT.yaml   identity: role, model, active, inherits-from
//     PROMPT.md    the instructions
//     knowledge/   tuned knowledge this agent always carries
//     skills/      its own skills (a folder each, with SKILL.md)
//
// `path:` points at a DIFFERENT folder — the way to enrol an agent that
// already grew somewhere else without moving it. A memory whose layout
// respects what is already running gets used; one that digs it up gets
// worked around.

import fs from 'node:fs';
import path from 'node:path';

// Relative paths reported by this module are IDENTIFIERS — printed,
// compared, and travelling with the memory — not handles for the local
// filesystem. path.relative answers in the native separator, so the same
// memory would say agents/old on Linux and agents\\old on Windows and the
// two would not compare equal. Filesystem access keeps using path.join.
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

export const AGENTS_DIR = 'agents';

/** Allowed agent names: the same strict pattern as project names. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function checkAgentName(name) {
  const n = String(name ?? '').trim();
  if (!NAME_PATTERN.test(n)) {
    throw new Error(
      `Invalid agent name '${name}'. Allowed: lowercase a-z 0-9 . _ -, `
      + 'at most 64 characters, starting with a letter or digit.',
    );
  }
  return n;
}

const agentHome = (root, name) => path.join(root, AGENTS_DIR, checkAgentName(name));

// A tiny YAML reader for flat key/value pairs and lists. Deliberately NOT
// a library: that would be this project's first runtime dependency, for a
// six-line file. Whatever does not parse here does not belong in an
// AGENT.yaml either — instructions go in PROMPT.md, knowledge under
// knowledge/.
export function readFlatYaml(text) {
  const out = {};
  let list = null;
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#') || line.trim() === '---') continue;
    const listHit = /^\s+-\s+(.*)$/.exec(line);
    if (listHit && list) { out[list].push(unquote(listHit[1])); continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (v === '') { list = k; out[k] = []; continue; }
    list = null;
    out[k] = unquote(v);
  }
  return out;
}

function unquote(v) {
  const s = String(v).trim().replace(/^["'](.*)["']$/, '$1');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/**
 * One agent, as it stands on disk.
 *
 * `path:` is resolved against the memory root and may never leave it —
 * otherwise an AGENT.yaml would be a read key for the whole disk.
 */
export function readAgent(root, name) {
  const n = checkAgentName(name);
  const home = agentHome(root, n);
  if (!fs.existsSync(home)) return null;

  let head = {};
  const yamlPath = path.join(home, 'AGENT.yaml');
  if (fs.existsSync(yamlPath)) {
    try { head = readFlatYaml(fs.readFileSync(yamlPath, 'utf8')); } catch { head = {}; }
  }

  let content = home;
  if (typeof head.path === 'string' && head.path) {
    const target = path.resolve(root, head.path);
    const inside = path.relative(path.resolve(root), target);
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) content = target;
  }

  const entriesIn = (sub, ext) => {
    const d = path.join(content, sub);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d, { withFileTypes: true })
      .filter((e) => (ext ? e.isFile() && e.name.endsWith(ext) : e.isDirectory()))
      .map((e) => e.name)
      .sort();
  };

  const promptPath = ['PROMPT.md', 'START.md'].map((f) => path.join(content, f)).find(fs.existsSync);

  return {
    name: n,
    role: head.role ?? '',
    model: head.model ?? '',
    // Active by default: an agent somebody created should count without a
    // field being set. Retiring one is the exception.
    active: head.active !== false,
    inherits_from: head.inherits_from ?? head['inherits-from'] ?? null,
    home: rel(root, home) || AGENTS_DIR,
    content: rel(root, content) || '.',
    prompt: promptPath ? rel(root, promptPath) : null,
    knowledge: entriesIn('knowledge', '.md'),
    skills: entriesIn('skills', null),
    note: head.note ?? '',
  };
}

/** Every agent, alphabetically. Retired ones are included and marked. */
export function listAgents(root) {
  const d = path.join(root, AGENTS_DIR);
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME_PATTERN.test(e.name))
    .map((e) => readAgent(root, e.name))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create an agent. Lays out the scaffold and overwrites nothing that is
 * already there — calling it twice is not an error, just a no-op.
 */
export function createAgent(root, name, { role = '', model = '', path: at = null } = {}) {
  const n = checkAgentName(name);
  const home = agentHome(root, n);
  const isNew = !fs.existsSync(home);
  fs.mkdirSync(path.join(home, 'knowledge'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });

  const yamlPath = path.join(home, 'AGENT.yaml');
  if (!fs.existsSync(yamlPath)) {
    fs.writeFileSync(yamlPath, [
      '---',
      `name: ${n}`,
      `role: ${JSON.stringify(role)}`,
      `model: ${JSON.stringify(model)}`,
      'active: true',
      ...(at ? [`path: ${JSON.stringify(at)}`] : []),
      '',
    ].join('\n'), 'utf8');
  }
  if (!at && !fs.existsSync(path.join(home, 'PROMPT.md'))) {
    fs.writeFileSync(path.join(home, 'PROMPT.md'),
      `# ${n}\n\n${role || 'Role not described yet.'}\n\n`
      + 'What this agent always carries lives under `knowledge/`.\n'
      + 'Its own skills live under `skills/<name>/SKILL.md`.\n', 'utf8');
  }
  return { isNew, home: rel(root, home) };
}

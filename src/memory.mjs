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

/** Known log types. Each has its own JSONL per project + global. */
export const TYPES = Object.freeze({
  decision: 'decisions.jsonl',
  error: 'errors.jsonl',
  event: 'events.jsonl',
  timeline: 'timeline.jsonl',
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
} = {}) {
  const needle = String(pattern).toLowerCase();
  const scopes = projects === null ? [null, ...listProjects(root)] : projects;
  const hits = [];
  for (const project of scopes) {
    for (const type of types) {
      const p = logPath(root, type, project);
      if (!fs.existsSync(p)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!line.trim()) continue;
        if (!line.toLowerCase().includes(needle)) continue;
        let entry;
        try { entry = JSON.parse(line); }
        catch { entry = { __broken: true, raw: line }; }
        if (since) {
          const sinceTs = since instanceof Date ? since.toISOString() : String(since);
          if (!entry.ts || entry.ts < sinceTs) continue;
        }
        hits.push({
          ...entry,
          _source: path.relative(root, p),
          _line: i + 1,
        });
      }
    }
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

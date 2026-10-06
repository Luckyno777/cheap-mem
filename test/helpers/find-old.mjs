// test/helpers/find-old.mjs - FROZEN reference: memory.find and
// timesearch.entriesInWindow exactly as they were at commit f9fd134 (before
// the streaming rewrite): every line of every log is parsed into one array and
// filtered afterwards. Only for tests (equality, memory ratchet); never use it
// in production code.
import fs from 'node:fs';
import path from 'node:path';
import * as capabilityMod from '../../src/capability.mjs';
import {
  TYPES, logPath, listProjects, withoutBom, retiredMap, isClosingLine, asSource,
} from '../../src/memory.mjs';

export function findOld(root, pattern, capability, {
  types = Object.keys(TYPES),
  projects = null,   // narrows WITHIN what `capability` admits; null = everything it admits
  since = null,
  withRetired = false,  // include retired (done/discarded/superseded)?
} = {}) {
  if (!(capability instanceof capabilityMod.Capability)) {
    throw new TypeError(
      "memory.find(root, pattern, capability, opts) — 'capability' is required and must be "
      + 'a capability.mjs Capability. There is no default: an omitted or optional capability '
      + 'that quietly meant "everything" is the exact second-spelling hole this parameter '
      + 'exists to close (see this function\'s doc comment). Pass capability.grantAll(subject) '
      + 'for a caller that legitimately has full reach, or capability.grantProject(name, '
      + '{ subject }) for one scoped to a single project.');
  }
  // Every scope this capability admits, computed against what the
  // memory actually has — `global` plus every real project directory.
  // This IS the drawer list now; nothing below re-derives it.
  const admitted = capability.has('read')
    ? [null, ...listProjects(root)]
      .filter((p) => capability.admits(capabilityMod.scopeOf({ project: p })))
    : [];
  const scopes = projects === null
    ? admitted
    : projects.filter((p) => admitted.includes(p));
  const needle = String(pattern).toLowerCase();

  // Pass 1: parse every line of the target logs. Only after that is it
  // known what is retired — a tombstone sits in the same log as its
  // target, but possibly further down.
  const raw = [];
  for (const project of scopes) {
    for (const type of types) {
      const p = logPath(root, type, project);
      if (!fs.existsSync(p)) continue;
      const lines = withoutBom(fs.readFileSync(p, 'utf8')).split('\n');
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
      _source: asSource(root, p),
      _line: line,
      ...(info ? { _retired: info } : {}),
    });
  }
  return hits;
}


export function entriesInWindowOld(root, capability, {
  from, to, words = [],
} = {}) {
  const all = findOld(root, '', capability, { since: from || null, withRetired: true });
  const fMs = from ? new Date(from).getTime() : -Infinity;
  const tMs = to ? new Date(to).getTime() : Infinity;
  const w = words.map((x) => x.toLowerCase());
  return all
    .filter((e) => {
      const t = e.ts ? new Date(e.ts).getTime() : NaN;
      if (Number.isNaN(t) || t < fMs || t >= tMs) return false;
      if (w.length) {
        const hay = JSON.stringify(e).toLowerCase();
        if (!w.some((x) => hay.includes(x))) return false;
      }
      return true;
    })
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}


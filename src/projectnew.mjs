// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * projectnew — create a NEW project, confirm it, and suggest candidates.
 *
 * Ported from the sibling house (2026-10-02, owner decision "option 2").
 *
 * ## Why this exists
 *
 * `mem log --project <unknown>` used to create a HALF-MADE directory
 * silently (no README, no facts.yaml), and neither the digest nor the
 * agent rules said when a new project was due. A typo became a project.
 * Now:
 *
 *   - `mem log --project <unknown>` is refused (memory.logEntry),
 *   - a new project arises only through `createProject()`: with a check
 *     for similar names, a reason, an event and the mark `status: new`,
 *   - a human confirms it (`confirmProject()`); until then the dashboard
 *     shows it as new and unconfirmed,
 *   - `suggestions()` is the dry run: read, count, create nothing.
 *
 * ## Merging (old -> target) is NOT built
 *
 * Topic aliases work because ONE reader (`memory.topicAliases`) resolves
 * them on read. Projects are found by EVERY reader through the DIRECTORY
 * NAME (listProjects, readLog, search, the dashboard, the doctor, the
 * network ...); a project alias would have to be resolved in all of those
 * ways, or they keep reading only the old directory, and two directories
 * would hold the same thing as two. Moving entries across would rewrite
 * history. A half merge is worse than none. Until then a wrongly created
 * project stays as a directory, stays `new` and is not confirmed.
 *
 * ## No names in the code
 *
 * Nothing here knows a project or participant name. Everything comes from
 * the memory it is pointed at, which ships empty.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as raw from './raw.mjs';
import { contentWords } from './search.mjs';
import { writeAtomic } from './atomicwrite.mjs';

const STATUS_NEW = 'new';
const STATUS_CONFIRMED = 'confirmed';
const TITLE_CREATED = 'Project created';
const TITLE_CONFIRMED = 'Project confirmed';

/** The two unattended runs' own threshold: captures and distinct days. */
const MIN_CAPTURES = 2;
const MIN_DAYS = 2;

/** Spelling key: lower case, `_` and blanks like `-`. */
function norm(name) {
  return String(name ?? '').toLowerCase().trim().replace(/[_\s]+/g, '-');
}
/** Like `norm`, but without any separator: "cheap-mem" and "cheapmem" agree. */
function compact(name) { return norm(name).replace(/-/g, ''); }

/** Levenshtein distance (small, no dependency). */
function editDistance(a, b) {
  const x = String(a); const y = String(b);
  if (x === y) return 0;
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

/** Why two names are too alike — or null. */
export function similarReason(fresh, old) {
  const a = norm(fresh); const b = norm(old);
  if (!a || !b) return null;
  if (a === b) return 'same name';
  if (compact(a) === compact(b)) return 'same name except case or separator (_ / -)';
  if (a.startsWith(`${b}-`) || a.endsWith(`-${b}`)) return `'${old}' is a word part of the new name`;
  if (b.startsWith(`${a}-`) || b.endsWith(`-${a}`)) return `the new name is a word part of '${old}'`;
  const ka = compact(a); const kb = compact(b);
  const short = Math.min(ka.length, kb.length);
  const d = editDistance(ka, kb);
  // Very short names: distance 2 is already another word entirely
  // (four letters vs four letters, or three vs three). So two letters
  // only from 5 characters, one letter from 3.
  if ((short >= 5 && d <= 2) || (short >= 3 && d <= 1)) return `only ${d} letter(s) of difference`;
  return null;
}

/**
 * Everything a new name is checked against: existing projects and the
 * names in the topic aliases (from AND to). `{name, kind, target}` —
 * `target` is what the caller can use instead.
 */
function comparisonNames(root) {
  const list = [];
  const projects = memory.listProjects(root);
  for (const p of projects) list.push({ name: p, kind: 'project', target: p });
  const known = new Set(projects);
  const p = path.join(root, memory.ALIAS_LOG);
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { text = ''; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    for (const field of ['from', 'to']) {
      const n = e?.[field];
      if (typeof n !== 'string' || !n) continue;
      // Topics may read `area/leaf` — every member is compared.
      for (const part of n.split('/')) {
        if (!part) continue;
        const target = known.has(e.to) ? e.to : (e.to ?? part);
        list.push({ name: part, kind: 'topic-alias', target: String(target) });
      }
    }
  }
  return list;
}

/** The first known name too alike: `{with, kind, target, reason}` or null. Projects first. */
function similar(root, name) {
  for (const k of comparisonNames(root)) {
    const reason = similarReason(name, k.name);
    if (reason) return { with: k.name, kind: k.kind, target: k.target, reason };
  }
  return null;
}

function similarMessage(name, s) {
  const what = s.kind === 'project'
    ? `the existing project '${s.with}'`
    : `the topic alias '${s.with}'${s.target && s.target !== s.with ? ` (-> '${s.target}')` : ''}`;
  return `The name '${name}' is too like ${what} (${s.reason}). Nothing was created. `
    + (s.kind === 'project'
      ? `Use the existing project: --project ${s.with}.`
      : 'Use an existing project (see projects/) or leave --project out (global).');
}

/** `facts.yaml` of a project, read flat (`key: value`). */
function readFacts(root, name) {
  const out = {};
  let text;
  try { text = fs.readFileSync(path.join(root, 'projects', name, 'facts.yaml'), 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    const m = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { /* leave raw */ } }
    out[m[1]] = v;
  }
  return out;
}

/** The state of a project: `{isNew, status, created_by, created_on}`. Old projects: `isNew: false`. */
export function projectStatus(root, name) {
  const f = readFacts(root, name);
  return {
    isNew: f.status === STATUS_NEW,
    status: f.status ?? null,
    created_by: f.created_by ?? null,
    created_on: f.created_on ?? null,
  };
}

function dayOf(date) { return new Date(date).toISOString().slice(0, 10); }

/** The day a capture was taken, from its file name (`<time>--<session>.jsonl.gz`). */
function captureDay(rel) {
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(path.basename(String(rel ?? '')));
  return m ? m[1] : null;
}

/**
 * Check named captures as evidence. Only a capture that exists, is
 * readable AND shares at least one content word with the project's own
 * words (name, title, reason) counts. A day comes from the file name.
 * Nothing is guessed: what fails is reported and does not count.
 */
function checkCaptures(root, paths, words) {
  const ok = []; const rejected = [];
  const wanted = new Set(words);
  for (const rel of paths) {
    const clean = String(rel).replace(/\\/g, '/');
    if (!clean.startsWith('raw/') || clean.split('/').includes('..')) {
      rejected.push({ path: rel, why: 'not a capture path (expected raw/YYYY/MM/<file>.jsonl.gz, as `mem raw pending` lists it)' });
      continue;
    }
    let lines;
    try { ({ lines } = raw.readCapture(root, clean)); } catch (e) {
      rejected.push({ path: rel, why: `unreadable (${e.code ?? e.message})` });
      continue;
    }
    const day = captureDay(clean);
    if (!day) { rejected.push({ path: rel, why: 'no date in the file name' }); continue; }
    const theirs = new Set(contentWords(lines.map((l) => raw.textOf(l)).join(' ')));
    if (![...wanted].some((w) => theirs.has(w))) {
      rejected.push({ path: rel, why: 'shares no content word with the name, title or reason' });
      continue;
    }
    ok.push({ path: clean, day });
  }
  return { ok, days: [...new Set(ok.map((o) => o.day))].sort(), rejected };
}

/**
 * Create a new project.
 *
 * `strict` (an unattended run, `MEM_HEADLESS`, see the CLI): at least two
 * evidenced captures on two different days — the same rule as in the
 * digest prompt, here as CODE so it does not hang on a model's
 * obedience. Without `strict` (a person, a session) `captures` are a
 * voluntary proof; ones that cannot be verified are reported, never
 * guessed.
 *
 * Throws with a clear message and writes only after every check passed
 * (name, title, reason, similarity, evidence).
 */
export function createProject(root, name, {
  title, reason, captures = [], strict = false, agent = null, now = new Date(),
} = {}) {
  memory.checkProjectName(name);
  const t = String(title ?? '').trim();
  const why = String(reason ?? '').trim();
  if (!t) throw new Error('project new: --title is missing (one sentence: what is the project?).');
  if (!why) throw new Error('project new: --reason is missing (why a new project, what made you see it?).');
  if (memory.projectExists(root, name)) {
    throw new Error(`The project '${name}' already exists — nothing was created. Use it: --project ${name}.`);
  }
  const s = similar(root, name);
  if (s) { const e = new Error(similarMessage(name, s)); e.code = 'PROJECT_SIMILAR'; e.similar = s; throw e; }

  const paths = (Array.isArray(captures) ? captures : String(captures ?? '').split(','))
    .map((x) => String(x).trim()).filter(Boolean);
  let evidence = { ok: [], days: [], rejected: [] };
  if (paths.length) evidence = checkCaptures(root, paths, contentWords(`${t} ${why} ${name}`));
  if (strict && (evidence.ok.length < MIN_CAPTURES || evidence.days.length < MIN_DAYS)) {
    const e = new Error(
      `project new: evidence is not enough — at least ${MIN_CAPTURES} evidenced captures on ${MIN_DAYS} different days are required, `
      + `${evidence.ok.length} capture(s) on ${evidence.days.length} day(s) hold up`
      + (evidence.rejected.length ? ` (rejected: ${evidence.rejected.map((r) => `${r.path}: ${r.why}`).join('; ')})` : '')
      + '. Nothing was created. A one-off mention belongs in global or in the nearest existing project.');
    e.code = 'PROJECT_EVIDENCE';
    throw e;
  }

  const by = agent ?? memory.agentDefault();
  const { dir, created } = memory.projectInit(root, name, {
    title: t, facts: { status: STATUS_NEW, created_by: by, created_on: dayOf(now) },
  });
  const origin = { via: 'project-new' };
  if (paths.length) origin.raw = evidence.ok.length === 0 ? 'unknown' : (evidence.ok.length === 1 ? evidence.ok[0].path : evidence.ok.map((o) => o.path));
  const { entry } = memory.logCheckedEntry(root, 'event', {
    title: TITLE_CREATED,
    text: `${name}: ${t}. Reason: ${why}`,
    reason: why,
    tags: ['project-new'],
    agent: by,
    origin,
  }, { project: name, now });
  return { dir, created, entry, evidence };
}

/**
 * Mark a new project as confirmed (a human). `facts.yaml` is state, not a
 * log: the status line is replaced; the trace stays as an event.
 */
export function confirmProject(root, name, { by = null, now = new Date() } = {}) {
  if (!memory.projectExists(root, name)) {
    throw new Error(`The project '${name}' does not exist. Known: ${memory.listProjects(root).join(', ') || '(none)'}.`);
  }
  const st = projectStatus(root, name);
  // A project made by hand (`handmade`) never carried the mark but waits for
  // a person just the same (Today card): confirming it must work too, or the
  // button there is dead.
  if (!st.isNew && !handmade(root).some((h) => h.name === name)) {
    throw new Error(`The project '${name}' is not marked new (status: ${st.status ?? 'not set'}) — nothing to confirm.`);
  }
  const who = by ?? memory.agentDefault();
  const file = path.join(root, 'projects', name, 'facts.yaml');
  let old = '';
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* made by hand, without facts.yaml */ }
  const lines = old.split('\n').filter((l) => !/^status:\s/.test(l));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`status: ${JSON.stringify(STATUS_CONFIRMED)}`);
  lines.push(`confirmed_by: ${JSON.stringify(who)}`);
  lines.push(`confirmed_on: ${JSON.stringify(dayOf(now))}`);
  writeAtomic(file, `${lines.join('\n')}\n`);
  const { entry } = memory.logCheckedEntry(root, 'event', {
    title: TITLE_CONFIRMED, text: `${name} confirmed by ${who}.`, tags: ['project-new'],
    agent: who, origin: { via: 'project-new' },
  }, { project: name, now });
  return { entry };
}

/** Since this day a project arises only through `createProject` (owner decision 2026-10-02). */
const RULE_FROM = '2026-10-02';

/** Parsed lines of one JSONL file; unreadable file or line: skipped, never thrown. */
function readJsonl(file) {
  let text;
  try { text = memory.withoutBom(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a broken line is the doctor's business */ }
  }
  return out;
}

/** Earliest `ts` of all entries of a project (its drawer files `*.jsonl`), or null. */
function firstEntry(root, name) {
  let first = null;
  let files;
  try { files = fs.readdirSync(path.join(root, 'projects', name)); } catch { return null; }
  for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
    for (const e of readJsonl(path.join(root, 'projects', name, f))) {
      if (typeof e?.ts === 'string' && (first === null || e.ts < first)) first = e.ts;
    }
  }
  return first;
}

/**
 * Projects that arose PAST THE COMMAND: first entry on or after
 * {@link RULE_FROM}, but no `Project created` event and no `status` in
 * facts.yaml. Such a project never carries the mark `new`, so nobody sees in
 * the dashboard or anywhere else that it exists and that no person has
 * confirmed it (port of lucky-mem `handangelegt`). Read only.
 * `[{ name, firstEntry }]`.
 */
export function handmade(root) {
  const out = [];
  for (const name of memory.listProjects(root)) {
    if (projectStatus(root, name).status) continue;
    const first = firstEntry(root, name);
    if (!first || first.slice(0, 10) < RULE_FROM) continue;
    const has = readJsonl(path.join(root, 'projects', name, memory.TYPES.event))
      .some((e) => e?.title === TITLE_CREATED);
    if (!has) out.push({ name, firstEntry: first });
  }
  return out;
}

/** The capture paths of an entry (`origin.raw`: a path or a list; `unknown` does not count). */
function capturesOf(e) {
  const r = e?.origin?.raw;
  const list = Array.isArray(r) ? r : (typeof r === 'string' ? [r] : []);
  return list.filter((x) => typeof x === 'string' && x && x !== 'unknown');
}

/**
 * Dry run: which topics WITHOUT a project would come into question as a
 * new project? Writes nothing, calls no model. It counts from the ENTRIES
 * the digest already wrote (topic, `origin.raw` = capture, day from the
 * capture's file name) — the raw captures themselves are not read. What
 * is still undigested only the digest sees.
 *
 * Candidate = a topic hanging on at least 2 captures on 2 different days
 * (the threshold of the digest prompt). `similar` names the existing
 * project or alias the name would be refused for.
 */
export function suggestions(root) {
  const entries = memory.topicEntries(root).filter((e) => e._project === null);
  const byTopic = new Map();
  for (const e of entries) {
    const k = e._topic;
    if (!byTopic.has(k)) byTopic.set(k, { topic: k, entries: 0, captures: new Set(), days: new Set() });
    const z = byTopic.get(k);
    z.entries += 1;
    for (const c of capturesOf(e)) {
      z.captures.add(c);
      const day = captureDay(c);
      if (day) z.days.add(day);
    }
  }
  const rows = [...byTopic.values()].map((z) => {
    // The project name is the first member (`area/leaf` -> area).
    const name = norm(z.topic.split('/')[0]);
    let valid = true;
    try { memory.checkProjectName(name); } catch { valid = false; }
    const s = valid ? similar(root, name) : null;
    return {
      name: valid ? name : null, topic: z.topic, entries: z.entries,
      captures: z.captures.size, days: z.days.size,
      met: z.captures.size >= MIN_CAPTURES && z.days.size >= MIN_DAYS,
      similar: s ? s.with : null,
    };
  });
  // Several topics under one area (`a/x`, `a/y`) are ONE candidate.
  const byName = new Map();
  for (const z of rows) {
    if (!z.name) continue;
    const prev = byName.get(z.name);
    if (!prev) { byName.set(z.name, { ...z, topics: 1 }); continue; }
    prev.entries += z.entries; prev.topics += 1;
    // Captures/days across topics cannot be added without the sets —
    // so the maximum is named (a lower bound, never too high).
    prev.captures = Math.max(prev.captures, z.captures); prev.days = Math.max(prev.days, z.days);
    prev.met = prev.captures >= MIN_CAPTURES && prev.days >= MIN_DAYS;
  }
  const candidates = [...byName.values()]
    .filter((z) => z.met)
    .sort((a, b) => b.captures - a.captures || b.days - a.days || a.name.localeCompare(b.name));
  return { entriesRead: entries.length, topics: byTopic.size, candidates, handmade: handmade(root) };
}

/** The dry run as text: names and numbers only. */
export function suggestionsText(r) {
  const out = [];
  out.push(`Read: ${r.entriesRead} entries without a project (global), ${r.topics} topics. `
    + 'Counted from origin.raw of the entries — the captures themselves are not read.');
  out.push(`Threshold: at least ${MIN_CAPTURES} captures on ${MIN_DAYS} different days. Nothing is created.`);
  if (!r.candidates.length) {
    out.push('Candidates: none.');
  } else {
    out.push('Candidate | Captures | Days | Entries');
    for (const k of r.candidates) {
      out.push(`${k.name} | ${k.captures} | ${k.days} | ${k.entries}`
        + (k.similar ? `   (would be refused: similar to '${k.similar}')` : ''));
    }
  }
  if (r.handmade?.length) {
    out.push('');
    out.push(`Made past the command (no "${TITLE_CREATED}" event, no status, first entry on or after ${RULE_FROM}) `
      + '— confirmed by nobody:');
    for (const h of r.handmade) out.push(`  ${h.name} (first entry ${h.firstEntry})`);
  }
  return out.join('\n');
}

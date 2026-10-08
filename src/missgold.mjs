// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * missgold — a LOCAL, never-committed file holding the question text of
 * real recall misses, scored once it holds {@link MIN_CASES} cases. Port of
 * lucky-mem's "Fehltreffer-Gold" (Hebel 8) and its daily collection.
 *
 * **Why it exists.** A gold case needs the question text. That text lives
 * only in the raw capture and, on purpose, never in the retrieval journal.
 * Storing only the filtered words (what `asked-learn` keeps on the entry)
 * would find the entry with exactly the words it was just given — the
 * measurement would confirm itself. So the question itself is kept, but only
 * here, only on this machine.
 *
 * **What a miss is** is decided by `src/askedlearn.mjs` (M18b), step by step
 * with the same helpers: a question turn that returned nothing (`too-weak`
 * or `empty`; with `includeShown` also one with a wrong injection), after
 * which the SAME session names an entry by id within the window, an entry the
 * memory did NOT itself show it. That entry is the expected hit; the
 * person's real input before it is the question. No model, no guess.
 *
 * **Where.** `<root>/.mem/local/miss-gold.jsonl` (or `CHEAP_MEM_MISS_GOLD`).
 * The place must be ignored by git — if it sits inside a work tree and git
 * does not ignore it, NOTHING is written. Directory 0700, file 0600, written
 * through `writeAtomic`. Never in the journal, never in an output:
 * `collect` / `score` / `status` print counts and ids, never question text
 * (a tool's output lands in the raw capture of the calling session, and so
 * in an archive again).
 *
 * **What is skipped, not encrypted.** Scoring needs the plain text on this
 * machine. A case is dropped when (a) the expected entry is encrypted
 * (shredded, `body_enc`), or (b) the question carries something the
 * redaction recognises as a secret — the raw capture is already redacted, so
 * a `[REDACTED:` marker in the question counts too. The number skipped is
 * reported (not measurable is not zero). Not ported: lucky-mem's fixed list
 * of sensitive TAGS; cheap-mem has no such taxonomy and ships none.
 *
 * **Circularity stays out.** A case the paraphrase learner already used —
 * `asked_evidence.journal` on an entry (asked-learn) or an evidence place in
 * the rewrite table (`.mem/rewrites.jsonl`) — would be found with the words
 * it was taught. Such cases are counted but not scored; the minimum of
 * {@link MIN_CASES} applies to the scored ones.
 *
 * **Daily.** {@link dailyRun} collects at most once per UTC day. The stamp
 * is set BEFORE collecting (atomic): a run that dies or fails comes back
 * tomorrow, not at every tick of the host job. It never throws; a failure
 * is stored as a class name only (a message could carry question text). If
 * the stamp cannot be written, nothing is collected.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeAtomic } from './atomicwrite.mjs';
import * as posixmode from './posixmode.mjs';
import * as askedlearn from './askedlearn.mjs';
import * as memory from './memory.mjs';
import * as raw from './raw.mjs';
import * as rewrites from './rewrites.mjs';
import { redact, redactAgainstEnv } from './redaction.mjs';
import * as search from './search.mjs';

/** Below this many scored cases no number is printed at all. */
export const MIN_CASES = 20;
export const FILE_REL = path.join('.mem', 'local', 'miss-gold.jsonl');
const RUN_FILE = 'miss-gold.run';
const ENV_FILE = 'CHEAP_MEM_MISS_GOLD';
/** Longer inputs are pasted text, not questions — and carry more that is private. */
const QUESTION_MAX_CHARS = 500;

export function filePath(root, env = process.env) {
  return path.resolve(env[ENV_FILE] || path.join(root, FILE_REL));
}

/** Does git ignore this path? Not a repository -> nothing could commit it (true). */
function gitIgnores(root, target) {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return true; // outside the tree
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', '--', rel], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (e) {
    return e.status === 1 ? false : true; // 128 = no repository
  }
}

/**
 * Read the lines; broken ones are counted, never thrown. `modeOk`: true = no
 * rights for group/others, false = open, null = the platform cannot say
 * (Windows: see posixmode.mjs) -- never a verdict from numbers that mean nothing.
 */
export function read(target, { platform = process.platform } = {}) {
  const out = { present: false, rows: [], broken: 0, modeOk: true };
  let text;
  try {
    out.modeOk = posixmode.isPrivate(fs.statSync(target).mode, platform);
    text = fs.readFileSync(target, 'utf8');
  } catch { return out; }
  out.present = true;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (typeof o?.question === 'string' && o.question && Array.isArray(o.expected) && o.expected.length && o.journal) out.rows.push(o);
      else out.broken += 1;
    } catch { out.broken += 1; }
  }
  return out;
}

function store(target, rows) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  writeAtomic(target, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
}

const idOf = (place) => createHash('sha256').update(String(place)).digest('hex').slice(0, 12);

/** Why this question may not enter the file — or null. */
function secretIn(question) {
  if (question.includes('[REDACTED')) return 'secret';
  if (redact(question).found.length || redactAgainstEnv(question).found.length) return 'secret';
  return null;
}

/**
 * The misses WITH question text — nothing is written. Same walk as
 * `askedlearn.cases`, without its word filter.
 */
export function find(root, { index = null, journal = null, lines = null, includeShown = false } = {}) {
  const idx = index ?? search.loadIndex(root);
  const j = journal ?? askedlearn.journalWithPlace(root);
  const ms = askedlearn.misses(j, { includeShown });
  const sessions = new Set(ms.map((m) => m.z.session));
  const { bySession } = lines ?? askedlearn.sessionLines(root, sessions);
  const ids = new Map();
  const successor = new Map();
  idx.documents.forEach((d, i) => {
    if (d.type === 'raw' || !d.entry?.id) return;
    ids.set(String(d.entry.id).toLowerCase(), i);
    if (d.entry.replaces_id) successor.set(String(d.entry.replaces_id).toLowerCase(), i);
  });
  const current = (id) => {
    let i = ids.get(id);
    for (let hops = 0; hops < 50; hops += 1) {
      const next = successor.get(String(idx.documents[i].entry.id).toLowerCase());
      if (next === undefined) break;
      i = next;
    }
    return idx.documents[i];
  };
  const counts = {
    misses: 0, withCapture: 0, withQuestion: 0, withMention: 0, selfShown: 0,
    sensitive: 0, secret: 0, tooLong: 0, cases: 0,
  };
  const found = [];
  for (const m of ms) {
    counts.misses += 1;
    const sl = bySession.get(m.z.session);
    if (!sl?.length) continue;
    counts.withCapture += 1;
    const t = Date.parse(m.z.ts);
    const q = askedlearn.questionLine(sl, t);
    if (!q) continue;
    counts.withQuestion += 1;
    const named = askedlearn.mentions(sl, q, (id) => ids.has(id));
    if (!named.length) continue;
    counts.withMention += 1;
    const question = String(raw.textOf(q.z) ?? '').trim();
    if (!question) continue;
    const shown = m.z.reason == null;
    if (question.length > QUESTION_MAX_CHARS || (shown && question.length > askedlearn.SHOWN_QUESTION_MAX_CHARS)) {
      counts.tooLong += 1; continue;
    }
    const expected = [];
    let why = null;
    for (const g of named) {
      const doc = current(g.id);
      if (doc.retired) continue;
      if (askedlearn.selfShown(j, m.z.session, t, g.t, `${doc.source}:${doc.line}`)) { counts.selfShown += 1; continue; }
      if (doc.enc || doc.entry?.body_enc) { why = 'sensitive'; break; }
      why = secretIn(question);
      if (why) break;
      expected.push(g.id);
    }
    if (why) { counts[why] += 1; continue; }
    if (!expected.length) continue;
    found.push({
      id: idOf(m.place), ts: m.z.ts, question, expected, kind: shown ? 'shown' : String(m.z.reason), journal: m.place,
    });
  }
  counts.cases = found.length;
  return { cases: found, counts };
}

/** Add new cases to the file (once per journal line). Returns counts, never text. */
export function collect(root, { write = false, env = process.env, ...opt } = {}) {
  const target = filePath(root, env);
  const g = find(root, opt);
  const old = read(target);
  const known = new Set(old.rows.map((r) => r.journal));
  const fresh = g.cases.filter((c) => !known.has(c.journal));
  const report = { path: target, counts: g.counts, fresh: fresh.length, before: old.rows.length, written: false };
  if (!write || !fresh.length) return report;
  if (!gitIgnores(root, target)) {
    throw new Error(`${target} sits inside the work tree and git does NOT ignore it — nothing written.`);
  }
  const stamp = new Date().toISOString();
  store(target, [...old.rows, ...fresh.map((c) => ({ ...c, collected: stamp }))]);
  return { ...report, written: true };
}

/** The stamp of the daily run sits next to the file and holds only day, time and counts. */
export function runPath(root, env = process.env) {
  return path.join(path.dirname(filePath(root, env)), RUN_FILE);
}

/** Read the stamp, or null (missing, broken). */
export function readRun(root, env = process.env) {
  try {
    const o = JSON.parse(fs.readFileSync(runPath(root, env), 'utf8'));
    return o && typeof o.day === 'string' ? o : null;
  } catch { return null; }
}

/** At most once per UTC day. Never throws; see the module header. */
export function dailyRun(root, { env = process.env, now = new Date(), ...opt } = {}) {
  const day = now.toISOString().slice(0, 10);
  const old = readRun(root, env);
  if (old?.day === day) return { skipped: true, day, result: old.result ?? 'unknown' };
  const target = runPath(root, env);
  const setStamp = (o) => {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeAtomic(target, `${JSON.stringify({ day, at: now.toISOString(), ...o })}\n`, { mode: 0o600 });
  };
  try { setStamp({ result: 'running' }); } catch { return { skipped: true, day, result: 'stamp-error' }; }
  let res;
  try {
    const b = collect(root, { write: true, env, ...opt });
    res = {
      result: 'ok', fresh: b.fresh, cases: b.before + (b.written ? b.fresh : 0),
      misses: b.counts.misses, withQuestion: b.counts.withQuestion,
    };
  } catch (e) {
    res = { result: 'error', class: String(e?.code || e?.name || 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) };
  }
  try { setStamp(res); } catch { /* the stamp stays 'running': status shows it */ }
  return { skipped: false, day, ...res };
}

/**
 * The user-facing line about the modes in a `status` result, or null. Open is a
 * WARNING; "cannot be judged here" (Windows) is said, not left out.
 */
export function modeNote(st) {
  const state = (ok) => (ok === null ? 'not-checkable' : ok ? 'private' : 'open');
  const states = [];
  if (st.present) states.push(state(st.modeOk));
  if (st.runModeOk !== undefined) states.push(state(st.runModeOk));
  return posixmode.note(states, 'the miss-gold files');
}

/** State of the file — counts only. `runModeOk`: the same verdict for the daily stamp (null when there is none). */
export function status(root, env = process.env, { platform = process.platform } = {}) {
  const target = filePath(root, env);
  const r = read(target, { platform });
  const stamp = runPath(root, env);
  const runState = posixmode.fileState(stamp, platform);
  return {
    run: readRun(root, env),
    path: target, present: r.present, cases: r.rows.length, broken: r.broken,
    modeOk: r.modeOk,
    runModeOk: runState === 'missing' ? undefined : runState === 'not-checkable' ? null : runState === 'private',
    ignored: gitIgnores(root, target), min: MIN_CASES,
  };
}

/** Places where the paraphrase learner already used a miss — scoring there would be circular. */
function learnedPlaces(root, index) {
  const places = new Set();
  for (const d of index.documents ?? []) {
    for (const b of d?.entry?.asked_evidence ?? []) if (b?.journal) places.add(b.journal);
  }
  for (const p of rewrites.folded(root).values()) {
    for (const b of p.evidence ?? []) if (b?.place) places.add(b.place);
  }
  return places;
}

/**
 * Score: rank-1 share, top-K share and MRR over the scored cases. Below
 * {@link MIN_CASES} scored cases NO share — only the count.
 */
export function score(root, { top = 3, min = MIN_CASES, index = null, env = process.env } = {}) {
  const target = filePath(root, env);
  const r = read(target);
  const base = { path: target, min, cases: r.rows.length, broken: r.broken };
  if (r.rows.length < min) {
    return { ...base, measurable: false, reason: `only ${r.rows.length} of ${min} cases — no number` };
  }
  const idx = index ?? search.loadIndex(root);
  const used = learnedPlaces(root, idx);
  const scored = r.rows.filter((z) => !used.has(z.journal));
  const learned = r.rows.length - scored.length;
  if (scored.length < min) {
    return {
      ...base, learned, scored: scored.length, measurable: false,
      reason: `only ${scored.length} of ${min} cases not yet learned from (${learned} circular, not scored) — no number`,
    };
  }
  const chain = memory.correctionSuccessorMap(idx.documents.map((d) => d.entry).filter(Boolean));
  let rank1 = 0; let topK = 0; let missing = 0; let mrr = 0;
  for (const z of scored) {
    const want = new Set(memory.expandExpectedIds(z.expected, chain));
    // noRaw: the raw capture holds the question verbatim and would echo it.
    const hits = search.search(idx, z.question, { top: 3000, minScore: 0, noRaw: true });
    const i = hits.findIndex((h) => want.has(h.entry?.id));
    if (i < 0) { missing += 1; continue; }
    if (i === 0) rank1 += 1;
    if (i < top) topK += 1;
    mrr += 1 / (i + 1);
  }
  const n = scored.length;
  return {
    ...base, measurable: true, scored: n, learned, top, rank1: rank1 / n, topK: topK / n, mrr: mrr / n, notFound: missing,
  };
}

/** Text for the CLI — no question text. */
export function scoreAsText(e) {
  if (!e.measurable) return `Miss gold: ${e.reason}. No number is printed.`;
  const p = (x) => `${(100 * x).toFixed(1)} %`;
  return [
    `Miss gold: ${e.scored} cases scored (${e.learned} circular left out, ${e.broken} broken lines)`,
    `  Rank 1: ${p(e.rank1)}   Top-${e.top}: ${p(e.topK)}   MRR: ${e.mrr.toFixed(3)}   not found: ${e.notFound}`,
  ].join('\n');
}

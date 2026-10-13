// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * questiontext — the wording of recall questions, LOCAL, 30 days, never in git.
 *
 * **The decision (Lucky gjwsnbisurbs, 2026-10-12, answering question
 * b54m20dbem46).** The question text of a recall is written down, BUT only in
 * a local, git-ignored file with a 30-day shelf life. The recall journal
 * (`.pipeline/injections.jsonl`) stays exactly as it was: `question_bytes`,
 * never the wording (invariant `nie-fragetext-im-journal`,
 * test/injection-no-question-text.test.mjs). Purpose: the reverse test (M3) and
 * the search guard G7 need REAL questions, run against old and new code. The
 * journal only says how long the question was. Port of lucky-mem's
 * `fragetext-lokal`.
 *
 * **Where.** `<root>/.mem/local/question-text/<YYYY-MM-DD>.jsonl`, one file per
 * UTC day. `.mem/local/` is the house's local, git-ignored place (`mem init`
 * writes `.mem/local/` into the memory's .gitignore, `src/cli/githook.mjs`;
 * this repo ignores all of `/.mem/`; `src/missgold.mjs` lives there too).
 * Directory 0700, files 0600. If the place sits inside a work tree and git does
 * NOT ignore it, nothing is written (the failure is counted). The check costs
 * one git call and therefore runs only on the first write of a day.
 *
 * **One line.** `{ v, ts, occasion, reason, question_bytes, key, question,
 * redacted, truncated }`. `ts` / `occasion` / `reason` / `question_bytes` are
 * fields of the journal line itself; `key` is its fingerprint ({@link key}) —
 * whoever holds a journal line computes the key and finds its question; the
 * journal needs nothing new. `question_bytes` in the journal is the length
 * BEFORE redaction; `question` here is redacted and at most
 * {@link QUESTION_MAX_CHARS} long. The session id is not copied.
 *
 * **Redaction before writing.** The text goes through `src/redaction.mjs`
 * (patterns, then a match against the environment): a recognised secret becomes
 * `[REDACTED:...]`, never stored raw. Cut AFTER redacting (a key cut in half
 * would match no pattern); to keep the patterns off a pasted book the input is
 * limited to {@link RAW_MAX_CHARS} first and the rest is dropped.
 *
 * **Shelf life.** {@link SHELF_DAYS} days. On the first write of a day (today's
 * file does not exist yet) the day files older than that are deleted — one
 * `readdir`, at most once per day and root, no stamp file. {@link read} never
 * returns a line past the limit, even when the cleanup has not run yet.
 *
 * **The hook path.** {@link keep} never throws. A failure (disk full, rights,
 * not ignored, a broken folder) costs the recall nothing; it is counted by
 * class name only (a message could carry question text) in
 * `.pipeline/question-text-errors.jsonl`, and the doctor shows it
 * (`checkQuestionText`).
 *
 * **Reading.** {@link read} / {@link questionsSince}: three honest states
 * (`missing`, `empty`, `broken`, else `ok`); a broken line is counted and
 * skipped, never thrown, never folded into `[]`. NO output of the house names
 * question text: not the doctor, not {@link status}.
 *
 * **Off.** `CHEAP_MEM_QUESTION_TEXT=off` (also `0`, `no`, `false`). Default: on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendLine } from './append.mjs';
import { writeAtomic } from './atomicwrite.mjs';
import * as posixmode from './posixmode.mjs';
import { redact, redactAgainstEnv, envSecrets } from './redaction.mjs';

export const DIR_REL = path.join('.mem', 'local', 'question-text');
export const ERRORS_REL = path.join('.pipeline', 'question-text-errors.jsonl');
/** One mark per day: once the place was found "not ignored" or git "unclear", nobody asks git again until the day changes. */
export const PLACE_MARK_REL = path.join('.pipeline', 'question-text-place.json');
/** The most a git call may take on the hook path. */
export const GIT_TIMEOUT_MS = 2000;
/** Not a failure, only a number: questions not kept because the hits were mostly encrypted. */
const SKIPPED = 'sensitive-skipped';
const SHELF_DAYS = 30;
/** Nothing longer is stored: pasted text is not a question and carries more that is private. */
export const QUESTION_MAX_CHARS = 2000;
/** The redaction sees at most this much text (run time of the patterns). */
const RAW_MAX_CHARS = 8000;
const ERRORS_MAX_BYTES = 64 * 1024;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;
/**
 * The hooks hand the prompt to node through these variables. They hold the very text being
 * kept, so the match against the environment must skip them — taken as "secrets" they would
 * replace the whole question with a marker.
 */
const HANDOVER = new Set(['MEM_RH_PROMPT', 'MEM_RH_WORKFLOW', 'MEM_J_Q']);

/** Is keeping on? Default on; only an explicit off switches it off. */
export function isOn(env = process.env) {
  const v = String(env?.CHEAP_MEM_QUESTION_TEXT ?? '').trim().toLowerCase();
  return !['off', '0', 'no', 'false'].includes(v);
}

export function dir(root) {
  return path.join(root, DIR_REL);
}

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

export function fileForDay(root, day) {
  return path.join(dir(root), `${day}.jsonl`);
}

/**
 * The key that ties a question line to its journal line: made of fields the
 * journal line carries (`ts`, `session`, `occasion`, `reason`,
 * `question_bytes`); 12 hex characters.
 */
export function key(journalLine) {
  const l = journalLine ?? {};
  const parts = [l.ts, l.session, l.occasion, l.reason, l.question_bytes].map((x) => (x == null ? '' : String(x)));
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 12);
}

/**
 * How does git see this path? `ignored`, `not-ignored` or `git-unclear`.
 *
 * `git check-ignore` (exit 0 = ignored, 1 = not). Any other answer - exit 128, no git, a timeout -
 * counts as "no repository, nothing could commit it" ONLY when `git rev-parse --is-inside-work-tree`
 * fails too AND no repository remnant (`.git/HEAD` or a `.git` file) lies in the place; otherwise it
 * is unclear (broken repository, hanging git) and nothing is written. Every call has
 * {@link GIT_TIMEOUT_MS}: a hook must not hang on git.
 */
function placeVerdict(root, target, { gitBin = 'git', gitTimeoutMs = GIT_TIMEOUT_MS } = {}) {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'ignored'; // outside the tree
  const run = (args) => {
    try {
      execFileSync(gitBin, args, { cwd: root, stdio: 'ignore', timeout: gitTimeoutMs });
      return { status: 0 };
    } catch (e) {
      return { status: e?.status ?? null, timedOut: e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM' };
    }
  };
  const a = run(['check-ignore', '-q', '--no-index', '--', rel]);
  if (a.status === 0) return 'ignored';
  if (a.status === 1) return 'not-ignored';
  if (a.timedOut) return 'git-unclear';
  const b = run(['rev-parse', '--is-inside-work-tree']);
  if (b.status === 0 || b.timedOut) return 'git-unclear';
  // A repository remnant is a broken repository; a `.git` folder holding only the hook's marks
  // (`.git/mem-abruf-zuege`, ...) is not - the hooks make those in memories that are no repository.
  const g = path.join(root, '.git');
  let remnant = false;
  try { remnant = fs.existsSync(path.join(g, 'HEAD')) || fs.statSync(g).isFile(); } catch { /* no .git */ }
  return remnant ? 'git-unclear' : 'ignored';
}

function readPlaceMark(root, day) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(root, PLACE_MARK_REL), 'utf8'));
    return o && o.day === day && typeof o.verdict === 'string' ? o.verdict : null;
  } catch { return null; }
}

function writePlaceMark(root, day, verdict) {
  try { writeAtomic(path.join(root, PLACE_MARK_REL), `${JSON.stringify({ day, verdict })}\n`); } catch { /* without a mark git is asked again next time */ }
}

/** Count a failure — the class only, never the message. Never throws. */
function countFailure(root, kind, now) {
  try {
    const where = path.join(root, ERRORS_REL);
    try { if (fs.statSync(where).size > ERRORS_MAX_BYTES) return; } catch { /* no file yet */ }
    fs.mkdirSync(path.dirname(where), { recursive: true });
    // mask-ok: a short event kind token
    fs.appendFileSync(where, `${JSON.stringify({ ts: new Date(now).toISOString(), kind: String(kind).slice(0, 60) })}\n`);
  } catch { /* the counter itself must hold nothing up */ }
}

/**
 * Failures of the last `days` days. `skipped` counts questions not kept because the hits were mostly
 * encrypted - no failure, only a number. `readable: false` when the counter itself cannot be read.
 */
export function failureCount(root, { now = Date.now(), days = 7 } = {}) {
  let text;
  try { text = fs.readFileSync(path.join(root, ERRORS_REL), 'utf8'); }
  catch (e) { return { count: 0, skipped: 0, readable: e?.code === 'ENOENT', kinds: {} }; }
  const from = new Date(now).getTime() - days * DAY_MS;
  const kinds = {};
  let count = 0;
  let skipped = 0;
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (!(Date.parse(o.ts) >= from)) continue;
      if (o.kind === SKIPPED) { skipped += 1; continue; }
      count += 1;
      kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
    } catch { /* a broken counter line is no failure of keeping */ }
  }
  return { count, skipped, readable: true, kinds };
}

/** Delete the day files past the shelf life. Returns how many; never throws. */
export function sweep(root, { now = Date.now() } = {}) {
  let gone = 0;
  try {
    const limitDay = dayOf(new Date(now).getTime() - SHELF_DAYS * DAY_MS);
    for (const name of fs.readdirSync(dir(root))) {
      const m = DAY_FILE.exec(name);
      if (!m || m[1] >= limitDay) continue;
      try { fs.unlinkSync(path.join(dir(root), name)); gone += 1; } catch { /* next day */ }
    }
  } catch { /* no folder: nothing to sweep */ }
  return gone;
}

/** Redacted, cut question — `{ question, redacted, truncated }`. */
export function prepare(text, { env = process.env } = {}) {
  // RAW_MAX_CHARS (8000) is a deliberate cost bound and four times the 2000 that is kept; a key crossing it
  // lies beyond the kept part. A PEM block that begins in the kept part and ends beyond the bound has no END
  // line in view: redaction.mjs masks such an OPEN block (header plus key material) as well.
  // mask-ok: cost bound four times the kept length; an open PEM block is masked by its own pattern
  const raw = String(text ?? '').slice(0, RAW_MAX_CHARS);
  const a = redact(raw);
  const b = redactAgainstEnv(a.text, envSecrets(env).filter((x) => !HANDOVER.has(x.name)));
  const redacted = [...a.found, ...b.found].reduce((n, f) => n + (f.count || 0), 0);
  const truncated = b.text.length > QUESTION_MAX_CHARS;
  // mask-ok: b.text is the REDACTED text
  return { question: truncated ? b.text.slice(0, QUESTION_MAX_CHARS) : b.text, redacted, truncated };
}

/**
 * Keep the question of a journal line locally. Synchronous like the journal's
 * own write, and it NEVER throws (hook path). `journalLine` is what
 * `injection.buildLine` made.
 */
export function keep(root, journalLine, text, {
  env = process.env, now = Date.now(), gitBin = 'git', gitTimeoutMs = GIT_TIMEOUT_MS, hits = null,
} = {}) {
  try {
    if (!root || typeof text !== 'string' || !text.trim()) return false;
    if (!isOn(env)) return false;
    // Mostly encrypted hits (`body_enc`, crypto-shredded entries - the counterpart of lucky-mem's
    // sensitive-tag filter; cheap-mem has no sensitive-tag list): the question is likely about
    // private content and is not kept. Only a number is counted.
    if (Array.isArray(hits) && hits.length) {
      const enc = hits.filter((h) => h && (h.enc || h.body_enc || h.entry?.body_enc)).length;
      if (enc * 2 > hits.length) { countFailure(root, SKIPPED, now); return false; }
    }
    const day = dayOf(now);
    const file = fileForDay(root, day);
    if (!fs.existsSync(file)) {
      // First write of this day: check once, sweep once, create the file with 0600. Was the place
      // found "not ignored" or git "unclear" today already, no recall asks git again.
      if (readPlaceMark(root, day)) return false;
      const verdict = placeVerdict(root, file, { gitBin, gitTimeoutMs });
      if (verdict !== 'ignored') {
        writePlaceMark(root, day, verdict);
        countFailure(root, verdict, now);
        return false;
      }
      fs.mkdirSync(dir(root), { recursive: true, mode: 0o700 });
      sweep(root, { now });
      fs.closeSync(fs.openSync(file, 'a', 0o600));
    }
    const p = prepare(text, { env });
    const line = {
      v: 1,
      ts: journalLine?.ts ?? null,
      occasion: journalLine?.occasion ?? null,
      reason: journalLine?.reason ?? null,
      question_bytes: journalLine?.question_bytes ?? null,
      key: key(journalLine),
      question: p.question,
      redacted: p.redacted,
      ...(p.truncated ? { truncated: true } : {}),
    };
    appendLine(file, `${JSON.stringify(line)}\n`);
    return true;
  } catch (e) {
    countFailure(root, e?.code || e?.name || 'Error', now);
    return false;
  }
}

/**
 * Read the kept questions, from `since` on (a date or a timestamp; default the
 * whole shelf life). Three states, not two: `missing` (no folder / no day
 * file), `empty` (files there, not one line), `broken` (at least one line
 * unreadable — the readable ones come anyway), else `ok`. Never throws.
 */
export function read(root, { since = null, until = null, now = Date.now() } = {}) {
  const out = { state: 'missing', lines: [], broken: 0, files: 0 };
  const limitDay = dayOf(new Date(now).getTime() - SHELF_DAYS * DAY_MS);
  const fromDay = since ? dayOf(Date.parse(since) || since) : null;
  const toDay = until ? dayOf(Date.parse(until) || until) : null;
  let names;
  try { names = fs.readdirSync(dir(root)).sort(); } catch { return out; }
  for (const name of names) {
    const m = DAY_FILE.exec(name);
    if (!m || m[1] < limitDay || (fromDay && m[1] < fromDay) || (toDay && m[1] > toDay)) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir(root), name), 'utf8'); } catch { out.broken += 1; out.files += 1; continue; }
    out.files += 1;
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l);
        if (o && typeof o.question === 'string' && o.key && o.ts) out.lines.push(o);
        else out.broken += 1;
      } catch { out.broken += 1; }
    }
  }
  if (!out.files) return out;
  out.state = out.broken ? 'broken' : (out.lines.length ? 'ok' : 'empty');
  return out;
}

/** `questions since <date>` — the entry for G7: the same read with a date. */
export function questionsSince(root, date, opt = {}) {
  return read(root, { ...opt, since: date });
}

/** The question of a journal line, or `null`. For G7: tie question and journal together. */
export function questionFor(root, journalLine, opt = {}) {
  const k = key(journalLine);
  const day = String(journalLine?.ts ?? '').slice(0, 10);
  return read(root, { ...opt, since: day || null }).lines.find((l) => l.key === k) ?? null;
}

/** Counts for the doctor — never question text. */
export function status(root, { env = process.env, now = Date.now(), platform = process.platform, gitBin = 'git' } = {}) {
  const r = read(root, { now });
  const f = failureCount(root, { now });
  const today = fileForDay(root, dayOf(now));
  const place = placeVerdict(root, today, { gitBin });
  let oldestDays = null;
  const stamps = r.lines.map((l) => Date.parse(l.ts)).filter(Number.isFinite);
  if (stamps.length) oldestDays = Math.floor((new Date(now).getTime() - Math.min(...stamps)) / DAY_MS);
  return {
    on: isOn(env), state: r.state, files: r.files, lines: r.lines.length, broken: r.broken, oldestDays,
    failures: f.count, skipped: f.skipped, failuresReadable: f.readable, failureKinds: f.kinds,
    place, ignored: place === 'ignored',
    mode: posixmode.fileState(today, platform),
  };
}

/**
 * The doctor's reading of {@link status}: `{ level, text, advice }` with the doctor's levels
 * (`good`, `warn`, `error`, `unknown`). Broken: the place is inside the work tree and git does
 * NOT ignore it (error; nothing is written then), failures within 7 days, unreadable lines,
 * a file open to group/others (warn). Off, or nothing kept yet: unknown, never good. Never
 * question text in the output.
 */
export function assess(root, { env = process.env, now = Date.now(), platform = process.platform, gitBin = 'git' } = {}) {
  const st = status(root, { env, now, platform, gitBin });
  const counts = `${st.lines} questions in ${st.files} day files, ${st.broken} unreadable, ${st.failures} failures in 7 days, `
    + `${st.skipped} not kept because the hits were encrypted`;
  if (st.place === 'git-unclear') {
    return {
      level: 'warn',
      text: `git does not answer clearly for ${DIR_REL}/ (broken .git, hanging or missing git): nothing is kept (${counts}).`,
      advice: `check "git status" in this memory; the day mark ${PLACE_MARK_REL} holds the verdict until the day changes`,
    };
  }
  if (st.place === 'not-ignored') {
    return {
      level: 'error',
      text: `${DIR_REL}/ sits in the work tree and git does NOT ignore it: nothing is kept (${counts}).`,
      advice: 'run `mem init` again in this memory (it writes `.mem/local/` into .gitignore); without that line question text would sit where `git add -A` collects it',
    };
  }
  if (st.failures > 0) {
    const kinds = Object.entries(st.failureKinds).map(([k, n]) => `${k}: ${n}`).join(', ');
    return {
      level: 'warn',
      text: `keeping recall questions fails (${kinds}); the recall itself is not affected (${counts}).`,
      advice: `counter: ${ERRORS_REL} (class names only). Check place, rights and free space of ${DIR_REL}/, or switch it off with CHEAP_MEM_QUESTION_TEXT=off`,
    };
  }
  if (!st.failuresReadable) {
    return { level: 'unknown', text: `the failure counter ${ERRORS_REL} cannot be read - whether keeping fails is not visible (${counts}).`, advice: null };
  }
  if (st.broken > 0) {
    return {
      level: 'warn',
      text: `${st.broken} lines/files in ${DIR_REL}/ are unreadable; the readable ones still count (${counts}).`,
      advice: 'torn lines come from interrupted writes; they expire with their day after 30 days',
    };
  }
  if (st.mode === 'open') {
    return {
      level: 'warn',
      text: `today's question-text file is readable by group/others (should be 0600) (${counts}).`,
      advice: `chmod 600 the day files in ${DIR_REL}/`,
    };
  }
  if (!st.on) {
    return { level: 'unknown', text: `CHEAP_MEM_QUESTION_TEXT is off: no recall questions are kept (${counts}). No alarm; G7 and the reverse test find no real questions then.`, advice: null };
  }
  if (st.state === 'missing' || st.state === 'empty') {
    return { level: 'unknown', text: `on, but no question kept yet (${st.state}; ${counts}). Only after the first recall with a question.`, advice: null };
  }
  return {
    level: 'good',
    text: `on; ${counts}; the oldest line is ${st.oldestDays} days old (shelf life ${SHELF_DAYS}); ${DIR_REL}/ is ignored by git.`,
    advice: null,
  };
}

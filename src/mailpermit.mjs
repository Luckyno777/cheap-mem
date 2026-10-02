// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * mailpermit — nothing that wakes a model goes out without the user's
 * permission or a budget the user gave.
 *
 * Ported from lucky-mem (src/erlaubnis.mjs, Block S4). A message whose
 * intent asks for work (`request`, `clarification`, `read`, see
 * envelope.mjs) costs the recipient a model run: the watcher starts a
 * fresh headless session for it. Agents may WRITE such a message any
 * time; it only WAKES the recipient with
 *
 *   (a) a grant for exactly this message
 *       (`mem inbox permit <name> --authority user`), or
 *   (b) a budget
 *       (`mem inbox allow --letters N | --tokens N [--until D] [--to R] --authority user`).
 *
 * Information, results and receipts never need either — they never wake.
 *
 * **Append-only, one ledger.** Grants AND spending are lines in
 * `inbox/permissions.jsonl` (merge=union like every *.jsonl). Nothing
 * is rewritten; the rest of a budget is the grant minus the sum of its
 * spend lines, computed fresh every time. A message is charged AT MOST
 * ONCE: one lying through ten watcher ticks costs the budget once.
 *
 * **Tokens are an estimate.** Nobody knows a run's usage in advance.
 * The estimate is the mean of the measured runs in the model-cost
 * journal (modelcost.mjs, last 30 days); without a measurement it is a
 * named ASSUMPTION (`TOKEN_ASSUMPTION`). Every spend line carries
 * `estimate: true` and its source — never shown as a measurement.
 *
 * **Authority user, and where the guarantee ends.** Only lines with
 * `authority: 'user'` count; anything else is listed as `disputed`
 * (visible, not followed). The write path refuses a missing `--authority
 * user`, a process ceiling below `user` (CHEAP_MEM_MAX_AUTHORITY) and
 * any headless run (MEM_HEADLESS — a session the watcher woke can never
 * grant itself more). Whoever can write the repository can still forge
 * a line: the same honest limit as authority.mjs (no cryptography).
 *
 * No model call anywhere in this path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendLine } from './append.mjs';
import * as authority from './authority.mjs';
import * as modelcost from './modelcost.mjs';

export const FILE = path.join('inbox', 'permissions.jsonl');

/**
 * Assumed tokens per woken session while nothing is measured. lucky-mem
 * derived it from its only measurement (two digest runs, about 63 000
 * output tokens together) — rough, hence labelled an assumption.
 */
export const TOKEN_ASSUMPTION = 60000;
export const ESTIMATE_DAYS = 30;

const KINDS = Object.freeze(['budget', 'grant', 'spend']);

/** Absolute path of the ledger under a memory root. */
export function ledgerPath(root) { return path.join(root, FILE); }

/**
 * Parse ledger TEXT into lines. Broken lines are counted and named,
 * never silently skipped. Pure, so the watcher can feed it the remote
 * copy of the file as well as the local one.
 */
export function parseLines(text) {
  const lines = [];
  const broken = [];
  String(text ?? '').split('\n').forEach((raw, i) => {
    if (!raw.trim()) return;
    try {
      const z = JSON.parse(raw);
      if (!z || typeof z !== 'object' || !KINDS.includes(z.kind) || typeof z.id !== 'string'
          || !Number.isFinite(Date.parse(z.ts))) {
        throw new Error('fields missing or unreadable');
      }
      lines.push(z);
    } catch (e) { broken.push({ line: i + 1, reason: e.message }); }
  });
  return { lines, broken };
}

/** The local ledger lines, plus `extraText` (e.g. the remote copy), deduplicated by id. */
export function readLines(root, { extraText = null } = {}) {
  const p = ledgerPath(root);
  const exists = fs.existsSync(p);
  const local = parseLines(exists ? fs.readFileSync(p, 'utf8') : '');
  if (extraText === null) return { ...local, file: exists };
  const extra = parseLines(extraText);
  const seen = new Set(local.lines.map((z) => z.id));
  const lines = [...local.lines];
  for (const z of extra.lines) if (!seen.has(z.id)) { seen.add(z.id); lines.push(z); }
  return { lines, broken: [...local.broken, ...extra.broken], file: exists };
}

function newId(seed) {
  return createHash('sha256').update(`${seed}\0${randomUUID()}`).digest('hex').slice(0, 12);
}

/**
 * May this process write a grant? Throws with a `code`. One place for
 * the CLI and every later surface.
 */
export function checkGrantRight({ authority: claimed = null, env = process.env } = {}) {
  if (env.MEM_HEADLESS) {
    const e = new Error(`Only the user grants permission — a headless run (${env.MEM_HEADLESS}) cannot.`);
    e.code = 'HEADLESS';
    throw e;
  }
  if (String(claimed ?? '').trim().toLowerCase() !== 'user') {
    const e = new Error('Only the user grants permission: --authority user is missing. '
      + 'Agents cannot set a budget or permit a message.');
    e.code = 'AUTHORITY_MISSING';
    throw e;
  }
  const ceiling = authority.ceilingFromEnv(env);
  if (ceiling && ceiling !== 'user') {
    const e = new Error(`Authority ceiling ${authority.CEILING_ENV}=${ceiling} — this process may not claim 'user'.`);
    e.code = 'AUTHORITY_CAPPED';
    throw e;
  }
}

function positiveWhole(value, flag) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} is a whole number from 1, not: ${JSON.stringify(value)}`);
  return n;
}

/** `--until 2026-10-03` means until the END of that day (UTC), not the midnight before it. */
export function untilFrom(until) {
  if (until === null || until === undefined || until === '') return null;
  const s = String(until).trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59Z`) : new Date(s);
  if (Number.isNaN(t.getTime())) throw new Error(`--until '${s}' is not a readable date`);
  return t.toISOString();
}

function append(root, line) {
  fs.mkdirSync(path.dirname(ledgerPath(root)), { recursive: true });
  appendLine(ledgerPath(root), `${JSON.stringify(line)}\n`);
  return line;
}

/** Grant a budget. Throws without authority user (checkGrantRight). */
export function grantBudget(root, {
  letters = null, tokens = null, until = null, to = null,
  authority: claimed = null, by = null, env = process.env, now = new Date(),
} = {}) {
  checkGrantRight({ authority: claimed, env });
  const l = positiveWhole(letters, '--letters');
  const t = positiveWhole(tokens, '--tokens');
  if ((l === null) === (t === null)) throw new Error('Give exactly one of --letters N or --tokens N.');
  return append(root, {
    kind: 'budget', id: newId('budget'), ts: new Date(now).toISOString(),
    letters: l, tokens: t, until: untilFrom(until), to: to ? String(to) : null,
    authority: 'user', by: typeof by === 'string' && by ? by : null,
  });
}

/** Permit one message by name. Throws without authority user. */
export function grantMessage(root, {
  message, authority: claimed = null, by = null, env = process.env, now = new Date(),
} = {}) {
  checkGrantRight({ authority: claimed, env });
  if (typeof message !== 'string' || !/^[A-Za-z0-9TZ._~-]+\.md$/.test(message)) {
    throw new Error(`Not a message file name: ${JSON.stringify(message)}`);
  }
  if (!fs.existsSync(path.join(root, 'inbox', message))) throw new Error(`No message '${message}' in the inbox`);
  return append(root, {
    kind: 'grant', id: newId(`grant\0${message}`), ts: new Date(now).toISOString(),
    message, authority: 'user', by: typeof by === 'string' && by ? by : null,
  });
}

/**
 * Tokens per woken session from model-cost rows: `{ tokens, source, runs }`,
 * source `modelcost-mean-30d` (measured, averaged) or `assumption`.
 */
export function estimateFrom(rows = [], { now = new Date(), days = ESTIMATE_DAYS } = {}) {
  const floor = new Date(now).getTime() - days * 86400000;
  let sum = 0;
  let n = 0;
  for (const r of rows) {
    const t = Date.parse(r?.ts);
    if (!Number.isFinite(t) || t < floor) continue;
    const i = typeof r.inputTokens === 'number' ? r.inputTokens : null;
    const o = typeof r.outputTokens === 'number' ? r.outputTokens : null;
    if (i === null && o === null) continue;
    sum += (i ?? 0) + (o ?? 0);
    n += 1;
  }
  if (!n) return { tokens: TOKEN_ASSUMPTION, source: 'assumption', runs: 0 };
  return { tokens: Math.max(1, Math.round(sum / n)), source: `modelcost-mean-${days}d`, runs: n };
}

/** The token estimate for this memory (measured mean, or the assumption). */
export function estimate(root, opts = {}) {
  let rows = [];
  try { rows = modelcost.read(root).rows; } catch { rows = []; }
  return estimateFrom(rows, opts);
}

function expired(b, now) {
  if (!b.until) return false;
  const t = Date.parse(b.until);
  return !Number.isFinite(t) || t <= new Date(now).getTime();
}

/**
 * Where every grant stands: per budget `spentLetters`, `spentTokens`,
 * `rest`, `status` (active|spent|expired); single grants; `disputed`
 * lines (no authority user — visible, never followed).
 */
export function status(root, { now = new Date(), extraText = null } = {}) {
  const { lines, broken, file } = readLines(root, { extraText });
  const disputed = lines.filter((z) => z.kind !== 'spend' && z.authority !== 'user');
  const budgets = lines.filter((z) => z.kind === 'budget' && z.authority === 'user');
  const grants = lines.filter((z) => z.kind === 'grant' && z.authority === 'user');
  const spends = lines.filter((z) => z.kind === 'spend');
  const out = budgets.map((b) => {
    const mine = spends.filter((s) => s.permitId === b.id);
    const sl = mine.length;
    const st = mine.reduce((s, x) => s + (Number(x.tokensEstimate) || 0), 0);
    const rest = b.letters !== null && b.letters !== undefined ? b.letters - sl : b.tokens - st;
    const state = expired(b, now) ? 'expired' : (rest <= 0 ? 'spent' : 'active');
    return { ...b, spentLetters: sl, spentTokens: st, rest, status: state };
  });
  return { file, budgets: out, grants, spends, disputed, broken };
}

/**
 * The permission checker for `envelope.wakes()`: `(message) -> { allowed, reason, ... }`.
 *
 * Reserves within ONE checker: three messages against a budget with one
 * letter left get one yes and two no, before any spend line is written.
 */
export function checker(root, { now = new Date(), estimateValue = null, extraText = null } = {}) {
  const st = status(root, { now, extraText });
  const est = estimateValue ?? estimate(root, { now });
  const heldLetters = new Map();
  const heldTokens = new Map();
  return (m) => {
    const name = m?.name;
    if (!name) return { allowed: false, reason: 'message without a name' };
    const already = st.spends.find((s) => s.message === name);
    if (already) return { allowed: true, reason: 'already-spent', source: already.source, permitId: already.permitId, spendNeeded: false };
    const g = st.grants.find((x) => x.message === name);
    if (g) return { allowed: true, reason: 'single-grant', source: 'grant', permitId: g.id, spendNeeded: true, estimate: est };
    let last = st.budgets.length ? 'no matching budget' : 'no budget';
    for (const b of st.budgets) {
      if (b.status === 'expired') { last = 'budget expired'; continue; }
      if (b.to && b.to !== m.to) continue;
      if (b.letters !== null && b.letters !== undefined) {
        const h = heldLetters.get(b.id) ?? 0;
        if (b.rest - h <= 0) { last = 'budget spent'; continue; }
        heldLetters.set(b.id, h + 1);
      } else {
        const h = heldTokens.get(b.id) ?? 0;
        // Only while the ESTIMATE still fits: overdrawing would be known in advance.
        if (b.rest - h < est.tokens) { last = 'token budget spent (estimate)'; continue; }
        heldTokens.set(b.id, h + est.tokens);
      }
      return { allowed: true, reason: 'budget', source: 'budget', permitId: b.id, spendNeeded: true, estimate: est };
    }
    return { allowed: false, reason: last };
  };
}

/**
 * Record the spending for a granted wake — AT MOST ONCE per message.
 * Returns the line, or null (nothing needed, or already there).
 */
export function spend(root, m, decision, { via = 'unknown', now = new Date() } = {}) {
  if (!decision?.allowed || !decision.spendNeeded) return null;
  const there = readLines(root).lines.find((z) => z.kind === 'spend' && z.message === m.name);
  if (there) return null;
  const est = decision.estimate ?? { tokens: TOKEN_ASSUMPTION, source: 'assumption' };
  return append(root, {
    kind: 'spend', id: newId(`spend\0${m.name}`), ts: new Date(now).toISOString(),
    message: m.name, to: m.to ?? null, source: decision.source, permitId: decision.permitId,
    via, tokensEstimate: est.tokens, estimate: true, estimateSource: est.source,
  });
}

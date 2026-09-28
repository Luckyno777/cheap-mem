// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// modelcost.mjs — a cost/token journal for every REAL model run
// (mirrors lucky-mem's dash-fix3, part 2a).
//
// **The gap.** "Work & Agents -> Usage" showed "Model cost —" forever —
// not because nothing could be measured, but because nothing ever was.
// `bin/mem-digest` calls `claude -p` without `--output-format json` and
// throws away the STRUCTURED fields (usage, total_cost_usd) the CLI
// hands back with every run.
//
// **What does NOT happen here.** No second model call, no estimate, no
// recomputation from character counts — only READING what the CLI
// already returns from a run that was going to happen anyway. When the
// output is not valid JSON (a timeout, an expired login, a CLI version
// without the field), there is NO cost line — "not measured yet" stays
// correct; an invented 0 would not be.
//
// **The existing log stays untouched.** This module writes NOTHING to
// `.mem/digest.log` itself — that stays the caller's job. The CLI
// branch below (`node src/modelcost.mjs <root> <who> [source]`) reads
// the STDOUT of a `claude -p --output-format json` run from stdin,
// appends a journal line on valid JSON, and passes through on its OWN
// stdout exactly the text `claude -p` WITHOUT `--output-format json`
// would have printed (the `result` field) — the caller writes that on,
// unchanged, into its own log the way it always did. On invalid input
// (not JSON) the input is passed through unchanged, so an existing
// text-based check (looking for a login failure in the log) sees the
// same text as before.
//
// **A measure, not a bill.** `total_cost_usd` from the CLI is a
// model-side cost ESTIMATE for the account's plan, not an invoice —
// every line carries `costKind: 'estimate'`, and the dashboard labels
// it that way (dash-fix3 wording, part 2a).
//
// **Where this differs from the sibling, on purpose.** lucky-mem's
// `betrieb/modellkosten.jsonl` is COMMITTED: that house is a shared,
// team-visible operations repo, and cost visibility across its agents
// is the point. cheap-mem is a personal, single-install memory — this
// journal describes a MACHINE's headless callers, not the user's
// knowledge, and travelling it to another clone via git would be
// exactly the invented-elsewhere-machine's-fact mistake `.pipeline/`
// already guards against for the injection journal and the MCP
// visibility log (see their header comments and .gitignore). So this
// journal lives there too: `.pipeline/model-cost.jsonl`, machine-local
// and already gitignored.
//
// invariant: not-measured-is-not-zero
// invariant: no-model-in-the-recall-path (this module CALLS nothing, it only reads)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLine } from './append.mjs';

export const LOG = path.join('.pipeline', 'model-cost.jsonl');
export const COST_KIND = 'estimate';

const filePath = (root) => path.join(root, LOG);

/**
 * Read the STDOUT of a `claude -p --output-format json` run. Returns
 * `{ ok:true, resultText, usage, costUsd, isError }` on valid JSON;
 * otherwise `{ ok:false, reason }` — the input is then presumably plain
 * text (a login error, a timeout notice, a CLI without
 * `--output-format json`).
 *
 * `claude -p --output-format json` prints ONE JSON object (not
 * stream-json with several lines) — that is the only shape any caller
 * here needs.
 */
export function parseClaudeJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty output' };
  let obj;
  try { obj = JSON.parse(raw); } catch { return { ok: false, reason: 'not valid JSON output (missing --output-format json?)' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'JSON is not an object' };
  const resultText = typeof obj.result === 'string' ? obj.result
    : (typeof obj.content === 'string' ? obj.content : null);
  const usage = obj.usage && typeof obj.usage === 'object' && !Array.isArray(obj.usage) ? obj.usage : null;
  const costUsd = typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : null;
  return {
    ok: true,
    resultText,
    usage,
    costUsd,
    isError: obj.is_error === true,
    sessionId: typeof obj.session_id === 'string' ? obj.session_id : null,
  };
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Build the journal row — a pure function, testable without a file. */
export function buildRow({ who, usage, costUsd, now = new Date(), source = null } = {}) {
  const u = usage || {};
  return {
    ts: new Date(now).toISOString(),
    who: String(who ?? 'unknown').trim() || 'unknown',
    inputTokens: numOrNull(u.input_tokens),
    outputTokens: numOrNull(u.output_tokens),
    cacheCreationInputTokens: numOrNull(u.cache_creation_input_tokens),
    cacheReadInputTokens: numOrNull(u.cache_read_input_tokens),
    costUsd: numOrNull(costUsd),
    costKind: COST_KIND,
    ...(source ? { source } : {}),
  };
}

/**
 * Append one row — only when SOMETHING was measured (usage OR costUsd).
 * Without either, the row would be an invented zero measurement, not a
 * finding.
 */
export function record(root, { who, usage, costUsd, now, source } = {}) {
  if (!usage && costUsd == null) {
    return { written: false, reason: 'neither usage nor total_cost_usd was supplied' };
  }
  const row = buildRow({ who, usage, costUsd, now, source });
  try {
    fs.mkdirSync(path.dirname(filePath(root)), { recursive: true });
    appendLine(filePath(root), `${JSON.stringify(row)}\n`);
    return { written: true, row };
  } catch (e) {
    return { written: false, reason: e?.message || String(e) };
  }
}

/** Every row, oldest first. Broken lines are counted, never swallowed. */
export function read(root) {
  let raw;
  try { raw = fs.readFileSync(filePath(root), 'utf8'); } catch { return { rows: [], broken: 0 }; }
  const rows = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && e.ts && e.who) rows.push(e); else broken += 1;
    } catch { broken += 1; }
  }
  return { rows, broken };
}

/**
 * Totals per caller (`who`) over the last `sinceDays` days: tokens
 * ALWAYS as a number (0 when measured rows exist without a token
 * field), `costUsd` NULL when NONE of the rows carried a cost value
 * (not every CLI version returns it) — "not measured yet" stays
 * distinguishable on the dashboard from "$0".
 */
export function sumByCaller(root, { sinceDays = 7, now = new Date() } = {}) {
  const cutoff = new Date(now).getTime() - sinceDays * 86400000;
  const { rows } = read(root);
  const by = new Map();
  for (const z of rows) {
    const t = new Date(z.ts).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    if (!by.has(z.who)) {
      by.set(z.who, { who: z.who, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: null, costMeasured: false });
    }
    const s = by.get(z.who);
    s.runs += 1;
    if (typeof z.inputTokens === 'number') s.inputTokens += z.inputTokens;
    if (typeof z.outputTokens === 'number') s.outputTokens += z.outputTokens;
    if (typeof z.costUsd === 'number') { s.costUsd = (s.costUsd ?? 0) + z.costUsd; s.costMeasured = true; }
  }
  return [...by.values()].map(({ costMeasured, ...rest }) => ({ ...rest, costUsd: costMeasured ? rest.costUsd : null }));
}

// --- CLI branch: node src/modelcost.mjs <root> <who> [source] ----------
//
// Reads STDIN (a `claude -p --output-format json` run's output), on
// valid JSON appends a journal row and writes to STDOUT the text the
// calling shell script writes into its own log as before (see the
// header comment). Errors go to STDERR ONLY — a broken journal must
// never fail a model run.
const isDirect = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

if (isDirect) {
  const [, , rootArg, who, source] = process.argv;
  const input = await readStdin();
  const parsed = parseClaudeJson(input);
  if (parsed.ok) {
    if (!parsed.isError && (parsed.usage || parsed.costUsd != null)) {
      const r = record(rootArg, { who, usage: parsed.usage, costUsd: parsed.costUsd, source: source || null });
      if (!r.written) process.stderr.write(`modelcost: not written — ${r.reason}\n`);
    }
    process.stdout.write(parsed.resultText ?? '');
  } else {
    // Not valid JSON — presumably plain text (a login error, a
    // timeout). Passed through unchanged so an existing text-based
    // check sees the same text it always did.
    process.stdout.write(input);
  }
}

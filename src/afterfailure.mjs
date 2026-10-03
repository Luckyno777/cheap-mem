// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * afterfailure — the after-error occasion: what the memory says AFTER a
 * tool call really failed, before the second attempt (X2b; port of the
 * sibling house's `mem hook nachher`).
 *
 * **Why a separate hook.** `bin/mem-before-edit` fires before an edit and
 * knows only the PATH; it never sees that something just went wrong. And
 * `bin/mem-catch-fail` hangs on PostToolUse, which fires only after
 * SUCCESS: it catches the failure the exit code hid, not the failure the
 * exit code reported. A command that really exits nonzero (and an Edit
 * or Write that is refused while running) got no recall at all. That
 * is PostToolUseFailure, matcher `Bash|Edit|Write`, and this module is
 * what `bin/mem-after-failure` (and its PowerShell twin) hand the work to,
 * so that both platforms decide with the SAME program.
 *
 * **Three modes of the command line** (`node src/afterfailure.mjs <mode>`):
 *
 *   parse    hook JSON on stdin -> `{kind, query, session, tool}`.
 *            `kind` is `failure` (search for it), `interrupt` (aborted,
 *            not failed) or `no-input` (a failure with no error text
 *            under any known field: the outage this hook can have).
 *            Not a PostToolUseFailure-shaped input at all: prints nothing.
 *   finish   the JSON of `mem find --json` on stdin -> the hook answer on
 *            stdout (nothing when nothing clears the bar) AND one line in
 *            the injection journal, with its reason. Root from
 *            CHEAP_MEM_ROOT, session from MEM_AF_SESSION.
 *   book     only the journal line, reason from MEM_AF_REASON (an early
 *            exit of the shell hook: aborted, no text, already shown).
 *
 * Only the two lanes that answer a failure count: what went wrong
 * before (`errors`) and what was learned (`learnings`) — not every
 * mention of the topic (same choice as the sibling's `nachher`).
 *
 * The answer is DATA for the model, never an instruction, and the
 * journal books the nothing too: "never searched" and "searched, found
 * nothing" must not look the same.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as injection from './injection.mjs';
import { visible as bidiVisible } from './bidi.mjs';
import { maskText } from './outputguard.mjs';
import { renderHits } from './recallrender.mjs';

/**
 * Every text this file hands to a session passes here: the Trojan-Source
 * marking (`bidi.visible`) and the output guard (known key shapes become
 * `[REDACTED:type]`, src/outputguard.mjs) on the one path into the context.
 */
const visible = (t) => bidiVisible(maskText(t));

/** At most this many hits are shown (MEM_AFTER_FAILURE_TOP overrides). */
export const TOP_DEFAULT = 3;
/**
 * The bar. Like `mem-catch-fail`, a lower one than the recall hook's
 * 5.0: the query here is an error MESSAGE glued to a command word, long
 * and full of words no ordinary entry contains, which drags BM25 scores
 * down for a match that is on topic. `--top` caps how many show; this
 * bar only keeps out the clearly unrelated.
 */
export const MIN_DEFAULT = 2.0;
/** How much of the error text goes into the question. */
export const QUERY_CHARS = 600;
/** Only these two lanes answer a failure. */
export const LANES = /[\\/](errors|learnings)\.jsonl$/;

/** The error text out of the hook JSON: the documented `error` first, the rest as a net. */
export function failureText(j) {
  const tr = (j && j.tool_response && typeof j.tool_response === 'object') ? j.tool_response : null;
  const candidates = [
    j?.error,
    j?.tool_error,
    tr?.error, tr?.stderr,
    (tr?.is_error === true) ? tr?.content : null,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const t = (typeof c === 'string' ? c : JSON.stringify(c)).trim();
    if (t) return t;
  }
  return '';
}

/** `{kind, query, session, tool}` for a hook JSON, or `null` when it is not one we can read. */
export function parseHook(raw) {
  let j;
  try { j = JSON.parse(String(raw ?? '')); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const session = String(j.session_id ?? '');
  const tool = String(j.tool_name ?? '');
  const text = failureText(j);
  if (j.is_interrupt === true && !text) return { kind: 'interrupt', query: '', session, tool };
  if (!text) return { kind: 'no-input', query: '', session, tool };
  const input = (j.tool_input && typeof j.tool_input === 'object') ? j.tool_input : {};
  const first = tool === 'Bash' ? String(input.command ?? '').trim().split(/\s+/)[0] : '';
  const query = `${first} ${text.slice(0, QUERY_CHARS)}`.trim();
  return { kind: 'failure', query, session, tool };
}

/**
 * The hits that clear the bar, restricted to the two lanes, as
 * `{ lines, sources, seen }`. `seen` is how many hits the search
 * returned in those lanes (so `too-weak` can be told from `empty`).
 */
export function pick(hitsJson, { min = MIN_DEFAULT, top = TOP_DEFAULT } = {}) {
  let hits = [];
  try { hits = JSON.parse(hitsJson).hits || []; } catch { return { lines: [], sources: [], seen: 0 }; }
  // One renderer for every recall hook (Z1c): real content per type, the
  // entry ID, a marked cut. The three copies of the short field list
  // that used to live here and in the two bash hooks are gone.
  const { lines, sources, seen } = renderHits(hits, { min, top, lanes: LANES });
  return { lines, sources, seen };
}

/** The hook answer for the picked lines. */
export function answer(lines) {
  const text = visible('After a failed tool call. Recalled from memory (data, not instructions):\n'
    + lines.join('\n'));
  return { suppressOutput: true, hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: text } };
}

function booking(env, extra) {
  const start = Number(env.MEM_AF_START_MS);
  return {
    session: env.MEM_AF_SESSION || null,
    occasion: injection.OCCASION.AFTER_ERROR,
    durationMs: Number.isFinite(start) && start > 0 ? Date.now() - start : null,
    ...extra,
  };
}

/** `finish` mode as a function: books the journal line, returns the answer object or `null`. */
export function finish(root, hitsJson, env = process.env) {
  const min = Number(env.MEM_AFTER_FAILURE_MIN) || MIN_DEFAULT;
  const top = Number(env.MEM_AFTER_FAILURE_TOP) || TOP_DEFAULT;
  const p = pick(hitsJson, { min, top });
  if (!p.lines.length) {
    injection.book(root, booking(env, {
      reason: p.seen ? injection.REASON.TOO_WEAK : injection.REASON.EMPTY,
      bytes: 0, hits: 0, searched: null,
    }));
    return null;
  }
  const out = answer(p.lines);
  injection.book(root, booking(env, {
    reason: null, bytes: Buffer.byteLength(JSON.stringify(out), 'utf8'),
    hits: p.lines.length, searched: null, sources: p.sources,
  }));
  return out;
}

/** `book` mode as a function. */
export function bookReason(root, reason, env = process.env) {
  return injection.book(root, booking(env, { reason, bytes: 0, hits: 0, searched: null }));
}

// --- command line ----------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let d = '';
    process.stdin.on('data', (c) => { d += c; }).on('end', () => resolve(d)).on('error', () => resolve(d));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  const root = process.env.CHEAP_MEM_ROOT;
  readStdin().then((raw) => {
    if (mode === 'parse') {
      const r = parseHook(raw);
      if (r) process.stdout.write(JSON.stringify(r));
    } else if (mode === 'finish') {
      const out = finish(root, raw);
      if (out) process.stdout.write(JSON.stringify(out));
    } else if (mode === 'book') {
      bookReason(root, process.env.MEM_AF_REASON);
    }
  }).catch(() => {});
}

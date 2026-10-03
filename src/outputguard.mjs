// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * outputguard — the second layer: key shapes at the OUTPUT.
 *
 * cheap-mem redacts at WRITE time (`memory.append` -> `redaction.redactEntry`).
 * A secret that got into a drawer past the write path — typed in by hand,
 * left from an older version, brought in by a merge — then sat on disk in
 * the clear, and every surface that shows entries handed it out unchanged:
 * `mem find`, `mem show`, `mem when`, `mem context`, `mem retrieve`, the
 * viewer file, the recall hook's `additionalContext`, the MCP bridge.
 *
 * **One rule, one place.** This module invents no pattern. It calls
 * `redaction.redact`, so it is the very `PATTERNS` list that applies at
 * write time. A new key shape added there protects the write path AND the
 * output.
 *
 * **Patterns only, not the environment match.** `redactEntry` also runs
 * layer 2 (the values in `process.env`). That stays with the write path and
 * the raw capture: at the output it would read the process environment on
 * every recall, and the recall path stays cheap.
 *
 * **Idempotent.** What already reads `[REDACTED:type]` is not found again.
 *
 * **Not a replacement for the write path.** The mask lives in the memory of
 * the output only; the line on disk stays as it is. The finding on disk is
 * still reported by `mem doctor`.
 */

import { redact } from './redaction.mjs';

// A long-running process (`mem serve`, the warm recall server) masks the
// same entries again on every build. The mask is a pure function of the
// text, so a bounded memo may keep it. When either bound is reached the
// whole memo is dropped (simple, no eviction argument).
const MEMO_FROM = 8;
const MEMO_MAX_CHARS = 12_000_000;
const MEMO_MAX_VALUES = 250_000;
const memo = new Map();
let memoChars = 0;

/** Text for the output: known key shapes become `[REDACTED:type]`. */
export function maskText(text) {
  if (typeof text !== 'string' || !text) return text;
  if (text.length < MEMO_FROM) return redact(text).text;
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const masked = redact(text).text;
  if (memoChars + text.length > MEMO_MAX_CHARS || memo.size >= MEMO_MAX_VALUES) { memo.clear(); memoChars = 0; }
  memo.set(text, masked);
  memoChars += text.length;
  return masked;
}

/**
 * An entry (or anything JSON-shaped) for the output: every string value is
 * masked, keys and numbers stay. Returns a COPY.
 */
export function maskEntry(value) {
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map(maskEntry);
  if (value !== null && typeof value === 'object') {
    // Plain objects only: a Date, a Map or a Buffer stays what it is.
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskEntry(v);
    return out;
  }
  return value;
}

/**
 * A finished output line or block that may be a JSON document
 * (`mem find --json`, `mem board --json`): if it is, the VALUES are masked
 * and it is serialised again (so it stays valid JSON); otherwise the text
 * is masked. A JSON document that does not change comes back unchanged,
 * byte for byte.
 */
export function maskOutput(text) {
  if (typeof text !== 'string' || !text) return text;
  const head = text.trimStart()[0];
  if (head === '{' || head === '[') {
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
      const masked = maskEntry(parsed);
      if (JSON.stringify(masked) === JSON.stringify(parsed)) return text;
      // Keep the shape the command printed: indented stays indented.
      return JSON.stringify(masked, null, /^\s*[{[]\n {2}\S/.test(text) ? 2 : 0);
    }
  }
  return maskText(text);
}

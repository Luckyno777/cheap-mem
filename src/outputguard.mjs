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

// A marker the cut tore in half ("[REDACTED:githu") shows nothing secret,
// but it reads as damage. The cut drops the torn stub.
// The label is a short kind name (`[REDACTED:openai-key]`, redaction.mjs); bounded, so an unclosed
// `[REDACTED:` run cannot make the scan quadratic (review: 400 KB of them took 6.5 s unbounded).
const MARKER = /\[REDACTED(?::[A-Za-z0-9_-]{0,64})?\]/g;

/**
 * Where a cut at `end` of a MASKED text may fall: an edge inside a
 * `[REDACTED:...]` marker moves to the marker's start, so neither a half
 * marker (`[RED`, `[REDACTED:git`) nor a stump of one is shown.
 */
function markerSafeEnd(masked, end) {
  for (const m of masked.matchAll(MARKER)) {
    if (m.index >= end) break;
    if (end < m.index + m[0].length) return m.index;
  }
  return end;
}

/**
 * **Mask first, then cut.** Cutting a text and masking the piece lets a key
 * that crosses the cut survive as a stump below the pattern's minimum length
 * (`ghp_` plus 29 characters is not found by a 30-character pattern). The
 * order is the whole rule: the mask sees the key whole, the cut sees only
 * the marker. Every surface that shortens entry text for display, a hook
 * message or a stored line goes through here (or through `maskText` before
 * its own cutter; the ratchet test `mask-before-cut-ratchet` guards it).
 *
 * `cutMasked(text, n)` is `maskText(text).slice(0, n)` and nothing more:
 * no ellipsis, no word boundary. A caller with its own cutter masks first
 * and cuts the masked text.
 */
export function cutMasked(text, n) {
  if (typeof text !== 'string' || !text) return text ?? '';
  const masked = maskText(text);
  if (masked.length <= n) return masked;
  return masked.slice(0, Math.max(0, n)).slice(0, markerSafeEnd(masked, Math.max(0, n)));
}

/**
 * The window variant: `text.slice(from, to)` of the MASKED text, so the
 * window cannot start or end inside a key (a tail without its prefix is
 * the same leak from the front). A window edge that falls inside a marker
 * moves to the marker's start, so no half marker is shown.
 */
export function windowMasked(text, from, to) {
  if (typeof text !== 'string' || !text) return text ?? '';
  const masked = maskText(text);
  const a = markerSafeEnd(masked, Math.max(0, from));
  const b = markerSafeEnd(masked, Math.min(masked.length, to));
  return masked.slice(a, Math.max(a, b));
}

/**
 * A **cost bound** (the work after it stays limited) that cannot leave half a key behind. A plain `text.slice(0, n)` in
 * front of a mask cuts through whatever stands at the edge; if the text is later folded (white space squeezed, so the
 * edge moves to the front of the result) or the kept part is short, the cut-through rest comes out and no pattern knows
 * it. So: when the text is longer than `n`, the last run of non-white characters in the window (the one the edge
 * broke) is dropped, back to the last white space. A text that fits comes back whole. Use it as
 * `maskText(costCut(text, n))`, never `maskText(text).slice(0, n)` for a bound that is not itself the shown length.
 *
 * Costs one character class scan of the window; a window without any white space (one run longer than `n`) comes back
 * empty: such a run is not text anybody reads, and a key is exactly such a run.
 */
export function costCut(text, n) {
  if (typeof text !== 'string' || text.length <= n) return text;
  // mask-ok: THIS is the cost bound; the run the edge broke is dropped on the next line
  const window = text.slice(0, Math.max(0, n));
  // the edge fell on white space: the last run is whole
  if (/\s/.test(text[n])) return window.trimEnd();
  let i = window.length;
  while (i > 0 && !/\s/.test(window[i - 1])) i -= 1;
  return window.slice(0, i).trimEnd();
}

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * src/errorsignature.mjs — recognising a failure the exit code hid.
 *
 * Ported idea from lucky-mem BAUPLAN M19 ("the swallowed failure"): a
 * Bash command can end with exit 0 while its own output says it did
 * not succeed — `npm test | tail -20`, `some-check || true`, a TAP or
 * spec run that prints `# fail 3` and still exits clean. A hook on
 * PostToolUseFailure never sees any of that; it only fires on a real
 * nonzero exit. This module is the exact, line-anchored check behind
 * the hook that catches the rest (bin/mem-catch-fail): that script
 * sieves roughly in pure bash first — no process start for the ordinary
 * case, which is every successful Bash call with nothing wrong — and
 * calls into here only past that sieve, for a precise verdict.
 *
 * A signature must start its own line (leading whitespace aside).
 * `grep -rn "Error:" src` output ("file.js:12:  // Error: ...") is not
 * a failure, and neither is a comment or string literal that happens to
 * contain one mid-line. `# fail 0` and "ok 1 - not ok is just a test
 * name" are explicitly not failures — see errorSignature.test.mjs for
 * the false-positive class this exists to reject.
 */

const SIGNATURES = Object.freeze([
  /^\s*not ok\b(?!.*#\s*(?:TODO|SKIP)\b)/, // TAP, unless marked TODO/SKIP
  /^\s*(?:#|ℹ)\s*fail\s+0*[1-9]\d*\s*$/, // TAP/spec summary line, N > 0 (# fail 0 is not a failure)
  /^\s*(?:Uncaught\s+)?[A-Za-z]*Error:/, // Error:, TypeError:, AssertionError: ...
  /^\s*FAIL\b/, // jest, unittest, ad hoc scripts
  /^\s*fatal:/, // git
]);

/**
 * The signature lines in `text`, joined — or `null` when none start a
 * line. At most `max` lines, each cut to `width`: the same text becomes
 * both the shown context and (via the caller) a dedup fingerprint, and
 * both should agree on the same output for the same input.
 */
export function errorSignature(text, { max = 8, width = 300 } = {}) {
  const lines = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (SIGNATURES.some((re) => re.test(line))) {
      lines.push(line.trim().slice(0, width));
      if (lines.length >= max) break;
    }
  }
  return lines.length ? lines.join('\n') : null;
}

/** stdout+stderr out of a Bash tool_response, whether object or string. */
export function bashOutput(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse !== 'object') return '';
  return [toolResponse.stdout, toolResponse.stderr, toolResponse.output, toolResponse.content]
    .filter((x) => typeof x === 'string' && x)
    .join('\n');
}

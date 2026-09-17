// No script may depend on a tool that is not on every platform.
//
// **The measurement behind this file (2026-09-17).** `flock` and
// `timeout` are GNU tools; neither is on macOS by default. Both fail in
// the same nasty way — not with a crash, but with a value that reads
// like ordinary operation:
//
//   - a missing `flock` makes `if ! flock -n 9` TRUE, so the caller
//     concludes "someone else holds the lock" and stands down. Every
//     tick, forever, exit 0.
//   - a missing `timeout` makes the wrapped command exit 127 before it
//     ever starts, which the caller reads as "the command failed".
//
// bin/mem-retrieve learned the `timeout` half months ago and wrote it
// into its own comment. The lesson stayed in that one file. Then the
// first CI step that ever started bin/mem-digest found BOTH holes
// there, and a sweep found seven more scripts across two repositories
// carrying the same lines. On a Mac the digest could not work by two
// independent routes, and nothing was red.
//
// So the rule is not a list of the scripts that were fixed today — a
// list goes stale the moment someone adds a script. The rule is: if a
// shell script calls one of these tools, it must reach them through
// bin/_portable.sh. The probe finds the scripts itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin');
const HELFER = '_portable.sh';

/** Every shell script in bin/ — by shebang, not by file extension. */
function shellSkripte() {
  return fs.readdirSync(BIN)
    .filter((n) => n !== HELFER && !n.endsWith('.ps1'))
    .map((n) => ({ name: n, text: fs.readFileSync(path.join(BIN, n), 'utf8') }))
    .filter((f) => /^#!.*\b(ba)?sh\b/.test(f.text));
}

/**
 * Lines that CALL one of the two tools.
 *
 * Not every mention: the scripts talk about a timeout in their log
 * messages ("exit $? (timeout or error)"), and a probe that counted
 * those would be red on prose. A call is the tool at the start of a
 * command — after the line start, a pipe, `&&`, `;`, `(` or `if`.
 */
function harteAufrufe(text) {
  const treffer = [];
  text.split('\n').forEach((z, i) => {
    if (/^\s*#/.test(z)) return;
    // Blank out quoted strings first. Without this the probe trips over
    // `note "handler: exit $? (timeout or error)"` — the word sits after
    // a `(`, which is exactly the shape of a real call. Found by the
    // detector's own positive control, which is why that control is
    // there: a rule nobody can pass gets turned off, not fixed.
    const ohneText = z.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    if (/(^|[|;&(]|\bif\s+!?\s*|\bthen\s+|&&\s*|\|\|\s*)\s*(timeout|flock)\s+[-"'$\w]/.test(ohneText)) {
      treffer.push(`${i + 1}: ${z.trim()}`);
    }
  });
  return treffer;
}

test('POSITIVE: the reader finds the shell scripts at all', () => {
  // Without this, every rule below would hold against an empty list.
  const s = shellSkripte();
  assert.ok(s.length >= 6, `only ${s.length} shell scripts found — the reader no longer fits bin/`);
  assert.ok(fs.existsSync(path.join(BIN, HELFER)), `bin/${HELFER} is gone`);
});

test('POSITIVE: the call detector really recognises a call', () => {
  // And does NOT trip over the word in a log message — that would make
  // the rule below unpassable and it would be turned off.
  assert.deepEqual(harteAufrufe('timeout 5 foo'), ['1: timeout 5 foo']);
  assert.deepEqual(harteAufrufe('  if ! flock -n 9; then'), ['1: if ! flock -n 9; then']);
  assert.deepEqual(harteAufrufe('( cd x && timeout "$T" $CMD )'), ['1: ( cd x && timeout "$T" $CMD )']);
  assert.deepEqual(harteAufrufe('note "handler: exit $? (timeout or error)"'), []);
  assert.deepEqual(harteAufrufe('#   MEM_DIGEST_TIMEOUT    seconds'), []);
});

test('no shell script calls flock or timeout directly', () => {
  const schuldig = [];
  for (const f of shellSkripte()) {
    const t = harteAufrufe(f.text);
    if (t.length) schuldig.push(`bin/${f.name}\n    ${t.join('\n    ')}`);
  }
  assert.deepEqual(schuldig, [],
    'these scripts call a tool that is not on macOS; route them through '
    + `bin/${HELFER} (capped / mem_take_lock) instead:\n  ${schuldig.join('\n  ')}`);
});

test('every script that needs them sources the shared file', () => {
  // The other direction: using `capped` or `mem_take_lock` without
  // sourcing the file is a runtime error, and only on the machine that
  // runs that script.
  for (const f of shellSkripte()) {
    if (!/\b(capped|mem_take_lock)\s/.test(f.text)) continue;
    // Deliberately loose about HOW the path is built: mem-reflect
    // computes it inline with nested quotes, others use a $HERE they
    // already have. What must be there is a `.` source line naming the
    // file — pinning the spelling would make the probe fail on a
    // correct script, and a probe that cries wolf gets deleted.
    assert.match(f.text, new RegExp(`^\\s*\\.\\s.*${HELFER}`, 'm'),
      `bin/${f.name} uses capped/mem_take_lock without sourcing bin/${HELFER}`);
  }
});

test('the shared file offers both halves, and a fallback for each', () => {
  // Otherwise the rule above could be satisfied by an empty file.
  const h = fs.readFileSync(path.join(BIN, HELFER), 'utf8');
  assert.match(h, /command -v timeout/, 'no timeout probe');
  assert.match(h, /command -v gtimeout/, 'no gtimeout fallback');
  assert.match(h, /command -v flock/, 'no flock probe');
  assert.match(h, /mkdir "\$lockdir"/, 'no directory lock as the flock fallback');
  assert.match(h, /capped\(\)/, 'capped is missing');
  assert.match(h, /mem_take_lock\(\)/, 'mem_take_lock is missing');
});

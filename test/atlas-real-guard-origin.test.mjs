// bench/atlas/phase-real.mjs — B4: the content guard must tell its own
// mistakes from a real leak.
//
// **The finding this answers (bauplan 2, 2026-09-20).** `real.guard.
// redactions` once reported 1 redaction and read like a leak of lucky-
// mem's content. It was a bare JS string literal this file's own author
// had written directly into an `expected` field instead of building it
// with `say`/`Vouched`. The guard was right to scrub it — a raw string
// is exactly the shape a real leak would take — but the report called
// every scrub the same severity, so a harness typo and an actual leak
// were indistinguishable.
//
// **The fix, tested here.** `Guard#scrub` now classifies a redacted
// string by ORIGIN, not appearance: is it verbatim, exact, and long
// enough to be a stretch of this file's OWN source text (a harness bug,
// `minor`, its location named), or not (assumed to be real content,
// `critical`, unchanged). Both directions are proven below, and — per
// this house's rule that sabotage prefers a parameter over a source
// patch — entirely through `Guard`'s public `scrub()` method with
// ordinary JS values, never a patch to phase-real.mjs itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Guard } from '../bench/atlas/phase-real.mjs';

const PHASE_REAL_PATH = fileURLToPath(new URL('../bench/atlas/phase-real.mjs', import.meta.url));
const ownSource = fs.readFileSync(PHASE_REAL_PATH, 'utf8');

/** A literal, exact, >=20-char chunk lifted straight OUT of phase-real.mjs's own source. */
function realOwnSourceLiteral() {
  const anchor = 'The distinguishing signal is origin';
  const idx = ownSource.indexOf(anchor);
  assert.ok(idx >= 0,
    'test fixture assumption: this exact comment sentence must still exist in phase-real.mjs '
    + '(it documents the very mechanism under test) — if it moved, update the anchor here');
  return ownSource.slice(idx, idx + 40);
}

test('ROT (own-code case): a string lifted verbatim from this file\'s own source is classified minor, not critical', () => {
  const g = new Guard();
  const literal = realOwnSourceLiteral();
  const back = g.scrub(literal);
  assert.equal(back, '[[redacted by content guard]]', 'sanity: it was in fact redacted (not a safe token)');
  assert.equal(g.redactions, 1);
  assert.equal(g.contentRedactions, 0,
    'a code-own literal must NOT be counted as a content-grade (critical) leak');
  assert.equal(g.ownStringRedactions.length, 1,
    'a code-own literal must be counted in the own-string (minor/harness-bug) bucket');
  // `callerLocation()` names the actual call site, whichever file that
  // is — here, this test file, since it drives `scrub()` directly; in
  // production it is always `phase-real.mjs`, the guard's one real
  // caller. Either way it must be a parseable `file.mjs:line`.
  assert.match(g.ownStringRedactions[0].location, /^[\w.-]+\.mjs:\d+$/,
    'the finding must name where the mistake happened (file:line)');
});

test('ROT (content case): a string read from a file, not present in this file\'s source, is classified critical', () => {
  // Simulated real content: a German sentence shaped like a memory
  // entry, written to a SEPARATE file and read back — never a literal
  // in phase-real.mjs, exactly the origin distinction the guard now
  // makes (read from a file, not authored as a literal here).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-guard-origin-'));
  const file = path.join(dir, 'simulated-entry.txt');
  const simulatedContent = 'Dies ist ein erfundener Speichereintrag zur Pruefung des Waechters, nicht echt';
  fs.writeFileSync(file, simulatedContent);
  try {
    assert.ok(!ownSource.includes(simulatedContent),
      'test fixture assumption: the simulated content must not accidentally already be in phase-real.mjs');
    const valueFromFile = fs.readFileSync(file, 'utf8');
    const g = new Guard();
    const back = g.scrub(valueFromFile);
    assert.equal(back, '[[redacted by content guard]]');
    assert.equal(g.redactions, 1);
    assert.equal(g.ownStringRedactions.length, 0,
      'content read from a file must NOT be filed as a harness bug');
    assert.equal(g.contentRedactions, 1,
      'content read from a file, not found in this file\'s own source, must be classified critical');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GRUEN (positive control, unchanged behaviour): the guard still redacts a synthetic memory-shaped string at all', () => {
  // Mirrors the phase's own `real.guard.positive-control` — this is not
  // a NEW guarantee, it is proof the origin split did not weaken the
  // guard's original job of catching an unsafe raw string in the first
  // place.
  const g = new Guard();
  const fakeMemoryEntry = '{"id":"fake0000","ts":"2020-01-01T00:00:00Z",'
    + '"titel":"Der Testeintrag wurde absichtlich erfunden",'
    + '"text":"Dies ist kein echter Eintrag aus lucky-mem"}';
  g.scrub(fakeMemoryEntry);
  assert.equal(g.redactions, 1);
  // Whichever bucket it lands in, the TOTAL must still be non-zero — the
  // point of this test is "still redacted", not which bucket.
  assert.equal(g.ownStringRedactions.length + g.contentRedactions, 1);
});

test('the two buckets always sum to the total redaction count', () => {
  const g = new Guard();
  g.scrub(realOwnSourceLiteral());
  g.scrub('a completely unrelated sentence nobody wrote into this file, over twenty characters long');
  g.scrub(42);
  g.scrub('copy');
  assert.equal(g.redactions, g.ownStringRedactions.length + g.contentRedactions,
    'every redaction must be attributed to exactly one origin bucket, with none double-counted or dropped');
});

test('numbers, booleans and the small allowed vocabulary pass through unredacted either way', () => {
  const g = new Guard();
  assert.equal(g.scrub(42), 42);
  assert.equal(g.scrub(true), true);
  assert.equal(g.scrub('copy'), 'copy');
  assert.equal(g.scrub('original'), 'original');
  assert.equal(g.scrub('12.3ms'), '12.3ms');
  assert.equal(g.redactions, 0);
  assert.equal(g.contentRedactions, 0);
  assert.equal(g.ownStringRedactions.length, 0);
});

test('a short coincidental match against this file\'s own source is NOT trusted as a code-own literal (safe-side default)', () => {
  // Below the length floor, "found verbatim in our own source" proves
  // too little to downgrade a redaction to minor — a short real-content
  // word could coincidentally appear in this file's English prose too.
  // The abort criterion for B4 is a real leak reading as minor; the safe
  // failure direction is to keep short/uncertain matches critical.
  const g = new Guard();
  // "index" is unsafe (not numeric-shaped, not in the allowed vocabulary)
  // and, being a five-letter common word, is almost certainly present
  // SOMEWHERE in this file's own source too — yet it must still be
  // classified as content, not as a code-own literal.
  assert.ok(ownSource.includes('index'), 'test fixture assumption: this short word occurs in phase-real.mjs');
  g.scrub('index');
  assert.equal(g.ownStringRedactions.length, 0);
  assert.equal(g.contentRedactions, 1);
});

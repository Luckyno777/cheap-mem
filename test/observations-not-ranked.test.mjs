// The observation ledger (`src/observations.mjs`): records what a
// ranked query showed, never influences what it shows.
//
// This is the second "must never" probe the task calls out (alongside
// the bridge_tool probe). The outside proposal's flaw was exactly a
// per-machine use-count feeding back into ranking, which breaks
// "identical data, identical parameters, identical prompt". Building
// the ledger without that feedback path is the whole point, so the
// probe deletes the ledger entirely and checks the ranked answer does
// not move by a single byte.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as observations from '../src/observations.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

// Genuinely distinct wording per note, not "note N" with a changing
// digit: near-duplicate phrasing gets collapsed by retrieval's own
// diversity pass (MMR) before this test's sabotage ever gets a say,
// which would hide a real reordering bug behind "only 2 ids ever come
// back anyway". Measured: with "widget note N" / "finding N", a
// 5-entry fixture returned only 2 ids for every query tried.
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-obs-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  // Several claims on the same topic, so there is an actual ORDER for
  // a ledger to have a chance at disturbing (a single-hit query proves
  // nothing about ranking).
  for (const w of WORDS) {
    spawnSync(process.execPath, [MEM, '--root', r, 'log', 'learning',
      '--topic', 'widget', '--title', `widget ${w}`, '--text', `the widget component ${w} needs attention`],
    { encoding: 'utf8' });
  }
  return r;
}
const run = (r, ...a) => spawnSync(process.execPath, [MEM, '--root', r, ...a], { encoding: 'utf8' });
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

test('mem retrieve appends one observation line per call, per the retrieve lane', () => {
  const r = world();
  try {
    const before = observations.readAll(r);
    assert.equal(before.missing, true, 'fixture must start with no ledger — an empty pass proves nothing');
    run(r, 'retrieve', 'widget');
    const after = observations.readAll(r);
    assert.equal(after.missing, false);
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].lane, 'retrieve');
    assert.ok(after.entries[0].ids.length >= 1, 'the observation must name what was shown');
  } finally { away(r); }
});

/**
 * The retrieval score legitimately drifts by a few ULPs from one call
 * to the next EVEN WITH NO CODE CHANGE AT ALL — it is derived in part
 * from freshness decay against wall-clock "now" (measured directly:
 * two `mem retrieve` calls one following the other, no ledger involved,
 * produced 0.18583143780786032 and 0.1858314374556235 for the same
 * claim). That is a pre-existing property of `src/retrieval.mjs`'s
 * scoring, not something this test set out to check, and not something
 * this file's probe should be confused by. What this probe is actually
 * claiming is narrower and exactly what matters here: the SET, the
 * ORDER, and every structural verdict (coverage, truncation, what was
 * excluded and why) do not move — so `score` is stripped before the
 * comparison and everything else is compared whole.
 */
function stripVolatileScore(json) {
  const r = JSON.parse(json);
  for (const c of r.claims) delete c.score;
  return r;
}

test('THE CASE: a heavily-observed ledger changes nothing — delete it, and the ranked answer is unchanged', () => {
  const r = world();
  try {
    // Run the SAME query many times, AND a narrower query that only
    // ever matches one note — so the ledger accumulates a real, UNEVEN
    // skew: some ids would look "most used" if anything read it, others
    // would not. A ledger where every id ties would let a reordering
    // bug hide behind a stable sort.
    for (let i = 0; i < 7; i += 1) run(r, 'retrieve', 'widget', '--json');
    for (let i = 0; i < 5; i += 1) run(r, 'retrieve', 'alpha', '--json');
    // Captured LAST, once the skew is in place — this is "the answer
    // while a heavily uneven ledger sits next to it".
    const withLedgerRaw = run(r, 'retrieve', 'widget', '--json').stdout;
    const ledgerBefore = observations.readAll(r);
    assert.ok(ledgerBefore.entries.length >= 13, 'the ledger fixture must actually have accumulated observations');

    fs.rmSync(observations.ledgerPath(r), { force: true });
    assert.equal(observations.readAll(r).missing, true, 'the ledger must actually be gone before the comparison run');

    const withoutLedgerRaw = run(r, 'retrieve', 'widget', '--json').stdout;
    const withLedger = stripVolatileScore(withLedgerRaw);
    const withoutLedger = stripVolatileScore(withoutLedgerRaw);
    assert.deepEqual(withoutLedger.claims.map((c) => c.id), withLedger.claims.map((c) => c.id),
      'the order of claims must not depend on whether the observation ledger exists');
    assert.deepEqual(withoutLedger, withLedger,
      'retrieval output (aside from the naturally time-drifting score) must not depend on the ledger');
  } finally { away(r); }
});

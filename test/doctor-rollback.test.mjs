// test/doctor-rollback.test.mjs — P21: the watermark now has a tick.
//
// `src/epoch.mjs` already had the mechanics (observe/checkEpoch/recordEpoch,
// see test/epoch.test.mjs) and `checkRollback` in src/doctor.mjs already
// turned those into a finding — but neither had ever been exercised through
// `mem doctor`, and nothing in the codebase ever called `recordEpoch` on its
// own. "no watermark yet" was not a fact about any memory; it was a fact
// about nobody having typed `mem epoch record`.
//
// This file tests two things:
//
//   1. `checkRollback` itself (the finding), which had ZERO test coverage
//      before this change despite being wired into `checkAll` since it was
//      written — the probe/counter-probe/sabotage/positive-control the
//      brief asks for.
//   2. `doctor.tickEpoch`, the new automatic tick: a passing `mem doctor`
//      run (no ERROR anywhere, not just in the rollback finding) now
//      advances the mark on its own.
//
// Four states, never two: UNKNOWN is asserted explicitly wherever the
// mark cannot say anything, never inferred from the absence of GOOD.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkRollback, tickEpoch, LEVEL } from '../src/doctor.mjs';
import { observe, readEpoch, EPOCH_FILE } from '../src/epoch.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

const z = (o) => `${JSON.stringify(o)}\n`;
const A = {
  id: 'a1', ts: '2026-01-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 't', choice: 'payment up front', why: 'original',
};
const FIX = {
  id: 'a2', ts: '2026-02-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 't', choice: 'payment up front, SEPA only', why: 'narrowed', replaces_id: 'a1',
};
const MORE = {
  id: 'a3', ts: '2026-03-01T00:00:00Z', author: 'alice', authority: 'agent',
  topic: 'u', choice: 'a second, unrelated decision', why: 'more forward work',
};

const LOG = ['projects', 'a', 'decisions.jsonl'];

/** A bare (non-`mem init`) root, direct JSONL control — same shape
 *  test/epoch.test.mjs already relies on for `observe`/`checkEpoch`. */
function fixture(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-doc-rb-'));
  fs.mkdirSync(path.join(root, 'projects', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, ...LOG), entries.map(z).join(''));
  return root;
}
const write = (root, entries) => fs.writeFileSync(
  path.join(root, ...LOG), entries.map(z).join(''));
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

// -- checkRollback: the finding itself -------------------------------------

test('SABOTAGE / not-measurable-is-not-zero: no mark at all -> UNKNOWN, never GOOD', () => {
  const root = fixture([A]);
  const f = checkRollback(root);
  assert.equal(f.level, LEVEL.UNKNOWN);
  assert.match(f.text, /no watermark yet/);
  assert.ok(f.advice, 'an UNKNOWN finding may skip advice, but this one names the fix');
  rm(root);
});

test('POSITIVE CONTROL: a mark that matches the current state says WHAT it inspected', () => {
  const root = fixture([A, FIX]);
  const before = tickEpoch(root, { worst: LEVEL.GOOD });
  assert.equal(before.advanced, true, 'setup: the tick must establish the first mark');
  const seen = observe(root);
  const f = checkRollback(root);
  assert.equal(f.level, LEVEL.GOOD);
  // "ok" is only earned by naming the quantities actually inspected —
  // a bare "ok" with no numbers would be exactly the failure mode this
  // house's four-state rule exists to rule out.
  assert.match(f.text, new RegExp(`${seen.claims} claims`));
  assert.match(f.text, new RegExp(`${seen.retiredCount} retired`));
  assert.match(f.text, /watermark from/);
  rm(root);
});

test('PROBE: an artificial jump backwards is reported RED, and named', () => {
  const root = fixture([A, FIX]);
  tickEpoch(root, { worst: LEVEL.GOOD });          // mark: 2 claims, 1 retired
  write(root, [A]);                                 // t1 state again: a1 un-retires
  const f = checkRollback(root);
  assert.equal(f.level, LEVEL.ERROR);
  assert.match(f.text, /BACKWARDS/);
  assert.match(f.text, /a1/);
  assert.ok(f.advice);
  rm(root);
});

test('COUNTER-PROBE (this is the one that matters most): normal forward work never fires the finding', () => {
  const root = fixture([A, FIX]);
  tickEpoch(root, { worst: LEVEL.GOOD });
  write(root, [A, FIX, MORE]);                       // pure addition, nothing resurrected
  const f = checkRollback(root);
  assert.equal(f.level, LEVEL.GOOD,
    'a rollback check that fires on an ordinary append is worse than none');
  rm(root);
});

test('SABOTAGE: the mark is deleted mid-session -> the finding falls back to UNKNOWN, not "ok"', () => {
  const root = fixture([A, FIX]);
  tickEpoch(root, { worst: LEVEL.GOOD });
  assert.equal(checkRollback(root).level, LEVEL.GOOD, 'setup: must be green before the sabotage');
  fs.rmSync(path.join(root, EPOCH_FILE));
  const f = checkRollback(root);
  assert.equal(f.level, LEVEL.UNKNOWN,
    'a missing mark is unmeasurable, not healthy — reporting GOOD here would be the ' +
    'exact bug this feature exists to prevent');
  rm(root);
});

// -- tickEpoch: the automatic advance ---------------------------------------

test('tick: a passing self-check with no mark yet establishes one, unattended', () => {
  const root = fixture([A, FIX]);
  assert.equal(readEpoch(root), null, 'setup: no mark yet');
  const r = tickEpoch(root, { worst: LEVEL.GOOD });
  assert.equal(r.advanced, true);
  const mark = readEpoch(root);
  assert.ok(mark, 'the tick did not write a mark');
  assert.equal(mark.claims, observe(root).claims);
  rm(root);
});

test('tick COUNTER-PROBE: an ERROR anywhere in the self-check blocks the tick, even with no rollback in sight', () => {
  const root = fixture([A]);
  // A synthetic doctor result: nothing wrong with THIS module's own
  // state, but doctor found an unrelated ERROR elsewhere (a leaked
  // credential, a broken config — anything). tickEpoch must not care
  // which finding was red; only that one was.
  const r = tickEpoch(root, { worst: LEVEL.ERROR });
  assert.equal(r.advanced, false);
  assert.equal(readEpoch(root), null,
    'a state that never passed doctor must not be enshrined as the reference');
  rm(root);
});

test('tick: WARN and UNKNOWN elsewhere do not block it (only ERROR does)', () => {
  // Every fresh memory has UNKNOWN findings (this one`s own rollback
  // finding, before its first mark, among them) and most real memories
  // carry at least one WARN. Requiring a spotless run would mean the
  // mark can basically never advance.
  const root = fixture([A]);
  const r1 = tickEpoch(root, { worst: LEVEL.UNKNOWN });
  assert.equal(r1.advanced, true, 'UNKNOWN elsewhere must not block the first tick');
  write(root, [A, FIX]);
  const r2 = tickEpoch(root, { worst: LEVEL.WARN });
  assert.equal(r2.advanced, true, 'WARN elsewhere must not block a later tick');
  rm(root);
});

test('tick keeps advancing across ordinary forward growth', () => {
  const root = fixture([A]);
  tickEpoch(root, { worst: LEVEL.GOOD });
  const first = readEpoch(root);
  write(root, [A, FIX, MORE]);
  const r = tickEpoch(root, { worst: LEVEL.GOOD });
  assert.equal(r.advanced, true);
  const second = readEpoch(root);
  assert.ok(second.claims > first.claims, 'the mark did not move forward with the memory');
  rm(root);
});

test('tick DOUBLE DEFENCE: even a caller reporting worst=GOOD cannot push the mark backwards', () => {
  // tickEpoch trusts its caller's `worst`, but `recordEpoch` underneath
  // it independently re-derives the rollback state and refuses on its
  // own — the same refusal `mem epoch record` (no --force) already
  // relies on. This proves the second guard is real, not just claimed
  // in the docblock.
  const root = fixture([A, FIX]);
  tickEpoch(root, { worst: LEVEL.GOOD });
  const before = readEpoch(root);
  write(root, [A]);                                  // a real rollback in the tree
  const r = tickEpoch(root, { worst: LEVEL.GOOD });   // a caller that (wrongly) thinks it's fine
  assert.equal(r.advanced, false);
  assert.deepEqual(readEpoch(root), before, 'the mark moved backwards anyway');
  rm(root);
});

// -- CLI wiring: the tick has to fire from the one place doctor is actually run --
//
// The 2026-09-20 `doctor.can-fail` incident (test/doctor-reaches-broken.test.mjs)
// is the exact shape of bug a unit test cannot see: the checked function was
// always correct, and the defect lived one call site up, on the path only a
// real `mem doctor` invocation takes. The tick is wired in at that same call
// site, so it gets the same kind of test.

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-doc-rb-cli-'));
}

function runDoctor(root) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [MEM, 'doctor'], {
      env: { ...process.env, CHEAP_MEM_ROOT: root }, encoding: 'utf8',
    }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

test('CLI: `mem doctor` on a freshly initialised memory writes the watermark on its own', () => {
  const root = tmpRoot();
  try {
    execFileSync(process.execPath, [MEM, 'init'], {
      env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: 'ignore',
    });
    assert.equal(fs.existsSync(path.join(root, EPOCH_FILE)), false,
      'setup: init alone must not create a watermark');
    const { out, code } = runDoctor(root);
    assert.notEqual(code, 2, `doctor reported an error on a fresh init:\n${out}`);
    assert.equal(fs.existsSync(path.join(root, EPOCH_FILE)), true,
      'mem doctor did not establish the watermark — nobody ever calls mem epoch record '
      + `by hand, so this is the only place it can happen\n${out}`);
  } finally { rm(root); }
});

test('CLI COUNTER-PROBE: `mem doctor` on a broken memory (no config) does NOT write a watermark', () => {
  const root = tmpRoot();          // deliberately never `mem init`-ed: checkConfig is ERROR
  try {
    const { out } = runDoctor(root);
    assert.match(out, /FAIL\s+config/, `expected a failing config finding:\n${out}`);
    // `.mem/` itself can legitimately appear as a side effect of other,
    // unrelated checks (checkIndex writes a search-index.json cache even
    // while reporting on a broken memory) — that is pre-existing
    // behaviour this feature does not touch. What THIS latch owns is the
    // watermark specifically: a config-less, error-level run must not
    // enshrine that broken state as the reference.
    assert.equal(fs.existsSync(path.join(root, EPOCH_FILE)), false,
      'mem doctor wrote a watermark for a memory that failed its own config check — '
      + `an ERROR anywhere must block the tick\n${out}`);
  } finally { rm(root); }
});

// test/atlas-k0-probes.test.mjs — the atlas measures honestly (K0 fixes 3 and 4).
//
// Fix 3: a search that failed is never "warm", and a cache probe never
// passes on the strength of a command that exited non-zero. Fix 4: the
// on-disk truth does not count cards, which the index leaves out by design.
// Each block carries a positive control, so the red it asserts is a red the
// probe can produce at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VERDICT, mem, buildCorpus, cacheDirPath, cacheManifestPath,
} from '../bench/atlas/core.mjs';
import { timeCli, coldWarmFields } from '../bench/atlas/phase-load.mjs';
import {
  diskTruth, cacheThresholdVerdict, cacheCounterVerdict, cachePositiveVerdict,
} from '../bench/atlas/phase-robust.mjs';

const TUNING = { maxReps: 5, cellBudgetMs: 1000 };
const fake = (statuses) => {
  let i = 0;
  return (args) => {
    const status = statuses[Math.min(i, statuses.length - 1)]; i += 1;
    return { args, status, ms: 10 + i, bytes: 5, stdout: '', stderr: '', signal: null };
  };
};

test('fix 3: timeCli with every run exiting 0 yields a p50 (positive control)', () => {
  const c = timeCli(['find', 'x'], '/unused', TUNING, { run: fake([0]) });
  assert.equal(c.failedRuns, 0);
  assert.equal(c.notMeasuredBecause, null);
  assert.equal(typeof c.p50, 'number');
});

test('fix 3: one run exiting non-zero leaves the cell without any timing, with a reason', () => {
  for (const statuses of [[0, 0, 1, 0, 0, 0], [1, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 2]]) {
    const c = timeCli(['find', 'x'], '/unused', TUNING, { run: fake(statuses) });
    assert.ok(c.failedRuns >= 1, `failedRuns for ${statuses}`);
    assert.equal(c.p50, null);
    assert.equal(c.p95, null);
    assert.equal(c.min, null);
    assert.match(c.notMeasuredBecause, /non-zero/);
  }
});

test('fix 3: an exit the command\'s contract names as an answer (doctor warns with 1) still yields a timing', () => {
  const c = timeCli(['doctor'], '/unused', TUNING, { run: fake([1]), okStatuses: [0, 1] });
  assert.equal(c.failedRuns, 0);
  assert.equal(typeof c.p50, 'number');
  const d = timeCli(['doctor'], '/unused', TUNING, { run: fake([2]), okStatuses: [0, 1] });
  assert.equal(d.p50, null);
});

test('fix 3: a cold/warm row with a failed warm run has no warm p50 and no penalty, and keeps both statuses', () => {
  const cold = { status: 0, ms: 500 };
  const good = coldWarmFields('find', cold, timeCli(['find'], '/u', TUNING, { run: fake([0]) }));
  assert.equal(typeof good.findWarmP50Ms, 'number');
  assert.equal(typeof good.findPenaltyMs, 'number');
  assert.equal(good.findWarmStatus, 0);
  assert.equal(good.findNotMeasuredBecause, undefined);

  const badWarm = coldWarmFields('find', cold, timeCli(['find'], '/u', TUNING, { run: fake([2]) }));
  assert.equal(badWarm.findWarmP50Ms, null);
  assert.equal(badWarm.findPenaltyMs, null);
  assert.equal(badWarm.findWarmStatus, 2);
  assert.match(badWarm.findNotMeasuredBecause, /did not answer/);

  const badCold = coldWarmFields('find', { status: 1, ms: 5 }, timeCli(['find'], '/u', TUNING, { run: fake([0]) }));
  assert.equal(badCold.findPenaltyMs, null);
  assert.equal(badCold.findColdStatus, 1);
});

test('fix 3: the cache verdicts never pass on a find that exited non-zero', () => {
  const ok = { findExit: 0, rewritten: true };
  const failed = { findExit: 1, rewritten: true };
  assert.equal(cacheThresholdVerdict(ok), VERDICT.PASS);
  assert.notEqual(cacheThresholdVerdict(failed), VERDICT.PASS);
  assert.equal(cacheThresholdVerdict({ findExit: 0, rewritten: false }), VERDICT.FAIL);

  assert.equal(cacheCounterVerdict({ findExit: 0, rewritten: false }), VERDICT.PASS);
  assert.notEqual(cacheCounterVerdict({ findExit: 1, rewritten: false }), VERDICT.PASS);
  assert.equal(cacheCounterVerdict({ findExit: 0, rewritten: true }), VERDICT.DEGRADED);

  assert.equal(cachePositiveVerdict({ findExit: 0, had: 0, after: 10 }), VERDICT.PASS);
  assert.notEqual(cachePositiveVerdict({ findExit: 3, had: 0, after: 10 }), VERDICT.PASS);
  assert.notEqual(cachePositiveVerdict({ findExit: 0, had: 0, after: 0 }), VERDICT.PASS);
});

test('fix 3: the cache path follows the expand suffix, and a real find under MEM_EXPAND=1 writes there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-k0-expand-'));
  try {
    const corpus = buildCorpus(root, 60, { anchors: 1, seed: 5 });
    const env = { MEM_EXPAND: '1' };
    assert.ok(cacheDirPath(root, env).endsWith('-expand'));
    assert.ok(!cacheDirPath(root, {}).endsWith('-expand'));
    const r = mem(['find', corpus.anchors[0].phrase], { root, env });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(cacheManifestPath(root, env)), 'cache under the suffixed directory');
    assert.ok(!fs.existsSync(cacheManifestPath(root, {})), 'nothing under the plain directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fix 4: diskTruth does not count cards, still counts a file the system does not know', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-k0-cards-'));
  try {
    buildCorpus(root, 40, { anchors: 1, seed: 7 });
    const before = diskTruth(root);
    assert.ok(before.parseable >= 40);
    const cards = path.join(root, 'global', 'cards.jsonl');
    fs.writeFileSync(cards, `${JSON.stringify({ id: 'c1', type: 'card', target_id: 'x' })}\n`.repeat(7));
    const withCards = diskTruth(root);
    assert.equal(withCards.parseable, before.parseable, 'cards are not entries the index owes');
    assert.equal(withCards.lines, before.lines);
    // positive control: the filter is the card file only, not "everything unusual"
    fs.writeFileSync(path.join(root, 'global', 'stranger.jsonl'), `${JSON.stringify({ id: 's' })}\n`);
    assert.equal(diskTruth(root).parseable, before.parseable + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

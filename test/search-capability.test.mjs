// Build point P13, repair half. `src/search.mjs` filtered `project` by
// bare string equality and never consulted `src/capability.mjs` — the
// finding of `test/scope-lattice-redteam.test.mjs`. `search()` and
// `exactHits()` now accept an OPTIONAL `capability`; when given one they
// use the same lattice-aware predicate `retrieval.mjs` already runs
// (`capability.admits(capabilityMod.scopeOf({ project: doc.project }))`)
// in place of the bare equality check.
//
// **What this file must prove, and in what order:**
//   1. POSITIVE CONTROL, and the important one: a caller that passes NO
//      capability gets EXACTLY what it got before this change — checked
//      against a fixture recorded by running the pristine, pre-repair
//      `search.mjs` (see `test/fixtures/search-capability-baseline.json`
//      and the recording method below).
//   2. A capability scoped to one project excludes a foreign project.
//   3. A capability admits `global` through the LATTICE, not equality —
//      a project-scoped capability still sees a global entry, which the
//      bare `project: '<name>'` string filter never did.
//   4. The same two things again through `exactHits()`, a separate call
//      site with its own claim to prove.
//   5. SABOTAGE, once per function: the shared predicate lives inside
//      `admits()`, so a probe that only ever calls ONE of `search()` /
//      `exactHits()` cannot tell whether the OTHER one wires capability
//      in at all. Each function gets its own sabotage-then-restore.
//   6. The abort criterion: a legitimate query, with the capability that
//      should admit it, must not be blocked.
//
// **How the fixture was recorded (so the positive control means what it
// claims).** `src/search.mjs` cannot be run at two points in its own
// history from inside one test file, and this repo's rule against `git`
// commands in this working copy rules out reading the old blob that way.
// So the fixture was produced by hand, once, exactly like a throwaway
// `git stash`: the four edits below were reverted in place (textually,
// the same edits this diff makes, undone), the corpus-building script at
// the bottom of this comment was run against that reverted file, its
// JSON output was saved as the fixture, and the edits were re-applied
// and diffed byte-for-byte against the pre-revert copy to confirm nothing
// else moved. The edits reverted for that recording were exactly:
//   - the `import * as capabilityMod from './capability.mjs'` line;
//   - `capability = null` added to `admits()`'s options, and the
//     `if (capability) {...} else if (project !== null...)` branch
//     collapsed back to the bare `if (project !== null...)` check;
//   - `capability = null` added to `search()`'s options;
//   - `capability` added to the id-lane `admits()` call and to the
//     `limits` object `search()`'s main loop builds;
//   - the paragraph on `exactHits()`'s doc comment naming
//     `limits.capability`.
// Re-running the corpus script against the CURRENT (repaired) file and
// diffing its output against the saved fixture is exactly test 1 below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as capabilityMod from '../src/capability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = new Date('2026-01-01T00:00:00Z');

/**
 * The exact corpus the baseline fixture was recorded from: one global
 * entry and one entry each in two projects, every field pinned (id, ts,
 * agent) so the recording is reproducible byte-for-byte regardless of
 * which host or day runs it.
 */
function buildCorpus() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p13-search-'));
  memory.logEntry(root, 'decision', {
    id: 'gid00000001', title: 'global marker entry', choice: 'global-marker-alpha-beta',
    why: 'shared root fact', topic: 'shared/topic', agent: 'tester',
  }, { project: null, now: FIXED_NOW });
  memory.logEntry(root, 'decision', {
    id: 'aid00000001', title: 'alpha project marker entry', choice: 'alpha-marker-alpha-beta',
    why: 'alpha reasons', topic: 'alpha/topic', agent: 'tester',
  }, { project: 'alpha', now: FIXED_NOW });
  memory.logEntry(root, 'decision', {
    id: 'bid00000001', title: 'beta project marker entry', choice: 'beta-marker-alpha-beta',
    why: 'beta reasons', topic: 'beta/topic', agent: 'tester',
  }, { project: 'beta', now: FIXED_NOW });
  return root;
}

function cleanup(root) { fs.rmSync(root, { recursive: true, force: true }); }

function runScenarios(index) {
  return {
    noOptions: search.search(index, 'marker', {}),
    top10: search.search(index, 'marker', { top: 10 }),
    withProjectAlpha: search.search(index, 'marker', { project: 'alpha', top: 10 }),
    withProjectGlobal: search.search(index, 'marker', { project: 'global', top: 10 }),
    withMmr: search.search(index, 'marker', { top: 10, mmr: true }),
    exactHitsAlpha: search.exactHits(index, 'alpha-marker-alpha-beta', 10, { project: 'alpha' }),
    exactHitsNoLimits: search.exactHits(index, 'beta-marker-alpha-beta', 10, {}),
  };
}

// =========================================================================
// 1. POSITIVE CONTROL — no capability, no behaviour change.
// =========================================================================

test('search()/exactHits(): no capability given is byte-identical to the pre-repair fixture', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);
    // Round-tripped through JSON, exactly as the fixture itself was
    // produced (`JSON.stringify(scenarios)` in the recording script — see
    // this file's header). Without the round trip, `exactHits()`'s
    // internal `__w` term-vector Map (a pre-existing wart, unrelated to
    // this change: `exactHits()` never strips it the way `search()`
    // does) compares a live Map against the `{}` JSON.stringify already
    // collapsed it to when the fixture was recorded — a false mismatch
    // about serialisation, not about scope.
    const actual = JSON.parse(JSON.stringify(runScenarios(index)));
    const fixturePath = path.join(HERE, 'fixtures', 'search-capability-baseline.json');
    const expected = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.deepEqual(actual, expected,
      'the no-capability path must return EXACTLY what the pre-repair code returned — '
      + 'see this file\'s header comment for how the fixture was recorded');
  } finally { cleanup(root); }
});

// =========================================================================
// 2/3. search(): a capability decides scope through the LATTICE.
// =========================================================================

test('search(): a capability scoped to one project excludes a foreign project\'s entry', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);
    const cap = capabilityMod.grantProject('alpha', { subject: 'tester' });
    const hits = search.search(index, 'marker', { top: 10, capability: cap });
    const bodies = JSON.stringify(hits);
    assert.ok(bodies.includes('alpha-marker-alpha-beta'), 'alpha capability lost its own project\'s entry');
    assert.ok(!bodies.includes('beta-marker-alpha-beta'),
      'a capability scoped to alpha reached beta\'s entry through search() itself');
  } finally { cleanup(root); }
});

test('search(): a capability admits global through the lattice, where bare project equality would not', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);

    // Contrast case first: the OLD mechanism (bare `project` string) does
    // NOT see the global entry when scoped to one project — `project:
    // 'alpha'` matches only `doc.project === 'alpha'`, and a global
    // entry's `doc.project` is `null`.
    const byEquality = search.search(index, 'marker', { top: 10, project: 'alpha' });
    assert.ok(!JSON.stringify(byEquality).includes('global-marker-alpha-beta'),
      'sanity check failed: bare project equality already saw the global entry, '
      + 'so this test would not show a real difference');

    // The lattice-aware path: the SAME project scope, through a
    // capability, DOES see the global entry — global is the root of the
    // lattice and every capability with read rights inherits it (see
    // `Capability.admits`'s own doc comment).
    const cap = capabilityMod.grantProject('alpha', { subject: 'tester' });
    const byCapability = search.search(index, 'marker', { top: 10, capability: cap });
    assert.ok(JSON.stringify(byCapability).includes('global-marker-alpha-beta'),
      'a project-scoped capability failed to see a global entry — the lattice property this change exists for');
  } finally { cleanup(root); }
});

// =========================================================================
// 4. exactHits(): the same two claims, through the OTHER call site.
// =========================================================================

test('exactHits(): a capability scoped to one project excludes a foreign project\'s entry', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);
    const cap = capabilityMod.grantProject('beta', { subject: 'tester' });
    // Ask by the ALPHA entry's own exact identifier, holding only a beta
    // capability.
    const hits = search.exactHits(index, 'alpha-marker-alpha-beta', 10, { capability: cap });
    assert.equal(hits.length, 0, 'a beta-only capability reached alpha\'s entry through exactHits()');
  } finally { cleanup(root); }
});

test('exactHits(): the same capability still finds its own project\'s exact entry (abort criterion)', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);
    const cap = capabilityMod.grantProject('beta', { subject: 'tester' });
    const hits = search.exactHits(index, 'beta-marker-alpha-beta', 10, { capability: cap });
    assert.equal(hits.length, 1, 'a legitimate query, with the capability that should admit it, was blocked');
    assert.equal(hits[0].entry.id, 'bid00000001');
  } finally { cleanup(root); }
});

// =========================================================================
// 6. Abort criterion, restated directly for search(): a legitimate query
// with the RIGHT capability must never be blocked. "A latch that reports
// the innocent gets switched off."
// =========================================================================

test('search(): a legitimate query with the right capability is not blocked', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);
    const cap = capabilityMod.grantProject('alpha', { subject: 'tester' });
    const hits = search.search(index, 'alpha project marker entry', { top: 10, capability: cap });
    assert.ok(hits.length > 0, 'a query for alpha\'s own entry, with an alpha capability, returned nothing');
    assert.ok(hits.some((h) => h.entry.id === 'aid00000001'),
      'alpha\'s own entry did not come back to alpha\'s own capability');
  } finally { cleanup(root); }
});

// =========================================================================
// 5. SABOTAGE — once per function, because both route through the same
// `admits()` and a probe that exercises only one cannot vouch for the
// other (see the brief this build point answers: "If removing it leaves
// everything green, the probe is measuring the other function.").
//
// `Capability.prototype.admits` is monkey-patched in place (reverted in
// a `finally`) rather than editing `search.mjs`'s source text: it is the
// one condition BOTH functions' capability branch relies on
// (`capability.admits(capabilityMod.scopeOf(...))`), so disabling it
// disables exactly what this change added, in whichever function is
// actually called — search() and exactHits() are each called from their
// own dedicated test below, which is what lets one implicate the other.
// =========================================================================

test('SABOTAGE search(): disabling Capability.admits flips the scoped probe red, then restores green', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);
    const cap = capabilityMod.grantProject('beta', { subject: 'tester' });

    const before = search.search(index, 'marker', { top: 10, capability: cap });
    assert.ok(!JSON.stringify(before).includes('alpha-marker-alpha-beta'),
      'sanity check failed: alpha should already be excluded before sabotage');

    const original = capabilityMod.Capability.prototype.admits;
    capabilityMod.Capability.prototype.admits = function alwaysAdmit() { return true; };
    let afterSabotage;
    try {
      afterSabotage = search.search(index, 'marker', { top: 10, capability: cap });
    } finally {
      capabilityMod.Capability.prototype.admits = original;
    }
    assert.ok(JSON.stringify(afterSabotage).includes('alpha-marker-alpha-beta'),
      'SABOTAGE DID NOT FLIP search() RED: disabling admits() should have let a beta-only '
      + 'capability see alpha through search() itself.');

    const restored = search.search(index, 'marker', { top: 10, capability: cap });
    assert.ok(!JSON.stringify(restored).includes('alpha-marker-alpha-beta'),
      'admits() was not fully restored after the sabotage block');
  } finally { cleanup(root); }
});

test('SABOTAGE exactHits(): disabling Capability.admits flips the scoped probe red, then restores green', () => {
  const root = buildCorpus();
  try {
    const index = search.buildIndex(root);
    const cap = capabilityMod.grantProject('beta', { subject: 'tester' });

    const before = search.exactHits(index, 'alpha-marker-alpha-beta', 10, { capability: cap });
    assert.equal(before.length, 0, 'sanity check failed: alpha should already be excluded before sabotage');

    const original = capabilityMod.Capability.prototype.admits;
    capabilityMod.Capability.prototype.admits = function alwaysAdmit() { return true; };
    let afterSabotage;
    try {
      afterSabotage = search.exactHits(index, 'alpha-marker-alpha-beta', 10, { capability: cap });
    } finally {
      capabilityMod.Capability.prototype.admits = original;
    }
    assert.equal(afterSabotage.length, 1,
      'SABOTAGE DID NOT FLIP exactHits() RED: disabling admits() should have let a beta-only '
      + 'capability see alpha through exactHits() itself — if this holds, exactHits() is not '
      + 'actually consulting the capability at all, and the earlier "excludes a foreign project" '
      + 'test for exactHits() is measuring search()\'s admits() call, not its own.');

    const restored = search.exactHits(index, 'alpha-marker-alpha-beta', 10, { capability: cap });
    assert.equal(restored.length, 0, 'admits() was not fully restored after the sabotage block');
  } finally { cleanup(root); }
});

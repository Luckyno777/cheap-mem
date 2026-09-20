// test/flood-grouping.test.mjs — does a key that always exists actually
// close the gap it was built for?
//
// Measured before this change (bench/atlas/phase-defence.mjs,
// `defence.flood.contested-flag`): a 50-strong flood was flagged as
// contested in 3 of 3 variants when the entries carried a `topic` field,
// and in 0 of 3 when they did not. `potentialConflicts` (src/retrieval.mjs)
// groups by `scope` + `topic`; an entry type that carries no topic — a
// learning, an error — was never grouped at all, flood or not.
//
// `memory.floodGroups` is the fix, kept in src/memory.mjs because this
// file has no access to src/retrieval.mjs: `topic` stays the key where it
// exists, and a normalised word-signature of the entry's own title+text,
// plus its scope, is the key where it does not. The guarantee below is
// stated at N=2 — with a distinct author per flood entry (the cheapest
// lever an attacker has), two entries sharing a signature are already
// enough to be flagged, because the group-size and author-count floors
// are 2, not some larger number tuned to make a demo look good.
//
// Every positive test here is paired with the negative it would be
// worthless without: a detector that flags everything passes every
// "catches the flood" test ever written, the same way one that flags
// nothing passes every "no false positive" test. See in particular the
// innocence probe — the one this feature does not ship without.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_SRC = path.join(HERE, '..', 'src', 'memory.mjs');

// --- a small, self-contained flood corpus, mirroring the three variants
// --- bench/atlas/phase-defence.mjs measures the ranking curve with ----

const SYNONYM_VERBS = ['runs in', 'is hosted in', 'operates in', 'lives in',
  'is located in', 'sits in'];

/**
 * One true entry plus `n` flood entries, all plain objects (no CLI, no
 * disk — `floodGroups` takes claim-like objects directly). Every flood
 * entry gets its own author name: rotating a name costs an attacker
 * nothing, so the detector has to work despite that, not because of a
 * shared author.
 */
function floodClaims(n, variant, { withTopic = false } = {}) {
  const claims = [{
    id: 'truth0001',
    title: 'production database location',
    text: 'the production database runs in Frankfurt on the eu-central cluster',
    author: 'ops',
    ...(withTopic ? { topic: 'production database location' } : {}),
  }];
  for (let i = 0; i < n; i += 1) {
    let text;
    if (variant === 'identical') {
      text = 'the production database runs in Singapore on the ap-southeast cluster';
    } else if (variant === 'one-word-varied') {
      text = `the production database runs in Singapore on the ap-southeast-${i} cluster`;
    } else if (variant === 'synonyms-swapped') {
      text = `the production database ${SYNONYM_VERBS[i % SYNONYM_VERBS.length]} `
        + 'Singapore on the ap-southeast cluster';
    } else {
      throw new Error(`unknown variant: ${variant}`);
    }
    claims.push({
      id: `flood${String(i).padStart(4, '0')}`,
      title: 'production database location',
      text,
      author: `flooder${i}`,
      ...(withTopic ? { topic: 'production database location' } : {}),
    });
  }
  return claims;
}

const VARIANTS = ['identical', 'one-word-varied', 'synonyms-swapped'];

// ======================================================================
// Positive control
// ======================================================================

test('positive control: the detector flags something at all', () => {
  const claims = floodClaims(5, 'identical', { withTopic: false });
  const groups = memory.floodGroups(claims, { scope: 'global' });
  assert.ok(groups.length > 0, 'a blatant 5-strong identical flood must produce at least one group');
  assert.ok(groups.some((g) => g.ids.includes('flood0000')));
});

// ======================================================================
// The guarantee: all three variants, WITHOUT a topic field, at N=2
// ======================================================================
//
// N=2 is the true floor, not a rounded-up demo number: the group-size
// and author-count minimums are both 2, so two flood entries by two
// different authors are already sufficient — there is no smaller flood
// than that.

for (const variant of VARIANTS) {
  test(`no-topic guarantee (${variant}): flagged at N=2, the smallest possible flood`, () => {
    const claims = floodClaims(2, variant, { withTopic: false });
    const groups = memory.floodGroups(claims, { scope: 'global' });
    assert.ok(groups.length > 0, `${variant} at N=2 must be flagged even with no topic field`);
    const flood = groups.find((g) => g.ids.every((id) => id.startsWith('flood')));
    assert.ok(flood, `the flagged group for ${variant} should be made of the flood entries, not the truth`);
    assert.equal(flood.matched, 2);
    assert.equal(flood.authors.length, 2);
  });

  test(`no-topic guarantee (${variant}): a lone claim is never a flood (N=1 stays unflagged)`, () => {
    const claims = floodClaims(1, variant, { withTopic: false });
    const groups = memory.floodGroups(claims, { scope: 'global' });
    assert.equal(groups.filter((g) => g.ids.some((id) => id.startsWith('flood'))).length, 0,
      'one flood entry has no second member to share a group with');
  });

  test(`no-topic guarantee (${variant}): still flagged at a larger N=8`, () => {
    const claims = floodClaims(8, variant, { withTopic: false });
    const groups = memory.floodGroups(claims, { scope: 'global' });
    const flood = groups.find((g) => g.ids.every((id) => id.startsWith('flood')));
    assert.ok(flood, `${variant} at N=8 must still be flagged`);
    assert.ok(flood.matched >= 2);
  });
}

// The topic-carrying path is unchanged from `potentialConflicts` and was
// already 3 of 3 before this change; kept here as a regression guard so
// a future edit to the fallback cannot quietly break the case that
// already worked.
for (const variant of VARIANTS) {
  test(`with-topic regression guard (${variant}): still flagged at N=8`, () => {
    const claims = floodClaims(8, variant, { withTopic: true });
    const groups = memory.floodGroups(claims, { scope: 'global' });
    assert.ok(groups.length > 0, `${variant} with a topic field must stay flagged`);
  });
}

// ======================================================================
// The innocence probe — the one this feature does not ship without
// ======================================================================

test('innocence probe: three genuinely independent entries, different '
  + 'authors, different times, must NOT be flagged', () => {
  const claims = [
    {
      id: 'ind1', author: 'priya', ts: '2026-01-12T09:00:00Z',
      title: 'on-call coverage',
      text: 'the on-call rotation moved to a follow-the-sun schedule across '
        + 'three regions after the outage retro',
    },
    {
      id: 'ind2', author: 'devon', ts: '2026-04-03T14:00:00Z',
      title: 'on-call coverage',
      text: 'hiring a fourth on-call region required updating the pager '
        + 'escalation policy and the vendor contract',
    },
    {
      id: 'ind3', author: 'mireille', ts: '2026-08-21T11:00:00Z',
      title: 'on-call coverage',
      text: 'the handoff checklist now links a runbook per service after '
        + 'last quarter confusion during an overnight handoff',
    },
  ];
  const groups = memory.floodGroups(claims, { scope: 'global' });
  assert.deepEqual(groups, [], 'three substantively different entries about '
    + 'one subject are not a flood, however many people wrote about it');
});

test('innocence probe (harder): the same subject revisited by ONE author '
  + 'over months — a correction, a supersession — must not read as a flood', () => {
  const claims = [
    {
      id: 'rev1', author: 'ops', ts: '2026-01-01T09:00:00Z',
      title: 'deploy target', text: 'the deploy target runs in the eu-west-1 cluster',
    },
    {
      id: 'rev2', author: 'ops', ts: '2026-03-01T09:00:00Z',
      title: 'deploy target',
      text: 'correction: the deploy target runs in the eu-west-2 cluster',
    },
    {
      id: 'rev3', author: 'ops', ts: '2026-06-01T09:00:00Z',
      title: 'deploy target',
      text: 'supersedes the prior note: the deploy target runs in the eu-central-1 cluster',
    },
  ];
  // These three are near-duplicates of each other by construction — a
  // correction usually IS a one-word change — which is exactly why this
  // probe matters: closeness alone would happily cluster them. What
  // must stop it is that all three are the same author's own record of
  // one subject changing over time, not several identities converging on
  // it at once.
  const groups = memory.floodGroups(claims, { scope: 'global' });
  assert.deepEqual(groups, [], 'one author correcting themselves is not a flood, '
    + 'no matter how similar the wording stays');
});

// ======================================================================
// The denominator
// ======================================================================

test('every flagged group states how many entries were grouped and out of how many', () => {
  const claims = floodClaims(5, 'one-word-varied', { withTopic: false });
  const groups = memory.floodGroups(claims, { scope: 'global' });
  assert.ok(groups.length > 0);
  for (const g of groups) {
    assert.equal(typeof g.matched, 'number');
    assert.equal(typeof g.of, 'number');
    assert.ok(g.matched >= 2, 'a reported group is never smaller than 2');
    assert.ok(g.matched <= g.of, 'a group can never be larger than the pool it was drawn from');
  }
  const flood = groups.find((g) => g.ids.every((id) => id.startsWith('flood')));
  assert.equal(flood.matched, 5, '5 flood entries grouped');
  assert.equal(flood.of, 6, 'out of 6 total claims in scope (5 flood + 1 truth)');
});

test('floodGroupKey always returns a non-empty key, topic or not', () => {
  assert.match(memory.floodGroupKey({ topic: 'auth/design', scope: 'global' }), /topic/);
  const fallback = memory.floodGroupKey({ title: 'x', text: 'the quick brown fox', scope: 'global' });
  assert.match(fallback, /shape/);
  assert.ok(fallback.length > 0);
  // Even an entry with no usable words at all still yields a real key —
  // "no words" and "no key" are different facts, and collapsing them
  // would silently reunite every contentless entry across every scope.
  const empty = memory.floodGroupKey({ title: '', text: '', scope: 'global' });
  assert.match(empty, /\(empty\)/);
});

// ======================================================================
// Sabotage: remove the fallback grouping by hand, confirm the no-topic
// variants go unflagged again, restore, confirm green.
// ======================================================================
//
// This never touches git — it writes a mutated SIBLING copy of
// src/memory.mjs into src/ (so its relative imports still resolve),
// imports that copy under its own module identity, and deletes it again
// in a `finally`. The real src/memory.mjs on disk is never written to.
//
// A test suite that stays green with the mechanism gone would be
// documentation, not a guarantee — this is the check that it is not.

test('sabotage: without the fallback grouping, no-topic variants go '
  + 'unflagged again; the original file is untouched', async () => {
  const original = fs.readFileSync(MEMORY_SRC, 'utf8');
  const marker = 'looClusters(noTopic)';
  assert.ok(original.includes(marker),
    'sabotage probe is stale: the fallback-clustering call it targets moved or was renamed');
  const sabotaged = original.replace(marker, '[] /* SABOTAGED BY TEST: fallback grouping removed by hand */');
  assert.notEqual(sabotaged, original);

  const tmpFile = path.join(HERE, '..', 'src', `memory.flood-sabotage-${process.pid}.mjs`);
  fs.writeFileSync(tmpFile, sabotaged);
  try {
    const mutated = await import(pathToFileURL(tmpFile).href);
    for (const variant of VARIANTS) {
      const claims = floodClaims(3, variant, { withTopic: false });
      const groups = mutated.floodGroups(claims, { scope: 'global' });
      assert.equal(groups.filter((g) => g.ids.some((id) => id.startsWith('flood'))).length, 0,
        `${variant} must go unflagged once the fallback grouping is removed by hand`);
    }
    // The topic-carrying path did not depend on the fallback and must
    // survive the sabotage untouched — otherwise this probe would be
    // testing "did I break the file", not "did I break the fallback".
    const withTopic = mutated.floodGroups(floodClaims(3, 'identical', { withTopic: true }), { scope: 'global' });
    assert.ok(withTopic.length > 0, 'the topic path must be unaffected by removing the fallback');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }

  // Restore: the file on disk was never modified, so "restore" is
  // confirming that fact, then re-running the real guarantee to prove
  // it is green again against the untouched module.
  assert.equal(fs.readFileSync(MEMORY_SRC, 'utf8'), original,
    'the real src/memory.mjs must be exactly as it was before the sabotage test ran');
  for (const variant of VARIANTS) {
    const claims = floodClaims(2, variant, { withTopic: false });
    const groups = memory.floodGroups(claims, { scope: 'global' });
    assert.ok(groups.length > 0, `${variant} must be flagged again against the real, unsabotaged module`);
  }
});

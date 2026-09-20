// The flood detector, on the path a real question takes.
//
// **Why this file exists separately from `test/flood-grouping.test.mjs`.**
// That file proves `memory.floodGroups` is correct. This one proves the
// live `retrieve()` answer actually carries its verdict — the difference
// between a capability and a capability with reach.
//
// When the detector was first wired in (2026-09-20) it reported one
// group of 8 out of 8 claims, keyed `shape:(empty)`, with the genuine
// user claim inside it. Two causes, both invisible to the unit tests:
//
//   1. A stored entry carries `title` and `text`. A claim from
//      `retrieve()` carries neither — both are already folded into
//      `body`. So every claim signed empty.
//   2. An empty signature was treated as a shape, so every contentless
//      entry unioned with every other. Grouping by what they do not
//      have.
//
// A detector that flags everything, the innocent claim included, is
// strictly worse than one that flags nothing: it is a latch that
// reports the innocent, and those get switched off. Hence the two
// innocence probes below, which are not optional extras here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { retrieve } from '../src/retrieval.mjs';
import * as memory from '../src/memory.mjs';
import { grantAll } from '../src/capability.mjs';

const MEM = path.join(import.meta.dirname, '..', 'bin', 'mem');

/** A fresh root, seeded, asked one question. */
function ask(seed, query = 'blue-green rollout') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-flood-live-'));
  try {
    execFileSync(process.execPath, [MEM, 'init'], { env: { ...process.env, CHEAP_MEM_ROOT: root } });
    seed(root);
    return retrieve(root, query, grantAll(), { top: 20 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const genuine = (root) => memory.logEntry(root, 'learning', {
  title: 'deploy uses blue-green',
  text: 'we switched to blue-green rollout last quarter',
  author: 'user',
});

test('a topic-less flood reaches the caller as `crowded`, and the old signal still misses it', () => {
  const r = ask((root) => {
    genuine(root);
    ['replaces', 'supersedes', 'overrides', 'cancels', 'revokes', 'voids', 'annuls']
      .forEach((v, i) => memory.logEntry(root, 'learning', {
        title: `deploy ${v} blue-green`,
        text: `deploy ${v} blue-green rollout entirely`,
        author: `bot${i}`,
      }));
  });

  // The measurement that motivated the whole build point: the
  // topic-based signal is blind here, and stays blind. This assertion
  // is not a wish — if a later change makes `contested` catch it, this
  // test should be reconsidered rather than quietly relaxed.
  assert.equal(r.contested.length, 0,
    'the topic-based signal was supposed to be blind to a flood without a topic');

  assert.equal(r.crowded.length, 1, `expected exactly one crowded group, got ${r.crowded.length}`);
  const [g] = r.crowded;
  assert.ok(g.authors.length >= 5, `a flood by seven bots reported only ${g.authors.length} authors`);
  assert.ok(g.key && !g.key.includes('(empty)'),
    `the group is keyed on the absence of content rather than on a shape: ${g.key}`);
  assert.ok(Number.isFinite(g.matched) && Number.isFinite(g.of),
    'a group without its own denominator is unreadable');
});

test('INNOCENCE: the genuine claim is not inside the group it was flooded with', () => {
  const r = ask((root) => {
    genuine(root);
    ['replaces', 'supersedes', 'overrides', 'cancels', 'revokes', 'voids', 'annuls']
      .forEach((v, i) => memory.logEntry(root, 'learning', {
        title: `deploy ${v} blue-green`,
        text: `deploy ${v} blue-green rollout entirely`,
        author: `bot${i}`,
      }));
  });
  const userClaim = r.claims.find((c) => c.author === 'user');
  assert.ok(userClaim, 'the genuine claim did not survive retrieval at all');
  for (const g of r.crowded) {
    assert.ok(!g.ids.includes(userClaim.id),
      `the owner's own claim was swept into the flood group (${g.matched} of ${g.of})`);
  }
});

test('INNOCENCE: genuinely different entries about one subject are not a flood', () => {
  const r = ask((root) => {
    genuine(root);
    memory.logEntry(root, 'decision', {
      title: 'rollout window moved',
      text: 'blue-green cutover now happens during the maintenance window on sunday',
      author: 'alice',
    });
    memory.logEntry(root, 'learning', {
      title: 'health check timing',
      text: 'the blue-green load balancer drains connections for ninety seconds before cutting over',
      author: 'bob',
    });
  });
  assert.ok(r.claims.length >= 3, 'the fixture did not come back');
  assert.deepEqual(r.crowded, [],
    'three people writing different things about one subject were reported as a flood');
});

test('INNOCENCE: contentless entries do not group on having no content', () => {
  const r = ask((root) => {
    for (let i = 0; i < 5; i += 1) {
      memory.logEntry(root, 'learning', { title: '---', text: '...', author: `bot${i}` });
    }
    memory.logEntry(root, 'learning', { title: 'blue-green rollout', text: 'we use blue-green', author: 'user' });
  });
  for (const g of r.crowded) {
    assert.ok(!String(g.key).includes('(empty)'),
      `entries were grouped by having no words: ${g.key} (${g.matched} of ${g.of})`);
  }
});

test('the detector reads a claim, not only a stored entry', () => {
  // The direct form of cause 1 above: hand `floodGroups` the shape
  // `retrieve()` actually produces. If it can only read `title`/`text`,
  // this signs empty and the guarantee is gone.
  const claims = ['replaces', 'supersedes', 'overrides'].map((v, i) => ({
    id: `c${i}`, author: `bot${i}`, scope: 'global', topic: null,
    body: `deploy ${v} blue-green — deploy ${v} blue-green rollout entirely`,
  }));
  const groups = memory.floodGroups(claims);
  assert.equal(groups.length, 1,
    'a claim carries its words in `body`; the detector did not look there');
  assert.ok(!groups[0].key.includes('(empty)'), groups[0].key);
});

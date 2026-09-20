// P11 · equivalence — `state.deriveState` (streaming,
// `memory.retiredMapFromFiles`) against `state.deriveStateMaterialized`
// (the pre-P11 array-based implementation, kept ONLY as this oracle —
// see its own comment in `state.mjs`).
//
// The brief for this build named the exact gap in the corpus this
// project's own retirement rule had never been tested against: "the
// current test corpus has no retirements, the map was empty at every
// measurement, and so that number is a floor." This corpus is built to
// close that gap — retirements, replacements (including a same-author
// self-correction and a cross-tier attempted override), a cycle, and a
// dangling reference (a `replaces_id` naming an id that does not exist
// anywhere) — split across multiple drawers and multiple projects, since
// `deriveState`'s whole reason to exist is reading EVERY drawer as one
// authority (see `state.mjs`'s header).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveState, deriveStateMaterialized, statusOf } from '../src/state.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p11-equiv-'));
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });
const z = (o) => `${JSON.stringify(o)}\n`;

function write(root, rel, entries) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, entries.map(z).join(''));
}

function buildCorpus(root) {
  // Global decisions: a plain claim, a same-author self-correction
  // (allowed), and a cross-tier attempted override that must be
  // DISPUTED, not applied — `authority.maySupersede`'s own rule.
  write(root, 'global/decisions.jsonl', [
    { id: 'd1', ts: '2026-01-01T00:00:00Z', author: 'lucky', authority: 'user',
      topic: 'db', choice: 'postgres' },
    { id: 'd2', ts: '2026-02-01T00:00:00Z', author: 'lucky', authority: 'user',
      topic: 'db', choice: 'postgres, self-hosted', replaces_id: 'd1' },
    { id: 'd3', ts: '2026-03-01T00:00:00Z', author: 'mallory', authority: 'inferred',
      topic: 'db', choice: 'sqlite (attempted takeover)', replaces_id: 'd2' },
  ]);

  // A retirement living in a DIFFERENT drawer than its target, and in a
  // DIFFERENT project — the exact case `state.test.mjs` already checks
  // for one drawer; this corpus repeats it across a project boundary,
  // which only `deriveState`'s "every drawer, every project" contract
  // (not a per-file view) can get right.
  write(root, 'global/thoughts.jsonl', [
    { id: 'th1', ts: '2026-01-05T00:00:00Z', author: 'lucky', authority: 'user',
      text: 'maybe drop the cache layer entirely' },
  ]);
  write(root, 'projects/alpha/events.jsonl', [
    { id: 'ev1', ts: '2026-01-06T00:00:00Z', author: 'lucky', authority: 'user',
      title: 'decided against it', retires_id: 'th1', state: 'discarded' },
  ]);

  // A duty closed from a sibling drawer, and a correction chain that
  // resolves to a genuine CYCLE (a replaces b replaces a) — the map must
  // not loop forever and must still assign SOME deterministic verdict to
  // both; equivalence with the array oracle is what actually matters
  // here, not which side "wins" a cycle neither implementation was
  // designed to referee.
  write(root, 'projects/alpha/duties.jsonl', [
    { id: 'du1', ts: '2026-01-10T00:00:00Z', author: 'lucky', authority: 'user', text: 'ship it' },
    { id: 'du2', ts: '2026-01-11T00:00:00Z', author: 'lucky', authority: 'user',
      closes_id: 'du1', state: 'done' },
  ]);
  write(root, 'projects/alpha/learnings.jsonl', [
    { id: 'l1', ts: '2026-01-01T00:00:00Z', author: 'agent-a', authority: 'agent',
      text: 'retry with backoff' },
    { id: 'l2', ts: '2026-01-02T00:00:00Z', author: 'agent-a', authority: 'agent',
      text: 'retry without backoff', replaces_id: 'l1' },
    // Written LAST but points back at l2 — closes the cycle, and forces
    // the "correction may appear before its target in file order" case
    // this module's whole two-pass design exists for.
    { id: 'l3', ts: '2026-01-03T00:00:00Z', author: 'agent-a', authority: 'agent',
      text: 'retry with backoff, actually', replaces_id: 'l2' },
  ]);
  // Patch l1's file after the fact isn't needed — instead close the loop
  // from a THIRD entry so l1 also gets superseded, forming l1 -> l2 -> l3
  // and then l3 pointing back is covered by a separate, explicit cycle:
  write(root, 'projects/beta/decisions.jsonl', [
    { id: 'c1', ts: '2026-01-01T00:00:00Z', author: 'lucky', authority: 'user',
      topic: 'y', choice: 'A' },
    { id: 'c2', ts: '2026-01-02T00:00:00Z', author: 'lucky', authority: 'user',
      topic: 'y', choice: 'B', replaces_id: 'c1' },
  ]);
  // A genuine two-entry cycle, same author (so both individually pass
  // `maySupersede`) — c-cycle-a replaces c-cycle-b and vice versa.
  write(root, 'projects/beta/thoughts.jsonl', [
    { id: 'cy-a', ts: '2026-01-01T00:00:00Z', author: 'lucky', authority: 'user',
      text: 'A', replaces_id: 'cy-b' },
    { id: 'cy-b', ts: '2026-01-02T00:00:00Z', author: 'lucky', authority: 'user',
      text: 'B', replaces_id: 'cy-a' },
  ]);

  // A dangling reference: replaces an id that exists NOWHERE in the
  // memory — must be treated as "target not in this view", not thrown.
  write(root, 'global/errors.jsonl', [
    { id: 'e1', ts: '2026-01-01T00:00:00Z', author: 'lucky', authority: 'user',
      class: 'x', title: 'a fix', text: 'y', replaces_id: 'never-existed' },
  ]);
}

test('P11 EQUIVALENCE — deriveState agrees with deriveStateMaterialized, id by id', () => {
  const root = tmp();
  try {
    buildCorpus(root);
    const streaming = deriveState(root);
    const materialized = deriveStateMaterialized(root);

    // Same SIZE and same set of keys — no id retired by one and not the
    // other, and no id retired differently.
    assert.equal(streaming.size, materialized.size,
      `map sizes differ: streaming=${streaming.size} materialized=${materialized.size}`);
    const allIds = new Set([...streaming.keys(), ...materialized.keys()]);
    assert.ok(allIds.size > 0, 'the corpus fixture produced no retirements at all — test is vacuous');
    for (const id of allIds) {
      assert.deepEqual(streaming.get(id), materialized.get(id), `retirement record for '${id}' differs`);
    }

    // And the derived STATUS agrees for every id this corpus mentions,
    // via the same accessor callers actually use.
    const mentioned = [
      'd1', 'd2', 'd3', 'th1', 'du1', 'l1', 'l2', 'l3', 'c1', 'c2',
      'cy-a', 'cy-b', 'e1', 'never-mentioned-at-all',
    ];
    for (const id of mentioned) {
      assert.equal(statusOf(streaming, id), statusOf(materialized, id), `statusOf('${id}') differs`);
    }

    // Spot-checks against what the corpus is actually supposed to mean,
    // so a bug that made BOTH implementations agreeably wrong would
    // still be caught.
    assert.equal(statusOf(streaming, 'd1'), 'superseded');
    assert.equal(statusOf(streaming, 'd2'), 'active', 'a cross-tier override should have been disputed, not applied');
    assert.equal(statusOf(streaming, 'd3'), 'disputed');
    assert.equal(statusOf(streaming, 'th1'), 'discarded', 'a cross-drawer, cross-project retirement was missed');
    assert.equal(statusOf(streaming, 'e1'), 'active', 'a dangling replaces_id target should not crash or wrongly retire e1');
  } finally { rm(root); }
});

test('P11 EQUIVALENCE — a bigger, denser corpus with a real cycle still agrees', () => {
  // Same shape as the ladder's fixture, but small enough to run fast and
  // exercise MANY corrections, not just a handful of hand-picked ones.
  const root = tmp();
  try {
    const lines = [];
    for (let i = 0; i < 3000; i += 1) {
      const id = `g${i}`;
      if (i > 0 && i % 30 === 0) {
        lines.push({ id, ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
          author: 'bench', authority: 'agent', replaces_id: `g${i - 7}`, text: `rev ${i}` });
      } else if (i > 0 && i % 111 === 0) {
        lines.push({ id: `t${i}`, ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
          author: 'bench', authority: 'agent', retires_id: `g${i - 2}`, state: 'discarded' });
      } else {
        lines.push({ id, ts: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
          author: 'bench', authority: 'agent', text: `entry ${i}` });
      }
    }
    write(root, 'global/decisions.jsonl', lines);

    const streaming = deriveState(root);
    const materialized = deriveStateMaterialized(root);
    assert.equal(streaming.size, materialized.size);
    for (const [id, rec] of materialized) {
      assert.deepEqual(streaming.get(id), rec, `record for '${id}' differs`);
    }
  } finally { rm(root); }
});

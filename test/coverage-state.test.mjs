// What may be concluded from what is MISSING.
//
// **The gap this closes.** The gateway returned `truncated: true|false`
// — two states for a three-state question. Measured on 2026-09-09:
// `retrieval.mjs` had 8 truncation sites, 17 limits, and zero
// occurrences of coverage, has_more or cursor. So an answer could be
// cut in four different ways and still look, to a caller, exactly like
// an answer that was not.
//
// The missing third state is the one that matters: *we could not
// establish what the search space was.* An empty answer from a caller
// with no capability had been reporting `truncated: false` — which
// reads as "we looked and there was nothing", when nothing was searched
// at all.
//
// The rule, in one line:
//
//     found evidence  ≠  complete evidence
//     no finding      ≠  proof of absence
//
// Deliberately not a number. A coverage score invites comparing 0.8
// against 0.9, and neither says WHICH limit bit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as retrieval from '../src/retrieval.mjs';
import * as capability from '../src/capability.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function memory(n = 1) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cov-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  for (let i = 0; i < n; i += 1) {
    spawnSync(process.execPath, [MEM, '--root', r, 'log', 'decision',
      '--topic', 'storage', '--choice', `sqlite variant ${i}`,
      '--why', 'small and local, no server'], { encoding: 'utf8' });
  }
  return r;
}
const cap = () => capability.grantAll('human:root');

test('POSITIVE: a plain answer reports complete', () => {
  // A probe where every state came back UNKNOWN would pass for the
  // wrong reason.
  const r = memory(1);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 5 });
    assert.equal(res.coverage.state, retrieval.COVERAGE.COMPLETE);
    assert.deepEqual(res.coverage.reasons, []);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('no capability is UNKNOWN, never complete', () => {
  // The case that used to answer `truncated: false`. Nothing was
  // searched; an empty answer claiming full coverage is the exact lie.
  const r = memory(1);
  try {
    const res = retrieval.retrieve(r, 'sqlite', null, { top: 5 });
    assert.equal(res.coverage.state, retrieval.COVERAGE.UNKNOWN);
    assert.match(res.coverage.reasons[0].why, /no capability/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a capability without read is UNKNOWN too', () => {
  const r = memory(1);
  try {
    const noRead = new capability.Capability({
      subject: 'human:root', scopes: ['global'], rights: ['write'] });
    const res = retrieval.retrieve(r, 'sqlite', noRead, { top: 5 });
    assert.equal(res.coverage.state, retrieval.COVERAGE.UNKNOWN);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a truncated QUERY is UNKNOWN, not partial', () => {
  // The whole question was not even asked. "We looked and found some"
  // would be a stronger claim than the run can support.
  const r = memory(1);
  try {
    const res = retrieval.retrieve(r, 'x'.repeat(3000), cap(), { top: 5 });
    assert.equal(res.coverage.state, retrieval.COVERAGE.UNKNOWN);
    assert.match(JSON.stringify(res.coverage.reasons), /query truncated/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('UNKNOWN beats PARTIAL — order matters', () => {
  // A run that could not establish its search space must never report a
  // mere partial. Checked on the decision function directly, because
  // producing both conditions at once through the CLI is fragile.
  const both = retrieval.coverageOf({ reasons: [
    { kind: 'partial', why: 'something was cut' },
    { kind: 'unknown', why: 'the space is unknown' },
  ] });
  assert.equal(both.state, retrieval.COVERAGE.UNKNOWN);
  assert.equal(both.reasons.length, 2, 'the partial reason was dropped');
});

test('a cut answer names the limit that bit', () => {
  // Not just "partial" — WHICH limit. A state without a reason is a
  // score with extra steps.
  const r = memory(30);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 2 });
    assert.equal(res.coverage.state, retrieval.COVERAGE.PARTIAL);
    assert.ok(res.coverage.reasons.length > 0);
    for (const why of res.coverage.reasons) assert.ok(why.why.length > 5);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('`truncated` is kept, because it answers a different question', () => {
  // `truncated`: was this answer cut. `coverage`: what may I conclude
  // from what is missing. Replacing one with the other would break
  // callers and answer the wrong question.
  const r = memory(1);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 5 });
    assert.equal(typeof res.truncated, 'boolean');
    assert.ok(res.coverage);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the CLI prints coverage even when the answer is EMPTY', () => {
  // An empty answer and a complete answer look identical on a terminal.
  // The difference between them is the difference between "we found
  // nothing" and "there is nothing".
  const r = memory(1);
  try {
    const out = spawnSync(process.execPath,
      [MEM, '--root', r, 'retrieve', 'a completely unrelated subject'],
      { encoding: 'utf8' }).stdout;
    assert.match(out, /No claims for/);
    assert.match(out, /Coverage: known_complete/);
    assert.match(out, /NOT proof that nothing else exists/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the CLI prints it when the answer is GOOD, too', () => {
  // Printing it only when something was cut would teach people that
  // silence means completeness — the exact reading this exists against.
  const r = memory(1);
  try {
    const out = spawnSync(process.execPath, [MEM, '--root', r, 'retrieve', 'sqlite'],
      { encoding: 'utf8' }).stdout;
    assert.match(out, /Coverage: known_complete/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('coverage is a state with reasons, never a number', () => {
  // The one thing explicitly not copied from the systems this came
  // from. 0.82 does not say why anything should be believed.
  const r = memory(3);
  try {
    const res = retrieval.retrieve(r, 'sqlite', cap(), { top: 1 });
    assert.equal(typeof res.coverage.state, 'string');
    assert.ok(Object.values(retrieval.COVERAGE).includes(res.coverage.state));
    assert.equal(typeof res.coverage.score, 'undefined');
    assert.equal(typeof res.coverage.confidence, 'undefined');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

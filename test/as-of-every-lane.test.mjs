// "What held THEN" must not depend on which door you walked through.
//
// **The finding.** `mem retrieve` had `--as-of` and filtered by
// `valid_from`/`valid_until`. `mem find` did not have the flag at all —
// so the same question, asked through the other door, came back with
// today's answer. A memory that can be time-travelled through one
// command and not the other does not have bi-temporal recall; it has a
// bi-temporal corner.
//
// **The second finding, which is worse.** `retrieval.validAt` treats an
// unparseable timestamp as "no bound" and returns true. Right for a
// library reading data it did not write — wrong for a flag a person just
// typed. Measured before this was fixed:
//
//     mem retrieve "test" --as-of gestern   ->   exit 0, every claim
//
// No warning, no empty result. Just the full present-day answer to a
// question about the past, in the shape of a correct answer. A tool that
// silently ignores the one flag that changes the meaning of the question
// is lying about what it did.
//
// **What these probes are aimed at.** Not the two lanes that were broken
// — the next one. `find` reaches its hits through THREE routes (ranked,
// `--literal`, and the time-expression router), plus an exact-match lane
// that is merged in FRONT of the ranked one. A filter that covers some of
// them is worse than none: you cannot tell by looking which answer you
// got. So the probes walk every route with the same data and demand the
// same verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');

/** Run the CLI. Returns {code, out} instead of throwing, so refusals are testable. */
function mem(root, ...argv) {
  try {
    return { code: 0, out: execFileSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Two decisions on ONE topic, each valid for its own stretch of world
// time, plus one entry with no bounds at all. The third is the control:
// an open-ended entry must survive every `--as-of`, otherwise a filter
// that simply drops everything would look like a working filter.
const THEN = '2026-03-01';   // only the first decision held
const NOW_ISH = '2026-08-01'; // only the second
const BEFORE_ALL = '2025-01-01';

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-asof-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  mem(r, 'log', 'decision', '--topic', 'payment', '--choice', 'prepay only',
    '--why', 'chargebacks', '--valid_from', '2026-01-01', '--valid_until', '2026-06-01');
  mem(r, 'log', 'decision', '--topic', 'payment', '--choice', 'card accepted',
    '--why', 'conversion', '--valid_from', '2026-06-01');
  mem(r, 'log', 'decision', '--topic', 'payment', '--choice', 'invoice on request',
    '--why', 'enterprise buyers ask for it');
  return r;
}

const holds = (text, what) => text.includes(what);

test('THE CASE: without --as-of, all three payment decisions are findable', () => {
  // Without this, every probe below could pass on an empty memory.
  const r = build();
  try {
    const { out } = mem(r, 'find', 'payment', '--top', '10');
    for (const w of ['prepay only', 'card accepted', 'invoice on request']) {
      assert.ok(holds(out, w), `'${w}' is not findable at all — the fixture is broken`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('RANKED LANE: --as-of picks the decision that held then', () => {
  const r = build();
  try {
    const then = mem(r, 'find', 'payment', '--as-of', THEN, '--top', '10').out;
    assert.ok(holds(then, 'prepay only'), `as of ${THEN} the prepay decision should hold`);
    assert.ok(!holds(then, 'card accepted'),
      `as of ${THEN} the card decision had not started yet, but it came back`);

    const later = mem(r, 'find', 'payment', '--as-of', NOW_ISH, '--top', '10').out;
    assert.ok(holds(later, 'card accepted'), `as of ${NOW_ISH} the card decision should hold`);
    assert.ok(!holds(later, 'prepay only'),
      `as of ${NOW_ISH} the prepay decision had expired, but it came back`);

    // The control: no bounds means it held at both moments.
    for (const [when, text] of [[THEN, then], [NOW_ISH, later]]) {
      assert.ok(holds(text, 'invoice on request'),
        `the unbounded decision vanished as of ${when} — the filter drops too much`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('LITERAL LANE: --literal --as-of means the same as --as-of', () => {
  // `--literal` is a different search, not a different policy. Before
  // 2026-09-08 this lane also ignored `--json` — same shape of bug, in
  // the same branch, which is why it gets its own probe rather than a
  // shared one.
  const r = build();
  try {
    const out = mem(r, 'find', 'prepay', '--literal', '--as-of', NOW_ISH).out;
    assert.ok(!holds(out, 'chargebacks'),
      `the literal lane returned an entry that had expired by ${NOW_ISH}`);
    // And it says WHY the list is short, rather than looking like an
    // empty memory.
    assert.match(out, /as of|not valid then/,
      'the literal lane filtered silently — a shorter list with no reason reads as "nothing there"');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('BOTH DOORS AGREE: find and retrieve exclude the same entry', () => {
  // The rule this file exists for. Not "both are right" — "both say the
  // same thing", which is the property that actually broke.
  const r = build();
  try {
    const f = JSON.parse(mem(r, 'find', 'payment', '--as-of', THEN, '--top', '10', '--json').out);
    const g = JSON.parse(mem(r, 'retrieve', 'payment', '--as-of', THEN, '--json').out);

    const vonFind = new Set(f.hits.map((h) => h.entry?.id).filter(Boolean));
    const vonRetrieve = new Set(g.claims.map((c) => c.id));
    assert.deepEqual([...vonFind].sort(), [...vonRetrieve].sort(),
      'find and retrieve disagree about what held then');

    // And both name the moment they filtered by, normalised the same way.
    assert.equal(f.asOf, g.asOf ?? f.asOf,
      'the two envelopes report different as-of values for the same flag');
    assert.ok(f.asOf, 'the find envelope does not say it filtered at all');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('BEFORE THE CUT: a valid entry is not displaced by an invalid one', () => {
  // A filter applied AFTER `--top` cannot bring back what the cut already
  // threw away. With `--top 1` and the expired decision ranking first,
  // filtering late would return nothing while an eligible entry existed.
  const r = build();
  try {
    const out = mem(r, 'find', 'payment', '--as-of', NOW_ISH, '--top', '1').out;
    assert.ok(holds(out, 'card accepted') || holds(out, 'invoice on request'),
      'with --top 1 the one valid hit was crowded out by an invalid one — '
      + 'the filter runs after the cut instead of before it');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('A DATE I CANNOT READ IS REFUSED, on both commands', () => {
  // The silent-no-op case. `validAt` returns true for an unparseable
  // stamp, so without a check at the boundary a typo turns a question
  // about the past into today's answer — and nothing says so.
  const r = build();
  try {
    for (const argv of [['find', 'payment', '--as-of', 'yesterday'],
      ['retrieve', 'payment', '--as-of', 'yesterday']]) {
      const { out } = mem(r, ...argv);
      assert.match(out, /not a date I can read/,
        `${argv[0]} accepted an unreadable --as-of instead of refusing it`);
      assert.ok(!holds(out, 'prepay only'),
        `${argv[0]} answered the query anyway, with an ignored --as-of`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NOTHING THEN is said differently from NOTHING AT ALL', () => {
  // Three states, not two: "no such entry" and "entries exist, none of
  // them held then" are different answers, and only one of them means
  // the memory is empty on this subject.
  const r = build();
  try {
    // **Query the BOUNDED entry only.** The first version of this probe
    // asked for 'payment' — and the unbounded control decision is valid
    // at every moment, so the result was never empty and the probe never
    // reached the branch it claims to test. Caught by sabotage: removing
    // the moment from the empty answer left it green.
    const nichtsDamals = mem(r, 'find', 'chargebacks', '--as-of', BEFORE_ALL, '--top', '10').out;
    assert.match(nichtsDamals, /^Nothing for/m,
      'the fixture no longer produces an empty result — this probe tests nothing');
    assert.ok(holds(nichtsDamals, BEFORE_ALL),
      'the empty answer does not name the moment it was empty at, so it reads '
      + 'like "this memory knows nothing about that" instead of "not then"');
    const garnichts = mem(r, 'find', 'quinoa-supplier', '--top', '10').out;
    assert.ok(!holds(garnichts, 'as of'),
      'a plain miss claims to have been filtered by a moment');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

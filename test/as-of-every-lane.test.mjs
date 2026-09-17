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

// --- valid_until AS ONE TRUTH WITH SUPERSESSION ----------------------------
//
// Everything above tests `valid_until` stated by hand on independent
// entries. None of it ever superseded anything, so none of it could have
// caught the actual trap: supersession (`replaces_id`) ALSO answers "when
// did this stop being true", and until `retrieval.validAt` learned about
// it, the two mechanisms disagreed whenever `--as-of` named a moment
// BEFORE a correction was written (measured 2026-09-17: the pre-correction
// claim came back empty for a moment at which it was the only truth there
// was — see `validAt`'s docstring in src/retrieval.mjs for the full
// account). These probes build that exact scenario — one entry superseded
// at a known cutover — and check it on every lane this file already
// covers, plus the time-window lane, which none of the probes above touch
// at all.
const CUTOVER = '2026-06-01';       // the successor's own valid_from
const BEFORE_CUTOVER = '2026-03-01'; // between the original's start and the cutover
const AFTER_CUTOVER = '2026-08-01';

// Logged with real `ts` (now), so the time-window lane's "last N hours"
// finds them by WRITE time, independent of the fictional `valid_from`
// dates above, which the window lane does not look at at all.
function buildSupersession() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-asof-super-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  mem(r, 'log', 'decision', '--topic', 'staffing', '--choice', 'use a contractor',
    '--why', 'fastest to start', '--valid_from', '2026-01-01');
  const found = JSON.parse(mem(r, 'find', 'staffing', '--json', '--top', '5').out);
  const oldId = found.hits[0].entry.id;
  mem(r, 'correction', 'decision', oldId, '--topic', 'staffing', '--choice', 'hire an employee',
    '--why', 'cheaper long term', '--valid_from', CUTOVER);
  return { r, oldId };
}

test('SUPERSESSION, RANKED LANE: the pre-correction claim still holds before the cutover it has not reached yet', () => {
  const { r } = buildSupersession();
  try {
    const before = mem(r, 'find', 'staffing', '--as-of', BEFORE_CUTOVER, '--top', '10').out;
    assert.ok(holds(before, 'use a contractor'),
      `as of ${BEFORE_CUTOVER} the original decision should still hold — it existed and the `
      + 'correction did not yet');
    assert.ok(!holds(before, 'hire an employee'),
      `as of ${BEFORE_CUTOVER} the correction had not started yet, but it came back`);

    const at = mem(r, 'find', 'staffing', '--as-of', CUTOVER, '--top', '10').out;
    assert.ok(holds(at, 'hire an employee'), 'at the cutover the correction should hold');
    assert.ok(!holds(at, 'use a contractor'),
      'a supersession-derived valid_until must be EXCLUSIVE, same as a stated one');

    const after = mem(r, 'find', 'staffing', '--as-of', AFTER_CUTOVER, '--top', '10').out;
    assert.ok(holds(after, 'hire an employee'));
    assert.ok(!holds(after, 'use a contractor'),
      'this direction already worked before this change (a time-blind status check gets it right by '
      + 'accident); kept here so all three moments are asserted on the same fixture');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SUPERSESSION, LITERAL LANE: --literal --as-of agrees with the ranked lane on the cutover', () => {
  const { r } = buildSupersession();
  try {
    const before = mem(r, 'find', 'contractor', '--literal', '--as-of', BEFORE_CUTOVER).out;
    assert.ok(holds(before, 'use a contractor'),
      'the literal lane dropped a claim that had not been superseded yet at this moment');

    const after = mem(r, 'find', 'contractor', '--literal', '--as-of', AFTER_CUTOVER).out;
    assert.ok(!holds(after, 'use a contractor'),
      'the literal lane kept a claim past the moment its successor took over');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SUPERSESSION, BOTH DOORS: find and retrieve agree before AND after the cutover', () => {
  const { r, oldId } = buildSupersession();
  try {
    const f = JSON.parse(mem(r, 'find', 'staffing', '--as-of', BEFORE_CUTOVER, '--top', '10', '--json').out);
    const g = JSON.parse(mem(r, 'retrieve', 'staffing', '--as-of', BEFORE_CUTOVER, '--json').out);
    const fIds = new Set(f.hits.map((h) => h.entry?.id).filter(Boolean));
    const gIds = new Set(g.claims.map((c) => c.id));
    assert.deepEqual([...fIds].sort(), [...gIds].sort(),
      'find and retrieve disagree about a claim that was superseded only in the future relative to --as-of');
    assert.ok(fIds.has(oldId), 'the pre-correction claim should be the one moment that holds');

    // The direction that actually exposes a missing `supersededAt` bound
    // on the gateway: without it, `retrieve()`'s own `!asOf` guard no
    // longer excludes the old claim (asOf IS set here), and `validAt`
    // would have nothing to bound it by, so it would wrongly survive
    // past the cutover too.
    const g2 = JSON.parse(mem(r, 'retrieve', 'staffing', '--as-of', AFTER_CUTOVER, '--json').out);
    const gIds2 = new Set(g2.claims.map((c) => c.id));
    assert.ok(!gIds2.has(oldId), 'retrieve() kept the old claim past the moment its successor took over');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SUPERSESSION, TIME-WINDOW LANE: "--as-of" on the window router honours supersession too', () => {
  // The window lane is reached by a query THAT IS ITSELF a time
  // expression ("last 1 hours") — see timeexpr.windowFor. It fetches
  // `withRetired: true` unconditionally (src/timesearch.mjs), so it never
  // had the candidate-stage bug the other two lanes had; it goes through
  // `retrieval.validAt` alone. This proves that fix travels here for
  // free, precisely because there is only the one function to fix.
  const { r } = buildSupersession();
  try {
    const before = mem(r, 'find', 'last 1 hours', '--as-of', BEFORE_CUTOVER, '--top', '10').out;
    assert.ok(holds(before, 'use a contractor'),
      `the time-window lane dropped a claim that had not been superseded yet as of ${BEFORE_CUTOVER}`);
    assert.ok(!holds(before, 'hire an employee'));

    const after = mem(r, 'find', 'last 1 hours', '--as-of', AFTER_CUTOVER, '--top', '10').out;
    assert.ok(!holds(after, 'use a contractor'),
      'the time-window lane kept a claim past the moment its successor took over');
    assert.ok(holds(after, 'hire an employee'));
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('mem log refuses an unreadable --valid_until instead of silently accepting it', () => {
  const r = build();
  try {
    const { out: msg, code } = mem(r, 'log', 'decision', '--topic', 'x', '--choice', 'y',
      '--valid_until', 'not-a-real-date');
    assert.notEqual(code, 0, 'a garbage --valid_until should refuse the write, not accept it');
    assert.match(msg, /not a date I can read/,
      'the refusal must say WHY, the same discipline --as-of already has');
    assert.ok(!holds(mem(r, 'find', 'x', '--literal').out, 'not-a-real-date'),
      'the bad value must not have been written at all');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SUPERSESSION SCOPE: --as-of opens the gate for a superseded claim, not for a discarded one', () => {
  // Requirement 5's other half: opening `withRetired` at the candidate
  // stage so a superseded claim can reach `validAt` must not ALSO leak
  // `done`/`discarded`/`obsolete`/`disputed` entries into an ordinary
  // `--as-of` query — those answer a different question than "when did
  // this stop being true", and `--as-of` was never asked to reach them.
  const r = build();
  try {
    const found = JSON.parse(mem(r, 'find', 'invoice', '--json', '--top', '5').out);
    const id = found.hits[0].entry.id;
    mem(r, 'discard', id, '--why', 'no longer relevant, unrelated to any date');

    const withAsOf = mem(r, 'find', 'invoice', '--as-of', NOW_ISH, '--top', '10').out;
    assert.ok(!holds(withAsOf, 'invoice on request'),
      '--as-of let a DISCARDED entry back into an ordinary query — it should stay governed by '
      + '--with-retired alone, exactly as before this file learned about valid_until');

    const withBoth = mem(r, 'find', 'invoice', '--as-of', NOW_ISH, '--with-retired', '--top', '10').out;
    assert.ok(holds(withBoth, 'invoice on request'),
      '--with-retired should still reveal it — that combination is unchanged by this file');
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

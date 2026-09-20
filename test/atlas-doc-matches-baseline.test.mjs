// `docs/benchmark-atlas.md` is prose about `bench/atlas-baseline.json`.
//
// **Why this file exists.** The doc explains what the run means, which a
// JSON cannot do; the JSON holds what was measured, which prose cannot
// be trusted to keep. That is two places holding one truth, and the
// usual outcome is that somebody re-runs the benchmark, commits a new
// baseline, and leaves the page quoting last month's numbers — with no
// sign anywhere that the two disagree. The page would still read as
// measured fact.
//
// So the numbers the page leans on are pinned here against the file they
// came from. Re-running the baseline is meant to break this test: that
// is the reminder to re-read the page, not an obstacle. The failure
// message names the figure, the page's value and the baseline's, so the
// fix is a one-line edit and not a re-derivation.
//
// Deliberately NOT everything on the page. Pinning every digit would
// make the test fail for a rounding difference in a sentence nobody
// reasons from, and a test that cries wolf gets deleted. What is pinned
// is what a reader would act on: the hard wall, the growth exponents,
// whether each model predicted its held-back rung, and the verdict
// counts.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', 'benchmark-atlas.md');
const BASELINE = path.join(ROOT, 'bench', 'atlas-baseline.json');

const doc = fs.readFileSync(DOC, 'utf8');
const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));

/** Every record of the run, by id. */
const records = new Map();
for (const phase of base.phases) for (const r of phase.records) records.set(r.id, r);

function recordOf(id) {
  const r = records.get(id);
  assert.ok(r, `the baseline has no record '${id}' — the page cites a check that no longer runs`);
  return r;
}

/**
 * Is `value` written somewhere in the page, in any of the spellings the
 * page legitimately uses?
 *
 * Thousands may be grouped with a normal space or a narrow one, and a
 * figure may be rounded to fewer decimals than the JSON carries. Both
 * are accepted; a different NUMBER is not.
 */
function pageStates(value, { decimals = null } = {}) {
  const forms = new Set();
  const add = (n) => {
    const plain = String(n);
    forms.add(plain);
    // 978395 -> "978 395" and "978 395" (narrow no-break space)
    const grouped = plain.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    forms.add(grouped);
    forms.add(grouped.replace(/ /g, ' '));
    forms.add(plain.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  };
  if (decimals === null) add(value);
  else {
    add(Number(value).toFixed(decimals));
    add(Math.round(value));
  }
  // **Boundary-aware, not `includes`.** The first cut of this matcher
  // asked `doc.includes(String(n))`, which reports that the page states
  // `26` because it contains `2638` — a matcher that says yes to almost
  // anything, wrapped around assertions that then prove nothing. A digit
  // may not sit directly against the number on either side, and neither
  // may a decimal point WITH a digit behind it — without that second
  // half, `548` still matches inside `548.7`, which is how this control
  // caught its own matcher. A percent sign or a unit may follow.
  for (const f of forms) {
    const re = new RegExp(`(?<![\\d.])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d]|\\.\\d)`);
    if (re.test(doc)) return true;
  }
  return false;
}

function pinned(label, value, opts) {
  assert.ok(pageStates(value, opts),
    `docs/benchmark-atlas.md does not state ${label} = ${value} `
    + '(the baseline was re-run; re-read the page and update it)');
}

// --- the probe can fail at all -----------------------------------------

test('CONTROL: the matcher would notice a wrong number', () => {
  // Without this, every assertion below could be passing because
  // `pageStates` returns true for anything.
  assert.equal(pageStates(1234567890123), false,
    'pageStates() claims the page states a number it cannot contain');
  assert.equal(pageStates(base.blindSpots.length), true,
    'pageStates() cannot find the blind-spot count, which the page definitely states');
  // The boundary half of the control: a number that occurs only INSIDE
  // another number must not count as stated. `548.7` is on the page as
  // the cache bytes per entry, so `548` and `8.7` are both substrings of
  // it and neither is a figure the page states.
  assert.ok(doc.includes('548.7'), 'the fixture for this control moved');
  assert.equal(pageStates(548), false, 'pageStates() matched a prefix of a longer number');
  assert.equal(pageStates(8.7), false, 'pageStates() matched a suffix of a longer number');
});

test('CONTROL: the baseline is a real run, not an empty shell', () => {
  const total = base.phases.reduce((n, p) => n + p.records.length, 0);
  assert.ok(total > 300, `only ${total} records in the baseline — that is not a full run`);
  assert.equal(base.phases.length, 7, 'the baseline does not carry all seven phases');
  assert.ok(base.blindSpots.length > 0,
    'a run with zero blind spots is a run that stopped naming them');
});

// --- the hard wall ------------------------------------------------------

test('the page states the entry count at which the index cache stops parsing', () => {
  const m = recordOf('ceiling.c.wall1.json-parse-limit').measured;
  pinned('the cache-parse limit in entries', m.entriesAtStringLimit);
  pinned('cache bytes per entry', m.cacheBytesPerEntry, { decimals: 1 });
  pinned("V8's maximum string length", m.maxStringLength);
});

test('the page states what reading one drawer costs', () => {
  const m = recordOf('ceiling.c.wall2.whole-file-read').measured;
  pinned('held MB per MB of drawer', m.heldMBPerDrawerMB, { decimals: 2 });
});

test('the page states what one invocation costs, separately from the drawer', () => {
  const m = recordOf('ceiling.c.process-rss').measured;
  pinned('empty-process RSS in MB', m.baseMB, { decimals: 0 });
  pinned('per-entry RSS in KB', m.slopeKBPerEntry, { decimals: 2 });
});

test('the page states the append rate and the git drawer size', () => {
  const w4 = recordOf('ceiling.c.wall4.append-contention').measured;
  pinned('mean append time', w4.meanAppendMs, { decimals: 1 });
  pinned('appends per second', w4.entriesPerSecond, { decimals: 2 });
  const w5 = recordOf('ceiling.c.wall5.git-transport').measured;
  pinned('the projected drawer size at 5M', Math.round(w5.projectedDrawerMBAt5M));
});

// --- the growth models and, more importantly, their counter-checks ------

const SERIES = ['find', 'doctor', 'context', 'indexBuild', 'indexBytes'];

test('every growth exponent on the page is the one the baseline fitted', () => {
  for (const s of SERIES) {
    const fit = recordOf(`ceiling.b.fit.${s}`);
    const b = /b=([\d.]+)/.exec(String(fit.actual));
    assert.ok(b, `ceiling.b.fit.${s} no longer reports an exponent`);
    pinned(`the ${s} exponent`, Number(b[1]), { decimals: 3 });
  }
});

test('every counter-check verdict on the page is the one the baseline reached', () => {
  // The single most load-bearing claim on the page: four of five models
  // do not predict a rung they did not see. If a re-run changes that —
  // in either direction — the page is telling a story the data stopped
  // supporting.
  const passing = SERIES.filter((s) => recordOf(`ceiling.b.counter-check.${s}`).verdict === 'pass');
  assert.deepEqual(passing, ['indexBytes'],
    `the page says only the index-size model predicts; the baseline says ${passing.join(', ') || 'none'} do`);
  assert.match(doc, /Four of the five models cannot predict one rung they did not see/,
    'the page no longer states the counter-check result it is built around');
});

// --- the verdict table --------------------------------------------------

test('the per-phase verdict table matches the baseline', () => {
  for (const phase of base.phases) {
    const c = {
      pass: 0, fail: 0, degraded: 0, 'not-measured': 0,
    };
    for (const r of phase.records) c[r.verdict] += 1;
    const row = new RegExp(`^\\| ${phase.id} — [^|]*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|`, 'm');
    const m = row.exec(doc);
    assert.ok(m, `the page has no table row for the '${phase.id}' phase`);
    const got = m.slice(1, 5).map((x) => Number(x.trim()));
    assert.deepEqual(got, [c.pass, c.fail, c.degraded, c['not-measured']],
      `the '${phase.id}' row on the page says ${got.join('/')}, the baseline says `
      + `${c.pass}/${c.fail}/${c.degraded}/${c['not-measured']}`);
  }
});

test('the page does not claim a clean run when the baseline is not one', () => {
  // A page that says "everything passes" over a baseline with failures
  // is worse than no page. This is the one direction that must never be
  // possible, whatever else drifts.
  const broken = base.counts.fail + base.counts.degraded;
  if (broken > 0) {
    assert.match(doc, /## What is confirmed broken/,
      `the baseline has ${broken} failing or degraded checks and the page has no section naming them`);
  }
  assert.match(doc, /\*\*not-measured\*\* \| could not be checked here — \*\*this is not a pass\*\*/,
    'the page stopped saying that not-measured is not a pass');
});

// The diff tool needs its own guards, for the reason it exists.
//
// It reports which shared assurances a house covers. If it stops
// finding markers — a renamed test directory, a changed marker syntax
// — it reports full coverage and nothing is wrong anywhere. That is
// precisely the silent no-op this whole family of instruments hunts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalogue, covered, finding, diff, readHouse, MARKER }
  from '../bench/invariants.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function house({ entries = [], markers = {} } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inv-'));
  fs.mkdirSync(path.join(r, 'shared'), { recursive: true });
  fs.mkdirSync(path.join(r, 'test'), { recursive: true });
  fs.writeFileSync(path.join(r, 'shared', 'invariants.jsonl'),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
  for (const [file, ids] of Object.entries(markers)) {
    fs.writeFileSync(path.join(r, 'test', file),
      `${ids.map((i) => `// invariant: ${i}`).join('\n')}\nimport x from 'y';\n`);
  }
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const INV = (id) => ({ id, art: 'invariant', titel: id, warum: 'x', pruefung: 'y' });

test('an invariant without a marker is uncovered', () => {
  const r = house({ entries: [INV('alpha-eins'), INV('beta-zwei')], markers: { 'one.test.mjs': ['alpha-eins'] } });
  try {
    const f = finding(readCatalogue(r), covered(r));
    assert.deepEqual(f.covered, ['alpha-eins']);
    assert.deepEqual(f.uncovered, ['beta-zwei']);
  } finally { away(r); }
});

test('a marker with no catalogue entry is reported, not counted as coverage', () => {
  // A typo in a marker otherwise looks exactly like coverage. That
  // would make the tool assert a guard that does not exist — worse
  // than reporting nothing at all.
  const r = house({ entries: [INV('alpha-eins')], markers: { 'one.test.mjs': ['alpha-eins', 'tippfehler-hier'] } });
  try {
    const f = finding(readCatalogue(r), covered(r));
    assert.deepEqual(f.covered, ['alpha-eins']);
    assert.deepEqual(f.unknownMarkers, ['tippfehler-hier']);
  } finally { away(r); }
});

test('discarded entries are not invariants and are never demanded', () => {
  // Negative knowledge records what was measured and deliberately NOT
  // built. Demanding a guard for it would push the next session to
  // build the very thing that was decided against.
  const r = house({
    entries: [INV('alpha-eins'), { id: 'nicht-gebaut-x', art: 'discarded', titel: 'n', zahl: '2 %', warum: 'x' }],
    markers: { 'one.test.mjs': ['alpha-eins'] },
  });
  try {
    const f = finding(readCatalogue(r), covered(r));
    assert.equal(f.invariants, 1);
    assert.equal(f.discarded, 1);
    assert.deepEqual(f.uncovered, [], 'a discarded entry was demanded as an invariant');
  } finally { away(r); }
});

test('the diff names a lesson one house does not know at all', () => {
  const a = house({ entries: [INV('xray-drei'), INV('yankee-vier')], markers: { 't.test.mjs': ['xray-drei', 'yankee-vier'] } });
  const b = house({ entries: [INV('xray-drei')], markers: { 't.test.mjs': ['xray-drei'] } });
  try {
    const d = diff(readHouse(a), readHouse(b));
    assert.deepEqual(d.catalogueOnlyHere, ['yankee-vier'], 'the missing lesson was not named');
    assert.deepEqual(d.coveredOnlyHere, ['yankee-vier']);
    assert.deepEqual(d.catalogueOnlyThere, []);
  } finally { away(a); away(b); }
});

test('the diff separates "knows but does not guard" from "does not know"', () => {
  // Two different repairs: write the guard, or learn the lesson first.
  const a = house({ entries: [INV('xray-drei')], markers: { 't.test.mjs': ['xray-drei'] } });
  const b = house({ entries: [INV('xray-drei')], markers: {} });
  try {
    const d = diff(readHouse(a), readHouse(b));
    assert.deepEqual(d.catalogueOnlyHere, [], 'both houses know the lesson');
    assert.deepEqual(d.coveredOnlyHere, ['xray-drei'], 'only one of them guards it');
  } finally { away(a); away(b); }
});

test('a missing catalogue is not a pass', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nocat-'));
  try {
    const c = readCatalogue(r);
    assert.equal(c.missing, true);
    assert.deepEqual(c.entries, []);
  } finally { away(r); }
});

test('broken catalogue lines are counted, not swallowed', () => {
  const r = house({ entries: [INV('alpha-eins')] });
  try {
    fs.appendFileSync(path.join(r, 'shared', 'invariants.jsonl'), '{not json\n');
    assert.equal(readCatalogue(r).broken, 1);
  } finally { away(r); }
});

test('both marker spellings are accepted', () => {
  // The houses comment in different languages. The id is the contract,
  // the word in front of it is not.
  assert.equal(MARKER.exec('// invariant: klon-marke-im-namen')?.[1], 'klon-marke-im-namen');
  assert.equal(MARKER.exec('// invariante: klon-marke-im-namen')?.[1], 'klon-marke-im-namen');
  assert.equal(MARKER.exec('// invariant klon-marke'), null, 'the colon is required');
});

test('POSITIVE: against this repository it actually finds markers', () => {
  // Without this, a renamed test directory or a changed marker syntax
  // would make every run report full coverage while checking nothing.
  const c = covered(REPO);
  assert.ok(c.size >= 5,
    `only ${c.size} markers found in this repository — the probe looks in the `
    + 'wrong place, or the marker syntax changed. Either way every coverage '
    + 'report after this is vacuous.');
  const f = finding(readCatalogue(REPO), c);
  assert.ok(f.invariants > 0, 'the catalogue of this repository carries no invariants');
});

test('a marker that ALMOST matches is reported, not dropped', () => {
  // A missing colon, a capital letter, a trailing word — the line does
  // not match and simply vanishes. The test then claims a coverage it
  // does not have, and the tool agrees. This is the failure mode the
  // whole catalogue exists to prevent, inside the tool that checks it.
  const r = house({ entries: [INV('alpha-eins')] });
  try {
    fs.writeFileSync(path.join(r, 'test', 'bad.test.mjs'),
      '// invariant alpha-eins\n// Invariant: Alpha-Eins\nimport x from "y";\n');
    const f = finding(readCatalogue(r), covered(r));
    assert.equal(f.malformedMarkers.length, 2,
      `both malformed lines must be named, got: ${JSON.stringify(f.malformedMarkers)}`);
    assert.match(f.malformedMarkers[0], /bad\.test\.mjs:1/);
    assert.deepEqual(f.covered, [], 'a malformed marker must not count as coverage');
  } finally { away(r); }
});

test('a correct marker is NOT reported as malformed', () => {
  // The counter-check. A near-marker probe that fires on good lines
  // gets ignored within a week, and then the real ones go unnoticed.
  const r = house({ entries: [INV('alpha-eins')], markers: { 'ok.test.mjs': ['alpha-eins'] } });
  try {
    const f = finding(readCatalogue(r), covered(r));
    assert.deepEqual(f.malformedMarkers, []);
    assert.deepEqual(f.covered, ['alpha-eins']);
  } finally { away(r); }
});

/**
 * Tests for the two-house mirror of doctor findings.
 *
 * Same risk as with invariants.test.mjs: the tool hunts an error class
 * ("a check that silently finds nothing") and must not fall into it
 * itself. If `finding(`/`befund(` changes in the source, the name set
 * has to fall to NOT MEASURABLE — not to 0, which would look like a
 * passed comparison.
 */

// invariant: leer-ist-kein-bestehen
// invariant: drei-zustaende-nie-zwei
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHouse, readMap, compare, mapsAgree, MAP_PLACES } from '../src/findingmirror.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'bench', 'finding-mirror.mjs');

const made = [];
after(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });

function tempRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-mirror-'));
  made.push(r);
  return r;
}

function house(root, { style = 'finding', names = [] } = {}) {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  const file = style === 'finding' ? 'doctor.mjs' : 'doktor.mjs';
  const call = style === 'finding' ? 'finding' : 'befund';
  const lines = names.map((n) => `  if (x) return ${call}('${n}', LEVEL.GOOD, 'x');`);
  fs.writeFileSync(path.join(root, 'src', file), `function checkX(x) {\n${lines.join('\n')}\n}\n`);
}

function writeMap(root, entries, place = MAP_PLACES[0]) {
  fs.mkdirSync(path.join(root, path.dirname(place)), { recursive: true });
  fs.writeFileSync(path.join(root, place),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout };
}

test('a house with no doctor source at all is not measurable, not empty', () => {
  const h = readHouse(tempRoot());
  assert.equal(h.missing, true);
  assert.equal(h.names.size, 0);
});

test('SABOTAGE: a source with zero matching calls is not measurable, not zero', () => {
  const r = tempRoot();
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src', 'doctor.mjs'), 'function checkX() { return report("x"); }\n');
  const h = readHouse(r);
  assert.equal(h.missing, false);
  assert.equal(h.empty, true, 'renaming the call must not look like a clean house');
});

test('the counter-check: a correctly named call is NOT reported as empty', () => {
  const r = tempRoot();
  house(r, { names: ['digest'] });
  assert.equal(readHouse(r).empty, false);
});

test('a curated pair that resolves on both sides counts for both', () => {
  const a = tempRoot(); const b = tempRoot();
  house(a, { style: 'finding', names: ['digest'] });
  house(b, { style: 'befund', names: ['fasser'] });
  writeMap(a, [{ id: 'fasser-digest', finding: 'digest', befund: 'fasser' }]);
  const g = compare(readHouse(a), readHouse(b), readMap(a));
  assert.deepEqual(g.both, ['fasser-digest']);
  assert.deepEqual(g.onlyHere, []);
  assert.deepEqual(g.onlyThere, []);
});

test('SABOTAGE: a mapping entry pointing at a renamed finding is flagged', () => {
  const a = tempRoot(); const b = tempRoot();
  house(a, { style: 'finding', names: ['digest-yield'] });
  house(b, { style: 'befund', names: ['fasser'] });
  writeMap(a, [{ id: 'fasser-digest', finding: 'digest', befund: 'fasser' }]);
  const g = compare(readHouse(a), readHouse(b), readMap(a));
  assert.equal(g.stale.length, 1);
  assert.deepEqual(g.both, [], 'a stale entry must never count as covered');
  assert.deepEqual(g.onlyHere, ['digest-yield'], 'the new name is unjudged now');
});

test('an entry explained as one-sided no longer counts as open', () => {
  const a = tempRoot(); const b = tempRoot();
  house(a, { style: 'finding', names: ['digest', 'rollback'] });
  house(b, { style: 'befund', names: ['fasser'] });
  writeMap(a, [
    { id: 'fasser-digest', finding: 'digest', befund: 'fasser' },
    { id: 'nur-rollback', finding: 'rollback', nur: 'finding', warum: 'no epoch mark over there' },
  ]);
  const g = compare(readHouse(a), readHouse(b), readMap(a));
  assert.deepEqual(g.onlyHere, []);
  assert.deepEqual(g.explainedHere.map((e) => e.name), ['rollback']);
});

test('POSITIVE CONTROL: a finding that is NOT explained stays open', () => {
  const a = tempRoot(); const b = tempRoot();
  house(a, { style: 'finding', names: ['digest', 'rollback', 'brandnew'] });
  house(b, { style: 'befund', names: ['fasser'] });
  writeMap(a, [
    { id: 'fasser-digest', finding: 'digest', befund: 'fasser' },
    { id: 'nur-rollback', finding: 'rollback', nur: 'finding', warum: 'x' },
  ]);
  const g = compare(readHouse(a), readHouse(b), readMap(a));
  assert.deepEqual(g.onlyHere, ['brandnew']);
});

test('the side is named by shape, so the same file reads the same from either house', () => {
  // The first version named the side by point of view rather than by
  // shape, and the same file read from the other house inverted every
  // entry. A point of view is not a fact.
  const a = tempRoot(); const b = tempRoot();
  house(a, { style: 'finding', names: ['digest', 'rollback'] });
  house(b, { style: 'befund', names: ['fasser'] });
  const entries = [
    { id: 'fasser-digest', finding: 'digest', befund: 'fasser' },
    { id: 'nur-rollback', finding: 'rollback', nur: 'finding', warum: 'x' },
  ];
  writeMap(a, entries);
  writeMap(b, entries, MAP_PLACES[1]);
  const fromA = compare(readHouse(a), readHouse(b), readMap(a));
  const fromB = compare(readHouse(b), readHouse(a), readMap(b));
  assert.deepEqual(fromA.explainedHere.map((e) => e.name), ['rollback']);
  assert.deepEqual(fromB.explainedThere.map((e) => e.name), ['rollback'],
    'read from the other side the very same entry must land on the very same house');
  assert.deepEqual(fromB.onlyHere, [], 'and must not turn into an open finding there');
});

test('a side marker naming no shape is incomplete, not silently accepted', () => {
  const a = tempRoot(); const b = tempRoot();
  house(a, { style: 'finding', names: ['digest', 'rollback'] });
  house(b, { style: 'befund', names: ['fasser'] });
  writeMap(a, [
    { id: 'fasser-digest', finding: 'digest', befund: 'fasser' },
    { id: 'old', finding: 'rollback', nur: 'hier', warum: 'old spelling' },
  ]);
  const g = compare(readHouse(a), readHouse(b), readMap(a));
  assert.equal(g.incomplete.length, 1);
  assert.deepEqual(g.onlyHere, ['rollback']);
});

test('two mapping copies that drift apart are a finding', () => {
  const a = tempRoot(); const b = tempRoot();
  writeMap(a, [{ id: 'x', finding: 'digest', befund: 'fasser' }]);
  writeMap(b, [{ id: 'x', finding: 'digest', befund: 'fasser', warum: 'suddenly different' }],
    MAP_PLACES[1]);
  assert.equal(mapsAgree(a, b).same, false);
});

test('POSITIVE CONTROL: the same copies in another order do not drift', () => {
  const a = tempRoot(); const b = tempRoot();
  const e1 = { id: 'x', finding: 'digest', befund: 'fasser' };
  const e2 = { id: 'y', finding: 'root', befund: 'wurzel' };
  writeMap(a, [e1, e2]);
  writeMap(b, [e2, e1], MAP_PLACES[1]);
  assert.equal(mapsAgree(a, b).same, true);
});

test('one side without a mapping file is not comparable, and that is not "same"', () => {
  const a = tempRoot(); const b = tempRoot();
  writeMap(a, [{ id: 'x', finding: 'digest', befund: 'fasser' }]);
  assert.equal(mapsAgree(a, b).same, null);
});

test('CLI: no doctor source at the given root exits 2, not 0', () => {
  assert.equal(run(['--root', tempRoot()]).status, 2);
});

test('CLI: a fully curated, agreeing pair of houses exits 0', () => {
  const a = tempRoot(); const b = tempRoot();
  house(a, { style: 'finding', names: ['digest'] });
  house(b, { style: 'befund', names: ['fasser'] });
  const entries = [{ id: 'fasser-digest', finding: 'digest', befund: 'fasser' }];
  writeMap(a, entries);
  writeMap(b, entries, MAP_PLACES[1]);
  const r = run(['--root', a, '--against', b]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /Every finding of both houses is judged/);
});

test('POSITIVE: against this repository, readHouse actually finds names', () => {
  const h = readHouse(REPO);
  assert.equal(h.missing, false);
  assert.ok(h.names.size >= 20, `only ${h.names.size} findings found — has the call name changed?`);
});

// --- Part 2 of #154: this probe used to read a SIBLING REPOSITORY on
// the same disk, at a path that is neither repo (`../lucky-mem`), which
// made its result a property of the machine it ran on, not of the code.
//
// Proven by sabotage on 2026-09-20: moving the sibling out of the way
// and running this file still printed "ok" for the old test below, in
// well under a millisecond — it never even opened the process it was
// meant to run. On a CI runner that checks out only this one repo (the
// normal case), that early `return` fires on every single run. A test
// silently green through every real divergence it exists to catch is
// worse than no test — the file header names exactly this trap, and
// this was it.
//
// Fix (option 1 of the two named in #154): check the neighbour's
// finding names against a COMMITTED SNAPSHOT instead of only the live
// clone. That makes the comparison reproducible on any machine, CI
// included — a name gained or lost over there shows up as a diff to
// this snapshot that a human approves when refreshing it deliberately,
// never as a probe that quietly never ran.
//
// Snapshot captured 2026-09-20 from lucky-mem/src/doktor.mjs via this
// file's own `readHouse()` (54 `befund(...)` names — includes
// `auftragslage`, the finding that triggered this issue). To refresh
// after a real change on the lucky-mem side, with the sibling checked
// out at `../lucky-mem`, run from this repo's root:
//
//   node -e "import('./src/findingmirror.mjs').then(({readHouse}) => \
//     console.log(JSON.stringify([...readHouse('../lucky-mem').names].sort(), null, 2)))"
//
// and replace the `names` array below with the result, as its own
// reviewed change — never silently.
const LUCKY_MEM_SNAPSHOT = Object.freeze({
  capturedAt: '2026-09-26',
  source: 'lucky-mem/src/doktor.mjs',
  names: Object.freeze([
    'abrufquote', 'altlast', 'anhang', 'ansicht', 'archiv-haltbar',
    'archiv-heil', 'archiv-rueckstau', 'auffindbar', 'auftragslage',
    'auto-pflichten-alter', 'bauweise', 'befund-gleichstand', 'bestand',
    'briefkasten', 'bruecke', 'dubletten', 'eintragsform',
    'erledigt-ohne-beleg', 'faecher', 'faecher-jsonl', 'fakt-konflikte',
    'fang-doppelt', 'fasser', 'fasser-ausbeute', 'fasser-timer',
    'frageworte', 'git', 'git-hook', 'hook-doppelt', 'hook-kopie', 'index',
    'klingel', 'modell-start', 'nachher-haken', 'nachweis-luecke',
    'offene-funde', 'plattenplatz', 'post-liegt', 'post-stau', 'redaktion',
    'regel-vorschlag', 'rohfang', 'rueckstand', 'startlast', 'stop-hook',
    'tagform', 'themen-guete', 'transkript-schema', 'waechter',
    'waechter-fassung', 'waisen', 'wiederholung', 'wirksamkeit', 'wurzel',
    'zeilenzugriff', 'zustellnachweis', 'zustellschuld', 'zustellung',
  ]),
});

test('the real pair holds against a committed snapshot: every finding of '
  + 'both houses is judged (reproducible with no sibling on disk)', () => {
  // The actual latch, made independent of the machine. If this goes
  // red, one of the two houses has gained or lost a finding nobody has
  // looked at — provably, because it runs the same way everywhere.
  const here = readHouse(REPO);
  const there = {
    root: `<committed snapshot, captured ${LUCKY_MEM_SNAPSHOT.capturedAt}>`,
    style: 'befund',
    source: LUCKY_MEM_SNAPSHOT.source,
    names: new Set(LUCKY_MEM_SNAPSHOT.names),
    missing: false,
    empty: false,
  };
  const map = readMap(REPO);
  const g = compare(here, there, map);
  const open = { onlyHere: g.onlyHere, onlyThere: g.onlyThere, stale: g.stale,
    incomplete: g.incomplete, ambiguous: g.ambiguous };
  const openCount = g.onlyHere.length + g.onlyThere.length + g.stale.length
    + g.incomplete.length + g.ambiguous.length;
  assert.equal(openCount, 0, JSON.stringify(open, null, 2));
});

test('freshness: the committed snapshot matches the live neighbour, '
  + 'when one is actually on disk', (t) => {
  // This is the ONLY place a live sibling is still read, and only as a
  // bonus check for whoever happens to have it checked out — it is
  // never the thing that makes the guarantee above pass or fail.
  //
  // Absent sibling: explicitly SKIPPED, not silently "ok". "Not
  // measurable" must look different from "measured and fine" in the
  // test output, the same rule the doctor findings themselves follow.
  const sibling = path.join(REPO, '..', 'lucky-mem');
  if (!fs.existsSync(path.join(sibling, 'src', 'doktor.mjs'))) {
    t.skip('no sibling checked out at ../lucky-mem — snapshot freshness is '
      + 'NOT MEASURABLE here, not confirmed fresh. The committed-snapshot '
      + 'test above still ran for real and is unaffected.');
    return;
  }
  const live = readHouse(sibling);
  assert.deepEqual([...live.names].sort(), [...LUCKY_MEM_SNAPSHOT.names].sort(),
    'the live neighbour has drifted from the committed snapshot — refresh '
    + 'LUCKY_MEM_SNAPSHOT in this file deliberately (see the comment above '
    + 'it) and re-run');
});

// --- Latch: warum/why parity in the real mapping file ---------------------
//
// Decision on 2026-09-26: every line now carries an English `why` next
// to the German `warum` — the same reasoning, translated. Two traps
// this latch hunts: a line gets a new `warum` on its next edit but
// nobody adds `why`; or the translation quietly changes a number (a
// date, a percentage, milliseconds), and the two language versions end
// up claiming different things without anyone noticing.

function readRealMap() {
  const text = fs.readFileSync(path.join(REPO, MAP_PLACES[0]), 'utf8');
  return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function numberMultiset(text) {
  return (text.match(/\d+/g) || []).slice().sort();
}

/** The same check the two probes below run against the real file — as
 *  a function, so the positive controls can run it against a fixture
 *  instead of duplicating the check. */
function checkWhy(entry) {
  const problems = [];
  const id = entry.id ?? '(no id)';
  if (typeof entry.warum !== 'string' || entry.warum.trim() === '') {
    problems.push(`${id}: warum is missing or empty`);
  }
  if (typeof entry.why !== 'string' || entry.why.trim() === '') {
    problems.push(`${id}: why is missing or empty`);
  }
  if (typeof entry.warum === 'string' && typeof entry.why === 'string') {
    const de = numberMultiset(entry.warum);
    const en = numberMultiset(entry.why);
    if (JSON.stringify(de) !== JSON.stringify(en)) {
      problems.push(`${id}: numbers in warum (${de}) and why (${en}) differ`);
    }
  }
  return problems;
}

test('every line of the real mapping file has a non-empty warum AND a non-empty why', () => {
  const lines = readRealMap();
  assert.ok(lines.length >= 50, `only ${lines.length} lines found — wrong place, or parsed wrong?`);
  for (const l of lines) {
    assert.ok(typeof l.warum === 'string' && l.warum.trim() !== '', `${l.id}: warum is missing or empty`);
    assert.ok(typeof l.why === 'string' && l.why.trim() !== '', `${l.id}: why is missing or empty`);
  }
});

test('in every line of the real mapping file the numbers in warum and why are the same multiset', () => {
  const lines = readRealMap();
  for (const l of lines) {
    assert.deepEqual(numberMultiset(l.warum), numberMultiset(l.why),
      `${l.id}: numbers in warum (${numberMultiset(l.warum)}) and why (${numberMultiset(l.why)}) differ`);
  }
});

test('POSITIVE CONTROL: a fixture line without why is flagged', () => {
  // Not checked against the real file — that one is supposed to be clean.
  const bad = { id: 'fixture-no-why', warum: 'ein Text mit Substanz' };
  const problems = checkWhy(bad);
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => /why/.test(p)));
});

test('POSITIVE CONTROL: a fixture line with a diverging number in why is flagged', () => {
  const bad = { id: 'fixture-number', warum: 'gebaut am 2026-09-19', why: 'built on 2026-09-20' };
  const problems = checkWhy(bad);
  assert.ok(problems.length > 0);
  assert.ok(problems.some((p) => /numbers/.test(p)));
});

test('the counter-check: a complete fixture line with matching numbers is NOT flagged', () => {
  // Without this, checkWhy could report "broken" even when everything
  // is actually fine, and the two probes above would pass for the
  // wrong reason.
  const good = { id: 'fixture-ok', warum: 'gebaut am 2026-09-19', why: 'built on 2026-09-19' };
  assert.deepEqual(checkWhy(good), []);
});

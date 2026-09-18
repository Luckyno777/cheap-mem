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

test('the real pair holds: every finding of both houses is judged', () => {
  // The actual latch. If this goes red, one of the two houses has
  // gained or lost a finding nobody has looked at.
  const sibling = path.join(REPO, '..', 'lucky-mem');
  if (!fs.existsSync(path.join(sibling, 'src', 'doktor.mjs'))) return;  // not cloned
  const r = run(['--root', REPO, '--against', sibling]);
  assert.equal(r.status, 0, r.stdout);
});

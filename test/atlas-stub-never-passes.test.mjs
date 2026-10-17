// test/atlas-stub-never-passes.test.mjs — a phase that is only named is never counted as passed.
//
// An atlas phase can hold an id agreed with the sister house before it measures
// anything (bench/atlas/stub.mjs). The quiet way for that to go wrong is a stub
// that records `pass`: the atlas would show a green phase for something nobody
// looked at, and the next reader would take the count at its word. This test
// pins the other outcome:
//
//   1. a stub, written the way bench/atlas/stub.mjs writes it, records zero `pass`
//      rows, one `<id>.not-built` row with the verdict `not-measured`, and a blind
//      spot naming it;
//   2. every phase FILE that imports stub.mjs (none since atlas-neue-phasen-cm
//      built `dashboard`, `cost`, `digest` and `net-tempo`; the loop is kept for
//      the next agreed id) passes the same check, and is named in `cmStubs` of the
//      parity list;
//   3. a run of stubs alone ends with exit code 3 ("nothing failed, but something
//      could not be measured"), never 0 (`exitCodeOf` in bench/atlas/core.mjs, the
//      function the runner ends with);
//   4. positive control: a stub written the wrong way (`pass`) is caught by the
//      same check that clears the real ones, so the check sees anything at all.
//
// Red proof: the mutants "stub: a stub counts as passed", "no blind spot" and
// "exit 0 instead of 3" in bench/mutation.mjs turn 1 and 3 red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Atlas, VERDICT, exitCodeOf } from '../bench/atlas/core.mjs';
import { runStub } from '../bench/atlas/stub.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(REPO, 'bench', 'atlas');

/** The ids whose phase file imports ./stub.mjs. */
function stubIds() {
  return fs.readdirSync(DIR).filter((f) => /^phase-.*\.mjs$/.test(f))
    .filter((f) => /from '\.\/stub\.mjs'/.test(fs.readFileSync(path.join(DIR, f), 'utf8')))
    .map((f) => f.slice(6, -4)).sort();
}

/** What is wrong with the way an atlas recorded a stub phase; an empty array is the honest outcome. */
export function stubProblems(atlas, id) {
  const problems = [];
  const phase = atlas.phases.find((p) => p.id === id);
  if (!phase) return [`no phase "${id}" was recorded`];
  const passes = phase.records.filter((r) => r.verdict === VERDICT.PASS);
  if (passes.length) problems.push(`${passes.length} record(s) of the stub "${id}" read pass: ${passes.map((r) => r.id).join(', ')}`);
  const notBuilt = phase.records.find((r) => r.id === `${id}.not-built`);
  if (!notBuilt) problems.push(`the stub "${id}" has no ${id}.not-built record`);
  else if (notBuilt.verdict !== VERDICT.NOT_MEASURED) problems.push(`${id}.not-built reads ${notBuilt.verdict}, not not-measured`);
  if (!atlas.blindSpots.some((b) => b.what.includes(`"${id}"`))) problems.push(`no blind spot names the stub "${id}"`);
  return problems;
}

const PARITY = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'atlas-phase-parity.json'), 'utf8'));
const STUB = { id: 'sample-stub', title: 'a stub made for the test', owes: 'Made for the test; no measurement is promised.' };

test('the phase files that import stub.mjs are exactly the cmStubs of the parity list, and each is a row of the atlas', () => {
  assert.deepEqual(stubIds(), PARITY.cmStubs.map((e) => e.id).sort());
  const table = fs.readFileSync(path.join(REPO, 'bench', 'atlas.mjs'), 'utf8');
  for (const id of stubIds()) assert.ok(table.includes(`['${id}', './atlas/phase-${id}.mjs'`), `${id} has no row in bench/atlas.mjs`);
});

test('a stub writes one not-measured row and a blind spot, and never a pass', () => {
  const atlas = new Atlas({ label: 'test' });
  runStub(atlas, STUB);
  assert.deepEqual(stubProblems(atlas, STUB.id), []);
  const c = atlas.counts();
  assert.equal(c.pass, 0, JSON.stringify(c));
  assert.equal(c['not-measured'], 1);
  assert.equal(atlas.blindSpots.length, 1);
});

test('each stub phase file in the tree does the same (none today)', async () => {
  for (const id of stubIds()) {
    const atlas = new Atlas({ label: 'test' });
    const m = await import(pathToFileURL(path.join(DIR, `phase-${id}.mjs`)).href);
    await m.run(atlas, { quick: true });
    assert.deepEqual(stubProblems(atlas, id), [], id);
    assert.equal(atlas.counts().pass, 0, id);
  }
});

test('a run of stubs alone ends with exit code 3, never 0; a failure ends it with 1', () => {
  const atlas = new Atlas({ label: 'test' });
  runStub(atlas, STUB);
  runStub(atlas, { ...STUB, id: 'second-stub' });
  assert.equal(exitCodeOf(atlas.counts()), 3);
  assert.equal(exitCodeOf({ pass: 5, fail: 0, degraded: 0, 'not-measured': 0 }), 0, 'positive control: a clean run is 0');
  assert.equal(exitCodeOf({ pass: 5, fail: 1, degraded: 0, 'not-measured': 2 }), 1);
  assert.equal(exitCodeOf({ pass: 5, fail: 0, degraded: 1, 'not-measured': 0 }), 1);
  assert.equal(exitCodeOf({ pass: 0, fail: 0, degraded: 0, 'not-measured': 0 }), 3, 'a run in which no record ran looked at nothing: not 0');
});

test('positive control: a stub that counts as passed is caught by the same check', () => {
  const atlas = new Atlas({ label: 'control' });
  atlas.phase('dashboard', 'a wrongly written stub');
  atlas.record({ id: 'dashboard.not-built', title: 'phase dashboard is built', verdict: VERDICT.PASS, expected: 'x', actual: 'y' });
  atlas.blind('phase "dashboard" (a wrongly written stub)', 'whatever');
  const problems = stubProblems(atlas, 'dashboard');
  assert.ok(problems.some((p) => p.includes('read pass')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('not pass') || p.includes('not not-measured')), problems.join('\n'));
  // And a stub that was never recorded, or has no blind spot, is not clean either.
  assert.ok(stubProblems(new Atlas({ label: 'empty' }), 'dashboard').length > 0);
  const quiet = new Atlas({ label: 'quiet' });
  quiet.phase('dashboard', 't');
  quiet.record({ id: 'dashboard.not-built', title: 't', verdict: VERDICT.NOT_MEASURED });
  assert.ok(stubProblems(quiet, 'dashboard').some((p) => p.includes('blind spot')));
});

test('an unknown phase id is refused with the list of valid ids and exit 2, before anything runs', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(REPO, 'bench', 'atlas.mjs'), ...args], { cwd: REPO, encoding: 'utf8', timeout: 120000 });
  const r = run('--quick', '--phase', 'tippfehler');
  assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /unknown phase: tippfehler/);
  assert.match(r.stderr, /valid phases: .*\bsurface\b.*\bdashboard\b.*\bnet-tempo\b/);
  assert.ok(!/atlas quick:/.test(r.stdout), 'nothing was run');
  // one valid and one unknown id: still refused (a typo next to a good id must not run the good one alone)
  const mixed = run('--quick', '--phase', 'digest,tippfehler');
  assert.equal(mixed.status, 2);
  assert.match(mixed.stderr, /unknown phase: tippfehler/);
  assert.ok(!/phase digest/.test(mixed.stderr), 'the good id did not run either');
  // positive control: a valid id is not refused (it runs, and ends with 0, 1 or 3 - never the refusal's 2)
  const ok = run('--quick', '--phase', 'digest');
  assert.notEqual(ok.status, 2, ok.stderr);
  assert.match(ok.stderr, /atlas: phase digest \.\.\./);
});

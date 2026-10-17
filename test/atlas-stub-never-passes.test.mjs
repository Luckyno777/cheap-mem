// test/atlas-stub-never-passes.test.mjs — a phase that is only named is never counted as passed.
//
// Four atlas phases (dashboard, cost, digest, net-tempo) hold an id agreed with
// the sister house and measure nothing yet (bench/atlas/stub.mjs). The quiet
// way for that to go wrong is a stub that records `pass`: the atlas would show
// a green phase for something nobody looked at, and the next reader would take
// the count at its word. This test pins the other outcome, three ways:
//
//   1. each stub phase, run on its own, writes no `pass` record, a `not-built`
//      record with the verdict `not-measured`, and a blind spot naming it;
//   2. the real runner (`node bench/atlas.mjs --phase <the stubs>`) ends with
//      exit code 3 ("nothing failed, but something could not be measured") and
//      counts zero passes -- not 0, which would read as green;
//   3. positive control: a stub written the wrong way (`pass`) is caught by the
//      same check that clears the real ones, so the check sees anything at all.
//
// Red proof: the mutant "stub: a stub counts as passed" in bench/mutation.mjs
// turns 1 and 2 red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';

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

test('there are exactly four stubs, and each is a row of the atlas', () => {
  assert.deepEqual(stubIds(), ['cost', 'dashboard', 'digest', 'net-tempo']);
  const table = fs.readFileSync(path.join(REPO, 'bench', 'atlas.mjs'), 'utf8');
  for (const id of stubIds()) assert.ok(table.includes(`['${id}', './atlas/phase-${id}.mjs'`), `${id} has no row in bench/atlas.mjs`);
});

test('each stub phase records one not-measured row and a blind spot, and never a pass', async () => {
  for (const id of stubIds()) {
    const atlas = new Atlas({ label: 'test' });
    const m = await import(pathToFileURL(path.join(DIR, `phase-${id}.mjs`)).href);
    await m.run(atlas, { quick: true });
    assert.deepEqual(stubProblems(atlas, id), [], id);
    const c = atlas.counts();
    assert.equal(c.pass, 0, `${id}: counts ${JSON.stringify(c)}`);
    assert.ok(c['not-measured'] >= 1, id);
  }
});

test('the runner ends a stub-only run with exit code 3 and zero passes', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-stub-'));
  try {
    const r = spawnSync(process.execPath, [path.join(REPO, 'bench', 'atlas.mjs'), '--quick', '--phase', stubIds().join(','), '--out', out],
      { cwd: REPO, encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 3, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
    const result = JSON.parse(fs.readFileSync(path.join(out, 'atlas.json'), 'utf8'));
    assert.equal(result.counts.pass, 0);
    assert.equal(result.counts['not-measured'], stubIds().length);
    assert.equal(result.blindSpots.length, stubIds().length);
    assert.match(r.stdout, /4 NOT MEASURED/);
    assert.match(r.stdout, /blind spot/);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
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

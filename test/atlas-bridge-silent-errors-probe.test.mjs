// test/atlas-bridge-silent-errors-probe.test.mjs — the two atlas phases `bridge` and `silent-errors`
// run, in quick size, on throwaway roots, and neither goes quiet.
//
// What this proves, and what it does not. It proves that each phase returns records with the four
// fields (what was expected, what was measured, which verdict, the evidence), that no record the
// phase promises is silently missing, that a `not-measured` names its reason, and that the controls
// which keep the harness honest hold: a legitimate entry of every type is accepted over a real
// stdio bridge, the run counter reports a run it was handed, the injected search failure throws
// only for the lane it names, the judge of the surfaces cannot be fooled by an empty answer. It
// does NOT pin the verdicts of the findings: E1 (the visibility journal) and E3 (the task lane)
// are red in this house when the phase was written, and a test that required them to stay red
// would punish the port that fixes them. A refusal of the bridge is pinned only through its
// control: if the control holds, the refusal record is a pass or a fail, never `not-measured`.
//
// Red proof for the bridge phase: against 91b1afc (before the security ports), archived into a
// scratch folder with the phase files copied in, 52 of the 75 records of the quick run read fail
// (no field refused, closes_id and guard accepted, a claimed appointment active, a forged inbox
// sender accepted, any store path accepted, a 60000-character run handed whole to the patterns).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';
import * as bridge from '../bench/atlas/phase-bridge.mjs';
import * as silent from '../bench/atlas/phase-silent-errors.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.join(HERE, '..', 'bench', 'atlas');
const VERDICTS = Object.values(VERDICT);

/** Every record carries the four fields, and an empty answer is never silent. */
function assertWellFormed(records) {
  assert.ok(records.length > 0, 'the phase produced no records at all');
  const ids = new Set();
  for (const r of records) {
    assert.ok(!ids.has(r.id), `duplicate record id ${r.id}`);
    ids.add(r.id);
    assert.ok(VERDICTS.includes(r.verdict), `${r.id}: verdict ${r.verdict}`);
    assert.ok('expected' in r, `${r.id}: no expected field`);
    assert.ok(typeof r.actual === 'string' && r.actual.length > 0, `${r.id}: nothing measured, nothing said`);
    assert.ok(typeof r.title === 'string' && r.title.length > 0, `${r.id}: no title`);
    if (r.verdict === VERDICT.NOT_MEASURED) {
      assert.ok(typeof r.evidence === 'string' && r.evidence.length > 10, `${r.id}: not-measured without a reason`);
    } else {
      assert.ok(r.expected !== null && r.expected !== undefined && String(r.expected).length > 0, `${r.id}: a verdict without an expectation`);
      assert.ok(r.evidence, `${r.id}: a verdict without evidence`);
    }
  }
}
const byId = (recs) => new Map(recs.map((r) => [r.id, r]));

test('the run counter reports the longest run it was handed, and ignores short subjects', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-run-counter-'));
  try {
    const out = path.join(dir, 'c.jsonl');
    const code = "'x'.repeat(2500).match(/x+/g); 'short text only'.match(/o/g); 'a b '.repeat(1000).replace(/a/g, 'c');";
    const r = spawnSync(process.execPath, [`--import=${pathToFileURL(path.join(BENCH, 'run-counter.mjs')).href}?out=${encodeURIComponent(out)}`, '-e', code], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const row = JSON.parse(fs.readFileSync(out, 'utf8').trim().split('\n').pop());
    assert.equal(row.longestRun, 2500);
    assert.equal(row.bySource['x+'], 2500);
    assert.equal(row.bySource.a, 1, 'a long subject made of short words holds runs of one character');
    assert.equal(row.bySource.o, undefined, 'a subject under the watch length is not looked at');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the injected search failure throws for the lane it names and for no other', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-inject-'));
  try {
    memory.logEntry(dir, 'error', { title: 'probe error', text: 'planted', class: 'wrong-cause', agent: 'probe' });
    const script = `const s = await import(${JSON.stringify(pathToFileURL(path.join(HERE, '..', 'src', 'search.mjs')).href)});`
      + `const index = s.loadIndex(${JSON.stringify(dir)});`
      + "const out = {}; for (const type of ['error', 'learning']) { try { s.search(index, 'probe', { top: 2, type }); out[type] = 'ok'; } catch (e) { out[type] = String(e.message); } }"
      + 'console.log(JSON.stringify(out));';
    const ask = (query) => spawnSync(process.execPath, ['--no-warnings', '--experimental-test-module-mocks', `--import=${pathToFileURL(path.join(BENCH, 'inject-search-failure.mjs')).href}${query}`, '--input-type=module', '-e', script], { encoding: 'utf8' });
    const healthy = ask('');
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.deepEqual(JSON.parse(healthy.stdout.trim()), { error: 'ok', learning: 'ok' });
    const broken = ask('?fail=error');
    assert.equal(broken.status, 0, broken.stderr);
    const got = JSON.parse(broken.stdout.trim());
    assert.match(got.error, /injected/);
    assert.equal(got.learning, 'ok');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the judge of the surfaces cannot be fooled by an empty answer', () => {
  const base = { error: false, shows: false, namesFile: false, mentionsSkip: false };
  assert.equal(silent.judge('unreadable', { ...base }).verdict, VERDICT.FAIL, 'an unreadable log answered with nothing is a failure');
  assert.equal(silent.judge('unreadable', { ...base, error: true }).verdict, VERDICT.DEGRADED, 'an error that does not name the file is not a clean pass');
  assert.equal(silent.judge('unreadable', { ...base, error: true, namesFile: true }).verdict, VERDICT.PASS);
  assert.equal(silent.judge('missing', { ...base, error: true }).verdict, VERDICT.FAIL, 'a missing log is not an error');
  assert.equal(silent.judge('missing', { ...base }).verdict, VERDICT.PASS);
  assert.equal(silent.judge('empty', { ...base, shows: true }).verdict, VERDICT.FAIL);
  assert.equal(silent.judge('broken', { ...base, shows: true }).verdict, VERDICT.DEGRADED, 'a skipped line that is not mentioned makes the answer partial without saying so');
  assert.equal(silent.judge('broken', { ...base, shows: true, mentionsSkip: true }).verdict, VERDICT.PASS);
  assert.equal(silent.judge('broken', { ...base }).verdict, VERDICT.FAIL, 'a broken line must not cost the good one');
  assert.equal(silent.judge('ok', { ...base }).verdict, VERDICT.FAIL, 'the control fails when the entry is not shown');
  const d = silent.digest({ stdout: 'Nothing for zorbleplex', stderr: '' }, { mark: 'sefmarker', file: '/x/global/learnings.jsonl' });
  assert.equal(d.shows, false, 'the echo of the question is not the entry');
});

test('bridge (quick): every door has its records, every control holds, nothing is silently missing', { timeout: 300000 }, async () => {
  const atlas = new Atlas({ label: 'probe' });
  await bridge.run(atlas, { quick: true });
  const phase = atlas.phases[0];
  assert.equal(phase.id, 'bridge');
  const recs = phase.records;
  assertWellFormed(recs);
  const ids = byId(recs);
  const must = ['bridge.connect', 'bridge.duty.control', 'bridge.duty.closes-id', 'bridge.duty.guard', 'bridge.duty.close-without-proof',
    'bridge.authority.clamped', 'bridge.appointment.control', 'bridge.appointment.control-cli-claim', 'bridge.appointment.claim-stays-proposed',
    'bridge.inbox.control', 'bridge.inbox.foreign-from', 'bridge.store.control',
    'bridge.store.absolute', 'bridge.store.in-root', 'bridge.store.dotdot', 'bridge.store.symlink', 'bridge.store.missing',
    'bridge.long-run.control', 'bridge.long-run.write', 'bridge.long-run.scan-bound.find', 'bridge.long-run.scan-bound.net'];
  for (const type of Object.keys(bridge.LEGIT)) {
    must.push(`bridge.fields.${type}.control`);
    for (const klass of Object.keys(bridge.FIELD_CLASSES)) must.push(`bridge.fields.${type}.${klass}`);
  }
  for (const type of bridge.REFUSED_TYPES) must.push(`bridge.fields.${type}.refused-type`);
  for (const id of must) assert.ok(ids.has(id), `missing record ${id}`);
  assert.equal(recs.length, must.length, `unexpected records: ${recs.filter((r) => !must.includes(r.id)).map((r) => r.id).join(', ')}`);
  // The controls hold: otherwise the refusals below them would say nothing.
  for (const r of recs.filter((x) => /\.control(-cli-claim)?$/.test(x.id))) assert.equal(r.verdict, VERDICT.PASS, `${r.id}: ${r.actual}`);
  // With the controls holding, a refusal record is a pass or a fail, never not-measured.
  for (const r of recs) assert.notEqual(r.verdict, VERDICT.NOT_MEASURED, `${r.id}: ${r.evidence}`);
  // The counters are there: refused of asked per type and class, never a time.
  const m = ids.get('bridge.fields.thought.machine').measured;
  assert.equal(m.asked, bridge.FIELD_CLASSES.machine.length);
  assert.ok(Number.isInteger(m.refused) && Number.isInteger(m.written));
  const bound = ids.get('bridge.long-run.scan-bound.find').measured;
  assert.equal(bound.planted, 60000);
  assert.ok(Number.isInteger(bound.worst) && bound.bound === bridge.RUN_BOUND);
  assert.ok(atlas.blindSpots.length >= 4, 'what the phase does not ask is named');
  assert.match(phase.note, /Counters, not clocks/);
});

test('silent-errors (quick): every state on every surface has a record, E1 and E3 are measured, nothing is silently missing', { timeout: 300000 }, async () => {
  const atlas = new Atlas({ label: 'probe' });
  await silent.run(atlas, { quick: true });
  const phase = atlas.phases[0];
  assert.equal(phase.id, 'silent-errors');
  const recs = phase.records;
  assertWellFormed(recs);
  const ids = byId(recs);
  const must = [];
  for (const s of silent.STATES) must.push(`silent-errors.readlog.${s}`);
  for (const surface of ['cli-find', 'cli-context', 'bridge-find', 'bridge-context']) for (const s of silent.STATES) must.push(`silent-errors.${surface}.${s}`);
  must.push('silent-errors.visibility.ok', 'silent-errors.visibility.broken', 'silent-errors.visibility.unreadable',
    'silent-errors.task-lane.control', 'silent-errors.task-lane.nothing-found', 'silent-errors.task-lane.failed-lane');
  for (const id of must) assert.ok(ids.has(id), `missing record ${id}`);
  assert.equal(recs.length, must.length, `unexpected records: ${recs.filter((r) => !must.includes(r.id)).map((r) => r.id).join(', ')}`);
  // The controls hold, so no state record is not-measured for a harness reason.
  for (const id of ['silent-errors.readlog.ok', 'silent-errors.cli-find.ok', 'silent-errors.cli-context.ok', 'silent-errors.bridge-find.ok',
    'silent-errors.bridge-context.ok', 'silent-errors.visibility.ok', 'silent-errors.task-lane.control', 'silent-errors.task-lane.nothing-found']) {
    assert.equal(ids.get(id).verdict, VERDICT.PASS, `${id}: ${ids.get(id).actual}`);
  }
  for (const r of recs) assert.notEqual(r.verdict, VERDICT.NOT_MEASURED, `${r.id}: ${r.evidence}`);
  // The library layer is the rule itself: five states, five answers.
  for (const s of silent.STATES) assert.equal(ids.get(`silent-errors.readlog.${s}`).verdict, VERDICT.PASS, s);
  // E1 and E3 are asked and answered either way; a fail names the line that makes a failure look empty.
  for (const id of ['silent-errors.visibility.unreadable', 'silent-errors.task-lane.failed-lane']) {
    const r = ids.get(id);
    assert.ok([VERDICT.PASS, VERDICT.FAIL].includes(r.verdict), id);
    if (r.verdict === VERDICT.FAIL) assert.match(r.evidence, /src\/(mcpvisibility|subagenttask)\.mjs:\d+/, `${id}: the evidence does not point to the source line`);
  }
  assert.ok(atlas.blindSpots.some((b) => /E2/.test(b.what)) && atlas.blindSpots.some((b) => /E4/.test(b.what)), 'E2 and E4 are named as not asked');
});

test('the atlas runner knows both phases', () => {
  const src = fs.readFileSync(new URL('../bench/atlas.mjs', import.meta.url), 'utf8');
  assert.match(src, /\['bridge', '\.\/atlas\/phase-bridge\.mjs'/);
  assert.match(src, /\['silent-errors', '\.\/atlas\/phase-silent-errors\.mjs'/);
});

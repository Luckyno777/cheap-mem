// test/atlas-skala-identifiers-probe.test.mjs — the two newest atlas phases
// run, in quick size, on throwaway roots, and neither goes quiet.
//
// What this proves, and what it does not. It proves that `skala` and
// `identifiers` each return records with the four fields (what was expected,
// what was measured, which verdict, the evidence), that none of the records
// the phases promise is silently missing, and that a `not-measured` names its
// reason. It does NOT pin the verdicts of the measurements themselves: the
// content-word path losing underscore identifiers is a finding the atlas is
// supposed to report, and a test that required it to stay red would punish
// the fix. The controls that keep the harness honest are pinned instead: the
// counter counts a planted file exactly, on every read path the code uses;
// a plain word is found first; a rank of 4 is not "rank 3 or better".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Atlas, VERDICT } from '../bench/atlas/core.mjs';
import * as skala from '../bench/atlas/phase-skala.mjs';
import * as identifiers from '../bench/atlas/phase-identifiers.mjs';

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
      assert.ok(typeof r.evidence === 'string' && r.evidence.length > 0, `${r.id}: not-measured without a reason`);
    } else {
      assert.ok(r.expected !== null && r.expected !== undefined && String(r.expected).length > 0, `${r.id}: a verdict without an expectation`);
      assert.ok(r.evidence, `${r.id}: a verdict without evidence`);
    }
  }
}

test('the counter counts a planted file exactly, on every read path the code uses', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-io-probe-'));
  try {
    fs.mkdirSync(path.join(root, 'global'));
    const file = path.join(root, 'global', 'planted.jsonl');
    fs.writeFileSync(file, 'a\nbb\nccc\n'.repeat(1000)); // 9000 bytes, 3000 lines
    const ctx = { root, home: root, scratch: root };
    const programs = {
      buffer: 'require("node:fs").readFileSync(process.argv[1])',
      utf8: 'require("node:fs").readFileSync(process.argv[1], "utf8")',
      'open+read': 'const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r");const b=Buffer.alloc(4096);while(fs.readSync(fd,b,0,4096,null)>0);fs.closeSync(fd)',
      stream: 'require("node:fs").createReadStream(process.argv[1]).on("data",()=>{})',
    };
    for (const [name, code] of Object.entries(programs)) {
      const r = skala.countedRun(ctx, ['-e', code, file]);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(r.io.corpusBytesRead, 9000, `${name}: bytes`);
      assert.equal(r.io.linesRead, 3000, `${name}: lines`);
      assert.equal(r.io.processes, 1, `${name}: processes`);
    }
    // A file outside the root is not counted: the counter is about the memory.
    const outside = path.join(os.tmpdir(), `atlas-io-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, 'x\n'.repeat(100));
    try {
      const r = skala.countedRun(ctx, ['-e', 'require("node:fs").readFileSync(process.argv[1])', outside]);
      assert.equal(r.io.corpusBytesRead + r.io.indexBytesRead + r.io.otherBytesRead, 0);
    } finally { fs.rmSync(outside, { force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('growthExponent: a linear counter has slope 1, rungs too close give no slope', () => {
  assert.equal(skala.growthExponent([{ x: 1000, y: 10 }, { x: 10000, y: 100 }]), 1);
  assert.equal(skala.growthExponent([{ x: 1000, y: 10 }, { x: 10000, y: 1000 }]), 2);
  assert.equal(skala.growthExponent([{ x: 1000, y: 10 }, { x: 1500, y: 15 }]), null);
  assert.equal(skala.growthExponent([{ x: 1000, y: 10 }]), null);
  assert.equal(skala.growthExponent([{ x: 1000, y: 0 }, { x: 10000, y: 5 }]), null);
});

test('rankOf: a rank of 4 is a rank of 4, an absent target is null, unreadable is not a rank', () => {
  const hits = ['a', 'b', 'c', 'target', 'e'].map((id) => ({ entry: { id } }));
  assert.equal(identifiers.rankOf(JSON.stringify({ hits }), 'target').rank, 4);
  assert.ok(identifiers.rankOf(JSON.stringify({ hits }), 'target').rank > identifiers.RANK_MAX);
  assert.equal(identifiers.rankOf(JSON.stringify({ hits }), 'nope').rank, null);
  assert.equal(identifiers.rankOf('not json', 'target').readable, false);
  assert.equal(identifiers.rankOf(JSON.stringify({ nothing: 1 }), 'target').readable, false);
});

test('identifiers (quick): every form on every path has a record, the control holds', { timeout: 300000 }, async () => {
  const atlas = new Atlas({ label: 'probe' });
  await identifiers.run(atlas, { quick: true });
  const recs = atlas.phases[0].records;
  assert.equal(atlas.phases[0].id, 'identifiers');
  assertWellFormed(recs);
  for (const f of identifiers.FORMS) {
    for (const p of identifiers.PATHS) {
      assert.ok(recs.some((r) => r.id === `identifiers.${f.key}.${p.key}`), `missing record for ${f.key} / ${p.key}`);
    }
  }
  assert.equal(recs.length, identifiers.FORMS.length * identifiers.PATHS.length);
  const control = recs.find((r) => r.id === 'identifiers.plain.find');
  assert.equal(control.verdict, VERDICT.PASS, `the positive control: ${control.actual}`);
  assert.ok(!recs.some((r) => r.id === 'identifiers.positive-control'), 'the harness reported a broken control');
  for (const r of recs) assert.ok([VERDICT.PASS, VERDICT.FAIL].includes(r.verdict), `${r.id}: ${r.verdict} where a rank was asked`);
  assert.ok(atlas.blindSpots.length >= 1, 'the forms not planted are named as blind spots');
  assert.match(atlas.phases[0].note, /find \d+\/\d+, recall \d+\/\d+, content-words \d+\/\d+/);
});

test('skala (quick, two small rungs): the records are all there, nothing is silently missing', { timeout: 600000 }, async () => {
  const atlas = new Atlas({ label: 'probe' });
  await skala.run(atlas, { quick: true, rungs: [200, 600] });
  const recs = atlas.phases[0].records;
  assert.equal(atlas.phases[0].id, 'skala');
  assertWellFormed(recs);
  const byId = new Map(recs.map((r) => [r.id, r]));
  const perRung = ['build', 'find-reads', 'context-reads', 'retrieve-hook-reads', 'candidates', 'index-bytes', 'peak-rss', 'time-companion'];
  for (const n of [200, 600]) {
    for (const k of perRung) assert.ok(byId.has(`skala.rung${n}.${k}`), `missing skala.rung${n}.${k}`);
    // Each of the three calls carries the counters the phase promises.
    for (const k of ['find-reads', 'context-reads', 'retrieve-hook-reads']) {
      const r = byId.get(`skala.rung${n}.${k}`);
      if (r.verdict === VERDICT.NOT_MEASURED) continue; // named by its evidence, checked in assertWellFormed
      assert.match(r.actual, /lines/);
      assert.ok(Number.isFinite(r.measured.linesRead ?? r.measured.find?.linesRead.p50), `${r.id}: no line counter`);
    }
    assert.equal(byId.get(`skala.rung${n}.build`).verdict, VERDICT.PASS);
    const cand = byId.get(`skala.rung${n}.candidates`);
    assert.ok(cand.measured.documents >= n, 'the scan visits every document');
    assert.ok(Number.isFinite(cand.measured.scored[0]));
    // The build's peak comes from /proc (VmHWM): Linux only. Where it cannot be read the record
    // must say so (not-measured, with the reason) instead of carrying a number it did not measure.
    const rss = byId.get(`skala.rung${n}.peak-rss`);
    if (process.platform === 'linux') {
      assert.ok(Number.isFinite(rss.measured.build), 'the peak RSS of the build');
    } else if (rss.measured.build == null) {
      assert.notEqual(rss.verdict, VERDICT.PASS, `${rss.id}: a pass without the build's peak`);
      assert.match(rss.evidence, /not measurable here/);
      assert.ok(atlas.blindSpots.some((b) => b.what.includes('build\'s peak RSS')), 'the missing build peak is a named blind spot');
    } else {
      assert.ok(Number.isFinite(rss.measured.build), 'the peak RSS of the build');
    }
    assert.ok(byId.get(`skala.rung${n}.index-bytes`).measured.indexBytes > 0);
  }
  for (const g of ['find-lines-read', 'find-corpus-bytes-read', 'find-index-bytes-read', 'candidates', 'peak-rss']) {
    assert.ok(byId.has(`skala.growth.${g}`), `missing skala.growth.${g}`);
  }
  // The reference rungs a quick run did not cover are named, with the reason.
  for (const n of [100000, 1000000]) {
    const r = byId.get(`skala.rung${n}.not-run`);
    assert.equal(r.verdict, VERDICT.NOT_MEASURED);
    assert.match(r.actual, /quick mode/);
  }
  assert.ok(atlas.blindSpots.some((b) => b.what.includes('100000')), 'the missing 100k rung is a named blind spot');
  assert.ok(atlas.blindSpots.some((b) => /recall server/.test(b.what)));
});

test('judgePeakRss: a build peak that could not be read is not-measured, never a pass and never invented', () => {
  const others = { find: 80, context: 70, hook: null, loadProbe: 90 };
  // The shape of macOS and Windows: no /proc, so the build figure is null.
  for (const platform of ['darwin', 'win32']) {
    const j = skala.judgePeakRss({ build: null, ...others }, 500, platform);
    assert.equal(j.verdict, VERDICT.NOT_MEASURED, platform);
    assert.equal(j.buildMeasured, false);
    assert.equal(j.peakMax, null, 'the smaller processes are not passed off as the largest');
    assert.match(j.evidence, new RegExp(`not measurable here.*${platform}`));
    assert.match(j.actual, /not measurable/);
  }
  // A measured process over the bound is a fail whatever the build did.
  assert.equal(skala.judgePeakRss({ build: null, ...others, find: 900 }, 500, 'darwin').verdict, VERDICT.FAIL);
  // Linux: all measured, under the bound is a pass; over it is a fail.
  assert.equal(skala.judgePeakRss({ build: 300, ...others }, 500, 'linux').verdict, VERDICT.PASS);
  assert.equal(skala.judgePeakRss({ build: 700, ...others }, 500, 'linux').verdict, VERDICT.FAIL);
  // Nothing read at all stays not-measured.
  assert.equal(skala.judgePeakRss({ build: null, find: null, context: null, hook: null, loadProbe: null }, 500, 'linux').verdict, VERDICT.NOT_MEASURED);
  // Zero is a number: a build that read 0 is not "missing".
  assert.equal(skala.judgePeakRss({ build: 0, ...others }, 500, 'linux').buildMeasured, true);
});

test('skala refuses a rung above the container limit instead of building it, and says so', { timeout: 120000 }, async () => {
  const atlas = new Atlas({ label: 'probe' });
  await skala.run(atlas, { quick: true, rungs: [2000000] });
  const refused = atlas.phases[0].records.find((r) => r.id === 'skala.rung2000000.refused');
  assert.ok(refused, 'a refused rung leaves a record');
  assert.equal(refused.verdict, VERDICT.NOT_MEASURED);
  assert.match(refused.evidence, /above the container gate/);
  assert.ok(!atlas.phases[0].records.some((r) => r.id === 'skala.rung2000000.build'));
  assertWellFormed(atlas.phases[0].records);
});

test('the atlas runner knows both phases and passes --rungs on', () => {
  const src = fs.readFileSync(new URL('../bench/atlas.mjs', import.meta.url), 'utf8');
  assert.match(src, /\['skala', '\.\/atlas\/phase-skala\.mjs'/);
  assert.match(src, /\['identifiers', '\.\/atlas\/phase-identifiers\.mjs'/);
  assert.match(src, /rungs: opt\.rungs/);
  const help = spawnSync(process.execPath, [fileURLToPath(new URL('../bench/atlas.mjs', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--rungs/);
  assert.match(help.stdout, /skala/);
});

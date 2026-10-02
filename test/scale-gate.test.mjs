// The scale gate's own logic (bench/scale-gate.mjs), small and fast. The gate
// decides pass/fail/unknown for a multi-hour run on a quiet machine; a gate
// that cannot fail, or that passes on a number it never measured, is worse
// than none. So: criteria loading, "not measured never passes", an abort is
// unknown, resume skips what is done, the resource pre-check refuses, a red
// proof (a sabotaged rung fails) and a positive control (a good rung passes).
//
// Nothing here runs a rung of real size: the two subprocess tests use 300
// entries and a private TMPDIR, and check that nothing is left behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadCriteria, boundFor, evaluateRung, rungVerdict, summarize, doneRungs, precheck, heldOut,
  parseRungs, readRows, appendRow, underTemp, writeFiller, estimateRssBytes, latestRungRows,
  MAX_ENTRIES, CRITERIA_FILE,
} from '../bench/scale-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.join(HERE, '..', 'bench', 'scale-gate.mjs');
const made = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const criteria = loadCriteria();

/** A metrics object that sits comfortably inside every limit at `n` (half of each bound, flags true, no drop). */
function goodMetrics(n, baseline = null) {
  const m = {};
  for (const k of criteria.criteria) {
    if (k.kind === 'max') m[k.metric] = boundFor(k.bound, n, criteria.corpusWeights) / 2;
    else if (k.kind === 'true') m[k.metric] = true;
    else m[k.metric] = baseline ? baseline[k.metric] : 80;
  }
  return m;
}

// --- criteria loading --------------------------------------------------

test('the committed criteria load, and every criterion names its source', () => {
  assert.equal(criteria.baselineRung, 10000);
  assert.deepEqual(criteria.defaultRungs, [10000, 100000, 1000000]);
  assert.ok(criteria.criteria.length >= 14);
  for (const k of criteria.criteria) assert.ok(k.source.length > 40, `${k.id}: source too short to be one`);
  for (const id of ['gold-pass3-drop', 'cold-find-p95', 'warm-find-p95', 'build-time', 'build-peak-rss', 'doctor-answers',
    'dashboard-first-answer', 'write-succeeds', 'write-findable']) {
    assert.ok(criteria.criteria.some((k) => k.id === id), `criterion ${id} missing`);
  }
});

test('a criteria file with no source, descending anchors, an unknown kind or a missing weight is refused', () => {
  const bad = (mutate, re) => {
    const c = JSON.parse(fs.readFileSync(CRITERIA_FILE, 'utf8'));
    mutate(c);
    const f = path.join(tmp('cm-sg-crit-'), 'c.json');
    fs.writeFileSync(f, JSON.stringify(c));
    assert.throws(() => loadCriteria(f), re);
  };
  bad((c) => { delete c.criteria[0].source; }, /no source/);
  bad((c) => { c.criteria.find((k) => k.kind === 'max').bound.anchors = [[100, 5], [10, 6]]; }, /ascend/);
  bad((c) => { c.criteria[0].kind = 'sometimes'; }, /unknown kind/);
  bad((c) => { c.criteria.find((k) => k.kind === 'max').bound.weight = 'nonexistent'; }, /not in corpusWeights/);
  bad((c) => { c.criteria.push({ ...c.criteria[0] }); }, /duplicate/);
  assert.throws(() => loadCriteria(path.join(os.tmpdir(), 'does-not-exist-sg.json')), /unreadable/);
});

test('boundFor: exact at an anchor, between anchors in between, beyond with the exponent, floor and ceiling hold', () => {
  const spec = { anchors: [[1000, 100], [10000, 1000]], extrapolateExponent: 0.5, weight: 'w', headroom: 2 };
  assert.equal(Math.round(boundFor(spec, 1000, { w: 3 })), 600);
  assert.equal(Math.round(boundFor(spec, 10000, { w: 3 })), 6000);
  const mid = boundFor(spec, 3162, { w: 3 });
  assert.ok(mid > 600 && mid < 6000 && Math.abs(mid - 1897) < 20, `log-log midpoint, got ${mid}`);
  assert.ok(Math.abs(boundFor(spec, 100000, { w: 1 }) - 1000 * Math.sqrt(10) * 2) < 1);
  assert.equal(boundFor({ ...spec, floor: 5000 }, 1000, { w: 1 }), 5000);
  assert.equal(boundFor({ ...spec, ceiling: 50 }, 10000, { w: 1 }), 50);
  // the real file: bounds grow with the rung
  const cold = criteria.criteria.find((k) => k.id === 'cold-find-p95').bound;
  const b = [10000, 100000, 1000000].map((n) => boundFor(cold, n, criteria.corpusWeights));
  assert.ok(b[0] < b[1] && b[1] < b[2]);
});

// --- not measured never passes -----------------------------------------

test('a metric that was not measured never passes, whatever shape the gap has', () => {
  for (const gap of [undefined, null, NaN, Infinity, 'fast']) {
    const metrics = {};
    for (const k of criteria.criteria) metrics[k.metric] = k.kind === 'true' ? gap : gap;
    const checks = evaluateRung(100000, metrics, criteria, goodMetrics(10000));
    assert.equal(checks.filter((c) => c.state === 'pass').length, 0, `gap ${String(gap)} produced a pass`);
    assert.equal(rungVerdict(checks), 'unknown');
  }
  assert.equal(rungVerdict([]), 'unknown');
  assert.equal(rungVerdict(undefined), 'unknown');
  // one missing value among good ones: unknown, not pass
  const m = goodMetrics(100000, goodMetrics(10000));
  delete m.warmP95Ms;
  const checks = evaluateRung(100000, m, criteria, goodMetrics(10000));
  assert.equal(checks.find((c) => c.id === 'warm-find-p95').state, 'unknown');
  assert.equal(rungVerdict(checks), 'unknown');
});

test('a drop check without a measured baseline is unknown, and below the baseline rung it is not applicable', () => {
  const m = goodMetrics(100000);
  assert.equal(evaluateRung(100000, m, criteria, null).find((c) => c.id === 'gold-pass3-drop').state, 'unknown');
  assert.equal(evaluateRung(100000, m, criteria, { goldPass3Pct: null }).find((c) => c.id === 'gold-pass3-drop').state, 'unknown');
  assert.equal(evaluateRung(2000, goodMetrics(2000), criteria, null).find((c) => c.id === 'gold-pass3-drop').state, 'na');
});

// --- red proof and positive control ------------------------------------

test('POSITIVE CONTROL: a rung inside every limit passes', () => {
  const base = goodMetrics(10000);
  const at10k = evaluateRung(10000, base, criteria, null);
  assert.equal(rungVerdict(at10k), 'pass');
  const m = goodMetrics(1000000, base);
  const checks = evaluateRung(1000000, m, criteria, base);
  assert.equal(rungVerdict(checks), 'pass', JSON.stringify(checks.filter((c) => c.state !== 'pass')));
  assert.equal(checks.filter((c) => c.state === 'pass').length, criteria.criteria.length);
});

test('RED PROOF: each kind of sabotage makes the rung fail, and a fail beats an unknown', () => {
  const base = goodMetrics(10000);
  const sabotage = [
    ['recall drops 10 points at rank 3', { goldPass3Pct: base.goldPass3Pct - 10 }, 'gold-pass3-drop'],
    ['heaps anchors drop 20 points', { anchorAt10Pct: base.anchorAt10Pct - 20 }, 'heaps-anchor-at10-drop'],
    ['cold p95 far above its bound', { coldP95Ms: 1e9 }, 'cold-find-p95'],
    ['warm p95 above its bound', { warmP95Ms: 1e9 }, 'warm-find-p95'],
    ['peak RSS above its bound', { buildPeakRssMb: 1e9 }, 'build-peak-rss'],
    ['build too slow', { buildMs: 1e12 }, 'build-time'],
    ['doctor does not answer', { doctorAnswered: false }, 'doctor-answers'],
    ['the write is not findable', { writeFindable: false }, 'write-findable'],
  ];
  for (const [name, patch, id] of sabotage) {
    const m = { ...goodMetrics(100000, base), ...patch };
    const checks = evaluateRung(100000, m, criteria, base);
    assert.equal(checks.find((c) => c.id === id).state, 'fail', name);
    assert.equal(rungVerdict(checks), 'fail', name);
    const withGap = { ...m, netAnswered: null };
    assert.equal(rungVerdict(evaluateRung(100000, withGap, criteria, base)), 'fail', `${name}: a fail stays a fail beside an unknown`);
  }
  // the edge: a drop of exactly the allowed 5.0 passes, a hair more fails
  const edge = { ...goodMetrics(100000, base), goldPass3Pct: base.goldPass3Pct - 5 };
  assert.equal(evaluateRung(100000, edge, criteria, base).find((c) => c.id === 'gold-pass3-drop').state, 'pass');
  edge.goldPass3Pct -= 0.1;
  assert.equal(evaluateRung(100000, edge, criteria, base).find((c) => c.id === 'gold-pass3-drop').state, 'fail');
});

// --- an abort is unknown, resume skips what is done --------------------

test('an aborted or refused rung is unknown, never fail; the overall verdict follows', () => {
  const rows = [
    { kind: 'rung', n: 10000, status: 'done', verdict: 'pass' },
    { kind: 'rung', n: 100000, status: 'aborted', verdict: 'unknown', reason: 'aborted by SIGTERM' },
  ];
  const s = summarize(rows, [10000, 100000, 1000000]);
  assert.equal(s.overall, 'unknown');
  assert.deepEqual(s.rungs.map((r) => r.verdict), ['pass', 'unknown', 'unknown']);
  assert.equal(s.rungs[2].status, 'not-run');
  assert.equal(summarize([{ kind: 'rung', n: 10000, status: 'done', verdict: 'pass' }], [10000]).overall, 'pass');
  assert.equal(summarize([...rows, { kind: 'rung', n: 1000000, status: 'done', verdict: 'fail' }], [10000, 100000, 1000000]).overall, 'fail');
});

test('resume: finished rungs (pass or fail) are skipped, aborted and refused ones run again, the latest row per rung counts', () => {
  const rows = [
    { kind: 'calibration', status: 'done' },
    { kind: 'rung', n: 10000, status: 'done', verdict: 'pass' },
    { kind: 'rung', n: 100000, status: 'aborted', verdict: 'unknown' },
    { kind: 'rung', n: 1000000, status: 'refused', verdict: 'unknown' },
    { kind: 'rung', n: 100000, status: 'done', verdict: 'fail' },
    { kind: 'rung', n: 2000, status: 'done', verdict: 'fail' },
    { kind: 'rung', n: 2000, status: 'aborted', verdict: 'unknown' },
  ];
  assert.deepEqual([...doneRungs(rows)].sort((a, b) => a - b), [10000, 100000]);
  assert.equal(latestRungRows(rows).get(2000).status, 'aborted');
});

test('every row is on disk the moment appendRow returns (an abort loses only the running rung)', () => {
  const f = path.join(tmp('cm-sg-rows-'), 'r.jsonl');
  assert.deepEqual(readRows(f), []);
  appendRow(f, { kind: 'rung', n: 1, status: 'done' });
  assert.equal(readRows(f).length, 1);
  appendRow(f, { kind: 'rung', n: 2, status: 'aborted' });
  assert.deepEqual(readRows(f).map((r) => r.n), [1, 2]);
  fs.appendFileSync(f, 'not json\n');
  assert.throws(() => readRows(f), /not JSON/);
});

test('SIGTERM during a rung: exit 130, the rung row says aborted/unknown, a summary follows, nothing is left in TMPDIR', async () => {
  const home = tmp('cm-sg-abort-');
  const tmpdir = path.join(home, 'tmp');
  fs.mkdirSync(tmpdir);
  const out = path.join(home, 'out.jsonl');
  const kid = spawn(process.execPath, [GATE, '--rungs', '300', '--bytes-per-entry', '5000', '--anchors', '4', '--gold-cases', '2',
    '--out', out, '--allow-uncommitted-criteria'], { env: { ...process.env, TMPDIR: tmpdir }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  const sent = new Promise((resolve) => {
    kid.stderr.on('data', (b) => {
      err += b;
      if (/building the index/.test(err) && !sent.done) { sent.done = true; kid.kill('SIGTERM'); resolve(); }
    });
  });
  const code = await new Promise((resolve) => kid.on('close', resolve));
  await sent;
  assert.equal(code, 130, err.slice(-500));
  const rows = readRows(out);
  const rung = rows.find((r) => r.kind === 'rung');
  assert.equal(rung.status, 'aborted');
  assert.equal(rung.verdict, 'unknown');
  assert.match(rung.reason, /SIGTERM/);
  assert.equal(rows.at(-1).kind, 'summary');
  assert.equal(rows.at(-1).overall, 'unknown');
  assert.deepEqual(fs.readdirSync(tmpdir), [], 'the temp roots were not cleaned up');
});

test('--resume with the only rung already done starts nothing; without --resume an existing output file is refused', () => {
  const dir = tmp('cm-sg-resume-');
  const tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpdir);
  const out = path.join(dir, 'out.jsonl');
  appendRow(out, { kind: 'calibration', n: 2000, status: 'done', bytesPerEntry: 4600 });
  appendRow(out, { kind: 'rung', n: 300, status: 'done', verdict: 'pass', metrics: {}, checks: [] });
  const env = { ...process.env, TMPDIR: tmpdir };
  const r = spawnSync(process.execPath, [GATE, '--rungs', '300', '--resume', '--out', out, '--allow-uncommitted-criteria'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /done already: 300/);
  assert.doesNotMatch(r.stderr, /rung 300: start/);
  assert.doesNotMatch(r.stderr, /calibration: building/, 'the calibration row is reused');
  const rows = readRows(out);
  assert.equal(rows.filter((x) => x.kind === 'rung').length, 1);
  assert.equal(rows.at(-1).kind, 'summary');
  assert.equal(rows.at(-1).overall, 'pass');
  const again = spawnSync(process.execPath, [GATE, '--rungs', '300', '--out', out, '--allow-uncommitted-criteria'], { env, encoding: 'utf8' });
  assert.equal(again.status, 2);
  assert.match(again.stderr, /already has/);
});

// --- the resource pre-check --------------------------------------------

test('the resource pre-check refuses with "unknown (insufficient resources)" instead of crashing; a roomy machine passes', () => {
  const GiB = 1073741824;
  const roomy = { n: 1000000, freeDiskBytes: 50 * GiB, freeRamBytes: 64 * GiB, bytesPerEntry: 4700, rssBytesPerEntry: 7000 };
  assert.equal(precheck(roomy).ok, true, 'POSITIVE CONTROL');
  const noDisk = precheck({ ...roomy, freeDiskBytes: 2.5 * GiB });
  assert.equal(noDisk.ok, false);
  assert.match(noDisk.reason, /^unknown \(insufficient resources\): disk: needs about 5\.\d\d GiB, 2\.50 GiB free/);
  assert.match(precheck({ ...roomy, freeRamBytes: 2 * GiB }).reason, /RAM: needs about/);
  // an unreadable machine and a missing estimate are refusals too
  assert.equal(precheck({ ...roomy, freeDiskBytes: null }).ok, false);
  assert.equal(precheck({ ...roomy, freeRamBytes: undefined }).ok, false);
  assert.equal(precheck({ ...roomy, bytesPerEntry: null }).ok, false);
  // above the owner's limit of 1M, whatever the machine has
  assert.equal(precheck({ ...roomy, n: MAX_ENTRIES + 1 }).ok, false);
  // the estimate grows with the rung
  assert.ok(precheck({ ...roomy, n: 100000 }).diskNeedBytes < precheck(roomy).diskNeedBytes);
});

test('end to end: a rung that does not fit is refused, written as unknown, nothing is built', () => {
  const dir = tmp('cm-sg-refuse-');
  const tmpdir = path.join(dir, 'tmp');
  fs.mkdirSync(tmpdir);
  const out = path.join(dir, 'out.jsonl');
  const r = spawnSync(process.execPath, [GATE, '--rungs', '300', '--bytes-per-entry', '1e13', '--out', out, '--allow-uncommitted-criteria'],
    { env: { ...process.env, TMPDIR: tmpdir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rows = readRows(out);
  const rung = rows.find((x) => x.kind === 'rung');
  assert.equal(rung.status, 'refused');
  assert.equal(rung.verdict, 'unknown');
  assert.match(rung.reason, /^unknown \(insufficient resources\)/);
  assert.doesNotMatch(r.stderr, /writing the filler/);
  assert.equal(JSON.parse(r.stdout).overall, 'unknown');
  assert.deepEqual(fs.readdirSync(tmpdir), []);
});

test('a rung above 1,000,000 is refused before anything happens (owner decision 2026-10-02)', () => {
  const r = spawnSync(process.execPath, [GATE, '--rungs', '2000000', '--dry-run', '--allow-uncommitted-criteria', '--out', path.join(tmp('cm-sg-big-'), 'o.jsonl')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /above the container limit/);
});

// --- the small pure helpers --------------------------------------------

test('held-out ladder point: an exact power law is predicted, fewer than three rungs are not', () => {
  const pts = [10000, 100000, 1000000].map((n) => ({ n, y: 0.2 * n ** 0.95 }));
  const h = heldOut(pts);
  assert.equal(h.ok, true);
  assert.ok(h.relativeError < 0.001);
  assert.equal(heldOut(pts.slice(0, 2)).ok, false);
  assert.equal(heldOut([]).ok, false);
});

test('rung lists parse sorted and unique, and nonsense is refused', () => {
  assert.deepEqual(parseRungs('100000, 10000,10000'), [10000, 100000]);
  assert.throws(() => parseRungs('10k'), /--rungs/);
  assert.throws(() => parseRungs('10'), /--rungs/);
});

test('temp roots only: the real home, the repo and a missing parent are not under the temp dir', () => {
  assert.equal(underTemp(tmp('cm-sg-under-')), true);
  assert.equal(underTemp(os.homedir()), false);
  assert.equal(underTemp(path.join(HERE, '..')), false);
  assert.equal(underTemp(os.tmpdir()), false, 'the temp dir itself is not a root of ours');
});

test('the RSS estimate grows with the rung and a finished rung raises it', () => {
  const small = estimateRssBytes(10000, criteria);
  const big = estimateRssBytes(1000000, criteria);
  assert.ok(big > small * 20);
  const raised = estimateRssBytes(1000000, criteria, [{ n: 100000, phases: { build: { peakRssMb: 5000 } } }]);
  assert.ok(raised > big);
});

test('the filler ends before the gold world starts, and the heaps questions are real entries of it', () => {
  const root = tmp('cm-sg-filler-');
  const { anchors, bytes } = writeFiller(root, 400, { anchors: 12 });
  assert.ok(bytes > 100000);
  assert.equal(anchors.length, 12);
  const ids = new Map();
  let latest = '';
  for (const f of fs.readdirSync(path.join(root, 'global'))) {
    for (const l of fs.readFileSync(path.join(root, 'global', f), 'utf8').split('\n').filter(Boolean)) {
      const e = JSON.parse(l);
      ids.set(e.id, e);
      if (e.ts > latest) latest = e.ts;
    }
  }
  assert.equal(ids.size, 400);
  assert.ok(latest < '2026-01-01', `latest filler ts ${latest}`);
  for (const a of anchors) {
    assert.ok(ids.has(a.id));
    assert.deepEqual(a.expected, [a.id]);
    assert.equal(a.query.split(' ').length, 4);
  }
});

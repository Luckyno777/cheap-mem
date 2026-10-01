// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The value report (bench/value-report.mjs) may not carry a number without
// its method and a link to the raw data, and may not drift from that data.
//
// What is held here, each with its own probe:
//   1. refusal: a metric with no method, no raw link, a link that does not
//      resolve, a value that differs from the raw value, or "not measured"
//      without a reason makes renderReport() throw — nothing is written;
//      positive control: the same fixture, intact, renders;
//   2. not measured is null, never 0 (a section that was not run renders as
//      "not measured");
//   3. docs/value-report.md and the README block are exactly what the raw
//      JSON in docs/value-report/ renders — a hand-edited number is red,
//      and a falsified raw value no longer matches the committed page;
//   4. the probes themselves can see: a redactor that removes nothing scores
//      0% on the secret set, a torn log line counts as corrupt, an
//      acknowledged note missing from disk counts as lost, an unknown
//      question makes a recall group "not measured";
//   5. the decoy set is sound (no decoy is a gold question, kinds are known).
// Red proof against the old state: before this change neither the module nor
// docs/value-report.md existed, so every test here fails on origin/main.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildMetrics, assertMetric, renderReport, renderReadmeBlock, applyToReadme, resolvePointer, growth,
  summariseRecall, loadRaw, loadDecoys, measureSecrets, measureCost, readAllNotes, simulateDigestDay,
  COST_SCENARIOS, METHODS, REPO, REPORT_FILE, README_BEGIN, README_END, SECRET_KINDS,
} from '../bench/value-report.mjs';
import { loadCases } from '../bench/gold-compare.mjs';

// A small, complete raw fixture (every section), values chosen to be easy to check.
function fixture() {
  return {
    meta: { commit: 'abc1234', dirty: false, measuredAt: '2026-10-01T00:00:00Z', sizes: [1000, 10000], environment: { cpuModel: 'test cpu', cpuCount: 2, node: 'v22' } },
    recall: { sizes: Object.fromEntries([1000, 10000].map((n) => [n, {
      groups: Object.fromEntries(['keywords', 'everyday', 'other-words', 'right-project', 'latest-fact', 'still-valid', 'other-language'].map((g) => [g, { n: 4, unknown: 0, at3: 3, at10: 4, pass3: 3, leaked3: 0, measured: true, at3Pct: 75, at10Pct: 100, pass3Pct: 75, leaked3Pct: 0 }])),
      decoys: { far: { n: 10, unknown: 0, falsePositives: 1, silent: 9, falsePositiveRatePct: 10 }, near: { n: 10, unknown: 0, falsePositives: 2, silent: 8, falsePositiveRatePct: 20 } },
    }])) },
    speed: { sizes: { 1000: { state: 'measured', cold: { n: 5, medianMs: 100, p95Ms: 120, worstMs: 130 }, warm: { n: 5, medianMs: 2, p95Ms: 3, worstMs: 4 } },
      10000: { state: 'measured', cold: { n: 5, medianMs: 200, p95Ms: 240, worstMs: 260 }, warm: { n: 5, medianMs: 20, p95Ms: 30, worstMs: 40 } } },
    afterWrite: { 1000: { state: 'measured', n: 2, medianMs: 150, p95Ms: 160, worstMs: 160 }, 10000: { state: 'not-measured', why: 'test' } },
    write: { 1000: { state: 'measured', n: 54, medianMs: 1, p95Ms: 2, worstMs: 3 }, 10000: { state: 'measured', n: 54, medianMs: 2, p95Ms: 3, worstMs: 4 } },
    growth: growth({ 1000: { cold: { medianMs: 100, p95Ms: 120 }, warm: { medianMs: 2, p95Ms: 3 } }, 10000: { cold: { medianMs: 200, p95Ms: 240 }, warm: { medianMs: 20, p95Ms: 30 } } }) },
    space: { sizes: { 1000: { logBytesPerNote: 260, withIndexBytesPerNote: 900 }, 10000: { logBytesPerNote: 261, withIndexBytesPerNote: 910 } }, realNotes: { bytesPerNote: 233 }, extrapolation: { realNotesGB: 0.233 } },
    cost: { scenarios: { idle: { label: 'idle: nothing captured', calls: 0, callsPerDay: 0 }, away: { label: 'away for a week after one small pile', calls: 1, callsPerDay: 0.14 }, light: { label: 'light day: 6 captures of 20 KB', calls: 3, callsPerDay: 3 } }, dollars: { state: 'not-measured', why: 'depends on your plan' } },
    durability: { trials: 3, acknowledged: 100, lost: 0, corruptLines: 0, writeAfterCrashFailed: 0, nextWriteAfterCrash: { n: 3, medianMs: 2, p95Ms: 3, worstMs: 3 } },
    secrets: { kinds: 24, secrets: 120, caughtByRedaction: 118, caughtPct: 98.3, keptOutOfLogFile: 118, keptOutOfLogFilePct: 98.3, benign: 30, benignChanged: 0, benignUntouchedPct: 100 },
    mutation: { state: 'not-measured', why: 'not run' },
  };
}

test('positive control: an intact fixture renders, with sentence, method and raw link for a number', () => {
  const md = renderReport(fixture());
  assert.match(md, /everyday words/);
  assert.match(md, /Method: \[gold\]\(#method\)/);
  assert.match(md, /\[recall\.json\]\(value-report\/recall\.json\) `\/sizes\/10000\/groups\/everyday\/at3Pct`/);
  assert.match(md, /75%/);
  assert.match(md, /Does not make things up/);
});

test('refusal: no method -> throws', () => {
  const raw = fixture();
  const m = buildMetrics(raw).find((x) => x.value !== null);
  assert.throws(() => assertMetric({ ...m, methodId: undefined }, raw), /has no method/);
  assert.throws(() => assertMetric({ ...m, methodId: 'does-not-exist' }, raw), /has no method/);
  assert.throws(() => assertMetric({ ...m, methodId: '' }, raw), /has no method/);
});

test('refusal: no raw link, or a link that resolves to nothing -> throws', () => {
  const raw = fixture();
  const m = buildMetrics(raw).find((x) => x.value !== null);
  assert.throws(() => assertMetric({ ...m, raw: undefined }, raw), /no link to the raw data/);
  assert.throws(() => assertMetric({ ...m, raw: { file: m.raw.file, pointer: '' } }, raw), /no link to the raw data/);
  assert.throws(() => assertMetric({ ...m, raw: { file: m.raw.file, pointer: '/nope/at/all' } }, raw), /does not exist/);
  assert.throws(() => assertMetric({ ...m, raw: { file: 'missing.json', pointer: '/x' } }, raw), /does not exist/);
});

test('refusal: a typed-by-hand value that differs from the raw value -> throws', () => {
  const raw = fixture();
  const m = buildMetrics(raw).find((x) => x.value !== null && x.unit === '%');
  assert.throws(() => assertMetric({ ...m, value: m.value + 1 }, raw), /but the raw data/);
});

test('refusal: a link into a missing part of the raw data is refused; an unmeasured section is not rendered as 0', () => {
  const raw = fixture();
  // A section that was never measured simply has no metrics (it is not rendered as 0) ...
  delete raw.cost;
  assert.doesNotMatch(renderReport(raw), /### Cost/);
  // ... and a link into a section that is gone is refused.
  const raw2 = fixture();
  const metrics = buildMetrics(raw2);
  const broken = metrics.map((x) => (x.key === 'cost.idle' ? { ...x, raw: { file: 'cost.json', pointer: '/scenarios/gone/calls' } } : x));
  assert.throws(() => broken.forEach((x) => assertMetric(x, raw2)), /does not exist/);
});

test('not measured is null with a reason, never 0', () => {
  const raw = fixture();
  const ms = buildMetrics(raw);
  const mut = ms.find((m) => m.key === 'mutation.score');
  assert.equal(mut.value, null);
  assert.match(mut.notMeasured, /not run/);
  const dollars = ms.find((m) => m.key === 'cost.dollars');
  assert.equal(dollars.value, null);
  const aw = ms.find((m) => m.key === 'speed.afterWrite.medianMs' && m.size === 10000);
  assert.equal(aw.value, null);
  assert.throws(() => assertMetric({ ...aw, notMeasured: '' }, raw), /needs a reason/);
  const md = renderReport(raw);
  assert.match(md, /Security mutants caught by tests: \*\*not measured\*\*/);
  assert.doesNotMatch(md, /Security mutants caught by tests.*\b0%/);
});

test('every method id a metric uses has a method text', () => {
  for (const m of buildMetrics(fixture())) assert.ok((METHODS[m.methodId] ?? '').trim(), `${m.key} -> ${m.methodId}`);
});

test('the committed report and README block are exactly what the committed raw data renders', () => {
  const raw = loadRaw();
  assert.ok(raw.meta && raw.recall && raw.speed, 'the raw JSON in docs/value-report/ is missing: run `node bench/value-report.mjs`');
  assert.equal(fs.readFileSync(REPORT_FILE, 'utf8'), renderReport(raw), 'docs/value-report.md drifted from the raw JSON in docs/value-report/ (re-render with `node bench/value-report.mjs --render-only`)');
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  assert.equal(readme, applyToReadme(readme, raw), 'README value-report block drifted (`node bench/value-report.mjs --readme`)');
  const i = readme.indexOf(README_BEGIN); const j = readme.indexOf(README_END);
  assert.ok(i >= 0 && j > i);
  assert.equal(readme.slice(i, j + README_END.length), renderReadmeBlock(raw));
});

test('sabotage: a falsified raw value no longer matches the committed page', () => {
  const raw = loadRaw();
  const fake = JSON.parse(JSON.stringify(raw));
  const first = Object.keys(fake.recall.sizes)[0];
  fake.recall.sizes[first].groups.keywords.at3Pct = 12.3;
  assert.notEqual(fs.readFileSync(REPORT_FILE, 'utf8'), renderReport(fake));
});

test('every raw link in the committed report resolves', () => {
  const raw = loadRaw();
  for (const m of buildMetrics(raw)) {
    assert.notEqual(resolvePointer(raw[m.raw.file.replace(/\.json$/, '')], m.raw.pointer), undefined, `${m.key} @${m.size}`);
  }
});

test('probe sees: a redactor that removes nothing scores 0% on the secret set', () => {
  const none = measureSecrets({ variants: 1, redactFn: (t) => ({ text: t, found: [] }) });
  assert.equal(none.caughtByRedaction, 0);
  const real = measureSecrets({ variants: 1 });
  assert.ok(real.caughtPct > 80, `real redaction caught only ${real.caughtPct}%`);
  assert.equal(real.secrets, SECRET_KINDS.length);
  // The report data must never hold a secret value: only counts and kinds.
  assert.ok(!JSON.stringify(real).match(/ghp_[A-Za-z0-9]{20}|sk-ant-/));
});

test('probe sees: a torn line is corrupt, a missing acknowledged note is lost', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-'));
  try {
    fs.mkdirSync(path.join(root, 'global'), { recursive: true });
    fs.writeFileSync(path.join(root, 'global', 'learnings.jsonl'), '{"id":"a"}\n{"id":"b"}\n{"id":"c","text":"cut off here');
    const seen = readAllNotes(root);
    assert.equal(seen.corrupt, 1);
    assert.ok(seen.ids.has('a') && seen.ids.has('b'));
    assert.ok(!seen.ids.has('c'), 'a torn note is not a note');
    const acked = ['a', 'b', 'c'];
    assert.deepEqual(acked.filter((id) => !seen.ids.has(id)), ['c']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('probe sees: an unknown question makes a recall group not measured, not a pass', () => {
  const groups = summariseRecall([
    { group: 'keywords', state: 'pass', rank: 1, top: ['x'], leakedIds: [] },
    { group: 'keywords', state: 'unknown', rank: null, top: [], leakedIds: [] },
  ]);
  assert.equal(groups.keywords.at3Pct, null);
  assert.equal(groups.keywords.measured, false);
  const ok = summariseRecall([{ group: 'keywords', state: 'pass', rank: 2, top: ['y', 'x'], leakedIds: [] }, { group: 'keywords', state: 'fail', rank: null, top: ['z'], leakedIds: [] }]);
  assert.equal(ok.keywords.at3Pct, 50);
  assert.equal(ok.keywords.at10Pct, 50);
});

test('a leaked forbidden note in the top 3 fails the scoped pass', () => {
  const g = summariseRecall([{ group: 'right-project', state: 'fail', rank: 1, top: ['good', 'bad'], leakedIds: ['bad'] }]);
  assert.equal(g['right-project'].at3, 1);
  assert.equal(g['right-project'].pass3, 0);
  assert.equal(g['right-project'].leaked3, 1);
});

test('growth: factor and exponent between sizes; a missing size gives null', () => {
  const g = growth({ 1000: { cold: { medianMs: 100, p95Ms: 100 }, warm: { medianMs: 1, p95Ms: 1 } }, 10000: { cold: { medianMs: 1000, p95Ms: 1000 }, warm: { medianMs: 5, p95Ms: 5 } }, 100000: { state: 'not-measured' } });
  assert.equal(g[0].notesFactor, 10);
  assert.equal(g[0].coldMedianFactor, 10);
  assert.equal(g[0].coldMedianExponent, 1);
  assert.equal(g[0].warmMedianFactor, 5);
  assert.equal(g[1].coldMedianFactor, null);
});

test('digest cost: idle is zero calls, a pile left for a week costs one, from the real due() rule', () => {
  const by = Object.fromEntries(COST_SCENARIOS.map((s) => [s.id, s]));
  assert.equal(simulateDigestDay(by.idle).calls, 0);
  assert.equal(simulateDigestDay(by.away).calls, 1);
  const heavy = simulateDigestDay(by.heavy);
  assert.ok(heavy.calls >= 1 && heavy.calls <= 144, 'at most one call per 10-minute tick');
  assert.equal(measureCost().dollars.state, 'not-measured', 'no price is invented');
});

test('decoy set is sound: known kinds, unique ids, no decoy is a gold question', () => {
  const decoys = loadDecoys();
  assert.ok(decoys.length >= 20);
  assert.equal(new Set(decoys.map((d) => d.id)).size, decoys.length);
  for (const d of decoys) { assert.ok(['far', 'near'].includes(d.kind), d.id); assert.ok(d.query.trim(), d.id); }
  const gold = new Set(loadCases().map((c) => c.query.toLowerCase()));
  for (const d of decoys) assert.ok(!gold.has(d.query.toLowerCase()), `${d.id} is also a gold question`);
  assert.ok(decoys.some((d) => d.kind === 'far') && decoys.some((d) => d.kind === 'near'));
});

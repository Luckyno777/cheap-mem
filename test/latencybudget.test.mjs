// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/latencybudget.test.mjs — hook time (Bauplan P2) and the live
// injection view (Bauplan P4): the journal's `duration_ms`, ONE budget
// (src/latencybudget.mjs), the doctor finding `hook-latency`, and the
// dashboard's hook-time / live-injection data. Red proof pinned to a
// fixed commit (rule 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';
import * as lb from '../src/latencybudget.mjs';
import * as doctor from '../src/doctor.mjs';
import * as memory from '../src/memory.mjs';
import * as data from '../src/dashboard-data.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const PRE_P_GAPS_COMMIT = 'e00c3fb176bc6735c06f4aebc14fe98810e14528';
const NOW = new Date('2026-09-29T12:00:00Z');

function fresh() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-latency-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'lattest', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const rows = (n, ms, { occasion = 'question', ts = '2026-09-29T10:00:00Z' } = {}) =>
  Array.from({ length: n }, (_, i) => ({ ts, occasion, reason: null, hits: 1, duration_ms: typeof ms === 'function' ? ms(i) : ms }));

test('RED PROOF (pinned commit): no duration field, no budget module, and the dashboard said "records no duration"', () => {
  const inj = execFileSync('git', ['show', `${PRE_P_GAPS_COMMIT}:src/injection.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.doesNotMatch(inj, /duration_ms/);
  assert.throws(() => execFileSync('git', ['show', `${PRE_P_GAPS_COMMIT}:src/latencybudget.mjs`], { cwd: REPO, stdio: 'pipe' }), /Command failed/);
  const dd = execFileSync('git', ['show', `${PRE_P_GAPS_COMMIT}:src/dashboard-data.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.match(dd, /the injection journal records no duration in cheap-mem/);
  const js = execFileSync('git', ['show', `${PRE_P_GAPS_COMMIT}:assets/dashboard/dashboard.js`], { cwd: REPO, encoding: 'utf8' });
  assert.match(js, /Not measured in cheap-mem: the injection journal records no duration/);
});

test('buildLine: duration_ms is carried when given, and is null (never 0) when unknown', () => {
  assert.equal(injection.buildLine({ durationMs: 123.4 }).duration_ms, 123);
  assert.equal(injection.buildLine({}).duration_ms, null);
  assert.equal(injection.buildLine({ durationMs: 'fast' }).duration_ms, null);
  assert.equal(injection.buildLine({ durationMs: -5 }).duration_ms, 0);
});

test('judge: below 20 timed lines is unknown, never good for lack of data', () => {
  const r = lb.judge(rows(19, 10), 'question', NOW);
  assert.equal(r.level, 'unknown');
  assert.equal(r.p95, null);
  assert.equal(r.n, 19);
});

test('judge: good / warn / error by p95 against the budget (positive control: the levels DO differ)', () => {
  const b = lb.BUDGET_MS.question;
  assert.equal(lb.judge(rows(30, 100), 'question', NOW).level, 'good');
  assert.equal(lb.judge(rows(30, b + 1), 'question', NOW).level, 'warn');
  assert.equal(lb.judge(rows(30, b * 2 + 1), 'question', NOW).level, 'error');
  assert.equal(lb.judge(rows(30, b), 'question', NOW).level, 'good', 'exactly at the budget is inside it');
  // one slow outlier in 40 (below p95) do not tip it
  assert.equal(lb.judge(rows(40, (i) => (i < 1 ? b * 5 : 50)), 'question', NOW).level, 'good');
});

test('judge: a line without duration is NOT counted as a fast one', () => {
  const lines = [...rows(19, 10), { ts: '2026-09-29T10:00:00Z', occasion: 'question', duration_ms: null }, { ts: '2026-09-29T10:00:00Z', occasion: 'question' }];
  const r = lb.judge(lines, 'question', NOW);
  assert.equal(r.n, 19);
  assert.equal(r.level, 'unknown');
});

test('worstLevel: all unknown stays unknown; a measured error wins over good', () => {
  assert.equal(lb.worstLevel(lb.judgeAll([], NOW)), 'unknown');
  const lines = [...rows(30, 50), ...rows(30, lb.BUDGET_MS['before-edit'] * 3, { occasion: 'before-edit' })];
  const all = lb.judgeAll(lines, NOW);
  assert.equal(lb.worstLevel(all), 'error');
  assert.equal(lb.withinBudget(lines, NOW), false);
  assert.equal(lb.withinBudget(rows(30, 50), NOW), true);
  assert.equal(lb.withinBudget([], NOW), true, 'unknown lets the probe through');
});

test('perDay: a day without a timed line is absent, never 0 ms', () => {
  const lines = [...rows(3, 100, { ts: '2026-09-27T10:00:00Z' }), ...rows(2, 300, { ts: '2026-09-29T10:00:00Z' }),
    { ts: '2026-09-28T10:00:00Z', occasion: 'question', duration_ms: null }];
  const d = lb.perDay(lines, { now: NOW });
  assert.deepEqual(d.map((x) => x.day), ['2026-09-27', '2026-09-29']);
  assert.equal(d[1].max, 300);
});

test('doctor hook-latency: no journal -> unknown; thin -> unknown; fast -> good; slow -> error with advice', () => {
  const r = fresh();
  try {
    assert.equal(doctor.checkHookLatency(r).level, 'unknown');
    assert.match(doctor.checkHookLatency(r).text, /no injection journal/);
    for (let i = 0; i < 5; i += 1) injection.book(r, { session: 's1', durationMs: 90, hits: 0 });
    assert.equal(doctor.checkHookLatency(r).level, 'unknown');
    for (let i = 0; i < 25; i += 1) injection.book(r, { session: 's1', durationMs: 90, hits: 0 });
    const good = doctor.checkHookLatency(r);
    assert.equal(good.level, 'good');
    assert.match(good.text, /question 90 ms of 4000/);
    assert.ok(doctor.checkAll(r).findings.some((f) => f.name === 'hook-latency'), 'part of `mem doctor`');
  } finally { away(r); }
  const s = fresh();
  try {
    for (let i = 0; i < 25; i += 1) injection.book(s, { session: 's1', durationMs: lb.BUDGET_MS.question * 3, hits: 0 });
    const bad = doctor.checkHookLatency(s);
    assert.equal(bad.level, 'error');
    assert.match(bad.advice, /5 s/);
  } finally { away(s); }
});

test('mem find --journal-session really writes a positive duration_ms', () => {
  const r = fresh();
  try {
    memory.logEntry(r, 'decision', { title: 'Use cranberry indexing', why: 'cranberry index warm recall speed' });
    const run = (...a) => spawnSync(process.execPath, [MEM, 'find', ...a, '--root', r], { encoding: 'utf8', cwd: r, env: { ...process.env, CHEAP_MEM_ROOT: '' } });
    assert.equal(run('cranberry indexing', '--json', '--journal-session', 'sess-lat-1').status, 0);
    const j = injection.read(r).lines;
    assert.equal(j.length, 1);
    assert.ok(Number.isFinite(j[0].duration_ms) && j[0].duration_ms > 0 && j[0].duration_ms < 60000, `duration_ms=${j[0].duration_ms}`);
  } finally { away(r); }
});

test('dashboard data: hook time and the live injection view come from the journal, not from a simulation', () => {
  const r = fresh();
  try {
    const empty = data.collectDashboard(r);
    assert.equal(empty.usage.measurable, false, 'no journal: not measurable, no invented view');
    assert.equal(empty.performance.hook.measured, 0);
    assert.equal(empty.performance.hook.level, 'unknown');

    for (let i = 0; i < 25; i += 1) injection.book(r, { session: 'abcdefghijkl', durationMs: 200, hits: 2, bytes: 500, sources: ['decisions.jsonl:1'] });
    injection.book(r, { session: 'abcdefghijkl', reason: injection.REASON.TOO_WEAK, hits: 0 });
    const d = data.collectDashboard(r);
    assert.equal(d.usage.live.length, 26);
    assert.equal(d.usage.live[0].reason, 'too-weak', 'newest first, and the nothing is on the view with its reason');
    assert.equal(d.usage.live[0].durationMs, null, 'an untimed line reads not measured, not 0');
    assert.equal(d.usage.live[1].session, 'abcdefgh');
    assert.equal(d.usage.live[1].durationMs, 200);
    assert.equal(d.usage.hookTime.measured, 25);
    assert.equal(d.usage.hookTime.p95, 200);
    assert.equal(d.performance.hook.level, 'good');
    assert.equal(d.performance.hook.finding.name, 'hook-latency');
    assert.match(d.performance.gate.reason, /^Not available in cheap-mem, by design/);
    assert.equal(d.notAvailable.liveInjection, undefined, 'the live view is built, not "not available"');
  } finally { away(r); }
});

test('the served script draws the live view and the hook-time panel', () => {
  const js = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
  assert.match(js, /function liveInjectionPanel\(/);
  assert.match(js, /\$\{liveInjectionPanel\(\)\}/);
  assert.match(js, /function hookTimePanel\(/);
  assert.doesNotMatch(js, /injection journal records no duration/);
});

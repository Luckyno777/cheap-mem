// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/usage-modelcost-effect-wiring.test.mjs — /dashboard.json's
// `usage.modelCost` (src/modelcost.mjs) and `usage.effect`
// (src/effect.mjs, already built but never wired to the dashboard)
// mirror lucky-mem's dash-fix3, part 2.
//
// Red proof pinned to this worktree's starting commit
// (ddca89d5430b7c2866a93788edd6fe14822af337, never `git merge-base`):
// on that commit `collectDashboard()`'s `usage` object has no
// `modelCost` and no `effect` field, however much cost-journal or
// effect data is sitting on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as modelcost from '../src/modelcost.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';

function memoryRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-usage-wiring-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'usagewiringtest', participants: { alex: { human: true } }, language: 'en',
  }));
  modelcost.record(r, { who: 'digest', usage: { input_tokens: 10, output_tokens: 5 }, costUsd: 0.001, source: 'digest-run' });
  return r;
}

test.afterEach(() => dashboardData._clearEffectCache());

test('RED on the old commit: usage carries no modelCost and no effect field', async () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:src/dashboard-data.mjs`], { cwd: REPO, encoding: 'utf8' });
  const tmp = path.join(REPO, 'src', '.usage-wiring-old-dashboard-data.mjs');
  fs.writeFileSync(tmp, old);
  const root = memoryRoot();
  try {
    const mod = await import(pathToFileURL(tmp).href);
    const data = mod.collectDashboard(root);
    assert.ok(data.usage, 'precondition: usage must exist at all for this to be a meaningful red proof');
    assert.equal('modelCost' in data.usage, false, 'the old commit must not carry usage.modelCost');
    assert.equal('effect' in data.usage, false, 'the old commit must not carry usage.effect');
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GREEN on this commit: usage.modelCost reads the real cost journal', () => {
  const root = memoryRoot();
  try {
    const data = dashboardData.collectDashboard(root);
    const mc = data.usage.modelCost;
    assert.equal(mc.measurable, true);
    assert.equal(mc.costLabel, 'estimate, not a bill');
    const row = mc.last7.find((s) => s.who === 'digest');
    assert.ok(row, 'the digest caller should show up in the last-7-day summary');
    assert.equal(row.runs, 1);
    assert.equal(row.inputTokens, 10);
    assert.equal(row.costUsd, 0.001);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('GREEN on a fresh install: usage.modelCost is honestly "not measured yet", never 0', () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-usage-empty-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'empty', participants: {}, language: 'en' }));
  try {
    const data = dashboardData.collectDashboard(r);
    assert.equal(data.usage.modelCost.measurable, false);
    assert.match(data.usage.modelCost.reason, /no row in the cost journal/);
    assert.equal(data.usage.effect.measurable, false);
    assert.match(data.usage.effect.reason, /no injection journal/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('effectOverview() caches for a few minutes and is cleared by _clearEffectCache()', () => {
  const root = memoryRoot();
  try {
    let calls = 0;
    const fakeMeasure = () => { calls += 1; return { state: 'no-data', n: 0, used: 0, minPairs: 1000 }; };
    const a = dashboardData.effectOverview(root, { measure: fakeMeasure, journalMeasurable: true });
    const b = dashboardData.effectOverview(root, { measure: fakeMeasure, journalMeasurable: true });
    assert.equal(calls, 1, 'a second call within the TTL must not re-measure');
    assert.deepEqual(a, b);
    dashboardData._clearEffectCache();
    dashboardData.effectOverview(root, { measure: fakeMeasure, journalMeasurable: true });
    assert.equal(calls, 2, 'after clearing the cache, the next call must measure again');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

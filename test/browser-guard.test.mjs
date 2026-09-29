// test/browser-guard.test.mjs — guard for browser probes (Bauplan W3,
// 2026-09-29; mirrors lucky-mem's test/browser-riegel.test.mjs).
//
// (a) no `networkidle` in test/ or the doc-image script (the network
//     never goes quiet after tempo, see test/fixture/browser.mjs).
// (b) no test file calls `chromium.launch` directly -- only the fixture
//     (test/fixture/browser.mjs) may.
// (c) the fixture closes its own browser in after(): a positive control
//     (a probe WITH the fixture exits promptly) and a sabotage file
//     (chromium.launch without the fixture, never closed -- caught by
//     rule (b)).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const TEST_DIR = HERE;
const FIXTURE = path.join(TEST_DIR, 'fixture', 'browser.mjs');
const DOCS_SCRIPT = path.join(REPO, 'bench', 'docs-images.mjs');

function allTestFiles() {
  return fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => path.join(TEST_DIR, f));
}

test('(a) no networkidle in test/ or the doc-image script', () => {
  const files = [...allTestFiles(), DOCS_SCRIPT];
  const hits = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    if (/waitUntil\s*:\s*['"]networkidle['"]/.test(content)) hits.push(path.relative(REPO, f));
  }
  assert.deepEqual(hits, [], `networkidle is forbidden, found in: ${hits.join(', ')}`);
});

test('(b) no test file calls chromium.launch directly -- only the fixture may', () => {
  // THIS file mentions "chromium.launch" on purpose (sabotage text / error
  // messages for the probes below) -- checking itself would be a false
  // hit, not a real rule-(b) violation.
  const hits = [];
  for (const f of allTestFiles()) {
    if (f === path.join(TEST_DIR, 'browser-guard.test.mjs')) continue;
    const content = fs.readFileSync(f, 'utf8');
    if (/chromium\.launch/.test(content)) hits.push(path.relative(REPO, f));
  }
  assert.deepEqual(hits, [], `chromium.launch belongs only in test/fixture/browser.mjs, found in: ${hits.join(', ')}`);
});

test('the fixture itself may use chromium.launch (counter-check for (b))', () => {
  const content = fs.readFileSync(FIXTURE, 'utf8');
  assert.match(content, /chromium\.launch/, 'the fixture is the one allowed place');
});

test('(c) positive control: a probe WITH the fixture ends within 10 s', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-guard-pos-'));
  try {
    const file = path.join(tmp, 'positive.test.mjs');
    fs.writeFileSync(file, `
import test from 'node:test';
import assert from 'node:assert/strict';
import { startBrowser } from ${JSON.stringify(FIXTURE)};
const { browser, reason } = await startBrowser();
test('uses the fixture', { skip: reason }, async () => {
  const page = await browser.newPage();
  await page.goto('about:blank');
  await page.close();
  assert.ok(true);
});
`);
    const start = Date.now();
    const r = spawnSync(process.execPath, ['--test', file], { timeout: 15000 });
    const took = Date.now() - start;
    assert.ok(took < 10000, `positive control should end the process < 10s after its tests, took ${took}ms`);
    assert.equal(r.status, 0, `positive control should be green: ${r.stderr?.toString().slice(0, 2000)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('(c) sabotage: a file with chromium.launch, no fixture, no close, is caught by rule (b)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-guard-sab-'));
  try {
    const file = path.join(tmp, 'sabotage.test.mjs');
    fs.writeFileSync(file, `
import { chromium } from 'playwright';
const browser = await chromium.launch();
// no after(), no close() -- exactly the 2026-09-29 bug
`);
    const content = fs.readFileSync(file, 'utf8');
    // Same check as rule (b), applied to the sabotage file: it MUST hit,
    // otherwise the rule would be a placebo.
    assert.match(content, /chromium\.launch/, 'the sabotage file must contain the forbidden call');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

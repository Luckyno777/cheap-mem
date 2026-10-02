// test/board-tempo-cm-browser.test.mjs — the page side of the first answer
// (task board-tempo-cm, 2026-10-02; the sibling's test/dash-tempo-lm-browser.test.mjs).
//
// Promises (a real Chromium against a real `mem serve`):
//   1. While only the head is loaded the start page shows the SERVER's
//      counter (400) and says "x of 400 entries loaded" — never the length of
//      the part as if it were the whole. Afterwards all 400 are loaded.
//   2. A part that is still being built (`building`) is not shown as an
//      empty list: the banner stays, no error panel, and the page asks again.
//   3. Before the first build (placeholder) every view says "state unknown" —
//      never "this memory holds no entry yet".
//   4. A light head (store too large for the full build) draws every view
//      without a script error and says that only a head is there.
// Positive controls: the held request WAS asked for; the probe store really
// has more entries than the head carries.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const { browser, reason } = await startBrowser();
const SKIP = reason;

function store(lines) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-btempo-b-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'btempo', participants: { alex: { human: true }, bot: {} }, language: 'en',
  }));
  const rows = [];
  for (let i = 0; i < lines; i += 1) {
    rows.push(JSON.stringify({
      id: `s${i.toString(36)}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      title: `Entry ${i} about queue`, text: `plain body ${i} ${'x'.repeat(lines > 1000 ? 200 : 20)}`, tags: ['queue'],
    }));
  }
  fs.writeFileSync(path.join(r, 'global', 'learnings.jsonl'), `${rows.join('\n')}\n`);
  return r;
}

async function withServer(root, env, fn) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off',
    CHEAP_MEM_SERVE_TEMPO_TEST_MS: '250', ...env,
  });
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((res) => { server.closeAllConnections?.(); server.close(res); });
  }
}

const metric = (page, label) => page.evaluate((l) => {
  const m = [...document.querySelectorAll('#screen .metrics > *')].find((x) => x.textContent.includes(l));
  return m ? m.textContent : null;
}, label);

test('browser: the head shows the server counter and "x of 400 loaded"; afterwards all 400 are loaded', { skip: SKIP }, async () => {
  const root = store(400);
  await withServer(root, {}, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let asked = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    await page.route('**/dashboard/part.json?part=entries*', async (route) => { asked += 1; await gate; await route.continue(); });
    try {
      await page.goto(`${base}/dashboard`);
      await waitReady(page);
      await page.waitForFunction(() => /\d+ of 400 entries loaded/.test(document.querySelector('#entriesLoad')?.textContent || ''), null, { timeout: 20000 });
      const banner = await page.textContent('#entriesLoad');
      const loaded = Number(/(\d+) of 400/.exec(banner)[1]);
      assert.ok(loaded < 400 && loaded >= 100, `the head loaded ${loaded} entries (positive control: fewer than the store has)`);
      assert.match(await metric(page, 'Knowledge in view'), /400/, 'the counter must be the server\'s 400, not the length of the part');
      assert.ok(asked >= 1, 'positive control: the page did ask for the rest');
      assert.equal(await page.evaluate(() => entries.length), loaded);
      release();
      await page.waitForFunction(() => !document.querySelector('#entriesLoad') && entries.length === 400, null, { timeout: 20000 });
      assert.match(await metric(page, 'Knowledge in view'), /400/);
      assert.deepEqual(errors, []);
    } finally { release(); await page.close(); }
  });
});

test('browser: a part that is still being built is no empty list — the banner stays, no error, it asks again', { skip: SKIP }, async () => {
  const root = store(400);
  await withServer(root, {}, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    let building = 2;
    let asked = 0;
    await page.route('**/dashboard/part.json?part=entries*', async (route) => {
      asked += 1;
      if (building > 0) {
        building -= 1;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'unknown', part: 'entries', data: null, building: true, reason: 'list not built yet' }) });
      } else await route.continue();
    });
    try {
      await page.goto(`${base}/dashboard`);
      await waitReady(page);
      await page.waitForFunction(() => /of 400 entries loaded/.test(document.querySelector('#entriesLoad')?.textContent || ''));
      assert.equal(await page.evaluate(() => document.body.textContent.includes('Not loaded')), false, '"building" was shown as an error');
      assert.equal(await page.evaluate(() => entries.length > 0), true, 'the head entries vanished');
      await page.waitForFunction(() => entries.length === 400 && !document.querySelector('#entriesLoad'), null, { timeout: 30000 });
      assert.ok(asked >= 3, `asked ${asked} times — it did not ask again after "building"`);
    } finally { await page.close(); }
  });
});

test('browser: before the first build every view says "state unknown", never "holds no entry yet"', { skip: SKIP }, async () => {
  const root = store(400);
  await withServer(root, {}, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let first = true;
    await page.route('**/dashboard.json', async (route) => {
      if (first) {
        first = false;
        const body = { ...dashboardData.placeholder({ title: 't' }), cache: { built_at: new Date().toISOString(), build_ms: 0, fresh: false, refreshing: true, reason: 'first build since the start is running', source: 'placeholder' } };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      } else await route.continue();
    });
    try {
      await page.goto(`${base}/dashboard#knowledge/entries`);
      await page.waitForFunction(() => /State unknown/.test(document.querySelector('#screen')?.textContent || ''), null, { timeout: 20000 });
      const text = await page.textContent('#screen');
      assert.doesNotMatch(text, /holds no entry yet|No entry|Nothing found/, 'a view over no data said "no entry"');
      await page.evaluate(() => { location.hash = '#home'; });
      await page.waitForFunction(() => /first state is being built/.test(document.querySelector('#screen')?.textContent || ''), null, { timeout: 20000 });
      assert.equal(await page.evaluate(() => !!document.querySelector('#screen .metrics')), false, 'a figure was shown without a measurement');
      // then the real state arrives by itself
      await page.waitForFunction(() => !!document.querySelector('#screen .metrics'), null, { timeout: 30000 });
      assert.match(await metric(page, 'Knowledge in view'), /400/);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});

test('browser: a light head draws every view without a script error and says it is only a head', { skip: SKIP }, async () => {
  const root = store(4000); // over 0.5 MB -> light head with CHEAP_MEM_SERVE_FULL_BUILD_MB=0.5
  await withServer(root, { CHEAP_MEM_SERVE_FULL_BUILD_MB: '0.5' }, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${base}/dashboard`);
      await waitReady(page);
      await page.waitForFunction(() => /only the counters and the newest entries|Only counters/.test(document.body.textContent) && !!document.querySelector('#screen .metrics'), null, { timeout: 60000 });
      assert.match(await metric(page, 'Knowledge in view'), /4,000/);
      const routes = await page.evaluate(() => Object.entries(sections).flatMap(([area, s]) => (s.tabs || []).map(([tab]) => `${area}/${tab}`)));
      assert.ok(routes.length > 20, `only ${routes.length} routes found — the probe sees too little`);
      const broken = [];
      for (const route of routes) {
        await page.evaluate((r) => { location.hash = '#' + r; }, route);
        await page.waitForTimeout(60);
        if (await page.evaluate(() => /View cannot be drawn/.test(document.querySelector('#screen')?.textContent || ''))) broken.push(route);
      }
      assert.deepEqual(errors, [], 'script errors while drawing views over a light head');
      assert.deepEqual(broken, [], 'views that could not be drawn over a light head');
    } finally { await page.close(); }
  });
});

// test/atlas-pass-cm-browser.test.mjs — the page side of the condensed atlas
// (task atlas-pass-cm, 2026-10-02; the sibling's
// test/dash-tempo2-lm-browser.test.mjs).
//
// Promises (a real Chromium against a real `mem serve` over a store the full
// build does not handle, CHEAP_MEM_SERVE_FULL_BUILD_MB=0.2):
//   1. The 3D atlas is condensed: topics with the server's counters; NO
//      request for atlas pages before the page zooms in.
//   2. Zooming into a topic loads its first 60 entries; "Load 60 more" loads
//      120 — and the figure says "x of N entries loaded" with the server's N.
//   3. A script error anywhere in this flow fails the probe.
// Positive control: a small store keeps the full view (no `condensed`, no
// atlas request, every entry in the net).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startBrowser, waitReady } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const { browser, reason } = await startBrowser();
const SKIP = reason;
const THEMES = ['queue', 'billing', 'auth', 'cache'];

function store(n) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-apass-b-'));
  made.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'apass', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(JSON.stringify({
      id: `s${i.toString(36)}`, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      title: `Entry ${i}`, text: `body ${i} ${'x'.repeat(n > 1000 ? 200 : 20)}`, tags: [THEMES[i % 4]],
    }));
  }
  fs.writeFileSync(path.join(r, 'global', 'learnings.jsonl'), `${rows.join('\n')}\n`);
  return r;
}

async function withServer(root, env, fn) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0',
    CHEAP_MEM_SERVE_TEMPO_TEST_MS: '250', ...env,
  });
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((res) => { server.closeAllConnections?.(); server.close(res); });
  }
}

test('browser: the atlas is condensed, asks for no page before zooming, then loads 60 and 120', { skip: SKIP }, async () => {
  const root = store(4000);
  await withServer(root, { CHEAP_MEM_SERVE_FULL_BUILD_MB: '0.2' }, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const atlasRequests = [];
    page.on('request', (q) => { if (/part=atlas/.test(q.url())) atlasRequests.push(q.url()); });
    try {
      await page.goto(`${base}/dashboard#home`);
      await waitReady(page);
      await page.waitForFunction(() => !!document.querySelector('#screen .metrics') && D?.atlas?.condensed === true && D?.cache?.source === 'build', null, { timeout: 90000 });
      await page.evaluate(() => { state.graphMode = 'topics'; render(); });
      await page.waitForFunction(() => document.querySelector('#brain')?.dataset.condensed === '1', null, { timeout: 60000 });
      assert.equal(await page.evaluate(() => graphAPI.model.groups.length), 4, 'one node per topic');
      assert.equal(await page.evaluate(() => graphAPI.model.groups.map((g) => countOf(g)).reduce((a, b) => a + b, 0)), 4000, 'the counters are the server\'s');
      assert.deepEqual(atlasRequests, [], 'a page of the atlas was asked for before zooming in');
      await page.evaluate(() => graphAPI.focus('tag:queue'));
      await page.waitForFunction(() => /^60 of 1,000 entries loaded/.test(document.querySelector('#atlasState')?.textContent || ''), null, { timeout: 30000 });
      assert.ok(atlasRequests.length >= 1, 'positive control: zooming in DID ask for the page');
      await page.click('.atlas-more');
      await page.waitForFunction(() => /^120 of 1,000 entries loaded/.test(document.querySelector('#atlasState')?.textContent || ''), null, { timeout: 30000 });
      assert.equal(await page.evaluate(() => graphAPI.model.groups.find((g) => g.key === 'tag:queue').members.length), 120);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});

test('browser: positive control — a small store keeps the full view (no condensing, no atlas request)', { skip: SKIP }, async () => {
  const root = store(200);
  await withServer(root, {}, async (base) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const atlasRequests = [];
    page.on('request', (q) => { if (/part=atlas/.test(q.url())) atlasRequests.push(q.url()); });
    try {
      await page.goto(`${base}/dashboard#home`);
      await waitReady(page);
      await page.waitForFunction(() => !!document.querySelector('#screen .metrics') && entries.length === 200, null, { timeout: 60000 });
      await page.evaluate(() => { state.graphMode = 'topics'; render(); });
      await page.waitForFunction(() => !!document.querySelector('#brain')?.dataset.units, null, { timeout: 60000 });
      assert.equal(await page.evaluate(() => document.querySelector('#brain').dataset.condensed), undefined);
      assert.equal(await page.evaluate(() => graphAPI.model.records.length), 200, 'every entry is in the net');
      assert.deepEqual(atlasRequests, []);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/board-parity-package-browser-cm.test.mjs — the "Load JSON package"
// button in a real browser (parity with lucky-mem's projektpaket, 2026-10-01).
//
//   * the click starts a download (Content-Disposition file name),
//   * the number in the content preview is the number in the package header,
//   * RED on the fixed base commit deca5ad7 (its dashboard.js through
//     page.route): the old button only shows a toast, no download.
/* global document, location -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { startBrowser, waitReady } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const OLD = 'deca5ad713f1dc7f3ec05cf21e0d5cf1ebb22a3b';

const { browser, reason: why } = await startBrowser();
const NEEDS = why ? { skip: why } : {};

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

async function startServer() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-package-browser-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'pkg', participants: { alex: { human: true } }, language: 'en' }));
  memory.projectInit(r, 'demo'); // logEntry no longer creates a project
  for (let i = 0; i < 4; i++) memory.logEntry(r, 'learning', { title: `Global ${i}`, text: 'x' });
  for (let i = 0; i < 7; i++) memory.logEntry(r, 'learning', { title: `Demo ${i}`, text: 'x' }, { project: 'demo' });
  const mod = await import(`${pathToFileURL(SERVE).href}?pkgb=${Math.random()}`);
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}

async function openExport(base, oldScript = null) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  try {
    const page = await ctx.newPage();
    if (oldScript) await page.route(/\/dashboard\/app\.js(\?|$)/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: oldScript }));
    await page.goto(base + '/dashboard', { waitUntil: 'load', timeout: 60000 });
    await waitReady(page);
    await page.evaluate(() => { location.hash = '#sources/export'; });
    await page.waitForSelector('#exportProject');
    await page.selectOption('#exportProject', 'demo');
    await page.dispatchEvent('#exportProject', 'change');
    return { ctx, page };
  } catch (e) { await ctx.close(); throw e; }
}

test(`RED on the fixed old state (${OLD.slice(0, 8)}): the button gives no download (positive control: the button is there)`, NEEDS, async (t) => {
  let old;
  try { old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/dashboard.js`], { encoding: 'utf8', maxBuffer: 16 << 20 }); } catch {
    t.skip(`commit ${OLD} not reachable — red proof unknown, not green`);
    return;
  }
  const s = await startServer();
  let ctx = null;
  try {
    const opened = await openExport(s.base, old);
    ctx = opened.ctx;
    const page = opened.page;
    assert.equal(await page.locator('#screen button[data-action="export-json"]').count(), 1, 'positive control');
    const dl = page.waitForEvent('download', { timeout: 4000 }).then(() => true, () => false);
    await page.locator('#screen button[data-action="export-json"]').click({ force: true });
    assert.equal(await dl, false, 'RED: the old state downloads nothing');
  } finally { await ctx?.close(); await s.stop(); }
});

test('GREEN: the click downloads the package; preview number = package header number', NEEDS, async () => {
  const s = await startServer();
  let ctx = null;
  try {
    const opened = await openExport(s.base);
    ctx = opened.ctx;
    const page = opened.page;
    await page.waitForSelector('#exportCount');
    const shown = Number((await page.textContent('#exportCount')).replace(/\D/g, ''));
    assert.equal(shown, 11, 'demo (7) plus the global foundations (4)');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#screen button[data-action="export-json"]')]);
    assert.match(dl.suggestedFilename(), /^cheap-mem-demo-\d{4}-\d{2}-\d{2}\.json$/);
    const pkg = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
    assert.equal(pkg.header.counts.entries, shown);
    assert.equal(pkg.entries.length, shown);
    // Switch off the global foundations: preview and package follow the same selection.
    await page.uncheck('#exportGlobal');
    await page.dispatchEvent('#exportGlobal', 'change');
    await page.waitForFunction(() => document.querySelector('#exportCount')?.textContent.trim() === '7');
  } finally { await ctx?.close(); await s.stop(); }
});

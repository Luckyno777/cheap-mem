// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/entries-page.test.mjs — D3b: the list page the SERVER renders.
//
// Replaces "raw JSON in a new tab" by `GET /entries` (src/entries-page.mjs):
// same filters, same cursor, same `pages.page()` as `/entries.json`.
// What is proven here: (1) the four states are visible and each has its
// own tone, (2) an empty list is not an error, (3) the page loads nothing
// from outside and runs no script, (4) the Host check, the CSP and "no
// CORS header" hold on the new route, (5) in a real browser the state
// and the rows are VISIBLE (getComputedStyle, not the DOM string), (6)
// the dashboard's Entries view offers the page in a new tab.
//
// Red-proof (hand-run, 2026-09-30, on the pinned old commit 241a8aa):
// the file run against the tree before D3b — /entries answers 404, the
// module does not exist. Positive controls sit in the tests below.
/* global document, getComputedStyle -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as entriesPage from '../src/entries-page.mjs';
import { startBrowser, waitReady } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const CSS = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.css'), 'utf8');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-entries-page-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'pagetest', participants: ['someone'], language: 'en' }));
  return r;
}
function events(root, n) {
  const p = path.join(root, 'global', 'events.jsonl');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, Array.from({ length: n }, (_, i) => JSON.stringify({
    id: `e${String(i).padStart(8, '0')}`, ts: `2026-09-${String(20 - i).padStart(2, '0')}T10:00:00Z`,
    title: `Event number ${i}`, text: 'ordinary content',
  })).join('\n') + '\n');
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
const q = (s) => new URLSearchParams(s);
const tone = (html) => /class="badge ([a-z]*)" id="state"/.exec(html)?.[1];

async function start(root, env = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?entries=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '', ...env });
  const port = server.address().port;
  return { mod, port, stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }) };
}
function rawGet(port, p, host, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

// --- the four states ---------------------------------------------------------

test('four states, each with its own tone: ok, warning, unknown (bad filter), error (bad cursor)', () => {
  const r = world();
  try {
    events(r, 3);
    const ok = entriesPage.render(r, q(''));
    assert.equal(ok.status, 200);
    assert.equal(tone(ok.html), 'good');
    assert.match(ok.html, /Event number 0/);

    fs.appendFileSync(path.join(r, 'global', 'events.jsonl'), '{ this is not JSON\n');
    const warn = entriesPage.render(r, q(''));
    assert.equal(warn.status, 200);
    assert.equal(tone(warn.html), 'warn');
    assert.match(warn.html, /unreadable/, 'the reason is not shown');
    assert.match(warn.html, /Event number 0/, 'the readable rows must still be shown');

    const unknown = entriesPage.render(r, q('type=nonsense'));
    assert.equal(unknown.status, 400);
    assert.equal(tone(unknown.html), 'unknown');
    assert.match(unknown.html, /unknown type/);

    const error = entriesPage.render(r, q('after=not-a-cursor'));
    assert.equal(error.status, 500);
    assert.equal(tone(error.html), 'bad');

    assert.equal(new Set([tone(ok.html), tone(warn.html), tone(unknown.html), tone(error.html)]).size, 4);
    assert.match(CSS, /\.badge\.unknown\{/, 'unknown has no CSS rule of its own');
    assert.match(CSS, /\.badge\.good\{/); assert.match(CSS, /\.badge\.warn\{/); assert.match(CSS, /\.badge\.bad\{/);
  } finally { gone(r); }
});

test('positive control: collapsing unknown into the warning tone makes the probe fail', () => {
  const r = world();
  try {
    const unknown = entriesPage.render(r, q('type=nonsense')).html.replace('class="badge unknown"', 'class="badge warn"');
    assert.equal(tone(unknown), 'warn', 'the collapsed page still passes as unknown');
  } finally { gone(r); }
});

test('an empty list is not an error: state ok, status 200, an own sentence, no reason of failure', () => {
  const r = world();
  try {
    for (const query of ['', 'project=global&type=event']) {
      const res = entriesPage.render(r, q(query));
      assert.equal(res.status, 200, query);
      assert.equal(tone(res.html), 'good', query);
      assert.match(res.html, /id="empty"/);
      assert.doesNotMatch(res.html, /class="note"/, 'an empty list carries an error note');
    }
    events(r, 2);
    const none = entriesPage.render(r, q('q=zzzzqqqq-nothing'));
    assert.equal(none.status, 200);
    assert.equal(tone(none.html), 'good');
    assert.match(none.html, /id="empty"/);
  } finally { gone(r); }
});

test('filters and cursor: the next link carries type, project, q and the cursor; page 2 continues without a gap', () => {
  const r = world();
  try {
    events(r, 5);
    const p1 = entriesPage.render(r, q('n=2&type=event'));
    const next = /id="next"[^>]*href="([^"]+)"/.exec(p1.html)?.[1];
    assert.ok(next, 'no next link on a page with more rows');
    const href = next.replace(/&amp;/g, '&');
    assert.match(href, /^\/entries\?/); assert.match(href, /type=event/); assert.match(href, /n=2/); assert.match(href, /after=/);
    const p2 = entriesPage.render(r, new URL(href, 'http://x').searchParams);
    assert.match(p1.html, /Event number 0/); assert.match(p1.html, /Event number 1/);
    assert.doesNotMatch(p1.html, /Event number 2/);
    assert.match(p2.html, /Event number 2/); assert.match(p2.html, /Event number 3/);
    assert.doesNotMatch(p2.html, /Event number 1\b/);
    const last = entriesPage.render(r, q('n=50'));
    assert.doesNotMatch(last.html, /id="next"/, 'a next link on the last page');
  } finally { gone(r); }
});

test('the filter text is escaped: no markup comes back out of the query', () => {
  const r = world();
  try {
    const res = entriesPage.render(r, q('q=' + encodeURIComponent('"><script>alert(1)</script>')));
    assert.doesNotMatch(res.html, /<script/i);
  } finally { gone(r); }
});

// --- nothing from outside ----------------------------------------------------

test('the page loads nothing from outside and runs no script', () => {
  const r = world();
  try {
    events(r, 2);
    const { html } = entriesPage.render(r, q(''));
    assert.doesNotMatch(html, /<script/i, 'a script on the list page');
    assert.doesNotMatch(html, /https?:\/\//, 'an absolute URL on the list page');
    const targets = [...html.matchAll(/(?:src|href|action)\s*=\s*"([^"]*)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:'));
    assert.ok(targets.length >= 3);
    for (const t of targets) assert.match(t, /^\/[a-z]/, `outside or relative target: ${t}`);
    assert.doesNotMatch(html, /@import|url\(\s*['"]?https?:/i);
  } finally { gone(r); }
});

// --- the server ----------------------------------------------------------------

test('the server: CSP with script-src self, no CORS header even with a foreign Origin, Host check, token door', async () => {
  const r = world();
  events(r, 2);
  const s = await start(r, { CHEAP_MEM_SERVE_HOSTS: 'mem.example.org' });
  try {
    const res = await rawGet(s.port, '/entries', `127.0.0.1:${s.port}`, { origin: 'https://evil.example' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(String(res.headers['content-security-policy']), /script-src 'self'/);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
    assert.equal(res.headers['access-control-allow-credentials'], undefined);
    assert.match(res.body, /Event number 0/);
    assert.ok(s.mod.HOST_GUARDED.includes('/entries'), '/entries is not in HOST_GUARDED');
    assert.ok(s.mod.HOST_GUARDED.includes('/entries.json'), '/entries.json is not in HOST_GUARDED');
    for (const p of ['/entries', '/entries.json']) {
      assert.equal((await rawGet(s.port, p, 'evil.example')).status, 403, `${p} served a foreign host`);
      assert.notEqual((await rawGet(s.port, p, 'mem.example.org')).status, 403, `${p} refused a listed host`);
      assert.notEqual((await rawGet(s.port, p, `localhost:${s.port}`)).status, 403, `${p} refused loopback`);
    }
    assert.ok(s.mod.PATHS.includes('/entries'));
  } finally { await s.stop(); gone(r); }
  const r2 = world();
  const s2 = await start(r2, { CHEAP_MEM_SERVE_TOKEN: 'probe-token-entries' });
  try {
    assert.equal((await rawGet(s2.port, '/entries', `127.0.0.1:${s2.port}`)).status, 404, 'the list page is visible without the token');
  } finally { await s2.stop(); gone(r2); }
});

test('the JSON twin still answers the same list (the dashboard palette reads it)', async () => {
  const r = world();
  events(r, 2);
  const s = await start(r);
  try {
    const res = await rawGet(s.port, '/entries.json?n=8', `127.0.0.1:${s.port}`);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).entries.length, 2);
  } finally { await s.stop(); gone(r); }
});

// --- in a real browser -----------------------------------------------------------

const { browser, reason: why } = await startBrowser();
const NEEDS = why ? { skip: why } : {};

test('browser: the state badge and the rows are visible, unknown looks different from warning', NEEDS, async () => {
  const r = world();
  events(r, 3);
  const s = await start(r);
  const page = await browser.newPage();
  try {
    const base = `http://127.0.0.1:${s.port}`;
    await page.goto(`${base}/entries`, { waitUntil: 'load' });
    const look = (sel) => page.evaluate((x) => {
      const el = document.querySelector(x); if (!el) return null;
      const cs = getComputedStyle(el); const b = el.getBoundingClientRect();
      return { display: cs.display, visibility: cs.visibility, w: b.width, h: b.height, color: cs.color, borderStyle: cs.borderStyle };
    }, sel);
    const badge = await look('#state');
    assert.ok(badge && badge.display !== 'none' && badge.visibility === 'visible' && badge.w > 0 && badge.h > 0, `state badge not visible: ${JSON.stringify(badge)}`);
    const row = await look('.list .row');
    assert.ok(row && row.display !== 'none' && row.h > 0, 'rows not visible');
    assert.equal(await page.locator('.list .row').count(), 3);

    await page.goto(`${base}/entries?type=nonsense`, { waitUntil: 'load' });
    const unknown = await look('#state');
    assert.ok(unknown && unknown.w > 0 && unknown.h > 0, 'unknown badge not visible');
    assert.equal(unknown.borderStyle, 'dashed', 'unknown does not look like unknown');

    fs.appendFileSync(path.join(r, 'global', 'events.jsonl'), '{ not json\n');
    await page.goto(`${base}/entries`, { waitUntil: 'load' });
    const warn = await look('#state');
    assert.notEqual(warn.color, unknown.color, 'warning and unknown share a colour');
    assert.notEqual(warn.borderStyle, 'dashed');

    await page.goto(`${base}/entries?project=global&type=decision`, { waitUntil: 'load' });
    const empty = await look('#empty');
    assert.ok(empty && empty.h > 0, 'the empty-list sentence is not visible');
  } finally { await page.close(); await s.stop(); gone(r); }
});

test('browser: the dashboard offers the list page in a new tab', NEEDS, async () => {
  const r = world();
  events(r, 2);
  const s = await start(r);
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${s.port}/dashboard#knowledge/entries`, { waitUntil: 'domcontentloaded' });
    await waitReady(page);
    await page.waitForSelector('#entriesPageLink', { timeout: 15000 });
    const a = await page.evaluate(() => {
      const el = document.querySelector('#entriesPageLink'); const b = el.getBoundingClientRect();
      return { href: el.getAttribute('href'), target: el.target, rel: el.rel, h: b.height, display: getComputedStyle(el).display };
    });
    assert.equal(a.target, '_blank'); assert.match(a.rel, /noopener/);
    assert.match(a.href, /^\/entries/);
    assert.ok(a.h > 0 && a.display !== 'none', 'the link is not visible');
  } finally { await page.close(); await s.stop(); gone(r); }
});

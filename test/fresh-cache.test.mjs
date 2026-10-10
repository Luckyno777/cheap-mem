// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/fresh-cache.test.mjs - a browser page never pays for the rebuild of the cached state
// (job fresh-cm, 2026-10-10; mirrors lucky-mem's test/renderlast-zwischenspeicher.test.mjs, commits 8dff252b / 0d70358d).
//
// **Cause (measured in lucky-mem; the code is the same here).** The view server's cache
// (src/dashboard-cache.mjs) keeps a built state for `TTL_MS` = 60 s, counted from the END of the build. After
// that the next request rebuilds it - for a small store (last build under `SYNC_UP_TO_MS` = 1 s, every probe)
// SYNCHRONOUSLY, inside the request, in the same process as the Playwright client. It is the page's own
// `/dashboard.json` request that pays for it, so the rebuild stands inside the deadline of `waitReady` (and holds
// the client's event loop). Quiet it costs ~0.8 s here (cold build, measured 2026-10-10: 819 / 897 ms), under suite
// load a multiple. `startView` warms the server at the start, which covers one minute only; a file with several
// browser probes runs longer (palette-fulltext: eight probes, two minutes).
//
// This file guards it WITHOUT a browser, without a clock threshold and without waiting: the server's clock
// (`Date.now`, read on every call) is set 61 s ahead; whether a request rebuilt is in `cache.built_at` of the answer.
//   1. POSITIVE CONTROL: without `fresh()` the page's request rebuilds the state after 61 s.
//   2. With `fresh()` first, THAT request pays for the rebuild and the page's request finds the state unchanged.
// Limit of the claim: in the worker lane (a build over 1 s, i.e. under load) the rebuild does not freeze the client;
// there the request costs nothing and helps nothing. The probe switch below forces the synchronous lane so the
// file does not depend on the load.
// Red proof: probe 2 is red without the `fresh()` call (probe 1 is exactly that case and green, because it asserts
// the opposite); the ratchet that every navigation calls it is in test/browser-fresh.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { startView } from './fixture/browser.mjs';

// The lane "last build under syncUpToMs" (1 s) is the one of every quiet probe. Under load a build takes longer
// and the cache builds in the background worker; which lane a probe runs in would depend on the load. This file
// forces the synchronous lane with the probe switch (syncUpToMs = one hour).
const SYNC = {
  CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '',
  CHEAP_MEM_SERVE_CACHE_SYNC_TEST_MS: String(3600 * 1000),
};

const roots = [];
test.after(() => { for (const r of roots) removeTree(r); });
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fresh-cache-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'fresh', participants: { alex: { human: true } }, language: 'en' }));
  for (let i = 0; i < 3; i++) memory.logEntry(r, 'learning', { title: `Note ${i}`, text: `Body ${i}`, tags: ['x'] }, { now: new Date(Date.parse('2026-09-01T09:00:00Z') + i * 60e3) });
  return r;
}

const realNow = Date.now;
/** Set the process clock (and with it the server's) `ms` ahead; `back()` restores it. */
function clockAhead(ms) { Date.now = () => realNow() + ms; }
const back = () => { Date.now = realNow; };

/** What the page asks: /dashboard.json, and of it the cache part. */
async function state(base) {
  const b = await (await fetch(base + '/dashboard.json', { headers: { 'cache-control': 'no-store' } })).json();
  assert.ok(b.cache?.built_at, `no built_at in the answer: ${JSON.stringify(b.cache)}`);
  return b.cache;
}

test('POSITIVE CONTROL: after 61 s the page\'s request rebuilds the state (synchronously, inside the request)', async () => {
  const view = await startView(world(), SYNC);
  try {
    const warm = await state(view.base);
    assert.equal(warm.fresh, true);
    clockAhead(61000);
    const page = await state(view.base);
    assert.notEqual(page.built_at, warm.built_at, 'the page\'s request rebuilt the state (this is what stands in the deadline of waitReady)');
    assert.equal(page.refreshing, false, 'built synchronously, not in the background');
  } finally { back(); await view.stop(); }
});

test('with fresh() first, that call pays for the rebuild and the page\'s request builds nothing', async () => {
  const view = await startView(world(), SYNC);
  try {
    const warm = await state(view.base);
    clockAhead(61000);
    const byFresh = await view.fresh();
    assert.notEqual(byFresh?.built_at, warm.built_at, 'fresh() rebuilt the expired state');
    clockAhead(62000); // the page asks right after: far under the TTL
    const page = await state(view.base);
    assert.equal(page.built_at, byFresh.built_at, 'the page\'s request builds nothing: it finds the state fresh() built');
    assert.equal(page.fresh, true);
  } finally { back(); await view.stop(); }
});

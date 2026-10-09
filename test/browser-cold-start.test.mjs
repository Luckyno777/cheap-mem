// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/browser-cold-start.test.mjs - the view server of a browser probe is warm when the browser opens
// the page, ALWAYS (job browser-warm-cm, 2026-10-09; port of lucky-mem's test/browser-kaltstart.test.mjs).
//
// **Cause (chain 2026-10-09 16:33Z, "green after repeat": test/x3c-core-knowledge-status.test.mjs,
// "RED on the fixed old state ...", "page.waitForFunction: Timeout 30000ms exceeded.").** The 30 s is the
// deadline of `waitReady`; every other wait of that probe carries its own 15 s / 10 s. A timeout of the
// readiness wait is a page that stayed on its loading tile - not a probe that read too early (that class
// ends in a wrong value, like lucky-mem's termine-wahl). It is the first probe of the file, the one that
// pays the cold start: the file built its server itself, so the first `/dashboard.json` build, the part
// routes and the gzip of the page files ran inside the browser's own deadline - and server and Playwright
// client share ONE event loop. Four other files had `warmView` for exactly this; x3c and the rest had not.
// Now `startView` (test/fixture/browser.mjs) starts the server and warms it.
//
// This file guards that WITHOUT a browser and without a clock threshold:
//   1. POSITIVE CONTROL: a server started raw builds its state in the FIRST request (the cold cost exists).
//   2. `startView` hands the server back with the state already built; a further request builds nothing.
//   3. `startView` asks for the page, the state and every deferred part before it returns.
//   4. RATCHET: every browser file starts its view server through `startView`, except the list of files
//      that measure the cold state on purpose (it may only SHRINK); no raw `serve()` call in a browser
//      file beyond the pinned HTTP-only ones; no direct `warmView` call outside the fixture.
// Red proof: `MEM_PROBE_NO_WARMUP=1` turns probes 2 and 3 red; the fixed old state 23caaac895ed (no
// `startView`) has no function for 2 and 3 and fails the ratchet on 18 files. The browser-level proof
// (a first part request delayed by 16 s on the event loop: old x3c red with the exact signature above,
// new green) is in the job report.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import * as fixture from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const ENV = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' };

const roots = [];
test.after(() => { for (const r of roots) removeTree(r); });
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cold-start-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'cold', participants: { alex: { human: true } }, language: 'en' }));
  for (let i = 0; i < 3; i++) memory.logEntry(r, 'learning', { title: `Note ${i}`, text: `Body ${i}`, tags: ['x'] }, { now: new Date(Date.parse('2026-09-01T09:00:00Z') + i * 60e3) });
  return r;
}

/** When was the state built (ms since the epoch)? The same question the browser asks. */
async function builtAt(base) {
  const b = await (await fetch(base + '/dashboard.json', { headers: { 'cache-control': 'no-store' } })).json();
  const t = Date.parse(b.cache?.built_at);
  assert.ok(Number.isFinite(t), `no cache.built_at in the answer: ${JSON.stringify(b.cache)}`);
  return t;
}

test('POSITIVE CONTROL: a server started raw builds its state in the FIRST request', async () => {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?cold=${Math.random()}`);
  const { server } = await mod.serve(world(), ENV);
  try {
    const before = Date.now();
    const t = await builtAt(`http://127.0.0.1:${server.address().port}`);
    assert.ok(t >= before, `the state is built by the first request (it was built ${before - t} ms before it)`);
  } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); }
});

for (const [name, serveOpts] of [['default', undefined], ['allowWrites', { allowWrites: true }]]) {
  test(`startView (${name}) returns the server WARM: the state is built before the browser phase, a further request builds nothing`, async () => {
    assert.equal(typeof fixture.startView, 'function', 'test/fixture/browser.mjs has no startView');
    const view = await fixture.startView(world(), ENV, { serveOpts });
    try {
      const browserBegins = Date.now();
      const first = await builtAt(view.base);
      const second = await builtAt(view.base);
      assert.ok(first <= browserBegins, `the state was built ${first - browserBegins} ms into the browser phase: the cold cost sits in the browser deadline again`);
      assert.equal(second, first, 'a further request builds nothing');
    } finally { await view.stop(); await view.stop(); } // stop() can be called twice
  });
}

/** Every request any http server of this process receives is pushed on `into`; the returned function undoes it. */
function recordRequests(into) {
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function hooked(ev, req, ...rest) {
    if (ev === 'request' && req?.url) into.push(req.url);
    return emit.call(this, ev, req, ...rest);
  };
  return () => { http.Server.prototype.emit = emit; };
}

test('startView asks for the page, the state and every deferred part before it returns', async () => {
  const asked = [];
  const stopRecording = recordRequests(asked);
  let view;
  try { view = await fixture.startView(world(), ENV); } finally { stopRecording(); }
  try {
    const answer = await (await fetch(view.base + '/dashboard.json')).json();
    const parts = Object.values(answer.parts || {}).map((p) => p.path).filter(Boolean);
    assert.ok(parts.length >= 3, `positive control: the state names ${parts.length} deferred parts`);
    assert.ok(asked.includes('/dashboard'), 'the page itself was not asked for');
    assert.ok(asked.includes('/dashboard.json'), 'the state was not asked for');
    assert.deepEqual(parts.filter((p) => !asked.includes(p)), [], 'deferred parts startView did not warm');
  } finally { await view.stop(); }
});

// --- Ratchet ------------------------------------------------------------------

const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const code = (f) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
/** Test files that start a Chromium. */
const browserFiles = () => fs.readdirSync(HERE).filter((f) => f.endsWith('.test.mjs') && f !== 'browser-cold-start.test.mjs' && /startBrowser|lazyBrowser|launchBrowser/.test(code(f))).sort();
const startsServer = (f) => /\.serve\(|mem-serve/.test(code(f));
const rawServes = (f) => (code(f).match(/\.serve\(/g) || []).length;

// Files that start the view server themselves (cold) ON PURPOSE, each with its reason. The list may only SHRINK.
const COLD_ON_PURPOSE = {
  'board-tempo-cm-browser.test.mjs': 'measures the first, cold answer of the server: probe 1 needs the HEAD state (fewer entries than the store) '
    + 'before the full build, probes 3 and 4 the placeholder and the compact build as the first state; a warmed server has all of that behind it '
    + 'and the probes would have nothing left to measure.',
};
// Raw `serve()` calls left in warm browser files, each for a probe WITHOUT a browser (HTTP door, route checks). Pinned, never grows.
const HTTP_ONLY_SERVES = { 'core-name.test.mjs': 1, 'entries-page.test.mjs': 1, 'gold-verdict.test.mjs': 1 };

test('Ratchet: every browser file that starts a view server uses startView - except the cold-on-purpose list', () => {
  const own = browserFiles().filter((f) => startsServer(f) && !code(f).includes('startView('));
  const unlisted = own.filter((f) => !(f in COLD_ON_PURPOSE));
  assert.deepEqual(unlisted, [], 'these browser files start the view server themselves and cold (the first page pays the cold start inside the browser deadline, see the file header): use startView from test/fixture/browser.mjs');
});

test('Ratchet: the cold-on-purpose list only shrinks - at most one file, each with its reason, none that already warms', () => {
  assert.ok(Object.keys(COLD_ON_PURPOSE).length <= 1, `the list may only shrink (1 after job browser-warm-cm, now ${Object.keys(COLD_ON_PURPOSE).length})`);
  const files = fs.readdirSync(HERE);
  for (const [f, why] of Object.entries(COLD_ON_PURPOSE)) {
    assert.ok(files.includes(f), `${f} is gone: remove it from the list`);
    assert.ok(why.length >= 80, `${f}: no real reason why the server must stay cold`);
    assert.ok(!code(f).includes('startView('), `${f} warms already: remove it from the list`);
    assert.ok(browserFiles().includes(f) && startsServer(f), `${f} is no browser file with its own server any more: remove it from the list`);
  }
});

test('Ratchet: no raw serve() call in a warm browser file beyond the pinned HTTP-only ones; none in a shared fixture', () => {
  for (const f of browserFiles().filter((x) => !(x in COLD_ON_PURPOSE))) {
    assert.ok(rawServes(f) <= (HTTP_ONLY_SERVES[f] || 0), `${f}: ${rawServes(f)} raw serve() call(s), pinned ${HTTP_ONLY_SERVES[f] || 0}: a browser probe must start its server with startView`);
  }
  for (const [f, n] of Object.entries(HTTP_ONLY_SERVES)) assert.ok(rawServes(f) === n, `${f}: pinned ${n} raw serve() call(s) but has ${rawServes(f)}: update the pin (it may only shrink)`);
  for (const f of fs.readdirSync(path.join(HERE, 'fixture')).filter((x) => x.endsWith('.mjs') && x !== 'browser.mjs')) {
    assert.ok(!/\.serve\(/.test(fs.readFileSync(path.join(HERE, 'fixture', f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')), `test/fixture/${f} starts a server itself: use startView`);
  }
});

test('Ratchet: warmView is called only inside the fixture (startView) - a file that warms by hand can forget a part', () => {
  const direct = fs.readdirSync(HERE).filter((f) => f.endsWith('.mjs') && f !== 'browser-cold-start.test.mjs' && /\bwarmView\(/.test(code(f)));
  assert.deepEqual(direct, []);
});

test('the files of the chain flake (x3c) and of the earlier warm-up (five files) start through startView', () => {
  for (const f of ['x3c-core-knowledge-status.test.mjs', 'sphere-visible.test.mjs', 'appointment-dashboard-browser.test.mjs', 'dash-run-cm-browser.test.mjs', 'board-parity-package-browser-cm.test.mjs']) {
    assert.ok(code(f).includes('startView('), `${f}: does not call startView`);
    assert.equal(rawServes(f), 0, `${f}: starts the server itself (cold)`);
  }
});

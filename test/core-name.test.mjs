// test/core-name.test.mjs — the renameable core label (setting 'core-name',
// task kern-name/core-name, 2026-09-29; mirrors lucky-mem's
// test/kern-name.test.mjs).
//
// The central core in the knowledge space, the atlas eyebrow and the
// breadcrumb all showed the hardcoded text "CHEAP MEM" / "cheap-mem". This
// makes that text a user setting, through the SAME write path every other
// setting uses (src/console.mjs's SETTINGS, POST /setting, the console log)
// — never a second, parallel place to store it.
//
// Three layers, same as console.test.mjs's split: the module (`apply()`
// directly), the real HTTP route (door, origin, redirect, log), and the
// rendered page (Playwright — SKIPPED, not failed, without a Chromium).
/* global document, route -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as consolePage from '../src/console.mjs';
import { lazyBrowser, browserStartProbe, waitReady, startView } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-core-name-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}

// --- Module level: unset -> default, invalid rejected, set -> read back ---

test('unset: reads back the exact default text, nothing changes visually', () => {
  const r = memory();
  try {
    const s = consolePage.SETTINGS['core-name'].read(r);
    assert.equal(s.value, 'CHEAP MEM');
    assert.equal(s.source, 'default');
    assert.equal(s.set, false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the default never contains the sibling house\'s name', () => {
  // Brand guard (2026-09-29): whatever the default is, or ever becomes,
  // it must never contain "lucky" — that is what test/sphere-visible.test.mjs
  // checks on the rendered page; this checks it at the source.
  assert.doesNotMatch(consolePage.SETTINGS['core-name'].read(memory()).value, /lucky/i);
});

test('set, then read back through apply() — the same function every setting uses', () => {
  const r = memory();
  try {
    consolePage.apply(r, 'core-name', 'Team Atlas');
    const s = consolePage.SETTINGS['core-name'].read(r);
    assert.equal(s.value, 'Team Atlas');
    assert.equal(s.source, 'console');
    assert.equal(s.set, true);
    const log = consolePage.readLog(r);
    assert.equal(log[0].id, 'core-name');
    assert.equal(log[0].after, 'Team Atlas');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('trimmed: leading/trailing whitespace does not become part of the name', () => {
  const r = memory();
  try {
    consolePage.apply(r, 'core-name', '  Padded Core  ');
    assert.equal(consolePage.SETTINGS['core-name'].read(r).value, 'Padded Core');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('invalid values are REJECTED with the house reason format, and never stored', () => {
  const r = memory();
  try {
    for (const bad of ['', '   ', 'x'.repeat(33), 'line\nbreak', 'tab\tstop', 'bell\x07']) {
      assert.throws(() => consolePage.apply(r, 'core-name', bad),
        /Core name must be 1.32 printable characters/, `accepted: ${JSON.stringify(bad)}`);
    }
    // None of the rejected attempts left a trace.
    assert.equal(consolePage.SETTINGS['core-name'].read(r).value, 'CHEAP MEM');
    assert.equal(consolePage.readLog(r).length, 0);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('exactly 32 printable characters is accepted (the boundary, not one past it)', () => {
  const r = memory();
  try {
    const name = 'A'.repeat(32);
    consolePage.apply(r, 'core-name', name);
    assert.equal(consolePage.SETTINGS['core-name'].read(r).value, name);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('collect() carries the setting — a setting stored and never read is no setting', () => {
  const r = memory();
  try {
    consolePage.apply(r, 'core-name', 'Custom Core');
    const found = consolePage.collect(r).settings.find((s) => s.id === 'core-name');
    assert.ok(found, 'core-name missing from collect().settings');
    assert.equal(found.value, 'Custom Core');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --- The real HTTP route: door, origin, redirect, log --------------------

const DOOR = ['probe', 'door', String(process.pid)].join('-');
const WITH_DOOR = { authorization: `Bearer ${DOOR}` };

async function start(root, env = {}, opts = { allowWrites: true }) {
  const mod = await import(`${pathToFileURL(SERVE).href}?corename=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR,
    CHEAP_MEM_SERVE_HOST: '127.0.0.1',
    CHEAP_MEM_SERVE_PORT: '0',
    ...env,
  }, opts);
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}

test('POST /setting id=core-name really changes it, through the same route and log as raw-archive', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: 'core-name', value: 'Ops Hub' }).toString(),
    });
    assert.equal(res.status, 303);
    assert.equal(consolePage.SETTINGS['core-name'].read(r).value, 'Ops Hub');
    const log = consolePage.readLog(r);
    assert.equal(log[0].id, 'core-name');
    assert.equal(log[0].after, 'Ops Hub');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('POST /setting id=core-name with a control character is REFUSED (400), nothing stored', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: 'core-name', value: 'bad\nname' }).toString(),
    });
    assert.equal(res.status, 400);
    assert.equal(consolePage.SETTINGS['core-name'].read(r).value, 'CHEAP MEM');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('the write gate applies to core-name exactly like every other setting (403 without the flag)', async () => {
  const r = memory();
  const s = await start(r, {}, {});
  try {
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: 'core-name', value: 'Should Not Land' }).toString(),
    });
    assert.equal(res.status, 403);
    assert.equal(consolePage.SETTINGS['core-name'].read(r).value, 'CHEAP MEM');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

// --- The rendered page: label, eyebrow, breadcrumb, and the single select ---

// The browser starts on first use, not by a top-level await (a throwing start is a named red probe).
const B = lazyBrowser();
browserStartProbe(B);

async function withServer(coreName, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-core-name-page-'));
  try {
    spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
    spawnSync(process.execPath, [MEM, '--root', root, 'log', 'learning',
      '--title', 'a short note', '--text', 'kept for the network to draw something'], { encoding: 'utf8' });
    if (coreName != null) consolePage.apply(root, 'core-name', coreName);
    const view = await startView(root, {
      CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0',
      CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '',
    });
    try {
      return await run(view.base);
    } finally {
      await view.stop();
    }
  } finally {
    removeTree(root);
  }
}

async function openNetwork(base) {
  const { browser } = await B.get();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(base + '/dashboard', { waitUntil: 'load' });
  await waitReady(page);
  // route(), not `location.hash = …`: the app has no hashchange listener,
  // only route() (called from clicks) and popstate (browser back/forward).
  // Setting the hash alone changes the URL, not the rendered page.
  await page.evaluate(() => { route('knowledge/network'); });
  await page.waitForSelector('#graphBreadcrumb', { timeout: 10000 });
  await page.waitForTimeout(400);
  return page;
}

test('DEFAULT (unset): the core label, eyebrow and breadcrumb show today\'s fixed text', async (t) => {
  if (!(await B.need(t))) return;
  await withServer(null, async (base) => {
    const page = await openNetwork(base);
    try {
      const text = await page.evaluate(() => document.body.innerText);
      assert.match(text, /CHEAP MEM \/ NEURAL ATLAS/);
      assert.match(text, /cheap-mem \/ all projects/);
    } finally { await page.close(); }
  });
});

test('a custom core-name shows on the label, the eyebrow and the breadcrumb', async (t) => {
  if (!(await B.need(t))) return;
  await withServer('Team Atlas', async (base) => {
    const page = await openNetwork(base);
    try {
      const text = await page.evaluate(() => document.body.innerText);
      // The eyebrow is CSS text-transform: uppercase — innerText reflects
      // the rendered case, so this matches case-insensitively, same as the
      // "CHEAP MEM" default already relied on being upper in source.
      assert.match(text, /Team Atlas \/ NEURAL ATLAS/i);
      assert.match(text, /team-atlas \/ all projects/);
      // The old fixed core-label/eyebrow/breadcrumb text must be fully
      // replaced, not merely joined by the new one. (The house name still
      // appears elsewhere — the footer, the browser tab — untouched by
      // this setting; only these three spots are in scope.)
      assert.doesNotMatch(text, /CHEAP MEM \/ NEURAL ATLAS/i);
      assert.doesNotMatch(text, /cheap-mem \/ all projects/);
      // The 3D label itself, drawn via label()/esc() onto a real <button>.
      const rootLabelText = await page.evaluate(() => document.querySelector('.atlas-label.root-label')?.textContent || '');
      assert.match(rootLabelText, /Team Atlas/);
    } finally { await page.close(); }
  });
});

test('a value with markup is escaped, never injected as HTML (esc())', async (t) => {
  if (!(await B.need(t))) return;
  await withServer('<b>hack</b>', async (base) => {
    const page = await openNetwork(base);
    try {
      const hasTag = await page.evaluate(() => !!document.querySelector('.atlas-label.root-label b'));
      assert.equal(hasTag, false, 'the <b> tag was rendered as an element, not text');
      const text = await page.evaluate(() => document.body.innerText);
      assert.match(text, /<b>hack<\/b>/);
    } finally { await page.close(); }
  });
});

test('no duplicate button row: the mode buttons and "Reset view" button are gone', async (t) => {
  if (!(await B.need(t))) return;
  await withServer(null, async (base) => {
    const page = await openNetwork(base);
    try {
      const modeButtons = await page.evaluate(() => [...document.querySelectorAll('button[data-action="graph-mode"]')].length);
      assert.equal(modeButtons, 0, 'the removed per-mode buttons still render');
      const resetButtons = await page.evaluate(() =>
        [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Reset view').length);
      assert.equal(resetButtons, 0, 'the removed "Reset view" text button still renders');
      // The select and the ↺ toolbar control remain the (single) way in.
      const hasSelect = await page.evaluate(() => !!document.querySelector('#graphModeSelect'));
      assert.ok(hasSelect, 'graphModeSelect missing');
      const hasResetIcon = await page.evaluate(() => !!document.querySelector('button[data-action="graph-reset"]'));
      assert.ok(hasResetIcon, '↺ reset control missing');
    } finally { await page.close(); }
  });
});

test('every graph mode is reachable through #graphModeSelect, incl. "Further modes"', async (t) => {
  if (!(await B.need(t))) return;
  await withServer(null, async (base) => {
    const page = await openNetwork(base);
    try {
      const values = await page.evaluate(() => [...document.querySelectorAll('#graphModeSelect option')].map((o) => o.value));
      assert.deepEqual(values.sort(), ['overview', 'relations', 'storage', 'structure', 'topics', 'trail'].sort());
      const optgroups = await page.evaluate(() => [...document.querySelectorAll('#graphModeSelect optgroup')].map((g) => g.label));
      assert.ok(optgroups.includes('Further modes'), 'the "Further modes" optgroup is gone');
    } finally { await page.close(); }
  });
});


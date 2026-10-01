// test/render-load.test.mjs — the dashboard computes nothing nobody sees
// (parity with the sibling's renderlast 41ea1e12 + c669e71, dashboard part).
//
// Both draw loops (3D network, full-screen background shader) rest while the
// page is hidden or a dialog is open; after 60 s without input they slow to
// ~10 frames/s with a real-time step; input lifts them back to full rate.
// Real WebGL draw calls are counted in a real Chromium, not only rAF callbacks.
//
// Red proof: the pinned stand 8a24c64 (origin/main before this change) draws
// on with the palette open (a probe loads its client through page.route).
// Positive control: a visible, moving network draws on both stands.
// Without Chromium the browser probes are SKIPPED (not measured is not passed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBrowser, waitReady } from './fixture/browser.mjs';
import { COUNTER, measureLoad } from './fixture/renderload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD = '8a24c64b68f5549f4781af77ec4f65ef6fad4973';
const old = (f) => execFileSync('git', ['-C', REPO, 'show', `${OLD}:${f}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const DEADLINE = 5 * 60 * 1000;
// One redraw (data refresh, one network frame) is not a loop: up to 4 calls/s
// in the 3 s window count as rest; a running loop makes 15 to 90.
const NOISE = 4;

test('source: the old stand has no RESTING(), the new one has it on every draw loop', () => {
  assert.ok(!/RESTING\(\)/.test(old('assets/dashboard/dashboard.js')));
  const n = fs.readFileSync(path.join(REPO, 'assets/dashboard/dashboard.js'), 'utf8');
  const loops = n.split('\n').filter((l) => /frame = requestAnimationFrame\(draw\)/.test(l));
  assert.ok(loops.length >= 3 && loops.every((l) => /RESTING\(\)/.test(l)), 'every draw loop checks RESTING');
  assert.ok(/THROTTLED\(\)/.test(n) && /IDLE_FRAME_MS/.test(n));
  assert.ok(!/1100 \/ innerWidth/.test(n), 'background shader at most 800 px wide');
});

const { browser, reason: REASON } = await startBrowser();

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-render-load-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
    const memory = await import(pathToFileURL(path.join(REPO, 'src', 'memory.mjs')).href);
    for (const p of ['payments', 'infra']) memory.projectInit(root, p);
    const types = ['decision', 'error', 'learning', 'thought', 'event'];
    for (let i = 0; i < 12; i++) {
      const type = types[i % types.length];
      const d = { agent: 'builder', title: `Entry ${i + 1}`, text: 'A short note.', tags: ['infra'] };
      if (type === 'decision') Object.assign(d, { topic: `choice/${i}`, choice: 'option a', why: 'measured' });
      if (type === 'error') d.class = 'flow';
      memory.logEntry(root, type, d, { project: ['payments', 'infra', null][i % 3], now: new Date(Date.parse('2026-09-01T09:00:00Z') + i * 3600e3) });
    }
    const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?load=${Math.random()}`);
    const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
    try { return await run(`http://127.0.0.1:${server.address().port}`); }
    finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function measure(base, { client = null, before = null, opt = {}, idleMs = 0, small = false } = {}) {
  // `small`: software GL (swiftshader) renders the full size at only a handful of
  // frames/s, which would hide a throttle; a small viewport lets the loops run
  // at the rate they are ALLOWED to.
  const page = await browser.newPage({ viewport: small ? { width: 480, height: 300 } : { width: 1440, height: 900 }, ...opt });
  page.setDefaultTimeout(60000);
  try {
    await page.addInitScript(COUNTER);
    if (idleMs) await page.addInitScript((ms) => { window.CM_IDLE_MS = ms; }, idleMs);
    if (client) await page.route('**/dashboard/app.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
    await page.goto(`${base}/dashboard#knowledge/network`, { waitUntil: 'load' }); // never networkidle
    await waitReady(page);
    await page.waitForFunction(() => !!document.querySelector('#brain'), null, { timeout: 60000 }).catch(() => null);
    if (before) await before(page);
    await page.waitForTimeout(1500); // let a running callback chain run out
    return await measureLoad(page, 3000);
  } finally { await page.close(); }
}

const PALETTE = async (p) => {
  let open = false;
  for (let i = 0; i < 6 && !open; i++) {
    await p.keyboard.press('Control+k');
    open = await p.waitForFunction(() => document.activeElement?.id === 'commandInput', null, { timeout: 5000 }).then(() => true, () => false);
  }
  assert.ok(open, 'the palette opens');
};
const HIDDEN = (p) => p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });

test('palette open: no steady drawing now; the old stand draws on; positive control: visible network draws', { skip: REASON, timeout: DEADLINE }, async () => {
  await withServer(async (base) => {
    const visible = await measure(base);
    assert.ok(visible.draws > 0.5, `positive control: a visible network draws (${visible.draws}/s)`);
    const now = await measure(base, { before: PALETTE });
    assert.ok(now.draws <= NOISE, `palette open: no steady drawing (${now.draws}/s)`);
    const red = await measure(base, { before: PALETTE, client: old('assets/dashboard/dashboard.js') });
    assert.ok(red.draws > 0.5, `RED: the old stand draws on with the palette open (${red.draws}/s)`);
  });
});

test('after Escape the view draws again; hidden page and reduced motion draw nothing', { skip: REASON, timeout: DEADLINE }, async () => {
  await withServer(async (base) => {
    const back = await measure(base, { before: async (p) => { await PALETTE(p); await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('dialog[open]')); } });
    assert.ok(back.draws > 0.5, `after Escape it runs again (${back.draws}/s)`);
    const hidden = await measure(base, { before: HIDDEN });
    assert.ok(hidden.draws <= NOISE, `document.hidden (${hidden.draws}/s)`);
    const reduced = await measure(base, { opt: { reducedMotion: 'reduce' } });
    assert.ok(reduced.draws <= NOISE, `reducedMotion (${reduced.draws}/s)`);
  });
});

test('idle (no input): keeps drawing at <= ~10 frames/s per loop, input lifts to full rate; palette/hidden stay at 0', { skip: REASON, timeout: DEADLINE }, async () => {
  await withServer(async (base) => {
    const idle = await measure(base, { idleMs: 1500, small: true });
    assert.ok(idle.frames > 3, `idle still draws (${idle.frames} frames/s)`);
    assert.ok(idle.frames <= 24, `throttled: network + background together <= ~24 frames/s (${idle.frames}/s)`);
    const full = await measure(base, { idleMs: 600000, small: true });
    assert.ok(full.frames > idle.frames * 1.25, `full rate is clearly higher (${full.frames} against ${idle.frames}/s)`);
    const palette = await measure(base, { idleMs: 1500, before: PALETTE });
    assert.ok(palette.draws <= NOISE, `idle + palette (${palette.draws}/s)`);
    const hidden = await measure(base, { idleMs: 1500, before: HIDDEN });
    assert.ok(hidden.draws <= NOISE, `idle + hidden (${hidden.draws}/s)`);
    const stopped = await measure(base, { idleMs: 1500, small: true, client: old('assets/dashboard/dashboard.js') });
    assert.ok(stopped.frames > idle.frames * 1.25, `RED: the old stand does not throttle in idle (${stopped.frames} against ${idle.frames}/s)`);
  });
});

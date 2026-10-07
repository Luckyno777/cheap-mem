// test/sphere-visible.test.mjs — the visible surface of the dashboard names
// no demo, no template, no pattern, no mockup and no brain (task sphaere,
// 2026-09-28; mirrors lucky-mem's test/sphaere-sichtbar.test.mjs).
//
// The owner: "… and make sure to remove every demo reference, e.g. in the
// footer". Before, the settings page carried a paragraph "The sibling
// house's Dashboard-Muster-3, ported unchanged … brain hull …", the footer
// said "cheap-mem · Dashboard · …" and the network "Spatial brain network".
//
// Measured on the RENDERED text, not on the source: the real server
// (bin/mem-serve) on a temporary store with neutral entries, a real
// Chromium (Playwright), every area and every tab from `sections` visited
// once. Checked: `document.body.innerText` plus the visible labels that
// innerText leaves out (optgroup label, aria-label, title, placeholder).
// Code comments and CSS class names do not count.
//
// Without Playwright/Chromium on the machine the probe is SKIPPED (with a
// reason) — not measured is not passed.
//
// Red proof: on the old state 6154cd0 (origin/main before this change) the
// check finds the German pattern name, "mockup" and "brain" (task report). Positive
// control below: an injected visible text is found, a hidden one is not.
/* global document, location -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBrowser, waitReady, warmView } from './fixture/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
// lucky (2026-09-29, Lucky): the sibling's name must never show here —
// not on the core of the knowledge space, not anywhere (the C, not the L).
const FORBIDDEN = /Muster|pattern|demo|template|mockup|brain|lucky/i;

const { browser, reason: REASON } = await startBrowser();

async function withServer(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-sphere-visible-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'notes', participants: { alex: { human: true }, builder: {} }, language: 'en' }));
    const memory = await import(pathToFileURL(path.join(REPO, 'src', 'memory.mjs')).href);
    for (const p of ['payments', 'infra']) memory.projectInit(root, p);
    const types = ['decision', 'error', 'learning', 'thought', 'event'];
    for (let i = 0; i < 12; i++) {
      const type = types[i % types.length];
      const d = { agent: 'builder', title: ['Retry card charges at most three times', 'Wait for the database health check', 'Log the request id on every hop'][i % 3] + ' ' + (i + 1), text: 'A short note.', tags: ['infra'] };
      if (type === 'decision') Object.assign(d, { topic: 'choice/' + i, choice: 'option a', why: 'measured' });
      if (type === 'error') d.class = 'flow';
      memory.logEntry(root, type, d, { project: ['payments', 'infra', null][i % 3], now: new Date(Date.parse('2026-09-01T09:00:00Z') + i * 3600e3) });
    }
    const mod = await import(`${pathToFileURL(path.join(REPO, 'bin', 'mem-serve')).href}?visible=${Math.random()}`);
    const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
    try {
      return await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
      await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Visible text of one screen: innerText plus visible labels.
const VISIBLE = () => {
  const attr = [...document.querySelectorAll('optgroup[label], [aria-label], [title], [placeholder]')]
    .filter((el) => el.tagName === 'OPTGROUP' || el.getClientRects().length)
    .flatMap((el) => ['label', 'aria-label', 'title', 'placeholder'].map((a) => el.getAttribute(a)).filter(Boolean));
  return [document.title, document.body.innerText, ...attr].join('\n');
};

async function everyScreen(base, before) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    // 'load' + loading marker gone, NOT 'networkidle': since tempo the page
    // fetches deferred parts and polls the MCP probe — under full load the
    // network never went quiet for 30 s (cm suite 2026-09-29, navigation timeout).
    await warmView(base); // the cold start of the server is not part of the browser deadlines
    await page.goto(base + '/dashboard', { waitUntil: 'load' });
    await waitReady(page);
    if (before) await page.evaluate(before);
    const targets = await page.evaluate('Object.entries(sections).flatMap(([a, s]) => s.tabs.length ? s.tabs.map(([t]) => a + "/" + t) : [a])');
    const texts = [];
    for (const t of targets) {
      await page.evaluate((h) => { location.hash = h; }, t);
      await page.waitForTimeout(250);
      texts.push({ t, text: await page.evaluate(VISIBLE) });
    }
    return { targets, texts, errors };
  } finally {
    await page.close();
  }
}
const hits = (texts) => texts.flatMap(({ t, text }) =>
  text.split('\n').filter((l) => FORBIDDEN.test(l)).map((l) => `${t}: ${l.trim().slice(0, 140)}`));

test('POSITIVE CONTROL: the probe finds an injected visible text, not a hidden one', { skip: REASON }, async () => {
  await withServer(async (base) => {
    const { texts, targets } = await everyScreen(base, () => {
      const a = document.createElement('div');
      a.textContent = 'Injected: dashboard after the mockup';
      const b = document.createElement('div');
      b.textContent = 'Hidden: template';
      b.hidden = true;
      document.body.append(a, b);
    });
    assert.ok(targets.length >= 20, `every tab visited (${targets.length})`);
    const h = hits(texts);
    assert.ok(h.some((l) => l.includes('Injected')), 'the visible text must be found');
    assert.ok(!h.some((l) => l.includes('Hidden')), 'hidden text does not count');
  });
});

test('GREEN: no visible text on any screen names a pattern, demo, template, mockup, brain or the sibling (lucky)', { skip: REASON }, async () => {
  await withServer(async (base) => {
    const { texts, targets, errors } = await everyScreen(base);
    const h = hits(texts);
    console.log(`   ${targets.length} screens, ${texts.reduce((n, x) => n + x.text.length, 0)} characters, ${h.length} hits`);
    assert.deepEqual(errors, [], 'no page errors');
    assert.deepEqual(h, [], 'visible references to pattern/demo/template/mockup/brain');
    // The footer states house, holdings, state and codebase — nothing else.
    assert.match(texts[0].text, /cheap-mem · .*state .*memory /, 'a factual footer');
  });
});


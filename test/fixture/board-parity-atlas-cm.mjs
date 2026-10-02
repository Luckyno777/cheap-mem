// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/fixture/board-parity-atlas-cm.mjs — a memory and measuring helpers
// for the atlas label pile-up (parity with lucky-mem's faehnchen fixture,
// 2026-10-01).
//
// The finding: focused on a large topic or a large relation bundle, the
// labels of its subgroups piled up into an unreadable heap. This memory
// rebuilds exactly that: one topic with 220 entries (-> twelve subgroups),
// a few more topics, and a bundle whose hub has 140 neighbours and a long
// title (-> the breadcrumb runs as a paragraph).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LONG_HUB = 'Capture bundle: the collecting point for every raw note from sessions that has not been sorted into a topic yet and waits for the librarian, with origin, timestamp and evidence from the retrieval trail';

export async function atlasWorld(REPO) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-atlas-labels-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'atlas', participants: { alex: { human: true } }, language: 'en' }));
  const memory = await import(pathToFileURL(path.join(REPO, 'src/memory.mjs')).href);
  const t0 = Date.parse('2026-09-01T09:00:00Z');
  let n = 0;
  const log = (d) => memory.logEntry(r, 'learning', d, { project: ['workshop', 'garden'][n % 2], now: new Date(t0 + (n++) * 60e3) }).entry;
  // One large topic "capture" with 18 subtopics of different sizes.
  for (let m = 0; m < 220; m++) {
    const u = m % 18;
    log({ title: `Capture note ${m}`, text: `Content ${m}`, tags: ['capture', `capture-part-${String(u).padStart(2, '0')}-${['session', 'recall', 'tool', 'path'][u % 4]}`] });
  }
  // More topics for the whole view.
  for (let t = 0; t < 7; t++) for (let m = 0; m < 6 + t * 3; m++) log({ title: `Topic ${t} note ${m}`, text: 'x', tags: [`topic-${t}`] });
  // A large relation bundle (a hub with 140 neighbours -> subgroups) with a long title, plus small ones.
  const hub = log({ title: LONG_HUB, text: 'Hub', tags: ['relation'] });
  for (let k = 0; k < 140; k++) log({ title: `Neighbour ${k}`, text: 'x', tags: ['relation'], origin: { derived_from: [hub.id] } });
  for (let b = 0; b < 6; b++) {
    const h = log({ title: `Small hub ${b}`, text: 'x', tags: ['relation'] });
    for (let k = 0; k < 3 + b; k++) log({ title: `Neighbour ${b}/${k}`, text: 'x', tags: ['relation'], origin: { derived_from: [h.id] } });
  }
  return r;
}

export async function withServer(REPO, root, run) {
  const mod = await import(`${pathToFileURL(path.join(REPO, 'bin/mem-serve')).href}?atlas=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '',
    // The red proofs run an OLD client that does not page: it must get every entry in the first answer.
    CHEAP_MEM_SERVE_HEAD_ENTRIES: '100000' });
  try { return await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((res) => { server.closeAllConnections?.(); server.close(res); }); }
}

/** Opens the page, the knowledge network in mode `mode`, waits for the net. `client`/`css`: another state of dashboard.js/.css. */
export async function openAtlas(browser, base, mode, { viewport = { width: 1920, height: 1080 }, client = null, css = null } = {}) {
  const page = await browser.newPage({ viewport });
  page.setDefaultTimeout(90000);
  if (client) await page.route('**/dashboard/app.js*', (r) => r.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: client }));
  if (css) await page.route('**/dashboard/app.css*', (r) => r.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body: css }));
  await page.goto(base + '/dashboard#knowledge/network', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof sections === 'object' && !document.querySelector('#screen .loading'), null, { timeout: 90000 });
  await page.waitForSelector('#graphModeSelect');
  await page.evaluate((m) => { const s = document.querySelector('#graphModeSelect'); s.value = m; s.dispatchEvent(new Event('change', { bubbles: true })); }, mode);
  await page.waitForFunction((m) => typeof graphAPI === 'object' && graphAPI && graphAPI.inspect().model.mode === m, mode);
  await page.locator('#brain').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  return page;
}

/** Focus on the group with the most members; waits until the flight and the placement are over. */
export async function focusLargest(page) {
  const key = await page.evaluate(() => {
    const g = [...graphAPI.inspect().model.groups].filter((x) => x.key !== 'isolated').sort((a, b) => b.members.length - a.members.length)[0];
    graphAPI.focus(g.key);
    return g.key;
  });
  await page.waitForFunction(() => !graphAPI.inspect().camera.transitioning);
  await waitStill(page);
  return key;
}

/** Waits until the labels stand: three equal counts 600 ms apart, and something stands at all. */
export async function waitStill(page, maxMs = 30000) {
  const until = Date.now() + maxMs;
  let before = '', same = 0;
  while (Date.now() < until) {
    await page.waitForTimeout(600);
    const z = await page.evaluate(COUNT_OVERLAP);
    const now = JSON.stringify(z);
    same = now === before && z.visible + z.dots > 0 ? same + 1 : 0;
    if (same >= 2) return;
    before = now;
  }
}

/** Counts visible labels and pairs that cover each other (area > 4 px^2), plus clipped lines. */
export const COUNT_OVERLAP = () => {
  const lay = document.querySelector('#graphLabels'), R = lay.getBoundingClientRect();
  const els = [...lay.querySelectorAll('.atlas-label')].filter((el) => {
    if (el.hidden || el.classList.contains('label-dot') || el.classList.contains('label-off')) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.3;
  });
  const boxes = els.map((el) => ({ el, b: el.getBoundingClientRect() })).filter(({ b }) => b.width > 0 && b.right > R.left && b.left < R.right && b.bottom > R.top && b.top < R.bottom);
  let pairs = 0;
  const involved = new Set();
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i].b, b = boxes[j].b;
    const ow = Math.min(a.right, b.right) - Math.max(a.left, b.left), oh = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (ow > 2 && oh > 2) { pairs++; involved.add(i); involved.add(j); }
  }
  const dots = [...lay.querySelectorAll('.atlas-label.label-dot')].filter((el) => !el.hidden).length;
  return { visible: boxes.length, pairs, involved: involved.size, dots };
};

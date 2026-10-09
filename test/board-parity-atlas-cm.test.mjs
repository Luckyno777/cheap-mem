// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/board-parity-atlas-cm.test.mjs — atlas labels without a pile-up, a
// breadcrumb of at most two lines (parity with lucky-mem's faehnchen-lm,
// 2026-10-01).
//
// The finding: focused on a large topic or a relation bundle, the labels of
// the subgroups piled up into an unreadable heap; in a bundle focus the
// breadcrumb (the hub's title) ran as a long paragraph across the full width.
//
// What is checked is the SHIPPED file assets/dashboard/dashboard.js: the pure
// function placeLabels (between the marks // <labelplace> and // </labelplace>)
// as a unit, and the fixture memory in a real Chromium.
// RED proof against the FIXED commit deca5ad7 (never merge-base): there is no
// placement there, refreshProjected reads layout per frame (offsetWidth), and
// in a focus the labels cover each other.
/* global document, getComputedStyle -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { lazyBrowser, browserStartProbe } from './fixture/browser.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import { atlasWorld, withServer, openAtlas, focusLargest, waitStill, COUNT_OVERLAP } from './fixture/board-parity-atlas-cm.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const OLD = 'deca5ad713f1dc7f3ec05cf21e0d5cf1ebb22a3b';
const oldFile = (f) => execFileSync('git', ['-C', REPO, 'show', `${OLD}:assets/dashboard/${f}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const SOURCE = fs.readFileSync(path.join(REPO, 'assets/dashboard/dashboard.js'), 'utf8');

function loadPlacement(source) {
  const m = source.match(/\/\/ <labelplace>[^\n]*\n([\s\S]*?)\/\/ <\/labelplace>/);
  assert.ok(m, 'block // <labelplace> missing in assets/dashboard/dashboard.js');
   
  return new Function(`${m[1]}; return { LABEL_PLACE, placeLabels };`)();
}
/** A function's body from `function name(` to its matching closing brace. */
function body(source, name) {
  const i = source.indexOf(`function ${name}(`);
  assert.ok(i >= 0, name);
  let depth = 0;
  for (let j = source.indexOf('{', i); j < source.length; j++) {
    if (source[j] === '{') depth++;
    else if (source[j] === '}' && --depth === 0) return source.slice(i, j + 1);
  }
  return source.slice(i);
}
const rect = (k, e) => [k.x + e.dx, k.y + e.dy, k.x + e.dx + k.w, k.y + e.dy + k.h];
const overlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
function standing(cands, res) {
  return cands.filter((k) => res.get(k.key)?.label).map((k) => ({ k, r: rect(k, res.get(k.key)) }));
}
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

const { LABEL_PLACE, placeLabels } = loadPlacement(SOURCE);

test('POSITIVE CONTROL: the overlap probe recognises two stacked labels', () => {
  assert.equal(overlap([10, 10, 130, 44], [20, 20, 140, 54]), true);
  assert.equal(overlap([10, 10, 130, 44], [140, 10, 260, 44]), false);
});

test('unit: a heap of 40 labels around one spot — no visible label covers another, all inside the area', () => {
  const r = rng(7);
  const cands = Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i, x: 500 + r() * 160, y: 300 + r() * 120, w: 100 + r() * 50, h: 34, prio: 1 + Math.floor(r() * 30), depth: 1 + (i % 3), focus: false, before: null }));
  const area = { w: 1100, h: 620, taken: [] };
  const res = placeLabels(cands, area);
  const s = standing(cands, res);
  assert.ok(s.length >= 8, `labels stand (${s.length})`);
  assert.ok(s.length < cands.length, 'not all fit — the rest become dots');
  for (let i = 0; i < s.length; i++) {
    const a = s[i].r;
    assert.ok(a[0] >= LABEL_PLACE.margin && a[1] >= LABEL_PLACE.margin && a[2] <= area.w - LABEL_PLACE.margin && a[3] <= area.h - LABEL_PLACE.margin, 'inside the area');
    for (let j = i + 1; j < s.length; j++) assert.equal(overlap(a, s[j].r), false, `${s[i].k.key} covers ${s[j].k.key}`);
  }
  for (const k of cands) assert.ok(res.has(k.key), 'every candidate has a result (label or dot)');
});

test('unit: priority — focus before weight before depth (budget 2 or 1 from the area)', () => {
  // 300 x 180 px carries exactly two 120 x 34 labels (fill 0.2); there would be room for more.
  const k = (key, prio, depth, focus = false) => ({ key, x: 150, y: 90, w: 120, h: 34, prio, depth, focus, before: null });
  const res = placeLabels([k('light', 3, 1), k('heavy', 50, 1), k('focus', 1, 2, true), k('deep', 50, 3)], { w: 300, h: 180, taken: [] });
  assert.equal(res.get('focus').label, true, 'focus first');
  assert.equal(res.get('heavy').label, true, 'then the weight (at equal weight the shallower level)');
  assert.equal(res.get('deep').label, false, 'as heavy, but deeper: a dot');
  assert.equal(res.get('light').label, false, 'the lightest becomes a dot');
  const k1 = (key, prio, depth) => ({ key, x: 60, y: 40, w: 120, h: 34, prio, depth, focus: false, before: null });
  const e2 = placeLabels([k1('deep', 9, 3), k1('shallow', 9, 1)], { w: 200, h: 150, taken: [] });
  assert.equal(e2.get('shallow').label, true);
  assert.equal(e2.get('deep').label, false);
});

test('unit: hysteresis — what already stood stays at a similar weight and in its spot', () => {
  const k = (key, prio, before = null) => ({ key, x: 60, y: 40, w: 120, h: 34, prio, depth: 1, focus: false, before });
  const area = { w: 200, h: 150, taken: [] }; // budget 1
  const e0 = placeLabels([k('A', 10), k('B', 12)], area);
  assert.equal(e0.get('B').label, true);
  assert.equal(e0.get('A').label, false);
  // A stood already, so it stays (10 * 1.6 > 12) — no flicker between two nearly equal ones
  const e = placeLabels([k('A', 10, { dx: 12, dy: 12 }), k('B', 12)], area);
  assert.equal(e.get('A').label, true);
  assert.equal(e.get('B').label, false);
  assert.equal(placeLabels([k('A', 10, { dx: 12, dy: 12 }), k('B', 40)], area).get('B').label, true, 'a much heavier one beats the hysteresis');
  const alone = placeLabels([{ key: 'C', x: 400, y: 300, w: 100, h: 30, prio: 1, depth: 1, focus: false, before: { dx: -112, dy: 12 } }], { w: 900, h: 600, taken: [] });
  assert.deepEqual([alone.get('C').dx, alone.get('C').dy], [-112, 12], 'the previous spot is tried first');
});

test('unit: budget from the area — at most as many labels as fit readably, more area allows more', () => {
  const r = rng(3);
  const many = (W, H) => Array.from({ length: 300 }, (_, i) => ({ key: 'k' + i, x: 10 + r() * (W - 20), y: 10 + r() * (H - 20), w: 110, h: 32, prio: 1, depth: 1, focus: false, before: null }));
  const count = (W, H) => [...placeLabels(many(W, H), { w: W, h: H, taken: [] }).values()].filter((e) => e.label).length;
  const small = count(390, 430), large = count(1600, 560);
  const cap = (W, H) => Math.floor((LABEL_PLACE.fill * W * H) / ((110 + LABEL_PLACE.gap) * (32 + LABEL_PLACE.gap)));
  assert.ok(small >= 1 && small <= cap(390, 430), `narrow: ${small} <= ${cap(390, 430)}`);
  assert.ok(large <= cap(1600, 560), `wide: ${large} <= ${cap(1600, 560)}`);
  assert.ok(large > small * 2, `more area, more labels (${small} -> ${large})`);
});

test('unit: taken rectangles are never covered; moved labels report themselves for the leader line', () => {
  const cands = Array.from({ length: 6 }, (_, i) => ({ key: 'k' + i, x: 300, y: 200, w: 100, h: 30, prio: 6 - i, depth: 1, focus: false, before: null }));
  const taken = [[310, 210, 420, 245]];
  const res = placeLabels(cands, { w: 800, h: 500, taken });
  for (const { r } of standing(cands, res)) assert.equal(overlap(r, taken[0]), false);
  assert.ok([...res.values()].some((e) => e.label && e.moved), 'at least one stands on the far ring');
  assert.ok([...res.values()].some((e) => e.label && !e.moved));
});

test(`source: no layout read per frame in refreshProjected (new); the old state ${OLD.slice(0, 8)} read offsetWidth per frame`, (t) => {
  let old;
  try { old = oldFile('dashboard.js'); } catch { t.skip(`commit ${OLD} not reachable — red proof unknown, not green`); return; }
  assert.ok(!/\/\/ <labelplace>/.test(old), 'RED: the old state has no placement');
  assert.match(body(old, 'place'), /offsetWidth/, 'RED: the old state reads the label width per frame');
  assert.match(body(old, 'refreshProjected'), /place\(/, 'RED: ... through place() from refreshProjected');
  const n = body(SOURCE, 'refreshProjected') + body(SOURCE, 'applyLabels') + body(SOURCE, 'leaderLine');
  assert.doesNotMatch(n, /offsetWidth|offsetHeight|getBoundingClientRect|getComputedStyle|scrollHeight|clientHeight/, 'new: per frame only arithmetic and writes');
  assert.match(body(SOURCE, 'refreshProjected'), /LABEL_PLACE\.throttle/, 'the placement is throttled');
});

// ---- browser: the fixture memory in a real Chromium ------------------------
// The browser starts on first use, not by a top-level await (a throwing start is a named red probe).
const B = lazyBrowser();
browserStartProbe(B);
const LIMIT = 6 * 60 * 1000;

test(`browser: topics + focus and bundles + focus — no covered labels (1920 and 390); the old state ${OLD.slice(0, 8)} piles them up`, { timeout: LIMIT }, async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  let old, oldCss;
  try { old = oldFile('dashboard.js'); oldCss = oldFile('dashboard.css'); } catch { t.skip(`commit ${OLD} not reachable — red proof unknown, not green`); return; }
  const root = await atlasWorld(REPO);
  try {
    await withServer(REPO, root, async (base) => {
      // RED + positive control of the probe: the old state shows covered labels in a focus.
      const pa = await openAtlas(browser, base, 'topics', { client: old, css: oldCss });
      try {
        await focusLargest(pa);
        const r = await pa.evaluate(COUNT_OVERLAP);
        console.log('   old topics 1920 focus', JSON.stringify(r));
        assert.ok(r.visible >= 5 && r.pairs > 0, `RED: the old state piles up (${JSON.stringify(r)})`);
      } finally { await pa.close(); }
      // RED breadcrumb: in the old state the hub title runs over more than two lines in a bundle focus.
      const pk = await openAtlas(browser, base, 'relations', { viewport: { width: 390, height: 844 }, client: old, css: oldCss });
      try {
        await focusLargest(pk);
        const k = await pk.evaluate(() => { const b = document.querySelector('#graphBreadcrumb'); return { h: b.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(b).lineHeight) || 15 }; });
        console.log('   old relations 390 breadcrumb', JSON.stringify(k));
        assert.ok(k.h > k.lh * 2 + 2, `RED: the old state shows the breadcrumb as a paragraph (${k.h}px)`);
      } finally { await pk.close(); }
      for (const [mode, vp] of [['topics', { width: 1920, height: 1080 }], ['relations', { width: 390, height: 844 }]]) {
        const p = await openAtlas(browser, base, mode, { viewport: vp });
        const errors = [];
        p.on('pageerror', (e) => errors.push(e.message));
        try {
          await waitStill(p);
          const whole = await p.evaluate(COUNT_OVERLAP);
          const key = await focusLargest(p);
          const r = await p.evaluate(COUNT_OVERLAP);
          console.log(`   new ${mode} ${vp.width} whole ${JSON.stringify(whole)} focus ${key} ${JSON.stringify(r)}`);
          assert.equal(whole.pairs, 0, 'whole view: nothing covered');
          assert.ok(r.visible >= 2, `labels stand (${r.visible})`);
          assert.equal(r.pairs, 0, `focus ${key}: nothing covered`);
          // Still camera: no label moves and none switches (no flicker).
          const spots = () => p.evaluate(() => [...document.querySelectorAll('#graphLabels .atlas-label')].map((el) => el.className + '@' + el.style.transform).join('\n'));
          const l1 = await spots();
          await p.waitForTimeout(1500);
          assert.equal(await spots(), l1, 'still camera: labels stand still');
          if (mode === 'relations') {
            // Breadcrumb: at most two lines, then "more"; "more" expands.
            const k = await p.evaluate(() => { const b = document.querySelector('#graphBreadcrumb'); return { h: b.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(b).lineHeight), full: b.scrollHeight, more: !document.querySelector('.crumb-more')?.hidden }; });
            assert.ok(k.h <= k.lh * 2 + 2, `two lines (${k.h}px at ${k.lh}px line height)`);
            assert.ok(k.full > k.h + 4 && k.more, 'the rest stands behind "more"');
            await p.click('.crumb-more');
            const opened = await p.evaluate(() => document.querySelector('#graphBreadcrumb').getBoundingClientRect().height);
            assert.ok(opened > k.h + 4, `"more" shows the whole title (${opened}px)`);
          }
          assert.deepEqual(errors, []);
        } finally { await p.close(); }
      }
    });
  } finally { removeTree(root); }
});

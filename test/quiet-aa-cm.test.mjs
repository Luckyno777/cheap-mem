// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/quiet-aa-cm.test.mjs - the logic half of test/quiet-aa-cm-browser.test.mjs (job quiet-aa-cm): the small grey text of
// the dashboard (colour --quiet, and --muted next to it) reaches WCAG AA, 4.5:1, on the surfaces it stands on, in the light
// and in the dark theme - worked out from assets/dashboard/dashboard.css alone, with no browser.
//
// Why a second probe of the same guarantee (CI run 1180): the browser probe needs Chromium, and the guarantees job of CI
// installs `npm ci --omit=optional` - no Playwright. There the probe skipped, the four "quiet AA" mutants in
// bench/mutation.mjs looked like survivors of their own suite ("NOT JUDGED HERE - its suites passed with 7 tests skipped"),
// and every slice of the mutation run went red. This probe needs no browser, so the mutants are caught where they are
// checked (the same cure as test/card-byline-ui-cm.test.mjs, CI run 1141).
//
// What it measures: the effective tokens of each theme (the later :root block wins over the first; body.light on top for the
// light theme; `.light .fabric-stage` for the stage), the surfaces they stand on (page, panel, figure tile, raised tile,
// sidebar, the dark fabric stage) - each surface composited layer by layer from the stylesheet, each gradient with EVERY
// colour stop, and the hover glow of a figure tile in each of the four page colours - and takes the worst ratio, with the
// same WCAG formula as test/fixture/text-contrast.mjs (pinned below to give the same numbers as the browser probe).
// What it does not see: what only a browser computes (inherited opacity, text on top of canvas drawings). That is the
// browser probe's half.
//
// Starting value:  the state before the branch (9a10bf6): light --quiet #617869, dark --quiet #91a699, the dark .content tint
//                  in the light theme, the stage with the light --quiet.
// Expected change: every ratio below at 4.5 or more.
// Abort criterion: one ratio below 4.5, or a parse that finds fewer surfaces than the positive control names.
//
// Red proof: DASH_CSS=<dashboard.css of 9a10bf6> node --test test/quiet-aa-cm.test.mjs; and one test per mutant of the four
// in bench/mutation.mjs ("quiet AA: ...").
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AA, measureInPage } from './fixture/text-contrast.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(process.env.DASH_CSS || path.join(REPO, 'assets', 'dashboard', 'dashboard.css'), 'utf8');

// ---- the WCAG formula, as in test/fixture/text-contrast.mjs (checked against it further down) ----
const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));

// ---- a small reader for the stylesheet: top-level rules and the rules of @media, no more ----
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
/** Splits `s` at `sep` outside parentheses. */
function splitTop(s, sep) {
  const out = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
/** Parses a block body (`a:b;c:d`) into a Map; a later declaration of the same property wins. */
function declsOf(body) {
  const m = new Map();
  for (const d of splitTop(body, ';')) {
    const i = d.indexOf(':');
    if (i > 0) m.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return m;
}
/** Every rule as `{ sels, decls, media }` in source order; `media` is null outside @media/@supports. */
function parseRules(css, media = null) {
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let depth = 1; let j = open + 1;
    while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    const head = css.slice(i, open).trim();
    const body = css.slice(open + 1, j - 1);
    if (/^@(media|supports)/i.test(head)) rules.push(...parseRules(body, head));
    else if (!head.startsWith('@')) rules.push({ sels: splitTop(head, ',').map((x) => x.trim()), decls: declsOf(body), media });
    i = j;
  }
  return rules;
}
const RULES = parseRules(stripComments(CSS));
/** The unconditional rules whose selector list holds `sel`, in source order. */
const rulesFor = (sel) => RULES.filter((r) => r.media === null && r.sels.includes(sel));
/** The last value `prop` takes over the unconditional rules for `sel` (undefined: no rule sets it). */
const last = (sel, prop) => rulesFor(sel).filter((r) => r.decls.has(prop)).map((r) => r.decls.get(prop)).at(-1);

// ---- colours ----
function hexColour(h) {
  let x = h.replace('#', '');
  if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join('');
  const p = [0, 2, 4].map((k) => parseInt(x.slice(k, k + 2), 16));
  return [...p, x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1];
}
/** The colour stops of one gradient layer, as [r,g,b,a]; `var(--page-glow)` is replaced by `glow` ("157,226,172"). */
function stopsOf(layer, glow) {
  const text = layer.replaceAll('var(--page-glow)', glow);
  const out = [];
  for (const m of text.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|\btransparent\b|\bwhite\b/gi)) {
    const t = m[0].toLowerCase();
    if (t === 'transparent') out.push([0, 0, 0, 0]);
    else if (t === 'white') out.push([255, 255, 255, 1]);
    else if (t.startsWith('#')) out.push(hexColour(t));
    else { const p = t.slice(t.indexOf('(') + 1, -1).split(/[\s,/]+/).filter(Boolean).map(Number); out.push([p[0], p[1], p[2], p.length > 3 ? p[3] : 1]); }
  }
  return out;
}
/** The gradient layers of a `background` value, top layer first, each as a list of stops. */
const layersOfBackground = (value, glow = '0,0,0') => (value && value !== 'none'
  ? splitTop(value, ',').map((l) => l.trim()).filter((l) => /gradient\(/.test(l)).map((l) => stopsOf(l, glow))
  : []);
/** Composites the layers (bottom first) over each of the candidate backgrounds; every stop is a possible colour. */
function composite(cands, layersBottomFirst) {
  let cur = cands;
  for (const stops of layersBottomFirst) {
    const next = new Map();
    for (const c of cur) for (const s of stops) { const v = over(s, c); next.set(v.map((x) => Math.round(x * 100)).join(','), v); }
    cur = [...next.values()];
  }
  return cur;
}
const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const solid = (h) => { const c = hexColour(h); assert.equal(c[3], 1, `${h} is a solid colour`); return c; };

// ---- the effective tokens of one theme ----
function tokens(light) {
  const t = new Map();
  for (const r of rulesFor(':root')) for (const [k, v] of r.decls) if (k.startsWith('--')) t.set(k, v);
  if (light) for (const r of rulesFor('body.light')) for (const [k, v] of r.decls) if (k.startsWith('--')) t.set(k, v);
  return t;
}
/** The four page colours (`--page-glow`): the default one and one per `body[data-area=...]`. */
function glows() {
  const out = new Set();
  for (const r of RULES) if (r.media === null && r.decls.has('--page-glow') && r.sels.every((s) => s === ':root' || /^body\[data-area=\w+\]$/.test(s))) out.add(r.decls.get('--page-glow'));
  return [...out];
}

/**
 * Every surface a small grey text can stand on in the theme, with the colour the text has there:
 * `[{ surface, text: { '--quiet': hex, '--muted': hex }, bgs: [rgb...] }]`.
 */
function surfaces(light) {
  const tk = tokens(light);
  const bg = solid(tk.get('--bg'));
  const names = ['--quiet', '--muted'];
  const colours = Object.fromEntries(names.map((n) => [n, solid(tk.get(n))]));
  const out = [];
  const add = (surface, bgs, text = colours) => out.push({ surface, text, bgs });

  // The page: --bg, and under .content the tint (the light theme sets `background:none` there).
  const contentBg = (light ? last('.light .content', 'background') : undefined) ?? last('.content', 'background');
  const page = composite([bg], layersOfBackground(contentBg).reverse());
  add('page', page);
  for (const n of ['--side', '--panel', '--raised']) add(n.slice(2), [solid(tk.get(n))]);

  // A panel and a figure tile (`.metric`, with its hover glow) on it, once per page colour.
  const panelBg = (light ? last('.light .panel', 'background') : undefined) ?? last('.panel', 'background');
  const metricBg = last('.metric', 'background');
  for (const g of glows()) {
    const panel = composite(page, layersOfBackground(panelBg, g).reverse());
    add(`panel [${g}]`, panel);
    add(`figure tile [${g}]`, composite(panel, layersOfBackground(metricBg, g).reverse()));
    // The tile glow on the flat panel colour too (the `.metrics` strip before its gradient).
    add(`figure tile on --panel [${g}]`, composite([solid(tk.get('--panel'))], layersOfBackground(metricBg, g).reverse()));
  }

  // The fabric stage is dark in both themes; the light theme gives it the dark --quiet again.
  const stageQuiet = (light ? last('.light .fabric-stage', '--quiet') : undefined) ?? last('.fabric-stage', '--quiet') ?? tk.get('--quiet');
  add('fabric stage', composite([bg], layersOfBackground(last('.fabric-stage', 'background')).reverse()), { '--quiet': solid(stageQuiet) });
  return out;
}

/** The worst ratio per `[theme, surface, variable]` below the line, as readable lines; `all` lists every measurement. */
function measure(light) {
  const rows = [];
  for (const s of surfaces(light)) {
    for (const [v, fg] of Object.entries(s.text)) {
      const worst = s.bgs.map((b) => ({ b, q: ratio(fg, b) })).sort((x, y) => x.q - y.q)[0];
      rows.push({ theme: light ? 'light' : 'dark', surface: s.surface, variable: v, color: hex(fg), bg: hex(worst.b), ratio: Math.round(worst.q * 100) / 100 });
    }
  }
  return rows;
}
const lines = (rows) => rows.filter((r) => r.ratio < AA).map((r) => `${r.theme} ${r.surface}: ${r.variable} ${r.color} on ${r.bg} = ${r.ratio}`);

test('the formula is the one of the browser probe: same numbers as test/fixture/text-contrast.mjs pins (4.48, 4.54, 4.36)', () => {
  assert.equal(Math.round(ratio([0x77, 0x77, 0x77], [255, 255, 255]) * 100) / 100, 4.48, '#777 on white');
  assert.equal(Math.round(ratio([0x76, 0x76, 0x76], [255, 255, 255]) * 100) / 100, 4.54, '#767676 on white');
  assert.equal(Math.round(ratio([0x59, 0x59, 0x59], [0xcc, 0xcc, 0xcc]) * 100) / 100, 4.36, '#595959 on #ccc');
  assert.deepEqual(over([0x76, 0x76, 0x76, 0.5], [255, 255, 255]), [186.5, 186.5, 186.5], 'a half-covering layer mixes evenly with what is below');
  // The in-page copy of the formula (lin/lum/ratio) gives the same numbers as this file's copy.
  const src = measureInPage.toString();
  const grab = (name) => new RegExp(`const ${name} = [^\\n]*;`).exec(src)?.[0];
  assert.ok(grab('lin') && grab('lum') && grab('ratio'), 'the in-page formula was not found in text-contrast.mjs - the fixture moved');
  const inPage = new Function(`${grab('lin')}\n${grab('lum')}\n${grab('ratio')}\nreturn ratio;`)();
  for (const [a, b] of [[[0x56, 0x6a, 0x5d], [0xf3, 0xf5, 0xed]], [[0x99, 0xac, 0xa0], [8, 15, 16]], [[0x61, 0x78, 0x69], [0xea, 0xf0, 0xe4]], [[255, 255, 255], [0, 0, 0]]]) {
    assert.equal(ratio(a, b), inPage(a, b), `${a} on ${b}`);
  }
  assert.equal(AA, 4.5);
});

test('POSITIVE CONTROL: the reader finds both themes, the four page colours, the stage and the figure tile in the stylesheet', () => {
  assert.ok(RULES.length > 500, `the stylesheet was read (${RULES.length} rules)`);
  const dark = tokens(false); const light = tokens(true);
  for (const n of ['--bg', '--side', '--panel', '--raised', '--muted', '--quiet']) {
    assert.match(dark.get(n) ?? '', /^#[0-9a-f]{6}$/i, `dark ${n}`);
    assert.match(light.get(n) ?? '', /^#[0-9a-f]{6}$/i, `light ${n}`);
  }
  assert.notEqual(dark.get('--bg'), light.get('--bg'), 'the light theme has its own page colour');
  assert.equal(glows().length, 5, 'the default page colour and the four areas');
  assert.ok(layersOfBackground(last('.panel', 'background'), '1,2,3').length >= 2, 'the panel gradient was read');
  assert.ok(layersOfBackground(last('.metric', 'background'), '1,2,3').length >= 1, 'the figure-tile glow was read');
  assert.ok(layersOfBackground(last('.fabric-stage', 'background')).length >= 2, 'the stage gradient was read');
  assert.ok(layersOfBackground(last('.content', 'background')).length >= 1, 'the dark .content tint was read');
  // Every surface was visited: a parse that drops them would be green for no reason.
  for (const light2 of [false, true]) {
    const names = new Set(surfaces(light2).map((s) => s.surface.replace(/ \[.*$/, '')));
    for (const n of ['page', 'side', 'panel', 'raised', 'figure tile', 'figure tile on --panel', 'fabric stage']) assert.ok(names.has(n), `${light2 ? 'light' : 'dark'}: surface ${n}`);
    assert.ok(measure(light2).length >= 20, 'enough measurements');
  }
});

for (const light of [false, true]) {
  test(`${light ? 'light' : 'dark'} theme: --quiet and --muted reach ${AA}:1 on every surface worked out from the stylesheet`, (t) => {
    const rows = measure(light);
    t.diagnostic(`lowest: --quiet ${Math.min(...rows.filter((r) => r.variable === '--quiet').map((r) => r.ratio))}, --muted ${Math.min(...rows.filter((r) => r.variable === '--muted').map((r) => r.ratio))} over ${rows.length} measurements`);
    assert.deepEqual(lines(rows), []);
  });
}

test('the light theme: the dark .content tint is gone, the stage keeps the dark --quiet, --quiet is its own darker colour', () => {
  const lt = tokens(true); const dk = tokens(false);
  assert.equal(layersOfBackground(last('.light .content', 'background')).length, 0, '.light .content takes the tint away');
  assert.equal(last('.light .fabric-stage', '--quiet'), dk.get('--quiet'), 'the light theme gives the stage the dark --quiet');
  assert.notEqual(lt.get('--quiet'), dk.get('--quiet'));
});

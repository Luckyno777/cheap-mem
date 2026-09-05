import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as viewer from '../src/viewer.mjs';
import * as memory from '../src/memory.mjs';

// The design system is documented in docs/viewer-design.md and
// docs/viewer-design-tokens.json. These tests guard the few claims in it
// that are cheap to check and expensive to notice breaking: an audit that
// nothing enforces drifts back within a month.

function page() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-vd-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  try {
    memory.logEntry(r, 'event', { title: 'x' });
    return viewer.build(r, { title: 't' }).html;
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
}

const css = (html) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

test('the type scale has no half-pixel steps', () => {
  // 13.5px and 14.5px round differently across platforms, so a scale built
  // on them is not the same scale twice. The ladder is 11 12 13 14 15 17 20.
  const bad = [...css(page()).matchAll(/font-size:\s*(\d+\.\d+)px/g)].map((m) => m[1]);
  assert.deepEqual(bad, [], `half-pixel font sizes: ${bad.join(', ')}`);
});

test('every interactive element has a visible keyboard focus ring', () => {
  // The page is driven from the keyboard (/ focuses search, Esc clears).
  // Before the design audit only the search field had a ring, so tabbing
  // through the lenses left no trace of where you were.
  const c = css(page());
  for (const sel of ['.tab:focus-visible', '.item:focus-visible', 'select:focus-visible']) {
    assert.ok(c.includes(sel), `no focus style for ${sel}`);
  }
  assert.match(c, /#q:focus\{[^}]*outline:/);
});

test('tabs reach a 44px touch target on small screens', () => {
  // 9px padding on a 14px line is ~36px, which is a poor thumb target.
  const c = css(page());
  const mobile = c.slice(c.indexOf('@media (max-width:620px)'));
  assert.match(mobile, /\.tab\{padding:13px/);
});

test('no colour is defined only inside a dark-mode block', () => {
  // A token that exists only under prefers-color-scheme leaves light mode
  // unstyled — the classic dark-first bug.
  const c = css(page());
  // Compare the FIRST :root rule (the colours) against the CONTENTS of the
  // dark block. Scanning the rest of the file sweeps in later :root layers,
  // and the test then reports motion tokens as missing colours.
  const root = c.slice(c.indexOf(':root{'), c.indexOf('@media (prefers-color-scheme:dark)'));
  const declared = new Set([...root.matchAll(/--([a-z-]+):/g)].map((m) => m[1]));
  const block = c.slice(c.indexOf(':root:not([data-theme="light"]){'));
  const inDark = new Set([...block.slice(0, block.indexOf('}')).matchAll(/--([a-z-]+):/g)]
    .map((m) => m[1]));
  const only = [...inDark].filter((t) => !declared.has(t));
  assert.deepEqual(only, [], `defined only in dark: ${only.join(', ')}`);
});

test('the page still carries no shadow', () => {
  // Two tiers of depth: surface tone plus a hairline. Motion arrived,
  // shadow did not — that stays the line between this page and a product
  // surface.
  assert.equal(/box-shadow/.test(css(page())), false, 'a shadow appeared');
});

test('reduced motion is its own token layer, not a patch', () => {
  // Someone who sets prefers-reduced-motion must get THIS page with
  // duration 0 — not a second, half-maintained one.
  const c = css(page());
  const i = c.indexOf('@media (prefers-reduced-motion:reduce)');
  assert.ok(i > 0, 'no reduced-motion block');
  const block = c.slice(i, c.indexOf('}', c.indexOf('{', c.indexOf('{', i) + 1)));
  for (const t of ['--dur-instant', '--dur-quick', '--dur-normal', '--dur-slow']) {
    assert.match(block, new RegExp(`${t}:0ms`), `${t} is not zeroed under reduced motion`);
  }
});

test('every scroll-driven animation is guarded with @supports', () => {
  // The costliest trap in this technique: with animation-fill-mode:both and
  // no support, the element stays PERMANENTLY invisible. A page nobody can
  // read any more is worse than one without the effect.
  // The @supports condition itself contains "animation-timeline:", so it is
  // replaced with a marker — otherwise the test checks itself.
  const c = css(page()).replace(/@supports \(animation-timeline:[^)]*\(\)\)/g, '@GUARD');
  const hits = [...c.matchAll(/animation-timeline:/g)];
  assert.ok(hits.length > 0, 'no scroll-driven animation found at all');
  for (const m of hits) {
    assert.ok(c.slice(0, m.index).lastIndexOf('@GUARD') > 0,
      'animation-timeline without an @supports guard');
  }
});

test('nothing moves forever, and nothing longer than 400ms', () => {
  // WCAG 2.2.2 requires a stop past 5s of continuous motion — so there is
  // none here at all. And the duration ceiling keeps the tone precise rather
  // than sluggish: small distances, fast, is the difference between a tool
  // and a landing page.
  const c = css(page());
  assert.equal(/infinite/.test(c), false, 'a perpetual animation appeared');
  const tooLong = [...c.matchAll(/--dur-[a-z]+:(\d+)ms/g)]
    .map((m) => Number(m[1])).filter((n) => n > 400);
  assert.deepEqual(tooLong, [], `durations too long: ${tooLong.join(', ')}ms`);
});

test('switching lenses does not cross-fade the whole surface', () => {
  // Otherwise the View Transition API takes everything by default — at 500
  // cards that looks coarse and stutters. So root is silenced and only the
  // view area is named.
  const c = css(page());
  assert.match(c, /::view-transition-old\(root\)[^{]*\{\s*animation:none/);
  assert.match(c, /view-transition-name:lens/);
});

test('no backtick in the page template', () => {
  // On 2026-09-05 the template broke FOUR times in the same place — the
  // fourth time inside the comment warning about this very trap.
  //
  // A backtick in a CSS or JS comment ends the template literal the whole
  // page is built inside. Sometimes the module then fails to parse;
  // worse, sometimes it parses on and a comment word becomes a property
  // access that only blows up at runtime.
  //
  // The SOURCE is checked, not the output: in the output a backtick can
  // legitimately sit inside a memory entry.
  const src = fs.readFileSync(new URL('../src/viewer.mjs', import.meta.url), 'utf8');
  const start = src.indexOf('return `<!doctype html>');
  assert.ok(start > 0, 'the page template was not found');
  const end = src.indexOf('</html>`;', start);
  assert.ok(end > start, 'the end of the template was not found');
  assert.equal(src.slice(start + 'return `'.length, end).includes('`'), false,
    'a backtick sits in the page template and ends it early');
});

test('printed, the controls fall away and the content stays', () => {
  const c = css(page());
  const i = c.indexOf('@media print');
  assert.ok(i > 0, 'no print block');
  const block = c.slice(i, i + 900);
  assert.match(block, /display:none/, 'the controls stay on the page');
  assert.match(block, /break-inside:avoid/, 'cards may not break mid-way');
});

test('every declared colour is actually used', () => {
  // A token nothing references is a promise the design does not keep.
  // --fresh sat unused for half a year.
  const c = css(page());
  const root = c.slice(c.indexOf(':root{'), c.indexOf('@media (prefers-color-scheme:dark)'));
  for (const m of root.matchAll(/--([a-z-]+):#/g)) {
    assert.ok(c.includes(`var(--${m[1]})`), `--${m[1]} is declared but used nowhere`);
  }
});

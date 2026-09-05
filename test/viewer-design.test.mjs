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
  const root = c.slice(c.indexOf(':root{'), c.indexOf('@media (prefers-color-scheme:dark)'));
  const declared = new Set([...root.matchAll(/--([a-z-]+):/g)].map((m) => m[1]));
  const dark = c.slice(c.indexOf('@media (prefers-color-scheme:dark)'));
  const inDark = new Set([...dark.matchAll(/--([a-z-]+):/g)].map((m) => m[1]));
  const only = [...inDark].filter((t) => !declared.has(t));
  assert.deepEqual(only, [], `defined only in dark: ${only.join(', ')}`);
});

test('the page carries no shadow and no animation', () => {
  // Two tiers of depth, no motion. Both are documented decisions, and both
  // are the kind of thing that gets added back by reflex.
  const c = css(page());
  assert.equal(/box-shadow/.test(c), false, 'a shadow appeared');
  assert.equal(/@keyframes|transition:/.test(c), false, 'motion appeared');
});

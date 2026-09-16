// The workspace against the house design system.
//
// **Why this file exists at all.** `docs/viewer-design.md` was written
// on 2026-09-05 with the anydesign skill and describes a complete
// system: a type ladder, a spacing ladder, a motion layer with named
// durations, and an accessibility position. The sibling project holds
// it with `test/ansicht-design.test.mjs`. When the workspace was
// rebuilt to Lucky's study on 2026-09-16, it was first built BY EYE —
// the design system sat there and was not opened. That is the recorded
// failure `Eine installierte Faehigkeit wird nicht dadurch benutzt,
// dass sie da ist`, and it happened again, so it gets a guard here.
//
// **The motion question, because it is the interesting one.** The
// design document says of the viewer: nothing is `infinite`, no
// spinner, no shimmer, no pulsing dot — citing WCAG 2.2.2. Read
// closely, 2.2.2 does not forbid movement; it requires a way to STOP
// movement that runs past five seconds. The workspace therefore moves —
// a light travels along each declared link, which is the arrowhead's
// statement told over time — and it carries the control that makes it
// allowed. These probes hold both halves: that the control is there,
// and that reduced motion is the default for whoever asked for calm.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as astra from '../src/astra.mjs';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function page() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-design-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'design' }));
  try {
    memory.logEntry(root, 'learning', { topic: 'x', title: 'one entry', text: 'so it draws' });
    return astra.build(root, { title: 'design' }).html;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const styles = (html) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

/**
 * Zeilen- und Blockkommentare heraus.
 *
 * Eine Zusicherung, die einen Namen FINDET, ist keine, die ein Verhalten
 * findet: `// if (x) x.onclick = ...` enthaelt denselben Text wie die
 * lebende Zeile. Gefunden durch Sabotage, dreimal am selben Tag.
 */
function ohneKommentare(js) {
  return js.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

test('POSITIVE: the probe really reads a stylesheet', () => {
  // Without this, every rule below passes against an empty string, and
  // "no shadow" would prove nothing at all.
  const css = styles(page());
  assert.ok(css.length > 2000, `only ${css.length} characters of CSS — wrong slice?`);
  assert.match(css, /:root\{/, 'no token block');
});

test('the type ladder has no half pixels', () => {
  // 13.5px and 14.5px round differently per platform, so a ladder built
  // on them is not the same ladder twice.
  const bad = [...styles(page()).matchAll(/font-size:\s*(\d+\.\d+)px/g)].map((m) => m[1]);
  assert.deepEqual(bad, [], `half pixels: ${bad.join(', ')}`);
});

test('every control shows the keyboard focus', () => {
  // The page is worked with a keyboard as much as a mouse. Before the
  // sibling project's design pass, only the search field had a ring —
  // tabbing through the lenses, you could not see where you were.
  const css = styles(page());
  for (const sel of ['.nav:focus-visible', '.item:focus-visible', 'select:focus-visible',
    '.icon-button:focus-visible', '#space:focus-visible', 'button.chip:focus-visible']) {
    assert.ok(css.includes(sel), `no focus style for ${sel}`);
  }
  assert.match(css, /#q:focus\{[^}]*outline:/, 'the search field has no focus ring');
});

test('on a narrow screen the rail reaches 44px', () => {
  // 9px of padding on a 14px line is about 36px — hard to hit with a
  // thumb, and this page is read on a phone over browser-SSH.
  const css = styles(page());
  const narrow = css.slice(css.indexOf('@media (max-width:980px)'));
  assert.ok(narrow.length > 100, 'no narrow block at all');
  assert.match(narrow, /\.nav\{padding:1[3-9]px/, 'the rail items stay thumb-hostile');
  assert.match(narrow, /\.icon-button\{padding:1[0-9]px/, 'the motion button stays small');
});

test('reduced motion is its own token layer, not a patch', () => {
  // Whoever asked for calm must get THIS page with zero durations, not
  // a second, half-maintained one.
  const css = styles(page());
  const i = css.indexOf('@media (prefers-reduced-motion:reduce)');
  assert.ok(i > 0, 'no reduced-motion block');
  const block = css.slice(i, i + 260);
  for (const t of ['--instant', '--quick', '--normal', '--slow']) {
    assert.match(block, new RegExp(`${t}:0ms`), `${t} is not zeroed under reduced motion`);
  }
});

test('durations come from tokens, and none of them is slow', () => {
  // A number written into a rule is a duration nobody can retune. And
  // the ceiling keeps the tone crisp rather than sluggish: short
  // distances, fast, is the difference between a tool and a landing page.
  const css = styles(page());
  const raw = [...css.matchAll(/transition:[^;}]*?(\d+)ms/g)].map((m) => m[1]);
  assert.deepEqual(raw, [], `durations written in by hand: ${raw.join(', ')}ms`);
  const tooLong = [...css.matchAll(/--(?:instant|quick|normal|slow):(\d+)ms/g)]
    .map((m) => Number(m[1])).filter((n) => n > 400);
  assert.deepEqual(tooLong, [], `durations over 400ms: ${tooLong.join(', ')}`);
  assert.ok(css.includes('var(--ease-standard)'), 'no easing token is used');
});

test('nothing in the stylesheet moves forever', () => {
  // The movement in this page lives in the canvas, where it can be
  // stopped. A CSS `infinite` cannot be, and that is the line.
  const css = styles(page());
  assert.equal(/\binfinite\b/.test(css), false, 'an endless CSS animation appeared');
});

test('the movement can be stopped, and calm is the default for whoever asked', () => {
  // This is what makes the pulse allowed at all under WCAG 2.2.2 — the
  // rule wants a mechanism, not abstinence. Measured in a real browser
  // on 2026-09-16: 42458 pixels changed in 700ms while running, 0 after
  // one press.
  const html = page();
  assert.match(html, /<button id="motion"[^>]*aria-pressed=/, 'no motion control in the header');
  // **Kommentare weg, BEVOR gesucht wird.** Sonst besteht die Probe
  // auch, wenn die Verdrahtung auskommentiert ist — der Text steht ja
  // noch da. Das ist heute die dritte Probe mit genau dieser Schwaeche
  // (onkeydown, command -v shellcheck, und diese), also steht die
  // Entschaerfung jetzt als Hilfsfunktion da statt als Vorsatz.
  const script = ohneKommentare(
    html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>')));
  assert.match(script, /prefers-reduced-motion: reduce/,
    'the space never asks whether calm was requested');
  assert.match(script, /var paused = ruhe;/,
    'movement does not start paused for someone who asked for calm');
  assert.match(script, /document\.hidden/, 'it keeps animating for a tab nobody is looking at');
  // Not the mere mention: `if (false) motionBtn.onclick` contains it
  // too, and the first version of this probe was happy with that. Third
  // time this exact weakness turned up today, so it is spelled out:
  // a probe that finds a name is not a probe that finds a behaviour.
  assert.match(script, /if \(motionBtn\) motionBtn\.onclick = function/,
    'the control is not wired, or the wiring is behind a dead condition');
});

test('the pulse runs on declared links only', () => {
  // On a containment line it would be decoration, and worse: it would
  // lend those lines a statement they do not make.
  const html = page();
  const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
  const i = script.indexOf('if (!paused) {');
  assert.ok(i > 0, 'the pulse is gone');
  // The nearest enclosing condition above it must be the declared guard.
  const before = script.slice(0, i);
  const guard = before.lastIndexOf("if (e.kind === 'declared')");
  assert.ok(guard > 0 && i - guard < 700,
    'the pulse is not inside the declared-only branch');
});

test('there is still no shadow', () => {
  // Two levels of depth: a surface tone and a hairline. Motion was
  // added on 2026-09-16, shadow was not — that stays the line between
  // this page and a product surface.
  assert.equal(/box-shadow|text-shadow/.test(styles(page())), false, 'a shadow appeared');
});

test('the study palette is the palette, and it is written down', () => {
  // Byte for byte from the study's own stylesheet, so a later "nearly
  // the same violet" is a visible change rather than a drift.
  const css = styles(page());
  const design = JSON.parse(fs.readFileSync(
    path.join(HERE, '..', 'docs', 'viewer-design-tokens.json'), 'utf8'));
  const study = design.$workspace && design.$workspace.palette_der_studie;
  assert.ok(study, 'the token file does not record the study palette');
  for (const [name, value] of Object.entries(study)) {
    if (!String(value).startsWith('#')) continue;
    assert.ok(css.includes(value), `${name} (${value}) is not in the page`);
  }
});

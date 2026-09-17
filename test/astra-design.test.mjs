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
  assert.match(script, /var paused = calm;/,
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
  // Not the literal condition — that changed once already when the
  // study's three pulse rules went in, and a probe pinned to a string
  // is a probe that breaks on every correct edit. What must hold is
  // WHERE it sits: inside the declared-only branch.
  const i = script.search(/if \(!paused && /);
  assert.ok(i > 0, 'the pulse is gone');
  // The nearest enclosing condition above it must be the declared guard.
  const before = script.slice(0, i);
  const guard = before.lastIndexOf("if (e.kind === 'declared')");
  assert.ok(guard > 0 && i - guard < 2000,
    'the pulse is not inside the declared-only branch');
  // And the three rules the study measured into it. Each one is what
  // separates a living net from a string of running lights.
  assert.match(script, /edgeIx % 7 === 0/, 'every edge pulses at once — that is noise');
  assert.match(script, /edgeIx \* 0\.177/, 'no offset, so the dots march in lockstep');
  assert.match(script, /#e3caff/, 'a selected edge does not brighten its dot');
});

test('no backtick hides inside the browser script', () => {
  // **Twice in one day this exact thing broke a file.** The browser
  // half lives in a `String.raw` template. A backtick anywhere inside
  // it closes the template early, and the rest of the module becomes
  // syntax soup — the first time it was a heredoc in a shell installer,
  // the second time a backtick inside MY OWN explanatory comment, put
  // there to quote an identifier. The comment warning about the
  // character contained it.
  //
  // A module that does not parse is caught by any probe. What this one
  // buys is the NAME of the cause, at the moment it happens, instead of
  // "Unexpected identifier" sixty lines further down.
  //
  // **Third time, 2026-09-17.** The first version of this probe guarded
  // only the SCRIPT template — and the next backtick landed in a comment
  // inside the CSS template, which this file did not look at. A probe
  // aimed at ONE instance of a recurring shape is the same defect it is
  // trying to catch, so it now walks both templates.
  const src = fs.readFileSync(path.join(HERE, '..', 'src', 'astra.mjs'), 'utf8');
  for (const decl of ['const CSS = ', 'const SCRIPT = String.raw']) {
    const open = src.indexOf(decl);
    assert.ok(open > 0, `the template "${decl}" is gone or renamed`);
    const start = src.indexOf('`', open);
    const end = src.indexOf('\n`;', start);
    assert.ok(end > start, `${decl}: the template is not closed the way this probe expects`);
    const inside = src.slice(start + 1, end);
    assert.ok(inside.length > 500, `${decl}: only ${inside.length} characters — wrong slice?`);
    const ticks = (inside.match(/`/g) || []).length;
    assert.equal(ticks, 0,
      `${ticks} backtick(s) inside ${decl} — each one closes the template early`);
  }
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

// --- three findings that only a rendered page produced ----------------
//
// Ported back from the sibling project on 2026-09-17, where the same
// design ran against a memory of 1487 entries. All three read fine in
// the source and were only visible in a browser.

test('the declared count in the bar is the count the stage makes', () => {
  // The bar said "80 declared" and the canvas, ten characters further
  // along, said "72": one counted every declared link of the shown
  // entries, the other only those with BOTH ends laid out. Two truths
  // about one word, side by side.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-space-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'space' }));
    memory.logEntry(root, 'error', { id: 'err00001', title: 'it broke', ts: '2026-09-01T10:00:00Z' });
    memory.logEntry(root, 'learning', {
      id: 'les00001', learning: 'so do not', ts: '2026-09-01T10:00:00Z',
      origin: { derived_from: ['err00001'] },
    });
    // A link to something that is NOT in the memory: known to the entry,
    // never a node on the stage. This is the case the two counts
    // disagreed about.
    memory.logEntry(root, 'learning', {
      id: 'les00002', learning: 'points outside', ts: '2026-09-01T10:00:00Z',
      origin: { derived_from: ['nichtdaxx'] },
    });
    const { data, html } = astra.build(root, { title: 'space' });
    const shown = data.entries.slice(0, astra.LIST_MAX);
    const ids = new Set(shown.map((e) => e.id));
    const likeTheStage = shown
      .reduce((n, e) => n + e.links.filter((l) => ids.has(l.id)).length, 0);
    const inTheBar = /of \d+ entries · (\d+) declared/.exec(html);
    assert.ok(inTheBar, 'the bar names no number at all any more');
    assert.equal(Number(inTheBar[1]), likeTheStage,
      `bar says ${inTheBar[1]}, the stage counts ${likeTheStage}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the glow scales with density, or a real memory is a white cloud', () => {
  const script = ohneKommentare(
    page().slice(page().indexOf('<script>'), page().lastIndexOf('</script>')));
  assert.match(script, /var glanz = Math\.min\(1, Math\.sqrt\(220 \/ Math\.max\(1, nodes\.length\)\)\)/,
    'the glow budget is gone, or no longer depends on the node count');
  assert.match(script, /r \* 6 \* glanz/, 'the glow radius does not take the budget');
  assert.match(script, /col \+ glanzAlpha/, 'the glow alpha does not take the budget');
});

test('grid children may shrink, or the page runs off a phone screen', () => {
  const css = styles(page());
  assert.match(css, /\.split>\*\{min-width:0\}/, 'the panes cannot shrink');
  assert.match(css, /overflow-wrap:anywhere/, 'long words break nowhere');
});

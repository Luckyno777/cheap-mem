// The guard: every page this house delivers carries its OWN mark —
// the trail spine with three shrinking bars — and never the sibling
// house's mark (lucky-mem's L with the three-node graph).
//
// **Why this is a separate file from test/icon.test.mjs.** That file
// checks the mark itself (valid PNG, correct corner handling) and that
// the viewer embeds it. It never asks whether a page embeds the WRONG
// mark, or whether the other pages — dashboard, board, console — embed
// nothing at all and whether that silence should count as passing.
// That is Lucky's rule from 2026-09-27 (lucky-mem
// betrieb/BAUPLAN-mem-admin_02.md): the two houses share the same
// palette and the same architecture on purpose ("we only turn the mark
// from a C into an L" — lucky-mem's own marke.mjs quotes that
// decision), and sharing that much makes it easy to copy a header line
// from the wrong repository without any colour or contrast probe ever
// noticing — both marks pass the exact same palette checks.
//
// **The technical fingerprint, measured rather than guessed.**
// - This house's mark: `icon.mark(size, opts)` — a pure function of
//   size and the `{maskable, dark}` flags, no clock, no randomness, so
//   two calls with the same arguments always produce byte-identical
//   PNGs. `viewer.mjs` is the only page that embeds it today
//   (`markLink()`, default size 64, light).
// - The sibling's mark: `lucky-mem/src/marke.mjs` draws an SVG path —
//   `M300 230 V1010 H1010` (the L) plus `M470 730 L690 545 L910 730`
//   with three circles — and `lucky-mem/src/pwa.mjs` draws the same
//   geometry as a PNG. Both are pure functions too.
//
// **No import across the repository boundary — fixed fixtures instead
// of a neighbour path (coordinator finding, 2026-09-27, before this
// merge).** An earlier version of this file imported
// `../../wt-p2/src/marke.mjs`, `pwa.mjs` and `gestalt.mjs` by absolute
// path and called them at test time — the sibling's real generator
// function, but only FOR AS LONG AS the neighbouring worktree `wt-p2`
// happens to sit next to this one. That worktree is a fixture of this
// one session: CI and the VM never have it, and it gets deleted. An
// import across that boundary is "built but unreachable" — the exact
// failure class this house already names for a delivered page (see
// `test/board.test.mjs`'s header on state that was never measured),
// just at the guard itself instead of at a page.
//
// The fix: the foreign geometry, captured ONCE and embedded as text
// constants below (`FOREIGN_LINK_SVG`, `FOREIGN_PNG_B64`) — with
// source and date in the comment, so it is clear what they are a copy
// OF and WHEN they were captured. If lucky-mem's mark ever changes
// geometry or palette, these constants go stale silently; that is the
// price of not depending on a worktree that will not always exist. A
// SHA-256 of the bytes is still the feature actually compared against
// — not the raw bytes spelled out in every failure message.
//
// **What actually carries a mark today — measured, not assumed (order
// point 3; re-measured 2026-09-28 when the dashboard became the only
// UI).** Checked by calling the real render functions against a
// fixture memory:
//   - `viewer.mjs` (`viewer.build()`): the PNG favicon, via
//     `markLink()`.
//   - `dashboard-page.mjs` (`/`, `/dashboard`, `/pult`): the PNG
//     favicon via `markLink()` and the inline C in the sidebar
//     (`markSvg()`) — both from `icon.GEOMETRY`.
//   - `board.mjs` (`mem board --html`): NO `<link rel="icon">`, no
//     embedded PNG — held to "never the foreign mark", not "must carry
//     the own one".
//   - `bin/mem-serve`: `/favicon.ico` and the manifest's icons are
//     `icon.mark()` — the own mark, checked below against the running
//     server's answers, not its source text.
//
// **The graph is shared, the letter is not.** The owner's rule of
// 2026-09-27: "we only turn the mark from a C into an L". Both houses
// draw the same three-node graph at the same coordinates; what tells
// them apart is the letter. So the foreign SIGNATURE is the sibling's L
// path, and the graph path alone proves nothing either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as icon from '../src/icon.mjs';
import * as viewer from '../src/viewer.mjs';
import * as board from '../src/board.mjs';
import * as dashboardPage from '../src/dashboard-page.mjs';
import * as pwa from '../src/pwa.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The foreign mark (lucky-mem), as fixed fixtures — no import across
 * the repository boundary (see the file header for why).
 *
 * **Source: `lucky-mem/src/marke.mjs`, `marke.zeichenLink(gestalt.TINTE)`
 * — the exact `<link rel="icon">` the sibling's `/` and `/post` pages
 * embed for their SVG favicon (dark palette: `grund:#101B1B,
 * tinte:#F6F4EC, violett:#54D6A0`). Captured 2026-09-27** by calling
 * that real generator function once, in the then-present neighbour
 * worktree `wt-p2` (see `git log -1 -- src/marke.mjs src/gestalt.mjs`
 * there at that time for the exact commit). Pure function of the
 * colour table and the size argument — no clock, no randomness — so
 * this text is stable for as long as `marke.zug()`'s geometry and
 * `gestalt.TINTE`'s hex values are not touched.
 */
const FOREIGN_LINK_SVG = '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg%20'
  + 'viewBox%3D%220%200%201240%201240%22%20width%3D%2264%22%20height%3D%2264%22%20role%3D%22img%22%20'
  + 'aria-label%3D%22lucky-mem%22%20fill%3D%22none%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsv'
  + 'g%22%3E%3Crect%20width%3D%221240%22%20height%3D%221240%22%20rx%3D%22223%22%20fill%3D%22%23101B1B%'
  + '22%2F%3E%3Cg%20transform%3D%22translate(620%20620)%20scale(0.8)%20translate(-620%20-620)%22%3E%3C'
  + 'path%20d%3D%22M300%20230%20V1010%20H1010%22%20stroke%3D%22%23F6F4EC%22%20stroke-width%3D%22152%2'
  + '2%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Cpath%20d%3D%22M470%20730'
  + '%20L690%20545%20L910%20730%22%20stroke%3D%22%2354D6A0%22%20stroke-width%3D%2278%22%20stroke-linec'
  + 'ap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3Ccircle%20cx%3D%22690%22%20cy%3D%22545%22'
  + '%20r%3D%22104%22%20fill%3D%22%2354D6A0%22%2F%3E%3Ccircle%20cx%3D%22470%22%20cy%3D%22730%22%20r%3D'
  + '%2288%22%20fill%3D%22%2354D6A0%22%2F%3E%3Ccircle%20cx%3D%22910%22%20cy%3D%22730%22%20r%3D%2288%22'
  + '%20fill%3D%22%2354D6A0%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E">';

/**
 * **Source: `lucky-mem/src/pwa.mjs`, `pwa.symbol(64, {dunkel:false})`
 * — the same geometry as a PNG (the light palette; this is what
 * `pwa.symbolLink()`'s default embeds). Captured 2026-09-27**,
 * alongside `FOREIGN_LINK_SVG` above, same worktree, same commit.
 */
const FOREIGN_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABBUlEQVR42u3bQQ6CMBCF4Z7AuOda'
  + '3sSTuzNucGeMxNriPKbT+ZvMggWk7ysJhTClNI7H/bZGqmI1ogU3g4ge/C+I2cJ3Icwavglh9vBVhCzhvyKkBsgWfoPQe+J5W'
  + 'TYVFsAifGgEAAAAAAAAAAAAAAAAAAAAb4DT9fKqVADvwT9reoBa+CMQAPAEaAmvRgAAAAB8AHrCKxFcAPaEVyEcCvArWO1YhS'
  + 'ADsFpR9Z0hAbCetBLBHEA1WdV1XQAUL00AAADAGADqDxzDPwVqE7XavAy/D+CjKAAAAABARoDRKj1ACwIAAGQH6P1feCYA07/'
  + 'Fw64+DRMA0DRF2xyNk7TO0jydtn3+CQSGdEORfWMuAAAAAElFTkSuQmCC';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-guard-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  return r;
}

/** SHA-256 of a PNG buffer, as hex — short enough to put in a message. */
function pngHash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Every `data:image/png;base64,...` occurrence in a page, decoded. */
function pngsFromHtml(html) {
  return [...html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)]
    .map((m) => Buffer.from(m[1], 'base64'));
}

/**
 * The path signatures unique to the sibling's own mark (`marke.zug()`).
 * Both the raw form (the inline `<svg>` the sibling's nav bar embeds)
 * and the percent-encoded form matter: the sibling's favicon link
 * (`marke.zeichenLink()`) carries the same SVG as a
 * `data:image/svg+xml,<percent-encoded>` URI, not base64 — a plain
 * space there is `%20`, so a text search that only knew the raw form
 * would miss exactly that channel.
 */
const FOREIGN_PATHS = Object.freeze([
  'M300 230 V1010 H1010', encodeURIComponent('M300 230 V1010 H1010'),        // the L
  // Not the graph (`M470 730 L690 545 L910 730`): both houses draw it
  // (see the file header, "The graph is shared, the letter is not").
]);

/**
 * The guard itself: checks one delivered page against this house's own
 * mark and the sibling's foreign one. One function, not a copy per
 * test, so the positive control, the sabotage and the "empty does not
 * pass" case all use the same yardstick.
 *
 * @param html    the delivered page
 * @param must    true: this page MUST carry its own mark today
 * @returns a reason the page fails, or null when it passes.
 */
function guardVerdict(html, {
  must,
  foreignHashes = [],
  ownHashes = [icon.markLink().match(/base64,([^"]+)/)[1]]
    .map((b64) => pngHash(Buffer.from(b64, 'base64'))),
} = {}) {
  const hasForeignPath = FOREIGN_PATHS.some((p) => html.includes(p));
  const pngHashesFound = pngsFromHtml(html).map(pngHash);
  const hasForeignPng = pngHashesFound.some((h) => foreignHashes.includes(h));
  if (hasForeignPath || hasForeignPng) return 'carries the FOREIGN mark (lucky-mem)';
  const ownPngs = pngHashesFound.filter((h) => ownHashes.includes(h));
  if (must && ownPngs.length === 0) {
    return 'carries NO mark, though this page must carry its own today — empty is not a pass';
  }
  return null;
}

test('POSITIVE CONTROL: the viewer carries its own mark, never the foreign one', () => {
  const r = root();
  try {
    const { html } = viewer.build(r, { title: 'cheap-mem' });
    assert.equal(guardVerdict(html, { must: true }), null);
    // Confirmed with the real generator, not just "a PNG is present":
    // its hash matches icon.mark(64) exactly (markLink()'s default).
    const pngs = pngsFromHtml(html);
    assert.ok(pngs.length >= 1, 'the viewer ships no PNG icon');
    assert.ok(pngs.some((b) => pngHash(b) === pngHash(icon.mark(64))),
      'the viewer icon does not hash to icon.mark(64)');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the dashboard carries its own mark: the PNG favicon and the inline C', () => {
  const html = dashboardPage.asHtml({ title: 'cheap-mem' });
  assert.equal(guardVerdict(html, { must: true }), null);
  assert.ok(html.includes(icon.cPath()), 'the sidebar no longer draws the own C');
  assert.ok(pwa.insertHead(html).includes('apple-touch-icon'), 'the served head lost its touch icon');
});

test("TODAY'S STATE, PINNED: board carries no mark at all", () => {
  const r = root();
  try {
    const boardHtml = board.asHtml(board.board(r, { now: new Date() }));
    assert.ok(!boardHtml.includes('<link rel="icon"'), 'board now carries a <link rel="icon"> — this comment is stale, please update it');
    assert.equal(pngsFromHtml(boardHtml).length, 0, 'board now embeds a PNG — this comment is stale, please update it');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('bin/mem-serve: favicon and manifest icons are the own mark, never the foreign one', async () => {
  const r = root();
  const { serve } = await import('../bin/mem-serve');
  const { server } = await serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '' });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const fav = Buffer.from(await (await fetch(base + '/favicon.ico')).arrayBuffer());
    assert.equal(pngHash(fav), pngHash(icon.mark(32, { dark: true })), '/favicon.ico is not icon.mark()');
    const foreign = pngHash(Buffer.from(FOREIGN_PNG_B64, 'base64'));
    assert.notEqual(pngHash(fav), foreign);
    const man = await (await fetch(base + '/manifest.webmanifest')).json();
    assert.ok(man.icons.length >= 2, 'the manifest lists no icons');
    for (const i of man.icons) {
      const png = Buffer.from(i.src.replace(/^data:image\/png;base64,/, ''), 'base64');
      assert.notEqual(pngHash(png), foreign, `manifest icon ${i.sizes} is the foreign mark`);
      assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', `manifest icon ${i.sizes} is not a PNG`);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((res) => server.close(res));
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('SABOTAGE: the foreign mark (lucky-mem) spliced into the dashboard turns the guard RED', () => {
  const foreignLink = FOREIGN_LINK_SVG; // the fixed fixture, see file header

  const r = root();
  try {
    const html = dashboardPage.asHtml({ title: 'cheap-mem' });
    // Before: green — the same positive control, right next to the
    // sabotage, so the difference is visible in one test run.
    assert.equal(guardVerdict(html, { must: true }), null);

    // The sabotage itself: the foreign <link> spliced into the head —
    // exactly the pattern a copy-pasted header line from the wrong
    // repository would leave behind.
    const sabotaged = html.replace('</head>', `${foreignLink}\n</head>`);
    const verdict = guardVerdict(sabotaged, { must: false });
    assert.ok(verdict, 'the sabotage with the foreign SVG mark was NOT caught — the guard is blind');
    assert.match(verdict, /FOREIGN/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SABOTAGE: the viewer with its own mark replaced by the foreign one turns RED', () => {
  const foreignHashes = [pngHash(Buffer.from(FOREIGN_PNG_B64, 'base64'))];

  const r = root();
  try {
    const { html } = viewer.build(r, { title: 'cheap-mem' });
    const ownLink = icon.markLink();
    assert.ok(html.includes(ownLink), 'precondition broken: the viewer no longer carries its own markLink() output');
    const sabotaged = html.replace(ownLink,
      `<link rel="icon" type="image/png" href="data:image/png;base64,${FOREIGN_PNG_B64}">`);
    const verdict = guardVerdict(sabotaged, { must: true, foreignHashes });
    assert.ok(verdict, 'own mark swapped for the foreign PNG was not caught');
    assert.match(verdict, /FOREIGN/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('EMPTY IS NOT A PASS: the viewer stripped of its icon is RED, not GREEN', () => {
  // The difference from the sabotage above: nothing foreign is added
  // here. A guard that only checks "no foreign mark found" would be
  // green on this input — which is exactly the failure this test rules
  // out, because the viewer is one of the pages that must carry its
  // own mark today.
  const r = root();
  try {
    const { html } = viewer.build(r, { title: 'cheap-mem' });
    const ownLink = icon.markLink();
    assert.ok(html.includes(ownLink), 'precondition broken: the viewer no longer carries its own markLink() output');
    const stripped = html.replace(ownLink, '');
    const verdict = guardVerdict(stripped, { must: true });
    assert.ok(verdict, 'a page with no mark at all was reported as passing — empty must not be green here');
    assert.match(verdict, /NO mark/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SABOTAGE: even board (no mark today) turns RED the moment the foreign one lands', () => {
  // The strongest case: a page that shows nothing today is not
  // automatically safe from the foreign mark. The guard must catch it
  // here too, or "carries nothing today" would be a blind spot.
  const foreignLink = FOREIGN_LINK_SVG;

  const r = root();
  try {
    const html = board.asHtml(board.board(r, { now: new Date() }));
    assert.equal(guardVerdict(html, { must: false }), null,
      'precondition: board should carry neither the own nor the foreign mark today');
    // board.mjs's page opens `<html lang="en"><meta charset="utf-8">`
    // with no explicit `<head>` (HTML5 allows the omission) — so the
    // splice point is the first `<style>`, not a `</head>` that is not
    // there to find.
    const target = html.includes('</head>')
      ? html.replace('</head>', `${foreignLink}\n</head>`)
      : html.replace('<style>', `${foreignLink}\n<style>`);
    const verdict = guardVerdict(target, { must: false });
    assert.ok(verdict, 'the foreign mark landing in board.mjs was not caught');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

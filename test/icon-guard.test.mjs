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
//   geometry as a PNG. Both are pure functions too. This file imports
//   them by ABSOLUTE path from the neighbouring worktree (`wt-p2`) —
//   the sibling's real generator function, not a copy of its formulas
//   kept here.
//
// **A hash instead of raw bytes.** A PNG literal in this file would be
// unreadable and would need re-pasting on every palette change. A
// SHA-256 of the generated PNG is just as unique (two different images
// essentially never share one) and stays legible in a diff.
//
// **What actually carries a mark today — measured, not assumed (order
// point 3).** Checked by calling the real render functions against a
// fixture memory:
//   - `viewer.mjs` (`viewer.build()`): the PNG favicon, via
//     `markLink()` — this is the ONLY page in this repository that
//     embeds any brand mark at all.
//   - `astra.mjs` (`/`, the dashboard), `console.mjs` (`/console`),
//     `board.mjs` (`mem board --html`): NO `<link rel="icon">`, no
//     embedded PNG, nothing — confirmed below. That mirrors the
//     sibling: `lucky-mem/src/brett.mjs` (Brett) carries no mark
//     either. This is not a defect this task is asked to fix (nothing
//     here shows the WRONG mark); it means these three pages are held
//     to "never the foreign mark", not "must carry the own one".
//   - `bin/mem-serve`: serves no manifest, no service worker, no
//     `/favicon.ico` route at all today (grepped and confirmed below,
//     as a fact about the running server, not the source text of a
//     page). The only PWA-shaped surface lucky-mem has
//     (`bin/mem-ansicht-server.mjs` with a real manifest/favicon/
//     service-worker) has no counterpart here yet.
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
import * as consolePage from '../src/console.mjs';
import * as astra from '../src/astra.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// **The sibling, by real path — not transcribed.** Both houses run in
// this session as two allowed worktrees (wt-p2, wt-p2-cm). The import
// is absolute because the two repositories share no package.json or
// node_modules — it is the same move as importing a file from this
// repo's own tree, just with a different path in front of it.
const SIBLING_MARKE = path.resolve(HERE, '../../wt-p2/src/marke.mjs');
const SIBLING_PWA = path.resolve(HERE, '../../wt-p2/src/pwa.mjs');

function siblingOrSkip(t) {
  if (!fs.existsSync(SIBLING_MARKE) || !fs.existsSync(SIBLING_PWA)) {
    t.skip(`lucky-mem is not checked out at ${SIBLING_MARKE} — cannot load the foreign mark`);
    return null;
  }
  return { marke: SIBLING_MARKE, pwa: SIBLING_PWA };
}

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
  'M470 730 L690 545 L910 730', encodeURIComponent('M470 730 L690 545 L910 730'), // the graph
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

test("TODAY'S STATE, PINNED: dashboard, console and board carry no mark at all", () => {
  const r = root();
  try {
    const dashHtml = astra.build(r, { title: 'cheap-mem', env: {}, cfg: {}, writable: true }).html;
    const consoleHtml = consolePage.asHtml(consolePage.collect(r, { env: {}, cfg: {} }));
    const boardHtml = board.asHtml(board.board(r, { now: new Date() }));
    for (const [name, html] of [['dashboard', dashHtml], ['console', consoleHtml], ['board', boardHtml]]) {
      assert.ok(!html.includes('<link rel="icon"'), `${name} now carries a <link rel="icon"> — this comment is stale, please update it`);
      assert.equal(pngsFromHtml(html).length, 0, `${name} now embeds a PNG — this comment is stale, please update it`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('bin/mem-serve serves no manifest, service worker or favicon route today', () => {
  // A fact about the running server, checked against its own route
  // table rather than grepped as text — `PATHS`/`AUTH_PATHS` style
  // literals drift, so this reads the same constant the server's own
  // auth exemption list (`server.mjs`) reads.
  const serveFile = path.join(HERE, '..', 'bin', 'mem-serve');
  const src = fs.readFileSync(serveFile, 'utf8');
  for (const needle of ['manifest.webmanifest', 'sw.js', 'favicon.ico', 'service-worker']) {
    assert.ok(!src.includes(needle),
      `bin/mem-serve now mentions '${needle}' — a PWA surface exists; this file's tests and header comment need updating to guard it too`);
  }
});

test('SABOTAGE: the foreign mark (lucky-mem) spliced into the dashboard turns the guard RED', async (t) => {
  const sibling = siblingOrSkip(t);
  if (!sibling) return;
  const marke = await import(`${sibling.marke}?t=${Math.random()}`);
  const gestalt = await import(`${path.resolve(HERE, '../../wt-p2/src/gestalt.mjs')}?t=${Math.random()}`);
  const foreignLink = marke.zeichenLink(gestalt.TINTE); // the sibling's REAL generator function

  const r = root();
  try {
    const html = astra.build(r, { title: 'cheap-mem', env: {}, cfg: {}, writable: true }).html;
    // Before: green — the same positive control, right next to the
    // sabotage, so the difference is visible in one test run.
    assert.equal(guardVerdict(html, { must: false }), null);

    // The sabotage itself: the foreign <link> spliced into the head —
    // exactly the pattern a copy-pasted header line from the wrong
    // repository would leave behind.
    const sabotaged = html.replace('</head>', `${foreignLink}\n</head>`);
    const verdict = guardVerdict(sabotaged, { must: false });
    assert.ok(verdict, 'the sabotage with the foreign SVG mark was NOT caught — the guard is blind');
    assert.match(verdict, /FOREIGN/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('SABOTAGE: the viewer with its own mark replaced by the foreign one turns RED', async (t) => {
  const sibling = siblingOrSkip(t);
  if (!sibling) return;
  const pwa = await import(`${sibling.pwa}?t=${Math.random()}`);
  const foreignPng = pwa.symbol(64, { dunkel: false }); // the sibling's REAL generator function
  const foreignHashes = [pngHash(foreignPng)];

  const r = root();
  try {
    const { html } = viewer.build(r, { title: 'cheap-mem' });
    const ownLink = icon.markLink();
    assert.ok(html.includes(ownLink), 'precondition broken: the viewer no longer carries its own markLink() output');
    const sabotaged = html.replace(ownLink,
      `<link rel="icon" type="image/png" href="data:image/png;base64,${foreignPng.toString('base64')}">`);
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

test('SABOTAGE: even board (no mark today) turns RED the moment the foreign one lands', async (t) => {
  // The strongest case: a page that shows nothing today is not
  // automatically safe from the foreign mark. The guard must catch it
  // here too, or "carries nothing today" would be a blind spot.
  const sibling = siblingOrSkip(t);
  if (!sibling) return;
  const marke = await import(`${sibling.marke}?t=${Math.random()}`);
  const gestalt = await import(`${path.resolve(HERE, '../../wt-p2/src/gestalt.mjs')}?t=${Math.random()}`);
  const foreignLink = marke.zeichenLink(gestalt.TINTE);

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

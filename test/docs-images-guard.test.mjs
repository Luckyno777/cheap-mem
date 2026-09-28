// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/docs-images-guard.test.mjs -- guard for the documentation
// screenshots (task docs-images, 2026-09-28; mirrors the sibling house's
// test/doku-bilder-riegel.test.mjs).
//
// Two things are checked here, neither needs Playwright/a browser (fast,
// runs in every partial and full suite):
//
//  1. **Red proof for the temp guard.** `bench/docs-images.mjs` exports
//     `assertRootIsTemp()` -- the function that stops the script from
//     ever running against a real store (the owner's own rule: "a real
//     store -> abort"). On a real path (this repo itself) it MUST throw;
//     on a real temp directory it MUST pass -- that is also the positive
//     control proving the check distinguishes anything at all.
//  2. **Every image linked from the README** under `docs/images/` exists
//     and is under 400 KB; the whole folder stays under 3 MB. The images
//     must also stay OUT of the npm package (see test/package-size.test.mjs
//     and the `files`/`!docs/images/*` entries in package.json).
//
// What is NOT checked: whether the images look right (needs a human) or
// whether the server truly starts (already covered by
// test/sphere-visible.test.mjs / dash-fix4-tabs-visible).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRootIsTemp } from '../bench/docs-images.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const IMAGES_DIR = path.join(REPO, 'docs', 'images');
const MAX_IMAGE_BYTES = 400 * 1024;
const MAX_DIR_BYTES = 3 * 1024 * 1024;

test('assertRootIsTemp: RED on a real store (this repo)', () => {
  assert.throws(() => assertRootIsTemp(REPO), /may only run against a synthetic temp store/);
});

test('assertRootIsTemp: RED on the home directory (if readable)', () => {
  const home = os.homedir();
  if (!fs.existsSync(home)) return;
  assert.throws(() => assertRootIsTemp(home));
});

test('assertRootIsTemp: positive control -- a real temp directory passes', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-images-guard-positive-'));
  try {
    assert.doesNotThrow(() => assertRootIsTemp(t));
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
});

function linkedImages() {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const hits = [...readme.matchAll(/docs\/images\/[\w.-]+\.(?:png|webp)/g)].map((m) => m[0]);
  assert.ok(hits.length >= 4, `README.md links too few docs images (${hits.length}) -- is the probe blind?`);
  return [...new Set(hits)];
}

test('every image linked from the README exists and is < 400 KB', () => {
  const faults = [];
  for (const rel of linkedImages()) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) { faults.push(`${rel}: missing`); continue; }
    const size = fs.statSync(abs).size;
    if (size > MAX_IMAGE_BYTES) faults.push(`${rel}: ${(size / 1024).toFixed(1)} KB > 400 KB`);
  }
  assert.deepEqual(faults, [], faults.join('\n'));
});

test('docs/images/ stays under 3 MB total', () => {
  if (!fs.existsSync(IMAGES_DIR)) return; // before bench/docs-images.mjs has ever run
  const total = fs.readdirSync(IMAGES_DIR)
    .filter((n) => /\.(png|webp)$/.test(n))
    .reduce((sum, n) => sum + fs.statSync(path.join(IMAGES_DIR, n)).size, 0);
  assert.ok(total < MAX_DIR_BYTES, `docs/images/ is ${(total / 1024 / 1024).toFixed(2)} MB, cap is 3 MB`);
});

test('docs/images/ is excluded from the npm package (files field)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const files = pkg.files || [];
  const excluded = files.some((f) => /^!docs\/images\//.test(f));
  assert.ok(excluded, 'package.json "files" must exclude docs/images/* (see the docs/assets/brand/* pattern already there)');
});

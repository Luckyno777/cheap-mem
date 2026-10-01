// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/docimages-state.mjs -- W7: docs-image freshness. ONE place that
// records WHICH files determine how the documentation screenshots look,
// and that writes the state when shooting (bench/docs-images.mjs) or
// reads it when checking (src/doctor.mjs, finding `docs-images-fresh`).
// Lives in src/ because the doctor never imports from bench/ (guard:
// test/src-no-bench-import.test.mjs).
//
// The doctor NEVER reshoots itself (automatic binary commits, and
// nobody looks at the images before the commit) -- it only says the
// images are older than the UI and names the one command.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CODE_ROOT = path.join(HERE, '..');

export const IMAGES_DIR = 'docs/images';
export const STATE_FILE = 'docs/images/.state.json';
export const RESHOOT_COMMAND = 'node bench/docs-images.mjs';

/**
 * The UI files the screenshots' look depends on -- THE one list, shared
 * by writer and checker. Entry = file (repo-relative) or directory
 * (ends in '/', not recursive, filtered by `exts`). Chosen deliberately:
 * dashboard script and style, the page shell (src/dashboard-page.mjs),
 * the sign-in page (src/login.mjs), the board and viewer pages
 * (src/board.mjs, src/viewer.mjs), the vendored fonts and the 3D
 * library. NOT in it: data/cache modules (they decide content, not
 * look; the demo store is synthetic anyway).
 */
export const UI_FILES = Object.freeze([
  Object.freeze({ path: 'assets/dashboard/', exts: Object.freeze(['.js', '.css']) }),
  Object.freeze({ path: 'assets/fonts/', exts: Object.freeze(['.woff2']) }),
  Object.freeze({ path: 'assets/three/', exts: Object.freeze(['.js']) }),
  Object.freeze({ path: 'src/dashboard-page.mjs' }),
  Object.freeze({ path: 'src/login.mjs' }),
  // README images docs/assets/brand/04-board.png and 05-viewer.png
  // (`mem board --html`, `mem viewer`) -- pages that bypass the dashboard.
  Object.freeze({ path: 'src/board.mjs' }),
  Object.freeze({ path: 'src/viewer.mjs' }),
]);

/** The resolved, sorted file list (repo-relative, '/'-separated). */
export function uiFiles(root = CODE_ROOT) {
  const out = new Set();
  for (const e of UI_FILES) {
    if (e.path.endsWith('/')) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, e.path)); } catch { /* missing */ }
      for (const n of names) if (e.exts.includes(path.extname(n))) out.add(e.path + n);
    } else {
      out.add(e.path);
    }
  }
  return [...out].sort();
}

/** {path: sha256-hex | null (file missing)} over the current UI. */
export function hashUi(root = CODE_ROOT) {
  const r = {};
  for (const p of uiFiles(root)) {
    try { r[p] = createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex'); } catch { r[p] = null; }
  }
  return r;
}

/** Called by the shooting script AFTER the shots; `surface` = the hashes
 * taken at the START (if the UI changes mid-run the state must not hide
 * it). */
export function writeState(root = CODE_ROOT, now = new Date(), surface = null) {
  const file = path.join(root, STATE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = { erzeugt_am: now.toISOString(), oberflaeche: surface || hashUi(root) };
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
  return state;
}

/**
 * Comparison for the finding: { state: 'good'|'warn'|'unknown', text,
 * changed: [path] }. Missing/broken state file = unknown (never good). A
 * path counts as changed when its hash differs, is new, or vanished.
 */
export function checkState(root = CODE_ROOT) {
  const file = path.join(root, STATE_FILE);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    const missing = e && e.code === 'ENOENT';
    return {
      state: 'unknown', changed: [],
      text: missing
        ? `${STATE_FILE} is missing — cannot show which UI the docs images were shot from`
        : `${STATE_FILE} is unreadable (${e && e.message})`,
    };
  }
  if (!state || typeof state.oberflaeche !== 'object' || state.oberflaeche === null) {
    return { state: 'unknown', changed: [], text: `${STATE_FILE} holds no UI hashes` };
  }
  const now = hashUi(root);
  const all = new Set([...Object.keys(state.oberflaeche), ...Object.keys(now)]);
  const changed = [...all].filter((p) => (state.oberflaeche[p] ?? null) !== (now[p] ?? null)).sort();
  if (!changed.length) {
    return {
      state: 'good', changed,
      text: `docs images were shot from today's UI (${Object.keys(now).length} files, shot ${state.erzeugt_am || '?'})`,
    };
  }
  return { state: 'warn', changed, text: `Docs images older than the UI: ${changed.join(', ')}` };
}

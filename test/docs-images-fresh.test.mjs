// test/docs-images-fresh.test.mjs -- W7: docs-image freshness.
// Writer (src/docimages-state.mjs: writeState, called by
// bench/docs-images.mjs) and checker (doctor finding `docs-images-fresh`)
// use the SAME constant UI_FILES. No browser needed.
//
// RED PROOF: at the pinned commit BASE_COMMIT there is neither
// src/docimages-state.mjs nor the finding -- the probe at the bottom
// pins that (git show BASE_COMMIT:src/docimages-state.mjs fails).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as d from '../src/docimages-state.mjs';
import { checkDocsImagesFresh } from '../src/doctor.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE_COMMIT = '782782f9d11779a06cea820c519a2366d0457de0';

function dummy() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dif-'));
  for (const e of d.UI_FILES) {
    if (e.path.endsWith('/')) {
      fs.mkdirSync(path.join(w, e.path), { recursive: true });
      fs.writeFileSync(path.join(w, e.path, 'a' + e.exts[0]), 'one');
      fs.writeFileSync(path.join(w, e.path, 'ignored.txt'), 'x');
    } else {
      fs.mkdirSync(path.dirname(path.join(w, e.path)), { recursive: true });
      fs.writeFileSync(path.join(w, e.path), 'one');
    }
  }
  return w;
}

test('the list resolves in the real repo and holds the core pieces (positive control)', () => {
  const l = d.uiFiles(REPO);
  for (const p of ['assets/dashboard/dashboard.css', 'assets/dashboard/dashboard.js', 'src/dashboard-page.mjs', 'src/login.mjs']) {
    assert.ok(l.includes(p), p);
  }
  assert.ok(l.some((p) => p.startsWith('assets/fonts/') && p.endsWith('.woff2')));
});

test('missing state -> unknown, never good', () => {
  const r = checkDocsImagesFresh(dummy());
  assert.equal(r.level, 'unknown');
  assert.match(r.text, /missing/);
});

test('written state + unchanged UI -> good', () => {
  const w = dummy();
  const s = d.writeState(w, new Date('2026-09-29T10:00:00Z'));
  assert.equal(s.created_at, '2026-09-29T10:00:00.000Z');
  assert.ok(fs.existsSync(path.join(w, d.STATE_FILE)));
  assert.equal(checkDocsImagesFresh(w).level, 'good');
  assert.ok(!Object.keys(s.surface).some((p) => p.endsWith('.txt')), 'extension filter');
});

test('a state file with the pre-2026-10-01 German keys is still read', () => {
  // Rename of the state keys (English throughout): an old file must not
  // turn a good state into unknown. Control: the same file without its
  // hashes IS unknown, so the probe sees the keys at all.
  const w = dummy();
  const s = d.writeState(w, new Date('2026-09-29T10:00:00Z'));
  const file = path.join(w, d.STATE_FILE);
  fs.writeFileSync(file, JSON.stringify({ erzeugt_am: s.created_at, oberflaeche: s.surface }));
  assert.equal(checkDocsImagesFresh(w).level, 'good');
  fs.writeFileSync(file, JSON.stringify({ erzeugt_am: s.created_at }));
  assert.equal(checkDocsImagesFresh(w).level, 'unknown');
});

test('changed file -> warn naming the file and the one command; added/removed likewise', () => {
  const w = dummy();
  d.writeState(w);
  fs.writeFileSync(path.join(w, 'src/login.mjs'), 'two');
  const r = checkDocsImagesFresh(w);
  assert.equal(r.level, 'warn');
  assert.match(r.text, /Docs images older than the UI: src\/login\.mjs$/);
  assert.ok(r.advice.includes(d.RESHOOT_COMMAND));
  d.writeState(w);
  assert.equal(checkDocsImagesFresh(w).level, 'good');
  fs.writeFileSync(path.join(w, 'assets/dashboard/new.js'), 'n');
  assert.match(checkDocsImagesFresh(w).text, /assets\/dashboard\/new\.js/);
  fs.rmSync(path.join(w, 'assets/dashboard/new.js'));
  fs.rmSync(path.join(w, 'src/dashboard-page.mjs'));
  assert.match(checkDocsImagesFresh(w).text, /src\/dashboard-page\.mjs/);
});

test('broken state -> unknown', () => {
  const w = dummy();
  fs.mkdirSync(path.join(w, 'docs/images'), { recursive: true });
  fs.writeFileSync(path.join(w, d.STATE_FILE), '{broken');
  assert.equal(checkDocsImagesFresh(w).level, 'unknown');
  fs.writeFileSync(path.join(w, d.STATE_FILE), '{}');
  assert.equal(checkDocsImagesFresh(w).level, 'unknown');
});

test('ONE source: the script calls writeState from src/, the doctor calls checkState; no second list', () => {
  const script = fs.readFileSync(path.join(REPO, 'bench/docs-images.mjs'), 'utf8');
  assert.match(script, /from '\.\.\/src\/docimages-state\.mjs'/);
  assert.match(script, /writeState\(/);
  const doctor = fs.readFileSync(path.join(REPO, 'src/doctor.mjs'), 'utf8');
  assert.match(doctor, /docimages\.checkState\(/);
  for (const t of [script, doctor]) assert.ok(!/assets\/fonts\/|assets\/dashboard\//.test(t.replace(/\/\/.*$/gm, '')), 'no second file list');
});

test('RED proof against a fixed commit: the base had no such module', () => {
  const r = spawnSync('git', ['-C', REPO, 'show', `${BASE_COMMIT}:src/docimages-state.mjs`], { encoding: 'utf8' });
  if (r.status !== 0 && /bad object|unknown revision|not a valid|invalid object/.test(r.stderr)) return; // clone without that commit
  assert.notEqual(r.status, 0);
});

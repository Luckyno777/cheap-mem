import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATE, LIMIT_MINUTES, provenance, asLine, notable } from '../src/provenance.mjs';

function repo({ commits = 1, dirty = false } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  const g = (...a) => spawnSync('git', ['-C', d, ...a], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'Test');
  for (let i = 0; i < commits; i += 1) {
    fs.writeFileSync(path.join(d, `f${i}.txt`), String(i));
    g('add', '-A'); g('commit', '-qm', `c${i}`);
  }
  if (dirty) fs.writeFileSync(path.join(d, 'dirt.txt'), 'x');
  return d;
}

test('a directory without git is "no-git", not "fresh"', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
  try {
    const p = provenance(d);
    assert.equal(p.state, STATE.NO_GIT);
    assert.match(asLine(p), /no provenance/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a directory that is not there is "unknown" — never "fresh"', () => {
  const p = provenance('/does/not/exist/at/all');
  assert.equal(p.state, STATE.UNKNOWN);
  assert.ok(notable(p));
});

test('a fresh commit is fresh, and the line still names the directory', () => {
  const d = repo();
  try {
    const p = provenance(d);
    assert.equal(p.state, STATE.FRESH);
    assert.match(asLine(p), new RegExp(path.basename(d)));
    assert.ok(!notable(p));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('past the limit it is STALE, with the limit named', () => {
  const d = repo();
  try {
    const p = provenance(d, { now: Date.now() + 3 * 3600 * 1000, limit: 90 });
    assert.equal(p.state, STATE.STALE);
    assert.match(asLine(p), /STALE \(limit 90 min\)/);
    assert.ok(notable(p));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a dirty tree is reported — the hook does not pull there', () => {
  const d = repo({ dirty: true });
  try {
    const p = provenance(d);
    assert.equal(p.dirty, true);
    assert.match(asLine(p), /dirty/);
    assert.ok(notable(p), 'a dirty tree counts as unremarkable');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('without remote tracking no lag is claimed', () => {
  const d = repo();
  try {
    assert.equal(provenance(d).behind, null);
    assert.ok(!/behind origin/.test(asLine(provenance(d))));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the limit is a named constant, not a scattered value', () => {
  const d = repo();
  try {
    assert.equal(typeof LIMIT_MINUTES, 'number');
    assert.equal(provenance(d).limit_minutes, LIMIT_MINUTES);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

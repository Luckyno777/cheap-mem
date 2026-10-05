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

// The gate: STALE needs age > limit AND (behind > 0 OR behind unknown).
// A clone with a tracked origin: `origin` is bare, `work` clones it.
function tracked({ behind = 0 } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-t-'));
  const run = (cwd, ...a) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  const other = path.join(base, 'other');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  spawnSync('git', ['clone', '-q', origin, work]);
  for (const d of [work]) { run(d, 'config', 'user.email', 't@example.invalid'); run(d, 'config', 'user.name', 'T'); }
  fs.writeFileSync(path.join(work, 'a.txt'), 'a');
  run(work, 'add', '-A'); run(work, 'commit', '-qm', 'a'); run(work, 'push', '-q', 'origin', 'HEAD:main');
  run(work, 'branch', '-q', '--set-upstream-to=origin/main');
  if (behind > 0) {
    spawnSync('git', ['clone', '-q', origin, other]);
    run(other, 'config', 'user.email', 't@example.invalid'); run(other, 'config', 'user.name', 'T');
    for (let i = 0; i < behind; i += 1) {
      fs.writeFileSync(path.join(other, `b${i}.txt`), 'b');
      run(other, 'add', '-A'); run(other, 'commit', '-qm', `b${i}`);
    }
    run(other, 'push', '-q', 'origin', 'HEAD:main');
    run(work, 'fetch', '-q', 'origin');
  }
  return { base, work };
}
const LATER = () => Date.now() + 3 * 3600 * 1000;

test('(a) old but level with origin (behind 0) is NOT stale', () => {
  const { base, work } = tracked();
  try {
    const p = provenance(work, { now: LATER(), limit: 90 });
    assert.equal(p.behind, 0);
    assert.notEqual(p.state, STATE.STALE);
    assert.equal(p.state, STATE.FRESH);
    assert.match(asLine(p), /old but level with origin/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('(b) old and behind origin is STALE', () => {
  const { base, work } = tracked({ behind: 2 });
  try {
    const p = provenance(work, { now: LATER(), limit: 90 });
    assert.equal(p.behind, 2);
    assert.equal(p.state, STATE.STALE);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('(c) old and lag unknown (no origin ref) is STALE — unknown is not fine', () => {
  const d = repo();
  try {
    const p = provenance(d, { now: LATER(), limit: 90 });
    assert.equal(p.behind, null);
    assert.equal(p.state, STATE.STALE);
    assert.match(asLine(p), /lag unknown/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('(d) young is FRESH whatever the lag', () => {
  const synced = tracked();
  const lagging = tracked({ behind: 1 });
  const unknown = repo();
  try {
    for (const d of [synced.work, lagging.work, unknown]) {
      assert.equal(provenance(d).state, STATE.FRESH);
    }
  } finally { for (const d of [synced.base, lagging.base, unknown]) fs.rmSync(d, { recursive: true, force: true }); }
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/verify-verdict.test.mjs — POST /dashboard/verify-verdict (N9
// parity): a human's judgement on an uncertain fact from the Today
// card, appended OUTSIDE the memory, never a write to the repository
// under review.
//
// Red proof pinned to this worktree's starting commit
// (ddca89d5430b7c2866a93788edd6fe14822af337, never `git merge-base`):
// that server answers 404 for this route (it does not exist at all).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import * as verifylog from '../src/verifylog.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';
const MEM = path.join(REPO, 'bin', 'mem');
const DOOR = ['verify-verdict-probe', String(process.pid)].join('-');

function memoryRoot({ allowWrites = true } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verify-verdict-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  const file = path.join(r, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (allowWrites) cfg.dashboard = { allowWrites: true };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return r;
}

async function start(scriptPath, root, env = {}) {
  const mod = await import(`${pathToFileURL(scriptPath).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', ...env,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: (route, body) => fetch(`${base}${route}`, {
      method: 'POST', redirect: 'manual',
      headers: { authorization: `Bearer ${DOOR}`, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
    stop: () => new Promise((res) => { server.closeAllConnections?.(); server.close(res); }),
  };
}

test('RED on the old commit: the route does not exist at all (404)', { timeout: 20000 }, async () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:bin/mem-serve`], { cwd: REPO, encoding: 'utf8' });
  const tmp = path.join(REPO, 'bin', '.verify-verdict-old-mem-serve.mjs');
  fs.writeFileSync(tmp, old);
  const root = memoryRoot();
  let s;
  try {
    s = await start(tmp, root);
    const res = await s.post('/dashboard/verify-verdict', 'key=x&verdict=still-current');
    assert.equal(res.status, 404, 'the old commit must not answer this route at all');
  } finally {
    await s?.stop();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GREEN: with writes allowed, one line is appended OUTSIDE the memory root, and nothing inside it changes', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verify-target-')), 'facts-verdict.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_VERIFY_FILE: target });
    const before = fs.readdirSync(path.join(root, '.mem'));
    const res = await s.post('/dashboard/verify-verdict', new URLSearchParams({
      key: 'server.users', project: 'global', verdict: 'outdated', ageDays: '400', conflict: '0', note: 'checked by hand',
    }).toString());
    const body = await res.json();
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.equal(body.state, 'ok');
    assert.ok(body.id);
    const { rows } = verifylog.read(target);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'server.users');
    assert.equal(rows[0].verdict, 'outdated');
    assert.equal(rows[0].ageDays, 400);
    assert.equal(rows[0].note, 'checked by hand');
    // Nothing inside the memory root moved.
    assert.deepEqual(fs.readdirSync(path.join(root, '.mem')).sort(), before.sort());
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('a target under the memory root is refused, and nothing is written', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  const insideTarget = path.join(root, 'verify.jsonl'); // inside the repo on purpose
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_VERIFY_FILE: insideTarget });
    const res = await s.post('/dashboard/verify-verdict', 'key=x&verdict=still-current');
    const body = await res.json();
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.equal(body.state, 'error');
    assert.match(body.reason, /outside/);
    assert.equal(fs.existsSync(insideTarget), false);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unknown verdict word or a missing key is refused (400), nothing written', { timeout: 20000 }, async () => {
  const root = memoryRoot();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verify-target2-')), 'facts-verdict.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_VERIFY_FILE: target });
    const bad1 = await s.post('/dashboard/verify-verdict', 'key=x&verdict=maybe-ish');
    assert.equal(bad1.status, 400);
    const bad2 = await s.post('/dashboard/verify-verdict', 'verdict=still-current');
    assert.equal(bad2.status, 400);
    assert.equal(fs.existsSync(target), false, 'a rejected verdict must not create the target file');
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('with the write switch off (default), the route refuses and writes nothing', { timeout: 20000 }, async () => {
  const root = memoryRoot({ allowWrites: false });
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verify-target3-')), 'facts-verdict.jsonl');
  let s;
  try {
    s = await start(path.join(REPO, 'bin', 'mem-serve'), root, { CHEAP_MEM_VERIFY_FILE: target });
    const res = await s.post('/dashboard/verify-verdict', 'key=x&verdict=still-current');
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(target), false);
  } finally { await s?.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// browser-lock.test.mjs — the lock in test/fixture/browser.mjs lets only ONE
// test file at a time hold a Chromium (twin of lucky-mem's browser-sperre).
// Checked without a browser, the lock alone. Red on the previous state:
// takeLock did not exist (the import fails).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const FIXTURE = new URL('./fixture/browser.mjs', import.meta.url).href;

// os.tmpdir() reads TMPDIR on POSIX but TEMP/TMP on Windows: setting only TMPDIR left the child
// on the real temp dir there (no wait at all; our lock never taken, never released).
function secondTakes(tmp) {
  const k = spawn(process.execPath, ['--input-type=module', '-e',
    `const { takeLock } = await import(${JSON.stringify(FIXTURE)}); const release = await takeLock(); process.stdout.write('HAS ' + Date.now() + '\\n'); release();`,
  ], { env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  k.stdout.on('data', (d) => { out += d; });
  k.stderr.on('data', (d) => { err += d; });
  return new Promise((r) => k.on('exit', (code) => r({ code, out, err })));
}

test('a second process waits until the first releases the lock', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-browser-lock-'));
  try {
    const lock = path.join(tmp, 'cheap-mem-browser.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), String(process.pid));
    const freeAt = Date.now() + 1200;
    setTimeout(() => fs.rmSync(lock, { recursive: true, force: true }), 1200);
    const r = await secondTakes(tmp);
    assert.equal(r.code, 0, `second process failed; stderr: ${r.err || '(empty)'}`);
    const has = Number((r.out.match(/HAS (\d+)/) || [])[1]);
    assert.ok(has >= freeAt - 50, `the second one got the lock too early; stderr: ${r.err || '(empty)'}`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('positive control: a dead process\'s lock is taken over without waiting', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-browser-lock-'));
  try {
    const lock = path.join(tmp, 'cheap-mem-browser.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'pid'), '999999999');
    const start = Date.now();
    const r = await secondTakes(tmp);
    assert.equal(r.code, 0, `stderr: ${r.err || '(empty)'}`);
    assert.ok(Date.now() - start < 8000, 'an orphaned lock must not block');
    assert.ok(!fs.existsSync(lock), 'after release the lock is gone');
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

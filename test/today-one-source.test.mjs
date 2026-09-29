// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/today-one-source.test.mjs — N8/N21 parity: ONE function's numbers
// reach `mem today --json`, the dashboard card data and the session-start
// line; unmeasurable parts say "unknown", never 0; the line is capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as today from '../src/today.mjs';
import * as data from '../src/dashboard-data.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'install', 'hooks', 'session-start.sh');
// Fixed commit (never merge-base): before this build there was no counts().
const OLD_COMMIT = 'e00c3fb176bc6735c06f4aebc14fe98810e14528';
const NOW = new Date('2026-09-29T09:00:00Z');

function memoryRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-today-1src-'));
  const res = spawnSync(process.execPath, [MEM, '--root', r, 'init'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return r;
}
const envFor = (r) => ({ CHEAP_MEM_GOLD_FILE: path.join(r, 'nope-gold.jsonl') });

test('one source: CLI json, dashboard card data and hook line carry the same counts and line', () => {
  const r = memoryRoot();
  try {
    const cli = JSON.parse(execFileSync(process.execPath, [MEM, '--root', r, 'today', '--json'], {
      encoding: 'utf8', env: { ...process.env, ...envFor(r) },
    }));
    const card = data.collectDashboard(r, { now: new Date(), env: { ...process.env, ...envFor(r) } }).today;
    assert.deepEqual(card.counts, cli.counts);
    assert.equal(card.line, cli.line);
    // The hook calls `$CHEAP_MEM_ROOT/bin/mem`; a delegating stub runs the REAL CLI.
    fs.mkdirSync(path.join(r, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(r, 'bin', 'mem'), `const { spawnSync } = require('node:child_process');
const x = spawnSync(process.execPath, [${JSON.stringify(MEM)}, '--root', ${JSON.stringify(r)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(x.status ?? 1);
`);
    const hook = spawnSync('bash', [HOOK], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: r, ...envFor(r) } });
    assert.ok(cli.line, 'a fresh install has something to say (unknown/warn)');
    assert.ok(hook.stdout.split('\n').includes(cli.line), `${cli.line} in ${hook.stdout}`);
    assert.equal(today.line(cli), cli.line, 'line() is a pure function of the same result');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('unknown: missing sources are null / "unknown", never 0; login is always unknown here', () => {
  const r = memoryRoot();
  try {
    const t = today.today(r, { env: envFor(r), now: NOW, doctorResult: { findings: [], worst: 'good', summary: {} } });
    assert.equal(t.counts.login, null);
    assert.equal(t.counts.review, null);
    assert.equal(t.counts.wordPairs, null);
    assert.equal(t.login.readable, false);
    assert.match(t.login.reason, /unknown/);
    const failing = today.today(r, { env: envFor(r), now: NOW });
    const broken = { ...failing, operations: { readable: false, reason: 'x', notable: [] } };
    assert.equal(today.counts(broken).operations, null);
    assert.match(today.line({ ...broken, counts: today.counts(broken) }), /operations unknown/);
    assert.doesNotMatch(today.line({ ...broken, counts: today.counts(broken) }), /\b0\b/);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('line cap: never longer than LINE_MAX, one line, no entry content', () => {
  const l = today.line({ counts: {
    decisions: 123456789, operationsWorst: 'error', verify: 987654321, goldQuestions: 3,
  } });
  assert.ok(l.length <= today.LINE_MAX, String(l.length));
  assert.doesNotMatch(l, /\n/);
});

test('RED on the old commit: no counts()/LINE_MAX there; POSITIVE CONTROL: old src has line()', () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:src/today.mjs`], { cwd: REPO, encoding: 'utf8' });
  assert.doesNotMatch(old, /export function counts|LINE_MAX/);
  assert.match(old, /export function line/);
});

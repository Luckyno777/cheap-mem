// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Field `origin` in the injection journal + the evaluation command
// (port of lucky-mem ceb244cb / e2f0190b, field `ort`). Proves that cloud and
// local lines can be told apart, that only a class value is booked and that
// old lines without the field stay readable (= unknown).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLine, JOURNAL_FILE } from '../src/injection.mjs';
import { originFrom, originNormal, ORIGINS } from '../src/origin.mjs';
import { detectSurface } from '../src/raw.mjs';
import { summarise, rankValue } from '../bench/injection-by-origin.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withEnv(changes, fn) {
  const old = {};
  for (const k of Object.keys(changes)) old[k] = process.env[k];
  for (const [k, v] of Object.entries(changes)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('originFrom: cloud, ssh, local, override, foreign value = unknown', () => {
  assert.equal(originFrom({ env: { CLAUDE_CODE_REMOTE: 'true' } }), 'cloud');
  assert.equal(originFrom({ env: { SSH_CONNECTION: '1 2 3 4' } }), 'ssh');
  assert.equal(originFrom({ env: {} }), 'local');
  assert.equal(originFrom({ env: { MEM_SURFACE: 'cloud' } }), 'cloud');
  assert.equal(originFrom({ env: { MEM_SURFACE: 'machine-17.example', CLAUDE_CODE_REMOTE: '1' } }), 'unknown');
  assert.deepEqual(Object.values(ORIGINS).sort(), ['cloud', 'local', 'ssh', 'unknown']);
});

test('originNormal: everything outside the list is unknown', () => {
  for (const x of [undefined, null, '', 'CLOUD', 'host-1', 42, {}]) assert.equal(originNormal(x), 'unknown');
  for (const x of ['cloud', 'ssh', 'local', 'unknown']) assert.equal(originNormal(x), x);
});

test('buildLine carries origin from the environment; only the class value, never host or identifier', () => {
  const cloud = withEnv({ MEM_SURFACE: null, CLAUDE_CODE_REMOTE: 'true' }, () => buildLine({ occasion: 'question' }));
  assert.equal(cloud.origin, 'cloud');
  const local = withEnv({ MEM_SURFACE: 'local', CLAUDE_CODE_REMOTE: null }, () => buildLine({ occasion: 'question' }));
  assert.equal(local.origin, 'local');
  const foreign = buildLine({ occasion: 'question', origin: `${os.hostname()}-xyz` });
  assert.equal(foreign.origin, 'unknown');
  assert.ok(!JSON.stringify(cloud).includes(os.hostname()) || os.hostname().length < 4, 'no hostname in the journal');
});

test('detectSurface keeps its answers (one truth, same results)', () => {
  withEnv({ MEM_SURFACE: null, CLAUDE_CODE_REMOTE: 'true', MEM_HEADLESS: null, SSH_CONNECTION: null }, () => assert.equal(detectSurface(), 'cloud'));
  withEnv({ MEM_SURFACE: null, CLAUDE_CODE_REMOTE: null, MEM_HEADLESS: 'x', SSH_CONNECTION: '1' }, () => assert.equal(detectSurface(), 'headless:x'));
  withEnv({ MEM_SURFACE: null, CLAUDE_CODE_REMOTE: null, MEM_HEADLESS: null, SSH_CONNECTION: '1' }, () => assert.equal(detectSurface(), 'ssh'));
  withEnv({ MEM_SURFACE: null, CLAUDE_CODE_REMOTE: null, MEM_HEADLESS: null, SSH_CONNECTION: null }, () => assert.equal(detectSurface(), 'local'));
  withEnv({ MEM_SURFACE: 'anything' }, () => assert.equal(detectSurface(), 'anything'));
});

const LINES = [
  { ts: '2026-10-01T10:00:00Z', occasion: 'question', origin: 'local', duration_ms: 100, path: 'server', path_reason: null },
  { ts: '2026-10-01T10:01:00Z', occasion: 'question', origin: 'local', duration_ms: 300, path: 'direct', path_reason: 'server-timeout' },
  { ts: '2026-10-01T10:02:00Z', occasion: 'question', origin: 'cloud', duration_ms: 900, path: 'direct', path_reason: null },
  { ts: '2026-10-01T10:03:00Z', occasion: 'question', origin: 'cloud', duration_ms: 700, path: 'direct', path_reason: null },
  { ts: '2026-10-01T10:04:00Z', occasion: 'question', duration_ms: 50, path: 'direct', path_reason: null }, // old line, no origin
  { ts: '2026-10-02T09:00:00Z', occasion: 'before', origin: 'cloud', duration_ms: 70 },
];

test('summarise: per occasion and origin, p50/p95, server share, path_reason', () => {
  const r = summarise(LINES);
  const f = (o, g) => r.find((x) => x.occasion === o && x.origin === g);
  assert.equal(f('question', 'local').n, 2);
  assert.equal(f('question', 'local').server_share, 0.5);
  assert.equal(f('question', 'local').p50_ms, 100);
  assert.equal(f('question', 'local').p95_ms, 300);
  assert.deepEqual(f('question', 'local').path_reasons, { 'no-server': 1, 'server-timeout': 1 });
  assert.equal(f('question', 'cloud').server_share, 0);
  assert.equal(f('question', 'unknown').n, 1, 'an old line without origin reads as unknown');
  assert.equal(f('before', 'cloud').server_share, null, 'without a path: not measurable, not 0');
  assert.equal(rankValue([], 0.5), null);
});

test('summarise: time window (after/before) and occasion filter', () => {
  assert.equal(summarise(LINES, { after: '2026-10-02T00:00:00Z' }).length, 1);
  assert.equal(summarise(LINES, { before: '2026-10-02T00:00:00Z' }).reduce((s, x) => s + x.n, 0), 5);
  assert.equal(summarise(LINES, { occasions: ['before'] }).length, 1);
});

test('command: reads a journal under --root, old and new lines mixed', (t) => {
  const w = tempDir('cm-origin-', t);
  fs.mkdirSync(path.dirname(path.join(w, JOURNAL_FILE)), { recursive: true });
  fs.writeFileSync(path.join(w, JOURNAL_FILE), LINES.map((z) => JSON.stringify(z)).join('\n') + '\n');
  const bench = path.join(REPO, 'bench', 'injection-by-origin.mjs');
  const a = spawnSync(process.execPath, [bench, '--root', w, '--json'], { encoding: 'utf8' });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(a.stderr, '');
  const j = JSON.parse(a.stdout);
  assert.ok(j.rows.some((x) => x.occasion === 'question' && x.origin === 'cloud' && x.n === 2));
  const b = spawnSync(process.execPath, [bench, '--root', w, '--after', '2026-10-02T00:00:00Z'], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  assert.match(b.stdout, /before\tcloud\t1/);
  const none = spawnSync(process.execPath, [bench, '--root', path.join(w, 'nothing')], { encoding: 'utf8' });
  assert.equal(none.status, 2, 'no journal = unknown, not success');
  assert.match(none.stderr, /no injection journal found/);
});

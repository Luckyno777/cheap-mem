// Excluding a session from raw capture (ported from the sibling house,
// 2026-10-02): `mem raw exclude` (or MEM_RAW_EXCLUDE=1) keeps a personal
// or interview session out of the raw archive. Only a fingerprint of the
// session id is recorded; the record rows carry no `path` and appear in
// no capture count; an unreadable record means NOT captured (fail-safe).
//
// Red proof (rule 3): on the base commit 1d8f6c5 the same transcript was
// captured after `mem raw exclude` (unknown subcommand) and with
// MEM_RAW_EXCLUDE=1 (no such switch). The positive controls show another
// session is still captured, so the probe sees a real difference.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as raw from '../src/raw.mjs';
import * as archive from '../src/archive.mjs';
import * as board from '../src/board.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const SECRET_ID = 'b7c1e2d4-0000-4aaa-9bbb-123456789abc';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rawexcl-'));
  spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8' });
  return root;
}
function transcript(root, id, n = 120) {
  const p = path.join(root, `${id}.jsonl`);
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({
    sessionId: id, timestamp: `2026-10-01T10:00:${String(i % 60).padStart(2, '0')}Z`,
    type: 'user', message: { content: `my private interview answer number ${i}` },
  }));
  fs.writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });
const mem = (root, args, env = {}) => spawnSync('node', [MEM, '--root', root, ...args],
  { encoding: 'utf8', timeout: 30000, env: { ...process.env, CLAUDE_CODE_SESSION_ID: '', ...env } });

test('exclude: a marked session is not captured, another one still is (positive control)', () => {
  const root = setup();
  try {
    const t = transcript(root, SECRET_ID);
    const other = transcript(root, 'other-session-1');
    const r = mem(root, ['raw', 'exclude', '--json'], { CLAUDE_CODE_SESSION_ID: SECRET_ID });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, 'excluded');
    assert.equal(JSON.parse(mem(root, ['raw', 'exclude', '--json', '--session', SECRET_ID]).stdout).status, 'already');

    const c = mem(root, ['raw-capture', '--transcript', t, '--json', '--session', SECRET_ID]);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(JSON.parse(c.stdout).status, 'excluded');
    // Without --session the transcript's file name stands in.
    assert.equal(raw.capture(root, t).status, 'excluded');
    assert.equal(raw.listCaptures(root).length, 0, 'nothing of the excluded session was stored');

    assert.equal(raw.capture(root, other).status, 'captured', 'positive control: another session is captured');
    assert.equal(raw.listCaptures(root).length, 1);
  } finally { rm(root); }
});

test('exclude: only the fingerprint is recorded, and the rows count as no capture', () => {
  const root = setup();
  try {
    raw.exclude(root, SECRET_ID);
    raw.capture(root, transcript(root, SECRET_ID));
    const text = fs.readFileSync(path.join(root, archive.RECORD_FILE), 'utf8');
    assert.ok(!text.includes(SECRET_ID), 'the raw session id reached the record');
    const rows = archive.records(root);
    assert.ok(rows.some((r) => r.record === 'excluded' && r.event === 'mark'));
    assert.ok(rows.some((r) => r.record === 'excluded' && r.event === 'skipped'));
    assert.ok(rows.every((r) => !r.path), 'an exclusion row carries a path');
    assert.equal(archive.inRange(rows).length, 0, 'an exclusion row counted as a capture');
    assert.deepEqual(raw.exclusionSummary(root), { sessions: 1, skipped: 1 });
    const b = board.tileArchive(root);
    assert.equal(b.numbers.foreign + b.numbers.missing, 0, `the board counted an exclusion row: ${b.line}`);
    // A second Stop without growth adds no second "skipped" row.
    raw.capture(root, transcript(root, SECRET_ID));
    assert.equal(raw.exclusionSummary(root).skipped, 1);
    const out = mem(root, ['raw', 'archive']);
    assert.match(out.stdout, /excluded: 1 session/);
  } finally { rm(root); }
});

test('MEM_RAW_EXCLUDE=1 excludes too; an unknown id is refused, not guessed', () => {
  const root = setup();
  try {
    const t = transcript(root, 'env-session-1');
    assert.equal(raw.capture(root, t, { env: { MEM_RAW_EXCLUDE: '1' } }).status, 'excluded');
    assert.equal(raw.listCaptures(root).length, 0);
    assert.equal(raw.capture(root, t, { env: {} }).status, 'captured', 'positive control without the switch');
    const r = mem(root, ['raw', 'exclude']);
    assert.notEqual(r.status, 0, 'excluded without a session id');
    assert.match(r.stderr, /session id unknown/);
  } finally { rm(root); }
});

// A directory where the record file should be cannot be read (EISDIR) on any platform, as any user: the
// way to an unreadable record that does not depend on POSIX modes (chmod 000 does nothing on Windows).
test('fail-safe: an unreadable record (a directory in its place) means nothing is captured', () => {
  const root = setup();
  try {
    const t = transcript(root, 'fs-session-dir');
    fs.mkdirSync(path.join(root, archive.RECORD_FILE), { recursive: true });
    const r = raw.capture(root, t);
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'exclusion-unreadable');
  } finally { rm(root); }
});

test('fail-safe: an unreadable record means nothing is captured', { skip: process.platform === 'win32' ? 'Windows: chmod 000 changes nothing (no POSIX modes); the directory variant above covers the rule there' : (process.getuid?.() === 0 ? 'root reads everything' : false) }, () => {
  const root = setup();
  try {
    const t = transcript(root, 'fs-session-1');
    fs.writeFileSync(path.join(root, archive.RECORD_FILE), '');
    fs.chmodSync(path.join(root, archive.RECORD_FILE), 0o000);
    const r = raw.capture(root, t);
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'exclusion-unreadable');
  } finally {
    try { fs.chmodSync(path.join(root, archive.RECORD_FILE), 0o644); } catch { /* gone */ }
    rm(root);
  }
});

test('the capture hook passes the session id from the hook JSON', () => {
  const root = setup();
  try {
    const t = path.join(root, 'renamed-transcript.jsonl');
    fs.renameSync(transcript(root, SECRET_ID), t);
    raw.exclude(root, SECRET_ID);
    const r = spawnSync('bash', [path.join(REPO, 'bin', 'mem-capture')], {
      input: JSON.stringify({ transcript_path: t, session_id: SECRET_ID }), encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HEADLESS: '', MEM_CAPTURE_OFF: '', CLAUDE_TRANSCRIPT_PATH: '' },
      cwd: root,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(raw.listCaptures(root).length, 0, 'the hook captured an excluded session');
  } finally { rm(root); }
});

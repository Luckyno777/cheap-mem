// test/correction-write-path.test.mjs - `mem correction` takes the same write
// path as `mem log`: redaction of secrets and crypto-shredding encryption of
// the corrected entry's body (port of lucky-mem 49e28bdc, 2026-10-03).
//
// Reason: a correction went through the bare logEntry. A secret pattern in a
// named field stayed on disk unredacted, and the correction of an encrypted
// entry was written in plaintext next to its ciphertext predecessor.
//
// Red proof: a FIXED base commit (never `git merge-base`, it drifts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const BASE = 'a07350a89066c2cb52a9dfad39441c3185ba2793';
const SECRET = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';

function makeRoot() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-correction-path-'));
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({
    version: 1, language: 'en', participants: { user: { role: 'the human', human: true }, session: 'an AI session' },
  }));
  return w;
}
const drop = (w) => fs.rmSync(w, { recursive: true, force: true });
const run = (mem, root, argv) => spawnSync(process.execPath, [mem, ...argv, '--root', root], { encoding: 'utf8' });
const raw = (w, type) => fs.readFileSync(memory.logPath(w, type, null), 'utf8');

function probe(mem, w) {
  const a = memory.logEntry(w, 'learning', {
    title: 'Plain learning', learning: 'a harmless body of the learning',
  }).entry;
  const r = run(mem, w, ['correction', 'learning', a.id, '--learning', `now the token is ${SECRET} in the text`]);
  return { r, text: raw(w, 'learning') };
}

test('a secret in a correction is redacted, never on disk in the clear', () => {
  const w = makeRoot();
  try {
    const { r, text } = probe(path.join(REPO, 'bin', 'mem'), w);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!text.includes(SECRET), 'secret reached the disk');
    assert.match(r.stderr, /redacted:/);
  } finally { drop(w); }
});

test('correcting an encrypted entry stays encrypted: no plaintext beside the ciphertext', () => {
  const w = makeRoot();
  try {
    const a = memory.logEntry(w, 'learning', {
      title: 'Secret title', learning: 'private body that must not appear', shred: true,
    }).entry;
    assert.ok(a.body_enc);
    const r = run(path.join(REPO, 'bin', 'mem'), w,
      ['correction', 'learning', a.id, '--learning', 'corrected private body sentinel-xyzzy']);
    assert.equal(r.status, 0, r.stderr);
    const text = raw(w, 'learning');
    assert.ok(!text.includes('sentinel-xyzzy'), 'correction body in the clear');
    const last = JSON.parse(text.trim().split('\n').at(-1));
    assert.ok(last.body_enc, 'correction line carries no envelope');
    assert.equal(last.shred, undefined);
    assert.match(r.stdout, /encrypted:\s+yes/);
  } finally { drop(w); }
});

test('a closing correction of an encrypted entry (no body field) still works', () => {
  const w = makeRoot();
  try {
    const a = memory.logEntry(w, 'learning', {
      title: 'Secret title', learning: 'private body', shred: true,
    }).entry;
    const c = memory.correctionEntry(w, 'learning', a.id, { state: 'discarded' });
    assert.equal(c.encrypted, false);
  } finally { drop(w); }
});

test('RED PROOF: at the base commit the same probes fail (positive control: today they pass)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-correction-path-base-'));
  const w = makeRoot();
  const w2 = makeRoot();
  try {
    execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', tmp, BASE], { stdio: 'ignore' });
    const old = probe(path.join(tmp, 'bin', 'mem'), w);
    assert.ok(old.text.includes(SECRET), 'base stand should write the secret in the clear');
    const a = memory.logEntry(w2, 'learning', { title: 't', learning: 'private body', shred: true }).entry;
    run(path.join(tmp, 'bin', 'mem'), w2,
      ['correction', 'learning', a.id, '--learning', 'corrected sentinel-xyzzy']);
    assert.ok(raw(w2, 'learning').includes('sentinel-xyzzy'), 'base stand should write plaintext beside ciphertext');
    // today's tree
    const now = probe(path.join(REPO, 'bin', 'mem'), makeRoot());
    assert.ok(!now.text.includes(SECRET));
  } finally {
    try { execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', tmp], { stdio: 'ignore' }); } catch { /* */ }
    drop(w); drop(w2);
  }
});

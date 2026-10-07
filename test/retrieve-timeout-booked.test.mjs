// K3: a search cut off by the hook's time cap is BOOKED as reason
// `timeout` - not silent (silence reads as "nothing found"; not
// measurable is not zero). Any other failure of `find` books reason
// `error` (the sibling house books the same case) — never silence.
// The cap is faked with a `timeout` in PATH that cuts `find` off with
// 124 (no test brake exists in the hook, and none was added).
// Red proof (rule 12): at the pinned start commit the hook has no such
// booking and the vocabulary has no `timeout`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';

const START_COMMIT = 'e0fdafc67b5a6cc713d18844b82a8c19e689e692';
const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const HOOK = path.join(CODE, 'bin', 'mem-retrieve');
const REAL_TIMEOUT = spawnSync('bash', ['-c', 'command -v timeout'], { encoding: 'utf8' }).stdout.trim();

function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rt-'));
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  execFileSync('node', [MEM, '--root', root, 'log', 'error', '--title', 'lockfile race - two runs overwrote it',
    '--text', 'the probe failed because two test runs overwrote the same lock file at once', '--class', 'race'], { stdio: 'ignore' });
  const fake = path.join(root, 'fakebin');
  fs.mkdirSync(fake);
  // No real `timeout` (macOS): the fake still has to run everything that is not
// `find`, so it drops the seconds argument and execs the rest. (It used to
// exec an empty path there, and the whole hook went silent - which is not
// what this file measures.)
  const script = ["#!/bin/bash", 'for a in "$@"; do [ "$a" = find ] && exit "${FAKE_FIND_RC:-124}"; done', REAL_TIMEOUT ? `exec ${REAL_TIMEOUT} "$@"` : 'shift; exec "$@"', ""].join("\n");
  fs.writeFileSync(path.join(fake, 'timeout'), script, { mode: 0o755 });
  return { root, fake };
}
const hook = ({ root, fake }, rc) => spawnSync('bash', [HOOK], {
  input: JSON.stringify({ session_id: 'sess-k3', prompt: 'the lockfile race where two test runs overwrote the same lock file' }),
  encoding: 'utf8', timeout: 30000,
  env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, FAKE_FIND_RC: String(rc), CHEAP_MEM_ROOT: root,
    MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_MIN: '0.1', MEM_RETRIEVE_NO_PULL: '1', MEM_HOOK_OFF: '' },
});
const lines = (root) => injection.read(root).lines;

test('red proof: the start commit cannot book a timeout', (t) => {
  let src;
  try { src = execFileSync('git', ['show', `${START_COMMIT}:bin/mem-retrieve`], { encoding: 'utf8', stdio: 'pipe' }); }
  catch { t.skip('start commit not in this clone - unknown, not green'); return; }
  assert.ok(!/REASON\.TIMEOUT/.test(src));
  const inj = execFileSync('git', ['show', `${START_COMMIT}:src/injection.mjs`], { encoding: 'utf8' });
  assert.ok(!/'timeout'/.test(inj));
});

test('K3: find cut off by the cap (124): exit 0, no output, a journal line with reason timeout', () => {
  const b = build();
  try {
    const r = hook(b, 124);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    const l = lines(b.root);
    assert.equal(l.length, 1, JSON.stringify(l));
    assert.equal(l[0].reason, 'timeout');
    assert.equal(l[0].occasion, 'question');
    assert.equal(l[0].session, 'sess-k3');
    assert.equal(l[0].hits, 0);
  } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
});

test('K3: killed (137) books timeout as well', () => {
  const b = build();
  try {
    assert.equal(hook(b, 137).status, 0);
    assert.equal(lines(b.root)[0]?.reason, 'timeout');
  } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
});

test('K3: another failure of find (exit 1) is booked as error, not as timeout', () => {
  const b = build();
  try {
    const r = hook(b, 1);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(lines(b.root).filter((x) => x.reason === 'timeout').length, 0);
    assert.equal(lines(b.root).filter((x) => x.reason === 'error').length, 1, 'a failed search leaves a line — not measurable is not zero');
  } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
});

test('positive control: without the fake cap the same hook answers and books no timeout', () => {
  const b = build();
  try {
    fs.rmSync(path.join(b.fake, 'timeout'));
    const r = hook(b, 124);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /lockfile race/);
    assert.equal(lines(b.root).filter((x) => x.reason === 'timeout').length, 0);
  } finally { fs.rmSync(b.root, { recursive: true, force: true }); }
});

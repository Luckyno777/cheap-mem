// test/posixmode.test.mjs - src/posixmode.mjs: a mode is judged on POSIX and
// only there; on Windows the answer is "not checkable on this platform".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';
import * as pm from '../src/posixmode.mjs';

test('isPrivate: POSIX judges the bits, win32 never judges (null for every number)', () => {
  assert.equal(pm.isPrivate(0o600, 'linux'), true);
  assert.equal(pm.isPrivate(0o700, 'darwin'), true);
  assert.equal(pm.isPrivate(0o640, 'linux'), false);
  assert.equal(pm.isPrivate(0o666, 'linux'), false);
  for (const mode of [0o600, 0o666, 0o644, 0o777]) assert.equal(pm.isPrivate(mode, 'win32'), null, mode.toString(8));
  assert.equal(pm.modesCheckable('win32'), false);
  assert.equal(pm.modesCheckable('linux'), true);
});

test('fileState: private / open / not-checkable / missing (win32 driven on any platform)', (t) => {
  const dir = tempDir('cm-posixmode-', t);
  const f = path.join(dir, 'secret');
  fs.writeFileSync(f, 'x');
  assert.equal(pm.fileState(path.join(dir, 'nope'), 'linux'), 'missing');
  assert.equal(pm.fileState(path.join(dir, 'nope'), 'win32'), 'missing');
  assert.equal(pm.fileState(f, 'win32'), 'not-checkable');
  if (process.platform !== 'win32') {
    fs.chmodSync(f, 0o600);
    assert.equal(pm.fileState(f), 'private');
    fs.chmodSync(f, 0o644);
    assert.equal(pm.fileState(f), 'open');
    assert.equal(pm.fileState(f, 'win32'), 'not-checkable', 'the numbers are not consulted on win32');
  } else {
    assert.equal(pm.fileState(f), 'not-checkable', 'the real platform says the same');
  }
});

test('note: open warns, not-checkable says so in the agreed words, private is silent', () => {
  assert.match(pm.note(['private', 'open'], 'the file'), /^WARNING: the file readable by group\/others \(should be 0600\)\.$/);
  assert.match(pm.note('not-checkable', 'the file'), /not checkable on this platform/);
  assert.equal(pm.note(['private', 'missing'], 'the file'), null);
  assert.equal(pm.note([], 'the file'), null);
  assert.equal(pm.NOT_CHECKABLE, 'not checkable on this platform');
});

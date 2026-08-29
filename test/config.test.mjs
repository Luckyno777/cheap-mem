import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as cfg from '../src/config.mjs';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-cfg-')); }

test('readConfig throws ENOCONFIG when missing', () => {
  const root = tmpRoot();
  let err;
  try { cfg.readConfig(root); } catch (e) { err = e; }
  assert.ok(err, 'should throw');
  assert.equal(err.code, 'ENOCONFIG');
});

test('writeConfig + readConfig round-trip', () => {
  const root = tmpRoot();
  cfg.writeConfig(root, { ...cfg.DEFAULT_CONFIG, participants: { me: 'the human' } });
  const r = cfg.readConfig(root);
  assert.equal(r.participants.me, 'the human');
});

test('readConfig fails loudly on invalid JSON', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.mem'));
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{ broken');
  assert.throws(() => cfg.readConfig(root), /not valid JSON/);
});

test('findRoot walks up', () => {
  const root = tmpRoot();
  cfg.writeConfig(root, cfg.DEFAULT_CONFIG);
  const sub = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(cfg.findRoot(sub), root);
});

test('findRoot returns null when no config anywhere up', () => {
  const root = tmpRoot();  // no config written
  assert.equal(cfg.findRoot(root), null);
});

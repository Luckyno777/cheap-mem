/**
 * The Claude Code installer never overwrites a settings.json it cannot read.
 *
 * **The finding, audit 2026-09-30, B9.** install/claude-code.sh parsed
 * settings.json inside `try { ... } catch {}` and fell back to `{}`,
 * then wrote `{}` plus its hooks over the file. Measured on 241a8aa
 * with a settings.json carrying one trailing comma: exit 0, the user's
 * `model` and `permissions` were gone, seven hook scripts copied.
 * Now: exit non-zero, a clear message, the file byte for byte as it
 * was, and no hook script copied either.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(REPO, 'install', 'claude-code.sh');
const MEM = path.join(REPO, 'bin', 'mem');

function setup(settingsText) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-installer-'));
  const root = path.join(tmp, 'memory');
  fs.mkdirSync(root);
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  const claudeHome = path.join(tmp, 'claude');
  fs.mkdirSync(claudeHome);
  if (settingsText !== null) fs.writeFileSync(path.join(claudeHome, 'settings.json'), settingsText);
  const r = spawnSync('bash', [INSTALL], {
    encoding: 'utf8',
    env: { ...process.env, HOME: tmp, CHEAP_MEM_ROOT: root, CLAUDE_HOME: claudeHome },
  });
  return { tmp, claudeHome, r };
}

test('a settings.json that does not parse is left untouched and the run stops', () => {
  const broken = '{"model":"opus", "permissions":{"allow":["X"]},}\n';
  const { tmp, claudeHome, r } = setup(broken);
  try {
    assert.notEqual(r.status, 0, 'installer reported success on a broken settings.json');
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'), broken);
    assert.equal(fs.existsSync(path.join(claudeHome, 'hooks')), false, 'hooks were copied before the refusal');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a settings.json that is JSON but not an object is refused too', () => {
  const { tmp, claudeHome, r } = setup('[1,2]\n');
  try {
    assert.notEqual(r.status, 0);
    assert.equal(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'), '[1,2]\n');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('positive control: a valid settings.json is merged and keeps its own keys', () => {
  const { tmp, claudeHome, r } = setup('{"model":"opus","permissions":{"allow":["X"]}}\n');
  try {
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    assert.equal(cfg.model, 'opus');
    assert.ok(cfg.permissions.allow.includes('X'));
    assert.ok(cfg.hooks.SessionStart.length >= 1);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('positive control: no settings.json at all installs cleanly', () => {
  const { tmp, claudeHome, r } = setup(null);
  try {
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).hooks);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

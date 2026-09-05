import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MEM = path.join(PKG_ROOT, 'bin', 'mem');

function run(argv, env = {}) {
  return spawnSync('node', [MEM, ...argv], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function freshMemory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-setup-'));
  const r = run(['--root', root, 'init']);
  assert.equal(r.status, 0, r.stderr);
  return root;
}

test('setup names only what it can actually verify', () => {
  // The whole point of the honest scope: an agent listed here is one
  // whose config format we can write correctly. Silently producing a
  // broken config in someone's home directory is worse than no feature.
  const r = run(['setup', '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /claude/);
  for (const guessed of ['cursor', 'windsurf', 'codex', 'gemini']) {
    assert.ok(!r.stdout.includes(`    ${guessed}`),
      `${guessed} is listed as supported but nothing here can verify its config`);
  }
});

test('an unsupported agent fails loudly instead of doing something plausible', () => {
  const r = run(['setup', 'cursor']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no recipe for 'cursor'/);
  assert.match(r.stderr, /claude/, 'the error must say what IS supported');
});

test('--dry-run touches nothing and prints both halves of the wiring', () => {
  const root = freshMemory();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  try {
    const r = run(['--root', root, 'setup', 'claude', '--dry-run'],
      { CLAUDE_HOME: path.join(home, '.claude') });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /claude-code\.sh/, 'the hook install is not named');
    assert.match(r.stdout, /mcp add cheap-mem/, 'the MCP step is not named');
    assert.deepEqual(fs.readdirSync(home), [],
      'a dry run wrote into the agent config directory');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('setup refuses a root that is not a memory yet', () => {
  const notAMemory = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nomem-'));
  try {
    const r = run(['--root', notAMemory, 'setup', 'claude', '--dry-run']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /mem init/, 'the error must say how to fix it');
  } finally { fs.rmSync(notAMemory, { recursive: true, force: true }); }
});

test('a mistyped flag is refused, not ignored', () => {
  // --dryrun silently ignored would run a real install someone asked
  // not to run. Unknown flags are always an error in this CLI.
  const root = freshMemory();
  try {
    const r = run(['--root', root, 'setup', 'claude', '--dryrun']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the install script setup delegates to exists and takes CHEAP_MEM_ROOT', () => {
  // `setup` is a thin wrapper; if the script moves or is left out of the
  // package, the failure must be visible here and not at a user's first run.
  const script = path.join(PKG_ROOT, 'install', 'claude-code.sh');
  assert.ok(fs.existsSync(script), 'install/claude-code.sh is missing');
  const src = fs.readFileSync(script, 'utf8');
  assert.match(src, /CHEAP_MEM_ROOT/, 'the script does not read the root we pass it');
  assert.match(src, /CLAUDE_HOME/, 'the script has no overridable target dir');
});

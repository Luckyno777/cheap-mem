import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MEM = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'mem');

function init(root, extra = []) {
  return execFileSync('node', [MEM, '--root', root, 'init', ...extra],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('init gitignores the API key file', () => {
  // Without this, the first `git add -A` commits .mem/embed.env — and
  // git forgets nothing. This is the difference between a key on your
  // disk and a key in a public repository.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-'));
  try {
    init(root);
    const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(rules, /^\.mem\/embed\.env/m, 'the key file is not ignored');
    for (const derived of ['search-index.json', 'vectors.db', 'raw-offsets.json']) {
      assert.ok(rules.includes(derived), `${derived} would be committed`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init is idempotent — rules are not appended twice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-idem-'));
  try {
    init(root);
    init(root, ['--force']);
    init(root, ['--force']);
    const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const hits = rules.split('\n').filter((l) => l.trim().startsWith('.mem/embed.env'));
    assert.equal(hits.length, 1, `the rule appears ${hits.length} times`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init keeps rules that are already there', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-keep-'));
  try {
    fs.writeFileSync(path.join(root, '.gitignore'), '# mine\n*.tmp\nnotes/\n');
    init(root);
    const rules = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.ok(rules.includes('*.tmp'), 'an existing rule was lost');
    assert.ok(rules.includes('notes/'), 'an existing rule was lost');
    assert.ok(rules.includes('.mem/embed.env'), 'ours was not added');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init creates the raw directory so capture has somewhere to write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-raw-'));
  try {
    init(root);
    for (const d of ['global', 'projects', 'inbox', 'raw']) {
      assert.ok(fs.existsSync(path.join(root, d)), `${d}/ is missing`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

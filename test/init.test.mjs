import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the pathname is
// "/D:/a/..." with a leading slash, and path.resolve then glues the
// current drive in front of it — "D:\\D:\\a\\...", which resolves to
// nothing. Every test using this helper failed on Windows and only
// there.
const MEM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

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

// -----------------------------------------------------------------------
// Who is the human — marked, not assumed (see src/config.mjs
// humanParticipant()). The default `mem init` config has to keep
// marking `user`, or every existing quickstart instruction breaks.
// -----------------------------------------------------------------------

function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.mem', 'config.json'), 'utf8'));
}

test('init default: "user" is marked human, so the desk and P1b work out of the box', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-human-default-'));
  try {
    init(root);
    const cfg = readConfig(root);
    assert.deepEqual(cfg.participants.user, { role: 'The human. Messages here are questions for them.', human: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init --participants marks the FIRST name human by default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-human-first-'));
  try {
    init(root, ['--participants', 'alice,bob,carol']);
    const cfg = readConfig(root);
    assert.equal(cfg.participants.alice.human, true);
    assert.notEqual(cfg.participants.bob?.human, true);
    assert.notEqual(cfg.participants.carol?.human, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init --participants --human names a different one as human', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-human-named-'));
  try {
    init(root, ['--participants', 'alice,bob,carol', '--human', 'carol']);
    const cfg = readConfig(root);
    assert.equal(cfg.participants.carol.human, true);
    assert.notEqual(cfg.participants.alice?.human, true);
    assert.notEqual(cfg.participants.bob?.human, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init --human naming a name outside --participants is refused, nothing written', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-human-badname-'));
  try {
    assert.throws(() => init(root, ['--participants', 'alice,bob', '--human', 'nobody']));
    assert.equal(fs.existsSync(path.join(root, '.mem', 'config.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('init --human without --participants is refused (the default already marks one)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-init-human-noparts-'));
  try {
    assert.throws(() => init(root, ['--human', 'someone']));
    assert.equal(fs.existsSync(path.join(root, '.mem', 'config.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

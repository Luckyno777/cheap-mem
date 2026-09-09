// Two defects found during a fresh Windows install.
//
// On 2026-09-07 somebody installed cheap-mem on a Windows machine and
// found two things none of our 434 tests had ever touched. Both are
// pinned here because both have the shape "looks right, does nothing".
//
//   1. Every Windows path counted as a secret. ENV_HARMLESS knew USER
//      and LOGNAME but not USERNAME. On an account called
//      `Administrator` the name sits in every path under C:\Users\, so
//      redaction replaced every path — and the pre-commit hook refused
//      every commit that mentioned one. Unusable.
//
//   2. The .gitignore ignored nothing. It was written as
//      `<rule><padding># <reason>`, and git has no trailing comments:
//      `#` starts a comment only at the START OF A LINE. All nine rules
//      were patterns matching nothing — the first of them
//      `.mem/embed.env`, whose only job is to keep an API key out of
//      the repository.
//
// The second case is the more instructive one: the file looked right.
// Anyone reading it sees nine rules. Only asking GIT shows zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as redaction from '../src/redaction.mjs';
import * as doctor from '../src/doctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');

function build({ git = true } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-win-'));
  if (git) execFileSync('git', ['init', '-q', '-b', 'main', r]);
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  return r;
}
const wipe = (r) => fs.rmSync(r, { recursive: true, force: true });
const ignored = (r, f) => spawnSync('git',
  ['-C', r, 'check-ignore', '-q', '--no-index', f]).status === 0;

// --- 1. Windows environment names ------------------------------------

test('THE CASE: the Windows user name is not a secret', () => {
  const env = { USERNAME: 'Administrator', USERPROFILE: 'C:\\Users\\Administrator' };
  assert.deepEqual(redaction.envSecrets(env), [],
    'USERNAME/USERPROFILE were treated as secrets');
});

test('THE CASE: a Windows path survives redaction unchanged', () => {
  const env = { USERNAME: 'Administrator' };
  const text = 'Klon in C:\\Users\\Administrator\\cheap-mem';
  assert.equal(redaction.redactAgainstEnv(text, redaction.envSecrets(env)).text, text);
});

test('casing does not matter — Windows names do not care either', () => {
  // A program hands in `Username` or `UserProfile` however it likes. A
  // list matching only one spelling has holes.
  for (const n of ['Username', 'userprofile', 'ComputerName', 'LOCALAPPDATA']) {
    assert.deepEqual(redaction.envSecrets({ [n]: 'WORKSTATION-Administrator' }), [],
      `${n} was treated as a secret`);
  }
});

test('POSITIVE: a real key stays a secret', () => {
  // Without this control nobody would know whether the list is too wide.
  for (const [k, v] of [['OPENAI_API_KEY', 'sk-proj-9f2Ab7QzX1mK'],
    ['GITHUB_TOKEN', 'ghp_9f2Ab7QzX1mKlmNo'], ['DB_PASSWORD', 'hunter2hunter2hunter']]) {
    assert.equal(redaction.envSecrets({ [k]: v }).length, 1, `${k} slipped through`);
  }
});

// --- 2. The .gitignore, git asked instead of read ---------------------

test('THE CASE: git really does ignore .mem/embed.env', () => {
  const r = build();
  try {
    assert.ok(ignored(r, '.mem/embed.env'),
      'the file holding API keys is NOT ignored');
  } finally { wipe(r); }
});

test('git ignores every rule that is written down', () => {
  const r = build();
  try {
    const rules = fs.readFileSync(path.join(r, '.gitignore'), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.ok(rules.length >= 9, `only ${rules.length} rules found`);
    for (const g of rules) {
      const probe = g.endsWith('/') ? `${g}x` : g;
      assert.ok(ignored(r, probe), `rule has no effect: ${JSON.stringify(g)}`);
    }
  } finally { wipe(r); }
});

test('no rule line carries a trailing comment', () => {
  const r = build();
  try {
    for (const l of fs.readFileSync(path.join(r, '.gitignore'), 'utf8').split('\n')) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      assert.ok(!t.includes('#'), `trailing comment: ${JSON.stringify(t)}`);
    }
  } finally { wipe(r); }
});

test('REPAIR: a broken old .gitignore is healed by the next init', () => {
  // The most important test in this file. A memory created before today
  // carries the broken lines — and the old comparison wrongly held them
  // to be present, so it would have skipped exactly the files that need
  // the repair.
  const r = build();
  try {
    fs.writeFileSync(path.join(r, '.gitignore'),
      '# cheap-mem: derived state and secrets\n'
      + '.mem/embed.env            # API keys. NEVER commit this.\n'
      + '.mem/epoch.json           # Local rollback watermark. Never commit: a tracked one\n'
      + '     travels back with the checkout it is meant to detect.\n'
      + '.mem/search-index.json    # derived: rebuilt in milliseconds\n');
    assert.ok(!ignored(r, '.mem/embed.env'), 'precondition: it is supposed to be broken');
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    assert.ok(ignored(r, '.mem/embed.env'), 'not healed');
    assert.ok(ignored(r, '.mem/epoch.json'), 'not healed');
    const text = fs.readFileSync(path.join(r, '.gitignore'), 'utf8');
    assert.ok(!/travels back with the checkout/.test(text.split('\n')
      .filter((l) => !l.trim().startsWith('#')).join('\n')),
    'the dangling continuation line is still standing there as a pattern');
  } finally { wipe(r); }
});

test('a second init changes nothing about a healthy file', () => {
  const r = build();
  try {
    const before = fs.readFileSync(path.join(r, '.gitignore'), 'utf8');
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    assert.equal(fs.readFileSync(path.join(r, '.gitignore'), 'utf8'), before);
  } finally { wipe(r); }
});

// --- The doctor sees it now -------------------------------------------

test('the doctor asks git and reports an inert .gitignore as an error', () => {
  const r = build();
  try {
    assert.equal(doctor.checkGitignoreEffective(r).level, 'good');
    fs.writeFileSync(path.join(r, '.gitignore'),
      '.mem/embed.env            # API keys. NEVER commit this.\n');
    const f = doctor.checkGitignoreEffective(r);
    assert.equal(f.level, 'error');
    assert.match(f.text, /embed\.env/);
  } finally { wipe(r); }
});

test('without a git repository the doctor stays quiet instead of warning', () => {
  // A memory without version control cannot fail at this. A warning
  // there would only teach people to skim past the output.
  const r = build({ git: false });
  try {
    assert.equal(doctor.checkGitignoreEffective(r).level, 'unknown');
  } finally { wipe(r); }
});

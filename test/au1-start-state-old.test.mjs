// AU1 (lucky-mem parity, automation gap L1): the SessionStart hook
// (install/hooks/session-start.sh)
//
//  (1) says LOUDLY "MEMORY STATE OLD: N commits behind origin/main" when the
//      clone is still behind after the pull (diverged, or a fast-forward
//      blocked by local changes), with the rescue path of the doctor finding
//      `hook-root-stranded`, and resets NOTHING (no reset --hard);
//  (2) sets user.email / user.name in the clone ONLY when the clone itself
//      has none AND an explicit source exists (CHEAP_MEM_GIT_EMAIL +
//      CHEAP_MEM_GIT_NAME, both); without a source it says so, never guesses.
//
// Runs in temp directories with the machine's git configuration switched off;
// origin is a local bare repository (no network).
//
// Red probe: against the hook before AU1 (AU1_HOOK_PATH) the banner and the
// identity lines are missing; the counter-probes (fast-forwardable, fetch fails,
// identity already in the clone) stay green on both states.
//
// error: 1968v6itl823
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Temp directories made by this file are removed when the process ends.
const MADE = [];
process.on('exit', () => { for (const d of MADE) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); MADE.push(d); return d; };

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HOOK = process.env.AU1_HOOK_PATH || path.join(REPO, 'install', 'hooks', 'session-start.sh');
const ID = ['-c', 'user.name=probe', '-c', 'user.email=probe@example.test', '-c', 'commit.gpgsign=false'];

function git(cwd, ...a) {
  const r = spawnSync('git', [...ID, ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(cwd, file, text, msg) {
  fs.writeFileSync(path.join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
}

function setup() {
  const t = mkTmp('au1-');
  const home = path.join(t, 'home');
  fs.mkdirSync(home, { recursive: true });
  const origin = path.join(t, 'origin.git');
  git(t, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(t, 'seed');
  git(t, 'clone', '-q', origin, seed);
  git(seed, 'checkout', '-q', '-B', 'main');
  fs.mkdirSync(path.join(seed, '.mem'));
  fs.writeFileSync(path.join(seed, '.mem', 'config.json'), '{}');
  git(seed, 'add', '.');
  commit(seed, 'BASE.md', 'one\n', 'base');
  git(seed, 'push', '-q', 'origin', 'main');
  const clone = path.join(t, 'clone');
  git(t, 'clone', '-q', origin, clone);
  const gitconfig = path.join(t, 'gitconfig-empty');
  fs.writeFileSync(gitconfig, '');
  const env = { PATH: process.env.PATH, HOME: home, CHEAP_MEM_ROOT: clone,
    GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  return { t, origin, seed, clone, env, home };
}

function run(s, shell, extra = {}) {
  const r = spawnSync(shell, [HOOK], { env: { ...s.env, ...extra }, encoding: 'utf8', timeout: 60_000, input: '{}' });
  return `${r.stdout}\n${r.stderr}`;
}

for (const shell of ['sh', 'bash']) {
  test(`AU1 [${shell}]: diverged -> loud banner with counter and rescue path, nothing is reset`, () => {
    const s = setup();
    commit(s.seed, 'n1.md', 'a\n', 'origin-1');
    commit(s.seed, 'n2.md', 'b\n', 'origin-2');
    git(s.seed, 'push', '-q', 'origin', 'main');
    commit(s.clone, 'local.md', 'x\n', 'capture: local');
    const headBefore = git(s.clone, 'rev-parse', 'HEAD');
    const out = run(s, shell);
    assert.match(out, /MEMORY STATE OLD: 2 commits behind origin\/main, 1 only local \(diverged\)/, out);
    assert.match(out, /hook-root-stranded/);
    assert.match(out, /worktree add --detach/);
    assert.match(out, /ONLY THEN|only THEN/);
    assert.match(out, /resets nothing \(no reset --hard/);
    assert.equal(git(s.clone, 'rev-parse', 'HEAD'), headBefore, 'the hook moved the clone');
    assert.equal(fs.readFileSync(path.join(s.clone, 'local.md'), 'utf8'), 'x\n', 'local work is gone');
  });
}

test('AU1: the rescue path text in the hook is the doctor\'s (no drift)', () => {
  const doctor = fs.readFileSync(path.join(REPO, 'src', 'doctor.mjs'), 'utf8').toLowerCase();
  const hook = fs.readFileSync(HOOK, 'utf8').toLowerCase();
  for (const piece of ['do not rebase/merge (diverged)', 'worktree add --detach', 'raw-record.jsonl', 'fetch + reset --hard']) {
    assert.ok(doctor.includes(piece), `the doctor text changed: ${piece}`);
    assert.ok(hook.includes(piece), `the hook text drifted from the doctor: ${piece}`);
  }
});

test('AU1 counter-probe: fast-forwardable -> no banner, the clone is pulled', () => {
  const s = setup();
  commit(s.seed, 'n1.md', 'a\n', 'origin-1');
  git(s.seed, 'push', '-q', 'origin', 'main');
  const out = run(s, 'bash');
  assert.doesNotMatch(out, /STATE OLD/, out);
  assert.equal(git(s.clone, 'rev-parse', 'HEAD'), git(s.seed, 'rev-parse', 'HEAD'));
});

test('AU1 counter-probe: fetch fails -> no "N behind" claim (unknown, not guessed)', () => {
  const s = setup();
  commit(s.clone, 'local.md', 'x\n', 'capture: local');
  fs.renameSync(s.origin, `${s.origin}.gone`);
  const out = run(s, 'bash');
  assert.doesNotMatch(out, /STATE OLD/, out);
});

test('AU1 positive control: behind and the fast-forward blocked by a local change -> banner without "only local"', () => {
  const s = setup();
  commit(s.seed, 'BASE.md', 'two\n', 'origin-edits-BASE');
  git(s.seed, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(s.clone, 'BASE.md'), 'local-uncommitted\n');
  const out = run(s, 'bash');
  assert.match(out, /MEMORY STATE OLD: 1 commits behind origin\/main \(fast-forward failed\)/, out);
  assert.doesNotMatch(out, /only local/);
  assert.equal(fs.readFileSync(path.join(s.clone, 'BASE.md'), 'utf8'), 'local-uncommitted\n');
});

// --- identity ---------------------------------------------------------

const local = (clone, key) => spawnSync('git', ['-C', clone, 'config', '--local', '--get', key], { encoding: 'utf8' }).stdout.trim();

for (const shell of ['sh', 'bash']) {
  test(`AU1 identity [${shell}]: none in the clone + a source -> set`, () => {
    const s = setup();
    assert.equal(local(s.clone, 'user.email'), '');
    const out = run(s, shell, { CHEAP_MEM_GIT_EMAIL: 'source@example.test', CHEAP_MEM_GIT_NAME: 'Source Name' });
    assert.equal(local(s.clone, 'user.email'), 'source@example.test', out);
    assert.equal(local(s.clone, 'user.name'), 'Source Name');
    assert.match(out, /git identity set in the clone/);
  });
}

test('AU1 identity: none and no source -> a loud line, nothing invented', () => {
  const s = setup();
  const out = run(s, 'bash');
  assert.equal(local(s.clone, 'user.email'), '');
  assert.equal(local(s.clone, 'user.name'), '');
  assert.match(out, /WARNING: the clone has no git identity and there is no source/);
  assert.match(out, /CHEAP_MEM_GIT_EMAIL/);
});

test('AU1 identity: half a source (email only) is no source', () => {
  const s = setup();
  const out = run(s, 'bash', { CHEAP_MEM_GIT_EMAIL: 'source@example.test' });
  assert.equal(local(s.clone, 'user.email'), '');
  assert.match(out, /no source/);
});

test('AU1 identity counter-probe: the clone already has one -> kept, the source does not overwrite it', () => {
  const s = setup();
  git(s.clone, 'config', '--local', 'user.email', 'already@example.test');
  git(s.clone, 'config', '--local', 'user.name', 'Already There');
  const out = run(s, 'bash', { CHEAP_MEM_GIT_EMAIL: 'source@example.test', CHEAP_MEM_GIT_NAME: 'Source Name' });
  assert.equal(local(s.clone, 'user.email'), 'already@example.test');
  assert.equal(local(s.clone, 'user.name'), 'Already There');
  assert.doesNotMatch(out, /git identity/);
});

test('AU1 identity: a source with a newline or angle brackets is not adopted', () => {
  const s = setup();
  run(s, 'bash', { CHEAP_MEM_GIT_EMAIL: 'x@y.test', CHEAP_MEM_GIT_NAME: 'Evil <x@y.test>' });
  assert.equal(local(s.clone, 'user.email'), '');
  run(s, 'bash', { CHEAP_MEM_GIT_EMAIL: 'x@y.test', CHEAP_MEM_GIT_NAME: 'Two\nLines' });
  assert.equal(local(s.clone, 'user.email'), '');
});

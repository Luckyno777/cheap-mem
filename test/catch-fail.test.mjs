// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/catch-fail.test.mjs — bin/mem-catch-fail end to end (M19 port from
// lucky-mem, "the swallowed failure"): a Bash call that exits 0 while its
// own output carries a failure signature takes the SAME recall path a
// real PostToolUseFailure would, staying cheap and silent otherwise.
//
// Positive controls throughout: every "this must stay silent" case is
// paired with one proving the same machinery DOES fire when it should.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.resolve(HERE, '..');
const MEM = path.join(CODE, 'bin', 'mem');
const SCRIPT = path.join(CODE, 'bin', 'mem-catch-fail');

function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-catch-fail-'));
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  execFileSync('node', [MEM, '--root', root, 'log', 'error',
    '--title', 'lockfile race - two runs overwrote it',
    '--text', 'the sperrdatei-rennen probe failed because two test runs overwrote the same lock file at once',
    '--class', 'race'], { stdio: 'ignore' });
  return root;
}
const teardown = (root) => fs.rmSync(root, { recursive: true, force: true });

const SUITE_RED = [
  'TAP version 13',
  'ok 1 - reading works',
  'not ok 2 - lockfile race: two runs overwrote the lock file',
  '# tests 2', '# pass 1', '# fail 1',
].join('\n');
const SUITE_GREEN = [
  'TAP version 13',
  'ok 1 - reading works',
  'ok 2 - lockfile race',
  'ok 3 - not ok is just a test name here',
  '# tests 3', '# pass 3', '# fail 0',
].join('\n');

function bashJson({ session = 's1', command = 'npm test 2>&1 | tail -20', stdout = '', stderr = '' } = {}) {
  return JSON.stringify({
    session_id: session, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command }, tool_response: { stdout, stderr, interrupted: false, isImage: false },
  });
}

function run(json, root, extraEnv = {}) {
  return spawnSync('bash', [SCRIPT], {
    input: json, encoding: 'utf8', timeout: 20000,
    env: {
      ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root,
      MEM_CATCH_FAIL_OFF: '', MEM_HOOK_OFF: '', ...extraEnv,
    },
  });
}

test('DER FALL: exit 0 but the output is red — same recall as a real failure', () => {
  const root = build();
  try {
    const r = run(bashJson({ stdout: SUITE_RED }), root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout, 'the caught failure stayed silent');
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, /lockfile race/);
  } finally { teardown(root); }
});

test('FALSE ALARM 0: a green suite (# fail 0) never fires and books nothing', () => {
  const root = build();
  try {
    const r = run(bashJson({ stdout: SUITE_GREEN.replace('not ok is', 'nothing is') }), root);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'a green suite triggered the catch');
    assert.equal(fs.existsSync(path.join(root, '.mem', 'catch-fail-turns')), false,
      'a silent run must not create the once-per-session mark directory either');
  } finally { teardown(root); }
});

test('only Bash: any other tool is ignored even with red-looking output', () => {
  const root = build();
  try {
    const j = JSON.parse(bashJson({ stdout: SUITE_RED }));
    j.tool_name = 'Read';
    const r = run(JSON.stringify(j), root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { teardown(root); }
});

test('stderr counts too (`|| true` swallows a git failure on stderr)', () => {
  const root = build();
  try {
    const r = run(bashJson({
      command: 'git -C x log || true',
      stderr: 'fatal: lockfile race, two runs overwrote the same lock file at once',
    }), root);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout, 'fatal: on stderr was not seen');
  } finally { teardown(root); }
});

test('LATCH: the same caught failure in the same session shows only once', () => {
  const root = build();
  try {
    const first = run(bashJson({ stdout: SUITE_RED }), root);
    assert.ok(first.stdout, 'precondition: the first call must fire');
    const second = run(bashJson({ stdout: SUITE_RED }), root);
    assert.equal(second.stdout, '', 'the same signature fired twice in one session');
  } finally { teardown(root); }
});

test('POSITIVE CONTROL: a DIFFERENT signature, or a different session, still fires', () => {
  const root = build();
  try {
    const first = run(bashJson({ stdout: SUITE_RED, session: 's9' }), root);
    assert.ok(first.stdout, 'precondition: the first call must fire');
    const otherSignature = run(bashJson({
      stdout: SUITE_RED.replace('not ok 2', 'not ok 9'), session: 's9',
    }), root);
    assert.ok(otherSignature.stdout, 'a different failure text was suppressed by the same-session latch');
    const otherSession = run(bashJson({ stdout: SUITE_RED, session: 's10' }), root);
    assert.ok(otherSession.stdout, 'the latch reached across sessions');
  } finally { teardown(root); }
});

// --- The bash sieve: cheap, and observably faster than a node start ----

test('SIEVE: a large harmless output returns fast, without a working memory root at all', () => {
  const big = `${'nothing wrong here, all good\n'.repeat(2000)}0 failures, 0 errors`;
  const t0 = Date.now();
  const r = run(bashJson({ stdout: big }), '/no/such/cheap-mem-root');
  const ms = Date.now() - t0;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  // A node start plus `mem find` measured 200-400ms in the CLI probes
  // above; the sieve alone on 60KB of harmless text must stay well under
  // that, or it is not doing its one job (avoiding exactly that cost).
  assert.ok(ms < 150, `sieve took ${ms}ms on harmless input — no longer cheap`);
});

test('SIEVE: a candidate substring only in the command line, not the output, stays silent', () => {
  const root = build();
  try {
    const r = run(bashJson({ command: 'npm test | grep "not ok"', stdout: '' }), root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { teardown(root); }
});

test('SIEVE: a grep -n hit mid-line ("file:12: ... Error: ...") is not a signature', () => {
  const root = build();
  try {
    const r = run(bashJson({
      command: 'grep -rn "Error:" src | head',
      stdout: 'src/hook.mjs:12:  // Error: sits mid-line\nsrc/a.mjs:3: x = "fatal: y"',
    }), root);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  } finally { teardown(root); }
});

// --- Installer: PostToolUse/Bash, exactly once, HOME never the real one --

function installToTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-catch-fail-home-'));
  const claudeHome = path.join(home, '.claude');
  const memRoot = build();
  const run2 = () => spawnSync('bash', [path.join(CODE, 'install', 'claude-code.sh')], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_HOME: claudeHome, CHEAP_MEM_ROOT: memRoot },
  });
  return { home, claudeHome, memRoot, run: run2 };
}

test('INSTALLER: PostToolUse/Bash -> cheap-mem-catch-fail.sh, exactly once, idempotent', () => {
  const { home, claudeHome, memRoot, run: run2 } = installToTempHome();
  try {
    assert.ok(home !== os.homedir() && claudeHome.startsWith(os.tmpdir()),
      'this probe must never run against the real HOME');
    for (const n of [1, 2]) {
      const r = run2();
      assert.equal(r.status, 0, `installer run ${n} failed: ${r.stderr}`);
    }
    const settings = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
    const matches = (event) => (settings.hooks?.[event] ?? []).flatMap((g) =>
      (g.hooks ?? []).filter((h) => /cheap-mem-catch-fail\.sh/.test(h.command ?? ''))
        .map(() => g.matcher));
    assert.deepEqual(matches('PostToolUse'), ['Bash'], JSON.stringify(settings.hooks?.PostToolUse));
    const copy = path.join(claudeHome, 'hooks', 'cheap-mem-catch-fail.sh');
    assert.ok(fs.existsSync(copy), 'the hook was not copied into ~/.claude/hooks');
    const installed = fs.readFileSync(copy, 'utf8');
    assert.match(installed, /export CHEAP_MEM_ROOT=/);
    // The installed copy must actually run, and stay silent on green input.
    const g = spawnSync('bash', [copy], { input: bashJson({ stdout: SUITE_GREEN }), encoding: 'utf8' });
    assert.equal(g.status, 0);
    assert.equal(g.stdout, '');
  } finally {
    teardown(home);
    teardown(memRoot);
  }
});

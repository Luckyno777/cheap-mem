// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/today-session-start.test.mjs — the session-start hook prints
// `mem today --line`'s output, with its own time cap (N8/N21 parity:
// lucky-mem's bin/mem-startpost.sh "Heute" line).
//
// Same scaffold as test/doctor-alarm.test.mjs's "path to a human" half
// — a stub `bin/mem` so the hook's OWN behaviour is exercised (not a
// grep for `today --line` in its source, which would stay green even
// if the output never reached anybody).
//
// Red proof pinned to this worktree's starting commit
// (ddca89d5430b7c2866a93788edd6fe14822af337, never `git merge-base`):
// that commit's session-start.sh never calls `today` at all — the
// stub below would see no such call, whatever it returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'install', 'hooks', 'session-start.sh');
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';

/** A throwaway memory whose stub `mem` answers only what the hook asks. */
function stage({ todayOut = '', busyMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'today-hook-'));
  spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'mem'), `
const argv = process.argv.slice(2).join(' ');
if (argv.includes('today') && argv.includes('--line')) {
  const until = Date.now() + ${busyMs};
  while (Date.now() < until) { /* real wall clock, so a timeout cap really bites */ }
  const t = ${JSON.stringify(todayOut)};
  if (t) process.stdout.write(t + '\\n');
  process.exit(0);
}
process.exit(0);
`);
  return {
    root,
    run: (hookPath, extra = {}) => spawnSync('bash', [hookPath], {
      encoding: 'utf8',
      env: { ...process.env, CHEAP_MEM_ROOT: root, ...extra },
    }),
  };
}

test('positive control: the hook runs at all and finds the memory', () => {
  const r = stage().run(HOOK);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /cheap-mem attached/);
});

test('RED on the old commit: the hook never calls `mem today` at all', () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:install/hooks/session-start.sh`], { cwd: REPO, encoding: 'utf8' });
  const tmpHook = path.join(REPO, 'install', 'hooks', '.today-old-session-start.sh');
  fs.writeFileSync(tmpHook, old);
  const s = stage({ todayOut: 'Today: this line must never appear on the old commit' });
  try {
    const r = s.run(tmpHook);
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.doesNotMatch(r.stdout, /this line must never appear/);
  } finally { fs.rmSync(tmpHook, { force: true }); fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('GREEN: a notable Today line reaches the start banner', () => {
  const s = stage({ todayOut: 'Today: 1 decision open · operations warn' });
  const r = s.run(HOOK);
  try { assert.match(r.stdout, /Today: 1 decision open · operations warn/, r.stdout); }
  finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('when today --line has nothing to say, the hook stays silent about it', () => {
  const s = stage({ todayOut: '' });
  const r = s.run(HOOK);
  try { assert.doesNotMatch(r.stdout, /Today:/, 'silence beats a banner nobody reads'); }
  finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('hitting the time cap is silent, never a hang (own MEM_TODAY_SECONDS)', (t) => {
  const hasTimeout = spawnSync('sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).status === 0;
  if (!hasTimeout) { t.skip('no timeout(1) on this machine — the cap is not testable'); return; }
  const s = stage({ todayOut: 'Today: must never appear', busyMs: 3000 });
  const start = Date.now();
  try {
    const r = s.run(HOOK, { MEM_TODAY_SECONDS: '1' });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /must never appear/);
    assert.ok(Date.now() - start < 10000, 'the hook must not hang on a slow today() call');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

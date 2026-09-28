// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// install/linux.sh restarts a RUNNING watcher whose unit changed
// (parity with lucky-mem dash-fix4, 2026-09-28).
//
// **Why.** `systemctl enable --now` starts what is stopped and leaves a
// running service alone — with its OLD unit and OLD environment. In the
// sibling house the installer reported "all services running" while the
// dashboard server ran without the variable the run had just added.
// Here the unit carries CHEAP_MEM_ROOT and MEM_WATCH_WHO inline, so a
// re-run with a new root would leave the watcher on the old one.
//
// **How.** The script is really executed, with a fake `systemctl` first
// on PATH (it logs every call and answers `is-active` from a file) and a
// throw-away HOME. Red proof: the same run with the script from 6154cd0a
// (pinned, never merge-base) never calls try-restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SCRIPT = path.join(REPO, 'install', 'linux.sh');
const OLD = '6154cd0a';

const dirs = [];
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function stage({ active = 'active', failRestart = false } = {}) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-linux-restart-'));
  dirs.push(w);
  const home = path.join(w, 'home');
  const bin = path.join(w, 'bin');
  const root = path.join(w, 'root');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{"name":"x","participants":{"a":{"human":true}}}');
  const log = path.join(w, 'systemctl.log');
  fs.writeFileSync(path.join(w, 'active'), `${active}\n`);
  fs.writeFileSync(path.join(bin, 'systemctl'), [
    '#!/bin/sh',
    `echo "$@" >> '${log}'`,
    `if [ "$2" = "is-active" ]; then cat '${path.join(w, 'active')}'; exit 0; fi`,
    failRestart ? 'if [ "$2" = "try-restart" ]; then exit 1; fi' : '',
    'exit 0',
  ].join('\n') + '\n');
  fs.chmodSync(path.join(bin, 'systemctl'), 0o755);
  const unit = path.join(home, '.config', 'systemd', 'user', 'cheap-mem-watch.service');
  const run = (script = SCRIPT, who = 'librarian') => spawnSync('bash', [script], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CHEAP_MEM_ROOT: root, MEM_WATCH_WHO: who },
  });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  return { run, calls, unit };
}
const restarts = (calls) => calls.filter((c) => c.includes('try-restart'));

test('positive control: the stage runs the script and writes the unit', () => {
  const s = stage();
  const r = s.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(s.unit), 'no unit written — the stage proves nothing');
  assert.ok(s.calls().some((c) => c.includes('enable --now')), 'enable --now never called');
});

test('first install: nothing to restart', () => {
  const s = stage();
  s.run();
  assert.deepEqual(restarts(s.calls()), []);
});

test('re-run with a changed unit while the watcher runs: try-restart, with the reason', () => {
  const s = stage();
  assert.equal(s.run(undefined, 'librarian').status, 0);
  const r = s.run(undefined, 'someone-else');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(restarts(s.calls()), ['--user try-restart cheap-mem-watch.service']);
  assert.ok(r.stdout.includes('restarted cheap-mem-watch.service: unit changed'), r.stdout);
});

test('re-run with the same unit: no restart, and it says so', () => {
  const s = stage();
  s.run();
  const r = s.run();
  assert.deepEqual(restarts(s.calls()), []);
  assert.ok(r.stdout.includes('unchanged cheap-mem-watch.service'), r.stdout);
});

test('a stopped watcher is not restarted (enable --now starts it with the new unit)', () => {
  const s = stage({ active: 'inactive' });
  s.run(undefined, 'librarian');
  s.run(undefined, 'someone-else');
  assert.deepEqual(restarts(s.calls()), []);
});

test('a failed restart is a finding, not success', () => {
  const s = stage({ failRestart: true });
  s.run(undefined, 'librarian');
  const r = s.run(undefined, 'someone-else');
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('NOT RESTARTED cheap-mem-watch.service'), r.stderr);
});

test(`RED on the old state (${OLD}): a running watcher with a changed unit is never restarted`, (t) => {
  let old;
  try { old = execFileSync('git', ['-C', REPO, 'show', `${OLD}:install/linux.sh`], { encoding: 'utf8' }); } catch { old = null; }
  if (!old) { t.skip(`commit ${OLD} not reachable — red proof unknown, not green`); return; }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-linux-old-')), 'linux.sh');
  dirs.push(path.dirname(file));
  // The old script finds bin/ relative to itself; point it at the repo.
  fs.writeFileSync(file, old.replace('HERE="$(cd "$(dirname "$0")/.." && pwd)"', `HERE='${REPO}'`));
  const s = stage();
  assert.equal(s.run(file, 'librarian').status, 0);
  const r = s.run(file, 'someone-else');
  assert.equal(r.status, 0, 'the old installer reported success');
  assert.deepEqual(restarts(s.calls()), [], 'old state would have restarted — then the test above proves nothing');
});

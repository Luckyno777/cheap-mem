// What is between "installed" and "working".
//
// **Why this command exists.** Reported from a Windows install on
// 2026-09-08: a hook with the first machine's absolute path baked in,
// dead and SILENT on the second — the session started without its
// memory and looked exactly like one that never had any. Nobody had a
// command that would have said "the memory is not attached here".
//
// **Why it is called `status` and not `setup`.** `mem setup <agent>`
// already existed. I defined `setup` a second time; a duplicate object
// key wins silently, and the help kept printing the old command. The
// same class as `mem frage` in the sibling project on the same day.
// It was caught by the `no-dupe-keys` lint rule, one hour after that
// rule was added — its first real find. `setup` installs, `status`
// reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as setup from '../src/setup.mjs';

const MEM = path.join(import.meta.dirname, '..', 'bin', 'mem');

function fresh() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-status-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), '{}');
  return r;
}

test('no command is defined twice', () => {
  // **Read as TEXT, not as an object.** That is the whole point: in the
  // loaded object a duplicate is invisible, because the second key has
  // replaced the first. Only the file itself shows both.
  const source = fs.readFileSync(MEM, 'utf8');
  const names = [...source.matchAll(/^ {2}([a-z-]+): async/gm)].map((m) => m[1]);
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual(twice, [], `defined twice: ${twice.join(', ')}`);
  assert.ok(names.length > 30, `only ${names.length} commands found — the probe is broken`);
});

test('every step has three possible states, not two', () => {
  // "ok / not ok" would put "not set up yet" and "broken" in one
  // bucket. Those need different answers: one is a task, the other is
  // a fault.
  assert.deepEqual(Object.values(setup.STATE).sort(), ['broken', 'ok', 'open']);
});

test('an unreadable config.json is BROKEN, a missing one is OPEN', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-status-'));
  const missing = setup.check(empty).steps.find((s) => s.id === 'memory');
  assert.equal(missing.state, setup.STATE.OPEN);

  const broken = fresh();
  fs.writeFileSync(path.join(broken, '.mem', 'config.json'), '{ this is not JSON');
  const b = setup.check(broken).steps.find((s) => s.id === 'memory');
  assert.equal(b.state, setup.STATE.BROKEN,
    'an unreadable configuration counts as "not set up yet"');
});

test('THE WINDOWS FINDING: a hook pointing at a dead path is BROKEN', () => {
  // This is the case the command exists for. A hook naming a path that
  // does not exist here is worse than no hook at all: it runs, finds
  // nothing, and exits quietly.
  const r = fresh();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'cheap-mem-session-start.sh'),
    'CHEAP_MEM_ROOT="/gibt/es/hier/nicht"\n');

  const s = setup.check(r, { env: {}, home }).steps.find((x) => x.id === 'hooks');
  assert.equal(s.state, setup.STATE.BROKEN);
  assert.match(s.detail, /gibt\/es\/hier\/nicht/, 'the dead path is not named');
  assert.ok(s.fix, 'no way out given');
});

test('a hook with a path that DOES exist is ok', () => {
  // Counter-check: otherwise the rule would be "every hook is broken".
  const r = fresh();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'cheap-mem-session-start.sh'),
    `CHEAP_MEM_ROOT="${r}"\n`);

  const s = setup.check(r, { env: {}, home }).steps.find((x) => x.id === 'hooks');
  assert.equal(s.state, setup.STATE.OK);
});

test('all steps run even when the first one fails', () => {
  // A run that stops at the first problem hides the other four — and
  // then somebody fixes one thing per session.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-status-'));
  const res = setup.check(empty, { env: {}, home: empty });
  assert.equal(res.steps.length, 5);
  assert.equal(res.steps.filter((s) => s.state).length, 5);
});

test('OPEN exits 0, BROKEN does not', () => {
  // Open is a to-do list. If that turns the exit code red, it breaks
  // every script calling the command — and then nobody puts it in a
  // script any more.
  const r = fresh();
  const a = spawnSync(process.execPath, [MEM, 'status'], { cwd: r, encoding: 'utf8' });
  assert.equal(a.status, 0, `open steps made the run red:\n${a.stdout}${a.stderr}`);
  assert.match(a.stdout, /of 5 in place/);
});

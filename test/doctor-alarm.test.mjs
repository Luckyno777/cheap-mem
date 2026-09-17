// The alarm — and the path it takes to reach a human.
//
// **The finding (2026-09-17, on the sibling house's machine.)** A VM
// reboot wiped three systemd units together with a door secret: that OS
// keeps `/etc` on an overlay backed by `/tmp`. Dashboard, mail poller
// and a public server stood still for 52 minutes.
//
// The doctor HAD the answer the whole time — two findings at level
// ERROR, both correct. The gap was never detection; it was that the
// doctor only runs when someone types it.
//
// So these probes check two things separately: that `alarm()` SELECTS
// the right findings, and that the session-start hook actually PRINTS
// them. The second half runs the hook instead of reading its source — a
// grep for `doctor --alarm` would stay green even if the output never
// reached anybody.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as doctor from '../src/doctor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'install', 'hooks', 'session-start.sh');

const f = (name, level, text) => ({ name, level, text });

test('A: only level ERROR gets through — a warning is backlog, not an alarm', () => {
  const lines = doctor.alarm({ findings: [
    f('index', doctor.LEVEL.GOOD, 'all fine'),
    f('capture', doctor.LEVEL.WARN, '42 captures due'),
    f('viewer', doctor.LEVEL.ERROR, 'last pulse 1.9 h ago'),
    f('watcher', doctor.LEVEL.UNKNOWN, 'no heartbeat here'),
  ] });
  assert.deepEqual(lines, ['FAIL  viewer  last pulse 1.9 h ago']);
});

test('B: nothing red means NOTHING — a banner that always shows becomes background', () => {
  const lines = doctor.alarm({ findings: [
    f('index', doctor.LEVEL.GOOD, 'ok'),
    f('capture', doctor.LEVEL.WARN, 'backlog'),
  ] });
  assert.deepEqual(lines, []);
});

test('C: if half the machine is down the list is capped and the rest is counted', () => {
  const many = Array.from({ length: 9 }, (_, i) => f(`d${i}`, doctor.LEVEL.ERROR, `down ${i}`));
  const lines = doctor.alarm({ findings: many }, { limit: 3 });
  assert.equal(lines.length, 4, 'three findings plus one collecting line');
  assert.match(lines[3], /and 6 more/);
  assert.match(lines[3], /doctor --quiet/, 'the collecting line must say where to look');
});

test('D: a long text is shortened, but never silently cut', () => {
  const lines = doctor.alarm({ findings: [f('x', doctor.LEVEL.ERROR, 'y'.repeat(300))] },
    { width: 40 });
  assert.equal(lines[0].length, 'FAIL  x  '.length + 40);
  assert.ok(lines[0].endsWith('…'), 'the shortening has to be visible');
});

test('E: a multi-line finding is reduced to its first line', () => {
  const lines = doctor.alarm({ findings: [f('x', doctor.LEVEL.ERROR, 'first\nsecond\nthird')] });
  assert.deepEqual(lines, ['FAIL  x  first']);
});

// --- The path to a human ---------------------------------------------

/** A throwaway memory whose `mem` answers only what the hook asks. */
function stage({ alarmOut = '', alarmRc = 0, busyMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-root-'));
  spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{}\n');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'mem'), `
const argv = process.argv.slice(2).join(' ');
if (argv.includes('doctor') && argv.includes('--alarm')) {
  const until = Date.now() + ${busyMs};
  while (Date.now() < until) { /* real wall clock, so timeout really bites */ }
  const t = ${JSON.stringify(alarmOut)};
  if (t) process.stdout.write(t + '\\n');
  process.exit(${alarmRc});
}
process.exit(0);
`);
  return {
    root,
    run: (extra = {}) => spawnSync('bash', [HOOK], {
      encoding: 'utf8',
      env: { ...process.env, CHEAP_MEM_ROOT: root, ...extra },
    }),
  };
}

test('positive control: the hook runs at all and finds the memory', () => {
  const r = stage().run();
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /cheap-mem attached/);
});

test('F: red findings show up in the start banner', () => {
  const r = stage({ alarmOut: 'FAIL  viewer  last pulse 1.9 h ago', alarmRc: 1 }).run();
  assert.match(r.stdout, /DOWN RIGHT NOW/, `no alarm section:\n${r.stdout}`);
  assert.match(r.stdout, /FAIL {2}viewer {2}last pulse 1\.9 h ago/);
});

test('G: when the alarm is silent, so is the hook', () => {
  const r = stage({ alarmOut: '', alarmRc: 0 }).run();
  assert.doesNotMatch(r.stdout, /DOWN RIGHT NOW/,
    'a section on every start is background within three days');
});

test('H: hitting the time cap is REPORTED, not swallowed', (t) => {
  // A real cap with the real `timeout`, not a faked return code. Where
  // there is no timeout(1) the claim is not testable here — then the
  // probe skips and says so instead of shining green.
  const hasTimeout = spawnSync('sh', ['-c', 'command -v timeout'], { encoding: 'utf8' }).status === 0;
  if (!hasTimeout) { t.skip('no timeout(1) on this machine — the cap is not testable'); return; }
  const r = stage({ alarmOut: 'FAIL  x  must never appear', alarmRc: 1, busyMs: 3000 })
    .run({ MEM_ALARM_SECONDS: '1' });
  assert.match(r.stdout, /hit its time cap/, `timed out looked like all fine:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /must never appear/);
});

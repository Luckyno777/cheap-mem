// AU4 (lucky-mem parity, automation gap L4): a digest WITHOUT a bell started
// only from 500 KB; smaller material lay there for as long as nobody rang
// (crash, bell file gone). Now the AGE of the OLDEST open capture counts as
// well: 24 h or older -> due, reason `age-without-bell`.
//
// Red probe: against the code before AU4 the age probes say `no-bell` (not
// due); the counter-probes (young, unreadable name, with a bell, 500 KB rule)
// are the same on both states.
//
// error: 387uxq7ijtrw
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as raw from '../src/raw.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600 * 1000;
const NOW = new Date('2026-10-12T12:00:00Z');

function memory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-au4-'));
  const r = spawnSync('node', [path.join(REPO, 'bin', 'mem'), 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return root;
}
const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
function capture(root, name) {
  const rel = path.join('raw', '2026', '10', name);
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), zlib.gzipSync(Buffer.from('{"text":"x"}\n')));
  return rel;
}
const ago = (root, hours, rest = 'a') => capture(root, `${stamp(new Date(NOW.getTime() - hours * HOUR))}--${rest}.jsonl.gz`);

test('AU4: no bell, oldest open capture 25 h old, far below 500 KB -> due (age-without-bell)', () => {
  const root = memory();
  ago(root, 25);
  assert.equal(raw.bellState(root), null, 'precondition: no bell');
  const d = raw.due(root, { now: NOW });
  assert.equal(d.due, true, JSON.stringify(d));
  assert.equal(d.reason, 'age-without-bell');
  assert.equal(d.oldestMin, 25 * 60);
  assert.ok(d.bytes < 500 * 1024);
});

test('AU4: the OLDEST counts, not the youngest', () => {
  const root = memory();
  ago(root, 2, 'young');
  ago(root, 30, 'old');
  assert.equal(raw.due(root, { now: NOW }).reason, 'age-without-bell');
});

test('AU4 counter-probe: 23 h old is not due yet and the answer names the age', () => {
  const root = memory();
  ago(root, 23);
  const d = raw.due(root, { now: NOW });
  assert.equal(d.due, false);
  assert.equal(d.reason, 'no-bell');
  assert.equal(d.oldestMin, 23 * 60);
});

test('AU4 counter-probe: a name without a readable time -> not due, "age not measurable" with the reason (never assumed young or old)', () => {
  const root = memory();
  capture(root, 'no-time-in-the-name.jsonl.gz');
  const d = raw.due(root, { now: NOW });
  assert.equal(d.due, false);
  assert.equal(d.oldestMin, undefined);
  assert.match(d.ageReason, /no readable time/);
});

test('AU4 positive control: the 500 KB rule still holds without a bell (young but big -> volume-without-bell)', () => {
  const root = memory();
  ago(root, 1);
  assert.equal(raw.due(root, { now: NOW, thresholds: { volumeNow: 1 } }).reason, 'volume-without-bell');
});

test('AU4: the threshold is adjustable (ageWithoutBellMs)', () => {
  const root = memory();
  ago(root, 3);
  assert.equal(raw.due(root, { now: NOW }).due, false);
  assert.equal(raw.due(root, { now: NOW, thresholds: { ageWithoutBellMs: 2 * HOUR } }).reason, 'age-without-bell');
});

test('AU4 counter-probe: WITH a bell nothing changes (the ceiling/quiet rules decide, not the age rule)', () => {
  const root = memory();
  ago(root, 30);
  raw.ring(root, new Date(NOW.getTime() - 60 * 1000));
  const d = raw.due(root, { now: NOW, thresholds: { volumeMin: 10 * 1024 * 1024, ceilingMs: 100 * HOUR } });
  assert.equal(d.due, false);
  assert.equal(d.reason, 'too-little');
});

test('AU4: oldestOpenTime reads the name, picks the minimum, and says why when it cannot', () => {
  assert.equal(raw.oldestOpenTime(['raw/2026/10/2026-10-11T09-00-00Z--b.jsonl.gz', 'raw/2026/10/2026-10-10T08-30-15Z--a.jsonl.gz']).time, '2026-10-10T08:30:15Z');
  assert.equal(raw.oldestOpenTime([]).time, null);
  assert.match(raw.oldestOpenTime(['raw/x/old-name.jsonl.gz']).reason, /no readable time/);
});

function mem(root, ...args) {
  return spawnSync('node', [path.join(REPO, 'bin', 'mem'), ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
}

test('AU4 CLI: mem digest due knows --age-without-bell (exit 1 = due) and shows the age', () => {
  const root = memory();
  capture(root, `${stamp(new Date(Date.now() - 5 * HOUR))}--a.jsonl.gz`);
  const no = mem(root, 'digest', 'due');
  assert.equal(no.status, 0, no.stderr + no.stdout);
  assert.match(no.stdout, /not due \(no-bell\)/);
  assert.match(no.stdout, /oldest open capture 5 h/);
  const yes = mem(root, 'digest', 'due', '--age-without-bell', '4');
  assert.equal(yes.status, 1, yes.stderr + yes.stdout);
  assert.match(yes.stdout, /DUE \(age-without-bell\)/);
  assert.equal(JSON.parse(mem(root, 'digest', 'due', '--age-without-bell', '4', '--json').stdout).reason, 'age-without-bell');
});

// --- End to end: the real tick (bin/mem-digest) with a stand-in model -------

function tick(root, extraEnv = {}) {
  const calls = path.join(root, '.mem', 'model-calls');
  const fake = path.join(root, 'fake-model.sh');
  fs.writeFileSync(fake, `#!/bin/sh\necho x >> "${calls}"\nprintf '%s' '{"result":"ok","usage":{"input_tokens":1,"output_tokens":1},"total_cost_usd":0,"is_error":false,"session_id":"s"}'\n`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'mem-digest')], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_DIGEST_CMD: fake, MEM_DIGEST_TIMEOUT: '20', ...extraEnv },
  });
  return { r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).length : 0 };
}

test('AU4 end to end: with no bell the tick starts the digest for a 26 h old small capture, not for a 2 h old one', () => {
  const old = memory();
  capture(old, `${stamp(new Date(Date.now() - 26 * HOUR))}--a.jsonl.gz`);
  const a = tick(old);
  assert.equal(a.calls, 1, `old capture without a bell: ${a.calls} model calls instead of 1\n${a.r.stderr}\n${a.r.stdout}`);

  const young = memory();
  capture(young, `${stamp(new Date(Date.now() - 2 * HOUR))}--a.jsonl.gz`);
  const j = tick(young);
  assert.equal(j.calls, 0, `young capture without a bell started the digest (${j.calls})`);
  assert.equal(j.r.status, 0, j.r.stderr);
});

test('AU4: bin/mem-digest passes MEM_DIGEST_AGE_WITHOUT_BELL_H on to the flag', () => {
  const sh = fs.readFileSync(path.join(REPO, 'bin', 'mem-digest'), 'utf8');
  assert.match(sh, /MEM_DIGEST_AGE_WITHOUT_BELL_H[^\n]*--age-without-bell/);
});

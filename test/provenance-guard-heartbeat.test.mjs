// Three foundations ported from the reference deployment (2026-09-08):
// origin stamping, error latches, and heartbeats.
//
// **Why they belong together.** Each one answers a question the memory
// could not answer before, and the later two depend on the first:
//
//   origin     855 of 1081 entries carried no agent field (79 %). The
//              axis every authority comparison rests on was empty.
//   latch      289 classified errors, 43 % of them in classes that
//              recurred across DAYS. The class warning counts; it does
//              not prevent.
//   heartbeat  no signal separate from work output. "Dead" and
//              "nothing to do" looked identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as guard from '../src/guard.mjs';
import * as heartbeat from '../src/heartbeat.mjs';
import * as search from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-found-'));
  spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return root;
}
function cli(root, argv, env = {}) {
  return spawnSync('node', [MEM, '--root', root, ...argv],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
}

// --- Origin ----------------------------------------------------------

test('POSITIVE CONTROL: agentDefault returns something at all', () => {
  assert.ok(memory.agentDefault({ USER: 'lucky' }));
});

test('an explicitly set agent wins', () => {
  const w = world();
  try {
    const { entry } = memory.logEntry(w, 'thought', { text: 'x', agent: 'chatgpt' });
    assert.equal(entry.agent, 'chatgpt');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('then the env, then human:<user>', () => {
  assert.equal(memory.agentDefault({ CHEAP_MEM_AGENT: 'curator', USER: 'lucky' }), 'curator');
  assert.equal(memory.agentDefault({ USER: 'lucky' }), 'human:lucky');
  assert.equal(memory.agentDefault({ LOGNAME: 'lucky' }), 'human:lucky');
});

test('THE RULE: never invent `session`', () => {
  // An invented origin is worse than none: it looks credible, so a
  // later reader takes it for evidence.
  for (const env of [{}, { USER: '' }, { USER: 'lucky' }]) {
    const a = memory.agentDefault(env);
    assert.notEqual(a, 'session');
    assert.notEqual(a, 'unknown');
    assert.ok(a.startsWith('human:'), `unexpected default: ${a}`);
  }
});

test('human and machine names stay distinguishable', () => {
  assert.ok(memory.agentDefault({ USER: 'lucky' }).startsWith('human:'));
  assert.ok(!memory.agentDefault({ CHEAP_MEM_AGENT: 'curator' }).startsWith('human:'));
});

test('every entry written through the CLI carries one', () => {
  const w = world();
  try {
    cli(w, ['log', 'thought', '--text', 'hello'], { CHEAP_MEM_AGENT: 'probe' });
    const e = JSON.parse(fs.readFileSync(path.join(w, 'global', 'thoughts.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.equal(e.agent, 'probe');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// --- Latches ---------------------------------------------------------

test('POSITIVE CONTROL: a latch can be green and red', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w, 'sample.txt'), 'hello world\n');
    assert.equal(guard.check({ kind: 'present', path: 'sample.txt', pattern: 'hello' },
      { root: w }).state, 'green');
    assert.equal(guard.check({ kind: 'absent', path: 'sample.txt', pattern: 'hello' },
      { root: w }).state, 'red');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE RULE: a latch executes nothing — the vocabulary is closed', () => {
  // An entry is data. If a latch were a shell command, a connected
  // agent could drop code on this machine and wait for the latches to
  // be run.
  const w = world();
  try {
    const r = guard.check({ kind: 'sh', path: '.', pattern: 'echo hi' }, { root: w });
    assert.equal(r.state, 'broken');
    assert.match(r.why, /unknown kind/);
    for (const k of Object.keys(guard.GUARD_KINDS)) {
      assert.ok(!/exec|shell|command|run/i.test(k), `'${k}' smells like execution`);
    }
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('the pattern is literal text, not a regular expression', () => {
  // A crafted pattern read as a regex can make a match run
  // arbitrarily long.
  // The direction matters. An earlier version of this test wrote
  // "a.c" into the file and asked for "a[b]c" — which matches neither
  // literally nor as a regex, so the sabotage run stayed green and the
  // assertion checked nothing. It has to be a case where the two
  // readings DISAGREE: the file says "abc", the pattern is "a.c".
  // Literal: not found. As a regex: found.
  const w = world();
  try {
    fs.writeFileSync(path.join(w, 's.txt'), 'abc\n');
    assert.equal(guard.check({ kind: 'present', path: 's.txt', pattern: 'abc' },
      { root: w }).state, 'green', 'the positive control itself fails');
    assert.equal(guard.check({ kind: 'present', path: 's.txt', pattern: 'a.c' },
      { root: w }).state, 'red', 'the pattern was read as a regex');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('no escaping the root', () => {
  const w = world();
  try {
    const r = guard.check({ kind: 'file-there', path: '../../../etc/passwd' }, { root: w });
    assert.equal(r.state, 'broken');
    assert.match(r.why, /outside the root/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE POINT: broken is NOT green', () => {
  // A latch pointing at a deleted file has checked nothing. Counting
  // that as a pass would be the very class it is built against.
  const w = world();
  try {
    const r = guard.check({ kind: 'present', path: 'gone.txt', pattern: 'x' }, { root: w });
    assert.equal(r.state, 'broken');
    assert.notEqual(r.state, 'green');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a green latch at creation time is reported, not swallowed', () => {
  // A latch that was never red is unproven — the same thing as a
  // falsification test without a backdrop.
  const w = world();
  try {
    fs.writeFileSync(path.join(w, 'a.txt'), 'boom\n');
    const r = cli(w, ['log', 'error', '--class', 'x', '--title', 't',
      '--guard-kind', 'present', '--guard-path', 'a.txt', '--guard-pattern', 'boom']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GREEN at creation/);
    const e = JSON.parse(fs.readFileSync(path.join(w, 'global', 'errors.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.equal(e.guard_at_creation, 'green');
    assert.deepEqual(e.guard, { kind: 'present', path: 'a.txt', pattern: 'boom' });
    assert.ok(!Object.hasOwn(e, 'guard-kind'), 'half a latch landed as a loose field');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('`mem guard run` exits 1 while something is red', () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w, 'a.txt'), 'boom\n');
    cli(w, ['log', 'error', '--class', 'x', '--title', 't',
      '--guard-kind', 'absent', '--guard-path', 'a.txt', '--guard-pattern', 'boom']);
    const red = cli(w, ['guard', 'run']);
    assert.equal(red.status, 1, red.stdout);
    assert.match(red.stdout, /RED/);

    fs.writeFileSync(path.join(w, 'a.txt'), 'fixed\n');
    const green = cli(w, ['guard', 'run']);
    assert.equal(green.status, 0, green.stdout);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// --- Heartbeat -------------------------------------------------------

test('POSITIVE CONTROL: a heartbeat is written and read back', () => {
  const w = world();
  try {
    assert.equal(heartbeat.beat(w, 'probe').written, true);
    assert.equal(heartbeat.latest(w).get('probe').agent, 'probe');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE QUIET PERIOD: a second beat inside the window writes nothing', () => {
  // A pulse every three minutes would be 480 lines per agent per day —
  // the memory buried under its own pulse measurement.
  const w = world();
  try {
    heartbeat.beat(w, 'probe');
    const again = heartbeat.beat(w, 'probe');
    assert.equal(again.written, false, 'the quiet period does not hold');
    assert.match(again.why, /quiet period/);
    assert.equal(heartbeat.read(w).lines.length, 1);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('after the window it writes again', () => {
  const w = world();
  try {
    heartbeat.beat(w, 'probe', { now: new Date('2026-09-08T10:00:00Z') });
    const later = heartbeat.beat(w, 'probe', { now: new Date('2026-09-08T12:00:00Z') });
    assert.equal(later.written, true);
    assert.equal(heartbeat.read(w).lines.length, 2);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE DISTINCTION: never seen is null, not Infinity', () => {
  // "Never seen" and "not seen for a long time" are different
  // statements, and the first usually means the agent does not call
  // the heartbeat at all.
  const w = world();
  try {
    assert.equal(heartbeat.ageMin(w, 'nobody'), null);
    heartbeat.beat(w, 'probe', { now: new Date('2026-09-08T10:00:00Z') });
    const age = heartbeat.ageMin(w, 'probe', { now: new Date('2026-09-08T11:00:00Z') });
    assert.equal(Math.round(age), 60);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('broken lines are COUNTED, not swallowed', () => {
  const w = world();
  try {
    heartbeat.beat(w, 'probe');
    fs.appendFileSync(path.join(w, heartbeat.LOG), 'this is not json\n');
    const r = heartbeat.read(w);
    assert.equal(r.lines.length, 1);
    assert.equal(r.broken, 1);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// --- Roads not taken -------------------------------------------------

test('THE RULE: `rejected` weighs LESS than `choice`', () => {
  // At equal or higher weight, somebody searching for the tool they USE
  // would first find the decision in which it was REJECTED.
  assert.ok(search.FIELD_WEIGHTS.rejected < search.FIELD_WEIGHTS.choice,
    `rejected ${search.FIELD_WEIGHTS.rejected} vs choice ${search.FIELD_WEIGHTS.choice}`);
  assert.ok(search.FIELD_WEIGHTS.rejected > 0, 'zero weight would be no field at all');
});

test('and rejected roads are indexed at all', () => {
  const g = search.fieldsOfEntry({ rejected: ['PostgreSQL: too heavy'] });
  assert.ok((g.get('postgresql') ?? 0) > 0,
    'a rejected road is not findable — then the field was pointless');
});

test('DER PUNKT: --rejected splits on a SEMICOLON, so commas survive', () => {
  // "PostgreSQL: too heavy, and too much ops" is one statement. A comma
  // split makes it two fragments, neither of which says anything.
  const w = world();
  try {
    cli(w, ['log', 'decision', '--topic', 'db', '--choice', 'SQLite', '--why', 'one file',
      '--rejected', 'PostgreSQL: too heavy, and too much ops; Redis: no need']);
    const e = JSON.parse(fs.readFileSync(path.join(w, 'global', 'decisions.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.deepEqual(e.rejected, ['PostgreSQL: too heavy, and too much ops', 'Redis: no need']);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('and still takes a JSON list', () => {
  const w = world();
  try {
    cli(w, ['log', 'decision', '--topic', 'db', '--choice', 'x', '--why', 'y',
      '--rejected', '["A: one, two","B"]']);
    const e = JSON.parse(fs.readFileSync(path.join(w, 'global', 'decisions.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.deepEqual(e.rejected, ['A: one, two', 'B']);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// The last four of the 2026-09-08 plan: neighbours at write time,
// onboarding, sources, components.
//
// **Neighbours.** The brief said "conflict at write time". Measured,
// the obvious rule would have been wrong 5 times out of 5, so what got
// built is the useful half: show, do not judge.
//
// **Onboarding.** A connected agent had the log tool for a whole day
// and used it not once. Configured, not connected.
//
// **Sources.** Company knowledge is already somewhere. The cheapest
// entrance is a boring one — and it must not become a crawler.
//
// **Components.** The pre-edit hook ran at a third of its reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as cfgmod from '../src/config.mjs';
import * as neighbours from '../src/neighbours.mjs';
import * as onboarding from '../src/onboarding.mjs';
import * as source from '../src/source.mjs';
import * as component from '../src/component.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const HOOK = path.join(REPO, 'bin', 'mem-before-edit');

function world({ agents: extra = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ma3-'));
  spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  for (const a of extra) {
    spawnSync('node', [MEM, '--root', root, 'agent', 'new', a, '--role', 'builder'],
      { encoding: 'utf8', timeout: 30000 });
  }
  return root;
}
function cli(root, argv, env = {}) {
  return spawnSync('node', [MEM, '--root', root, ...argv],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
}

// --- Neighbours ------------------------------------------------------

test('POSITIVE CONTROL: the same topic is found', () => {
  const w = world();
  try {
    memory.logEntry(w, 'decision', { topic: 'database', choice: 'SQLite', why: 'x' });
    const n = neighbours.neighbours(w, 'decision', { topic: 'database', choice: 'Postgres' });
    assert.equal(n.hits.length, 1);
    assert.equal(n.hits[0].choice, 'SQLite');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a different topic is no neighbour', () => {
  const w = world();
  try {
    memory.logEntry(w, 'decision', { topic: 'database', choice: 'SQLite', why: 'x' });
    assert.equal(neighbours.neighbours(w, 'decision', { topic: 'viewer', choice: 'PWA' }).hits.length, 0);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a withdrawn ruling is no neighbour', () => {
  // Showing it would weigh the writer against something that no longer
  // holds.
  const w = world();
  try {
    const { entry } = memory.logEntry(w, 'decision', { topic: 'database', choice: 'SQLite', why: 'x' });
    const r = cli(w, ['discard', entry.id, '--why', 'superseded']);
    assert.equal(r.status, 0, r.stderr);
    const n = neighbours.neighbours(w, 'decision', { topic: 'database', choice: 'Postgres' });
    assert.equal(n.hits.length, 0, 'a discarded ruling shows up as a neighbour');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE RULE: the hint never asserts a conflict', () => {
  // This code does not know whether two rulings cancel each other, and
  // cannot. Five of five cases in the reference corpus are follow-ups.
  const w = world();
  try {
    memory.logEntry(w, 'decision', { topic: 'database', choice: 'SQLite', why: 'x' });
    const n = neighbours.neighbours(w, 'decision', { topic: 'database', choice: 'Postgres' });
    const text = neighbours.hint(n).join('\n');
    assert.ok(!/contradicts the|this contradicts|conflict detected/i.test(text),
      `the hint passes judgement: ${text}`);
    assert.match(text, /already stands/);
    assert.match(text, /replaces_id/, 'the "this supersedes" way out is missing');
    assert.match(text, /kind contradicts/, 'the "they contradict" way out is missing');
    assert.match(text, /do nothing/, 'the most common case — both hold — is missing');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('without neighbours no hint appears at all', () => {
  assert.deepEqual(neighbours.hint({ hits: [] }), []);
  const w = world();
  try {
    const r = cli(w, ['log', 'decision', '--topic', 'new', '--choice', 'x', '--why', 'y']);
    assert.ok(!/already stands/.test(r.stdout), r.stdout);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('REACH: `mem log` shows it, and not the entry it just wrote', () => {
  const w = world();
  try {
    cli(w, ['log', 'decision', '--topic', 'database', '--choice', 'SQLite', '--why', 'x']);
    const second = cli(w, ['log', 'decision', '--topic', 'database', '--choice', 'Postgres', '--why', 'y']);
    assert.match(second.stdout, /Something already stands under topic 'database'/, second.stdout);
    assert.match(second.stdout, /SQLite/);
    // Read BEFORE the write, or the hint would read "something already
    // stands: your entry from a second ago".
    const only = cli(w, ['log', 'decision', '--topic', 'once', '--choice', 'x', '--why', 'y']);
    assert.ok(!/already stands/.test(only.stdout), only.stdout);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// --- Onboarding ------------------------------------------------------

test('POSITIVE CONTROL: a freshly created agent is NOT done', () => {
  const w = world({ agents: ['newcomer'] });
  try {
    const st = onboarding.status(w, 'newcomer', { participants: cfgmod.readConfig(w).participants });
    assert.equal(st.done, false, 'created counts as onboarded — that is the mistake itself');
    assert.equal(st.steps.inbox.state, 'green');
    assert.equal(st.steps.written.state, 'red');
    assert.equal(st.steps.loop.state, 'red');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE CORE: somebody else\'s entry does not count', () => {
  // Otherwise you could "onboard" an agent by writing for it — exactly
  // the tick that must not exist here.
  const w = world({ agents: ['newcomer'] });
  try {
    memory.logEntry(w, 'thought', { text: 'I write for it', tags: [onboarding.PROBE_TAG],
      agent: 'session' });
    const st = onboarding.status(w, 'newcomer', { participants: cfgmod.readConfig(w).participants });
    assert.equal(st.steps.written.state, 'red');
    assert.equal(st.steps.loop.state, 'red');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE LOOP: written AND found again', () => {
  const w = world({ agents: ['newcomer'] });
  try {
    memory.logEntry(w, 'thought', { text: 'the probe', tags: [onboarding.PROBE_TAG],
      agent: 'newcomer' });
    const st = onboarding.status(w, 'newcomer', { participants: cfgmod.readConfig(w).participants });
    assert.equal(st.steps.loop.state, 'green', st.steps.loop.why);
    assert.match(st.steps.loop.why, /found again/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a WITHDRAWN probe no longer proves the loop', () => {
  // Without this, the "found again" half distinguishes nothing: an
  // entry contains its own id, so the literal search always finds it —
  // as long as it holds. `find` hides retired entries, and that is
  // where the difference shows.
  const w = world({ agents: ['newcomer'] });
  try {
    const { entry } = memory.logEntry(w, 'thought', { text: 'the probe',
      tags: [onboarding.PROBE_TAG], agent: 'newcomer' });
    const parts = cfgmod.readConfig(w).participants;
    assert.equal(onboarding.status(w, 'newcomer', { participants: parts }).steps.loop.state, 'green');
    const r = cli(w, ['discard', entry.id, '--why', 'not after all']);
    assert.equal(r.status, 0, r.stderr);
    const loop = onboarding.status(w, 'newcomer', { participants: parts }).steps.loop;
    assert.equal(loop.state, 'red', 'a revoked proof still counts');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('`done` only when EVERY step is green', () => {
  const w = world({ agents: ['newcomer'] });
  try {
    memory.logEntry(w, 'thought', { text: 'the probe', tags: [onboarding.PROBE_TAG],
      agent: 'newcomer' });
    const parts = cfgmod.readConfig(w).participants;
    let st = onboarding.status(w, 'newcomer', { participants: parts });
    assert.equal(st.done, false, 'four of five already counts as done');
    assert.deepEqual(st.open, ['heartbeat']);

    const r = cli(w, ['heartbeat'], { CHEAP_MEM_AGENT: 'newcomer' });
    assert.equal(r.status, 0, r.stderr);
    st = onboarding.status(w, 'newcomer', { participants: parts });
    assert.equal(st.done, true, st.open.join(', '));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('`mem onboarding` exits 1 while something is open, and names the fix', () => {
  const w = world({ agents: ['newcomer'] });
  try {
    const openRun = cli(w, ['onboarding', 'newcomer']);
    assert.equal(openRun.status, 1, openRun.stdout);
    assert.match(openRun.stdout, /created is not connected/);
    const st = onboarding.status(w, 'newcomer', { participants: cfgmod.readConfig(w).participants });
    for (const step of st.open) {
      assert.ok(st.steps[step].todo, `step '${step}' does not say what to do`);
    }
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// --- Sources ---------------------------------------------------------

test('POSITIVE CONTROL: `source` is a type, not a folder off to the side', () => {
  assert.ok(Object.hasOwn(memory.TYPES, 'source'));
  assert.ok(search.FIELD_WEIGHTS.excerpt > 0);
});

test('the excerpt weighs LESS than our own text', () => {
  assert.ok(search.FIELD_WEIGHTS.excerpt < search.FIELD_WEIGHTS.text,
    `excerpt ${search.FIELD_WEIGHTS.excerpt} vs text ${search.FIELD_WEIGHTS.text}`);
});

test('THE PURPOSE: a company document is findable by its own words', () => {
  const w = world();
  try {
    for (let i = 0; i < 12; i += 1) {
      memory.logEntry(w, 'learning', { title: `filler ${i}`, text: `something about topic ${i}` });
    }
    const f = path.join(w, 'handbook.md');
    fs.writeFileSync(f, 'Sales handbook\n\nDiscount tiers: A five percent, B twelve percent.\n');
    source.take(w, f, { title: 'Sales handbook' });
    const hits = search.search(search.buildIndex(w), 'discount tiers', { top: 5, minScore: 0 });
    assert.ok(hits.length, 'the document is not findable');
    assert.equal(hits[0].entry.title, 'Sales handbook');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE RULE: an address stays a pointer — nothing is fetched', () => {
  const w = world();
  try {
    const { entry } = source.take(w, 'https://intranet.example.com/wiki/X', { title: 'Wiki X' });
    assert.equal(entry.kind, 'address');
    assert.ok(!entry.excerpt, 'there is text nobody supplied — it was fetched');
    assert.ok(!entry.hash);
    // The pattern is narrow on purpose.
    assert.ok(!source.isAddress('ftp://example.com/x'));
    assert.ok(!source.isAddress('file:///etc/passwd'));
    assert.ok(source.isAddress('https://example.com/x'));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a local file lands in the store, the entry carries the hash', () => {
  const w = world();
  try {
    const f = path.join(w, 'h.md');
    fs.writeFileSync(f, 'Contents of a handbook.\n');
    const { entry } = source.take(w, f, { title: 'H' });
    assert.equal(entry.kind, 'file');
    assert.match(String(entry.hash), /^[0-9a-f]{64}$/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('a binary file gets no byte soup as an excerpt', () => {
  const w = world();
  try {
    const f = path.join(w, 'img.png');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    const { entry } = source.take(w, f, { title: 'Image' });
    assert.ok(!entry.excerpt, 'byte soup in the index makes every search worse');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE CAP: a long document is truncated and says so', () => {
  const w = world();
  try {
    const f = path.join(w, 'long.md');
    fs.writeFileSync(f, 'word '.repeat(20000));
    const { entry } = source.take(w, f, { title: 'Long' });
    assert.ok(entry.excerpt.length <= source.MAX_EXCERPT,
      `${entry.excerpt.length} characters — the cap does not bite`);
    assert.equal(entry.truncated, true, 'truncated without saying so');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE LATCH: a secret in the excerpt is redacted and reported', () => {
  // The fixtures are ASSEMBLED, never written out: the pre-commit
  // secret scanner reads this file as text and cannot know a secret is
  // invented.
  const word = ['PASS', 'WORD'].join('');
  const value = ['hunter2', 'secret'].join('');
  const a = source.excerpt(`Login with ${word}=${value} and continue`);
  assert.ok(!a.text.includes(value), `unredacted: ${a.text}`);
  assert.ok(a.findings.length, 'redacted, but silently — nobody looks');
});

// --- Components ------------------------------------------------------

test('POSITIVE CONTROL: two forms, narrow before wide', () => {
  assert.deepEqual(component.forms('/home/u/cheap-mem/bin/capture.sh'),
    ['bin/capture.sh', 'capture.sh']);
  assert.deepEqual(component.forms('mem.sh'), ['mem.sh']);
  assert.deepEqual(component.forms(''), []);
});

test('THE LATCH: a DIFFERENT prefix is not compatible', () => {
  // `projects/x/events.jsonl` answers no question about
  // `global/events.jsonl`. That is a different file.
  assert.ok(component.compatible('in capture.sh there is', 'capture.sh', 'bin'));
  assert.ok(component.compatible('in bin/capture.sh', 'capture.sh', 'bin'));
  assert.ok(!component.compatible('projects/x/events.jsonl', 'events.jsonl', 'global'));
  assert.ok(component.compatible('global/events.jsonl', 'events.jsonl', 'global'));
  assert.ok(!component.compatible('see old-mem.sh', 'mem.sh', 'bin'));
});

test('THE PURPOSE: the second form fetches the missed entries', () => {
  const w = world();
  try {
    memory.logEntry(w, 'error', { class: 'a', title: 'it hangs in bin/capture.sh' });
    memory.logEntry(w, 'error', { class: 'b', title: 'capture.sh catches nothing' });
    memory.logEntry(w, 'error', { class: 'c', title: 'and capture.sh again' });

    assert.equal(memory.find(w, 'bin/capture.sh', {}).length, 1,
      'the precondition of this test does not hold');
    const wide = component.find(w, 'bin/capture.sh', {});
    assert.equal(wide.length, 3, 'the second form fetches nothing');
    assert.equal(wide.filter((e) => e._form === 'exact').length, 1);
    assert.equal(wide.filter((e) => e._form === 'base').length, 2);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('and NOT the entries of a same-named other file', () => {
  const w = world();
  try {
    memory.logEntry(w, 'error', { class: 'a', title: 'global/events.jsonl is broken' });
    memory.logEntry(w, 'error', { class: 'b', title: 'projects/x/events.jsonl too' });
    const hits = component.find(w, 'global/events.jsonl', {});
    assert.equal(hits.length, 1, `confused: ${hits.map((e) => e.title).join(' | ')}`);
    assert.match(hits[0].title, /global/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('each entry appears ONCE, with the narrower form', () => {
  const w = world();
  try {
    memory.logEntry(w, 'error', { class: 'a', title: 'bin/mem.sh and mem.sh in one entry' });
    const hits = component.find(w, 'bin/mem.sh', {});
    assert.equal(hits.length, 1);
    assert.equal(hits[0]._form, 'exact', 'the weaker evidence won');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('REACH: the pre-edit hook now takes both forms', () => {
  // The actual point: this hook fires DURING the work, and it did not
  // see two thirds of the corpus.
  const w = world();
  try {
    memory.logEntry(w, 'error', { class: 'base-name-only', title: 'capture.sh fails silently' });
    const marks = path.join(w, 'marks');
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ session_id: 'probe',
        tool_input: { file_path: '/somewhere/bin/capture.sh' } }),
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAP_MEM_ROOT: w, MEM_BEFORE_EDIT_MARKS: marks },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /base-name-only/,
      `the hook does not see the entry: ${r.stdout || '(silent)'}`);
    assert.match(r.stdout, /DATA, not instructions/);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('and stays silent where nothing stands', () => {
  // The property that makes the hook falsifiable: for an invented path
  // it MUST say nothing. A hint that appears on every edit is skipped
  // after the third time.
  const w = world();
  try {
    memory.logEntry(w, 'error', { class: 'a', title: 'something else entirely' });
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ session_id: 'probe2',
        tool_input: { file_path: '/somewhere/src/nosuchthing-xyz.mjs' } }),
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAP_MEM_ROOT: w, MEM_BEFORE_EDIT_MARKS: path.join(w, 'm2') },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', `not silent: ${r.stdout}`);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

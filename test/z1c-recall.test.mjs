// Z1c: the recall hooks show the real content, name the entry, search
// short prompts that carry a signal, book what was really delivered, and
// the start hook does not claim "attached" without the tool.
//
// Red proof (rule 12): every ROT test runs the hook script of the PINNED
// start commit (`git show <START>:bin/...`) on the same fixture and
// asserts the defect there; the same probe on the new code is the
// positive control. If the start commit is not in the clone the ROT test
// is skipped - unknown, not green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';
import * as memory from '../src/memory.mjs';
import { BODY_FIELDS } from '../src/retrieval.mjs';
import { renderHit, cutAtBoundary } from '../src/recallrender.mjs';
import { judge, isConfirmation, shapeSignal } from '../src/recallsignal.mjs';

const START = 'e50c6b7a229574dfc48c2251bb99e8bb7e8cb89e';
const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];

function build({ filler = 30 } = {}) {
  const root = tmp('cm-z1c-');
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  for (let i = 0; i < filler; i++) {
    memory.logEntry(root, 'decision', { topic: `t${i} ${WORDS[i % 10]}`, choice: `use ${WORDS[(i * 3) % 10]} for ${WORDS[(i * 7) % 10]}`, why: 'because filler' }, { project: null });
  }
  const learning = memory.logEntry(root, 'learning', {
    title: 'amberquartz deployment',
    learning: 'ESSENTIAL_ACTION_STOP_BEFORE_DEPLOYMENT',
    tags: ['deploy'],
  }, { project: null }).entry;
  return { root, learning };
}
const teardown = (root) => fs.rmSync(root, { recursive: true, force: true });

/** The hook script of the pinned start commit, wired to the CURRENT tool. */
function oldHook(name) {
  let src;
  try { src = execFileSync('git', ['show', `${START}:bin/${name}`], { encoding: 'utf8', stdio: 'pipe' }); }
  catch { return null; }
  const dir = tmp('cm-z1c-old-');
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.writeFileSync(path.join(dir, 'bin', name), src, { mode: 0o755 });
  fs.copyFileSync(path.join(CODE, 'bin', '_portable.sh'), path.join(dir, 'bin', '_portable.sh'));
  fs.symlinkSync(MEM, path.join(dir, 'bin', 'mem'));
  fs.symlinkSync(path.join(CODE, 'src'), path.join(dir, 'src'));
  return { dir, script: path.join(dir, 'bin', name) };
}

function run(script, input, root, extra = {}) {
  return spawnSync('bash', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_NO_PULL: '1',
      MEM_RETRIEVE_TURNS: path.join(root, '.mem', 'turns'), MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '', ...extra },
  });
}
const NEW_RETRIEVE = path.join(CODE, 'bin', 'mem-retrieve');
const ctx = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return r.stdout; } };
const QUESTION = 'what is the amberquartz deployment procedure';

// ---- 1. the content is shown -----------------------------------------

test('renderer: every BODY_FIELD reaches the line, next to the title and the ID (one truth: BODY_FIELDS)', () => {
  for (const f of BODY_FIELDS) {
    if (f === 'title' || f === 'why') continue;
    const e = { id: 'abc123def456', ts: '2026-09-30T10:00:00Z', class: 'k', title: 'The Title', [f]: `MARK_${f}_END` };
    const { line } = renderHit({ entry: e, source: 'x/learnings.jsonl', line: 3, score: 9 });
    assert.ok(line.includes(`MARK_${f}_END`), `${f}: content missing in ${line}`);
    assert.ok(line.includes('The Title'), `${f}: title missing`);
    assert.ok(line.includes('abc123def456'), `${f}: id missing`);
  }
});

test('renderer: the reason keeps its place, an unknown shape is not empty and not raw JSON', () => {
  const { line } = renderHit({ entry: { id: 'i1', ts: '2026-09-30', choice: 'X', why: 'ONLY BECAUSE Y' }, source: 'd/decisions.jsonl', line: 1 });
  assert.match(line, /because ONLY BECAUSE Y/);
  const odd = renderHit({ entry: { id: 'i2', ts: '2026-09-30', wibble: 'strange shape text' }, source: 'd/x.jsonl', line: 1 }).line;
  assert.match(odd, /strange shape text/);
  assert.ok(!odd.includes('{'), odd);
});

test('renderer: a cut falls on a boundary and is marked with the way to the full text', () => {
  const long = 'First sentence is short. Second sentence carries on for a while and on. ' + 'word '.repeat(120);
  const r = renderHit({ entry: { id: 'idcut1', ts: '2026-09-30', learning: long }, source: 'a/learnings.jsonl', line: 1 });
  assert.equal(r.cut, true);
  assert.match(r.line, /… \[cut - full text: mem show idcut1\]$/);
  const c = cutAtBoundary('One two three four five. Six seven eight nine ten eleven twelve.', 40);
  assert.equal(c.text, 'One two three four five. …', 'not on the sentence boundary: ' + c.text);
  assert.equal(cutAtBoundary('short', 40).cut, false);
});

test('ROT + control: the pinned start commit shows a learning with a title as its title alone; the new hook shows the content and the ID', (t) => {
  const old = oldHook('mem-retrieve');
  if (!old) { t.skip('start commit not in this clone - unknown, not green'); return; }
  const b = build();
  try {
    const before = ctx(run(old.script, { prompt: QUESTION, session_id: 's-old' }, b.root));
    assert.ok(before.includes('amberquartz deployment'), 'the fixture must be found at all: ' + before);
    assert.ok(!before.includes('ESSENTIAL_ACTION'), 'RED: the start commit is expected to drop the content');
    assert.ok(!before.includes(b.learning.id), 'RED: the start commit names no ID');
    const after = ctx(run(NEW_RETRIEVE, { prompt: QUESTION, session_id: 's-new' }, b.root));
    assert.ok(after.includes('ESSENTIAL_ACTION_STOP_BEFORE_DEPLOYMENT'), after);
    assert.ok(after.includes(b.learning.id), after);
    assert.match(after, /Recalled automatically from memory/);
  } finally { teardown(b.root); teardown(old.dir); }
});

test('ROT + control: mem-catch-fail (exit 0, red output) shows the content and the ID too', (t) => {
  const old = oldHook('mem-catch-fail');
  if (!old) { t.skip('start commit not in this clone - unknown, not green'); return; }
  const b = build();
  const input = { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'amberquartz deploy' },
    tool_response: { stdout: 'not ok 2 - amberquartz deployment\n# tests 2\n# pass 1\n# fail 1', stderr: '' } };
  try {
    const before = ctx(run(old.script, input, b.root, { MEM_CATCH_FAIL_TURNS: path.join(b.root, 'cf-old') }));
    assert.ok(before.includes('amberquartz'), 'fixture must be found: ' + before);
    assert.ok(!before.includes('ESSENTIAL_ACTION'), 'RED: start commit drops the content');
    const after = ctx(run(path.join(CODE, 'bin', 'mem-catch-fail'), input, b.root, { MEM_CATCH_FAIL_TURNS: path.join(b.root, 'cf-new') }));
    assert.ok(after.includes('ESSENTIAL_ACTION_STOP_BEFORE_DEPLOYMENT'), after);
    assert.ok(after.includes(b.learning.id), after);
  } finally { teardown(b.root); teardown(old.dir); }
});

test('after-failure (src/afterfailure.mjs) uses the same renderer: content and ID', async () => {
  const { pick } = await import('../src/afterfailure.mjs');
  const hits = JSON.stringify({ hits: [{ score: 9, source: 'x/learnings.jsonl', line: 4,
    entry: { id: 'af1234567890', ts: '2026-09-30', title: 'T', learning: 'AF_CONTENT' } }] });
  const p = pick(hits);
  assert.equal(p.lines.length, 1);
  assert.match(p.lines[0], /AF_CONTENT/);
  assert.match(p.lines[0], /af1234567890/);
});

test('positive control: a normal prompt still finds the same entry as before (same hit set)', () => {
  const b = build();
  try {
    const out = ctx(run(NEW_RETRIEVE, { prompt: QUESTION, session_id: 's-ctl' }, b.root));
    const lines = out.split('\n').filter((l) => /^\s+\d{4}-\d\d-\d\d\s/.test(l));
    assert.equal(lines.length, 1, out);
    assert.ok(lines[0].includes('amberquartz'));
  } finally { teardown(b.root); }
});

// ---- 2. short prompts ------------------------------------------------

test('signal: confirmations never search, shapes do, ordinary short words do not', async () => {
  for (const c of ['yep', 'ok', 'yes', 'go on', 'that fits', 'thanks!', 'do it']) {
    assert.equal(isConfirmation(c), true, c);
    assert.equal((await judge(c)).search, false, c);
  }
  assert.equal(shapeSignal('ENOENT'), 'error-code');
  assert.equal(shapeSignal('hook.mjs'), 'file');
  assert.equal(shapeSignal('2xm5u7zdo9'), 'id');
  assert.equal(shapeSignal('deployment'), null);
  assert.equal((await judge('a long enough prompt')).why, 'long');
  assert.equal((await judge('deploy it')).search, false, 'ordinary short words stay no-signal');
});

test('ROT + control: an unambiguous 11-character term is searched (start commit: 0 byte, no journal line)', (t) => {
  const old = oldHook('mem-retrieve');
  if (!old) { t.skip('start commit not in this clone - unknown, not green'); return; }
  const b = build();
  try {
    const before = run(old.script, { prompt: 'amberquartz', session_id: 's2-old' }, b.root);
    assert.equal(before.stdout, '', 'RED: the start commit ends before the search');
    assert.equal(injection.read(b.root).lines.filter((l) => l.session === 's2-old').length, 0, 'RED: no journal line either');
    const after = run(NEW_RETRIEVE, { prompt: 'amberquartz', session_id: 's2-new' }, b.root);
    assert.match(ctx(after), /ESSENTIAL_ACTION_STOP_BEFORE_DEPLOYMENT/);
  } finally { teardown(b.root); teardown(old.dir); }
});

test('short prompts: a confirmation and a common short word are booked as no-signal, not searched', () => {
  const b = build();
  try {
    for (const p of ['yes', 'go on', 'filler']) {
      const r = run(NEW_RETRIEVE, { prompt: p, session_id: `s-${p.replace(/\W/g, '')}` }, b.root);
      assert.equal(r.stdout, '', p);
    }
    const l = injection.read(b.root).lines;
    assert.equal(l.length, 3, JSON.stringify(l));
    assert.ok(l.every((x) => x.reason === 'no-signal' && x.occasion === 'question'), JSON.stringify(l));
    // "filler" stands in every filler entry: not rare, no signal.
  } finally { teardown(b.root); }
});

test('short prompts: a file name, an error code and an entry ID are searched', () => {
  const b = build();
  try {
    memory.logEntry(b.root, 'error', { title: 'ENOENT on hook.mjs load', text: 'the loader raised ENOENT for hook.mjs' , class: 'io' }, { project: null });
    for (const [p, s] of [['hook.mjs', 'sf'], ['ENOENT', 'sc'], [b.learning.id, 'si']]) {
      const r = run(NEW_RETRIEVE, { prompt: p, session_id: s }, b.root, { MEM_RETRIEVE_MIN: '0.1' });
      assert.notEqual(r.stdout, '', `${p}: not searched`);
    }
  } finally { teardown(b.root); }
});

// ---- 4. the journal follows the output ------------------------------

test('ROT + control: two registrations of one turn book ONE delivery and one already-shown (start commit: two deliveries, one output)', (t) => {
  const old = oldHook('mem-retrieve');
  if (!old) { t.skip('start commit not in this clone - unknown, not green'); return; }
  const b = build();
  try {
    const one = run(old.script, { prompt: QUESTION, session_id: 's3-old' }, b.root);
    const two = run(old.script, { prompt: QUESTION, session_id: 's3-old' }, b.root);
    assert.notEqual(one.stdout, '');
    assert.equal(two.stdout, '', 'second registration is silent');
    const oldLines = injection.read(b.root).lines.filter((l) => l.session === 's3-old');
    assert.equal(oldLines.filter((l) => l.reason === null).length, 2, 'RED: two deliveries booked, one output');

    const a = run(NEW_RETRIEVE, { prompt: QUESTION, session_id: 's3-new' }, b.root);
    const c = run(NEW_RETRIEVE, { prompt: QUESTION, session_id: 's3-new' }, b.root);
    assert.notEqual(a.stdout, '');
    assert.equal(c.stdout, '');
    const nl = injection.read(b.root).lines.filter((l) => l.session === 's3-new');
    assert.equal(nl.filter((l) => l.reason === null).length, 1, JSON.stringify(nl));
    assert.equal(nl.filter((l) => l.reason === 'already-shown').length, 1, JSON.stringify(nl));
    const delivered = nl.find((l) => l.reason === null);
    assert.equal(delivered.bytes, Buffer.byteLength(a.stdout, 'utf8'), 'bytes = what really went out');
    assert.equal(delivered.hits, 1);
    assert.ok(delivered.sources.length === 1 && /learnings\.jsonl/.test(delivered.sources[0]));
  } finally { teardown(b.root); teardown(old.dir); }
});

test('misses are still booked: below the bar -> too-weak, nothing -> empty', () => {
  const b = build();
  try {
    run(NEW_RETRIEVE, { prompt: 'zzzunknownterm qqqunknownword nothing here', session_id: 'sm' }, b.root);
    const l = injection.read(b.root).lines.filter((x) => x.session === 'sm');
    assert.equal(l.length, 1, JSON.stringify(l));
    assert.ok(['empty', 'too-weak'].includes(l[0].reason), l[0].reason);
    assert.equal(l[0].question_bytes, Buffer.byteLength('zzzunknownterm qqqunknownword nothing here'));
  } finally { teardown(b.root); }
});

// ---- 5. start hook ---------------------------------------------------

test('start hook: without bin/mem it says NOT attached and UNKNOWN; with it, attached (ROT: start commit says attached)', (t) => {
  let oldSrc;
  try { oldSrc = execFileSync('git', ['show', `${START}:install/hooks/session-start.sh`], { encoding: 'utf8', stdio: 'pipe' }); }
  catch { t.skip('start commit not in this clone - unknown, not green'); return; }
  const home = tmp('cm-z1c-home-');
  const mem = path.join(home, 'mem');
  fs.mkdirSync(path.join(mem, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(mem, '.mem', 'config.json'), '{}');
  const oldPath = path.join(home, 'old-start.sh');
  fs.writeFileSync(oldPath, oldSrc);
  const go = (script) => spawnSync('bash', [script], { input: '{"session_id":"s"}', encoding: 'utf8', timeout: 30000,
    env: { PATH: process.env.PATH, HOME: home, CHEAP_MEM_ROOT: mem, MEM_HOOK_OFF: '' } });
  try {
    const before = go(oldPath).stdout;
    assert.match(before, /=== cheap-mem attached ===/, 'RED: start commit claims attached without the tool');
    const after = go(path.join(CODE, 'install', 'hooks', 'session-start.sh')).stdout;
    assert.doesNotMatch(after, /cheap-mem attached/);
    assert.match(after, /NOT attached/);
    assert.match(after, /UNKNOWN/);
    // positive control: with the tool present it is attached again
    fs.mkdirSync(path.join(mem, 'bin'));
    fs.writeFileSync(path.join(mem, 'bin', 'mem'), '#!/usr/bin/env node\n');
    assert.match(go(path.join(CODE, 'install', 'hooks', 'session-start.sh')).stdout, /=== cheap-mem attached ===/);
  } finally { teardown(home); }
});

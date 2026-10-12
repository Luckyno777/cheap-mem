// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Fable security run 2026-10-11, ported from lucky-mem (error 5katltp7cfkr): a log line whose text field is an OBJECT
// (`tags: {toString: "x"}`, `owner: {a: 1}`) or whose `ts` is a number crashed every reader that concatenates, compares
// or lower-cases the field - `mem find`, `mem context`, `mem duties`, `mem viewer`, the recall hook (silently: no recall
// for anybody), `mem doctor` and the dashboard server (an uncaught throw in /entries.json ended the process).
// The bridge already refuses such values when writing (`bridgefields.logFieldShape`); this is the READ side: a line
// written raw, by an old CLI or by a merge never meets that gate. The readers report it as BROKEN (three states) and the
// doctor names it; nothing is deleted (append-only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import { shapeProblem } from '../src/fieldshape.mjs';
import * as integrity from '../src/integrity.mjs';
import * as drawermemo from '../src/drawermemo.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(ROOT, 'bin', 'mem');
const SERVE = path.join(ROOT, 'bin', 'mem-serve');
const RETRIEVE = path.join(ROOT, 'bin', 'mem-retrieve');

/** The poisoned lines: each is a raw JSONL line, as a hand edit, a merge or an old CLI would leave it. */
const POISON = [
  { id: '9poison0001', ts: '2026-10-11T22:30:00Z', title: 'alpha poison tags', text: 'alpha', tags: { toString: 'x' }, agent: 'x', authority: 'agent' },
  { id: '9poison0002', ts: '2026-10-11T22:30:01Z', title: 'alpha poison owner', text: 'alpha', owner: { a: 1 }, agent: { a: 1 }, authority: 'agent' },
  { id: '9poison0003', ts: 12345, title: 'alpha poison ts', text: 'alpha', agent: 'x', authority: 'agent' },
  { id: '9poison0004', ts: '2026-10-11T22:30:03Z', title: { toString: 'x' }, text: ['alpha'], agent: 'x', authority: 'agent' },
  { id: { a: 1 }, ts: '2026-10-11T22:30:04Z', title: 'alpha id object', text: 'alpha', agent: 'x', authority: 'agent' },
  // fields the first cut of the list missed, found by fuzzing every name the readers touch:
  { id: '9poison0006', ts: '2026-10-11T22:30:05Z', title: 'alpha subject', text: 'alpha', subject: { toString: 'x' }, agent: 'x', authority: 'agent' },
  { id: '9poison0007', ts: '2026-10-11T22:30:06Z', title: 'alpha project', text: 'alpha', project: { toString: 'x' }, agent: 'x', authority: 'agent' },
  { id: '9poison0008', ts: '2026-10-11T22:30:07Z', title: 'alpha reader field', text: 'alpha', _type: { toString: 'x' }, agent: 'x', authority: 'agent' },
  { id: '9poison0009', ts: '2026-10-11T22:30:08Z', title: 'alpha link end', text: 'alpha', source: { toString: 'x' }, target: ['q'], agent: 'x', authority: 'agent' },
  { id: '9poison0010', ts: '2026-10-11T22:30:09Z', title: 'alpha closes', text: 'alpha', closes_id: { toString: 'x' }, replaces_id: { a: 1 }, retires_id: ['z'], agent: 'x', authority: 'agent' },
];
const DRAWERS = ['thoughts', 'decisions', 'errors', 'duties', 'events', 'timeline', 'learnings'];

function world(t) {
  const root = tempDir('cm-poison-', t);
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root, '--participants', 'lucky,session', '--human', 'lucky'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  // Healthy entries first (the positive control: they must still be found AFTER the poison is in).
  memory.logEntry(root, 'thought', { title: 'Normal alpha', text: 'findable alpha content', tags: ['a'], agent: 'lucky' });
  memory.logEntry(root, 'duty', { title: 'A duty alpha', text: 'x', owner: 'lucky', agent: 'lucky' });
  memory.logEntry(root, 'decision', { topic: 'alpha', choice: 'c', why: 'w', agent: 'lucky' });
  return root;
}
function poison(root) {
  for (const d of DRAWERS) {
    for (const p of POISON) fs.appendFileSync(path.join(root, 'global', `${d}.jsonl`), `${JSON.stringify(p)}\n`);
  }
}
const cli = (root, ...args) => spawnSync(process.execPath, [MEM, '--root', root, ...args], {
  encoding: 'utf8', env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root }, timeout: 120000,
});
const CRASH = /Cannot convert object to primitive value|is not a function|TypeError|Cannot read properties/;

test('the shape rule: what is broken and what stays readable', () => {
  // broken: an object or a list in a text field, a non-list in a list field, a number as ts or id, an object in a reader's field
  for (const bad of [
    { tags: { toString: 'x' } }, { tags: [{ a: 1 }] }, { title: true }, { key: 5 }, { owner: { a: 1 } }, { title: ['a'] }, { ts: 12345 }, { id: 7 },
    { id: { a: 1 } }, { _type: { a: 1 } }, { subject: { a: 1 } }, { project: ['p'] },
  ]) assert.ok(shapeProblem(bad), `should be broken: ${JSON.stringify(bad)}`);
  // legitimate (legacy) forms stay readable
  for (const ok of [
    { tags: 'solo' }, { tags: ['a', 'b'] }, { asked: 'one phrase' }, { tags: true }, { files: 5 }, { value: 5000 }, { value: false }, { key: 'k' },
    { origin: { derived_from: ['abc'] } }, { provenance: { inferred_from: ['x'] } }, { guard: { kind: 'test', path: 'a' } },
    { chain_seal: { writer: 'w', hash: 'h' } }, { error_ids: ['a', 'b'] }, { steps: ['one', 'two'] }, { tags: null }, { owner: undefined },
    { _source: 'global/x.jsonl', _line: 4 }, {},
    // lists the CLI really writes (found by writing every type through it): `--rejected a,b`, a workflow's match lists, a procedure's classes
    { rejected: ['mysql', 'sqlite'] }, { rejected: 'mysql' }, { triggers: ['deploy'], path_patterns: ['bin/mem'], tool_patterns: ['npm publish'], tools: ['git'] },
    { on_class: 'a,b' }, { on_class: ['a', 'b'] }, { references: { procedure: ['p1'] }, on_instruction: true },
  ]) assert.equal(shapeProblem(ok), null, `should stay readable: ${JSON.stringify(ok)}`);
  assert.equal(shapeProblem(null), null);
  assert.equal(shapeProblem([1]), null);
});

test('positive control: what the CLI itself writes for every kind of entry is NOT broken', (t) => {
  const root = world(t);
  const run = (...args) => {
    const r = cli(root, ...args);
    assert.equal(r.status, 0, `mem ${args.join(' ')}: ${r.stderr}`);
  };
  run('log', 'decision', '--topic', 'db', '--choice', 'pg', '--why', 'speed', '--tags', 'a,b', '--asked', 'which db', '--rejected', 'mysql,sqlite');
  run('log', 'error', '--title', 'boom', '--text', 't', '--class', 'looks-right-does-nothing', '--file', 'src/a.mjs');
  run('log', 'timeline', '--key', 'db.engine', '--value', 'postgres', '--text', 'x', '--valid-from', '2026-01-01');
  run('log', 'thought', '--title', 't', '--text', 't', '--symbols', 'foo,bar');
  run('log', 'procedure', '--title', 'p', '--rule', 'always', '--on-class', 'looks-right-does-nothing,assumed-not-measured', '--issued-by', 'owner', '--triggers', 'deploy,publish');
  run('workflow', 'new', '--title', 'wf', '--steps', 'a;b', '--issued-by', 'owner', '--triggers', 'x,y', '--path-patterns', 'a,b', '--tool-patterns', 'npm publish', '--tools', 'git');
  run('snippet', 'new', '--title', 'sn', '--body', 'hello {{NAME}}', '--placeholders', 'NAME,AGE', '--kind', 'text', '--language', 'en');
  run('log', 'question', '--question', 'why?');
  run('log', 'duty', '--title', 'd', '--text', 't', '--owner', 'lucky');
  const scan = integrity.scanIntegrity(root);
  assert.deepEqual(scan.broken, [], 'a form the CLI writes was reported as broken');
  assert.ok(scan.entries >= 11);
});

test('parseLine: unreadable and wrongly shaped are BROKEN (never swallowed, never healthy); a healthy line passes untouched', () => {
  const bad = memory.parseLine('{"id":"a1b2","ts":"2026-10-11T22:30:00Z","tags":{"toString":"x"}}');
  assert.equal(bad.__broken, true);
  assert.match(bad.reason, /'tags' is an object/);
  assert.ok(bad.raw.includes('toString'));
  const notJson = memory.parseLine('{"id":');
  assert.equal(notJson.__broken, true);
  assert.equal(notJson.reason, undefined);
  const good = memory.parseLine('{"id":"a1b2","ts":"2026-10-11T22:30:00Z","tags":["x"]}');
  assert.equal(good.__broken, undefined);
  assert.deepEqual(good.tags, ['x']);
});

test('every reader survives the poisoned lines and still answers from the healthy ones', (t) => {
  const root = world(t);
  poison(root);
  const find = cli(root, 'find', 'alpha', '--fresh');
  assert.equal(find.status, 0, find.stderr);
  assert.match(find.stdout, /Normal alpha/, 'the healthy entry is still found');
  for (const args of [
    ['find', 'alpha'], ['find', 'alpha', '--literal'], ['find', 'alpha', '--brief'], ['context'], ['duties'], ['duties', '--all'],
    ['facts'], ['facts', '--conflicts'], ['core'], ['topics'], ['experiences', '--all'], ['retrieve', 'alpha content', '--json'],
    ['explain', 'alpha', 'zzzz'], ['epoch', 'show'], ['sources', 'list'], ['net', '--json'], ['today'], ['links', '9poison0001'],
  ]) {
    const r = cli(root, ...args);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, CRASH, `mem ${args.join(' ')} crashed: ${r.stderr}`);
  }
  const ctx = cli(root, 'context');
  assert.match(ctx.stdout, /alpha/);
  const duties = cli(root, 'duties');
  assert.match(duties.stdout, /A duty alpha/, 'the healthy duty is still open');
  const viewer = cli(root, 'viewer', '--out', path.join(root, 'v.html'));
  assert.equal(viewer.status, 0, viewer.stderr);
});

test('the doctor names the malformed lines, with the field, and counts them out of the healthy ones', (t) => {
  const root = world(t);
  poison(root);
  const total = DRAWERS.length * POISON.length;
  const scan = integrity.scanIntegrity(root);
  assert.equal(scan.broken.length, total, 'every poisoned line is reported, none swallowed');
  assert.match(scan.broken[0].why, /field '.*' is (an object|a list|number)/);
  assert.equal(scan.entries, 3, 'only the healthy entries count as entries');
  const doc = cli(root, 'doctor');
  assert.doesNotMatch(`${doc.stdout}\n${doc.stderr}`, /check aborted|unreadable: .*(convert|function)/);
  assert.match(doc.stdout, /FAIL\s+drawers\s+\d+ unparsable lines/);
  assert.match(doc.stdout, /FAIL\s+integrity/);
  // append-only: nothing was removed
  const lines = fs.readFileSync(path.join(root, 'global', 'thoughts.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1 + POISON.length);
});

test('the same inside a doctor run (the drawer memo marks the line broken and says why)', (t) => {
  const root = world(t);
  poison(root);
  const abs = path.join(root, 'global', 'thoughts.jsonl');
  drawermemo.runWithMemo({ maxBytes: 1 << 24 }, () => {
    const rows = drawermemo.rowsOf(abs);
    const broken = drawermemo.entriesOf(rows).filter((e) => e.__broken);
    assert.equal(broken.length, POISON.length);
    assert.ok(broken.every((e) => typeof e.reason === 'string' && e.reason.length > 0));
    assert.equal(rows.vals.filter((v) => v === drawermemo.NOT_JSON).length, POISON.length);
  });
});

test('the recall hook still recalls (it used to fail silently for everybody)', (t) => {
  const root = world(t);
  poison(root);
  const r = spawnSync('bash', [RETRIEVE], {
    input: JSON.stringify({ prompt: 'findable alpha content', hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: root }),
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RECALL_SERVER: '0', MEM_RETRIEVE_NO_PULL: '1', MEM_RETRIEVE_MIN: '0.1' },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Normal alpha/, `the healthy entry was recalled: ${r.stdout}`);
});

test('the dashboard server stays up, answers 200, and says honestly that a poisoned id cannot be read', async (t) => {
  const root = world(t);
  poison(root);
  const cfgFile = path.join(root, '.mem', 'config.json');
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const TOKEN = ['probe', 'poison', String(process.pid)].join('-');
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: TOKEN, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off',
  }, {});
  t.after(() => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }));
  assert.ok(fs.existsSync(cfgFile));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (route) => {
    const res = await fetch(base + route, { headers: { authorization: `Bearer ${TOKEN}` } });
    return { status: res.status, text: await res.text() };
  };
  const good = memory.readLog(root, 'thought').entries.find((e) => e.title === 'Normal alpha');
  for (const route of ['/', '/dashboard.json', '/entries.json', '/entries', '/desk.json', '/console.json', '/dashboard/part.json?part=entries']) {
    const r = await get(route);
    assert.equal(r.status, 200, `${route} -> ${r.status} ${r.text.slice(0, 120)}`);
    assert.doesNotMatch(r.text, CRASH, route);
  }
  const one = await get(`/entry.json?id=${good.id}`);
  assert.equal(one.status, 200, 'a healthy entry is shown whole');
  const poisoned = await get('/entry.json?id=9poison0001');
  assert.notEqual(poisoned.status, 200, 'a poisoned id is never shown as healthy');
  assert.doesNotMatch(poisoned.text, CRASH);
  // the process is still alive afterwards
  assert.equal((await get('/health')).status, 200);
});

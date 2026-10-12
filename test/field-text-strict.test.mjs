// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Review of the port of the Fable run (2026-10-12), blockers 2 and 3 and the nesting bomb.
//
// 2. A NUMBER or a BOOLEAN in key / text / why / valid_from crashed `context`, `core`, `facts`, `viewer`, `today`,
//    /desk.json and /dashboard.json ("localeCompare / slice is not a function") and `mem doctor` stayed ok. The CLI writes
//    `"key": true` itself when `--key` has no value. A text field is text now (strict, like id and ts): such a line is
//    BROKEN and the doctor sees it. The readers that sort or slice coerce with String() as a second line of defence, and
//    `fieldsFrom` refuses a value-less flag for every field that is not a real switch.
// 3. The regression: `--tags` / `--asked` / `--rejected` / `--symbols` / `--files` WITHOUT a value wrote `true`, and the
//    first cut of fieldshape then made the entry vanish from every read. The write side refuses it with a clear message
//    (nothing written); an OLD line that already carries `tags: true` stays readable (read as an empty list) and the
//    doctor WARNS about it instead of calling it broken.
// 4. An `origin` nested 40,000 deep made find, viewer and doctor overflow the stack. A line nested deeper than 32 levels is
//    broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as integrity from '../src/integrity.mjs';
import { shapeProblem } from '../src/fieldshape.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(ROOT, 'bin', 'mem');
const SERVE = path.join(ROOT, 'bin', 'mem-serve');
const DOOR = ['probe', 'strict', String(process.pid)].join('-');
const CRASH = /Cannot convert object to primitive value|is not a function|TypeError|Cannot read properties|Maximum call stack|RangeError/;

function world(t) {
  const root = tempDir('cm-strict-', t);
  const init = spawnSync(process.execPath, [MEM, '--root', root, 'init', '--participants', 'lucky,session', '--human', 'lucky'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  memory.logEntry(root, 'thought', { title: 'Normal alpha', text: 'findable alpha content', tags: ['a'], agent: 'lucky' });
  memory.logEntry(root, 'timeline', { key: 'db.engine', value: 'postgres', text: 'engine', valid_from: '2026-01-01', agent: 'lucky' });
  memory.logEntry(root, 'decision', { topic: 'alpha', choice: 'c', why: 'because', agent: 'lucky' });
  return root;
}
const append = (root, file, o) => fs.appendFileSync(path.join(root, 'global', file), `${JSON.stringify({ ts: '2026-10-11T22:30:00Z', v: 1, agent: 'x', authority: 'agent', ...o })}\n`);
const cli = (root, ...args) => spawnSync(process.execPath, [MEM, '--root', root, ...args], {
  encoding: 'utf8', env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root }, timeout: 120000,
});
const READERS = [['context'], ['core'], ['facts'], ['facts', '--conflicts'], ['find', 'alpha'], ['find', 'alpha', '--literal'], ['duties', '--all'],
  ['topics'], ['today', '--json'], ['retrieve', 'alpha', '--json'], ['experiences', '--all']];

const NUMBERS_AND_BOOLEANS = [5, true, 0, false];
const STRICT_FIELDS = ['key', 'text', 'why', 'valid_from', 'title', 'topic', 'choice', 'owner', 'class', 'subject', 'project'];

test('the shape rule: a text field is text; a number or a boolean there is wrong', () => {
  for (const f of STRICT_FIELDS) {
    for (const v of NUMBERS_AND_BOOLEANS) assert.ok(shapeProblem({ [f]: v }), `${f}=${v} must be broken`);
    assert.equal(shapeProblem({ [f]: 'text' }), null, `${f}: text stays readable`);
  }
  // the few scalars that are not prose stay as they are
  for (const f of ['value', 'version', 'test', 'on_instruction']) for (const v of [5, true, 'x']) assert.equal(shapeProblem({ [f]: v }), null, `${f}=${v}`);
});

test('a number or a boolean in key / text / why / valid_from does not crash any reader; the doctor names the line', (t) => {
  const root = world(t);
  let i = 0;
  for (const f of ['key', 'text', 'why', 'valid_from']) {
    for (const v of [5, true]) {
      i += 1;
      append(root, 'timeline.jsonl', { id: `9strict${String(i).padStart(3, '0')}`, title: `alpha strict ${f}`, key: 'db.engine', value: 'x', text: 'alpha', [f]: v });
      append(root, 'thoughts.jsonl', { id: `9strict1${String(i).padStart(2, '0')}`, title: `alpha strict ${f}`, text: 'alpha', [f]: v });
    }
  }
  for (const args of READERS) {
    const r = cli(root, ...args);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, CRASH, `mem ${args.join(' ')}: ${r.stderr}`);
  }
  assert.match(cli(root, 'find', 'alpha').stdout, /Normal alpha/, 'the healthy entry is still found');
  assert.equal(cli(root, 'viewer', '--out', path.join(root, 'v.html')).status, 0);
  const doc = cli(root, 'doctor');
  assert.match(doc.stdout, /FAIL\s+drawers\s+\d+ unparsable lines/);
  assert.equal(integrity.scanIntegrity(root).broken.length, i * 2);
});

test('the dashboard answers with such lines in the drawers: /desk.json and /dashboard.json are 200', async (t) => {
  const root = world(t);
  append(root, 'timeline.jsonl', { id: '9strict900', key: true, value: 'x', text: 'alpha' });
  append(root, 'timeline.jsonl', { id: '9strict901', key: 'db.engine', value: 'x', valid_from: 5 });
  append(root, 'thoughts.jsonl', { id: '9strict902', title: 'alpha', text: 5, why: true });
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off' }, {});
  t.after(() => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/desk.json', '/dashboard.json', '/entries.json', '/console.json']) {
    const res = await fetch(base + route, { headers: { authorization: `Bearer ${DOOR}` } });
    const text = await res.text();
    assert.equal(res.status, 200, `${route}: ${text.slice(0, 160)}`);
    assert.doesNotMatch(text, CRASH, route);
  }
});

test('a value-less flag is refused for every field that is not a switch: nothing is written, the message names the flag', (t) => {
  const root = world(t);
  const before = fs.readFileSync(path.join(root, 'global', 'thoughts.jsonl'), 'utf8');
  for (const flag of ['tags', 'asked', 'rejected', 'symbols', 'files', 'key', 'owner', 'class', 'valid-from', 'topic']) {
    const r = cli(root, 'log', 'thought', '--title', 't', '--text', 'x', `--${flag}`);
    assert.notEqual(r.status, 0, `--${flag} without a value was accepted: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(`--${flag}`), r.stderr);
    assert.match(r.stderr, /without a value|nothing (was )?written/i);
  }
  const k = cli(root, 'log', 'timeline', '--key', '--value', 'v', '--text', 'x');
  assert.notEqual(k.status, 0, 'a swallowed --key value');
  assert.equal(fs.readFileSync(path.join(root, 'global', 'thoughts.jsonl'), 'utf8'), before, 'nothing was written');
  // correction goes through the same rule
  const id = memory.readLog(root, 'thought').entries[0].id;
  const c = cli(root, 'correction', 'thought', id, '--tags');
  assert.notEqual(c.status, 0);
});

test('positive control: the real switches still work, and every list/text form is written through the real CLI and stays readable', (t) => {
  const root = world(t);
  const run = (...args) => { const r = cli(root, ...args); assert.equal(r.status, 0, `mem ${args.join(' ')}: ${r.stderr}`); };
  run('log', 'thought', '--title', 'shredded alpha', '--text', 'a body', '--shred');
  run('log', 'error', '--title', 'e', '--text', 't', '--class', 'looks-right-does-nothing', '--file', 'src/a.mjs', '--without-scaffold');
  run('log', 'decision', '--topic', 'db', '--choice', 'pg', '--why', 'speed', '--tags', 'a,b', '--asked', 'which db', '--rejected', 'mysql;sqlite');
  run('log', 'thought', '--title', 't', '--text', 't', '--symbols', 'foo,bar', '--files', 'src/a.mjs,src/b.mjs', '--tags', 'x');
  run('log', 'timeline', '--key', 'k.v', '--value', '5', '--text', 'x', '--valid-from', '2026-01-01');
  run('log', 'learning', '--title', 'l', '--learning', 'do x', '--text', 'y');
  assert.deepEqual(integrity.scanIntegrity(root).broken, [], 'a form the CLI writes was reported as broken');
});

test('an OLD line with a list field that is true or a number stays readable (as an empty list) and the doctor WARNS', (t) => {
  const root = world(t);
  append(root, 'thoughts.jsonl', { id: '9legacy001', title: 'alpha legacy tags', text: 'alpha legacy', tags: true });
  append(root, 'thoughts.jsonl', { id: '9legacy002', title: 'alpha legacy files', text: 'alpha legacy', files: 5, asked: false });
  assert.equal(shapeProblem({ tags: true, files: 5, asked: false, rejected: 0 }), null, 'a list flag without a value is no shape error');
  assert.ok(shapeProblem({ tags: { a: 1 } }) && shapeProblem({ tags: [{ a: 1 }] }), 'an object is still wrong');
  const e = memory.readLog(root, 'thought').entries.find((x) => x.id === '9legacy001');
  assert.ok(e && !e.__broken, 'the entry is read, not broken');
  assert.deepEqual(e.tags, [], 'read as an empty list');
  const find = cli(root, 'find', 'legacy');
  assert.equal(find.status, 0, find.stderr);
  assert.match(find.stdout, /alpha legacy tags/);
  assert.match(find.stdout, /alpha legacy files/);
  for (const args of READERS) assert.doesNotMatch(cli(root, ...args).stderr, CRASH, args.join(' '));
  const scan = integrity.scanIntegrity(root);
  assert.deepEqual(scan.broken, []);
  assert.deepEqual(scan.listWithoutValue.map((x) => `${x.id}:${[...x.fields].sort().join(",")}`).sort(), ['9legacy001:tags', '9legacy002:asked,files']);
  const doc = cli(root, 'doctor').stdout;
  assert.match(doc, /WARN\s+drawers\s+2 line\(s\) carry a list field without a list/);
  assert.doesNotMatch(doc, /FAIL\s+drawers/);
});

test('a line nested deeper than 32 levels is broken, nothing overflows the stack; a normal nesting stays', (t) => {
  const root = world(t);
  const deep = (n) => { let o = 'x'; for (let i = 0; i < n; i += 1) o = { o }; return o; };
  const bomb = `{"id":"9bomb0001","ts":"2026-10-11T22:30:00Z","v":1,"title":"alpha bomb","text":"alpha","origin":${'{"o":'.repeat(40000)}1${'}'.repeat(40000)},"agent":"x","authority":"agent"}\n`;
  fs.appendFileSync(path.join(root, 'global', 'thoughts.jsonl'), bomb);
  append(root, 'thoughts.jsonl', { id: '9okay00001', title: 'alpha fine origin', text: 'alpha', origin: { derived_from: ['abc'], note: { deeper: { still: 'fine' } } } });
  assert.ok(shapeProblem({ origin: deep(100) }), 'deeper than 32');
  assert.equal(shapeProblem({ origin: deep(10) }), null);
  assert.ok(memory.parseLine(bomb).__broken);
  for (const args of [['find', 'alpha'], ['find', 'alpha', '--fresh'], ['context'], ['duties'], ['facts'], ['viewer', '--out', path.join(root, 'v2.html')], ['doctor'], ['retrieve', 'alpha', '--json']]) {
    const r = cli(root, ...args);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, CRASH, `mem ${args.join(' ')}: ${r.stderr.slice(0, 200)}`);
  }
  assert.match(cli(root, 'find', 'alpha').stdout, /alpha fine origin/, 'the normally nested entry is found');
  assert.equal(integrity.scanIntegrity(root).broken.length, 1);
});

test('the bridge refuses what the readers would call broken: a number or a boolean in a text field', async () => {
  const bridgefields = await import('../src/bridgefields.mjs');
  for (const bad of [{ key: true }, { text: 5 }, { why: false }, { valid_from: 20260101 }, { title: 7 }]) {
    assert.throws(() => bridgefields.logFieldShape(bad), /\(a string\)/, JSON.stringify(bad));
  }
  for (const ok of [{ key: 'db.engine' }, { value: 5 }, { value: true }, { version: 2 }, { tags: ['a'] }, { owner: 'lucky' }]) {
    assert.doesNotThrow(() => bridgefields.logFieldShape(ok), JSON.stringify(ok));
  }
});

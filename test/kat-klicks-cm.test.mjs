// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/kat-klicks-cm.test.mjs — the category click actions (task kat-klicks-cm,
// 2026-10-03; parity with lucky-mem `kategorie-*`). One unit test per task kind
// (persons only, closed parameters, the CLI call, the verdict) and the CLI's
// `--json` answer of every write action. The browser side is in
// kat-klicks-cm-browser.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as tasks from '../src/tasks.mjs';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KINDS = ['category-assign', 'category-confirm', 'category-acknowledge', 'category-rename', 'category-merge', 'category-create'];

function world(t) {
  const root = tempDir('cm-kk-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'kk', participants: { alex: { human: true } }, language: 'en' }));
  return root;
}
const mem = (root, ...a) => {
  const env = { ...process.env, CHEAP_MEM_ROOT: root };
  delete env.MEM_HEADLESS;
  const r = spawnSync('node', [path.join(REPO, 'bin', 'mem'), ...a], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test('every category kind is a person-only kind with a closed parameter list', (t) => {
  const root = world(t);
  for (const k of KINDS) {
    assert.ok(tasks.KINDS[k], `${k} exists`);
    assert.equal(tasks.KINDS[k].humanOnly, true, `${k} persons only`);
  }
  assert.throws(() => tasks.start(root, 'category-acknowledge', { key: 'infra' }, { user: false }), (e) => e.code === 'NOT_A_PERSON');
  assert.throws(() => tasks.start(root, 'category-acknowledge', { key: 'infra', extra: 'x' }, { user: true }), (e) => e.code === 'INVALID_PARAMS');
  assert.throws(() => tasks.start(root, 'category-acknowledge', { key: '--all-proposals' }, { user: true }), (e) => e.code === 'INVALID_PARAMS', 'a dash is never a word start');
});

test('category-assign: topic and category, the CLI call', () => {
  const s = tasks.KINDS['category-assign'];
  assert.deepEqual(s.command('r', 'x', { topic: 'infra/deploys', category: 'infra' }).args, ['category', 'assign', 'infra/deploys', 'infra', '--json']);
  assert.throws(() => tasks.checkParams('category-assign', { topic: 'a' }), (e) => e.code === 'INVALID_PARAMS', 'category required');
  assert.equal(s.classify({ ok: true, text: 'x' }).state, 'ok');
  assert.equal(s.classify({}).state, 'warning', 'positive control: no ok = not ok');
});

test('category-confirm: one topic or all, never both, never none', () => {
  const s = tasks.KINDS['category-confirm'];
  assert.deepEqual(s.command('r', 'x', { topic: 't/a' }).args, ['category', 'confirm', 't/a', '--json']);
  assert.deepEqual(s.command('r', 'x', { all: 'yes' }).args, ['category', 'confirm', '--all-proposals', '--json']);
  assert.throws(() => s.precheck('r', {}), /either/);
  assert.throws(() => s.precheck('r', { topic: 'a', all: 'yes' }), /not both/);
  assert.doesNotThrow(() => s.precheck('r', { all: 'yes' }));
  assert.throws(() => tasks.checkParams('category-confirm', { all: 'maybe' }), (e) => e.code === 'INVALID_PARAMS');
});

test('category-acknowledge: the CLI call and the verdict', () => {
  const s = tasks.KINDS['category-acknowledge'];
  assert.deepEqual(s.command('r', 'x', { key: 'gardening' }).args, ['category', 'acknowledge', 'gardening', '--json']);
  assert.equal(s.classify({ ok: true }).state, 'ok');
  assert.equal(s.classify({ ok: false }).state, 'warning');
});

test('category-rename: a label of 2 to 40 characters, one line, no dash start', () => {
  const s = tasks.KINDS['category-rename'];
  assert.deepEqual(s.command('r', 'x', { key: 'infra', label: 'Infrastructure' }).args, ['category', 'rename', 'infra', 'Infrastructure', '--json']);
  for (const bad of ['x', 'a'.repeat(41), '-flag', 'two\nlines', ' padded']) {
    assert.throws(() => tasks.checkParams('category-rename', { key: 'infra', label: bad }), (e) => e.code === 'INVALID_PARAMS', `refused: ${JSON.stringify(bad)}`);
  }
  assert.equal(s.classify({ ok: true }).state, 'ok');
});

test('category-merge: two different keys, the alias is written with a reason', () => {
  const s = tasks.KINDS['category-merge'];
  assert.deepEqual(s.command('r', 'x', { source: 'a-cat', target: 'b-cat' }).args, ['category', 'merge', 'a-cat', 'b-cat', '--why=Dashboard', '--json']);
  assert.throws(() => s.precheck('r', { source: 'a', target: 'a' }), /itself/);
  assert.doesNotThrow(() => s.precheck('r', { source: 'a', target: 'b' }));
  assert.equal(s.classify({ ok: true }).state, 'ok');
  assert.throws(() => tasks.checkParams('category-merge', { from: 'a', to: 'b' }), (e) => e.code === 'INVALID_PARAMS', 'the route reserves `from`');
});

test('category-create: the key is the label in key form', () => {
  const s = tasks.KINDS['category-create'];
  assert.deepEqual(s.command('r', 'x', { label: 'AI & Agents' }).args, ['category', 'create', 'ai-agents', 'AI & Agents', '--json']);
  assert.throws(() => tasks.checkParams('category-create', { label: '!!' }), (e) => e.code === 'INVALID_PARAMS', 'no key can be made of it');
  assert.equal(s.classify({ ok: true }).state, 'ok');
});

test('the CLI answers every write action with --json {ok,text}, plain text unchanged without it', (t) => {
  const root = world(t);
  for (const [tp, n] of [['infra/a', 1], ['infra/b', 1], ['infra/c', 1]]) {
    assert.equal(mem(root, 'log', 'learning', `Entry ${tp}`, '--text', `Body ${tp} ${n}`, '--topic', tp, '--tags', 'x').code, 0);
  }
  const j = (...a) => { const r = mem(root, ...a); assert.equal(r.code, 0, r.err); assert.equal(r.err, '', 'no stderr'); return JSON.parse(r.out); };
  assert.equal(j('category', 'create', 'infra', 'Infrastructure', '--json').ok, true);
  assert.equal(j('category', 'create', 'design', 'Design', '--json').ok, true);
  assert.match(j('category', 'assign', 'infra/a', 'infra', '--json').text, /confirmed/);
  assert.match(j('category', 'rename', 'design', 'Visual design', '--json').text, /renamed/);
  assert.match(j('category', 'acknowledge', 'infra', '--json').text, /confirmed/);
  assert.match(j('category', 'merge', 'design', 'infra', '--json').text, /counts as/);
  assert.match(j('category', 'confirm', '--all-proposals', '--json').text, /0 proposals confirmed/);
  assert.match(mem(root, 'category', 'create', 'plain', 'Plain').out, /Category plain \(Plain\) created\./, 'plain output unchanged');
  const bad = mem(root, 'category', 'assign', 'infra/zzz', 'infra', '--json');
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /no topic 'infra\/zzz'/, 'the refusal names the reason on stderr');
});

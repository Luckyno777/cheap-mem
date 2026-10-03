// test/skill-scope-list.test.mjs - the scope of a skill and the files of an error are LISTS
// (port of lucky-mem `skill-geltung`, 2026-10-03).
//
// Reason: `--topics '["mcp","skill"]'` stayed one string; the reader tore it apart at the comma
// into `["mcp"` and `"skill"]`, so the skill's account counted 0 cases. The same family: a
// comma list of `--files` stayed a string and `errorfile.files()` (which reads an array) ignored it.
//
// Red proof: at a FIXED base commit the same command stores a string and the reader gets the
// fragments. Positive controls: a plain single value and a real list are read as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as experience from '../src/experience.mjs';
import * as errorfile from '../src/errorfile.mjs';
import * as skillregistry from '../src/skillregistry.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';

function world(t) {
  const root = tempDir('cm-scope-list-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  return root;
}
const run = (mem, root, argv) => spawnSync(process.execPath, [mem, ...argv, '--root', root], { encoding: 'utf8', input: '' });
const lastOf = (root, file) => JSON.parse(fs.readFileSync(path.join(root, 'global', file), 'utf8').trim().split('\n').pop());

test('RED PROOF: at the base commit the JSON list is stored as a string and the reader tears it apart', (t) => {
  const tmp = tempDir('cm-scope-list-base-', t);
  const tar = execFileSync('git', ['archive', BASE, 'bin', 'src', 'shared', 'package.json'], { cwd: REPO, maxBuffer: 1 << 28 });
  assert.equal(spawnSync('tar', ['-x', '-C', tmp], { input: tar }).status, 0);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
  const root = world(t);
  const r = run(path.join(tmp, 'bin', 'mem'), root, ['log', 'skill', '--title', 'A skill', '--text', 'x', '--topics', '["mcp","skill"]']);
  assert.equal(r.status, 0, r.stderr);
  const e = lastOf(root, 'skills.jsonl');
  assert.equal(typeof e.topics, 'string', 'the base already stored a list');
  assert.deepEqual(e.topics.split(','), ['["mcp"', '"skill"]'], 'the fragments the old reader got');
  // positive control: today's tree stores the list
  const root2 = world(t);
  assert.equal(run(MEM, root2, ['log', 'skill', '--title', 'A skill', '--text', 'x', '--topics', '["mcp","skill"]']).status, 0);
  assert.deepEqual(lastOf(root2, 'skills.jsonl').topics, ['mcp', 'skill']);
});

test('classes, files and topics are stored as lists, from JSON or from a comma list', (t) => {
  const root = world(t);
  const r = run(MEM, root, ['log', 'skill', '--title', 'A skill', '--text', 'x',
    '--classes', 'wrong-cause,mishandling', '--files', 'src/a.mjs, src/b.mjs', '--topics', '["mcp","skill"]']);
  assert.equal(r.status, 0, r.stderr);
  const e = lastOf(root, 'skills.jsonl');
  assert.deepEqual(e.classes, ['wrong-cause', 'mishandling']);
  assert.deepEqual(e.files, ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(e.topics, ['mcp', 'skill']);
  const bad = run(MEM, root, ['log', 'skill', '--title', 'B', '--text', 'x', '--topics', '[1,2]']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /list of strings/);
  const bent = run(MEM, root, ['log', 'skill', '--title', 'C', '--text', 'x', '--files', 'a.mjs,"b.mjs"']);
  assert.notEqual(bent.status, 0, 'a half-JSON comma list must be refused like for tags');
});

test('the same holds for `mem correction` (its fields run through the same function)', (t) => {
  const root = world(t);
  const a = memory.logEntry(root, 'skill', { title: 'A skill', text: 'x' }).entry;
  const r = run(MEM, root, ['correction', 'skill', a.id, '--topics', '["mcp","skill"]']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(lastOf(root, 'skills.jsonl').topics, ['mcp', 'skill']);
});

test('the reader: a list stored as JSON TEXT in old stock is a list; a plain value and a comma list are read as before', () => {
  assert.deepEqual(experience.scopeOf({ topics: '["mcp","skill"]' }).topics, ['mcp', 'skill']);
  assert.deepEqual(experience.scopeOf({ topics: ['mcp', 'skill'] }).topics, ['mcp', 'skill']);
  assert.deepEqual(experience.scopeOf({ topics: 'mcp,skill' }).topics, ['mcp', 'skill']);
  assert.deepEqual(experience.scopeOf({ topics: 'mcp' }).topics, ['mcp']);
  assert.deepEqual(experience.scopeOf({ topics: '[broken' }).topics, ['[broken'], 'text that is no JSON stays a comma list');
  assert.equal(experience.scopeOf({}).empty, true);
});

test('end to end: the account of a skill declared with --topics as JSON counts the error of that topic', (t) => {
  const root = world(t);
  assert.equal(run(MEM, root, ['log', 'skill', '--title', 'Mcp skill', '--text', 'x', '--topics', '["mcp","skill"]']).status, 0);
  const err = memory.logEntry(root, 'error', { class: 'wrong-cause', title: 'An mcp failure', text: 'it broke', topic: 'mcp' }).entry;
  const item = skillregistry.registry(root).find((i) => i.type === 'skill');
  const acc = experience.account(item, experience.stock(root));
  assert.equal(acc.withoutScope, false);
  assert.deepEqual(acc.traps.map((x) => x.id), [err.id]);
});

test('an error logged with --files is now read by errorfile.files (it ignored a comma string before)', (t) => {
  const root = world(t);
  assert.equal(run(MEM, root, ['log', 'error', '--title', 'Lock file breaks', '--text', 'it breaks', '--class', 'wrong-cause', '--files', 'src/zebra.mjs,src/other.mjs']).status, 0);
  const e = lastOf(root, 'errors.jsonl');
  assert.deepEqual(errorfile.files(e), ['src/zebra.mjs', 'src/other.mjs']);
});

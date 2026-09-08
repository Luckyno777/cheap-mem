// The command, not the library.
//
// **Why this file exists separately.** On 2026-09-08 the sibling
// project fixed a defect in the archive layer, left the same defect in
// the CLI one level up, and the library tests stayed green while the
// command was still wrong. A probe that exercises a different door from
// the one people walk through checks nothing.
//
// So these spawn `bin/mem`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-boardcli-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: { lucky: 'human' } }));
  return r;
}

function mem(r, ...argv) {
  return spawnSync(process.execPath, [MEM, ...argv, '--root', r],
    { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: r } });
}

test('mem board prints every tile', () => {
  const r = root();
  const res = mem(r, 'board');
  assert.equal(res.status, 0, res.stderr);
  for (const title of ['Raw archive', 'Digest', 'Error classes', 'Agents',
    'Open questions', 'Installation', 'MCP bridge']) {
    assert.ok(res.stdout.includes(title), `no tile: ${title}`);
  }
  assert.match(res.stdout, /unmeasured/);
});

test('mem board --json is parseable and keeps the unknown count', () => {
  const r = root();
  const res = mem(r, 'board', '--json');
  assert.equal(res.status, 0, res.stderr);
  const b = JSON.parse(res.stdout);
  assert.equal(b.tiles.length, 7);
  assert.ok(b.unknown > 0);
});

test('mem board --html is one self-contained page', () => {
  const r = root();
  const res = mem(r, 'board', '--html');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(res.stdout));
});

test('mem board rejects a flag it does not know', () => {
  // A typo that is silently ignored produces a board the caller did not
  // ask for and believes they did.
  const r = root();
  const res = mem(r, 'board', '--htlm');
  assert.notEqual(res.status, 0);
});

test('mem classes lists all twelve with their question', () => {
  const r = root();
  const res = mem(r, 'classes');
  assert.equal(res.status, 0, res.stderr);
  assert.equal((res.stdout.match(/^ +\? /gm) ?? []).length, 12);
  assert.match(res.stdout, /No error entries yet/);
});

test('mem log error warns on an unknown class but still writes it', () => {
  const r = root();
  const res = mem(r, 'log', 'error', '--title', 'x', '--class', 'a-name-nobody-defined');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /outside the vocabulary/);
  // The warning must not cost the entry: `mem log` is the path along
  // which things get saved that would otherwise be lost.
  const log = fs.readFileSync(path.join(r, 'global', 'errors.jsonl'), 'utf8');
  assert.match(log, /a-name-nobody-defined/);
});

test('mem log error names the class an old name maps to', () => {
  const r = root();
  const res = mem(r, 'log', 'error', '--title', 'x', '--class', 'silent-failure');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /old name for 'looks-right-does-nothing'/);
});

test('a valid class passes without a word', () => {
  const r = root();
  const res = mem(r, 'log', 'error', '--title', 'x', '--class', 'two-truths');
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!/vocabulary|old name/.test(res.stderr), res.stderr);
});

test('mem classes --open names what it could not map', () => {
  const r = root();
  mem(r, 'log', 'error', '--title', 'a', '--class', 'a-name-nobody-defined');
  mem(r, 'log', 'error', '--title', 'b', '--class', 'looks-right-does-nothing');
  const res = mem(r, 'classes', '--open');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /1x {2}a-name-nobody-defined/);
  assert.ok(!res.stdout.includes('looks-right-does-nothing'));
});

test('mem bridge report lands, and the board picks it up', () => {
  const r = root();
  const set = mem(r, 'bridge', 'report', 'deadbee');
  assert.equal(set.status, 0, set.stderr);
  const res = mem(r, 'board');
  assert.match(res.stdout, /serving version deadbee/);
  // And it is no longer unknown — which is the whole point of the
  // report existing at all.
  const b = JSON.parse(mem(r, 'board', '--json').stdout);
  assert.equal(b.tiles.find((t) => t.id === 'bridge').state, 'calm');
});

test('mem bridge report without a hash refuses', () => {
  const r = root();
  const res = mem(r, 'bridge', 'report');
  assert.notEqual(res.status, 0);
  assert.equal(fs.existsSync(path.join(r, '.mem', 'bridge-reports.jsonl')), false,
    'a half-set state was written anyway');
});

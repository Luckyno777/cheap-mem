// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Reading tolerates a UTF-8 BOM at the start of a drawer.
//
// A BOM made the FIRST line unparseable: the first entry was invisible to
// find, show, when and the viewer, and `mem doctor` called it a broken line.
// Red proof against a FIXED old commit (never a moving merge-base), with a
// positive control: the same entry without a BOM is found there.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** cheap-mem main before the BOM tolerance. */
const OLD_STATE = '24cd9a95195e4a0b969ea7621ffd430521835817';
const BOM = '﻿';
const TITLE = 'Bomtitle survivor';

const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const mem = (bin, root, args) => spawnSync(process.execPath, [bin, ...args], {
  encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: root },
});

/** A memory whose learnings, errors and duties drawers each start with a BOM (or not, for the control). */
function root(t, bin, { bom }) {
  const r = tmp(t, 'cm-bom-');
  assert.equal(mem(bin, r, ['init']).status, 0);
  const put = (file, e) => fs.writeFileSync(
    path.join(r, 'global', file),
    `${bom ? BOM : ''}${JSON.stringify({ id: `bom${file.slice(0, 4)}`, ts: new Date().toISOString(), v: 1, ...e })}\n`,
  );
  put('learnings.jsonl', { title: TITLE, text: 'bomword survivor' });
  put('duties.jsonl', { duty: 'bomword duty survivor', text: 'bomword duty survivor', title: TITLE });
  put('errors.jsonl', { title: TITLE, text: 'bomword survivor', class: 'measurement' });
  return r;
}

function surfaces(bin, r) {
  const viewerOut = path.join(r, 'v.html');
  mem(bin, r, ['viewer', '--out', viewerOut]);
  const seen = (args) => mem(bin, r, args).stdout.includes(TITLE);
  return {
    find: seen(['find', 'bomword']),
    show: seen(['show', 'bomlear']),
    when: seen(['when', 'today']),
    duties: seen(['duties']),
    context: seen(['context']),
    viewer: fs.existsSync(viewerOut) && fs.readFileSync(viewerOut, 'utf8').includes(TITLE),
    doctorBroken: /not JSON|unparse?able/i.test(mem(bin, r, ['doctor']).stdout),
  };
}

const BIN = path.join(REPO, 'bin', 'mem');

test('a BOM at the start of a drawer: every surface still sees the first entry, the doctor reports no broken line', (t) => {
  const s = surfaces(BIN, root(t, BIN, { bom: true }));
  assert.deepEqual(s, { find: true, show: true, when: true, duties: true, context: true, viewer: true, doctorBroken: false });
});

test('the disk is never changed by reading', (t) => {
  const r = root(t, BIN, { bom: true });
  const file = path.join(r, 'global', 'learnings.jsonl');
  const before = fs.readFileSync(file);
  surfaces(BIN, r);
  assert.ok(fs.readFileSync(file).equals(before), 'the BOM stays on disk, byte for byte');
});

test('withoutBom strips exactly one BOM and only at the front', () => {
  assert.equal(memory.withoutBom(`${BOM}abc`), 'abc');
  assert.equal(memory.withoutBom(`${BOM}${BOM}abc`), `${BOM}abc`);
  assert.equal(memory.withoutBom(`a${BOM}bc`), `a${BOM}bc`, 'a BOM in the middle stays damage');
  assert.equal(memory.withoutBom(''), '');
  assert.equal(memory.withoutBom(undefined), undefined);
});

test('the streaming reader strips a BOM that is cut at a block boundary (1, 2 and 3 bytes per block)', (t) => {
  const file = path.join(tmp(t, 'cm-bom-iter-'), 'x.jsonl');
  fs.writeFileSync(file, `${BOM}${JSON.stringify({ id: 'a', n: 1 })}\n${JSON.stringify({ id: 'b', n: 2 })}\n`);
  for (const chunkBytes of [1, 2, 3, 4, 64]) {
    const got = [...memory.iterLogFile(file, { chunkBytes })];
    assert.deepEqual(got.map((e) => e.id), ['a', 'b'], `chunkBytes ${chunkBytes}`);
    assert.ok(got.every((e) => !e.__broken));
  }
});

test('a BOM in the MIDDLE of a drawer is still a broken line (it is damage, not an encoding mark)', (t) => {
  const file = path.join(tmp(t, 'cm-bom-mid-'), 'x.jsonl');
  fs.writeFileSync(file, `${JSON.stringify({ id: 'a' })}\n${BOM}${JSON.stringify({ id: 'b' })}\n`);
  const got = [...memory.iterLogFile(file)];
  assert.equal(got.length, 2);
  assert.ok(!got[0].__broken);
  assert.ok(got[1].__broken);
});

test('RED: on the pinned old state the BOM entry is invisible and the doctor calls it broken; the control without a BOM is found there', (t) => {
  const old = tmp(t, 'cm-bom-old-');
  exportCommit(REPO, OLD_STATE, ['.'], old);
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules')); } catch { /* none needed */ }
  const oldBin = path.join(old, 'bin', 'mem');
  const control = surfaces(oldBin, root(t, oldBin, { bom: false }));
  assert.deepEqual(control, { find: true, show: true, when: true, duties: true, context: true, viewer: true, doctorBroken: false },
    'positive control: without a BOM every surface sees the entry on the old state');
  const red = surfaces(oldBin, root(t, oldBin, { bom: true }));
  assert.equal(red.find, false);
  assert.equal(red.show, false);
  assert.equal(red.when, false);
  assert.equal(red.duties, false);
  assert.equal(red.doctorBroken, true);
});

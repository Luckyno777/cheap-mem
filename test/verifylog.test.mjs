// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/verifylog.test.mjs — src/verifylog.mjs unit-level guarantees
// (the HTTP-level behaviour is covered by test/verify-verdict.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as verifylog from '../src/verifylog.mjs';

test('newId(): 12 base36 characters, no two calls collide across 1000 draws', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i += 1) {
    const id = verifylog.newId();
    assert.equal(id.length, 12);
    assert.match(id, /^[0-9a-z]{12}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 1000);
});

test('checkTargetOutsideRoot(): refuses a path inside the root, accepts one outside', () => {
  assert.throws(() => verifylog.checkTargetOutsideRoot('/a/b/mem/verdicts.jsonl', '/a/b/mem'));
  assert.throws(() => verifylog.checkTargetOutsideRoot('/a/b/mem', '/a/b/mem'), /outside/);
  assert.doesNotThrow(() => verifylog.checkTargetOutsideRoot('/a/other/verdicts.jsonl', '/a/b/mem'));
  // A sibling directory that only shares a PREFIX must not be treated as "inside".
  assert.doesNotThrow(() => verifylog.checkTargetOutsideRoot('/a/b/mem-backup/verdicts.jsonl', '/a/b/mem'));
});

test('checkRow(): a missing key or an unknown verdict word are both defects', () => {
  assert.deepEqual(verifylog.checkRow(verifylog.buildRow({ key: 'k', verdict: 'still-current' })), []);
  const noKey = verifylog.checkRow(verifylog.buildRow({ verdict: 'still-current' }));
  assert.ok(noKey.some((d) => /key/.test(d)));
  const badVerdict = verifylog.checkRow(verifylog.buildRow({ key: 'k', verdict: 'maybe' }));
  assert.ok(badVerdict.some((d) => /verdict/.test(d)));
});

test('append(): writes exactly one line, append() twice writes two, read() sees both', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verifylog-'));
  const target = path.join(dir, 'verdicts.jsonl');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verifylog-root-'));
  try {
    const a = verifylog.append(target, root, verifylog.buildRow({ key: 'k1', verdict: 'still-current' }));
    assert.equal(a.written, true);
    const b = verifylog.append(target, root, verifylog.buildRow({ key: 'k2', verdict: 'outdated' }));
    assert.equal(b.written, true);
    const { rows, broken } = verifylog.read(target);
    assert.equal(broken, 0);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].key, 'k1');
    assert.equal(rows[1].key, 'k2');
    assert.notEqual(a.row.id, b.row.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('append(): a defective row is refused BEFORE any file is created', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verifylog-bad-'));
  const target = path.join(dir, 'nested', 'verdicts.jsonl');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-verifylog-root2-'));
  try {
    const r = verifylog.append(target, root, verifylog.buildRow({ verdict: 'still-current' }));
    assert.equal(r.written, false);
    assert.ok(r.defects.length > 0);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read(): a missing file reads as present:false with zero rows, never an error', () => {
  const r = verifylog.read('/definitely/not/a/real/path/verdicts.jsonl');
  assert.equal(r.present, false);
  assert.deepEqual(r.rows, []);
  assert.equal(r.broken, 0);
});

test('targetPath(): CHEAP_MEM_VERIFY_FILE overrides the default, resolved to an absolute path', () => {
  const t = verifylog.targetPath({ CHEAP_MEM_VERIFY_FILE: 'relative/verdicts.jsonl' });
  assert.ok(path.isAbsolute(t));
  const def = verifylog.targetPath({});
  assert.match(def, /\.cheap-mem-verify[/\\]facts-verdict\.jsonl$/);
});

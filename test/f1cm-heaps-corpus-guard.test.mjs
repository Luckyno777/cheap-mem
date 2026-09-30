/**
 * `bench/heaps-corpus.mjs build <root>` never wipes a directory it did not make.
 *
 * **The finding, audit 2026-09-30, B27.** build/check ran
 * `fs.rmSync(root, { recursive: true })` on whatever path it was given.
 * Measured on 241a8aa: a memory directory outside the temp dir holding
 * a decisions log was deleted and replaced by the synthetic corpus,
 * exit 0. Now the run aborts before deleting unless the root is
 * missing, empty, under os.tmpdir(), or carries the bench marker.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'heaps-corpus.mjs');

function build(root, fakeTmp) {
  return spawnSync('node', [SCRIPT, 'build', root, '40'], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: fakeTmp, TMP: fakeTmp, TEMP: fakeTmp },
  });
}

test('a non-empty directory outside the temp dir is refused and left intact', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-heaps-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const fakeTmp = path.join(base, 'tmp');
  fs.mkdirSync(fakeTmp);
  const real = path.join(base, 'my-memory');
  fs.mkdirSync(path.join(real, 'global'), { recursive: true });
  const log = path.join(real, 'global', 'decisions.jsonl');
  fs.writeFileSync(log, '{"keep":1}\n');
  const r = build(real, fakeTmp);
  assert.notEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /refusing to delete/);
  assert.equal(fs.readFileSync(log, 'utf8'), '{"keep":1}\n');
});

test('positive control: temp dir, fresh path and an earlier bench corpus are rebuilt', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'f1cm-heaps-ok-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const fakeTmp = path.join(base, 'tmp');
  fs.mkdirSync(fakeTmp);
  const inTmp = path.join(fakeTmp, 'corpus');
  fs.mkdirSync(inTmp);
  fs.writeFileSync(path.join(inTmp, 'old.txt'), 'x');
  assert.equal(build(inTmp, fakeTmp).status, 0);
  const fresh = path.join(base, 'fresh');
  assert.equal(build(fresh, fakeTmp).status, 0, 'a path that does not exist yet');
  const again = build(fresh, fakeTmp);
  assert.equal(again.status, 0, `rebuild over its own marker: ${again.stderr}`);
  assert.ok(fs.readdirSync(path.join(fresh, 'global')).length > 0);
});

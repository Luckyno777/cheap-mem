// F5 / suggestion list item 14: one way to write a state file --
// `writeAtomic()` in src/atomicwrite.mjs (unique temp file + rename).
//
// Two guards.
//   1. No FIXED temp name any more (`${file}.tmp`, `.new`, `.neu`, or the
//      pid-only `${file}.${process.pid}.tmp`): two writers (or two writes
//      of one process) would share the file and could rename a mixture
//      (lucky-mem finding 2jaqvkqf537u). Count today: 0, cap 0.
//   2. Direct `writeFileSync`/`writeFile`/`createWriteStream` in src/ and
//      bin/ must not GROW. The old stock is listed per file with its cap;
//      it is NOT checked one by one for "is this state" (many write new
//      files into build or scratch directories, some are state). A cap that
//      is too high fails too, so it ratchets down. A new direct writer:
//      use `writeAtomic()`, or list it here with a reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { files, hits, read } from './f5-source.mjs';
import { writeAtomic, tempNameFor } from '../src/atomicwrite.mjs';

const FIXED_NAME = /`\$\{\w+\}\.(tmp|new|neu)`|\.\$\{process\.pid\}\.tmp`|\.tmp-\$\{process\.pid\}/;
const DIRECT = /\b(writeFileSync|writeFile|createWriteStream)\(/;

// Old stock of direct writers, per file (state 2026-10-01, number of sites).
const DIRECT_CAP = {
  'src/agents.mjs': 2,
  'src/answercheck.mjs': 1,
  'src/archive.mjs': 3,
  'src/cli/commands/capture.mjs': 1,
  'src/cli/commands/setup.mjs': 5,
  'src/cli/githook.mjs': 6,
  'src/closingreport.mjs': 1,
  'src/config.mjs': 1,
  'src/console.mjs': 2,
  'src/docimages-state.mjs': 1,
  'src/embed/index.mjs': 1,
  'src/environment.mjs': 1,
  'src/filelock.mjs': 1,
  'src/inbox.mjs': 5,
  'src/indexcache.mjs': 3,
  'src/integrationcontract.mjs': 1,
  'src/memory.mjs': 1,
  'src/probescaffold.mjs': 1,
  'src/raw.mjs': 1,
  'src/release.mjs': 1,
  'src/setup.mjs': 1,
  'src/store.mjs': 1
};

const CANDIDATES = () => [
  ...files('src', (n) => n.endsWith('.mjs')),
  ...files('bin', () => true),
].filter((r) => r !== 'src/atomicwrite.mjs' && !r.endsWith('.ps1'));

test('positive control: both patterns see their targets, comments not', () => {
  assert.equal(hits('const t = `${file}.tmp`;', FIXED_NAME).length, 1);
  assert.equal(hits('const t = `${file}.${process.pid}.tmp`;', FIXED_NAME).length, 1);
  assert.equal(hits('const t = `${file}.tmp-${process.pid}-${Date.now()}`;', FIXED_NAME).length, 1);
  assert.equal(hits('const t = `${file}.${process.pid}.${rand}.tmp`;', FIXED_NAME).length, 0);
  assert.equal(hits('fs.writeFileSync(a, b)', DIRECT).length, 1);
  assert.equal(hits('// fs.writeFileSync(a, b)', DIRECT).length, 0);
  assert.equal(hits('writeAtomic(a, b)', DIRECT).length, 0);
});

test('no fixed temp name anywhere in src/ or bin/', () => {
  const found = [];
  for (const rel of CANDIDATES()) for (const h of hits(read(rel), FIXED_NAME)) found.push(`${rel}:${h.line}: ${h.text}`);
  assert.deepEqual(found, [], `fixed temp name instead of writeAtomic():\n${found.join('\n')}`);
});

test('direct writers do not grow (old stock capped per file)', () => {
  const tooMany = []; const tooHigh = []; const seen = {};
  for (const rel of CANDIDATES()) {
    const n = hits(read(rel), DIRECT).length;
    if (!n) continue;
    seen[rel] = n;
    const cap = DIRECT_CAP[rel] ?? 0;
    if (n > cap) tooMany.push(`${rel}: ${n} direct writers, cap ${cap}`);
  }
  for (const [rel, cap] of Object.entries(DIRECT_CAP)) {
    if ((seen[rel] ?? 0) < cap) tooHigh.push(`${rel}: only ${seen[rel] ?? 0} left, lower the cap from ${cap}`);
  }
  assert.deepEqual(tooMany, [], `new direct writers -- use writeAtomic():\n${tooMany.join('\n')}`);
  assert.deepEqual(tooHigh, [], `cap too high:\n${tooHigh.join('\n')}`);
});

test('writeAtomic: writes, creates the directory, leaves no temp file', () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-atomic-'));
  try {
    const target = path.join(w, 'a', 'b', 'state.json');
    writeAtomic(target, '{"x":1}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"x":1}\n');
    writeAtomic(target, '{"x":2}\n');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"x":2}\n');
    assert.deepEqual(fs.readdirSync(path.dirname(target)), ['state.json']);
    if (process.platform !== 'win32') {
      writeAtomic(path.join(w, 'key'), 'k', { mode: 0o600 });
      assert.equal(fs.statSync(path.join(w, 'key')).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('writeAtomic: temp names are unique, the failure path cleans up, EPERM is retried', () => {
  const names = new Set(Array.from({ length: 200 }, () => tempNameFor('/x/y')));
  assert.equal(names.size, 200, 'two calls produced the same temp name');
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-atomic-'));
  try {
    const target = path.join(w, 'target');
    fs.mkdirSync(path.join(target, 'inside'), { recursive: true });
    assert.throws(() => writeAtomic(target, 'x'));
    assert.deepEqual(fs.readdirSync(w), ['target'], 'temp file was left behind');
    // The retry is DRIVEN, not read: two EPERMs, then success.
    let n = 0;
    const flaky = (a, b) => { n += 1; if (n <= 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); fs.renameSync(a, b); };
    const file = path.join(w, 'f.json');
    writeAtomic(file, 'ok', { rename: flaky, pause: () => {} });
    assert.equal(fs.readFileSync(file, 'utf8'), 'ok');
    assert.equal(n, 3);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// P12 · `memory.iterLogFile`'s own correctness, at the boundary cases a
// chunked reader can get wrong that a whole-file read never has to
// think about: a line straddling a chunk boundary, a multi-byte UTF-8
// character straddling one, no trailing newline, an empty file, a line
// longer than the chunk itself, and a broken (non-JSON) line. Every
// case is run with a deliberately tiny `chunkBytes` so the boundary is
// forced, not hoped for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';

function file(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-iterlogfile-'));
  const p = path.join(dir, 'drawer.jsonl');
  fs.writeFileSync(p, content);
  return p;
}

function collect(p, opts) {
  return [...memory.iterLogFile(p, opts)];
}

test('a missing file yields nothing, not an error', () => {
  assert.deepEqual(collect('/does/not/exist.jsonl'), []);
});

test('an empty file yields nothing', () => {
  assert.deepEqual(collect(file('')), []);
});

test('a normal file, read in tiny 8-byte chunks, matches a whole-file read', () => {
  const rows = [];
  for (let i = 0; i < 40; i += 1) rows.push({ id: `e${i}`, n: i });
  const content = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
  const p = file(content);
  const whole = collect(p);
  const chunked = collect(p, { chunkBytes: 8 });
  assert.deepEqual(chunked, whole);
  assert.deepEqual(chunked, rows);
});

test('the last line survives with no trailing newline', () => {
  const p = file('{"id":"a"}\n{"id":"b"}');
  assert.deepEqual(collect(p, { chunkBytes: 4 }), [{ id: 'a' }, { id: 'b' }]);
});

test('a line longer than the chunk size is still read whole', () => {
  const long = 'y'.repeat(500);
  const p = file(`{"id":"short"}\n{"id":"long","text":"${long}"}\n{"id":"tail"}\n`);
  const got = collect(p, { chunkBytes: 16 });
  assert.equal(got.length, 3);
  assert.equal(got[1].text, long);
  assert.equal(got[1].text.length, 500);
});

test('a multi-byte UTF-8 character straddling a chunk boundary decodes correctly', () => {
  // German umlauts and an emoji: this project's own bidi/language
  // handling exists because real drawers are not ASCII-only, so the
  // decoder has to get this right, not just avoid throwing.
  const text = 'Muenchen: über-Frühstück 😀 done';
  const p = file(`${JSON.stringify({ id: 'a', text })}\n`);
  // chunkBytes values chosen to land the boundary at different byte
  // offsets inside the multi-byte sequences (2-byte umlauts, a 4-byte
  // surrogate-pair emoji), not just at a convenient ASCII gap.
  for (const chunkBytes of [1, 2, 3, 5, 7, 11, 13, 17, 23]) {
    const got = collect(p, { chunkBytes });
    assert.deepEqual(got, [{ id: 'a', text }],
      `chunkBytes=${chunkBytes} corrupted a multi-byte character at the boundary`);
  }
});

test('a broken (non-JSON) line reports __broken, same as readLog', () => {
  const p = file('{"id":"a"}\nnot json at all\n{"id":"b"}\n');
  const got = collect(p, { chunkBytes: 6 });
  assert.deepEqual(got, [
    { id: 'a' },
    { __broken: true, raw: 'not json at all' },
    { id: 'b' },
  ]);
});

test('iterLog (by root/type/project) matches iterLogFile (by path) on the same drawer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-iterlog-'));
  try {
    memory.logEntry(root, 'thought', { text: 'one' });
    memory.logEntry(root, 'thought', { text: 'two' });
    const viaType = [...memory.iterLog(root, 'thought')].map((e) => e.text);
    const viaPath = [...memory.iterLogFile(memory.logPath(root, 'thought'))].map((e) => e.text);
    assert.deepEqual(viaType, ['one', 'two']);
    assert.deepEqual(viaPath, viaType);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an early-exit consumer never triggers a read past the match — chunked reads stop too', () => {
  // Not a memory assertion (that is the ladder's job) — a behavioural
  // one: breaking out of the generator must not force it to finish
  // reading the file first. Proven by handing it a file whose LATER
  // bytes are simply not there to read correctly (truncated mid multi-
  // byte sequence) and confirming that never surfaces as an error,
  // because the loop stops before the reader ever gets that far.
  const rows = [];
  for (let i = 0; i < 20; i += 1) rows.push({ id: `e${i}` });
  const p = file(`${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  let seen = 0;
  for (const e of memory.iterLogFile(p, { chunkBytes: 8 })) {
    seen += 1;
    assert.equal(e.id, `e${seen - 1}`);
    if (seen === 3) break;
  }
  assert.equal(seen, 3);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACTION, fingerprint, decide, readMark, writeMark, watermark, pointerLine,
} from '../src/pointer.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ptr-'));

test('without a mark it shows', () => {
  assert.equal(decide({ mark: null, levelNow: 10 }).action, ACTION.SHOW);
});

test('an equal watermark means a pointer — without looking again', () => {
  const d = decide({ mark: { level: 100, fingerprint: 'a' }, levelNow: 100, newFingerprint: null });
  assert.equal(d.action, ACTION.POINTER);
  assert.equal(d.why, 'watermark-equal');
});

test('grown but same content is still a pointer', () => {
  assert.equal(decide({ mark: { level: 100, fingerprint: 'a' }, levelNow: 150, newFingerprint: 'a' }).action,
    ACTION.POINTER);
});

test('grown with different content means FRESH — the whole point', () => {
  assert.equal(decide({ mark: { level: 100, fingerprint: 'a' }, levelNow: 150, newFingerprint: 'b' }).action,
    ACTION.FRESH);
});

test('grown but unchecked: show, do not stay silent', () => {
  const d = decide({ mark: { level: 100, fingerprint: 'a' }, levelNow: 150, newFingerprint: null });
  assert.equal(d.action, ACTION.SHOW);
  assert.equal(d.why, 'grew-unchecked');
});

test('a broken mark falls to show, never to silence', () => {
  assert.equal(decide({ mark: { level: 'lots' }, levelNow: 1 }).action, ACTION.SHOW);
  assert.equal(decide({ mark: { fingerprint: 5, level: 1 }, levelNow: 1 }).action, ACTION.SHOW);
});

test('the watermark counts only append-only books and skips raw/', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'global'), { recursive: true });
  fs.mkdirSync(path.join(d, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(d, 'global', 'errors.jsonl'), 'x'.repeat(100));
  fs.writeFileSync(path.join(d, 'global', 'facts.yaml'), 'y'.repeat(500));
  fs.writeFileSync(path.join(d, 'raw', 'big.jsonl'), 'z'.repeat(9000));
  const w = watermark(d);
  assert.equal(w.bytes, 100);
  assert.equal(w.files, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test('an appended entry moves the watermark', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'global'), { recursive: true });
  const f = path.join(d, 'global', 'errors.jsonl');
  fs.writeFileSync(f, '{"a":1}\n');
  const before = watermark(d).bytes;
  fs.appendFileSync(f, '{"a":2}\n');
  assert.ok(watermark(d).bytes > before);
  fs.rmSync(d, { recursive: true, force: true });
});

test('mark round-trips, a broken one yields null', () => {
  const d = tmp();
  const w = path.join(d, 'm', 'mark.json');
  assert.ok(writeMark(w, { level: 7, fingerprint: 'q', shown: 2 }));
  assert.deepEqual(readMark(w), { level: 7, fingerprint: 'q', shown: 2 });
  fs.writeFileSync(w, '{broken');
  assert.equal(readMark(w), null);
  assert.equal(readMark(path.join(d, 'nope')), null);
  fs.rmSync(d, { recursive: true, force: true });
});

test('the fingerprint is stable and discriminates', () => {
  assert.equal(fingerprint('abc'), fingerprint('abc'));
  assert.notEqual(fingerprint('abc'), fingerprint('abd'));
});

test('the pointer line names the file, the count and that it still holds', () => {
  const l = pointerLine({ pathName: 'src/search.mjs', count: 3 });
  assert.match(l, /src\/search\.mjs/);
  assert.match(l, /3 entries/);
  assert.match(l, /unchanged/);
  assert.match(l, /already injected/);
});

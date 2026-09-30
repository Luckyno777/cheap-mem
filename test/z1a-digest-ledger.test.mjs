/**
 * Wave Z1a (ChatGPT brief 2026-09-30): digest and agent ledger.
 *
 *   B16  markDigested demands an existing capture and carries the yield
 *   B17  the bell does not disappear while a rest is open
 *   B18  a tiny pile is not "too-little" forever (ceiling before the floor)
 *   B19  the budget counts bytes BEFORE packing (source_bytes)
 *   B21  broken lines in a capture are counted: ok / partial / broken
 *
 * Every probe carries its positive control in the same test: first the
 * situation where the guard must NOT bite, then the one where it must.
 * The red proof is in the report (same file against the state 68a5316).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import * as raw from '../src/raw.mjs';
import * as memory from '../src/memory.mjs';
import * as archive from '../src/archive.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MEM = fileURLToPath(new URL('../bin/mem', import.meta.url));
const mkRoot = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-z1a-'));
  process.on('exit', () => { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* fine */ } });
  return r;
};
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const gz = (l) => zlib.gzipSync(l.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n') + '\n');
function cap(root, name, buf) {
  const dir = path.join(root, 'raw', '2026', '09');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), buf);
  return path.join('raw', '2026', '09', name);
}

// --- B17 ---------------------------------------------------------------

test('B17: after a partial marking the bell stays and the rest becomes due', () => {
  const r = mkRoot();
  const a = cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: rnd(27000) }]));
  cap(r, '2026-09-01T00-00-01Z--s2.jsonl.gz', gz([{ __stamp: 1, session_id: 's2' }, { t: rnd(27000) }]));
  raw.ring(r, new Date('2026-09-01T00:00:00Z'));
  raw.markDigested(r, [a]);
  assert.notEqual(raw.bellState(r), null, 'rest open -> the bell must not vanish');
  const d = raw.due(r, { now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(d.due, true, `the rest must be due after a month: ${JSON.stringify(d)}`);
  assert.equal(raw.pending(r).open.length, 1);
});

test('B17 positive control: when NOTHING is left open the bell is reset', () => {
  const r = mkRoot();
  const a = cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: rnd(100) }]));
  raw.ring(r, new Date('2026-09-01T00:00:00Z'));
  raw.markDigested(r, [a]);
  assert.equal(raw.bellState(r), null);
});

// --- B18 ---------------------------------------------------------------

test('B18: a very small capture is due at the ceiling, not "too-little" forever', () => {
  const r = mkRoot();
  cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: 'tiny' }]));
  raw.ring(r, new Date('2026-09-01T00:00:00Z'));
  const month = raw.due(r, { now: new Date('2026-10-01T00:00:00Z') });
  assert.equal(month.due, true, JSON.stringify(month));
  assert.equal(month.reason, 'ceiling');
  // Positive control: before the ceiling the floor still holds.
  const early = raw.due(r, { now: new Date('2026-09-01T02:00:00Z') });
  assert.equal(early.due, false);
  assert.equal(early.reason, 'too-little');
});

// --- B16 ---------------------------------------------------------------

test('B16: a non-existing path is rejected, nothing written, the bell stays', () => {
  const r = mkRoot();
  cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: 'x' }]));
  raw.ring(r, new Date('2026-09-01T00:00:00Z'));
  assert.throws(() => raw.markDigested(r, ['raw/2026/09/does-not-exist.jsonl.gz']),
    (e) => e.code === 'CAPTURE_MISSING');
  assert.equal(fs.existsSync(path.join(r, raw.LEDGER_FILE)), false, 'no ledger for a phantom path');
  assert.notEqual(raw.bellState(r), null, 'the bell must not fall');
  assert.equal(raw.pending(r).open.length, 1);
});

test('B16: a mixed call (one real, one wrong path) marks NOTHING', () => {
  const r = mkRoot();
  const a = cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: 'x' }]));
  assert.throws(() => raw.markDigested(r, [a, 'raw/2026/09/typo.jsonl.gz']), (e) => e.code === 'CAPTURE_MISSING');
  assert.equal(raw.pending(r).open.length, 1, 'the real one stays open too');
});

test('B16: the yield is in the ledger and in the result, the 0 included', () => {
  const r = mkRoot();
  const a = cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: 'x' }]));
  const b = cap(r, '2026-09-01T00-00-01Z--s2.jsonl.gz', gz([{ __stamp: 1, session_id: 's2' }, { t: 'y' }]));
  const res = raw.markDigestedWithYield(r, [a, b], { yield: { [a]: 2, [b]: 0 } });
  assert.equal(res.yield[a], 2);
  assert.equal(res.yield[b], 0);
  assert.deepEqual(res.withoutEntry, [b], 'the 0 is named, not left out');
  const last = JSON.parse(fs.readFileSync(path.join(r, raw.LEDGER_FILE), 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(last.yield, { [a]: 2, [b]: 0 });
  assert.equal(last.entries, 2);
});

test('B16: without a passed yield it is UNKNOWN (null in the ledger), never 0', () => {
  const r = mkRoot();
  const a = cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: 'x' }]));
  const res = raw.markDigestedWithYield(r, [a]);
  assert.deepEqual(res.unknown, [a]);
  assert.deepEqual(res.withoutEntry, []);
  const last = JSON.parse(fs.readFileSync(path.join(r, raw.LEDGER_FILE), 'utf8').trim().split('\n').at(-1));
  assert.deepEqual(last.yield, { [a]: null });
});

test('B16 (CLI): `mem raw digested` counts the yield from the logs and shows it, the 0 included', () => {
  const r = mkRoot();
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ version: 1, participants: { a: 'x' } }));
  const a = cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: 'x' }]));
  const b = cap(r, '2026-09-01T00-00-01Z--s2.jsonl.gz', gz([{ __stamp: 1, session_id: 's2' }, { t: 'y' }]));
  memory.logEntry(r, 'decision', { title: 'from a', origin: { raw: a } });
  memory.logEntry(r, 'decision', { title: 'also from a', origin: { raw: [a] } });
  const mem = (...args) => spawnSync('node', [MEM, '--root', r, ...args], { encoding: 'utf8' });
  const wrong = mem('raw', 'digested', a, 'raw/2026/09/typo.jsonl.gz');
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stderr + wrong.stdout, /does not exist/);
  assert.equal(raw.pending(r).open.length, 2);
  const res = mem('raw', 'digested', a, b);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Yield: 2 entries from 2 captures, 1 without an entry \(0\)/);
  assert.ok(res.stdout.includes(`0 entries: ${b}`), res.stdout);
});

test('B16: an unusable yield (not a number) is rejected', () => {
  const r = mkRoot();
  const a = cap(r, '2026-09-01T00-00-00Z--s1.jsonl.gz', gz([{ __stamp: 1, session_id: 's1' }, { t: 'x' }]));
  assert.throws(() => raw.markDigested(r, [a], { yield: { [a]: 'many' } }), (e) => e.code === 'YIELD_MISSING');
  assert.equal(fs.existsSync(path.join(r, raw.LEDGER_FILE)), false);
});

// --- B21 ---------------------------------------------------------------

test('B21: broken lines are counted: ok / partial / broken', () => {
  const r = mkRoot();
  const ok = cap(r, '2026-09-01T00-00-00Z--ok.jsonl.gz', gz([{ __stamp: 1, session_id: 'a' }, { ok: 1 }]));
  const part = cap(r, '2026-09-01T00-00-01Z--part.jsonl.gz', gz([{ __stamp: 1, session_id: 'b' }, { ok: 1 }, '{broken', 'not json']));
  const bad = cap(r, '2026-09-01T00-00-02Z--bad.jsonl.gz', gz(['{x', 'y']));
  const a = raw.readCapture(r, ok);
  assert.equal(a.state, 'ok'); assert.equal(a.broken, 0);
  const b = raw.readCapture(r, part);
  assert.equal(b.state, 'partial'); assert.equal(b.broken, 2);
  assert.equal(b.lines.length, 1, 'the readable line stays');
  const c = raw.readCapture(r, bad);
  assert.equal(c.state, 'broken'); assert.equal(c.broken, 2);
});

// --- B19 ---------------------------------------------------------------

test('B19: the budget knows the bytes BEFORE packing; unknown stays null', () => {
  const r = mkRoot();
  const big = cap(r, '2026-09-01T00-00-00Z--big.jsonl.gz', gz([{ __stamp: 1, session_id: 'g' }, { t: 'a'.repeat(1024 * 1024) }]));
  const small = cap(r, '2026-09-01T00-00-01Z--small.jsonl.gz', gz([{ __stamp: 1, session_id: 'k' }, { t: 'b'.repeat(1024) }]));
  const none = cap(r, '2026-09-01T00-00-02Z--none.jsonl.gz', gz([{ __stamp: 1, session_id: 'o' }, { t: 'c' }]));
  const rec = (p, bytes, src) => archive.writeRecord(r, {
    path: p, captured_at: '2026-09-01T00:00:00Z', location: `file:///x/${p}`, bytes,
    ...(src === undefined ? {} : { source_bytes: src }), sha256: 'x'.repeat(64),
  });
  rec(big, fs.statSync(path.join(r, big)).size, 50 * 1024 * 1024);
  rec(small, fs.statSync(path.join(r, small)).size, 50 * 1024);
  rec(none, 30);
  const s = raw.pending(r);
  assert.equal(s.rawSizes[big], 50 * 1024 * 1024);
  assert.equal(s.rawSizes[small], 50 * 1024);
  assert.equal(s.rawSizes[none], null, 'unknown is not zero and not the packed number');
  assert.equal(s.rawUnknown, 1);
  assert.equal(s.rawBytes, 50 * 1024 * 1024 + 50 * 1024);
  // Positive control: packed, the big one is tiny — the old sum could not see the difference.
  assert.ok(s.sizes[big] < 10 * 1024, 'packed, the big capture is tiny');
  assert.ok(s.rawSizes[big] / s.rawSizes[small] > 500, 'before packing it is not');
});

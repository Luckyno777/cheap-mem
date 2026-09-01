import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as doctor from '../src/doctor.mjs';
import * as memory from '../src/memory.mjs';
import * as raw from '../src/raw.mjs';

test('the legacy finding never names a value', () => {
  // The redaction only protects what was captured after it. A gap
  // closed later leaves material written under weaker rules — and
  // nobody looks again. That is how three dashboard tokens sat in a
  // repository for hours.
  //
  // The finding may report the hit, never the value: printing it would
  // spread it a second time, into the terminal and the doctor log.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-legacy-'));
  try {
    const secret = `ghp_${'W'.repeat(36)}`;
    const dir = path.join(root, 'raw', '2026', '01');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ __stamp: { session_id: 'x', surface: 't' } }),
      JSON.stringify({ message: { content: `export GITHUB_TOKEN=${secret}` } }),
    ];
    fs.writeFileSync(path.join(dir, 'old.jsonl.gz'),
      zlib.gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8')));

    const result = doctor.checkAll(root);
    const f = result.findings.find((x) => x.name === 'legacy');
    assert.ok(f, 'no legacy finding');
    assert.equal(f.level, doctor.LEVEL.ERROR, 'a hit must be an error, not a warning');
    const asText = `${f.text} ${f.advice ?? ''}`;
    assert.ok(!asText.includes(secret), 'the value is in the finding');
    assert.ok(!asText.includes('W'.repeat(20)), 'part of the value is in the finding');
    assert.match(f.text, /github-token|env-secret/, 'the kind is not named');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the behind check makes no network call', () => {
  // Pushed is not fixed: capture loads the redaction from THIS clone
  // and never pulls. But doctor must not hang offline either, so the
  // check may only read what git already fetched.
  const source = fs.readFileSync(new URL('../src/doctor.mjs', import.meta.url), 'utf8');
  assert.match(source, /function checkBehind/);
  const block = source.slice(source.indexOf('function checkBehind'));
  const end = block.indexOf('\nfunction ');
  const fn = end === -1 ? block : block.slice(0, end);
  assert.ok(!/'fetch'|"fetch"/.test(fn), 'checkBehind must not run git fetch');
  assert.match(fn, /rev-list/);
});

// --- Digest yield (point 2) -----------------------------------------
function findFinding(result, name) {
  return result.findings.find((x) => x.name === name);
}
function putCapture(root, name) {
  const rel = path.join('raw', '2026', '08', name);
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, zlib.gzipSync('{"text":"x"}\n'));
  return rel;
}

test('digest yield: nothing digested yet is GOOD (nothing to measure)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-yield-'));
  const b = findFinding(doctor.checkAll(root), 'digest-yield');
  assert.equal(b.level, 'good');
  assert.match(b.text, /nothing to measure/);
});

test('digest yield: a high gap ratio warns with a spot-check', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-yield-'));
  const a = putCapture(root, '2026-08-30T01-00-00Z--aaa.jsonl.gz');
  const b2 = putCapture(root, '2026-08-30T02-00-00Z--bbb.jsonl.gz');
  const c = putCapture(root, '2026-08-30T03-00-00Z--ccc.jsonl.gz');
  raw.markDigested(root, [a, b2, c]);
  memory.logEntry(root, 'thought', { text: 'from capture a', origin: { raw: a, session_id: 'aaa' } });
  const b = findFinding(doctor.checkAll(root), 'digest-yield');
  assert.equal(b.level, 'warn');
  assert.match(b.text, /1 entries from 3 digested captures; 2 produced nothing/);
  assert.ok(b.advice && /Spot-check/.test(b.advice));
});

test('digest yield: full coverage stays GOOD', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-yield-'));
  const a = putCapture(root, '2026-08-30T01-00-00Z--aaa.jsonl.gz');
  const b2 = putCapture(root, '2026-08-30T02-00-00Z--bbb.jsonl.gz');
  const c = putCapture(root, '2026-08-30T03-00-00Z--ccc.jsonl.gz');
  raw.markDigested(root, [a, b2, c]);
  memory.logEntry(root, 'thought', { text: 'one', origin: { raw: a } });
  memory.logEntry(root, 'error', { title: 'two', origin: { raw: b2 } });
  memory.logEntry(root, 'event', { title: 'three', origin: { raw: c } });
  const b = findFinding(doctor.checkAll(root), 'digest-yield');
  assert.equal(b.level, 'good');
  assert.match(b.text, /0 produced nothing/);
});

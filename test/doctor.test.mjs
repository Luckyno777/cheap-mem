import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as doctor from '../src/doctor.mjs';

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

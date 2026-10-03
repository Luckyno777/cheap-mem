// test/redaction-signed-url.test.mjs — presigned URLs in raw captures.
//
// Origin: a cloud session wrote presigned upload links (AWS X-Amz-*)
// into raw captures unredacted; the pre-commit guard stayed silent. These
// probes check the rule itself, the real capture path (capture -> read the
// stored file back) and the real pre-commit guard in a throwaway repo.
//
// Every dummy is assembled at runtime (no literal secret in this file).
// CANARY FILE — contains synthetic secrets on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import * as redaction from '../src/redaction.mjs';
import * as raw from '../src/raw.mjs';
import * as archive from '../src/archive.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOOK = path.join(ROOT, 'hooks', 'pre-commit');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const SIG = ['5e', 'b1'].join('').repeat(16);
const TOK = ['IQoJb3JpZ2luX2Vj', 'Xk9Zq7', '%2B', 'Lm4Np2', '%3D%3D'].join('');
const CRED = ['AKIA', 'QRSTUVWXYZ234567'].join('') + '%2F20261003%2Feu-west-1%2Fs3%2Faws4_request';
const GSIG = ['c0', 'de'].join('').repeat(40);
const AZSIG = ['Zm9v', 'YmFy', 'QmF6', 'cXV4'].join('').repeat(2) + '%3D';

const aws = (sep = '&', eq = '=') => ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'].join(eq) + sep
  + ['X-Amz-Credential', CRED].join(eq) + sep + 'X-Amz-Date' + eq + '20261003T000000Z' + sep
  + 'X-Amz-Expires' + eq + '3600' + sep + 'X-Amz-Security-Token' + eq + TOK + sep
  + 'X-Amz-SignedHeaders' + eq + 'host' + sep + 'X-Amz-Signature' + eq + SIG;
const VALUES = [SIG, TOK, CRED, GSIG, AZSIG];
const clean = (t) => VALUES.every((w) => !t.includes(w));

test('AWS presigned URL: token, signature and credential fall, names stay', () => {
  const e = redaction.redact(`https://b.s3.amazonaws.com/k?${aws()}`);
  assert.ok(clean(e.text), 'a value survived');
  for (const n of ['X-Amz-Security-Token=[REDACTED:signed-url]',
    'X-Amz-Signature=[REDACTED:signed-url]', 'X-Amz-Credential=[REDACTED:signed-url]']) {
    assert.ok(e.text.includes(n), `missing: ${n}`);
  }
  assert.ok(e.text.includes('X-Amz-Expires=3600'));
  assert.deepEqual(e.found, [{ type: 'signed-url', count: 3 }]);
});

test('URL-encoded (%3D, %26) falls as well', () => {
  const e = redaction.redact(`https://b.s3.amazonaws.com/k?${aws('%26', '%3D')}`);
  assert.ok(clean(e.text));
  assert.ok(e.text.includes('X-Amz-Signature%3D[REDACTED:signed-url]'));
  assert.ok(e.text.includes('%26X-Amz-Expires%3D3600'));
});

test('JSON-escaped ampersand (u0026), also double-escaped', () => {
  const url = `https://b.s3.amazonaws.com/k?${aws('\\u0026')}`;
  const once = JSON.stringify({ upload: { url } });
  const e = redaction.redact(once);
  assert.ok(clean(e.text));
  assert.ok(e.text.includes('\\u0026X-Amz-Expires=3600'));
  assert.doesNotThrow(() => JSON.parse(e.text));
  const twice = redaction.redact(JSON.stringify({ msg: once }));
  assert.ok(clean(twice.text));
  assert.doesNotThrow(() => JSON.parse(twice.text));
});

test('HTML form (&amp;) and case-insensitive names', () => {
  const h = redaction.redact(aws('&amp;'));
  assert.ok(clean(h.text));
  assert.ok(h.text.includes('&amp;X-Amz-Expires=3600'));
  assert.ok(redaction.redact(aws().toLowerCase()).found.length > 0);
});

test('GCS: X-Goog-Signature and X-Goog-Credential', () => {
  const t = `https://storage.googleapis.com/b/o?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=svc%40p.iam.gserviceaccount.com%2F20261003%2Fauto%2Fstorage%2Fgoog4_request&X-Goog-Signature=${GSIG}`;
  const e = redaction.redact(t);
  assert.ok(clean(e.text));
  assert.ok(e.text.includes('X-Goog-Algorithm=GOOG4-RSA-SHA256'));
  assert.deepEqual(e.found, [{ type: 'signed-url', count: 2 }]);
});

test('Azure SAS: sig= only together with sv=<date>, both orders', () => {
  const sas = `sv=2021-06-08&ss=b&sp=rw&se=2026-12-01T00%3A00%3A00Z&spr=https&sig=${AZSIG}`;
  const a = redaction.redact(`https://k.blob.core.windows.net/c/b?${sas}`);
  assert.ok(clean(a.text));
  assert.ok(a.text.includes('sig=[REDACTED:signed-url]'));
  assert.ok(a.text.includes('sv=2021-06-08&ss=b'));
  assert.ok(clean(redaction.redact(`?sig=${AZSIG}&sv=2021-06-08&se=2026-12-01`).text));
  assert.ok(clean(redaction.redact(`?sv%3D2021-06-08%26sp%3Drw%26sig%3D${AZSIG}`).text));
  const bare = `https://example.test/x?sig=${AZSIG}&n=1`;
  assert.equal(redaction.redact(bare).text, bare, 'a bare sig= must stay');
});

test('false positives: placeholders, prose, short values stay', () => {
  for (const t of [
    'The parameter X-Amz-Signature=<signature> is checked by the server.',
    'X-Amz-Signature=${SIGNATURE} and X-Amz-Credential=[REDACTED:aws-key-id]',
    'X-Amz-Signature=xxxxxxxxxxxx',
    'X-Amz-Signature=short',
    'X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Algorithm=AWS4-HMAC-SHA256',
    'Signature=abc123def456abc123def456 (SigV2, deliberately not covered)',
  ]) assert.equal(redaction.redact(t).text, t, `changed wrongly: ${t}`);
});

test('idempotent and linear', () => {
  const once = redaction.redact(`?${aws()}`);
  const twice = redaction.redact(once.text);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.found, []);
  for (const t of [
    'X-Amz-Signature=' + 'a'.repeat(2000) + '\\'.repeat(3) + ' ',
    'sv=2021-06-08' + '&a=b'.repeat(5000),
    ('sig=' + 'a'.repeat(30) + '&').repeat(400),
    'X-Amz-'.repeat(8000),
  ]) {
    const t0 = process.hrtime.bigint();
    redaction.redact(t);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${ms.toFixed(0)} ms for ${t.length} chars`);
  }
});

test('self-test knows the class (canary 13)', () => {
  assert.equal(redaction.CANARY_COUNT, 13);
  assert.deepEqual(redaction.selfTest(), { ok: true, checked: 13 });
});

// --- capture path: the real capture function, stored file read back ------

test('capture: the stored file carries no value, the header names the type', () => {
  const root = tmp('cm-signed-root-');
  const dir = tmp('cm-signed-tr-');
  try {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      timestamp: `2026-10-03T10:${String(i % 60).padStart(2, '0')}:00Z`,
      role: i % 2 ? 'assistant' : 'user',
      text: `Line ${i} with enough filler text so the size threshold is met here.`,
      ...(i === 7 ? {
        tool: JSON.stringify({ upload_url: `https://b.s3.amazonaws.com/k?${aws('\\u0026')}` }),
        plain: `https://b.s3.amazonaws.com/k?${aws()}`,
        encoded: `https://b.s3.amazonaws.com/k?${aws('%26', '%3D')}`,
      } : {}),
    }));
    const t = path.join(dir, 't.jsonl');
    fs.writeFileSync(t, lines.map((z) => JSON.stringify(z)).join('\n') + '\n');
    const r = raw.capture(root, t, { minBytes: 100 });
    assert.equal(r.status, 'captured', JSON.stringify(r));
    assert.ok(r.redacted.some((f) => f.type === 'signed-url'), 'capture does not report the type');
    const store = archive.readConfig(process.env, root);
    const gz = archive.get(store, root, r.path);
    assert.ok(gz, 'stored file not readable');
    const text = zlib.gunzipSync(gz).toString('utf8');
    assert.ok(clean(text), 'a value is in the stored file');
    assert.ok(text.includes('X-Amz-Signature=[REDACTED:signed-url]'));
    const head = JSON.parse(text.split('\n')[0]);
    assert.ok(head.__redacted.some((f) => f.type === 'signed-url' && f.count >= 9));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- guard: the real pre-commit hook in a throwaway repo ------------------

function hookRepo() {
  const r = tmp('cm-signed-hook-');
  const git = (...a) => execFileSync('git', a, { cwd: r, encoding: 'utf8' });
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.mkdirSync(path.join(r, 'hooks'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'redaction.mjs'), path.join(r, 'src', 'redaction.mjs'));
  fs.copyFileSync(HOOK, path.join(r, 'hooks', 'pre-commit'));
  fs.chmodSync(path.join(r, 'hooks', 'pre-commit'), 0o755);
  fs.writeFileSync(path.join(r, 'package.json'), '{"type":"module"}\n');
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', 'hooks');
  git('add', '-A');
  git('commit', '-q', '-m', 'init', '--no-verify');
  return { r, git };
}
const attempt = (r) => {
  const p = spawnSync('git', ['commit', '-q', '-m', 'probe'], { cwd: r, encoding: 'utf8' });
  return { code: p.status, text: `${p.stdout ?? ''}${p.stderr ?? ''}` };
};

test('guard: pre-commit reports file and type of a signed URL, never the value', () => {
  const { r, git } = hookRepo();
  try {
    fs.writeFileSync(path.join(r, 'note.txt'), `Link: https://b.s3.amazonaws.com/k?${aws()}\n`);
    git('add', 'note.txt');
    const e = attempt(r);
    assert.notEqual(e.code, 0, `commit went through:\n${e.text}`);
    assert.match(e.text, /note\.txt: signed-url x3/);
    assert.ok(clean(e.text), 'the guard printed a value');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('guard (positive control): a link without a secret passes', () => {
  const { r, git } = hookRepo();
  try {
    fs.writeFileSync(path.join(r, 'note.txt'),
      'Link: https://b.s3.amazonaws.com/k?X-Amz-Expires=3600&X-Amz-SignedHeaders=host\n');
    git('add', 'note.txt');
    const e = attempt(r);
    assert.equal(e.code, 0, `wrongly rejected:\n${e.text}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

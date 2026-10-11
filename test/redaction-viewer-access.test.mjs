// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Fable security run 2026-10-11, ported from lucky-mem (B14, N6): the viewer's own ways in - the link `/?k=<token>`,
// the cookie `mem_k=<token>` and the password-session cookie `mem_session=<token>` - carry neither the word token nor
// secret nor password, so no assignment pattern saw them; raw capture, the stored lines and every output gave them away
// in clear text. Now one pattern, `viewer-access`: name and `=` stay, the value falls WHOLE (no upper cap), also encoded
// (`%3Fk%3D`, `&k=`, `&amp;k=`). The tokens are assembled at runtime (no literal secret in this file).
// CANARY FILE - contains synthetic secrets on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as redaction from '../src/redaction.mjs';
import * as outputguard from '../src/outputguard.mjs';
import * as raw from '../src/raw.mjs';
import * as archive from '../src/archive.mjs';

const TOKEN = ['AbCdEf0123', '456789ZyXw', 'VuTsRqPo'].join('');
const LONG = 'Q'.repeat(700);
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const FORMS = [
  ['link', `open http://127.0.0.1:8847/?k=${TOKEN} now`, 'k='],
  ['link, later parameter', `https://mem.example.test/dashboard?x=1&k=${TOKEN}`, 'k='],
  ['link, whole URL encoded', `http%3A%2F%2Fh%2F%3Fk%3D${TOKEN} end`, 'k%3D'],
  ['link, encoded question mark', `http://h/%3Fk=${TOKEN} end`, 'k='],
  ['link, encoded ampersand', `http://h/?a=1%26k=${TOKEN}`, 'k='],
  ['link, JSON-escaped', `{"u":"http://h/?a=1\\u0026k=${TOKEN}"}`, 'k='],
  ['link, HTML-escaped', `http://h/?a=1&amp;k=${TOKEN}`, 'k='],
  ['link, semicolon', `x;k=${TOKEN}`, 'k='],
  ['token cookie', `Cookie: mem_k=${TOKEN}; other=1`, 'mem_k='],
  ['token cookie, capital letters', `Cookie: MEM_K=${TOKEN}`, 'MEM_K='],
  ['session cookie', `Cookie: mem_session=${TOKEN}`, 'mem_session='],
  ['session cookie, set-cookie', `Set-Cookie: mem_session=${TOKEN}; Path=/; HttpOnly`, 'mem_session='],
  ['session cookie, encoded equals', `mem_session%3D${TOKEN}`, 'mem_session%3D'],
];

test('every form of the viewer access falls; the name stays so the finding is actionable', () => {
  for (const [label, text, name] of FORMS) {
    const r = redaction.redact(text);
    assert.ok(!r.text.includes(TOKEN), `${label}: the value is still there: ${r.text}`);
    assert.ok(r.text.includes(`${name}[REDACTED:viewer-access]`), `${label}: ${r.text}`);
    assert.ok(r.found.some((f) => f.type === 'viewer-access'), label);
  }
});

test('a very long value falls whole - there is no cap that leaves the tail behind', () => {
  const r = redaction.redact(`http://h/?k=${LONG}&b=1`);
  assert.ok(!r.text.includes('QQQQQQQQ'), r.text.slice(0, 120));
  assert.ok(r.text.endsWith('&b=1'));
});

test('what is no access stays: a short k=, a longer word that ends in k, a value too short', () => {
  for (const t of [
    'short ?k=5 keep', 'page?k=abc', 'a=b&k=1234567', 'task=30&desk=abcdefghijklmnopqrstuvwxyz', 'junk=abcdefghijklmnopqrstuvwxyz',
    'mem_key=abcdefghijklmnop', 'mem_k=short', 'the mem_session cookie is set', 'k = abcdefghijklmnopqrstuvwxyz', 'https://h/?bk=abcdefghijklmnopqrstuvwxyz',
  ]) assert.equal(redaction.redact(t).text, t, `changed wrongly: ${t}`);
});

test('idempotent, and linear on hostile input', () => {
  const once = redaction.redact(`?k=${TOKEN} Cookie: mem_k=${TOKEN}`);
  const twice = redaction.redact(once.text);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.found, []);
  for (const t of ['?k='.repeat(20000), 'mem_k='.repeat(20000), '&k=' + 'a'.repeat(200000), `${'%3F'.repeat(30000)}k=`]) {
    const t0 = process.hrtime.bigint();
    redaction.redact(t);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 2000, `${ms.toFixed(0)} ms for ${t.length} chars`);
  }
});

test('the output layer masks it as well (the dashboard, find, show, the hooks share the pattern list)', () => {
  const masked = outputguard.maskEntry({ id: 'a1b2c3', title: 'link', text: `Open http://127.0.0.1:8847/?k=${TOKEN} and Cookie: mem_session=${TOKEN}` });
  assert.ok(!JSON.stringify(masked).includes(TOKEN), JSON.stringify(masked));
});

test('the self-test carries the canary of the class', () => {
  assert.ok(redaction.CANARIES.some(([type]) => type === 'viewer-access'));
  assert.deepEqual(redaction.selfTest(), { ok: true, checked: redaction.CANARY_COUNT });
});

test('raw capture: the stored transcript carries no value, the header names the type', () => {
  const root = tmp('cm-viewer-root-');
  const dir = tmp('cm-viewer-tr-');
  try {
    const lines = Array.from({ length: 60 }, (_, i) => ({
      timestamp: `2026-10-11T10:${String(i % 60).padStart(2, '0')}:00Z`,
      role: i % 2 ? 'assistant' : 'user',
      text: `Line ${i} with enough filler text so the size threshold is met here.`,
      ...(i === 7 ? {
        tool: JSON.stringify({ opened: `http://127.0.0.1:8847/?k=${TOKEN}`, cookie: `mem_k=${TOKEN}; mem_session=${TOKEN}` }),
        encoded: `http%3A%2F%2Fh%2F%3Fk%3D${TOKEN}`,
      } : {}),
    }));
    const t = path.join(dir, 't.jsonl');
    fs.writeFileSync(t, lines.map((z) => JSON.stringify(z)).join('\n') + '\n');
    const r = raw.capture(root, t, { minBytes: 100 });
    assert.equal(r.status, 'captured', JSON.stringify(r));
    assert.ok(r.redacted.some((f) => f.type === 'viewer-access'));
    const store = archive.readConfig(process.env, root);
    const text = zlib.gunzipSync(archive.get(store, root, r.path)).toString('utf8');
    assert.ok(!text.includes(TOKEN), 'a value is in the stored file');
    assert.ok(text.includes('mem_k=[REDACTED:viewer-access]'));
    const head = JSON.parse(text.split('\n')[0]);
    assert.ok(head.__redacted.some((f) => f.type === 'viewer-access' && f.count >= 4));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

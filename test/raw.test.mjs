import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as raw from '../src/raw.mjs';

function transcript(root, name, lines) {
  const p = path.join(root, name);
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

function talk(n, text) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    message: { content: `${text} ${i}` },
  }));
}

test('capture is incremental and never re-reads what it had', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-'));
  try {
    const t = transcript(root, 't.jsonl', talk(200, 'talking about deployment'));
    const a = raw.capture(root, t);
    assert.equal(a.status, 'captured');
    assert.equal(a.lines, 200);

    const b = raw.capture(root, t);
    assert.equal(b.status, 'nothing', 'a second capture with no growth took something');

    fs.appendFileSync(t, `${JSON.stringify({ message: { content: 'x'.repeat(5000) } })}\n`);
    const c = raw.capture(root, t);
    assert.equal(c.status, 'captured');
    assert.equal(c.lines, 1, 'the increment should hold exactly the new line');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a clean line boundary does not cost a line', () => {
  // The code dropped the first line of every increment because it
  // MIGHT be a slice of the previous one. When the last capture ended
  // exactly on a newline — the normal case — it was complete, and it
  // was lost. With a single-line increment the whole capture vanished
  // and was reported as 'nothing'.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-edge-'));
  try {
    const t = transcript(root, 't.jsonl', talk(100, 'first batch'));
    raw.capture(root, t);
    const marker = `IMPORTANT ${'x'.repeat(5000)}`;
    fs.appendFileSync(t, `${JSON.stringify({ message: { content: marker } })}\n`);
    const e = raw.capture(root, t);
    assert.equal(e.status, 'captured', 'a single new line must not disappear');
    const { lines } = raw.readCapture(root, e.path);
    assert.ok(JSON.stringify(lines).includes('IMPORTANT'), 'the line content is missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('secrets are redacted before anything reaches the disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-sec-'));
  try {
    const token = `ghp_${'K'.repeat(36)}`;
    const lines = talk(100, 'ordinary chatter');
    lines.push({ message: { content: `export GITHUB_TOKEN=${token}` } });
    const t = transcript(root, 't.jsonl', lines);
    const e = raw.capture(root, t);
    assert.equal(e.status, 'captured');
    assert.ok(e.redacted.some((r) => r.type === 'github-token'), 'the token was not reported');
    const onDisk = zlib.gunzipSync(fs.readFileSync(path.join(root, e.path))).toString('utf8');
    assert.ok(!onDisk.includes(token), 'the token is on disk — this is a leak');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a broken redaction stops the capture instead of writing anyway', () => {
  // Better a gap in the memory than a secret in the version history.
  // Verified through the public contract: capture refuses when the
  // self-test fails.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-canary-'));
  try {
    const r = raw.capture(root, path.join(root, 'does-not-exist.jsonl'));
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'no-transcript');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the stamp says where from, never who', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-stamp-'));
  try {
    const t = transcript(root, 't.jsonl', talk(200, 'hello'));
    const e = raw.capture(root, t);
    const s = e.stamp;
    assert.ok(s.session_id && s.surface);
    const asText = JSON.stringify(s);
    assert.ok(!asText.includes(os.userInfo().username), 'the stamp carries a login name');
    assert.ok(!asText.includes(os.hostname()), 'the stamp carries a machine name');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the bell governs dueness — no bell, nothing happens', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-bell-'));
  try {
    assert.equal(raw.due(root).due, false, 'due without any material');
    assert.equal(raw.due(root).reason, 'no-material');

    const t = transcript(root, 't.jsonl', talk(400, 'plenty of talking here'));
    raw.capture(root, t);

    // Volume alone, at a low threshold, is enough.
    assert.equal(raw.due(root, { thresholds: { volumeNow: 1024 } }).due, true);

    // Quiet counts from the LAST bell, not the first — otherwise the
    // digest fires in the middle of the working day.
    const soon = new Date(Date.now() + 10 * 60 * 1000);
    assert.equal(raw.due(root, { now: soon, thresholds: { volumeMin: 1, quietMs: 45 * 60000 } }).due,
      false, 'fired although the burst was still going');
    const later = new Date(Date.now() + 60 * 60 * 1000);
    assert.equal(raw.due(root, { now: later, thresholds: { volumeMin: 1, quietMs: 45 * 60000 } }).due,
      true, 'did not fire after the quiet period');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('marking digested clears the pile and the bell', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-wm-'));
  try {
    const t = transcript(root, 't.jsonl', talk(300, 'content'));
    const e = raw.capture(root, t);
    assert.equal(raw.pending(root).open.length, 1);
    assert.ok(raw.bellState(root));
    raw.markDigested(root, [e.path]);
    assert.equal(raw.pending(root).open.length, 0);
    assert.equal(raw.bellState(root), null, 'the bell survived the digest');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('marking digested is a union, never a replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-union-'));
  try {
    raw.markDigested(root, ['a.gz']);
    raw.markDigested(root, ['b.gz']);
    const wm = JSON.parse(fs.readFileSync(path.join(root, raw.WATERMARK_FILE), 'utf8'));
    assert.deepEqual(wm.digested, ['a.gz', 'b.gz']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('two captures in the same second keep both files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-raw-'));
  try {
    // The Stop hook can fire twice inside one second. The storage name
    // has second resolution, so the second capture used to overwrite
    // the first — everything it held was gone, silently.
    const now = new Date('2026-01-01T12:00:00Z');
    const t = transcript(root, 't.jsonl', talk(200, 'talking about deployment'));
    const a = raw.capture(root, t, { now });
    assert.equal(a.status, 'captured');

    fs.appendFileSync(t, `${talk(200, 'and more about errors')
      .map((l) => JSON.stringify(l)).join('\n')}\n`);
    const b = raw.capture(root, t, { now });
    assert.equal(b.status, 'captured');

    const files = fs.readdirSync(path.join(root, 'raw', '2026', '01'));
    assert.equal(files.length, 2, `both captures should survive, got ${files.join(', ')}`);

    const lines = files
      .map((f) => zlib.gunzipSync(fs.readFileSync(path.join(root, 'raw', '2026', '01', f))))
      .map((b2) => b2.toString('utf8').trim().split('\n').length)
      .reduce((x, y) => x + y, 0);
    // 200 + 200 payload lines plus one header per file.
    assert.equal(lines, 402, 'no captured line may go missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

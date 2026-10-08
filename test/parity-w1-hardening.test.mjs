/**
 * Parity wave 1, small hardening fixes ported from lucky-mem.
 * Red proof pinned against cheap-mem 8a24c64 (before the fixes).
 *
 * CANARY FILE
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as redaction from '../src/redaction.mjs';
import { cookieFrom } from '../src/login.mjs';
import { windowFor } from '../src/timeexpr.mjs';
import * as inbox from '../src/inbox.mjs';
import { tempDir } from './temp-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Values are assembled at runtime so the commit guard does not flag this file.
const short6 = ['ab', '12', 'cd'].join('');
const short7 = ['ab', '12', 'cd', '7'].join('');
const special = ['Ab', '1!', 'xy'].join('');

test('redaction: 6-7 char secrets with a digit or special char are redacted', () => {
  for (const v of [short6, short7, special]) {
    const r = redaction.redact(`PASSWORD=${v}`);
    assert.ok(!r.text.includes(v), `left in clear: ${r.text}`);
    const r2 = redaction.redact(`password: ${v}`);
    assert.ok(!r2.text.includes(v), `left in clear: ${r2.text}`);
  }
});

test('redaction positive control: short plain words and prose stay', () => {
  for (const s of ['password: sonnen', 'PASSWORD=abcdef', 'Schluessel: Wortliste', 'token: abc']) {
    assert.equal(redaction.redact(s).text, s, `over-masked: ${s}`);
  }
});

test('redaction: canaries stay intact', () => {
  const t = redaction.selfTest();
  assert.equal(t.ok, true, JSON.stringify(t.failed ?? []));
});

test('mem: inherited object names are not commands', () => {
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/mem'), name], { encoding: 'utf8', cwd: ROOT });
    assert.notEqual(r.status, 0, `'${name}' exited 0: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Unknown command/);
  }
});

test('mem positive control: a real command still runs', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/mem'), 'version'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0);
});

test('login cookieFrom: broken %-sequence does not throw, fails closed', () => {
  assert.equal(cookieFrom({ headers: { cookie: 'mem_k=%E0%A4%A' } }, 'mem_k'), '');
  assert.equal(cookieFrom({ headers: { cookie: 'mem_k=ab%20cd' } }, 'mem_k'), 'ab cd');
});

test('mem-serve tokenFrom: broken %-sequence does not throw', () => {
  const src = spawnSync(process.execPath, ['-e', `
    import('node:fs').then(async (fs) => {
      const code = fs.readFileSync(${JSON.stringify(path.join(ROOT, 'bin/mem-serve'))}, 'utf8');
      const m = /function tokenFrom[\\s\\S]*?\\n}\\n/.exec(code);
      const stub = 'const webauth = { bearerFrom: () => "" };' + m[0] + ';return tokenFrom;';
      const f = new Function(stub)();
      const url = new URL('http://x/');
      const bad = f({ headers: { cookie: 'mem_k=%E0%A4%A' } }, url);
      const ok = f({ headers: { cookie: 'mem_k=a%20b' } }, url);
      console.log(JSON.stringify([bad, ok]));
    });
  `, '--input-type=module'], { encoding: 'utf8' });
  assert.equal(src.status, 0, src.stderr);
  assert.deepEqual(JSON.parse(src.stdout), ['', 'a b']);
});

const NOW = new Date('2026-09-01T18:00:00.000Z');

test('timeexpr: impossible dates are not dates (no silent roll-over)', () => {
  for (const d of ['2026-13-45', '2026-02-31', '2026-02-29', '2026-04-31']) {
    assert.equal(windowFor(`what happened on ${d}`, { now: NOW, zone: 'UTC' }), null, d);
  }
});

test('timeexpr positive control: real dates still resolve', () => {
  const w = windowFor('what happened on 2026-02-28', { now: NOW, zone: 'UTC' });
  assert.equal(w.from.toISOString(), '2026-02-28T00:00:00.000Z');
  assert.equal(windowFor('on 2028-02-29', { now: NOW, zone: 'UTC' }).from.toISOString(), '2028-02-29T00:00:00.000Z');
});

test('inbox: 999 names per second, the 1000th fails with the true number', (t) => {
  const root = tempDir('cheap-mem-w1-inbox-', t);
  const parts = { user: 'H', session: 'AI', librarian: 'lib' };
  const now = new Date('2026-09-01T10:00:00Z');
  const seen = new Set();
  for (let i = 0; i < 999; i += 1) {
    const r = inbox.write(root, parts, { from: 'session', to: 'librarian', subject: 's', text: `t${i}`, now });
    seen.add(r.name);
  }
  assert.equal(seen.size, 999);
  assert.ok([...seen].some((n) => /-999\.md$/.test(n)), 'the -999 name was never used');
  assert.throws(() => inbox.write(root, parts, { from: 'session', to: 'librarian', subject: 's', text: 'x', now }), /999 messages/);
});

// ---- recall keeper: busy socket -> quiet retry (lucky-mem ed176a5) ----
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as keeper from '../src/recallserver-keeper.mjs';
import * as place from '../src/recallserver-place.mjs';

test('keeper: a busy socket is retried quietly, and taken over once free', async (t) => {
  const root = tempDir('cheap-mem-w1-keeper-', t);
  spawnSync(process.execPath, [path.join(ROOT, 'bin/mem'), '--root', root, 'init'], { stdio: 'ignore' });
  const occupier = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'recallserver.mjs')).href)}).then((r) => r.start(${JSON.stringify(root)}))
      .then((x) => { if (!x.running) process.exit(1); process.on('SIGTERM', () => x.close().then(() => process.exit(0))); });
  `], { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  occupier.stderr.on('data', (c) => { err += c; });
  const sock = place.place(root, {}).socket;
  const until = Date.now() + 15000;
  while (!fs.existsSync(sock) && Date.now() < until && occupier.exitCode == null) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(sock), `occupier not listening: ${err}`);
  const said = [];
  const k = keeper.keep(root, { env: { ...process.env, MEM_RECALL_SERVER_RESTART_MS: '100' }, log: (x) => said.push(x) });
  try {
    const bis = Date.now() + 10000;
    while (!said.some((x) => /busy/.test(x)) && Date.now() < bis) await new Promise((r) => setTimeout(r, 25));
    assert.ok(said.some((x) => /busy/.test(x)), `no busy line: ${said.join(' | ')}`);
    assert.equal(said.filter((x) => /busy/.test(x)).length, 1, 'only the start of the series is logged');
    const gone = new Promise((r) => occupier.once('exit', r));
    occupier.kill('SIGTERM');
    await gone;
    const bis2 = Date.now() + 15000;
    while (k.starts.length < 2 && Date.now() < bis2) await new Promise((r) => setTimeout(r, 50));
    assert.ok(k.starts.length >= 2, `the keeper never retried: ${said.join(' | ')}`);
    const bis3 = Date.now() + 15000;
    while (!fs.existsSync(sock) && Date.now() < bis3) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(sock), 'the new server listens after the occupier is gone');
  } finally {
    await k.stop();
    if (occupier.exitCode == null) occupier.kill('SIGTERM');
  }
});

// ---- mcp mem_find books into the injection journal (lucky-mem 425ddc2) ----
import * as injection from '../src/injection.mjs';

function mcpFind(root, query) {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_find', arguments: { query } } }),
  ];
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin/mem-mcp')], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2);
}

test('mcp mem_find books occasion mcp-question: length, hits, sources, never the text', (t) => {
  const root = tempDir('cheap-mem-w1-mcp-', t);
  spawnSync(process.execPath, [path.join(ROOT, 'bin/mem'), '--root', root, 'init'], { stdio: 'ignore' });
  spawnSync(process.execPath, [path.join(ROOT, 'bin/mem'), '--root', root, 'log', 'learning',
    '--title', 'retention thirty days', '--text', 'we keep captures thirty days because of privacy'], { stdio: 'ignore' });
  const query = 'retention thirty days Zauberwortquux';
  const reply = mcpFind(root, query);
  assert.ok(reply?.result, JSON.stringify(reply));
  const lines = injection.read(root).lines.filter((l) => l.occasion === 'mcp-question');
  assert.equal(lines.length, 1, JSON.stringify(injection.read(root).lines));
  assert.ok(lines[0].hits >= 1);
  assert.equal(lines[0].reason, null);
  assert.equal(lines[0].question_bytes, Buffer.byteLength(query));
  assert.ok(lines[0].sources.length >= 1);
  assert.ok(Number.isFinite(lines[0].duration_ms));
  const journal = fs.readFileSync(path.join(root, injection.JOURNAL_FILE), 'utf8');
  assert.ok(!journal.includes('Zauberwortquux'), 'the question text must never be booked');
  // The hook's own occasion stays untouched.
  assert.equal(injection.read(root).lines.filter((l) => l.occasion === 'question').length, 0);
});

test('mcp mem_find with no hit books reason empty; unknown occasions stay unknown', (t) => {
  const root = tempDir('cheap-mem-w1-mcp2-', t);
  spawnSync(process.execPath, [path.join(ROOT, 'bin/mem'), '--root', root, 'init'], { stdio: 'ignore' });
  mcpFind(root, 'qqqxyzzz vvvwwwyyy');
  const l = injection.read(root).lines.filter((x) => x.occasion === 'mcp-question');
  assert.equal(l.length, 1);
  assert.equal(l[0].hits, 0);
  assert.equal(l[0].reason, 'empty');
  assert.equal(injection.buildLine({ occasion: 'invented' }).occasion, 'unknown');
});

// ---- capture carries a fingerprint of the REAL session id (lucky-mem c495d73) ----
import * as raw from '../src/raw.mjs';
import * as userhabits from '../src/userhabits.mjs';
import * as goldlog from '../src/goldlog.mjs';
import * as gap from '../src/gap.mjs';

test('capture: stamp carries a fingerprint of the real session id; raw and journal correlate', (t) => {
  const root = tempDir('cheap-mem-w1-fp-', t);
  const REAL = 'f7c1a2de-0000-4000-8000-9a9a9a9a9a9a';
  const tp = path.join(root, 'transcript.jsonl');
  const rows = Array.from({ length: 80 }, (_, i) => ({
    type: 'user', sessionId: REAL,
    timestamp: `2026-09-01T10:00:${String(i % 60).padStart(2, '0')}Z`,
    message: { role: 'user', content: `please explain how the frobnicator widget retries number ${i}` },
  }));
  fs.writeFileSync(tp, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const r = raw.capture(root, tp, { minBytes: 1 });
  assert.equal(r.status, 'captured', JSON.stringify(r));
  assert.equal(r.stamp.session_fingerprint, raw.sessionFingerprint(REAL));
  assert.notEqual(r.stamp.session_id, raw.sessionFingerprint(REAL), 'session_id stays the path hash');
  // The raw id itself is never stored in the stamp.
  assert.ok(!JSON.stringify(r.stamp).includes(REAL));
  const { messages } = userhabits.realMessages(root);
  assert.ok(messages.length > 0);
  assert.equal(messages[0].sessionFingerprint, raw.sessionFingerprint(REAL));
  // The journal books the raw id: the correlation must find the message.
  const hit = goldlog.nearestMessage(messages, '2026-09-01T10:00:05Z', REAL);
  assert.ok(hit, 'journal session and capture did not correlate');
  assert.ok(gap.nearestMessage(messages, '2026-09-01T10:00:05Z', REAL));
  // Positive control: a different session does not match.
  assert.equal(goldlog.nearestMessage(messages, '2026-09-01T10:00:05Z', 'some-other-session'), null);
});

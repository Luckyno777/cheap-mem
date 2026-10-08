// test/body-reader.test.mjs — audit F21: one shared, bounded body reader (the sibling's test/rumpfleser.test.mjs).
// Cap in BYTES including the current chunk, 413 without mutation, exactly one answer, abort handled.
// Red proof against the fixed old state 4bbca61 (characters, checked before appending).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readBoundedBody } from '../src/body-reader.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD = '4bbca61';
const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

// ---------- unit: the reader without a network ----------
function fake(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.resume = () => {};
  req.destroy = () => {};
  return req;
}
const read = (req, max) => { const out = []; readBoundedBody(req, null, max, (e) => out.push(e)); return out; };

test('unit: exactly max bytes is ok, max+1 is too big (bytes, not characters)', () => {
  let r = fake(); let out = read(r, 4);
  r.emit('data', Buffer.from('abcd')); r.emit('end');
  assert.deepEqual(out, [{ status: 'ok', body: 'abcd' }]);
  r = fake(); out = read(r, 4);
  r.emit('data', Buffer.from('abcde')); r.emit('end');
  assert.deepEqual(out, [{ status: 'too-big' }]);
  // 3 characters, 6 bytes
  r = fake(); out = read(r, 5);
  r.emit('data', Buffer.from('äää')); r.emit('end');
  assert.deepEqual(out, [{ status: 'too-big' }]);
});

test('unit: the chunk that blows the cap counts; exactly one result afterwards', () => {
  const r = fake(); const out = read(r, 10);
  r.emit('data', Buffer.from('12345')); r.emit('data', Buffer.from('678901')); // 11 bytes
  r.emit('data', Buffer.from('x')); r.emit('end'); r.emit('close');
  assert.deepEqual(out, [{ status: 'too-big' }]);
});

test('unit: a multi-byte character across a chunk border is decoded correctly', () => {
  const b = Buffer.from('ä'); const r = fake(); const out = read(r, 100);
  r.emit('data', b.subarray(0, 1)); r.emit('data', b.subarray(1)); r.emit('end');
  assert.deepEqual(out, [{ status: 'ok', body: 'ä' }]);
});

test('unit: a Content-Length above the cap is refused without reading', () => {
  const r = fake({ 'content-length': '100' }); const out = read(r, 10);
  assert.deepEqual(out, [{ status: 'too-big' }]);
  r.emit('data', Buffer.from('x')); r.emit('end');
  assert.equal(out.length, 1);
});

test('unit: abort (aborted, close before end, error) -> exactly one aborted, a late end has no effect', () => {
  for (const event of ['aborted', 'close', 'error']) {
    const r = fake(); const out = read(r, 100);
    r.emit('data', Buffer.from('ab'));
    r.emit(event, new Error('gone'));
    r.emit('end'); r.emit('close');
    assert.deepEqual(out, [{ status: 'aborted' }], event);
  }
});

// ---------- server: all seven places ----------
let oldTree;
function oldState() {
  if (oldTree !== undefined) return oldTree;
  const dest = tmp('cm-old-state-');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const tar = execFileSync('git', ['-C', REPO, 'archive', OLD, 'bin', 'src', 'shared', 'assets', 'package.json'], { env, maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', dest], { input: tar, env });
    oldTree = dest;
  } catch { oldTree = null; }
  return oldTree;
}

async function start(moduleRoot) {
  const mod = await import(`${pathToFileURL(path.join(moduleRoot, 'bin', 'mem-serve')).href}?t=${Math.random()}`);
  const root = tmp('cm-body-');
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'bodyprobe', participants: { alex: { human: true }, bot: {} }, language: 'en' }));
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', MEM_RECALL_SERVER: '0' }, { allowWrites: true });
  return { server, root, port: server.address().port, paths: { verdict: mod.VERIFY_VERDICT_PATH, gold: mod.GOLD_VERDICT_PATH } };
}
const stop = (srv) => new Promise((res) => { srv.closeAllConnections?.(); srv.close(res); });
const tree = (root) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(`${path.relative(root, p)}:${fs.statSync(p).size}`); } }; // rel-ok: snapshot key compared only with itself
  walk(root);
  return out.sort().join('|');
};
function post(port, pathName, chunks) {
  return new Promise((ok, no) => {
    const answers = [];
    const r = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: {
      host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } },
    (res) => { answers.push(res.statusCode); res.resume(); res.on('end', () => ok(answers)); res.on('close', () => ok(answers)); });
    r.on('error', (e) => ((e.code === 'ECONNRESET' || e.code === 'EPIPE') && answers.length ? ok(answers) : no(e)));
    (async () => { for (const c of chunks) { if (!r.write(c)) await new Promise((t) => r.once('drain', t)); } r.end(); })().catch(() => {});
  });
}
// Runs fn against a fresh server and ALWAYS tears it down.
async function withServer(moduleRoot, fn) {
  const s = await start(moduleRoot);
  try { await fn(s); } finally { await stop(s.server); }
}

const PLACES = (p) => [['/setting', 8192], [p.verdict, 4096], [p.gold, 4096], ['/dashboard/probe.json', 8192], ['/inbox/state', 4096], ['/inbox/reply', 16384], ['/task', 16384]];

test('green: one chunk above the cap -> 413, exactly one answer, store unchanged (all seven places)', async () => {
  await withServer(REPO, async (s) => {
    for (const [pathName, cap] of PLACES(s.paths)) {
      const before = tree(s.root);
      const a = await post(s.port, pathName, [`id=x&value=${'a'.repeat(cap + 10)}`]);
      assert.deepEqual(a, [413], pathName);
      assert.equal(tree(s.root), before, pathName);
    }
  });
});

test('green: many small chunks whose sum blows the cap -> 413', async () => {
  await withServer(REPO, async (s) => {
    const a = await post(s.port, '/setting', Array.from({ length: 12 }, (_, i) => (i ? 'a'.repeat(1000) : `id=x&value=${'a'.repeat(990)}`)));
    assert.deepEqual(a, [413]);
  });
});

test('green: multi-byte characters count as bytes (5000 x 2 bytes > 8192 -> 413)', async () => {
  await withServer(REPO, async (s) => {
    const a = await post(s.port, '/setting', [`id=x&value=${'ä'.repeat(5000)}`]);
    assert.deepEqual(a, [413]);
  });
});

test('positive control: a body under the cap is read (no 413), the route limit stays', async () => {
  await withServer(REPO, async (s) => {
    const a = await post(s.port, '/setting', ['id=x&value=1']);
    assert.equal(a.length, 1);
    assert.notEqual(a[0], 413);
    const b = await post(s.port, '/inbox/reply', [`name=x&text=${'a'.repeat(9000)}`]); // above 8192, under 16384
    assert.notEqual(b[0], 413);
  });
});

test('green: the client aborts in the middle of the body -> the server stays whole and answers afterwards', async () => {
  await withServer(REPO, async (s) => {
    const before = tree(s.root);
    await new Promise((ok) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, path: '/setting', method: 'POST', headers: {
        host: `127.0.0.1:${s.port}`, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/x-www-form-urlencoded', 'transfer-encoding': 'chunked' } });
      r.on('error', () => ok());
      r.write('id=x&value=1');
      setTimeout(() => r.destroy(), 30);
    });
    await new Promise((t) => setTimeout(t, 50));
    assert.equal(tree(s.root), before);
    const a = await post(s.port, '/setting', ['id=x&value=1']);
    assert.equal(a.length, 1);
  });
});

test(`RED on the fixed old state (${OLD}): a single large chunk gets through (no 413) and characters are counted`, async (t) => {
  const old = oldState();
  if (!old) { t.skip('old commit not available in this checkout'); return; }
  await withServer(old, async (s) => {
    for (const [pathName, cap] of PLACES(s.paths)) {
      const big = await post(s.port, pathName, [`id=x&value=${'a'.repeat(cap + 10)}`]);
      assert.notEqual(big[0], 413, `old: a chunk above the cap gets through at ${pathName}`);
    }
    const chars = await post(s.port, '/setting', [`id=x&value=${'ä'.repeat(5000)}`]);
    assert.notEqual(chars[0], 413, 'old: 10 KB in bytes, but only 5000 characters');
  });
});

test('static: no place in the dashboard server reads with req.on(data) itself any more', () => {
  const source = fs.readFileSync(path.join(REPO, 'bin', 'mem-serve'), 'utf8');
  assert.equal((source.match(/req\.on\('data'/g) ?? []).length, 0);
  assert.equal((source.match(/readBoundedBody\(req/g) ?? []).length, 7);
});

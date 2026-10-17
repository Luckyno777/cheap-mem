// test/probe-post.test.mjs - the POST helper of the 413 probes (test/helpers/probe-post.mjs) survives a reset AFTER the answer.
//
// A service that refuses an over-limit body answers 413 and may cut the connection while the client still writes. The reset
// then lands on the response after its status line. A helper without an 'error' listener on the response (and one that waits
// for the response's 'end') turns the whole file red although every assertion passed. Here the cut is made on purpose by a
// raw server, so the case no longer depends on timing under load.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { probePost } from './helpers/probe-post.mjs';

/** A raw TCP server: `onData(socket)` decides what the client gets. Returns { port, close }. */
async function rawServer(onConnection, t) {
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); onConnection(s); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  return server.address().port;
}

// The status line and the first bytes of a body that is announced longer than what is sent, then the cut.
const answerThenCut = (s) => s.once('data', () => {
  s.write('HTTP/1.1 413 Payload Too Large\r\nContent-Length: 1000\r\nConnection: close\r\n\r\npart', () => s.destroy());
});

test('control: the raw server really cuts the answer short (the response never ends, it aborts)', async (t) => {
  const port = await rawServer(answerThenCut, t);
  const seen = await new Promise((resolve) => {
    const events = [];
    const q = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (r) => {
      events.push(`status:${r.statusCode}`);
      r.on('end', () => events.push('end'));
      r.on('aborted', () => events.push('aborted'));
      r.on('error', () => events.push('error'));
      r.resume();
    });
    q.on('error', () => events.push('request-error'));
    q.on('close', () => resolve(events));
    q.end('x');
  });
  assert.equal(seen[0], 'status:413', `the status line arrives: ${seen}`);
  assert.ok(!seen.includes('end'), `the response does not end normally: ${seen}`);
  assert.ok(seen.includes('aborted') || seen.includes('error'), `the cut is visible on the response (this is what an unlistened error event would break): ${seen}`);
});

test('a reset after the answer keeps the status (413) and is marked, nothing is thrown', async (t) => {
  const port = await rawServer(answerThenCut, t);
  const r = await probePost({ host: '127.0.0.1', port, path: '/' }, (q) => q.end('x'), { timeoutMs: 5000 });
  assert.equal(r.status, 413);
  assert.notEqual(r.code, 'timeout', 'it settled with the request, it did not wait for the time limit');
  assert.equal(r.resetAfterAnswer, true, 'the cut after the status line is recorded, not lost');
});

test('a reset BEFORE any answer is { status: null, code } - the code is not interpreted', async (t) => {
  const port = await rawServer((s) => s.once('data', () => s.destroy()), t);
  const r = await probePost({ host: '127.0.0.1', port, path: '/' }, (q) => q.end('x'));
  assert.equal(r.status, null);
  assert.equal(typeof r.code, 'string');
  assert.ok(r.code.length > 0);
});

test('a normal answer: status, no code, no reset', async (t) => {
  const port = await rawServer((s) => s.once('data', () => s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok')), t);
  const r = await probePost({ host: '127.0.0.1', port, path: '/' }, (q) => q.end('x'));
  assert.deepEqual(r, { status: 200, code: null, resetAfterAnswer: false });
});

test('a connection that hangs settles at the time limit', async (t) => {
  const port = await rawServer(() => {}, t);
  const t0 = Date.now();
  const r = await probePost({ host: '127.0.0.1', port, path: '/' }, (q) => q.end('x'), { timeoutMs: 200 });
  assert.equal(r.status, null);
  assert.equal(r.code, 'timeout');
  assert.ok(Date.now() - t0 < 10000, 'it did not wait for anything but the limit');
});

test('the body can be written in chunks by the caller, and a throwing writer does not leave the probe hanging', async (t) => {
  const port = await rawServer((s) => s.once('data', () => s.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')), t);
  const chunked = await probePost({ host: '127.0.0.1', port, path: '/', headers: { 'transfer-encoding': 'chunked' } }, async (q) => { q.write('a'); q.write('b'); q.end(); });
  assert.equal(chunked.status, 200);
  const throwing = await probePost({ host: '127.0.0.1', port, path: '/' }, () => { throw new Error('writer broke'); }, { timeoutMs: 300 });
  assert.equal(throwing.status, null);
  assert.equal(throwing.code, 'timeout');
});

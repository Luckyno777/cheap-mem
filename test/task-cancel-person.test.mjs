// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Fable security run 2026-10-11, ported from lucky-mem (N1, N9): cancelling a task is the same right as starting a
// `humanOnly` one. `/task/cancel` took only the bearer token, so anybody handed the link could end a task an owner
// had started (a half-finished raw delete: bytes gone, tombstone missing). Now: a password session, 403 otherwise -
// checked BEFORE the kind and the state, so the answer says nothing about what runs. And `raw-delete` is not
// cancellable at all: it frees the bytes first and then writes the tombstone, so a cancel between the two would leave
// a half state; it takes milliseconds and is safe to repeat, so it runs to its end (409 NOT_CANCELLABLE).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as tasks from '../src/tasks.mjs';
import { personCookie } from './person-session.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const DOOR = ['probe', 'cancel', String(process.pid)].join('-');
const BEARER = { authorization: `Bearer ${DOOR}` };

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cancel-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  fs.mkdirSync(path.join(r, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'cancel', participants: ['someone'], language: 'en' }));
  // enough input that `mem chain` is still running when the cancel arrives (same calibration as test/tasks.test.mjs)
  const one = Array.from({ length: 50000 }, (_, i) => JSON.stringify({
    id: `e${String(i).padStart(8, '0')}`, ts: '2026-09-27T00:00:00Z', type: 'error', title: `probe ${i}`, text: 'x'.repeat(80),
  })).join('\n');
  fs.writeFileSync(path.join(r, 'global', 'errors.jsonl'), `${one}\n`.repeat(8));
  return r;
}
// the cancelled task's child may still hold files on Windows for a moment (CI run 980: ENOTEMPTY)
const gone = (r) => removeTree(r);
async function ended(root, id) {
  for (const started = Date.now(); Date.now() - started < 20000;) {
    const b = tasks.read(root, id);
    if (b.result !== undefined || b.cancelled) return b;
    await new Promise((ok) => { setTimeout(ok, 60); });
  }
  return tasks.read(root, id);
}

async function start(root, env = {}) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', ...env,
  }, { allowWrites: true });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  };
}
const post = (s, route, body, headers) => fetch(`${s.base}${route}`, {
  method: 'POST', body, headers: { origin: s.base, 'content-type': 'application/x-www-form-urlencoded', ...headers },
});

test('tasks.cancel: without a person it refuses before looking at kind or state; with one it ends the child', async () => {
  const r = world();
  try {
    const { id } = tasks.start(r, 'integrity');
    await assert.rejects(tasks.cancel(r, 'integrity'), (e) => e.code === 'NOT_A_PERSON');
    await assert.rejects(tasks.cancel(r, 'integrity', {}), (e) => e.code === 'NOT_A_PERSON');
    await assert.rejects(tasks.cancel(r, 'integrity', { user: 'yes' }), (e) => e.code === 'NOT_A_PERSON', 'only the boolean true counts');
    // the right comes first: no word about unknown kinds or idle kinds to someone who may not cancel
    await assert.rejects(tasks.cancel(r, 'no-such-kind'), (e) => e.code === 'NOT_A_PERSON');
    await assert.rejects(tasks.cancel(r, 'export'), (e) => e.code === 'NOT_A_PERSON');
    assert.equal(tasks.read(r, id).running, true, 'the refused cancels left the task running');
    const res = await tasks.cancel(r, 'integrity', { user: true });
    assert.equal(res.reallyEnded, true);
    assert.equal((await ended(r, id)).cancelled, true);
    // a person asking about an unknown or idle kind still gets the honest codes
    await assert.rejects(tasks.cancel(r, 'no-such-kind', { user: true }), (e) => e.code === 'UNKNOWN_KIND');
    await assert.rejects(tasks.cancel(r, 'export', { user: true }), (e) => e.code === 'NOTHING_ACTIVE');
  } finally { gone(r); }
});

test('raw-delete is not cancellable: bytes first, tombstone second, a cancel between would leave half a state', async () => {
  assert.equal(tasks.KINDS['raw-delete'].interruptible, false);
  for (const [kind, spec] of Object.entries(tasks.KINDS)) if (kind !== 'raw-delete') assert.notEqual(spec.interruptible, false, kind);
  const r = world();
  try {
    await assert.rejects(tasks.cancel(r, 'raw-delete', { user: true }), (e) => e.code === 'NOT_CANCELLABLE');
    await assert.rejects(tasks.cancel(r, 'raw-delete'), (e) => e.code === 'NOT_A_PERSON', 'the right still comes first');
  } finally { gone(r); }
});

test('POST /task/cancel: the bearer token alone is refused (403) and the task of the owner keeps running', async () => {
  const r = world();
  const s = await start(r);
  try {
    const cookie = { cookie: `${personCookie(r)}; mem_k=${DOOR}` };
    const began = await post(s, '/task', 'kind=integrity', cookie);
    const body = await began.json();
    assert.equal(began.status, 201, JSON.stringify(body));
    const { id } = body;
    const bearer = await post(s, '/task/cancel', 'kind=integrity', BEARER);
    assert.equal(bearer.status, 403);
    assert.match((await bearer.json()).reason, /password session/);
    const idle = await post(s, '/task/cancel', 'kind=export', BEARER);
    assert.equal(idle.status, 403, 'no word about what runs');
    assert.equal(tasks.read(r, id).running, true, 'the owner\'s task was not touched');
    const person = await post(s, '/task/cancel', 'kind=integrity', cookie);
    assert.equal(person.status, 200, 'the signed-in person can cancel');
    assert.equal((await person.json()).reallyEnded, true);
    assert.equal((await ended(r, id)).cancelled, true);
    const raw = await post(s, '/task/cancel', 'kind=raw-delete', cookie);
    assert.equal(raw.status, 409);
    assert.match((await raw.json()).reason, /not interrupted|runs to its end/);
  } finally { await s.stop(); gone(r); }
});

test('POST /task/cancel with the login switched off cannot show a person either (403)', async () => {
  const r = world();
  const s = await start(r, { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1' });
  try {
    const began = await post(s, '/task', 'kind=integrity', BEARER);
    assert.equal(began.status, 201);
    const { id } = await began.json();
    const res = await post(s, '/task/cancel', 'kind=integrity', BEARER);
    assert.equal(res.status, 403);
    assert.equal(tasks.read(r, id).running, true);
    await tasks.cancel(r, 'integrity', { user: true }); // the test cleans up through the module
    await ended(r, id);
  } finally { await s.stop(); gone(r); }
});

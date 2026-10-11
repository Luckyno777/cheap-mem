// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Review of B7 (2026-10-11), blocker 2: the `done`, `restore` and `merge` tasks write with the human stamp
// (`human:<os-user>`). With only the bearer token that stamp is forged: a person closes an entry with
// `mem done --authority user`, and a bearer-only POST /task kind=restore brought it back to life (mem find
// found it again). They are `humanOnly` now, like `raw-delete`: 403 without a password session.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tasks from '../src/tasks.mjs';
import * as memory from '../src/memory.mjs';
import { personCookie } from './person-session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const MEM = path.join(HERE, '..', 'bin', 'mem');
const DOOR = ['probe', 'door', String(process.pid)].join('-');
const BEARER = { authorization: `Bearer ${DOOR}` };

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-b7h-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r, '--participants', 'lucky,session', '--human', 'lucky'], { encoding: 'utf8' });
  return r;
}
const cli = (root, args, env = {}) => spawnSync(process.execPath, [MEM, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, MEM_HEADLESS: '', ...env } });
async function start(root) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_TOKEN: DOOR, CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0' }, { allowWrites: true });
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }) };
}
async function waitTask(s, id, headers) {
  let st;
  for (let i = 0; i < 100; i += 1) {
    st = await (await fetch(`${s.base}/task.json?id=${id}`, { headers })).json();
    if (st.running !== true) break;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  return st;
}

test('the three kinds that write the human stamp are humanOnly', () => {
  for (const k of ['done', 'restore', 'merge', 'raw-delete']) assert.equal(tasks.KINDS[k].humanOnly, true, k);
});

test('restore: a bearer-only POST cannot bring back what a person closed; with a password session it can', async () => {
  const r = world();
  const e = memory.logEntry(r, 'decision', { title: 'Wrong plan Zebra', choice: 'Zebra', why: 'old', agent: 'session' }).entry;
  const closed = cli(r, ['done', e.id, '--why', 'user retired it', '--authority', 'user'], { CHEAP_MEM_AGENT: 'lucky' });
  assert.equal(closed.status, 0, closed.stderr);
  const found = () => cli(r, ['find', 'Zebra']).stdout.includes('Wrong plan Zebra');
  assert.equal(found(), false, 'positive control: the closed entry is out of the recall');
  const s = await start(r);
  try {
    const bearer = await fetch(`${s.base}/task`, { method: 'POST', headers: { ...BEARER, origin: s.base, accept: 'application/json' }, body: new URLSearchParams({ kind: 'restore', id: e.id, why: 'x' }) });
    assert.equal(bearer.status, 403, await bearer.text());
    assert.equal(found(), false, 'the entry came back to life through the bearer');
    const rows = memory.readLog(r, 'decision').entries.length;
    for (const body of [{ kind: 'done', id: e.id, why: 'x' }, { kind: 'merge', ids: `${e.id},${e.id}x` }]) {
      const res = await fetch(`${s.base}/task`, { method: 'POST', headers: { ...BEARER, origin: s.base, accept: 'application/json' }, body: new URLSearchParams(body) });
      assert.equal(res.status, 403, `${body.kind}: ${await res.text()}`);
    }
    assert.equal(memory.readLog(r, 'decision').entries.length, rows, 'a line was written without a session');
    const cookie = `${personCookie(r)}; mem_k=${DOOR}`;
    const ok = await fetch(`${s.base}/task`, { method: 'POST', headers: { ...BEARER, cookie, origin: s.base, accept: 'application/json' }, body: new URLSearchParams({ kind: 'restore', id: e.id, why: 'a person restores it' }) });
    const started = await ok.json();
    assert.equal(ok.status, 201, JSON.stringify(started));
    const st = await waitTask(s, started.id, { ...BEARER, cookie });
    assert.equal(st.state, 'ok', JSON.stringify(st));
    assert.equal(found(), true, 'positive control: with a session the restore works');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

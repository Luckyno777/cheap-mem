// hooks-harden-cm / D4 follow-up (lucky-mem 484e11b75): the warm recall server answers with the CALLER's switches.
//
// The finding: the server runs the same `find` handler as the direct path - but the handler reads its switches
// (MEM_RETRIEVE_REQUEST_FRAME, MEM_SEARCH_LEVERS, MEM_RETRIEVE_TIE) from `process.env`, and in a server that is
// the environment the SERVER was started with, not the one of the hook that asks. The same hook with the same
// switch answered differently with and without a server (measured 2026-10-14 on a scratch memory, "explain the
// empty query guard to me", REQUEST_FRAME=0: direct 1.7 / 1.3, server 1.8 / 1.4). The sibling house fixed the
// same class in its recall service for the request frame and the candidate cap (484e11b75).
//
// Now the client sends the values of FORWARDED_ENV (null for a switch it does not have), the server evaluates the
// question under that environment, and a switch that shapes the INDEX itself (MEM_EXPAND) cannot be overridden per
// call: a different value is refused, the hook then asks the direct path (always right).
//
// RED: with the base `find` handler and server the answers differ (the first test fails there); POSITIVE
// CONTROL: the switch really changes the direct answer, else equality would prove nothing.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as place from '../src/recallserver-place.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const CLIENT = path.join(CODE, 'bin', 'mem-retrieve-client.mjs');
const QUESTION = 'explain the empty query guard to me';

function world(t) {
  const root = tempDir('cm-rsenv-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  memory.logEntry(root, 'error', { class: 'mishandling', title: 'search breaks on empty query', text: 'The search module throws when the query string is empty; add a guard in the search entry point before tokenizing' });
  memory.logEntry(root, 'learning', { title: 'empty query guard', learning: 'Guard empty queries at the search entry point instead of inside the tokenizer' });
  memory.logEntry(root, 'decision', { topic: 'search', choice: 'keep BM25 lanes', why: 'measured better than embeddings for short queries' });
  return root;
}

/** The answer without its clock: `ms` is how long this call took, not part of the answer. */
const norm = (text) => { const j = JSON.parse(text); delete j.ms; return j; };

/** The direct path: `mem find --recall --json` under exactly this environment. */
function direct(root, env = {}) {
  const e = { ...process.env, CHEAP_MEM_ROOT: root, MEM_RECALL_SERVER: '0', ...env };
  for (const k of place.FORWARDED_ENV ?? []) if (!(k in env)) delete e[k];
  const r = spawnSync(process.execPath, [MEM, 'find', QUESTION, '--top', '5', '--recall', '--json'], { encoding: 'utf8', env: e });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

async function startServer(root, env = {}) {
  const kid = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileURL(path.join(CODE, 'src', 'recallserver.mjs')).href)}).then((r) => r.start(${JSON.stringify(root)}))
      .then((x) => {
        if (!x.running) process.exit(1);
        const stop = () => x.close().then(() => process.exit(0));
        process.on('SIGTERM', stop);
        process.on('message', (m) => { if (m === 'stop') stop(); });
      });
  `], { env: { ...process.env, CHEAP_MEM_ROOT: root, ...env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let err = '';
  kid.stderr.on('data', (s) => { err += s; });
  const until = Date.now() + 15000;
  while (!/listening on/.test(err) && Date.now() < until && kid.exitCode == null) await new Promise((r) => setTimeout(r, 25));
  assert.ok(/listening on/.test(err), `server not listening: ${err}`);
  const stop = async () => {
    if (kid.exitCode != null) return;
    const gone = new Promise((r) => kid.once('exit', r));
    if (process.platform === 'win32') kid.send('stop'); else kid.kill('SIGTERM');
    await gone;
  };
  return { stop };
}

function client(root, env = {}) {
  return new Promise((resolve) => {
    const e = { ...process.env, MEM_HOOK_START_MS: String(Date.now()), ...env };
    for (const k of ['MEM_RETRIEVE_REQUEST_FRAME', 'MEM_SEARCH_LEVERS', 'MEM_RETRIEVE_TIE', 'MEM_EXPAND']) if (!(k in env)) delete e[k];
    const k = spawn(process.execPath, [CLIENT, root, QUESTION, '5'], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    k.stdout.on('data', (s) => { out += s; });
    k.on('exit', (code) => resolve({ code, out }));
  });
}

test('POSITIVE CONTROL: the request-frame switch really changes the direct answer on this memory', (t) => {
  const root = world(t);
  const on = direct(root, { MEM_RETRIEVE_REQUEST_FRAME: '1' });
  const off = direct(root, { MEM_RETRIEVE_REQUEST_FRAME: '0' });
  assert.notDeepEqual(norm(on), norm(off), 'the switch changes nothing here - the probe below would prove nothing');
});

test('RED/GREEN: a server started WITHOUT the switch answers a client that has it exactly like the direct path, and the other way round', async (t) => {
  const root = world(t);
  const plain = await startServer(root);
  t.after(() => plain.stop());
  for (const frame of ['0', '1']) {
    const want = direct(root, { MEM_RETRIEVE_REQUEST_FRAME: frame });
    const got = await client(root, { MEM_RETRIEVE_REQUEST_FRAME: frame });
    assert.equal(got.code, 0);
    assert.deepEqual(norm(got.out), norm(want), `frame=${frame}: the server did not follow the caller's switch`);
  }
  await plain.stop();

  // The server HAS the switch (0), the caller has none: the caller's absence wins, as in the direct path.
  const odd = await startServer(root, { MEM_RETRIEVE_REQUEST_FRAME: '0' });
  t.after(() => odd.stop());
  const got = await client(root, {});
  assert.equal(got.code, 0);
  assert.deepEqual(norm(got.out), norm(direct(root, {})), 'a switch the server was started with leaked into an answer for a caller without it');
});

test('the other forwarded switches (levers, tie cut) follow the caller too', async (t) => {
  const root = world(t);
  const srv = await startServer(root, { MEM_SEARCH_LEVERS: 'all', MEM_RETRIEVE_TIE: '0.5' });
  t.after(() => srv.stop());
  for (const env of [{}, { MEM_SEARCH_LEVERS: 'off' }, { MEM_RETRIEVE_TIE: '0.01' }, { MEM_SEARCH_LEVERS: 'all', MEM_RETRIEVE_TIE: '0.5' }]) {
    const got = await client(root, env);
    assert.equal(got.code, 0, JSON.stringify(env));
    assert.deepEqual(norm(got.out), norm(direct(root, env)), JSON.stringify(env));
  }
});

test('MEM_EXPAND shapes the index: a different value than the server\'s is REFUSED (the hook then goes direct), the same value is answered', async (t) => {
  const root = world(t);
  const srv = await startServer(root);
  t.after(() => srv.stop());
  const refused = await client(root, { MEM_EXPAND: '1' });
  assert.equal(refused.code, place.CLIENT_RC.REFUSED);
  assert.equal(refused.out, '', 'a refused question must not print anything');
  const same = await client(root, {});
  assert.equal(same.code, 0);
  await srv.stop();
  const expanded = await startServer(root, { MEM_EXPAND: '1' });
  t.after(() => expanded.stop());
  assert.equal((await client(root, { MEM_EXPAND: '1' })).code, 0, 'same value, expansion on both sides');
  assert.equal((await client(root, {})).code, place.CLIENT_RC.REFUSED, 'server expands, caller does not');
});

test('an older client (no environment in the request) is still answered, as before', async (t) => {
  const root = world(t);
  const srv = await startServer(root);
  t.after(() => srv.stop());
  const where = place.place(root, process.env);
  const key = fs.readFileSync(where.key, 'utf8').trim();
  const reply = await new Promise((resolve, reject) => {
    const sock = net.connect(where.socket);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ v: place.VERSION, key, root, query: QUESTION, top: '5', deadline_ms: Date.now() + 10000 })}\n`));
    sock.on('data', (s) => { buf += s; });
    sock.on('end', () => resolve(JSON.parse(buf)));
    sock.on('error', reject);
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(norm(reply.stdout), norm(direct(root, {})));
});

test('the allowlist is the set of switches the find handler reads from the environment', () => {
  const src = fs.readFileSync(path.join(CODE, 'src', 'cli', 'commands', 'search.mjs'), 'utf8');
  // Every env switch the find handler consults is either forwarded or shapes the index (refused when different).
  const read = new Set([...src.matchAll(/(requestFrameOn|tieSpread|levers\.active)\(([^)]*)\)/g)].map((m) => m[1]));
  assert.ok(read.has('requestFrameOn') && read.has('tieSpread') && read.has('levers.active'), 'the reader found no switch read - the probe is blind');
  for (const m of src.matchAll(/(requestFrameOn|tieSpread)\(([^)]*)\)/g)) assert.ok(/env/.test(m[2]), `${m[0]} reads process.env, not the caller's environment`);
  for (const m of src.matchAll(/levers\.active\('h[13]'([^)]*)\)/g)) assert.ok(/env/.test(m[1]), `${m[0]} reads process.env, not the caller's environment`);
  assert.deepEqual([...place.FORWARDED_ENV].sort(), ['MEM_RETRIEVE_REQUEST_FRAME', 'MEM_RETRIEVE_TIE', 'MEM_SEARCH_LEVERS']);
  assert.deepEqual([...place.INDEX_ENV], ['MEM_EXPAND']);
});

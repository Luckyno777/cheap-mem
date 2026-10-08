// M10 (2026-09-30): warm recall through a locally running server.
//
// One probe each:
//   1. The server delivers the SAME as the direct path (O1: the same
//      `find` handler), and the journal books the path (positive
//      control: `path: server` — otherwise equality would be trivial).
//   2. Server dead, socket file still there -> direct, reason booked.
//   3. Server hangs -> direct, TOTAL time stays inside the ONE budget.
//   4. New entry after the start -> the server delivers the new state.
//   5. Code changed -> the server answers `stale`, never old results.
//   6. Strangers get nothing: wrong key refused (and nothing searched),
//      modes 0700/0600, and another user (setpriv, root only) fails.
//   7. No server socket: the path from before M10.
// Red proof: at START_COMMIT the hook has no server path and the journal
// has no `path` field (pinned hash, never merge-base — rule 12).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as place from '../src/recallserver-place.mjs';
import * as recallserver from '../src/recallserver.mjs';
import * as keeper from '../src/recallserver-keeper.mjs';
import * as injection from '../src/injection.mjs';

const START_COMMIT = 'e474505';
const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const HOOK = path.join(CODE, 'bin', 'mem-retrieve');
const CLIENT = path.join(CODE, 'bin', 'mem-retrieve-client.mjs');
const PROMPT = 'the lockfile race where two test runs overwrote the same lock file';

const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-m10-'));
  made.push(root);
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  execFileSync('node', [MEM, '--root', root, 'log', 'error', '--title', 'lockfile race - two runs overwrote it',
    '--text', 'the probe failed because two test runs overwrote the same lock file at once', '--class', 'concurrency'], { stdio: 'ignore' });
  return root;
}

function hook(root, session, extra = {}, prompt = PROMPT) {
  const t0 = Date.now();
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: session, prompt }),
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_MIN: '0.1',
      MEM_RETRIEVE_NO_PULL: '1', MEM_HOOK_OFF: '', ...extra },
  });
  return { out: String(r.stdout ?? ''), status: r.status, ms: Date.now() - t0, stderr: String(r.stderr ?? '') };
}

const lines = (root) => injection.read(root).lines.filter((l) => l.occasion === 'question');

async function startServer(root, env = {}) {
  const kid = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileURL(path.join(CODE, 'src', 'recallserver.mjs')).href)}).then((r) => r.start(${JSON.stringify(root)}))
      .then((x) => {
        if (!x.running) process.exit(1);
        const stop = () => x.close().then(() => process.exit(0));
        process.on('SIGTERM', stop);
        process.on('message', (m) => { if (m === 'stop') stop(); });
      });
  `], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let err = '';
  kid.stderr.on('data', (s) => { err += s; });
  const until = Date.now() + 15000;
  while (!/listening on/.test(err) && Date.now() < until && kid.exitCode == null) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const sock = place.place(root, env).listed;
  assert.ok(fs.existsSync(sock), `server not listening: ${err}`);
  // 'SIGTERM' is the real signal everywhere it exists. On Windows `kill('SIGTERM')` is a hard
  // TerminateProcess: no handler runs, so nothing could be said about close(). There (and for
  // the 'message' mode, driven on every platform) the same graceful close() is asked for over
  // the IPC channel; 'SIGKILL' stays a hard kill on every platform.
  const stop = async (signal = 'SIGTERM') => {
    if (kid.exitCode != null) return;
    const gone = new Promise((r) => kid.once('exit', r));
    if (signal === 'message' || (signal === 'SIGTERM' && process.platform === 'win32')) kid.send('stop');
    else kid.kill(signal);
    await gone;
  };
  return { sock, stop };
}

function clientAsync(root, env = {}) {
  return new Promise((resolve) => {
    const k = spawn(process.execPath, [CLIENT, root, PROMPT, '3'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    k.stdout.on('data', (s) => { out += s; });
    k.on('exit', (code) => resolve({ code, out }));
  });
}

test('red proof: the start commit has no server path and no journal path field', (t) => {
  let src;
  try { src = execFileSync('git', ['show', `${START_COMMIT}:bin/mem-retrieve`], { encoding: 'utf8', stdio: 'pipe' }); }
  catch { t.skip('start commit not in this clone - unknown, not green'); return; }
  assert.ok(!/mem-retrieve-client/.test(src));
  const inj = execFileSync('git', ['show', `${START_COMMIT}:src/injection.mjs`], { encoding: 'utf8' });
  assert.ok(!/path_reason/.test(inj));
});

test('M10-1: the server delivers the same as the direct path, the journal books the path', async () => {
  const root = build();
  const direct = hook(root, 's-direct');
  assert.match(direct.out, /Recalled automatically/, direct.stderr);
  const s = await startServer(root);
  try {
    const warm = hook(root, 's-warm');
    assert.equal(warm.out, direct.out, 'the server delivers byte for byte what the direct path delivers');
    const l = lines(root);
    assert.equal(l.length, 2, JSON.stringify(l));
    assert.equal(l[0].path, 'direct');
    assert.equal(l[0].path_reason, null);
    assert.equal(l[1].path, 'server', 'positive control: the second answer really came from the server');
    assert.equal(l[1].path_reason, null);
    assert.deepEqual(l[1].sources, l[0].sources);
    assert.ok(Number.isFinite(l[1].duration_ms), 'duration_ms is measured');
  } finally { await s.stop(); }
  assert.equal(fs.existsSync(s.sock), false, 'after SIGTERM the server removes its socket');
});

test('M10-1b: a graceful stop over the message channel (the way Windows takes) removes the socket or marker too', async () => {
  const root = build();
  const s = await startServer(root);
  assert.ok(fs.existsSync(s.sock), 'positive control: the listed file is there while the server runs');
  await s.stop('message');
  assert.equal(fs.existsSync(s.sock), false, 'after a graceful stop the listed file is gone');
});

test('M10-2: server dead, socket still there -> direct, reason server-gone', async () => {
  const root = build();
  const direct = hook(root, 's-a');
  const s = await startServer(root);
  await s.stop('SIGKILL');
  assert.ok(fs.existsSync(s.sock), 'precondition: a dead server leaves its socket file');
  const r = hook(root, 's-b');
  assert.equal(r.out, direct.out);
  const l = lines(root);
  assert.equal(l[1].path, 'direct');
  assert.equal(l[1].path_reason, 'server-gone');
});

test('M10-3: server hangs -> direct, total time stays inside the ONE budget', async () => {
  const root = build();
  const direct = hook(root, 's-a');
  const w = place.place(root, {});
  fs.mkdirSync(w.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(w.key, 'x'.repeat(64), { mode: 0o600 });
  // Accepts connections (the kernel does, through the backlog, while
  // spawnSync blocks this loop) and never answers.
  const hang = net.createServer(() => {});
  await new Promise((r) => hang.listen(w.socket, r));
  if (w.marker) fs.writeFileSync(w.marker, `${w.socket}\n`); // Windows: a pipe is no file, the marker is what the hook sees
  try {
    const r = hook(root, 's-b', { MEM_RETRIEVE_TIME: '3', MEM_RECALL_SERVER_WAIT_MS: '60000' });
    assert.equal(r.out, direct.out, 'after the hang the direct path delivers');
    // The prompt/session parsing before the search is outside the search
    // budget (as before M10); a second full cap would be >= 6 s.
    assert.ok(r.ms < 4500, `total ${r.ms} ms`);
    const l = lines(root);
    assert.equal(l[1].path, 'direct');
    assert.equal(l[1].path_reason, 'server-timeout');
  } finally { await new Promise((r) => hang.close(r)); }
});

test('M10-4: a new entry after the start -> the server delivers the new state', async () => {
  const root = build();
  const s = await startServer(root);
  try {
    const q = 'how do we settle the zebrafinch swirl in the mirror hall';
    const before = hook(root, 's-1', {}, q);
    assert.doesNotMatch(before.out, /zebrafinch/i);
    execFileSync('node', [MEM, '--root', root, 'log', 'error', '--title', 'zebrafinch swirl in the mirror hall',
      '--text', 'the mirror hall swirls when the zebrafinch starts twice', '--class', 'concurrency'], { stdio: 'ignore' });
    const after = hook(root, 's-2', {}, q);
    assert.match(after.out, /zebrafinch/i, 'the server sees the new entry');
    assert.equal(lines(root).at(-1).path, 'server', 'positive control: the fresh answer came from the server');
  } finally { await s.stop(); }
});

test('M10-5: code changed -> the server answers stale, the client delivers nothing', async () => {
  const root = build();
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-m10-code-'));
  made.push(code);
  fs.mkdirSync(path.join(code, 'src'), { recursive: true });
  fs.writeFileSync(path.join(code, 'src', 'a.mjs'), 'export const a = 1;\n');
  const s = await recallserver.start(root, { env: {}, codeRoot: code, log: () => {} });
  assert.equal(s.running, true);
  try {
    const good = await clientAsync(root);
    assert.equal(good.code, place.CLIENT_RC.OK, 'positive control: before the change the server answers');
    assert.match(good.out, /"hits"/);
    fs.writeFileSync(path.join(code, 'src', 'a.mjs'), 'export const a = 22;\n');
    const old = await clientAsync(root);
    assert.equal(old.code, place.CLIENT_RC.STALE);
    assert.equal(old.out, '', 'stale means: NOTHING delivered, never old results');
    // And afterwards it no longer listens: without a socket the hook never asks it again.
    const until = Date.now() + 2000;
    while (fs.existsSync(s.where.listed) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.equal(fs.existsSync(s.where.listed), false, 'a stale server removes its socket');
  } finally { await s.close(); }
});

test('M10-6: strangers get nothing (key, modes, another user)', async (t) => {
  const root = build();
  const s = await startServer(root);
  try {
    const w = place.place(root, {});
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(w.dir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(w.socket).mode & 0o777, 0o600);
      assert.equal(fs.statSync(w.key).mode & 0o777, 0o600);
    } else {
      // No POSIX modes on Windows (UNVERIFIED there): the docs must say so; the key remains the guard.
      const doc = fs.readFileSync(path.join(CODE, 'docs', 'dashboard.md'), 'utf8');
      assert.match(doc, /Windows POSIX modes\s+mean nothing and cannot be checked|On Windows POSIX modes\s+mean nothing and cannot be checked/);
      process.stderr.write('NOTICE: recall dir/key modes not asserted on Windows; docs say they cannot be checked\n');
    }
    const ign = spawnSync('git', ['-C', CODE, 'check-ignore', '-q', '.pipeline/recall/key']);
    assert.equal(ign.status, 0, '.pipeline/recall is gitignored');

    const answer = await new Promise((resolve) => {
      const c = net.connect(w.socket);
      let a = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write(`${JSON.stringify({ v: place.VERSION, key: 'wrong', root, query: PROMPT, top: 3 })}\n`));
      c.on('data', (x) => { a += x; });
      c.on('end', () => resolve(JSON.parse(a)));
    });
    assert.equal(answer.ok, false);
    assert.equal(answer.reason, 'refused');
    assert.equal('stdout' in answer, false, 'a refused call carries no search result');

    const setpriv = spawnSync('sh', ['-c', 'command -v setpriv']).status === 0;
    if (typeof process.getuid !== 'function' || process.getuid() !== 0 || !setpriv) {
      t.diagnostic('another user: skipped (not root or no setpriv)');
      return;
    }
    const other = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, '-e', `
      const net = require('node:net'); const fs = require('node:fs');
      let k = 'readable'; try { fs.readFileSync(${JSON.stringify(w.key)}); } catch (e) { k = e.code; }
      const c = net.connect(${JSON.stringify(w.socket)});
      c.on('connect', () => { console.log('CONNECTED ' + k); process.exit(0); });
      c.on('error', (e) => { console.log(e.code + ' ' + k); process.exit(0); });
    `], { encoding: 'utf8', cwd: '/', timeout: 10000 });
    assert.match(other.stdout, /^EACCES EACCES/, `another user: ${other.stdout} ${other.stderr}`);
  } finally { await s.stop(); }
});

test('M10-7: without a server socket the path from before M10 runs', () => {
  const root = build();
  // A plain FILE at the socket place is no server: `[ -S ]` says no.
  const w = place.place(root, {});
  fs.mkdirSync(w.dir, { recursive: true });
  if (!w.marker) fs.writeFileSync(w.socket, ''); // Windows: no marker, no server (a pipe path cannot be written as a file)
  const r = hook(root, 's-a');
  assert.match(r.out, /Recalled automatically/);
  const l = lines(root);
  assert.equal(l[0].path, 'direct');
  assert.equal(l[0].path_reason, null, 'no server asked: no reason');
});

test('M10-7b: MEM_RECALL_SERVER=0 does not ask even a live server', async () => {
  const root = build();
  const s = await startServer(root);
  try {
    hook(root, 's-a', { MEM_RECALL_SERVER: '0' });
    const l = lines(root);
    assert.equal(l[0].path, 'direct');
    assert.equal(l[0].path_reason, null);
  } finally { await s.stop(); }
});

test('M10-8: the journal vocabulary is closed', () => {
  assert.deepEqual(Object.values(injection.PATH).sort(), ['direct', 'server']);
  assert.deepEqual(Object.values(injection.PATH_REASON).sort(),
    ['server-error', 'server-gone', 'server-refused', 'server-stale', 'server-timeout']);
  assert.equal(injection.buildLine({ recallPath: 'sideways' }).path, 'unknown');
  assert.equal(injection.buildLine({ recallPath: 'direct', pathReason: 'made-up' }).path_reason, 'unknown');
  const other = JSON.parse(JSON.stringify(injection.buildLine({ occasion: 'question' })));
  assert.equal('path' in other, false, 'writers other than the recall hook stay byte-identical');
  assert.equal('path_reason' in other, false);
});

test('M10-9: a question whose client already gave up is skipped, not searched', async () => {
  const root = build();
  // A fixed code state of its own: this probe is about deadlines, not code
  // state. Watching the package's src/ made it answer "stale" once in the
  // full suite (chain run 2026-10-01), which says nothing about deadlines.
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-m10-code-'));
  made.push(code);
  fs.mkdirSync(path.join(code, 'src'), { recursive: true });
  fs.writeFileSync(path.join(code, 'src', 'a.mjs'), 'export const a = 1;\n');
  const s = await recallserver.start(root, { env: {}, codeRoot: code, log: () => {} });
  try {
    const key = fs.readFileSync(s.where.key, 'utf8');
    const ask = (deadline) => new Promise((resolve) => {
      const c = net.connect(s.where.socket);
      let a = '';
      c.setEncoding('utf8');
      c.on('connect', () => c.write(`${JSON.stringify({ v: place.VERSION, key, root, query: PROMPT, top: 3, deadline_ms: deadline })}\n`));
      c.on('data', (x) => { a += x; });
      c.on('end', () => resolve(JSON.parse(a)));
    });
    const late = await ask(Date.now() - 1);
    assert.equal(late.ok, false);
    assert.equal(late.reason, 'timeout');
    assert.equal('stdout' in late, false, 'skipped: no search result');
    // Positive control: the same question inside its deadline is answered.
    const inTime = await ask(Date.now() + 10000);
    assert.equal(inTime.ok, true);
    assert.match(inTime.stdout, /"hits"/);
  } finally { await s.close(); }
});

function hookAsync(root, session, extra = {}) {
  return new Promise((resolve) => {
    const k = spawn('bash', [HOOK], {
      env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_MIN: '0.1',
        MEM_RETRIEVE_NO_PULL: '1', MEM_HOOK_OFF: '', ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    k.stdout.on('data', (x) => { out += x; });
    k.on('exit', (status) => resolve({ out, status }));
    k.stdin.end(JSON.stringify({ session_id: session, prompt: PROMPT }));
  });
}

test('M10-10: code change -> stale -> the server restarts itself, the rate limit holds', async () => {
  const root = build();
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-m10-code-'));
  made.push(code);
  fs.mkdirSync(path.join(code, 'src'), { recursive: true });
  const file = path.join(code, 'src', 'a.mjs');
  fs.writeFileSync(file, 'export const a = 1;\n');
  const said = [];
  const GAP = 2000;
  // **The keeper's clock stands still until the probe advances it (chain,
  // 2026-10-07).** With the wall clock the rate limit only bit if the new
  // server reported the next change less than GAP after its start. Under load
  // the start takes longer than 2 s; the gap has then already passed, the
  // "restart in N s" line never comes, and the probe went red although the
  // keeper works. Now the rate limit is a matter of the clock, not of the
  // machine: the probe advances the clock by exactly GAP and waits on events
  // (log line, start), not on ticks.
  let clock = 1_000_000;
  const k = keeper.keep(root, {
    env: { ...process.env, MEM_RECALL_SERVER_CODE_STATE: code, MEM_RECALL_SERVER_RESTART_MS: String(GAP) },
    log: (t) => said.push(t),
    now: () => clock,
  });
  const sock = place.place(root, {}).listed;
  const until = async (f) => {
    const end = Date.now() + 15000;
    while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return f();
  };
  const waitSocket = () => until(() => fs.existsSync(sock));
  const limitLines = (n) => said.filter((t) => /restart in \d+ s/.test(t)).length >= n;
  try {
    assert.ok(await waitSocket(), 'the first start listens');
    await hookAsync(root, 's-1');
    assert.equal(lines(root).at(-1).path, 'server');

    fs.writeFileSync(file, 'export const a = 22;\n');
    const r2 = await hookAsync(root, 's-2');
    assert.match(r2.out, /Recalled automatically/, 'the stale turn is answered direct');
    assert.equal(lines(root).at(-1).path, 'direct');
    assert.equal(lines(root).at(-1).path_reason, 'server-stale');
    // ... the keeper holds the restart back until the clock is GAP further ...
    assert.ok(await until(() => limitLines(1)), `no rate-limit line for change 1: ${said.join(' | ')}`);
    assert.equal(k.starts.length, 1, 'no second start before the gap has passed');
    clock += GAP;
    // ... and then, without a manual step, a server with the new state listens again.
    assert.ok(await until(() => k.starts.length >= 2), `second start missing: ${said.join(' | ')}`);
    assert.ok(await waitSocket(), 'after the restart a server listens again');
    await hookAsync(root, 's-3');
    assert.equal(lines(root).at(-1).path, 'server', 'warm again, no manual step');

    // Rate limit: the next change right away - the third start does not come
    // before GAP after the second (the clock stands still, so surely not).
    fs.writeFileSync(file, 'export const a = 333;\n');
    await hookAsync(root, 's-4');
    assert.ok(await until(() => limitLines(2)), `no rate-limit line for change 2: ${said.join(' | ')}`);
    assert.equal(k.starts.length, 2, 'the rate limit holds the third start back');
    clock += GAP;
    assert.ok(await until(() => k.starts.length >= 3), `third start missing: ${said.join(' | ')}`);
    assert.ok(k.starts[2] - k.starts[1] >= GAP, `gap ${k.starts[2] - k.starts[1]} ms < ${GAP}`);
    assert.ok(said.some((t) => /restart \(code under src\/ changed\)/.test(t)), 'a log line for the restart');
  } finally { await k.stop(); }
});

test('M10-9: simulated win32 place: a pipe plus a marker FILE the hook can see (UNVERIFIED on real Windows)', () => {
  const w = place.place('/some/root', {}, 'win32');
  assert.match(w.socket, /^\\\\\.\\pipe\\cheap-mem-recall-[0-9a-f]{16}$/);
  assert.equal(path.basename(w.marker), place.MARKER_NAME);
  assert.equal(w.listed, w.marker, 'the hook looks at the marker, never at the pipe path');
  const p = place.place('/some/root', {}, 'linux');
  assert.equal(p.marker, null);
  assert.equal(p.listed, p.socket);
  // the hook's gate accepts the marker (bash side)
  assert.match(fs.readFileSync(path.join(CODE, 'bin', 'mem-retrieve'), 'utf8'), /-f "\$RECALL_DIR\/recall\.pipe"/);
});

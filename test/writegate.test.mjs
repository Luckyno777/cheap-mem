// test/writegate.test.mjs — the dashboard write switch (2026-09-27).
//
// Decision: an open-source dashboard writes nothing before its owner
// allows it. `bin/mem-serve` now refuses every writing route unless
// `dashboard.allowWrites` is true in `.mem/config.json` or the server
// runs with `mem serve --allow-writes`. See `src/writegate.mjs`.
//
// **The HTTP probes import only `bin/mem-serve`, never the new module.**
// They were run against the tree BEFORE the switch (a detached worktree
// of the base commit) and went red there — a POST wrote — which is what
// makes their green here mean something. The module-level four-state
// probes import `src/writegate.mjs` lazily, inside the test, so a
// missing module fails those tests only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const MEM = path.join(HERE, '..', 'bin', 'mem');
const WRITEGATE = path.join(HERE, '..', 'src', 'writegate.mjs');

const DOOR = ['probe', 'door', String(process.pid)].join('-');
const WITH_DOOR = { authorization: `Bearer ${DOOR}` };

/** The routes that write, as the old server had them — hand-listed ON
 * PURPOSE for the red run (the old server exports no `WRITE_PATHS`);
 * the inventory probe below pins this list against the server's own. */
const WRITES = [
  ['/setting', 'id=error-window&value=30&from=%2F'],
  ['/task', 'kind=integrity'],
  ['/task/cancel', 'kind=integrity'],
  // P1b: replying from the inbox. The switch refuses before the body
  // is read, so the name need not exist for these probes.
  ['/inbox/reply', 'name=none.md&text=hello&from=%2F'],
  // Acknowledging a message from the dashboard (2026-09-28).
  ['/inbox/state', 'name=none.md&state=done'],
];

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-writegate-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}
function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

function setSwitch(root, value) {
  const file = path.join(root, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value === undefined) delete cfg.dashboard;
  else cfg.dashboard = { allowWrites: value };
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Every file below root (without .git) with its content hash. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(root, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(root);
  return out;
}

async function start(root, env = {}, opts = undefined) {
  const mod = await import(`${pathToFileURL(SERVE).href}?t=${Math.random()}`);
  const { server, cfg } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR,
    CHEAP_MEM_SERVE_HOST: '127.0.0.1',
    CHEAP_MEM_SERVE_PORT: '0',
    ...env,
  }, opts);
  return {
    mod,
    cfg,
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

function post(s, route, body) {
  return fetch(`${s.base}${route}`, {
    method: 'POST', redirect: 'manual',
    headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function waitIdle(s) {
  const t0 = Date.now();
  for (;;) {
    const o = await (await fetch(`${s.base}/task.json`, { headers: WITH_DOOR })).json();
    if (!Object.values(o.running).some((t) => t?.running === true)) return;
    if (Date.now() - t0 > 20000) throw new Error('timed out waiting for tasks');
    await new Promise((ok) => { setTimeout(ok, 60); });
  }
}

// ---------------------------------------------------------------------------
// Off by default: every writing route refuses, and nothing is written
// ---------------------------------------------------------------------------

test('DEFAULT OFF: every writing route answers 403 with the way to turn it on, and writes nothing', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const before = snapshot(r);
    for (const [route, body] of WRITES) {
      const res = await post(s, route, body);
      const text = await res.text();
      assert.equal(res.status, 403, `${route} was not refused with the switch off (got ${res.status})`);
      assert.match(text, /--allow-writes/, `${route}: the refusal does not say how to turn it on`);
      assert.match(text, /allowWrites/, `${route}: the refusal does not name the config key`);
    }
    assert.deepEqual(snapshot(r), before, 'a refused POST changed a file');
  } finally { await s.stop(); gone(r); }
});

test('DEFAULT OFF: an explicit false and an unrecognised value refuse the same way', async () => {
  for (const value of [false, 'yes', 1]) {
    const r = memory();
    setSwitch(r, value);
    const s = await start(r);
    try {
      const before = snapshot(r);
      for (const [route, body] of WRITES) {
        const res = await post(s, route, body);
        assert.equal(res.status, 403, `${route} with allowWrites=${JSON.stringify(value)}`);
      }
      assert.deepEqual(snapshot(r), before);
    } finally { await s.stop(); gone(r); }
  }
});

test('a broken .mem/config.json keeps writing off (fail closed)', async () => {
  const r = memory();
  const s = await start(r);
  try {
    fs.writeFileSync(path.join(r, '.mem', 'config.json'), '{ not json');
    const before = snapshot(r);
    const res = await post(s, '/setting', 'id=error-window&value=30');
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not valid JSON/);
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// Positive controls: switched on, writing really works
// ---------------------------------------------------------------------------

test('POSITIVE: allowWrites=true in .mem/config.json lets /setting write', async () => {
  const r = memory();
  setSwitch(r, true);
  const s = await start(r);
  try {
    const res = await post(s, '/setting', 'id=error-window&value=30&from=%2F');
    assert.equal(res.status, 303);
    const state = JSON.parse(fs.readFileSync(path.join(r, '.mem', 'console.json'), 'utf8'));
    assert.equal(state.errorWindow, 30);
  } finally { await s.stop(); gone(r); }
});

test('POSITIVE: --allow-writes (one run) lets /task start and /task/cancel answer', async () => {
  const r = memory();
  const s = await start(r, {}, { allowWrites: true });
  try {
    const res = await post(s, '/task', 'kind=integrity');
    assert.equal(res.status, 201, await res.text());
    await waitIdle(s);
    const c = await post(s, '/task/cancel', 'kind=integrity');
    assert.equal(c.status, 409, 'cancel with nothing running: reached the route, not the switch');
    // One run means one run: nothing was written down.
    const cfg = JSON.parse(fs.readFileSync(path.join(r, '.mem', 'config.json'), 'utf8'));
    assert.equal(cfg.dashboard, undefined, 'the flag was persisted into the config');
  } finally { await s.stop(); gone(r); }
});

test('READONLY still wins over the switch and the flag', async () => {
  const r = memory();
  setSwitch(r, true);
  const s = await start(r, { CHEAP_MEM_SERVE_READONLY: '1' }, { allowWrites: true });
  try {
    const before = snapshot(r);
    for (const [route, body] of WRITES) {
      assert.equal((await post(s, route, body)).status, 403, route);
    }
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

test('Origin and Host latches stay in force with the switch on', async () => {
  const r = memory();
  const s = await start(r, {}, { allowWrites: true });
  try {
    const before = snapshot(r);
    const foreign = await fetch(`${s.base}/setting`, {
      method: 'POST', redirect: 'manual',
      headers: { ...WITH_DOOR, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=error-window&value=30',
    });
    assert.equal(foreign.status, 403);
    assert.match(await foreign.text(), /origin/i);
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// The dashboard cannot turn itself on
// ---------------------------------------------------------------------------

test('the dashboard cannot flip its own switch: no /setting id reaches .mem/config.json', async () => {
  const r = memory();
  const s = await start(r, {}, { allowWrites: true });
  const cfgFile = path.join(r, '.mem', 'config.json');
  try {
    const before = fs.readFileSync(cfgFile);
    const consolePage = await import(pathToFileURL(path.join(HERE, '..', 'src', 'console.mjs')).href);
    const ids = [...Object.keys(consolePage.SETTINGS),
      'dashboard.allowWrites', 'allowWrites', 'dashboard', 'allow-writes', 'writes'];
    for (const id of ids) {
      for (const value of ['true', '1', '{"allowWrites":true}']) {
        await post(s, '/setting', `id=${encodeURIComponent(id)}&value=${encodeURIComponent(value)}`);
      }
    }
    assert.deepEqual(fs.readFileSync(cfgFile), before, 'a /setting POST changed .mem/config.json');
    // And the switch, read without the flag, is still off.
    const s2 = await start(r);
    try {
      const res = await post(s2, '/setting', 'id=error-window&value=40');
      assert.equal(res.status, 403, 'after the attempts, a server without the flag writes');
    } finally { await s2.stop(); }
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// The pages: buttons disabled, the way to turn it on said in words
// ---------------------------------------------------------------------------

// The dashboard draws its controls in the browser; what the server
// decides is carried in /dashboard.json and on <body data-writes>.
const SCRIPT = fs.readFileSync(path.join(HERE, '..', 'assets', 'dashboard', 'dashboard.js'), 'utf8');

test('UI: with the switch off, the dashboard disables every control and says how to turn it on', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.match(page, /<body data-writes="0"/);
    const d = await (await fetch(`${s.base}/dashboard.json`, { headers: WITH_DOOR })).json();
    assert.equal(d.meta.writesAllowed, false);
    assert.equal(d.meta.writes.state, 'off');
    assert.match(d.meta.writes.howTo, /mem serve --allow-writes/, 'the one-run way is not named');
    assert.match(d.meta.writes.howTo, /allowWrites/, 'the config key is not named');
    // The script: no server switch -> read only, and the settings panel
    // prints the how-to next to the reason.
    assert.match(SCRIPT, /if \(!serverWrites\) state\.readonly = true;/);
    assert.match(SCRIPT, /\$\{w\.howTo \? ' ' \+ esc\(w\.howTo\) : ''\}/);
  } finally { await s.stop(); gone(r); }
});

test('UI POSITIVE: with the switch on, the controls are enabled', async () => {
  const r = memory();
  setSwitch(r, true);
  const s = await start(r);
  try {
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.match(page, /<body data-writes="1"/);
    const d = await (await fetch(`${s.base}/dashboard.json`, { headers: WITH_DOOR })).json();
    assert.equal(d.meta.writesAllowed, true);
    assert.equal(d.meta.writes.state, 'on');
    assert.equal(d.meta.writes.howTo, null);
  } finally { await s.stop(); gone(r); }
});

test('UI: an unreadable switch is NOT shown as a plain "off"', async () => {
  const r = memory();
  setSwitch(r, 'yes');
  const s = await start(r);
  try {
    const d = await (await fetch(`${s.base}/dashboard.json`, { headers: WITH_DOOR })).json();
    assert.equal(d.meta.writes.state, 'unknown');
    assert.match(d.meta.writes.reason, /neither true nor false/);
    assert.equal(d.meta.writesAllowed, false);
    const j = await (await fetch(`${s.base}/console.json`, { headers: WITH_DOOR })).json();
    assert.equal(j.writes.state, 'unknown');
    assert.equal(j.writes.allowed, false);
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// Inventory: every route that reads a request body goes through the gate
// ---------------------------------------------------------------------------

test('inventory: every body-reading route calls writegate.refusal(), and WRITE_PATHS names them', async () => {
  // Code lines only: the comments name the function too.
  const src = fs.readFileSync(SERVE, 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n');
  // ONE named exception: the dashboard's retrieval probe reads a POST
  // body (the question) and writes nothing — proven by
  // test/dashboard-page.test.mjs ("the retrieval probe is read-only").
  // It is cut out by its own handler, and it must hold exactly one reader.
  const at = src.indexOf('url.pathname === dashboardPage.PATHS.probe');
  assert.ok(at > 0, 'the probe handler moved — re-read this exception');
  const end = src.indexOf('if (url.pathname ===', at + 10);
  const probe = src.slice(at, end);
  assert.equal((probe.match(/req\.on\('data'/g) || []).length, 1, 'the probe handler reads more than its question');
  assert.equal((probe.match(/writegate\.refusal\(/g) || []).length, 0);
  const rest = src.slice(0, at) + src.slice(end);
  const readers = (rest.match(/req\.on\('data'/g) || []).length;
  const gates = (rest.match(/writegate\.refusal\(/g) || []).length;
  assert.ok(readers >= 2, 'no body reader found — the probe measures nothing');
  assert.equal(gates, readers, `${readers} body readers, but ${gates} gate calls`);
  const mod = await import(`${pathToFileURL(SERVE).href}?inv=${Math.random()}`);
  assert.deepEqual([...mod.WRITE_PATHS].sort(), WRITES.map(([p]) => p).sort());
  for (const p of mod.WRITE_PATHS) assert.ok(mod.PATHS.includes(p), `${p} outside the auth list`);
});

// ---------------------------------------------------------------------------
// Four states at module level
// ---------------------------------------------------------------------------

test('writegate.read(): four states, and only "on" allows', async () => {
  const wg = await import(pathToFileURL(WRITEGATE).href);
  const r = memory();
  try {
    assert.deepEqual([wg.read(r).state, wg.read(r).source], ['off', 'default']);
    setSwitch(r, false);
    assert.deepEqual([wg.read(r).state, wg.read(r).source], ['off', 'config']);
    setSwitch(r, true);
    assert.deepEqual([wg.read(r).state, wg.read(r).allowed], ['on', true]);
    setSwitch(r, 'true');
    assert.deepEqual([wg.read(r).state, wg.read(r).allowed], ['unknown', false]);
    fs.writeFileSync(path.join(r, '.mem', 'config.json'), '[');
    assert.deepEqual([wg.read(r).state, wg.read(r).allowed], ['error', false]);
    assert.deepEqual([wg.read(r, { flag: true }).state, wg.read(r, { flag: true }).source], ['on', 'flag']);
    assert.deepEqual([wg.read(r, { flag: true, readonly: true }).allowed], [false]);
    fs.rmSync(path.join(r, '.mem', 'config.json'));
    assert.deepEqual([wg.read(r).state, wg.read(r).allowed], ['off', false]);
  } finally { gone(r); }
});

test('CLI: mem serve documents --allow-writes and refuses a value for it', () => {
  const help = spawnSync(process.execPath, [MEM, 'serve', '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /--allow-writes/);
  assert.match(help.stdout, /allowWrites/);
  const r = memory();
  try {
    const bad = spawnSync(process.execPath, [MEM, '--root', r, 'serve', '--allow-writes', 'maybe'],
      { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /takes no value/);
  } finally { gone(r); }
});

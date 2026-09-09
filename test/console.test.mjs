// The console, against a server that is actually running.
//
// **Why not only the module level.** The console is the first place
// this project WRITES over HTTP. A probe that calls `apply()` directly
// checks the effect — but not the door in front of it, and the door is
// the real subject here. On 2026-09-08 that exact difference cost the
// sibling project twice: a fix in the library while the command one
// level up stayed wrong.
//
// So: real server, real requests, real headers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as consolePage from '../src/console.mjs';
import * as archive from '../src/archive.mjs';
import * as webauth from '../src/webauth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const MEM = path.join(HERE, '..', 'bin', 'mem');

// **The probe values are ASSEMBLED, not written down.** A literal after
// `Bearer` or after a `*_TOKEN` key looks like the thing it stands for,
// and a secret scanner that lets fixtures through eventually lets the
// real thing through. The probes lose nothing: a real value still flows
// through auth and page, it just is not a literal anywhere.
const DOOR = ['probe', 'door', String(process.pid)].join('-');
const OTHER = ['probe', 'other', String(process.pid)].join('-');
const WITH_DOOR = { authorization: `Bearer ${DOOR}` };

function memory() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-console-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  spawnSync(process.execPath, [MEM, '--root', r, 'log', 'error',
    '--title', 'a race', '--class', 'concurrency'], { encoding: 'utf8' });
  return r;
}

async function start(root, env = {}) {
  const mod = await import(`${SERVE}?t=${Math.random()}`);
  const { server, cfg } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR,
    CHEAP_MEM_SERVE_HOST: '127.0.0.1',
    CHEAP_MEM_SERVE_PORT: '0',
    ...env,
  });
  return {
    cfg,
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    // `closeAllConnections` first: `close()` alone waits for existing
    // sockets, and `fetch` keeps them alive.
    stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

test('POSITIVE: the probe really reaches a server', async () => {
  // A probe that requests nothing is green forever.
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('binding to a public address without a token is REFUSED', async () => {
  // Not warned about — refused. A warning in a log has never once
  // prevented an open link.
  //
  // **The `escaped` handle is here because of what this probe did when
  // the rule was actually broken.** Every assertion reported correctly
  // — and then the run HUNG on the leaked listening socket, so the
  // summary never printed. A run nobody sees is not a red run. The
  // probe now cleans up the server that should never have come up.
  const r = memory();
  let escaped = null;
  try {
    await assert.rejects(
      async () => {
        escaped = await start(r, {
          CHEAP_MEM_SERVE_TOKEN: '', CHEAP_MEM_SERVE_HOST: '0.0.0.0' });
      },
      /Refusing to bind/);
    // And with a token the same bind is fine.
    assert.equal(webauth.bindAllowed({ host: '0.0.0.0', token: 'x' }).ok, true);
  } finally {
    if (escaped) { escaped.server.unref(); await escaped.stop(); }
    fs.rmSync(r, { recursive: true, force: true });
  }
});

test('/ is the console, /viewer is the viewer, both carry the nav', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const c = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.match(c, /<title>cheap-mem — console<\/title>/);
    assert.match(c, /Settings/);
    assert.match(c, /class="mem-nav"/);

    const v = await (await fetch(`${s.base}/viewer`, { headers: WITH_DOOR })).text();
    assert.match(v, /class="mem-nav"/, 'the viewer has no way back to the console');
    assert.ok(!/<title>cheap-mem — console<\/title>/.test(v), 'the viewer shows the console');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('a wrong token gets a bare 404, on every path', async () => {
  // The invisible principle: a scanner must see "nothing here", not
  // "something guarded here".
  const r = memory();
  const s = await start(r);
  try {
    for (const p of ['/', '/console.json', '/viewer']) {
      const res = await fetch(`${s.base}${p}`, { headers: { authorization: 'Bearer wrong' } });
      assert.equal(res.status, 404, `${p} gives itself away`);
      const body = await res.text();
      assert.ok(!/console|cheap-mem|token/i.test(body), `${p} says too much: ${body}`);
    }
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('a POST from the same origin really changes something', async () => {
  const r = memory();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-target-'));
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      redirect: 'manual',
      headers: { ...WITH_DOOR, origin: s.base,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: 'raw-archive', value: target }).toString(),
    });
    assert.equal(res.status, 303, `no redirect: ${res.status}`);
    assert.equal(res.headers.get('location'), '/');

    // The EFFECT, not the answer.
    const store = archive.readConfig({}, r);
    assert.equal(store.location, target);
    assert.equal(store.explicit, true);
    const log = consolePage.readLog(r);
    assert.equal(log[0].id, 'raw-archive');
    assert.equal(log[0].after, target);
  } finally {
    await s.stop();
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('a POST from a foreign page changes NOTHING', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id: 'raw-archive', value: '/tmp/hijacked' }).toString(),
    });
    assert.equal(res.status, 403);
    assert.equal(archive.readConfig({}, r).explicit, false, 'a foreign POST set something');
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('a POST with NO origin is refused as well', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      headers: { ...WITH_DOOR, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=error-window&value=30',
    });
    assert.equal(res.status, 403);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('an unknown field name is refused, not ignored', async () => {
  // Ignoring would be the construction this project builds against: the
  // page reports success and nothing happened.
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: s.base,
        'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=nosuchsetting&value=whatever',
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /Unknown setting/);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('READONLY=1 turns setting off, and the page says so', async () => {
  const r = memory();
  const s = await start(r, { CHEAP_MEM_SERVE_READONLY: '1' });
  try {
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.match(page, /Writing is off/);
    assert.match(page, /disabled/);
    const res = await fetch(`${s.base}/setting`, {
      method: 'POST',
      headers: { ...WITH_DOOR, origin: s.base,
        'content-type': 'application/x-www-form-urlencoded' },
      body: 'id=error-window&value=30',
    });
    assert.equal(res.status, 403);
    assert.equal(consolePage.SETTINGS['error-window'].read(r).value, 14);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('a GET on /setting changes nothing', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/setting?id=error-window&value=99`, { headers: WITH_DOOR });
    assert.equal(res.status, 405);
    assert.equal(consolePage.SETTINGS['error-window'].read(r).value, 14);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('no token is ever on the page', async () => {
  // The mistake that cannot be taken back: a console printing the link
  // with the token in it, so you can conveniently copy it, has put it
  // into every screenshot.
  const r = memory();
  const s = await start(r, { CHEAP_MEM_ARCHIVE: '', SOME_OTHER_TOKEN: OTHER });
  try {
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.ok(!page.includes(DOOR), 'the door token is on the page');
    assert.ok(!page.includes(OTHER), 'another secret is on the page');
    // But THAT one is set does appear — otherwise the tile is useless.
    assert.match(page, /token set/);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('the page escapes what came out of the memory', async () => {
  const r = memory();
  fs.appendFileSync(path.join(r, '.mem', 'bridge-reports.jsonl'),
    `${JSON.stringify({ seen_at: new Date().toISOString(), version: '<script>alert(1)</script>' })}\n`);
  const s = await start(r);
  try {
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.ok(!page.includes('<script>alert(1)</script>'), 'unescaped into the page');
    assert.ok(page.includes('&lt;script&gt;'));
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('/console.json carries the same numbers as the page', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const j = await (await fetch(`${s.base}/console.json`, { headers: WITH_DOOR })).json();
    assert.equal(j.board.tiles.length, 7);
    assert.equal(j.settings.length, Object.keys(consolePage.SETTINGS).length);
    assert.equal(j.setup.length, 5);
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    for (const s2 of j.settings) assert.ok(page.includes(s2.title), `${s2.title} missing`);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

test('an unknown path is a 404, not a guess', async () => {
  const r = memory();
  const s = await start(r);
  try {
    const res = await fetch(`${s.base}/admin`, { headers: WITH_DOOR });
    assert.equal(res.status, 404);
  } finally { await s.stop(); fs.rmSync(r, { recursive: true, force: true }); }
});

// --- The module level, where it has its own questions ----------------

test('an empty value RESETS the archive rather than freezing the default', () => {
  const r = memory();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-target2-'));
  try {
    consolePage.apply(r, 'raw-archive', target);
    assert.equal(archive.readConfig({}, r).explicit, true);
    consolePage.apply(r, 'raw-archive', '');
    const after = archive.readConfig({}, r);
    assert.equal(after.explicit, false);
    assert.equal(after.source, 'default');
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('the numeric settings refuse nonsense', () => {
  const r = memory();
  try {
    for (const bad of ['0', '-3', 'lots', '99999', '']) {
      assert.throws(() => consolePage.apply(r, 'error-window', bad), /between/, `${bad} passed`);
    }
    assert.throws(() => consolePage.apply(r, 'quiet-hours', '0'), /between/);
    consolePage.apply(r, 'error-window', '30');
    assert.equal(consolePage.SETTINGS['error-window'].read(r).value, 30);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a setting actually reaches the board it configures', () => {
  // The stretch that matters: a knob that is stored and never read is
  // the same as no knob. `collect()` has to hand it to `board()`.
  const r = memory();
  try {
    consolePage.apply(r, 'error-window', '365');
    assert.equal(consolePage.collect(r).board.tiles
      .find((t) => t.id === 'errors').numbers.window, 365);
    consolePage.apply(r, 'quiet-hours', '1');
    const rows = consolePage.collect(r).board.tiles.find((t) => t.id === 'agents');
    assert.ok(rows, 'no agents tile');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the log is appended, never overwritten', () => {
  const r = memory();
  try {
    consolePage.apply(r, 'error-window', '7');
    consolePage.apply(r, 'error-window', '21');
    const log = consolePage.readLog(r);
    assert.equal(log.length, 2, 'the second change replaced the first');
    assert.equal(log[0].after, 21, 'the newest is not first');
    assert.equal(log[0].before, 7, 'the before value is missing — then the log says nothing');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a broken log line does not swallow the good ones', () => {
  const r = memory();
  try {
    consolePage.apply(r, 'error-window', '7');
    fs.appendFileSync(path.join(r, consolePage.LOG_FILE), '{ not json\n');
    consolePage.apply(r, 'error-window', '9');
    const log = consolePage.readLog(r);
    assert.equal(log.length, 2);
    assert.equal(log[0].after, 9);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the store list names only what was FOUND', () => {
  // The first draft mapped every entry `stores.discover()` returns, and
  // it returns all five with a possibly empty `found` array. The page
  // then announced four cloud drives on a Linux container that has
  // none — a claim about the machine, produced by not reading a field.
  const r = memory();
  try {
    for (const s of consolePage.collect(r).stores) {
      assert.ok(s.found.length > 0, `${s.id} is listed as found with nothing behind it`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('insertNav does not guess when there is no body', () => {
  assert.equal(consolePage.insertNav('no html here'), 'no html here');
  assert.match(consolePage.insertNav('<html><body><p>x</p></body></html>'),
    /<body><style>[\s\S]*<nav class="mem-nav">/);
});

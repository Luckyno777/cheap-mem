// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/inbox-reply.test.mjs — replying from the dashboard's inbox (P1b).
//
// The desk shows the human participant's tray. P1b adds a reply form
// under each message, posting to `/inbox/reply` in `bin/mem-serve`.
// Three things are pinned here:
//
//   1. It sits behind the write switch (`src/writegate.mjs`): off by
//      default -> 403 with the way to turn it on, and NOTHING written
//      (snapshot before = after). Readonly, Host and Origin still bite.
//   2. Switched on, the reply lands exactly as `mem inbox write` writes
//      it: same directory, same file-name scheme, same header, same body
//      — checked against a real CLI call in the same memory (positive
//      control), not against a hand-typed expectation.
//   3. Nobody speaks for someone else: the form carries only the message
//      name; a message not addressed to the human participant, a path
//      instead of a name, or an empty text is refused and writes nothing.
//
// **The HTTP probes import only `bin/mem-serve` and the CLI**, never the
// new code directly. Run against the tree before P1b the route does not
// exist (404), so every probe here goes red there.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');
const MEM = path.join(HERE, '..', 'bin', 'mem');

const DOOR = ['reply', 'door', String(process.pid)].join('-');
const WITH_DOOR = { authorization: `Bearer ${DOOR}` };

function mem(args, input = undefined) {
  return spawnSync(process.execPath, [MEM, ...args], { encoding: 'utf8', input, timeout: 20000 });
}

/**
 * A fresh memory with one extra participant whose name is NOT one of
 * the defaults — so a probe that passes cannot be leaning on a name the
 * code knows by heart. The human's key stays the one `mem init` writes.
 */
function memory({ allowWrites } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reply-'));
  const init = mem(['init', '--root', r]);
  assert.equal(init.status, 0, init.stderr);
  const file = path.join(r, '.mem', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.participants.scribe = 'A test agent with a name the code does not know.';
  if (allowWrites !== undefined) cfg.dashboard = { allowWrites };
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return r;
}
function gone(r) { fs.rmSync(r, { recursive: true, force: true }); }

/** Send a message through the CLI and return its file name. */
function send(r, { as, to, subject, text, inReplyTo = null }) {
  const w = mem(['--root', r, 'inbox', 'write', '--as', as, '--to', to, '--subject', subject, '--text', text,
    ...(inReplyTo ? ['--in-reply-to', inReplyTo] : [])]);
  assert.equal(w.status, 0, w.stderr);
  const m = /Written: inbox\/(\S+)/.exec(w.stdout);
  assert.ok(m, `CLI did not name the written file: ${w.stdout}`);
  return m[1];
}

function inboxFiles(r) {
  const dir = path.join(r, 'inbox');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')).sort() : [];
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
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_TOKEN: DOOR,
    CHEAP_MEM_SERVE_HOST: '127.0.0.1',
    CHEAP_MEM_SERVE_PORT: '0',
    ...env,
  }, opts);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }),
  };
}

function reply(s, fields, headers = {}) {
  return fetch(`${s.base}/inbox/reply`, {
    method: 'POST', redirect: 'manual',
    headers: { ...WITH_DOOR, origin: s.base, 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ from: '/', ...fields }).toString(),
  });
}

/** The message without its Time line — the one field two writes cannot share. */
function withoutTime(content) {
  return content.split('\n').filter((l) => !l.startsWith('Time: ')).join('\n');
}

// ---------------------------------------------------------------------------
// 1. Off by default
// ---------------------------------------------------------------------------

test('OFF (default): /inbox/reply answers 403 with the way to turn it on, and writes nothing', async () => {
  const r = memory();
  const name = send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'are you there?' });
  const s = await start(r);
  try {
    const before = snapshot(r);
    const res = await reply(s, { name, text: 'yes' });
    const text = await res.text();
    assert.equal(res.status, 403, `not refused with the switch off (got ${res.status})`);
    assert.match(text, /--allow-writes/);
    assert.match(text, /allowWrites/);
    assert.deepEqual(snapshot(r), before, 'a refused reply changed a file');
  } finally { await s.stop(); gone(r); }
});

test('OFF: an explicit false and an unrecognised value refuse the same way', async () => {
  for (const value of [false, 'yes']) {
    const r = memory({ allowWrites: value });
    const name = send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'x' });
    const s = await start(r);
    try {
      const before = snapshot(r);
      assert.equal((await reply(s, { name, text: 'y' })).status, 403, JSON.stringify(value));
      assert.deepEqual(snapshot(r), before);
    } finally { await s.stop(); gone(r); }
  }
});

test('READONLY wins over the switch and the flag for replies too', async () => {
  const r = memory({ allowWrites: true });
  const name = send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'x' });
  const s = await start(r, { CHEAP_MEM_SERVE_READONLY: '1' }, { allowWrites: true });
  try {
    const before = snapshot(r);
    assert.equal((await reply(s, { name, text: 'y' })).status, 403);
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

test('Origin and Host latches stay in force on /inbox/reply with the switch on', async () => {
  const r = memory({ allowWrites: true });
  const name = send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'x' });
  const s = await start(r);
  try {
    const before = snapshot(r);
    const foreign = await reply(s, { name, text: 'y' }, { origin: 'https://evil.example' });
    assert.equal(foreign.status, 403);
    assert.match(await foreign.text(), /origin/i);
    const noOrigin = await fetch(`${s.base}/inbox/reply`, {
      method: 'POST', redirect: 'manual',
      headers: { ...WITH_DOOR, 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=${encodeURIComponent(name)}&text=y`,
    });
    assert.equal(noOrigin.status, 403, 'a POST without Origin was accepted');
    assert.deepEqual(snapshot(r), before);
    // Host: DNS rebinding — a foreign name in Host AND Origin, matching
    // each other. Only the Host check separates this from a real form.
    // (fetch cannot set Host, so this goes through node:http.)
    const rebound = await new Promise((ok, fail) => {
      const q = http.request(`${s.base}/inbox/reply`, {
        method: 'POST',
        headers: { ...WITH_DOOR, host: 'evil.example', origin: 'http://evil.example',
          'content-type': 'application/x-www-form-urlencoded' },
      }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => ok({ status: res.statusCode, text: b }));
      });
      q.on('error', fail);
      q.end(`name=${encodeURIComponent(name)}&text=y`);
    });
    assert.equal(rebound.status, 403);
    assert.match(rebound.text, /host/i);
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

test('GET /inbox/reply writes nothing (405)', async () => {
  const r = memory({ allowWrites: true });
  const s = await start(r);
  try {
    const before = snapshot(r);
    const res = await fetch(`${s.base}/inbox/reply?name=x&text=y`, { headers: WITH_DOOR });
    assert.equal(res.status, 405);
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// 2. On: the reply lands exactly as the CLI writes it
// ---------------------------------------------------------------------------

test('POSITIVE: switched on, a reply lands in inbox/ exactly as `mem inbox write` would write it', async () => {
  const r = memory({ allowWrites: true });
  const name = send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'are you there?' });
  const originalBytes = fs.readFileSync(path.join(r, 'inbox', name));
  const s = await start(r);
  try {
    const before = inboxFiles(r);
    const res = await reply(s, { name, text: 'Yes, here.\nSecond line.' });
    assert.equal(res.status, 303, await res.text());
    assert.equal(res.headers.get('location'), '/', 'redirect goes back to the desk, nowhere else');
    const added = inboxFiles(r).filter((n) => !before.includes(n));
    assert.equal(added.length, 1, `expected exactly one new message, got ${added.join(', ')}`);
    const viaDesk = fs.readFileSync(path.join(r, 'inbox', added[0]), 'utf8');

    // The same reply through the CLI, in the same memory.
    // Z3/A7: the desk writes In-Reply-To; the CLI does the same with --in-reply-to.
    const cliName = send(r, { as: 'user', to: 'scribe', subject: 'Re: ping', text: 'Yes, here.\nSecond line.', inReplyTo: name });
    const viaCli = fs.readFileSync(path.join(r, 'inbox', cliName), 'utf8');

    assert.equal(withoutTime(viaDesk), withoutTime(viaCli), 'desk and CLI wrote different messages');
    // Block S: a reply is one turn deeper than its original (envelope.replyTurn).
    assert.match(viaDesk, /^From: user\nTo: scribe\nTime: \S+\nSubject: Re: ping\nState: open\nIn-Reply-To: \S+\.md\nTurn: 1 of 6\n\nYes, here\.\nSecond line\.\n$/);
    // Same file-name scheme: <time>--<from>-to-<to>~<clone mark>[.-n].md
    const scheme = /^[0-9TZ-]+--user-to-scribe~[a-z0-9]{1,12}(?:-[0-9]{1,3})?\.md$/;
    assert.match(added[0], scheme);
    assert.match(cliName, scheme);
    // The original is left exactly as it was — acking is a separate step.
    assert.deepEqual(fs.readFileSync(path.join(r, 'inbox', name)), originalBytes);
    // And the CLI reads it back like any other message.
    const shown = mem(['--root', r, 'inbox', 'all', '--as', 'scribe']);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, new RegExp(added[0].replace(/[.]/g, '\\.')));
  } finally { await s.stop(); gone(r); }
});

test('POSITIVE: --allow-writes (one run) lets a reply through, and "Re: Re:" is not stacked', async () => {
  const r = memory();
  const name = send(r, { as: 'session', to: 'user', subject: 'Re: plan', text: 'x' });
  const s = await start(r, {}, { allowWrites: true });
  try {
    const before = inboxFiles(r);
    const res = await reply(s, { name, text: 'ok' });
    assert.equal(res.status, 303, await res.text());
    const added = inboxFiles(r).filter((n) => !before.includes(n));
    assert.equal(added.length, 1);
    const content = fs.readFileSync(path.join(r, 'inbox', added[0]), 'utf8');
    assert.match(content, /\nTo: session\n/);
    assert.match(content, /\nSubject: Re: plan\n/);
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// 3. Nobody speaks for someone else; bad input writes nothing
// ---------------------------------------------------------------------------

test('a message NOT addressed to the human participant is refused (400) and nothing is written', async () => {
  const r = memory({ allowWrites: true });
  const name = send(r, { as: 'session', to: 'scribe', subject: 'between agents', text: 'x' });
  const s = await start(r);
  try {
    const before = snapshot(r);
    const res = await reply(s, { name, text: 'hijack' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /only its recipient/);
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

test('a path instead of a name, an unknown name and an empty text are refused, nothing written', async () => {
  const r = memory({ allowWrites: true });
  const name = send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'x' });
  const s = await start(r);
  try {
    const before = snapshot(r);
    for (const [fields, why] of [
      [{ name: `../inbox/${name}`, text: 'y' }, 'path'],
      [{ name: '../.mem/config.json', text: 'y' }, 'path'],
      [{ name: 'no-such.md', text: 'y' }, 'unknown'],
      [{ name, text: '   ' }, 'empty'],
      [{ name }, 'missing text'],
    ]) {
      const res = await reply(s, fields);
      assert.equal(res.status, 400, `${why}: got ${res.status}`);
    }
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// 4. Who "the human" is comes from `.mem/config.json`, never a hardcoded
//    key. `dashboard.HUMAN_PARTICIPANT` used to be the literal string
//    'user'; renaming that key silently turned the tray and this very
//    route into "not configured". Now it is whichever participant
//    carries `"human": true`, wherever that key is named.
// ---------------------------------------------------------------------------

/** A memory whose human participant is renamed away from `user`. */
function renamedHumanMemory({ allowWrites } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reply-renamed-'));
  const init = mem(['init', '--root', r, '--participants', 'lucky,session', '--human', 'lucky']);
  assert.equal(init.status, 0, init.stderr);
  if (allowWrites !== undefined) {
    const file = path.join(r, '.mem', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.dashboard = { allowWrites };
    fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  }
  return r;
}

test('POSITIVE: a renamed human ("lucky", "human": true) gets a working tray and reply form', async () => {
  const r = renamedHumanMemory({ allowWrites: true });
  const name = send(r, { as: 'session', to: 'lucky', subject: 'ping', text: 'are you there?' });
  const s = await start(r);
  try {
    const d = await (await fetch(`${s.base}/dashboard.json`, { headers: WITH_DOOR })).json();
    assert.equal(d.humanTray.who, 'lucky', 'the tray does not name the renamed human');
    assert.equal(d.humanTray.count, 1);
    const before = inboxFiles(r);
    const res = await reply(s, { name, text: 'yes, renamed and still working' });
    assert.equal(res.status, 303, await res.text());
    const added = inboxFiles(r).filter((n) => !before.includes(n));
    assert.equal(added.length, 1);
    const content = fs.readFileSync(path.join(r, 'inbox', added[0]), 'utf8');
    assert.match(content, /^From: lucky\nTo: session\n/);
  } finally { await s.stop(); gone(r); }
});

test('a memory with no participant marked "human": true refuses the reply honestly (400), not as "user"', async () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reply-nohuman-'));
  fs.mkdirSync(path.join(r, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  const file = path.join(r, '.mem', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Both participants exist (old, plain-string shape), neither is
  // marked human, and there is no 'user' key at all — the old hardcode
  // would already have refused this, but for the wrong reason (missing
  // key, not missing mark).
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1, participants: { alice: 'a person', bob: 'another' },
    dashboard: { allowWrites: true },
  }, null, 2)}\n`);
  const name = send(r, { as: 'alice', to: 'bob', subject: 'ping', text: 'x' });
  const s = await start(r);
  try {
    const before = snapshot(r);
    const res = await reply(s, { name, text: 'y' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /"human": true/);
    assert.deepEqual(snapshot(r), before);
  } finally { await s.stop(); gone(r); }
});

// ---------------------------------------------------------------------------
// The page: a form under each message, disabled with a note when off
// ---------------------------------------------------------------------------

// The dashboard draws the reply form in the browser (message drawer);
// what the server decides travels as <body data-writes> and the data.
const SCRIPT = fs.readFileSync(path.join(HERE, '..', 'assets', 'dashboard', 'dashboard.js'), 'utf8');

test('UI: switch off -> reply form is there but disabled, and the page says how to turn it on', async () => {
  const r = memory();
  send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'x' });
  const s = await start(r);
  try {
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.match(page, /<body data-writes="0"/);
    const d = await (await fetch(`${s.base}/dashboard.json`, { headers: WITH_DOOR })).json();
    assert.match(d.meta.writes.howTo, /mem serve --allow-writes/);
    // The form: textarea and button carry `disabled` unless the reader
    // may answer, and read-only (the switch off) forbids answering.
    const form = /<form id="replyForm"[\s\S]*?<\/form>/.exec(SCRIPT);
    assert.ok(form, 'no reply form in the message drawer');
    assert.match(form[0], /<textarea name="text"[^>]*\$\{mayAnswer \? '' : 'disabled'\}/);
    assert.match(form[0], /<button[^>]*type="submit" \$\{mayAnswer \? '' : 'disabled'\}/);
    assert.match(SCRIPT, /const mayAnswer = !state\.readonly && /);
  } finally { await s.stop(); gone(r); }
});

test('UI POSITIVE: switch on -> the reply form is live and carries only the message name', async () => {
  const r = memory({ allowWrites: true });
  send(r, { as: 'scribe', to: 'user', subject: 'ping', text: 'x' });
  const s = await start(r);
  try {
    const page = await (await fetch(`${s.base}/`, { headers: WITH_DOOR })).text();
    assert.match(page, /<body data-writes="1"/);
    // What is sent: the message name and the text — never a sender or a
    // recipient the form could choose.
    const post = /formPost\('\/inbox\/reply', \{([^}]*)\}\)/.exec(SCRIPT);
    assert.ok(post, 'the reply is not sent through formPost');
    const fields = [...post[1].matchAll(/(\w+):/g)].map((m) => m[1]).sort();
    assert.deepEqual(fields, ['name', 'text'], 'a form field could pick sender or recipient');
  } finally { await s.stop(); gone(r); }
});

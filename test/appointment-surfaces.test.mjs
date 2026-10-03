// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// appointment surfaces: the CLI (`mem appointment`), the MCP tools, the dashboard route, the watcher hook and `tick --sync`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as A from '../src/appointments.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const SERVE = path.join(REPO, 'bin', 'mem-serve');

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-appt-surf-'));
  roots.push(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    version: 1, participants: { alex: { role: 'the human', human: true }, 'vm-admin': 'agent' }, language: 'en', timezone: 'Europe/Berlin',
  }));
  return r;
}
const cli = (r, args, env = {}) => spawnSync(process.execPath, [MEM, ...args, '--root', r], {
  encoding: 'utf8', input: '', timeout: 40000, env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_MAX_AUTHORITY: '', CHEAP_MEM_AGENT: 'human:alex', ...env },
});
const json = (r, args, env) => { const x = cli(r, args, env); assert.equal(x.status, 0, x.stderr + x.stdout); return JSON.parse(x.stdout); };

test('CLI: new / list / show / due / today / cancel / move; a leading repeat word works ("weekdays 7:00")', () => {
  const r = world();
  const a = json(r, ['appointment', 'new', '--at', 'weekdays 7:00', '--title', 'Stand-up', '--json']);
  assert.equal(a.status, 'active');
  assert.equal(a.repeat, 'weekdays');
  const b = json(r, ['appointment', 'new', '--at', 'in 3 hours', '--title', 'Dentist', '--remind-before', '15m', '--json']);
  assert.equal(b.status, 'active', 'a human-named reminder is active without a flag');
  const l = json(r, ['appointment', 'list', '--all', '--json']);
  assert.equal(l.appointments.length, 2);
  assert.equal(l.zone, 'Europe/Berlin');
  const shown = json(r, ['appointment', 'show', b.id, '--json']);
  assert.equal(shown.appointment.remindBeforeMin, 15);
  assert.equal(json(r, ['appointment', 'due', '--json']).entries.length, 0);
  const today = json(r, ['appointment', 'today', '--json']);
  for (const k of ['date', 'weekday', 'zone', 'empty', 'appointments', 'actions', 'duties', 'letters', 'yesterday', 'cap']) assert.ok(k in today, k);
  const moved = json(r, ['appointment', 'move', b.id, '--at', 'in 5 hours', '--json']);
  assert.ok(Date.parse(moved.at) > Date.now() + 4 * 3600000);
  assert.equal(json(r, ['appointment', 'cancel', b.id, '--why', 'changed mind', '--json']).already, false);
  assert.equal(json(r, ['appointment', 'cancel', b.id, '--json']).already, true);
  assert.match(cli(r, ['appointment', 'today', '--date', '2026-10-05']).stdout, /Today in the calendar \(Monday, 2026-10-05\)/);
  assert.match(cli(r, ['appointment', '--help']).stdout, /mem appointment new/);
  assert.match(cli(r, ['appointment', 'list']).stdout, /Occurrences/);
});

test('CLI: refusals are loud - bad flag, bad time, repeat conflict, missing id, unknown subcommand', () => {
  const r = world();
  for (const [args, re] of [
    [['appointment', 'new', '--at', 'tomorrow', '--title', 'x', '--bogus', '1'], /unknown flag '--bogus'/],
    [['appointment', 'new', '--at', 'whenever', '--title', 'x'], /no time recognised/],
    [['appointment', 'new', '--title', 'x'], /--at is missing/],
    [['appointment', 'new', '--at', 'daily 9:00', '--repeat', 'weekly', '--title', 'x'], /give one of them/],
    [['appointment', 'new', '--at', 'tomorrow 9:00', '--title', 'x', '--remind-before', 'soon'], /duration/],
    [['appointment', 'new', '--at', 'tomorrow 9:00', '--title', 'x', '--max-minutes', 'abc'], /needs a number/],
    [['appointment', 'new', '--at', 'tomorrow 9:00', '--title', 'x', '--relative-to', 'yesterday-ish'], /not an ISO time/],
    [['appointment', 'new', '--at', 'tomorrow 9:00', '--title', 'x', '--quote', 'hi'], /needs --requested-by user/],
    [['appointment', 'show'], /which id/],
    [['appointment', 'cancel', 'nope'], /does not exist/],
    [['appointment', 'dance'], /unknown subcommand/],
    [['appointment', 'today', '--date', '2026-02-31'], /not a date/],
  ]) {
    const x = cli(r, args);
    assert.notEqual(x.status, 0, args.join(' '));
    assert.match(x.stderr + x.stdout, re, args.join(' '));
  }
  assert.equal(fs.existsSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE)), false, 'nothing was written by any refused call');
});

test('CLI rights: an agent proposes, only --authority user arms; headless and a lowered ceiling refuse the claim', () => {
  const r = world();
  const prop = json(r, ['appointment', 'new', '--at', 'tomorrow 9:00', '--title', 'Backup', '--wake', 'vm-admin', '--task', 'check it', '--json'], { CHEAP_MEM_AGENT: 'vm-admin' });
  assert.equal(prop.status, 'proposed');
  const nope = cli(r, ['appointment', 'confirm', prop.id], { CHEAP_MEM_AGENT: 'vm-admin' });
  assert.notEqual(nope.status, 0);
  assert.match(nope.stderr, /Confirming is for a human/);
  for (const env of [{ MEM_HEADLESS: 'watcher' }, { CHEAP_MEM_MAX_AUTHORITY: 'agent' }]) {
    const x = cli(r, ['appointment', 'confirm', prop.id, '--authority', 'user'], env);
    assert.notEqual(x.status, 0, JSON.stringify(env));
  }
  assert.equal(json(r, ['appointment', 'list', '--all', '--json']).proposed, 1);
  assert.equal(json(r, ['appointment', 'confirm', prop.id, '--authority', 'user', '--json']).already, false);
  assert.equal(json(r, ['appointment', 'list', '--all', '--json']).proposed, 0);
  assert.notEqual(cli(r, ['appointment', 'cap', '3'], { CHEAP_MEM_AGENT: 'vm-admin' }).status, 0);
  assert.equal(json(r, ['appointment', 'cap', '3', '--authority', 'user', '--json']).value, 3);
  assert.equal(json(r, ['appointment', 'cap', '--json']).value, 3);
  assert.equal(json(r, ['appointment', 'cap', '--proposals', '--json']).value, 10);
  const armed = json(r, ['appointment', 'new', '--at', 'tomorrow 10:00', '--title', 'Armed', '--wake', 'vm-admin', '--task', 'x', '--authority', 'user', '--json']);
  assert.equal(armed.status, 'active');
  const c = cli(r, ['appointment', 'cancel', armed.id], { CHEAP_MEM_AGENT: 'vm-admin' });
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /only the user cancels/);
});

test('CLI tick: writes the letters; the dry run `due` shows the same entries without writing', () => {
  const r = world();
  const past = Date.now() - 3 * 3600000;
  // A reminder whose time passed AFTER it was recorded: written directly with an old recording time.
  A.create(r, { title: 'Pill', atMs: Date.now() - 120000, actor: A.actorFrom({ name: 'human:alex', authority: 'user', env: {} }), now: past, env: {} });
  const due = json(r, ['appointment', 'due', '--json']);
  assert.equal(due.entries.length, 1);
  assert.equal(due.entries[0].action, 'remind');
  assert.equal(fs.existsSync(path.join(r, A.FIRED_FILE)), false, 'due is a dry run');
  const t = json(r, ['appointment', 'tick', '--json']);
  assert.equal(t.clock.fired.length, 1);
  assert.equal(t.calendar.state, 'off');
  assert.equal(json(r, ['appointment', 'tick', '--json']).clock.fired.length, 0);
  assert.equal(fs.readdirSync(path.join(r, 'inbox')).filter((f) => f.endsWith('.md')).length, 1);
  assert.match(cli(r, ['appointment', 'calendar', 'status']).stdout, /Calendar outlet: OFF/);
  assert.equal(json(r, ['appointment', 'calendar', 'status', '--json']).active, false);
  assert.match(cli(r, ['appointment', 'calendar', 'test']).stderr, /outlet is off/);
  assert.equal(json(r, ['appointment', 'calendar', 'retry', '--json']).state, 'off');
  assert.notEqual(cli(r, ['appointment', 'calendar', 'bogus']).status, 0);
});

test('tick --sync commits and pushes only appointments/ and inbox/', () => {
  const r = world();
  const sh = (cwd, ...a) => { const x = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(x.status, 0, x.stderr); return x.stdout; };
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-appt-bare-'));
  roots.push(bare);
  sh(bare, 'init', '-q', '--bare', '-b', 'main');
  sh(r, 'init', '-q', '-b', 'main');
  sh(r, 'config', 'user.email', 't@example.test'); sh(r, 'config', 'user.name', 't'); sh(r, 'config', 'commit.gpgsign', 'false');
  sh(r, 'remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(r, 'README.md'), 'x');
  sh(r, 'add', '-A'); sh(r, 'commit', '-q', '-m', 'init', '--no-verify'); sh(r, 'push', '-q', '-u', 'origin', 'main');
  A.create(r, { title: 'Pill', atMs: Date.now() - 120000, actor: A.actorFrom({ name: 'human:alex', authority: 'user', env: {} }), now: Date.now() - 3 * 3600000, env: {} });
  fs.writeFileSync(path.join(r, 'unrelated.txt'), 'leave me');
  const t = cli(r, ['appointment', 'tick', '--sync', '--json'], { GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test' });
  assert.equal(t.status, 0, t.stderr);
  assert.equal(JSON.parse(t.stdout).sync, 'synced');
  const files = sh(bare, 'ls-tree', '-r', '--name-only', 'main').split('\n').filter(Boolean);
  assert.ok(files.includes('appointments/appointments.jsonl'));
  assert.ok(files.includes('appointments/fired.jsonl'));
  assert.ok(files.some((f) => f.startsWith('inbox/')));
  assert.ok(!files.includes('unrelated.txt'), 'only the two folders are synced');
  assert.equal(JSON.parse(cli(r, ['appointment', 'tick', '--sync', '--json']).stdout).sync, 'nothing to sync');
});

// --- MCP ------------------------------------------------------------------------------------------

function bridge(r, calls, env = {}) {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  for (const [name, args] of calls) lines.push(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }));
  const x = spawnSync('node', [MCP], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000, env: { ...process.env, CHEAP_MEM_ROOT: r, MEM_HEADLESS: '', CHEAP_MEM_AGENT: 'vm-admin', ...env } });
  return String(x.stdout).split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z)).slice(1);
}
const payload = (m) => (m.result?.structuredContent ?? JSON.parse(m.result.content[0].text.startsWith('{') ? m.result.content[0].text : '{}'));

test('MCP: an agent proposes and lists, can cancel only its own proposal, can never arm, and the read-only profile hides the writers', () => {
  const r = world();
  const [made, plain, quoted, action, listed, today] = bridge(r, [
    ['mem_appointment_new', { at: 'tomorrow 9:00', title: 'Suggestion' }],
    ['mem_appointment_new', { at: 'tomorrow 10:00', title: 'Plain, no request' }],
    ['mem_appointment_new', { at: 'tomorrow 11:00', title: 'Asked for', requested_by: 'user', quote: 'remind me tomorrow at 11' }],
    ['mem_appointment_new', { at: 'tomorrow 12:00', title: 'Action', wake: 'vm-admin', task: 'do', requested_by: 'user', quote: 'have vm-admin do it' }],
    ['mem_appointment_list', { all: true }],
    ['mem_appointment_list', { today: true }],
  ]);
  assert.ok(!made.error && !made.result.isError, JSON.stringify(made));
  assert.equal(payload(made).status, 'proposed');
  assert.equal(payload(plain).status, 'proposed');
  assert.equal(payload(quoted).status, 'active', 'an explicit user quote makes a plain reminder active');
  assert.equal(payload(action).status, 'proposed', 'a quote never arms an action');
  assert.equal(payload(listed).appointments.length, 4);
  assert.ok('empty' in payload(today));
  const st = A.load(r);
  assert.equal([...st.items.values()].filter((x) => x.armed).length, 0, 'the bridge armed nothing');
  // Cancel: own proposal yes.
  const id = payload(made).id;
  const [c1] = bridge(r, [['mem_appointment_cancel', { id }]]);
  assert.ok(!c1.result.isError, JSON.stringify(c1));
  // An armed one (made by a human) no.
  const human = A.create(r, { title: 'Armed', atMs: Date.now() + 86400000, wake: 'vm-admin', task: 't', actor: A.actorFrom({ name: 'h', authority: 'user', env: {} }), now: Date.now(), env: {} });
  const [c2] = bridge(r, [['mem_appointment_cancel', { id: human.id }]]);
  assert.equal(c2.result.isError, true);
  assert.match(JSON.stringify(c2), /only the user cancels/);
  // Errors are errors.
  const [bad] = bridge(r, [['mem_appointment_new', { at: 'whenever', title: 'x' }]]);
  assert.equal(bad.result.isError, true);
  // Read-only profile: list works, the writers are refused and nothing is written.
  const before = fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8');
  const [ro1, ro2, ro3] = bridge(r, [['mem_appointment_list', {}], ['mem_appointment_new', { at: 'tomorrow 9:00', title: 'y' }], ['mem_appointment_cancel', { id: human.id }]], { CHEAP_MEM_MCP_READONLY: '1' });
  assert.ok(!ro1.error && !ro1.result.isError, JSON.stringify(ro1));
  assert.ok(ro2.error || ro2.result.isError);
  assert.ok(ro3.error || ro3.result.isError);
  assert.equal(fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8'), before);
});

// --- Dashboard --------------------------------------------------------------------------------------

test('dashboard: /dashboard/appointments.json is read only, host guarded, empty on a fresh memory, full when there are appointments', async () => {
  const r = world();
  const mod = await import(`${pathToFileURL(SERVE).href}?appt=${Math.random()}`);
  assert.ok(mod.HOST_GUARDED.includes('/dashboard/appointments.json'));
  assert.ok(mod.PATHS.includes('/dashboard/appointments.json'));
  assert.ok(!mod.WRITE_PATHS.includes('/dashboard/appointments.json'));
  const { server } = await mod.serve(r, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '' });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fresh = await (await fetch(`${base}/dashboard/appointments.json`)).json();
    assert.equal(fresh.empty, true);
    assert.deepEqual(fresh.appointments, []);
    assert.equal(fresh.outlet.active, false);
    A.create(r, { title: 'Dentist', atMs: Date.now() + 3600000, actor: A.actorFrom({ name: 'h', authority: 'user', env: {} }), now: Date.now(), env: {} });
    A.create(r, { title: 'Idea', atMs: Date.now() + 7200000, wake: 'vm-admin', task: 't', actor: { name: 'vm-admin', human: false }, now: Date.now(), env: {} });
    const full = await (await fetch(`${base}/dashboard/appointments.json`)).json();
    assert.equal(full.empty, false);
    assert.equal(full.appointments.length, 2);
    assert.equal(full.proposed, 1);
    for (const k of ['zone', 'nowText', 'cap', 'occurrences', 'banner', 'today', 'actions', 'outlet', 'briefingActive']) assert.ok(k in full, k);
    const post = await fetch(`${base}/dashboard/appointments.json`, { method: 'POST', body: '{}' });
    assert.equal(post.status, 405);
    // fetch() cannot set a Host header; a raw request can.
    const foreign = await new Promise((res, rej) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/dashboard/appointments.json', headers: { host: 'evil.example.test' } }, (x) => { x.resume(); res(x.statusCode); }).on('error', rej);
    });
    assert.ok(foreign >= 400, `a foreign Host name is refused (DNS rebinding), got ${foreign}`);
    const before = fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8');
    await fetch(`${base}/dashboard/appointments.json`);
    assert.equal(fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8'), before, 'reading writes nothing');
    // The page's script knows the tab and the card.
    const js = await (await fetch(`${base}/dashboard/app.js`)).text();
    assert.match(js, /\['calendar', 'Calendar'\]/);
    assert.match(js, /Today in the calendar/);
  } finally { await new Promise((res) => { server.closeAllConnections?.(); server.close(res); }); }
});

// --- The watcher -------------------------------------------------------------------------------------

test('watcher scripts: the clock ticks inside the poll loop (bash and PowerShell), switchable off, opt-in sync', () => {
  const sh = fs.readFileSync(path.join(REPO, 'bin', 'mem-watch'), 'utf8');
  const ps = fs.readFileSync(path.join(REPO, 'bin', 'mem-watch.ps1'), 'utf8');
  for (const [name, text] of [['bash', sh], ['ps1', ps]]) {
    assert.match(text, /appointment/, name);
    assert.match(text, /MEM_WATCH_APPOINTMENTS/, name);
    assert.match(text, /MEM_WATCH_APPOINTMENTS_SYNC/, name);
    assert.match(text, /appointments\/appointments\.jsonl/, name);
  }
  // The tick comes BEFORE the remote check in the loop.
  assert.ok(sh.indexOf('appointment tick') < sh.indexOf('"${WATCH_ARGS[@]}" --root'), 'bash: tick before the poll');
  assert.ok(sh.indexOf('"${TICK_ARGS[@]}"') > sh.indexOf('while true; do'));
});

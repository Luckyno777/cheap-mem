// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A12 (port of lucky-mem 38dd39888; security cross-check 2026-10-10): the bridge cannot verify
// who said what, so `requested_by: "user"` + a quote over `mem_appointment_new` is a CLAIM, not
// evidence.
//
// **The finding.** bin/mem-mcp turned `requested_by` + `quote` into `requestedBy: {by:'user', quote}`
// and `reminderActive: true`; `appointments.create` only checks that `by` is 'user' and the quote is
// non-empty. So any connected agent that typed those two arguments got a plain reminder ACTIVE at
// once (it fires, and it goes to the human's calendar) AND out of the daily cap on agent proposals
// (`proposalsToday` skips lines with `requested_by`). Same class as the authority claim (Y4b): the
// tier is a tool argument nobody can check.
//
// **The change (a behaviour change of a documented intent).** Over the bridge an appointment always
// starts as `proposed`, even with requested_by + quote; it counts towards the daily cap; the claim
// stays in the text as a marked, unverified note (never as the `requested_by` field, which the clock
// and the cap read as a proven wish) so the human sees what was claimed when confirming. The CLI
// (`mem appointment new --requested-by user --quote ...`) is unchanged.
//
// Red on 91b1afc (origin/main), green after.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as A from '../src/appointments.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

const roots = [];
process.on('exit', () => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-appt-claim-'));
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

function bridge(r, calls, env = {}) {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  calls.forEach(([name, args], i) => lines.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: args } })));
  const x = spawnSync(process.execPath, [MCP], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: r, MEM_HEADLESS: '', CHEAP_MEM_AGENT: 'foreign', ...env } });
  const replies = String(x.stdout).split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  return calls.map((_, i) => replies.find((y) => y.id === 10 + i));
}
const payload = (m) => (m.result?.structuredContent ?? JSON.parse(m.result.content[0].text.startsWith('{') ? m.result.content[0].text : '{}'));
const textOf = (m) => JSON.stringify(m.result ?? m.error);
const lastLine = (r) => {
  const rows = fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return rows.at(-1);
};

test('A12: a plain reminder with requested_by "user" + a quote is a PROPOSAL over the bridge, not active', () => {
  const r = world();
  const [m] = bridge(r, [['mem_appointment_new', { at: 'tomorrow 11:00', title: 'Asked for', requested_by: 'user', quote: 'remind me tomorrow at 11' }]]);
  assert.ok(!m.error && !m.result.isError, textOf(m));
  assert.equal(payload(m).status, 'proposed', 'a claim nobody can verify made the reminder active');
  assert.equal(payload(m).wishVerified, false, 'the answer must say the claim was not taken as evidence');
  const st = A.load(r);
  assert.equal([...st.items.values()].filter((x) => x.status === 'active').length, 0);
  assert.equal([...st.items.values()].filter((x) => x.armed).length, 0);
});

test('A12: the claim is kept as a MARKED, unverified note in the text -- never as the requested_by field', () => {
  const r = world();
  bridge(r, [['mem_appointment_new', { at: 'tomorrow 11:00', title: 'Asked for', text: 'bring the files', requested_by: 'user', quote: 'remind me tomorrow at 11' }]]);
  const line = lastLine(r);
  assert.equal(line.requested_by, undefined, 'requested_by in the line reads as a proven wish for the clock and the cap');
  assert.equal(line.quote, undefined);
  assert.equal(line.proposed, true);
  assert.equal(line.source, 'mcp');
  assert.match(line.text, /bring the files/);
  assert.match(line.text, /Unverified/i);
  assert.match(line.text, /foreign/);
  assert.match(line.text, /remind me tomorrow at 11/);
});

test('A12: a bridge claim counts towards the daily cap of agent proposals (no free ride with a quote)', () => {
  const r = world();
  assert.equal(cli(r, ['appointment', 'cap', '1', '--proposals', '--authority', 'user']).status, 0);
  const [a, b] = bridge(r, [
    ['mem_appointment_new', { at: 'tomorrow 11:00', title: 'One', requested_by: 'user', quote: 'remind me one' }],
    ['mem_appointment_new', { at: 'tomorrow 13:00', title: 'Two', requested_by: 'user', quote: 'remind me two' }],
  ]);
  assert.equal(payload(a).status, 'proposed');
  assert.equal(payload(b).dropped, true, `the second quoted proposal was not capped: ${textOf(b)}`);
});

test('A12: an action with a quote stays a proposal (as before), and the claim needs a quote and only "user"', () => {
  const r = world();
  const [act, noQuote, other] = bridge(r, [
    ['mem_appointment_new', { at: 'tomorrow 12:00', title: 'Action', wake: 'vm-admin', task: 'do', requested_by: 'user', quote: 'have vm-admin do it' }],
    ['mem_appointment_new', { at: 'tomorrow 14:00', title: 'No quote', requested_by: 'user' }],
    ['mem_appointment_new', { at: 'tomorrow 15:00', title: 'Other', requested_by: 'admin', quote: 'x' }],
  ]);
  assert.equal(payload(act).status, 'proposed');
  assert.equal(noQuote.result.isError, true, 'a claim without the sentence must still be refused');
  assert.equal(other.result.isError, true, "requested_by is only 'user'");
});

test('A12: private keeps the wording out -- the claimed quote is not stored either', () => {
  const r = world();
  bridge(r, [['mem_appointment_new', { at: 'tomorrow 11:00', title: 'Doctor', text: 'secret', private: true, requested_by: 'user', quote: 'remind me about the doctor' }]]);
  const raw = fs.readFileSync(path.join(r, A.DIR, A.APPOINTMENTS_FILE), 'utf8');
  assert.doesNotMatch(raw, /doctor|secret/);
  assert.equal(lastLine(r).proposed, true);
});

test('A12 positive control: without a claim nothing changes, and a human confirming makes it active', () => {
  const r = world();
  const [plain] = bridge(r, [['mem_appointment_new', { at: 'tomorrow 10:00', title: 'Plain' }]]);
  assert.equal(payload(plain).status, 'proposed');
  assert.equal(payload(plain).wishVerified, undefined, 'no claim, no statement about a claim');
  assert.doesNotMatch(lastLine(r).text ?? '', /Unverified/i);
  const id = payload(plain).id;
  const c = cli(r, ['appointment', 'confirm', id, '--authority', 'user', '--json']);
  assert.equal(c.status, 0, c.stderr + c.stdout);
  assert.equal(A.load(r).items.get(id).status, 'active');
});

test('A12 positive control: the CLI with the explicit flag keeps working -- requested-by + quote is active at once', () => {
  const r = world();
  const a = json(r, ['appointment', 'new', '--at', 'tomorrow 11:00', '--title', 'Said so', '--requested-by', 'user', '--quote', 'remind me tomorrow at 11', '--json'],
    { CHEAP_MEM_AGENT: 'session' });
  assert.equal(a.status, 'active');
  assert.equal(lastLine(r).requested_by, 'user');
  // And the library path (what the CLI calls) is unchanged: a session recording the user's request.
  const lib = A.create(r, { title: 'Lib', atMs: Date.now() + 3600000, requestedBy: { by: 'user', quote: 'q' }, reminderActive: true,
    actor: A.actorFrom({ name: 'session', env: {} }), now: Date.now(), env: {} });
  assert.equal(lib.status, 'active');
});

test('A12: the tool description and the schema say it honestly', () => {
  const src = fs.readFileSync(MCP, 'utf8');
  const at = src.indexOf("name: 'mem_appointment_new'");
  const block = src.slice(at, at + 3200);
  assert.doesNotMatch(block, /which is active at once/, 'the description still promises an active reminder');
  assert.match(block, /not evidence|unverified|cannot (be )?verif/i);
});

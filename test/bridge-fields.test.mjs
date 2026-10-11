// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A6 + A1 remainder (port of lucky-mem d286a0014, b0baee13d, e1eb522b2; security
// cross-check 2026-10-10): what a connected foreign agent may write over `mem_log`.
//
// **The finding.** `bin/mem-mcp` took `{ type, project, tags, agent, id, ts, ...fields }`
// and wrote EVERY other key. `memory.logCheckedEntry` then wrote everything that is not a
// machine field, and the machine fields (`state`, `status`, `v`, `authority_clamped_from`,
// `guard_at_creation`, ...) were passed straight through as stamps. A bridge caller could
// therefore file an entry that claims a lower-tier demotion it never had, a `status`, a
// guard result, a `shred` switch, or any field some later reader gives a meaning.
//
// A block-list is as good as its author's memory (lucky-mem's F01 was a field the list
// had forgotten). The bridge now takes an ALLOW-list per type (src/bridgefields.mjs); any
// other field is refused LOUDLY with its name and the list of what is allowed; nothing is
// written. The counterpart ids (`replaces_id`, `closes_id`, `retires_id`) stay: their effect
// is judged on read by `authority.mayChangeState`. `authority` stays clamped (Y4b).
//
// Red on 91b1afc (origin/main), green after. The behaviour probes do not import the new
// module at the top, so on the old state they run and FAIL instead of not starting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as bodyfields from '../src/bodyfields.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

const cli = (root, ...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root],
  { encoding: 'utf8', input: '', timeout: 40000 });

function bridge(root, calls, env = {}) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  let id = 10;
  for (const [name, a] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: a } }));
  }
  const r = spawnSync(process.execPath, [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0', ...env },
  });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  if (replies.length < calls.length + 1) {
    throw new Error(`bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 800)}`);
  }
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

function world(t) {
  const root = tempDir('cm-bridge-fields-', t);
  assert.equal(cli(root, 'init').status, 0);
  return root;
}
const rows = (root, type) => {
  const r = memory.readLog(root, type);
  return r.missing ? [] : (r.entries ?? []);
};

// --- Positive control: what is legitimately written over the bridge goes through ----------------

// One entry per type with the fields the bridge legitimately carries (the tests that write over
// the bridge, docs/system-prompt.txt, the type readers). Only names and shapes matter.
const LEGIT = {
  decision: { title: 't', choice: 'a', why: 'b', text: 'x', rejected: 'c', topic: 'probe', tags: ['t'], class: 'k' },
  error: { title: 't', class: 'wrong-cause', text: 'x', why: 'w', file: 'src/a.mjs', files: ['src/b.mjs'],
    guard: { kind: 'file-there', path: 'README.md' }, tags: ['t'] },
  event: { title: 't', text: 'x', tags: ['t'], topic: 'probe', valid_from: '2026-10-01' },
  timeline: { title: 't', key: 'server.users', value: 13, fact: 'f', source: 'ops', valid_from: '2026-10-01', valid_until: '2026-12-01' },
  thought: { title: 't', text: 'x', why: 'w', tags: ['t'], symbols: 'a.b', asked_as: ['x handling'] },
  learning: { title: 't', learning: 'l', text: 'x', why: 'w', tags: ['t'] },
  duty: { title: 't', duty: 'd', text: 'x', owner: 'foreign', tags: ['t'] },
  question: { title: 't', question: 'Does it?', text: 'x', tags: ['t'] },
  skill: { title: 't', skill: 's', text: 'x', when: 'w', scope: 'repo', family: 'f', tags: ['t'] },
  source: { title: 't', description: 'd', excerpt: 'e', address: 'https://example.org/x', tags: ['t'] },
  update: { title: 't', text: 'x', tags: ['t'] },
  link: { from: 'abcd1234', to: 'efgh5678', kind: 'causes', why: 'w' },
  snippet: { title: 't', kind: 'code', body: 'echo {{X}}', description: 'd', placeholders: ['X'], language: 'bash', version: 1, test: 'test/x.mjs', used_by: ['a'] },
};

test('positive control: the legitimate fields of every writable type still go through, and stand in the entry', (t) => {
  const root = world(t);
  const types = Object.keys(LEGIT);
  const res = bridge(root, types.map((type) => ['mem_log', { type, ...LEGIT[type] }]));
  types.forEach((type, i) => {
    assert.ok(!res[i].isError, `${type}: ${textOf(res[i])}`);
    const e = rows(root, type).at(-1);
    for (const [k, v] of Object.entries(LEGIT[type])) {
      assert.deepEqual(e[k], v, `${type}: field '${k}' missing or altered`);
    }
    assert.equal(e.agent, 'foreign', `${type}: origin is the connected agent`);
  });
});

test('positive control: counterpart ids still work, and state/by_id travel only with them', (t) => {
  const root = world(t);
  const [a, b] = bridge(root, [
    ['mem_log', { type: 'decision', title: 'old', choice: 'a', why: 'w' }],
    ['mem_log', { type: 'decision', title: 'new', choice: 'b', why: 'w' }],
  ]);
  assert.ok(!a.isError && !b.isError);
  const [old, neu] = rows(root, 'decision');
  const [fix, sup, duty] = bridge(root, [
    ['mem_log', { type: 'decision', title: 'old, fixed', choice: 'c', why: 'w', replaces_id: old.id }],
    ['mem_log', { type: 'decision', retires_id: neu.id, state: 'superseded', by_id: old.id }],
    ['mem_log', { type: 'duty', title: 'owed', duty: 'x' }],
  ]);
  assert.ok(!fix.isError, textOf(fix));
  assert.ok(!sup.isError, textOf(sup));
  assert.ok(!duty.isError, textOf(duty));
  const d = rows(root, 'duty')[0];
  const [closed] = bridge(root, [['mem_log', { type: 'duty', closes_id: d.id, state: 'done', why: 'finished' }]]);
  assert.ok(!closed.isError, textOf(closed));
  assert.equal(rows(root, 'duty').at(-1).closes_id, d.id);
});

// --- A6: a field outside the list is refused loudly, with its name -------------------------------

// Fields that have a meaning somewhere in the house and that no block-list had to know about.
const EFFECT_FIELDS = ['body_enc', 'shredded_of', 'shred', 'automatic', 'predecessor', 'valid_until_force',
  'command-pattern', 'origin', 'hash', 'chain', 'zzz_unknown'];

test('A6: every field outside the list is refused with its name and the allowed list; nothing is written', (t) => {
  const root = world(t);
  const res = bridge(root, EFFECT_FIELDS.map((f) => ['mem_log', { type: 'thought', text: 'harmless', [f]: 'x' }]));
  EFFECT_FIELDS.forEach((f, i) => {
    assert.equal(res[i].isError, true, `'${f}' was accepted: ${textOf(res[i])}`);
    assert.match(textOf(res[i]), new RegExp(`'${f}'`), `the refusal does not name '${f}'`);
    assert.match(textOf(res[i]), /Allowed:.*\btext\b/s, 'the refusal does not say what is allowed');
    assert.match(textOf(res[i]), /nothing (was )?written/i);
  });
  assert.equal(rows(root, 'thought').length, 0, 'something was written despite the refusal');
});

test('A6: several offending fields are all named at once (never silently dropped)', (t) => {
  const root = world(t);
  const [r] = bridge(root, [['mem_log', { type: 'error', title: 't', text: 'x', shred: true, zzz_a: 1, zzz_b: 2 }]]);
  assert.equal(r.isError, true);
  for (const f of ['shred', 'zzz_a', 'zzz_b']) assert.match(textOf(r), new RegExp(`'${f}'`));
  assert.equal(rows(root, 'error').length, 0);
});

test('A6: the rule holds for EVERY writable type', (t) => {
  const root = world(t);
  const types = Object.keys(LEGIT);
  const res = bridge(root, types.map((type) => ['mem_log', { type, ...LEGIT[type], zzz_unknown: 'x' }]));
  types.forEach((type, i) => {
    assert.equal(res[i].isError, true, `${type}: an unknown field was accepted`);
    assert.match(textOf(res[i]), /'zzz_unknown'/, type);
    assert.equal(rows(root, type).length, 0, `${type}: written despite the refusal`);
  });
});

test('A6: the refusal comes before any read -- it needs no project, no neighbours, no corpus', (t) => {
  const root = world(t);
  // A project that does not exist would make the WRITE fail with a different message; the field
  // refusal must win, which proves it stands before logEntry and before the neighbour scans.
  const [r] = bridge(root, [['mem_log', { type: 'decision', title: 'x', choice: 'a', why: 'b', project: 'nosuchproject', zzz_unknown: 1 }]]);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /'zzz_unknown'/);
  assert.doesNotMatch(textOf(r), /does not exist/);
});

// --- A1 remainder: machine and audit fields are not the caller's ---------------------------------

const MACHINE = ['v', 'status', 'state', 'by_id', 'authority_clamped_from', 'guard_at_creation'];

test('A1: machine and audit fields are refused by name (state and by_id only when no counterpart id is named)', (t) => {
  const root = world(t);
  const res = bridge(root, MACHINE.map((f) => ['mem_log', { type: 'error', title: 't', text: 'x', [f]: 'forged' }]));
  MACHINE.forEach((f, i) => {
    assert.equal(res[i].isError, true, `'${f}' was accepted: ${textOf(res[i])}`);
    assert.match(textOf(res[i]), new RegExp(`'${f}'`));
  });
  assert.equal(rows(root, 'error').length, 0, 'a forged machine field was written');
});

test('A1: the demotion record cannot be forged -- authority_clamped_from is refused even when nothing was clamped', (t) => {
  const root = world(t);
  const [forged, user, less] = bridge(root, [
    ['mem_log', { type: 'decision', title: 'forged', choice: 'a', why: 'w', authority: 'agent', authority_clamped_from: 'user' }],
    ['mem_log', { type: 'decision', title: 'claims user', choice: 'a', why: 'w', authority: 'user' }],
    ['mem_log', { type: 'decision', title: 'claims less', choice: 'a', why: 'w', authority: 'external' }],
  ]);
  assert.equal(forged.isError, true, textOf(forged));
  assert.match(textOf(forged), /'authority_clamped_from'/);
  // Positive control: authority itself stays settable and clamped (Y4b), the demotion is recorded by the bridge.
  assert.ok(!user.isError && !less.isError);
  const by = Object.fromEntries(rows(root, 'decision').map((e) => [e.title, e]));
  assert.equal(by['claims user'].authority, 'agent');
  assert.equal(by['claims user'].authority_clamped_from, 'user');
  assert.equal(by['claims less'].authority, 'external');
  assert.equal(by.forged, undefined);
});

test('A1: identity stays the bridge\'s -- agent, id and ts are still dropped silently, as before', (t) => {
  const root = world(t);
  const [r] = bridge(root, [['mem_log', { type: 'thought', text: 'x', agent: 'someone-else', id: 'forged-id-1', ts: '2001-01-01T00:00:00Z' }]]);
  assert.ok(!r.isError, textOf(r));
  const e = rows(root, 'thought')[0];
  assert.equal(e.agent, 'foreign');
  assert.notEqual(e.id, 'forged-id-1');
  assert.notEqual(e.ts, '2001-01-01T00:00:00Z');
});

test('the late supersede door takes no foreign field either', (t) => {
  const root = world(t);
  bridge(root, [
    ['mem_log', { type: 'decision', title: 'old', choice: 'a', why: 'w' }],
    ['mem_log', { type: 'decision', title: 'new', choice: 'b', why: 'w' }],
  ]);
  const [old, neu] = rows(root, 'decision');
  const before = rows(root, 'decision').length;
  const [r] = bridge(root, [['mem_log', { type: 'decision', retires_id: old.id, state: 'superseded', by_id: neu.id, zzz_unknown: 1 }]]);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /'zzz_unknown'/);
  assert.equal(rows(root, 'decision').length, before, 'a tombstone was written despite the refusal');
});

// --- The table (loads the module only here, so the probes above run red on the old state) --------

test('table: every type is listed or expressly refused; no list holds a machine field; every body field of a type is allowed', async () => {
  const bf = await import('../src/bridgefields.mjs');
  for (const type of Object.keys(memory.TYPES)) {
    const listed = Object.hasOwn(bf.ALLOWED_FIELDS, type);
    const refused = bf.REFUSED_TYPES.includes(type);
    assert.ok(listed !== refused, `type '${type}' is ${listed && refused ? 'listed AND refused' : 'neither listed nor refused'}: a new type needs a decision here`);
  }
  assert.deepEqual([...bf.REFUSED_TYPES].sort(), ['procedure', 'workflow']);
  const NEVER = ['v', 'status', 'state', 'by_id', 'authority_clamped_from', 'guard_at_creation', 'shred', 'body_enc',
    'shredded_of', 'id', 'ts', 'agent', 'project', 'hash'];
  for (const [type, list] of Object.entries(bf.ALLOWED_FIELDS)) {
    for (const n of NEVER) assert.ok(!list.includes(n), `${type}: '${n}' is on the allowed list`);
    for (const f of bodyfields.BODY_FIELDS_BY_TYPE[type] ?? []) {
      assert.ok(list.includes(f), `${type}: body field '${f}' is not allowed over the bridge: the entry could never carry its own text`);
    }
    for (const f of [...bf.COUNTERPART_IDS, 'authority', 'tags']) assert.ok(list.includes(f), `${type}: '${f}' missing`);
  }
  // The positive-control table above is a subset of the lists (a probe for the probe).
  for (const [type, fields] of Object.entries(LEGIT)) {
    for (const k of Object.keys(fields)) assert.ok(bf.ALLOWED_FIELDS[type].includes(k), `${type}: '${k}'`);
  }
});

test('refusal is a pure function of the arguments: no I/O, same answer twice', async () => {
  const bf = await import('../src/bridgefields.mjs');
  const args = Object.freeze({ title: 't', zzz: 1, state: 'x' });
  const a = (() => { try { bf.refuse('thought', args); return null; } catch (e) { return e.message; } })();
  const b = (() => { try { bf.refuse('thought', args); return null; } catch (e) { return e.message; } })();
  assert.ok(a && a === b);
  assert.match(a, /'zzz'/);
  assert.match(a, /'state'/);
  assert.doesNotThrow(() => bf.refuse('thought', { title: 't', tags: ['a'], agent: 'x', id: 'y', ts: 'z' }));
  assert.ok(fs.existsSync(path.join(REPO, 'src', 'bridgefields.mjs')));
});

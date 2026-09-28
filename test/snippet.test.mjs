// test/snippet.test.mjs — A3: a text/mail/letter snippet must pass the
// redaction check before it is written; a real-data hit aborts.
//
// Red proof pinned to a FIXED commit (never `git merge-base` — see
// test/workflow.test.mjs's header for why). Same constant hash: the
// `origin/main` HEAD this whole package branched from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as snippet from '../src/snippet.mjs';
import * as redaction from '../src/redaction.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const FIXED_COMMIT = '9218f3f68742bbb85b7621818a43fe6ed0787f48';
// A credential-shaped string `redaction.mjs` catches (its own scope —
// see src/snippet.mjs's head comment on what "real data" means here).
const REAL_DATA = 'sk-ant-abcdefghijklmnopqrstuvwx1234';

function showAtFixed(relPath) {
  try {
    return { ok: true, text: execFileSync('git', ['show', `${FIXED_COMMIT}:${relPath}`], { cwd: REPO, encoding: 'utf8' }) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-snippet-'));
  spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  return root;
}
function cli(root, argv, env = {}) {
  return spawnSync('node', [MEM, '--root', root, ...argv],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
}
function readReplies(r, what) {
  const lines = String(r.stdout ?? '').split('\n').filter((z) => z.trim());
  if (!lines.length) {
    throw new Error(`${what}: the MCP server produced no reply.\n`
      + `  status: ${r.status}  stderr: ${String(r.stderr ?? '').trim().slice(0, 1000) || '(empty)'}`);
  }
  return lines.map((z) => JSON.parse(z));
}
function bridge(root, calls, env = {}) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  for (const [name, a] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: a } }));
  }
  const r = spawnSync('node', [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...env },
  });
  return readReplies(r, 'bridge');
}

// --- Red proof + positive control (fixed commit, never merge-base) ---

test('RED PROOF: snippet did not exist at the fixed commit', () => {
  const mem = showAtFixed('src/memory.mjs');
  assert.ok(mem.ok, `could not read src/memory.mjs at ${FIXED_COMMIT}: ${mem.error}`);
  assert.doesNotMatch(mem.text, /\bsnippet:\s*'snippets\.jsonl'/,
    'the fixed commit already had this type — the hash is not actually "before this build"');

  const sn = showAtFixed('src/snippet.mjs');
  assert.equal(sn.ok, false, 'src/snippet.mjs already existed at the fixed commit');
});

test('POSITIVE CONTROL: the same probe finds redaction.mjs, which WAS already there', () => {
  const red = showAtFixed('src/redaction.mjs');
  assert.ok(red.ok, 'src/redaction.mjs should already have existed at the fixed commit — '
    + 'if not, the probe sees nothing and the red proof above is meaningless');
  assert.match(red.text, /export function redact\(/);
});

// --- POSITIVE CONTROL that redaction.mjs itself actually fires on the
// exact fixture this suite uses, BEFORE trusting snippet.mjs's gate to
// have caught anything real. ---

test('POSITIVE CONTROL: the fixture string is one redaction.mjs actually catches', () => {
  const { found } = redaction.redact(`token: ${REAL_DATA}`);
  assert.ok(found.length > 0, 'the fixture is not credential-shaped enough for redaction.mjs to see — '
    + 'fix the fixture, not the gate');
});

// --- The guarantee, on the current build (green) ---

test('POSITIVE CONTROL: `snippet` is a type of its own', () => {
  assert.ok(Object.hasOwn(memory.TYPES, 'snippet'));
  assert.equal(memory.TYPES.snippet, 'snippets.jsonl');
});

test('closed kind list: code, script, text, mail, letter — nothing else', () => {
  assert.deepEqual(snippet.KINDS, ['code', 'script', 'text', 'mail', 'letter']);
  assert.ok(snippet.validKind('mail'));
  assert.ok(!snippet.validKind('memo'), 'an open vocabulary defeats the closed-list guarantee');
});

test('check(): a real-data hit in a text/mail/letter body is refused', () => {
  for (const kind of ['text', 'mail', 'letter']) {
    const r = snippet.check({ title: 'x', kind, body: `Hi, use ${REAL_DATA} to log in.` });
    assert.equal(r.ok, false, `kind ${kind} should have been refused`);
    assert.ok(r.errors.some((e) => /real data, not placeholders/.test(e)), JSON.stringify(r.errors));
  }
});

test('POSITIVE CONTROL: the identical text with a placeholder instead goes through', () => {
  for (const kind of ['text', 'mail', 'letter']) {
    const r = snippet.check({ title: 'x', kind, body: 'Hi, use {{API_KEY}} to log in.' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
  }
});

test('code/script snippets are NOT redaction-gated on purpose', () => {
  // A credential-shaped example in a docstring or test fixture is normal
  // for a code snippet and must not be impossible to save — see
  // src/snippet.mjs's head comment. This locks the deliberate scope in.
  const r = snippet.check({ title: 'x', kind: 'code', body: `const KEY = "${REAL_DATA}";` });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('placeholdersOf() finds {{NAME}}-shaped identifiers', () => {
  assert.deepEqual(snippet.placeholdersOf('Hi {{NAME}}, see {{LINK}} and {{NAME}} again.'), ['NAME', 'LINK']);
});

test('THE LATCH (CLI): a real-data hit aborts the write', () => {
  const w = world();
  try {
    const r = cli(w, ['log', 'snippet', '--title', 'Reset mail', '--kind', 'mail',
      '--body', `Hi, your key is ${REAL_DATA}.`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /real data, not placeholders/);
    assert.ok(!fs.existsSync(path.join(w, 'global', 'snippets.jsonl')));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL (CLI): the placeholder version is written', () => {
  const w = world();
  try {
    const r = cli(w, ['log', 'snippet', '--title', 'Reset mail', '--kind', 'mail',
      '--body', 'Hi {{NAME}}, your reset link is {{LINK}}.']);
    assert.equal(r.status, 0, r.stderr);
    const e = JSON.parse(fs.readFileSync(path.join(w, 'global', 'snippets.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.equal(e.kind, 'mail');
    assert.equal(e.version, 1);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('THE LATCH (bridge): the same check runs over the MCP bridge too', () => {
  const w = world();
  try {
    const res = bridge(w, [['mem_log', { type: 'snippet', title: 'x', kind: 'text',
      body: `secret ${REAL_DATA}` }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    const all = JSON.stringify(res.find((x) => x.id === 9));
    assert.match(all, /real data, not placeholders/, all);
    assert.ok(!fs.existsSync(path.join(w, 'global', 'snippets.jsonl')));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('POSITIVE CONTROL (bridge): unlike workflow/procedure, snippet IS writable over the bridge', () => {
  const w = world();
  try {
    const res = bridge(w, [['mem_log', { type: 'snippet', title: 'Reset mail', kind: 'mail',
      body: 'Hi {{NAME}}, reset here {{LINK}}.' }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    const all = JSON.stringify(res.find((x) => x.id === 9));
    assert.doesNotMatch(all, /not written over the bridge/, all);
    assert.ok(fs.existsSync(path.join(w, 'global', 'snippets.jsonl')));
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// O1 (BAUPLAN-mem-admin_02.md Block O, ported from lucky-mem): ONE write
// path for the CLI and the MCP bridge.
//
// Found before the build (start commit f738499):
//   - The content check (`memory.hasContent`, `question.check`) stood only
//     in the CLI handler; over the bridge an entry with no content went
//     through.
//   - Neither `mem log` nor `mem_log`, neither `mem inbox write` nor
//     `mem_inbox_write` redacted before the disk — all four leaned on the
//     commit scan.
//   - claim / renew / done had no MCP tool.
//
// Every refusal here has its positive control (the ordinary case passes),
// so a refusal cannot just mean "the function always throws". Only
// synthetic sample values, assembled at run time rather than written out
// (the pre-commit scan would otherwise refuse this very file).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

const FAKE_TOKEN = `ghp${'_'}${'Q'.repeat(36)}`;

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
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'session', ...env },
  });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  if (replies.length < calls.length + 1) {
    throw new Error(`bridge answered ${replies.length} times: ${String(r.stderr).slice(0, 800)}`);
  }
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

function world(t) {
  const root = tempDir('cheap-mem-o1-', t);
  assert.equal(cli(root, 'init').status, 0);
  return root;
}
const entries = (root, type) => {
  const r = memory.readLog(root, type);
  return r.missing ? [] : (r.entries ?? []);
};
const withoutStamps = (e) => {
  const { id: _i, ts: _t, agent: _a, ...rest } = e;
  return rest;
};

// --- content check: the same refusal on both paths -------------------

test('MCP: an entry with no content is refused and nothing is written', (t) => {
  const root = world(t);
  const [empty, full] = bridge(root, [
    ['mem_log', { type: 'thought', tags: ['only-a-label'] }],
    // Positive control: the same path with text goes through.
    ['mem_log', { type: 'thought', text: 'a real thought' }],
  ]);
  assert.equal(empty.isError, true, `an empty entry was accepted: ${textOf(empty)}`);
  assert.match(textOf(empty), /no content/);
  assert.ok(!full.isError, textOf(full));
  assert.equal(entries(root, 'thought').length, 1, 'exactly the entry with content');
});

test('PARITY: no content — CLI and MCP refuse with the same message', (t) => {
  const root = world(t);
  const r = cli(root, 'log', 'thought', '--tags', 'only-a-label');
  assert.notEqual(r.status, 0, 'the CLI accepted an empty entry');
  const [m] = bridge(root, [['mem_log', { type: 'thought', tags: ['only-a-label'] }]]);
  assert.equal(m.isError, true, 'the bridge accepted an empty entry');
  assert.ok(textOf(m).includes(memory.NO_CONTENT_MESSAGE), textOf(m));
  assert.ok(r.stderr.includes(memory.NO_CONTENT_MESSAGE), r.stderr);
  assert.equal(entries(root, 'thought').length, 0);
});

test('MCP: a question without a question is refused, as at the CLI', (t) => {
  const root = world(t);
  const r = cli(root, 'log', 'question', '--title', 'no text here');
  assert.notEqual(r.status, 0, 'positive control: the CLI refuses it');
  const [m] = bridge(root, [['mem_log', { type: 'question', title: 'no text here' }]]);
  assert.equal(m.isError, true, `the bridge accepted it: ${textOf(m)}`);
});

// --- redaction: the same redaction on both paths ---------------------

test('CLI: `mem log` does NOT write a secret pattern to disk unredacted', (t) => {
  const root = world(t);
  const r = cli(root, 'log', 'thought', '--text', `the key ${FAKE_TOKEN} was in the log`);
  assert.equal(r.status, 0, r.stderr);
  const [e] = entries(root, 'thought');
  assert.ok(!JSON.stringify(e).includes(FAKE_TOKEN), 'the pattern stands unredacted on disk');
  assert.match(e.text, /REDACTED:github-token/, 'positive control: the redaction found nothing');
  assert.match(`${r.stdout}${r.stderr}`, /redacted: github-tokenx1/);
});

test('PARITY: the same input over CLI and MCP yields the same entry', (t) => {
  const root = world(t);
  const fields = { title: 'parity probe', text: `value ${FAKE_TOKEN} in the text` };
  const r = cli(root, 'log', 'thought', '--title', fields.title, '--text', fields.text);
  assert.equal(r.status, 0, r.stderr);
  const [m] = bridge(root, [['mem_log', { type: 'thought', ...fields }]]);
  assert.ok(!m.isError, textOf(m));
  assert.match(textOf(m), /redacted: github-tokenx1/);
  const [fromCli, fromMcp] = entries(root, 'thought');
  assert.ok(fromCli && fromMcp, 'not both entries written');
  assert.deepEqual(withoutStamps(fromCli), withoutStamps(fromMcp));
  // No double redaction: exactly ONE marker, not a nested one.
  assert.equal((fromMcp.text.match(/REDACTED/g) ?? []).length, 1, fromMcp.text);
});

test('PARITY: an inbox message is redacted on both paths before it hits the disk', (t) => {
  const root = world(t);
  const r = cli(root, 'inbox', 'write', '--as', 'session', '--to', 'librarian',
    '--subject', 'probe CLI', '--text', `token ${FAKE_TOKEN} please delete`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(`${r.stdout}${r.stderr}`, /redacted: github-tokenx1/);
  const [m] = bridge(root, [['mem_inbox_write',
    { from: 'session', to: 'librarian', subject: 'probe MCP', text: `token ${FAKE_TOKEN} please delete` }]]);
  assert.ok(!m.isError, textOf(m));
  const dir = path.join(root, 'inbox');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.equal(files.length, 2);
  const bodies = files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const b of bodies) {
    assert.ok(!b.includes(FAKE_TOKEN), 'unredacted on disk');
    assert.match(b, /REDACTED:github-token/);
  }
});

// --- claim / renew / done as MCP tools -------------------------------

test('MCP: claim, renew, done — the same functions, the claimant from the connection', (t) => {
  const root = world(t);
  assert.equal(cli(root, 'inbox', 'write', '--as', 'session', '--to', 'librarian',
    '--subject', 'work', '--text', 'do it').status, 0);
  const name = fs.readdirSync(path.join(root, 'inbox')).find((f) => f.endsWith('.md'));
  // A `by` in the call does not count — identity is not a parameter.
  const [c] = bridge(root, [['mem_inbox_claim', { name, minutes: 10, by: 'user' }]], { CHEAP_MEM_AGENT: 'librarian' });
  assert.ok(!c.isError, textOf(c));
  const claimId = c.structuredContent.claim_id;
  assert.match(claimId, /^[0-9a-f]{12}$/);
  assert.match(cli(root, 'inbox', 'claims', name).stdout, /claimed — librarian until/);
  const [rn] = bridge(root, [['mem_inbox_renew', { name, claim_id: claimId, minutes: 20 }]], { CHEAP_MEM_AGENT: 'librarian' });
  assert.equal(rn.structuredContent.valid, true, textOf(rn));
  // Sabotage: somebody else cannot finish MY claim.
  const [foreign] = bridge(root, [['mem_inbox_done', { name, claim_id: claimId }]], { CHEAP_MEM_AGENT: 'session' });
  assert.equal(foreign.isError, true, 'a foreign done counted');
  const [d] = bridge(root, [['mem_inbox_done', { name, claim_id: claimId }]], { CHEAP_MEM_AGENT: 'librarian' });
  assert.equal(d.structuredContent.valid, true, textOf(d));
  assert.match(cli(root, 'inbox', 'claims', name).stdout, /: done/);
});

// --- the function itself ----------------------------------------------

test('memory.logCheckedEntry: content, redaction, findings — one place', (t) => {
  const root = world(t);
  assert.throws(() => memory.logCheckedEntry(root, 'thought', { tags: ['x'] }), /no content/);
  const { entry, findings } = memory.logCheckedEntry(root, 'thought', { text: `a ${FAKE_TOKEN} b` });
  assert.ok(!entry.text.includes(FAKE_TOKEN));
  assert.deepEqual(findings, [{ type: 'github-token', count: 1 }]);
});

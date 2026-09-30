// G1b (B): a decision written WITHOUT topic shows the two lexically
// closest standing decisions as a note — with the ready command to
// retire the old one. Same note over CLI and MCP. No model, nothing
// written, no verdict ("similar", never "contradicts").
//
// Why at write time: gold case time-08 (an unlinked newer decision
// without topic) has no ranking rule by design — word overlap cannot tell
// which of two rulings holds. The writer can. See src/neighbours.mjs.
//
// Every probe has its control: an unrelated decision gets no note, a
// decision WITH a topic gets no note (the topic hint speaks there), and
// the note never lands in the entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as neighbours from '../src/neighbours.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

const cli = (root, ...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root],
  { encoding: 'utf8', input: '', timeout: 40000 });

function bridge(root, calls) {
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
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'session' },
  });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  if (replies.length < calls.length + 1) throw new Error(`bridge answered ${replies.length}: ${String(r.stderr).slice(0, 800)}`);
  return replies.slice(1).map((x) => x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

function world(t) {
  const root = tempDir('cheap-mem-g1b-', t);
  assert.equal(cli(root, 'init').status, 0);
  assert.equal(cli(root, 'log', 'decision', '--title', 'The dashboard is styled with Tailwind',
    '--choice', 'Tailwind', '--why', 'consistent without a design system').status, 0);
  return root;
}
const idOf = (out) => /id: (\S+)/.exec(out)?.[1];
const NOTE = /Similar decisions already stand/;

test('CLI: a similar decision without topic gets the note and the ready command', (t) => {
  const root = world(t);
  const [old] = memory.readLog(root, 'decision').entries;
  const r = cli(root, 'log', 'decision', '--title', 'The dashboard moved from Tailwind to plain CSS',
    '--choice', 'plain CSS', '--why', 'class lists became unreadable');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, NOTE, `no note for a near-duplicate subject:\n${r.stdout}`);
  assert.ok(r.stdout.includes(`mem discard ${old.id} --why "replaced by ${idOf(r.stdout)}"`),
    `the ready command is missing or wrong:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /contradict/i, 'the note judged — it must only say "similar"');
  // Output only: the entry carries nothing of it.
  const written = memory.readLog(root, 'decision').entries.at(-1);
  assert.ok(!JSON.stringify(written).includes('Similar'), 'the note leaked into the entry');
});

test('CLI control: an unrelated decision and a decision WITH topic get no note', (t) => {
  const root = world(t);
  const other = cli(root, 'log', 'decision', '--title', 'Invoices are archived as PDF for ten years',
    '--choice', 'PDF archive', '--why', 'retention law');
  assert.equal(other.status, 0, other.stderr);
  assert.doesNotMatch(other.stdout, NOTE, 'an unrelated decision got the note — threshold too low');
  const topical = cli(root, 'log', 'decision', '--topic', 'styling', '--title', 'The dashboard moved from Tailwind to plain CSS',
    '--choice', 'plain CSS', '--why', 'unreadable');
  assert.equal(topical.status, 0, topical.stderr);
  assert.doesNotMatch(topical.stdout, NOTE, 'with a topic, the topic hint speaks — not this one');
});

test('MCP: mem_log shows the same note as the CLI', (t) => {
  const root = world(t);
  const [res, ctl] = bridge(root, [
    ['mem_log', { type: 'decision', title: 'The dashboard moved from Tailwind to plain CSS', choice: 'plain CSS', why: 'unreadable' }],
    ['mem_log', { type: 'decision', title: 'Invoices are archived as PDF for ten years', choice: 'PDF archive', why: 'retention law' }],
  ]);
  assert.ok(!res.isError, textOf(res));
  assert.match(textOf(res), NOTE, `the bridge wrote without the note:\n${textOf(res)}`);
  assert.match(textOf(res), /mem discard \S+ --why "replaced by \S+"/);
  assert.doesNotMatch(textOf(ctl), NOTE, 'control: unrelated decision over the bridge got a note');
});

test('UNIT: threshold — two shared words and Jaccard >= 0.25', () => {
  const a = neighbours.subjectWords({ title: 'The dashboard is styled with Tailwind', choice: 'Tailwind' });
  const b = neighbours.subjectWords({ title: 'The dashboard moved from Tailwind to plain CSS', choice: 'plain CSS' });
  const o = neighbours.overlap(a, b);
  assert.ok(o.shared >= neighbours.SIMILAR_MIN_SHARED && o.jaccard >= neighbours.SIMILAR_MIN_JACCARD, JSON.stringify(o));
  const c = neighbours.subjectWords({ title: 'Dashboard login uses email codes', choice: 'email codes' });
  const oc = neighbours.overlap(a, c);
  assert.ok(oc.shared < neighbours.SIMILAR_MIN_SHARED || oc.jaccard < neighbours.SIMILAR_MIN_JACCARD,
    `one shared word must not be enough: ${JSON.stringify(oc)}`);
});

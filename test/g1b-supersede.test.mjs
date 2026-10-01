// G1b follow-up: the note's ready command must say what happened —
// "the old ruling held until the new one", not "the old one was wrong".
//
// **The defect.** The first version of the note offered `mem discard`.
// That stamps the old decision `discarded`: status says it was withdrawn,
// and under `--as-of` it vanishes from its own past (a discarded entry
// never reaches `validAt`). No existing door said "superseded by an entry
// that already exists": `correction` writes a third entry, a `replaces`
// link is a graph edge retirement never reads.
//
// **The door.** `mem supersede <old> --by <new>` (and `mem_log` with
// retires_id + state "superseded" + by_id): one appended line, judged
// on read by the strict replacement rule, ending the old claim at the
// SUCCESSOR's start. Probed on dated entries: as of a moment before the
// new decision the old one holds; after it, the new one does and the old
// one does not; status reads `superseded`.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const cli = (root, ...a) => spawnSync(process.execPath, [MEM, ...a, '--root', root],
  { encoding: 'utf8', input: '', timeout: 40000 });

function bridge(root, calls) {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  calls.forEach(([name, a], i) => lines.push(JSON.stringify({ jsonrpc: '2.0', id: 10 + i, method: 'tools/call', params: { name, arguments: a } })));
  const r = spawnSync(process.execPath, [MCP], { input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'session' } });
  const replies = String(r.stdout ?? '').split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
  return calls.map((_, i) => {
    const x = replies.find((y) => y.id === 10 + i);
    if (!x) throw new Error(`no reply: ${String(r.stderr).slice(0, 600)}`);
    return x.result ?? { isError: true, content: [{ text: JSON.stringify(x.error) }] };
  });
}
const textOf = (res) => (res.content ?? []).map((c) => c.text).join('\n');

// Two dated decisions, no topic, no replaces_id — the time-08 shape.
function world(t, agent = undefined) {
  const root = tempDir('cheap-mem-g1b-sup-', t);
  assert.equal(cli(root, 'init').status, 0);
  const old = memory.logEntry(root, 'decision', { title: 'Dashboard styled with Tailwind zebracorn', choice: 'Tailwind', why: 'x', ...(agent ? { agent } : {}) },
    { now: new Date('2026-01-10T09:00:00Z') }).entry;
  const created = memory.logEntry(root, 'decision', { title: 'Dashboard moved to plain CSS zebracorn', choice: 'plain CSS', why: 'y', ...(agent ? { agent } : {}) },
    { now: new Date('2026-05-01T09:00:00Z') }).entry;
  return { root, old, created };
}
const findIds = (root, ...extra) => {
  const r = cli(root, 'find', 'zebracorn', '--json', '--top', '10', ...extra);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hits.map((h) => h.entry.id);
};
const stateOf = (root, id) => memory.retiredMap(memory.readLog(root, 'decision').entries).get(id)?.state ?? null;

test('POSITIVE CONTROL: unlinked, the old decision still holds after the new one started', (t) => {
  const { root, old } = world(t);
  assert.ok(findIds(root, '--as-of', '2026-06-01').includes(old.id), 'the probe cannot see the old decision at all');
});

test('mem supersede: old holds before the new one, new holds after, status superseded', (t) => {
  const { root, old, created } = world(t);
  const r = cli(root, 'supersede', old.id, '--by', created.id);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(root, old.id), 'superseded', 'status must read superseded, not discarded/done');
  // The streaming replay (P11) must decide the same, end included.
  const streamed = memory.retiredMapFromFiles([memory.logPath(root, 'decision', null)]).get(old.id);
  assert.equal(streamed?.state, 'superseded');
  assert.equal(streamed?.supersededAt, created.ts, 'the streaming replay lost the successor start');
  assert.ok(findIds(root, '--as-of', '2026-03-01').includes(old.id), 'as of March the old decision held');
  const june = findIds(root, '--as-of', '2026-06-01');
  assert.ok(june.includes(created.id), 'as of June the new decision holds');
  assert.ok(!june.includes(old.id), 'as of June the old decision is over — it ended when the new one STARTED, not when the link was typed');
  // Gateway door agrees.
  const g = cli(root, 'retrieve', 'zebracorn', '--as-of', '2026-03-01', '--json');
  assert.ok(g.stdout.includes(old.id), `retrieve lost the old decision's past:\n${g.stdout}`);
  // Present-day recall shows the new one only.
  const now = findIds(root);
  assert.ok(now.includes(created.id) && !now.includes(old.id));
});

test('why not discard: it stamps "discarded" and erases the old decision from its own past', (t) => {
  // The reason for this build, kept as a probe: if discard ever started
  // behaving like supersede, this test says the note could go back.
  const { root, old } = world(t);
  assert.equal(cli(root, 'discard', old.id, '--why', 'replaced').status, 0);
  assert.equal(stateOf(root, old.id), 'discarded');
  assert.ok(!findIds(root, '--as-of', '2026-03-01').includes(old.id));
});

test('refusals: unknown successor, self-supersession — nothing written', (t) => {
  const { root, old } = world(t);
  const before = memory.readLog(root, 'decision').entries.length;
  assert.notEqual(cli(root, 'supersede', old.id, '--by', 'nosuchid00').status, 0);
  assert.notEqual(cli(root, 'supersede', old.id, '--by', old.id).status, 0);
  assert.notEqual(cli(root, 'supersede', old.id).status, 0, 'without --by it must refuse');
  assert.equal(memory.readLog(root, 'decision').entries.length, before);
});

test('rank rule: a lower tier cannot supersede a user claim (disputed, target stays)', () => {
  const target = { id: 'a', ts: '2026-01-01T00:00:00Z', agent: 'human:alex', authority: 'user', choice: 'x' };
  const succ = { id: 'b', ts: '2026-02-01T00:00:00Z', agent: 'bot', authority: 'inferred', choice: 'y' };
  const low = { id: 't', retires_id: 'a', state: 'superseded', by_id: 'b', agent: 'bot', authority: 'inferred' };
  const m = memory.retiredMap([target, succ, low]);
  assert.equal(m.get('a'), undefined, 'a lower tier retired a user claim');
  assert.equal(m.get('t')?.state, 'disputed');
  // Positive control: the same author may.
  const own = { ...low, agent: 'human:alex', authority: 'user' };
  const m2 = memory.retiredMap([target, succ, own]);
  assert.equal(m2.get('a')?.state, 'superseded');
  assert.equal(m2.get('a')?.supersededAt, succ.ts);
});

test('bridge: mem_log with retires_id/state/by_id is the same door; the topic note shows too', (t) => {
  // Same author as the bridge session: the strict rule allows it (a
  // DIFFERENT author at the same tier would be refused — see the rank test).
  const { root, old, created } = world(t, 'session');
  const [bad, ok] = bridge(root, [
    ['mem_log', { type: 'decision', retires_id: old.id, state: 'superseded', by_id: 'nosuchid00' }],
    ['mem_log', { type: 'decision', retires_id: old.id, state: 'superseded', by_id: created.id }],
  ]);
  assert.equal(bad.isError, true, `an unknown successor was accepted: ${textOf(bad)}`);
  assert.ok(!ok.isError, textOf(ok));
  const line = memory.readLog(root, 'decision').entries.at(-1);
  assert.deepEqual([line.retires_id, line.state, line.by_id], [old.id, 'superseded', created.id]);
  assert.equal(stateOf(root, old.id), 'superseded');
  // O1 parity: the same-topic note `mem log` prints, now over the bridge.
  cli(root, 'log', 'decision', '--topic', 'styling', '--choice', 'Tailwind', '--why', 'a');
  const [topical] = bridge(root, [['mem_log', { type: 'decision', topic: 'styling', choice: 'plain CSS', why: 'b' }]]);
  assert.match(textOf(topical), /Something already stands under topic 'styling'/, textOf(topical));
});

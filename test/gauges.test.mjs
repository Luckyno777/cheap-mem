import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMAND_KIND, BUCKET, classifyCommand, isMemorySearch, pathsOf,
  callsOf, threadOf, afterLook, occupancy, allocation, countBuckets,
  measure, asText,
} from '../src/gauges.mjs';

function assistant(calls, extra = {}) {
  return {
    type: 'assistant', timestamp: extra.ts ?? '2026-09-12T10:00:00Z',
    ...extra,
    message: { content: calls.map((c) => ({ type: 'tool_use', name: c.name, input: c.input ?? {} })) },
  };
}

test('writing beats reading: cat > file <<EOF is not a read', () => {
  assert.equal(classifyCommand("cat > /tmp/x.mjs <<'EOF'"), COMMAND_KIND.WRITE);
  assert.equal(classifyCommand('cat src/search.mjs'), COMMAND_KIND.READ);
});

test('sed -n counts as reading, grep as searching', () => {
  assert.equal(classifyCommand("sed -n '1,40p' src/raw.mjs"), COMMAND_KIND.READ);
  assert.equal(classifyCommand('grep -n "foo" src/*.mjs'), COMMAND_KIND.SEARCH);
  assert.equal(classifyCommand('rg --files'), COMMAND_KIND.SEARCH);
});

test('a command with no file bearing is OTHER, not silently a read', () => {
  assert.equal(classifyCommand('echo hello'), COMMAND_KIND.OTHER);
  assert.equal(classifyCommand(''), COMMAND_KIND.OTHER);
});

test('a renewed memory search is recognised — shell and MCP alike', () => {
  assert.ok(isMemorySearch('Bash', { command: 'node /home/x/cheap-mem/bin/mem find "x"' }));
  assert.ok(isMemorySearch('mcp__cheap-mem__mem_find', {}));
  assert.ok(!isMemorySearch('Bash', { command: 'ls' }));
});

test('concurrent calls are not a verdict', () => {
  const lines = [assistant([{ name: 'Grep' }])];
  assert.equal(afterLook(lines, 0, { named: [] }).bucket, BUCKET.NO_VERDICT);
});

test('bookkeeping is stepped over, the call behind it judges', () => {
  const lines = [
    assistant([]),
    assistant([{ name: 'TaskUpdate' }]),
    assistant([{ name: 'Bash', input: { command: 'grep -rn x src/' } }]),
  ];
  assert.equal(afterLook(lines, 0, {}).bucket, BUCKET.SEARCHED);
});

test('a named place read vs. one never injected', () => {
  const lines = [
    assistant([]),
    assistant([{ name: 'Bash', input: { command: 'cat projects/x/learnings.jsonl' } }]),
  ];
  assert.equal(afterLook(lines, 0, { named: ['projects/x/learnings.jsonl:12'] }).bucket,
    BUCKET.READ_NAMED);
  assert.equal(afterLook(lines, 0, { named: ['global/facts.yaml:1'] }).bucket,
    BUCKET.READ_UNNAMED);
});

test('without named places READ_NAMED is never claimed', () => {
  const lines = [assistant([]), assistant([{ name: 'Read', input: { file_path: '/x/y.md' } }])];
  assert.equal(afterLook(lines, 0, { named: [] }).bucket, BUCKET.READ_UNNAMED);
});

test('a subagent does not judge for the main thread', () => {
  const lines = [
    assistant([]),
    assistant([{ name: 'Grep' }], { isSidechain: true, uuid: 'u1' }),
    assistant([{ name: 'Edit', input: { file_path: 'a.mjs' } }]),
  ];
  assert.equal(afterLook(lines, 0, { thread: 'main' }).bucket, BUCKET.MOVED_ON);
  assert.ok(threadOf(lines[1]).startsWith('side:'));
});

test('occupancy without a measured chars-per-token calls the window unknown', () => {
  const o = occupancy({ injections: [{ bytes: 400 }, { bytes: 600 }], materialBytes: 10000 });
  assert.equal(o.bytes, 1000);
  assert.equal(o.share_material, 0.1);
  assert.equal(o.share_window, null);
  assert.equal(o.units, null);
});

test('occupancy computes the window only with a handed-in ratio', () => {
  const o = occupancy({ injections: [{ bytes: 2250 }], materialBytes: 4500, charsPerToken: 2.25, window: 1000 });
  assert.equal(o.units, 1000);
  assert.equal(o.share_window, 1);
});

test('allocation counts injections, not bytes, and drops no-verdict', () => {
  const a = allocation([
    { bucket: BUCKET.READ_NAMED }, { bucket: BUCKET.MOVED_ON }, { bucket: BUCKET.NO_VERDICT },
  ]);
  assert.equal(a.scored, 2);
  assert.equal(a.used, 1);
  assert.equal(a.share, 0.5);
});

test('allocation without verdicts is unknown, not zero percent', () => {
  assert.equal(allocation([]).share, null);
  assert.equal(allocation([{ bucket: BUCKET.NO_VERDICT }]).share, null);
});

test('countBuckets returns every bucket, empty ones included', () => {
  const c = countBuckets([{ bucket: BUCKET.MOVED_ON }]);
  assert.equal(c.length, 6);
  assert.equal(c.find((x) => x.bucket === BUCKET.MOVED_ON).count, 1);
  assert.equal(c.find((x) => x.bucket === BUCKET.SEARCHED).count, 0);
});

test('a missing journal is a blind spot, not a zero', () => {
  const r = measure({ journal: [], lines: [], journalPresent: false });
  assert.equal(r.occupancy.bytes, null);
  assert.equal(r.occupancy.share_material, null);
  const t = asText(r);
  assert.match(t, /unknown — not measured, not zero/);
  assert.equal(/0 bytes/.test(t), false, 'the head claims a number again');
});

test('with a journal the zero is shown as a zero', () => {
  const r = measure({
    journal: [{ ts: '2026-09-12T10:00:00Z', reason: 'empty', bytes: 0 }],
    lines: [], journalPresent: true,
  });
  assert.equal(r.occupancy.bytes, 0);
  assert.match(asText(r), /0 bytes/);
});

test('silent turns are counted with their reason', () => {
  const r = measure({
    journal: [
      { ts: '2026-09-12T10:00:00Z', reason: 'too-weak' },
      { ts: '2026-09-12T10:01:00Z', reason: 'too-weak' },
      { ts: '2026-09-12T10:02:00Z', reason: 'empty' },
    ],
    lines: [assistant([])],
  });
  assert.equal(r.silent, 3);
  assert.deepEqual(r.silent_reasons.map((x) => x.reason).sort(), ['empty', 'too-weak']);
  assert.equal(r.occupancy.injections, 0);
});

test('callsOf and pathsOf read only what is there', () => {
  assert.deepEqual(callsOf({ type: 'user' }), []);
  assert.deepEqual(pathsOf('Read', { file_path: '/a/b.md' }), ['/a/b.md']);
  assert.ok(pathsOf('Bash', { command: 'cat src/search.mjs' }).includes('src/search.mjs'));
});

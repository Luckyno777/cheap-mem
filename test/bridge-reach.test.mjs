// What the CLI can do, and how much of it a connected agent reaches.
//
// **The finding, 2026-09-08.** 35 CLI commands, 11 MCP tools. `links`,
// `experiences`, `topics`, `facts`, `show` and `explain` were built,
// tested and documented — and for any foreign agent simply not there.
// It could not walk the edge graph, follow a topic thread, or ask why
// something did NOT come back.
//
// The same pattern as with logging on the same day, one level down:
// not "the capability is missing", but "it is not reachable from where
// the work happens".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(REPO, 'bin', 'mem-mcp');

/** A memory with enough content that every tool has something to say. */
function memory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reach-'));
  const mem = (...a) => spawnSync('node', [path.join(REPO, 'bin', 'mem'), ...a],
    { cwd: root, encoding: 'utf8', timeout: 30000 });
  mem('init');
  mem('log', 'error', '--class', 'quoting', '--title', 'unquoted bash path', '--topic', 'install/windows');
  mem('log', 'learning', '--title', 'quote every path', '--topic', 'install/windows');
  mem('log', 'timeline', '--key', 'server.users', '--value', '13', '--valid_from', '2026-07-13');
  return root;
}

/** One handshake plus any number of calls, in a single process. */
function bridge(root, calls = [], extraEnv = {}) {
  const lines = [JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  })];
  if (!calls.length) lines.push(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  for (const [name, args] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }));
  }
  const r = spawnSync('node', [MCP], {
    input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...extraEnv },
  });
  return String(r.stdout).split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z));
}

const REQUIRED = ['mem_links', 'mem_show', 'mem_experiences', 'mem_topics', 'mem_facts', 'mem_explain'];

test('THE CASE: the six tools are offered at all', () => {
  const root = memory();
  try {
    const names = bridge(root).at(-1).result.tools.map((t) => t.name);
    for (const n of REQUIRED) assert.ok(names.includes(n), `${n} is missing from the bridge`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('and they ANSWER too, instead of only appearing in the list', () => {
  // A tool that is listed and throws when called is worse than one
  // that is missing: the agent believes it asked.
  const root = memory();
  try {
    const answers = bridge(root, [
      ['mem_experiences', {}], ['mem_topics', {}], ['mem_facts', {}],
    ]).slice(1);
    assert.equal(answers.length, 3, 'not every call answered');
    for (const a of answers) {
      assert.ok(!a.error, `error instead of an answer: ${JSON.stringify(a.error)}`);
      assert.ok(!a.result?.isError, `isError: ${JSON.stringify(a.result)}`);
      assert.ok(a.result.content[0].text.trim().length > 0, 'empty answer');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_facts names the value valid right now', () => {
  const root = memory();
  try {
    const [, a] = bridge(root, [['mem_facts', {}]]);
    assert.match(a.result.content[0].text, /server\.users/);
    assert.match(a.result.content[0].text, /13/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_topics without a key lists topics, with a key the thread', () => {
  // An agent that does not know the topic names cannot ask for one.
  const root = memory();
  try {
    const [, list, thread] = bridge(root, [
      ['mem_topics', {}], ['mem_topics', { key: 'install/windows' }],
    ]);
    assert.match(list.result.content[0].text, /install\/windows/);
    const lines = thread.result.content[0].text.trim().split('\n');
    assert.equal(lines.length, 2, 'the thread should show both entries');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the descriptions of the new tools name the OCCASION', () => {
  // The same lesson as with mem_find and mem_log: a tool whose occasion
  // nobody states does not get used. The list is in the context on
  // every turn — that is where the when belongs, not just the what.
  const root = memory();
  try {
    const tools = Object.fromEntries(bridge(root).at(-1).result.tools.map((t) => [t.name, t.description]));
    for (const n of REQUIRED) {
      assert.match(tools[n], /\b(call it|use it|use this|ask this|read this)\b/i,
        `${n}: the description says only WHAT, not WHEN`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Three more, added 2026-09-08: the file store -------------------
//
// Same measurement, same fix: `mem store put/list/get` existed, tested
// and documented, and unreachable from the bridge. `verify` and
// `remove` stay off it on purpose — a connected agent can register and
// read artifacts, never delete one.

const STORE_TOOLS = ['mem_store_put', 'mem_store_list', 'mem_store_get'];

test('THE GAP: the three store tools are actually offered', () => {
  const root = memory();
  try {
    const names = bridge(root).at(-1).result.tools.map((t) => t.name);
    for (const n of STORE_TOOLS) assert.ok(names.includes(n), `${n} missing from the bridge`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('their descriptions name the OCCASION, not just the capability', () => {
  const root = memory();
  try {
    const tools = Object.fromEntries(bridge(root).at(-1).result.tools.map((t) => [t.name, t.description]));
    for (const n of STORE_TOOLS) {
      assert.match(tools[n], /\b(call it|use it|use this|ask this|read this)\b/i,
        `${n}: the description says only WHAT, not WHEN`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_store_put really stores a file, mem_store_list and mem_store_get find it again', () => {
  // A tool that is listed and throws on call is worse than a missing
  // one — the agent believes it asked.
  const root = memory();
  const src = path.join(root, 'to-store.txt');
  fs.writeFileSync(src, 'a harmless generated report\n');
  try {
    const [, put] = bridge(root, [['mem_store_put', { source: src, purpose: 'test artifact' }]]);
    assert.ok(!put.error, `mem_store_put threw: ${JSON.stringify(put.error)}`);
    assert.ok(!put.result?.isError, `mem_store_put isError: ${JSON.stringify(put.result)}`);
    const hash = put.result.structuredContent.sha256;
    assert.match(hash, /^[0-9a-f]{64}$/, 'no real sha256 came back');

    const [, list] = bridge(root, [['mem_store_list', {}]]);
    assert.ok(!list.error, `mem_store_list threw: ${JSON.stringify(list.error)}`);
    assert.match(list.result.content[0].text, /to-store\.txt/);

    const [, get] = bridge(root, [['mem_store_get', { hash: hash.slice(0, 12) }]]);
    assert.ok(!get.error, `mem_store_get threw: ${JSON.stringify(get.error)}`);
    const at = get.result.content[0].text.trim();
    assert.ok(fs.existsSync(at), `mem_store_get pointed at a path that does not exist: ${at}`);
    assert.equal(fs.readFileSync(at, 'utf8'), 'a harmless generated report\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Round 3, 2026-09-08 --------------------------------------------
//
// After the multi-agent port, six capabilities existed only at the
// CLI. For an agent whose ONLY access is the bridge they therefore did
// not exist.
//
// The expensive one was `heartbeat`: `mem onboarding` checks five
// steps, and one of them was fundamentally out of reach for a
// bridge-only agent. It could behave however well it liked and stay
// red. A test bench that does not permit a result is not measuring the
// thing under test.

const ROUND3 = ['mem_heartbeat', 'mem_questions', 'mem_answer',
  'mem_procedures', 'mem_component', 'mem_source'];

test('REACH: the six new capabilities are at the bridge', () => {
  const root = memory();
  try {
    const namen = bridge(root)[1].result.tools.map((t) => t.name);
    const fehlen = ROUND3.filter((n) => !namen.includes(n));
    assert.deepEqual(fehlen, [],
      `CLI-only, and therefore absent for a bridge agent: ${fehlen.join(', ')}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('THE EXPENSIVE ONE: a bridge agent can record a heartbeat', () => {
  // Without it the onboarding step stays red for it forever.
  const root = memory();
  try {
    const [, r] = bridge(root, [['mem_heartbeat', { what: 'probe' }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    assert.ok(!r.error, JSON.stringify(r.error));
    assert.match(JSON.stringify(r.result), /Heartbeat for 'chatgpt' recorded/, JSON.stringify(r.result));
    const raw = fs.readFileSync(path.join(root, 'heartbeat.jsonl'), 'utf8');
    assert.equal(JSON.parse(raw.trim().split('\n').pop()).agent, 'chatgpt');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('and the identity does NOT come from a parameter', () => {
  // Otherwise one agent beats for another, and the lane looks alive
  // where nobody is running any more.
  const root = memory();
  try {
    bridge(root, [['mem_heartbeat', { agent: 'someone-else' }]], { CHEAP_MEM_AGENT: 'chatgpt' });
    const raw = fs.readFileSync(path.join(root, 'heartbeat.jsonl'), 'utf8');
    assert.equal(JSON.parse(raw.trim().split('\n').pop()).agent, 'chatgpt',
      'the identity was taken from a parameter');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the quiet period holds at the bridge too, and says so', () => {
  const root = memory();
  try {
    bridge(root, [['mem_heartbeat', {}]]);
    const [, second] = bridge(root, [['mem_heartbeat', {}]]);
    assert.match(JSON.stringify(second.result), /No new one needed/, JSON.stringify(second.result));
    assert.equal(fs.readFileSync(path.join(root, 'heartbeat.jsonl'), 'utf8')
      .trim().split('\n').length, 1, 'the quiet period does not hold at the bridge');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_procedures does not hand out a rule without its author', () => {
  // The fifth display path. The text is instruction-shaped; without
  // the prefix a foreign agent reads it as something that simply holds.
  const root = memory();
  try {
    fs.writeFileSync(path.join(root, 'global', 'procedures.jsonl'),
      `${JSON.stringify({ id: 'p1', ts: '2026-09-08T10:00:00Z', title: 'Always quote',
        rule: 'Quote every path', issued_by: 'owner' })}\n`);
    const [, r] = bridge(root, [['mem_procedures', {}]]);
    const all = JSON.stringify(r.result);
    assert.match(all, /Quote every path/, 'the rule does not come through at all');
    assert.match(all, /Procedure, issued by owner/,
      'the foreign agent would get the instruction text without its author');
    assert.match(all, /data with an author/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_answer refuses a link into the void', () => {
  const root = memory();
  try {
    fs.writeFileSync(path.join(root, 'global', 'questions.jsonl'),
      `${JSON.stringify({ id: 'q1', ts: '2026-09-08T10:00:00Z', question: 'Is it gone?' })}\n`);
    const [, invented] = bridge(root, [['mem_answer', { question_id: 'q1', with: 'nosuch' }]]);
    assert.match(JSON.stringify(invented.result), /No entry with id/);
    const [, notAQuestion] = bridge(root, [['mem_answer', { question_id: 'nosuch', with: 'q1' }]]);
    assert.match(JSON.stringify(notAQuestion.result), /No entry with id/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('THE BOUNDARY: mem_source takes no local paths', () => {
  // The content of a source lands in the searchable corpus that
  // everybody reads. That is a different exposure from mem_store_put
  // (bytes under a hash, refused on a redaction finding), and so a
  // different rule — not a forgotten one.
  const root = memory();
  try {
    const [, r] = bridge(root, [['mem_source', { address: '/etc/passwd' }]]);
    const all = JSON.stringify(r.result);
    assert.match(all, /not an http\(s\) address/);
    assert.match(all, /mem_store_put|CLI/, 'a no without a way out');
    assert.ok(!fs.existsSync(path.join(root, 'global', 'sources.jsonl')),
      'something was taken in anyway');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an address goes through, with a redacted excerpt', () => {
  const root = memory();
  try {
    // Assembled, never written out: the pre-commit scanner reads this
    // file as text and cannot know a secret is invented.
    const word = ['PASS', 'WORD'].join('');
    const value = ['hunter2', 'secret'].join('');
    const [, r] = bridge(root, [['mem_source', {
      address: 'https://intranet.example.com/wiki/X',
      title: 'Wiki X',
      note: `Access with ${word}=${value} and on`,
    }]]);
    assert.ok(!r.error, JSON.stringify(r.error));
    const e = JSON.parse(fs.readFileSync(path.join(root, 'global', 'sources.jsonl'), 'utf8')
      .trim().split('\n').pop());
    assert.equal(e.kind, 'address');
    assert.ok(!e.excerpt.includes(value), `unredacted: ${e.excerpt}`);
    assert.match(JSON.stringify(r.result), /redacted/,
      'redacted, but silently — nobody looks');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_component finds across both spellings, and says which', () => {
  const root = memory();
  try {
    fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'),
      `${JSON.stringify({ id: 'e9', ts: '2026-09-08T10:00:00Z', class: 'base-only',
        title: 'capture.sh fails silently' })}\n`);
    const [, r] = bridge(root, [['mem_component', { path: 'bin/capture.sh' }]]);
    const all = JSON.stringify(r.result);
    assert.match(all, /base-only/, `not found: ${all.slice(0, 200)}`);
    assert.match(all, /base/, 'the form of the evidence is missing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- The tool list, asserted by name ---------------------------------
//
// **This guard was documented before it existed.** `docs/CAPABILITIES.md`
// 7.2 says: "The tool list is asserted **by name** in the test suite, so
// a new tool is a decision someone makes rather than one that happens."
// On 2026-09-08 that sentence was checked and there was no such
// assertion anywhere. A guarantee stated in the reference and absent
// from the code is worse than a missing guarantee: a reader who
// believes it stops looking.
//
// The sibling project has had the list since the start, and it has
// fallen twice — both times correctly, both times making somebody think
// about what they had just added.

const TOOLS = [
  'mem_answer', 'mem_board', 'mem_bridge_report', 'mem_component',
  'mem_context', 'mem_duties', 'mem_duty_close', 'mem_experiences',
  'mem_explain', 'mem_facts', 'mem_find', 'mem_heartbeat',
  'mem_inbox_ack', 'mem_inbox_new', 'mem_inbox_show', 'mem_inbox_write',
  'mem_links', 'mem_log', 'mem_procedures', 'mem_project_init',
  'mem_questions', 'mem_retrieve', 'mem_show', 'mem_source',
  'mem_store_get', 'mem_store_list', 'mem_store_put', 'mem_topics',
];

test('the tool list is exactly this, by name', () => {
  const root = memory();
  try {
    const names = bridge(root).at(-1).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, TOOLS,
      'the bridge surface changed — that is a decision, so it belongs in this list');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no tool edits, deletes, commits or pushes', () => {
  const root = memory();
  try {
    const names = bridge(root).at(-1).result.tools.map((t) => t.name);
    // Four tools write, and every one of them only APPENDS:
    //   mem_log            a new line in a log
    //   mem_heartbeat      a new line, at most hourly
    //   mem_store_put      a new register line, a content-addressed file
    //   mem_bridge_report  a new line in the bridge reports
    //   mem_project_init   a directory skeleton, idempotent
    //   mem_inbox_write    a new message file
    //   mem_answer         a new `resolves` edge
    //   mem_duty_close     a closing line; the original stays
    // What is missing is any way to change or remove something that is
    // already there. `mem_inbox_ack` moves one message's own state
    // forward and nothing else.
    for (const n of names) {
      assert.ok(!/delete|remove|edit|update|overwrite|commit|push|reset|purge/i.test(n),
        `${n} sounds like more than appending and reading`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- The board and the bridge report ---------------------------------
//
// The bridge tile asks whether the server outside is serving the code in
// this repo. From inside that is unmeasurable, so the server has to
// REPORT it — and the command for that started life in the CLI only,
// while the agents it is about come in over the bridge and have no CLI.
// The tile would have stayed on `unknown` forever, for exactly the cases
// it was built for.

test('a foreign agent can report its checkout, and the board shows it', () => {
  // The whole chain in one run: report, then look. A test that only
  // checks the write leaves open whether the tile finds the record —
  // and that is where the first version was wrong (two writers, one
  // reader).
  const root = memory();
  try {
    const [, reported, boardAnswer] = bridge(root, [
      ['mem_bridge_report', { version: 'cafe123' }],
      ['mem_board', {}],
    ]);
    assert.ok(!reported.error, JSON.stringify(reported.error));
    assert.match(reported.result.content[0].text, /cafe123/);
    assert.ok(!boardAnswer.error, JSON.stringify(boardAnswer.error));
    const text = boardAnswer.result.content[0].text;
    assert.match(text, /cafe123/, 'reported, and the tile does not see it');
    assert.ok(!/no state reported/.test(text));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without a report the board says unknown, not calm', () => {
  // The counter-probe to the line above. Without it there is no way to
  // tell whether the tile read the report or is simply always green.
  const root = memory();
  try {
    const [, a] = bridge(root, [['mem_board', {}]]);
    assert.match(a.result.content[0].text, /no state reported/);
    assert.match(a.result.content[0].text, /unmeasured/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_bridge_report appends, so an earlier report survives', () => {
  // The rule the first draft broke. It rewrote one JSON file, which
  // would have made this tool the only one at the bridge that CHANGES
  // something. Appending also answers a question the overwrite could
  // not: since when has this server been on the same checkout.
  const root = memory();
  try {
    bridge(root, [
      ['mem_bridge_report', { version: 'aaa1111' }],
      ['mem_bridge_report', { version: 'bbb2222' }],
    ]);
    const lines = fs.readFileSync(path.join(root, '.mem', 'bridge-reports.jsonl'), 'utf8')
      .split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 2, 'the second report replaced the first');
    assert.equal(JSON.parse(lines[0]).version, 'aaa1111');
    // And the tile takes the NEWEST, not the first.
    const [, a] = bridge(root, [['mem_board', {}]]);
    assert.match(a.result.content[0].text, /bbb2222/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem_bridge_report without a version writes nothing', () => {
  // A half-set report would be worse than none: the tile would go calm
  // and name a version nobody is running.
  const root = memory();
  try {
    const [, a] = bridge(root, [['mem_bridge_report', {}]]);
    assert.ok(a.error || /error|hash|version/i.test(a.result?.content?.[0]?.text ?? ''),
      'an empty report was accepted');
    assert.equal(fs.existsSync(path.join(root, '.mem', 'bridge-reports.jsonl')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the identity in a report comes from the connection, not a parameter', () => {
  // Same rule as the heartbeat: otherwise one agent could report for
  // another, and the tile would name the wrong server.
  const root = memory();
  try {
    bridge(root, [['mem_bridge_report', { version: 'ddd4444', by: 'somebody-else' }]],
      { CHEAP_MEM_AGENT: 'session' });
    const line = JSON.parse(fs.readFileSync(
      path.join(root, '.mem', 'bridge-reports.jsonl'), 'utf8').trim());
    assert.equal(line.by, 'session');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The house rules a connected agent hears, and the second channel that
// keeps saying it while the agent works.
//
// **The finding.** On 2026-09-07 an agent had `mem_log` available for a
// whole day and used it zero times. In one measured task it made twelve
// tool calls, every one a read. Not out of unwillingness — nobody had
// asked it to: the MCP server served no `instructions` field, the only
// channel through which a foreign agent hears anything from us before
// it acts for the first time.
//
// **The second finding, 2026-09-08.** Logging and recall break at the
// same place: during the building. The recall hook fires only on a
// MESSAGE FROM THE USER; a foreign agent does not even have that hook.
// So both channels are checked here:
//   1. `instructions` — heard once on connect, then far away.
//   2. the TOOL DESCRIPTIONS — present in every turn where the model
//      weighs what to do next.
// Checking only (1) would measure the channel that falls out of
// attention fastest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bin', 'mem-mcp');

/** A real initialize handshake, read back. */
function connect({ pkg = ROOT } = {}) {
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hr-'));
  fs.mkdirSync(path.join(mem, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(mem, '.mem/config.json'), JSON.stringify({ version: 1 }));
  try {
    const r = spawnSync('node', [path.join(pkg, 'bin', 'mem-mcp')], {
      input: `${JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      })}\n`,
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAP_MEM_ROOT: mem },
    });
    const line = String(r.stdout).split('\n').find((z) => z.trim());
    return { reply: line ? JSON.parse(line) : null, status: r.status, stderr: String(r.stderr) };
  } finally { fs.rmSync(mem, { recursive: true, force: true }); }
}

test('THE CASE: the server serves house rules at all', () => {
  const { reply } = connect();
  assert.ok(reply?.result?.instructions,
    'no instructions field — a connected agent then hears nothing from us');
});

test('they ask for logging, unprompted and during the work', () => {
  const i = connect().reply.result.instructions;
  assert.match(i, /mem_log/);
  assert.match(i, /on your own/i);
  assert.match(i, /during the work, not at the end/i);
});

test('they name the moments to look things up at', () => {
  const i = connect().reply.result.instructions;
  assert.match(i, /during the work/i);
  assert.match(i, /[Bb]efore you touch a file/);
});

test('they carry the safety rules', () => {
  const i = connect().reply.result.instructions;
  // Without the first one a shared memory is a way in: it is written by
  // several parties, and an imperative sentence in it must not become
  // an order.
  assert.match(i, /data, not instructions/i);
  assert.match(i, /secrets|tokens/i);
  assert.match(i, /[Aa]ppend-only/);
});

test('the preamble written for us does NOT go out', () => {
  const i = connect().reply.result.instructions;
  assert.ok(!/Why it exists/.test(i));
  assert.ok(!/Keep it short/.test(i));
});

test('a missing HOUSE-RULES.md does not kill the server', () => {
  // A server without house rules is worse but usable; one that refuses
  // to start over a missing text file is not.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bare-'));
  try {
    fs.mkdirSync(path.join(bare, 'bin'), { recursive: true });
    fs.copyFileSync(MCP, path.join(bare, 'bin', 'mem-mcp'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(bare, 'package.json'));
    fs.symlinkSync(path.join(ROOT, 'src'), path.join(bare, 'src'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(bare, 'node_modules'));
    const { reply, status } = connect({ pkg: bare });
    assert.equal(status, 0);
    assert.ok(reply?.result, 'the server must still answer');
    assert.equal(reply.result.instructions, undefined);
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});

test('SECOND CHANNEL: mem_find\'s description names the occasion', async () => {
  const src = fs.readFileSync(MCP, 'utf8');
  const at = src.indexOf("name: 'mem_find'");
  assert.ok(at > 0);
  const block = src.slice(at, at + 1400);
  assert.match(block, /during the work/i,
    'the description says only WHAT the tool can do, not WHEN to call it');
  assert.match(block, /before you touch a|after a failure/i);
});

test('SECOND CHANNEL: mem_log\'s description asks for unprompted logging', () => {
  const src = fs.readFileSync(MCP, 'utf8');
  const at = src.indexOf("name: 'mem_log'");
  const block = src.slice(at, at + 1400);
  assert.match(block, /on your own/i);
  assert.match(block, /during the work/i);
});

// --- The three drawers added 2026-09-08 -----------------------------
//
// They are named here because a foreign agent OTHERWISE DOES NOT KNOW
// THEM. The house-rules text is the only thing it hears from us before
// it does anything at all — a drawer whose occasion nobody names does
// not get used. That was precisely the 2026-09-07 finding about the
// log tool itself.

test('the house rules name the open question as a drawer', () => {
  const { reply } = connect();
  assert.match(reply.result.instructions, /type: `?question`?/,
    'an agent that does not know `question` notes none');
});

test('and the source, with the promise that nothing is fetched', () => {
  const i = connect().reply.result.instructions;
  assert.match(i, /source/);
  assert.match(i, /[Nn]othing is fetched/,
    'without this line an agent expects us to dereference the address');
});

test('THE NO WITH A WAY OUT: procedure is refused, and the reason is there', () => {
  // A no without a reason and without an alternative turns a proposal
  // into nothing. The latch itself lives in bin/mem-mcp; this says the
  // agent learns about it BEFOREHAND rather than by running into it.
  const i = connect().reply.result.instructions;
  assert.match(i, /procedure/);
  assert.match(i, /refused|not written/i);
  assert.match(i, /thought/, 'the way out is missing');
});

test('the broadcast is announced — otherwise the post surprises', () => {
  assert.match(connect().reply.result.instructions, /inbox/i,
    'an agent given unannounced mail treats it as noise');
});

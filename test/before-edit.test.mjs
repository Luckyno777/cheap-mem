// mem-before-edit — recall DURING the work.
//
// **The finding.** `mem-retrieve` hangs on UserPromptSubmit and so
// fires only when the person types. Between two of their messages lies
// the actual building — and that is where the errors come from.
// Measured 2026-09-08 against four defects of one Windows install: for
// THREE of them an entry already existed naming the very file being
// touched. None was shown.
//
// The hook therefore hangs on PreToolUse (Edit|Write) and queries with
// the PATH. The property it can be falsified by comes first: for a path
// no entry mentions it MUST stay silent. A hook that always says
// something says nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'bin', 'mem-before-edit');
const MEM = path.join(ROOT, 'bin', 'mem');

function memory(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-be-'));
  const r = spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  for (const [file, lines] of Object.entries(entries)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return root;
}

function call(root, { file, session = 's1' } = {}) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: session, tool_name: 'Edit', tool_input: { file_path: file } }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '' },
  });
  const raw = String(r.stdout).trim();
  return { raw, json: raw ? JSON.parse(raw) : null, status: r.status };
}

const ENTRIES = {
  'global/errors.jsonl': [{
    id: 'a1', ts: '2026-09-07T10:00:00Z', class: 'unquoted-path',
    title: 'install/claude-code.sh does not quote the bash path',
    text: 'On Windows bash sits in "Program Files"; without quotes the hook breaks.',
  }],
  'global/thoughts.jsonl': [{
    id: 'b1', ts: '2026-09-07T11:00:00Z',
    text: 'By the way, install/claude-code.sh is a pleasant script.',
  }],
};

// Entries that share the WORD PARTS of a path but never name the file
// looked for. Without them the falsification below proves nothing: in a
// memory of two lines a ranked search finds nothing either, and the
// test would be green without `--literal` making it green. Verified:
// with this backdrop the test fails the moment `--literal` is dropped.
const BACKDROP = Array.from({ length: 60 }, (_, i) => ({
  id: `k${i}`, ts: '2026-09-01T10:00:00Z', class: `backdrop-${i}`,
  title: `src/part-${i}.mjs rebuilt`,
  text: `In src/part-${i}.mjs there was a bug; src is full of mjs files.`,
}));

test('THE FALSIFICATION: a path no entry names stays silent', () => {
  const root = memory({
    ...ENTRIES,
    'global/errors.jsonl': [...ENTRIES['global/errors.jsonl'], ...BACKDROP],
  });
  try {
    const { raw } = call(root, { file: '/x/src/nothing-here.mjs' });
    assert.equal(raw, '', `it spoke anyway: ${raw}`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('THE CASE: the entry about the touched file arrives', () => {
  const root = memory(ENTRIES);
  try {
    const { json } = call(root, { file: '/home/x/cheap-mem/install/claude-code.sh' });
    assert.ok(json, 'nothing printed');
    assert.match(json.hookSpecificOutput.additionalContext, /unquoted-path/);
    assert.equal(json.hookSpecificOutput.hookEventName, 'PreToolUse');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('warning lanes only — a thought about the same file stays out', () => {
  const root = memory(ENTRIES);
  try {
    const { json } = call(root, { file: '/home/x/cheap-mem/install/claude-code.sh' });
    assert.ok(!/pleasant/.test(json.hookSpecificOutput.additionalContext));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('twice on the same file in one session: only the first time', () => {
  const root = memory(ENTRIES);
  try {
    const f = '/home/x/cheap-mem/install/claude-code.sh';
    assert.ok(call(root, { file: f }).raw, 'even the first call was silent');
    assert.equal(call(root, { file: f }).raw, '', 'the second call repeated itself');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a different session starts over', () => {
  const root = memory(ENTRIES);
  try {
    const f = '/home/x/cheap-mem/install/claude-code.sh';
    call(root, { file: f, session: 's1' });
    assert.ok(call(root, { file: f, session: 's2' }).raw);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a Windows path is split too', () => {
  // The friend's install runs on Windows; there the hook JSON carries
  // backslashes. Splitting on "/" alone would leave the whole path as
  // one segment and the query would never match anything.
  const root = memory(ENTRIES);
  try {
    const { json } = call(root, { file: 'C:\\Users\\x\\cheap-mem\\install\\claude-code.sh' });
    assert.ok(json, 'a Windows path produced nothing');
    assert.match(json.hookSpecificOutput.additionalContext, /unquoted-path/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SECOND CHANNEL: the hit is visible to the person as well', () => {
  // additionalContext on PreToolUse is documented but not measured by
  // us. If it is ignored, the hit must not vanish without trace.
  const root = memory(ENTRIES);
  try {
    const { json } = call(root, { file: '/a/install/claude-code.sh' });
    assert.match(json.systemMessage, /install\/claude-code\.sh/);
    assert.match(json.systemMessage, /1 entry\b/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('MEM_HOOK_OFF stops it, like every other hook', () => {
  const root = memory(ENTRIES);
  try {
    const r = spawnSync('bash', [HOOK], {
      input: JSON.stringify({ session_id: 'x', tool_input: { file_path: '/a/install/claude-code.sh' } }),
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '1' },
    });
    assert.equal(String(r.stdout).trim(), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('broken hook JSON never holds up an edit', () => {
  const root = memory(ENTRIES);
  try {
    const r = spawnSync('bash', [HOOK], {
      input: 'not json', encoding: 'utf8', timeout: 30000,
      env: { ...process.env, CHEAP_MEM_ROOT: root },
    });
    assert.equal(r.status, 0);
    assert.equal(String(r.stdout).trim(), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('without a memory it ends quietly', () => {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: 'x', tool_input: { file_path: '/a/b.mjs' } }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: '/nope', MEM_RETRIEVE_ROOTS: '/nope2' },
  });
  assert.equal(r.status, 0);
  assert.equal(String(r.stdout).trim(), '');
});

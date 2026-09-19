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
// Covers an assurance from shared/invariants.jsonl.
// invariant: unterprozess-nennt-ursache
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
    // The trace names the branch the hook exits at, on stderr. It is
    // off in normal use and never touches stdout; here it is on so a
    // failing assertion can say WHICH exit was taken instead of only
    // that nothing came back.
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_TRACE: '1' },
  });
  const raw = String(r.stdout ?? '').trim();
  // **A silent hook must say why it was silent.**
  //
  // This used to return `json: null` and nothing else, so a failure
  // read "the hook does not see the entry: (silent)" — which names
  // neither the exit code nor the stack bash printed. Eight of this
  // file's tests fail that way on every Windows CI run while Linux and
  // macOS are green, and for days that message was the whole evidence.
  //
  // Silence is a legitimate ANSWER here (no matching entry), so this
  // cannot throw. It carries the cause along instead, and `warum()`
  // turns it into an assertion message.
  return {
    raw,
    json: raw ? JSON.parse(raw) : null,
    status: r.status,
    signal: r.signal ?? null,
    spawnError: r.error ? r.error.message : null,
    stderr: String(r.stderr ?? '').trim(),
  };
}

/** Why was it silent? For assertion messages, so a red test explains itself. */
function warum(a) {
  return `(silent)  exit=${a.status} signal=${a.signal ?? '-'} `
    + `spawn=${a.spawnError ?? '-'}\n  stderr: ${a.stderr.slice(0, 1200) || '(empty)'}`;
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
    const a = call(root, { file: '/home/x/cheap-mem/install/claude-code.sh' });
    const { json } = a;
    assert.ok(json, `nothing printed ${warum(a)}`);
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

test('twice on the same file: a pointer the second time, NEVER silence', () => {
  // The old guarantee was `raw === ''` — the second edit got nothing.
  // But silence reads as "there is nothing about this file", and that
  // was wrong. Now: one line instead of a block.
  const root = memory(ENTRIES);
  try {
    const f = '/home/x/cheap-mem/install/claude-code.sh';
    const one = call(root, { file: f });
    assert.ok(one.raw, `even the first call was silent ${warum(one)}`);
    assert.match(one.json.hookSpecificOutput.additionalContext, /went wrong here before/);

    const two = call(root, { file: f });
    assert.ok(two.raw, `the second call was silent — exactly the defect ${warum(two)}`);
    const t = two.json.hookSpecificOutput.additionalContext;
    // `warum(two)` on these three as well, not only on the silence above.
    // On the 2026-09-16 Windows runner this assertion failed with nothing
    // but the repeated block to look at — while the trace that names the
    // branch was already being collected and simply not printed. A
    // diagnosis that exists and is not shown is worth as much as none.
    assert.match(t, /already injected/, `the block came back instead of a pointer ${warum(two)}`);
    assert.match(t, /unchanged/, `no watermark in the pointer ${warum(two)}`);
    assert.ok(!/went wrong here before/.test(t),
      `the second call repeated the block ${warum(two)}`);
    assert.ok(two.raw.length < one.raw.length, 'the pointer is not shorter than the block');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an entry arriving DURING the session brings the full block back', () => {
  // The case the old mark hid until the session ended — and the normal
  // one while working on a file: you build, it breaks, you log, you
  // build on.
  const root = memory(ENTRIES);
  try {
    const f = '/home/x/cheap-mem/install/claude-code.sh';
    assert.ok(call(root, { file: f }).raw);
    fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'), JSON.stringify({
      id: 'e2', ts: '2026-09-12T09:00:00Z', class: 'brand-new',
      title: 'install/claude-code.sh also breaks on an empty HOME',
      text: 'Happened today.',
    }) + '\n');
    const a = call(root, { file: f });
    assert.ok(a.json, `the hook does not see the entry ${warum(a)}`);
    const t = a.json.hookSpecificOutput.additionalContext;
    assert.match(t, /brand-new|empty HOME|went wrong here before/,
      'the new entry was withheld');
    assert.ok(!/already injected/.test(t), 'only a pointer despite a new entry');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('when the memory grows ELSEWHERE it stays a pointer', () => {
  // The watermark alone would show again here. Only the fingerprint
  // says that nothing about THIS answer changed.
  const root = memory(ENTRIES);
  try {
    const f = '/home/x/cheap-mem/install/claude-code.sh';
    assert.ok(call(root, { file: f }).raw);
    fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'), JSON.stringify({
      id: 'z9', ts: '2026-09-12T09:30:00Z', class: 'elsewhere',
      title: 'src/somewhere-else.mjs falls over', text: 'Nothing to do with the installer.',
    }) + '\n');
    const a = call(root, { file: f });
    assert.ok(a.json, `the hook does not see the entry ${warum(a)}`);
    const t = a.json.hookSpecificOutput.additionalContext;
    assert.match(t, /already injected/,
      `a foreign entry triggered the whole block again ${warum(a)}`);
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

test('a Windows ROOT is found too', () => {
  // The path SPLIT was handled (the test below); the path to the
  // memory ITSELF was not. On Windows the agent hands this hook a
  // native root — `C:\\Users\\x\\...` — and `[ -f "$k/.mem/config.json" ]`
  // finds nothing there. The hook then exits 0 without a word, which
  // from the outside looks exactly like "nothing to say about this
  // file". So on Windows it did nothing at all, silently, for as long
  // as it has existed.
  //
  // Reproducible without Windows, which is why this test can exist
  // here: the same memory answers with content when addressed with
  // slashes and with nothing when addressed with backslashes.
  const root = memory(ENTRIES);
  try {
    const gerade = call(root, { file: '/home/x/cheap-mem/install/claude-code.sh', session: 'w1' });
    assert.ok(gerade.raw, `precondition: the memory answers at all ${warum(gerade)}`);

    const schief = call(root.replace(/\//g, '\\'),
      { file: '/home/x/cheap-mem/install/claude-code.sh', session: 'w2' });
    assert.ok(schief.raw,
      'a memory addressed with backslashes was not found, and the hook said nothing '
      + `about it — the exact Windows failure ${warum(schief)}`);
    assert.equal(schief.json.hookSpecificOutput.additionalContext,
      gerade.json.hookSpecificOutput.additionalContext,
      'both spellings of the same root must give the same answer');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a Windows path is split too', () => {
  // The friend's install runs on Windows; there the hook JSON carries
  // backslashes. Splitting on "/" alone would leave the whole path as
  // one segment and the query would never match anything.
  const root = memory(ENTRIES);
  try {
    const a = call(root, { file: 'C:\\Users\\x\\cheap-mem\\install\\claude-code.sh' });
    const { json } = a;
    assert.ok(json, `a Windows path produced nothing ${warum(a)}`);
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

// --------------------------------------------------------------------
// A path is not an ESM specifier.
//
// The hooks load `src/pointer.mjs` via `node -e 'import(process.argv[1])'`.
// On Linux this works fine, because `/home/...` happens to also be a
// valid absolute specifier. On Windows that is `D:/a/...`, and Node
// reads `D:` as a URL SCHEME:
//
//     D:/a/x/src/pointer.mjs  ->  ERR_UNSUPPORTED_ESM_URL_SCHEME
//
// Each of the six calls catches this with `.catch()` and returns an
// empty state. So the hook re-displayed the full block on EVERY edit
// there instead of setting a pointer the second time, and never wrote a
// mark — measured on 2026-09-16.
//
// invariant: fremder-pfad-wird-normalisiert
// error-class: looks-right-does-nothing
test('no hook passes a bare path along as an ESM specifier', () => {
  const hooks = fs.readdirSync(path.join(ROOT, 'bin'))
    .filter((n) => n.startsWith('mem-'))
    .map((n) => [n, fs.readFileSync(path.join(ROOT, 'bin', n), 'utf8')]);
  assert.ok(hooks.length > 0, 'no hooks found — this probe measures nothing');

  let checked = 0;
  for (const [name, text] of hooks) {
    if (!text.includes('import(process.argv')) continue;
    checked += 1;
    // Whatever is passed at the end of node -e must be a URL variable.
    //
    // **Two spellings since 2026-09-19.** bin/ carries both shells now:
    // the bash hooks hand the specifier over as `' "$PTR_URL" 2>/dev/null`,
    // the PowerShell ports as `node -e $SomeScript $PtrUrl 2>$null`. A
    // probe that knew only the bash shape reported the new .ps1 files as
    // "no handoff found" — a true statement about the pattern and a
    // false one about the file, and the kind of false alarm that gets a
    // guard switched off. The RULE is unchanged: the last argument must
    // name a URL, not a path.
    const handoffs = [
      ...(text.match(/'\s+"\$[A-Z_]+"\s+2>\/dev\/null/g) ?? []),
      ...(text.match(/node -e \$[A-Za-z]+\s+\$[A-Za-z]+\s+2>\$null/g) ?? []),
    ];
    assert.ok(handoffs.length > 0, `${name}: no handoff found`);
    for (const u of handoffs) {
      assert.match(u, /_URL"|Url\b/,
        `${name} passes a bare path along: ${u.trim()}`);
    }
  }
  // Positive control: if the probe found no hook with a dynamic import
  // at all, it would be green and blind.
  assert.ok(checked > 0,
    'no hook uses import(process.argv) — this probe checked nothing');
});

test('a path with a drive letter really is invalid as a specifier', async () => {
  // The reasoning behind the guard next to this, measured rather than
  // assumed — and on EVERY platform, because `D:` is read as a scheme
  // everywhere. If this test ever fails because Node accepts it after
  // all, the guard above has become redundant and may go.
  await assert.rejects(
    () => import('D:/a/x/src/pointer.mjs'),  // windows-path-ok: this IS the negative case
    (e) => ['ERR_UNSUPPORTED_ESM_URL_SCHEME', 'ERR_MODULE_NOT_FOUND'].includes(e.code),
    'a drive path suddenly loads after all');
});

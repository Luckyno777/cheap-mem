// hooks-harden-cm / TB5 — the before-edit hook runs in ONE node process now
// (bin/mem-before-edit-core.mjs, src/beforeedit.mjs). The output must not have
// moved by a single byte.
//
// The reference is the OLD hook, kept verbatim as test/fixture/before-edit-v1/
// mem-before-edit.sh.txt (the bash hook as of e98bf2d: a dozen `node -e`
// snippets and one `node bin/mem component`). Old and new run side by side on
// the same memory, each with its own marks directory, step by step: stdout,
// exit code, trace, and the line each books into the injection journal (minus
// the clock fields) are compared.
//
// Cases: a hit, the pointer on the second call, the pointer after an unrelated
// entry, a fresh block after a related one; no hit; broken log; missing and
// empty memory; open duty and released procedure; a solution line (also a
// commit solution); Bash that writes a file and Bash that does not; a short
// path; input that is not JSON.
//
// The probe must be able to fail: POSITIVE CONTROL runs a mutated copy of the
// new hook (one character of the final text changed) through the same compare
// and demands that it reports a difference. A compare that never differs
// measures nothing.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { OLD_HOOK_TEXT, toolDir } from './fixture/before-edit-old.mjs';
import * as memory from '../src/memory.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const FILE = '/home/x/proj/install/claude-code.sh';

function world(t) {
  const root = tempDir('cm-bego-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}
const log = (root, type, fields) => memory.logEntry(root, type, fields).entry;

/** The journal lines past `from`, without the clock. */
function journalSince(root, from) {
  const f = path.join(root, '.pipeline', 'injections.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(from).map((l) => {
    const j = JSON.parse(l);
    delete j.ts; delete j.duration_ms;
    return j;
  });
}
const journalLen = (root) => {
  const f = path.join(root, '.pipeline', 'injections.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0;
};

function call(hook, root, marks, input, extraEnv = {}) {
  const before = journalLen(root);
  const r = spawnSync('bash', [hook], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_BEFORE_EDIT_MARKS: marks, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '',
      MEM_BEFORE_EDIT_TRACE: '1', ...extraEnv },
  });
  return {
    stdout: r.stdout, status: r.status,
    // the trace, without the two path-bearing words that differ by construction
    stderr: String(r.stderr).split('\n').filter((l) => /^mem-before-edit: (exit at|no-)/.test(l) || /mark written/.test(l)).join('\n')
      .replaceAll(marks, '<marks>'),
    journal: journalSince(root, before),
  };
}

const edit = (file = FILE, session = 's1', tool = 'Edit') => ({ session_id: session, tool_name: tool, tool_input: { file_path: file } });
const bash = (command, session = 's1') => ({ session_id: session, tool_name: 'Bash', tool_input: { command } });

/** Run one scenario on old and new; return [{step, old, new}]. */
function compare(t, build, steps, { newHookText = null, env = {} } = {}) {
  const root = build();
  const oldHook = toolDir(t, fs.readFileSync(OLD_HOOK_TEXT, 'utf8'));
  const newHook = toolDir(t, newHookText ?? fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8'), { core: true });
  const mOld = tempDir('cm-bego-mo-', t);
  const mNew = tempDir('cm-bego-mn-', t);
  const rows = [];
  for (const [name, step] of steps) {
    if (typeof step === 'function') { step(root); continue; }
    // old first, then new: the hook does not write into the memory's books,
    // so the order cannot matter; the journal is read per call.
    const o = call(oldHook, root, mOld, step, env);
    const n = call(newHook, root, mNew, step, env);
    rows.push({ name, o, n });
  }
  return rows;
}
function same(rows) {
  for (const { name, o, n } of rows) {
    assert.equal(n.stdout, o.stdout, `${name}: stdout differs\n old: ${o.stdout}\n new: ${n.stdout}`);
    assert.equal(n.status, o.status, `${name}: exit code differs`);
    assert.equal(n.stderr, o.stderr, `${name}: trace differs`);
    assert.deepEqual(n.journal, o.journal, `${name}: journal line differs`);
  }
}

const ERR = { class: 'unquoted-path', title: 'install/claude-code.sh does not quote the bash path', text: 'install/claude-code.sh breaks on a space' };

function hitWorld(t) {
  return () => {
    const root = world(t);
    log(root, 'error', ERR);
    log(root, 'decision', { topic: 'install/claude-code.sh', choice: 'quote every path', why: 'spaces in HOME' });
    log(root, 'thought', { title: 'thought about install/claude-code.sh stays out (not a warning lane)' });
    return root;
  };
}

test('a hit, then the pointer, then the pointer after an unrelated entry, then a fresh block after a related one', (t) => {
  let root;
  const rows = compare(t, () => { root = hitWorld(t)(); return root; }, [
    ['first call: the block', edit()],
    ['second call: the pointer', edit()],
    ['an unrelated entry', (r) => log(r, 'error', { class: 'x', title: 'src/other.mjs unrelated', text: 'nothing about the file' })],
    ['third call: still the pointer (content-equal)', edit()],
    ['a related entry', (r) => log(r, 'error', { class: 'y', title: 'install/claude-code.sh second defect', text: 'install/claude-code.sh again' })],
    ['fourth call: a fresh block', edit()],
    ['other session: the block again', edit(FILE, 's2')],
    ['NotebookEdit shape', { session_id: 's3', tool_name: 'NotebookEdit', tool_input: { notebook_path: FILE } }],
  ]);
  same(rows);
  const [first, second, third, fourth] = rows;
  assert.match(first.n.stdout, /memory knows install\/claude-code\.sh: 2 entries/, 'the probe must see a block at all');
  assert.match(second.n.stdout, /already injected in this session and unchanged/);
  assert.match(third.n.stdout, /already injected/);
  assert.match(fourth.n.stdout, /memory knows install\/claude-code\.sh: 3 entries/);
  assert.equal(first.n.journal.length, 1, 'one journal line per run that reached a query');
});

test('no hit stays silent, and so does a short path, a missing path and input that is not JSON', (t) => {
  const rows = compare(t, hitWorld(t), [
    ['invented path', edit('/home/x/proj/src/never-mentioned-anywhere.mjs')],
    ['short path', edit('a.c')],
    ['no path at all', { session_id: 's1', tool_name: 'Read', tool_input: {} }],
    ['not JSON', 'this is not json'],
    ['empty stdin', ''],
  ]);
  same(rows);
  for (const r of rows) assert.equal(r.n.stdout, '', `${r.name} answered something`);
});

test('a broken log: garbage lines next to a good one', (t) => {
  const rows = compare(t, () => {
    const root = hitWorld(t)();
    fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'), '{"id":"broken", "title": \n');
    fs.appendFileSync(path.join(root, 'global', 'decisions.jsonl'), 'not json at all\n');
    return root;
  }, [['first', edit()], ['second', edit()]]);
  same(rows);
  assert.match(rows[0].n.stdout, /memory knows/, 'the good entries still arrive');
});

test('a missing memory and an empty memory', (t) => {
  const home = tempDir('cm-bego-home-', t);
  const missing = path.join(home, 'no-such-memory');
  const oldHook = toolDir(t, fs.readFileSync(OLD_HOOK_TEXT, 'utf8'));
  const newHook = toolDir(t, fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8'), { core: true });
  const mo = tempDir('cm-bego-mo-', t); const mn = tempDir('cm-bego-mn-', t);
  // HOME has no cheap-mem either: the probe list finds nothing.
  const env = { HOME: home, USERPROFILE: home, MEM_RETRIEVE_ROOTS: '' };
  const o = call(oldHook, missing, mo, edit(), env);
  const n = call(newHook, missing, mn, edit(), env);
  assert.equal(o.stdout, ''); assert.equal(n.stdout, o.stdout);
  assert.equal(n.status, o.status);
  assert.equal(n.stderr.replace(/\(CHEAP_MEM_ROOT=[^)]*\)/, ''), o.stderr.replace(/\(CHEAP_MEM_ROOT=[^)]*\)/, ''));
  assert.match(n.stderr, /exit at no-root/);

  const rows = compare(t, () => world(t), [['empty memory', edit()], ['again', edit()]]);
  same(rows);
  assert.equal(rows[0].n.stdout, '');
});

test('an open duty, a released procedure; a closed duty and a proposed rule never', (t) => {
  const rows = compare(t, () => {
    const root = world(t);
    log(root, 'duty', { file: 'install/claude-code.sh', owner: 'a', title: 'OWED-GUARD add a quoting probe' });
    log(root, 'procedure', { issued_by: 'owner', start_status: 'released', title: 'RULE-IN-FORCE', rule: 'Quote every path in install/claude-code.sh.' });
    log(root, 'procedure', { issued_by: 'owner', start_status: 'proposed', title: 'RULE-PROPOSED', rule: 'Rewrite install/claude-code.sh elsewhere.' });
    log(root, 'error', ERR);
    return root;
  }, [['first', edit()], ['second', edit()]]);
  same(rows);
  assert.match(rows[0].n.stdout, /\(open duty\).*OWED-GUARD/);
  assert.match(rows[0].n.stdout, /\(procedure\).*RULE-IN-FORCE/);
  assert.doesNotMatch(rows[0].n.stdout, /RULE-PROPOSED/);
});

test('a solution line below its error, a commit solution too (the journal books the same ids)', (t) => {
  const rows = compare(t, () => {
    const root = world(t);
    const e = log(root, 'error', ERR);
    const l = log(root, 'learning', { title: 'Quote the path first', learning: 'Quote the path first - body' });
    log(root, 'link', { from: l.id, to: e.id, kind: 'resolves', why: 'a reason', agent: 'test' });
    const e2 = log(root, 'error', { class: 'z', title: 'install/claude-code.sh second one', text: 'install/claude-code.sh again' });
    log(root, 'link', { from: 'commit:0123456789abcdef', to: e2.id, kind: 'resolves', evidence: 'commit:0123456789ab',
      why: `Commit 0123456789ab carries "Fixes: ${e2.id}": quote the path` });
    return root;
  }, [['first', edit()]]);
  same(rows);
  assert.match(rows[0].n.stdout, /\\u21b3 Solution|↳ Solution/, 'the probe must see a solution line');
  assert.ok(rows[0].n.journal[0].ids.length >= 1, 'solution ids reach the journal');
});

test('Bash: a command that writes a file recalls like an Edit; one that writes none is silent', (t) => {
  const rows = compare(t, hitWorld(t), [
    ['writes via tee', bash('printf x | tee install/claude-code.sh')],
    ['redirect into the file, same session', bash('echo x >> install/claude-code.sh')],
    ['writes via sed -i, other session', bash("sed -i 's/a/b/' install/claude-code.sh", 's2')],
    ['reads only', bash('cat install/claude-code.sh 2>&1 >/dev/null', 's3')],
    ['pipes, writes none', bash("grep -n x install/claude-code.sh | sed 's/a/b/'", 's4')],
    ['writes nothing named', bash('ls -la', 's5')],
  ]);
  same(rows);
  assert.match(rows[0].n.stdout, /memory knows install\/claude-code\.sh/);
  assert.equal(rows[3].n.stdout, '');
});

test('the switches: off, hook-off, and a top of one', (t) => {
  const root = hitWorld(t)();
  const oldHook = toolDir(t, fs.readFileSync(OLD_HOOK_TEXT, 'utf8'));
  const newHook = toolDir(t, fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8'), { core: true });
  for (const env of [{ MEM_BEFORE_EDIT_OFF: '1' }, { MEM_HOOK_OFF: '1' }, { MEM_BEFORE_EDIT_TOP: '1' }, { MEM_BEFORE_EDIT_TOP: '0' }]) {
    const mo = tempDir('cm-bego-mo-', t); const mn = tempDir('cm-bego-mn-', t);
    const o = call(oldHook, root, mo, edit(), env);
    const n = call(newHook, root, mn, edit(), env);
    assert.equal(n.stdout, o.stdout, JSON.stringify(env));
    assert.equal(n.stderr, o.stderr, JSON.stringify(env));
    assert.deepEqual(n.journal, o.journal, JSON.stringify(env));
  }
});

test('POSITIVE CONTROL: the compare fails on a hook whose final text differs by one character', (t) => {
  const text = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  const core = fs.readFileSync(path.join(REPO, 'src', 'beforeedit.mjs'), 'utf8');
  assert.ok(core.includes('what went wrong here before'), 'the string the mutation targets moved');
  // Mutate the module copy inside a tool dir of its own.
  const hook = toolDir(t, text, { core: true });
  const mod = path.join(path.dirname(hook), '..', 'src', 'beforeedit.mjs');
  fs.writeFileSync(mod, core.replace('what went wrong here before', 'what went wrong here befor'));
  const root = hitWorld(t)();
  const oldHook = toolDir(t, fs.readFileSync(OLD_HOOK_TEXT, 'utf8'));
  const o = call(oldHook, root, tempDir('cm-bego-mo-', t), edit());
  const n = call(hook, root, tempDir('cm-bego-mn-', t), edit());
  assert.ok(o.stdout.includes('what went wrong here before'), 'the old hook shows the block');
  assert.notEqual(n.stdout, o.stdout, 'the compare did not notice a changed character');
});

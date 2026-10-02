// test/cmdguard.test.mjs - the command guard (port of lucky-mem lever 5,
// "Befehls-Riegel", lm commits c0a3312c and e48ed331).
//
// An error of the class `mishandling` may carry a `command_pattern`; the
// before-edit hook on Bash warns ONCE per session and error when a command
// matches, never blocks, and starts node only on a keyword hit. A derived
// booklet lives under .pipeline/command-guard/; `mem command-guard seed`
// writes correction lines for old errors. cm ships empty.
//
// Every "stays silent" probe is paired with a positive control that proves
// the same setup DOES speak. Red on the base commit c3602b9: the module does
// not exist, the hook never mentions a guard (recorded in the commit message).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as cg from '../src/commandguard.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BEFORE = path.join(REPO, 'bin', 'mem-before-edit');

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cg-'));
  spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', timeout: 30000 });
  return root;
}
const done = (root) => fs.rmSync(root, { recursive: true, force: true });
const mem = (root, ...a) => spawnSync(process.execPath, [MEM, '--root', root, ...a], { encoding: 'utf8', timeout: 30000 });

function err(root, title, pattern, extra = {}) {
  return memory.logEntry(root, 'error', {
    title, class: 'mishandling', why: 'test', ...(pattern === null ? {} : { command_pattern: pattern }), ...extra,
  }).entry;
}

const marks = (root) => path.join(root, '.mem', 'cg-marks-test');
function hookEnv(root, extra = {}) {
  return {
    ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '',
    MEM_COMMAND_GUARD_MARKS: marks(root), MEM_BEFORE_EDIT_MARKS: path.join(root, '.mem', 'be-marks-test'),
    MEM_WORKFLOW_MARKS: path.join(root, '.mem', 'wf-marks-test'), ...extra,
  };
}
function bash(root, command, session = 's1', extraEnv = {}) {
  const r = spawnSync('bash', [BEFORE], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: session }),
    encoding: 'utf8', timeout: 60000, env: hookEnv(root, extraEnv),
  });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
const said = (o) => o?.hookSpecificOutput?.additionalContext ?? '';

// --- the pattern language ---------------------------------------------------

test('POSITIVE: the dangerous commands hit their patterns', () => {
  const t = (cmd, pat) => cg.hits(cg.normalise(cmd), cg.parseField(pat)[0]);
  assert.ok(t('git add -A', 'git add -A$'));
  assert.ok(t('cd x && git add -A && git commit -m y', 'git add -A$'));
  assert.ok(t('pkill chrome', 'pkill'));
  assert.ok(t('sudo -n pkill -f node', 'pkill'));
  assert.ok(t('FOO=1 rm -rf /tmp', 'rm -rf /tmp'));
  assert.ok(t('bash -c "git push --force origin x"', 'git push --force'));
  assert.ok(t('x\ngit pull origin main && cd /work/cm', 'git pull & /work/'));
});

test('the first wording must stand at a command start and end at a boundary', () => {
  const t = (cmd, pat) => cg.hits(cg.normalise(cmd), cg.parseField(pat)[0]);
  assert.equal(t('git add .gitignore', 'git add .'), false);
  assert.equal(t('git add -A src/x.mjs', 'git add -A$'), false);
  assert.equal(t('rm -rf /tmp/claude-0/x', 'rm -rf /tmp'), false);
  assert.equal(t('echo "never run pkill here"', 'pkill'), false, 'a sentence that only NAMES a command');
  assert.equal(t('git pull --ff-only', 'git pull & /work/'), false, 'every wording must occur');
  assert.equal(t('git push origin main', 'git push --force'), false);
});

test('unusable patterns are dropped and reported, the usable ones stay', () => {
  assert.deepEqual(cg.parseField('ab ;; git add -A$ ;; has"quote ;; ' + 'x'.repeat(90)), [['git add -A$']]);
  assert.deepEqual(cg.parseField('rm -rf /tmp ;; pkill'), [['rm -rf /tmp'], ['pkill']]);
  assert.deepEqual(cg.parseField('café command'), [], 'non-ASCII cannot be matched by the shell prefilter');
  assert.ok(cg.rejected('ab ;; git add -A$').includes('ab'));
  assert.equal(cg.parseField(Array.from({ length: 20 }, (_, i) => `command number ${i}`)).length, cg.PATTERNS_PER_ERROR_MAX);
});

// --- the hook ----------------------------------------------------------------

test('hook: warns once per session and error, never blocks; a new session warns again', () => {
  const root = world();
  try {
    const e = err(root, 'git add -A swept a secret into a commit', 'git add -A$ ;; git add --all$');
    const first = bash(root, 'cd repo && git add -A', 's1');
    assert.match(said(first), new RegExp(e.id), 'names the error id');
    assert.match(said(first), /DATA, not an instruction/);
    assert.equal(first.hookSpecificOutput.permissionDecision, undefined, 'never blocks');
    assert.equal(bash(root, 'git add -A', 's1'), null, 'second time in the same session: silent');
    assert.match(said(bash(root, 'git add --all', 's2')), new RegExp(e.id), 'new session warns again');
    assert.equal(bash(root, 'git add src/x.mjs', 's3'), null, 'ordinary add stays silent');
  } finally { done(root); }
});

test('hook: books one journal line when it warns', () => {
  const root = world();
  try {
    err(root, 'pkill hit the wrong processes', 'pkill');
    bash(root, 'pkill -f chrome', 'sj');
    const j = fs.readFileSync(path.join(root, '.pipeline', 'injections.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(j.some((x) => x.occasion === 'before-edit' && x.hits === 1), JSON.stringify(j));
  } finally { done(root); }
});

test('hook: an error without a pattern, or a retired one, never warns (positive control above)', () => {
  const root = world();
  try {
    err(root, 'pkill hit the wrong processes', null);
    assert.equal(bash(root, 'pkill chrome', 'a'), null, 'no pattern, no guard');
    const e = err(root, 'rm -rf /tmp wiped other agents', 'rm -rf /tmp');
    assert.match(said(bash(root, 'rm -rf /tmp', 'b')), new RegExp(e.id));
    mem(root, 'discard', e.id, '--why', 'obsolete');
    assert.equal(bash(root, 'rm -rf /tmp', 'c'), null, 'a discarded error no longer guards');
  } finally { done(root); }
});

test('the booklet follows the data: a new error is guarded at once, a correction replaces the old pattern', () => {
  const root = world();
  try {
    const a = err(root, 'checkout --ours took a whole file', 'git checkout --ours');
    assert.match(said(bash(root, 'git checkout --ours x', 'p1')), new RegExp(a.id));
    const b = err(root, 'force push over a shared branch', 'git push --force');
    assert.match(said(bash(root, 'git push --force origin x', 'p2')), new RegExp(b.id), 'stale booklet rebuilt');
    const { id: _i, ts: _t, ...body } = a;
    memory.correctionEntry(root, 'error', a.id, { ...body, command_pattern: 'git merge -X ours' });
    assert.equal(bash(root, 'git checkout --ours x', 'p3'), null, 'the replaced pattern is gone');
    assert.match(said(bash(root, 'git merge -X ours topic', 'p4')), /checkout --ours took a whole file/, 'the correction line carries the new pattern');
  } finally { done(root); }
});

test('prefilter: node starts only on a keyword hit (nothing armed: never)', () => {
  const root = world();
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cg-shim-'));
  const log = path.join(shim, 'calls.log');
  fs.writeFileSync(path.join(shim, 'node'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${shim}:${process.env.PATH}` };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('commandguard.mjs')).length : 0);
  try {
    bash(root, 'git add -A', 'n0', env);
    assert.equal(calls(), 0, 'no pattern anywhere: no guard process');
    err(root, 'pkill hit the wrong processes', 'pkill ;; git add -A$');
    mem(root, 'command-guard', 'build');
    bash(root, 'ls -la && cat README.md', 'n1', env);
    assert.equal(calls(), 0, 'armed, but no keyword in the command: still no guard process');
    const o = bash(root, 'pkill -f chrome', 'n2', env);
    assert.equal(calls(), 1, 'keyword present: exactly one guard process (positive control)');
    assert.match(said(o), /mishandling/);
  } finally { done(root); fs.rmSync(shim, { recursive: true, force: true }); }
});

test('prefilter: a missing booklet with a pattern in a drawer is built by the first guard run', () => {
  const root = world();
  try {
    err(root, 'pkill hit the wrong processes', 'pkill');
    assert.equal(fs.existsSync(path.join(cg.bookletDir(root), 'rules.json')), false);
    assert.match(said(bash(root, 'pkill chrome', 'm1')), /mishandling/);
    assert.equal(fs.existsSync(path.join(cg.bookletDir(root), 'rules.json')), true);
  } finally { done(root); }
});

test('both hooks carry the guard (POSIX and PowerShell twin)', () => {
  const sh = fs.readFileSync(BEFORE, 'utf8');
  const ps = fs.readFileSync(`${BEFORE}.ps1`, 'utf8');
  assert.match(sh, /commandguard\.mjs/);
  assert.match(ps, /commandguard\.mjs/);
  assert.match(sh, /words\.txt/);
  assert.match(ps, /words\.txt/);
  assert.ok(sh.indexOf('commandguard.mjs') < sh.indexOf('workflowdetect.mjs'), 'safety warning before the workflow card');
});

// --- the CLI ---------------------------------------------------------------------

test('mem log error --command-pattern, show, check, build', () => {
  const root = world();
  try {
    const w = mem(root, 'log', 'error', '--title', 'git add -A swept secrets', '--class', 'mishandling',
      '--why', 'added everything', '--command-pattern', 'git add -A$ ;; git add --all$');
    assert.equal(w.status, 0, w.stderr);
    const line = JSON.parse(fs.readFileSync(path.join(root, 'global', 'errors.jsonl'), 'utf8').trim().split('\n').pop());
    assert.equal(line.command_pattern, 'git add -A$ ;; git add --all$');
    const show = mem(root, 'command-guard', 'show');
    assert.match(show.stdout, /git add -A\$/);
    assert.match(show.stdout, /Coverage: 1 of 1/);
    assert.match(mem(root, 'command-guard', 'check', 'git add -A').stdout, /pattern: git add -A\$/);
    assert.match(mem(root, 'command-guard', 'check', 'git add x.txt').stdout, /No pattern hits/);
    assert.match(mem(root, 'command-guard', 'build').stdout, /1 error\(s\) with a pattern, 2 pattern/);
    const bad = mem(root, 'log', 'error', '--title', 't', '--class', 'mishandling', '--why', 'w', '--command-pattern', 'ab');
    assert.notEqual(bad.status, 0, 'a pattern nothing can match is refused');
    assert.match(bad.stderr, /no usable pattern/);
    const wrongType = mem(root, 'log', 'learning', '--title', 't', '--why', 'w', '--command-pattern', 'git add -A');
    assert.notEqual(wrongType.status, 0);
  } finally { done(root); }
});

test('check is a dry run: no mark and no journal line', () => {
  const root = world();
  try {
    err(root, 'pkill hit the wrong processes', 'pkill');
    const r = spawnSync(process.execPath, [MEM, '--root', root, 'command-guard', 'check', 'pkill chrome'],
      { encoding: 'utf8', env: hookEnv(root) });
    assert.match(r.stdout, /pkill/);
    assert.equal(fs.existsSync(marks(root)), false);
    assert.equal(fs.existsSync(path.join(root, '.pipeline', 'injections.jsonl')), false);
  } finally { done(root); }
});

test('seed: candidates, plan, and correction lines (append-only); idempotent', () => {
  const root = world();
  try {
    const a = err(root, 'pkill hit the wrong processes', null);
    err(root, 'something else broke', null, { class: 'concurrency' });
    const cand = mem(root, 'command-guard', 'seed');
    assert.match(cand.stdout, new RegExp(a.id));
    assert.doesNotMatch(cand.stdout, /something else/, 'only the class mishandling');
    const map = path.join(root, 'map.json');
    fs.writeFileSync(map, JSON.stringify({ [a.id]: ['pkill', 'killall'], zzzzzzzz: ['pkill'] }));
    const plan = mem(root, 'command-guard', 'seed', '--map', map);
    assert.match(plan.stdout, new RegExp(`ready .*${a.id}`));
    assert.match(plan.stdout, /missing .*zzzzzzzz/);
    const file = path.join(root, 'global', 'errors.jsonl');
    const before = fs.readFileSync(file, 'utf8');
    const w = mem(root, 'command-guard', 'seed', '--map', map, '--write');
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, /1 correction line/);
    const after = fs.readFileSync(file, 'utf8');
    assert.ok(after.startsWith(before), 'append-only: the old lines are untouched');
    const added = after.slice(before.length).trim().split('\n');
    assert.equal(added.length, 1);
    const line = JSON.parse(added[0]);
    assert.equal(line.replaces_id, a.id);
    assert.equal(line.command_pattern, 'pkill ;; killall');
    assert.equal(line.title, 'pkill hit the wrong processes', 'content unchanged');
    assert.match(said(bash(root, 'killall node', 'sd')), /mishandling/);
    assert.match(mem(root, 'command-guard', 'seed', '--map', map).stdout, /present .*pkill/, 'second run: already there');
    assert.equal(mem(root, 'command-guard', 'seed', '--map', map, '--write').stdout.match(/(\d+) correction/)[1], '0');
    assert.equal(cg.coverage(root).withPattern, 1);
  } finally { done(root); }
});

test('cm ships empty: the code carries no pattern of its own', () => {
  const root = world();
  try {
    assert.match(mem(root, 'command-guard', 'show').stdout, /No error carries a command pattern/);
    assert.equal(cg.coverage(root), null, 'not measurable is unknown, not zero');
    assert.equal(bash(root, 'git add -A && pkill chrome', 'e1'), null);
  } finally { done(root); }
});

// --- measurement: cost and false alarms on ordinary commands -----------------------------

/** Deterministic synthetic set of ordinary Bash commands, with hard negatives. */
function ordinaryCommands(n) {
  const files = ['src/search.mjs', 'README.md', 'test/x.test.mjs', 'package.json', '.gitignore', 'docs/CAPABILITIES.md', 'bin/mem'];
  const dirs = ['/tmp/scratch', '/tmp/claude-0/x/y', 'build/out', '/home/user/wt-a', './dist'];
  const msgs = ['fix parser', 'port lever 5', 'docs: update table', 'wip'];
  const t = [
    (i) => `ls -la ${dirs[i % 5]}`,
    (i) => `cat ${files[i % 7]} | head -n ${10 + (i % 40)}`,
    (i) => `grep -rn "pattern${i}" src test | head`,
    (i) => `git add ${files[i % 7]}`,
    (i) => `git commit -m "${msgs[i % 4]}"`,
    (i) => `git status --short && git diff --stat`,
    (i) => `git push origin agent/work-${i % 9}`,
    (i) => `git pull --ff-only`,
    (i) => `git fetch origin main && git merge --ff-only origin/main`,
    (i) => `rm -rf ${dirs[i % 5]}/cache-${i}`,
    (i) => `rm -f ${files[i % 7]}.bak`,
    (i) => `node --test test/${files[i % 7].replace(/\W/g, '-')}.mjs`,
    (i) => `npm test -- --grep "case ${i}"`,
    (i) => `echo "never run pkill without checking the process tree" > notes-${i}.txt`,
    (i) => `pgrep -af '[k]ette\\.sh' || true`,
    (i) => `sed -n '${1 + (i % 50)},${60 + (i % 50)}p' ${files[i % 7]}`,
    (i) => `mkdir -p ${dirs[i % 5]} && cd ${dirs[i % 5]} && ls`,
    (i) => `git log --oneline -${5 + (i % 20)} -- ${files[i % 7]}`,
    (i) => `git checkout -b agent/task-${i}`,
    (i) => `git commit -m "merge: take --ours for the lock file, do not git add -A"`,
    (i) => `cd /work/cheap-mem && git status`,
    (i) => `bash -c "cd ${dirs[i % 5]} && find . -name '*.mjs' | wc -l"`,
  ];
  const out = [];
  for (let i = 0; out.length < n; i += 1) out.push(t[i % t.length](i));
  return out;
}

test('MEASURE: matching cost per command and false-alarm rate on 500 ordinary commands', () => {
  const root = world();
  try {
    // A realistic armed set: the patterns a cm user would plausibly record.
    err(root, 'process kill hit parallel agents', 'pkill ;; killall');
    err(root, 'pgrep -f matched its own loop', 'pgrep -f');
    err(root, 'git add everything swept a secret', 'git add -A$ ;; git add --all$ ;; git add .$');
    err(root, 'commit -a after a merge', 'git commit -a ;; git commit -am');
    err(root, 'checkout --ours on a whole file', 'git checkout --ours');
    err(root, 'git pull on the VM', 'git pull & /work/');
    err(root, 'rm -rf /tmp wiped others', 'rm -rf /tmp ;; rm -rf /tmp/' + '*');
    err(root, 'force push over history', 'git push --force ;; git push -f ;; git push --force-with-lease');
    cg.build(root);
    const set = ordinaryCommands(500);
    assert.equal(set.length, 500);
    let falseAlarms = 0;
    const flagged = [];
    const t0 = process.hrtime.bigint();
    for (const c of set) {
      if (cg.matches(root, c).length) { falseAlarms += 1; flagged.push(c); }
    }
    const perCommandMs = Number(process.hrtime.bigint() - t0) / 1e6 / set.length;
    const rate = falseAlarms / set.length;
    process.stdout.write(`# command-guard: ${set.length} ordinary commands, ${falseAlarms} false alarms (${(rate * 100).toFixed(2)} %), `
      + `${perCommandMs.toFixed(3)} ms per command incl. booklet freshness check\n`);
    assert.ok(rate < 0.01, `false-alarm rate ${(rate * 100).toFixed(2)} % (flagged: ${flagged.slice(0, 3).join(' | ')})`);
    assert.ok(perCommandMs < 20, `${perCommandMs} ms per command`);
    // Positive control: the same armed set DOES hit the real thing.
    const real = ['pkill -f chrome', 'git add -A', 'git commit -a -m x', 'git pull origin main && cd /work/x', 'rm -rf /tmp',
      'git push --force origin x', 'git checkout --ours f', 'pgrep -f node'];
    for (const c of real) assert.ok(cg.matches(root, c).length > 0, `must hit: ${c}`);
  } finally { done(root); }
});

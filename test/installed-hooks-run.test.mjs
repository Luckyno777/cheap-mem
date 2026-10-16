// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/installed-hooks-run.test.mjs - every INSTALLED hook is RUN, the way
// Claude Code runs it, and has to deliver where it can be expected to.
//
// **The finding (2026-10-16).** The installer put seven hook shims into
// ~/.claude/hooks. Run with an empty environment (no CHEAP_MEM_ROOT, the
// way Claude Code starts a hook) two of them were dead: UserPromptSubmit
// exited 0 with ZERO bytes on every prompt, SessionStart announced
// "cheap-mem NOT attached". Both looked for the tool only inside the
// memory, and a memory made by `mem init` carries no bin/. Nothing failed,
// so nothing was ever reported - the recall lane had been mute since the
// install, on every prompt of every session. The other shims found the
// tool through CHEAP_MEM_CODE, which the installer bakes in; these two
// never got the line.
//
// Every test that looked at those shims ran them from the repository
// (bin/mem-retrieve, with the environment of the test run), which is not
// what an installed copy sees. This file is the missing half: install into
// a scratch HOME, start each registered command with a bare environment
// and a real hook JSON on stdin, and ask for the one thing a hook is for:
// bytes in the context.
//
// Environment: PATH holds only the directories of node and bash (plus the
// system ones), HOME points into the scratch. No CHEAP_MEM_ROOT, no
// CHEAP_MEM_CODE, no MEM_* - the shim has to bring both with it. Nothing
// here touches the real ~/.claude.
//
// Thresholds: nothing is lowered. The score bar (MEM_RETRIEVE_MIN, 5.0)
// stays at its default, and the prompt carries the rare word of the
// fixture entry ("sperrdatei-rennen"), which clears it by a wide margin.
// (Measured on a two-entry memory: a prompt made only of common words
// scores below the bar in a corpus this small, so it would test the
// threshold, not the shim.)
//
// Windows: the .sh shims run wherever bash exists (Git Bash on Windows),
// through the command settings.json registers. The .ps1 shims that
// install/windows.ps1 writes are run on win32 only, and only if
// powershell is there; on every platform their text is checked statically
// for the CHEAP_MEM_CODE way (the same defect lived in them, and on a
// platform without PowerShell the static check is the whole proof).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const INSTALL_PS1 = path.join(REPO, 'install', 'windows.ps1');
const WIN = process.platform === 'win32';

const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };

// Find an executable on the PATH of THIS process (no `which`: that is a
// POSIX tool).
function find(name) {
  const exts = WIN ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = path.join(dir, name + e);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  return null;
}

const BASH = find('bash');
const POWERSHELL = WIN ? (find('powershell') || find('pwsh')) : null;

// The bare environment, the equivalent of `env -i PATH=... HOME=...`.
// Built as a fresh object (spawn with `env:` replaces, never merges), so
// no variable of the test run leaks in by accident.
function bareEnv(home, extra = {}) {
  const dirs = [path.dirname(process.execPath)];
  if (BASH) {
    dirs.push(path.dirname(BASH));
    const usr = path.join(path.dirname(BASH), '..', 'usr', 'bin'); // Git for Windows
    if (WIN && fs.existsSync(usr)) dirs.push(usr);
  }
  if (!WIN) dirs.push('/usr/bin', '/bin');
  // The system ones on Windows too (CI run 1074): every .ps1 shim hands over with `& powershell -File ...`,
  // the way the registered command itself starts it, and a PATH without System32\WindowsPowerShell\v1.0 is
  // no Windows a hook ever runs on - the shims then failed with "'powershell' is not recognized" and the
  // probe read that as a mute recall lane.
  if (WIN && process.env.SystemRoot) {
    dirs.push(path.join(process.env.SystemRoot, 'System32'),
      path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'));
  }
  if (WIN && POWERSHELL) dirs.push(path.dirname(POWERSHELL));
  const env = { PATH: [...new Set(dirs)].join(path.delimiter), HOME: home };
  if (WIN) {
    for (const k of ['SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) {
      if (process.env[k]) env[k] = process.env[k];
    }
    env.USERPROFILE = home;
  }
  return { ...env, ...extra };
}

function log(root, kind, args) {
  execFileSync(process.execPath, [MEM, '--root', root, 'log', kind, ...args], { stdio: 'ignore' });
}

// A memory WITHOUT the tool in it (what `mem init` makes), holding entries
// that the probes below ask for by name.
function buildMemory(parent = null, name = 'memory') {
  const root = parent ? path.join(parent, name) : temp('cm-ihr-mem-');
  fs.mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  assert.ok(!fs.existsSync(path.join(root, 'bin', 'mem')),
    'the fixture memory carries the tool - the probe would prove nothing');
  log(root, 'error', ['--title', 'lockfile race - two runs overwrote it',
    '--text', 'the sperrdatei-rennen probe failed because two test runs overwrote the same lock file at once; seen in src/lockrace.mjs',
    '--class', 'race']);
  log(root, 'decision', ['--topic', 'lockfile race handling',
    '--choice', 'serialize the two test runs on one lock file',
    '--why', 'two runs overwrote the same lock file']);
  return root;
}

const SUITE_RED = ['TAP version 13', 'ok 1 - reading works',
  'not ok 2 - lockfile race: two runs overwrote the lock file',
  '# tests 2', '# pass 1', '# fail 1'].join('\n');

function inputs(scratch) {
  const transcript = path.join(scratch, 'transcript.jsonl');
  const lines = [];
  for (let i = 1; i <= 200; i++) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: `line ${i}: building the lockfile race probe, recall hooks, redaction ${i * 7919}` } }));
  }
  fs.writeFileSync(transcript, lines.join('\n') + '\n');
  return {
    transcript,
    'session-start': { session_id: 'ihr-1', hook_event_name: 'SessionStart', source: 'startup', cwd: scratch },
    'user-prompt': { session_id: 'ihr-1', hook_event_name: 'UserPromptSubmit', cwd: scratch,
      prompt: 'what is known about the lockfile race and the sperrdatei-rennen probe?' },
    'pre-edit': { session_id: 'ihr-1', hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: scratch,
      tool_input: { file_path: path.join(scratch, 'work', 'src', 'lockrace.mjs'), old_string: 'a', new_string: 'b' } },
    'catch-fail': { session_id: 'ihr-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: scratch,
      tool_input: { command: 'npm test 2>&1 | tail -20' },
      tool_response: { stdout: SUITE_RED, stderr: '', interrupted: false, isImage: false } },
    'after-failure': { session_id: 'ihr-1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', cwd: scratch,
      tool_input: { command: 'npm test' },
      error: 'Exit code 1\nnot ok 2 - lockfile race: two runs overwrote the lock file' },
    'subagent-start': { session_id: 'ihr-1', hook_event_name: 'SubagentStart', agent_type: 'general-purpose', cwd: scratch },
    'session-stop': { session_id: 'ihr-1', hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript, cwd: scratch },
  };
}

const ctx = (stdout) => {
  const j = JSON.parse(stdout);
  return j.hookSpecificOutput.additionalContext;
};

// What each hook has to deliver. `name` is the shim's name in
// ~/.claude/hooks (cheap-mem-<name>.sh / .ps1). `check` gets the result of
// the bare run, the memory root and the scratch.
const EXPECT = {
  'session-start': (r) => {
    assert.match(r.stdout, /=== cheap-mem attached ===/, `SessionStart did not attach:\n${r.stdout}`);
    assert.doesNotMatch(r.stdout, /NOT attached/);
    assert.match(r.stdout, /=== mem context ===/, 'no context block under the "attached" header');
    assert.match(r.stdout, /lockfile race/, 'the context block does not carry the fixture entries');
  },
  'user-prompt': (r) => {
    assert.ok(r.stdout, 'UserPromptSubmit delivered ZERO bytes: recall is mute');
    assert.match(ctx(r.stdout), /lockfile race/);
  },
  'pre-edit': (r) => {
    assert.ok(r.stdout, 'PreToolUse delivered ZERO bytes although an entry names this file');
    assert.match(ctx(r.stdout), /lockfile race/);
  },
  'catch-fail': (r) => {
    assert.ok(r.stdout, 'PostToolUse delivered ZERO bytes for a failure hidden behind exit 0');
    assert.match(ctx(r.stdout), /lockfile race/);
  },
  'after-failure': (r) => {
    assert.ok(r.stdout, 'PostToolUseFailure delivered ZERO bytes for a real failure');
    assert.match(ctx(r.stdout), /lockfile race/);
  },
  'subagent-start': (r) => {
    assert.ok(r.stdout, 'SubagentStart delivered ZERO bytes');
    assert.match(ctx(r.stdout), /lockfile race/, 'the subagent recap lacks the fixture entries');
  },
  // The Stop hook has nothing to say to the context; its effect is the
  // capture on disk.
  'session-stop': (r, root) => {
    const rawDir = path.join(root, 'raw');
    const caps = [];
    const walk = (d) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else if (/\.jsonl\.gz$/.test(e.name)) caps.push(p);
      }
    };
    walk(rawDir);
    assert.ok(caps.length >= 1, `the Stop hook captured nothing (stdout: ${r.stdout}, stderr: ${r.stderr})`);
  },
};
const NAMES = Object.keys(EXPECT);

// `codeCopy`: install from a COPY of the tool placed at <scratch>/<codeDir>
// (default: install from this checkout). `memName`: the memory's folder name.
function installSh({ codeDir = null, memName = 'memory' } = {}) {
  assert.ok(BASH, 'no bash on the PATH: the installer cannot run (Windows: Git Bash is required)');
  const scratch = temp('cm-ihr-');
  const home = path.join(scratch, 'home');
  const claudeHome = path.join(home, '.claude');
  fs.mkdirSync(home, { recursive: true });
  const root = buildMemory(codeDir ? scratch : null, memName);
  let code = REPO;
  if (codeDir) {
    code = path.join(scratch, ...codeDir);
    for (const d of ['bin', 'src', 'install', 'shared']) {
      fs.cpSync(path.join(REPO, d), path.join(code, d), { recursive: true });
    }
    fs.copyFileSync(path.join(REPO, 'package.json'), path.join(code, 'package.json'));
  }
  const r = spawnSync(BASH, [path.join(code, 'install', 'claude-code.sh')], {
    encoding: 'utf8', timeout: 60000,
    env: bareEnv(home, { CHEAP_MEM_ROOT: root, CLAUDE_HOME: claudeHome }),
  });
  assert.equal(r.status, 0, `installer failed: ${r.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
  return { scratch, home, claudeHome, root, cfg, code };
}

// event -> the command settings.json registers for a cheap-mem shim.
function registered(cfg, ext) {
  const out = new Map();
  for (const entries of Object.values(cfg.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) {
        const m = /cheap-mem-([a-z-]+)\.(sh|ps1)\b/.exec(h.command || '');
        if (m && m[2] === ext) out.set(m[1], h.command);
      }
    }
  }
  return out;
}

const hookEnv = (home) => bareEnv(home, WIN ? {} : { MEM_ALARM_SECONDS: '60', MEM_TODAY_SECONDS: '60', MEM_STOP_NO_PUSH: '1' });

// Start every registered hook bare; return what failed and rc/bytes seen.
function runAll({ scratch, home, root, cmds }) {
  const input = inputs(scratch);
  const failures = [];
  const seen = {};
  for (const name of NAMES) {
    const r = spawnSync(cmds.get(name), {
      shell: true, input: JSON.stringify(input[name]), encoding: 'utf8', timeout: 90000, env: hookEnv(home),
    });
    seen[name] = { rc: r.status, bytes: Buffer.byteLength(r.stdout || '') };
    try {
      assert.equal(r.status, 0, `${name}: rc ${r.status} ${r.error?.message ?? ''}\n${r.stderr}`);
      EXPECT[name](r, root);
    } catch (e) { failures.push(`[${name}] ${e.message}`); }
  }
  return `${failures.join('\n---\n')}${failures.length ? `\n\nrc/bytes: ${JSON.stringify(seen)}` : ''}`;
}

const shimFiles = (claudeHome) => fs.readdirSync(path.join(claudeHome, 'hooks'))
  .filter((f) => /^cheap-mem-[a-z-]+\.sh$/.test(f));

test('every installed .sh hook, started with a bare environment, delivers', () => {
  const { scratch, home, root, claudeHome, cfg } = installSh();
  const cmds = registered(cfg, 'sh');
  assert.deepEqual([...cmds.keys()].sort(), [...NAMES].sort(),
    'the installer registers a different set of hooks than this file probes: add the new one to EXPECT');
  // The message helper sits next to the shims and is not a hook itself.
  const onDisk = shimFiles(claudeHome).map((f) => /^cheap-mem-([a-z-]+)\.sh$/.exec(f)[1])
    .filter((n) => n !== 'tool-missing').sort();
  assert.deepEqual(onDisk, [...NAMES].sort(), 'a hook file is installed that is not registered, or the reverse');
  assert.ok(fs.existsSync(path.join(claudeHome, 'hooks', 'cheap-mem-tool-missing.sh')),
    'the tool-missing helper was not installed next to the shims');
  assert.equal(runAll({ scratch, home, root, cmds }), '');
});

test('a path with an apostrophe and a space in the tool AND the memory: every shim parses and delivers', () => {
  // `export CHEAP_MEM_CODE='<path>'` ended at the apostrophe: bash -n rc 2,
  // the shim never ran. Both baked values are escaped now.
  const { scratch, home, root, claudeHome, cfg, code } = installSh({
    codeDir: ["Lucky's tools", 'cheap mem'], memName: "mem's root" });
  assert.ok(code.includes("'") && code.includes(' '), 'the fixture path lost its awkward characters');
  assert.ok(root.includes("'"), 'the memory path lost its apostrophe');
  for (const f of shimFiles(claudeHome)) {
    const r = spawnSync(BASH, ['-n', path.join(claudeHome, 'hooks', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f} does not parse: ${r.stderr}`);
  }
  assert.equal(runAll({ scratch, home, root, cmds: registered(cfg, 'sh') }), '');
});

test('the code path is GONE: every silent shim says so, once; the start hook names the path; the doctor sees it', async () => {
  // The baked-in checkout was moved or deleted. Before the message existed
  // the four delegating shims plus stop exited 0 with no byte - the
  // original defect one level down.
  const { scratch, home, root, claudeHome, cfg, code } = installSh({ codeDir: ['gone', 'cheap-mem'] });
  const cmds = registered(cfg, 'sh');
  fs.rmSync(code, { recursive: true, force: true });
  const input = inputs(scratch);
  const failures = [];
  for (const name of NAMES.filter((n) => n !== 'session-start')) {
    const run = () => spawnSync(cmds.get(name), {
      shell: true, input: JSON.stringify(input[name]), encoding: 'utf8', timeout: 90000, env: hookEnv(home),
    });
    const r = run();
    try {
      assert.equal(r.status, 0, `rc ${r.status}`);
      const msg = JSON.parse(r.stdout).systemMessage;
      assert.match(msg, new RegExp(`the ${name} hook is SILENT`));
      assert.ok(msg.includes('CHEAP_MEM_CODE='), 'the message does not name the baked path');
      assert.match(msg, /install\/claude-code\.sh/, 'the message does not name the repair');
      assert.equal(run().stdout, '', 'the second call inside 30 minutes repeats itself');
    } catch (e) { failures.push(`[${name}] ${e.message} (stdout: ${r.stdout})`); }
  }
  assert.equal(failures.length, 0, failures.join('\n---\n'));
  const start = spawnSync(cmds.get('session-start'), {
    shell: true, input: JSON.stringify(input['session-start']), encoding: 'utf8', timeout: 90000, env: hookEnv(home),
  });
  assert.equal(start.status, 0);
  assert.match(start.stdout, /NOT attached/);
  assert.ok(start.stdout.includes(`CHEAP_MEM_CODE=`), `the start hook does not name the baked path:\n${start.stdout}`);
  assert.match(start.stdout, /install\/claude-code\.sh/);
  // The doctor reads the same installed files: registered, but silent.
  const doctor = await import('../src/doctor.mjs');
  const f = doctor.checkIntegrationContract(root, { settingsPaths: [path.join(claudeHome, 'settings.json')] });
  assert.equal(f.level, doctor.LEVEL.ERROR, `${f.text}`);
  assert.match(f.text, /SILENT/);
  assert.match(f.text, /cheap-mem-user-prompt\.sh/);
});

test('time cap in the start hook: rc 0, the cap is REPORTED, the rest of the output still comes (set -u)', () => {
  // `$MEM_SHOW` was first set at the bottom; the cap branch used it above
  // that line, under `set -u`: rc 1, no today line, no hints, no journal.
  const { scratch, home, cfg } = installSh();
  const cmds = registered(cfg, 'sh');
  const env = { ...hookEnv(home), MEM_ALARM_SECONDS: '0.01' };
  const r = spawnSync(cmds.get('session-start'), {
    shell: true, input: JSON.stringify(inputs(scratch)['session-start']), encoding: 'utf8', timeout: 90000, env,
  });
  assert.equal(r.status, 0, `rc ${r.status}: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /unbound variable/);
  assert.match(r.stdout, /=== how to use this memory this session ===/, 'the output stopped after the alarm');
  const hasTimeout = spawnSync('timeout', ['--version'], { env, encoding: 'utf8' }).status === 0;
  if (hasTimeout) assert.match(r.stdout, /hit its time cap/, 'a cap that expired looked like all fine');
  else assert.doesNotMatch(r.stdout, /hit its time cap/, 'no timeout(1): the alarm runs uncapped');
});

test('control: the same bare run WITHOUT a code path is mute (the probe can fail)', () => {
  // Strip the CHEAP_MEM_CODE line from the installed prompt and start
  // hooks. If the probe above could not see the difference between a shim
  // that finds the tool and one that does not, it would be decoration.
  const { scratch, home, claudeHome, cfg } = installSh();
  const cmds = registered(cfg, 'sh');
  for (const n of ['user-prompt', 'session-start']) {
    const f = path.join(claudeHome, 'hooks', `cheap-mem-${n}.sh`);
    const txt = fs.readFileSync(f, 'utf8');
    assert.match(txt, /^export CHEAP_MEM_CODE='/m, `${n}: the installer did not bake CHEAP_MEM_CODE in`);
    fs.writeFileSync(f, txt.replace(/^export CHEAP_MEM_CODE=.*\n/m, ''));
  }
  const input = inputs(scratch);
  const run = (n) => spawnSync(cmds.get(n), {
    shell: true, input: JSON.stringify(input[n]), encoding: 'utf8', timeout: 90000, env: bareEnv(home),
  });
  assert.equal(run('user-prompt').stdout, '', 'without CHEAP_MEM_CODE the prompt shim cannot know where the tool is');
  assert.match(run('session-start').stdout, /NOT attached/);
});

// ---- the PowerShell shims -------------------------------------------

// The here-strings install/windows.ps1 turns into hook files, by the name
// of the variable that holds their destination.
function ps1Hooks() {
  const src = fs.readFileSync(INSTALL_PS1, 'utf8').replace(/\r\n/g, '\n');
  const out = {};
  const re = /@"\n([\s\S]*?)\n"@ \| Set-Content -LiteralPath \$(\w+)Dst/g;
  let m;
  while ((m = re.exec(src))) out[m[2]] = m[1];
  return { src, hooks: out };
}
const PS1_VAR = {
  'session-start': 'startHook', 'session-stop': 'stopHook', 'user-prompt': 'promptHook',
  'pre-edit': 'editHook', 'catch-fail': 'catchFailHook', 'after-failure': 'afterFailureHook',
  'subagent-start': 'subagentHook',
};

test('windows.ps1: every hook it writes has the CHEAP_MEM_CODE way (static, all platforms)', () => {
  const { src, hooks } = ps1Hooks();
  // The baked paths sit in single-quoted strings: an apostrophe in a path
  // has to be doubled, or the generated hook does not parse.
  assert.match(src, /\$CodeHint = \$RepoRoot -replace "'", "''"/, 'the code hint is baked in without escaping an apostrophe');
  assert.match(src, /\$RootHint = \$env:CHEAP_MEM_ROOT -replace "'", "''"/, 'the memory hint is baked in without escaping an apostrophe');
  for (const [name, v] of Object.entries(PS1_VAR)) {
    const body = hooks[v];
    assert.ok(body, `${name}: the here-string for ${v}Dst was not found - the extraction needs updating`);
    assert.match(body, /\$env:CHEAP_MEM_CODE/, `${name}: does not read CHEAP_MEM_CODE`);
    assert.match(body, /'\$CodeHint'/, `${name}: has no baked-in fallback for the code location`);
    assert.match(body, /\$hint = '\$RootHint'/, `${name}: bakes the memory path without the apostrophe escape`);
    assert.doesNotMatch(body, /Test-Path `\$(mem|retrieve|before|catchFail|afterFailure|subagent|stop)\b/,
      `${name}: tests the tool path with wildcards (Test-Path without -LiteralPath)`);
    if (name !== 'session-start') {
      assert.match(body, /cheap-mem-tool-missing\.ps1/, `${name}: exits silent when the tool is missing`);
    } else {
      assert.match(body, /The code path baked in by the installer has no tool/, `${name}: does not name a dead code path`);
    }
    // The tool is looked for under the code location, not only the memory.
    assert.match(body, /Join-Path `\$codeRoot (`\$rel|'bin\\mem')/,
      `${name}: never looks for the tool under the code location`);
  }
  assert.equal(Object.keys(PS1_VAR).length, NAMES.length, 'ps1 and sh probe different hook sets');
});

// Where PowerShell really exists (a Windows machine) the installed .ps1
// hooks are started bare as well. Everywhere else the static test above is
// the proof, and this one states what it did instead of skipping.
test('windows.ps1: the installed .ps1 hooks, started bare, deliver (win32 with powershell only)', () => {
  if (!WIN) {
    // Platform branch, with its own assertion: the generated text carries a
    // hook for every event (the static test above checks what is inside).
    assert.deepEqual(Object.keys(ps1Hooks().hooks).sort(), Object.values(PS1_VAR).sort(),
      'windows.ps1 writes a different set of hooks than this file probes');
    return;
  }
  assert.ok(POWERSHELL, 'win32 without powershell.exe/pwsh on the PATH');
  const scratch = temp('cm-ihr-ps-');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  const root = buildMemory();
  const inst = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_PS1,
    '-SkipTask', '-SkipClaudeDesktop'], {
    encoding: 'utf8', timeout: 120000, env: bareEnv(home, { CHEAP_MEM_ROOT: root }),
  });
  assert.equal(inst.status, 0, `windows.ps1 failed: ${inst.stderr}`);
  const input = inputs(scratch);
  const failures = [];
  for (const name of NAMES) {
    const file = path.join(home, '.claude', 'hooks', `cheap-mem-${name}.ps1`);
    const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file], {
      input: JSON.stringify(input[name]), encoding: 'utf8', timeout: 120000, env: bareEnv(home),
    });
    try {
      assert.equal(r.status, 0, `${name}: rc ${r.status}\n${r.stderr}`);
      EXPECT[name](r, root);
    } catch (e) { failures.push(`[${name}] ${e.message}`); }
  }
  assert.equal(failures.length, 0, failures.join('\n---\n'));
});

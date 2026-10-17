// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/own-tool.test.mjs - a memory runs NO code of its own unless the user
// said so, locally (tool-trust-cm, Lucky's decision 2026-10-16).
//
// **The finding.** Every hook shim looked for `<memory>/bin/mem-retrieve` (and
// the six others) BEFORE the installed tool; `bin/mem-retrieve` preferred
// `<memory>/bin/mem` and loaded the modules under `<memory>/src`; the Stop hook took
// `src/answercheck.mjs`, `src/closingreport.mjs`, `bin/mem-capture` and
// `bin/mem-reflect` from the memory; the installer put
// `node <memory>/bin/mem` on the allow list. The memory is a git clone that
// `mem-retrieve` pulls from origin every ten minutes: whoever could push there
// ran code at every prompt.
//
// **How this file proves it.** The memory is given a PLANTED tool: every
// script of it writes one marker file instead of doing its job. The hooks are
// installed into a scratch HOME and started the way Claude Code starts them.
//   RED   (against base 151eb2f): the markers appear - the planted code ran.
//   GREEN (this change)         : no marker without the switch; every marker
//                                 with it (the positive control, so "no
//                                 marker" can only mean "not run"), and none
//                                 again after `--off`.
// Everything runs in a scratch HOME and a scratch memory and writes only
// marker files there. The real ~/.claude and ~/.config are never touched.
//
// Platforms: the .sh side runs wherever bash exists (Git Bash on Windows). The
// PowerShell side runs on win32 when powershell is there; everywhere else it is
// proved statically (brace balance, every hook script consults the rule, the
// shims the installer writes call it). Nothing here is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as owntool from '../src/owntool.mjs';
import { relPosix } from './helpers/relpath.mjs';
import { removeTree } from './fixture/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const WIN = process.platform === 'win32';

const made = [];
process.on('exit', () => { for (const d of made) removeTree(d); });
const temp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); made.push(d); return d; };
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
// The spelling the installer writes into the rules: it resolves the memory with `pwd -W` under Git Bash, which gives
// the LONG form of an 8.3 name (the CI temp dir is C:\Users\RUNNER~1, the rules say runneradmin; CI run 1103).
// Elsewhere `pwd` keeps the path as given, so it is compared as given.
const spelled = (p) => (WIN ? fs.realpathSync.native(p) : p).replace(/\\/g, '/');

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
const GIT = find('git');

// A bare environment (spawn with `env:` replaces, never merges): PATH holds the
// directories of node, bash and git, HOME and the config home point into the scratch.
function bareEnv(home, extra = {}) {
  const dirs = [path.dirname(process.execPath)];
  if (BASH) {
    dirs.push(path.dirname(BASH));
    const usr = path.join(path.dirname(BASH), '..', 'usr', 'bin');
    if (WIN && fs.existsSync(usr)) dirs.push(usr);
  }
  if (GIT) dirs.push(path.dirname(GIT));
  if (!WIN) dirs.push('/usr/bin', '/bin');
  const env = {
    PATH: [...new Set(dirs)].join(path.delimiter),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
  if (WIN) {
    for (const k of ['SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT']) if (process.env[k]) env[k] = process.env[k];
    env.USERPROFILE = home;
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
  }
  return { ...env, ...extra };
}

/** Where the switch file is for this scratch HOME, by the same rule the code uses. */
const switchOf = (home) => owntool.switchFile({
  env: { XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData', 'Roaming') }, home,
});
const optsOf = (home) => ({ env: { XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData', 'Roaming') }, home });

function initMemory(parent, name = 'memory') {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  return root;
}

// ---------------------------------------------------------------------------
// 1. The switch itself (src/owntool.mjs)
// ---------------------------------------------------------------------------

test('the switch file lives outside every repository, by platform', () => {
  const home = path.join(os.tmpdir(), 'h');
  assert.equal(owntool.configDir({ env: { XDG_CONFIG_HOME: '/x/cfg' }, platform: 'linux', home }),
    path.join('/x/cfg', 'cheap-mem'));
  // A relative XDG value is not a valid base (the spec says so): ignored.
  assert.equal(owntool.configDir({ env: { XDG_CONFIG_HOME: 'rel/cfg' }, platform: 'linux', home }),
    path.join(home, '.config', 'cheap-mem'));
  assert.equal(owntool.configDir({ env: {}, platform: 'darwin', home }), path.join(home, '.config', 'cheap-mem'));
  // The drive letter is built, not written: a fixed Windows path in a test is a path of somebody's machine.
  const winHome = ['C:', 'Users', 'u'].join('\\');
  const winRoaming = [winHome, 'AppData', 'Roaming'].join('\\');
  assert.equal(owntool.configDir({ env: { APPDATA: winRoaming }, platform: 'win32', home: winHome }), [winRoaming, 'cheap-mem'].join('\\'));
  assert.equal(owntool.configDir({ env: {}, platform: 'win32', home: winHome }), [winRoaming, 'cheap-mem'].join('\\'));
  assert.equal(owntool.FILE_NAME, 'own-tool-roots');
});

test('keys: windows ignores case and separators, posix keeps both', () => {
  assert.equal(owntool.normalizeKey(['C:', 'Users', 'Me', 'Memory', ''].join('\\'), 'win32'), 'c:/users/me/memory');
  assert.equal(owntool.normalizeKey('/Home/Me/Memory/', 'linux'), '/Home/Me/Memory');
  assert.equal(owntool.normalizeKey('/', 'linux'), '/');
});

test('three states, never collapsed: missing, empty, broken', (t) => {
  const dir = temp('cm-ot-state-');
  const file = path.join(dir, 'cheap-mem', 'own-tool-roots');
  assert.equal(owntool.readSwitch(file).state, 'missing');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# only a comment\n\n');
  assert.equal(owntool.readSwitch(file).state, 'empty');
  fs.writeFileSync(file, '# c\n/a/b\r\n/c/d\n');
  assert.deepEqual(owntool.readSwitch(file).keys, ['/a/b', '/c/d'], 'comments skipped, CRLF tolerated');
  // A directory where the file should be: cannot be read, and that is not "nobody is trusted".
  fs.rmSync(file);
  fs.mkdirSync(file);
  const broken = owntool.readSwitch(file);
  assert.equal(broken.state, 'broken');
  assert.ok(broken.error);
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'cheap-mem', 'own-tool-roots'), { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'cheap-mem', 'own-tool-roots'), { recursive: true });
  const root = initMemory(dir);
  assert.equal(owntool.isTrusted(root, optsOf(home)), false, 'an unreadable switch file trusts nobody');
  assert.throws(() => owntool.setTrusted(root, true, optsOf(home)), /cannot read/,
    'a file that cannot be read is not rewritten: it would drop lines never seen');
  void t;
});

test('set and withdraw: other memories stay, repeating changes nothing, the path is the real one', () => {
  const dir = temp('cm-ot-set-');
  const home = path.join(dir, 'home');
  const a = initMemory(dir, 'a');
  const b = initMemory(dir, 'b');
  const o = optsOf(home);
  assert.equal(owntool.isTrusted(a, o), false, 'default: off');
  assert.equal(owntool.setTrusted(a, true, o).changed, true);
  assert.equal(owntool.setTrusted(a, true, o).changed, false, 'idempotent');
  assert.equal(owntool.isTrusted(a, o), true);
  assert.equal(owntool.isTrusted(b, o), false, 'another memory is not trusted by this one');
  owntool.setTrusted(b, true, o);
  assert.equal(owntool.setTrusted(a, false, o).changed, true);
  assert.equal(owntool.isTrusted(a, o), false);
  assert.equal(owntool.isTrusted(b, o), true, 'withdrawing one leaves the other');
  assert.equal(owntool.setTrusted(a, false, o).changed, false, 'withdrawing what was never set changes nothing');
  const text = fs.readFileSync(switchOf(home), 'utf8');
  assert.match(text, /^# cheap-mem:/, 'the file explains itself');
  // A second spelling of the same directory (a link to it) is the same memory; a COPY is not.
  const link = path.join(dir, 'link-to-b');
  fs.symlinkSync(b, link, WIN ? 'junction' : 'dir');
  assert.equal(owntool.isTrusted(link, o), true, 'the real path is compared, not the spelling');
  const copy = path.join(dir, 'copy-of-b');
  fs.cpSync(b, copy, { recursive: true });
  assert.equal(owntool.isTrusted(copy, o), false, 'a copy does not inherit the trust');
});

test('a memory path with a line break is refused, not written as two lines', () => {
  const dir = temp('cm-ot-nl-');
  const home = path.join(dir, 'home');
  const o = optsOf(home);
  // The key of a path with a line break, on any platform (win32 keeps the unresolved spelling as a key).
  assert.throws(() => owntool.setTrusted(path.join(dir, 'a\nb'), true, { ...o, platform: 'win32' }), /line break/);
  assert.throws(() => owntool.setTrusted(path.join(dir, 'a\rb'), true, { ...o, platform: 'win32' }), /line break/);
  assert.equal(fs.existsSync(switchOf(home)), false, 'a refused path left a switch file');
  if (!WIN) {
    const odd = path.join(dir, 'x\ny');
    fs.mkdirSync(odd);
    assert.throws(() => owntool.setTrusted(odd, true, o), /line break/);
    assert.equal(fs.existsSync(switchOf(home)), false);
  }
});

test('shipsOwnTool: a bin/mem*, or a src module a hook would load; nothing else', () => {
  const dir = temp('cm-ot-ships-');
  const root = initMemory(dir);
  assert.equal(owntool.shipsOwnTool(root), false, 'a memory made by `mem init` carries no tool');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'tool.sh'), '');
  assert.equal(owntool.shipsOwnTool(root), false, 'a bin/ with other things in it is not a cheap-mem tool');
  fs.writeFileSync(path.join(root, 'bin', 'mem-retrieve'), '');
  assert.equal(owntool.shipsOwnTool(root), true);
  removeTree(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'subagentstart.mjs'), '');
  assert.equal(owntool.shipsOwnTool(root), true);
});

// ---------------------------------------------------------------------------
// 2. The shell twin answers like the node module
// ---------------------------------------------------------------------------

function sh(home, script, extraEnv = {}) {
  assert.ok(BASH, 'no bash on the PATH (Windows: Git Bash is required for the .sh side)');
  const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8', timeout: 30000, env: bareEnv(home, extraEnv) });
  assert.equal(r.status, 0, `bash failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}
const OWN_SH = pathToFileURL(path.join(REPO, 'bin', '_owntool.sh')).pathname;
const ownShPath = () => (WIN ? path.join(REPO, 'bin', '_owntool.sh').replace(/\\/g, '/') : OWN_SH);
const shTrusted = (home, root) => sh(home, `. "${ownShPath()}"; if mem_own_tool_trusted "$1"; then echo yes; else echo no; fi`.replace('"$1"', JSON.stringify(root.replace(/\\/g, '/')))).trim() === 'yes';

test('bin/_owntool.sh agrees with src/owntool.mjs on every case', () => {
  const dir = temp('cm-ot-sh-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const o = optsOf(home);
  const plain = initMemory(dir, 'plain');
  const odd = initMemory(dir, "it's a memory");
  const prefix = initMemory(dir, 'plain2'); // plain is a string prefix of plain2
  const cases = [
    ['not set at all', () => {}, plain, false],
    ['set', () => owntool.setTrusted(plain, true, o), plain, true],
    ['a longer name that starts like the trusted one', () => {}, prefix, false],
    ['an apostrophe and spaces in the path', () => owntool.setTrusted(odd, true, o), odd, true],
    ['withdrawn again', () => owntool.setTrusted(plain, false, o), plain, false],
    ['a path that does not exist', () => {}, path.join(dir, 'nope'), false],
  ];
  for (const [name, setup, root, want] of cases) {
    setup();
    assert.equal(owntool.isTrusted(root, o), want, `node, ${name}`);
    assert.equal(shTrusted(home, root), want, `shell, ${name}`);
  }
  // The file as a person might leave it: CRLF, comments, blank lines.
  fs.writeFileSync(switchOf(home), `# note\r\n\r\n${owntool.rootKeys(plain).join('\r\n')}\r\n`);
  assert.equal(shTrusted(home, plain), true, 'shell: CRLF and comments');
  assert.equal(owntool.isTrusted(plain, o), true, 'node: CRLF and comments');
  // Unreadable: a directory in place of the file.
  fs.rmSync(switchOf(home));
  fs.mkdirSync(switchOf(home));
  assert.equal(shTrusted(home, plain), false, 'shell: an unreadable switch trusts nobody');
  removeTree(switchOf(home));
  // A link to a trusted memory is the same memory, a copy is not.
  owntool.setTrusted(plain, true, o);
  const link = path.join(dir, 'link-to-plain');
  fs.symlinkSync(plain, link, WIN ? 'junction' : 'dir');
  assert.equal(shTrusted(home, link), true, 'shell: the real path is compared');
  const copy = path.join(dir, 'copy-of-plain');
  fs.cpSync(plain, copy, { recursive: true });
  assert.equal(shTrusted(home, copy), false, 'shell: a copy does not inherit the trust');
});

test('mem_pick_tool: installed first, the memory only with the switch, a checkout inside the memory counts as the memory', () => {
  const dir = temp('cm-ot-pick-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const o = optsOf(home);
  const root = initMemory(dir);
  const code = path.join(dir, 'installed');
  fs.mkdirSync(path.join(code, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(code, 'bin', 'mem-x'), '');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'mem-x'), '');
  const inside = path.join(root, 'vendored');
  fs.mkdirSync(path.join(inside, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(inside, 'bin', 'mem-x'), '');
  // A sibling whose NAME starts with the memory's name is not inside it.
  const sibling = path.join(dir, 'memory-extras');
  fs.mkdirSync(path.join(sibling, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(sibling, 'bin', 'mem-x'), '');
  const nothing = path.join(dir, 'nothing');
  fs.mkdirSync(nothing);
  const slash = (p) => p.replace(/\\/g, '/');
  const pick = (codeDir, self = '') => sh(home, `. "${slash(ownShPath())}"
    ${codeDir ? `export CHEAP_MEM_CODE="${slash(codeDir)}"` : 'unset CHEAP_MEM_CODE'}
    mem_pick_tool "${slash(root)}" bin/mem-x ${self ? `"${slash(self)}"` : ''}
    echo "$mem_picked|$MEM_OWN_SKIPPED"`).trim();
  const rel = (s) => { const [p, k] = s.split('|'); return [p ? relPosix(dir, p) : '', k]; };
  // switch OFF
  assert.deepEqual(rel(pick(code)), ['installed/bin/mem-x', '1'], 'off: the installed tool, and the memory\'s copy is reported as passed over');
  assert.deepEqual(rel(pick(inside)), ['', '1'], 'off: a checkout INSIDE the memory is the memory\'s own tool');
  assert.deepEqual(rel(pick(sibling)), ['memory-extras/bin/mem-x', '1'], 'off: a sibling that merely starts with the memory\'s name is another directory');
  assert.deepEqual(rel(pick(null, path.join(root, 'bin'))), ['', '1'], 'off: nor is the memory\'s bin/ as the script\'s own directory');
  assert.deepEqual(rel(pick(null, path.join(nothing, 'bin'))), ['', '1']);
  assert.deepEqual(rel(pick(null, path.join(code, 'bin'))), ['installed/bin/mem-x', '1'], 'off, nothing installed: the tool the script sits in');
  // switch ON
  owntool.setTrusted(root, true, o);
  assert.deepEqual(rel(pick(code)), ['memory/bin/mem-x', '0'], 'on: the memory\'s own copy first, as before');
  fs.rmSync(path.join(root, 'bin', 'mem-x'));
  assert.deepEqual(rel(pick(code)), ['installed/bin/mem-x', '0'], 'on, but this file is not in the memory: the installed one');
  assert.deepEqual(rel(pick(inside)), ['memory/vendored/bin/mem-x', '0'], 'on: a checkout inside the memory is usable');
  // a memory with nothing to skip says nothing
  owntool.setTrusted(root, false, o);
  assert.deepEqual(rel(pick(code)), ['installed/bin/mem-x', '0'], 'nothing of the memory\'s to pass over: no report');
});

// ---------------------------------------------------------------------------
// 3. The hooks, installed and started: planted code must not run
// ---------------------------------------------------------------------------

// A memory that carries a PLANTED tool. Every script writes its own marker
// (named by the script) into $CM_PLANT_DIR, which is the only thing it does.
const PLANTED_BIN = ['mem-retrieve', 'mem-before-edit', 'mem-stop', 'mem-subagent-start', 'mem-after-failure', 'mem-catch-fail',
  'mem-capture', 'mem-reflect'];
function plant(root) {
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  for (const n of PLANTED_BIN) {
    fs.writeFileSync(path.join(root, 'bin', n), `#!/usr/bin/env bash\n: > "\${CM_PLANT_DIR}/${n}"\nexit 0\n`, { mode: 0o755 });
  }
  const js = (n) => `require('node:fs').writeFileSync(require('node:path').join(process.env.CM_PLANT_DIR, ${JSON.stringify(n)}), 'x');\n`;
  fs.writeFileSync(path.join(root, 'bin', 'mem'), `#!/usr/bin/env node\n${js('mem')}`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin', 'mem-before-edit-core.mjs'),
    `import fs from 'node:fs'; import path from 'node:path';\nfs.writeFileSync(path.join(process.env.CM_PLANT_DIR, 'core'), 'x');\n`);
  for (const n of ['answercheck', 'closingreport', 'subagentstart', 'injection', 'afterfailure', 'errorsignature', 'provenance']) {
    fs.writeFileSync(path.join(root, 'src', `${n}.mjs`),
      `import fs from 'node:fs'; import path from 'node:path';\nfs.writeFileSync(path.join(process.env.CM_PLANT_DIR, 'src-${n}'), 'x');\nexport const checkStop = () => null; export const stopReport = () => null;\nexport const hookResultFor = async () => null; export const book = () => {}; export const OCCASION = { SESSION_START: 'session-start' };\n`);
  }
}
const markersOf = (dir) => fs.readdirSync(dir).sort();

function install({ withBash = true } = {}) {
  assert.ok(!withBash || BASH, 'no bash on the PATH (Windows: Git Bash is required for the .sh side)');
  const scratch = temp('cm-ot-hooks-');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  const root = initMemory(scratch);
  plant(root);
  const marks = path.join(scratch, 'marks');
  fs.mkdirSync(marks);
  const claudeHome = path.join(home, '.claude');
  const r = spawnSync(BASH, [path.join(REPO, 'install', 'claude-code.sh')], {
    encoding: 'utf8', timeout: 60000, env: bareEnv(home, { CHEAP_MEM_ROOT: root, CLAUDE_HOME: claudeHome }),
  });
  assert.equal(r.status, 0, `installer failed: ${r.stderr}`);
  return { scratch, home, root, marks, claudeHome, installer: r };
}

function hookInput(scratch) {
  const transcript = path.join(scratch, 'transcript.jsonl');
  const lines = [];
  for (let i = 1; i <= 200; i++) lines.push(JSON.stringify({ type: 'assistant', message: { content: `line ${i}: building the probe ${i * 7919}` } }));
  fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
  const red = ['TAP version 13', 'ok 1 - reading works', 'not ok 2 - the planted probe failed', '# tests 2', '# pass 1', '# fail 1'].join('\n');
  return {
    'session-start': { session_id: 'ot-1', hook_event_name: 'SessionStart', source: 'startup', cwd: scratch },
    'user-prompt': { session_id: 'ot-1', hook_event_name: 'UserPromptSubmit', cwd: scratch, prompt: 'what is known about the planted probe and its lockfile?' },
    'pre-edit': { session_id: 'ot-1', hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: scratch,
      tool_input: { file_path: path.join(scratch, 'work', 'src', 'probe.mjs'), old_string: 'a', new_string: 'b' } },
    'catch-fail': { session_id: 'ot-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: scratch,
      tool_input: { command: 'npm test 2>&1 | tail -20' }, tool_response: { stdout: red, stderr: '', interrupted: false, isImage: false } },
    'after-failure': { session_id: 'ot-1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', cwd: scratch,
      tool_input: { command: 'npm test' }, error: 'Exit code 1\nnot ok 2 - the planted probe failed' },
    'subagent-start': { session_id: 'ot-1', hook_event_name: 'SubagentStart', agent_type: 'general-purpose', cwd: scratch },
    'session-stop': { session_id: 'ot-1', hook_event_name: 'Stop', stop_hook_active: false, transcript_path: transcript, cwd: scratch },
  };
}
const SHIMS = ['session-start', 'user-prompt', 'pre-edit', 'catch-fail', 'after-failure', 'subagent-start', 'session-stop'];

/** Run every installed shim, each with its own marker directory; returns { shim: [markers] } and the outputs. */
function runShims(ctx, extraEnv = {}) {
  const input = hookInput(ctx.scratch);
  const got = {};
  const out = {};
  for (const name of SHIMS) {
    const dir = path.join(ctx.marks, name);
    removeTree(dir);
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(BASH, [path.join(ctx.claudeHome, 'hooks', `cheap-mem-${name}.sh`)], {
      input: JSON.stringify(input[name]), encoding: 'utf8', timeout: 60000,
      env: bareEnv(ctx.home, { CM_PLANT_DIR: dir, MEM_STOP_NO_PUSH: '1', MEM_REFLECT: '1', MEM_ALARM_SECONDS: '60', MEM_TODAY_SECONDS: '60', ...extraEnv }),
    });
    assert.equal(r.status, 0, `${name}: rc ${r.status}\n${r.stderr}`);
    got[name] = markersOf(dir);
    out[name] = r;
  }
  return { got, out };
}
// CHEAP_MEM_PROVISION=1 is what a provisioning script sets; `noProvision` is the call of somebody who did not.
const trustCli = (ctx, ...a) => spawnSync(process.execPath, [MEM, '--root', ctx.root, 'trust-own-tool', ...a], {
  encoding: 'utf8', timeout: 30000, env: bareEnv(ctx.home, ctx.noProvision ? {} : { CHEAP_MEM_PROVISION: '1' }),
});

test('RED/GREEN: planted code in the memory is not run by any installed shim; with the switch it is; after --off it is not', () => {
  const ctx = install();
  // Positive control of the harness itself: the planted scripts DO write their marker when run.
  const probeDir = path.join(ctx.marks, 'probe');
  fs.mkdirSync(probeDir);
  const direct = spawnSync(BASH, [path.join(ctx.root, 'bin', 'mem-retrieve')], { env: bareEnv(ctx.home, { CM_PLANT_DIR: probeDir }) });
  assert.equal(direct.status, 0);
  assert.deepEqual(markersOf(probeDir), ['mem-retrieve'], 'the planted script writes no marker: the probe would prove nothing');

  // The installer must have told the story.
  assert.ok(fs.existsSync(path.join(ctx.claudeHome, 'hooks', 'cheap-mem-own-tool.sh')), 'the rule is installed next to the shims');

  // OFF (default): nothing planted runs.
  const off = runShims(ctx);
  for (const name of SHIMS) assert.deepEqual(off.got[name], [], `${name}: planted code ran without the switch`);
  const start = off.out['session-start'].stdout;
  assert.match(start, /=== cheap-mem attached ===/, 'the installed tool still attaches');
  const said = start.split('memory ships its own tool; using the installed one. To trust it: mem trust-own-tool').length - 1;
  assert.equal(said, 1, `the start hook must say it ONCE, said ${said} times:\n${start}`);
  assert.doesNotMatch(start, /NOT attached/);

  // ON: every shim reaches the memory's own script (positive control: "no marker" above can only mean "not run").
  const set = trustCli(ctx, '--non-interactive');
  assert.equal(set.status, 0, set.stderr);
  const on = runShims(ctx);
  assert.deepEqual(on.got['user-prompt'], ['mem-retrieve']);
  assert.deepEqual(on.got['pre-edit'], ['mem-before-edit']);
  assert.deepEqual(on.got['session-stop'], ['mem-stop']);
  assert.deepEqual(on.got['subagent-start'], ['mem-subagent-start']);
  assert.deepEqual(on.got['after-failure'], ['mem-after-failure']);
  assert.deepEqual(on.got['catch-fail'], ['mem-catch-fail']);
  assert.ok(on.got['session-start'].includes('mem'), 'the start hook ran the memory\'s own bin/mem');
  assert.ok(on.got['session-start'].includes('src-provenance'), 'positive control: with the switch the start hook loads the memory\'s own src/provenance.mjs');
  assert.doesNotMatch(on.out['session-start'].stdout, /memory ships its own tool/, 'trusted: nothing to announce');

  // OFF again.
  assert.equal(trustCli(ctx, '--off').status, 0);
  const off2 = runShims(ctx);
  for (const name of SHIMS) assert.deepEqual(off2.got[name], [], `${name}: planted code ran after --off`);
});

test('no installed tool and an untrusted own tool: the hooks SAY so (no silent deviation), and still run nothing', () => {
  const ctx = install();
  const input = hookInput(ctx.scratch);
  const hooks = path.join(ctx.claudeHome, 'hooks');
  // A shim as an install without a code path would have left it: the CHEAP_MEM_CODE line taken out.
  const bare = path.join(hooks, 'bare-user-prompt.sh');
  const lines = fs.readFileSync(path.join(hooks, 'cheap-mem-user-prompt.sh'), 'utf8').split('\n');
  assert.ok(lines.some((l) => l.startsWith('export CHEAP_MEM_CODE=')), 'the fixture lost its CHEAP_MEM_CODE line');
  fs.writeFileSync(bare, lines.filter((l) => !l.startsWith('export CHEAP_MEM_CODE=')).join('\n'));
  const dir = path.join(ctx.marks, 'bare');
  fs.mkdirSync(dir);
  const run = () => spawnSync(BASH, [bare], {
    input: JSON.stringify(input['user-prompt']), encoding: 'utf8', timeout: 30000,
    env: bareEnv(ctx.home, { CM_PLANT_DIR: dir }),
  });
  const r = run();
  assert.equal(r.status, 0);
  assert.deepEqual(markersOf(dir), [], 'the planted tool ran');
  const msg = JSON.parse(r.stdout).systemMessage;
  assert.match(msg, /user-prompt hook is SILENT/);
  assert.match(msg, /ships its own tool, which is not trusted, and no installed tool is configured/);
  assert.match(msg, /mem trust-own-tool/);
  assert.equal(run().stdout, '', 'at most once per 30 minutes');
  // With the switch the same shim runs the memory's tool.
  assert.equal(trustCli(ctx, '--non-interactive').status, 0);
  removeTree(path.join(ctx.root, '.pipeline'));
  run();
  assert.deepEqual(markersOf(dir), ['mem-retrieve']);
});

test('the doctor: a registered hook whose only tool is the memory\'s untrusted one is SILENT; trusting it ends that', async () => {
  const ctx = install();
  // The baked code path points at nothing (the checkout was moved), the memory carries a tool.
  const hooks = path.join(ctx.claudeHome, 'hooks');
  for (const f of fs.readdirSync(hooks).filter((n) => /^cheap-mem-.*\.sh$/.test(n))) {
    const p = path.join(hooks, f);
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(/^export CHEAP_MEM_CODE='.*'$/m, `export CHEAP_MEM_CODE='${path.join(ctx.scratch, 'moved-away')}'`));
  }
  const doctor = await import('../src/doctor.mjs');
  const o = { settingsPaths: [path.join(ctx.claudeHome, 'settings.json')] };
  const before = doctor.checkIntegrationContract(ctx.root, o);
  assert.equal(before.level, doctor.LEVEL.ERROR, before.text);
  assert.match(before.text, /SILENT/);
  assert.match(before.advice, /trust-own-tool/, 'the advice names the switch');
  const set = spawnSync(process.execPath, [MEM, '--root', ctx.root, 'trust-own-tool', '--non-interactive'], { encoding: 'utf8', env: bareEnv(ctx.home, { CHEAP_MEM_PROVISION: '1' }) });
  assert.equal(set.status, 0, set.stderr);
  const prev = { ...process.env };
  process.env.HOME = ctx.home;
  process.env.XDG_CONFIG_HOME = path.join(ctx.home, '.config');
  process.env.APPDATA = path.join(ctx.home, 'AppData', 'Roaming');
  try {
    const after = doctor.checkIntegrationContract(ctx.root, o);
    assert.doesNotMatch(after.text, /SILENT/, `trusted: the memory's tool is a tool again\n${after.text}`);
  } finally {
    for (const k of ['HOME', 'XDG_CONFIG_HOME', 'APPDATA']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
  }
});

// The scripts under bin/ decide for themselves too (a shim is not the only way in: the installed
// shim starts them, and the Windows hooks and a hand-started hook do not pass through a shim).
// Each is run from the INSTALLED tool (this checkout), pointed at the planted memory.
const DIRECT = [
  // script, input name, extra env, markers that must stay away without the switch (and appear with it)
  ['mem-retrieve', 'user-prompt', {}, ['mem']],
  ['mem-before-edit', 'pre-edit', {}, ['core']],
  ['mem-after-failure', 'after-failure', {}, ['src-afterfailure']],
  ['mem-catch-fail', 'catch-fail', {}, ['src-errorsignature']],
  ['mem-stop', 'session-stop', { MEM_REFLECT: '1' }, ['src-answercheck', 'src-closingreport', 'mem-capture', 'mem-reflect']],
  ['mem-subagent-start', 'subagent-start', {}, ['src-subagentstart']],
];

test('the bin/ hooks themselves refuse the memory\'s modules without the switch, and take them with it', () => {
  const ctx = install();
  const input = hookInput(ctx.scratch);
  const run = (script, name, env) => {
    const dir = path.join(ctx.marks, `d-${script}`);
    removeTree(dir);
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(BASH, [path.join(REPO, 'bin', script)], {
      input: JSON.stringify(input[name]), encoding: 'utf8', timeout: 60000,
      env: bareEnv(ctx.home, { CHEAP_MEM_ROOT: ctx.root, CM_PLANT_DIR: dir, MEM_STOP_NO_PUSH: '1', ...env }),
    });
    assert.equal(r.status, 0, `${script}: rc ${r.status}\n${r.stderr}`);
    return markersOf(dir);
  };
  for (const [script, name, env] of DIRECT) assert.deepEqual(run(script, name, env), [], `${script}: planted code ran without the switch`);
  assert.equal(trustCli(ctx, '--non-interactive').status, 0);
  for (const [script, name, env, want] of DIRECT) {
    const got = run(script, name, env);
    for (const m of want) assert.ok(got.includes(m), `${script}: with the switch the memory's ${m} should run (positive control); markers: ${got.join(',') || '(none)'}`);
  }
});

test('a git pull cannot set the switch: a pushed commit brings code and a "trust" file, and none of it runs', (t) => {
  assert.ok(GIT, 'git is needed for this probe');
  const scratch = temp('cm-ot-pull-');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  const git = (cwd, ...a) => {
    const r = spawnSync(GIT, ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], {
      cwd, encoding: 'utf8', env: { ...bareEnv(home), GIT_CONFIG_NOSYSTEM: '1' },
    });
    assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const remote = path.join(scratch, 'remote.git');
  fs.mkdirSync(remote);
  git(remote, 'init', '--bare', '-b', 'main');
  const mine = initMemory(scratch, 'mine');
  git(mine, 'init', '-b', 'main');
  git(mine, 'add', '-A');
  git(mine, 'commit', '-m', 'init');
  git(mine, 'remote', 'add', 'origin', pathToFileURL(remote).href);
  git(mine, 'push', '-u', 'origin', 'main');
  // The attacker's clone pushes code, a versioned "trust" setting and a file at the switch's own name.
  const evil = path.join(scratch, 'evil');
  git(scratch, 'clone', pathToFileURL(remote).href, evil);
  plant(evil);
  fs.mkdirSync(path.join(evil, '.config', 'cheap-mem'), { recursive: true });
  fs.writeFileSync(path.join(evil, '.config', 'cheap-mem', 'own-tool-roots'), `${owntool.rootKeys(mine).join('\n')}\n`);
  fs.writeFileSync(path.join(evil, 'trustOwnTool'), 'true\n');
  git(evil, 'add', '-A', '-f');
  git(evil, 'commit', '-m', 'ship a tool');
  git(evil, 'push', 'origin', 'main');
  git(mine, 'pull', '--ff-only');
  assert.ok(fs.existsSync(path.join(mine, 'bin', 'mem-retrieve')), 'the pull did not bring the planted tool: the probe proves nothing');
  const ctx = { scratch, home, root: mine, marks: path.join(scratch, 'marks') };
  fs.mkdirSync(ctx.marks);
  const o = optsOf(home);
  assert.equal(owntool.isTrusted(mine, o), false, 'the pull set the switch');
  assert.equal(fs.existsSync(switchOf(home)), false, 'the pull created the switch file');
  const st = trustCli(ctx, '--status');
  assert.match(st.stdout, /switch:\s+OFF/);
  assert.match(st.stdout, /ships its own tool: yes/);
  // And the installed hook, after the pull, still does not run it.
  const claudeHome = path.join(home, '.claude');
  const inst = spawnSync(BASH, [path.join(REPO, 'install', 'claude-code.sh')], {
    encoding: 'utf8', timeout: 60000, env: bareEnv(home, { CHEAP_MEM_ROOT: mine, CLAUDE_HOME: claudeHome }),
  });
  assert.equal(inst.status, 0, inst.stderr);
  const r = runShims({ ...ctx, claudeHome });
  for (const name of SHIMS) assert.deepEqual(r.got[name], [], `${name}: the pulled code ran`);
  void t;
});

// ---------------------------------------------------------------------------
// 4. The permission list
// ---------------------------------------------------------------------------

test('permissions.allow: the installed tool always, the memory\'s own only with the switch, a stale entry is withdrawn; the switch command is denied', () => {
  const ctx = install();
  const settingsPath = path.join(ctx.claudeHome, 'settings.json');
  const cfg = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const slash = (p) => p.replace(/\\/g, '/');
  const installed = `Bash(node ${slash(REPO)}/bin/mem:*)`;
  const memorys = `Bash(node ${spelled(ctx.root)}/bin/mem:*)`;
  const reinstall = () => {
    const r = spawnSync(BASH, [path.join(REPO, 'install', 'claude-code.sh')], {
      encoding: 'utf8', timeout: 60000, env: bareEnv(ctx.home, { CHEAP_MEM_ROOT: ctx.root, CLAUDE_HOME: ctx.claudeHome }),
    });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
  const first = cfg().permissions;
  assert.ok(first.allow.includes(installed), 'the installed tool is allowed');
  assert.ok(!first.allow.includes(memorys), `the memory's own tool must not be allowed by default:\n${first.allow.join('\n')}`);
  assert.ok(first.deny.includes(`Bash(node ${slash(REPO)}/bin/mem trust-own-tool:*)`), 'the switch command is denied to a model (installed tool)');
  assert.ok(first.deny.includes(`Bash(node ${spelled(ctx.root)}/bin/mem trust-own-tool:*)`), 'the switch command is denied to a model (memory)');
  // An entry an earlier version of the installer wrote is withdrawn while the switch is off.
  const old = cfg();
  old.permissions.allow.push(memorys);
  fs.writeFileSync(settingsPath, JSON.stringify(old, null, 2));
  reinstall();
  assert.ok(!cfg().permissions.allow.includes(memorys), 'the stale allow entry for the memory was kept');
  assert.ok(cfg().permissions.allow.includes(installed));
  // The switch on: now it is allowed.
  assert.equal(trustCli(ctx, '--non-interactive').status, 0);
  const again = reinstall();
  assert.ok(cfg().permissions.allow.includes(memorys), 'trusted: the memory\'s own tool is allowed');
  assert.ok(cfg().permissions.allow.includes(installed));
  assert.match(again.stdout, /because you trusted it/);
  // And off again.
  assert.equal(trustCli(ctx, '--off').status, 0);
  reinstall();
  assert.ok(!cfg().permissions.allow.includes(memorys), 'withdrawn: the entry is gone again');
  // Unrelated entries survive all of this.
  assert.ok(cfg().permissions.allow.includes('Bash(git status:*)'));
});

test('a checkout installed from INSIDE the memory is the memory\'s own tool: not allowed, not run, until trusted', () => {
  const scratch = temp('cm-ot-inside-');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  const root = initMemory(scratch);
  const code = path.join(root, 'vendored', 'cheap-mem');
  for (const d of ['bin', 'src', 'install', 'shared']) fs.cpSync(path.join(REPO, d), path.join(code, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(code, 'package.json'));
  const claudeHome = path.join(home, '.claude');
  const install = () => spawnSync(BASH, [path.join(code, 'install', 'claude-code.sh')], {
    encoding: 'utf8', timeout: 60000, env: bareEnv(home, { CHEAP_MEM_ROOT: root, CLAUDE_HOME: claudeHome }),
  });
  const allow = () => JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8')).permissions.allow;
  const own = `Bash(node ${spelled(code)}/bin/mem:*)`;
  const r1 = install();
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stderr, /lies inside the memory, so it counts as the memory's own tool/);
  assert.ok(!allow().includes(own), 'a tool inside the memory was put on the allow list without the switch');
  // And the hooks do not run it either: this is the "no installed tool" case.
  const dir = path.join(scratch, 'marks');
  fs.mkdirSync(dir);
  const probe = spawnSync(BASH, [path.join(claudeHome, 'hooks', 'cheap-mem-session-start.sh')], {
    input: '{"session_id":"x"}', encoding: 'utf8', timeout: 60000, env: bareEnv(home, { CM_PLANT_DIR: dir }),
  });
  assert.match(probe.stdout, /NOT attached/);
  assert.match(probe.stdout, /memory ships its own tool and no installed tool was found/);
  // Trusted: allowed, and the hooks use it.
  assert.equal(trustCli({ root, home }, '--non-interactive').status, 0);
  const r2 = install();
  assert.equal(r2.status, 0, r2.stderr);
  assert.ok(allow().includes(own), 'trusted: the checkout inside the memory is allowed');
  const probe2 = spawnSync(BASH, [path.join(claudeHome, 'hooks', 'cheap-mem-session-start.sh')], {
    input: '{"session_id":"x"}', encoding: 'utf8', timeout: 60000, env: bareEnv(home),
  });
  assert.match(probe2.stdout, /=== cheap-mem attached ===/);
});

// --- The permission rules, matched the way Claude Code reads them ------------------------------------------------
//
// Claude Code reads `Bash(prefix:*)` as a prefix, `Bash(a*b)` as a glob, splits a compound command at `&&`, `||`, `;`,
// `|` and a line break, and refuses it when ANY part is denied; it runs it without asking only when EVERY part is
// allowed. A word in front of `node` (a variable, `env`, `cd x &&`) leaves the allow list. This is a model of that
// (the documentation's reading, not Claude Code itself); the test holds the rules the installer WRITES to it.
// `pessimistic`: the other possible reading of the rules, in which Claude Code ignores variable assignments (and `env`)
// in front of a command when it matches a part against the allow list. The documentation I know does not say so, and
// the installer must not depend on it: a form is judged under BOTH readings.
function bashVerdict(cmd, rules, pessimistic = false) {
  const specOf = (r, tool) => { const m = new RegExp(`^${tool}\\((.*)\\)$`, 's').exec(r); return m ? m[1] : null; };
  const hits = (spec, c) => {
    if (spec.endsWith(':*')) { const pre = spec.slice(0, -2); return c === pre || c.startsWith(`${pre} `); }
    if (spec.includes('*')) return new RegExp(`^${spec.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's').test(c);
    return c === spec;
  };
  const parts = cmd.split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean);
  const on = (list, c) => list.some((r) => { const sp = specOf(r, 'Bash'); return sp !== null && hits(sp, c); });
  const bare = (c) => (pessimistic ? c.replace(/^(?:env\s+)?(?:\w+=\S*\s+)+/, '').replace(/^export\s+\w+=\S*$/, 'true') : c);
  const denied = on(rules.deny, cmd) || parts.some((c) => on(rules.deny, c) || on(rules.deny, bare(c)));
  const allowed = parts.length > 0 && parts.every((c) => on(rules.allow, bare(c)) || (pessimistic && bare(c) === 'true'));
  return { denied, allowed };
}
// A file rule: a leading double slash is an absolute path, `~/` the home directory, a trailing double star any depth.
function fileDenied(tool, file, home, deny) {
  return deny.some((r) => {
    const m = new RegExp(`^${tool}\\((.*)\\)$`).exec(r);
    if (!m) return false;
    let spec = m[1];
    if (spec.startsWith('//')) spec = spec.slice(1);
    else if (spec.startsWith('~/')) spec = `${home.replace(/\\/g, '/')}${spec.slice(1)}`;
    else return false;
    const f = file.replace(/\\/g, '/');
    const deep = `/${'*'.repeat(2)}`;
    return spec.endsWith(deep) ? f.startsWith(spec.slice(0, -2)) : f === spec;
  });
}

test('the written rules: every real way to call the switch command is refused or not allowed; Write/Edit of the switch file are denied', () => {
  const ctx = install();
  const cfg = JSON.parse(fs.readFileSync(path.join(ctx.claudeHome, 'settings.json'), 'utf8'));
  const rules = { allow: cfg.permissions.allow, deny: cfg.permissions.deny };
  const code = REPO.replace(/\\/g, '/');
  const mem = ctx.root.replace(/\\/g, '/');
  const forms = {
    'plain': `node ${code}/bin/mem trust-own-tool --non-interactive`,
    '--root in front': `node ${code}/bin/mem --root ${mem} trust-own-tool --non-interactive`,
    '--root= in front': `node ${code}/bin/mem --root=${mem} trust-own-tool --non-interactive`,
    'variable in front': `CHEAP_MEM_PROVISION=1 node ${code}/bin/mem trust-own-tool --non-interactive`,
    'env in front': `env CHEAP_MEM_PROVISION=1 node ${code}/bin/mem trust-own-tool --non-interactive`,
    'export first': `export CHEAP_MEM_PROVISION=1 && node ${code}/bin/mem trust-own-tool --non-interactive`,
    'cd first': `cd ${mem} && node ${code}/bin/mem trust-own-tool --non-interactive`,
    'doubled blanks': `node  ${code}/bin/mem   trust-own-tool  --non-interactive`,
    'relative path to bin/mem': `node ../../${path.basename(code)}/bin/mem trust-own-tool --non-interactive`,
    'the memory\'s own bin/mem': `node ${mem}/bin/mem trust-own-tool --non-interactive`,
    'a pipe behind': `node ${code}/bin/mem trust-own-tool --non-interactive | cat`,
    // The one that is NOT covered by the word "trust-own-tool": the variable in front, the command name split by a quote.
    'variable in front, name split by a quote': `CHEAP_MEM_PROVISION=1 node ${code}/bin/mem trust-own-"tool" --non-interactive`,
    'export first, name split by a quote': `export CHEAP_MEM_PROVISION=1 && node ${code}/bin/mem trust-own-"tool" --non-interactive`,
    'env in front, name split by a quote': `env CHEAP_MEM_PROVISION=1 node ${code}/bin/mem trust-own-'tool' --non-interactive`,
  };
  for (const pessimistic of [false, true]) {
    for (const [name, cmd] of Object.entries(forms)) {
      const v = bashVerdict(cmd, rules, pessimistic);
      assert.ok(v.denied || !v.allowed, `[${name}${pessimistic ? ', variables ignored' : ''}] would run WITHOUT asking: ${cmd}\n(denied=${v.denied}, allowed=${v.allowed})`);
    }
  }
  assert.ok(rules.deny.includes('Bash(*CHEAP_MEM_PROVISION*)'), 'the provisioning variable is not denied wherever it stands');
  // Control: the matcher is not simply refusing everything - the installed tool's ordinary use goes through.
  const ok = bashVerdict(`node ${code}/bin/mem find "x" --top 3`, rules);
  assert.equal(ok.allowed && !ok.denied, true, 'the installed tool\'s ordinary commands must stay allowed');
  assert.equal(bashVerdict(`node ${code}/bin/mem --root ${mem} log event --title x`, rules).allowed, true);

  // The last line of defence, for a spelling no rule lists (a quote splits the word): it matches the allow rule and
  // slips past the deny rule, and then the COMMAND refuses, because nothing in front of `node` set the variable.
  const sneaky = `node ${code}/bin/mem trust-own-"tool" --non-interactive`;
  const v = bashVerdict(sneaky, rules);
  assert.equal(v.allowed && !v.denied, true, 'fixture: this spelling is meant to pass the rules');
  const r = spawnSync(BASH, ['-c', `${sneaky.replace(`bin/mem trust`, `bin/mem --root "${mem}" trust`)}`], { encoding: 'utf8', timeout: 30000, env: bareEnv(ctx.home) });
  assert.notEqual(r.status, 0, 'the command must refuse a call that carries no CHEAP_MEM_PROVISION');
  assert.equal(owntool.isTrusted(ctx.root, optsOf(ctx.home)), false, 'the quote-split spelling switched the memory on');

  // Write and Edit of the switch file are denied, others are not.
  const file = switchOf(ctx.home);
  for (const tool of ['Write', 'Edit']) {
    assert.equal(fileDenied(tool, file.replace(/\\/g, '/'), ctx.home, rules.deny), true, `${tool} of ${file} is not denied:\n${rules.deny.join('\n')}`);
    assert.equal(fileDenied(tool, path.join(ctx.home, 'notes.txt').replace(/\\/g, '/'), ctx.home, rules.deny), false, `${tool} of an ordinary file is denied`);
  }
});

test('an installer from before the follow-up: the stale allow entry goes in its backslash spelling too', () => {
  const ctx = install();
  const settingsPath = path.join(ctx.claudeHome, 'settings.json');
  const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const fwd = `Bash(node ${spelled(ctx.root)}/bin/mem:*)`;
  cfg.permissions.allow.push(fwd.replace(/\//g, '\\'));
  fs.writeFileSync(settingsPath, JSON.stringify(cfg));
  const r = spawnSync(BASH, [path.join(REPO, 'install', 'claude-code.sh')], {
    encoding: 'utf8', timeout: 60000, env: bareEnv(ctx.home, { CHEAP_MEM_ROOT: ctx.root, CLAUDE_HOME: ctx.claudeHome }),
  });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.allow;
  assert.ok(!after.some((e) => e.replace(/\\/g, '/') === fwd), 'the backslash spelling of the stale entry was kept');
});

// --- Hooks installed before the rule ---------------------------------------------------------------------------
test('the doctor warns about hooks installed before the own-tool rule, until the installer has run again', async () => {
  const ctx = install();
  const doctor = await import('../src/doctor.mjs');
  const o = { settingsPaths: [path.join(ctx.claudeHome, 'settings.json')] };
  const clean = doctor.checkIntegrationContract(ctx.root, o);
  assert.doesNotMatch(clean.text, /predate/, `a fresh install must not be accused: ${clean.text}`);
  const hooks = path.join(ctx.claudeHome, 'hooks');
  // (a) the rule file is gone from beside the shims
  fs.renameSync(path.join(hooks, 'cheap-mem-own-tool.sh'), path.join(hooks, 'moved-own-tool.sh'));
  const a = doctor.checkIntegrationContract(ctx.root, o);
  assert.equal(a.level, doctor.LEVEL.WARN, a.text);
  assert.match(a.text, /installed hooks predate the own-tool rule - run the installer/);
  assert.match(a.text, /cheap-mem-own-tool\.sh is not installed next to it/);
  fs.renameSync(path.join(hooks, 'moved-own-tool.sh'), path.join(hooks, 'cheap-mem-own-tool.sh'));
  // (b) a shim that never asks the rule (what the installer wrote before): put the old look-in-the-memory-first back
  const shim = path.join(hooks, 'cheap-mem-user-prompt.sh');
  const text = fs.readFileSync(shim, 'utf8');
  fs.writeFileSync(shim, text.replace(/mem_pick_tool/g, 'mem_pick_nothing'));
  const b = doctor.checkIntegrationContract(ctx.root, o);
  assert.equal(b.level, doctor.LEVEL.WARN, b.text);
  assert.match(b.text, /cheap-mem-user-prompt\.sh \(does not ask the rule\)/);
  assert.match(b.advice, /installer/);
  fs.writeFileSync(shim, text);
  assert.doesNotMatch(doctor.checkIntegrationContract(ctx.root, o).text, /predate/);
});

// --- The "at most every 30 minutes" marker must not be written through a symlink of the memory ---------------------
test('tool-missing: a symlink in the memory at the old marker place does not cut a file of the user (and nothing is written into the memory)', () => {
  const ctx = install();
  const victim = path.join(ctx.scratch, 'victim.txt');
  const victimDir = path.join(ctx.scratch, 'victim-dir');
  fs.mkdirSync(victimDir);
  fs.writeFileSync(victim, 'precious\n');
  const link = (target, at) => { try { fs.symlinkSync(target, at, WIN ? 'junction' : undefined); return true; } catch { return false; } };
  // a committed symlink at the marker itself, and (second run) at .pipeline
  fs.mkdirSync(path.join(ctx.root, '.pipeline'), { recursive: true });
  const marker = path.join(ctx.root, '.pipeline', 'tool-missing-user-prompt');
  if (!WIN) {
    assert.ok(link(victim, marker), 'fixture: symlink');
    // An old link: a fresh one would be read as "said a minute ago" and the old code would stay silent without writing.
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    fs.lutimesSync(marker, old, old);
  }
  const hooks = path.join(ctx.claudeHome, 'hooks');
  const lines = fs.readFileSync(path.join(hooks, 'cheap-mem-user-prompt.sh'), 'utf8').split('\n');
  const bare = path.join(hooks, 'bare-user-prompt.sh');
  fs.writeFileSync(bare, lines.filter((l) => !l.startsWith('export CHEAP_MEM_CODE=')).join('\n'));
  const run = () => spawnSync(BASH, [bare], {
    input: '{"prompt":"x"}', encoding: 'utf8', timeout: 30000,
    env: bareEnv(ctx.home, { XDG_STATE_HOME: path.join(ctx.home, 'state') }),
  });
  const r = run();
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /user-prompt hook is SILENT/);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n', 'the shim wrote through the symlink and cut the user\'s file');
  // .pipeline itself a link to a directory of the user's
  removeTree(path.join(ctx.root, '.pipeline'));
  if (!WIN) {
    assert.ok(link(victimDir, path.join(ctx.root, '.pipeline')), 'fixture: directory symlink');
    run();
    assert.deepEqual(fs.readdirSync(victimDir), [], 'the shim wrote a marker through the .pipeline link');
  }
  // The marker really is in the user's state directory, and it limits the message to once per 30 minutes.
  const state = path.join(ctx.home, 'state', 'cheap-mem');
  assert.ok(fs.readdirSync(state).some((f) => f.startsWith('tool-missing-user-prompt-')), 'no marker in the user\'s state directory');
  assert.equal(run().stdout, '', 'the second call inside 30 minutes repeats itself');
  assert.ok(!fs.existsSync(path.join(ctx.root, '.pipeline', 'tool-missing-user-prompt')) || WIN, 'a marker was written into the memory');
});

// ---------------------------------------------------------------------------
// 5. The command
// ---------------------------------------------------------------------------

test('mem trust-own-tool: refuses without a terminal, --non-interactive sets, --status and --off need none', () => {
  const scratch = temp('cm-ot-cmd-');
  const home = path.join(scratch, 'home');
  fs.mkdirSync(home, { recursive: true });
  const root = initMemory(scratch);
  const ctx = { root, home };
  const run = (...a) => trustCli(ctx, ...a);

  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--non-interactive/);
  assert.match(help.stdout, /needs a terminal/);

  const refused = run();
  assert.notEqual(refused.status, 0, 'no terminal: must refuse');
  assert.match(refused.stderr, /needs a terminal/);
  assert.equal(fs.existsSync(switchOf(home)), false, 'a refused run wrote the switch');

  // --non-interactive alone is not enough: the variable is what a provisioning script adds on purpose.
  const noVar = trustCli({ root, home, noProvision: true }, '--non-interactive');
  assert.notEqual(noVar.status, 0, '--non-interactive without CHEAP_MEM_PROVISION=1 must refuse');
  assert.match(noVar.stderr, /CHEAP_MEM_PROVISION=1/, 'the refusal names what is missing');
  assert.equal(fs.existsSync(switchOf(home)), false, 'a refused run wrote the switch');
  const noFlag = spawnSync(process.execPath, [MEM, '--root', root, 'trust-own-tool'], {
    encoding: 'utf8', timeout: 30000, env: bareEnv(home, { CHEAP_MEM_PROVISION: '1' }),
  });
  assert.notEqual(noFlag.status, 0, 'the variable without the flag must refuse');

  const status0 = run('--status');
  assert.equal(status0.status, 0);
  assert.match(status0.stdout, /switch:\s+OFF/);
  assert.match(status0.stdout, /\(missing\)/);

  const set = run('--non-interactive');
  assert.equal(set.status, 0, set.stderr);
  assert.match(set.stderr, /ships no tool of its own/, 'a memory without a tool is told the switch does nothing yet');
  assert.equal(owntool.isTrusted(root, optsOf(home)), true);
  assert.match(run('--status').stdout, /switch:\s+ON/);
  assert.match(run('--non-interactive').stdout, /Already trusted/);

  assert.notEqual(run('--status', '--off').status, 0, '--status takes no other flag');
  assert.notEqual(run('--bogus').status, 0, 'an unknown flag is refused');

  const off = run('--off');
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /Trust withdrawn/);
  assert.equal(owntool.isTrusted(root, optsOf(home)), false);
  assert.match(run('--off').stdout, /nothing to withdraw/);

  // Not an MCP tool: a switch that decides whether code runs must not be one a model can call.
  assert.doesNotMatch(read('bin/mem-mcp'), /trust-own-tool|trust_own_tool/);
});

// ---------------------------------------------------------------------------
// 6. Inventory ratchet and the PowerShell side
// ---------------------------------------------------------------------------

const GUARD = /mem_own_tool_trusted|OWN_TOOL\b|mem_pick_tool|Find-OwnTool|OwnToolTrusted/;

// A line that names `<memory>/bin/...` or `<memory>/src/...` (or the tool file a shim looked up under the memory
// root, `Join-Path <memory> $rel`) must ask the rule ITSELF or sit right behind a line that does (the gate of an
// `if`, a few lines up). A whole file that asks somewhere else is not enough: that is how the Windows start hook's
// provenance block imported <memory>\src\provenance.mjs without the switch while the file asked the rule five lines
// further up (tool-trust-cm, review round 3).
const NAMES_MEMORY_CODE = /(\$\{?(CHEAP_MEM_ROOT|ROOT)\}?|\$Root\)?|\$env:CHEAP_MEM_ROOT|\$\{?memRoot\}?)[\s/\\']+((bin|src)[/\\]|`?\$rel\b)/;
const ALLOWED_UNGUARDED = [
  // [file, line text fragment, reason] - empty on purpose: a line that names the memory's code and does not ask the rule
  // needs a reason that is better than "the file asks somewhere".
];
function unguardedLines(text, file = '') {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((l, i) => {
    if (/^\s*(#|\/\/|\*)/.test(l) || !NAMES_MEMORY_CODE.test(l)) return;
    const near = lines.slice(Math.max(0, i - 2), i + 1).join('\n');
    if (GUARD.test(near)) return;
    if (ALLOWED_UNGUARDED.some(([f, frag]) => f === file && l.includes(frag))) return;
    out.push(`${i + 1}: ${l.trim().slice(0, 90)}`);
  });
  return out;
}

test('ratchet: every line that runs or loads code from the memory root asks the rule, itself or in the gate right above it', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(REPO, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (!/\.(md|png|json)$/.test(e.name)) files.push(rel);
    }
  };
  walk('bin');
  walk('install');
  const bad = [];
  let named = 0;
  for (const f of files) {
    if (/^install\/(codex|linux|macos)/.test(f)) continue;
    const text = read(f);
    named += text.split('\n').filter((l) => !/^\s*(#|\/\/|\*)/.test(l) && NAMES_MEMORY_CODE.test(l)).length;
    for (const hit of unguardedLines(text, f)) bad.push(`${f}:${hit}`);
  }
  assert.ok(named >= 14, `the ratchet found only ${named} lines that name the memory's code - its pattern is broken`);
  assert.deepEqual(bad, [], 'these lines run or load code from the memory root and do not ask whether the user allowed it');
  // Positive control: the form that slipped through is caught, its repaired form is not.
  const oldProvenance = ["try {", "  `$provSrc = Join-Path `$env:CHEAP_MEM_ROOT 'src\\provenance.mjs'", "  if (Test-Path `$provSrc) { }", "} catch { }"].join('\n');
  assert.equal(unguardedLines(oldProvenance).length, 1, 'the ratchet does not see the old provenance block');
  const repaired = "  `$provSrc = (Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel 'src\\provenance.mjs' -Self `$PSScriptRoot).Path";
  assert.equal(unguardedLines(repaired).length, 0);
  assert.equal(unguardedLines('RUN_MEM=(node "$ROOT/bin/mem")').length, 1, 'a bare shell line is caught');
  assert.equal(unguardedLines('if [ -f "$ROOT/bin/mem" ] && mem_own_tool_trusted "$ROOT"; then\n  RUN_MEM=(node "$ROOT/bin/mem")').length, 0);
});

test('every hook script and every shim consults the rule (sh and ps1)', () => {
  const sh = ['mem-retrieve', 'mem-before-edit', 'mem-after-failure', 'mem-catch-fail', 'mem-stop', 'mem-subagent-start'];
  for (const n of sh) assert.match(read(`bin/${n}`), GUARD, `bin/${n} does not ask the rule`);
  for (const n of sh) {
    assert.match(read(`bin/${n}.ps1`), /Test-OwnToolTrusted|Find-OwnTool/, `bin/${n}.ps1 does not ask the rule`);
  }
  for (const n of ['user-prompt', 'pre-edit', 'catch-fail', 'after-failure', 'subagent-start', 'session-stop', 'session-start']) {
    const text = read(`install/hooks/${n}.sh`);
    assert.match(text, /mem_pick_tool/, `install/hooks/${n}.sh does not ask the rule`);
    assert.doesNotMatch(text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'),
      /exec bash "\$CHEAP_MEM_ROOT\/bin\//, `install/hooks/${n}.sh still runs the memory's tool first`);
  }
});

test('the shell and the installed copy are one file; bin/_owntool.ps1 is installed under its shim name', () => {
  assert.match(read('install/claude-code.sh'), /cp "\$CODE_ROOT\/bin\/_owntool\.sh" "\$HOOKS_DIR\/cheap-mem-own-tool\.sh"/);
  assert.match(read('install/windows.ps1'), /bin\\_owntool\.ps1'\) -Destination \(Join-Path \$HooksDir 'cheap-mem-own-tool\.ps1'\)/);
});

test('windows.ps1: all seven generated hooks use the rule; the memory\'s bin is never tried first (static, all platforms)', () => {
  const text = read('install/windows.ps1');
  // The six delegating hooks.
  const found = text.match(/Find-OwnTool -Root `\$env:CHEAP_MEM_ROOT -Rel `\$rel -Self `\$PSScriptRoot/g) || [];
  assert.equal(found.length, 6, `expected 6 delegating hooks to call Find-OwnTool, got ${found.length}`);
  // The start hook.
  assert.match(text, /Find-OwnTool -Root `\$env:CHEAP_MEM_ROOT -Rel 'bin\\mem' -Self `\$PSScriptRoot/);
  assert.match(text, /Find-OwnTool -Root `\$env:CHEAP_MEM_ROOT -Rel 'src\\injection\.mjs'/);
  // No line that joins the memory root with a tool path remains in the generated text.
  const joins = text.split('\n').filter((l) => !/^\s*#/.test(l)
    && /Join-Path `?\$env:CHEAP_MEM_ROOT `?\$rel|Join-Path `?\$env:CHEAP_MEM_ROOT 'bin\\mem'|Join-Path `?\$env:CHEAP_MEM_ROOT 'src\\injection/.test(l));
  assert.deepEqual(joins, [], 'a generated hook still looks in the memory first');
  // The permission list.
  assert.match(text, /if \(\$ownTrusted\) \{ \$allowNeeded \+= \(Get-MemCmd \$env:CHEAP_MEM_ROOT\) \}/);
  assert.match(text, /\(-not \$codeInsideMem\) -or \$ownTrusted/);
  assert.match(text, /trust-own-tool:\*\)/, 'the switch command is on the deny list');
  // The deny list: the glob form (every spelling), the PowerShell tool, and Write/Edit of the switch file.
  assert.match(text, /'Bash\(\*trust-own-tool\*\)', 'PowerShell\(\*trust-own-tool\*\)'/);
  assert.match(text, /'Bash\(\*CHEAP_MEM_PROVISION\*\)', 'PowerShell\(\*CHEAP_MEM_PROVISION\*\)'/);
  assert.match(text, /foreach \(\$tool in @\('Write', 'Edit'\)\) \{ \$denyNeeded \+= "\$tool\(\/\$swPosix\/\*\*\)" \}/);
  assert.match(text, /\(\[string\]\$_\)\.Replace\('\\', '\/'\) -ne \$stale/, 'the stale entry goes in its backslash spelling too');
  // The tool-missing marker is in the user's state directory, never written through the memory.
  const tm = text.slice(text.indexOf('param([string]$Name'), text.indexOf("'@ | Set-Content -LiteralPath $missingHookDst"));
  assert.doesNotMatch(tm, /\$Root '\.pipeline'|Join-Path \(Join-Path \$Root|\.pipeline'\)/, 'tool-missing still writes into the memory');
  assert.match(tm, /Join-Path \$base 'cheap-mem'/, 'the marker directory is the user\'s');
  assert.match(tm, /\$env:LOCALAPPDATA/);
  assert.match(tm, /ReparsePoint/, 'a link at the marker place must not be written through');
  // The tool-missing message speaks for a skipped own tool even without a code path.
  assert.match(text, /\[switch\]\$Skipped/);
  assert.match(text, /memory ships its own tool; using the installed one\. To trust it: mem trust-own-tool/);
});

test('bin/_owntool.ps1: balanced, ASCII, the functions the hooks call', () => {
  const text = read('bin/_owntool.ps1');
  assert.ok(/^[\x00-\x7f]*$/.test(text), 'a non-ASCII character: Windows PowerShell 5.1 reads a BOM-less file as ANSI');
  for (const [o, c] of [['{', '}'], ['(', ')']]) {
    const strip = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n').replace(/'[^'\n]*'/g, "''");
    assert.equal(strip.split(o).length, strip.split(c).length, `unbalanced ${o}${c}`);
  }
  for (const fn of ['Get-OwnToolKey', 'Get-OwnToolFile', 'Test-OwnToolTrusted', 'Test-OwnToolInside', 'Test-OwnToolShips', 'Find-OwnTool']) {
    assert.match(text, new RegExp(`function ${fn}\\b`), `${fn} is missing`);
  }
  // A relative path is read against the PowerShell location; a link or junction is followed.
  assert.match(text, /Join-Path \(Get-Location\)\.ProviderPath \$Path/, 'a relative path must be resolved against $PWD');
  assert.match(text, /\[System\.IO\.Directory\]::ResolveLinkTarget\(\$full, \$true\)/, 'a link or junction must be followed');
  assert.match(text, /\$item\.Target/, 'the 5.1 fallback for a link target');
  // The decisions themselves, each pinned (the mutation sweep removes them one by one).
  assert.match(text, /foreach \(\$line in \$lines\) \{ if \(\$line -ceq \$key\) \{ return \$true \} \}/, 'the line must equal the key, exactly');
  assert.match(text, /if \(\$trusted\) \{ \$res\.Path = \$own; return \$res \}\s+\$res\.Skipped = \$true/, 'the memory\'s own copy only when trusted, else reported as passed over');
  assert.match(text, /if \(\(-not \$trusted\) -and \(Test-OwnToolInside \(Split-Path -Parent \$c\) \$Root\)\)/, 'a candidate inside the memory counts as the memory\'s own');
  assert.match(text, /\(\$d \+ '\/'\)\.StartsWith\(\(\$r \+ '\/'\), \[System\.StringComparison\]::Ordinal\)/, 'inside = a path prefix at a separator, not a string prefix');
  assert.match(text, /if \(\$env:CHEAP_MEM_CODE\) \{ \$cands \+= \(Join-Path \$env:CHEAP_MEM_CODE \$Rel\) \}/, 'the installed tool is a candidate');
  // The key rule is the node module's: forward slashes, lower-case on Windows only.
  assert.match(text, /\.Replace\('\\', '\/'\)/);
  assert.match(text, /DirectorySeparatorChar -eq '\\'\) \{ \$k = \$k\.ToLowerInvariant/);
  assert.match(text, /'cheap-mem'\) 'own-tool-roots'/);
});

test('the PowerShell hooks in bin gate the memory\'s copy on the rule, each one (static, all platforms)', () => {
  for (const n of ['mem-retrieve', 'mem-before-edit', 'mem-after-failure', 'mem-catch-fail']) {
    assert.match(read(`bin/${n}.ps1`), /if \(\$OwnToolTrusted -and \(Test-Path -LiteralPath \(Join-Path \$Root 'bin\/mem'\)\)\) \{/,
      `bin/${n}.ps1 takes the memory's bin/mem without asking the rule`);
    assert.match(read(`bin/${n}.ps1`), /\$OwnToolTrusted = Test-OwnToolTrusted \$Root|\$OwnToolTrusted = \$false/, `bin/${n}.ps1 never sets the flag from the rule`);
  }
  const stop = read('bin/mem-stop.ps1');
  assert.equal((stop.match(/@\(\$\(if \(\$OwnToolTrusted\) \{ Join-Path \$Root '/g) || []).length, 4,
    'mem-stop.ps1: all four modules of the memory (answercheck, closingreport, mem-capture, mem-reflect) are gated');
  assert.match(stop, /\$OwnToolTrusted = Test-OwnToolTrusted \$Root/);
  assert.match(read('bin/mem-subagent-start.ps1'), /Find-OwnTool -Root \$Root -Rel 'src\/subagentstart\.mjs' -Self \$Here/);
});

test('the model is told to call the installed tool, never the memory\'s bin/mem', () => {
  // The sub-agent hint names the tool THIS module belongs to.
  const dir = temp('cm-ot-hint-');
  const root = initMemory(dir);
  const sa = execFileSync(process.execPath, ['--input-type=module', '-e',
    `import * as m from ${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'subagentstart.mjs')).href)}; process.stdout.write(m.buildContext(process.argv[1]));`, root],
  { encoding: 'utf8' });
  assert.ok(sa.includes(`${path.join(REPO, 'bin', 'mem')} --root ${root} component <path>`), `the sub-agent hint does not name the installed tool:\n${sa}`);
  assert.ok(!sa.includes(`${root}/bin/mem`) && !sa.includes(path.join(root, 'bin', 'mem')), 'the sub-agent hint sends the model to the memory\'s bin/mem');
  // The mail handler's prompt (run with `echo` as the model: it prints what it was asked).
  assert.ok(BASH, 'bash is needed for the handler');
  const r = spawnSync(BASH, [path.join(REPO, 'bin', 'mem-handle-post')], {
    encoding: 'utf8', timeout: 30000,
    env: bareEnv(dir, { CHEAP_MEM_ROOT: root, MEM_WATCH_WHO: 'reader', MEM_HANDLER_CMD: 'echo' }),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /node \S*\/bin\/mem --root \$CHEAP_MEM_ROOT inbox new --as reader/, `the handler prompt does not name the installed tool:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /CHEAP_MEM_ROOT\/bin\/mem/, 'the handler prompt sends the model to the memory\'s bin/mem');
  // The reflector's prompt, and both PowerShell twins, say the same (their text is the proof here).
  for (const f of ['bin/mem-reflect', 'bin/mem-reflect.ps1', 'bin/mem-handle-post.ps1']) {
    assert.doesNotMatch(read(f), /CHEAP_MEM_ROOT[/\\]bin[/\\]mem\b/, `${f} still names the memory's bin/mem`);
    assert.match(read(f), /\$\{?toolCmd\}?|\$TOOL_CMD/i, `${f} does not use the installed tool's path`);
  }
});

test('PowerShell side (win32 only): the twin answers like the node module', () => {
  if (!WIN || !POWERSHELL) {
    // The honest branch: no PowerShell here. The static proof above is the whole proof on this platform.
    assert.ok(!WIN || !POWERSHELL, 'unreachable');
    assert.ok(read('bin/_owntool.ps1').includes('function Test-OwnToolTrusted'), 'the twin must at least exist');
    return;
  }
  const dir = temp('cm-ot-ps-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const o = optsOf(home);
  const root = initMemory(dir);
  const ps = (r) => spawnSync(POWERSHELL, ['-NoProfile', '-Command',
    `. '${path.join(REPO, 'bin', '_owntool.ps1').replace(/'/g, "''")}'; if (Test-OwnToolTrusted '${r.replace(/'/g, "''")}') { 'yes' } else { 'no' }`],
  { encoding: 'utf8', env: bareEnv(home) }).stdout.trim();
  assert.equal(ps(root), 'no');
  owntool.setTrusted(root, true, o);
  assert.equal(ps(root), 'yes');
  owntool.setTrusted(root, false, o);
  assert.equal(ps(root), 'no');
});

// A hook `command` in settings.json goes through a shell. The path in it has
// to come out of that shell as ONE word, whatever characters it holds (#42).
//
// **The finding.** `install/claude-code.sh` wrote paths with
// `/[\s"]/.test(s) ? "\"" + s + "\"" : s`: double quotes, and only for white
// space or a `"`. A `"` inside was not escaped, and inside double quotes the
// shell still expands `$HOME`, `$(...)`, a backtick and a backslash. A Claude
// home or a bash path with one of them either did not run (the hook was mute)
// or ran something else.
//
// **What is written now** (see the comment above `q` in the installer):
//   - POSIX path of safe characters only: byte for byte as before, so an
//     older install is replaced, not doubled;
//   - any other POSIX path: single quotes, `'` as `'\''`;
//   - Windows path (drive letter, UNC, backslash form): double quotes for
//     white space as before, and a `"`, a `$` or a backtick in it is REFUSED
//     (a shell evaluates `$` and a backtick inside double quotes). Which
//     shell runs a hook on Windows cannot be proven from here, so single
//     quotes (which cmd.exe does not read) are not used there.
//
// Probes run the real installer against a HOME and a Claude home in the OS
// temp directory, never the user's own ~/.claude, and run the written command
// with `sh -c` the way Claude Code does. The Windows branch of `q` cannot be
// reached by an installer run on a POSIX box, so its function is cut out of
// the installer text and called directly. POSITIVE CONTROL: the OLD function
// is run on the same names and is broken by them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const INSTALL = path.join(REPO, 'install', 'claude-code.sh');
const WIN = process.platform === 'win32';
const INSTALLER_TEXT = fs.readFileSync(INSTALL, 'utf8');

// Folder names that mean something to a shell. A backslash and a `"` are not
// legal in a Windows folder name, so those cases are POSIX-only. `$` and a
// backtick are legal there, but a Windows-form path (`C:/...`, what cygpath
// gives) is written in double quotes, where a shell evaluates them: the
// installer REFUSES such a path (decision of the reviewer, #42), so on Windows
// these three names are probed for the refusal further down, not for a run.
const NAMES = [
  ['white space', 'claude home'],
  ['apostrophe', "o'brien home"],
  ['ampersand and semicolon', 'a&b;c (d)'],
  ...(WIN ? [] : [
    ['dollar sign text', 'cl$HOME-x'],
    ['command substitution', 'cl$(touch INJECTED-DOLLAR)x'],
    ['backtick', 'cl`touch INJECTED-TICK`x'],
    ['double quote', 'say "hi"'],
    ['backslash', 'back\\slash'],
    ['everything at once', `a b'c"d$HOME\`x\\y`],
  ]),
];

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-quote-'));
}
const wipe = (t) => fs.rmSync(t, { recursive: true, force: true });

/** An initialised memory and a place to install into, all under one scratch. */
function setup(homeName) {
  const tmp = scratch();
  const root = path.join(tmp, 'memory');
  fs.mkdirSync(root, { recursive: true });
  execFileSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  const heim = path.join(tmp, 'home');
  fs.mkdirSync(heim, { recursive: true });
  const claudeHome = path.join(tmp, homeName);
  const cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, HOME: heim, USERPROFILE: heim, CHEAP_MEM_ROOT: root, CLAUDE_HOME: claudeHome };
  return { tmp, root, claudeHome, cwd, env, settings: path.join(claudeHome, 'settings.json') };
}

function runInstaller(w) {
  return spawnSync('bash', [INSTALL], { cwd: w.cwd, env: w.env, encoding: 'utf8' });
}

const readSettings = (w) => JSON.parse(fs.readFileSync(w.settings, 'utf8'));
const commandsOf = (cfg) => Object.values(cfg.hooks).flat().flatMap((e) => (e.hooks ?? []).map((h) => h.command));
const hookCommand = (cfg, file) => commandsOf(cfg).find((c) => c.includes(file));

/** The words a POSIX shell makes of a command line. */
function shellWords(command, cwd) {
  const r = spawnSync('sh', ['-c', 'set -- ' + command + '; for a in "$@"; do printf "%s\\n" "$a"; done'],
    { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').slice(0, -1);
}

for (const [label, name] of NAMES) {
  test(`the written command runs exactly the hook script - ${label}`, () => {
    const w = setup(name);
    try {
      const r = runInstaller(w);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const cfg = readSettings(w);
      const cmds = commandsOf(cfg).filter((c) => /cheap-mem-[a-z-]+\.sh/.test(c));
      assert.ok(cmds.length >= 7, `only ${cmds.length} hook commands written`);

      // Every command is two shell words: the interpreter and ONE script.
      // (On Windows the folder is a drive-letter path, written in double
      // quotes; the names in NAMES that hold nothing a shell evaluates read
      // as one word there too. `$`, a backtick and `"` never get this far.)
      for (const c of cmds) {
        const words = shellWords(c, w.cwd);
        assert.equal(words.length, 2, `the shell splits ${c} into ${JSON.stringify(words)}`);
        assert.ok(fs.existsSync(words[1]), `${words[1]} is not a file (command ${c})`);
      }

      // And the command really starts THAT script: replace the installed
      // shim by a marker writer, run the command the way Claude Code does.
      const marker = path.join(w.tmp, 'marker.txt');
      const script = shellWords(hookCommand(cfg, 'cheap-mem-user-prompt.sh'), w.cwd)[1];
      fs.writeFileSync(script, '#!/usr/bin/env bash\nprintf ran > "$CM_MARKER"\n');
      const run = spawnSync('sh', ['-c', hookCommand(cfg, 'cheap-mem-user-prompt.sh')],
        { cwd: w.cwd, env: { ...w.env, CM_MARKER: marker }, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'ran', 'the marker script did not run');

      // Nothing in the path was evaluated by the shell.
      const stray = fs.readdirSync(w.cwd);
      assert.deepEqual(stray, [], `the shell ran something from the path: ${stray}`);
    } finally { wipe(w.tmp); }
  });
}

test('a path of safe characters is written exactly as before (no migration)', { skip: WIN && 'the Windows form is covered by the direct calls below' }, () => {
  const w = setup('claudehome');
  try {
    const r = runInstaller(w);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const cfg = readSettings(w);
    const cmds = commandsOf(cfg).filter((c) => /cheap-mem-[a-z-]+\.sh/.test(c));
    assert.ok(cmds.length >= 7);
    const hooks = path.join(w.claudeHome, 'hooks');
    for (const c of cmds) {
      assert.ok(/^[^'" ]+ [^'" ]+$/.test(c), `a quote appeared in a smooth path: ${c}`);
      assert.ok(c.endsWith(' ' + hooks + '/' + c.split('/').at(-1)), `not the plain script path: ${c}`);
    }
  } finally { wipe(w.tmp); }
});

test('a second install makes no second entry, and replaces an entry in the old double-quote form', () => {
  const w = setup('old form home');
  try {
    // What the old installer wrote for a path with a space.
    fs.mkdirSync(w.claudeHome, { recursive: true });
    const hooks = path.join(w.claudeHome, 'hooks');
    const seeded = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `bash "${hooks}/cheap-mem-user-prompt.sh"` }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo foreign' }] }],
      },
    };
    fs.writeFileSync(w.settings, JSON.stringify(seeded));
    for (let i = 0; i < 2; i += 1) {
      const r = runInstaller(w);
      assert.equal(r.status, 0, r.stderr + r.stdout);
    }
    const cfg = readSettings(w);
    const mine = commandsOf(cfg).filter((c) => c.includes('cheap-mem-user-prompt.sh'));
    assert.equal(mine.length, 1, `entries for the prompt hook: ${JSON.stringify(mine)}`);
    assert.ok(!mine[0].includes('"'), `still the old double-quote form: ${mine[0]}`);
    for (const file of ['session-start', 'session-stop', 'pre-edit', 'catch-fail', 'after-failure', 'subagent-start']) {
      const n = commandsOf(cfg).filter((c) => c.includes(`cheap-mem-${file}.sh`)).length;
      assert.equal(n, 1, `${file}: ${n} entries after two runs`);
    }
    assert.ok(commandsOf(cfg).includes('echo foreign'), 'a foreign hook was lost');
  } finally { wipe(w.tmp); }
});

// `C:` makes the path a Windows path to the installer even on a POSIX box (a
// relative folder under the scratch cwd); on Windows the name is real (`$` and a
// backtick are legal there; a `"` is refused by the file system before that).
// Either way: loud, and no settings.json.
for (const [label, folder, reason] of [
  ['a double quote', 'C:/pre"fix', /double quote/],
  ['a dollar sign', 'C:/pre$HOMEfix', /dollar sign/],
  ['a backtick', 'C:/pre`touch X`fix', /backtick/],
]) {
  test(`${label} in a Windows-form path stops the installer before settings.json is written`, () => {
    const w = setup('unused');
    try {
      w.env.CLAUDE_HOME = folder;
      const settings = path.join(w.cwd, ...folder.split('/'), 'settings.json');
      const r = runInstaller(w);
      assert.notEqual(r.status, 0, `the installer went on: ${r.stdout}`);
      assert.equal(fs.existsSync(settings), false, 'settings.json was written');
      assert.deepEqual(fs.readdirSync(w.cwd).filter((f) => f !== 'C:'), [], 'the shell ran something from the path');
      if (!(WIN && label === 'a double quote')) assert.match(r.stderr, reason);
    } finally { wipe(w.tmp); }
  });
}

// ---- the function itself, Windows branch included ---------------------------------------------------------------

function loadQ() {
  const a = INSTALLER_TEXT.indexOf('const isWindowsPath');
  const b = INSTALLER_TEXT.indexOf('// An old install is recognised by the SCRIPT NAME');
  assert.ok(a > 0 && b > a, 'the quoting function moved - this probe cannot cut it out');
  const calls = { exit: null, err: [] };
  const fake = { exit: (c) => { calls.exit = c; throw new Error('exit ' + c); } };
  const fakeConsole = { error: (m) => calls.err.push(m) };
  const q = new Function('settingsPath', 'process', 'console', INSTALLER_TEXT.slice(a, b) + '\nreturn q;')('S', fake, fakeConsole);
  return { q, calls };
}

test('q: POSIX paths', () => {
  const { q } = loadQ();
  assert.equal(q('bash'), 'bash');
  assert.equal(q('/usr/bin/bash'), '/usr/bin/bash');
  assert.equal(q('/home/u/.claude/hooks/cheap-mem-stop.sh'), '/home/u/.claude/hooks/cheap-mem-stop.sh');
  assert.equal(q('/a b/x.sh'), "'/a b/x.sh'");
  assert.equal(q("/o'b/x.sh"), "'/o'\\''b/x.sh'");
  assert.equal(q('/a$HOME/x'), "'/a$HOME/x'");
  assert.equal(q('/a`x`/y'), "'/a`x`/y'");
  assert.equal(q('/a"b/y'), "'/a\"b/y'");
  assert.equal(q('/a\\b/y'), "'/a\\b/y'");
  assert.equal(q('/a&b;c/y'), "'/a&b;c/y'");
});

test('q: Windows paths keep the double quotes; a double quote, a dollar sign or a backtick in one is refused', () => {
  const { q, calls } = loadQ();
  assert.equal(q('C:\\Program Files\\Git\\bin\\bash.exe'), '"C:\\Program Files\\Git\\bin\\bash.exe"');
  assert.equal(q('C:/Users/Max Muster/.claude/hooks/cheap-mem-stop.sh'), '"C:/Users/Max Muster/.claude/hooks/cheap-mem-stop.sh"');
  assert.equal(q('C:/Users/max/.claude/hooks/cheap-mem-stop.sh'), 'C:/Users/max/.claude/hooks/cheap-mem-stop.sh');
  assert.equal(q('C:\\Git\\bin\\bash.exe'), 'C:\\Git\\bin\\bash.exe');
  assert.equal(q('\\\\server\\share x\\bash.exe'), '"\\\\server\\share x\\bash.exe"');
  // a backslash form without a drive letter is a Windows path too
  assert.equal(q('hooks\\a b.sh'), '"hooks\\a b.sh"');
  for (const [bad, word] of [['C:/Users/a"b/x.sh', 'double quote'], ['C:/Users/a$HOME/x.sh', 'dollar sign'],
    ['C:\\Users\\a b`c`\\x.sh', 'backtick'], ['\\\\host\\c$\\x\\bash.exe', 'dollar sign'],
    ['rel\\$x\\y.sh', 'dollar sign']]) {
    calls.exit = null; calls.err.length = 0;
    assert.throws(() => q(bad), /exit 1/, bad);
    assert.equal(calls.exit, 1, bad);
    assert.ok(calls.err.join('\n').includes(word), `${bad}: ${calls.err.join(' ')}`);
  }
  // refusing is for Windows paths only: a POSIX path with these is quoted, not refused
  assert.equal(q('/a$b'), "'/a$b'");
  // a POSIX path with a backslash in it is NOT a Windows path
  assert.equal(q('/home/a\\b'), "'/home/a\\b'");
});

test('POSITIVE CONTROL: the old function breaks on these names', () => {
  const old = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);
  const dollar = shellWords(old('/tmp/a$HOME b/x.sh'), os.tmpdir());
  assert.notEqual(dollar[0], '/tmp/a$HOME b/x.sh', 'the old form kept $HOME literal');
  // the quotes cancel out: the shell reads `say hi`, a different directory
  assert.notDeepEqual(shellWords(old('/tmp/say "hi"/x.sh'), os.tmpdir()), ['/tmp/say "hi"/x.sh'],
    'the old form survived a double quote in the path');
  const tick = old('/tmp/a b`echo X`/x.sh');
  assert.ok(!shellWords(tick, os.tmpdir())[0].includes('`'), 'the old form kept the backtick literal');
  // and the new function does not
  const { q } = loadQ();
  for (const p of ['/tmp/a$HOME b/x.sh', '/tmp/say "hi"/x.sh', '/tmp/a b`echo X`/x.sh', "/tmp/o'b c/x.sh"]) {
    assert.deepEqual(shellWords(q(p), os.tmpdir()), [p]);
  }
});

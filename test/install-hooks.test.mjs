// The hook command names its interpreter.
//
// For a long time the installer wrote the bare `.sh` path as the
// command. That fails in two ways, and both have been paid for:
//
//   Linux/macOS — exit 126 as soon as the x bit is missing. That
//   happens by itself on a clone with core.fileMode=false. At least it
//   is loud; found in lucky-mem on 2026-09-01.
//
//   Windows — `bash` is not on the PATH cmd.exe sees. A test run
//   through cmd did not fail, it HUNG. A UserPromptSubmit hook that
//   hangs blocks every message until the timeout — the memory then
//   makes the assistant unusable rather than merely mute. Reported by a
//   fresh Windows install on 2026-09-07.
//
// The Windows branch (cygpath) cannot be exercised here. What can be
// exercised is everything else — and that is exactly the part that has
// to be identical on every platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const INSTALL = path.join(REPO, 'install', 'claude-code.sh');
const EVENTS = ['SessionStart', 'Stop', 'UserPromptSubmit'];

// `home` may contain a space — on Windows that is the normal case, not
// the exception.
function install({ homeName = 'claude home' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inst-'));
  const root = path.join(tmp, 'memory');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  const claudeHome = path.join(tmp, homeName);
  execFileSync('bash', [INSTALL], {
    env: { ...process.env, CHEAP_MEM_ROOT: root, CLAUDE_HOME: claudeHome },
    stdio: 'ignore',
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
  return { tmp, claudeHome, cfg };
}
const wipe = (t) => fs.rmSync(t, { recursive: true, force: true });
const commands = (cfg) => EVENTS.map((e) => cfg.hooks[e].at(-1).hooks[0].command);

test('THE CASE: no command is a bare script path', () => {
  const { tmp, cfg } = install();
  try {
    for (const cmd of commands(cfg)) {
      assert.ok(!/^\S*cheap-mem-[a-z-]+\.sh$/.test(cmd.trim()),
        `bare path as command: ${cmd}`);
      assert.match(cmd, /bash/, `no interpreter named: ${cmd}`);
    }
  } finally { wipe(tmp); }
});

test('a path with a space is quoted', () => {
  // `C:\Program Files\Git\bin\bash.exe` is the normal case on Windows.
  const { tmp, cfg } = install({ homeName: 'claude home' });
  try {
    for (const cmd of commands(cfg)) {
      const parts = cmd.match(/"[^"]*"|\S+/g) ?? [];
      assert.equal(parts.length, 2, `not exactly two parts: ${cmd}`);
      assert.ok(parts[1].startsWith('"') && parts[1].endsWith('"'),
        `path with a space is unquoted: ${cmd}`);
    }
  } finally { wipe(tmp); }
});

test('the command points at the file that is really there', () => {
  const { tmp, claudeHome, cfg } = install({ homeName: 'claudehome' });
  try {
    for (const cmd of commands(cfg)) {
      const script = (cmd.match(/(\S+cheap-mem-[a-z-]+\.sh)/) ?? [])[1];
      assert.ok(script, `no script path in the command: ${cmd}`);
      assert.ok(fs.existsSync(script), `command points nowhere: ${script}`);
      assert.equal(path.dirname(script), path.join(claudeHome, 'hooks'));
    }
  } finally { wipe(tmp); }
});

test('the command runs and returns what the hook is supposed to return', () => {
  // The only proof that counts: not how it looks, but whether it runs.
  // Without this test "names an interpreter" would stay a claim about a
  // string.
  const { tmp, cfg } = install({ homeName: 'claudehome' });
  try {
    const cmd = cfg.hooks.UserPromptSubmit.at(-1).hooks[0].command;
    const out = execFileSync('bash', ['-c', cmd], {
      input: JSON.stringify({ prompt: 'was ist mit dem gedaechtnis' }),
      encoding: 'utf8', timeout: 20000,
    });
    // Empty output is allowed (fresh memory, no hit); what is NOT
    // allowed is a crash or garbage.
    if (out.trim()) JSON.parse(out);
  } finally { wipe(tmp); }
});

test('a second run replaces the entry instead of appending a second one', () => {
  // Two hooks on UserPromptSubmit means every message pays twice. The
  // old filter looked for the PATH — and that changes between two runs
  // as soon as the form changes.
  const { tmp, claudeHome, cfg } = install({ homeName: 'claudehome' });
  try {
    const before = Object.fromEntries(EVENTS.map((e) => [e, cfg.hooks[e].length]));
    // Slip in an entry in the old form — and with a DIFFERENT PATH
    // FORM. That is the case that counts: under Git Bash one run writes
    // `/c/Users/...`, the next one `C:/Users/...`. A filter comparing
    // paths sees two different hooks there and leaves both standing.
    //
    // A first version of this test simply rebuilt the path the way the
    // installer writes it — and was therefore green with the old,
    // path-based filter too. A test that sabotage cannot turn red
    // proves nothing.
    const file = path.join(claudeHome, 'settings.json');
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    old.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command',
      command: 'C:/Users/Administrator/.claude/hooks/cheap-mem-user-prompt.sh' }] });
    fs.writeFileSync(file, JSON.stringify(old, null, 2));

    const root = path.join(tmp, 'memory');
    execFileSync('bash', [INSTALL], {
      env: { ...process.env, CHEAP_MEM_ROOT: root, CLAUDE_HOME: claudeHome },
      stdio: 'ignore',
    });
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of EVENTS) {
      assert.equal(now.hooks[e].length, before[e],
        `${e} now has ${now.hooks[e].length} entries instead of ${before[e]}`);
    }
  } finally { wipe(tmp); }
});

test('foreign hooks are left untouched', () => {
  const { tmp, claudeHome } = install({ homeName: 'claudehome' });
  try {
    const file = path.join(claudeHome, 'settings.json');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    cfg.hooks.UserPromptSubmit.unshift({ hooks: [{ type: 'command', command: 'echo foreign' }] });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    execFileSync('bash', [INSTALL], {
      env: { ...process.env, CHEAP_MEM_ROOT: path.join(tmp, 'memory'), CLAUDE_HOME: claudeHome },
      stdio: 'ignore',
    });
    const now = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(now.hooks.UserPromptSubmit.some((e) => e.hooks[0].command === 'echo foreign'),
      'a foreign hook was removed');
  } finally { wipe(tmp); }
});

test('what the installer ANNOUNCES, it also creates', () => {
  // The closing line named three hooks, four were created. Nobody would
  // have missed the fourth — you read the line and believe it. Exactly
  // the class this repository spent the day building against, only the
  // other way round: the presentation was POORER than the thing.
  const src = fs.readFileSync(path.join(REPO, 'install', 'claude-code.sh'), 'utf8');
  const m = /cheap-mem-\{([^}]+)\}\.sh/.exec(src);
  assert.ok(m, 'the summary no longer names the hooks in {a,b} form');
  const announced = new Set(m[1].split(',').map((x) => x.trim()));
  const created = new Set(
    [...src.matchAll(/\$HOOKS_DIR\/cheap-mem-([a-z-]+)\.sh"/g)].map((x) => x[1]),
  );
  for (const h of created) {
    assert.ok(announced.has(h), `${h}.sh is created but not announced`);
  }
  for (const h of announced) {
    assert.ok(created.has(h), `${h}.sh is announced but not created`);
  }
});

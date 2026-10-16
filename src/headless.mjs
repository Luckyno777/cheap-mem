// headless — the ONE place that decides how cheap-mem starts a model session
// (`claude -p`) from an unattended job: the digest, the mail handler, the reflector.
//
// **The finding (tool-trust review, 2026-10).** Without `--bare`, `claude -p`
// runs the hooks of `.claude/settings.json` of the folder it starts in and
// connects the servers of its `.mcp.json` — in a folder nobody ever trusted,
// with no dialog (Claude Code docs, "What runs before you trust a folder").
// The digest and the mail handler started IN the memory. Whoever can push to a
// memory could plant `.claude/settings.json` with a hook and have the next
// watcher or digest run execute it. A cloned memory must never run code.
//
// **Two layers, either one enough on its own:**
//   1. `--setting-sources user --strict-mcp-config`: the session reads the
//      user's own settings only (their permissions stay), no project settings,
//      no `.mcp.json`, and — since skills, commands and agents of an `--add-dir`
//      folder load through the `project` source — none of those either.
//   2. A neutral working directory outside the memory, with the memory passed
//      as `--add-dir` when the job needs to read it. The folder the session
//      starts in is an empty one of ours.
//
// **Not `--bare`** (needs an API key; the owner logs in with an account) and
// **not** `disableAllHooks` (it would also switch off the owner's own
// protective hooks).
//
// **Only for `claude`.** The command is configurable (MEM_DIGEST_CMD, ...).
// Another CLI has another flag grammar; adding claude's flags would break it, so
// it is left as configured and docs/security-model.md says so. What counts as
// claude: the first word (or the second after `node`) is `claude`, with or
// without a directory or an extension, or the path names `claude-code`.
//
// **An old claude refuses to start.** One without `--setting-sources` fails on
// the unknown option; `looksLikeOldClaude()` reads that failure so the log says
// WHY, and nothing runs open (a missing flag is never dropped).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The flags every claude start carries. `--add-dir` is added per job and goes LAST. */
export const ISOLATION_FLAGS = Object.freeze(['--setting-sources', 'user', '--strict-mcp-config']);

const OLD_CLAUDE_MESSAGE = [
  'headless: this claude does not know --setting-sources (too old).',
  '  cheap-mem will not start a model session that could read the memory\'s',
  '  .claude/settings.json and .mcp.json; it started nothing without the flag.',
  '  Update claude (`claude update`, or reinstall @anthropic-ai/claude-code) and run again.',
];

const stem = (w) => String(w ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');

/** Split a configured command line on whitespace (the same split the shells do). */
function splitCommand(line) {
  return String(line ?? '').split(/\s+/).filter(Boolean);
}

/** True when the configured command starts claude (see the header for what counts). */
export function isClaudeCommand(line) {
  const w = splitCommand(line);
  if (w.length === 0) return false;
  const named = (x) => stem(x) === 'claude' || /(^|[\\/])claude-code([\\/]|$)/i.test(String(x));
  // The whole line as ONE path: `C:\Program Files\claude\claude.exe` has a space in it (bin/mem-digest.ps1
  // hands over just the executable), and its first "word" would be `C:\Program`.
  if (named(String(line).trim())) return true;
  if (named(w[0])) return true;
  if (stem(w[0]) === 'node' && w.length > 1) return named(w[1]);
  return false;
}

/** Does this text (a failed start's output) say that claude does not know our isolation flags? */
export function looksLikeOldClaude(text) {
  return String(text ?? '').split('\n').some((l) =>
    /(setting-sources|strict-mcp-config)/i.test(l)
    && /(unknown|unrecogni[sz]ed|unexpected|invalid|not (a )?(valid|recogni[sz]ed|supported)|no such)/i.test(l));
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * The neutral working directory: an empty folder of ours OUTSIDE the memory.
 * Same cache base as the hooks' compile cache (src of bin/_portable.sh, bin/mem-retrieve.ps1):
 * LOCALAPPDATA on Windows, ~/Library/Caches on macOS, XDG_CACHE_HOME or ~/.cache elsewhere.
 * No home at all: a per-user folder under the OS temp directory. Never inside the memory.
 */
export function neutralDir({ root, env = process.env, platform = process.platform, home = os.homedir(), tmp = os.tmpdir(), create = true } = {}) {
  const bases = [];
  if (platform === 'win32' && env.LOCALAPPDATA) bases.push(env.LOCALAPPDATA);
  else if (platform === 'darwin' && home) bases.push(path.join(home, 'Library', 'Caches'));
  else if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) bases.push(env.XDG_CACHE_HOME);
  else if (home) bases.push(path.join(home, '.cache'));
  const user = (() => { try { return os.userInfo().username; } catch { return 'user'; } })().replace(/[^A-Za-z0-9_.-]/g, '_');
  const candidates = [
    ...bases.map((b) => path.join(b, 'cheap-mem', 'headless-cwd')),
    path.join(tmp, `cheap-mem-headless-cwd-${user}`),
  ];
  const rootReal = root ? real(root) : null;
  for (const dir of candidates) {
    if (create) {
      try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { continue; }
    }
    if (rootReal && inside(real(dir), rootReal)) continue;
    return dir;
  }
  return null;
}

/**
 * What a model start must carry. `{ isolated, args, cwd }`:
 * `args` go AFTER the prompt (`--add-dir` is variadic and would swallow a prompt that
 * followed it, so it is the last thing on the line), `cwd` is where the session starts.
 * Not claude: `{ isolated: false, args: [], cwd: null }` — left as configured.
 * Claude but no safe working directory: throws (refuse, never start open).
 */
export function planHeadless({ cmd, root, addDir = true, env = process.env, platform = process.platform, home, tmp, create = true } = {}) {
  if (!isClaudeCommand(cmd)) return { isolated: false, args: [], cwd: null };
  if (!root || /[\r\n]/.test(root)) throw new Error('headless: no usable memory root to hand to the session');
  const cwd = neutralDir({ root, env, platform, home, tmp, create });
  if (!cwd) throw new Error('headless: no neutral working directory outside the memory could be made');
  return { isolated: true, args: [...ISOLATION_FLAGS, ...(addDir ? ['--add-dir', root] : [])], cwd };
}

// ---- command line (bin/mem-headless.mjs calls this) -------------------------------------------

/**
 * `plan --cmd <line> --root <dir> [--no-add-dir]` prints `isolated=0|1`, `cwd=...`, `arg=...` lines.
 * `old-claude <file>` exits 0 and prints the message when the file's text is an old-claude refusal.
 */
export function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s), env = process.env } = {}) {
  const [sub, ...rest] = argv;
  if (sub === 'plan') {
    const v = { cmd: '', root: '', addDir: true };
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--cmd') v.cmd = rest[++i] ?? '';
      else if (rest[i] === '--root') v.root = rest[++i] ?? '';
      else if (rest[i] === '--no-add-dir') v.addDir = false;
      else { err(`headless: unknown argument ${rest[i]}\n`); return 2; }
    }
    let p;
    try { p = planHeadless({ ...v, env }); } catch (e) { err(`${e.message}\n`); return 2; }
    const lines = [`isolated=${p.isolated ? 1 : 0}`];
    if (p.cwd) lines.push(`cwd=${p.cwd}`);
    for (const a of p.args) {
      if (/[\r\n]/.test(a)) { err('headless: an argument contains a line break\n'); return 2; }
      lines.push(`arg=${a}`);
    }
    out(`${lines.join('\n')}\n`);
    return 0;
  }
  if (sub === 'old-claude') {
    let text = '';
    try { text = fs.readFileSync(rest[0], 'utf8'); } catch { return 1; }
    if (!looksLikeOldClaude(text)) return 1;
    out(`${OLD_CLAUDE_MESSAGE.join('\n')}\n`);
    return 0;
  }
  err('usage: mem-headless.mjs plan --cmd <line> --root <dir> [--no-add-dir] | old-claude <file>\n');
  return 2;
}

export const isMain = (metaUrl, argv1 = process.argv[1]) => Boolean(argv1) && metaUrl === pathToFileURL(path.resolve(argv1)).href;

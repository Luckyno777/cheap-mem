// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// headless - the ONE place that decides how cheap-mem starts a model session from an unattended job
// (the digest, the mail handler, the reflector). Why, what and the limits: docs/security-model.md, section 11.
//
// Without `--bare`, `claude -p` runs the hooks of the `.claude/settings.json` and connects the servers of the
// `.mcp.json` of its working directory, in a folder nobody trusted and with no dialog. A memory is a git repository
// others can push to, so it must never be that folder. Two layers:
//   1. EVERY configured command starts in a neutral empty directory outside the memory (hooks and `.mcp.json` come from
//      the working directory only, so this protects wrappers, aliases and other agent CLIs too).
//   2. A command recognised as claude also gets `--setting-sources user --strict-mcp-config` and, where the job reads the
//      memory, `--add-dir <memory>`. Not `--bare` (needs an API key), not `disableAllHooks` (would switch off the owner's hooks).
// An alias or a wrapper under another name is not recognised: neutral directory, no flags, and the log says so.
// An old claude without `--setting-sources` fails on the unknown option; that is read, named, and never started open.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The flags every claude start carries. `--add-dir` is added per job and goes LAST. */
export const ISOLATION_FLAGS = Object.freeze(['--setting-sources', 'user', '--strict-mcp-config']);

/** Said in the log when the command is not recognised as claude. */
export const NOT_RECOGNISED_NOTE = 'command not recognised as claude: started in a neutral directory without the settings flags; '
  + 'if it runs claude, add --setting-sources user --strict-mcp-config';

const OLD_CLAUDE_MESSAGE = [
  'headless: this claude does not know --setting-sources (too old).',
  '  cheap-mem will not start a model session that could read the memory\'s',
  '  .claude/settings.json and .mcp.json; it started nothing without the flag.',
  '  Update claude (`claude update`, or reinstall @anthropic-ai/claude-code) and run again.',
];

const stem = (w) => String(w ?? '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1|js|mjs|cjs)$/, '');

/** Split a command line on whitespace; a first word in quotes may hold spaces. */
function words(line) {
  const t = String(line ?? '').trim();
  const q = /^(["'])(.*?)\1(?=\s|$)/.exec(t);
  if (!q) return t.split(/\s+/).filter(Boolean);
  return [q[2], ...t.slice(q[0].length).split(/\s+/).filter(Boolean)];
}

const named = (x) => {
  const s = String(x ?? '');
  return stem(s) === 'claude' || stem(s.replace(/@[^/@\s]+$/, '')) === 'claude-code'
    || /(^|[\\/])claude-code([\\/]|$)/i.test(s) || /@anthropic-ai\/claude-code(@\S*)?$/i.test(s);
};

// Programs that only start another one. Flags that take a value, so the value is not taken for the program.
const WRAPPERS = new Set(['env', 'sudo', 'doas', 'nice', 'ionice', 'timeout', 'gtimeout', 'nohup', 'command', 'exec', 'time',
  'setsid', 'stdbuf', 'caffeinate', 'npx', 'bunx']);
const VALUE_FLAGS = new Set(['-u', '-g', '-n', '-c', '-s', '-k', '-p', '-C', '-S', '-t', '--user', '--group']);
const RUNNERS = new Set(['pnpm', 'yarn', 'npm', 'bun']);
const RUNNER_VERBS = new Set(['dlx', 'exec', 'x']);

/** True when the configured command starts claude (see the header for what counts). */
export function isClaudeCommand(line) {
  const text = String(line ?? '').trim();
  if (!text) return false;
  // The whole line as ONE path: `C:\Program Files\claude\claude.exe` (bin/mem-digest.ps1 hands over just the executable).
  if (named(text)) return true;
  const w = words(text);
  let i = 0;
  for (let guard = 0; i < w.length && guard < 64; guard += 1) {
    const t = w[i];
    const s = stem(t);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i += 1; continue; }
    if (WRAPPERS.has(s)) {
      i += 1;
      while (i < w.length && (/^-/.test(w[i]) || /^[0-9]+[smhd]?$/.test(w[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]))) {
        i += VALUE_FLAGS.has(w[i]) && w[i + 1] !== undefined ? 2 : 1;
      }
      continue;
    }
    if (RUNNERS.has(s) && RUNNER_VERBS.has(stem(w[i + 1]))) { i += 2; while (i < w.length && /^-/.test(w[i])) i += 1; continue; }
    if ((s === 'node' || s === 'deno' || s === 'bun') && w[i + 1] !== undefined) { i += 1; while (i < w.length && /^-/.test(w[i])) i += 1; continue; }
    break;
  }
  return i < w.length && named(w[i]);
}

/** Does this text (a failed start's output) say that claude does not know our isolation flags? Line breaks inside the sentence do not matter. */
export function looksLikeOldClaude(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ');
  const flag = '(?:setting-sources|strict-mcp-config)';
  return new RegExp(`(?:unknown|unrecogni[sz]ed|unexpected|invalid|no such) (?:option|argument|flag)s?:? ?['"\`]?-{0,2}${flag}`, 'i').test(t)
    || new RegExp(`${flag}['"\`]?(?: [a-z]+){0,3} (?:is )?(?:unknown|not (?:a )?(?:valid|recogni[sz]ed|supported))`, 'i').test(t);
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
/** Where a path would land, before anything is made there. */
function realFuture(p) {
  let head = path.resolve(p); const tail = [];
  while (!fs.existsSync(head) && path.dirname(head) !== head) { tail.unshift(path.basename(head)); head = path.dirname(head); }
  return path.join(real(head), ...tail);
}
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Names that make a folder a project to some agent CLI; none may be in the neutral directory. */
const PROJECT_MARKERS = ['.claude', '.mcp.json', 'CLAUDE.md', '.gemini', 'GEMINI.md', 'AGENTS.md', '.codex'];

/** Is this (an `lstat`) an acceptable neutral directory? A real directory, ours (POSIX), 0700, no project marker inside. */
export function dirIsAcceptable(st, entries, { uid = (typeof process.getuid === 'function' ? process.getuid() : null) } = {}) {
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  if (uid !== null && st.uid !== uid) return false;
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return false;
  return !entries.some((e) => PROJECT_MARKERS.includes(e));
}

/**
 * The neutral working directory: `{ dir, cleanup }` or null. `cleanup` is set for a per-run folder (removed after the job).
 * Where: `MEM_HEADLESS_CWD` (parent folder; then ONLY there) or the user cache `cheap-mem/headless-cwd` (LOCALAPPDATA,
 * ~/Library/Caches, XDG_CACHE_HOME or ~/.cache), and last a fresh `mkdtemp` folder in the OS temp directory. Whether a
 * place is inside the memory is decided BEFORE anything is made there. A long-lived folder that is not acceptable is left
 * alone and a fresh per-run one is made next to it.
 */
export function neutralDir({ root, env = process.env, platform = process.platform, home = os.homedir(), tmp = os.tmpdir(), create = true } = {}) {
  const rootReal = root ? realFuture(root) : null;
  const outside = (p) => !rootReal || !inside(realFuture(p), rootReal);
  const parents = [];
  if (env.MEM_HEADLESS_CWD) parents.push(path.resolve(env.MEM_HEADLESS_CWD));
  else {
    if (platform === 'win32' && env.LOCALAPPDATA) parents.push(path.join(env.LOCALAPPDATA, 'cheap-mem'));
    else if (platform === 'darwin' && home) parents.push(path.join(home, 'Library', 'Caches', 'cheap-mem'));
    else if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) parents.push(path.join(env.XDG_CACHE_HOME, 'cheap-mem'));
    else if (home) parents.push(path.join(home, '.cache', 'cheap-mem'));
  }
  for (const parent of parents) {
    const dir = path.join(parent, 'headless-cwd');
    if (!outside(dir)) continue;
    if (!create) return { dir, cleanup: null };
    try {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      let st = null;
      try { st = fs.lstatSync(dir); } catch { st = null; }
      if (!st) { fs.mkdirSync(dir, { mode: 0o700 }); return { dir, cleanup: null }; }
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { entries = ['.claude']; }
      if (dirIsAcceptable(st, entries)) return { dir, cleanup: null };
      const fresh = fs.mkdtempSync(path.join(parent, 'headless-cwd-'));
      return { dir: fresh, cleanup: fresh };
    } catch { /* next place */ }
  }
  if (!env.MEM_HEADLESS_CWD) {
    const prefix = path.join(tmp, 'cheap-mem-headless-cwd-');
    if (outside(prefix)) {
      if (!create) return { dir: `${prefix}XXXXXX`, cleanup: null };
      try { const fresh = fs.mkdtempSync(prefix); return { dir: fresh, cleanup: fresh }; } catch { /* none */ }
    }
  }
  return null;
}

/** Remove a per-run neutral directory made by `neutralDir` (nothing else: name, type and place are checked). */
export function cleanupNeutral(dir) {
  try {
    const name = path.basename(String(dir ?? ''));
    if (!/^(headless-cwd-|cheap-mem-headless-cwd-)[A-Za-z0-9]{6}$/.test(name)) return false;
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch { return false; }
}

/**
 * What a model start must carry: `{ isolated, args, cwd, cleanup, note }`. `cwd` is ALWAYS a neutral directory. Only a command
 * recognised as claude (`isolated`) gets `args` (flags go AFTER the prompt, `--add-dir` last: it is variadic and would swallow
 * a prompt that followed it); any other gets a `note` for the log. No safe directory: throws (refuse, never start open).
 */
export function planHeadless({ cmd, root, addDir = true, env = process.env, platform = process.platform, home, tmp, create = true } = {}) {
  if (!root || /[\r\n]/.test(root)) throw new Error('headless: no usable memory root to hand to the session');
  const claude = isClaudeCommand(cmd);
  const n = neutralDir({ root, env, platform, home, tmp, create });
  if (!n) throw new Error('headless: no neutral working directory outside the memory could be made');
  if (!claude) return { isolated: false, args: [], cwd: n.dir, cleanup: n.cleanup, note: NOT_RECOGNISED_NOTE };
  return { isolated: true, args: [...ISOLATION_FLAGS, ...(addDir ? ['--add-dir', root] : [])], cwd: n.dir, cleanup: n.cleanup, note: null };
}

// ---- command line (bin/mem-headless.mjs calls this) -------------------------------------------

/** `plan --cmd <line> --root <dir> [--no-add-dir]` prints isolated/cwd/arg/note/cleanup lines; `old-claude <file|->`; `cleanup <dir>`. */
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
    const lines = [`isolated=${p.isolated ? 1 : 0}`, `cwd=${p.cwd}`];
    for (const a of p.args) {
      if (/[\r\n]/.test(a)) { err('headless: an argument contains a line break\n'); return 2; }
      lines.push(`arg=${a}`);
    }
    if (p.note) lines.push(`note=${p.note}`);
    if (p.cleanup) lines.push(`cleanup=${p.cleanup}`);
    out(`${lines.join('\n')}\n`);
    return 0;
  }
  if (sub === 'old-claude') {
    let text = '';
    try { text = fs.readFileSync(rest[0] === '-' ? 0 : rest[0], 'utf8'); } catch { return 1; }
    if (!looksLikeOldClaude(text)) return 1;
    out(`${OLD_CLAUDE_MESSAGE.join('\n')}\n`);
    return 0;
  }
  if (sub === 'cleanup') return cleanupNeutral(rest[0]) ? 0 : 1;
  err('usage: mem-headless.mjs plan --cmd <line> --root <dir> [--no-add-dir] | old-claude <file|-> | cleanup <dir>\n');
  return 2;
}

// The shared test (src/ismain.mjs): both sides as real paths. A text comparison of `import.meta.url` (the REAL path) with
// argv[1] (the path as typed) was false under any symlinked parent - every macOS temp dir, /var -> /private/var - and
// bin/mem-headless.mjs then printed nothing: the digest, the mail handler and the reflector refused to start (CI run 1103).
export { isMain } from './ismain.mjs';

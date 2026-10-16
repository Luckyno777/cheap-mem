// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Whether a memory may run its OWN copy of the tool (`<memory>/bin`,
 * `<memory>/src`). Default: no. The switch lives outside every repository.
 *
 * **The threat (tool-trust-cm, 2026-10-16).** The recall hooks used to look
 * for `<memory>/bin/mem-retrieve` first and only then for the installed tool,
 * and `bin/mem-retrieve` itself preferred `<memory>/bin/mem` and loaded
 * `<memory>/src/*.mjs`. A memory is a git clone that `mem-retrieve` pulls from
 * origin every ten minutes. Whoever can push to that remote therefore got code
 * execution on every prompt of every session, and the installer even put
 * `node <memory>/bin/mem` on the permission allow list.
 *
 * **The decision (Lucky).** The default is the installed tool (`CHEAP_MEM_CODE`).
 * A memory runs its own `bin/` or `src/` only when a LOCAL, UNVERSIONED switch
 * says so. A cloned, foreign memory can then never run code, whatever it ships.
 *
 * **The switch.** One text file per user, outside every repository:
 * `$XDG_CONFIG_HOME/cheap-mem/own-tool-roots` (else `~/.config/cheap-mem/...`),
 * on Windows `%APPDATA%\cheap-mem\own-tool-roots`. One line per trusted memory:
 * its real path, with `/` as separator (lower-cased on Windows, where paths
 * ignore case). Why a file and not `git config cheapmem.trustOwnTool`:
 *   - a memory need not be a git repository (a tarball, a synced folder);
 *   - reading it is one shell loop, no `git` start on the hot path of every
 *     prompt (on Windows a `git` start alone costs more than the whole recall);
 *   - it is keyed by the real path, so a COPY or a moved memory does not
 *     inherit the trust, and one file shows every trusted memory at a glance.
 *     The other side of that: the trust hangs on the PATH, so a memory that is
 *     deleted and cloned again at the same path (from another remote, too) has
 *     it. `mem trust-own-tool --off` before deleting the directory withdraws it.
 *   - `.git/config` is also a place git itself executes things from
 *     (`core.fsmonitor`, `core.pager`); no reason to make it a second trust file.
 * Neither a `git pull` nor anything inside the memory can write this file.
 * `.mem/config.json` is NOT used: it is versioned, so the remote would set it.
 *
 * **What it does not claim.** A process that runs as the user can write the
 * file too. The switch stops a pushed commit, a poisoned note and a model that
 * was talked into running a command; it is not a sandbox against local malware.
 *
 * The same rule is implemented a second time in `bin/_owntool.sh` and
 * `bin/_owntool.ps1` (the hooks cannot start node on their hot path);
 * `test/own-tool.test.mjs` holds the three to the same answer.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeAtomic } from './atomicwrite.mjs';

export const FILE_NAME = 'own-tool-roots';

const HEADER = [
  '# cheap-mem: memories allowed to run their OWN bin/ and src/ (one real path per line).',
  '# Written by `mem trust-own-tool`; not versioned, a git pull cannot change it.',
  '# Remove a line (or run `mem trust-own-tool --off`) to withdraw the trust.',
];

/** The directory of the switch file. Pure: everything it needs is passed in. */
export function configDir({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'cheap-mem');
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.posix.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, 'cheap-mem');
}

export function switchFile(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const dir = configDir(opts);
  return (platform === 'win32' ? path.win32 : path).join(dir, FILE_NAME);
}

/** One path in the form the file stores: `/` separators, no trailing `/`, lower-case on Windows. */
export function normalizeKey(p, platform = process.platform) {
  let k = String(p).replace(/\\/g, '/');
  if (k.length > 1 && k.endsWith('/') && !/^[A-Za-z]:\/$/.test(k)) k = k.slice(0, -1);
  return platform === 'win32' ? k.toLowerCase() : k;
}

/**
 * The keys one memory root can be known by. POSIX: the real path (symlinks
 * resolved, so `/tmp` and `/private/tmp` agree). Windows: the long real path,
 * the plain real path and the absolute path, because the shell and PowerShell
 * sides cannot resolve 8.3 names or junctions the way node does, and a miss
 * there must come out as "not trusted", never as a wrong match.
 */
export function rootKeys(root, platform = process.platform) {
  const abs = path.resolve(String(root));
  const found = [];
  const add = (f) => { try { found.push(normalizeKey(f(), platform)); } catch { /* not resolvable */ } };
  add(() => fs.realpathSync(abs));
  if (platform === 'win32') {
    add(() => fs.realpathSync.native(abs));
    add(() => abs);
  }
  return [...new Set(found)];
}

/**
 * Reads the file. Three states, never collapsed (design commitment 2):
 * `missing` (never set), `empty` (nothing trusted) and `broken` (cannot be
 * read - the answer is "not trusted", and the command says why).
 */
export function readSwitch(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { state: 'missing', keys: [], file };
    return { state: 'broken', keys: [], file, error: String((e && e.message) || e) };
  }
  const keys = text.split(/\r?\n/).filter((l) => l !== '' && !l.startsWith('#'));
  return { state: keys.length ? 'ok' : 'empty', keys, file };
}

/** Does this memory root have the switch? */
export function trustState(root, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const file = switchFile(opts);
  const sw = readSwitch(file);
  const mine = rootKeys(root, platform);
  const trusted = mine.some((k) => sw.keys.includes(k));
  return { trusted, state: sw.state, file, keys: mine, error: sw.error };
}

export function isTrusted(root, opts = {}) {
  return trustState(root, opts).trusted;
}

/**
 * Does the memory carry a tool of its own? `bin/mem*` (the CLI and every hook
 * script) or one of the `src/` modules the hooks would pick up from a memory.
 */
export function shipsOwnTool(root) {
  try {
    const bin = fs.readdirSync(path.join(root, 'bin'));
    if (bin.some((n) => n === 'mem' || n.startsWith('mem-'))) return true;
  } catch { /* no bin/ */ }
  return ['subagentstart.mjs', 'answercheck.mjs', 'closingreport.mjs']
    .some((n) => fs.existsSync(path.join(root, 'src', n)));
}

function writeFileAtomic(file, text) {
  // The directory holds only this file; private to the user, like the file itself.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, text, { mode: 0o600 });
}

/**
 * Sets (`on`) or clears the switch for one memory. Other memories' lines stay.
 * Refuses to rewrite a file it cannot read (state `broken`): replacing it would
 * drop lines it never saw.
 */
export function setTrusted(root, on, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const file = switchFile(opts);
  const sw = readSwitch(file);
  if (sw.state === 'broken') throw new Error(`cannot read ${file}: ${sw.error}`);
  const mine = rootKeys(root, platform);
  if (!mine.length) throw new Error(`cannot resolve ${root}`);
  // The file is one path per line. A path with a line break in it would be written as two lines - two
  // different "paths", neither of them this memory - so it is refused instead.
  if (mine.some((k) => /[\r\n]/.test(k))) throw new Error('the path of the memory contains a line break; it cannot be written to the switch file');
  const kept = sw.keys.filter((k) => !mine.includes(k));
  const next = on ? [...kept, ...mine] : kept;
  const changed = on ? mine.some((k) => !sw.keys.includes(k)) : kept.length !== sw.keys.length;
  if (changed) writeFileAtomic(file, `${HEADER.join('\n')}\n${next.join('\n')}${next.length ? '\n' : ''}`);
  return { file, keys: mine, changed };
}

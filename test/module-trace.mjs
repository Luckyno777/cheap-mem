// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Test helper (not a test): which modules does a CLI process load?
//
// A module hook (`node:module` register, as test/hookcost-cm.test.mjs uses)
// appends every `file:` URL the process loads to a log file. Structural,
// not timed: a count of imports does not wobble under load the way a
// stopwatch does. URLs always use `/`, so the matching is the same on
// Windows. No /tmp and no POSIX tool: the log lives in the caller's own
// temp directory.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const LOADER = `data:text/javascript,${encodeURIComponent(`
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(\`
import fs from 'node:fs';
export async function load(url, ctx, next) {
  if (process.env.MODULE_TRACE_LOG && url.startsWith('file:')) fs.appendFileSync(process.env.MODULE_TRACE_LOG, url + '\\\\n');
  return next(url, ctx);
}\`));
`)}`;

export const GROUPS = ['write', 'search', 'capture', 'agents', 'setup', 'admin'];

/**
 * Run `<bin> <args...>` and return what it loaded.
 * @returns {{ loaded: string[]|null, groups: string[], status: number|null, stdout: string, stderr: string }}
 *   `loaded` is null when the hook wrote nothing at all (a hook that did not run
 *   must not read as "nothing was loaded").
 */
export function traceRun(bin, args, { root, logDir } = {}) {
  const log = path.join(logDir, `trace-${process.pid}-${Math.random().toString(36).slice(2)}.txt`);
  const env = { ...process.env, MODULE_TRACE_LOG: log };
  if (root) env.CHEAP_MEM_ROOT = root;
  const r = spawnSync(process.execPath, ['--import', LOADER, bin, ...args], { encoding: 'utf8', env, input: '' });
  const loaded = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : null;
  const groups = (loaded ?? []).map((u) => u.match(/\/src\/cli\/commands\/([a-z]+)\.mjs$/)?.[1]).filter(Boolean);
  return { loaded, groups, status: r.status, stdout: r.stdout, stderr: r.stderr };
}

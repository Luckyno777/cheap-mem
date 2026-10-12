// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * appendonly.mjs - the ONE rule "a log only grows at its end", for the git
 * hook (AU11) and for the doctor finding `append-only-git`.
 *
 * **The rule.** The committed (HEAD) text of a log must be a byte PREFIX of the
 * new text. Anything else changed or removed a line that git already holds.
 * Line endings are not an edit (`core.autocrlf` on a Windows checkout turns the
 * blob's LF into CRLF on disk), so both sides are compared with `\r\n` folded to
 * `\n`.
 *
 * **Which files.** Logs of the memory, not every `.jsonl` in the tree:
 * `global/*.jsonl` and `projects/<name>/*.jsonl` (the drawers and the alias and
 * category tables beside them) and the root logs `raw-record.jsonl`,
 * `digested.jsonl`. This list is why the hook needs no list of EXCEPTIONS: the
 * tool's own tables and measurements (`shared/`, `eval/`, `bench/`, `test/`) are
 * not on it, because their lines are rewritten on purpose.
 *
 * **A deliberate change** (a real redaction, an entry moved to another drawer)
 * goes through with `CHEAP_MEM_JSONL_APPROVAL="<reason, approval id>"`: the hook
 * lets that ONE commit pass and names reason and files on stderr. Without it the
 * commit is refused with a rescue path (hooks/pre-commit).
 */

import { execFileSync } from 'node:child_process';

/** Environment variable that lets one commit change committed log lines. */
export const APPROVAL_ENV = 'CHEAP_MEM_JSONL_APPROVAL';

const MEMORY_LOGS = [
  /^global\/[^/]+\.jsonl$/,
  /^projects\/[^/]+\/[^/]+\.jsonl$/,
  /^(?:raw-record|digested)\.jsonl$/,
];

/** Is this repo-relative path one of the memory's append-only logs? */
export function isMemoryLog(rel) {
  return MEMORY_LOGS.some((re) => re.test(String(rel)));
}

const lf = (s) => String(s).replace(/\r\n/g, '\n');

/**
 * `committed` against `current`: `{ ok: true }` when `committed` is a prefix of
 * `current`, else `{ ok: false, line }` with the 1-based number of the first
 * line that no longer matches (what an editor shows).
 */
export function onlyAppended(committed, current) {
  const a = lf(committed);
  const b = lf(current);
  if (b.startsWith(a)) return { ok: true };
  const oldLines = a.split('\n');
  const newLines = b.split('\n');
  let line = 1;
  while (line <= oldLines.length && newLines[line - 1] === oldLines[line - 1]) line += 1;
  return { ok: false, line };
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * What the next commit (the INDEX, not the working tree) does to the memory's
 * logs: `[{ rel, kind: 'changed'|'deleted'|'unreadable', line?, committedLines }]`.
 * New files are not findings; `unreadable` (git could not hand over a version)
 * is reported, never waved through.
 */
export function stagedViolations(root) {
  const raw = git(root, ['diff', '--cached', '--name-status', '--no-renames', '--diff-filter=MD', '-z']);
  const parts = raw.split('\0').filter((p) => p !== '');
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const rel = parts[i + 1];
    if (!isMemoryLog(rel)) continue;
    let committed;
    try { committed = git(root, ['show', `HEAD:${rel}`]); } catch { out.push({ rel, kind: 'unreadable', committedLines: 0 }); continue; }
    const committedLines = lf(committed).split('\n').filter((l) => l !== '').length;
    if (status === 'D') { out.push({ rel, kind: 'deleted', committedLines }); continue; }
    let staged;
    try { staged = git(root, ['show', `:${rel}`]); } catch { out.push({ rel, kind: 'unreadable', committedLines }); continue; }
    const v = onlyAppended(committed, staged);
    if (!v.ok) out.push({ rel, kind: 'changed', line: v.line, committedLines });
  }
  return out;
}

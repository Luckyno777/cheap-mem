// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// src/posixmode.mjs — what a file mode may be claimed to say, and where it may not.
//
// POSIX mode bits (0600, 0700) exist on Linux and macOS. On Windows `stat`
// returns 0666 for a file and 0777 for a directory whatever was asked at
// creation, and `chmod` only toggles the read-only flag. Reading those
// numbers as "open to everyone" would be false; reading 0600 back would be
// impossible, and saying "0600 ok" there would be a claim nobody checked.
// So every place that reports on modes asks here first and says
// "not checkable on this platform" instead of a verdict (docs/dashboard.md
// says the same for the stores).
//
// `platform` is a parameter everywhere so the Windows answer can be driven
// on Linux; the default is the real one.
import fs from 'node:fs';

/** The words the product uses wherever it cannot judge a mode. */
export const NOT_CHECKABLE = 'not checkable on this platform';

/** Do POSIX mode bits mean anything on this platform? */
export function modesCheckable(platform = process.platform) {
  return platform !== 'win32';
}

/**
 * Does `mode` give no rights to group and others?
 * true / false, or null when the platform cannot say (never a guess).
 */
export function isPrivate(mode, platform = process.platform) {
  if (!modesCheckable(platform)) return null;
  return (mode & 0o077) === 0;
}

/**
 * The state of one file: 'private', 'open', 'not-checkable' or 'missing'.
 * On Windows a file that is there is always 'not-checkable': the answer
 * never depends on the numbers stat returns there.
 */
export function fileState(file, platform = process.platform) {
  let st;
  try { st = fs.statSync(file); } catch { return 'missing'; }
  const p = isPrivate(st.mode, platform);
  if (p === null) return 'not-checkable';
  return p ? 'private' : 'open';
}

/**
 * One line for the user about a set of states (fileState values), or null
 * when there is nothing to say. `what` names the files, e.g. "the file".
 */
export function note(states, what, wanted = '0600') {
  const list = [].concat(states);
  if (list.includes('open')) return `WARNING: ${what} readable by group/others (should be ${wanted}).`;
  if (list.includes('not-checkable')) return `NOTE: the mode of ${what} (${wanted} on POSIX) is ${NOT_CHECKABLE}.`;
  return null;
}

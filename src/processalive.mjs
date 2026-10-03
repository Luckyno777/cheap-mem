// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * processalive — does a process really live? (port of lucky-mem `prozess.mjs`,
 * 2026-10-03)
 *
 * `process.kill(pid, 0)` also succeeds for a ZOMBIE (`<defunct>`): ended, but
 * not collected by its parent. In the sibling house such a zombie held a
 * night run's lock for eleven hours ("already running") and made a resume
 * path take an old build for a running one. On Linux the state in
 * `/proc/<pid>/stat` therefore counts: `Z` (zombie) and `X` (dead) do not
 * live. Without `/proc` (other systems) the signal alone decides.
 */
import fs from 'node:fs';

/** `true` if `pid` is a living process: signalable and not a zombie. */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return true; }
  const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
  return state !== 'Z' && state !== 'X';
}

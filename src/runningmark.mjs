// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * runningmark.mjs — W1 parity: every long-running cheap-mem service
 * writes a marker, at start, of which code it is actually executing.
 *
 * Ported from the sibling house's `src/laufmarke.mjs` (Bauplan Block W,
 * W1). The problem is the same one: `mem serve` (and, in `--http` mode,
 * `mem-mcp`) can keep running for days out of a code checkout that a
 * person keeps pulling/installing over, without the running process
 * noticing — it just quietly answers with OLD code. Nothing external
 * (`ps`, a port scan) can tell which commit a live process holds in
 * memory; only the process itself can say so, once, when it starts.
 *
 * **Where the marker lives.** `.pipeline/running/<service>.json`, under
 * the MEMORY root — the same neighbourhood as `injection.mjs`'s own
 * `.pipeline/injections.jsonl`: runtime state describing what a process
 * on THIS machine is doing, not tracked repo content. This deliberately
 * mirrors the sibling's choice to key markers by memory root even
 * though a marker DESCRIBES a different directory (`code_path` — the
 * cheap-mem package install, which need not be the memory root at all):
 * `doctor.mjs` already reads everything else about "this machine, this
 * memory" from `root/.pipeline/`, and a marker is exactly one more such
 * fact.
 *
 * **Where the commit comes from.** `codePath` is normally a git
 * checkout (`git -C codePath rev-parse HEAD`). `src/release.mjs`'s
 * frozen release copies (`git archive`, no `.git/`) carry the same
 * commit instead in `.release-meta.json` — read here as a fallback,
 * same two-tier lookup as the sibling's `ermittleCommit()`. Neither
 * readable -> `commit: null` with a `reason`, never a guess (house rule
 * "not measured is not null").
 *
 * **Atomic.** Written to a temp file in the same directory, then
 * `fs.renameSync` over the real name — a reader (doctor's
 * `checkRunningCode`) never sees a half-written marker.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Where all service markers live, relative to the memory root. */
export const MARKER_DIR = path.join('.pipeline', 'running');

/** Where ONE service's marker lives. */
export function markerPath(root, service) {
  return path.join(root, MARKER_DIR, `${service}.json`);
}

/**
 * Which commit is `codePath` actually running? `{ commit, reason }` —
 * `commit` is a string or `null`; `reason` is set only when `commit`
 * is `null` (why — for the doctor finding to explain to a person).
 */
export function commitOf(codePath) {
  try {
    const out = execFileSync('git', ['-C', codePath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return { commit: out, reason: null };
  } catch { /* no .git here — a release copy, or a broken checkout, see below */ }

  try {
    const meta = JSON.parse(fs.readFileSync(path.join(codePath, '.release-meta.json'), 'utf8'));
    if (typeof meta.commit === 'string' && meta.commit) return { commit: meta.commit, reason: null };
    return { commit: null, reason: '.release-meta.json has no commit field' };
  } catch { /* neither git nor a release meta file is readable */ }

  return {
    commit: null,
    reason: `neither 'git -C ${codePath} rev-parse HEAD' nor ${path.join(codePath, '.release-meta.json')} is readable`,
  };
}

/**
 * Write the start marker for `service`, atomically. `wurzel`-equivalent
 * naming kept English: `root` is WHERE the marker is written (the
 * memory root, always); `codePath` is WHICH code the marker describes
 * (default: `root`, for the rare case both coincide).
 */
export function writeMarker(root, { service, codePath = root, pid = process.pid, now = new Date() } = {}) {
  if (!service) throw new Error('runningmark: service is required');
  const { commit, reason } = commitOf(codePath);
  const marker = {
    service, commit, code_path: codePath, start: now.toISOString(), pid,
  };
  if (commit === null) marker.reason = reason;

  const target = markerPath(root, service);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return marker;
}

/** Read one service's marker — `null` if missing or unreadable. */
export function readMarker(root, service) {
  try {
    const content = JSON.parse(fs.readFileSync(markerPath(root, service), 'utf8'));
    if (content && typeof content === 'object' && typeof content.service === 'string') return content;
    return null;
  } catch {
    return null;
  }
}

#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * mem-recall-server.mjs — the warm recall server as its own process (M10).
 *
 * `mem serve` starts it as a CHILD under src/recallserver-keeper.mjs: when
 * code under `src/` changes, the server answers `stale`, removes its socket
 * and key, and exits with STALE_RC (75); the keeper starts a new one with a
 * fresh import (at most once per 60 s). A restart INSIDE one process is not
 * possible — ESM loads each module once per process.
 *
 * By hand (a machine without `mem serve`, probes, measurements):
 *
 *   CHEAP_MEM_ROOT=/path node bin/mem-recall-server.mjs
 *
 * MEM_RECALL_SERVER_CODE_STATE (probes only): which directory (its `src/`)
 * is watched as the code state; default this package.
 */
import path from 'node:path';
import * as recallserver from '../src/recallserver.mjs';

const root = path.resolve(process.env.CHEAP_MEM_ROOT || process.cwd());
const codeRoot = process.env.MEM_RECALL_SERVER_CODE_STATE
  ? path.resolve(process.env.MEM_RECALL_SERVER_CODE_STATE) : undefined;
const s = await recallserver.start(root, {
  ...(codeRoot ? { codeRoot } : {}),
  onStale: () => process.exit(recallserver.STALE_RC),
});
if (!s.running) process.exit(s.reason === 'busy' ? recallserver.BUSY_RC : 1);
const stop = () => { s.close().then(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// Under a keeper: stop when the parent is gone (SIGKILL leaves no chance to
// tell the child). By hand (no MEM_RECALL_SERVER_PARENT) nothing changes.
const parent = Number(process.env.MEM_RECALL_SERVER_PARENT);
if (parent > 0) {
  setInterval(() => { if (recallserver.parentGone(parent)) stop(); }, 1000).unref();
}

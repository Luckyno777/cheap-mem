#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * mem-retrieve-client.mjs — asks the warm recall server (M10).
 *
 *   node bin/mem-retrieve-client.mjs <root> <query> <top>
 *
 * Called by bin/mem-retrieve only when a server socket is there. Prints
 * the server's `mem find --json` output EXACTLY as the direct `mem find`
 * would, or nothing. Loads Node built-ins only (through
 * src/recallserver-place.mjs) — the point of the server is that the
 * search path is NOT loaded here.
 *
 * Exit codes: recallserver-place CLIENT_RC. On anything but 0 nothing
 * was written to stdout; the hook then falls back to the direct path
 * with what is left of its time budget.
 *
 * Wait: MEM_RECALL_SERVER_WAIT_MS (default 2500), capped to what is left
 * of the budget MEM_RETRIEVE_TIME (default 5 s, counted from
 * MEM_HOOK_START_MS) minus a reserve for the direct fallback. One
 * budget, not two.
 */
import fs from 'node:fs';
import net from 'node:net';
import * as place from '../src/recallserver-place.mjs';

const RC = place.CLIENT_RC;
const env = process.env;
const [root, query, top] = process.argv.slice(2);
if (!root) process.exit(RC.NO_SERVER);

const start = Number(env.MEM_HOOK_START_MS);
const startMs = Number.isFinite(start) && start > 0 ? start : Date.now();
const budgetMs = (Number(env.MEM_RETRIEVE_TIME) > 0 ? Number(env.MEM_RETRIEVE_TIME) : 5) * 1000;
const RESERVE_MS = 1500;
const wish = Number(env.MEM_RECALL_SERVER_WAIT_MS) > 0 ? Number(env.MEM_RECALL_SERVER_WAIT_MS) : 2500;
const left = budgetMs - (Date.now() - startMs) - RESERVE_MS;
const waitMs = Math.max(50, Math.min(wish, left));

const where = place.place(root, env);
let key;
try { key = fs.readFileSync(where.key, 'utf8').trim(); } catch { process.exit(RC.NO_SERVER); }

const request = `${JSON.stringify({ v: place.VERSION, key, root, query: query ?? '', top: top ?? null })}\n`;

let finished = false;
const end = (rc, text = null) => {
  if (finished) return;
  finished = true;
  clearTimeout(clock);
  sock.destroy();
  if (text) process.stdout.write(text, () => process.exit(rc));
  else process.exit(rc);
};

const sock = net.connect(where.socket);
const clock = setTimeout(() => end(RC.TIMEOUT), waitMs);
let reply = '';
sock.setEncoding('utf8');
sock.on('connect', () => sock.write(request));
sock.on('data', (s) => { reply += s; if (reply.length > place.MAX_BYTES) end(RC.ERROR); });
sock.on('error', (e) => {
  const none = ['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK'].includes(e?.code);
  end(none ? RC.NO_SERVER : RC.ERROR);
});
sock.on('end', () => {
  let a = null;
  try { a = JSON.parse(reply.trim()); } catch { end(RC.ERROR); return; }
  if (!a || a.v !== place.VERSION) { end(RC.ERROR); return; }
  if (a.ok) { end(RC.OK, typeof a.stdout === 'string' && a.stdout ? a.stdout : null); return; }
  if (a.reason === 'stale') { end(RC.STALE); return; }
  if (a.reason === 'refused') { end(RC.REFUSED); return; }
  end(RC.ERROR);
});

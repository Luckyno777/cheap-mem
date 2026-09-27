// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// writegate.mjs — the one switch in front of every writing path of the
// dashboard server (`bin/mem-serve`).
//
// **Off unless someone turned it on.** An open-source dashboard writes
// nothing before its owner allows it. Until 2026-09-27 the server was
// writable by default (`/setting`, then `/task` and `/task/cancel`),
// guarded only by the bind rule, the SameSite cookie, the Host check
// and the Origin check. Those latches stay — this switch sits IN FRONT
// of them, it does not replace them.
//
// **One place of truth, two ways to say "yes":**
//
//   - `.mem/config.json` → `"dashboard": { "allowWrites": true }`
//     (permanent, for this memory);
//   - `mem serve --allow-writes` (this one run only, never written down).
//
// Nothing else turns it on. In particular the dashboard itself cannot:
// `/setting` accepts only the closed list in `src/console.mjs`
// (`SETTINGS`), none of which touches `.mem/config.json`, and the flag
// lives in the process, not on disk. A switch the thing it guards can
// flip would be decoration.
//
// **Four states, never two.** `on`, `off`, `unknown` (the key holds
// something that is neither true nor false) and `error` (the config
// file exists but cannot be read). Only `on` lets a write through, but
// the page and the refusal SAY which of the other three it is: a config
// that could not be read is not the same as a switch that is off, and
// printing "off" for it would hide the broken file.
//
// **One check, not one per route.** `refusal()` is the single function
// every writing route calls — `/setting`, `/task`, `/task/cancel` today,
// and any new writing route (P1b: replies from the inbox) tomorrow. A
// route that copies the latches instead of calling it is the way the
// next route ships without one.

import fs from 'node:fs';
import * as config from './config.mjs';
import * as webauth from './webauth.mjs';

/** The config key, as a person would write it in `.mem/config.json`. */
export const CONFIG_KEY = 'dashboard.allowWrites';

/** The one-run flag of `mem serve`. */
export const FLAG = '--allow-writes';

/** How to turn it on — the same words on the page and in every 403. */
export const HOW_TO = `Turn it on for one run with \`mem serve ${FLAG}\`, `
  + 'or for this memory with "dashboard": { "allowWrites": true } in .mem/config.json.';

/**
 * Read the switch.
 *
 * @param root  the memory root (where `.mem/config.json` lives)
 * @param opts.flag      true when the server was started with `--allow-writes`
 * @param opts.readonly  true under CHEAP_MEM_SERVE_READONLY=1 — the older,
 *   stricter latch; it still wins over everything
 * @returns {{state:'on'|'off'|'unknown'|'error', allowed:boolean,
 *   source:string, reason:string}}
 */
export function read(root, { flag = false, readonly = false } = {}) {
  if (readonly) {
    return { state: 'off', allowed: false, source: 'readonly',
      reason: 'The server runs read-only (CHEAP_MEM_SERVE_READONLY=1); that latch wins over '
        + `${CONFIG_KEY} and ${FLAG}.` };
  }
  if (flag === true) {
    return { state: 'on', allowed: true, source: 'flag',
      reason: `Writing is on for this run (${FLAG}).` };
  }
  const file = config.configPath(root);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') {
      return { state: 'off', allowed: false, source: 'default',
        reason: 'Writing from the dashboard is off (the default; no .mem/config.json).' };
    }
    return { state: 'error', allowed: false, source: 'config',
      reason: `.mem/config.json could not be read (${e?.message || e}); writing stays off.` };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { state: 'error', allowed: false, source: 'config',
      reason: `.mem/config.json is not valid JSON (${e.message}); writing stays off.` };
  }
  const section = parsed && typeof parsed === 'object' ? parsed.dashboard : undefined;
  const value = section && typeof section === 'object' ? section.allowWrites : undefined;
  if (value === undefined) {
    return { state: 'off', allowed: false, source: 'default',
      reason: `Writing from the dashboard is off (the default; ${CONFIG_KEY} is not set).` };
  }
  if (value === true) {
    return { state: 'on', allowed: true, source: 'config',
      reason: `Writing is on (${CONFIG_KEY} is true in .mem/config.json).` };
  }
  if (value === false) {
    return { state: 'off', allowed: false, source: 'config',
      reason: `Writing from the dashboard is off (${CONFIG_KEY} is false in .mem/config.json).` };
  }
  return { state: 'unknown', allowed: false, source: 'config',
    reason: `${CONFIG_KEY} is ${JSON.stringify(value)} — neither true nor false, so it is not `
      + 'read as a yes; writing stays off.' };
}

/**
 * The single check every writing route runs before it reads a body.
 *
 * @param root the memory root
 * @param cfg  the server config (`readConfig()` in bin/mem-serve plus
 *   `allowWrites` from the one-run flag)
 * @param req  the incoming request (Host and Origin are read from it)
 * @returns null when the write may proceed, else `{ code, text, gate }`
 */
export function refusal(root, cfg, req) {
  const gate = read(root, { flag: cfg.allowWrites === true, readonly: cfg.readonly === true });
  if (!gate.allowed) {
    const text = gate.source === 'readonly'
      ? 'Writing is off (CHEAP_MEM_SERVE_READONLY=1).'
      : `${gate.reason} ${HOW_TO}`;
    return { code: 403, text, gate };
  }
  // Host first: Origin-against-Host is a same-origin check and trusts
  // the Host. Under DNS rebinding both carry the attacker's name and
  // match. Only the name we agree to be reachable under separates them.
  if (!webauth.hostAllowed(req.headers.host, cfg.hosts)) {
    return { code: 403, text: 'Foreign or missing host.', gate };
  }
  if (!webauth.postOriginOk(req.headers.origin, req.headers.host, cfg.origins)) {
    return { code: 403, text: 'Foreign or missing origin.', gate };
  }
  return null;
}

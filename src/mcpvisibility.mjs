// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// mcpvisibility.mjs — which MCP client saw or called which tool, and when?
//
// **The gap this closes.** "Operations -> MCP tools" showed "client
// visible: unknown" for every tool — not because nobody was connected,
// but because nobody wrote it down. `bin/mem-mcp` knows the client
// (`clientInfo.name` from the MCP `initialize` handshake) from the
// moment it connects, but nothing kept a running record of what that
// client was actually shown or actually called.
//
// **What this holds, and what it never will.** Only the tool name, the
// client name, the time, and whether it was a `tools/list` (the client
// was shown the tool) or a `tools/call` (the client invoked it) —
// never arguments, never a result. Same boundary as the rest of this
// house's liveness signals: a visibility line is a signal that
// something happened, never a transcript of what was said.
//
// **Append-only, one line per (tool, client) sighting — no throttle.**
// A `tools/list` answer names every visible tool at once, so a single
// connection already produces one line per tool; that is the expected
// shape, not something to collapse. Throttling per tool (as the
// liveness heartbeat does per agent) would make a rarely-used tool show
// the LAST call of a frequently-used one instead of its own.
//
// **Machine-local, not repository truth (2026-09-28).** Which client
// this MACHINE has seen belongs to the container the bridge runs in,
// not to the memory's committed history — and `.pipeline/` is already
// this house's gitignored, per-clone runtime-state directory (see
// .gitignore: "Runtime state of ONE clone... must never travel").
// Putting the log anywhere under a tracked path risks exactly what the
// sibling memory measured on 2026-09-28: a full test run against the
// repository root left an unversioned file with real lines in a
// clean checkout.
//
// invariant: no-content-only-name-client-time
import fs from 'node:fs';
import path from 'node:path';
import { appendLine } from './append.mjs';

/** Machine-local, gitignored (`.pipeline/` — see .gitignore). */
export const LOG = path.join('.pipeline', 'mcp-visibility.jsonl');

const filePath = (root) => path.join(root, LOG);

/** `'tools/list'` or `'tools/call'`. Closed list, same discipline as `injection.OCCASION`. */
export const METHOD = Object.freeze({
  LIST: 'tools/list',
  CALL: 'tools/call',
});

/**
 * Append one sighting. Without a client OR a tool name, nothing is
 * written — an empty/unknown client would be an invented observation,
 * not a measured one.
 */
export function record(root, { method, tool, client, now = new Date() } = {}) {
  const c = String(client ?? '').trim();
  const t = String(tool ?? '').trim();
  if (!c) return { written: false, reason: 'no client (clientInfo.name is missing)' };
  if (!t) return { written: false, reason: 'no tool name' };
  const m = method === METHOD.CALL ? METHOD.CALL : METHOD.LIST;
  const row = { ts: new Date(now).toISOString(), method: m, tool: t, client: c };
  try {
    fs.mkdirSync(path.dirname(filePath(root)), { recursive: true });
    appendLine(filePath(root), `${JSON.stringify(row)}\n`);
    return { written: true };
  } catch (e) {
    // A log that cannot be written must never block a tool call — the
    // caller wraps this in its own try/catch too, but this one never
    // throws on its own.
    return { written: false, reason: e?.message || String(e) };
  }
}

/** Every row, oldest first. Broken lines are counted, never swallowed. */
export function read(root) {
  let raw;
  try { raw = fs.readFileSync(filePath(root), 'utf8'); } catch { return { rows: [], broken: 0 }; }
  const rows = [];
  let broken = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === 'object' && e.tool && e.client && e.ts) rows.push(e);
      else broken += 1;
    } catch { broken += 1; }
  }
  return { rows, broken };
}

/** The newest sighting per tool: `Map<tool, {ts, method, client}>`. */
export function latestPerTool(root) {
  const map = new Map();
  for (const e of read(root).rows) {
    const prior = map.get(e.tool);
    if (!prior || String(e.ts) > String(prior.ts)) map.set(e.tool, e);
  }
  return map;
}

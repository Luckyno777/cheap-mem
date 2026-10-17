// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/bridge-client.mjs — a real stdio client against bin/mem-mcp, for
// the atlas phases that ask what a connected foreign agent can and cannot do.
//
// **Why a real client.** The security ports (A1, A6, A12, V1, V2) were each
// proved by a test that spawns `bin/mem-mcp` and writes JSON-RPC lines into
// it. This client is the same door with the SDK's own transport, one process
// for many calls, so a phase can ask a hundred questions in a second and ask
// them the way an agent's client would: handshake first, then `tools/call`.
//
// **What a call returns.** `{ isError, text, structured }`. A refusal comes
// back as `isError: true` with the message in `text`; a JSON-RPC error (an
// unknown tool, a schema violation the SDK rejects) is caught and returned
// the same way, so a phase counts refusals without caring which layer said
// no. A call that gets no answer within `HANG_GUARD_MS` is returned as
// `{ hung: true }`: the limit is a guard against a stall, never a measurement.
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { REPO } from './core.mjs';

const MCP = path.join(REPO, 'bin', 'mem-mcp');
const HANG_GUARD_MS = 120000;

/** The participants of the throwaway memory the bridge phases use. */
const PARTICIPANTS = Object.freeze({ user: { human: true }, foreign: 'agent', librarian: 'agent' });

/** Write the config of a bridge root: three participants, one of them the human. */
export function writeBridgeConfig(root) {
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({
    version: 1, name: 'atlas-bridge', participants: PARTICIPANTS, language: 'en', timezone: 'Europe/Berlin',
  }));
}

/** The environment of the bridge process: the minimum it needs, the root, the identity it connects as. */
function bridgeEnv(root, extra) {
  const env = { CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', CHEAP_MEM_MCP_READONLY: '0', MEM_HEADLESS: '' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'SystemRoot', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

const textOfResult = (r) => (r?.content ?? []).map((c) => c.text ?? '').join('\n');

/**
 * Connect to a fresh `bin/mem-mcp` that serves `root`.
 * `tree` is the code tree whose `bin/mem-mcp` is started (default: this repository). A phase group takes it as a
 * parameter so the same measurement can be pointed at a scratch copy with one guarantee removed (test/atlas-gaps-cm.test.mjs).
 * @returns {Promise<{ call: Function, tools: Function, close: Function }>}
 */
export async function openBridge(root, { env = {}, tree = REPO } = {}) {
  const mcp = tree === REPO ? MCP : path.join(tree, 'bin', 'mem-mcp');
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], env: bridgeEnv(root, env), stderr: 'pipe' });
  const client = new Client({ name: 'atlas-probe', version: '1' });
  await client.connect(transport);
  return {
    async call(name, args = {}) {
      try {
        const r = await client.callTool({ name, arguments: args }, undefined, { timeout: HANG_GUARD_MS });
        return { isError: r.isError === true, text: textOfResult(r), structured: r.structuredContent ?? null, hung: false };
      } catch (e) {
        const hung = /timed out|timeout/i.test(String(e?.message));
        return { isError: true, text: String(e?.message ?? e), structured: null, hung };
      }
    },
    async tools() {
      const r = await client.listTools();
      return (r.tools ?? []).map((t) => t.name);
    },
    async close() { try { await client.close(); } catch { /* the child is going away anyway */ } },
  };
}

/** The JSON payload of an answer: the structured part when there is one, else the text if it parses. */
export function payloadOf(res) {
  if (res.structured && typeof res.structured === 'object') return res.structured;
  try { return JSON.parse(res.text); } catch { return null; }
}

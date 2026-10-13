// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * ollama — local Ollama embeddings. The only embedding adapter.
 *
 * Default: nomic-embed-text (768 dim). Free, local, no key, no data
 * leaving the machine.
 *
 * Endpoint: OLLAMA_HOST, or http://localhost:11434. **It must be a
 * loopback address** (see ./loopback.mjs). A remote host is refused
 * before any socket is opened: with an Ollama on another machine the
 * entry text would cross a network, which is exactly what is switched off
 * for embeddings (owner decision 2026-10-13).
 *
 * Why `http.request` and not `fetch`: the connection goes to the
 * address the check approved, with a private agent (so a proxy
 * environment cannot reroute it) and no redirect following (so a local
 * server cannot bounce the text elsewhere).
 *
 * Setup: ollama pull nomic-embed-text
 */

import http from 'node:http';
import { checkEndpoint } from './loopback.mjs';

export function name() { return 'ollama'; }

const DEFAULT_ENDPOINT = 'http://localhost:11434';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** The configured endpoint, as text (OLLAMA_HOST or the default). */
export function configuredEndpoint(env = process.env) {
  return env.OLLAMA_HOST || DEFAULT_ENDPOINT;
}

function post(target, body, signal) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const agent = new http.Agent({ keepAlive: false });
    const req = http.request({
      host: target.address,
      port: target.port,
      method: 'POST',
      path: '/api/embeddings',
      agent,
      signal: signal ?? undefined,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) { req.destroy(new Error('response too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        agent.destroy();
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', reject);
    });
    req.on('error', (e) => { agent.destroy(); reject(e); });
    req.end(payload);
  });
}

export async function embed(text, { model = 'nomic-embed-text', signal = null } = {}) {
  const wanted = configuredEndpoint();
  const target = await checkEndpoint(wanted);
  if (!target.ok) {
    const err = new Error(
      `ollama: host '${target.host}' refused (${target.reason}). `
      + 'external embedding providers are disabled: no entry text leaves this machine; using lexical search');
    err.code = 'EXTERNAL_DISABLED';
    throw err;
  }
  let res;
  try {
    res = await post(target, { model, prompt: text }, signal);
  } catch (e) {
    // Bare `fetch failed` tells a user nothing. Name the endpoint and
    // the two things that are actually wrong nine times out of ten.
    if (e.name === 'AbortError') throw e;
    const err = new Error(
      `ollama: cannot reach ${target.host} (${e.message}).\n`
      + '  Is ollama running?      ollama serve\n'
      + `  Is the model pulled?    ollama pull ${model}\n`
      + '  Different port?         set OLLAMA_HOST (loopback addresses only)');
    err.code = 'NO_SERVICE';
    throw err;
  }
  if (res.status < 200 || res.status >= 300) {
    // mask-ok: the reply of the LOOPBACK Ollama server, and src/embed/ may import nothing but its own helpers (the
    // local-only rail, test/embed-local-only.test.mjs); the error reaches the user through a guarded out()
    throw new Error(
      `ollama HTTP ${res.status}: ${res.text.slice(0, 200)}\n`
      + `Is ollama running? Is '${model}' pulled (ollama pull ${model})?`);
  }
  let data;
  try { data = JSON.parse(res.text); }
  catch { throw new Error('ollama: the reply was not JSON'); }
  const vec = data?.embedding;
  if (!Array.isArray(vec)) throw new Error('ollama: unexpected response shape (no .embedding)');
  return new Float32Array(vec);
}

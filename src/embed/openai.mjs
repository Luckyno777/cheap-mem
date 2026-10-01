// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * openai — OpenAI embeddings.
 *
 * Default: text-embedding-3-small (1536 dim).
 * Auth: OPENAI_API_KEY, or .mem/embed.env with OPENAI_API_KEY=...
 */

import fs from 'node:fs';
import path from 'node:path';

export function name() { return 'openai'; }

function apiKey(root = null) {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  // Relative to the memory ROOT, not the caller's working directory: a hook
  // running elsewhere never found the key (audit B#23).
  const local = path.resolve(root ?? process.cwd(), '.mem', 'embed.env');
  if (fs.existsSync(local)) {
    for (const line of fs.readFileSync(local, 'utf8').split('\n')) {
      const m = /^OPENAI_API_KEY\s*=\s*(.+)$/.exec(line.trim());
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  const e = new Error(
    'openai: no OPENAI_API_KEY. Set the env var or create .mem/embed.env '
    + 'with OPENAI_API_KEY=...');
  e.code = 'NO_KEY';
  throw e;
}

export async function embed(text, { model = 'text-embedding-3-small', signal = null, root = null } = {}) {
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey(root)}` },
      body: JSON.stringify({ input: text, model }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // A bare `fetch failed` is useless to whoever hits it.
    const err = new Error(
      `openai: cannot reach api.openai.com (${e.message}). No network, a proxy, or an outage.`);
    err.code = 'NO_SERVICE';
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '(no body)');
    throw new Error(`openai HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('openai: unexpected response shape (no data[0].embedding)');
  return new Float32Array(vec);
}

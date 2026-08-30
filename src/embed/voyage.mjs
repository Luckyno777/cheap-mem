/**
 * voyage — Voyage AI embeddings.
 *
 * Default: voyage-3-lite (512 dim). Cheap, and good at short text,
 * which is what a memory entry is.
 *
 * Auth: VOYAGE_API_KEY, or .mem/embed.env with VOYAGE_API_KEY=...
 */

import fs from 'node:fs';
import path from 'node:path';

export function name() { return 'voyage'; }

function apiKey() {
  if (process.env.VOYAGE_API_KEY) return process.env.VOYAGE_API_KEY;
  const local = path.resolve('.mem', 'embed.env');
  if (fs.existsSync(local)) {
    for (const line of fs.readFileSync(local, 'utf8').split('\n')) {
      const m = /^VOYAGE_API_KEY\s*=\s*(.+)$/.exec(line.trim());
      if (m) return m[1].replace(/^["']|["']$/g, '');
    }
  }
  // NO_KEY is not a defect, it is "not set up" — the normal state for
  // anyone who does not want embeddings. The caller uses this to stay
  // quiet instead of warning on every single write.
  const e = new Error(
    'voyage: no VOYAGE_API_KEY. Set the env var or create .mem/embed.env '
    + 'with VOYAGE_API_KEY=...');
  e.code = 'NO_KEY';
  throw e;
}

export async function embed(text, { model = 'voyage-3-lite', signal = null } = {}) {
  let res;
  try {
    res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({ input: [text], model, input_type: 'document' }),
      signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    // A bare `fetch failed` is useless to whoever hits it.
    const err = new Error(
      `voyage: cannot reach api.voyageai.com (${e.message}). No network, a proxy, or an outage.`);
    err.code = 'NO_SERVICE';
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '(no body)');
    throw new Error(`voyage HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error('voyage: unexpected response shape (no data[0].embedding)');
  return new Float32Array(vec);
}

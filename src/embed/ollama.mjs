/**
 * ollama — local Ollama embeddings.
 *
 * Default: nomic-embed-text (768 dim). Free, local, no key, no data
 * leaving the machine — the option to pick if the memory holds
 * anything you would not send to a vendor.
 *
 * Endpoint: OLLAMA_HOST, or http://localhost:11434
 * Setup: ollama pull nomic-embed-text
 */

export function name() { return 'ollama'; }

function endpoint() {
  return process.env.OLLAMA_HOST || 'http://localhost:11434';
}

export async function embed(text, { model = 'nomic-embed-text', signal = null } = {}) {
  let res;
  try {
    res = await fetch(`${endpoint()}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal,
    });
  } catch (e) {
    // Bare `fetch failed` tells a user nothing. Name the endpoint and
    // the two things that are actually wrong nine times out of ten.
    if (e.name === 'AbortError') throw e;
    const err = new Error(
      `ollama: cannot reach ${endpoint()} (${e.message}).\n`
      + '  Is ollama running?      ollama serve\n'
      + `  Is the model pulled?    ollama pull ${model}\n`
      + '  Different host?         set OLLAMA_HOST');
    err.code = 'NO_SERVICE';
    throw err;
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '(no body)');
    throw new Error(
      `ollama HTTP ${res.status}: ${txt.slice(0, 200)}\n`
      + `Is ollama running? Is '${model}' pulled (ollama pull ${model})?`);
  }
  const data = await res.json();
  const vec = data?.embedding;
  if (!Array.isArray(vec)) throw new Error('ollama: unexpected response shape (no .embedding)');
  return new Float32Array(vec);
}

/**
 * embed — dispatcher for embedding providers.
 *
 * **This is the escalation, not the default.** `mem find` works with no
 * key, no network and no cost, and it is what you should use. Reach for
 * embeddings only when you hit the case BM25 honestly cannot do: a true
 * paraphrase with no word in common — "the customer was unhappy" should
 * find "complaint received" and no thesaurus entry covers it.
 *
 * Three adapters:
 *   voyage  voyage-3-lite      512d   (default; cheap, good at short text)
 *   openai  text-embedding-3-small  1536d
 *   ollama  nomic-embed-text   768d   (local, free, no key)
 *
 * Config: `.mem/embed.json`, not versioned. Without it the dispatcher
 * falls back to voyage.
 *
 * **No import at module load.** Adapters load lazily so that a missing
 * provider fails only when actually used. The `mem log` path must never
 * lose a JSONL line over an embedding configuration problem.
 */

import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_PATH = path.join('.mem', 'embed.json');

export const DEFAULTS = Object.freeze({
  provider: 'voyage',
  model: null,       // adapter-specific default
  timeoutMs: 5000,
  onFail: 'warn',    // 'warn' | 'error'
});

const MODEL_DEFAULTS = Object.freeze({
  voyage: 'voyage-3-lite',
  openai: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
});

const ADAPTER_DIM = Object.freeze({
  'voyage:voyage-3-lite': 512,
  'voyage:voyage-3': 1024,
  'openai:text-embedding-3-small': 1536,
  'openai:text-embedding-3-large': 3072,
  'ollama:nomic-embed-text': 768,
});

export function readConfig(root) {
  const p = path.join(root, CONFIG_PATH);
  if (!fs.existsSync(p)) return { ...DEFAULTS, model: MODEL_DEFAULTS.voyage };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`embed config ${p} is not valid JSON: ${e.message}`); }
  const cfg = { ...DEFAULTS, ...raw };
  if (!Object.hasOwn(MODEL_DEFAULTS, cfg.provider)) {
    throw new Error(
      `embed: unknown provider '${cfg.provider}' (known: ${Object.keys(MODEL_DEFAULTS).join(', ')})`);
  }
  if (!cfg.model) cfg.model = MODEL_DEFAULTS[cfg.provider];
  return cfg;
}

export function writeConfig(root, cfg) {
  const p = path.join(root, CONFIG_PATH);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  return p;
}

/** Dimension for a provider+model. Throws when unknown. */
export function dimensions(provider, model) {
  const key = `${provider}:${model}`;
  const d = ADAPTER_DIM[key];
  if (!d) {
    throw new Error(
      `embed: unknown dimension for '${key}'. Known: ${Object.keys(ADAPTER_DIM).join(', ')}`);
  }
  return d;
}

export function knownProviders() { return Object.keys(MODEL_DEFAULTS); }

/**
 * Turn text into a vector.
 *
 * The dimension is checked against the config, because a provider that
 * silently returns a different size would corrupt the store in a way
 * that only shows up as bad results months later.
 */
export async function embed(root, text, { cfg = null, timeoutMs = null } = {}) {
  const c = cfg ?? readConfig(root);
  const t = timeoutMs ?? c.timeoutMs;
  const capped = text.length > 8000 ? text.slice(0, 8000) : text;

  const adapter = await loadAdapter(c.provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const vec = await adapter.embed(capped, { model: c.model, signal: controller.signal });
    if (!(vec instanceof Float32Array)) {
      throw new Error(`adapter '${c.provider}' did not return a Float32Array`);
    }
    const expected = dimensions(c.provider, c.model);
    if (vec.length !== expected) {
      throw new Error(
        `adapter '${c.provider}/${c.model}' returned dim=${vec.length}, expected ${expected}`);
    }
    return vec;
  } finally {
    clearTimeout(timer);
  }
}

async function loadAdapter(provider) {
  switch (provider) {
    case 'voyage': return import('./voyage.mjs');
    case 'openai': return import('./openai.mjs');
    case 'ollama': return import('./ollama.mjs');
    default: throw new Error(`unknown provider '${provider}'`);
  }
}

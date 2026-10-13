// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * embed — dispatcher for embedding providers. LOCAL ONLY.
 *
 * **This is the escalation, not the default.** `mem find` works with no
 * key, no network and no cost, and it is what you should use. Reach for
 * embeddings only when you hit the case BM25 honestly cannot do: a true
 * paraphrase with no word in common — "the customer was unhappy" should
 * find "complaint received" and no thesaurus entry covers it.
 *
 * One adapter:
 *   ollama  nomic-embed-text   768d   (a model on this machine, no key)
 *
 * **No entry text goes to an embedding vendor. Not masked, not
 * truncated, not behind a flag** (owner decision 2026-10-13). The Voyage
 * and OpenAI adapters are gone, and so is every other way to put a
 * remote host behind this dispatcher: the one adapter refuses any
 * endpoint that is not a loopback address (./loopback.mjs). A test
 * (test/embed-local-only.test.mjs) fails when a file in this directory
 * reaches for the network without being on its allowlist.
 *
 * Old configuration is RECOGNISED and refused, never ignored quietly:
 * a `.mem/embed.json` that names `voyage` or `openai` yields the state
 * `rejected`, and the search says so out loud and uses lexical search.
 * Vectors an external provider already wrote to `.mem/vectors.db` are
 * not deleted (they are the user's data) and not used.
 *
 * Config: `.mem/embed.json`, not versioned. Without it the state is
 * `not-configured`.
 *
 * **No import at module load.** The adapter loads lazily so that a
 * missing provider fails only when actually used. The `mem log` path
 * must never lose a JSONL line over an embedding configuration problem.
 */

import fs from 'node:fs';
import path from 'node:path';
import { checkEndpoint } from './loopback.mjs';

export const CONFIG_PATH = path.join('.mem', 'embed.json');

/** The providers that may run. A provider belongs here only if no entry text leaves the machine. */
export const LOCAL_PROVIDERS = Object.freeze(['ollama']);

/** Providers that existed and were removed (2026-10-13). Names only, so old configs can be recognised. */
export const REMOVED_PROVIDERS = Object.freeze({ voyage: 'Voyage AI', openai: 'OpenAI' });

/** What an embed.json without a `provider` meant before the removal. */
const LEGACY_DEFAULT_PROVIDER = 'voyage';

/** The sentence every refusal carries. Tests and docs quote it. */
export const EXTERNAL_DISABLED_MESSAGE =
  'external embedding providers are disabled: no entry text leaves this machine; using lexical search';

export const DEFAULTS = Object.freeze({
  provider: 'ollama',
  model: null,       // adapter-specific default
  timeoutMs: 5000,
  onFail: 'warn',    // 'warn' | 'error'
});

const MODEL_DEFAULTS = Object.freeze({
  ollama: 'nomic-embed-text',
});

const ADAPTER_DIM = Object.freeze({
  'ollama:nomic-embed-text': 768,
});

/**
 * Read `.mem/embed.json`. Returns null when there is none (not
 * configured). A provider that is not local is NOT an error here: it is
 * returned as written, and `embedState` turns it into a refusal.
 */
export function readConfig(root) {
  const p = path.join(root, CONFIG_PATH);
  if (!fs.existsSync(p)) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`embed config ${p} is not valid JSON: ${e.message}`); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`embed config ${p} is not a JSON object`);
  }
  const cfg = { ...DEFAULTS, ...raw };
  if (raw.provider === undefined || raw.provider === null) cfg.provider = LEGACY_DEFAULT_PROVIDER;
  if (!cfg.model && Object.hasOwn(MODEL_DEFAULTS, cfg.provider)) cfg.model = MODEL_DEFAULTS[cfg.provider];
  return cfg;
}

export function writeConfig(root, cfg) {
  if (!LOCAL_PROVIDERS.includes(cfg.provider)) {
    const err = new Error(`embed: provider '${cfg.provider}' is not allowed. ${EXTERNAL_DISABLED_MESSAGE}`);
    err.code = 'EXTERNAL_DISABLED';
    throw err;
  }
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

export function knownProviders() { return [...LOCAL_PROVIDERS]; }

/** Names (never values) of the removed key variables that are set in this process. */
export function removedKeyVarsSet(env = process.env) {
  // Presence only: the value is tested for being non-empty and goes
  // nowhere, not into a request, not into a message.
  const set = [];
  if (env.VOYAGE_API_KEY) set.push('VOYAGE_API_KEY');
  if (env.OPENAI_API_KEY) set.push('OPENAI_API_KEY');
  return set;
}

/** Does a `.mem/embed.env` exist? It used to hold the removed keys; nothing reads it any more. */
export function legacyEnvFilePresent(root) {
  return fs.existsSync(path.join(root, '.mem', 'embed.env'));
}

/**
 * Where the embedding of this memory stands. Three states, plus one for a
 * config that cannot even be read:
 *
 *   local           semantic search can run, on this machine
 *   not-configured  no `.mem/embed.json`: lexical search, nothing wrong
 *   rejected        configured for something that would send text out
 *                   (voyage, openai, any non-local provider, an ollama
 *                   host that is not loopback): refused, loudly
 *   broken          `.mem/embed.json` is unreadable
 *
 * `message` is the sentence to show a person; for `rejected` it always
 * carries EXTERNAL_DISABLED_MESSAGE.
 */
export async function embedState(root, { env = process.env, lookup = null } = {}) {
  let cfg;
  try { cfg = readConfig(root); }
  catch (e) {
    return { state: 'broken', cfg: null, provider: null, model: null, reason: 'config',
      message: `${e.message}; using lexical search` };
  }
  if (!cfg) {
    return { state: 'not-configured', cfg: null, provider: null, model: null, reason: 'no-config',
      message: 'semantic search is not configured (`mem embed setup --provider ollama` sets up a local one); using lexical search' };
  }
  const provider = String(cfg.provider);
  const model = cfg.model ?? null;
  if (!LOCAL_PROVIDERS.includes(provider)) {
    const removed = Object.hasOwn(REMOVED_PROVIDERS, provider);
    return { state: 'rejected', cfg, provider, model, reason: removed ? 'removed-provider' : 'non-local-provider',
      message: `${removed ? `provider '${provider}' (${REMOVED_PROVIDERS[provider]}) was removed` : `provider '${provider}' is not a local provider`}; ${EXTERNAL_DISABLED_MESSAGE}` };
  }
  const { configuredEndpoint } = await import('./ollama.mjs');
  const ep = await checkEndpoint(configuredEndpoint(env), { lookup });
  if (!ep.ok) {
    return { state: 'rejected', cfg, provider, model, reason: 'remote-endpoint', endpoint: ep.host,
      message: `ollama host '${ep.host}' refused (${ep.reason}); ${EXTERNAL_DISABLED_MESSAGE}` };
  }
  return { state: 'local', cfg, provider, model, reason: null, endpoint: ep.host,
    message: `semantic search runs locally (${provider}/${model} at ${ep.host})` };
}

/**
 * Turn text into a vector.
 *
 * The dimension is checked against the config, because a provider that
 * silently returns a different size would corrupt the store in a way
 * that only shows up as bad results months later.
 *
 * Throws `EXTERNAL_DISABLED` for any provider that is not local, BEFORE
 * an adapter is loaded, and `NOT_CONFIGURED` without a config.
 */
export async function embed(root, text, { cfg = null, timeoutMs = null } = {}) {
  const c = cfg ?? readConfig(root);
  if (!c) {
    const err = new Error('embed: not configured (`mem embed setup --provider ollama`)');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  if (!LOCAL_PROVIDERS.includes(c.provider)) {
    const err = new Error(`embed: provider '${c.provider}' refused. ${EXTERNAL_DISABLED_MESSAGE}`);
    err.code = 'EXTERNAL_DISABLED';
    throw err;
  }
  const t = timeoutMs ?? c.timeoutMs;
  const capped = text.length > 8000 ? text.slice(0, 8000) : text;

  const adapter = await loadAdapter(c.provider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const vec = await adapter.embed(capped, { model: c.model, signal: controller.signal, root });
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
    case 'ollama': return import('./ollama.mjs');
    default: throw new Error(`unknown provider '${provider}'`);
  }
}

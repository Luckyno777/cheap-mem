/**
 * embed-hook — attach an embedding to an entry that is already written.
 *
 * Order matters: the JSONL line is written FIRST and the embedding is
 * added afterwards. If embedding fails — no key, no network, a provider
 * outage — the memory entry still exists. The reverse order would mean
 * losing a memory because an optional feature was unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as embed from './embed/index.mjs';
import * as store from './embed/store.mjs';

/** Fields worth embedding, in the order they read best. */
const TEXT_FIELDS = ['title', 'topic', 'choice', 'why', 'text', 'description',
  'learning', 'duty', 'skill', 'fact', 'class'];

export function entryText(entry) {
  const parts = [];
  for (const f of TEXT_FIELDS) {
    const v = entry[f];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
  }
  if (Array.isArray(entry.tags) && entry.tags.length) parts.push(entry.tags.join(' '));
  return parts.join('\n').trim();
}

/**
 * Embed one entry.
 *
 * Never throws when onFail is 'warn' — returns `{status, ...}`:
 *   ok     stored
 *   empty  nothing embeddable in this entry
 *   off    embeddings are not set up (no key) — silent, not a defect
 *   broken a real failure worth reporting
 */
export async function embedEntry(root, file, line, entry) {
  const text = entryText(entry);
  if (!text) return { status: 'empty', reason: 'no embeddable text in the entry' };

  let cfg;
  try { cfg = embed.readConfig(root); }
  catch (e) { return { status: 'broken', reason: 'config', detail: e.message }; }

  let dim;
  try { dim = embed.dimensions(cfg.provider, cfg.model); }
  catch (e) { return { status: 'broken', reason: 'dimension', detail: e.message }; }

  let vector;
  try {
    vector = await embed.embed(root, text, { cfg });
  } catch (e) {
    // No key means "not set up", the normal state for anyone who does
    // not want embeddings. Reporting it as broken would warn on every
    // single `mem log` — and once people are used to warnings, they
    // stop seeing the real ones.
    if (e.code === 'NO_KEY') return { status: 'off', reason: `no key for ${cfg.provider}` };
    return { status: 'broken', reason: 'embed', detail: `${cfg.provider}: ${e.message}` };
  }

  let db;
  try { db = await store.open(root, dim); }
  catch (e) { return { status: 'broken', reason: 'store-open', detail: e.message }; }

  try {
    const id = store.save(db, {
      sourceFile: path.relative(root, file),
      lineNumber: line,
      jsonlId: entry.id,
      ts: entry.ts,
      text,
      provider: cfg.provider,
      model: cfg.model,
      vector,
    });
    return { status: 'ok', id, provider: cfg.provider, model: cfg.model, dim };
  } catch (e) {
    return { status: 'broken', reason: 'store-save', detail: e.message };
  } finally {
    try { db.close(); } catch { /* fine */ }
  }
}

export function warning(r) {
  return `[embed ${r.status} ${r.reason}] ${r.detail ?? ''}`.trim();
}

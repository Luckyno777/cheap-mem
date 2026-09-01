/**
 * search — lane 3 of the memory: retrieval WITHOUT a model.
 *
 * This is the part people expect to need embeddings for. It does not.
 *
 *   score = BM25(tokens)              k1=1.2, b=0.75
 *         + thesaurus expansion       curated, weight 0.6
 *         + tag-graph expansion       learned, weight = nPMI (max 0.5)
 *         × field weight              title 3.0 … text 1.0
 *         × recency                   max +15%, halved after 90 days
 *
 * Every expansion stays below 1.0, so a synonym never outranks a
 * literal hit.
 *
 * Cost: nothing. Latency: single-digit milliseconds on a cached index.
 * No API key, no network, no vendor. It runs on a plane.
 *
 * Where it honestly loses: true paraphrase with no lexical overlap.
 * "the customer was unhappy" finds "complaint received" only if a
 * matching synonym pair exists. For that case there is `mem find-embed`
 * — the escalation, not the default.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as memory from './memory.mjs';
import * as thesaurus from './thesaurus.mjs';
import * as raw from './raw.mjs';
import { pack } from './language.mjs';

const K1 = 1.2;
const B = 0.75;

export const CACHE_FILE = path.join('.mem', 'search-index.json');

// Cache schema version. When the shape of an index document changes
// (e.g. the new `retired` field), an old cache MUST be discarded — else
// recall would keep showing retired entries until the corpus happens to
// change. Bumping this forces a rebuild.
export const CACHE_VERSION = 2;

/**
 * Field weights. The same word means more in a title than in a body:
 * a title is what someone chose to call the thing.
 */
export const FIELD_WEIGHTS = Object.freeze({
  title: 3.0,
  topic: 2.5,
  class: 2.0,
  tags: 2.0,
  skill: 2.0,
  choice: 1.5,
  learning: 1.5,
  duty: 1.5,
  why: 1.2,
  description: 1.0,
  text: 1.0,
  fact: 1.0,
});

/**
 * Compound splitting — for languages that glue nouns together.
 *
 * "Sitzungspost" should find "Post". We split greedily against a
 * lexicon built from the corpus itself: any word that occurs often
 * enough on its own may be a part. No dictionary file, no maintenance —
 * the lexicon grows with the memory.
 *
 * Linking characters are per language ("Sitzung|s|post").
 */
export function splitCompound(word, lexicon, lang, minPart = 4) {
  if (!lang.compounds) return null;
  if (word.length < minPart * 2) return null;
  const linking = lang.linkingChars ?? [];
  for (let i = word.length - minPart; i >= minPart; i -= 1) {
    let left = word.slice(0, i);
    const rest = word.slice(i);
    if (!lexicon.has(left)) {
      for (const l of linking) {
        if (left.endsWith(l) && lexicon.has(left.slice(0, -l.length))) {
          left = left.slice(0, -l.length);
          break;
        }
      }
    }
    if (!lexicon.has(left)) continue;
    if (lexicon.has(rest)) return [left, rest];
    const deeper = splitCompound(rest, lexicon, lang, minPart);
    if (deeper) return [left, ...deeper];
  }
  return null;
}

/**
 * Text to tokens. Returns base forms, plus — when a lexicon is given —
 * the parts of compounds.
 */
export function tokenize(text, { lexicon = null, lang = pack('en') } = {}) {
  if (typeof text !== 'string') return [];
  const rawWords = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 2 && !lang.stopwords.has(w));

  const out = [];
  for (const w of rawWords) {
    // Hyphenated words yield BOTH the full form (`pull-request`) and
    // the parts (`pull`, `request`). Without that, "embedding" never
    // finds the entry "embeddings-endpoint".
    const forms = [w];
    if (w.includes('-')) {
      for (const part of w.split('-')) {
        if (part.length >= 2 && !lang.stopwords.has(part)) forms.push(part);
      }
    }
    for (const f of forms) {
      const n = lang.normalize(f);
      out.push(lang.stem(n));
      if (n !== f) out.push(lang.stem(f));   // both spellings
      if (lexicon) {
        const parts = splitCompound(n, lexicon, lang);
        if (parts) for (const p of parts) out.push(lang.stem(p));
      }
    }
  }
  return out;
}

/**
 * One entry to weighted fields. Returns a Map token -> weight: the
 * same word in the title counts more than in the body.
 */
export function fieldsOfEntry(entry, { lexicon = null, lang = pack('en') } = {}) {
  const weights = new Map();
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const value = entry[field];
    if (!value) continue;
    const text = Array.isArray(value) ? value.join(' ') : String(value);
    for (const t of tokenize(text, { lexicon, lang })) {
      weights.set(t, (weights.get(t) ?? 0) + weight);
    }
  }
  return weights;
}

/**
 * How much text per capture goes into the index. A full capture can be
 * megabytes; most of it is tool output. We take the start of the
 * conversational part — enough for "what was that again", not so much
 * that the index bursts.
 */
export const RAW_CAP = 20 * 1024;

/** Weight of raw captures. Deliberately low: a digested entry is
 *  checked and phrased, a capture is raw text. It should be findable,
 *  but never displace a real entry. */
export const RAW_WEIGHT = 0.35;

/**
 * Captures as documents. Takes only the conversational part — tool
 * results are nearly worthless for recall and make up roughly half the
 * material.
 *
 * One capture becomes ONE document (not one per line) — otherwise a
 * single long session would swamp the whole index.
 */
function* rawDocuments(root, lexicon, lang) {
  let captures;
  try { captures = raw.listCaptures(root); }
  catch { return; }

  const openSet = (() => {
    try { return new Set(raw.pending(root).open); }
    catch { return new Set(); }
  })();

  for (const rel of captures) {
    let header, lines;
    try { ({ header, lines } = raw.readCapture(root, rel)); }
    catch { continue; }   // a broken capture is no reason to fail

    const pieces = [];
    let length = 0;
    for (const l of lines) {
      if (length >= RAW_CAP) break;
      const s = conversationText(l);
      if (!s) continue;
      pieces.push(s);
      length += s.length;
    }
    if (pieces.length === 0) continue;

    const text = pieces.join('\n').slice(0, RAW_CAP);
    const weights = new Map();
    for (const t of tokenize(text, { lexicon, lang })) {
      weights.set(t, (weights.get(t) ?? 0) + RAW_WEIGHT);
    }

    yield {
      type: 'raw',
      project: header?.__stamp?.project ?? null,
      source: rel,
      line: 0,
      weights,
      pending: openSet.has(rel),
      entry: {
        ts: header?.__stamp?.ts_to ?? header?.__captured_at ?? null,
        title: `[raw] ${rel.split('/').pop()}`,
        text: text.slice(0, 400),
        surface: header?.__stamp?.surface ?? null,
        session_id: header?.__stamp?.session_id ?? null,
      },
    };
  }
}

/**
 * Pull the conversational part out of a transcript line. Tool calls
 * and tool results are skipped: they are about half the material and
 * contribute almost nothing to recall ("what did we decide back then"
 * is not in an `ls` output).
 */
function conversationText(l) {
  if (!l || typeof l !== 'object') return '';
  const asText = JSON.stringify(l);
  if (asText.includes('tool_result') || asText.includes('toolUseResult')) return '';
  return raw.textOf(l);
}

/**
 * Build the index. Reads all JSONL files, tokenizes, collects document
 * frequencies. Two passes, because the compound lexicon only comes into
 * being from the corpus:
 *   pass 1  without lexicon -> word frequencies -> lexicon
 *   pass 2  with lexicon    -> final index
 */
export function buildIndex(root, { types = null, language = 'en' } = {}) {
  const lang = pack(language);
  const targetTypes = types ?? Object.keys(memory.TYPES);
  const rawEntries = [];

  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of targetTypes) {
      let p;
      try { p = memory.logPath(root, type, project); }
      catch { continue; }
      if (!fs.existsSync(p)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i].trim()) continue;
        let e;
        try { e = JSON.parse(lines[i]); } catch { continue; }
        rawEntries.push({
          entry: e, type, project,
          source: path.relative(root, p),
          line: i + 1,
        });
      }
    }
  }

  // Pass 1: word frequencies for the compound lexicon.
  const lexicon = new Set();
  if (lang.compounds) {
    const wordCount = new Map();
    for (const { entry } of rawEntries) {
      for (const field of Object.keys(FIELD_WEIGHTS)) {
        const value = entry[field];
        if (!value) continue;
        const text = Array.isArray(value) ? value.join(' ') : String(value);
        for (const w of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
          if (w.length < 4 || lang.stopwords.has(w)) continue;
          const n = lang.normalize(w);
          wordCount.set(n, (wordCount.get(n) ?? 0) + 1);
        }
      }
    }
    for (const [w, n] of wordCount) if (n >= 2) lexicon.add(w);
  }

  // Pass 2: the final index.
  const documents = [];
  const docFreq = new Map();
  let lengthSum = 0;

  const addDoc = (doc) => {
    if (doc.weights.size === 0) return;
    let length = 0;
    for (const g of doc.weights.values()) length += g;
    lengthSum += length;
    for (const t of doc.weights.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    documents.push({ ...doc, length });
  };

  // Retired map from the SAME corpus. Tombstone lines are not indexed
  // at all (they are bookkeeping, not content); every other doc carries
  // its retired state so search can hide it in everyday recall.
  const retired = memory.retiredMap(rawEntries.map((r) => r.entry));

  for (const r of rawEntries) {
    if (memory.isClosingLine(r.entry)) continue;
    const info = r.entry.id ? retired.get(r.entry.id) : null;
    addDoc({
      ...r,
      weights: fieldsOfEntry(r.entry, { lexicon: lang.compounds ? lexicon : null, lang }),
      ...(info ? { retired: info } : {}),
    });
  }

  // --- Index the raw material too --------------------------------
  //
  // The digest can take up to 45 minutes to turn a capture into a
  // structured entry. In that window whatever was said would be
  // unfindable — although it has been on disk the whole time.
  //
  // So captures are indexed as well, but **weighted low** and marked
  // `pending`. Nothing is ever invisible; the delay now affects only
  // the structure, not the findability.
  for (const doc of rawDocuments(root, lang.compounds ? lexicon : null, lang)) addDoc(doc);

  const tagGraph = thesaurus.buildTagGraph(rawEntries.map((r) => r.entry));

  return {
    documents,
    docFreq,
    lexicon,
    tagGraph,
    language: lang.name,
    N: documents.length,
    avgLength: documents.length ? lengthSum / documents.length : 1,
    builtAt: new Date().toISOString(),
  };
}

/** BM25 IDF (with +1 to keep very common terms from going negative). */
function idf(index, term) {
  const n = index.docFreq.get(term) ?? 0;
  return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
}

/**
 * Search. Returns the best `top` hits, descending by score.
 */
export function search(index, query, {
  top = 10,
  type = null,
  project = null,
  since = null,
  minScore = 0.01,
  noRaw = false,
  onlyRaw = false,
  withRetired = false,   // include retired (done/discarded/superseded)?
  language = null,
} = {}) {
  const lang = pack(language ?? index.language ?? 'en');
  const own = tokenize(query, { lexicon: index.lexicon, lang });
  if (own.length === 0) return [];

  const terms = new Map();
  for (const t of own) terms.set(t, Math.max(terms.get(t) ?? 0, 1.0));

  for (const [syn, g] of thesaurus.expand(own, index.tagGraph, lang)) {
    const stemmed = lang.stem(lang.normalize(syn));
    if (terms.has(stemmed)) continue;   // the original beats the expansion
    terms.set(stemmed, g);
  }

  const sinceTs = since
    ? (since instanceof Date ? since.toISOString() : String(since))
    : null;
  const now = Date.now();

  const hits = [];
  for (const doc of index.documents) {
    const isRaw = doc.type === 'raw';
    if (doc.retired && !withRetired) continue;
    if (noRaw && isRaw) continue;
    if (onlyRaw && !isRaw) continue;
    if (type && doc.type !== type) continue;
    if (project !== null && project !== undefined) {
      const target = project === 'global' ? null : project;
      if (doc.project !== target) continue;
    }
    if (sinceTs && (!doc.entry.ts || doc.entry.ts < sinceTs)) continue;

    let score = 0;
    for (const [term, qWeight] of terms) {
      const f = doc.weights.get(term);
      if (!f) continue;
      const norm = f * (K1 + 1) / (f + K1 * (1 - B + B * doc.length / index.avgLength));
      score += qWeight * idf(index, term) * norm;
    }
    if (score <= 0) continue;

    // Mild recency bonus: max +15%, halved after 90 days.
    if (doc.entry.ts) {
      const ageDays = (now - Date.parse(doc.entry.ts)) / 86400000;
      if (Number.isFinite(ageDays) && ageDays >= 0) {
        score *= 1 + 0.15 * Math.exp(-ageDays / 90);
      }
    }

    hits.push({
      score,
      type: doc.type,
      project: doc.project,
      source: doc.source,
      line: doc.line,
      entry: doc.entry,
      raw: isRaw,
      pending: doc.pending ?? false,
      ...(doc.retired ? { retired: doc.retired } : {}),
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const maxScore = hits.length ? hits[0].score : 0;
  return hits
    .filter((t) => maxScore === 0 || t.score / maxScore >= minScore)
    .slice(0, top);
}

// --- Index cache -----------------------------------------------------

/**
 * A stamp over the corpus. Changes whenever any log file changes.
 *
 * Size AND mtime must both flow in, each on its own. An earlier version
 * took Math.max over both — size (~10^3) always lost to time in
 * milliseconds (~10^12), so growth within the same millisecond was
 * invisible and the cache served stale hits.
 */
export function corpusStamp(root) {
  let files = 0;
  let bytes = 0;
  let newest = 0;
  const visit = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    files += 1;
    bytes += st.size;
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      try { visit(memory.logPath(root, type, project)); } catch { /* skip */ }
    }
  }
  for (const c of raw.listCaptures(root)) visit(path.join(root, c));
  return `${files}:${bytes}:${newest}`;
}

export function loadIndex(root, { fresh = false, language = 'en' } = {}) {
  const cachePath = path.join(root, CACHE_FILE);
  const stamp = corpusStamp(root);
  if (!fresh && fs.existsSync(cachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (c.version === CACHE_VERSION && c.stamp === stamp && c.language === pack(language).name) {
        return {
          ...c.index,
          documents: c.index.documents.map((d) => ({ ...d, weights: new Map(d.weights) })),
          docFreq: new Map(c.index.docFreq),
          lexicon: new Set(c.index.lexicon),
          tagGraph: thesaurus.unpackTagGraph(c.index.tagGraph),
          fromCache: true,
        };
      }
    } catch { /* broken cache is not an error, just a rebuild */ }
  }
  const index = buildIndex(root, { language });
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({
      version: CACHE_VERSION,
      stamp,
      language: index.language,
      index: {
        ...index,
        documents: index.documents.map((d) => ({ ...d, weights: [...d.weights] })),
        docFreq: [...index.docFreq],
        lexicon: [...index.lexicon],
        tagGraph: thesaurus.packTagGraph(index.tagGraph),
      },
    }));
  } catch { /* an unwritable cache costs speed, not correctness */ }
  return { ...index, fromCache: false };
}

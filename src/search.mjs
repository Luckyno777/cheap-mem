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
// 3: the index carries the learned term co-occurrence graph. An older
// cache has no termGraph, so it must be rebuilt rather than loaded.
export const CACHE_VERSION = 4;

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
export function tokenize(text, opts = {}) {
  return tokenizeGroups(text, opts).flat();
}

/**
 * The same tokens, but grouped by the word they came from.
 *
 * One typed word can produce several tokens: `pull-request` yields the
 * whole form and both parts, and `datastore` yields itself plus `data`
 * and `store` once the lexicon knows them. For scoring that flattening is
 * exactly right — every form is a chance to match.
 *
 * For anything that asks "how much of what the user TYPED does this
 * document cover", it is exactly wrong, and quietly so: coverage counted
 * over flat tokens treated `datastore` as three typed words, so the
 * document saying "data store" — the one the compound splitter exists to
 * find — covered 2 of 3 and lost a third of its score. Grouping keeps
 * one typed word worth one word.
 *
 * `tokenize` is this function flattened, so the two cannot drift apart.
 */
export function tokenizeGroups(text, { lexicon = null, lang = pack('en') } = {}) {
  if (typeof text !== 'string') return [];
  const rawWords = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 2 && !lang.stopwords.has(w));

  const groups = [];
  for (const w of rawWords) {
    const out = [];
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
    if (out.length) groups.push(out);
  }
  return groups;
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
function* rawDocuments(root, lexicon, lang, only = null) {
  let captures;
  if (only) captures = only;
  else {
    try { captures = raw.listCaptures(root); }
    catch { return; }
  }

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

  // The learned co-occurrence thesaurus, over the structured entries only.
  // Captures are deliberately excluded: they are raw transcript, and their
  // boilerplate and tool output would dominate the statistics and teach the
  // graph associations that say more about the terminal than about the work.
  // Stopwords of the corpus language AND of English: quoted error messages
  // drag foreign filler in ("because it was ignored not ..."), and that
  // filler clusters tightly enough to look like a real association.
  // Stemmed AND unstemmed: the graph works on stemmed terms, so a raw list
  // of stopwords misses them all — "because" never matches the "becaus"
  // that actually sits in the index, and the filler sails straight through.
  const stopwords = new Set();
  for (const w of [...lang.stopwords, ...pack('en').stopwords]) {
    stopwords.add(w);
    stopwords.add(lang.stem(lang.normalize(w)));
  }
  const termGraph = thesaurus.buildTermGraph(
    documents.filter((d) => d.type !== 'raw').map((d) => d.weights),
    { stopwords });

  return {
    documents,
    docFreq,
    lexicon,
    tagGraph,
    termGraph,
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
 * Cosine similarity between two documents' term-weight vectors. Pure,
 * deterministic, no embeddings — it reuses the same weighted term maps
 * BM25 already builds, so feeding MMR costs nothing extra.
 */
export function docSimilarity(aW, bW) {
  if (!aW || !bW || aW.size === 0 || bW.size === 0) return 0;
  let na = 0; for (const v of aW.values()) na += v * v;
  let nb = 0; for (const v of bW.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  const [small, big] = aW.size <= bW.size ? [aW, bW] : [bW, aW];
  let dot = 0;
  for (const [t, v] of small) { const w = big.get(t); if (w) dot += v * w; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Maximal Marginal Relevance re-ranking. Greedily picks the next result
 * that best trades relevance against redundancy with what is already
 * chosen:  val = lambda*rel - (1-lambda)*max_sim_to_selected.
 *
 * Relevance is normalized to [0,1] by the top score so it is comparable to
 * the [0,1] cosine similarity. This is cheap-mem's answer to the problem
 * engram.so solves with MMR: stop the top-k from filling with near-
 * duplicates (repeated sessions log near-identical lines), without a model
 * or embeddings. Deterministic — on a tie the earlier (higher-scored)
 * candidate wins. `simOf(a, b)` must return similarity in [0,1].
 */
export function mmrRerank(candidates, { lambda = 0.7, top = 10, simOf } = {}) {
  if (candidates.length <= 1) return candidates.slice(0, top);
  const maxScore = candidates.reduce((m, c) => (c.score > m ? c.score : m), 0);
  const remaining = candidates.map((c) => c);
  const selected = [];
  while (selected.length < top && remaining.length) {
    let bestPos = 0;
    let bestVal = -Infinity;
    for (let p = 0; p < remaining.length; p += 1) {
      const cand = remaining[p];
      const rel = maxScore > 0 ? cand.score / maxScore : 0;
      let maxSim = 0;
      for (const s of selected) {
        const sim = simOf(cand, s);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * rel - (1 - lambda) * maxSim;
      // Strictly greater keeps the earlier (higher-ranked) one on ties.
      if (val > bestVal) { bestVal = val; bestPos = p; }
    }
    selected.push(remaining.splice(bestPos, 1)[0]);
  }
  return selected;
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
  mmr = false,           // re-rank the top for diversity (MMR)
  mmrLambda = 0.7,       // 1 = pure relevance, 0 = pure diversity
  coverage = 1,          // reward covering more of the TYPED query (0 = off)
} = {}) {
  const lang = pack(language ?? index.language ?? 'en');
  // Grouped, not flat: coverage below counts TYPED WORDS, and one typed
  // word can expand into several tokens (hyphen parts, compound parts).
  const groups = tokenizeGroups(query, { lexicon: index.lexicon, lang });
  const own = groups.flat();
  if (own.length === 0) return [];

  const terms = new Map();
  for (const t of own) terms.set(t, Math.max(terms.get(t) ?? 0, 1.0));

  for (const [syn, g] of thesaurus.expand(own, index.tagGraph, lang, index.termGraph)) {
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

    // Coordination. BM25 adds up term scores and has no notion of "this
    // document answered MORE of the question", so one common word carried
    // often can outrank a document that contains every word typed.
    //
    // Counted over TYPED WORDS, not tokens. Only the words the user
    // actually typed count at all — rewarding coverage of the thesaurus
    // expansion would reward the expansion, not the query — and a word
    // that expanded into several tokens still counts once. Over flat
    // tokens this was measurably wrong: `datastore` looked like three
    // typed words, so the document saying "data store" covered 2 of 3
    // and lost a third of its score, which is the opposite of what the
    // compound splitter is for.
    if (coverage > 0 && groups.length > 1) {
      let covered = 0;
      for (const g of groups) {
        for (const t of g) { if (doc.weights.has(t)) { covered += 1; break; } }
      }
      score *= (covered / groups.length) ** coverage;
    }

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
      __w: doc.weights,   // internal: term vector for MMR; stripped below
    });
  }

  hits.sort((a, b) => b.score - a.score);
  const maxScore = hits.length ? hits[0].score : 0;
  const kept = hits.filter((t) => maxScore === 0 || t.score / maxScore >= minScore);
  const out = (mmr && kept.length > 1)
    ? mmrRerank(kept, { lambda: mmrLambda, top, simOf: (a, b) => docSimilarity(a.__w, b.__w) })
    : kept.slice(0, top);
  for (const t of out) delete t.__w;   // internal helper never leaves search()
  return out;
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
/**
 * Per-file state, cheap enough to compute on every search.
 *
 * The corpus stamp answers "did anything change" in one number, which is
 * all a full rebuild needs to know. Appending needs more: WHICH file grew,
 * by how much, and whether what came before is still the same bytes. So
 * each log and each capture is tracked by its size plus a hash of the
 * last slice of the part already indexed.
 *
 * That tail hash is the guard against the case that makes naive
 * append-tracking wrong: `git pull --rebase` replays a local commit on
 * top of a remote one, so a line can appear in the MIDDLE of a file that
 * only ever gets appended to locally. Size alone would then read the
 * wrong tail and index a line twice while missing another. Hashing the
 * end of the indexed prefix catches exactly that, with one positioned
 * read of at most 4 KB instead of a pass over the file.
 */
const TAIL_BYTES = 4096;

function tailHash(file, upto) {
  if (upto <= 0) return '0';
  const from = Math.max(0, upto - TAIL_BYTES);
  const len = upto - from;
  const buf = Buffer.allocUnsafe(len);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, from);
  } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* fine */ } }
  // FNV-1a: no dependency, and collisions here cost a needless rebuild,
  // never a wrong answer.
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i += 1) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${len}:${h.toString(36)}`;
}

/** Every file the index is built from, with its current size. */
export function indexedFiles(root, { types = null } = {}) {
  const out = new Map();
  const targetTypes = types ?? Object.keys(memory.TYPES);
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of targetTypes) {
      let p;
      try { p = memory.logPath(root, type, project); } catch { continue; }
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      out.set(path.relative(root, p), { bytes: st.size, kind: 'log', type, project });
    }
  }
  let captures = [];
  try { captures = raw.listCaptures(root); } catch { /* no raw/ */ }
  for (const rel of captures) {
    let st;
    try { st = fs.statSync(path.join(root, rel)); } catch { continue; }
    out.set(rel, { bytes: st.size, kind: 'raw' });
  }
  return out;
}

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

/**
 * How much of the corpus may be added incrementally before the index is
 * rebuilt from scratch.
 *
 * Appending updates the documents, the term frequencies and the
 * averages exactly. It does NOT recompute the compound lexicon or the
 * two learned graphs (tags, term co-occurrence) — those are corpus-wide
 * statistics, and recomputing them is most of what a build costs. They
 * drift instead, and this threshold bounds the drift: once a fifth of
 * the corpus arrived after the last full build, the next search pays for
 * a real one. Retrieval quality therefore lags the newest entries a
 * little; finding them does not, because the documents themselves are in
 * the index immediately.
 */
export const REBUILD_AFTER_FRACTION = 0.2;

/**
 * How many new log bytes may accumulate before the cache file is written
 * again.
 *
 * Writing it costs a full serialization — 82 MB of JSON at 200k entries,
 * about 2.6 s. Doing that after every appended line turns a 1.5 s load
 * into a 4.2 s one and throws away most of what appending buys. So the
 * cache is left alone while the un-cached tail stays small: the next
 * search re-reads and re-parses those same few lines, which costs
 * milliseconds, and the expensive write happens once per few thousand
 * entries instead of once per entry.
 *
 * The trade is bounded in both directions: never more than this many
 * bytes re-parsed per search, never more than one full write per this
 * many bytes captured.
 */
export const CACHE_WRITE_AFTER_BYTES = 4 * 1024 * 1024;

/**
 * Add newly appended lines to an already-loaded index.
 *
 * Returns null when the change is not a pure append — a shrunk file, a
 * changed prefix, a file that disappeared — in which case the caller
 * falls back to a full build. Refusing is always safe; guessing is not.
 */
function appendToIndex(root, index, before, now, lang) {
  const added = [];
  const lastLines = new Map();   // rel -> line count after this append
  let newBytes = 0;

  for (const [rel, cur] of now) {
    const old = before[rel];
    if (!old) {                       // a file that did not exist before
      newBytes += cur.bytes;
      if (cur.kind === 'log') {
        const parsed = parseLogTail(root, rel, { ...cur, linesBefore: 0 }, 0);
        if (!parsed) return null;
        added.push(...parsed);
        lastLines.set(rel, parsed.length ? parsed[parsed.length - 1].line : 0);
      }
      continue;                       // new captures are handled below
    }
    if (cur.bytes === old.bytes) {
      if (tailHash(path.join(root, rel), cur.bytes) !== old.tail) return null;
      continue;                       // untouched
    }
    if (cur.bytes < old.bytes) return null;              // shrunk: rewritten
    if (tailHash(path.join(root, rel), old.bytes) !== old.tail) return null;  // prefix moved
    if (cur.kind !== 'log') return null;                 // a capture never grows
    newBytes += cur.bytes - old.bytes;
    const parsed = parseLogTail(root, rel, { ...cur, linesBefore: old.lines ?? 0 }, old.bytes);
    if (!parsed) return null;
    added.push(...parsed);
    lastLines.set(rel, parsed.length ? parsed[parsed.length - 1].line : (old.lines ?? 0));
  }
  for (const rel of Object.keys(before)) {
    if (!now.has(rel)) return null;   // something was deleted: rebuild
  }

  // Captures are whole new files; index them the same way a build does.
  const knownRaw = new Set(Object.keys(before).filter((r) => before[r].kind === 'raw'));
  const freshRaw = [...now.keys()].filter((r) => now.get(r).kind === 'raw' && !knownRaw.has(r));
  const rawDocs = freshRaw.length
    ? [...rawDocuments(root, lang.compounds ? index.lexicon : null, lang, freshRaw)]
    : [];

  // A tombstone or correction in the new lines retires an entry that is
  // already indexed — so the retired map is applied to the WHOLE index,
  // not only to what just arrived. Missing this would leave a discarded
  // entry answering searches until the next full build.
  const retired = memory.retiredMap(added.map((d) => d.entry));
  if (retired.size) {
    for (const doc of index.documents) {
      const info = doc.entry && doc.entry.id ? retired.get(doc.entry.id) : null;
      if (info) doc.retired = info;
    }
  }

  let lengthSum = index.avgLength * index.N;
  const push = (doc) => {
    if (doc.weights.size === 0) return;
    let length = 0;
    for (const g of doc.weights.values()) length += g;
    lengthSum += length;
    for (const t of doc.weights.keys()) index.docFreq.set(t, (index.docFreq.get(t) ?? 0) + 1);
    index.documents.push({ ...doc, length });
  };
  for (const d of added) {
    if (memory.isClosingLine(d.entry)) continue;
    const info = d.entry.id ? retired.get(d.entry.id) : null;
    push({
      ...d,
      weights: fieldsOfEntry(d.entry, { lexicon: lang.compounds ? index.lexicon : null, lang }),
      ...(info ? { retired: info } : {}),
    });
  }
  for (const d of rawDocs) push(d);

  index.N = index.documents.length;
  index.avgLength = index.N ? lengthSum / index.N : 1;
  return { added: added.length + rawDocs.length, newBytes, lastLines };
}

/** The lines of one log file from byte `from` on, as index entries. */
function parseLogTail(root, rel, info, from) {
  const full = path.join(root, rel);
  let text;
  try {
    const fd = fs.openSync(full, 'r');
    try {
      const len = info.bytes - from;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, from);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }

  // Line numbers keep counting from the start of the file, or every
  // `source:line` the search prints would be wrong. The count comes from
  // the stored state — re-reading the prefix just to count newlines would
  // put the whole file back in the hot path, which is the cost this
  // function exists to avoid.
  let lineNo = (info.linesBefore ?? 0) + 1;
  const out = [];
  for (const line of text.split('\n')) {
    if (line.trim()) {
      let e;
      try { e = JSON.parse(line); } catch { lineNo += 1; continue; }
      out.push({ entry: e, type: info.type, project: info.project, source: rel, line: lineNo });
    }
    lineNo += 1;
  }
  return out;
}

export function loadIndex(root, { fresh = false, language = 'en' } = {}) {
  const cachePath = path.join(root, CACHE_FILE);
  const lang = pack(language);

  const writeCache = (index, files, fullAt) => {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({
        version: CACHE_VERSION,
        language: index.language,
        files,
        fullAt,
        index: {
          ...index,
          documents: index.documents.map((d) => ({ ...d, weights: [...d.weights] })),
          docFreq: [...index.docFreq],
          lexicon: [...index.lexicon],
          tagGraph: thesaurus.packTagGraph(index.tagGraph),
          termGraph: thesaurus.packTagGraph(index.termGraph),
        },
      }));
    } catch { /* an unwritable cache costs speed, not correctness */ }
  };

  // The state of every file the index covers, right now.
  const now = indexedFiles(root);
  const stateOf = (files, lines) => {
    const out = {};
    for (const [rel, info] of files) {
      out[rel] = {
        bytes: info.bytes,
        kind: info.kind,
        type: info.type,
        project: info.project,
        lines: lines ? (lines.get(rel) ?? 0) : countLines(root, rel),
        tail: tailHash(path.join(root, rel), info.bytes),
      };
    }
    return out;
  };

  if (!fresh && fs.existsSync(cachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (c.version === CACHE_VERSION && c.language === lang.name && c.files) {
        const index = {
          ...c.index,
          documents: c.index.documents.map((d) => ({ ...d, weights: new Map(d.weights) })),
          docFreq: new Map(c.index.docFreq),
          lexicon: new Set(c.index.lexicon),
          tagGraph: thesaurus.unpackTagGraph(c.index.tagGraph),
          termGraph: thesaurus.unpackTagGraph(c.index.termGraph),
        };
        const fullAt = c.fullAt ?? index.N;
        const grown = appendToIndex(root, index, c.files, now, lang);

        if (grown && grown.added === 0) {
          return { ...index, fromCache: true, appended: 0 };
        }
        // Rebuild rather than append once enough of the corpus is new that
        // the lexicon and the learned graphs would be measurably behind.
        if (grown && index.N <= fullAt * (1 + REBUILD_AFTER_FRACTION)) {
          if (grown.newBytes >= CACHE_WRITE_AFTER_BYTES) {
            const files = stateOf(now, grown.lastLines);
            // Line counts for untouched files carry over unchanged.
            for (const [rel, old] of Object.entries(c.files)) {
              if (files[rel] && !grown.lastLines.has(rel)) files[rel].lines = old.lines ?? files[rel].lines;
            }
            writeCache(index, files, fullAt);
          }
          return { ...index, fromCache: true, appended: grown.added };
        }
      }
    } catch { /* a broken cache is not an error, just a rebuild */ }
  }

  const index = buildIndex(root, { language });
  writeCache(index, stateOf(now, null), index.N);
  return { ...index, fromCache: false, appended: 0 };
}

/** Lines in a file — only ever called on a full build. */
function countLines(root, rel) {
  try {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch { return 0; }
}

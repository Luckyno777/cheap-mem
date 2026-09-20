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
import { createHash } from 'node:crypto';
import * as memory from './memory.mjs';
import * as thesaurus from './thesaurus.mjs';
import * as entity from './entity.mjs';
import * as raw from './raw.mjs';
import * as archive from './archive.mjs';
import { deriveState } from './state.mjs';

/**
 * The file path of one indexed piece.
 *
 * Log files live in the repository, captures live in the archive since
 * 2026-09-08. Both cases in ONE function, so five callers do not each
 * guess for themselves — which is exactly what happened: every one of
 * them used `path.join(root, rel)`, every one failed after the move,
 * every one with `continue` and no message.
 */
function piecePath(root, rel) {
  const r = String(rel);
  if (!r.startsWith(`${raw.RAW_DIR}/`) && !r.startsWith(`${raw.RAW_DIR}\\`)) {
    return path.join(root, rel);
  }
  return archive.filePath(archive.readConfig(process.env, root), root, rel)
    ?? path.join(root, rel);
}
import { pack } from './language.mjs';
import { detectEntryLanguage, DETECTABLE_LANGUAGES, UNCERTAIN } from './langdetect.mjs';
import * as profile from './profile.mjs';

/**
 * The packs consulted when an entry's (or a query's) language is not
 * pinned down — either because detection came back UNCERTAIN, or
 * because a caller asked no single language be assumed. See
 * `langdetect.mjs` for why only these two are real candidates today.
 */
const DETECTABLE_PACKS = DETECTABLE_LANGUAGES.map((code) => pack(code));

/**
 * Which pack(s) apply to one piece of content, given its detection
 * result. CERTAIN gets its own language's rules and nothing else —
 * exactly what a single-language corpus already got before this file
 * carried per-entry detection at all, so a correctly-detected entry
 * costs nothing extra. UNCERTAIN gets every detectable rule set: "apply
 * both, claim nothing" is not a slogan here, it is which packs get
 * handed to the tokenizer.
 */
function packsFor(langInfo) {
  return langInfo.certain ? [pack(langInfo.language)] : DETECTABLE_PACKS;
}

const K1 = 1.2;
const B = 0.75;

export const CACHE_FILE = path.join('.mem', 'search-index.json');

// Cache schema version. When the shape of an index document changes
// (e.g. the new `retired` field), an old cache MUST be discarded — else
// recall would keep showing retired entries until the corpus happens to
// change. Bumping this forces a rebuild.
// 3: the index carries the learned term co-occurrence graph. An older
// cache has no termGraph, so it must be rebuilt rather than loaded.
// 7: `symbols` is now a weighted field, and the exact index recognises
//    dot-separated names. An old cache has neither — it would keep
//    finding nothing, and silently at that.
// 8: each file's cache record now carries `docs`, the number of index
//    documents it contributed (see `docCountsMatch` below) — an older
//    cache has no such count to check the loaded documents against.
// 9: P28 — every document now carries its own DETECTED `lang` and
//    `langCertain`, and the index carries `lexicons` (one compound
//    lexicon per detectable language) alongside the single `lexicon`.
//    An older cache has neither: its documents were tokenised with one
//    corpus-wide pack, so serving it as-is would keep answering the
//    exact defect P28 exists to close.
export const CACHE_VERSION = 9;

/**
 * Field weights. The same word means more in a title than in a body:
 * a title is what someone chose to call the thing.
 */
export const FIELD_WEIGHTS = Object.freeze({
  title: 3.0,
  topic: 2.5,
  class: 2.0,
  tags: 2.0,
  // Asked-words: what someone would ASK to find this, written by the
  // digester while condensing. They cost nothing at retrieval time — the
  // work happens in lane 2, where a model runs anyway.
  //
  // Weighted like `tags`, and for the same reason: both are short,
  // deliberately set access words, not prose. Higher than the title
  // would be wrong — then a guessed asked-words field would override
  // the entry's actual subject.
  asked: 2.0,
  skill: 2.0,
  // Code symbols an entry explicitly names:
  // `AuthService.refreshToken`, `store.put`.
  //
  // **Why this field was missing even though it was already stored.**
  // An entry was always allowed to carry `symbols` — free fields are
  // accepted —, and `--literal` found it too. The RANKED search did not:
  // without a weight BM25 does not see the field at all, and the
  // exact-match lane did not recognise dot-separated names as
  // identifiers. Stored, findable only the long way round — the class
  // `built-but-out-of-reach`, measured on 2026-09-09.
  //
  // Weighted like `tags` and `asked`, for the same reason: a symbol is
  // a deliberately set access word, not prose. Higher than the title
  // would be wrong — then a symbol list would override the entry's
  // actual subject.
  symbols: 2.0,
  choice: 1.5,
  // Roads not taken — LIGHTER than `choice`, and that is the whole
  // point.
  //
  // Without this field "have we already looked at PostgreSQL?" is not
  // answerable: the entry only records that SQLite was chosen, and the
  // next agent evaluates it again from scratch.
  //
  // But at equal or higher weight the damage would be worse than the
  // one repaired: somebody searching for the tool they USE would first
  // find the decision in which it was REJECTED. 1.2 keeps it findable
  // and behind the actual choice.
  rejected: 1.2,
  learning: 1.5,
  duty: 1.5,
  // The text of a procedure. Weighted like `duty`: both are things
  // that HOLD, not things somebody observed. Without this field a rule
  // would only be findable by its title — and a norm you can only find
  // if you already know its name is not one.
  rule: 1.5,
  // The text of an open question. Higher than `text`, because a
  // question consists of nothing else — and because "what do we not
  // know about X" would otherwise not be answerable at all.
  question: 1.8,
  why: 1.2,
  // The excerpt from a foreign source. Lower than our own text: it is a
  // QUOTATION, not a statement by the memory. At equal weight one long
  // document would push our own learnings out of every hit list.
  excerpt: 0.8,
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
  return tokenizeGroupsMulti(text, {
    langs: [lang],
    lexicons: lexicon ? new Map([[lang.name, lexicon]]) : new Map(),
  });
}

/**
 * The same grouping as `tokenizeGroups`, but against SEVERAL language
 * packs at once — one typed word still yields one group, and that group
 * now holds forms from every pack in `langs`.
 *
 * This is where "ask the question against both rule sets" (P28) and
 * "one entry, its own rule set" both live: a single-pack call (what
 * `tokenizeGroups` is a thin wrapper over) reproduces the old, single-
 * language behaviour byte for byte, so a CERTAIN entry or an explicit
 * single-language query costs exactly what it always did.
 *
 * **Stopwords are filtered by UNION, not by any one pack.** A word is
 * dropped only if EVERY pack in `langs` calls it a stopword. Filtering
 * by intersection instead — drop it if pack A alone calls it a
 * stopword — would let an English filler word ("the") survive into a
 * German-tokenised group just because German's stopword list has never
 * heard of it, which is noise, not signal, and it is the UNION that
 * reproduces single-pack behaviour exactly when `langs` has one member.
 */
/**
 * One typed word's token forms under ONE pack: itself stemmed, both
 * spellings when normalising changed it, and its compound parts when
 * the pack's lexicon knows them. This is the unit both
 * `tokenizeGroupsMulti` (sums these across packs — see its own doc
 * comment on why that stacking is fine within ONE pack) and
 * `tokenizeGroupsPacked` (keeps one pack's forms apart from another's —
 * see that function) are built from, so the two cannot drift apart.
 */
function wordForms(f, lang, lexicon) {
  const out = [];
  const n = lang.normalize(f);
  out.push(lang.stem(n));
  if (n !== f) out.push(lang.stem(f));   // both spellings
  if (lexicon) {
    const parts = splitCompound(n, lexicon, lang);
    if (parts) for (const p of parts) out.push(lang.stem(p));
  }
  return out;
}

/** Hyphenated words yield BOTH the full form (`pull-request`) and the
 *  parts (`pull`, `request`). Without that, "embedding" never finds the
 *  entry "embeddings-endpoint". Shared by both grouping functions below. */
function hyphenForms(w, isStop) {
  const forms = [w];
  if (w.includes('-')) {
    for (const part of w.split('-')) {
      if (part.length >= 2 && !isStop(part)) forms.push(part);
    }
  }
  return forms;
}

export function tokenizeGroupsMulti(text, { lexicons = new Map(), langs } = {}) {
  if (typeof text !== 'string') return [];
  const packs = langs && langs.length ? langs : [pack('en')];
  const isStop = (w) => packs.every((l) => l.stopwords.has(w));

  const rawWords = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 2 && !isStop(w));

  const groups = [];
  for (const w of rawWords) {
    const out = [];
    for (const f of hyphenForms(w, isStop)) {
      for (const lang of packs) out.push(...wordForms(f, lang, lexicons.get(lang.name) ?? null));
    }
    if (out.length) groups.push(out);
  }
  return groups;
}

/**
 * The QUERY-side grouping (P28): one entry per typed word, but with each
 * applicable pack's forms kept in its OWN sub-list rather than pooled —
 * `groups[i]` is `[[en's forms for word i], [de's forms for word i], ...]`
 * for the packs that do not already treat the word as a stopword.
 *
 * **Why this needs to be a different shape from `tokenizeGroupsMulti`.**
 * `search()` scores a candidate spelling's alternates from DIFFERENT
 * language packs with MAX, not SUM — see the scoring loop's own comment
 * for why summing them broke the exact coordination guarantee
 * `test/coverage-floor.test.mjs` exists to protect: an UNCERTAIN
 * document indexed under both `cache` and `cach` would otherwise be
 * scored as if it had matched the query TWICE. Forms WITHIN one pack
 * (hyphen parts, compound parts) still stack, exactly as they always
 * have — see `wordForms` — because those are genuinely different
 * evidence for the same word, not two guesses about which language it
 * is in.
 */
export function tokenizeGroupsPacked(text, { lexicons = new Map(), langs } = {}) {
  if (typeof text !== 'string') return [];
  const packs = langs && langs.length ? langs : [pack('en')];
  const isStop = (w) => packs.every((l) => l.stopwords.has(w));

  const rawWords = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((w) => w.length >= 2 && !isStop(w));

  const groups = [];
  for (const w of rawWords) {
    const forms = hyphenForms(w, isStop);
    const perPack = [];
    for (const lang of packs) {
      if (lang.stopwords.has(w)) continue;   // this pack alone calls it filler
      const out = [];
      for (const f of forms) out.push(...wordForms(f, lang, lexicons.get(lang.name) ?? null));
      if (out.length) perPack.push(out);
    }
    if (perPack.length) groups.push(perPack);
  }
  return groups;
}

/**
 * One entry to weighted fields. Returns a Map token -> weight: the
 * same word in the title counts more than in the body.
 *
 * **Why each pack is tokenised SEPARATELY and its share HALVED when
 * `langs` holds more than one (P28's UNCERTAIN case), rather than
 * pooling every pack's tokens at full field weight.** The first version
 * of this did pool them, and it broke exactly the guarantee
 * `test/coverage-floor.test.mjs` exists to protect: an UNCERTAIN
 * document — no stopword fired either way, so BOTH rule sets apply —
 * got en-stem AND de-stem tokens each at the FULL field weight, so one
 * word repeated three times contributed as if it had been repeated six
 * times. That is a real BM25 score inflation, not a test artifact: the
 * adversarial "one word carried often" fixture in that file has no
 * stopword at all, so under the pooled version it went from losing to
 * the honest three-word answer (as coordination requires) to beating it
 * outright, simply for lacking a stopword to be certain about.
 *
 * Splitting the field weight `1/packs.length` ways fixes it structurally
 * rather than by tuning a number: an occurrence's total weight mass is
 * the same whether it lands on one spelling (CERTAIN, one pack, full
 * share) or is spread across two candidate spellings (UNCERTAIN, half
 * each) — hedging between two rule sets costs nothing extra and buys
 * nothing extra, which is what "claim nothing" has to mean for a score,
 * not only for a label. When both packs happen to stem a word to the
 * SAME spelling the two halves land back on one key and recombine to
 * the full weight, so a CERTAIN-worthy word occurring in an UNCERTAIN
 * entry is not quietly penalised either.
 */
export function fieldsOfEntry(entry, { lexicon = null, lang = pack('en'), lexicons = null, langs = null } = {}) {
  const packs = langs && langs.length ? langs : [lang];
  const lex = lexicons ?? (lexicon ? new Map([[lang.name, lexicon]]) : new Map());
  const share = 1 / packs.length;
  const weights = new Map();
  for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
    const value = entry[field];
    if (!value) continue;
    const text = Array.isArray(value) ? value.join(' ') : String(value);
    for (const p of packs) {
      for (const t of tokenizeGroupsMulti(text, { lexicons: lex, langs: [p] }).flat()) {
        weights.set(t, (weights.get(t) ?? 0) + weight * share);
      }
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
function* rawDocuments(root, lexicons, only = null) {
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
    // A capture is a transcript — it carries the same silent-mis-stem
    // risk a typed entry does, and a raw German session is common
    // enough (bilingual sessions, see FILLER above) that it gets the
    // same per-piece detection rather than one language for the whole
    // corpus.
    const langInfo = detectEntryLanguage({ text }, { fieldWeights: { text: 1 } });
    const packs = packsFor(langInfo);
    // Split per pack, same reasoning as `fieldsOfEntry`: an UNCERTAIN
    // capture must not outweigh a CERTAIN one just for trying both rule
    // sets.
    const share = RAW_WEIGHT / packs.length;
    const weights = new Map();
    for (const p of packs) {
      for (const t of tokenizeGroupsMulti(text, { lexicons, langs: [p] }).flat()) {
        weights.set(t, (weights.get(t) ?? 0) + share);
      }
    }

    yield {
      type: 'raw',
      project: header?.__stamp?.project ?? null,
      source: rel,
      line: 0,
      weights,
      lang: langInfo.language,
      langCertain: langInfo.certain,
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
 * Word frequencies for ONE language's compound lexicon (pass 1 of
 * `buildIndex`, pulled out because it now runs once per detectable
 * language instead of once for the whole corpus — see P28).
 */
function buildLexicon(rawEntries, langPack) {
  const wordCount = new Map();
  for (const { entry } of rawEntries) {
    for (const field of Object.keys(FIELD_WEIGHTS)) {
      const value = entry[field];
      if (!value) continue;
      const text = Array.isArray(value) ? value.join(' ') : String(value);
      for (const w of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
        if (w.length < 4 || langPack.stopwords.has(w)) continue;
        const n = langPack.normalize(w);
        wordCount.set(n, (wordCount.get(n) ?? 0) + 1);
      }
    }
  }
  const set = new Set();
  for (const [w, n] of wordCount) if (n >= 2) set.add(w);
  return set;
}

/**
 * Build the index. Reads all JSONL files, tokenizes, collects document
 * frequencies. Two passes, because the compound lexicon only comes into
 * being from the corpus:
 *   pass 1  without lexicon -> word frequencies -> lexicon (per language)
 *   pass 2  with lexicon    -> final index, one language per ENTRY
 *
 * **`language` no longer picks the corpus's one tokenisation.** It used
 * to: every entry was stemmed and stopword-filtered with the SAME pack,
 * so a memory that mixed languages found one of them worse than the
 * other, silently (P28). It still names the CONFIGURED default — kept
 * for `index.language` (cache versioning, `mem doctor`, the CLI's
 * `--fresh` path) and for `index.lexicon`, the single Set those callers
 * already read — but which pack actually tokenises a given document is
 * now decided PER DOCUMENT, by `detectEntryLanguage` below.
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

  // Pass 1: word frequencies for the compound lexicon — one lexicon per
  // language a document could actually be detected as, PLUS the
  // configured default (which may be neither: `nl`, `sv`... have no
  // stopword list, so `detectEntryLanguage` can never name them, but a
  // memory can still be explicitly CONFIGURED to one of them, and that
  // still deserves compound splitting the way it always has).
  const lexiconLangs = new Set([...DETECTABLE_LANGUAGES, lang.name]);
  const lexicons = new Map();
  for (const code of lexiconLangs) {
    const p = pack(code);
    lexicons.set(code, p.compounds ? buildLexicon(rawEntries, p) : new Set());
  }
  const lexicon = lexicons.get(lang.name) ?? new Set();

  // Pass 2: the final index.
  const documents = [];
  const docFreq = new Map();
  let lengthSum = 0;

  // Second, curated statistic: the same numbers, but WITHOUT raw capture.
  // What it is for is explained at `statsN` in the return value.
  const curatedFreq = new Map();
  let curatedLengthSum = 0;
  let curatedN = 0;

  const addDoc = (doc) => {
    if (doc.weights.size === 0) return;
    let length = 0;
    for (const g of doc.weights.values()) length += g;
    lengthSum += length;
    for (const t of doc.weights.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    if (doc.type !== 'raw') {
      curatedN += 1;
      curatedLengthSum += length;
      for (const t of doc.weights.keys()) curatedFreq.set(t, (curatedFreq.get(t) ?? 0) + 1);
    }
    documents.push({ ...doc, length });
  };

  // Retired map from the SAME corpus. Tombstone lines are not indexed
  // at all (they are bookkeeping, not content); every other doc carries
  // its retired state so search can hide it in everyday recall.
  const retired = memory.retiredMap(rawEntries.map((r) => r.entry));

  for (const r of rawEntries) {
    if (memory.isClosingLine(r.entry)) continue;
    const info = r.entry.id ? retired.get(r.entry.id) : null;
    // **The per-entry decision (P28).** Detected from the entry's OWN
    // weighted fields — never from `language`/`lang` above, and never
    // hand-set anywhere: this is the only place a document's language
    // comes from, so there is no second copy of it to drift out of
    // sync. CERTAIN gets exactly that language's pack, matching what a
    // correctly-configured single-language memory already got.
    // UNCERTAIN gets every detectable pack — see `packsFor`.
    const langInfo = detectEntryLanguage(r.entry, { fieldWeights: FIELD_WEIGHTS });
    addDoc({
      ...r,
      lang: langInfo.language,
      langCertain: langInfo.certain,
      weights: fieldsOfEntry(r.entry, { langs: packsFor(langInfo), lexicons }),
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
  // The expensive section: measured in the sibling memory on
  // 2026-09-12 at about 3.0 of 4.9 seconds, because every capture
  // archive has to be read and decompressed. It grows with every
  // session, and when it crosses the recall deadline the hook goes
  // quiet. This is the number to ask for first.
  profile.measure('index', 'raw', () => {
    let n = 0;
    for (const doc of rawDocuments(root, lexicons)) { addDoc(doc); n += 1; }
    return n;
  }, { count: (n) => n });

  const tagGraph = thesaurus.buildTagGraph(rawEntries.map((r) => r.entry));

  // The learned co-occurrence thesaurus, over the structured entries only.
  // Captures are deliberately excluded: they are raw transcript, and their
  // boilerplate and tool output would dominate the statistics and teach the
  // graph associations that say more about the terminal than about the work.
  // Stopwords of EVERY detectable language, not just the configured
  // default: documents are no longer all tokenised with the same pack
  // (P28), so a term graph that only knew the configured language's
  // filler would let the OTHER language's stopwords straight through
  // wherever a document actually used it. Stemmed AND unstemmed: the
  // graph works on stemmed terms, so a raw list of stopwords misses them
  // all — "because" never matches the "becaus" that actually sits in the
  // index, and the filler sails straight through.
  const stopwords = new Set();
  for (const p of new Set([lang, ...DETECTABLE_PACKS])) {
    for (const w of p.stopwords) {
      stopwords.add(w);
      stopwords.add(p.stem(p.normalize(w)));
    }
  }
  const termGraph = thesaurus.buildTermGraph(
    documents.filter((d) => d.type !== 'raw').map((d) => d.weights),
    { stopwords });

  // The exact index over machine-shaped identifiers. It counts nothing
  // and weighs nothing — it only remembers where a string occurs.
  const entityIndex = entity.buildIndex(documents, entityText);

  return {
    documents,
    docFreq,
    lexicon,
    lexicons,
    tagGraph,
    termGraph,
    entityIndex,
    language: lang.name,
    N: documents.length,
    avgLength: documents.length ? lengthSum / documents.length : 1,
    // What BM25 sees as "rare" and "long" comes from the curated part of
    // the memory — not from raw capture.
    //
    // Raw capture is a transcript, not a statement. It grows with every
    // session, it contains every question verbatim, and it is exactly
    // the material that makes the words of the most-asked questions
    // common. Letting it determine the idf makes the curated entry lose
    // its edge over thematic neighbours — and precisely for the
    // questions asked most often.
    //
    // Measured on the eval corpus (39 raw captures carrying the asked
    // words): gold-in-context 11/33 -> 8/33, without a single receipt
    // being issued; the gold entry never even becomes a candidate.
    //
    // That raw capture should not shape the statistic was already
    // decided here — `termGraph` excludes it. Only docFreq, N and
    // avgLength did not. Raw captures are still FOUND; they are simply no
    // longer consulted on what counts as a rare word.
    statsN: curatedN || documents.length,
    statsDocFreq: curatedN ? curatedFreq : docFreq,
    statsAvgLength: curatedN ? (curatedLengthSum / curatedN)
      : (documents.length ? lengthSum / documents.length : 1),
    builtAt: new Date().toISOString(),
  };
}

/**
 * The text an exact-identifier index should look at: the entry as
 * written, not the weighted term map. A path survives tokenisation
 * badly — that is the whole reason this index exists — so it must be
 * read from the original strings.
 */
export function entityText(doc) {
  const e = doc?.entry ?? {};
  const teile = [];
  for (const v of Object.values(e)) {
    if (typeof v === 'string') teile.push(v);
    else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') teile.push(x);
  }
  if (doc?.source) teile.push(String(doc.source));
  return teile.join(' ');
}

/** BM25 IDF (with +1 to keep very common terms from going negative). */
/**
 * How far the coordination multiplier may pull a score down.
 *
 * 0 reproduces the pre-2026-09-20 behaviour (a pure product, which
 * annihilates); 1 switches coordination off entirely. The measured
 * window in which both the dilution and the contested fixture pass is
 * [0.50, 0.75] — see the block that uses this constant, and
 * test/coverage-floor.test.mjs, which pins the window itself rather than
 * only this value.
 */
export const COVERAGE_FLOOR = 0.6;

function idf(index, term) {
  const df = index.statsDocFreq ?? index.docFreq;
  const N = index.statsN ?? index.N;
  const n = df.get(term) ?? 0;
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

/** BM25's contribution from one term against one document, IDF x the
 *  length-normalised term frequency. Pulled out so the P28 per-pack
 *  scoring below (see `search`) can call it once per candidate spelling
 *  instead of duplicating the formula. */
function bm25Term(index, doc, term) {
  const f = doc.weights.get(term);
  if (!f) return 0;
  const avg = index.statsAvgLength ?? index.avgLength;
  const norm = f * (K1 + 1) / (f + K1 * (1 - B + B * doc.length / avg));
  return idf(index, term) * norm;
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
/**
 * A hit's identity, for breaking ties in a way that is the same on
 * every machine.
 *
 * **The finding, 2026-09-17.** `test/raw-stats.test.mjs` failed on the
 * macOS runners and nowhere else — twice, on two different node
 * versions, and each time the BASELINE list differed from the previous
 * run as well. Measured cause: six fixture entries score exactly the
 * same, to the last bit (1.6907827160660296). Their order was decided
 * by nothing but sort stability and, inside MMR, by which of two
 * floating-point values happened to be larger.
 *
 * `Math.log` and friends are allowed to differ by one unit in the last
 * place between platforms, and one ULP is enough to flip a comparison
 * between two otherwise identical candidates. For a memory whose whole
 * claim is "the same data gives the same answer", an order that depends
 * on the C library is a defect, not a detail.
 *
 * Source and line are used, not the entry id: every document has them,
 * including raw captures, and together they are unique by construction.
 */
function stableKey(hit) {
  return `${hit.source ?? ''}:${String(hit.line ?? 0).padStart(9, '0')}`;
}

/** Descending by score, ties broken by identity. Total order, always. */
export function byScoreThenIdentity(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ka = stableKey(a); const kb = stableKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/**
 * How close two MMR values have to be to count as the same.
 *
 * Relative, not absolute: the values scale with the score. Two
 * candidates whose values differ only in the last few bits are the
 * same candidate as far as any human reading the result is concerned —
 * and treating them as equal is what lets the deterministic tie-break
 * below decide instead of the platform's maths library.
 */
const MMR_GLEICH = 1e-12;

export function mmrRerank(candidates, { lambda = 0.7, top = 10, simOf } = {}) {
  if (candidates.length <= 1) return candidates.slice(0, top);
  const maxScore = candidates.reduce((m, c) => (c.score > m ? c.score : m), 0);
  const remaining = candidates.map((c) => c);
  const selected = [];
  while (selected.length < top && remaining.length) {
    // **`bestPos = -1`, not `0`, and `bestVal` left unset.**
    //
    // The first version of this change started at `-Infinity` as before
    // — and was broken by it: `Math.abs(-Infinity) * eps` is `Infinity`,
    // `-Infinity + Infinity` is `NaN`, so the greater-than test was
    // false for the FIRST candidate and `bestVal` stayed `-Infinity`.
    // From there on only identity decided, and MMR never ran its own
    // relevance comparison at all. The probe "a REAL difference still
    // decides" caught it; without that probe a fix would have landed
    // that is worse than the bug.
    let bestPos = -1;
    let bestVal = 0;
    for (let p = 0; p < remaining.length; p += 1) {
      const cand = remaining[p];
      const rel = maxScore > 0 ? cand.score / maxScore : 0;
      let maxSim = 0;
      for (const s of selected) {
        const sim = simOf(cand, s);
        if (sim > maxSim) maxSim = sim;
      }
      const val = lambda * rel - (1 - lambda) * maxSim;
      // **Equal here means: equal down to the last bits.**
      //
      // This used to read `val > bestVal`, with a comment saying the
      // earlier-ranked one wins on ties. That held only while the
      // values were BIT-identical. One unit in the last place — exactly
      // what a different maths library produces — turned a tie into a
      // win, one way on one machine and the other way on another.
      if (bestPos === -1) { bestVal = val; bestPos = p; continue; }
      const spanne = Math.max(Math.abs(val), Math.abs(bestVal), 1) * MMR_GLEICH;
      if (val > bestVal + spanne) { bestVal = val; bestPos = p; continue; }
      // A tie down to the last bits: chance does not decide, identity
      // does — and the same way on every machine.
      if (val >= bestVal - spanne && stableKey(cand) < stableKey(remaining[bestPos])) {
        bestVal = val; bestPos = p;
      }
    }
    selected.push(remaining.splice(bestPos, 1)[0]);
  }
  return selected;
}

/**
 * Search. Returns the best `top` hits, descending by score.
 */
const TIERS_KNOWN = new Set(['user', 'system', 'agent', 'external', 'inferred', 'unknown']);

/**
 * May this document be returned AT ALL, whatever lane found it?
 *
 * **The finding (external audit, 2026-09-17).** There are three lanes
 * into this function — the id lane above, the literal/exact lane in
 * `bin/mem find`, and the ranked lane below — and each carried its own
 * idea of which entries are allowed out. Reproduced:
 *
 *   search(index, '<id of a beta error>', {project:'alpha', type:'decision'})
 *
 * returned that beta error. The id lane checked `retired` and nothing
 * else, so project and type were requested and silently ignored. The
 * automatic recall hook goes through `mem find`, so the divergence
 * reached the context an agent is handed without anyone asking for it.
 *
 * The rule is therefore written ONCE, here, and every lane calls it
 * before it returns anything. What stays lane-specific is RANKING: an
 * exact match may skip the relevance floor, because "this is literally
 * the thing you named" is not a score. It may not skip the scope.
 *
 * Adding an option that narrows what may be returned means adding it
 * here. A lane that filters on its own is the defect this replaces.
 */
export function admits(doc, {
  type = null,
  project = null,
  authority = null,
  since = null,
  noRaw = false,
  onlyRaw = false,
  withRetired = false,
} = {}) {
  if (!doc) return false;
  const isRaw = doc.type === 'raw';
  if (doc.retired && !withRetired) return false;
  if (noRaw && isRaw) return false;
  if (onlyRaw && !isRaw) return false;
  if (type && doc.type !== type) return false;
  if (authority !== null) {
    const t = String(doc.entry?.authority ?? 'unknown').toLowerCase();
    if ((TIERS_KNOWN.has(t) ? t : 'unknown') !== authority) return false;
  }
  if (project !== null && project !== undefined) {
    const target = project === 'global' ? null : project;
    if (doc.project !== target) return false;
  }
  if (since) {
    const sinceTs = since instanceof Date ? since.toISOString() : String(since);
    if (!doc.entry?.ts || doc.entry.ts < sinceTs) return false;
  }
  return true;
}

export function search(index, query, {
  top = 10,
  type = null,
  project = null,
  authority = null,      // restrict to one tier — used for per-tier candidates
  since = null,
  minScore = 0.01,
  noRaw = false,
  onlyRaw = false,
  withRetired = false,   // include retired (done/discarded/superseded)?
  language = null,
  mmr = false,           // re-rank the top for diversity (MMR)
  mmrLambda = 0.7,       // 1 = pure relevance, 0 = pure diversity
  coverage = 1,          // reward covering more of the TYPED query (0 = off)
  coverageFloor = COVERAGE_FLOOR,  // how far coordination may pull a score down
} = {}) {
  // --- The id lane: asking for an id means asking for ONE entry ----
  //
  // **The finding (2026-09-08, reported by a connected agent.)** It
  // wrote an entry over the bridge and then looked for it with
  // `mem_find <id>`: ZERO hits, even after waiting. The literal search
  // found it at once — but a bridge agent does not have that one.
  // `mem_find` is ranked and nothing else.
  //
  // Cause: the exact-identifier lane knows five shapes (path, version,
  // hyphenated name, number, env var). An entry id like `8hyrg44w8htp`
  // matches none of them. So "write it and find it again" — the loop
  // the whole onboarding check rests on — could not be closed over the
  // bridge at all.
  //
  // **Why a lookup and not a sixth pattern.** An id has no
  // distinguishing shape: a pattern for "twelve alphanumeric
  // characters" would swallow half a dictionary. The question "is this
  // string an id we HOLD?" has zero false positives by construction.
  const maybeId = String(query ?? '').trim();
  if (/^[A-Za-z0-9]{6,20}$/.test(maybeId)) {
    for (const doc of index.documents) {
      if (doc?.entry?.id !== maybeId) continue;
      // The SAME admission rules as every other lane — not a private
      // copy of one of them. Before the audit this line read
      // `if (doc.retired && !withRetired) break;` and nothing else, so
      // an id lookup answered across projects and types that the caller
      // had explicitly excluded.
      if (!admits(doc, { type, project, authority, since, noRaw, onlyRaw, withRetired })) break;
      return [{
        score: 1000,
        type: doc.type,
        project: doc.project,
        source: doc.source,
        line: doc.line,
        entry: doc.entry,
        raw: doc.type === 'raw',
        lang: doc.lang ?? UNCERTAIN,
        langCertain: doc.langCertain ?? false,
        ...(doc.retired ? { retired: doc.retired } : {}),
        exact: ['id'],
      }];
    }
  }

  // **The question is asked against BOTH rule sets (P28), not the one
  // the corpus happens to be configured for.** An explicit `language`
  // still pins it down — `mem find --lang de` stays exact, and stays as
  // cheap as it always was, one pack. Left unset, a query cannot know
  // which of a mixed memory's two languages it was typed in any better
  // than an entry can, so it gets every detectable pack rather than
  // guessing at the corpus default the way `index.language ?? 'en'`
  // used to. See `tokenizeGroupsMulti` for how one typed word still
  // counts as one word: the extra pack adds FORMS to try, not extra
  // groups for `coverage` to divide by.
  const queryPacks = language ? [pack(language)] : DETECTABLE_PACKS;
  const queryLexicons = index.lexicons
    ?? (index.lexicon ? new Map([[index.language, index.lexicon]]) : new Map());
  // Grouped BY TYPED WORD, and — inside each word — by PACK: `groups[i]`
  // is `[[en's forms], [de's forms], ...]` for word `i`. `coverage`
  // below only needs to know THAT a word matched, so it flattens each
  // word's packs together; the score loop keeps them apart on purpose —
  // see its own comment for why an alternate spelling from a second
  // rule set must never be allowed to add a SECOND match for one word.
  const groups = tokenizeGroupsPacked(query, { lexicons: queryLexicons, langs: queryPacks });
  const own = groups.flatMap((packVariants) => packVariants.flat());
  if (own.length === 0) return [];
  const ownSet = new Set(own);

  // The curated thesaurus is English-only (see `curatedCoverage`'s own
  // doc comment) — a German pack could not look its own words up in it
  // any better, so this leg of expansion stays pinned to English rather
  // than joining the multi-pack query tokenisation above. The learned
  // term graph, expanded via the SAME call, has no such limit: it is
  // keyed by whatever the corpus's documents actually stemmed to, in
  // either language. These are genuinely ADDITIONAL evidence (a
  // different word entirely), so — unlike the language alternates above
  // — they keep stacking additively with the literal score, exactly as
  // before P28.
  const terms = new Map();
  for (const [syn, g] of thesaurus.expand(own, index.tagGraph, pack('en'), index.termGraph)) {
    const stemmed = pack('en').stem(pack('en').normalize(syn));
    if (ownSet.has(stemmed)) continue;   // the original beats the expansion
    terms.set(stemmed, g);
  }

  const now = Date.now();
  const limits = { type, project, authority, since, noRaw, onlyRaw, withRetired };

  const hits = [];
  for (const doc of index.documents) {
    // The tier filter that used to stand here is part of `admits` now.
    // It exists so a caller can generate candidates PER TIER instead of
    // taking the global top-k: a lower tier with enough volume otherwise
    // fills the candidate set before a higher tier is looked at, and no
    // policy applied afterwards can recover a claim that was never a
    // candidate. Measured 2026-09-05 (bench/byzantine.mjs).
    if (!admits(doc, limits)) continue;
    const isRaw = doc.type === 'raw';

    let score = 0;
    // **Literal terms: MAX across packs, SUM across everything else
    // (P28).** `groups[i]` is one typed word's forms, split by which
    // pack produced them. Within a pack, forms still stack exactly as
    // they always have (a hyphen part or a compound part is genuinely
    // separate evidence). ACROSS packs they must NOT: they are two
    // rule sets' competing guesses about the SAME occurrence, and
    // summing them let an UNCERTAIN document — indexed under both
    // `cache` and `cach` — score as though it had matched the word
    // TWICE. Reproduced in `test/coverage-floor.test.mjs`'s contested
    // fixture: pooling put the "cache cache cache" decoy at rank 1
    // ahead of the document actually answering the question.
    for (const packVariants of groups) {
      let best = 0;
      for (const forms of packVariants) {
        let sub = 0;
        for (const t of forms) sub += bm25Term(index, doc, t);
        if (sub > best) best = sub;
      }
      score += best;
    }
    // Expansions (thesaurus, tag graph, term graph): genuinely additional
    // evidence — a different word the query did not type — so these keep
    // stacking additively, unchanged from before P28.
    for (const [term, qWeight] of terms) score += qWeight * bm25Term(index, doc, term);
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
      for (const packVariants of groups) {
        if (packVariants.some((forms) => forms.some((t) => doc.weights.has(t)))) covered += 1;
      }
      // **The floor (2026-09-20).** Until this day the line read
      //
      //     score *= (covered / groups.length) ** coverage;
      //
      // and that is a PRODUCT, so a small factor annihilates. Measured
      // over the atlas anchors at three corpus sizes: with three or more
      // ordinary words in the question the right entry left the top ten
      // entirely — recall@1 went 1.0 -> 0.0. Those are the two standing
      // failures `load.b.recall.diluted3` and `diluted5`.
      //
      // The mechanism, in one line: at five noise words the anchor covers
      // 1 of 6 typed words (0.167) and any filler sentence covers 5 of 6
      // (0.833), so coverage hands the win to the filler. Coverage counts
      // WORDS, not information, and one rare word is worth more than five
      // common ones.
      //
      // Two repairs suggested themselves and BOTH were measured and
      // rejected: switching the multiplier off, and weighting coverage by
      // IDF mass. Each fixes dilution and each loses the case the
      // multiplier exists for — a decoy carrying one query word several
      // times beat the answer carrying all three, pushing the answer from
      // rank 1 to rank 8. (The IDF arm fails for a reason worth keeping:
      // when one query word is rare it holds nearly all the IDF mass, so
      // covering it alone already scores ~1.0. It does not solve the
      // contested case, it restates it.)
      //
      // A floor under the product holds both. Swept in steps of 0.05 at
      // 5,000 and at 20,000 entries, the window where dilution AND the
      // contested case both pass is [0.50, 0.75]; below it k=5 still
      // fails, above it the decoy takes rank 1. 0.6 sits inside with
      // room on both sides.
      //
      // Note the floor does NOT weaken the ordering: covering more still
      // scores strictly higher. It only stops a partial cover from being
      // multiplied down to nothing.
      const share = (covered / groups.length) ** coverage;
      score *= coverageFloor + (1 - coverageFloor) * share;
    }

    // Mild recency bonus: max +15%, halved after 90 days.
    //
    // **The age is counted in WHOLE UTC DAYS, on both sides (2026-09-19).**
    //
    // This continues the tie-break finding of 2026-09-17 one layer up.
    // Down there one unit in the last place of `Math.log` decided the
    // order of six entries that score the same, and `stableKey` put
    // identity in charge instead. This layer kept feeding a far bigger
    // noise into the same comparison, so identity never got to speak.
    //
    // Measured: `logEntry` stamps `ts` at SECOND resolution. A fixture
    // that writes its entries within a third of a second still ends up
    // with one second of spread whenever a second boundary happens to
    // fall between two writes. Through `exp(-ageDays / 90)` that one
    // second becomes a relative score difference of about
    // 0.15 / 90 / 86400 = 1.9e-8 — five orders of magnitude above the
    // MMR tie window, so it decides the order, and which entry it
    // favours depends on nothing but when the scheduler let the write
    // through. Reproduced deterministically by walking the second
    // boundary through the fixture of `test/raw-stats.test.mjs`: every
    // position inside its last block rotates the six tied entries
    // (about 1 failure in 60 runs when left to chance).
    //
    // A second is not a signal this bonus can carry: it is documented in
    // days, `ts` cannot hold anything finer than a second anyway, and
    // which second a write landed in says nothing about the entry. So
    // the age is taken in whole days, and `now` is bucketed exactly like
    // `ts`. Two entries written on the same UTC day then get precisely
    // the same factor — not just while they share a rolling window, but
    // for good — and score equal to the last bit, which is what hands
    // the decision to `stableKey`. Because both sides step together at
    // midnight, the difference between two documents' ages never moves
    // with the passage of time either: their relative order follows from
    // the data alone.
    //
    // The guard against timestamps from the future stays. It now lets
    // through a ts that is ahead by hours but still on today's date,
    // which buys an attacker nothing — writing `now` would have earned
    // the same factor.
    if (doc.entry.ts) {
      const stamped = Date.parse(doc.entry.ts);
      const ageDays = Math.floor(now / 86400000) - Math.floor(stamped / 86400000);
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
      // The detected language this document was actually indexed with —
      // exposed rather than kept internal, so "which rule set answered
      // this" is checkable instead of assumed. `lang` is UNCERTAIN when
      // both rule sets were applied; see `langdetect.mjs`.
      lang: doc.lang ?? UNCERTAIN,
      langCertain: doc.langCertain ?? false,
      ...(doc.retired ? { retired: doc.retired } : {}),
      __w: doc.weights,   // internal: term vector for MMR; stripped below
    });
  }

  hits.sort(byScoreThenIdentity);
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
/**
 * A cheap fingerprint of the corpus, for binding a cursor to a snapshot.
 *
 * **Why byte counts and not a content hash.** The logs are append-only,
 * so any change moves a byte count — and stat is free where reading
 * every line is not. A rewritten line of the same length would slip
 * through here, and that is fine: rewriting history is what the epoch
 * watermark alarms on, a different question with a different answer.
 *
 * What this is for: telling page 2 that it belongs to the same memory
 * page 1 came from. Without it, an append between two pages silently
 * shifts every row, and the caller sees a view that never existed.
 */
export function corpusGeneration(root, { types = null } = {}) {
  const parts = [];
  for (const [rel, info] of indexedFiles(root, { types })) {
    parts.push(`${rel}:${info.bytes}`);
  }
  parts.sort();
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
}

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
    try { st = fs.statSync(piecePath(root, rel)); } catch { continue; }
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
 * **What this does and does not keep exact.** Two layers, and only one of
 * them is exact after an append:
 *
 *   exact        documents, docFreq, lexicon, avgLength. An appended
 *                entry is findable immediately and its term statistics
 *                are the same as a full rebuild would produce.
 *   approximate  tagGraph and termGraph. These are NOT extended here.
 *                They stay exactly as the last full build left them.
 *
 * The graphs are global co-occurrence structures with relative
 * thresholds, so recomputing them means walking the whole corpus — which
 * is the cost this path exists to avoid. Worse, a pair can DROP OUT of
 * the graph as the corpus grows, because significance is relative: at 60
 * documents a corpus had three learned pairs and at 71 it had two.
 * Measured 2026-09-05 by a property test, after a weaker measurement in
 * the round-two audit had reported "no divergence" from too few cases.
 *
 * So `rebuild == incremental` is TRUE for the exact layer and FALSE for
 * ranking until the next full build. REBUILD_AFTER_FRACTION bounds how
 * far ranking can drift; `loadIndex(root, { fresh: true })` removes the
 * drift entirely. The returned index carries `graphsStale` so a caller
 * that needs exactness can tell rather than assume.
 *
 * Returns null when the change is not a pure append — a shrunk file, a
 * changed prefix, a file that disappeared — in which case the caller
 * falls back to a full build. Refusing is always safe; guessing is not.
 */
function appendToIndex(root, index, before, now) {
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
      if (tailHash(piecePath(root, rel), cur.bytes) !== old.tail) return null;
      continue;                       // untouched
    }
    if (cur.bytes < old.bytes) return null;              // shrunk: rewritten
    if (tailHash(piecePath(root, rel), old.bytes) !== old.tail) return null;  // prefix moved
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
    ? [...rawDocuments(root, index.lexicons ?? new Map(), freshRaw)]
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
  // The curated statistic grows only with curated lines. This is exactly
  // where the distinction would otherwise be lost again: the append path
  // is the one the stop hook triggers on EVERY session.
  let statsLengthSum = (index.statsAvgLength ?? index.avgLength) * (index.statsN ?? index.N);
  let statsN = index.statsN ?? index.N;
  const push = (doc) => {
    if (doc.weights.size === 0) return;
    let length = 0;
    for (const g of doc.weights.values()) length += g;
    lengthSum += length;
    for (const t of doc.weights.keys()) index.docFreq.set(t, (index.docFreq.get(t) ?? 0) + 1);
    // The exact index grows along with it: otherwise a freshly written
    // path would only become findable after the next full build.
    for (const b of entity.identifiers(entityText(doc))) {
      let set = index.entityIndex.get(b);
      if (!set) { set = new Set(); index.entityIndex.set(b, set); }
      set.add(index.documents.length);
    }
    if (doc.type !== 'raw') {
      statsN += 1;
      statsLengthSum += length;
      for (const t of doc.weights.keys()) {
        index.statsDocFreq.set(t, (index.statsDocFreq.get(t) ?? 0) + 1);
      }
    }
    index.documents.push({ ...doc, length });
  };
  for (const d of added) {
    if (memory.isClosingLine(d.entry)) continue;
    const info = d.entry.id ? retired.get(d.entry.id) : null;
    // Same per-entry detection as a full build (P28) — an appended
    // entry gets its OWN rule set immediately, not the rule set the
    // rest of the corpus happened to be built with.
    const langInfo = detectEntryLanguage(d.entry, { fieldWeights: FIELD_WEIGHTS });
    push({
      ...d,
      lang: langInfo.language,
      langCertain: langInfo.certain,
      weights: fieldsOfEntry(d.entry, { langs: packsFor(langInfo), lexicons: index.lexicons ?? new Map() }),
      ...(info ? { retired: info } : {}),
    });
  }
  for (const d of rawDocs) push(d);

  index.N = index.documents.length;
  index.avgLength = index.N ? lengthSum / index.N : 1;
  index.statsN = statsN || index.N;
  index.statsAvgLength = statsN ? statsLengthSum / statsN : index.avgLength;
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

/**
 * Rename, and on Windows: try again.
 *
 * **Measured on the Windows runner, 2026-09-17.** The atomic write went
 * in, and Windows answered `EPERM: operation not permitted, rename` —
 * reproducibly, on node 20 and 22, while a reader had the target open.
 * POSIX replaces a file somebody is reading; Windows refuses to.
 *
 * That is worse than the tear it was meant to fix: the write throws,
 * the caller swallows it (an unwritable cache is not an error), and on
 * a Windows machine with an active retrieval hook the index would be
 * rebuilt from scratch every single time — silently, forever.
 *
 * A reader holds the handle for the length of one `readFileSync`, so
 * the refusal is transient. Six attempts with a short wait between them
 * is what closes it. The wait is a backoff, not a measurement: nothing
 * here decides anything by the clock, it only spaces out retries.
 *
 * Whatever is left after the last attempt is thrown on, so the caller's
 * existing "cache is optional" catch still decides what it costs.
 */
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

export function renameWithRetry(from, to, {
  attempts = 6,
  // Both injectable, and only so the probe can DRIVE this rather than
  // read it. A source-level check here is worthless: the first cut of
  // the probe asserted that the word `attempts` appears, and stayed
  // green when the retry was removed entirely.
  rename = fs.renameSync,
  pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  for (let i = 1; ; i += 1) {
    try { rename(from, to); return i; } catch (err) {
      if (i >= attempts || !TRANSIENT_RENAME.has(err.code)) throw err;
      pause(i * 5);
    }
  }
}

/**
 * How many index documents came from each source file, keyed the same
 * way `indexedFiles` keys its map (a path relative to `root`).
 *
 * The one place both `writeCache` and the load-time check below get this
 * number from — computed the same way in both, so they can never drift
 * apart the way two independent counts always eventually do (the exact
 * failure `checkDrawers`'s docstring names for `mem doctor`'s own line
 * count, one file over from this one).
 */
function sourceDocCounts(documents) {
  const out = new Map();
  for (const d of documents) {
    if (!d.source) continue;
    out.set(d.source, (out.get(d.source) ?? 0) + 1);
  }
  return out;
}

/**
 * Does the cache's OWN bookkeeping agree with the documents it is
 * actually carrying?
 *
 * **The finding (SCHWER, 2026-09-19).** Cut one document out of
 * `.mem/search-index.json` and shrink `N` to match — an edit that is
 * internally consistent, and contradicts nothing the file says about
 * itself. `appendToIndex` only ever compares the CURRENT bytes of a log
 * file on disk against the bytes recorded at the last cache write
 * (`before[rel]` vs `now`); if the actual log file has not moved, that
 * comparison passes and the cached `documents` array — tampered or not —
 * is served as-is. A search for the cut entry's own anchor text then
 * goes from 1 hit to 0, `index.N` reports fewer entries than the log
 * actually holds, and nothing says so.
 *
 * The gap is that nothing ties the cached DOCUMENTS back to the cached
 * FILE METADATA that is supposedly what produced them. `writeCache` now
 * records, per file, how many documents it actually contributed
 * (`docs`); this recomputes that same count from the documents just
 * unpacked from the cache and compares. A mismatch means the two halves
 * of the cache disagree with EACH OTHER — not with the log, which is
 * cheap to notice and needs no re-read of any log file — and the honest
 * answer is to distrust the whole cache and rebuild, the same way a
 * version mismatch or a missing `files` entry already does below.
 *
 * Cost: one pass over the already-unpacked `documents` array, which
 * `loadIndex` walks anyway to turn `weights` back into `Map`s — so this
 * adds one counter increment per document already being touched, not a
 * new pass over anything. Measured on a 20k-document cache load
 * (2026-09-19): +0.6 ms over a load that already takes ~140 ms, i.e.
 * noise against the cost of unpacking the cache in the first place.
 */
function docCountsMatch(documents, files) {
  const actual = sourceDocCounts(documents);
  for (const [rel, info] of Object.entries(files)) {
    if ((actual.get(rel) ?? 0) !== (info.docs ?? 0)) return false;
  }
  return true;
}

/**
 * Overwrite every document's `retired` field with what the LOG currently
 * says, never with what the cache happened to bake in.
 *
 * **The finding (SCHWER, 2026-09-19).** Log an entry, `mem done <id>`,
 * `mem find --fresh` (a full rebuild AND a cache write — `retired` lands
 * correctly on the document at that moment), then delete the `retired`
 * field from the CACHED document by hand. `mem find` then serves the
 * retired entry as live again. The cause: `buildIndex` bakes `retired`
 * into the document once, at build time, and `appendToIndex` only ever
 * updates it for entries that a NEWLY read line retires — bytes that
 * were already on disk before this run started are never looked at
 * again. So once a document's `retired` field is in the cache, nothing
 * downstream of a cache HIT ever re-derives it; whatever the cache file
 * says, correct or tampered, is what `search()` and `admits()` see.
 *
 * `mem retrieve` never had this hole, and not by luck: `retrieval.mjs`
 * calls `state.deriveState(root)` — which reads the log itself, fresh,
 * every call, with no cache in the loop at all — and looks status up
 * there instead of trusting anything carried on the hit. That is the
 * module doc's whole point: "THE LOG DECIDES WHAT IS TRUE. THE INDEX
 * DECIDES ONLY WHAT IS FAST TO FIND." The ranked lane of `mem find`
 * (`src/cli/commands/search.mjs`) is the one caller that still read
 * retirement off the INDEX — so the fix belongs where the index is
 * produced, once, rather than in that caller, which would have to
 * remember to ask `state.mjs` on every call site it has.
 *
 * **Cost, measured (2026-09-20, this machine, medians of 20 runs on the
 * Atlas corpus at seed 42).** The number that matters is the added cost
 * on top of an already-warm cache hit, because that is the path this
 * sits in:
 *
 *   entries   cache-hit load   of which deriveState
 *     1,012          10.7 ms                 1.4 ms
 *     5,012          65.8 ms                 6.6 ms
 *    20,012         236.4 ms                32.2 ms
 *
 * So roughly 13 % of a warm load, growing with the LOG (it re-reads every
 * typed file) and not with the index. That is a real cost and it is paid
 * on every ranked `mem find`; it buys the ranked lane the same immunity
 * `mem retrieve` already had — a cache may decide what is FAST to find,
 * never what is RETIRED. Above roughly 100k entries it stops being
 * noise, and the honest answer then is an incremental retirement feed,
 * not a bigger cache; `bench/atlas.mjs --phase ceiling` is where that
 * threshold gets re-measured rather than re-guessed.
 *
 * The figures that stood here before this line were written by a hand
 * that had not run the function — it was defined and never called, so
 * the "3.1 ms -> 8.4 ms" it reported could not have been observed. The
 * class is `behauptet-statt-gemessen`, and it is the reason a cost
 * comment in this house now names its corpus and its date.
 *
 * Applied to every document, not only ones the cache marked retired —
 * the opposite tamper (forging `retired` on a document that is actually
 * still active, to suppress it) needs the same correction, and costs
 * nothing extra since the whole log is read regardless.
 */
function reconcileRetired(root, index) {
  const state = deriveState(root);
  for (const doc of index.documents) {
    const id = doc.entry?.id;
    const info = id ? state.get(id) : null;
    if (info) doc.retired = info;
    else if (doc.retired) delete doc.retired;
  }
  return index;
}

export function loadIndex(root, { fresh = false, language = 'en' } = {}) {
  const cachePath = path.join(root, CACHE_FILE);
  const lang = pack(language);

  const writeCache = (index, files, fullAt) => {
    // Declared out here so the cleanup below can actually name it — a
    // catch block cannot see a const from inside the try, and a cleanup
    // that removes a path nobody wrote is the quietest no-op there is.
    let tmpPath = null;
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      // **Write beside it, then rename.**
      //
      // `rename` is atomic on POSIX; `writeFileSync` straight onto the
      // target path is not. A reader that comes in mid-write — and the
      // retrieval hook reads this very path in parallel — sees half a
      // file, `JSON.parse` throws, and the caller falls back to a full
      // rebuild: expensive, and inside a hook that means hitting the
      // time limit and going silent.
      //
      // Not a theory: measured on the sibling memory with the same
      // shape, a reader in a tight loop saw broken JSON in 2 to 6 of
      // roughly 600 reads, reproducibly, across three runs.
      //
      // The temporary name carries the process and a roll of the dice,
      // because a fixed `.tmp` only moves the tear: two processes
      // rebuilding at once would write the SAME scratch file, and one
      // would rename the other's half.
      tmpPath = `${cachePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify({
        version: CACHE_VERSION,
        language: index.language,
        files,
        fullAt,
        index: {
          ...index,
          documents: index.documents.map((d) => ({ ...d, weights: [...d.weights] })),
          docFreq: [...index.docFreq],
          statsDocFreq: [...index.statsDocFreq],
          entityIndex: entity.pack(index.entityIndex),
          lexicon: [...index.lexicon],
          lexicons: [...(index.lexicons ?? new Map())].map(([code, set]) => [code, [...set]]),
          tagGraph: thesaurus.packTagGraph(index.tagGraph),
          termGraph: thesaurus.packTagGraph(index.termGraph),
        },
      }));
      renameWithRetry(tmpPath, cachePath);
    } catch {
      // An unwritable cache costs speed, not correctness — but a
      // scratch file left lying around costs both, so it goes.
      if (tmpPath) { try { fs.rmSync(tmpPath, { force: true }); } catch { /* nothing to clean */ } }
    }
  };

  // The state of every file the index covers, right now. `docCounts`
  // (from `sourceDocCounts`) is what closes the Case-3 gap above: it is
  // recorded per file so a LATER load can check the documents it just
  // unpacked from the cache against what the cache itself claims they
  // should add up to.
  const now = indexedFiles(root);
  const stateOf = (files, lines, docCounts) => {
    const out = {};
    for (const [rel, info] of files) {
      out[rel] = {
        bytes: info.bytes,
        kind: info.kind,
        type: info.type,
        project: info.project,
        lines: lines ? (lines.get(rel) ?? 0) : countLines(root, rel),
        tail: tailHash(piecePath(root, rel), info.bytes),
        docs: docCounts ? (docCounts.get(rel) ?? 0) : 0,
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
          statsDocFreq: new Map(c.index.statsDocFreq ?? c.index.docFreq),
          entityIndex: entity.unpack(c.index.entityIndex),
          lexicon: new Set(c.index.lexicon),
          lexicons: new Map((c.index.lexicons ?? []).map(([code, arr]) => [code, new Set(arr)])),
          tagGraph: thesaurus.unpackTagGraph(c.index.tagGraph),
          termGraph: thesaurus.unpackTagGraph(c.index.termGraph),
        };
        // Cheap, and checked BEFORE anything else trusts `index.documents`:
        // a cache whose own per-file counts disagree with what it is
        // actually carrying is corrupt regardless of what the log on disk
        // says, and `appendToIndex` below has no way to see that — it only
        // ever compares log bytes, never the documents derived from them.
        // Thrown so the surrounding catch does exactly what it already
        // does for a version mismatch: fall through to a full rebuild.
        if (!docCountsMatch(index.documents, c.files)) {
          throw new Error('cache doc counts do not match the documents it holds');
        }
        const fullAt = c.fullAt ?? index.N;
        const grown = appendToIndex(root, index, c.files, now);

        if (grown && grown.added === 0) {
          return { ...reconcileRetired(root, index), fromCache: true, appended: 0, graphsStale: false };
        }
        // Rebuild rather than append once enough of the corpus is new that
        // the lexicon and the learned graphs would be measurably behind.
        if (grown && index.N <= fullAt * (1 + REBUILD_AFTER_FRACTION)) {
          if (grown.newBytes >= CACHE_WRITE_AFTER_BYTES) {
            const files = stateOf(now, grown.lastLines, sourceDocCounts(index.documents));
            // Line counts for untouched files carry over unchanged.
            for (const [rel, old] of Object.entries(c.files)) {
              if (files[rel] && !grown.lastLines.has(rel)) files[rel].lines = old.lines ?? files[rel].lines;
            }
            writeCache(index, files, fullAt);
          }
          // The learned graphs are NOT extended by an append — see
          // appendToIndex. They are exactly the ones the last full build
          // produced, so ranking lags behind the newest entries even
          // though finding them does not. Saying so is the point: an
          // approximation nobody declares is how a memory starts giving
          // two different answers to the same question.
          return {
            ...reconcileRetired(root, index),
            fromCache: true,
            appended: grown.added,
            graphsStale: grown.added > 0,
          };
        }
      }
    } catch { /* a broken cache is not an error, just a rebuild */ }
  }

  // No `reconcileRetired` here on purpose: this index was just derived
  // from the log itself, a few lines up in `buildIndex`, which applies
  // `memory.retiredMap` to exactly those entries. Re-deriving the same
  // answer from the same file would be the second reading of one truth,
  // and it would cost every cold start a log re-read for nothing.
  const index = buildIndex(root, { language });
  writeCache(index, stateOf(now, null, sourceDocCounts(index.documents)), index.N);
  return { ...index, fromCache: false, appended: 0, graphsStale: false };
}

/** Lines in a file — only ever called on a full build. */
function countLines(root, rel) {
  try {
    const text = fs.readFileSync(piecePath(root, rel), 'utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch { return 0; }
}


// ---------------------------------------------------------------------
// Content words: what is left of a spoken question
//
// **The finding (2026-09-05).** The retrieval hook pushed the user's
// whole message into BM25. In a 45-word conversational sentence maybe
// three words carry the question; the rest is connective tissue that
// appears in EVERY entry and therefore distinguishes nothing. BM25 does
// weight rare terms higher, but with enough filler the mass wins.
//
// Nothing is stripped that could be a subject: technical terms, proper
// nouns, verbs with content all stay. When in doubt a word survives — one
// word too many costs a little rank, one word too few costs the hit.

const FILLER = new Set([
  // articles, pronouns, prepositions, conjunctions
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'its', 'we', 'us',
  'our', 'you', 'your', 'they', 'them', 'their', 'he', 'she', 'his', 'her',
  'and', 'or', 'but', 'so', 'if', 'then', 'than', 'as', 'because', 'while',
  'with', 'without', 'for', 'from', 'into', 'onto', 'about', 'over', 'under',
  'between', 'through', 'against', 'upon', 'per', 'via',
  // auxiliaries and all-purpose verbs
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'have', 'has', 'had', 'do', 'does', 'did', 'done',
  'can', 'could', 'will', 'would', 'shall', 'should', 'may', 'might', 'must',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'give',
  'go', 'goes', 'want', 'need', 'let', 'put', 'use', 'using', 'see', 'look',
  // vague filler that appears in every entry
  'just', 'also', 'still', 'only', 'even', 'very', 'really', 'quite', 'maybe',
  'perhaps', 'actually', 'simply', 'always', 'never', 'again', 'more', 'most',
  'less', 'much', 'many', 'some', 'any', 'all', 'both', 'each', 'other',
  'here', 'there', 'now', 'today', 'yesterday', 'tomorrow', 'thing', 'things',
  'good', 'better', 'best', 'nice', 'please', 'thanks', 'like', 'well',
  'what', 'which', 'who', 'when', 'where', 'why', 'how', 'not', 'no', 'yes',
  // German, because captures are bilingual
  'der', 'die', 'das', 'und', 'ist', 'nicht', 'auch', 'noch', 'aber', 'wir',
  'ich', 'mit', 'ein', 'eine', 'dass', 'wie', 'was', 'schon', 'nur', 'mal',
]);

const SHORT_OK = new Set(['mem', 'pwa', 'api', 'css', 'git', 'vm', 'ui', 'ux', 'js', 'id']);

/** Content words: at least four characters, not filler. */
export function contentWords(text) {
  const raw = String(text ?? '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out = [];
  for (const w of raw) {
    if (FILLER.has(w)) continue;
    if (w.length >= 4 || SHORT_OK.has(w)) out.push(w);
  }
  // Drop duplicates, keep order: saying "topic" three times must not make
  // the question three times as heavy as it is.
  return [...new Set(out)];
}

/**
 * The question as retrieval should ask it.
 *
 * Capped past a handful of words — but NOT by position. That was the
 * first draft and it was wrong: in German (and often in English) the
 * subject arrives late in the sentence, so taking the first eight words
 * threw away the very word the question was about.
 *
 * Ranked by RARITY instead: the words appearing in the fewest entries
 * carry the question. That is the same quantity BM25 weights by
 * afterwards, and it comes free from the existing index.
 *
 * With nothing left after stripping ("yes", "do that"), the original
 * question comes back — better a vague search than none.
 */
export const RETRIEVE_WORDS_MAX = 8;

export function retrievalQuery(text, { root = null, index = null } = {}) {
  const w = contentWords(text);
  if (!w.length) return String(text ?? '').trim();
  if (w.length <= RETRIEVE_WORDS_MAX) return w.join(' ');

  let idx = index;
  if (!idx && root) {
    try { idx = loadIndex(root); } catch { idx = null; }
  }
  const df = idx.statsDocFreq ?? idx.docFreq;
  if (!idx || !df) return w.slice(0, RETRIEVE_WORDS_MAX).join(' ');

  // From the CURATED statistic, for the same reason as the idf — and it
  // weighs heavier here. BM25 shifts a rank; this cut drops a word
  // entirely. Raw capture contains every question verbatim, so it makes
  // exactly the words that carry the question common, and those are
  // exactly the ones that would then fall out of the eight kept.
  //
  // Through the SAME tokenisation as the index, or the lookup misses on
  // an ending and every word would look equally rare. A word the index
  // does not know at all is maximally rare — and often exactly the
  // technical term being asked about.
  const rarity = (x) => {
    let lowest = Infinity;
    for (const t of tokenize(x)) lowest = Math.min(lowest, df.get(t) ?? 0);
    return Number.isFinite(lowest) ? lowest : 0;
  };
  return [...w].sort((a, b) => rarity(a) - rarity(b)).slice(0, RETRIEVE_WORDS_MAX).join(' ');
}

/**
 * Exact identifier hits, as ordinary hits.
 *
 * Deliberately NOT a scoring path: these carry the BM25 score they would
 * have had (often near zero) plus the list of identifiers that matched.
 * The gateway decides what to do with them — here we only say WHICH
 * documents contain the exact string the question named.
 *
 * `slots` is the answer size, and it is the whole bound: an identifier
 * in more documents than there are slots is not identifying, it is
 * furniture. No free parameter, nothing to calibrate.
 *
 * **The lane is ordered INSIDE, and it did not used to be.** The comment
 * above always claimed these hits "carry the BM25 score they would have
 * had"; the code set `score: 0` on every one of them and handed them
 * back in index order. Both callers put the lane in front unchanged, so
 * whichever document happened to sit earlier in the file won.
 *
 * Measured in lucky-mem on 2026-09-07, same code, same shape: a question
 * naming `1029` matched seven entries. A zip-bomb note (BM25 2.26) came
 * out at rank 2, the entry that answered the question (19.96) at rank 5,
 * and the strongest of the whole lane (36.26) at rank 7. A briefing that
 * takes the top three per question lost the answer — not because search
 * missed it, but because the lane buried it.
 *
 * Seven mentions are not certainty, they are a topic. The lane still goes
 * in front — a named identifier beats a guess — but the order INSIDE it
 * follows the score. Same split as MMR and the raw reserve: the lane
 * decides the SELECTION, the score decides the order within it.
 *
 * The scores come from one extra `search()` pass rather than from a list
 * the caller hands in. That is deliberate: `mem find` and `retrieve()`
 * have drifted apart twice already (see test/paths-agree.test.mjs), and a
 * parameter each caller has to fill correctly is a third chance. The pass
 * is BM25 over an in-memory index; it costs what it costs and nobody has
 * to remember anything.
 *
 * **And it takes the scope, since 2026-09-17.** The external audit ran
 *
 *   mem find src/payments.mjs --project alpha --type decision --json
 *
 * and got back a beta ERROR alongside the alpha decision, plus — with the
 * decision retired and no `--with-retired` — the retired one too. This
 * lane had no filters at all, and `mem find` puts it in FRONT, so the
 * filters the user typed were not merely weakened, they were overruled.
 * The automatic recall hook goes through this path.
 *
 * What the lane may still skip is the RELEVANCE floor: "you named this
 * literally" is not a score, which is the reason the lane exists. Scope
 * is a different question and is answered by `admits`, once, for every
 * lane.
 */
export function exactHits(index, query, slots, limits = {}) {
  const found = entity.hits(index.entityIndex, query, slots);
  if (!found.size && !found.length) return [];
  // minScore 0: a lane hit is often exactly the document BM25 rates near
  // zero — that is the whole reason the lane exists.
  const scores = new Map();
  for (const h of search(index, query, {
    top: index.N ?? index.documents.length, minScore: 0,
    withRetired: true, mmr: false,
  })) scores.set(`${h.source}:${h.line}`, h.score);
  const out = [];
  for (const [i, which] of found) {
    const doc = index.documents[i];
    if (!doc) continue;
    if (!admits(doc, limits)) continue;
    out.push({
      score: scores.get(`${doc.source}:${doc.line}`) ?? 0,
      type: doc.type,
      project: doc.project,
      source: doc.source,
      line: doc.line,
      entry: doc.entry,
      raw: doc.type === 'raw',
      pending: doc.pending ?? false,
      lang: doc.lang ?? UNCERTAIN,
      langCertain: doc.langCertain ?? false,
      ...(doc.retired ? { retired: doc.retired } : {}),
      exact: which,
      __w: doc.weights,
    });
  }
  out.sort(byScoreThenIdentity);
  return out;
}

/**
 * Is this hit essentially the question itself?
 *
 * The retrieval hook runs on EVERY message, and the stop hook files every
 * message as a raw capture. So the next time something similar is asked,
 * the best hit is the user's own sentence from before. Measured on
 * 2026-09-05: 13 of 18 injected hits were such echoes.
 *
 * They are not wrong — they really are in the memory — but they answer
 * nothing. A block that hands you back your own question gets skimmed
 * past after the third time, and then the whole retrieval is gone.
 *
 * Overlap is measured in ONE direction: how much of the HIT is already in
 * the question. A long entry that happens to contain the question stays;
 * only the short echo falls.
 *
 * How often this actually fires, measured 2026-09-06 on 483 real captures
 * from a working memory with 211 hand-typed user messages as questions:
 * 27 of 535 injected hits = 5.0% (95% 3.5-7.2). The 13/18 above was one
 * session and a corpus where each capture held a single message; with a
 * capture per session (12 messages) the rate is 0.0% (95% 0.0-0.2). See
 * eval/README.md — the number is small, and stating it as 72% would be
 * selling the filter on the best case it has.
 */
export const ECHO_OVER = 0.7;

export function isEcho(questionText, hitText, { threshold = ECHO_OVER } = {}) {
  const q = new Set(contentWords(questionText));
  const h = contentWords(hitText);
  if (!q.size || h.length < 3) return false;
  let inside = 0;
  for (const w of h) if (q.has(w)) inside += 1;
  return inside / h.length >= threshold;
}

/**
 * The echo policy itself — one place, so both recall paths obey the same
 * one. `mem find` and `retrieve()` each carried their own copy of this
 * decision, and each drifted from the other within a day.
 *
 * Two things it settles:
 *
 * 1. ONLY raw captures. A typed entry is by construction not the user's
 *    question: it went through the digest or was filed deliberately.
 *    Without the restriction a genuine claim falls — the question
 *    "zahlung vorkasse entscheidung" against the decision "zahlung nur
 *    per vorkasse — meine entscheidung" is three of four content words,
 *    0.75 over the 0.7 threshold.
 *
 * 2. The CAPTURED text, not the record around it. A raw hit carries a
 *    synthetic title (`[raw] <file>.jsonl.gz`) that no question contains.
 *    Counting it dilutes the one-directional overlap with words that
 *    cannot match: a capture holding the question verbatim scored 0.53
 *    with the title and 1.00 without — the filter would have passed the
 *    purest echo there is.
 */
export function isEchoHit(questionText, hit, opts = {}) {
  if (!hit || !(hit.type === 'raw' || hit.raw === true)) return false;
  return isEcho(questionText, String(hit.entry?.text ?? ''), opts);
}

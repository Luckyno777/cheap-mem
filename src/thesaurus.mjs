/**
 * thesaurus — word associations without a model.
 *
 * Two sources:
 *
 *   1. **Thesaurus** (static, curated). Hand-picked groups for the
 *      domain this tool lives in: software work. A wrong synonym group
 *      poisons every future search, so new entries are added by hand,
 *      never automatically.
 *
 *   2. **Tag graph** (learned, automatic). From the co-occurrence of
 *      `tags` fields in your own corpus. If `ci` and `flake` show up
 *      together twelve times, they are associated — derived from YOUR
 *      data, not from someone else's model. That is the actual trick:
 *      semantic proximity without a semantic model.
 *
 * No network, no cost, deterministic.
 */

/**
 * Every row is an equivalence group — all words in it expand to each
 * other.
 *
 * **Rule for additions:** only if the words really mean the same thing
 * in this context. "fast" and "cheap" do not belong together even
 * though they often co-occur — that is what the tag graph is for.
 *
 * Single words only. A multi-word entry can never match, because
 * queries are split into single tokens.
 *
 * **No word may appear in two groups.** Expansion is transitive
 * through a shared word: if `memory` sat in both the RAM group and the
 * recall group, a search for `heap` would pull in `remember`. That
 * merge is invisible in the source — you only notice it as search
 * results that make no sense. A test enforces the rule; when a word
 * genuinely has two senses, pick the one this corpus means and let the
 * tag graph learn the other from your own data.
 *
 * Users extend this per memory via `.mem/thesaurus.json`; see
 * `loadUserGroups`.
 */
export const THESAURUS = Object.freeze([
  // Failure shapes
  ['error', 'bug', 'defect', 'broken', 'problem', 'failure', 'fault'],
  ['flake', 'flaky', 'intermittent', 'sporadic', 'unstable', 'unreliable'],
  ['timeout', 'hang', 'hung', 'stuck', 'blocked', 'deadlock', 'frozen'],
  ['crash', 'panic', 'abort', 'segfault', 'died', 'killed'],
  ['leak', 'leaking', 'unbounded', 'growing', 'oom'],
  ['race', 'racy', 'concurrent', 'interleaving'],
  ['regression', 'regressed', 'broke', 'worse'],

  // State / lifecycle
  ['start', 'begin', 'launch', 'boot', 'startup', 'init'],
  ['stop', 'shutdown', 'halt', 'terminate', 'teardown'],
  ['restart', 'reboot', 'relaunch', 'bounce'],
  ['done', 'finished', 'complete', 'completed', 'shipped', 'merged'],
  ['open', 'pending', 'outstanding', 'todo', 'unfinished'],
  ['waiting', 'stalled', 'gated', 'queued'],

  // Build / delivery
  ['build', 'compile', 'compilation', 'bundling'],
  ['deploy', 'release', 'ship', 'rollout', 'publish'],
  ['test', 'testing', 'check', 'verify', 'verification', 'assertion'],
  ['ci', 'pipeline', 'workflow', 'action', 'runner', 'job'],
  ['merge', 'pr', 'pull-request', 'mr', 'patch'],
  ['branch', 'ref', 'head'],
  ['rollback', 'revert', 'undo', 'backout'],

  // Performance
  ['slow', 'sluggish', 'latency', 'lag', 'delay'],
  ['fast', 'quick', 'speedy', 'throughput'],
  ['ram', 'heap', 'allocation', 'gc'],

  // Security
  ['secret', 'token', 'credential', 'key', 'password'],
  ['exposure', 'disclosure', 'exfiltration'],
  ['auth', 'authentication', 'authorization', 'login', 'signin'],
  ['permission', 'access', 'privilege', 'grant', 'scope'],

  // Data
  ['database', 'db', 'datastore', 'store', 'storage', 'persistence'],
  ['query', 'lookup', 'search', 'find', 'retrieval'],
  ['index', 'indexing', 'indexed'],
  ['migration', 'schema', 'ddl'],

  // Decisions and reasoning
  ['decision', 'decided', 'chose', 'choose', 'choosing', 'choice', 'picked', 'selected'],
  ['because', 'reason', 'rationale', 'why', 'motivation'],
  ['tradeoff', 'compromise', 'balance', 'cost'],

  // The memory system itself
  ['memory', 'mem', 'recall', 'remember'],
  ['capture', 'raw', 'transcript', 'log'],
  ['digest', 'condense', 'summarize', 'compact'],
  ['duty', 'obligation', 'promise', 'commitment', 'owed'],
  ['learning', 'lesson', 'insight', 'takeaway'],
]);

let userGroups = [];

/**
 * Per-memory extra groups from `.mem/thesaurus.json`.
 *
 * Shape: `[["a","b"],["c","d"]]`. Ignored silently when absent — an
 * optional file that breaks the tool when missing is not optional.
 * A malformed file is NOT silent: a thesaurus that quietly does
 * nothing is worse than one that says it is broken.
 */
export function loadUserGroups(root, fs, path) {
  const p = path.join(root, '.mem', 'thesaurus.json');
  if (!fs.existsSync(p)) { userGroups = []; resetStemIndex(); return { loaded: 0 }; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return { loaded: 0, error: `thesaurus.json is not valid JSON: ${e.message}` }; }
  if (!Array.isArray(raw)) return { loaded: 0, error: 'thesaurus.json must be an array of arrays' };
  const groups = [];
  for (const g of raw) {
    if (!Array.isArray(g)) continue;
    const words = g.map((w) => String(w).toLowerCase().trim())
      .filter((w) => w && !w.includes(' '));
    if (words.length >= 2) groups.push(words);
  }
  userGroups = groups;
  resetStemIndex();
  return { loaded: groups.length };
}

function allGroups() {
  return userGroups.length ? [...THESAURUS, ...userGroups] : THESAURUS;
}

/**
 * Lookup index, keyed by STEM.
 *
 * This is not an optimisation, it is a correctness fix. Query tokens
 * arrive stemmed; the groups are written in plain words. Looking a
 * stemmed token up in the raw groups silently fails for every word
 * whose stem differs from itself — `testing` -> `test`, `deployed` ->
 * `deploy`, `blocking` -> `block`. Those entries were unreachable:
 * present in the file, never once matched.
 *
 * So both sides go through the same stemmer. The index is cached per
 * language, because the stemmer differs per language and rebuilding it
 * on every query would cost more than the search itself.
 */
const stemIndexCache = new Map();

function stemIndex(lang) {
  const key = `${lang.name}:${userGroups.length}`;
  const hit = stemIndexCache.get(key);
  if (hit) return hit;

  const index = new Map();
  for (const group of allGroups()) {
    // Every member's stem points at the whole group. Storing the plain
    // words (not their stems) as neighbours keeps the caller free to
    // stem them again for the actual term lookup.
    for (const word of group) {
      const k = lang.stem(lang.normalize(word));
      if (!index.has(k)) index.set(k, new Set());
      for (const other of group) if (other !== word) index.get(k).add(other);
    }
  }
  stemIndexCache.set(key, index);
  return index;
}

/** Drop the cache — needed after loading user groups. */
export function resetStemIndex() { stemIndexCache.clear(); }

function thesaurusNeighbours(word, lang) {
  const hit = stemIndex(lang).get(word);
  return hit ? [...hit] : [];
}

/**
 * Build the tag graph from tag co-occurrence.
 *
 * Uses normalised pointwise mutual information (nPMI): how much more
 * often do two tags appear together than chance would allow? Requires
 * at least `minPairs` co-occurrences, so a single coincidence never
 * becomes a rule.
 *
 * Weight is capped at 0.5 — a learned association must never outweigh
 * a literal hit.
 */
export function buildTagGraph(entries, { minPairs = 2, maxNeighbours = 8 } = {}) {
  const single = new Map();
  const pairs = new Map();
  let docs = 0;

  for (const e of entries) {
    const tags = normaliseTags(e);
    if (tags.length === 0) continue;
    docs += 1;
    for (const t of tags) single.set(t, (single.get(t) ?? 0) + 1);
    for (let i = 0; i < tags.length; i += 1) {
      for (let j = i + 1; j < tags.length; j += 1) {
        const key = tags[i] < tags[j] ? `${tags[i]} ${tags[j]}` : `${tags[j]} ${tags[i]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  if (docs === 0) return new Map();

  const graph = new Map();
  for (const [key, nAB] of pairs) {
    if (nAB < minPairs) continue;
    const [a, b] = key.split(' ');
    const pA = single.get(a) / docs;
    const pB = single.get(b) / docs;
    const pAB = nAB / docs;
    const pmi = Math.log(pAB / (pA * pB));
    if (pmi <= 0) continue;
    const npmi = pmi / -Math.log(pAB);
    const weight = Math.min(0.5, Math.max(0, npmi) * 0.5);
    if (weight < 0.05) continue;
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    graph.get(a).push([b, weight]);
    graph.get(b).push([a, weight]);
  }

  for (const [tag, neighbours] of graph) {
    neighbours.sort((x, y) => y[1] - x[1]);
    graph.set(tag, neighbours.slice(0, maxNeighbours));
  }
  return graph;
}

/**
 * Does this token look like a WORD, rather than machine debris?
 *
 * Measured against a real 458-entry corpus, the co-occurrence graph's
 * worst output was not wrong associations between words — it was tight,
 * high-scoring clusters of things that are not words at all: git file
 * modes (100644 <-> 100755 <-> chmod), capture filenames and timestamps
 * (2026-08-30t05-52-53z <-> 30t05 <-> 53z <-> gz), shell fragments. They
 * cluster *especially* hard precisely because they always travel together,
 * and nPMI rewards exactly that. No statistic can fix this; only knowing
 * that a query will never usefully expand to "100644" can.
 *
 * So: must start with a letter, be at least three characters, and contain
 * only letters plus internal hyphen/underscore. Anything with a digit is
 * out — domain vocabulary essentially never carries one, machine debris
 * almost always does.
 */
function wordLike(t) {
  return /^\p{L}[\p{L}\-_]{2,}$/u.test(t);
}

/**
 * The learned co-occurrence thesaurus: which CONTENT WORDS hang together
 * in this corpus.
 *
 * **Why this exists.** Query expansion had two legs: a hand-curated
 * synonym list and the tag graph. Both are limited in the same way — the
 * curated list only knows the domain its maintainer wrote synonyms for
 * (for a public tool, that is half-blind for everybody else), and the tag
 * graph is sparse because only tagged entries contribute. This third leg
 * learns relatedness from the full text of the corpus itself: words that
 * keep showing up in the same entry are related, by the same nPMI maths
 * the tag graph already uses. No model, no network, no dependency — it is
 * derived once while the index is built.
 *
 * **Why it is tuned tighter than the tag graph.** Tags are deliberate,
 * short category names; content words are noisy. So: a pair must co-occur
 * more often (`minPairs`), a term must be neither too rare to carry signal
 * nor so common it is a de-facto stopword (`minDocFreq`/`maxDocFraction`),
 * only each document's strongest terms count (`termsPerDoc`, which also
 * keeps pair counting O(N*k^2) instead of quadratic in document length),
 * and the weight ceiling is LOWER (0.35 vs 0.5). A learned association
 * must never outweigh a literal hit — that rule gets stricter, not looser,
 * the noisier the signal.
 *
 * @param docs  array of Map(term -> weight), one per document
 * @returns Map(term -> [[neighbour, weight], ...])
 */
export function buildTermGraph(docs, {
  minPairs = 3,
  maxNeighbours = 6,
  minDocFreq = 3,
  // A term in more than half the corpus is a de-facto stopword. This is
  // only a backstop: nPMI already punishes ubiquity by itself (if two
  // words are both everywhere, pAB/(pA*pB) tends to 1 and the pair falls
  // out at pmi <= 0). Set too tight, this cutoff throws away exactly the
  // domain vocabulary the graph exists to learn.
  maxDocFraction = 0.5,
  termsPerDoc = 40,
  weightCap = 0.35,
  minWeight = 0.10,
  stopwords = null,
} = {}) {
  const n = docs.length;
  if (n < 4) return new Map();   // too little corpus to learn anything honest

  // Pass 1: document frequency, to drop the too-rare and the too-common.
  const docFreq = new Map();
  for (const w of docs) {
    for (const t of w.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const maxDF = Math.max(minDocFreq, Math.floor(n * maxDocFraction));
  const usable = (t) => {
    if (!wordLike(t)) return false;
    if (stopwords && stopwords.has(t)) return false;
    const df = docFreq.get(t) ?? 0;
    return df >= minDocFreq && df <= maxDF;
  };

  // Pass 2: co-occurrence over each document's strongest usable terms.
  const single = new Map();
  const pairs = new Map();
  let counted = 0;
  for (const w of docs) {
    const terms = [...w.entries()]
      .filter(([t]) => usable(t))
      .sort((a, b) => b[1] - a[1])
      .slice(0, termsPerDoc)
      .map(([t]) => t)
      .sort();
    if (terms.length === 0) continue;
    // The probability base must be EVERY document that carries a usable
    // term, not only those with a pair. Counting just the pair-bearing
    // documents makes any surviving pair perfectly correlated inside its
    // own sample — pAB/(pA*pB) collapses to 1, pmi to 0, and the honest
    // associations get dropped by the very filter meant to catch noise.
    counted += 1;
    for (const t of terms) single.set(t, (single.get(t) ?? 0) + 1);
    if (terms.length < 2) continue;
    for (let i = 0; i < terms.length; i += 1) {
      for (let j = i + 1; j < terms.length; j += 1) {
        const key = `${terms[i]} ${terms[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }
  if (counted === 0) return new Map();

  const graph = new Map();
  for (const [key, nAB] of pairs) {
    if (nAB < minPairs) continue;
    const sp = key.indexOf(' ');
    const a = key.slice(0, sp);
    const b = key.slice(sp + 1);
    const pA = single.get(a) / counted;
    const pB = single.get(b) / counted;
    const pAB = nAB / counted;
    const pmi = Math.log(pAB / (pA * pB));
    if (pmi <= 0) continue;
    const npmi = pmi / -Math.log(pAB);
    const weight = Math.min(weightCap, Math.max(0, npmi) * weightCap);
    if (weight < minWeight) continue;
    if (!graph.has(a)) graph.set(a, []);
    if (!graph.has(b)) graph.set(b, []);
    graph.get(a).push([b, weight]);
    graph.get(b).push([a, weight]);
  }

  for (const [term, neighbours] of graph) {
    neighbours.sort((x, y) => y[1] - x[1]);
    graph.set(term, neighbours.slice(0, maxNeighbours));
  }
  return graph;
}

/**
 * Collect an entry's tags. Besides `tags`, the fields `class` and
 * `topic` count as tag-like — they are equally short category names.
 */
function normaliseTags(e) {
  const out = new Set();
  if (Array.isArray(e.tags)) {
    for (const t of e.tags) {
      const s = String(t).toLowerCase().trim();
      if (s) out.add(s);
    }
  }
  for (const field of ['class', 'topic']) {
    const v = e[field];
    if (typeof v === 'string' && v.trim()) out.add(v.toLowerCase().trim());
  }
  return [...out];
}

/**
 * Expand query terms. Returns a list of [word, weight].
 *
 * Weights:
 *   thesaurus neighbour   0.6           (curated, reliable)
 *   tag-graph neighbour   nPMI 0.05..0.5 (learned from tags)
 *   term-graph neighbour  nPMI 0.10..0.35 (learned from full text)
 *
 * All stay below 1.0 — the original word always wins. The term graph is
 * capped lowest because it is the noisiest of the three sources.
 */
export function expand(terms, tagGraph = null, lang = null, termGraph = null) {
  const l = lang ?? { name: 'raw', normalize: (w) => w, stem: (w) => w };
  const own = new Set(terms);
  const out = new Map();
  for (const t of terms) {
    for (const n of thesaurusNeighbours(t, l)) {
      out.set(n, Math.max(out.get(n) ?? 0, 0.6));
    }
    if (tagGraph && tagGraph.has(t)) {
      for (const [n, g] of tagGraph.get(t)) {
        out.set(n, Math.max(out.get(n) ?? 0, g));
      }
    }
    if (termGraph && termGraph.has(t)) {
      for (const [n, g] of termGraph.get(t)) {
        // Never expand onto a word the user already typed: search() would
        // overwrite it anyway, but keeping it out here means the honest
        // count of "what did the expansion add" stays honest.
        if (own.has(n)) continue;
        out.set(n, Math.max(out.get(n) ?? 0, g));
      }
    }
  }
  return [...out];
}

/** For the index cache: Map -> Array and back. */
export function packTagGraph(graph) { return [...graph]; }
export function unpackTagGraph(raw) { return new Map(raw ?? []); }

/**
 * Diagnostics: which tags hang together. For `mem thesaurus --graph`,
 * so you can see what the memory has learned about your own work.
 */
export function graphReport(graph, { top = 20 } = {}) {
  const lines = [];
  const sorted = [...graph.entries()]
    .map(([tag, ns]) => [tag, ns, ns.reduce((s, n) => s + n[1], 0)])
    .sort((a, b) => b[2] - a[2])
    .slice(0, top);
  for (const [tag, ns] of sorted) {
    lines.push(`  ${tag}  ->  ${ns.map(([w, g]) => `${w}(${g.toFixed(2)})`).join(' ')}`);
  }
  return lines.join('\n');
}

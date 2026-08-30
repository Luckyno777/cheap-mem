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
 *   thesaurus neighbour   0.6   (curated, reliable)
 *   tag-graph neighbour   nPMI  (0.05 .. 0.5, learned)
 *
 * Both stay below 1.0 — the original word always wins.
 */
export function expand(terms, tagGraph = null, lang = null) {
  const l = lang ?? { name: 'raw', normalize: (w) => w, stem: (w) => w };
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

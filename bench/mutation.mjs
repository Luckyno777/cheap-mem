// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/mutation.mjs — are the guarantees ENFORCED, or only documented?
//
// A test suite that passes proves the tests pass. It does not prove the
// mechanism under test exists. The only way to tell is to break the
// mechanism on purpose and check that something notices.
//
// Each mutant below disables one guarantee. A mutant that SURVIVES — tests
// still green with the mechanism gone — marks a guarantee that lives in
// documentation and nowhere else.
//
// This found a real one on 2026-09-05: the resource-limit test used 120
// IDENTICAL claims, which body deduplication collapsed into one, so the
// assertion held whether or not the cap existed. It read like proof and
// was worth nothing.
//
//   node bench/mutation.mjs
//
// Restores every file it touches, including on failure.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

export const MUTANTS=[
 { name:'authority: maySupersede always allows',
   file:'src/authority.mjs',
   from:'export function maySupersede(claim, target) {',
   to:'export function maySupersede(claim, target) {\n  if (true) return { ok: true, reason: "MUTANT" };',
   tests:['test/authority.test.mjs'] },

 { name:'capability: admits() always true',
   file:'src/capability.mjs',
   from:'  admits(scope) {',
   to:'  admits(scope) {\n    if (true) return true;',
   tests:['test/retrieval.test.mjs'] },

 { name:'retrieval: drop the disputed filter',
   file:'src/retrieval.mjs',
   from:"    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); return null; }",
   to:"    // MUTANT: filter removed",
   tests:['test/retrieval.test.mjs','test/authority.test.mjs'] },

 { name:'retrieval: drop body deduplication',
   file:'src/retrieval.mjs',
   from:'    const first = seenBody.get(h);',
   to:'    const first = null;  // MUTANT: dedup removed',
   tests:['test/retrieval.test.mjs'] },

 { name:'retrieval: ignore every resource limit',
   file:'src/retrieval.mjs',
   from:'  const want = Math.min(Math.max(1, Number(top) || 1), limits.maxResults);',
   to:'  const want = Math.max(1, Number(top) || 1);  // MUTANT: cap removed',
   tests:['test/retrieval.test.mjs'] },

 { name:'redaction: narrow SEP back to ASCII',
   file:'src/redaction.mjs',
   from:"export const SEP = '[:=\\\\uFF1D\\\\uFF1A\\\\u2236\\\\u02D0\\\\u205D]';",
   to:"export const SEP = '[:=]';  // MUTANT",
   tests:['test/redaction-unicode.test.mjs'] },

 { name:'integrity: stop counting broken lines',
   file:'src/integrity.mjs',
   from:"      catch { broken.push({ file: f.rel, line: i + 1, why: 'not JSON' }); continue; }",
   to:'      catch { continue; }  // MUTANT: silent again',
   tests:['test/integrity.test.mjs'] },

 { name:'integrity: never report cycles',
   file:'src/integrity.mjs',
   from:"      if (!cycles.some((c) => c.join() === ring.join())) cycles.push(ring);",
   to:'      void ring;  // MUTANT',
   tests:['test/integrity.test.mjs'] },

 { name:'environment: merge driver always ok',
   file:'src/environment.mjs',
   from:'export function checkMergeDriver(root) {',
   to:"export function checkMergeDriver(root) {\n  if (true) return check('merge-driver', LAYER.GIT, true, 'MUTANT');",
   tests:['test/environment.test.mjs'] },

 { name:'search: appendToIndex skips docFreq',
   file:'src/search.mjs',
   from:'    for (const t of doc.weights.keys()) index.docFreq.set(t, (index.docFreq.get(t) ?? 0) + 1);',
   to:'    void doc;  // MUTANT: docFreq not updated',
   tests:['test/properties.test.mjs'] },

 { name:'memory: retiredMap ignores replaces_id entirely',
   // Re-anchored 2026-09-20: `applyRetirement` (the function this line
   // lives in) sits at top-level indent now, not nested one level
   // deeper — the anchor's leading four spaces became two. Same line,
   // same guarantee, verified still caught by the tests below.
   // Re-anchored 2026-09-30 (Y4): `applyRetirement` now loops over the
   // three state fields; the same mutant skips the replaces_id pass.
   file:'src/memory.mjs',
   from:'    if (!targetId) continue;',
   to:"    if (!targetId || field === 'replaces_id') continue;  // MUTANT",
   tests:['test/authority.test.mjs','test/properties.test.mjs'] },

 { name:'authority: retires_id/closes_id from a lower tier are allowed again (Y4)',
   file:'src/authority.mjs',
   from:'  if (!outranks(tt, ct)) {',
   to:'  if (true) {  // MUTANT: the target is never protected',
   tests:['test/y4-state-authority.test.mjs'] },

 { name:'epoch: never report a rollback',
   file:'src/epoch.mjs',
   from:"  if (resurrected.length || lostClaims > 0) {",
   to:"  if (false && (resurrected.length || lostClaims > 0)) {  // MUTANT",
   tests:['test/epoch.test.mjs'] },

 { name:'epoch: watermark may move backwards',
   file:'src/epoch.mjs',
   from:"  if (state.status === 'rollback' && !force) {",
   to:"  if (false) {  // MUTANT: no longer refuses",
   tests:['test/epoch.test.mjs'] },

 { name:'semantics: compare across a rules change',
   file:'src/semantics.mjs',
   from:'export function comparable(theirs) {',
   to:'export function comparable(theirs) {\n  if (true) return true;  // MUTANT',
   tests:['test/epoch.test.mjs'] },

 { name:'memory: ignore the write-path authority ceiling',
   file:'src/memory.mjs',
   from:'  const ceiling = authority.ceilingFromEnv();',
   to:'  const ceiling = null;  // MUTANT: ceiling ignored',
   tests:['test/write-ceiling.test.mjs'] },

 { name:'authority: clampTier raises instead of lowering',
   file:'src/authority.mjs',
   from:'  if (rank(t) < rank(ceiling)) return { tier: ceiling, clamped: true, from: t };',
   to:'  if (false) return { tier: ceiling, clamped: true, from: t };  // MUTANT',
   tests:['test/write-ceiling.test.mjs'] },

 // --- semantic mutants: the RULE changed, not the mechanism removed ------
 //
 // Mechanism mutants ask "does the code run?". These ask "does the code
 // mean what the documentation says?" — a boundary flipped, a comparison
 // inverted, a default reversed. That is the class the status-from-hits
 // bug belonged to: every mechanism was present and each one ran.

 { name:'SEM tier order reversed (lower wins)',
   file:'src/authority.mjs',
   from:'export function outranks(a, b) {\n  return rank(a) < rank(b);',
   to:'export function outranks(a, b) {\n  return rank(a) > rank(b);  // MUTANT',
   tests:['test/authority.test.mjs','test/write-ceiling.test.mjs'] },

 { name:'SEM same-author check becomes any-author',
   file:'src/authority.mjs',
   from:"  if (ca !== null && ta !== null && ca === ta) {",
   to:"  if (ca !== null && ta !== null) {  // MUTANT: any author",
   tests:['test/authority.test.mjs'] },

 { name:'SEM outranks becomes >= (equal tier may supersede)',
   file:'src/authority.mjs',
   from:'  if (outranks(ct, tt)) {',
   to:'  if (rank(ct) <= rank(tt)) {  // MUTANT',
   tests:['test/authority.test.mjs'] },

 { name:'SEM clampTier uses <= (clamps an equal tier too)',
   file:'src/authority.mjs',
   from:'  if (rank(t) < rank(ceiling)) return { tier: ceiling, clamped: true, from: t };',
   to:'  if (rank(t) <= rank(ceiling)) return { tier: ceiling, clamped: true, from: t };  // MUTANT',
   tests:['test/write-ceiling.test.mjs'] },

 { name:'SEM valid_until becomes inclusive',
   file:'src/retrieval.mjs',
   from:'  if (Number.isFinite(until) && t >= until) return false;',
   to:'  if (Number.isFinite(until) && t > until) return false;  // MUTANT',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM valid_from becomes exclusive',
   file:'src/retrieval.mjs',
   from:'  if (Number.isFinite(from) && t < from) return false;',
   to:'  if (Number.isFinite(from) && t <= from) return false;  // MUTANT',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM global becomes invisible to a project capability',
   file:'src/capability.mjs',
   from:"    if (id === GLOBAL && this.rights.includes('read')) return true;",
   to:'    // MUTANT: global no longer inherited',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM narrow() may widen',
   file:'src/capability.mjs',
   from:'    const keep = (scopes ?? this.scopes).filter((s) => this.covers(s));',
   to:'    const keep = (scopes ?? this.scopes);  // MUTANT: no filter',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM disputed becomes included by default',
   file:'src/retrieval.mjs',
   from:"    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); return null; }",
   to:"    if (c.status === 'disputed' && withDisputed) { note(c.id, 'MUTANT'); return null; }",
   tests:['test/retrieval.test.mjs','test/authority.test.mjs'] },

 { name:'SEM status read from the RESULT SET, not the log',
   file:'src/retrieval.mjs',
   from:'  const claimState = statusOf(state, e.id);',
   to:"  const claimState = hit.retired?.state ?? 'active';  // MUTANT: the exact bug of 2026-09-05, status back from the index",
   tests:['test/retrieval.test.mjs','test/state.test.mjs'] },
 // (An ARCH-section twin of this mutant, same file/from/to, was removed: it
 // was counted as a second guarantee and ran the same program twice.)

 { name:'SEM author share becomes a flat cap of one',
   file:'src/retrieval.mjs',
   from:'  const cap = Math.max(2, Math.floor(sizeBasis * limits.perAuthorShare));',
   to:'  const cap = 1;  // MUTANT',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM user tier loses its quota exemption',
   file:'src/retrieval.mjs',
   from:"    if (c.authority === 'user' || !c.author) { out.push(c); continue; }",
   to:'    if (!c.author) { out.push(c); continue; }  // MUTANT',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM canonicalBody also folds case',
   file:'src/retrieval.mjs',
   from:"  return String(text ?? '').normalize('NFC').replace(/\\r\\n/g, '\\n').replace(/\\s+/g, ' ').trim();",
   to:"  return String(text ?? '').normalize('NFC').toLowerCase().replace(/\\r\\n/g, '\\n').replace(/\\s+/g, ' ').trim();  // MUTANT",
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM an unrecognised tier ranks FIRST instead of last',
   file:'src/authority.mjs',
   from:'  return i === -1 ? TIERS.length : i;',
   to:'  return i === -1 ? -1 : i;  // MUTANT',
   tests:['test/authority.test.mjs','test/write-ceiling.test.mjs'] },

 { name:'SEM legacy data (no author, no tier) may no longer correct',
   file:'src/authority.mjs',
   from:"  if (ca === null && ta === null) {",
   to:"  if (false) {  // MUTANT",
   tests:['test/authority.test.mjs','test/properties.test.mjs'] },

 { name:'SEM rollback compares COUNTS only, not the retired set',
   file:'src/epoch.mjs',
   from:'  const resurrected = (mark.retiredIds ?? []).filter((id) => !nowRetired.has(id));',
   to:'  const resurrected = [];  // MUTANT: count-only comparison',
   tests:['test/epoch.test.mjs'] },

 { name:'SEM growth and rollback are conflated',
   file:'src/epoch.mjs',
   from:'  const lostClaims = mark.claims - cur.claims;',
   to:'  const lostClaims = 0;  // MUTANT',
   tests:['test/epoch.test.mjs'] },

 { name:'SEM merge driver matched anywhere, not as a whole line',
   file:'src/environment.mjs',
   from:'  const ok = /^\\s*\\*\\.jsonl\\s+merge=union\\s*$/m.test(text);',
   to:'  const ok = /jsonl/.test(text);  // MUTANT',
   tests:['test/environment.test.mjs'] },

 { name:'SEM unknown environment counts as OK under --strict',
   file:'src/environment.mjs',
   from:'  return checks.every((c) => (strict ? c.ok === true : c.ok !== false));',
   to:'  return checks.every((c) => c.ok !== false);  // MUTANT',
   tests:['test/environment.test.mjs'] },

 { name:'SEM a fork is reported as a cycle',
   file:'src/integrity.mjs',
   from:'    if (ids.length > 1) forks.push({ target, by: ids.slice().sort() });',
   to:'    if (ids.length > 1) cycles.push(ids.slice().sort());  // MUTANT',
   tests:['test/integrity.test.mjs'] },

 { name:'SEM candidates no longer generated per tier',
   file:'src/retrieval.mjs',
   from:'  for (const tier of authority.TIERS) {',
   to:'  for (const tier of [null]) {  // MUTANT: global top-k again',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM tier PRECEDENCE instead of representation',
   file:'src/retrieval.mjs',
   from:'    .sort((a, b) => (b.score - a.score) || String(a.id ?? \'\').localeCompare(String(b.id ?? \'\')));',
   to:'    .sort((a, b) => authority.rank(a.authority) - authority.rank(b.authority));  // MUTANT',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM one author saying two things counts as contested',
   file:'src/retrieval.mjs',
   from:'    if (authors.size < 2) continue;',
   to:'    // MUTANT: same-author revision now flagged',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM non-overlapping intervals count as contested',
   file:'src/retrieval.mjs',
   from:'    if (overlapping.length < 2) continue;',
   to:'    // MUTANT: a succession is now a conflict',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM contested claims are dropped instead of flagged',
   file:'src/retrieval.mjs',
   from:'    contested: potentialConflicts(page),',
   to:'    contested: [],  // MUTANT: never flag',
   tests:['test/retrieval.test.mjs'] },

 // --- composed / architectural mutants ------------------------------------
 //
 // These do not remove a mechanism or flip a boundary. They violate an
 // ARCHITECTURAL ASSUMPTION — where state may come from, in what order the
 // layers run, whether a cache may decide meaning. Every fundamental bug
 // found in this project belonged here, and none of the earlier mutants
 // could have caught them.

 { name:'ARCH state derived from the retrieval subset',
   file:'src/state.mjs',
   from:'export function deriveState(root) {',
   to:'export function deriveState(root, hits) {\n  if (hits) return memory.retiredMap(hits);  // MUTANT: the original bug',
   tests:['test/state.test.mjs'] },

 { name:'ARCH state derived once per HIT instead of once per call',
   file:'src/retrieval.mjs',
   from:'  const state = deriveState(root);',
   to:'  const state = new Map();  // MUTANT: no state at all',
   tests:['test/state.test.mjs','test/retrieval.test.mjs','test/authority.test.mjs'] },

 { name:'ARCH scope applied AFTER the result is assembled',
   file:'src/retrieval.mjs',
   from:'    if (!capability.admits(c.scope)) { note(c.id, `outside capability (${c.scope})`); return null; }',
   to:'    // MUTANT: scope checked nowhere',
   tests:['test/retrieval.test.mjs'] },

 { name:'ARCH conflict flagged from the RAW hits, before filtering',
   file:'src/retrieval.mjs',
   from:'    contested: potentialConflicts(page),',
   to:'    contested: potentialConflicts(raw.map((h) => ({ topic: h.entry?.topic, scope: "x", author: h.entry?.author, id: h.entry?.id }))),  // MUTANT',
   tests:['test/retrieval.test.mjs'] },

 // NOTE: an earlier mutant here added an unused `deriveStateForQuery`
 // export. It survived — correctly. Adding a function nobody calls changes
 // no behaviour, so it is an EQUIVALENT mutant and no test can or should
 // catch it. A surviving equivalent mutant is not a coverage gap; treating
 // it as one would push toward tests that assert shapes instead of
 // behaviour. It was replaced by the one below, which changes what the
 // function actually returns.

 { name:'ARCH state derived from only the first drawer',
   file:'src/state.mjs',
   from:'  for (const f of integrity.logFiles(root)) {',
   to:'  for (const f of integrity.logFiles(root).slice(0, 1)) {  // MUTANT',
   tests:['test/state.test.mjs','test/properties.test.mjs'] },

 { name:'SEM curatedCoverage stops stemming its input',
   file:'src/thesaurus.mjs',
   from:'  for (const t of terms) if (thesaurusNeighbours(l.stem(l.normalize(t)), l).length) covered += 1;',
   to:'  for (const t of terms) if (thesaurusNeighbours(t, l).length) covered += 1;  // MUTANT',
   tests:['test/synonyms.test.mjs'] },

 { name:'ARCH gateway stops dropping echoes of the question',
   file:'src/retrieval.mjs',
   from:'  dropEcho = true,',
   to:'  dropEcho = false,  // MUTANT: the query itself comes back again',
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH `mem find` stops dropping echoes by default',
   file:'src/cli/commands/search.mjs',
   from:"    const filtered = args['with-echo']",
   to:"    const filtered = true  // MUTANT: default back to letting everything through\n      || args['with-echo']",
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH echo filter forgets that it is only for raw captures',
   file:'src/search.mjs',
   from:"  if (!hit || !(hit.type === 'raw' || hit.raw === true)) return false;",
   to:"  if (!hit) return false;  // MUTANT: typed entries fall through too",
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH echo check counts the synthetic raw title again',
   file:'src/search.mjs',
   from:"  return isEcho(questionText, String(hit.entry?.text ?? ''), opts);",
   to:"  return isEcho(questionText, `${hit.entry?.title ?? ''} ${hit.entry?.text ?? ''}`, opts);  // MUTANT",
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH raw captures shape the idf again',
   file:'src/search.mjs',
   from:"    statsDocFreq: curatedN ? curatedFreq : docFreq,",
   to:"    statsDocFreq: docFreq,  // MUTANT: raw capture decides what is rare again",
   tests:['test/raw-stats.test.mjs'] },

 { name:'ARCH raw captures shape the length normalisation again',
   file:'src/search.mjs',
   from:"    statsN: curatedN || documents.length,",
   to:"    statsN: documents.length,  // MUTANT: N wieder inklusive Rohfang",
   tests:['test/raw-stats.test.mjs'] },

 { name:'ARCH the append path lets fresh captures back into the stats',
   file:'src/search.mjs',
   from:"    if (doc.type !== 'raw') {\n      statsN += 1;",
   to:"    if (true) {  // MUTANT: every fresh capture counts again\n      statsN += 1;",
   tests:['test/raw-stats.test.mjs','test/search.test.mjs'] },

 { name:'ARCH raw captures compete with curated claims again',
   file:'src/retrieval.mjs',
   from:'  rawReserve = true,',
   to:'  rawReserve = false,  // MUTANT: the capture pushes to the front again',
   tests:['test/raw-reserve.test.mjs'] },

 { name:'ARCH raw captures are dropped from the gateway entirely',
   file:'src/retrieval.mjs',
   from:"       ...ranked.filter((h) => h.type === 'raw' && !exactIds.has(h.entry?.id))]",
   to:"       ]  // MUTANT: the reserve never speaks",
   tests:['test/raw-reserve.test.mjs'] },

 { name:'ARCH the retrieval query asks the raw captures what is rare',
   file:'src/search.mjs',
   from:"  const df = idx.statsDocFreq ?? idx.docFreq;",
   to:"  const df = idx.docFreq;  // MUTANT: the capture decides the eight words",
   tests:['test/raw-stats.test.mjs','test/search.test.mjs','test/retrieval.test.mjs'] },

 { name:'ARCH the exact lane forgets its own bound',
   file:'src/entity.mjs',
   from:'    if (!s || s.size === 0 || s.size > slots) continue;',
   to:'    if (!s || s.size === 0) continue;  // MUTANT: equipment counts as an identifier tooer',
   tests:['test/exact-lane.test.mjs'] },

 { name:'ARCH the gateway drops the exact lane',
   file:'src/retrieval.mjs',
   from:'  const exactMatches = exactHits(idx, useQuery, want, { withRetired: true, ...(cap ? { capability: cap } : {}) });',
   to:'  const exactMatches = [];  // MUTANT: exact hits fall back under the threshold',
   tests:['test/exact-lane.test.mjs'] },

 { name:'ARCH `mem find` drops the exact lane',
   file:'src/cli/commands/search.mjs',
   // Anchored on the line that FOLDS the lane in, not on the call: the
   // call became multi-line when the admission limits went in
   // (2026-09-17), and a one-line anchor over it went quietly missing.
   // This line is the one that decides whether the lane reaches the
   // caller at all.
   from:'    const exactIds = new Set(exactMatches.map((h) => h.entry?.id).filter(Boolean));',
   to:'    const exactIds = new Set(); exactMatches.length = 0;  // MUTANT: only the gateway knows the lane, the hook does not',
   tests:['test/exact-lane.test.mjs'] },

 { name:'SEM identifier patterns swallow ordinary prose',
   file:'src/entity.mjs',
   from:"  { name: 'number', re: /\\b\\d{4,8}\\b/g },",
   to:"  { name: 'number', re: /\\b\\d{1,8}\\b/g },  // MUTANT: every everyday number becomes an identifier",
   tests:['test/exact-lane.test.mjs'] },

 { name:'SEM Frageworte are not indexed at all',
   file:'src/search.mjs',
   from:'  asked: 2.0,',
   to:'  // MUTANT: the field drops out of indexing',
   tests:['test/asked.test.mjs'] },

 { name:'SEM Frageworte outweigh the title',
   file:'src/search.mjs',
   from:'  asked: 2.0,',
   to:'  asked: 5.0,  // MUTANT: geratene Woerter uebersteuern den Gegenstand',
   tests:['test/asked.test.mjs'] },

 { name:'SEM `--asked` is stored flat, as one string',
   // Moved out of bin/mem into src/cli/shell.mjs on 2026-09-18, when the
   // 4503-line CLI was split. mutation-anchors.test.mjs caught both of
   // these the moment the file changed — a mutant that can no longer be
   // applied does not fail, it stops running, and the guarantee behind
   // it quietly stops being checked.
   file:'src/cli/shell.mjs',
   from:"    if ((k === 'tags' || k === 'asked') && typeof v === 'string') {\n      // `asked` are QUESTION WORDS",
   to:"    if (k === 'tags' && typeof v === 'string') {  // MUTANT: asked stays a string\n      // `asked` are QUESTION WORDS",
   tests:['test/asked.test.mjs'] },

 { name:'ARCH gateway falls back to pure BM25 order (no diversity)',
   file:'src/retrieval.mjs',
   from:'  mmr = true,',
   to:'  mmr = false,  // MUTANT: the agent path worse than `mem find` again',
   tests:['test/gateway-diversity.test.mjs'] },

 { name:'ARCH statusOf defaults to active for anything it does not know',
   file:'src/state.mjs',
   from:"  return state.get(id)?.state ?? 'active';",
   to:"  return 'active';  // MUTANT: state ignored entirely",
   tests:['test/state.test.mjs','test/retrieval.test.mjs'] },

 { name:'a switch that narrowly misses a reserved name becomes a field again',
   file:'src/cli/shell.mjs',   // see above, 2026-09-18
   from:'    refuseNearReserved(command, k);',
   to:'    // MUTANT: the typo guard is gone, --projekt becomes a field',
   tests:['test/reserved-typo.test.mjs'] },

 { name:'the near-miss threshold stops depending on length',
   file:'src/switches.mjs',
   from:'export function nearMissThreshold(name) { return name.length >= 6 ? 2 : 1; }',
   to:'export function nearMissThreshold(name) { return name ? 2 : 2; }  // MUTANT',
   tests:['test/reserved-typo.test.mjs'] },

 { name:'the search cache is written straight onto its own path again',
   // Re-anchored 2026-09-20 (B8, the shard-cache migration): the single
   // JSON file and its `renameWithRetry(tmpPath, cachePath)` swap are
   // gone from src/search.mjs. The cache is now a directory of shards,
   // and the atomic swap moved into `indexcache.mjs`'s
   // `writeIndexCache`, as `renameWithRetry(tmpDir, cacheDir)` — see
   // that file's own doc comment. `fs.copyFileSync` cannot stand in for
   // the mutation any more (the target is a directory, not a file), so
   // the mutant now swaps the atomic rename for a non-atomic recursive
   // copy — same defect (the swap is no longer one syscall, so a reader
   // can see a half-written cacheDir), same test catching it.
   file:'src/indexcache.mjs',
   from:'      renameWithRetry(tmpDir, cacheDir);',
   to:'      fs.cpSync(tmpDir, cacheDir, { recursive: true, force: true });  // MUTANT: no longer atomic',
   tests:['test/atomic-cache.test.mjs'] },

 { name:'a rename Windows refuses is no longer retried',
   file:'src/search.mjs',
   from:'      if (i >= attempts || !TRANSIENT_RENAME.has(err.code)) throw err;',
   to:'      throw err;  // MUTANT: first refusal is final',
   tests:['test/atomic-cache.test.mjs'] },

 // ---------------------------------------------------------------------
 // Risk-ordered block (security- and data-critical modules).
 //
 // The catalogue grew by what was easy to break, not by what matters if
 // it breaks: 17 of ~141 modules had a mutant, and `login`, `webauth`,
 // `chain`, `shred`, `append`, `claim`, `writegate`, `pathcheck`,
 // `filelock`, `inbox` and `guard` had none. Each mutant below breaks one
 // promise a user relies on (a token leaves redaction, a wrong password is
 // accepted, a tampered chain reads as fine, plaintext survives a shred, a
 // foreign "done" counts, a path leaves its root). `tests` is the TARGET
 // suite list: a sweep of exactly these mutants needs those suites, not the
 // full suite. Measure: `node bench/mutation.mjs --security`.
 // ---------------------------------------------------------------------

 { name:'redaction: stripe keys are no longer matched',
   file:'src/redaction.mjs',
   from:"['stripe-key',      /\\b[rs]k_(live|test)_[A-Za-z0-9]{20,}/g],",
   to:"['stripe-key',      /\\b[rs]k_(live|test)_[A-Za-z0-9]{2000,}/g],  // MUTANT",
   tests:['test/redaction.test.mjs'] },

 { name:'redaction: secrets inside arrays are not redacted',
   file:'src/redaction.mjs',
   from:'  if (Array.isArray(o)) return o.map((x) => redactObject(x, found));',
   to:'  if (Array.isArray(o)) return o;  // MUTANT',
   tests:['test/redaction.test.mjs'] },

 { name:'redaction: no environment secret is ever collected',
   file:'src/redaction.mjs',
   from:'    out.push({ name, value });',
   to:'    void value;  // MUTANT: nothing collected',
   tests:['test/redaction.test.mjs'] },

 { name:'login: any password matches the stored hash',
   file:'src/login.mjs',
   from:'  return timingSafeEqual(got, want);',
   to:'  return true;  // MUTANT',
   tests:['test/login.test.mjs'] },

 { name:'login: an expired session still counts as signed in',
   file:'src/login.mjs',
   from:'  if (!e || !(e.expires > now)) return { valid: false };',
   to:'  if (!e) return { valid: false };  // MUTANT',
   tests:['test/login.test.mjs'] },

 { name:'login: failed attempts never lock a source out',
   file:'src/login.mjs',
   from:'  const lockMs = (n, from) => (n < from ? 0 :',
   to:'  const lockMs = (n, from) => (true ? 0 :  // MUTANT',
   tests:['test/login.test.mjs'] },

 { name:'webauth: any token compares equal',
   file:'src/webauth.mjs',
   from:'  return timingSafeEqual(ha, hb);',
   to:'  return true;  // MUTANT',
   tests:['test/webauth.test.mjs'] },

 { name:'webauth: a non-loopback bind is allowed without a token',
   file:'src/webauth.mjs',
   from:'  if (isLoopback(host)) return { ok: true };',
   to:'  if (true) return { ok: true };  // MUTANT',
   tests:['test/webauth.test.mjs'] },

 { name:'webauth: a foreign origin passes the POST check',
   file:'src/webauth.mjs',
   from:'  return Boolean(host) && from.host === String(host);',
   to:'  return true;  // MUTANT',
   tests:['test/webauth.test.mjs'] },

 { name:'capability: narrow() keeps scopes the capability does not cover',
   file:'src/capability.mjs',
   from:'    const keep = (scopes ?? this.scopes).filter((s) => this.covers(s));',
   to:'    const keep = (scopes ?? this.scopes);  // MUTANT: widens',
   tests:['test/retrieval.test.mjs'] },

 { name:'capability: covers() ignores descendants:false',
   file:'src/capability.mjs',
   from:'    if (this.scopes.includes(id)) return true;\n    if (this.descendants && this.scopes.includes(GLOBAL)) return true;',
   to:'    if (this.scopes.includes(id)) return true;\n    if (this.scopes.includes(GLOBAL)) return true;  // MUTANT',
   tests:['test/retrieval.test.mjs'] },

 { name:'capability: the global scope is admitted without the read right',
   file:'src/capability.mjs',
   from:"    if (id === GLOBAL && this.rights.includes('read')) return true;",
   to:"    if (id === GLOBAL) return true;  // MUTANT",
   tests:['test/retrieval.test.mjs'] },

 { name:'chain: a seal that does not match the replayed hash counts as ok',
   file:'src/chain.mjs',
   from:'          ok: declared !== null && declared === before,',
   to:'          ok: true,  // MUTANT',
   tests:['test/chain.test.mjs'] },

 { name:'chain: a writer with no seal reads as ok instead of unknown',
   file:'src/chain.mjs',
   from:"    else if (seals.length === 0 || covered === 0) state = 'unknown';",
   to:"    else if (false) state = 'unknown';  // MUTANT",
   tests:['test/chain.test.mjs'] },

 { name:'chain: lines after the last seal are not counted as unsealed',
   file:'src/chain.mjs',
   from:'      unsealedSince: firstBad ? null : (total - covered),',
   to:'      unsealedSince: firstBad ? null : 0,  // MUTANT',
   tests:['test/chain.test.mjs'] },

 { name:'shred: the plaintext body fields stay in the written entry',
   file:'src/shred.mjs',
   from:'  for (const f of Object.keys(present)) delete redacted[f];',
   to:'  void present;  // MUTANT: plaintext stays',
   tests:['test/p14-crypto-shred.test.mjs'] },

 { name:'shred: destroying a key leaves it in the keyring',
   file:'src/shred.mjs',
   from:'    keys.delete(id);',
   to:'    void id;  // MUTANT: the key survives',
   tests:['test/p14-crypto-shred.test.mjs'] },

 { name:'shred: an unreachable keyring is reported as a shredded entry',
   file:'src/shred.mjs',
   from:"    return { state: 'unreadable', reason: 'keyring-absent', fields: null };",
   to:"    return { state: 'unreadable', reason: 'no-key', fields: null };  // MUTANT",
   tests:['test/p14-crypto-shred.test.mjs'] },

 { name:'append: a file without a final newline is no longer healed',
   file:'src/append.mjs',
   from:'    return probe[0] !== 0x0A;',
   to:'    return false;  // MUTANT',
   tests:['test/append-newline.test.mjs'] },

 { name:'append: a short write is no longer truncated back',
   file:'src/append.mjs',
   from:'          fs.ftruncateSync(fd, sizeBefore);',
   to:'          void sizeBefore;  // MUTANT: fragment stays',
   tests:['test/append-enospc.test.mjs'] },

 { name:'append: a short write truncates even when another writer was ahead',
   file:'src/append.mjs',
   from:'      if (sizeNow === ownEnd) {',
   to:'      if (true) {  // MUTANT',
   tests:['test/append-enospc.test.mjs'] },

 { name:'claim: a done by someone who is not the holder counts',
   file:'src/claim.mjs',
   from:"  if (z.by !== holder.claimed_by) return 'done by someone who is not the holder';",
   to:"  // MUTANT: holder check removed",
   tests:['test/claim.test.mjs'] },

 { name:'claim: a done with an old or foreign claim_id counts',
   file:'src/claim.mjs',
   from:"return 'done by someone who is not the holder';\n  if (z.claim_id !== holder.id) {",
   to:"return 'done by someone who is not the holder';\n  if (false) {  // MUTANT",
   tests:['test/claim.test.mjs'] },

 { name:'claim: a second claim takes over while the first is still valid',
   file:'src/claim.mjs',
   from:'      } else if (holder && Date.parse(z.time) < Date.parse(holder.until)) {',
   to:'      } else if (false) {  // MUTANT',
   tests:['test/claim.test.mjs'] },

 { name:'claim: renewals are no longer capped',
   file:'src/claim.mjs',
   from:'  if (Date.parse(z.until) > cap) {',
   to:'  if (false) {  // MUTANT',
   tests:['test/z2-claim-renew.test.mjs'] },

 { name:'writegate: the read-only latch no longer wins over the flag',
   file:'src/writegate.mjs',
   from:'  if (readonly) {',
   to:'  if (readonly && flag !== true) {  // MUTANT',
   tests:['test/writegate.test.mjs'] },

 { name:'writegate: any truthy allowWrites value is read as a yes',
   file:'src/writegate.mjs',
   from:'  if (value === true) {',
   to:'  if (value) {  // MUTANT',
   tests:['test/writegate.test.mjs'] },

 { name:'writegate: the origin check is skipped for writes',
   file:'src/writegate.mjs',
   from:'  if (!webauth.postOriginOk(req.headers.origin, req.headers.host, cfg.origins)) {',
   to:'  if (false) {  // MUTANT',
   tests:['test/writegate.test.mjs'] },

 { name:'pathcheck: a mention with no known tree reads as intact',
   file:'src/pathcheck.mjs',
   from:'  if (!tree) return VERDICT.UNKNOWN;',
   to:'  if (!tree) return VERDICT.INTACT;  // MUTANT',
   tests:['test/pathcheck.test.mjs'] },

 { name:'pathcheck: a URL is read as a mention of a local path',
   file:'src/pathcheck.mjs',
   from:'  /(?<![A-Za-z0-9_./-])((?:src|',
   to:'  /((?:src|',
   tests:['test/pathcheck.test.mjs'] },

 { name:'pathcheck: a dangling path is counted as intact',
   file:'src/pathcheck.mjs',
   from:'      else if (v === VERDICT.DANGLING) rec.dangling.push({ path: m, source, line });',
   to:'      else if (v === VERDICT.DANGLING) rec.intact += 1;  // MUTANT',
   tests:['test/pathcheck.test.mjs'] },

 { name:'filelock: a fresh lock is taken over as if stale',
   file:'src/filelock.mjs',
   from:'  if (age <= staleS) return false;',
   to:'  // MUTANT: no staleness check',
   tests:['test/filelock.test.mjs'] },

 { name:'filelock: nested locks are allowed',
   file:'src/filelock.mjs',
   from:'  if (heldPath !== null) {',
   to:'  if (false) {  // MUTANT',
   tests:['test/filelock.test.mjs'] },

 { name:'filelock: the lock file is created without O_EXCL',
   file:'src/filelock.mjs',
   from:"flag: 'wx', mode: 0o600",
   to:"flag: 'w', mode: 0o600  /* MUTANT */",
   tests:['test/filelock.test.mjs'] },

 { name:'inbox: a message name with a path in it is accepted',
   file:'src/inbox.mjs',
   from:"  if (name.includes('/') || name.includes('\\\\') || name.includes('..')) {",
   to:'  if (false) {  // MUTANT',
   tests:['test/inbox.test.mjs'] },

 { name:'inbox: a message is written to disk without redaction',
   file:'src/inbox.mjs',
   from:'    const r = redaction.redact(v);',
   to:'    const r = { text: v, found: [] };  // MUTANT',
   tests:['test/inbox.test.mjs'] },

 { name:'inbox: a stale state writer still counts',
   file:'src/inbox.mjs',
   from:'    if (z.prior !== state) {',
   to:'    if (false) {  // MUTANT',
   tests:['test/inbox.test.mjs'] },

 { name:'inbox: reopening a closed message needs no reason',
   file:'src/inbox.mjs',
   from:'  if (isDone(current) && newState === STATE.OPEN && !r) {',
   to:'  if (false) {  // MUTANT',
   tests:['test/inbox.test.mjs'] },

 { name:'guard: a latch path may leave the root',
   file:'src/guard.mjs',
   from:'  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {',
   to:'  if (false) {  // MUTANT',
   tests:['test/guards.test.mjs'] },

 { name:'guard: a pattern latch on a missing file is no longer broken',
   file:'src/guard.mjs',
   from:"  if (!there) return { state: 'broken', why: `${rel} does not exist",
   to:"  if (!there) return { state: 'green', why: `${rel} does not exist",
   tests:['test/guards.test.mjs'] },
];

// The modules whose failure is a security or data-integrity failure. The
// measure that matters is "mutants caught per module here", not "share of
// modules with any mutant". `--security` sweeps only these, and only the
// suites each mutant names (no baseline over, and no full run after, the
// rest of the catalogue).
export const SECURITY_MODULES = Object.freeze([
  'redaction', 'login', 'webauth', 'capability', 'chain', 'shred', 'append',
  'claim', 'writegate', 'pathcheck', 'filelock', 'inbox', 'guard',
].map((m) => `src/${m}.mjs`));

// **The catalogue is importable; none of the rest of this file is.**
//
// `test/mutation-anchors.test.mjs` (and `test/readme-zahlen.test.mjs`,
// which reads `MUTANTS.length` to check the README's own count) both
// import this module only to read `MUTANTS` — cheap, without applying a
// single mutant or running a single test. Every effectful line below,
// starting with the baseline check, has to sit behind the SAME
// run-as-a-command gate the mutation sweep already used further down
// (`ALS_BEFEHL`, moved up here so it covers the baseline check too):
// computed BEFORE anything runs, so a bare `import()` of this file does
// nothing observable at all.
//
// The occasion: a bare `import('bench/mutation.mjs')` printed "Mutation
// testing needs a green baseline" and launched a full baseline
// `execFileSync('node', ['--test', ...])` run as a SIDE EFFECT of being
// imported, because only the sweep loop further down was behind
// `ALS_BEFEHL` — the baseline check above it was not. Every run of
// `test/readme-zahlen.test.mjs` was paying for a full baseline test run
// it never asked for, and a transient flake in that baseline (see the
// 2026-09-19 note below) could fail a test file with nothing to do with
// mutation testing at all.
const ALS_BEFEHL = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (ALS_BEFEHL) {

// `--security` or `--only=src/a.mjs,src/b.mjs`: sweep a subset, run only its
// own suites. A survivor is then judged against ITS suites alone (no full
// run to tell "caught elsewhere" from "survived"): it is reported as
// SURVIVED and the person decides - a missing test, or an equivalent mutant.
const ONLY=process.argv.includes('--security') ? SECURITY_MODULES
  : (process.argv.find((a)=>a.startsWith('--only='))?.slice(7).split(',').filter(Boolean) ?? null);
const SWEEP=ONLY ? MUTANTS.filter((m)=>ONLY.includes(m.file)) : MUTANTS;
const perModule=new Map();

// A mutant counts as caught when the tests fail. So on a suite that is
// ALREADY failing, every mutant counts as caught and the score is perfect.
// Found on 2026-09-05 by stripping assertions out of state.test.mjs: one
// test broke, `npm test` went red, and this harness printed 48/48 green.
// A verification tool that scores highest when the thing it verifies is
// broken is worse than none.
{
  const suites=[...new Set(SWEEP.flatMap((m)=>m.tests))];
  try{ execFileSync('node',['--test',...suites],{cwd:ROOT,stdio:['ignore','pipe','pipe'],encoding:'utf8'}); }
  catch(e){
    const out=String(e.stdout||'');
    // The TAP block under a failing test - location, error, the diff -
    // and not just its name.
    //
    // **Measured 2026-09-19 (run 234).** The baseline went red on
    // `raw captures do not change the order of the curated entries`
    // and that one line was the whole report. The test carries two
    // assertions with two very different meanings - a positive control
    // that the fixture finds the answer at all, and the order
    // comparison the test exists for - and both of them carry a
    // message built for exactly this moment. Neither reached the log.
    // Thirty local reruns, a full suite and three runs of this very
    // command could not reproduce it, so the one report there was had
    // to carry the diagnosis, and it carried a name.
    //
    // A harness that says WHICH test broke but not HOW forces the next
    // person to reproduce a failure that may not reproduce.
    const lines=out.split('\n');
    const bad=[];
    for(let i=0;i<lines.length && bad.length<5;i+=1){
      const m=/^not ok [0-9]+ - (.*)$/.exec(lines[i]);
      if(!m) continue;
      const block=[lines[i]];
      // The YAML block belongs to this test: it opens on the next line
      // with '---' and ends at '...'. Bounded, so a malformed block
      // cannot swallow the rest of the output.
      for(let j=i+1;j<lines.length && j<i+40;j+=1){
        block.push(lines[j]);
        if(/^\s*\.\.\.\s*$/.test(lines[j])) break;
      }
      bad.push(block.join('\n'));
    }
    console.log('The suites these mutants rely on are already failing:\n');
    for(const b of bad) console.log(b+'\n');
    console.log('Mutation testing needs a green baseline. On a red suite every');
    console.log('mutant is "caught" by a failure that was there before it.');
    process.exit(1);
  }
}

let survived=0, skipped=0, ambiguous=0, misScoped=0;

// A killed run used to leave the mutant on disk — the header claims every
// file is restored "including on failure", and SIGINT is a failure. One
// interrupted run left `t <= from` in src/retrieval.mjs and the tree looked
// like ordinary work in progress.
let inFlight=null;
const restore=()=>{ if(inFlight){ fs.writeFileSync(inFlight.path, inFlight.orig); inFlight=null; } };
for(const sig of ['SIGINT','SIGTERM','SIGHUP']) process.on(sig, ()=>{ restore(); process.exit(130); });
process.on('uncaughtException', (e)=>{ restore(); throw e; });

console.log('Mutant                                           | do tests fail?');
console.log('-------------------------------------------------+----------------');
// **The catalogue is importable; the sweep is not.** (`ALS_BEFEHL` itself
// now lives at the top of this file, ahead of the baseline check — see
// the comment there. `test/mutation-anchors.test.mjs` and
// `test/readme-zahlen.test.mjs` both rely on importing `MUTANTS` costing
// nothing: no baseline run, no sweep.)
//
// The occasion: a rename on 2026-09-17 left six anchors pointing at
// nothing. The mutants did not fail — they stopped running, and six
// guarantees quietly stopped being checked.
for(const m of SWEEP){
  const p=`${ROOT}/${m.file}`;
  const orig=fs.readFileSync(p,'utf8');
  const hits=orig.split(m.from).length-1;
  // A mutant that cannot be applied proves nothing. It used to be counted
  // as caught, which is how "48/48" stayed green while one guarantee had
  // quietly stopped being tested at all.
  if(hits===0){ skipped++; console.log(`${m.name.padEnd(48)} | ANCHOR GONE — never applied, NOT a pass`); continue; }
  // Two matches means replace() mutates the first and leaves the second,
  // so a green run would say more than it knows.
  if(hits>1){ ambiguous++; console.log(`${m.name.padEnd(48)} | ANCHOR AMBIGUOUS (${hits}x) — only the first would mutate`); continue; }
  inFlight={path:p, orig};
  fs.writeFileSync(p, orig.replace(m.from,m.to));
  let failed=false, detail='';
  try{
    execFileSync('node',['--test',...m.tests],{cwd:ROOT,stdio:['ignore','pipe','pipe'],encoding:'utf8'});
  }catch(e){
    failed=true;
    const out=String(e.stdout||'');
    const n=(out.match(/^not ok /gm)||[]).length;
    detail=` (${n} test${n===1?'':'s'})`;
  }
  let elsewhere=false;
  if(!failed && !ONLY){
    try{ execFileSync('node',['--test'],{cwd:ROOT,stdio:['ignore','pipe','pipe'],encoding:'utf8'}); }
    catch{ elsewhere=true; }
  }
  restore();
  { const r=perModule.get(m.file) ?? {caught:0,total:0}; r.total+=1; if(failed) r.caught+=1; perModule.set(m.file,r); }
  if(!failed && !elsewhere) survived++;
  if(!failed && elsewhere) misScoped++;
  console.log(`${m.name.padEnd(48)} | ${failed?'yes'+detail
    :elsewhere?'not by its own suite — caught elsewhere, list is wrong':'NO — SURVIVED'}`);
}

const applied=SWEEP.length-skipped-ambiguous;
console.log(`\n${applied-survived}/${applied} applied mutants caught by tests`
  + ` (of ${SWEEP.length} defined; ${skipped} anchor gone, ${ambiguous} ambiguous).`);
if(ONLY){
  console.log('\nCaught mutants per module (the measure that matters):');
  for(const [f,r] of [...perModule].sort()) console.log(`  ${f.padEnd(24)} ${r.caught}/${r.total}`);
}
if(survived) console.log(`${survived} surviving mutant(s) = ${survived} guarantee(s) that exist only in documentation.`);
if(skipped||ambiguous) console.log(`${skipped+ambiguous} mutant(s) did not run. An untested guarantee is not a kept one — re-anchor them.`);
if(misScoped) console.log(`${misScoped} mutant(s) name the wrong suite: the guarantee is kept, the bookkeeping is not.`);
if(survived||skipped||ambiguous) process.exitCode = 1;

}

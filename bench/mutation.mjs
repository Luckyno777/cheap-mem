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
   // Re-anchored 2026-10-10: since the doctor memo (src/drawermemo.mjs)
   // both read paths -- memoized and plain -- hand the line to one
   // `visit`, and that is where a NOT_JSON line is counted as broken.
   from:"      if (e === drawermemo.NOT_JSON) { broken.push({ file: f.rel, line: no, why: reasons.get(no) ?? 'not JSON' }); return; }",
   to:'      if (e === drawermemo.NOT_JSON) { return; }  // MUTANT: silent again',
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
   from:"  const ok = attributesOf(text, '*.jsonl').get('merge') === 'union';",
   to:'  const ok = /jsonl/.test(text);  // MUTANT',
   tests:['test/environment.test.mjs'] },

 { name:'alarm-tearing: a torn record on this mount is ignored',
   file:'src/environment.mjs',
   from:"    if (rec.state === 'usable' && !rec.ok) {",
   to:'    if (false) {  // MUTANT: the banner forgets a measured tearing',
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: any usable record, clean or torn, is an error',
   file:'src/environment.mjs',
   from:"    if (rec.state === 'usable' && !rec.ok) {",
   to:"    if (rec.state === 'usable') {  // MUTANT: a clean old measurement alarms",
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: the device of the record is not compared',
   file:'src/environment.mjs',
   from:"  if (dev === null || r.dev !== dev) return { state: 'other' };",
   to:"  if (dev === null) return { state: 'other' };  // MUTANT: a record from another mount counts",
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: a broken record throws',
   file:'src/environment.mjs',
   from:"  try { r = JSON.parse(text); } catch { return { state: 'broken' }; }",
   to:'  r = JSON.parse(text);  // MUTANT: a damaged record takes the doctor down',
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: the filesystem name of the record is not compared',
   file:'src/environment.mjs',
   from:"  if (fsType && r.fsType && fsType.toLowerCase() !== r.fsType.toLowerCase()) return { state: 'other' };",
   to:'  void fsType;  // MUTANT: a record from another named filesystem counts',
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: the record is read without looking at its kind and size first',
   file:'src/environment.mjs',
   from:"  if (!st.isFile() || st.size > APPEND_RECORD_MAX_BYTES) return { state: 'unfit' };",
   to:'  void st;  // MUTANT: a device, a pipe or a huge file is read',
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: the read itself is not bounded',
   file:'src/environment.mjs',
   from:"      if (n > APPEND_RECORD_MAX_BYTES) return { state: 'unfit' };",
   to:'      void n;  // MUTANT: a file that grew after the look is taken as it is',
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: --full keeps no record',
   file:'src/environment.mjs',
   from:'  if (probe.measured) writeAppendRecord(root, probe, { fsType });',
   to:'  void writeAppendRecord;  // MUTANT: the verdict is not kept',
   tests:['test/alarm-tearing.test.mjs'] },

 { name:'alarm-tearing: the record is written in place, not by temp file and rename',
   file:'src/environment.mjs',
   from:"    writeAtomic(path.join(root, APPEND_RECORD_FILE), `${JSON.stringify({",
   to:"    fs.mkdirSync(path.join(root, '.pipeline'), { recursive: true });\n    fs.writeFileSync(path.join(root, APPEND_RECORD_FILE), `${JSON.stringify({  // MUTANT: not atomic",
   tests:['test/alarm-tearing.test.mjs'] },

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
   // Anchored on deriveState itself. It used to sit on the `for` loop of
   // deriveStateMaterialized, the oracle that p11-equivalence compares
   // against: after the P11 rewrite that is not what the product calls, so
   // the mutant changed nothing the suites below look at, survived, and made
   // the sweep run the whole suite for it (the guarantees job, 25 minutes).
   from:'  const files = integrity.logFiles(root).map((f) => f.abs);',
   to:'  const files = integrity.logFiles(root).slice(0, 1).map((f) => f.abs);  // MUTANT',
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
   // Re-anchored with abruf-budget: the ranked lane moved from the CLI handler into src/findcore.mjs, which `mem find`
   // and `mem_find` both call.
   file:'src/findcore.mjs',
   from:"  const filtered = o.withEcho",
   to:"  const filtered = true  // MUTANT: default back to letting everything through\n    || o.withEcho",
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
   from:"  const df = idx?.statsDocFreq ?? idx?.docFreq;",
   to:"  const df = idx?.docFreq;  // MUTANT: the capture decides the eight words",
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
   file:'src/findcore.mjs',
   // Anchored on the line that FOLDS the lane in, not on the call: the
   // call became multi-line when the admission limits went in
   // (2026-09-17), and a one-line anchor over it went quietly missing.
   // This line is the one that decides whether the lane reaches the
   // caller at all.
   from:'  const exactIds = new Set(exactMatches.map((h) => h.entry?.id).filter(Boolean));',
   to:'  const exactIds = new Set(); exactMatches.length = 0;  // MUTANT: only the gateway knows the lane, the hook does not',
   tests:['test/exact-lane.test.mjs'] },

 { name:'SEM identifier patterns swallow ordinary prose',
   file:'src/entity.mjs',
   from:"  { name: 'number', re: /\\b\\d{4,8}\\b/g },",
   to:"  { name: 'number', re: /\\b\\d{1,8}\\b/g },  // MUTANT: every everyday number becomes an identifier",
   tests:['test/exact-lane.test.mjs'] },

 { name:'SEM asked words are not indexed at all',
   file:'src/search.mjs',
   from:'  asked: 2.0,',
   to:'  // MUTANT: the field drops out of indexing',
   tests:['test/asked.test.mjs'] },

 { name:'SEM asked words outweigh the title',
   file:'src/search.mjs',
   from:'  asked: 2.0,',
   to:'  asked: 5.0,  // MUTANT: guessed words outweigh the subject',
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
   tests:['test/redaction.test.mjs','test/mutant-security-gaps.test.mjs'] },

 { name:'redaction: secrets inside arrays are not redacted',
   file:'src/redaction.mjs',
   from:'        return v.map((x) => rec(x, depth + 1, ctx, inner));',
   to:'        return v;  // MUTANT',
   tests:['test/redaction.test.mjs','test/mutant-security-gaps.test.mjs'] },

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
   tests:['test/login.test.mjs','test/mutant-security-gaps.test.mjs'] },

 { name:'login: failed attempts never lock a source out',
   file:'src/login.mjs',
   from:'  const lockMs = (n, from) => (n < from ? 0 :',
   to:'  const lockMs = (n, from) => (true ? 0 :  // MUTANT',
   tests:['test/login.test.mjs'] },

 { name:'webauth: any token compares equal',
   file:'src/webauth.mjs',
   from:'  return timingSafeEqual(ha, hb);',
   to:'  return true;  // MUTANT',
   tests:['test/webauth.test.mjs','test/console.test.mjs'] },

 { name:'webauth: a non-loopback bind is allowed without a token',
   file:'src/webauth.mjs',
   from:'  if (isLoopback(host)) return { ok: true };',
   to:'  if (true) return { ok: true };  // MUTANT',
   tests:['test/webauth.test.mjs','test/console.test.mjs'] },

 { name:'webauth: a foreign origin passes the POST check',
   file:'src/webauth.mjs',
   from:'  return Boolean(host) && from.host === String(host);',
   to:'  return true;  // MUTANT',
   tests:['test/webauth.test.mjs','test/console.test.mjs'] },


 { name:'capability: covers() ignores descendants:false',
   file:'src/capability.mjs',
   from:'    if (this.scopes.includes(id)) return true;\n    if (this.descendants && this.scopes.includes(GLOBAL)) return true;',
   to:'    if (this.scopes.includes(id)) return true;\n    if (this.scopes.includes(GLOBAL)) return true;  // MUTANT',
   tests:['test/retrieval.test.mjs','test/mutant-security-gaps.test.mjs'] },

 { name:'capability: the global scope is admitted without the read right',
   file:'src/capability.mjs',
   from:"    if (id === GLOBAL && this.rights.includes('read')) return true;",
   to:"    if (id === GLOBAL) return true;  // MUTANT",
   tests:['test/retrieval.test.mjs','test/mutant-security-gaps.test.mjs'] },

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

 { name:'append: a short write is cut back again (the F01 truncate returns)',
   file:'src/append.mjs',
   from:'      torn = bytesOnDisk > 0; // 0 bytes without a throw: nothing stands there',
   to:'      fs.ftruncateSync(fd, sizeBefore); torn = false;  // MUTANT: fragment cut, clean-rollback acquittal',
   tests:['test/append-enospc.test.mjs','test/audit-append-rollback.test.mjs'] },

 { name:'append: growth after a throw is no longer named as a tear',
   file:'src/append.mjs',
   from:'      torn = grew > 0; // ambiguous growth: name it, never cut it',
   to:'      torn = false;  // MUTANT',
   tests:['test/append-enospc.test.mjs','test/audit-append-rollback.test.mjs'] },

 { name:'claim: a done by someone who is not the holder counts',
   file:'src/claim.mjs',
   from:"  if (z.by !== holder.claimed_by) return 'done by someone who is not the holder';",
   to:"  // MUTANT: holder check removed",
   tests:['test/claim.test.mjs'] },

 { name:'claim: a done with an old or foreign claim_id counts',
   file:'src/claim.mjs',
   from:"return 'done by someone who is not the holder';\n  if (z.claim_id !== holder.id) {",
   to:"return 'done by someone who is not the holder';\n  if (false) {  // MUTANT",
   tests:['test/claim.test.mjs','test/y0-claim-id.test.mjs'] },

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

 // (Dropped as equivalent: "a fresh lock is taken over as if stale" - removing
 // the `age <= staleS` early return still ends in the `moved <= staleS`
 // put-back and `return false`, so no caller can tell. Replaced by the
 // opposite promise: a dead lock IS taken over.)
 { name:'filelock: a stale lock is never taken over',
   file:'src/filelock.mjs',
   from:'  if (age <= staleS) return false;',
   to:'  if (true) return false;  // MUTANT',
   tests:['test/filelock.test.mjs','test/audit-lock-owner.test.mjs'] },

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
   tests:['test/inbox.test.mjs','test/mutant-security-gaps.test.mjs'] },

 { name:'inbox: a message is written to disk without redaction',
   file:'src/inbox.mjs',
   from:'    const r = redaction.redact(v);',
   to:'    const r = { text: v, found: [] };  // MUTANT',
   tests:['test/inbox.test.mjs','test/mutant-security-gaps.test.mjs'] },

 { name:'inbox: a stale state writer still counts',
   file:'src/inbox.mjs',
   from:'    if (z.prior !== state) {',
   to:'    if (false) {  // MUTANT',
   tests:['test/inbox.test.mjs','test/z3-inbox.test.mjs'] },

 { name:'inbox: reopening a closed message needs no reason',
   file:'src/inbox.mjs',
   from:'  if (isDone(current) && newState === STATE.OPEN && !r) {',
   to:'  if (false) {  // MUTANT',
   tests:['test/inbox.test.mjs','test/z3-inbox.test.mjs'] },

 { name:'guard: a latch path may leave the root',
   file:'src/guard.mjs',
   from:'  if (!target.startsWith(path.resolve(root) + path.sep) && target !== path.resolve(root)) {',
   to:'  if (false) {  // MUTANT',
   tests:['test/guards.test.mjs','test/provenance-guard-heartbeat.test.mjs'] },

 { name:'guard: a pattern latch on a missing file is no longer broken',
   file:'src/guard.mjs',
   from:"  if (!there) return { state: 'broken', why: `${rel} does not exist",
   to:"  if (!there) return { state: 'green', why: `${rel} does not exist",
   tests:['test/guards.test.mjs','test/provenance-guard-heartbeat.test.mjs'] },

 { name:'redaction: a key that ends in pin or pincode is no pin word (userpin, pincode)',
   file:'src/redaction.mjs',
   from:'const PIN_END = /^(.*pin)(?:code|hash|value|number|num|digest|salt)?\\d*$/;',
   to:'const PIN_END = /^$/;  // MUTANT',
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: pincode_hash is no pin key when pincode is not read as a word',
   file:'src/redaction.mjs',
   from:'const PIN_END = /^(.*pin)(?:code|hash|value|number|num|digest|salt)?\\d*$/;',
   to:'const PIN_END = /^(.*pin)$/;  // MUTANT',
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: a key that STARTS with pin (pinned, ping, pins) is read as a pin word',
   file:'src/redaction.mjs',
   from:'const PIN_END = /^(.*pin)(?:code|hash|value|number|num|digest|salt)?\\d*$/;',
   to:'const PIN_END = /^(pin).*$/;  // MUTANT',
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: spin and the other English words that end in pin are pin keys',
   file:'src/redaction.mjs',
   from:'return m !== null && !NOT_PIN_WORDS.has(m[1]);',
   to:'return m !== null;  // MUTANT',
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: a pincode count is no counter (pincode_count: 3 is masked)',
   file:'src/redaction.mjs',
   from:'const rest = words.filter((w) => !isExtraWord(w) && !CREDENTIAL_WORDS.has(w));',
   to:'const rest = words;  // MUTANT',
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: pin with digits behind it (pin1, PIN2) is no pin word',
   file:'src/redaction.mjs',
   from:'const PIN_END = /^(.*pin)(?:code|hash|value|number|num|digest|salt)?\\d*$/;',
   to:'const PIN_END = /^(.*pin)(?:code|hash|value|number|num|digest|salt)?$/;  // MUTANT',
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: pinhash, pinvalue and pinnumber are no pin words',
   file:'src/redaction.mjs',
   from:'const PIN_END = /^(.*pin)(?:code|hash|value|number|num|digest|salt)?\\d*$/;',
   to:'const PIN_END = /^(.*pin)(?:code)?\\d*$/;  // MUTANT',
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: the plural of a pin compound (userpins) is no counter key',
   file:'src/redaction.mjs',
   from:"if (!hit) return words.some(isPinPlural) ? 'counter' : null;",
   to:"if (!hit) return null;  // MUTANT",
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'redaction: the bare word pins is a counter key',
   file:'src/redaction.mjs',
   from:"const isPinPlural = (w) => w.length > 4 && w.endsWith('s')",
   to:"const isPinPlural = (w) => w.length > 3 && w.endsWith('s')",
   tests:['test/redaction-object-keys.test.mjs'] },

 { name:'answercheck: the continuation reason asks for a fix, not for the whole answer again',
   file:'src/answercheck.mjs',
   from:"'Check this now, in the same turn. If it applies, output the WHOLE answer again, corrected, '",
   to:"'Check this now, in the same turn, and fix the answer if it applies. '  // MUTANT",
   tests:['test/answer-check.test.mjs'] },

 { name:'reflect: the model is handed the raw transcript path again',
   file:'bin/mem-reflect',
   from:'TRANSCRIPT_PATH="$MASKED_COPY"\n',
   to:'# MUTANT: the raw path stays\n',
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'reflect: when the masked copy cannot be made the model starts anyway',
   file:'bin/mem-reflect',
   from:'  echo "$LAST_SIZE" > "$MARKER"\n  exit 0\nfi\nTRANSCRIPT_PATH="$MASKED_COPY"',
   to:'  MASKED_COPY="$TRANSCRIPT_PATH"  # MUTANT: fail open\nfi\nTRANSCRIPT_PATH="$MASKED_COPY"',
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'reflect: the hand-in variable with the raw path stays in the model environment',
   file:'bin/mem-reflect',
   from:'\nunset TRANSCRIPT_PATH_ENV\n',
   to:'\n: # MUTANT\n',
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'reflect: the helper is not told the memory root, so a temp directory inside it passes',
   file:'bin/mem-reflect',
   from:'mem-mask-copy.mjs" --root "$CHEAP_MEM_ROOT" "$TRANSCRIPT_PATH"',
   to:'mem-mask-copy.mjs" "$TRANSCRIPT_PATH"',
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'mask-copy: a temp directory inside the memory root is accepted',
   file:'bin/mem-mask-copy.mjs',
   from:"    if (root && isInside(fs.realpathSync.native(dir), fs.realpathSync.native(root)))",
   to:"    if (false && root && isInside(fs.realpathSync.native(dir), fs.realpathSync.native(root)))  // MUTANT\n",
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'reflect: the masked copy is never deleted',
   file:'bin/mem-reflect',
   from:'    node "$HERE/mem-mask-copy.mjs" --clean "$MASKED_COPY" >/dev/null 2>&1 || true\n',
   to:'    : # MUTANT\n',
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'mask-copy: a transcript line is copied unmasked',
   file:'bin/mem-mask-copy.mjs',
   from:'        await put(JSON.stringify(maskEntry(parsed)));',
   to:'        await put(line);  // MUTANT',
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'mask-copy: every plain line is masked alone, a PEM key loses its mask',
   file:'bin/mem-mask-copy.mjs',
   from:'const BLOCK_MAX_LINES = 20000;',
   to:'const BLOCK_MAX_LINES = 1;  // MUTANT',
   tests:['test/reflect-masked-copy.test.mjs','test/small-rest2-cm.test.mjs'] },

 { name:'mask-copy: a bare number or string line is read as a JSON structure',
   file:'bin/mem-mask-copy.mjs',
   from:"return parsed !== null && typeof parsed === 'object' ? parsed : undefined;",
   to:'return parsed;  // MUTANT',
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'mask-copy: a line that is no JSON is copied unmasked',
   file:'bin/mem-mask-copy.mjs',
   from:"      let masked = maskText(text);",
   to:"      let masked = text;  // MUTANT",
   tests:['test/reflect-masked-copy.test.mjs'] },

 { name:'mask-copy: a cut gives up a PEM block that is still open (no END yet): the rest of the key stays in the clear',
   file:'bin/mem-mask-copy.mjs',
   from:"      carry = cut ? openBlockHeader(text) : '';",
   to:"      carry = '';  // MUTANT",
   tests:['test/small-rest2-cm.test.mjs'] },

 { name:'redaction: the short last line of a PEM key (an open block, or one past the 8 KB bound) stays in the clear',
   file:'src/redaction.mjs',
   from:"(?:[A-Za-z0-9+/=]{1,19}(?=[ \\t]*(?:\\r?\\n|\\\\[nr]|$|[\"']|-----END)))?/g],",
   to:"/g],  // MUTANT",
   tests:['test/small-rest2-cm.test.mjs'] },

 { name:'redaction: blanks at the end of the short last line of a PEM key save it',
   file:'src/redaction.mjs',
   from:"{1,19}(?=[ \\t]*(?:\\r?\\n|",
   to:"{1,19}(?=(?:\\r?\\n|",
   tests:['test/small-rest2-cm.test.mjs'] },

 { name:'redaction: pinhashes (the plural of pinhash, in one word) is no counter key',
   file:'src/redaction.mjs',
   from:"|| (w.endsWith('hashes') && isExtraWord(w.slice(0, -2)))",
   to:"|| false",
   tests:['test/small-rest2-cm.test.mjs'] },

 { name:'mask-copy: --clean removes a directory it did not make',
   file:'bin/mem-mask-copy.mjs',
   from:"  if (path.basename(target) !== FILE_NAME || !path.basename(dir).startsWith(DIR_PREFIX)) return false;",
   to:"  // MUTANT: any directory",
   tests:['test/reflect-masked-copy.test.mjs'] },
 { name:'dashboard stamp: the expand suffix stays on (the expanded index turns the stamp)',
   file:'src/dashboard-cache.mjs',
   from:'  if (EXPAND_SUFFIX && base.endsWith(EXPAND_SUFFIX)) base = base.slice(0, -EXPAND_SUFFIX.length);',
   to:'  // MUTANT: suffix kept',
   tests:['test/dash-stamp-r4-cm.test.mjs'] },

 { name:'dashboard stamp: scratch names of a derived cache count as a change',
   file:'src/dashboard-cache.mjs',
   from:"  let base = String(name).replace(SCRATCH_NAME, '');",
   to:'  let base = String(name);  // MUTANT',
   tests:['test/dash-stamp-r4-cm.test.mjs'] },

 { name:'dashboard stamp: the component table, its rebuild lock and log are not derived',
   file:'src/dashboard-cache.mjs',
   from:"  'component-table.json', 'component-table-rebuild.lock', 'component-table-rebuild.log',",
   to:'  // MUTANT: component table not derived',
   tests:['test/dash-stamp-r4-cm.test.mjs'] },

 { name:'recall server codeState: the change time is left out',
   file:'src/recallserver.mjs',
   from:'        if (st.ctimeMs > newestChange) newestChange = st.ctimeMs;',
   to:'        // MUTANT: no ctime',
   tests:['test/dash-stamp-r4-cm.test.mjs'] },
 { name:'live parts: question-confirm makes no part stale (back to rebuild-only)',
   file:'src/dashboard-live.mjs',
   from:"  'question-confirm': ['questions'],",
   to:'  // MUTANT: no part for question-confirm',
   tests:['test/dash-confirm-fresh-cm.test.mjs'] },

 { name:'live parts: the questions part reads the whole store of a compact build',
   file:'src/dashboard-live.mjs',
   from:"      if (work.compact) throw new Error('this store is built compact: its question lists come from the one pass over the store, the rebuild brings the new state');",
   to:'      // MUTANT: compact read whole',
   tests:['test/dash-confirm-fresh-cm.test.mjs'] },

 { name:'question lists: an unreadable list is not named',
   file:'src/dashboard-data.mjs',
   from:"  } catch (e) { reasons.push(`waiting questions not readable: ${e?.message || e}`); }\n  return { openQuestions",
   to:"  } catch { /* MUTANT: silent */ }\n  return { openQuestions",
   tests:['test/dash-confirm-fresh-cm.test.mjs'] },
 { name:'deferred parts: a newer round leaves the old retry waiting (every part fetched twice)',
   file:'assets/dashboard/dashboard.js',
   from:'  partLaterSkipTimer();\n  const entriesRun1 = loadEntriesPart();',
   to:'  const entriesRun1 = loadEntriesPart();  // MUTANT',
   // The logic half first: the guarantees job has no Chromium, the browser probe skips there, and a mutant whose suite
   // only skipped sent the harness through the whole suite (8 min, the job's 25-minute limit; CI run 1103).
   tests:['test/dash-later-once-cm.test.mjs', 'test/dash-later-once-cm-browser.test.mjs'] },

 // CI run 1103: an entry point started through a symlinked directory (every macOS temp dir) printed nothing.
 { name:'entry point: the starter compares argv[1] with import.meta.url as text again',
   file:'src/headless.mjs',
   from:"export { isMain } from './ismain.mjs';",
   to:"import { pathToFileURL } from 'node:url';\nexport const isMain = (metaUrl, argv1 = process.argv[1]) => Boolean(argv1) && metaUrl === pathToFileURL(path.resolve(argv1)).href; // MUTANT",
   tests:['test/ismain-symlink-entry.test.mjs'] },
 // CI run 1103 (Windows): the per-run neutral folder was removed from inside, so it stayed.
 { name:'headless cleanup: the shell stays in the per-run folder it removes',
   file:'bin/_portable.sh',
   from:'    if [ -n "$there" ] && [ "$here" = "$there" ]; then cd .. 2>/dev/null || cd / || true; fi\n',
   to:'    : # MUTANT\n',
   tests:['test/headless-cleanup-cwd.test.mjs'] },
 { name:'headless cleanup (ps1): the location stays in the per-run folder it removes',
   file:'bin/_headless.ps1',
   from:'{ Set-Location -LiteralPath (Split-Path -Parent $Plan.Clean) }',
   to:'{ } # MUTANT',
   tests:['test/headless-cleanup-cwd.test.mjs'] },
 // CI run 1103 (Windows): Git Bash hands XDG_STATE_HOME on in its Windows spelling.
 { name:'tool-missing: a Windows-spelled XDG_STATE_HOME is passed over under Git Bash again',
   file:'install/support/tool-missing.sh',
   from:'        MINGW* | MSYS* | CYGWIN*) state="${XDG_STATE_HOME//\\\\//}" ;;',
   to:'        MINGW* | MSYS* | CYGWIN*) state="$HOME/.local/state" ;; # MUTANT',
   tests:['test/tool-missing-state-win.test.mjs'] },
 { name:'before-edit trace: the JSON.parse message (which quotes the input) is printed again',
   file:'src/beforeedit.mjs',
   from:"why = `not JSON: ${String(e?.name || 'Error').replace(/[^A-Za-z]/g, '')}${at ? ` at position ${at[1]}` : ''}`;",
   to:'why = `not JSON: ${String(e?.message || e).slice(0, 80)}`; void at; // MUTANT',
   tests:['test/before-edit-trace-noleak.test.mjs'] },
 { name:'entry point: the masked copy compares argv[1] with import.meta.url as text again',
   file:'bin/mem-mask-copy.mjs',
   from:'if (isMain(import.meta.url)) {',
   to:"if (process.argv[1] && import.meta.url.endsWith(path.resolve(process.argv[1]).split(path.sep).join('/'))) { // MUTANT",
   tests:['test/ismain-symlink-entry.test.mjs'] },

 // Round 3 (hooks-harden-cm): the tracked-runtime findings of the gitignore check and `mem init`.
 { name:'trackedruntime: the finding prints file names out of the index',
   file:'src/trackedruntime.mjs',
   from:"  const lead = groups.slice(0, 6).map((g) => `${g.count} in ${g.spec}`).join(', ');",
   to:"  const lead = files.slice(0, 3).join(', ');  // MUTANT",
   tests:['test/tracked-names.test.mjs'] },

 { name:'trackedruntime: the star of a glob spec skips line breaks again',
   file:'src/trackedruntime.mjs',
   from:"join('[\\\\s\\\\S]*')",
   to:"join('.*')",
   tests:['test/gitignore-guards.test.mjs'] },

 { name:'trackedruntime: the component table is not a runtime path',
   file:'src/trackedruntime.mjs',
   from:"{ rule: '.mem/component-table.json', spec: '.mem/component-table.json', probe: '.mem/component-table.json',",
   to:"{ rule: '.mem/component-tableX.json', spec: '.mem/component-tableX.json', probe: '.mem/component-tableX.json',  // MUTANT\n   ",
   tests:['test/pipeline-ignore.test.mjs'] },

 { name:'trackedruntime: the keyring is not a runtime path',
   file:'src/trackedruntime.mjs',
   from:"{ rule: '.mem/keyring.json', spec: '.mem/keyring.json', probe: '.mem/keyring.json',",
   to:"{ rule: '.mem/keyringX.json', spec: '.mem/keyringX.json', probe: '.mem/keyringX.json',  // MUTANT\n   ",
   tests:['test/pipeline-ignore.test.mjs'] },

 { name:'doctor gitignore: a tracked runtime file is not looked for',
   file:'src/doctor.mjs',
   from:"    if (tracked.length) {\n      // Folders and counts only",
   to:"    if (false) {  // MUTANT\n      // Folders and counts only",
   tests:['test/pipeline-ignore.test.mjs','test/tracked-names.test.mjs'] },

 { name:'doctor gitignore: a negated pattern counts as ignored',
   file:'src/doctor.mjs',
   from:"cells[i] === '' || cells[i + 2].startsWith('!')",
   to:"cells[i] === ''",
   tests:['test/gitignore-guards.test.mjs'] },

 { name:'mem init: a git that cannot list the index stays quiet',
   file:'src/cli/commands/setup.mjs',
   from:"if (fs.existsSync(path.join(root, '.git'))) out('  ? tracked runtime files: unknown (git ls-files could not answer)');",
   to:"if (false) out('  ? tracked runtime files: unknown (git ls-files could not answer)');  // MUTANT",
   tests:['test/gitignore-guards.test.mjs'] },

 // headless start (src/headless.mjs, bin/_portable.sh, the three jobs): an unattended job never starts claude open.
 { name:'headless: drop --strict-mcp-config from the isolation flags',
   file:'src/headless.mjs',
   from:"export const ISOLATION_FLAGS = Object.freeze(['--setting-sources', 'user', '--strict-mcp-config']);",
   to:"export const ISOLATION_FLAGS = Object.freeze(['--setting-sources', 'user']);  // MUTANT",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the session starts in the memory itself',
   file:'src/headless.mjs',
   from:"return { isolated: true, args: [...ISOLATION_FLAGS, ...(addDir ? ['--add-dir', root] : [])], cwd: n.dir, cleanup: n.cleanup, note: null };",
   to:"return { isolated: true, args: [...ISOLATION_FLAGS, ...(addDir ? ['--add-dir', root] : [])], cwd: root, cleanup: n.cleanup, note: null };  // MUTANT",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: claude is not recognised as claude',
   file:'src/headless.mjs',
   from:"    if (WRAPPERS.has(s)) {",
   to:"    if (false) {  // MUTANT: wrappers (env, sudo, nice, npx, ...) are not looked through",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: a neutral directory inside the memory is accepted',
   file:'src/headless.mjs',
   from:"    if (!outside(dir)) continue;",
   to:"    // MUTANT: no containment check before anything is made",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: an old claude is never recognised',
   file:'src/headless.mjs',
   from:"export function looksLikeOldClaude(text) {",
   to:"export function looksLikeOldClaude(text) {\n  if (true) return false;  // MUTANT",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the digest starts claude without the starter arguments',
   file:'bin/mem-digest',
   from:'$CMD "$PROMPT" --output-format json ${MEM_HL_ARGS[@]+"${MEM_HL_ARGS[@]}"} ) 2>>"$LOG"',
   to:'$CMD "$PROMPT" --output-format json ) 2>>"$LOG"  # MUTANT',
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the digest ignores a failed plan',
   file:'bin/mem-digest',
   from:'  if ! mem_headless_plan "$CMD" "$ROOT"; then',
   to:'  if ! { mem_headless_plan "$CMD" "$ROOT"; true; }; then  # MUTANT',
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the mail handler starts claude without the starter arguments',
   file:'bin/mem-handle-post',
   from:'$CMD "$PROMPT" ${MEM_HL_ARGS[@]+"${MEM_HL_ARGS[@]}"} 2>&1 | tee "$SEEN"',
   to:'$CMD "$PROMPT" 2>&1 | tee "$SEEN"  # MUTANT',
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the mail handler stays in the memory',
   file:'bin/mem-handle-post',
   from:'cd "$MEM_HL_CWD" || exit 1',
   to:'true  # MUTANT: no cd',
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the reflector stays in the host repository',
   file:'bin/mem-reflect',
   from:'if ! cd "$MEM_HL_CWD"; then',
   to:'if ! true; then',
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the reflector ignores a failed plan',
   file:'bin/mem-reflect',
   from:'if ! mem_headless_plan "$CMD" "$CHEAP_MEM_ROOT" 0; then',
   to:'if ! { mem_headless_plan "$CMD" "$CHEAP_MEM_ROOT" 0; true; }; then  # MUTANT',
   tests:['test/headless-start.test.mjs'] },


 { name:'headless: a command that is not claude starts in the memory again',
   file:'src/headless.mjs',
   from:"if (!claude) return { isolated: false, args: [], cwd: n.dir, cleanup: n.cleanup, note: NOT_RECOGNISED_NOTE };",
   to:"if (!claude) return { isolated: false, args: [], cwd: root, cleanup: n.cleanup, note: NOT_RECOGNISED_NOTE };  // MUTANT",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: an unrecognised command is not announced in the log',
   file:'src/headless.mjs',
   from:"if (!claude) return { isolated: false, args: [], cwd: n.dir, cleanup: n.cleanup, note: NOT_RECOGNISED_NOTE };",
   to:"if (!claude) return { isolated: false, args: [], cwd: n.dir, cleanup: n.cleanup, note: null };  // MUTANT",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: a neutral directory holding a project marker is reused',
   file:'src/headless.mjs',
   from:"  return !entries.some((e) => PROJECT_MARKERS.includes(e));",
   to:"  return true;  // MUTANT",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: a symlink is accepted as the neutral directory',
   file:'src/headless.mjs',
   from:"  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;",
   to:"  if (!st) return false;  // MUTANT",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: the cleanup removes any directory it is given',
   file:'src/headless.mjs',
   from:"    if (!/^(headless-cwd-|cheap-mem-headless-cwd-)[A-Za-z0-9]{6}$/.test(name)) return false;",
   to:"    // MUTANT: no name check",
   tests:['test/headless-start.test.mjs'] },

 { name:'headless: a line break inside the old-claude sentence hides it',
   file:'src/headless.mjs',
   from:"  const t = String(text ?? '').replace(/\\s+/g, ' ');",
   to:"  const t = String(text ?? '');  // MUTANT",
   tests:['test/headless-start.test.mjs'] },


 { name:'headless: the mail handler leaves its per-run directory behind',
   file:'bin/mem-handle-post',
   from:"mem_headless_cleanup\n\n# An old claude",
   to:"true  # MUTANT: no cleanup\n\n# An old claude",
   tests:['test/headless-start.test.mjs'] },

// writer-identity-cm: `--as-me` and the card byline (name AND rank), test/writer-identity.test.mjs
 { name:"WRITER --as-me with no identity falls back to the OS account",
   file:"src/cli/shell.mjs",
   from:"    if (!stored) {\n      die([",
   to:"    if (!stored) {\n      return null; die([  // MUTANT: the OS account is the fallback again",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER --as-me stamps a name that reads as a person",
   file:"src/cli/shell.mjs",
   from:"if (authority.isHumanName(name)) {",
   to:"if (false && authority.isHumanName(name)) {  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER --as-me stamps the configured human participant",
   file:"src/cli/shell.mjs",
   from:"if (cfgmod.isHuman(cfg.participants?.[name])) {",
   to:"if (false && cfgmod.isHuman(cfg.participants?.[name])) {  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER --as-me combines with --authority (a rank claim)",
   file:"src/cli/shell.mjs",
   from:"if (Object.hasOwn(args, 'authority')) {",
   to:"if (false) {  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER --as-me combines with --agent (two writers)",
   file:"src/cli/shell.mjs",
   from:"if (Object.hasOwn(args, 'agent')) die(",
   to:"if (false) die(  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER --as-me swallows the next word without a word",
   file:"src/cli/shell.mjs",
   from:"  if (v !== true) {\n    // The value",
   to:"  if (false) {  // MUTANT\n    // The value",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER --as-me accepts a stored name that is no participant",
   file:"src/cli/shell.mjs",
   from:"if (!Object.hasOwn(cfg.participants, stored)) {",
   to:"if (false) {  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER --as-me: the stored whoami outranks CHEAP_MEM_AGENT",
   file:"src/cli/shell.mjs",
   from:"  let name = set;\n  if (!name) {",
   to:"  let name = '';  // MUTANT\n  if (!name) {",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER mem log --as-me is ignored",
   file:"src/cli/commands/write.mjs",
   from:"const asMe = asMeWriter(root, cfg, args, 'log');",
   to:"const asMe = (asMeWriter(root, cfg, args, 'log'), null);  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER mem correction --as-me is ignored",
   file:"src/cli/commands/write.mjs",
   from:"    const asMe = asMeWriter(root, cfg, args, 'correction');\n    if (asMe) data.agent = asMe;",
   to:"    asMeWriter(root, cfg, args, 'correction');  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER mem card add --as-me is ignored",
   file:"src/cli/commands/write.mjs",
   from:"agent: asMe ?? undefined",
   to:"agent: undefined  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER mem sources add --as-me is ignored",
   file:"src/cli/commands/setup.mjs",
   from:"agent: asMe ?? memory.agentDefault(),\n          max: (numberFlag('max', args.max, { min: 1 }) ?? undefined),\n        });\n      } catch (e) { die(`sources add:",
   to:"agent: memory.agentDefault(),  // MUTANT\n          max: (numberFlag('max', args.max, { min: 1 }) ?? undefined),\n        });\n      } catch (e) { die(`sources add:",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER mem sources bridge --as-me is ignored",
   file:"src/cli/commands/setup.mjs",
   from:"agent: asMe ?? memory.agentDefault(),\n          max: (numberFlag('max', args.max, { min: 1 }) ?? undefined),\n        });\n      } catch (e) { die(`sources bridge:",
   to:"agent: memory.agentDefault(),  // MUTANT\n          max: (numberFlag('max', args.max, { min: 1 }) ?? undefined),\n        });\n      } catch (e) { die(`sources bridge:",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER a card is a person's by its author name again",
   file:"src/decisioncard.mjs",
   from:"by_human: Boolean(name) && rank === 'user',",
   to:"by_human: Boolean(name) && (rank === 'user' || authority.isHumanName(name)),  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER a card is a person's by its rank alone, without a name",
   file:"src/decisioncard.mjs",
   from:"by_human: Boolean(name) && rank === 'user',",
   to:"by_human: rank === 'user',  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER the byline invents a rank for a line without one",
   file:"src/decisioncard.mjs",
   from:"const rank = set ? from.rank : null;",
   to:"const rank = from.rank;  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER the byline text drops the rank",
   file:"src/decisioncard.mjs",
   from:"text: `${name ?? 'unknown'} (${rank ?? 'rank unknown'})`,",
   to:"text: `${name ?? 'unknown'}`,  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER the card shelf loses the rank state",
   file:"src/cardstore.mjs",
   from:"    rank_state: authority.tierState(z).state,\n",
   to:"  // MUTANT\n",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER tierState reads a blank tier as missing",
   file:"src/authority.mjs",
   from:"if (!t) return { tier: null, state: 'empty' };",
   to:"if (!t) return { tier: null, state: 'missing' };  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER tierState reads a foreign word as a tier",
   file:"src/authority.mjs",
   from:"return TIERS.includes(t) ? { tier: t, state: 'set' } : { tier: null, state: 'broken' };",
   to:"return { tier: t, state: 'set' };  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER rankWord shows a missing rank as a plain tier",
   file:"src/authority.mjs",
   from:"if (typeof state === 'string' && state !== 'set') return `unknown (${state})`;",
   to:"if (false) return `unknown (${state})`;  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER mem today shows a missing card rank as a plain tier",
   file:"src/today.mjs",
   from:"authority.rankWord(card.origin.rank, card.byline?.rank_state)",
   to:"String(card.origin.rank ?? 'unknown')  // MUTANT",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER mem card list shows a missing rank as a plain tier",
   file:"src/cli/commands/write.mjs",
   from:"tier ${authority.rankWord(k.rank, k.rank_state)}, ",
   to:"tier ${k.rank}, ",
   tests:['test/writer-identity.test.mjs'] },

 { name:"WRITER the bridge card list shows a missing rank as a plain tier",
   file:"bin/mem-mcp",
   from:"tier ${authority.rankWord(k.rank, k.rank_state)}, ",
   to:"tier ${k.rank}, ",
   tests:['test/writer-identity.test.mjs'] },

 // card-byline-ui-cm: the dashboard's origin line reads the card's byline in the words of rankWord.
 { name:"BYLINE-UI the dashboard shows a missing rank as a plain tier",
   file:"assets/dashboard/dashboard.js",
   from:"(typeof state === 'string' && state !== 'set' ? `unknown (${state})` : ",
   to:"(false ? `unknown (${state})` : ",
   tests:['test/card-byline-ui-cm-browser.test.mjs'] },

 { name:"BYLINE-UI the dashboard reads the rank from origin, not from the byline",
   file:"assets/dashboard/dashboard.js",
   from:"tier ${ce(rankWord(b.rank, b.rank_state))}",
   to:"tier ${ce(rankWord(o.rank))}",
   tests:['test/card-byline-ui-cm-browser.test.mjs'] },

 { name:"BYLINE-UI the configured human's name drops the agent hint",
   file:"assets/dashboard/dashboard.js",
   from:"const note = o.rank === 'user' ? '' : ",
   to:"const note = o.rank === 'user' || b.name === 'user' ? '' : ",
   tests:['test/card-byline-ui-cm-browser.test.mjs'] },
 { name:'K1 the question query cuts an identifier at the underscore again',
   file:'src/search.mjs',
   from:"    .split(/[^a-z0-9_\\u00e4\\u00f6\\u00fc\\u00df]+/)",
   to:"    .split(/[^a-z0-9\\u00e4\\u00f6\\u00fc\\u00df]+/)  // MUTANT: `a_b` falls apart again",
   tests:['test/k1-underscore.test.mjs'] },

 { name:'K1 the question query puts umlauts into `ae` spelling again',
   file:'src/search.mjs',
   from:"    if ((w.length >= 4 || SHORT_OK.has(w)) && !out.has(w)) out.set(w, tw);",
   to:"    if ((w.length >= 4 || SHORT_OK.has(w)) && !out.has(w)) out.set(w, w);  // MUTANT: English entries are missed",
   tests:['test/k1-underscore.test.mjs'] },

 { name:'K1 retrievalQuery asks for the plain cut',
   file:'src/search.mjs',
   from:"  const w = contentWords(text, { withoutRequest: requestFrame ?? requestFrameOn(), typed: true })",
   to:"  const w = contentWords(text, { withoutRequest: requestFrame ?? requestFrameOn() })  // MUTANT",
   tests:['test/k1-underscore.test.mjs'] },

 { name:'K1 the H1 split cuts the question the old way',
   file:'src/questionsplit.mjs',
   from:"const plainWords = search.typedWords;",
   to:"const plainWords = (text) => String(text ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);  // MUTANT",
   tests:['test/k1-underscore.test.mjs'] },

 { name:'K1S the parts weigh as much as a typed word (1 instead of 0.6)',
   file:'src/search.mjs',
   from:'const SUBWORD_WEIGHT = 0.6;',
   to:'const SUBWORD_WEIGHT = 1;  // MUTANT: the parts outweigh nothing',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S the parts are searched even when the index holds the whole word (switch always on)',
   file:'src/search.mjs',
   from:'  const weight = known ? SUBWORD_WEIGHT_KNOWN : SUBWORD_WEIGHT;',
   to:'  const weight = SUBWORD_WEIGHT;  // MUTANT: `session_id` pulls in every `session` entry again',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S the parts are never searched (switch always off)',
   file:'src/search.mjs',
   from:'  const weight = known ? SUBWORD_WEIGHT_KNOWN : SUBWORD_WEIGHT;',
   to:'  const weight = SUBWORD_WEIGHT_KNOWN;  // MUTANT: K1 without the parts',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S a known identifier keeps a weak part weight (a bonus gap instead of a switch)',
   file:'src/search.mjs',
   from:'const SUBWORD_WEIGHT_KNOWN = 0;',
   to:'const SUBWORD_WEIGHT_KNOWN = 0.3;  // MUTANT',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S a word covered only by its parts counts full in the coordination factor',
   file:'src/search.mjs',
   from:'          || packVariants.subwordForms?.some((t) => doc.weights.has(t))) covered += 0.5;',
   to:'          || packVariants.subwordForms?.some((t) => doc.weights.has(t))) covered += 1;  // MUTANT',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S the answer gate counts a part-covered word full',
   file:'src/search.mjs',
   from:'          || packVariants.subwordForms?.some((t) => doc.weights.has(t))) c += 0.5;',
   to:'          || packVariants.subwordForms?.some((t) => doc.weights.has(t))) c += 1;  // MUTANT',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S a part that is also typed is counted twice',
   file:'src/search.mjs',
   from:'      .filter((p) => !p.perPack.flat().some((t) => ownSet.has(t)));',
   to:'      ;  // MUTANT: the typed word and its part both score',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S a part shared by two identifiers is counted once per identifier',
   file:'src/search.mjs',
   from:'      const key = JSON.stringify(p.perPack);',
   to:'      const key = `${subwordMap.size}:${JSON.stringify(p.perPack)}`;  // MUTANT: no sharing',
   tests:['test/k1-subword.test.mjs'] },

 { name:'K1S a two-letter part is searched',
   file:'src/search.mjs',
   from:'    if (part.length < SUBWORD_MIN ||',
   to:'    if (part.length < 1 ||  // MUTANT',
   tests:['test/k1-subword.test.mjs'] },

 { name:'RB the hook\'s renderer drops the exact leg of the bar',
   file:'src/recallrender.mjs',
   from:"    if (!clears(h, min)) continue;",
   to:"    if (!(Number(h.score) >= min)) continue;  // MUTANT: a named identifier needs a score again",
   tests:['test/recall-bar.test.mjs'] },

 { name:'RB clears() forgets the exact hit',
   file:'src/recallrender.mjs',
   from:"  return Number(hit?.score) >= min || Boolean(hit?.exact && hit.exact.length);",
   to:"  return Number(hit?.score) >= min;  // MUTANT",
   tests:['test/recall-bar.test.mjs'] },

 { name:'RB the H5 path of the hook has its own bar again',
   file:'src/recallhook.mjs',
   from:"    ? levers.coreLines(shown.filter((h) => clears(h, min)), { attach })",
   to:"    ? levers.coreLines(shown.filter((h) => Number(h.score) >= min), { attach })  // MUTANT",
   tests:['test/recall-bar.test.mjs'] },

 { name:'RB the recall-levers measurement keeps its own copy of the bar',
   file:'bench/recall-levers.mjs',
   from:"  return { raw, shown: raw.filter((h) => clears(h, BAR)) };",
   to:"  return { raw, shown: raw.filter((h) => h.score >= BAR || h.exact.length) };  // MUTANT",
   tests:['test/recall-bar.test.mjs'] },

 { name:'AI an index load without a language takes English again',
   file:'src/search.mjs',
   from:"  if (opts.language === undefined) opts = { ...opts, language: configuredLanguage(root) };",
   to:"  // MUTANT: the unnamed language is English, the cache of a German memory is rebuilt on every alternate load",
   tests:['test/recall-index-language.test.mjs'] },

 { name:'AI `mem find` loads the index a second time for the search',
   file:'src/cli/commands/search.mjs',
   from:"    const index = openIndex();\n    if (index.bridgeError)",
   to:"    const index = search.loadIndex(root, { fresh: Boolean(args.fresh), language: cfg.language });  // MUTANT: a second load\n    if (index.bridgeError)",
   tests:['test/recall-index-language.test.mjs'] },

 { name:'AI the content-word shortening ignores the index its caller opened',
   file:'src/search.mjs',
   from:"  if (!idx && open) {",
   to:"  if (false && open) {  // MUTANT",
   tests:['test/recall-index-language.test.mjs'] },

 { name:'SG the SubagentStart task query reads the request-frame switch from the process again',
   file:'src/subagenttask.mjs',
   from:"retrievalQuery(task, { root, index, requestFrame: requestFrameOn(env) })",
   to:"retrievalQuery(task, { root, index })  /* MUTANT */",
   tests:['test/subagent-given-env.test.mjs'] },

 { name:'RB the journal line of `mem find` keeps its own copy of the bar',
   file:'src/cli/commands/search.mjs',
   from:"      const shown = hits.filter((h) => clears(h, min));",
   to:"      const shown = hits.filter((h) => Number(h.score) >= min);  // MUTANT",
   tests:['test/recall-bar.test.mjs'] },

 { name:'dashboard stamp: the time track, its build lock and the drawer locks are not derived',
   file:'src/dashboard-cache.mjs',
   from:"  'timetrack', 'timetrack-build.lock', 'locks',",
   to:'  // MUTANT: time track and locks not derived',
   tests:['test/dash-stamp-r4-cm.test.mjs'] },

 { name:'questions: an unreadable question drawer is skipped again (reads as "no questions")',
   file:'src/question.mjs',
   from:'    const res = memory.readLog(root, TYPE, { project: p });',
   to:'    let res; try { res = memory.readLog(root, TYPE, { project: p }); } catch { continue; }  // MUTANT',
   tests:['test/question-unreadable-cm.test.mjs'] },

 // tool-trust-cm (2026-10-16): a memory runs no code of its own unless the user said so. Each weiche of the
 // rule, one by one; test/own-tool.test.mjs must go red for every one.
 { name:"own-tool: the memory's copy is used without the switch",
   file:"bin/_owntool.sh",
   from:"if [ \"$trusted\" = 1 ] && [ -f \"$root/$rel\" ]; then mem_picked=\"$root/$rel\"; return 0; fi",
   to:"if [ -f \"$root/$rel\" ]; then mem_picked=\"$root/$rel\"; return 0; fi  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: a checkout inside the memory counts as installed",
   file:"bin/_owntool.sh",
   from:"if [ \"$trusted\" = 0 ] && mem_own_inside \"${c%/" + "*}\" \"$root\"; then MEM_OWN_SKIPPED=1; continue; fi",
   to:"if false && mem_own_inside \"${c%/" + "*}\" \"$root\"; then MEM_OWN_SKIPPED=1; continue; fi  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: any line of the switch file trusts the memory",
   file:"bin/_owntool.sh",
   from:"    [ \"$line\" = \"$key\" ] && return 0",
   to:"    [ -n \"$line\" ] && return 0  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the memory is compared by its spelling, not its real path",
   file:"bin/_owntool.sh",
   from:"  CDPATH='' cd -P -- \"$1\" 2>/dev/null || return 1",
   to:"  CDPATH='' cd -- \"$1\" 2>/dev/null || return 1  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: a string prefix counts as inside the memory",
   file:"bin/_owntool.sh",
   from:"  case \"$d/\" in \"$r\"/" + "*) return 0 ;; esac",
   to:"  case \"$d\" in \"$r\"*) return 0 ;; esac  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: an unreadable switch file is read as trusted",
   file:"bin/_owntool.sh",
   from:"  [ -f \"$mem_own_f\" ] && [ -r \"$mem_own_f\" ] || return 1",
   to:"  [ -f \"$mem_own_f\" ] && [ -r \"$mem_own_f\" ] || return 0  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: every memory is trusted",
   file:"src/owntool.mjs",
   from:"  const trusted = mine.some((k) => sw.keys.includes(k));",
   to:"  const trusted = true;  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: an unreadable switch file is rewritten",
   file:"src/owntool.mjs",
   from:"  if (sw.state === 'broken') throw new Error(`cannot read ${file}: ${sw.error}`);",
   to:"  // MUTANT: broken file rewritten",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: withdrawing trust leaves the line",
   file:"src/owntool.mjs",
   from:"  const next = on ? [...kept, ...mine] : kept;",
   to:"  const next = [...kept, ...mine];  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: mem-retrieve takes the memory's bin/mem without the switch",
   file:"bin/mem-retrieve",
   from:"if [ -f \"$ROOT/bin/mem\" ] && mem_own_tool_trusted \"$ROOT\"; then",
   to:"if [ -f \"$ROOT/bin/mem\" ]; then  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: mem-before-edit takes the memory's bin/mem without the switch",
   file:"bin/mem-before-edit",
   from:"if [ -f \"$ROOT/bin/mem\" ] && mem_own_tool_trusted \"$ROOT\"; then",
   to:"if [ -f \"$ROOT/bin/mem\" ]; then  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: mem-after-failure takes the memory's bin/mem without the switch",
   file:"bin/mem-after-failure",
   from:"if [ -f \"$ROOT/bin/mem\" ] && mem_own_tool_trusted \"$ROOT\"; then",
   to:"if [ -f \"$ROOT/bin/mem\" ]; then  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: mem-catch-fail takes the memory's bin/mem without the switch",
   file:"bin/mem-catch-fail",
   from:"if [ -f \"$ROOT/bin/mem\" ] && mem_own_tool_trusted \"$ROOT\"; then",
   to:"if [ -f \"$ROOT/bin/mem\" ]; then  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: mem-stop trusts the memory by default",
   file:"bin/mem-stop",
   from:"OWN_TOOL=0",
   to:"OWN_TOOL=1  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: mem-subagent-start loads the memory's module without the switch",
   file:"bin/mem-subagent-start",
   from:"MODULE=\"$mem_picked\"",
   to:"MODULE=\"$ROOT/src/subagentstart.mjs\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the mail handler sends the model to the memory's bin/mem",
   file:"bin/mem-handle-post",
   from:"TOOL_CMD=\"node $HERE/mem --root \\$CHEAP_MEM_ROOT\"",
   to:"TOOL_CMD=\"node \\$CHEAP_MEM_ROOT/bin/mem\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the sub-agent hint sends the model to the memory's bin/mem",
   file:"src/subagentstart.mjs",
   from:"  const tool = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');",
   to:"  const tool = path.join(root, 'bin', 'mem');  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the user-prompt shim runs the memory's tool first",
   file:"install/hooks/user-prompt.sh",
   from:"  mem_pick_tool \"$CHEAP_MEM_ROOT\" bin/mem-retrieve \"$HERE\"",
   to:"  mem_picked=\"$CHEAP_MEM_ROOT/bin/mem-retrieve\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the pre-edit shim runs the memory's tool first",
   file:"install/hooks/pre-edit.sh",
   from:"  mem_pick_tool \"$CHEAP_MEM_ROOT\" bin/mem-before-edit \"$HERE\"",
   to:"  mem_picked=\"$CHEAP_MEM_ROOT/bin/mem-before-edit\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the catch-fail shim runs the memory's tool first",
   file:"install/hooks/catch-fail.sh",
   from:"  mem_pick_tool \"$CHEAP_MEM_ROOT\" bin/mem-catch-fail \"$HERE\"",
   to:"  mem_picked=\"$CHEAP_MEM_ROOT/bin/mem-catch-fail\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the after-failure shim runs the memory's tool first",
   file:"install/hooks/after-failure.sh",
   from:"  mem_pick_tool \"$CHEAP_MEM_ROOT\" bin/mem-after-failure \"$HERE\"",
   to:"  mem_picked=\"$CHEAP_MEM_ROOT/bin/mem-after-failure\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the subagent-start shim runs the memory's tool first",
   file:"install/hooks/subagent-start.sh",
   from:"  mem_pick_tool \"$CHEAP_MEM_ROOT\" bin/mem-subagent-start \"$HERE\"",
   to:"  mem_picked=\"$CHEAP_MEM_ROOT/bin/mem-subagent-start\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the session-stop shim runs the memory's tool first",
   file:"install/hooks/session-stop.sh",
   from:"  mem_pick_tool \"$CHEAP_MEM_ROOT\" bin/mem-stop \"$HERE\"",
   to:"  mem_picked=\"$CHEAP_MEM_ROOT/bin/mem-stop\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the start hook runs the memory's bin/mem first",
   file:"install/hooks/session-start.sh",
   from:"  mem_pick_tool \"$CHEAP_MEM_ROOT\" bin/mem \"$SS_HERE\"",
   to:"  mem_picked=\"$CHEAP_MEM_ROOT/bin/mem\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the start hook says nothing about a tool it passed over",
   file:"install/hooks/session-start.sh",
   from:"    own_tool_note=\"memory ships its own tool; using the installed one. To trust it: mem trust-own-tool\"",
   to:"    own_tool_note=\"\"  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: tool-missing stays silent for an untrusted own tool without a code path",
   file:"install/support/tool-missing.sh",
   from:"[ -n \"$code\" ] || [ \"$skipped\" = \"1\" ] || exit 0",
   to:"[ -n \"$code\" ] || exit 0  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the memory's own tool is always on the allow list",
   file:"install/claude-code.sh",
   from:"if (ownTrusted === '1') allow.push(memCmd(memRoot));",
   to:"allow.push(memCmd(memRoot));  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: a stale allow entry for the memory is kept",
   file:"install/claude-code.sh",
   from:"if (ownTrusted !== '1') {\n  const stale = memCmd(memRoot);",
   to:"if (false) {\n  const stale = memCmd(memRoot);  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the switch command is not denied to a model",
   file:"install/claude-code.sh",
   from:"  `Bash(node ${codeRoot.replace(/\\\\/g, '/')}/bin/mem trust-own-tool:*)`,\n",
   to:"",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: an installed checkout inside the memory is allowed",
   file:"install/claude-code.sh",
   from:"if (!codeInsideMem || ownTrusted === '1') allow.push(memCmd(codeRoot));",
   to:"allow.push(memCmd(codeRoot));  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the windows installer allows the memory's own tool always",
   file:"install/windows.ps1",
   from:"    if ($ownTrusted) { $allowNeeded += (Get-MemCmd $env:CHEAP_MEM_ROOT) }",
   to:"    $allowNeeded += (Get-MemCmd $env:CHEAP_MEM_ROOT)  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the windows hooks look in the memory first (the code root first, not the rule)",
   file:"install/windows.ps1",
   from:"  `$found = Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel 'bin\\mem' -Self `$PSScriptRoot",
   to:"  `$found = [pscustomobject]@{ Path = (Join-Path `$env:CHEAP_MEM_ROOT 'bin\\mem'); Skipped = `$false }  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the PowerShell twin trusts any line",
   file:"bin/_owntool.ps1",
   from:"  foreach ($line in $lines) { if ($line -ceq $key) { return $true } }",
   to:"  foreach ($line in $lines) { return $true }  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the PowerShell twin uses the memory's copy without the switch",
   file:"bin/_owntool.ps1",
   from:"    if ($trusted) { $res.Path = $own; return $res }",
   to:"    $res.Path = $own; return $res  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: mem-retrieve.ps1 takes the memory's bin/mem without the switch",
   file:"bin/mem-retrieve.ps1",
   from:"if ($OwnToolTrusted -and (Test-Path -LiteralPath (Join-Path $Root 'bin/mem'))) {",
   to:"if (Test-Path -LiteralPath (Join-Path $Root 'bin/mem')) {  # MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the switch is set without a terminal",
   file:"src/cli/commands/setup.mjs",
   from:"      if (!args['non-interactive'] || !provision) {",
   to:"      if (false) {  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 { name:"own-tool: the doctor counts the memory's untrusted tool as a tool",
   file:"src/integrationcontract.mjs",
   from:"if (!has(code) && !(has(root) && ownTool.isTrusted(root))) out.push({ hook: path.basename(script), code });",
   to:"if (!has(code) && !has(root)) out.push({ hook: path.basename(script), code });  // MUTANT",
   tests:['test/own-tool.test.mjs'] },

 // tool-trust-cm follow-up (2026-10-16): the deny rules, the provisioning variable, hooks installed before the rule, the marker.
 { name:"own-tool: --non-interactive works without CHEAP_MEM_PROVISION",
   file:"src/cli/commands/setup.mjs",
   from:"      if (!args['non-interactive'] || !provision) {",
   to:"      if (!args['non-interactive']) {  // MUTANT",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the deny rule for the switch command is narrow again",
   file:"install/claude-code.sh",
   from:"  'Bash(*trust-own-tool*)',\n",
   to:"  // MUTANT: only the prefix forms below\n",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: Write and Edit of the switch file are not denied",
   file:"install/claude-code.sh",
   from:"  for (const f of forms) for (const tool of ['Write', 'Edit']) deny.push(`${tool}(${f})`);",
   to:"  void forms;  // MUTANT",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the stale allow entry is kept in its backslash spelling",
   file:"install/claude-code.sh",
   from:"filter((e) => String(e).replace(/\\\\/g, '/') !== stale)",
   to:"filter((e) => e !== stale)  /* MUTANT */",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: hooks that never ask the rule are not reported",
   file:"src/integrationcontract.mjs",
   from:"    const calls = isPs ? /Find-OwnTool/.test(text) : /mem_pick_tool/.test(text);",
   to:"    const calls = true;  // MUTANT",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: a missing rule file next to the shims is not reported",
   file:"src/integrationcontract.mjs",
   from:"    else if (!fs.existsSync(helper)) out.push(",
   to:"    else if (false) out.push(",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the tool-missing marker is written into the memory again",
   file:"install/support/tool-missing.sh",
   from:"    dir=\"$state/cheap-mem\"\n    mark=\"$dir/tool-missing-$name-${sum:-0}\"\n    # A marker that is a symlink or not a plain file is not trusted: say it (the message is the point), write nothing.\n    if [ -L \"$mark\" ] || { [ -e \"$mark\" ] && [ ! -f \"$mark\" ]; }; then mark=\"\"; fi\n    if [ -n \"$mark\" ]; then\n      if [ -n \"$(find \"$mark\" -mmin -30 2>/dev/null)\" ]; then exit 0; fi\n      if [ ! -L \"$dir\" ]; then (umask 077; mkdir -p \"$dir\" 2>/dev/null && : > \"$mark\" 2>/dev/null); fi\n    fi",
   to:"    dir=\"$root/.pipeline\"\n    mark=\"$dir/tool-missing-$name\"\n    if [ -n \"$mark\" ]; then\n      if [ -n \"$(find \"$mark\" -mmin -30 2>/dev/null)\" ]; then exit 0; fi\n      mkdir -p \"$dir\" 2>/dev/null && : > \"$mark\" 2>/dev/null  # MUTANT\n    fi",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: a path with a line break is written to the switch file",
   file:"src/owntool.mjs",
   from:"  if (mine.some((k) => /[\\r\\n]/.test(k))) throw",
   to:"  if (false) throw",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the PowerShell twin reads a relative path against the .NET directory",
   file:"bin/_owntool.ps1",
   from:"Join-Path (Get-Location).ProviderPath $Path",
   to:"Join-Path ([System.IO.Directory]::GetCurrentDirectory()) $Path",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the PowerShell twin does not follow a junction",
   file:"bin/_owntool.ps1",
   from:"[System.IO.Directory]::ResolveLinkTarget($full, $true)",
   to:"$null",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the windows installer's deny list is narrow again",
   file:"install/windows.ps1",
   from:"      'Bash(*trust-own-tool*)', 'PowerShell(*trust-own-tool*)',\n",
   to:"      # MUTANT\n",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the windows tool-missing marker is written into the memory again",
   file:"install/windows.ps1",
   from:"    $dir = Join-Path $base 'cheap-mem'",
   to:"    $dir = Join-Path $Root '.pipeline'",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the windows start hook imports the memory's provenance module without the rule",
   file:"install/windows.ps1",
   from:"  if (Test-Path -LiteralPath `$ownLib) { `$provSrc = (Find-OwnTool -Root `$env:CHEAP_MEM_ROOT -Rel 'src\\provenance.mjs' -Self `$PSScriptRoot).Path }",
   to:"  `$provSrc = Join-Path `$env:CHEAP_MEM_ROOT 'src\\provenance.mjs'  # MUTANT: the memory's module, without the rule",
   tests:['test/own-tool.test.mjs'] },
 { name:"own-tool: the provisioning variable is not denied wherever it stands",
   file:"install/claude-code.sh",
   from:"  'Bash(*CHEAP_MEM_PROVISION*)',\n",
   to:"  // MUTANT\n",
   tests:['test/own-tool.test.mjs'] },

 // quiet-aa-cm: the small grey text reaches WCAG AA (4.5:1) on every surface, light and dark.
 { name:'quiet AA: the light theme gets its old --quiet back (#617869, 3.85 on a figure tile)',
   file:'assets/dashboard/dashboard.css',
   from:'--muted:#51695a;--quiet:#566a5d;',
   to:'--muted:#51695a;--quiet:#617869;',
   tests:['test/quiet-aa-cm-browser.test.mjs'] },
 { name:'quiet AA: the dark theme gets its old --quiet back (#91a699, 4.30 on a figure tile)',
   file:'assets/dashboard/dashboard.css',
   from:'--muted:#a7b8ae;--quiet:#99aca0;',
   to:'--muted:#a7b8ae;--quiet:#91a699;',
   tests:['test/quiet-aa-cm-browser.test.mjs'] },
 { name:'quiet AA: the light theme keeps the dark .content tint (page top grey, --muted 4.13)',
   file:'assets/dashboard/dashboard.css',
   from:'.light .content{background:none}',
   to:'.light .content{}',
   tests:['test/quiet-aa-cm-browser.test.mjs'] },
 { name:'quiet AA: the dark fabric stage takes the light --quiet in the light theme (2.3 on the stage)',
   file:'assets/dashboard/dashboard.css',
   from:'.light .fabric-stage{--quiet:#99aca0}',
   to:'.light .fabric-stage{}',
   tests:['test/quiet-aa-cm-browser.test.mjs'] },
 { name:"codex-cloud: a failed write takes back folders RECURSIVELY",
   file:"src/codexcloud.mjs",
   from:"try { fs.rmdirSync(p); }",
   to:"try { fs.rmSync(p, { recursive: true }); }  /* MUTANT: deletes what is in it */ ",
   tests:['test/codex-cloud-skill.test.mjs'] },
 { name:"codex-cloud: the report says .gitignore was put back though it was never touched",
   file:"src/codexcloud.mjs",
   from:"const gi = !changed ? [] :",
   to:"const gi = false ? [] :",
   tests:['test/codex-cloud-skill.test.mjs'] },
 { name:"codex-cloud: a failing restore after a failed skill write masks the first error",
   file:"src/codexcloud.mjs",
   from:"const notBack = changed ? tryRestoreGi() : null;",
   to:"const notBack = changed ? (restoreGi(), null) : null;  // MUTANT: a throw here replaces the error",
   tests:['test/codex-cloud-skill.test.mjs'] },
 { name:"codex-cloud: a failing restore after a failed ignore check masks the first error",
   file:"src/codexcloud.mjs",
   from:"const notBack = tryRestoreGi();",
   to:"const notBack = (restoreGi(), null);  // MUTANT: a throw here replaces the error",
   tests:['test/codex-cloud-skill.test.mjs'] },
 { name:"due-one-place: the pattern has no destructuring branch (`const { due } = d` is not found)",
   file:"shared/calculations.jsonl",
   from:"|\\\\{(?:[^{}]*,)?\\\\s*['\\\\\\\"]?(?:due|due_date|until|deadline)['\\\\\\\"]?\\\\s*(?:[:=][^{},]*)?(?:,[^{}]*)?\\\\}\\\\s*(?:=(?![=>])|of\\\\b|\\\\)\\\\s*=>)",
   to:"",
   tests:['test/due-core.test.mjs'] },
 { name:"due-one-place: the pattern has no bracket-access branch (`d[\"due\"]` is not found)",
   file:"shared/calculations.jsonl",
   from:"|\\\\[\\\\s*['\\\\\\\"`](?:due|due_date|until|deadline)['\\\\\\\"`]\\\\s*\\\\]",
   to:"",
   tests:['test/due-core.test.mjs'] },
 { name:"due-one-place: the pattern has no `due ?? by` branch (the alias fallback is not found)",
   file:"shared/calculations.jsonl",
   from:"|\\\\b(?:due|due_date|until|deadline)\\\\b\\\\s*(?:\\\\?\\\\?|\\\\|\\\\|)\\\\s*(?:\\\\w+\\\\??\\\\.)?by\\\\b",
   to:"",
   tests:['test/due-core.test.mjs'] },
 { name:"answer-budget: a part never steps down to its pointer",
   file:"src/answerbudget.mjs",
   from:"for (let f = 0; f < upto; f += 1) {",
   to:"for (let f = 0; f < Math.min(1, upto); f += 1) { // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"answer-budget: the omission note is not reserved in the budget",
   file:"src/answerbudget.mjs",
   from:"      picked = run(reserve);",
   to:"      picked = run(0); // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"answer-budget: a form is measured before it is masked",
   file:"src/answerbudget.mjs",
   from:"try { t = sanitize(f); } catch { continue; }",
   to:"t = f; // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"answer-budget: the budget is doubled",
   file:"src/answerbudget.mjs",
   from:"export const ANSWER_BYTES = 3200;",
   to:"export const ANSWER_BYTES = 6400; // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"answer-budget: an elastic part may overrun its room in bytes",
   file:"src/answerbudget.mjs",
   from:"const trial = text ? tryWith(0, text) : null;",
   to:"const trial = text ? new Map([...without, [p, { form: 0, text }]]) : null; // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"recallhook: a workflow card turned into a pointer keeps its 'seen' mark",
   file:"src/recallhook.mjs",
   from:"if (wfCardLost) forgetCard(root, env);",
   to:"// MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"recallhook: the journal counts every hit, not the delivered ones",
   file:"src/recallhook.mjs",
   from:"hits: delivered.length, searched: null, sources: shownSources, ids: shownIds,",
   to:"hits: units.length, searched: null, sources: shownSources, ids: shownIds, // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"subagentstart: the recap may overrun its room in bytes",
   file:"src/subagentstart.mjs",
   from:"if (size <= room) return recap;",
   to:"return recap; // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"subagentstart: the budget of the start is doubled",
   file:"src/subagentstart.mjs",
   from:"export const CAP_BYTES = answerbudget.ANSWER_BYTES;",
   to:"export const CAP_BYTES = answerbudget.ANSWER_BYTES * 2; // MUTANT",
   tests:['test/answer-budget-cm.test.mjs','test/subagent-start.test.mjs'] },
 { name:"workflowdetect: a card over its limit is shown whole again",
   file:"src/workflowdetect.mjs",
   from:"return size > maxBytes ? sizePointerText(entry, size) : text;",
   to:"return text; // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"findcore: MMR is off whatever the caller asks",
   file:"src/findcore.mjs",
   from:"mmr: o.mmr !== false,",
   to:"mmr: false, // MUTANT",
   tests:['test/paths-agree.test.mjs','test/answer-budget-cm.test.mjs'] },
 { name:"answer-budget: a procedure (a keep part) may fall away again",
   file:"src/answerbudget.mjs",
   from:"x.keep && x.forms.length)) {",
   to:"x.keep && x.forms.length && false)) { // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"answer-budget: the separators of the parts are not counted in the size of a choice",
   file:"src/answerbudget.mjs",
   from:"n += bytes(got.text) + (i === 0 ? 0 : bytes(sepOf(p)));",
   to:"n += bytes(got.text); // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"answer-budget: a pointer title is cut before it is masked",
   file:"src/answerbudget.mjs",
   from:"const flat = maskText(String(text ?? '')).replace(",
   to:"const flat = String(text ?? '').replace( // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"subagentstart: the recap is first asked smaller than the old cap",
   file:"src/subagentstart.mjs",
   from:"let chars = Math.floor(legacyChars);",
   to:"let chars = Math.floor(Math.min(room, legacyChars)); // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"workflowdetect: a card that came only as a pointer is repeated as 'already shown'",
   file:"src/workflowdetect.mjs",
   from:"return size > maxBytes ? sizePointerRepeatText(entry, size) : pointerText(entry);",
   to:"return pointerText(entry); // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"mem-mcp: mem_find does not cut a large top",
   file:"bin/mem-mcp",
   from:"const wanted = Math.min(asked, MCP_FIND_TOP_MAX);",
   to:"const wanted = asked; // MUTANT",
   tests:['test/answer-budget-cm.test.mjs'] },
 { name:"mem-mcp: mem_find drops the caller's variants",
   file:"bin/mem-mcp",
   from:"variants: Array.isArray(variants) ? variants : [], weak: Boolean(weak), env: process.env,",
   to:"variants: [], weak: Boolean(weak), env: process.env, // MUTANT",
   tests:['test/variants.test.mjs'] },

// help-after-bool-cm: `-h` after a yes/no switch is a help request, test/bool-switch-help.test.mjs
 { name:"HELP-BOOL the parser gives -h to a listed yes/no switch again",
   file:"src/cli/shell.mjs",
   from:" && !(next === '-h' && BOOL_SWITCHES.has(key))",
   to:"  // MUTANT: the register is not asked",
   tests:['test/bool-switch-help.test.mjs'] },
 { name:"HELP-BOOL `sync` (appointment tick) is not in the register",
   file:"src/cli/shell.mjs",
   from:"'suggested', 'sync', 'table'",
   to:"'suggested', 'table'  /* MUTANT */",
   tests:['test/bool-switch-help.test.mjs'] },
 { name:"HELP-BOOL `readonly` (serve) is not in the register",
   file:"src/cli/shell.mjs",
   from:"'dry-run', 'readonly', 'allow-writes'",
   to:"'dry-run', 'allow-writes'  /* MUTANT */",
   tests:['test/bool-switch-help.test.mjs'] },
];

// The modules whose failure is a security or data-integrity failure. The
// measure that matters is "mutants caught per module here", not "share of
// modules with any mutant". `--security` sweeps only these, and only the
// suites each mutant names (no baseline over, and no full run after, the
// rest of the catalogue).
const SECURITY_MODULES = Object.freeze([
  'redaction', 'login', 'webauth', 'capability', 'chain', 'shred', 'append',
  'claim', 'writegate', 'pathcheck', 'filelock', 'inbox', 'guard', 'owntool',
].map((m) => `src/${m}.mjs`));

// **The catalogue is importable; none of the rest of this file is.**
//
// `test/mutation-anchors.test.mjs` (and `test/readme-numbers.test.mjs`,
// which reads `MUTANTS.length` to check the README's own count) both
// import this module only to read `MUTANTS` — cheap, without applying a
// single mutant or running a single test. Every effectful line below,
// starting with the baseline check, has to sit behind the SAME
// run-as-a-command gate the mutation sweep already used further down
// (`RUN_AS_SCRIPT`, moved up here so it covers the baseline check too):
// computed BEFORE anything runs, so a bare `import()` of this file does
// nothing observable at all.
//
// The occasion: a bare `import('bench/mutation.mjs')` printed "Mutation
// testing needs a green baseline" and launched a full baseline
// `execFileSync('node', ['--test', ...])` run as a SIDE EFFECT of being
// imported, because only the sweep loop further down was behind
// `RUN_AS_SCRIPT` — the baseline check above it was not. Every run of
// `test/readme-numbers.test.mjs` was paying for a full baseline test run
// it never asked for, and a transient flake in that baseline (see the
// 2026-09-19 note below) could fail a test file with nothing to do with
// mutation testing at all.
const RUN_AS_SCRIPT = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (RUN_AS_SCRIPT) {

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
// **The catalogue is importable; the sweep is not.** (`RUN_AS_SCRIPT` itself
// now lives at the top of this file, ahead of the baseline check — see
// the comment there. `test/mutation-anchors.test.mjs` and
// `test/readme-numbers.test.mjs` both rely on importing `MUTANTS` costing
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

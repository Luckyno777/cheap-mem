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

const MUTANTS=[
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
   from:"    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); continue; }",
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
   file:'src/memory.mjs',
   from:'    if (e.replaces_id) {',
   to:'    if (false && e.replaces_id) {  // MUTANT',
   tests:['test/authority.test.mjs','test/properties.test.mjs'] },

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
   from:'    const keep = (scopes ?? this.scopes).filter((s) => this.admits(s));',
   to:'    const keep = (scopes ?? this.scopes);  // MUTANT: no filter',
   tests:['test/retrieval.test.mjs'] },

 { name:'SEM disputed becomes included by default',
   file:'src/retrieval.mjs',
   from:"    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); continue; }",
   to:"    if (c.status === 'disputed' && withDisputed) { note(c.id, 'MUTANT'); continue; }",
   tests:['test/retrieval.test.mjs','test/authority.test.mjs'] },

 { name:'SEM status read from the RESULT SET, not the log',
   file:'src/retrieval.mjs',
   from:'  const claimState = statusOf(state, e.id);',
   to:"  const claimState = hit.retired?.state ?? 'active';  // MUTANT: the exact bug of 2026-09-05, status back from the index",
   tests:['test/retrieval.test.mjs','test/state.test.mjs'] },

 { name:'SEM author share becomes a flat cap of one',
   file:'src/retrieval.mjs',
   from:'  const cap = Math.max(1, Math.floor(claims.length * limits.perAuthorShare));',
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
   from:'    .sort((a, b) => b.score - a.score);',
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
   from:'    contested: potentialConflicts(fair),',
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

 { name:'ARCH state read from the index instead of the log',
   file:'src/retrieval.mjs',
   from:'  const claimState = statusOf(state, e.id);',
   to:"  const claimState = hit.retired?.state ?? 'active';  // MUTANT: cache is truth again",
   tests:['test/state.test.mjs','test/retrieval.test.mjs'] },

 { name:'ARCH state derived once per HIT instead of once per call',
   file:'src/retrieval.mjs',
   from:'  const state = deriveState(root);',
   to:'  const state = new Map();  // MUTANT: no state at all',
   tests:['test/state.test.mjs','test/retrieval.test.mjs','test/authority.test.mjs'] },

 { name:'ARCH scope applied AFTER the result is assembled',
   file:'src/retrieval.mjs',
   from:'    if (!capability.admits(c.scope)) { note(c.id, `outside capability (${c.scope})`); continue; }',
   to:'    // MUTANT: scope checked nowhere',
   tests:['test/retrieval.test.mjs'] },

 { name:'ARCH conflict flagged from the RAW hits, before filtering',
   file:'src/retrieval.mjs',
   from:'    contested: potentialConflicts(fair),',
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
   to:'  dropEcho = false,  // MUTANT: die eigene Frage kommt wieder zurueck',
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH `mem find` stops dropping echoes by default',
   file:'bin/mem',
   from:"    const hits = (args['with-echo']",
   to:"    const hits = (true  // MUTANT: Vorgabe wieder auf durchlassen\n      || args['with-echo']",
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH echo filter forgets that it is only for raw captures',
   file:'src/search.mjs',
   from:"  if (!hit || !(hit.type === 'raw' || hit.raw === true)) return false;",
   to:"  if (!hit) return false;  // MUTANT: getippte Eintraege fallen mit",
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH echo check counts the synthetic raw title again',
   file:'src/search.mjs',
   from:"  return isEcho(questionText, String(hit.entry?.text ?? ''), opts);",
   to:"  return isEcho(questionText, `${hit.entry?.title ?? ''} ${hit.entry?.text ?? ''}`, opts);  // MUTANT",
   tests:['test/paths-agree.test.mjs'] },

 { name:'ARCH raw captures shape the idf again',
   file:'src/search.mjs',
   from:"    statsDocFreq: curatedN ? curatedFreq : docFreq,",
   to:"    statsDocFreq: docFreq,  // MUTANT: der Rohfang bestimmt wieder, was selten ist",
   tests:['test/raw-stats.test.mjs'] },

 { name:'ARCH raw captures shape the length normalisation again',
   file:'src/search.mjs',
   from:"    statsN: curatedN || documents.length,",
   to:"    statsN: documents.length,  // MUTANT: N wieder inklusive Rohfang",
   tests:['test/raw-stats.test.mjs'] },

 { name:'ARCH the append path lets fresh captures back into the stats',
   file:'src/search.mjs',
   from:"    if (doc.type !== 'raw') {\n      statsN += 1;",
   to:"    if (true) {  // MUTANT: jeder frische Fang zaehlt wieder mit\n      statsN += 1;",
   tests:['test/raw-stats.test.mjs','test/search.test.mjs'] },

 { name:'ARCH gateway falls back to pure BM25 order (no diversity)',
   file:'src/retrieval.mjs',
   from:'  mmr = true,',
   to:'  mmr = false,  // MUTANT: der Agentenpfad wieder schlechter als `mem find`',
   tests:['test/gateway-diversity.test.mjs'] },

 { name:'ARCH statusOf defaults to active for anything it does not know',
   file:'src/state.mjs',
   from:"  return state.get(id)?.state ?? 'active';",
   to:"  return 'active';  // MUTANT: state ignored entirely",
   tests:['test/state.test.mjs','test/retrieval.test.mjs'] },
];

// A mutant counts as caught when the tests fail. So on a suite that is
// ALREADY failing, every mutant counts as caught and the score is perfect.
// Found on 2026-09-05 by stripping assertions out of state.test.mjs: one
// test broke, `npm test` went red, and this harness printed 48/48 green.
// A verification tool that scores highest when the thing it verifies is
// broken is worse than none.
{
  const suites=[...new Set(MUTANTS.flatMap((m)=>m.tests))];
  try{ execFileSync('node',['--test',...suites],{cwd:ROOT,stdio:['ignore','pipe','pipe'],encoding:'utf8'}); }
  catch(e){
    const out=String(e.stdout||'');
    const bad=(out.match(/^not ok [0-9]+ - (.*)$/gm)||[]).slice(0,10);
    console.log('The suites these mutants rely on are already failing:\n');
    for(const b of bad) console.log('  '+b);
    console.log('\nMutation testing needs a green baseline. On a red suite every');
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
for(const m of MUTANTS){
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
  if(!failed){
    try{ execFileSync('node',['--test'],{cwd:ROOT,stdio:['ignore','pipe','pipe'],encoding:'utf8'}); }
    catch{ elsewhere=true; }
  }
  restore();
  if(!failed && !elsewhere) survived++;
  if(!failed && elsewhere) misScoped++;
  console.log(`${m.name.padEnd(48)} | ${failed?'yes'+detail
    :elsewhere?'not by its own suite — caught elsewhere, list is wrong':'NO — SURVIVED'}`);
}

const applied=MUTANTS.length-skipped-ambiguous;
console.log(`\n${applied-survived}/${applied} applied mutants caught by tests`
  + ` (of ${MUTANTS.length} defined; ${skipped} anchor gone, ${ambiguous} ambiguous).`);
if(survived) console.log(`${survived} surviving mutant(s) = ${survived} guarantee(s) that exist only in documentation.`);
if(skipped||ambiguous) console.log(`${skipped+ambiguous} mutant(s) did not run. An untested guarantee is not a kept one — re-anchor them.`);
if(misScoped) console.log(`${misScoped} mutant(s) name the wrong suite: the guarantee is kept, the bookkeeping is not.`);
if(survived||skipped||ambiguous) process.exitCode = 1;

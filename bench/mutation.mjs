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
const ROOT='/home/user/cheap-mem';

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
   from:"    if (first) { note(c.id, `identical body to ${first}`); continue; }",
   to:"    // MUTANT: dedup removed",
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
];

let survived=0;
console.log('Mutant                                           | do tests fail?');
console.log('-------------------------------------------------+----------------');
for(const m of MUTANTS){
  const p=`${ROOT}/${m.file}`;
  const orig=fs.readFileSync(p,'utf8');
  if(!orig.includes(m.from)){ console.log(`${m.name.padEnd(48)} | ANCHOR MISSING — the mutant no longer applies`); continue; }
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
  fs.writeFileSync(p,orig);
  if(!failed) survived++;
  console.log(`${m.name.padEnd(48)} | ${failed?'yes'+detail:'NO — SURVIVED'}`);
}
console.log(`\n${MUTANTS.length-survived}/${MUTANTS.length} mutants caught by tests.`);
if(survived) { console.log(`${survived} surviving mutant(s) = ${survived} guarantee(s) that exist only in documentation.`); process.exitCode = 1; }

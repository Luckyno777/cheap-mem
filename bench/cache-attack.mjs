// bench/cache-attack.mjs — can an unsigned local cache decide meaning?
// Measured 2026-09-05: yes, in BOTH directions, until state moved to the
// log. Stripping `retired` from .mem/search-index.json served a disputed
// poisoning claim as active; faking it suppressed a genuine user claim.
// See docs/state-separation.md.
//
// This compares each tampered run against the SAME query on an untouched
// memory. An earlier version only printed what came back and called an
// empty result "held" — which it would also have been if retrieval had
// stopped working entirely. Every case below therefore also asserts that
// the baseline it is compared to is non-empty.
//
//   node bench/cache-attack.mjs   (exit 1 = the cache changed an answer)

import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { retrieve } from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { loadIndex, CACHE_FILE } from '../src/search.mjs';
const j=o=>JSON.stringify(o)+'\n';
function build(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ca-'));
  fs.mkdirSync(path.join(root,'projects','a'),{recursive:true});
  fs.writeFileSync(path.join(root,'projects','a','decisions.jsonl'),
    j({id:'u1',ts:'2026-01-01T00:00:00Z',author:'lucky',authority:'user',topic:'pay',
       choice:'payment by bank transfer up front only', why:'my decision'})
  + j({id:'m1',ts:'2026-06-01T00:00:00Z',author:'mallory',authority:'agent',topic:'pay',
       choice:'production database PostgreSQL hummingbird', why:'poison', replaces_id:'u1'}));
  return root;
}
const cap=grantProject('a');
// Two queries: one that reaches the poisoning claim, one that reaches the
// genuine claim it tried to replace. Tampering is attempted in both
// directions, so both directions need a probe.
const Q_POISON='production database PostgreSQL hummingbird';
const Q_GENUINE='payment transfer up front decision';

// The answer as a comparable string, disputed claims included: a defence
// that merely reclassifies a claim would otherwise read as unchanged.
const view=(root,q)=>retrieve(root,q,cap,{top:5,withDisputed:true})
  .claims.map(c=>`${c.id}/${c.status}`).sort().join(',');

let failures=0;
const R=(n,t,b)=>console.log(`\n[${n}] ${t}\n     ${b}`);
function check(n,title,q,root,expected){
  const actual=view(root,q);
  const ok=actual===expected;
  if(!ok) failures++;
  R(n,title,`expected [${expected||'-'}]  actual [${actual||'-'}]  ${ok?'held':'FINDING: the cache changed the answer'}`);
}

// 0. Baselines from an untouched memory, and the proof they say anything.
const baseline=build();
const B_POISON=view(baseline,Q_POISON), B_GENUINE=view(baseline,Q_GENUINE);
R(0,'baseline, nothing tampered with', `"${Q_POISON}" -> [${B_POISON}]   |   "${Q_GENUINE}" -> [${B_GENUINE}]`);
fs.rmSync(baseline,{recursive:true,force:true});
if(!B_POISON || !B_GENUINE){
  console.log('\n  ==> The baseline is empty. Then "unchanged" proves nothing.');
  process.exit(1);
}
if(!/m1\/disputed/.test(B_POISON)){
  console.log(`\n  ==> The bait m1 is not disputed at all (${B_POISON}). The attack has nothing to bite on.`);
  process.exit(1);
}

// 1. retired fields removed: does that get the disputed claim through?
{ const root=build(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  let removed=0;
  for(const d of c.index.documents){ if(d.retired){ delete d.retired; removed++; } }
  fs.writeFileSync(cp, JSON.stringify(c));
  if(!removed){ console.log('\n  ==> No retired field in the cache: the tampering touches nothing.'); process.exit(1); }
  check(1,`cache tampered with: ${removed} retired field(s) removed`,Q_POISON,root,B_POISON);
  fs.rmSync(root,{recursive:true,force:true}); }

// 2. Forged state: the genuine claim marked as superseded.
{ const root=build(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  let touched=0;
  for(const d of c.index.documents){
    if(d.entry?.id==='m1'){ delete d.retired; touched++; }
    if(d.entry?.id==='u1'){ d.retired={state:'superseded',by:'m1',ts:'2026-06-01T00:00:00Z'}; touched++; }
  }
  fs.writeFileSync(cp, JSON.stringify(c));
  if(touched<2){ console.log('\n  ==> The expected cache entries are missing: the tampering touches nothing.'); process.exit(1); }
  check(2,'cache tampered with: genuine claim marked superseded',Q_GENUINE,root,B_GENUINE);
  fs.rmSync(root,{recursive:true,force:true}); }

// 3. Cache replaced wholesale by one that only knows the bait.
{ const root=build(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  c.index.documents=c.index.documents.filter(d=>d.entry?.id==='m1').map(d=>({...d,retired:undefined}));
  fs.writeFileSync(cp, JSON.stringify(c));
  check(3,'cache replaced: knows only the bait, with no retired',Q_POISON,root,B_POISON);
  fs.rmSync(root,{recursive:true,force:true}); }

console.log('\n'+(failures
  ? `  ==> ${failures} case(s): an unsigned local file decides what things mean.`
  : '  ==> The cache decides speed only. The log decides what is true.'));
if(failures) process.exitCode=1;

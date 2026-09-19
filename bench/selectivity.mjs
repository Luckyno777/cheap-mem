// bench/selectivity.mjs — is the bottleneck the scan, or the candidate set?
// Measured 2026-09-05: rare-term candidate generation scores 3x-1038x fewer
// documents with identical top-10 in 8 of 8 queries. See
// docs/architecture-audit-2026-09-05.md section 3.

// Hypothesis: what is missing is not the posting list but the CHOICE of
// terms. A union over ALL terms is as unselective as its commonest term.
// A union over only the rare terms ought to return the same top 10 — and
// orders of magnitude more cheaply. Measured here, not asserted.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildIndex, search, tokenizeGroups } from '../src/search.mjs';
import * as thesaurus from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';
const TOPICS=['billing','auth','database','ci','ops','frontend','security','deploy','cache','queue'];
const VERBS=['fixed','moved','removed','added','renamed','split','merged','reverted'];
function rnd(s){return()=>((s=s*1103515245+12345&0x7fffffff)/0x7fffffff);}
function corpus(n){const r=rnd(7),d=[];for(let i=0;i<n;i++){
 const t=TOPICS[Math.floor(r()*TOPICS.length)],v=VERBS[Math.floor(r()*VERBS.length)];
 const rare='id'+Math.floor(Math.pow(r(),3)*n), rare2='file'+Math.floor(Math.pow(r(),2)*n/10)+'.mjs';
 d.push({id:'e'+i,ts:new Date(Date.now()-i*60000).toISOString(),topic:t,
  choice:`${v} ${t} handler ${rare}`,why:`the ${t} path in ${rare2} was ${v} because the ${t} check failed on ${rare}`});}
 return d;}
const N=100000;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wand-'));
fs.mkdirSync(path.join(dir,'projects','p'),{recursive:true});
fs.writeFileSync(path.join(dir,'projects','p','decisions.jsonl'),corpus(N).map(o=>JSON.stringify(o)).join('\n')+'\n');
const idx=buildIndex(dir); const lang=pack(idx.language??'en');

// Build the inverted posting lists once (this is what the index rework would do).
const post=new Map();
for(let i=0;i<idx.documents.length;i++) for(const t of idx.documents[i].weights.keys()){
  let a=post.get(t); if(!a){a=[];post.set(t,a);} a.push(i);
}
const QUERIES=['billing handler failed','auth check database','security deploy queue',
              'id42','file12.mjs','id42 file12.mjs','id7 id42 id99','frontend cache id300'];
console.log(`corpus ${idx.N}, vocabulary ${idx.lexicon.size}, posting lists ${post.size}\n`);
console.log('query                     | union all  | union rare   | factor  | same top 10?');
console.log('--------------------------+------------+--------------+---------+---------------');
for(const q of QUERIES){
  const groups=tokenizeGroups(q,{lexicon:idx.lexicon,lang}); const own=groups.flat();
  const terms=new Set(own);
  for(const [syn] of thesaurus.expand(own, idx.tagGraph, lang, idx.termGraph)) terms.add(lang.stem(lang.normalize(syn)));
  const withDf=[...terms].map(t=>[t,(post.get(t)||[]).length]).filter(([,d])=>d>0).sort((a,b)=>a[1]-b[1]);
  if(!withDf.length){console.log(`${q.padEnd(25)} | (no terms in the index)`);continue;}
  const all=new Set(); for(const [t] of withDf) for(const i of post.get(t)) all.add(i);
  // "rare" = terms whose posting list is at most N/20 long; if every term is
  // common, take the rarest single one (lower bound: there must be candidates).
  const threshold=idx.N/20;
  let chosen=withDf.filter(([,d])=>d<=threshold); if(!chosen.length) chosen=[withDf[0]];
  const few=new Set(); for(const [t] of chosen) for(const i of post.get(t)) few.add(i);
  // Compare the results: full scan vs. scoring only the candidates.
  const fullTop=search(idx,q,{top:10}).map(h=>h.entry.id).join(',');
  const partIdx={...idx, documents:[...few].map(i=>idx.documents[i])};
  const partTop=search(partIdx,q,{top:10}).map(h=>h.entry.id).join(',');
  console.log(`${q.padEnd(25)} | ${String(all.size).padStart(10)} | ${String(few.size).padStart(12)} | ${(all.size/Math.max(1,few.size)).toFixed(1).padStart(6)}x | ${fullTop===partTop?'yes':'NO'}`);
}
fs.rmSync(dir,{recursive:true,force:true});

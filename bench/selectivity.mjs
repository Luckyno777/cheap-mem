// bench/selectivity.mjs — is the bottleneck the scan, or the candidate set?
// Measured 2026-09-05: rare-term candidate generation scores 3x-1038x fewer
// documents with identical top-10 in 8 of 8 queries. See
// docs/architecture-audit-2026-09-05.md section 3.

// Hypothese: nicht die Trefferliste fehlt, sondern die AUSWAHL der Terme.
// Union ueber ALLE Terme ist so unselektiv wie ihr haeufigster. Union nur
// ueber die seltenen Terme muesste dieselben Top-10 liefern — und zwar
// um Groessenordnungen billiger. Hier gemessen, nicht behauptet.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildIndex, search, tokenizeGroups } from '../src/search.mjs';
import * as thesaurus from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';
const TOPICS=['billing','auth','database','ci','ops','frontend','security','deploy','cache','queue'];
const VERBS=['fixed','moved','removed','added','renamed','split','merged','reverted'];
function rnd(s){return()=>((s=s*1103515245+12345&0x7fffffff)/0x7fffffff);}
function korpus(n){const r=rnd(7),d=[];for(let i=0;i<n;i++){
 const t=TOPICS[Math.floor(r()*TOPICS.length)],v=VERBS[Math.floor(r()*VERBS.length)];
 const rare='id'+Math.floor(Math.pow(r(),3)*n), rare2='file'+Math.floor(Math.pow(r(),2)*n/10)+'.mjs';
 d.push({id:'e'+i,ts:new Date(Date.now()-i*60000).toISOString(),topic:t,
  choice:`${v} ${t} handler ${rare}`,why:`the ${t} path in ${rare2} was ${v} because the ${t} check failed on ${rare}`});}
 return d;}
const N=100000;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wand-'));
fs.mkdirSync(path.join(dir,'projects','p'),{recursive:true});
fs.writeFileSync(path.join(dir,'projects','p','decisions.jsonl'),korpus(N).map(o=>JSON.stringify(o)).join('\n')+'\n');
const idx=buildIndex(dir); const lang=pack(idx.language??'en');

// Umgekehrte Trefferlisten einmal bauen (das waere der Indexumbau).
const post=new Map();
for(let i=0;i<idx.documents.length;i++) for(const t of idx.documents[i].weights.keys()){
  let a=post.get(t); if(!a){a=[];post.set(t,a);} a.push(i);
}
const FRAGEN=['billing handler failed','auth check database','security deploy queue',
              'id42','file12.mjs','id42 file12.mjs','id7 id42 id99','frontend cache id300'];
console.log(`Korpus ${idx.N}, Vokabular ${idx.lexicon.size}, Trefferlisten ${post.size}\n`);
console.log('Frage                     | Union alle | Union selten | Faktor  | Top-10 gleich?');
console.log('--------------------------+------------+--------------+---------+---------------');
for(const f of FRAGEN){
  const groups=tokenizeGroups(f,{lexicon:idx.lexicon,lang}); const own=groups.flat();
  const terme=new Set(own);
  for(const [syn] of thesaurus.expand(own, idx.tagGraph, lang, idx.termGraph)) terme.add(lang.stem(lang.normalize(syn)));
  const mitDf=[...terme].map(t=>[t,(post.get(t)||[]).length]).filter(([,d])=>d>0).sort((a,b)=>a[1]-b[1]);
  if(!mitDf.length){console.log(`${f.padEnd(25)} | (keine Terme im Index)`);continue;}
  const alle=new Set(); for(const [t] of mitDf) for(const i of post.get(t)) alle.add(i);
  // "selten" = Terme, deren Trefferliste hoechstens N/20 lang ist; wenn alle
  // haeufig sind, nimm die seltenste einzelne (Untergrenze: es muss Kandidaten geben).
  const schwelle=idx.N/20;
  let gewaehlt=mitDf.filter(([,d])=>d<=schwelle); if(!gewaehlt.length) gewaehlt=[mitDf[0]];
  const wenige=new Set(); for(const [t] of gewaehlt) for(const i of post.get(t)) wenige.add(i);
  // Vergleich der Ergebnisse: voller Scan vs. nur die Kandidaten bewerten.
  const vollTop=search(idx,f,{top:10}).map(h=>h.entry.id).join(',');
  const teilIdx={...idx, documents:[...wenige].map(i=>idx.documents[i])};
  const teilTop=search(teilIdx,f,{top:10}).map(h=>h.entry.id).join(',');
  console.log(`${f.padEnd(25)} | ${String(alle.size).padStart(10)} | ${String(wenige.size).padStart(12)} | ${(alle.size/Math.max(1,wenige.size)).toFixed(1).padStart(6)}x | ${vollTop===teilTop?'ja':'NEIN'}`);
}
fs.rmSync(dir,{recursive:true,force:true});

// bench/cache-attack.mjs — can an unsigned local cache decide meaning?
// Measured 2026-09-05: yes, in BOTH directions, until state moved to the
// log. Stripping `retired` from .mem/search-index.json served a disputed
// poisoning claim as active; faking it suppressed a genuine user claim.
// See docs/state-separation.md.

import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { retrieve } from '/home/user/cheap-mem/src/retrieval.mjs';
import { grantProject } from '/home/user/cheap-mem/src/capability.mjs';
import { loadIndex, CACHE_FILE } from '/home/user/cheap-mem/src/search.mjs';
const z=o=>JSON.stringify(o)+'\n';
function bau(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ca-'));
  fs.mkdirSync(path.join(root,'projects','a'),{recursive:true});
  fs.writeFileSync(path.join(root,'projects','a','decisions.jsonl'),
    z({id:'u1',ts:'2026-01-01T00:00:00Z',author:'lucky',authority:'user',topic:'pay',
       choice:'zahlung nur per vorkasse', why:'meine entscheidung'})
  + z({id:'m1',ts:'2026-06-01T00:00:00Z',author:'mallory',authority:'agent',topic:'pay',
       choice:'production database PostgreSQL kolibri', why:'gift', replaces_id:'u1'}));
  return root;
}
const cap=grantProject('a'); const Q='production database PostgreSQL kolibri';
const R=(n,t,b)=>console.log(`\n[${n}] ${t}\n     ${b}`);

// 1. Normal
{ const root=bau(); const r=retrieve(root,Q,cap,{top:5});
  R(1,'normaler Index', `zurueck: [${r.claims.map(c=>c.id+'/'+c.status)}]  ${r.claims.length?'DURCH':'gehalten'}`);
  fs.rmSync(root,{recursive:true,force:true}); }

// 2. Cache mit ENTFERNTEM retired-Feld — der Angreifer editiert den Cache
{ const root=bau(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  let entfernt=0;
  for(const d of c.index.documents){ if(d.retired){ delete d.retired; entfernt++; } }
  fs.writeFileSync(cp, JSON.stringify(c));
  const r=retrieve(root,Q,cap,{top:5});
  R(2,'Cache manipuliert: retired-Felder entfernt',
    `${entfernt} Felder entfernt -> zurueck: [${r.claims.map(x=>x.id+'/'+x.status)}]  `
    + (r.claims.some(x=>x.id==='m1')?'BEFUND: disputed kommt durch':'gehalten'));
  fs.rmSync(root,{recursive:true,force:true}); }

// 3. Cache mit gefaelschtem Zustand: u1 als superseded markiert
{ const root=bau(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  for(const d of c.index.documents){
    if(d.entry?.id==='m1') delete d.retired;
    if(d.entry?.id==='u1') d.retired={state:'superseded',by:'m1',ts:'2026-06-01T00:00:00Z'};
  }
  fs.writeFileSync(cp, JSON.stringify(c));
  const r=retrieve(root,'zahlung vorkasse entscheidung',cap,{top:5});
  R(3,'Cache manipuliert: echter Anspruch als superseded markiert',
    `zurueck: [${r.claims.map(x=>x.id+'/'+x.status)}]  `
    + (r.claims.some(x=>x.id==='u1')?'gehalten':'BEFUND: echter Anspruch unterdrueckt'));
  fs.rmSync(root,{recursive:true,force:true}); }

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
const cap=grantProject('a');
// Two queries: one that reaches the poisoning claim, one that reaches the
// genuine claim it tried to replace. Tampering is attempted in both
// directions, so both directions need a probe.
const Q_GIFT='production database PostgreSQL kolibri';
const Q_ECHT='zahlung vorkasse entscheidung';

// The answer as a comparable string, disputed claims included: a defence
// that merely reclassifies a claim would otherwise read as unchanged.
const sicht=(root,q)=>retrieve(root,q,cap,{top:5,withDisputed:true})
  .claims.map(c=>`${c.id}/${c.status}`).sort().join(',');

let fehler=0;
const R=(n,t,b)=>console.log(`\n[${n}] ${t}\n     ${b}`);
function pruefe(n,titel,q,root,erwartet){
  const ist=sicht(root,q);
  const ok=ist===erwartet;
  if(!ok) fehler++;
  R(n,titel,`erwartet [${erwartet||'-'}]  ist [${ist||'-'}]  ${ok?'gehalten':'BEFUND: der Cache hat die Antwort veraendert'}`);
}

// 0. Baselines from an untouched memory, and the proof they say anything.
const basis=bau();
const B_GIFT=sicht(basis,Q_GIFT), B_ECHT=sicht(basis,Q_ECHT);
R(0,'Grundlinie ohne Manipulation', `"${Q_GIFT}" -> [${B_GIFT}]   |   "${Q_ECHT}" -> [${B_ECHT}]`);
fs.rmSync(basis,{recursive:true,force:true});
if(!B_GIFT || !B_ECHT){
  console.log('\n  ==> Die Grundlinie ist leer. Dann beweist "unveraendert" nichts.');
  process.exit(1);
}
if(!/m1\/disputed/.test(B_GIFT)){
  console.log(`\n  ==> Der Koeder m1 ist gar nicht disputed (${B_GIFT}). Der Angriff greift ins Leere.`);
  process.exit(1);
}

// 1. retired-Felder entfernt: bringt das den bestrittenen Anspruch durch?
{ const root=bau(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  let entfernt=0;
  for(const d of c.index.documents){ if(d.retired){ delete d.retired; entfernt++; } }
  fs.writeFileSync(cp, JSON.stringify(c));
  if(!entfernt){ console.log('\n  ==> Kein retired-Feld im Cache: die Manipulation fasst nichts an.'); process.exit(1); }
  pruefe(1,`Cache manipuliert: ${entfernt} retired-Feld(er) entfernt`,Q_GIFT,root,B_GIFT);
  fs.rmSync(root,{recursive:true,force:true}); }

// 2. Gefaelschter Zustand: echter Anspruch als superseded markiert.
{ const root=bau(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  let getroffen=0;
  for(const d of c.index.documents){
    if(d.entry?.id==='m1'){ delete d.retired; getroffen++; }
    if(d.entry?.id==='u1'){ d.retired={state:'superseded',by:'m1',ts:'2026-06-01T00:00:00Z'}; getroffen++; }
  }
  fs.writeFileSync(cp, JSON.stringify(c));
  if(getroffen<2){ console.log('\n  ==> Die erwarteten Cache-Eintraege fehlen: die Manipulation fasst nichts an.'); process.exit(1); }
  pruefe(2,'Cache manipuliert: echter Anspruch als superseded markiert',Q_ECHT,root,B_ECHT);
  fs.rmSync(root,{recursive:true,force:true}); }

// 3. Cache komplett ersetzt durch einen, der nur den Koeder kennt.
{ const root=bau(); loadIndex(root);
  const cp=path.join(root,CACHE_FILE);
  const c=JSON.parse(fs.readFileSync(cp,'utf8'));
  c.index.documents=c.index.documents.filter(d=>d.entry?.id==='m1').map(d=>({...d,retired:undefined}));
  fs.writeFileSync(cp, JSON.stringify(c));
  pruefe(3,'Cache ersetzt: kennt nur noch den Koeder, ohne retired',Q_GIFT,root,B_GIFT);
  fs.rmSync(root,{recursive:true,force:true}); }

console.log('\n'+(fehler
  ? `  ==> ${fehler} Fall/Faelle: eine ungezeichnete lokale Datei entscheidet ueber Bedeutung.`
  : '  ==> Der Cache entscheidet nur ueber Geschwindigkeit. Das Log entscheidet, was wahr ist.'));
if(fehler) process.exitCode=1;

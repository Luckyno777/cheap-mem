// bench/gateway-attack.mjs — attacking the gateway that was built to fix
// the earlier findings. Five attacks; two found real defects in it and are
// now fixed (global invisible to a project capability; the author-share cap
// bypassed by rotating names). Two are known-unsolved and say so. One held.
// See docs/security-model.md section 8.

import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { retrieve, enforceAuthorShare, LIMITS } from '../src/retrieval.mjs';
import { grantProject, grantAll } from '../src/capability.mjs';
import * as memory from '../src/memory.mjs';
const R=(n,t,b)=>console.log(`\n[${n}] ${t}\n     ${b}`);
function mem(byScope){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'v3-'));
  fs.mkdirSync(path.join(root,'global'),{recursive:true});
  for(const [scope,es] of Object.entries(byScope)){
    const dir = scope==='global' ? path.join(root,'global') : path.join(root,'projects',scope);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'decisions.jsonl'), es.map(e=>JSON.stringify(e)).join('\n')+'\n');
  }
  return root;
}
const c=(id,x={})=>({id,ts:'2026-01-01T00:00:00Z',topic:'t',choice:'kolibri routing',why:'reason',...x});

// A1: can a project capability see global facts?
{ const root=mem({global:[c('g1',{choice:'kolibri timezone is Europe/Berlin'})], a:[c('a1')]});
  const r=retrieve(root,'kolibri',grantProject('a'));
  R('A1','a project capability and global facts',
    `returned: [${r.claims.map(x=>x.id)}] — global visible: ${r.claims.some(x=>x.id==='g1')?'yes (HELD)':'NO — a project session cannot see who the user is'}`);
  fs.rmSync(root,{recursive:true,force:true}); }

// A2: bypass the author-share cap by rotating names
{ const claims=Array.from({length:20},(_,i)=>({id:'x'+i,author:'sybil'+i,authority:'agent',body:'b',score:1,status:'active'}));
  const kept=enforceAuthorShare(claims,LIMITS);
  // The cap alone, and then the same attack through the real gateway --
  // where identical bodies collapse DURING selection. Content is what an
  // attacker cannot vary and still rank; a name is free.
  const root=mem({a:[
    ...Array.from({length:5},(_,i)=>c('e'+i,{author:'alice',authority:'agent',
      choice:`kolibri routing variant ${i}`,why:`distinct reasoning number ${i}`})),
    ...Array.from({length:20},(_,i)=>c('s'+i,{author:'sybil'+i,authority:'agent',
      choice:'kolibri routing',why:'kolibri routing'}))]});
  const g=retrieve(root,'kolibri routing',grantProject('a'),{top:10});
  const floods=g.claims.filter(x=>x.id.startsWith('s')).length;
  const real=g.claims.filter(x=>x.id.startsWith('e')).length;
  R('A2','rotating author names to bypass the share cap',
    `enforceAuthorShare alone: 20 claims under 20 names -> ${kept.length} kept `
    + `(the cap bounds a NAMED flooder and nothing else)\n`
    + `     retrieve(): ${floods} flood + ${real} genuine of 10  `
    + `${floods<=1&&real>=3?'HELD: identical bodies collapse during selection':'FAILED'}`);
  fs.rmSync(root,{recursive:true,force:true}); }

// A3: simply claim a higher tier
{ const root=mem({a:[c('a1',{author:'alice',authority:'agent',choice:'kolibri SEPA up front'}),
                     c('m1',{author:'mallory',authority:'user',choice:'kolibri no checks',replaces_id:'a1'})]});
  const map=memory.retiredMap(memory.readLog(root,'decision',{project:'a'}).entries);
  R('A3','attacker simply writes authority:user',
    `a1 retired: ${map.get('a1')?.state ?? 'no'} — ${map.get('a1')?'PASSES, by design: the field is not forgery-proof. Poisoning costs repository write access, not one line. Stated in docs/security-model.md, never sold as cryptography.':'held'}`);
  fs.rmSync(root,{recursive:true,force:true}); }

// A4: one huge claim starves the others through the context budget
{ const big=c('BIG',{why:'kolibri '.repeat(4000)});
  const rest=Array.from({length:10},(_,i)=>c('r'+i,{choice:'kolibri routing detail '+i}));
  const root=mem({a:[big,...rest]});
  const r=retrieve(root,'kolibri',grantProject('a'),{top:10});
  R('A4','one huge claim eats the context budget',
    `returned ${r.claims.length} claims [${r.claims.map(x=>x.id).slice(0,6)}...] — `+
    `budget exclusions: ${r.excluded.filter(e=>/budget/.test(e.why)).length}  `+
    `${r.claims.length>=5?'HELD: the per-claim cap truncates before the budget can be starved':'FAILED'}`);
  fs.rmSync(root,{recursive:true,force:true}); }

// A5: ranking eviction, now against the gateway
{ const echt=Array.from({length:50},(_,i)=>c('e'+i,{author:'alice',authority:'agent',
    choice:`deploy to production uses blue green ${i}`,why:'the deploy pipeline switches traffic after health checks'}));
  const gift=c('KURZ',{author:'mallory',authority:'agent',choice:'deploy to production',why:'deploy production'});
  const root=mem({a:[...echt,gift]});
  const r=retrieve(root,'how do we deploy to production',grantProject('a'),{top:3});
  R('A5','a short claim carrying the query words, against the gateway',
    `top-3: [${r.claims.map(x=>x.id)}] — ${r.claims[0]?.id==='KURZ'?'STILL WORKS, and is documented as unsolved: authority only decides where claims CONFLICT, and detecting that deterministically is open':'no longer'}`);
  fs.rmSync(root,{recursive:true,force:true}); }

import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { buildIndex, search } from '/home/user/cheap-mem/src/search.mjs';
const z=(o)=>JSON.stringify(o)+'\n';
function probe(gift){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'rk-'));
  fs.mkdirSync(path.join(d,'projects','a'),{recursive:true});
  const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, Array.from({length:50},(_,i)=>z({id:'e'+i,ts:'2026-06-01T00:00:00Z',topic:'deploy',
    choice:`deploy to production uses blue green ${i}`,
    why:'the deploy pipeline switches traffic after health checks and waits for the readiness probe'})).join(''));
  if(gift) fs.appendFileSync(p,z(gift));
  const r=search(buildIndex(d),'how do we deploy to production',{top:3}).map(h=>`${h.entry.id}:${h.score.toFixed(2)}`);
  fs.rmSync(d,{recursive:true,force:true}); return r;
}
console.log('Angriff                              | Top-3');
console.log('-------------------------------------+------------------------------------');
console.log(`${'(kein Angriff)'.padEnd(36)} | ${probe(null).join('  ')}`);
console.log(`${'nur Zukunftsdatum (ts 2099)'.padEnd(36)} | ${probe({id:'ZUKUNFT',ts:'2099-01-01T00:00:00Z',topic:'deploy',choice:'deploy to production uses blue green 99',why:'the deploy pipeline switches traffic after health checks and waits for the readiness probe'}).join('  ')}`);
console.log(`${'nur KURZ (alle Fragewoerter)'.padEnd(36)} | ${probe({id:'KURZ',ts:'2026-06-01T00:00:00Z',topic:'deploy',choice:'deploy to production',why:'deploy production'}).join('  ')}`);
console.log(`${'nur Term-Stuffing'.padEnd(36)} | ${probe({id:'STUFF',ts:'2026-06-01T00:00:00Z',topic:'deploy',choice:'deploy deploy deploy production production production',why:'deploy production deploy production deploy production deploy production'}).join('  ')}`);

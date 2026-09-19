// bench/query-independence.mjs — does the query change the STATE?
// The same log, six queries that hit different subsets. Every query must
// agree about which claims are active, superseded and disputed; only the
// SELECTION may differ. This is the invariant the post-closure round was
// built around.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { retrieve } from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
const j=o=>JSON.stringify(o)+'\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qi-'));
fs.mkdirSync(path.join(root,'projects','a'),{recursive:true});
fs.writeFileSync(path.join(root,'projects','a','decisions.jsonl'),
  j({id:'A',ts:'2026-01-01T00:00:00Z',author:'alice',authority:'agent',topic:'loc',
     choice:'Server X is in Frankfurt', why:'decided that way first'})
+ j({id:'B',ts:'2026-06-01T00:00:00Z',author:'alice',authority:'agent',topic:'loc',
     choice:'Server X is in Berlin', why:'relocated', replaces_id:'A'})
+ j({id:'M',ts:'2026-07-01T00:00:00Z',author:'mallory',authority:'agent',topic:'loc',
     choice:'entirely different words in here', why:'poisoning', replaces_id:'B'}));

const cap=grantProject('a');
const Q={
 'Q1 hits only A':    'Frankfurt decided first',
 'Q2 hits only B':    'Berlin relocated',
 'Q3 hits both':      'Server X is',
 'Q4 hits neither':   'completely unrelated subject',
 'Q5 hits only M':    'entirely different words poisoning',
 'Q6 very many hits': 'server x is in frankfurt berlin relocated words',
};
// The state as each query SEES it: id -> status, over hits AND exclusions.
function view(q){
  const r=retrieve(root,q,cap,{top:20,withDisputed:true});
  const m={};
  for(const c of r.claims) m[c.id]=c.status;
  for(const e of r.excluded) if(e.id) m[e.id]=m[e.id]??('excl:'+e.why);
  return m;
}
const views=Object.entries(Q).map(([k,q])=>[k,view(q)]);
console.log('query                   | A                | B                | M');
console.log('------------------------+------------------+------------------+------------------');
for(const [k,m] of views)
  console.log(`${k.padEnd(23)} | ${String(m.A??'-').padEnd(16)} | ${String(m.B??'-').padEnd(16)} | ${String(m.M??'-')}`);

// Contradiction: does one query say 'active' and another 'superseded/disputed'?
const conflicts=[];
for(const id of ['A','B','M']){
  const values=new Set(views.map(([,m])=>m[id]).filter(v=>v && v!=='-')
    .map(v=>String(v).startsWith('excl:')?String(v).replace(/^excl:/,''):v));
  if(values.size>1) conflicts.push(`${id}: {${[...values].join(' | ')}}`);
}
// Consistency across nothing but empty views is not consistency. Before
// the result means anything, the table must have shown both: at least one
// claim active and at least one superseded or disputed.
const allValues=views.flatMap(([,m])=>Object.values(m)).map(String);
const sawActive=allValues.some(v=>v==='active');
const sawDead=allValues.some(v=>/superseded|disputed/.test(v));
const empty=[];
if(!sawActive) empty.push('not a single query saw an active claim');
if(!sawDead)   empty.push('not a single query saw a superseded or disputed claim');

console.log('\n'+(conflicts.length
  ? '  ==> STATE DEPENDS ON THE QUERY:\n     '+conflicts.join('\n     ')
  : empty.length
    ? '  ==> INCONCLUSIVE: '+empty.join('; ')+'. The table is testing itself, not the code.'
    : '  ==> State is consistent across every query.'));
fs.rmSync(root,{recursive:true,force:true});
if(conflicts.length||empty.length) process.exitCode=1;

// bench/query-independence.mjs — does the query change the STATE?
// The same log, six queries that hit different subsets. Every query must
// agree about which claims are active, superseded and disputed; only the
// SELECTION may differ. This is the invariant the post-closure round was
// built around.

// Haengt der abgeleitete Zustand von der Anfrage ab?
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { retrieve } from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
const z=o=>JSON.stringify(o)+'\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'qi-'));
fs.mkdirSync(path.join(root,'projects','a'),{recursive:true});
fs.writeFileSync(path.join(root,'projects','a','decisions.jsonl'),
  z({id:'A',ts:'2026-01-01T00:00:00Z',author:'alice',authority:'agent',topic:'loc',
     choice:'Server X steht in Frankfurt', why:'zuerst so entschieden'})
+ z({id:'B',ts:'2026-06-01T00:00:00Z',author:'alice',authority:'agent',topic:'loc',
     choice:'Server X steht in Berlin', why:'umgezogen', replaces_id:'A'})
+ z({id:'M',ts:'2026-07-01T00:00:00Z',author:'mallory',authority:'agent',topic:'loc',
     choice:'ganz andere woerter hier drin', why:'vergiftung', replaces_id:'B'}));

const cap=grantProject('a');
const Q={
 'Q1 trifft nur A':      'Frankfurt zuerst entschieden',
 'Q2 trifft nur B':      'Berlin umgezogen',
 'Q3 trifft beide':      'Server X steht',
 'Q4 trifft keinen':     'voellig unbeteiligtes thema',
 'Q5 trifft nur M':      'ganz andere woerter vergiftung',
 'Q6 sehr viele Treffer':'server x steht in frankfurt berlin umgezogen woerter',
};
// Der Zustand, wie ihn jede Anfrage SIEHT: id -> status, ueber Treffer UND Ausschluesse.
function sicht(q){
  const r=retrieve(root,q,cap,{top:20,withDisputed:true});
  const m={};
  for(const c of r.claims) m[c.id]=c.status;
  for(const e of r.excluded) if(e.id) m[e.id]=m[e.id]??('excl:'+e.why);
  return m;
}
const sichten=Object.entries(Q).map(([k,q])=>[k,sicht(q)]);
console.log('Anfrage                 | A                | B                | M');
console.log('------------------------+------------------+------------------+------------------');
for(const [k,m] of sichten)
  console.log(`${k.padEnd(23)} | ${String(m.A??'-').padEnd(16)} | ${String(m.B??'-').padEnd(16)} | ${String(m.M??'-')}`);

// Widerspruch: sagt eine Anfrage 'active' und eine andere 'superseded/disputed'?
const konflikte=[];
for(const id of ['A','B','M']){
  const werte=new Set(sichten.map(([,m])=>m[id]).filter(v=>v && v!=='-')
    .map(v=>String(v).startsWith('excl:')?String(v).replace(/^excl:/,''):v));
  if(werte.size>1) konflikte.push(`${id}: {${[...werte].join(' | ')}}`);
}
// Konsistenz ueber lauter leere Sichten ist keine Konsistenz. Bevor das
// Ergebnis etwas heisst, muss die Tabelle beides gezeigt haben: mindestens
// einen Anspruch als aktiv und mindestens einen als verdraengt/bestritten.
const alleWerte=sichten.flatMap(([,m])=>Object.values(m)).map(String);
const sahAktiv=alleWerte.some(v=>v==='active');
const sahTot=alleWerte.some(v=>/superseded|disputed/.test(v));
const leer=[];
if(!sahAktiv) leer.push('keine einzige Anfrage sah einen aktiven Anspruch');
if(!sahTot)   leer.push('keine einzige Anfrage sah einen verdraengten oder bestrittenen Anspruch');

console.log('\n'+(konflikte.length
  ? '  ==> ZUSTAND HAENGT VON DER ANFRAGE AB:\n     '+konflikte.join('\n     ')
  : leer.length
    ? '  ==> AUSSAGELOS: '+leer.join('; ')+'. Die Tabelle prueft sich selbst, nicht den Code.'
    : '  ==> Zustand ist ueber alle Anfragen konsistent.'));
fs.rmSync(root,{recursive:true,force:true});
if(konflikte.length||leer.length) process.exitCode=1;

// Failure classes that appeared neither in the brief nor in the first audit.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildIndex, search, loadIndex } from '../src/search.mjs';
const j=(o)=>JSON.stringify(o)+'\n';
function fresh(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'ue-'));
 fs.mkdirSync(path.join(d,'projects','a'),{recursive:true});fs.mkdirSync(path.join(d,'global'),{recursive:true});return d;}
const R=(n,t,b)=>console.log(`\n[${n}] ${t}\n     ${b}`);

// --- A: index divergence. Does the incremental extension answer like a full build?
{ const d=fresh(); const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, Array.from({length:200},(_,i)=>j({id:'x'+i,ts:'2026-01-01T00:00:00Z',topic:'t',choice:`alpha beta ${i}`,why:'gamma delta'})).join(''));
  loadIndex(d);                                     // cache holding 200
  fs.appendFileSync(p, Array.from({length:20},(_,i)=>j({id:'y'+i,ts:'2026-02-01T00:00:00Z',topic:'t',choice:`epsilon zeta ${i}`,why:'alpha'})).join(''));
  const incr=loadIndex(d);                           // incremental
  const full=buildIndex(d);                          // full build
  const sameN = incr.N===full.N;
  const queries=['alpha','epsilon zeta 3','gamma delta','alpha beta 7'];
  let diverged=0;
  const details=[];
  for(const q of queries){
    const a=search(incr,q,{top:5}).map(h=>h.entry.id).join(',');
    const b=search(full,q,{top:5}).map(h=>h.entry.id).join(',');
    if(a!==b){diverged++;details.push(`"${q}": incr=[${a}] full=[${b}]`);}
  }
  // idf hangs off docFreq: does that diverge?
  const dfDiff=[...full.docFreq].filter(([t,n])=>(incr.docFreq.get(t)??0)!==n).length;
  R('A','index divergence: incremental vs. full build',
    `N equal: ${sameN} (${incr.N}/${full.N}); docFreq terms differing: ${dfDiff}; top-5 differs on ${diverged}/${queries.length} queries`
    + (details.length? '\n     '+details.join('\n     '):''));
  fs.rmSync(d,{recursive:true,force:true}); }

// --- B: ranking manipulation. Can an attacker write themselves to the top?
{ const d=fresh(); const p=path.join(d,'projects','a','decisions.jsonl');
  const genuine=Array.from({length:50},(_,i)=>j({id:'e'+i,ts:'2026-06-01T00:00:00Z',topic:'deploy',
    choice:`deploy to production uses blue green ${i}`,why:'the deploy pipeline switches traffic after health checks'}));
  fs.writeFileSync(p, genuine.join(''));
  const idx0=buildIndex(d); const before=search(idx0,'how do we deploy to production',{top:3}).map(h=>h.entry.id);
  // Attack 1: term stuffing
  fs.appendFileSync(p, j({id:'POISON1',ts:'2026-06-01T00:00:00Z',topic:'deploy',
    choice:'deploy deploy deploy production production production',why:'deploy production deploy production deploy production deploy production'}));
  // Attack 2: future timestamp (stealing the recency bonus)
  fs.appendFileSync(p, j({id:'POISON2',ts:'2099-01-01T00:00:00Z',topic:'deploy',
    choice:'deploy to production',why:'deploy production'}));
  const idx1=buildIndex(d);
  const after=search(idx1,'how do we deploy to production',{top:3}).map(h=>h.entry.id);
  R('B','ranking manipulation by term stuffing and a future date',
    `before top-3: [${before}]  after: [${after}]  => poison on top: ${after.some(x=>x.startsWith('POISON'))?'YES':'no'}`);
  fs.rmSync(d,{recursive:true,force:true}); }

// --- C: git merge of two clones that both appended
{ const d=fresh();
  const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(d,'init','-q'); git(d,'config','user.email','t@t'); git(d,'config','user.name','t');
  const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, j({id:'base',ts:'2026-01-01T00:00:00Z',choice:'shared'}));
  git(d,'add','-A'); git(d,'commit','-qm','base');
  git(d,'checkout','-qb','agentA'); fs.appendFileSync(p,j({id:'a1',ts:'2026-02-01T00:00:00Z',choice:'from A'}));
  git(d,'add','-A'); git(d,'commit','-qm','A');
  git(d,'checkout','-q','master'); git(d,'checkout','-qb','agentB');
  fs.appendFileSync(p,j({id:'b1',ts:'2026-02-01T00:00:00Z',choice:'from B'}));
  git(d,'add','-A'); git(d,'commit','-qm','B');
  let outcome;
  try{ git(d,'merge','agentA','-m','merge'); outcome='merged cleanly'; }
  catch(e){ outcome='CONFLICT: '+String(e.stdout||e.message).split('\n').filter(l=>l.includes('CONFLICT')||l.includes('Auto')).join(' | '); }
  const content=fs.readFileSync(p,'utf8');
  const marker=content.includes('<<<<<<<');
  let usable=0,broken=0; for(const l of content.split('\n').filter(Boolean)){try{JSON.parse(l);usable++;}catch{broken++;}}
  R('C','git merge: two agents append to the same drawer',
    `${outcome}; conflict markers in the file: ${marker}; lines usable ${usable}, broken ${broken}`);
  fs.rmSync(d,{recursive:true,force:true}); }

// --- D: Unicode / homoglyphs against redaction and search
{ const red=await import('../src/redaction.mjs');
  const name='AWS_SECRET'+'_ACCESS_KEY'; const value='wJalrXUtnFEMI'+'K7MDENGbPxRfiCYEXAMPLEKEY';
  const plain=`export ${name}=${value}`;
  const withNBSP=`export ${name} =${value}`;        // non-breaking space
  const withFullwidth=`export ${name}＝${value}`;        // fullwidth equals sign
  const zwsp=`export ${name}=${value.slice(0,5)}​${value.slice(5)}`; // zero width inside the value
  const f=(s)=>red.redact(s).found.length;
  R('D','Unicode against the redaction',
    `plain: ${f(plain)} hits | NBSP before '=': ${f(withNBSP)} | fullwidth '=': ${f(withFullwidth)} | zero width in the value: ${f(zwsp)}`); }

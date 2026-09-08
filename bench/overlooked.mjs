// Fehlerklassen, die weder im Auftrag noch im ersten Audit vorkamen.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildIndex, search, loadIndex } from '../src/search.mjs';
const z=(o)=>JSON.stringify(o)+'\n';
function neu(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'ue-'));
 fs.mkdirSync(path.join(d,'projects','a'),{recursive:true});fs.mkdirSync(path.join(d,'global'),{recursive:true});return d;}
const R=(n,t,b)=>console.log(`\n[${n}] ${t}\n     ${b}`);

// --- A: Index-Divergenz. Liefert der inkrementelle Anbau dasselbe wie ein Vollbau?
{ const d=neu(); const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, Array.from({length:200},(_,i)=>z({id:'x'+i,ts:'2026-01-01T00:00:00Z',topic:'t',choice:`alpha beta ${i}`,why:'gamma delta'})).join(''));
  loadIndex(d);                                     // Cache mit 200
  fs.appendFileSync(p, Array.from({length:20},(_,i)=>z({id:'y'+i,ts:'2026-02-01T00:00:00Z',topic:'t',choice:`epsilon zeta ${i}`,why:'alpha'})).join(''));
  const ink=loadIndex(d);                            // inkrementell
  const voll=buildIndex(d);                          // Vollbau
  const gleichN = ink.N===voll.N;
  const fragen=['alpha','epsilon zeta 3','gamma delta','alpha beta 7'];
  let abw=0;
  const details=[];
  for(const f of fragen){
    const a=search(ink,f,{top:5}).map(h=>h.entry.id).join(',');
    const b=search(voll,f,{top:5}).map(h=>h.entry.id).join(',');
    if(a!==b){abw++;details.push(`"${f}": ink=[${a}] voll=[${b}]`);}
  }
  // idf haengt an docFreq: weicht die ab?
  const dfAbw=[...voll.docFreq].filter(([t,n])=>(ink.docFreq.get(t)??0)!==n).length;
  R('A','Index-Divergenz: inkrementell vs. Vollbau',
    `N gleich: ${gleichN} (${ink.N}/${voll.N}); docFreq-Terme mit Abweichung: ${dfAbw}; Top-5 abweichend bei ${abw}/${fragen.length} Fragen`
    + (details.length? '\n     '+details.join('\n     '):''));
  fs.rmSync(d,{recursive:true,force:true}); }

// --- B: Ranking-Manipulation. Kann ein Angreifer sich nach oben schreiben?
{ const d=neu(); const p=path.join(d,'projects','a','decisions.jsonl');
  const echt=Array.from({length:50},(_,i)=>z({id:'e'+i,ts:'2026-06-01T00:00:00Z',topic:'deploy',
    choice:`deploy to production uses blue green ${i}`,why:'the deploy pipeline switches traffic after health checks'}));
  fs.writeFileSync(p, echt.join(''));
  const idx0=buildIndex(d); const vorher=search(idx0,'how do we deploy to production',{top:3}).map(h=>h.entry.id);
  // Angriff 1: Term-Stuffing
  fs.appendFileSync(p, z({id:'GIFT1',ts:'2026-06-01T00:00:00Z',topic:'deploy',
    choice:'deploy deploy deploy production production production',why:'deploy production deploy production deploy production deploy production'}));
  // Angriff 2: Zukunfts-Zeitstempel (Recency-Bonus erschleichen)
  fs.appendFileSync(p, z({id:'GIFT2',ts:'2099-01-01T00:00:00Z',topic:'deploy',
    choice:'deploy to production',why:'deploy production'}));
  const idx1=buildIndex(d);
  const nachher=search(idx1,'how do we deploy to production',{top:3}).map(h=>h.entry.id);
  R('B','Ranking-Manipulation durch Term-Stuffing und Zukunftsdatum',
    `vorher Top-3: [${vorher}]  nachher: [${nachher}]  => Gift oben: ${nachher.some(x=>x.startsWith('GIFT'))?'JA':'nein'}`);
  fs.rmSync(d,{recursive:true,force:true}); }

// --- C: git-Merge zweier Klone, die beide angehaengt haben
{ const d=neu();
  const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(d,'init','-q'); git(d,'config','user.email','t@t'); git(d,'config','user.name','t');
  const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, z({id:'base',ts:'2026-01-01T00:00:00Z',choice:'gemeinsam'}));
  git(d,'add','-A'); git(d,'commit','-qm','base');
  git(d,'checkout','-qb','agentA'); fs.appendFileSync(p,z({id:'a1',ts:'2026-02-01T00:00:00Z',choice:'von A'}));
  git(d,'add','-A'); git(d,'commit','-qm','A');
  git(d,'checkout','-q','master'); git(d,'checkout','-qb','agentB');
  fs.appendFileSync(p,z({id:'b1',ts:'2026-02-01T00:00:00Z',choice:'von B'}));
  git(d,'add','-A'); git(d,'commit','-qm','B');
  let ergebnis;
  try{ git(d,'merge','agentA','-m','merge'); ergebnis='sauber gemerged'; }
  catch(e){ ergebnis='KONFLIKT: '+String(e.stdout||e.message).split('\n').filter(l=>l.includes('CONFLICT')||l.includes('Auto')).join(' | '); }
  const inhalt=fs.readFileSync(p,'utf8');
  const marker=inhalt.includes('<<<<<<<');
  let lesbar=0,kaputt=0; for(const l of inhalt.split('\n').filter(Boolean)){try{JSON.parse(l);lesbar++;}catch{kaputt++;}}
  R('C','git-Merge: zwei Agenten haengen im selben Fach an',
    `${ergebnis}; Konfliktmarker in der Datei: ${marker}; Zeilen lesbar ${lesbar}, kaputt ${kaputt}`);
  fs.rmSync(d,{recursive:true,force:true}); }

// --- D: Unicode / Homoglyphen gegen Redaktion und Suche
{ const red=await import('../src/redaction.mjs');
  const name='AWS_SECRET'+'_ACCESS_KEY'; const wert='wJalrXUtnFEMI'+'K7MDENGbPxRfiCYEXAMPLEKEY';
  const normal=`export ${name}=${wert}`;
  const mitNBSP=`export ${name} =${wert}`;        // geschuetztes Leerzeichen
  const mitVollbreite=`export ${name}＝${wert}`;        // Vollbreiten-Gleichheitszeichen
  const zwsp=`export ${name}=${wert.slice(0,5)}​${wert.slice(5)}`; // Nullbreite im Wert
  const f=(s)=>red.redact(s).found.length;
  R('D','Unicode gegen die Redaktion',
    `normal: ${f(normal)} Treffer | NBSP vor '=': ${f(mitNBSP)} | Vollbreiten-'=': ${f(mitVollbreite)} | Nullbreite im Wert: ${f(zwsp)}`); }

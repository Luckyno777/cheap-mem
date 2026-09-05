import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
const z=(o)=>JSON.stringify(o)+'\n';
const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function repo(mitAttrs){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'m-'));
  fs.mkdirSync(path.join(d,'projects','a'),{recursive:true});
  git(d,'init','-q','-b','haupt'); git(d,'config','user.email','t@t'); git(d,'config','user.name','t');
  if(mitAttrs) fs.writeFileSync(path.join(d,'.gitattributes'),'*.jsonl merge=union\n');
  return d;
}
function lauf(mitAttrs, gleicherEintrag){
  const d=repo(mitAttrs); const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, z({id:'base',ts:'2026-01-01T00:00:00Z',choice:'gemeinsam'}));
  git(d,'add','-A'); git(d,'commit','-qm','base');
  git(d,'checkout','-qb','A'); fs.appendFileSync(p,z({id:'a1',ts:'2026-02-01T00:00:00Z',choice:'von A'}));
  git(d,'add','-A'); git(d,'commit','-qm','A');
  git(d,'checkout','-q','haupt'); git(d,'checkout','-qb','B');
  fs.appendFileSync(p, gleicherEintrag ? z({id:'a1',ts:'2026-02-01T00:00:00Z',choice:'von A'})
                                       : z({id:'b1',ts:'2026-02-01T00:00:00Z',choice:'von B'}));
  git(d,'add','-A'); git(d,'commit','-qm','B');
  let st='sauber';
  try{ git(d,'merge','A','-m','merge'); }catch(e){ st='KONFLIKT'; }
  const inhalt=fs.readFileSync(p,'utf8'); const zeilen=inhalt.split('\n').filter(Boolean);
  let ok=0,kaputt=0; const ids=[];
  for(const l of zeilen){ try{ ids.push(JSON.parse(l).id); ok++; }catch{ kaputt++; } }
  fs.rmSync(d,{recursive:true,force:true});
  return {st, ok, kaputt, marker:inhalt.includes('<<<<<<<'), ids};
}
console.log('Fall                                   | Merge    | lesbar | kaputt | Marker | ids');
console.log('---------------------------------------+----------+--------+--------+--------+---------------');
const erg={};
for(const [k,t,attrs,gleich] of [
  ['ohne',  'OHNE .gitattributes, verschiedene Zeilen', false,false],
  ['union', 'MIT  merge=union,   verschiedene Zeilen',  true, false],
  ['gleich','MIT  merge=union,   IDENTISCHE Zeile',     true, true ],
]){
  const r=erg[k]=lauf(attrs,gleich);
  console.log(`${t.padEnd(38)} | ${r.st.padEnd(8)} | ${String(r.ok).padStart(6)} | ${String(r.kaputt).padStart(6)} | ${String(r.marker).padStart(6)} | ${r.ids.join(',')}`);
}

// Der Vertrag, den das Repo mit `*.jsonl merge=union` eingeht — und der
// Gegenbeweis, dass die Vorrichtung ueberhaupt etwas tut. Ohne die
// Kontrollzeile 'ohne' wuerde ein git, das gar nicht mergt, hier gruen
// aussehen.
const fehler=[];
if(erg.union.kaputt) fehler.push(`merge=union hinterlaesst ${erg.union.kaputt} unlesbare Zeile(n)`);
if(erg.union.marker) fehler.push('merge=union hinterlaesst Konfliktmarker in der Datei');
if(erg.union.st!=='sauber') fehler.push(`merge=union mergt nicht sauber (${erg.union.st})`);
if(erg.union.ok!==3) fehler.push(`merge=union verliert Zeilen: ${erg.union.ok} statt 3`);
// Die zweite Haelfte des Vertrags: union dedupliziert NICHT. Zwei Agenten,
// die zufaellig dieselbe Zeile schreiben, behalten eine davon — wer sich
// auf Anzahl verlaesst, muss das wissen.
if(erg.gleich.ok!==2) fehler.push(`identische Zeile: ${erg.gleich.ok} statt 2 (union faltet Duplikate zusammen)`);
// Kontrolle: ohne .gitattributes MUSS es weh tun, sonst misst der Test nichts.
if(!erg.ohne.marker && !erg.ohne.kaputt && erg.ohne.st==='sauber')
  fehler.push('ohne .gitattributes passiert nichts Schlimmes — dann belegt dieser Lauf nicht, dass der Treiber wirkt');

console.log('\n'+(fehler.length
  ? '  ==> '+fehler.join('\n  ==> ')
  : '  ==> Der Merge-Treiber haelt: append-only ueberlebt zwei Zweige, ohne Marker und ohne kaputte Zeilen.'));
if(fehler.length) process.exitCode=1;

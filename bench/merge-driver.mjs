import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
const z=(o)=>JSON.stringify(o)+'\n';
const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function repo(mitAttrs){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'m-'));
  fs.mkdirSync(path.join(d,'projects','a'),{recursive:true});
  git(d,'init','-q'); git(d,'config','user.email','t@t'); git(d,'config','user.name','t');
  if(mitAttrs) fs.writeFileSync(path.join(d,'.gitattributes'),'*.jsonl merge=union\n');
  return d;
}
function lauf(mitAttrs, gleicherEintrag){
  const d=repo(mitAttrs); const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, z({id:'base',ts:'2026-01-01T00:00:00Z',choice:'gemeinsam'}));
  git(d,'add','-A'); git(d,'commit','-qm','base');
  git(d,'checkout','-qb','A'); fs.appendFileSync(p,z({id:'a1',ts:'2026-02-01T00:00:00Z',choice:'von A'}));
  git(d,'add','-A'); git(d,'commit','-qm','A');
  git(d,'checkout','-q','master'); git(d,'checkout','-qb','B');
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
for(const [t,attrs,gleich] of [
  ['OHNE .gitattributes, verschiedene Zeilen', false,false],
  ['MIT  merge=union,   verschiedene Zeilen',  true, false],
  ['MIT  merge=union,   IDENTISCHE Zeile',     true, true ],
]){
  const r=lauf(attrs,gleich);
  console.log(`${t.padEnd(38)} | ${r.st.padEnd(8)} | ${String(r.ok).padStart(6)} | ${String(r.kaputt).padStart(6)} | ${String(r.marker).padStart(6)} | ${r.ids.join(',')}`);
}

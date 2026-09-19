import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
const j=(o)=>JSON.stringify(o)+'\n';
const git=(cwd,...a)=>execFileSync('git',a,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function repo(withAttrs){
  const d=fs.mkdtempSync(path.join(os.tmpdir(),'m-'));
  fs.mkdirSync(path.join(d,'projects','a'),{recursive:true});
  git(d,'init','-q','-b','main'); git(d,'config','user.email','t@t'); git(d,'config','user.name','t');
  if(withAttrs) fs.writeFileSync(path.join(d,'.gitattributes'),'*.jsonl merge=union\n');
  return d;
}
function run(withAttrs, sameEntry){
  const d=repo(withAttrs); const p=path.join(d,'projects','a','decisions.jsonl');
  fs.writeFileSync(p, j({id:'base',ts:'2026-01-01T00:00:00Z',choice:'shared'}));
  git(d,'add','-A'); git(d,'commit','-qm','base');
  git(d,'checkout','-qb','A'); fs.appendFileSync(p,j({id:'a1',ts:'2026-02-01T00:00:00Z',choice:'from A'}));
  git(d,'add','-A'); git(d,'commit','-qm','A');
  git(d,'checkout','-q','main'); git(d,'checkout','-qb','B');
  fs.appendFileSync(p, sameEntry ? j({id:'a1',ts:'2026-02-01T00:00:00Z',choice:'from A'})
                                 : j({id:'b1',ts:'2026-02-01T00:00:00Z',choice:'from B'}));
  git(d,'add','-A'); git(d,'commit','-qm','B');
  let st='clean';
  try{ git(d,'merge','A','-m','merge'); }catch{ st='CONFLICT'; }
  const content=fs.readFileSync(p,'utf8'); const lines=content.split('\n').filter(Boolean);
  let ok=0,broken=0; const ids=[];
  for(const l of lines){ try{ ids.push(JSON.parse(l).id); ok++; }catch{ broken++; } }
  fs.rmSync(d,{recursive:true,force:true});
  return {st, ok, broken, marker:content.includes('<<<<<<<'), ids};
}
console.log('case                                   | merge    | usable | broken | marker | ids');
console.log('---------------------------------------+----------+--------+--------+--------+---------------');
const res={};
for(const [k,t,attrs,same] of [
  ['without','WITHOUT .gitattributes, different lines', false,false],
  ['union',  'WITH    merge=union,  different lines',   true, false],
  ['same',   'WITH    merge=union,  IDENTICAL line',    true, true ],
]){
  const r=res[k]=run(attrs,same);
  console.log(`${t.padEnd(38)} | ${r.st.padEnd(8)} | ${String(r.ok).padStart(6)} | ${String(r.broken).padStart(6)} | ${String(r.marker).padStart(6)} | ${r.ids.join(',')}`);
}

// The contract this repo enters with `*.jsonl merge=union` — and the
// counter-proof that the arrangement does anything at all. Without the
// 'without' control row, a git that does not merge in the first place
// would look green here.
const failures=[];
if(res.union.broken) failures.push(`merge=union leaves ${res.union.broken} unreadable line(s)`);
if(res.union.marker) failures.push('merge=union leaves conflict markers in the file');
if(res.union.st!=='clean') failures.push(`merge=union does not merge cleanly (${res.union.st})`);
if(res.union.ok!==3) failures.push(`merge=union loses lines: ${res.union.ok} instead of 3`);
// The second half of the contract: union does NOT deduplicate. Two agents
// that happen to write the same line keep one of them — anyone relying on
// counts has to know that.
if(res.same.ok!==2) failures.push(`identical line: ${res.same.ok} instead of 2 (union folds duplicates together)`);
// Control: without .gitattributes it MUST hurt, or this run measures nothing.
if(!res.without.marker && !res.without.broken && res.without.st==='clean')
  failures.push('without .gitattributes nothing bad happens — then this run does not show the driver works');

console.log('\n'+(failures.length
  ? '  ==> '+failures.join('\n  ==> ')
  : '  ==> The merge driver holds: append-only survives two branches, with no markers and no broken lines.'));
if(failures.length) process.exitCode=1;

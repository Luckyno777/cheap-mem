// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// readview — the offline reading view of the project package (#sources/export,
// button "Offline reading view", parity with lucky-mem's leseansicht, 2026-10-03).
//
// **One file, from the same package.** `buildHtml(pkg)` takes the result of
// `projectpackage.build()` — the same selection, the same redaction, the same
// count as "Load JSON package". Nothing is read, decrypted or added here.
// (`mem viewer` stays the whole-memory file; this one is the package's.)
//
// **Encrypted entries.** Neither the envelope (`body_enc`) nor any field beside
// it is in the file: only id, type, project, state and the relations. The view
// says "encrypted".
//
// **Self-contained.** Embedded CSS (the dashboard's tokens), one embedded script,
// the data as a JSON block. No address, no network call, no outside font — it
// runs from file:// offline. Everything embedded is set in the browser through
// textContent only. No raw captures, mail or keys: they are not in the package.

/** JSON for a <script> block: never an end tag, never U+2028/9. */
function jsonForScript(x) {
  return JSON.stringify(x)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The package for the view: encrypted entries without their envelope and side fields. */
function viewData(pkg) {
  return {
    header: pkg.header,
    entries: pkg.entries.map((e) => (e.encrypted ? { ...e, entry: null } : e)),
    refs: pkg.refs,
  };
}

const CSS = `
:root{color-scheme:dark;--bg:#101917;--panel:#15211e;--raised:#1b2a25;--line:#2b3e35;--text:#eef2e9;--muted:#a7b8ae;--quiet:#91a699;--accent:#bfef95;--green:#83d7b4;--gold:#e8c586;--red:#eda69c;--radius:20px}
body.light{color-scheme:light;--bg:#f3f5ed;--panel:#fcfdf8;--raised:#eaf0e4;--line:#cdd8c9;--text:#20372a;--muted:#51695a;--quiet:#617869;--accent:#386820;--green:#267558;--gold:#93631c;--red:#a4473e}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 'DM Sans','Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text)}
button,input,select{font:inherit;color:inherit}button{cursor:pointer;border:0}button:disabled{opacity:.45;cursor:not-allowed}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
h1,h2,h3,p{margin:0}h1{font-size:clamp(26px,3.4vw,40px);font-weight:500;line-height:1.14;letter-spacing:-1.2px}h2{font-size:19px;font-weight:550;letter-spacing:-.35px}h3{font-size:15px;font-weight:600}
.small{font-size:12px}.muted{color:var(--muted)}.quiet{color:var(--quiet)}.mono{font:12px/1.6 ui-monospace,Consolas,monospace}
.label{font-size:10px;letter-spacing:1.6px;text-transform:uppercase;color:var(--quiet)}
main{max-width:1280px;margin:0 auto;padding:28px 20px 60px}
.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:20px}.head p{color:var(--muted);max-width:70ch;margin-top:8px}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;padding:8px 13px;border-radius:9px;background:var(--raised);border:1px solid var(--line);font-weight:500;font-size:12px;white-space:nowrap;color:var(--text)}
.btn:hover{border-color:var(--quiet);background:var(--panel)}.btn.small{padding:6px 10px;font-size:11px}.btn.ghost{background:transparent}
.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);overflow:hidden;margin-bottom:18px}
.metric{padding:16px 18px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric strong{display:block;font-size:28px;font-weight:450;letter-spacing:-.8px;line-height:1.2}.metric .name{font-size:11px;color:var(--quiet)}.metric small{font-size:11px;color:var(--quiet)}
.toolbar{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:17px}
.field{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px 12px;font-size:12px;min-width:0}.searchfield{flex:1;min-width:200px}
.check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:18px;align-items:start}
.panel{border:1px solid var(--line);border-radius:var(--radius);background:var(--panel);min-width:0;overflow:hidden}
ul.list{list-style:none;margin:0;padding:0}.listbox{max-height:78vh;overflow:auto}#detail{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto}
.row{display:block;width:100%;text-align:left;background:none;color:inherit;padding:12px 18px;border-bottom:1px solid var(--line);min-width:0}.row:hover{background:var(--raised)}.row[aria-current=true]{background:var(--raised);box-shadow:inset 2px 0 0 var(--accent)}
.row strong{display:block;font-size:13px;font-weight:600;overflow-wrap:anywhere}.row .sub{display:block;font-size:11px;color:var(--quiet);overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:5px;padding:3px 7px;font-size:10px;color:var(--muted);white-space:nowrap;margin:3px 5px 0 0}
.badge.gold{color:var(--gold)}.badge.good{color:var(--green)}.badge.bad{color:var(--red)}
.tablefoot{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:13px 18px;color:var(--quiet);font-size:11px;border-top:1px solid var(--line)}
.detail{padding:20px 22px}.detail h2{margin:6px 0 10px;overflow-wrap:anywhere}
.callout{padding:13px 16px;border-left:2px solid var(--gold);background:var(--raised);color:var(--muted);font-size:12px;margin:16px 0;border-radius:0 8px 8px 0}
dl.fields{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin:14px 0}dl.fields dt{color:var(--quiet);font-size:11px}dl.fields dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}
.text{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--raised);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:10px 0}
.rel{display:flex;gap:10px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line);font-size:12px;flex-wrap:wrap}.rel:last-child{border-bottom:0}
a.link,.link{color:var(--accent);background:none;padding:0;text-align:left;overflow-wrap:anywhere}
.empty{padding:45px 24px;text-align:center;color:var(--muted)}
@media(max-width:900px){#detail{position:static;max-height:none}.layout{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}}
@media(max-width:720px){main{padding:20px 16px 50px}.detail{padding:16px}dl.fields{grid-template-columns:1fr}.searchfield{flex:1 1 100%}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media print{.toolbar,.btn{display:none!important}body{background:#fff;color:#000}.layout{display:block}}
`;

// The reading view. Data come only from the embedded JSON block and are set
// through textContent exclusively (never innerHTML).
const SCRIPT = `
(function(){
  var P = JSON.parse(document.getElementById('package').textContent);
  var E = P.entries, byId = {}, incoming = {};
  E.forEach(function(e){ if(!byId[e.id]) byId[e.id]=e; });
  E.forEach(function(e){ (e.relations||[]).forEach(function(b){ (incoming[b.id]=incoming[b.id]||[]).push({kind:b.kind,from:e.id}); }); });
  var R = {}; (P.refs||[]).forEach(function(v){ R[v.id]=v; });
  var $ = function(s){ return document.querySelector(s); };
  var st = { q:'', type:'', state:'', onlyEnc:false, sel:null, limit:50 };
  function el(tag, cls, text){ var n=document.createElement(tag); if(cls) n.className=cls; if(text!=null) n.textContent=text; return n; }
  function titleOf(e){
    var z=e.entry; if(e.encrypted) return 'encrypted entry';
    if(z){ var t=z.title||z.topic||z.question||z.name||z.key; if(t) return String(t); if(z.text) return String(z.text).split('\\n')[0].slice(0,120); }
    return e.id;
  }
  function fullText(e){
    if(e.encrypted||!e.entry) return '';
    var s=''; for(var k in e.entry){ var v=e.entry[k]; if(typeof v==='string') s+=' '+v; else if(Array.isArray(v)) s+=' '+v.join(' '); }
    return s.toLowerCase();
  }
  var T = E.map(function(e){ return (e.id+' '+titleOf(e)+' '+e.type+' '+e.project+' '+fullText(e)).toLowerCase(); });
  function filtered(){
    var q=st.q.trim().toLowerCase(), out=[];
    for(var i=0;i<E.length;i++){ var e=E[i];
      if(st.type && e.type!==st.type) continue;
      if(st.state && e.state!==st.state) continue;
      if(st.onlyEnc && !e.encrypted) continue;
      if(q && T[i].indexOf(q)<0) continue;
      out.push(e); }
    return out;
  }
  function head(){
    var c=P.header.counts||{}, m=$('#metrics'); m.textContent='';
    [['Entries',c.entries,'in the package'],['Encrypted',c.encrypted,'ciphertext only, not readable here'],['Historical',c.historical,'superseded or retired'],['External references',c.externalRefs,'outside the package']].forEach(function(r){
      var d=el('div','metric'); d.appendChild(el('span','name',r[0])); d.appendChild(el('strong',null,String(r[1]==null?'—':r[1]))); d.appendChild(el('small',null,r[2])); m.appendChild(d); });
    $('#stamp').textContent='Project '+P.header.selection.project+' · created '+P.header.created+(P.header.code&&P.header.code.commit?' · commit '+String(P.header.code.commit).slice(0,8):'');
    var v=P.header.completeness; if(v&&v.state!=='good'){ var c2=$('#incomplete'); c2.hidden=false; c2.textContent='Incomplete: '+(v.reasons||[]).join('; '); }
    var f=$('#type'), ts={}; E.forEach(function(e){ ts[e.type]=1; });
    Object.keys(ts).sort().forEach(function(k){ var o=el('option',null,k); o.value=k; f.appendChild(o); });
    var zs=$('#state'), ss={}; E.forEach(function(e){ ss[e.state]=1; });
    Object.keys(ss).sort().forEach(function(k){ var o=el('option',null,k); o.value=k; zs.appendChild(o); });
  }
  function list(){
    var all=filtered(), ul=$('#list'); ul.textContent='';
    all.slice(0,st.limit).forEach(function(e){
      var li=el('li'), b=el('button','row'); b.type='button'; b.setAttribute('data-id',e.id);
      if(st.sel===e.id) b.setAttribute('aria-current','true');
      b.appendChild(el('strong',null,titleOf(e)));
      b.appendChild(el('span','sub',e.type+' · '+e.project+' · '+e.id));
      if(e.encrypted) b.appendChild(el('span','badge gold','encrypted'));
      if(e.state!=='active') b.appendChild(el('span','badge',e.state));
      li.appendChild(b); ul.appendChild(li); });
    if(!all.length){ var li=el('li'); li.appendChild(el('div','empty','No entry matches the search and filters.')); ul.appendChild(li); }
    $('#count').textContent=Math.min(st.limit,all.length)+' of '+all.length+' entries'+(all.length!==E.length?' (filtered, '+E.length+' in the package)':'');
    $('#more').hidden = all.length<=st.limit;
  }
  function rel(title, rows){
    var w=el('div'); w.appendChild(el('h3',null,title));
    if(!rows.length){ w.appendChild(el('p','small quiet','None.')); return w; }
    rows.forEach(function(r){ var d=el('div','rel'); d.appendChild(el('span','badge',r.kind)); var t=byId[r.id];
      if(t){ var b=el('button','link',titleOf(t)+' ('+r.id+')'); b.type='button'; b.setAttribute('data-id',r.id); d.appendChild(b); }
      else { var v=R[r.id]; d.appendChild(el('span','mono',r.id)); d.appendChild(el('span','small quiet', v&&v.known? ('outside the package · '+v.type+(v.title?' · '+v.title:(v.encrypted?' · encrypted':''))) : 'outside the package')); }
      w.appendChild(d); });
    return w;
  }
  function detail(){
    var d=$('#detail'); d.textContent='';
    var e=st.sel&&byId[st.sel];
    if(!e){ d.appendChild(el('div','empty','Select an entry on the left.')); return; }
    var w=el('div','detail');
    w.appendChild(el('span','label',e.type+' / '+e.id));
    w.appendChild(el('h2',null,titleOf(e)));
    w.appendChild(el('span','badge '+(e.state==='active'?'good':''),e.state));
    if(e.encrypted){ w.appendChild(el('span','badge gold','encrypted')); w.appendChild(el('div','callout','This entry is encrypted. The reading view decrypts nothing and carries no content of it — only id, type and relations.')); }
    if(e.why) w.appendChild(el('div','callout','Why retired: '+e.why));
    if(!e.encrypted){
      if(!e.entry) w.appendChild(el('div','callout','No readable raw line was available for this entry.'));
      else {
        var z=e.entry, dl=el('dl','fields'), long=[];
        Object.keys(z).forEach(function(k){ var v=z[k]; if(v==null||v==='') return;
          var s=typeof v==='string'?v:(typeof v==='object'?JSON.stringify(v):String(v));
          if(s.length>240||s.indexOf('\\n')>=0){ long.push([k,s]); return; }
          dl.appendChild(el('dt',null,k)); dl.appendChild(el('dd',null,s)); });
        w.appendChild(dl);
        long.forEach(function(p){ w.appendChild(el('span','label',p[0])); w.appendChild(el('div','text',p[1])); });
      }
    }
    w.appendChild(rel('Points to',(e.relations||[]).map(function(b){return {kind:b.kind,id:b.id};})));
    w.appendChild(rel('Pointed to by',(incoming[e.id]||[]).map(function(r){return {kind:r.kind,id:r.from};})));
    d.appendChild(w);
  }
  function choose(id){ st.sel=id; if(location.hash!=='#'+id) try{ history.replaceState(null,'','#'+encodeURIComponent(id)); }catch(x){} list(); detail(); }
  document.addEventListener('click',function(ev){ var b=ev.target.closest('[data-id]'); if(b) choose(b.getAttribute('data-id')); });
  $('#search').addEventListener('input',function(ev){ st.q=ev.target.value; st.limit=50; list(); });
  $('#type').addEventListener('change',function(ev){ st.type=ev.target.value; st.limit=50; list(); });
  $('#state').addEventListener('change',function(ev){ st.state=ev.target.value; st.limit=50; list(); });
  $('#onlyenc').addEventListener('change',function(ev){ st.onlyEnc=ev.target.checked; st.limit=50; list(); });
  $('#more').addEventListener('click',function(){ st.limit+=50; list(); });
  $('#theme').addEventListener('click',function(){ document.body.classList.toggle('light'); });
  head();
  var h=decodeURIComponent((location.hash||'').slice(1)); if(h&&byId[h]) st.sel=h;
  list(); detail();
})();
`;

/** The whole file as text. `pkg` = result of `projectpackage.build()`. */
export function buildHtml(pkg) {
  const data = viewData(pkg);
  const project = String(pkg.header?.selection?.project ?? '').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>cheap-mem · reading view ${project}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<div class="head"><div><span class="label">cheap-mem / offline reading view</span><h1>Everything that stays, to read.</h1><p>One file, readable without a network. Redacted like the JSON package; encrypted entries stay encrypted here, raw captures, mail and keys are not included. <span id="stamp"></span></p></div><button class="btn small ghost" id="theme" type="button">Light / dark</button></div>
<div class="metrics" id="metrics"></div>
<div class="callout" id="incomplete" hidden></div>
<div class="toolbar"><input class="field searchfield" id="search" type="search" placeholder="Title, content, id …" aria-label="Search entries"><select class="field" id="type" aria-label="Type"><option value="">All types</option></select><select class="field" id="state" aria-label="State"><option value="">All states</option></select><label class="check"><input type="checkbox" id="onlyenc"> only encrypted</label></div>
<div class="layout">
<article class="panel"><div class="listbox"><ul class="list" id="list"></ul></div><div class="tablefoot"><span id="count" role="status"></span><button class="btn small ghost" id="more" type="button" hidden>Show more</button></div></article>
<article class="panel" id="detail" aria-live="polite"></article>
</div>
</main>
<script type="application/json" id="package">${jsonForScript(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

/** `cheap-mem-<project>-<YYYY-MM-DD>-reading.html` */
export function fileName(project, now = new Date()) {
  return `cheap-mem-${project}-${now.toISOString().slice(0, 10)}-reading.html`;
}

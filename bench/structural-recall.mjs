#!/usr/bin/env node
// Does a STRUCTURAL hop surface history that word retrieval misses?
//
// **The question this exists to settle**, before anything is built on
// the answer. The comparison with a code-graph MCP suggested: take a
// git diff, resolve the changed symbols, walk the call graph, and ask
// the memory about the neighbours. The claim is that this finds
// historical errors a word query would not — because the old entry and
// the new question share no words, only structure.
//
// That claim is plausible and untested. This measures it.
//
// **What is measured, and what is NOT.** The edge used here is
// `import`, extracted exactly from the source with a regex — no
// tree-sitter, no LSP, no daemon. That is DELIBERATELY weaker than a
// call graph: an import edge is coarser, so it links more loosely.
//
//   - A strong effect on imports is evidence that a finer graph would
//     do at least as well, and probably better.
//   - No effect on imports is evidence AGAINST the whole line, but
//     weaker evidence than a call-graph run would be.
//
// Saying which of the two this is, is the point. A benchmark that
// claimed to measure "structural retrieval" while measuring imports
// would be the kind of number this project spends its time removing.
//
// Usage:
//   node bench/structural-recall.mjs --root <memory> --src <dir> [--top 10]
import fs from 'node:fs';
import path from 'node:path';
import * as search from '../src/search.mjs';

function args(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}

/** Every entry of the memory, as a flat record with its searchable text. */
function entries(root) {
  const out = [];
  const walk = (dir) => {
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name.endsWith('.jsonl')) {
        for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            out.push({
              id: e.id,
              topic: e.topic ?? null,
              klass: e.class ?? null,
              text: Object.values(e).filter((v) => typeof v === 'string').join(' '),
            });
          } catch { /* integrity reports these */ }
        }
      }
    }
  };
  for (const d of ['global', 'projects', 'projekte']) walk(path.join(root, d));
  return out;
}

/**
 * The import graph, both ways.
 *
 * Only relative imports: a package name is not a file in this repo, and
 * an edge to `node:fs` links every module to every other one, which
 * would make the structural set meaningless.
 */
function importGraph(srcDir) {
  const files = fs.readdirSync(srcDir).filter((n) => n.endsWith('.mjs'));
  const out = new Map(files.map((f) => [f, new Set()]));
  for (const f of files) {
    const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
    for (const m of text.matchAll(/from\s+'(\.[^']+)'/g)) {
      const target = path.basename(m[1]);
      if (!out.has(target)) continue;
      out.get(f).add(target);
      out.get(target).add(f);   // undirected: a neighbour is a neighbour
    }
  }
  return out;
}

const a = args(process.argv);
const root = a.root ?? process.env.CHEAP_MEM_ROOT ?? '.';
const srcDir = a.src ?? path.join(root, 'src');
const top = Number(a.top ?? 10);

const korpus = entries(root);
const graph = importGraph(srcDir);
const index = search.loadIndex(root);

// Which entries mention which file, literally. The ground truth here is
// deliberately literal: it is what a person means by "there is history
// about this file", and it needs no ranking to establish.
const mentions = new Map();
const byId = new Map(korpus.map((e) => [e.id, e]));
for (const f of graph.keys()) {
  mentions.set(f, new Set(korpus.filter((e) => e.text.includes(f)).map((e) => e.id)));
}

/**
 * The topics and error classes a set of entries is about.
 *
 * This is the half the first version of this bench could not see. It
 * measured what the WORD QUERY returns, and found near-zero for both
 * structural neighbours and random files — then called that "no
 * difference". Both numbers being zero says the words carry no
 * structure at all; it says nothing about whether the neighbours'
 * history would have been WORTH having.
 *
 * Topic and class overlap is a proxy for that, and it is in the data
 * already — no model, no judgement call.
 */
function subjectsOf(ids) {
  const out = new Set();
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) continue;
    if (e.topic) out.add(`t:${e.topic}`);
    if (e.klass) out.add(`c:${e.klass}`);
  }
  return out;
}

/** |A ∩ B| / |A ∪ B| — 0 means nothing in common, 1 means the same subjects. */
function jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * **The control, and why the measurement is worthless without it.**
 *
 * "The word query misses 99 % of the neighbours' history" sounds like a
 * finding and may be arithmetic. A query for `doktor.mjs` obviously
 * does not return entries about `suche.mjs` — different files, different
 * words. That number alone measures "unrelated things are unrelated".
 *
 * So every file is also scored against a RANDOM set of files of the
 * same size. If the structural neighbours are no better than random
 * ones, the edge carries nothing and the whole line dies here.
 *
 * Only the DIFFERENCE between the two is evidence.
 */
function randomNeighbours(file, howMany, all, rand) {
  const pool = all.filter((f) => f !== file);
  const picked = new Set();
  while (picked.size < Math.min(howMany, pool.length)) {
    picked.add(pool[Math.floor(rand() * pool.length)]);
  }
  return picked;
}

/** Deterministic, so two runs of this bench compare. */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(Number(a.seed ?? 20260909));
const allFiles = [...graph.keys()];

const rows = [];
for (const [file, neighbours] of graph) {
  const own = mentions.get(file);
  if (!own.size) continue;               // no history about this file at all

  // Lane 1: ask the memory the way a person would — by name.
  const found = new Set(search.search(index, file, { top })
    .map((h) => h.entry?.id).filter(Boolean));

  // Lane 2: the structural set — history about the immediate
  // neighbours, which a query for THIS file has no word in common with.
  const structural = new Set();
  for (const n of neighbours) for (const id of mentions.get(n) ?? []) structural.add(id);
  for (const id of own) structural.delete(id);   // the file's own history is lane 1's job
  if (!structural.size) continue;

  const missed = [...structural].filter((id) => !found.has(id));

  // The same measurement against random files of the same count.
  const control = new Set();
  for (const n of randomNeighbours(file, neighbours.size, allFiles, rand)) {
    for (const id of mentions.get(n) ?? []) control.add(id);
  }
  for (const id of own) control.delete(id);
  const controlMissed = [...control].filter((id) => !found.has(id));

  const ownSubjects = subjectsOf(own);
  rows.push({
    file,
    neighbours: neighbours.size,
    ownHistory: own.size,
    structural: structural.size,
    missedByWords: missed.length,
    hitStructural: structural.size - missed.length,
    control: control.size,
    hitControl: control.size - controlMissed.length,
    // Does the neighbours' history talk about the same subjects as this
    // file's own history — more than random files do?
    simStructural: jaccard(ownSubjects, subjectsOf(structural)),
    simControl: jaccard(ownSubjects, subjectsOf(control)),
  });
}

rows.sort((x, y) => y.missedByWords - x.missedByWords);

const sumStructural = rows.reduce((s, r) => s + r.structural, 0);
const sumMissed = rows.reduce((s, r) => s + r.missedByWords, 0);
const sumHitStructural = rows.reduce((s, r) => s + r.hitStructural, 0);
const sumControl = rows.reduce((s, r) => s + r.control, 0);
const sumHitControl = rows.reduce((s, r) => s + r.hitControl, 0);
const rateStructural = sumStructural ? sumHitStructural / sumStructural : 0;
const rateControl = sumControl ? sumHitControl / sumControl : 0;

console.log(`memory      ${root}`);
console.log(`source      ${srcDir}`);
console.log(`entries     ${korpus.length}`);
console.log(`files       ${graph.size} in the import graph, ${rows.length} with both `
  + 'own history and neighbours');
console.log(`top         ${top} (what the word query is allowed to return)`);
console.log('');
console.log('file                       nbrs  own  struct  sim-struct  sim-ctrl');
for (const r of [...rows].sort((x, y) => y.simStructural - x.simStructural)) {
  console.log(`${r.file.padEnd(26)} ${String(r.neighbours).padStart(4)} `
    + `${String(r.ownHistory).padStart(4)} ${String(r.structural).padStart(7)} `
    + `${r.simStructural.toFixed(3).padStart(11)} ${r.simControl.toFixed(3).padStart(9)}`);
}
// **Not an average alone.** One file with a high overlap and
// twenty-four with none would produce the same mean as a broad, weak
// effect — and only one of those two is worth building on.
const better = rows.filter((r) => r.simStructural > r.simControl).length;
const same = rows.filter((r) => r.simStructural === r.simControl).length;
console.log('');
console.log(`files where structural beats random  ${better} of ${rows.length}`);
console.log(`files where they tie (often both 0)  ${same}`);
console.log('');
console.log(`structural entries   ${sumStructural}, of which the word query returned `
  + `${sumHitStructural} (${(rateStructural * 100).toFixed(1)} %)`);
console.log(`random control       ${sumControl}, of which the word query returned `
  + `${sumHitControl} (${(rateControl * 100).toFixed(1)} %)`);
console.log(`missed structurally  ${sumMissed}`);
console.log('');

// **The verdict, stated by the bench rather than by whoever reads it.**
//
// Two questions, and the first version conflated them:
//
//   1. Does the word query reach the neighbours' history?  (reach)
//   2. Would that history have been worth reaching?        (relevance)
//
// Near-zero reach for BOTH structural and random neighbours does not
// mean the edge is worthless — it means words carry no structure, for
// anybody. Only the subject overlap speaks to relevance.
const meanStructural = rows.reduce((s2, r) => s2 + r.simStructural, 0) / (rows.length || 1);
const meanControl = rows.reduce((s2, r) => s2 + r.simControl, 0) / (rows.length || 1);
const lift = meanStructural - meanControl;

console.log(`subject overlap with own history:`);
console.log(`  structural neighbours  ${meanStructural.toFixed(3)}`);
console.log(`  random control         ${meanControl.toFixed(3)}`);
console.log('');

if (rateStructural < 0.05 && rateControl < 0.05) {
  console.log('REACH: a name query returns that file\'s own history and essentially');
  console.log('  nothing else — neither its neighbours nor random files, at any --top.');
  console.log('  So if neighbour history is wanted, words will never deliver it.');
} else {
  console.log(`REACH: the word query already returns ${(rateStructural * 100).toFixed(1)} % of the`);
  console.log(`  structural set against ${(rateControl * 100).toFixed(1)} % of a random one.`);
}
console.log('');
// **The verdict is decided by the DISTRIBUTION, not by the mean.**
//
// The first version of this bench reported the mean overlap — 0.108
// structural against 0.010 random, stable over five seeds — and called
// the case for a structural hop "real". The per-file table said
// otherwise: four files of twenty-five show any effect at all, two of
// them at a perfect 1.000 on a sample of one or two entries, which is
// noise wearing a big number.
//
// That is the exact defect this bench was written to avoid in someone
// else's comparison: an aggregate that reads like a finding. It was
// caught by printing the distribution, not by thinking harder.
const strong = rows.filter((r) => r.simStructural > r.simControl && r.ownHistory >= 3
  && r.structural >= 3).length;
const share = rows.length ? better / rows.length : 0;

if (strong >= 3 && share > 0.4) {
  console.log(`RELEVANCE: ${better} of ${rows.length} files show more subject overlap with`);
  console.log(`  their structural neighbours than with random files, ${strong} of them on`);
  console.log('  a sample large enough to mean something. The edge points at related');
  console.log('  history that words cannot reach.');
  console.log('  VERDICT: the case for a structural hop holds. Next step is a call');
  console.log('  graph, where the edge is finer than an import.');
} else {
  console.log(`RELEVANCE: only ${better} of ${rows.length} files show any effect, and only`);
  console.log(`  ${strong} of those on a sample large enough to mean anything. The mean`);
  console.log(`  (${meanStructural.toFixed(3)} against ${meanControl.toFixed(3)}) is carried by a `
    + 'couple of tiny');
  console.log('  files where one shared topic out of one entry scores a perfect 1.0.');
  console.log('  VERDICT: NOT demonstrated on this corpus. Do not build for it.');
  console.log('');
  console.log('  What this does NOT say: that the effect is absent. Most entries in');
  console.log('  this memory are about operations, not modules, and `topic` is sparse.');
  console.log('  What would settle it is a corpus where entries name the symbols they');
  console.log('  are about — which `symbols` now makes possible. Measure again when');
  console.log('  there is data, rather than building on a mean.');
}
console.log('');
console.log('The edge measured is IMPORT, not CALL. A call graph is finer, so a');
console.log('strong result here is a lower bound and a weak one is weaker evidence');
console.log('against than a call-graph run would be.');

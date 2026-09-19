// bench/alias-fragmentation.mjs — does THIS corpus need an entity layer?
//
// An instrument, not a feature. It changes nothing and writes nothing.
//
// **Why it exists.** On 2026-09-08 an outside suggestion was that
// cheap-mem lacks entity resolution, with the textbook example
// `Lukas = Lucky = the mail address`. Measured against a real corpus of
// 1070 entries, that example was a non-problem: `lukas` appeared EXACTLY
// ONCE, and 94 % of all mentions used the same spelling. In a corpus
// that has grown for a while, people and projects carry a canonical name
// by themselves.
//
// Where the fragmentation was real: COMPONENTS. One component went by
// three different names, and no spelling held a majority (43 %).
//
// Hence this script instead of a recommendation: whether an alias layer
// pays off depends on the corpus, not on the paradigm. Whoever knows the
// number for THEIR corpus decides; whoever does not, believes.
//
// **Addendum 2026-09-16 — and it comes out against the alias layer.**
// This script measures a GIVEN set of names: you tell it that three
// spellings mean the same component, and it counts how the mentions
// distribute. That answers "how fragmented is THIS component" and not
// "how much of the fragmentation in the corpus is spelling at all".
//
// The second question is measured by `bench/name-dispersion.mjs`, with
// nothing given, across all values: of 845 tag values, 20 to 24 are
// spelling variants — about 2.5 %. For the `class` field: 1 and 0 out of
// 185. The spread sits in the vocabulary, not in the spelling.
//
// The 43 % above stays correct for what it measures, and is still no
// justification for an alias layer: a component that goes by three names
// is one case, not a pattern. Decided and argued in
// `docs/deliberately-not-built.md`.
//
// Usage:
//   node bench/alias-fragmentation.mjs [--root <path>] [--set "a,b,c" ...]
//
// Without --set the names are guessed from the corpus: frequent
// identifiers that contain one another as a substring. That is crude and
// meant to be — it is the way in, not the verdict.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
const ROOT = path.resolve(flag('root') ?? process.env.CHEAP_MEM_ROOT ?? process.cwd());

const sets = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set') sets.push(argv[i + 1].split(',').map((s) => s.trim().toLowerCase()));
}

const files = [];
(function walk(d) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(ROOT);

if (!files.length) {
  console.error(`No .jsonl under ${ROOT}. Pass --root <memory> or set CHEAP_MEM_ROOT.`);
  process.exit(1);
}

// Raw captures are excluded on purpose: they are unedited transcripts,
// so they carry every casual spelling anyone ever typed. Counting them
// would measure how people TALK, not how the memory is WRITTEN.
const lines = [];
for (const f of files) {
  if (/(^|\/)(raw|captures)\//.test(f)) continue;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) if (l.trim()) lines.push(l.toLowerCase());
}

if (!sets.length) {
  console.log(`${lines.length} entries under ${ROOT}\n`);
  console.log('No --set given, so nothing is measured — the point of this tool is that');
  console.log('YOU name the things you suspect are split. Example:\n');
  console.log('  node bench/alias-fragmentation.mjs --root ~/mem \\');
  console.log('    --set "checkout,check-out,checkout-service" \\');
  console.log('    --set "mcp-bridge,mcp-server,mem-mcp"\n');
  process.exit(0);
}

console.log(`${lines.length} entries under ${ROOT}\n`);
console.log('set                                   | hits | dominant spelling covers');
console.log('--------------------------------------|-----:|-------------------------');
for (const variants of sets) {
  const counts = variants
    .map((v) => [v, lines.filter((l) => l.includes(v)).length])
    .sort((a, b) => b[1] - a[1]);
  const total = counts.reduce((s, [, n]) => s + n, 0);
  const share = total ? (counts[0][1] / total) * 100 : 0;
  const label = variants.join(',').slice(0, 37);
  console.log(`${label.padEnd(37)} | ${String(total).padStart(4)} | ${share.toFixed(0)}%`);
  for (const [v, n] of counts) console.log(`    ${String(n).padStart(5)}  ${v}`);
}
console.log('\nReading it: a dominant spelling near 100% means this name is already');
console.log('canonical — an alias layer would buy nothing for it. Near 50% or below');
console.log('means the corpus really is split, and a lookup for one spelling misses');
console.log('the rest. Measure before you build the layer.');

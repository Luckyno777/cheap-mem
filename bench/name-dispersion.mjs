// bench/name-dispersion.mjs — does the spelling scatter, or the vocabulary?
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing.
//
// **Why it exists.** From the finding "845 distinct tag values, 475 of
// them used exactly once" a work order was derived: build entity
// resolution, an alias table merging spelling variants of the same
// thing.
//
// This measurement checks that premise before anything gets built, and
// it does not hold. Under two independent normalisations, 20 to 24 of
// those 845 are spelling variants. About 2.5 %.
//
//   hook / hooks          test / tests
//   tool / tools          release / releases
//
// The remaining single-use values are not typos but different words:
// metrics, noise, statistics, optimisation, diversity, provenance,
// authority, ergonomics.
//
// So the dispersion sits in the VOCABULARY, not in the spelling:
// nobody types the same word differently, everyone picks another word.
// An alias table would have changed 2.5 % of it and left a table to
// maintain. Same answer as the closed class vocabulary, from the other
// side: against a sprawling vocabulary a closed list helps, a synonym
// table does not.
//
// It stays here as a tool rather than a note so the question can be
// recomputed when the memory is twice the size. If the share comes out
// differently then, the answer is retaken.
//
// Usage:
//   node bench/name-dispersion.mjs [--root <path>] [--field tags|klasse|topic]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

/** Suffixes off, umlaut transcription unified, separators removed. */
export function normalise(s) {
  return String(s).toLowerCase()
    .replace(/[-_.]/g, '')
    .replace(/(en|er|e|s|n)$/, '')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .replace(/ss/g, 's');
}

/** The same, but independent of word order inside a compound. */
export function wordSet(s) {
  return String(s).toLowerCase().split(/[-_.]/).filter(Boolean)
    .map((w) => w.replace(/(en|er|e|s|n)$/, ''))
    .sort()
    .join(' ');
}

/** Every value of one field across all project logs. */
export function values(root, field) {
  const counter = new Map();
  let entries = 0;
  const projects = path.join(root, 'projects');
  let names = [];
  try { names = fs.readdirSync(projects); } catch { return { counter, entries }; }
  for (const p of names) {
    let files = [];
    try { files = fs.readdirSync(path.join(projects, p)); } catch { continue; }
    for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
      let text = '';
      try { text = fs.readFileSync(path.join(projects, p, f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let o;
        try { o = JSON.parse(line); } catch { continue; }
        entries += 1;
        const raw = field === 'tags' ? (o?.tags ?? []) : [o?.[field]].filter(Boolean);
        for (const v of raw) {
          const s = String(v).toLowerCase();
          counter.set(s, (counter.get(s) ?? 0) + 1);
        }
      }
    }
  }
  return { counter, entries };
}

/**
 * How much of the dispersion would be spelling?
 *
 * Two normalisations, not one. A single one might be too coarse and
 * merge things that differ — then the saving looks large while being
 * only damage. Two different procedures agreeing makes the number
 * worth something.
 */
export function dispersion({ counter }) {
  const groupBy = (fn) => {
    const g = new Map();
    for (const [w, c] of counter) {
      const k = fn(w);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push([w, c]);
    }
    return g;
  };
  const a = groupBy(normalise);
  const b = groupBy(wordSet);
  return {
    distinct: counter.size,
    once: [...counter.values()].filter((c) => c === 1).length,
    afterNormalise: a.size,
    afterWordSet: b.size,
    variantsNormalise: counter.size - a.size,
    variantsWordSet: counter.size - b.size,
    groups: [...a.values()].filter((v) => v.length > 1)
      .sort((x, y) => y.reduce((s, [, c]) => s + c, 0) - x.reduce((s, [, c]) => s + c, 0))
      .map((v) => v.sort((x, y) => y[1] - x[1])),
  };
}

// --- as a command ------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = path.resolve(flag('root') ?? process.env.CHEAP_MEM_ROOT ?? process.cwd());
  const FIELD = flag('field') ?? 'tags';
  const v = values(ROOT, FIELD);
  if (!v.counter.size) {
    console.log(`No values for '${FIELD}' in ${ROOT}/projects. That is not a pass.`);
    process.exit(2);
  }
  const d = dispersion(v);
  const share = (n) => `${Math.round((n / d.distinct) * 100)} %`;

  console.log(`Field '${FIELD}' across ${v.entries} entries\n`);
  console.log(`  distinct values             ${d.distinct}`);
  console.log(`  used exactly once           ${d.once}  (${share(d.once)})`);
  console.log();
  console.log(`  spelling variants (suffix)  ${d.variantsNormalise}  (${share(d.variantsNormalise)})`);
  console.log(`  spelling variants (wordset) ${d.variantsWordSet}  (${share(d.variantsWordSet)})`);
  console.log(`\n${d.groups.length} group(s) with more than one spelling:`);
  for (const g of d.groups.slice(0, 15)) {
    console.log(`  ${g.map(([t, c]) => `${t}(${c})`).join(' | ')}`);
  }
  console.log('\nRead it like this: the first share is the dispersion, the second is');
  console.log('the part of it an alias table could collect. If they are far apart,');
  console.log('the VOCABULARY scatters and not the spelling — then a closed list');
  console.log('helps and a synonym table does not.');
}

// bench/field-without-writer.mjs — reads a field nobody ever sets.
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing.
//
// **Why it exists.** Four times in ten days, in the sibling project this
// tool was extracted from, the same defect: a guard reads a field, and
// no write path ever sets it. Each time the guard silently did nothing,
// and each time it took weeks to notice — because a guard that never
// fires looks exactly like a guard with nothing to report.
//
//   2026-09-07  a wake-up flag on messages — the bell stayed silent
//   2026-09-08  a reply-reference on messages — every reply fell back
//               to a subject heuristic
//   2026-09-15  a provenance stamp on captures — 757 of 757 were null
//   2026-09-16  a project field in an artifact register — no view could
//               attribute an artifact to a project
//
// **Two cuts were tried and thrown away first**, and saying so is part
// of the instrument:
//
//   1. "field read in code, never written in code" — 222 candidates,
//      nearly all of them file extensions and Node APIs. Useless.
//   2. "field read in code, absent from the corpus" — 714 of 727, for
//      the same reason: most fields a program reads are not log fields.
//
// What makes the third cut work is not a better regex but a narrower
// question. The defect is never "a field is unused". It is **a field
// that a DECISION depends on**, holding nothing. So the instrument only
// looks at fields read inside a condition, and only at fields the
// corpus actually knows. On a live 2,526-entry corpus that is 358 → 11,
// and a human can read eleven.
//
// **Three states, never two.** A field the corpus has never heard of is
// not the same as one it carries empty. The first is almost always a
// local variable and none of our business; the second is the defect.
// Reporting them together would bury eleven real answers under 700.
//
// Usage:
//   node bench/field-without-writer.mjs [--root <path>] [--code <path>]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

/** Fields a decision depends on — `if (x.f)`, `x.f === y`, `x.f ?? y`, `x.f ? a : b`. */
export const ENTSCHEIDUNGS_MUSTER = Object.freeze([
  /if\s*\([^)]*?\.([a-z_][a-zA-Z0-9_]{2,})\b/g,
  /\.([a-z_][a-zA-Z0-9_]{2,})\s*(?:===|!==|\?\?|&&|\|\|)/g,
  /\.([a-z_][a-zA-Z0-9_]{2,})\s*\?[^?]/g,
  // Header-style keys are read by name, not by property access.
  /\[['"]([A-Za-z][A-Za-z0-9_-]{2,})['"]\]/g,
]);

/** Every field the code branches on, with the files that branch on it. */
export function entscheidungsFelder(dirs, lesen = (p) => fs.readFileSync(p, 'utf8')) {
  const raus = new Map();
  for (const d of dirs) {
    let namen = [];
    try { namen = fs.readdirSync(d); } catch { continue; }
    for (const n of namen) {
      const p = path.join(d, n);
      let text;
      try { if (!fs.statSync(p).isFile()) continue; text = lesen(p); } catch { continue; }
      for (const re of ENTSCHEIDUNGS_MUSTER) {
        for (const m of text.matchAll(re)) {
          if (!raus.has(m[1])) raus.set(m[1], new Set());
          raus.get(m[1]).add(p);
        }
      }
    }
  }
  return raus;
}

/**
 * What the corpus actually carries.
 *
 * **Three persistence shapes, not one**, and that is the whole reason
 * this function is longer than a one-liner. Of the four defects above,
 * exactly ONE lived in a `.jsonl` entry. The other three sat in
 * message headers (`Field: value` at the top of a text file) and in
 * compressed captures. An instrument that only reads the log would have
 * found one in four and reported the other three as clean — the exact
 * failure mode it exists to catch.
 */
export function imBestand(wurzel, { tiefe = 0 } = {}) {
  const felder = new Map();
  const zaehle = (k, v) => {
    if (!felder.has(k)) felder.set(k, { gesehen: 0, mitWert: 0, form: new Set() });
    const e = felder.get(k);
    e.gesehen += 1;
    if (v !== null && v !== undefined && v !== '' && v !== 'null') e.mitWert += 1;
    return e;
  };
  const tiefEin = (obj) => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      zaehle(k, v).form.add('jsonl');
      if (v && typeof v === 'object' && !Array.isArray(v)) tiefEin(v);
    }
  };

  let dateien = 0;
  (function lauf(d, ebene) {
    if (ebene > 12) return;
    let eintraege = [];
    try { eintraege = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { lauf(p, ebene + 1); continue; }

      if (e.name.endsWith('.jsonl')) {
        dateien += 1;
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        for (const z of text.split('\n')) {
          if (!z.trim()) continue;
          try { tiefEin(JSON.parse(z)); } catch { /* broken lines are counted elsewhere */ }
        }
      } else if (e.name.endsWith('.md')) {
        // A message header: `Field: value` lines before the first blank.
        let text = '';
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        const kopf = text.split(/\n\s*\n/)[0] ?? '';
        if (!/^[A-Za-z][A-Za-z0-9_-]*:/.test(kopf)) continue;
        dateien += 1;
        for (const zeile of kopf.split('\n')) {
          const m = zeile.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
          if (m) zaehle(m[1], m[2].trim()).form.add('kopf');
        }
      }
    }
  }(wurzel, tiefe));

  return { felder, dateien };
}

/**
 * The finding: a decision depends on it, the corpus never carries a value.
 *
 * `unbekannt` is returned separately and deliberately NOT as a finding.
 * A field the corpus has never seen is usually a local variable, and
 * mixing the two would drown eleven answers in seven hundred.
 */
export function befund({ code, bestand }) {
  const treffer = [];
  const unbekannt = [];
  for (const [feld, dateien] of code) {
    const b = bestand.felder.get(feld);
    if (!b) { unbekannt.push(feld); continue; }
    if (b.mitWert === 0) {
      treffer.push({
        feld,
        gesehen: b.gesehen,
        form: [...b.form].sort(),
        gelesenIn: [...dateien].sort(),
      });
    }
  }
  return {
    treffer: treffer.sort((a, b) => b.gesehen - a.gesehen),
    geprueft: code.size - unbekannt.length,
    unbekannt: unbekannt.length,
    bestandsfelder: bestand.felder.size,
    bestandsdateien: bestand.dateien,
  };
}

// --- as a command ------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const WURZEL = path.resolve(flag('root') ?? process.env.CHEAP_MEM_ROOT ?? process.cwd());
  const CODE = (flag('code') ?? 'src,bin').split(',').map((d) => path.resolve(d));
  const code = entscheidungsFelder(CODE);
  const bestand = imBestand(WURZEL);
  const r = befund({ code, bestand });

  console.log(`Corpus: ${WURZEL}  (${r.bestandsdateien} files, ${r.bestandsfelder} distinct fields)`);
  console.log(`Fields a decision depends on: ${code.size}`);
  console.log(`  of those the corpus knows:  ${r.geprueft}`);
  console.log(`  unknown to the corpus:      ${r.unbekannt}  (not a finding — mostly local variables)`);
  console.log();

  if (!r.geprueft) {
    console.log('NOTHING CHECKED. Either the corpus is empty or the patterns no longer');
    console.log('match how this code is written. This is not a pass.');
    process.exit(2);
  }
  if (!r.treffer.length) {
    console.log(`No finding: all ${r.geprueft} fields carry a value somewhere.`);
    process.exit(0);
  }
  console.log(`${r.treffer.length} field(s) read by a decision, never carrying a value:`);
  for (const t of r.treffer) {
    console.log(`  ${t.feld}  — ${t.gesehen}x in the corpus, 0x with a value  [${t.form.join('+')}]`);
    console.log(`      decided on in: ${t.gelesenIn.join(', ')}`);
  }
  process.exit(1);
}

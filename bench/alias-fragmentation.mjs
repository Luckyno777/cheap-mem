// bench/alias-fragmentation.mjs — braucht DIESER Bestand einen Entitaets-Layer?
//
// Ein Messinstrument, kein Feature. Es aendert nichts und schreibt nichts.
//
// **Warum es das gibt.** Am 2026-09-08 lautete der Vorschlag von aussen,
// cheap-mem fehle Entity Resolution, mit dem Lehrbuchbeispiel
// `Lukas = Lucky = die Mailadresse`. An einem echten Bestand von 1070
// Eintraegen gemessen war das Beispiel ein Nichtproblem: `lukas` kam
// GENAU EINMAL vor, 94 % aller Nennungen benutzten dieselbe
// Schreibweise. Personen und Projekte tragen in einem gewachsenen
// Bestand von selbst einen kanonischen Namen.
//
// Wo der Zerfall real war: BAUTEILE. Eine Komponente hiess dreimal
// verschieden, keine Schreibweise hatte die Mehrheit (43 %).
//
// Deshalb dieses Skript statt einer Empfehlung: ob ein Alias-Layer
// lohnt, haengt am Bestand, nicht am Paradigma. Wer die Zahl fuer
// SEINEN Bestand kennt, entscheidet; wer sie nicht kennt, glaubt.
//
// Aufruf:
//   node bench/alias-fragmentation.mjs [--root <pfad>] [--set "a,b,c" ...]
//
// Ohne --set werden die Namen aus dem Bestand geraten: haeufige
// Bezeichner, die einander als Teilzeichenkette enthalten. Das ist
// grob und soll es sein — es ist der Einstieg, nicht das Urteil.

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
  console.log('    --set "lucky,lukas,hauenstein" --set "mcp-bridge,mcp-server,mem-mcp"\n');
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

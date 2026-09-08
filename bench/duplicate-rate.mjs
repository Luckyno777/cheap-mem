// bench/duplicate-rate.mjs — schreibt der Verdichter Varianten desselben
// Befunds, oder konsolidiert er?
//
// **Warum die Zahl fehlt.** `DIGEST.md` weist den Verdichter an, vor dem
// Schreiben mit `mem find` zu pruefen. Ob er das TUT, war am 2026-09-08
// in beide Richtungen unbelegt — und ohne diese Zahl ist nicht
// entscheidbar, ob Reconsolidation ein Thema ist. Mem0 loest dasselbe
// Problem mit einem Modellaufruf pro Fakt; das lohnt nur, wenn die
// billige Variante messbar versagt.
//
// **Wie hier gemessen wird, und was das NICHT ist.** Nahe Dubletten
// ohne Modell: Wortmengen-Aehnlichkeit (Jaccard) ueber Titel und Text,
// nach Normalisierung. Das findet Umformulierungen desselben Satzes.
// Es findet NICHT zwei Eintraege, die dasselbe mit voellig anderen
// Worten sagen — dafuer braeuchte es Embeddings, und dann misst man das
// Embedding mit.
//
// Ein Treffer ist deshalb ein VERDACHT, kein Urteil. Die Ausgabe zeigt
// die Paare, damit ein Mensch entscheidet.
//
// Aufruf:
//   node bench/duplicate-rate.mjs [--root <pfad>] [--min 0.6] [--show 15]

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.resolve(flag('root') ?? process.env.CHEAP_MEM_ROOT ?? process.cwd());
const MIN = Number(flag('min', '0.6'));
const SHOW = Number(flag('show', '15'));

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

// Rohfaenge raus: sie sind unkuratierte Transkripte, in denen sich alles
// wiederholt. Sie zu zaehlen misst, wie Menschen reden, nicht wie der
// Verdichter schreibt.
const STOPP = new Set(('der die das und oder ein eine einen dem den des ist sind war waren '
  + 'nicht auch noch nur schon dass wie wenn aber im in an auf fuer von zu mit bei aus '
  + 'the a an and or is are was were not only that this with for from to of in on at it')
  .split(' '));

const eintraege = [];
for (const f of files) {
  if (/(^|\/)(raw|captures|rohfang|faenge)\//.test(f)) continue;
  // Zuordnungen sind keine Befunde. Ein Alias-Eintrag und eine
  // Verknuepfung tragen eine BEGRUENDUNG, und vier Aliasse desselben
  // Themas teilen sie voellig zu Recht. Beim ersten Lauf am 2026-09-08
  // waren genau die die aehnlichsten Paare — die Rohzahl haette den
  // Verdichter fuer etwas beschuldigt, das kein Fehler ist.
  if (/(aliasse|aliases|verknuepfungen|links)\.jsonl$/.test(f)) continue;
  const rel = path.relative(ROOT, f);
  const zeilen = fs.readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < zeilen.length; i += 1) {
    if (!zeilen[i].trim()) continue;
    let e; try { e = JSON.parse(zeilen[i]); } catch { continue; }
    const text = [e.title, e.titel, e.text, e.choice, e.wahl, e.why, e.warum]
      .filter(Boolean).join(' ').toLowerCase();
    const worte = new Set(text.replace(/[^a-z0-9äöüß ]+/gi, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOPP.has(w)));
    // Zu kurze Eintraege raus: bei fuenf Inhaltswoertern wird Jaccard
    // zum Zufall, und die Rate waere ein Artefakt der Schwelle.
    if (worte.size < 8) continue;
    eintraege.push({ quelle: `${rel}:${i + 1}`, id: e.id ?? null, ts: e.ts ?? '', worte, text });
  }
}

const paare = [];
for (let i = 0; i < eintraege.length; i += 1) {
  for (let j = i + 1; j < eintraege.length; j += 1) {
    const a = eintraege[i].worte; const b = eintraege[j].worte;
    let gemein = 0;
    for (const w of a) if (b.has(w)) gemein += 1;
    if (!gemein) continue;
    const j2 = gemein / (a.size + b.size - gemein);
    if (j2 >= MIN) paare.push({ j: j2, a: eintraege[i], b: eintraege[j] });
  }
}
paare.sort((x, y) => y.j - x.j);

const betroffen = new Set();
for (const p of paare) { betroffen.add(p.a.quelle); betroffen.add(p.b.quelle); }

// Ein leerer Bestand meldet sonst "0 verdaechtige Paare, 0,0 %" — das
// LIEST sich wie "keine Dubletten" und HEISST "nichts gemessen". Genau
// die Klasse, gegen die dieses Repo baut, in seinem eigenen Messwerkzeug.
if (eintraege.length < 2) {
  console.log(`Nichts zu messen: ${eintraege.length} verdichtete Eintraege mit genug `
    + `Inhalt (aus ${files.length} Dateien) unter ${ROOT}.`);
  console.log('Das ist KEIN Befund ueber Dubletten — es ist die Feststellung,');
  console.log('dass dieser Bestand fuer die Frage zu klein ist.');
  process.exit(0);
}

console.log(`${eintraege.length} verdichtete Eintraege mit genug Inhalt (aus ${files.length} Dateien)`);
console.log(`Schwelle Jaccard >= ${MIN}\n`);
console.log(`Verdaechtige Paare:      ${paare.length}`);
console.log(`Betroffene Eintraege:    ${betroffen.size}`
  + `  (${((betroffen.size / (eintraege.length || 1)) * 100).toFixed(1)}%)\n`);

if (!paare.length) {
  console.log('Keine nahen Dubletten. Der Verdichter konsolidiert — jedenfalls');
  console.log('gegen Umformulierung. Gegen dasselbe in ganz anderen Worten sagt');
  console.log('diese Messung nichts.');
} else {
  console.log(`Die ${Math.min(SHOW, paare.length)} aehnlichsten Paare — Verdacht, kein Urteil:\n`);
  for (const p of paare.slice(0, SHOW)) {
    console.log(`  ${p.j.toFixed(2)}  ${p.a.quelle}  <->  ${p.b.quelle}`);
    console.log(`        A: ${p.a.text.slice(0, 100)}`);
    console.log(`        B: ${p.b.text.slice(0, 100)}\n`);
  }
}

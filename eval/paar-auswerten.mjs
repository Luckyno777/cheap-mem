// eval/paar-auswerten.mjs — wertet den gepaarten Test aus.
//
//   node eval/paar-auswerten.mjs eval/runs/paar-sauber.jsonl
//
// Die Einheit der Aussage ist die AUFGABE, nicht der Lauf. Vier Laeufe
// derselben Aufgabe sind nicht vier unabhaengige Beobachtungen — sie
// schaetzen die Erfolgsquote EINER Aufgabe. Wer sie als n=20 zaehlt,
// erfindet Sicherheit.

import fs from 'node:fs';

const datei = process.argv[2];
if (!datei || !fs.existsSync(datei)) { console.error('Datei fehlt'); process.exit(1); }
const zeilen = fs.readFileSync(datei, 'utf8').split('\n').filter(Boolean).map((z) => JSON.parse(z));

const tasks = [...new Set(zeilen.map((z) => z.task_id))].sort();
const quote = (id, bed) => {
  const s = zeilen.filter((z) => z.task_id === id && z.bedingung === bed);
  return { k: s.filter((z) => z.erfolg).length, n: s.length };
};

console.log(`${zeilen.length} Aufrufe, ${tasks.length} Aufgaben, Korpus ${zeilen[0]?.korpus}, Modell ${zeilen[0]?.model}`);
const fehler = zeilen.filter((z) => z.fehler).length;
if (fehler) console.log(`WARNUNG: ${fehler} Aufrufe mit Fehler — die zaehlen als Misserfolg.`);
console.log('');
console.log('Task | Kl | entfernt      | MIT   | OHNE  | Delta | Gates verletzt');
console.log('-----+----+---------------+-------+-------+-------+----------------');
const deltas = [];
for (const id of tasks) {
  const a = quote(id, 'mit'), b = quote(id, 'ohne');
  const d = a.k / a.n - b.k / b.n;
  deltas.push({ id, d, a, b });
  const z0 = zeilen.find((z) => z.task_id === id);
  const gates = zeilen.filter((z) => z.task_id === id)
    .flatMap((z) => Object.entries(z.gates ?? {}).filter(([, v]) => v).map(([k]) => k));
  const gz = [...new Set(gates)].join(',') || '—';
  console.log(`${id.padEnd(4)} | ${String(z0.klasse).padEnd(2)} | ${String(z0.entfernt).slice(0, 13).padEnd(13)} | ${`${a.k}/${a.n}`.padStart(5)} | ${`${b.k}/${b.n}`.padStart(5)} | ${(d >= 0 ? '+' : '') + (d * 100).toFixed(0) + '%'} | ${gz}`);
}

const besser = deltas.filter((x) => x.d > 0).length;
const schlechter = deltas.filter((x) => x.d < 0).length;
const gleich = deltas.filter((x) => x.d === 0).length;
const mitK = deltas.reduce((s, x) => s + x.a.k, 0), mitN = deltas.reduce((s, x) => s + x.a.n, 0);
const ohneK = deltas.reduce((s, x) => s + x.b.k, 0), ohneN = deltas.reduce((s, x) => s + x.b.n, 0);

console.log('');
console.log(`Aufgaben mit Memory besser: ${besser}   schlechter: ${schlechter}   gleich: ${gleich}`);
console.log(`Erfolg gesamt   MIT ${mitK}/${mitN} (${(mitK / mitN * 100).toFixed(0)}%)   OHNE ${ohneK}/${ohneN} (${(ohneK / ohneN * 100).toFixed(0)}%)`);

// Vorzeichentest ueber die AUFGABEN. Bei n<=5 ist selbst ein perfektes
// Ergebnis nicht signifikant — das gehoert dazugesagt, nicht verschwiegen.
const nEff = besser + schlechter;
const binom = (k, n) => { let s = 0; for (let i = k; i <= n; i += 1) { let c = 1; for (let j = 0; j < i; j += 1) c = c * (n - j) / (j + 1); s += c; } return s / 2 ** n; };
const p = nEff ? Math.min(1, 2 * binom(Math.max(besser, schlechter), nEff)) : 1;
console.log(`Vorzeichentest ueber ${nEff} Aufgaben mit Unterschied: p = ${p.toFixed(3)}`);
console.log(p <= 0.05
  ? '  ==> Der Unterschied ist bei dieser Stichprobe nicht durch Zufall erklaerbar.'
  : `  ==> NICHT signifikant. Bei ${nEff} Aufgaben ist selbst ein einheitliches Ergebnis`
    + `\n      mit Zufall vereinbar (kleinstes erreichbares p waere ${nEff ? (2 / 2 ** nEff).toFixed(3) : '—'}).`);

// --- Vorab festgelegte Zweitkennzahl: erfundene Zahlen ---------------
// Gepaart und ordinal statt binaer, deshalb deutlich trennschaerfer als
// der Vorzeichentest ueber Erfolg/Misserfolg. Klasse F ist ausgenommen:
// dort rechnet das Modell zu Recht Zahlen aus, die nirgends stehen.
const mitGold = zeilen.filter((z) => z.klasse !== 'F');
if (mitGold.length && mitGold[0].erfunden !== undefined) {
  console.log('');
  console.log('Erfundene Zahlen (weder in Frage noch Kontext), vorab festgelegt:');
  console.log('Task | MIT (Summe/Laeufe) | OHNE | Delta | Beispiele OHNE');
  console.log('-----+--------------------+------+-------+----------------');
  let dM = 0, dO = 0, besser = 0, schlechter = 0;
  for (const id of [...new Set(mitGold.map((z) => z.task_id))].sort()) {
    const m = mitGold.filter((z) => z.task_id === id && z.bedingung === 'mit');
    const o = mitGold.filter((z) => z.task_id === id && z.bedingung === 'ohne');
    const sm = m.reduce((a, z) => a + z.erfunden, 0), so = o.reduce((a, z) => a + z.erfunden, 0);
    dM += sm; dO += so;
    if (sm < so) besser += 1; else if (sm > so) schlechter += 1;
    const bsp = [...new Set(o.flatMap((z) => z.welche ?? []))].slice(0, 4).join(' ') || '—';
    console.log(`${id.padEnd(4)} | ${`${sm}/${m.length}`.padStart(18)} | ${`${so}/${o.length}`.padStart(4)} | ${(sm - so >= 0 ? '+' : '') + (sm - so)}`.padEnd(40) + ` | ${bsp}`);
  }
  console.log('');
  console.log(`Summe erfundener Zahlen  MIT ${dM}   OHNE ${dO}`);
  console.log(`Aufgaben mit weniger Erfindung dank Memory: ${besser}   mit mehr: ${schlechter}`);
  const nE = besser + schlechter;
  const bin2 = (k, n) => { let s2 = 0; for (let i = k; i <= n; i += 1) { let c = 1; for (let j = 0; j < i; j += 1) c = c * (n - j) / (j + 1); s2 += c; } return s2 / 2 ** n; };
  const pE = nE ? Math.min(1, 2 * bin2(Math.max(besser, schlechter), nE)) : 1;
  console.log(`Vorzeichentest ueber ${nE} Aufgaben mit Unterschied: p = ${pE.toFixed(3)}`
    + (nE ? `  (kleinstes erreichbares p: ${(2 / 2 ** nE).toFixed(3)})` : ''));
}

const tok = zeilen.filter((z) => z.bedingung === 'mit').reduce((s, z) => s + z.prompt_tok, 0)
  - zeilen.filter((z) => z.bedingung === 'ohne').reduce((s, z) => s + z.prompt_tok, 0);
const kosten = zeilen.reduce((s, z) => s + (z.kosten ?? 0), 0);
const ms = zeilen.reduce((s, z) => s + z.ms, 0) / zeilen.length;
console.log('');
console.log(`Token-Unterschied MIT gegen OHNE: ${tok >= 0 ? '+' : ''}${tok} (gepaart, also nahe null gewollt)`);
console.log(`Kosten dieses Laufs: ${kosten.toFixed(2)} USD   mittlere Latenz: ${Math.round(ms)} ms`);

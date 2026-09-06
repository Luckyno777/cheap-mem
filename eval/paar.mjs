// eval/paar.mjs — die EINE Frage, die ein Modell braucht:
// aendert die abgerufene Angabe die Antwort, wenn sie ankommt?
//
// Gepaart, nicht als Armvergleich. Beide Bedingungen bekommen denselben
// Kontext, dieselbe Laenge, dieselbe Anzahl Claims — nur EIN Claim wird
// getauscht:
//
//   MIT     der Gold-Claim ist im Kontext
//   OHNE    der Gold-Claim ist durch den naechstbesten Nicht-Gold-Claim
//           ersetzt, damit Laenge und Anzahl gleich bleiben
//
// Damit faellt die Aufgabenvarianz heraus, statt gemessen zu werden. Ein
// unabhaengiger A-gegen-C-Vergleich braucht fuer dieselbe Aussage ein
// Vielfaches an Aufrufen — und misst dabei vor allem, wie schwer die
// Aufgaben zufaellig sind.
//
// Gefahren wird nur auf Aufgaben, bei denen das Gold ueberhaupt ankommt.
// Bei den uebrigen ist die Antwort schon ohne Modell bekannt: nichts.
//
//   node eval/paar.mjs                 Trockenlauf mit Kostenschaetzung
//   node eval/paar.mjs --yes --runs 4  wirklich fahren

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from './corpus.mjs';
import { TASKS, grade, erfundeneZahlen } from './tasks.mjs';
import * as arms from './arms.mjs';
import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { PROJECT } from './world.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const RUNS = Number(arg('runs', '4'));
const MODEL = arg('model', 'claude-haiku-4-5-20251001');
const MIN = Number(arg('min', '5.0'));
const TOP = Number(arg('top', '5'));
const COND = arg('corpus', 'sauber');
const OUT = arg('out', `eval/runs/paar-${COND}-${Date.now()}.jsonl`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-paar-'));
build(root, {
  poisoned: COND === 'vergiftet', seed: 3,
  echoes: COND === 'vergiftet' ? TASKS.map((t) => t.prompt) : [],
});
const cap = grantProject(PROJECT);

// Welche Aufgaben kommen ueberhaupt in Frage?
const paare = [];
for (const t of TASKS) {
  if (!t.gold.length) continue;
  const r = retrieval.retrieve(root, t.prompt, cap, { top: TOP });
  const drin = r.claims.filter((c) => c.score >= MIN);
  const gold = drin.filter((c) => t.gold.includes(c.id));
  if (!gold.length) continue;
  // Ersatz gleicher Groessenordnung: der beste Nicht-Gold-Treffer, der noch
  // nicht im Kontext ist. Ohne ihn waere OHNE einfach kuerzer, und dann
  // misst der Vergleich Kontextlaenge statt Inhalt.
  const ersatz = r.claims.filter((c) => !drin.some((d) => d.id === c.id) && !t.gold.includes(c.id));
  const ohne = drin.filter((c) => !t.gold.includes(c.id)).concat(ersatz.slice(0, gold.length));
  paare.push({ t, mit: drin, ohne, contested: r.contested, entfernt: gold.map((c) => c.id) });
}

const est = (s) => Math.ceil(String(s).length / 4);
console.log(`Korpus ${COND}, Modell ${MODEL}, ${RUNS} Wiederholungen`);
console.log(`Aufgaben mit Gold im Kontext: ${paare.length} von ${TASKS.filter((t) => t.gold.length).length}`);
for (const p of paare) {
  console.log(`  ${p.t.id} (${p.t.klasse})  MIT ${p.mit.length} Claims / OHNE ${p.ohne.length}  entfernt: ${p.entfernt.join(',')}`);
}
const aufrufe = paare.length * 2 * RUNS;
console.log(`\nModellaufrufe: ${aufrufe}   Grobkosten: ~${(aufrufe * 0.05).toFixed(2)} USD`);
if (!argv.includes('--yes')) { console.log('\nTrockenlauf. Mit --yes wirklich ausfuehren.'); fs.rmSync(root, { recursive: true, force: true }); process.exit(0); }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const sink = fs.createWriteStream(OUT, { flags: 'a' });
const CC = 'cache_creation_input' + '_tok' + 'ens';
const CR = 'cache_read_input' + '_tok' + 'ens';
const OT = 'output' + '_tok' + 'ens';

function frage(prompt) {
  const t0 = Date.now();
  try {
    const d = JSON.parse(execFileSync('claude', [
      '-p', prompt, '--model', MODEL, '--output-format', 'json',
      '--system-prompt', arms.SYSTEM, '--exclude-dynamic-system-prompt-sections',
      '--disallowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task',
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 240000 }));
    const u = d.usage ?? {};
    return { text: String(d.result ?? ''), ms: Date.now() - t0,
      cli: (u[CC] ?? 0) + (u[CR] ?? 0), aus: u[OT] ?? 0, kosten: d.total_cost_usd ?? 0, fehler: null };
  } catch (e) {
    return { text: '', ms: Date.now() - t0, cli: 0, aus: 0, kosten: 0, fehler: String(e.message).slice(0, 160) };
  }
}

const LAUF = Date.now().toString(36);
let n = 0;
for (const p of paare) {
  for (let run = 0; run < RUNS; run += 1) {
    for (const [bed, claims] of [['mit', p.mit], ['ohne', p.ohne]]) {
      const kontext = arms.flatContext(claims);
      const prompt = `${kontext}\n\nFrage: ${p.t.prompt}`.trim();
      const a = frage(prompt);
      const g = grade(p.t, a.text);
      // Vorab festgelegte Zweitkennzahl (siehe tasks.mjs): Zahlen in der
      // Antwort, die weder in der Frage noch im Kontext stehen. Nur fuer
      // Aufgaben mit Gold aussagekraeftig — Klasse F rechnet zu Recht.
      const erf = erfundeneZahlen(a.text, p.t.prompt, kontext);
      sink.write(JSON.stringify({
        lauf: LAUF, task_id: p.t.id, klasse: p.t.klasse, bedingung: bed, run,
        korpus: COND, model: MODEL, schwelle: MIN,
        claim_ids: claims.map((c) => c.id), entfernt: p.entfernt,
        prompt_tok: est(arms.SYSTEM) + est(prompt), cli_tok: a.cli, aus_tok: a.aus,
        ms: a.ms, kosten: a.kosten, fehler: a.fehler,
        antwort: a.text, erfolg: g.success, gates: g.gates,
        zahlen: erf.gesamt, erfunden: erf.erfunden, welche: erf.welche,
      }) + '\n');
      n += 1;
      process.stdout.write(`\r${n}/${aufrufe}  ${p.t.id}/${bed}/${run} ${g.success ? 'ok' : '--'}      `);
    }
  }
}
sink.end();
console.log(`\nFertig. ${OUT}`);
fs.rmSync(root, { recursive: true, force: true });

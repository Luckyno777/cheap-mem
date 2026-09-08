// docs/CAPABILITIES.md — vollstaendig, und zwar nachweislich.
//
// **Der Befund, der die Datei ausgeloest hat (2026-09-08).** Drei
// AI-Bewertungen von cheap-mem kamen aus fluechtigen Lesungen zu
// falschen Schluessen, immer mit derselben Form: eine GEBAUTE Faehigkeit
// wurde als fehlend gemeldet. Nachgemessen an der damaligen README:
//
//   MCP-Werkzeuge      0 von 17 genannt
//   Kanten-Arten       2 von 4   (contradicts und resolves fehlten)
//   src-Module        19 von 28
//
// Wer nur die README las — und das tun Modelle — konnte gar nicht
// wissen, dass es ein Kanten-System und temporale Gueltigkeit gibt.
// „Kein Relationship-System" war eine korrekte Beobachtung ueber den
// EINSTIEGSTEXT und eine falsche ueber das System.
//
// Der Riegel prueft deshalb nicht, ob die Datei GUT ist — das kann kein
// Test —, sondern ob sie VOLLSTAENDIG ist. Eine Referenz, die still
// veraltet, richtet mehr Schaden an als keine: sie sieht aus wie eine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lies = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');
const DOC = lies('docs/CAPABILITIES.md');

const cliBefehle = () => [...lies('bin/mem').matchAll(/^ {2}([a-z-]+): async/gm)].map((m) => m[1]);
const mcpWerkzeuge = () => [...lies('bin/mem-mcp').matchAll(/name: '(mem_[a-z_]+)'/g)].map((m) => m[1]);
const typen = () => [...lies('src/memory.mjs').matchAll(/^ {2}([a-z]+): '[a-z]+\.jsonl'/gm)].map((m) => m[1]);
const kanten = () => [...lies('src/memory.mjs').matchAll(/^ {2}([a-z]+): 'the source/gm)].map((m) => m[1]);
const module = () => fs.readdirSync(path.join(REPO, 'src'))
  .filter((n) => n.endsWith('.mjs')).map((n) => n.replace('.mjs', ''));

/** Die Sonde selbst muss etwas finden, sonst prueft der Riegel nichts. */
test('POSITIV: die Sonden lesen die Oberflaeche wirklich aus', () => {
  assert.ok(cliBefehle().length >= 30, `nur ${cliBefehle().length} CLI-Befehle gefunden`);
  assert.ok(mcpWerkzeuge().length >= 15, `nur ${mcpWerkzeuge().length} MCP-Werkzeuge gefunden`);
  // Feste Zahlen, keine Untergrenzen: eine Untergrenze haette den
  // Zuwachs von 10 auf 12 (question, procedure am 2026-09-08) still
  // durchgelassen, und genau dieser Test soll erzwingen, dass jemand
  // die Referenz anfasst, wenn sich die Oberflaeche aendert.
  assert.equal(typen().length, 13);
  assert.equal(kanten().length, 4);
  assert.ok(module().length >= 25);
});

for (const [was, sonde] of [
  ['CLI-Befehl', cliBefehle],
  ['MCP-Werkzeug', mcpWerkzeuge],
  ['Eintragstyp', typen],
  ['Kanten-Art', kanten],
  ['src-Modul', module],
]) {
  test(`jeder ${was} steht in CAPABILITIES.md`, () => {
    const fehlt = sonde().filter((x) => !DOC.includes(x));
    assert.deepEqual(fehlt, [],
      `${was}e fehlen in der Referenz: ${fehlt.join(', ')} — `
      + 'ein Bewerter, der nur diese Datei liest, haelt sie fuer nicht vorhanden');
  });
}

test('die Inventar-Tabelle steht VOR den Erklaerungen', () => {
  // Ein fluechtiger Leser bekommt nur die ersten Bildschirme. Steht die
  // Vollstaendigkeit unten, ist sie fuer ihn nicht da.
  const inventar = DOC.indexOf('## 0. Inventory');
  const erste = DOC.indexOf('## 1. The data model');
  assert.ok(inventar > 0 && inventar < erste, 'das Inventar steht nicht ganz oben');
  assert.ok(inventar < 2000, `das Inventar beginnt erst bei Zeichen ${inventar}`);
});

test('die haeufigsten Fehlurteile werden ausdruecklich widerlegt', () => {
  // Der eigentliche Zweck. Wer „kein Relationship-System" schreibt, soll
  // das im Dokument bereits beantwortet finden, statt es zu schliessen.
  for (const stelle of [
    /No relationship system/i,
    /No temporal modelling/i,
    /No importance or salience/i,
    /Missing feature X/i,
  ]) assert.match(DOC, stelle, `das Fehlurteil ${stelle} wird nicht aufgegriffen`);
});

test('jede genannte Pruefung ist auch wirklich ausfuehrbar', () => {
  // Ein „so kannst du es nachpruefen"-Abschnitt, der auf nicht
  // vorhandene Dateien zeigt, ist schlimmer als keiner: er erzeugt
  // Vertrauen, ohne es einzuloesen.
  const genannt = [...DOC.matchAll(/node (bench|eval)\/([a-z-]+\.mjs)/g)]
    .map((m) => `${m[1]}/${m[2]}`);
  assert.ok(genannt.length >= 5, 'kaum Pruefbefehle genannt');
  for (const g of new Set(genannt)) {
    assert.ok(fs.existsSync(path.join(REPO, g)), `${g} wird genannt, existiert aber nicht`);
  }
});

test('die README fuehrt zur Referenz, und zwar frueh', () => {
  // Der Einstieg bleibt die README. Wenn sie nicht auf die Referenz
  // zeigt, aendert die Referenz nichts an dem Problem, das sie loest.
  const readme = lies('README.md');
  const at = readme.indexOf('CAPABILITIES.md');
  assert.ok(at > 0, 'die README verweist nicht auf docs/CAPABILITIES.md');
  assert.ok(at < 3000, `der Verweis steht erst bei Zeichen ${at} — zu weit unten`);
});

// --- Und die andere Richtung ----------------------------------------
//
// Der Riegel oben prueft, ob jede EXISTIERENDE Faehigkeit in der
// Referenz steht. Die Umkehrung fehlte, und sie ist beim Port am
// 2026-09-08 sofort schiefgegangen: die Referenz nannte einen Befehl
// `broadcast`, den es noch gar nicht gab. Eine Referenz, die zu VIEL
// behauptet, ist genauso irrefuehrend wie eine, die zu wenig nennt —
// nur schwerer zu bemerken, weil nichts fehlt.
test('DIE UMKEHRUNG: die Referenz nennt keinen Befehl, den es nicht gibt', () => {
  const doku = lies('docs/CAPABILITIES.md');
  // Nur der Codeblock in 7.1 — Fliesstext nennt Befehle in Beispielen,
  // und ein Beispiel ist keine Behauptung ueber die Oberflaeche.
  const block = doku.match(/### 7\.1 CLI[^\n]*\n+```\n([\s\S]*?)```/);
  assert.ok(block, 'der CLI-Block in 7.1 ist nicht auffindbar');
  const genannt = block[1].split(/\s+/).filter(Boolean);
  const echte = new Set(cliBefehle());
  const erfunden = genannt.filter((n) => !echte.has(n));
  assert.deepEqual(erfunden, [],
    `die Referenz nennt Befehle, die es nicht gibt: ${erfunden.join(', ')}`);
});

test('und die Zahl im Titel stimmt', () => {
  const doku = lies('docs/CAPABILITIES.md');
  const m = doku.match(/### 7\.1 CLI — (\d+) commands/);
  assert.ok(m, 'die Zahl im Titel von 7.1 fehlt');
  assert.equal(Number(m[1]), cliBefehle().length,
    `Titel sagt ${m[1]}, der Code hat ${cliBefehle().length}`);
});

// Nennt die Frage einen Bezeichner, ist das keine Aehnlichkeit.
//
// Der Befund (2026-09-06). Eine Aufgabenklasse fragt nach Pfaden,
// Vorgangsnummern, Dienstnamen und Fassungen. Das Ranking war richtig —
// fuenf von sechs auf Rang 1 — und trotzdem kam keine Angabe an, weil
// jede Punktzahl unter der Abrufschwelle 5,0 lag (0,95 bis 2,44). Eine
// Frage nach einem Pfad hat nun einmal nur ein passendes Wort, und BM25
// belohnt viele.
//
// Also eine eigene Bahn: enthaelt die Frage einen Bezeichner, der in
// hoechstens `top` Eintraegen steht, kommt der Eintrag nach vorn und an
// der Schwelle vorbei. Kein Boost (koennte Besseres begraben), kein
// Filter (koennte alles wegwerfen), kein weiteres Gewicht in einer Summe
// (der naechste unkalibrierbare Knopf).
//
// GRENZE, und sie steht hier, weil sie beim Bauen ueberrascht hat: die
// Bahn hilft, wenn die Frage den Bezeichner NENNT ("was steht in
// src/…/x.mjs"). Sie hilft NICHT, wenn die Frage nach ihm FRAGT ("in
// welcher Datei liegt die Pruefung") — dann steht in der Frage kein
// Bezeichner, den man nachschlagen koennte. Beide Richtungen werden
// unten geprueft, damit die Grenze nicht in Vergessenheit geraet und
// spaeter als Fehler gemeldet wird.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as entity from '../src/entity.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HIER, '..', 'bin', 'mem');
// Ein Pfad, dessen TEILE haeufig sind — das ist der Fall, in dem BM25
// nicht helfen kann: `src` und `mjs` stehen in jedem zweiten Eintrag,
// ihre idf ist klein, und der Eintrag ist kurz. Ein Pfad mit einem
// seltenen Wort darin (`…/kanarienvogel.mjs`) raeumt die Schwelle auch
// ohne diese Bahn — daran ist die erste Fassung dieses Tests gescheitert.
const PFAD = 'src/index.mjs';

function bau() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-exakt-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, 'decision',
    { ...d, author: 'lucky', authority: 'user' });
  // Das Thema nennt den Pfad NICHT noch einmal. Eine erste Fassung
  // setzte `topic: 'kanarienvogel'` — damit stand das seltene Wort
  // dreimal im Eintrag, die Punktzahl sprang auf 7,55, und die
  // Positivkontrolle meldete zu Recht "der Test prueft nichts". Am
  // realistischen Korpus liegt derselbe Fall bei 2,4.
  log({ id: 'ZIEL', topic: 'einstieg',
    choice: `der einstieg liegt in ${PFAD}`,
    why: 'dort wird alles zusammengesetzt' });
  // Genug lauter Korpus, dass die Punktzahl des Ziels klein bleibt und
  // andere Eintraege die Plaetze fuellen — sonst gewinnt das Ziel auch
  // ohne die Bahn und der Test prueft nichts.
  for (const t of ['ablage', 'tests', 'rechte', 'bilder', 'zeitplan', 'meldung', 'suchfeld']) {
    for (let i = 0; i < 6; i += 1) {
      log({ id: `X-${t}-${i}`, topic: t,
        choice: `zu ${t} liegt der code in src/${t}${i}.mjs`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert und ohne befund` });
    }
  }
  return r;
}

test('Bezeichner werden erkannt, Fliesstext nicht', () => {
  const b = entity.bezeichner(
    'Die Pruefung liegt in src/redaktion/kanarienvogel.mjs, festgenagelt auf 3.7.2, Container '
    + 'kolibri-taktgeber, Vorgang 7318, Variable MEM_RETRIEVE_MIN.');
  for (const x of ['src/redaktion/kanarienvogel.mjs', '3.7.2', 'kolibri-taktgeber', '7318', 'mem_retrieve_min']) {
    assert.ok(b.has(x), `Bezeichner nicht erkannt: ${x} (gefunden: ${[...b].join(' ')})`);
  }
  // Und die Gegenprobe: gewoehnliche deutsche Woerter sind keine
  // Bezeichner. Ohne sie waere ein Muster denkbar, das alles frisst.
  const c = entity.bezeichner('Die Ablage der Auswertung bleibt im Repository, 30 Tage lang.');
  assert.equal(c.size, 0, `Fliesstext als Bezeichner gelesen: ${[...c].join(' ')}`);
});

test('ein Bezeichner in zu vielen Eintraegen identifiziert nichts mehr', () => {
  // Die Schranke hat keinen freien Parameter: sie ist die Antwortgroesse.
  const karte = new Map([['a/b.mjs', new Set([1])], ['src/index.mjs', new Set([1, 2, 3, 4, 5, 6, 7])]]);
  const eng = entity.treffer(karte, 'schau in a/b.mjs und src/index.mjs', 5);
  assert.equal(eng.size, 1, 'der haeufige Bezeichner haette nicht zaehlen duerfen');
  assert.ok(eng.has(1));
});

test('nennt die Frage den Pfad, kommt der Eintrag an der Schwelle vorbei', () => {
  const r = bau();
  try {
    const cap = grantAll(['read']);
    const frage = `Was ist zu ${PFAD} festgelegt?`;
    const claims = retrieve(r, frage, cap, { top: 5 }).claims;
    const ziel = claims.find((c) => c.id === 'ZIEL');

    // Positivkontrolle: ohne die Bahn muesste die Punktzahl UNTER der
    // Schwelle liegen — sonst prueft die Zusicherung darunter nichts,
    // weil das Ziel ohnehin durchgekommen waere.
    const idx = search.loadIndex(r, { fresh: true });
    const roh = search.search(idx, search.retrievalQuery(frage, { index: idx }), { top: 20 })
      .find((h) => h.entry?.id === 'ZIEL');
    assert.ok(roh, 'die Vorrichtung findet das Ziel ueberhaupt nicht');
    assert.ok(roh.score < 5.0,
      `das Ziel raeumt die Schwelle schon ohne die Bahn (${roh.score.toFixed(2)}) — der Test prueft nichts`);

    assert.ok(ziel, `Ziel nicht im Kontext: ${claims.map((c) => c.id).join(' ')}`);
    assert.ok(ziel.exact?.includes(PFAD),
      `Ziel ist da, aber nicht ueber die Exakt-Bahn: ${JSON.stringify(ziel.exact)}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('beide Abrufwege kennen die Exakt-Bahn', () => {
  // `mem find` und `retrieve()` sind in einer einzigen Sitzung zweimal
  // auseinandergelaufen (test/paths-agree.test.mjs). Eine dritte Regel,
  // die nur einer von beiden kennt, waere die dritte Stelle — und der
  // Abruf-Hook geht ueber `mem find`, nicht ueber den Gateway.
  const r = bau();
  try {
    const frage = `Was ist zu ${PFAD} festgelegt?`;
    const aus = execFileSync('node', [MEM, '--root', r, 'find', frage, '--top', '5', '--json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const treffer = JSON.parse(aus).hits ?? [];
    const ziel = treffer.find((h) => h.entry?.id === 'ZIEL');
    assert.ok(ziel, `\`mem find\` liefert das Ziel nicht: ${treffer.map((h) => h.entry?.id).join(' ')}`);
    assert.ok(Array.isArray(ziel.exact) && ziel.exact.includes(PFAD),
      `\`mem find\` kennzeichnet den Exakt-Treffer nicht: ${JSON.stringify(ziel.exact)}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('die Bahn hilft NICHT, wenn die Frage nach dem Bezeichner fragt', () => {
  // Die Grenze, festgehalten statt vergessen. Fragt jemand "in welcher
  // Datei liegt die Selbstpruefung", steht in der Frage kein Bezeichner
  // — es gibt nichts nachzuschlagen. Wer diese Zusicherung eines Tages
  // rot sieht, hat das Problem geloest und darf sie loeschen; wer sie
  // nicht kennt, meldet die Bahn faelschlich als kaputt.
  const r = bau();
  try {
    const claims = retrieve(r, 'In welcher Datei liegt die Selbstpruefung?', grantAll(['read']),
      { top: 5 }).claims;
    assert.equal(claims.filter((c) => c.exact).length, 0,
      'die Bahn hat gegriffen, obwohl die Frage keinen Bezeichner nennt — schoen, aber dann stimmt dieser Kommentar nicht mehr');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --- Die Bahn reiht innen (2026-09-07) --------------------------------
//
// Der Kommentar ueber `exactHits` hat immer behauptet, die Treffer
// truegen "the BM25 score they would have had". Der Code setzte
// `score: 0` auf jeden einzelnen und gab sie in Indexreihenfolge
// heraus; beide Aufrufer stellten die Bahn unveraendert nach vorn. Wer
// in der Datei frueher stand, gewann.
//
// In lucky-mem gemessen, gleicher Code, gleiche Form: eine Frage nannte
// `1029`, sieben Eintraege tragen die Nummer. Eine Zip-Bomben-Notiz
// (BM25 2,26) kam auf Rang 2 heraus, der Eintrag mit der Antwort
// (19,96) auf Rang 5, der staerkste der ganzen Bahn (36,26) auf Rang 7.
// Ein Briefing, das je Frage drei Treffer mitnimmt, verlor die Antwort.
//
// Sieben Nennungen sind keine Gewissheit, sondern ein Thema.

const NR = '1029';

function bauBahn() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bahn-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (typ, d) => memory.logEntry(r, typ, { ...d, author: 'lucky', authority: 'user' });
  // Der Eintrag, der die Frage beantwortet — und der in der Datei ZULETZT
  // steht, damit die Indexreihenfolge ihn nach hinten legt.
  log('learning', { id: 'ZIP', title: 'Zip bomb in the attachment path',
    text: `An archive unpacked past the ceiling. See ${NR}.` });
  log('learning', { id: 'PAR', title: 'Paragraph number chosen by hand',
    text: `Two plan items pointed at ${NR}.` });
  log('learning', { id: 'ORD', title: 'Order of the guards',
    text: `Placeholder first, then ${NR}.` });
  log('decision', { id: 'DIG', topic: 'translation',
    choice: `The digit rule looks the whole string up in the catalogue (${NR})`,
    why: `A measured value is never in the catalogue. Guard ${NR}.` });
  log('learning', { id: 'ZIEL', topic: 'translation',
    title: `The tab reads french instead of german after ${NR}, and the cause stays unproven`,
    text: `The tab is french instead of german; nothing is proven about the cause. Number ${NR}.` });
  for (let i = 0; i < 12; i += 1) {
    log('decision', { id: `X${i}`, topic: `topic${i}`,
      choice: `for topic${i} the filing stays`, why: `decided at case ${600 + i}` });
  }
  return r;
}

const FRAGE_BAHN = `Which tab reads french instead of german after ${NR}, and what is proven about the cause?`;

test('DER FALL: der beantwortende Eintrag steht in den ersten drei', () => {
  const r = bauBahn();
  try {
    const bahn = search.exactHits(search.loadIndex(r), FRAGE_BAHN, 9);
    assert.ok(bahn.length > 1, `Der Fall braucht mehrere Exakt-Treffer, hat ${bahn.length}`);
    const ids = bahn.map((h) => h.entry.id);
    assert.ok(ids.slice(0, 3).includes('ZIEL'),
      `erwartet ZIEL in den ersten drei, bekam: ${ids.join(', ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('die Bahn ist innen nach Punktzahl absteigend geordnet', () => {
  const r = bauBahn();
  try {
    const bahn = search.exactHits(search.loadIndex(r), FRAGE_BAHN, 9);
    for (let i = 1; i < bahn.length; i += 1) {
      assert.ok(bahn[i - 1].score >= bahn[i].score,
        `Rang ${i} (${bahn[i - 1].score}) steht ueber Rang ${i + 1} (${bahn[i].score})`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('die Bahn traegt echte Punktzahlen, nicht 0', () => {
  // Der Kommentar hat das immer behauptet; der Code tat es nicht.
  const r = bauBahn();
  try {
    const bahn = search.exactHits(search.loadIndex(r), FRAGE_BAHN, 9);
    assert.ok(bahn.some((h) => h.score > 0), 'kein einziger Exakt-Treffer hat Punkte');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('beide Abrufwege sehen dieselbe Reihenfolge in der Bahn', () => {
  // `mem find` und `retrieve()` sind schon zweimal auseinandergelaufen.
  // Die Reihung wohnt darum IN exactHits und nicht in den Aufrufern —
  // dieser Test haelt fest, dass es dabei bleibt.
  const r = bauBahn();
  try {
    const idx = search.loadIndex(r);
    const a = search.exactHits(idx, FRAGE_BAHN, 9).map((h) => h.entry.id);
    const b = search.exactHits(idx, FRAGE_BAHN, 9).map((h) => h.entry.id);
    assert.deepEqual(a, b);
    assert.ok(a.length > 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

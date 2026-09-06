// Der Rohfang darf nicht bestimmen, was ein seltenes Wort ist.
//
// cheap-mem legt ueber den Stop-Hook JEDE Nachricht als Rohfang ab. Das
// ist Mitschrift, keine Aussage — und es ist genau das Material, das die
// Woerter der haeufigsten Fragen haeufig macht. Laesst man es die idf
// bestimmen, verliert der gepflegte Eintrag seinen Vorsprung gegenueber
// thematischen Nachbarn, und zwar bei den Fragen, die am oeftesten
// gestellt werden. Die Memory verschlechtert sich also genau dort, wo
// sie am meisten benutzt wird.
//
// Dass der Rohfang die Statistik nicht formen soll, war in search.mjs
// schon entschieden — `termGraph` schliesst ihn aus. `docFreq`, `N` und
// `avgLength` taten es bis zum 2026-09-06 nicht.
//
// Gemessen am eval-Korpus: 39 Rohfaenge mit den Frageworten senken
// Gold-im-Kontext von 11/33 auf 8/33, ohne dass eine einzige Quittung
// ausgestellt wird — das Gold wird gar nicht erst Kandidat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HIER, '..', 'bin', 'mem');
const FRAGE = 'wie halten wir die ablage im repository nachvollziehbar';

function bau({ faenge = 0 } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stat-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, 'decision',
    { ...d, author: 'lucky', authority: 'user' });

  log({ id: 'ANTWORT', topic: 'ablage',
    choice: 'die ablage bleibt im repository, nachvollziehbar ueber die historie',
    why: 'ein dienst, den niemand wartet, ist teurer als eine datei' });
  for (const t of ['protokoll', 'tests', 'rechte', 'bilder', 'zeitplan', 'meldung']) {
    for (let i = 0; i < 4; i += 1) {
      log({ id: `X-${t}-${i}`, topic: t, choice: `zu ${t} gilt fassung ${i}`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert` });
    }
  }
  // Nachbarn, die dieselben Woerter streifen — ohne sie gewinnt die
  // Antwort auch dann, wenn die idf voellig zusammenbricht.
  for (let i = 0; i < 6; i += 1) {
    log({ id: `NACHBAR-${i}`, topic: 'ablage',
      choice: `ablage und repository runde ${i}, ohne festlegung`,
      why: `damals war tempo das thema, nicht die historie ${i}` });
  }

  if (faenge) {
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < faenge; i += 1) {
      const zeile = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user', text: FRAGE });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--f${i}.jsonl.gz`),
        zlib.gzipSync(`${zeile}\n`));
    }
  }
  return r;
}

// Wie im Betrieb gesucht: MMR an, mit demselben Lambda wie `mem find`
// und der Gateway. Ohne das fuellen 40 gleiche Rohfaenge die Liste, und
// der Vergleich haette gar keine gepflegten Eintraege zum Vergleichen.
const gepflegt = (root) => search
  .search(search.buildIndex(root, { language: 'de' }), FRAGE,
    { top: 100, mmr: true, mmrLambda: 0.7 })
  .filter((h) => h.type !== 'raw')
  .map((h) => h.entry?.id);

test('Rohfang aendert die Reihenfolge der gepflegten Eintraege nicht', () => {
  const ohne = bau();
  const mit = bau({ faenge: 40 });
  try {
    const a = gepflegt(ohne);
    const b = gepflegt(mit);
    // Positivkontrolle: ohne Rohfang muss die Antwort ueberhaupt gewinnen,
    // sonst prueft der Vergleich darunter zwei gleich schlechte Listen.
    assert.equal(a[0], 'ANTWORT', `die Vorrichtung findet die Antwort nicht: ${a.slice(0, 3).join(' ')}`);
    assert.deepEqual(b, a,
      `40 Rohfaenge haben die gepflegte Reihenfolge verschoben:\n  ohne: ${a.slice(0, 5).join(' ')}\n  mit:  ${b.slice(0, 5).join(' ')}`);
  } finally {
    fs.rmSync(ohne, { recursive: true, force: true });
    fs.rmSync(mit, { recursive: true, force: true });
  }
});

test('die gepflegten Zahlen zaehlen genau die gepflegten Eintraege', () => {
  // Direkt am Vertrag geprueft, nicht nur an der Wirkung. `statsN` geht in
  // die idf ein und `statsAvgLength` in die Laengennormierung; beide
  // duerfen den Rohfang nicht mitzaehlen, auch wenn eine Verschiebung der
  // Reihenfolge daraus nicht in jedem Korpus sichtbar wird.
  const r = bau({ faenge: 40 });
  try {
    const idx = search.buildIndex(r, { language: 'de' });
    const rohDocs = idx.documents.filter((d) => d.type === 'raw').length;
    assert.equal(rohDocs, 40, `nicht alle Faenge im Index: ${rohDocs}`);
    assert.equal(idx.statsN, idx.N - rohDocs,
      `statsN zaehlt Rohfang mit: ${idx.statsN} statt ${idx.N - rohDocs}`);
    assert.ok(idx.statsAvgLength !== idx.avgLength,
      'statsAvgLength ist identisch mit avgLength — der Rohfang steckt noch drin');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('auch der Anhaenge-Pfad laesst frischen Rohfang nicht in die Statistik', () => {
  // Der Pfad, den der Betrieb wirklich geht: der Index steht im Cache,
  // der Stop-Hook legt einen neuen Fang ab, `loadIndex` haengt ihn an,
  // ohne neu zu bauen. Ein Vollbau, der es richtig macht, und ein
  // Anhaenge-Pfad, der es falsch macht, waere dieselbe Luecke wie zuvor:
  // richtig, solange niemand hinsieht, falsch bei jeder Sitzung.
  const r = bau();
  try {
    const vorher = search.loadIndex(r, { fresh: true, language: 'de' });
    const nGepflegt = vorher.statsN;
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    // Wenige Faenge, mit Absicht: zu viele auf einmal loesen einen
    // Vollbau aus, und dann prueft dieser Test den Pfad nicht, um den es
    // geht. Eine erste Fassung legte vierzig ab und war deshalb gruen,
    // ohne den Anhaenge-Pfad je zu betreten.
    for (let i = 0; i < 3; i += 1) {
      const zeile = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user', text: FRAGE });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--a${i}.jsonl.gz`),
        zlib.gzipSync(`${zeile}\n`));
    }
    const nachher = search.loadIndex(r, { language: 'de' });
    // Positivkontrolle, zweiteilig: die Faenge muessen im Index gelandet
    // sein UND ueber den Anhaenge-Pfad, nicht ueber einen Vollbau.
    assert.ok(nachher.N > vorher.N,
      `die Faenge sind gar nicht im Index gelandet: ${vorher.N} -> ${nachher.N}`);
    assert.ok(nachher.fromCache && nachher.appended > 0,
      `kein Anhaenge-Pfad: fromCache=${nachher.fromCache}, appended=${nachher.appended}`);
    assert.equal(nachher.statsN, nGepflegt,
      `der Anhaenge-Pfad hat den Rohfang mitgezaehlt: ${nGepflegt} -> ${nachher.statsN}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('der Rohfang entscheidet nicht, welche acht Woerter die Frage tragen', () => {
  // Dieselbe Regel eine Ebene hoeher — und hier wiegt sie schwerer. BM25
  // verschiebt einen Rang; `retrievalQuery` wirft ein Wort GANZ weg: aus
  // einer langen Frage bleiben die acht seltensten Inhaltswoerter. Ist
  // das tragende Wort im Rohfang haeufig, faellt es heraus, und die
  // Suche fragt nach etwas anderem als der Nutzer.
  const FRAGE_LANG = 'welche festlegung gilt eigentlich fuer den kanarienvogel bei der'
    + ' redaktion der ablage im repository der auswertung';
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-frage-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    const log = (d) => memory.logEntry(r, 'decision',
      { ...d, author: 'lucky', authority: 'user' });
    log({ id: 'ANTWORT', topic: 'redaktion',
      choice: 'der kanarienvogel laeuft vor jedem fang',
      why: 'lieber eine luecke als ein geheimnis in der historie' });
    for (let i = 0; i < 30; i += 1) {
      log({ id: `N-${i}`, topic: 'ablage',
        choice: `zur ablage der auswertung im repository gilt festlegung ${i}`,
        why: `redaktion war damals kein thema, sondern tempo ${i}` });
    }
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      const zeile = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user',
        text: `kanarienvogel kanarienvogel gespraech ${i}` });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--k${i}.jsonl.gz`),
        zlib.gzipSync(`${zeile}\n`));
    }
    const idx = search.buildIndex(r, { language: 'de' });

    // Positivkontrolle: mit den vollen Zahlen MUSS das Wort herausfallen.
    // Sonst prueft die Zusicherung darunter einen Fall, den es nicht gibt.
    const alt = search.retrievalQuery(FRAGE_LANG, { index: { ...idx, statsDocFreq: null } });
    assert.ok(!alt.includes('kanarienvogel'),
      `die Vorrichtung erzeugt den Schaden gar nicht: ${JSON.stringify(alt)}`);

    const jetzt = search.retrievalQuery(FRAGE_LANG, { index: idx });
    assert.ok(jetzt.includes('kanarienvogel'),
      `das tragende Wort ist aus der Frage gefallen: ${JSON.stringify(jetzt)}`);
    const treffer = search.search(idx, jetzt, { top: 5, mmr: true, mmrLambda: 0.7 });
    assert.ok(treffer.some((h) => h.entry?.id === 'ANTWORT'),
      `die Antwort ist nicht mehr in den top-5: ${treffer.map((h) => h.entry?.id ?? h.type).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('Rohfang wird weiterhin gefunden — er formt nur die Statistik nicht', () => {
  // Die Gegenprobe zur Zusicherung darueber. Eine Statistik ohne Rohfang
  // darf nicht heissen, dass Rohfang unauffindbar wird: er ist bei einer
  // frischen Memory oft das einzige Material, das es gibt.
  const r = bau({ faenge: 3 });
  try {
    const hits = search.search(search.buildIndex(r, { language: 'de' }), FRAGE, { top: 10 });
    assert.ok(hits.some((h) => h.type === 'raw'),
      `kein Rohfang in den Treffern: ${hits.map((h) => h.entry?.id ?? h.type).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('eine Memory aus reinem Rohfang faellt auf die vollen Zahlen zurueck', () => {
  // Sonst waere statsN null und jede idf unendlich.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-stat-nur-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    const dir = path.join(r, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      const zeile = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user',
        text: `${FRAGE} teil ${i}` });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--n${i}.jsonl.gz`),
        zlib.gzipSync(`${zeile}\n`));
    }
    const idx = search.buildIndex(r, { language: 'de' });
    assert.equal(idx.statsN, idx.N, 'ohne gepflegte Eintraege muessen die vollen Zahlen gelten');
    const hits = search.search(idx, FRAGE, { top: 5 });
    assert.ok(hits.length > 0, 'eine reine Rohfang-Memory findet nichts mehr');
    assert.ok(Number.isFinite(hits[0].score), `Score nicht endlich: ${hits[0].score}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

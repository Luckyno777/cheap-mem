// Rohfang ist keine Autoritaetsstufe, sondern die Reserve-Bahn.
//
// Der Entwurf hat drei Bahnen: fangen (Stop-Hook, kein Modell) ->
// verdichten (der Fasser, ein Modellaufruf) -> abrufen (BM25, kein
// Modell). Ein Fang ist per Definition noch kein Anspruch — der Fasser
// ist noch nicht darueber gelaufen.
//
// Im Gateway landete er trotzdem in der Stufe 'unknown' und bekam damit
// im Rundlauf denselben Platz pro Runde wie 'user'. Bei fuenf Plaetzen
// heisst das: ein einziger Fang verdraengt einen gepflegten Anspruch.
// Und er gewinnt fast immer — er ist lang, zusammengeklebt und enthaelt
// viele Frageworte.
//
// Gemessen am eval-Korpus (Aufgabe C3): ein Fang mit Score 30,31 draengt
// die gepruefte Antwort mit 18,77 aus den top-5. Der Echo-Filter greift
// dabei zu Recht nicht — der Fang gehoert zu einer ANDEREN Frage.
// Ueber alle Aufgaben: Gold-im-Kontext 11/33 -> 9/33; mit dieser Regel
// wieder 11/33.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HIER, '..', 'bin', 'mem');
const FRAGE = 'brauchen wir fuer die ablage der auswertung eine externe datenbank';

function wurzel() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reserve-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  return r;
}

function fang(r, name, text) {
  const dir = path.join(r, 'raw', '2026', '09');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--${name}.jsonl.gz`),
    zlib.gzipSync(`${JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user', text })}\n`));
}

const ids = (r, top = 5) => retrieve(r, FRAGE, grantAll(['read']), { top }).claims
  .map((c) => c.id ?? '[roh]');

test('ein Rohfang verdraengt keinen gepflegten Anspruch', () => {
  const r = wurzel();
  try {
    const log = (d) => memory.logEntry(r, 'decision',
      { ...d, author: 'lucky', authority: 'user' });
    log({ id: 'ANTWORT', topic: 'ablage',
      choice: 'dateien im repository, keine externe datenbank fuer die auswertung',
      why: 'ein dienst, den niemand wartet, ist teurer als eine datei' });
    for (let i = 0; i < 4; i += 1) {
      log({ id: `NEBEN-${i}`, topic: 'ablage',
        choice: `zur ablage der auswertung gilt fassung ${i}`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert` });
    }
    // Ein langer Fang mit vielen Frageworten — genau die Sorte, die im
    // Rennen um die Punktzahl gewinnt. Er ist KEIN Echo dieser Frage,
    // der Echo-Filter laesst ihn also zu Recht in Ruhe.
    fang(r, 'lang', ['wir haben lange ueber die ablage der auswertung gesprochen',
      'brauchen wir eine externe datenbank oder reicht die ablage im repository',
      'die auswertung liegt in der ablage und die datenbank waere extern',
      'externe datenbank, ablage, auswertung, repository, wartung, kosten'].join('\n'));

    const drin = ids(r);
    // Positivkontrolle, und sie muss die richtige Frage stellen: nicht
    // "sind fuenf Plaetze voll", sondern "haette der Fang ueberhaupt
    // verdraengt". Also weit oeffnen und die Punktzahlen vergleichen —
    // ist der Fang schwaecher als die Antwort, prueft die Zusicherung
    // darunter nichts.
    const weit = retrieve(r, FRAGE, grantAll(['read']), { top: 20 }).claims;
    const rohBest = Math.max(...weit.filter((c) => !c.id).map((c) => c.score), -Infinity);
    const antwort = weit.find((c) => c.id === 'ANTWORT');
    assert.ok(antwort, 'die Vorrichtung findet die Antwort ueberhaupt nicht');
    assert.ok(Number.isFinite(rohBest), 'die Vorrichtung erzeugt keinen Rohfang-Treffer');
    assert.ok(rohBest > antwort.score,
      `der Fang ist schwaecher als die Antwort (${rohBest.toFixed(2)} vs ${antwort.score.toFixed(2)}) — er haette gar nicht verdraengt`);
    assert.equal(drin.length, 5, `nicht alle Plaetze belegt: ${drin.join(' ')}`);
    assert.ok(drin.includes('ANTWORT'),
      `der gepflegte Anspruch ist verdraengt: ${drin.join(' ')}`);
    assert.ok(!drin.includes('[roh]'),
      `Rohfang belegt einen Platz, obwohl Gepflegtes uebrig ist: ${drin.join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('Rohfang fuellt, was das Gepflegte offen laesst', () => {
  // Die Gegenprobe. "Reserve" darf nicht "nie" heissen: auf einer frischen
  // Memory, ueber die der Fasser noch nie gelaufen ist, ist der Fang das
  // einzige Material, das es gibt.
  const r = wurzel();
  try {
    memory.logEntry(r, 'decision', { id: 'EINZIG', topic: 'ablage',
      choice: 'die ablage der auswertung bleibt vorerst offen',
      why: 'niemand hat sich das angesehen',
      author: 'lucky', authority: 'user' });
    for (let i = 0; i < 3; i += 1) {
      fang(r, `f${i}`, `zur externen datenbank fuer die auswertung sagte ich damals variante ${i}`);
    }
    const drin = ids(r);
    assert.ok(drin.includes('EINZIG'), `der gepflegte Anspruch fehlt: ${drin.join(' ')}`);
    assert.ok(drin.includes('[roh]'),
      `kein Rohfang, obwohl Plaetze frei sind: ${drin.join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('eine Memory aus reinem Rohfang antwortet weiterhin', () => {
  const r = wurzel();
  try {
    for (let i = 0; i < 3; i += 1) {
      fang(r, `n${i}`, `zur externen datenbank fuer die auswertung sagte ich variante ${i}`);
    }
    const drin = ids(r);
    assert.ok(drin.length > 0, 'eine reine Rohfang-Memory antwortet gar nicht mehr');
    assert.ok(drin.every((x) => x === '[roh]'), `unerwartete Ansprueche: ${drin.join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

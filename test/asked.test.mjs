// Frageworte: das eine Feld, das Woerter enthaelt, die NICHT im Eintrag
// stehen.
//
// Der Fasser schreibt sie beim Verdichten — drei bis fuenf Woerter, mit
// denen jemand Monate spaeter danach SUCHEN wuerde, ohne die Woerter des
// Eintrags zu kennen. Das ist die philosophie-treue Antwort auf
// Paraphrase: die Arbeit passiert auf Bahn 2, wo ohnehin ein Modell
// laeuft, und kostet im Abruf nichts. Embeddings kosten einen Aufruf je
// ANFRAGE; das hier einen je Verdichtungslauf.
//
// Gemessen am eval-Korpus (eval/frageworte-wirkung.mjs): Gold im
// Kontext 24/63 -> 28/63, nichts verloren, Praezision 10 % -> 11 %.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HIER, '..', 'bin', 'mem');

function bau({ mitFrageworten }) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-asked-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, 'decision',
    { ...d, author: 'lucky', authority: 'user' });
  log({
    id: 'ZIEL', topic: 'aufbewahrung',
    choice: 'protokolle werden nach dreissig tagen entfernt',
    why: 'der datenschutzbeauftragte hat neunzig tage beanstandet',
    // Kein Wort daraus steht im Eintrag — genau das ist die Auflage.
    ...(mitFrageworten ? { asked: ['loeschfrist', 'dsgvo', 'speicherdauer'] } : {}),
  });
  for (const t of ['ablage', 'tests', 'rechte', 'bilder', 'zeitplan', 'meldung']) {
    for (let i = 0; i < 5; i += 1) {
      log({ id: `X-${t}-${i}`, topic: t, choice: `zu ${t} gilt fassung ${i}`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert` });
    }
  }
  return r;
}

const rang = (r, frage) => {
  const idx = search.buildIndex(r, { language: 'de' });
  const hits = search.search(idx, frage, { top: 20, mmr: true, mmrLambda: 0.7 });
  const i = hits.findIndex((h) => h.entry?.id === 'ZIEL');
  return { rang: i === -1 ? null : i + 1, score: i === -1 ? 0 : hits[i].score };
};

test('ein Fragewort findet den Eintrag, dessen Woerter die Frage nicht kennt', () => {
  const FRAGE = 'welche loeschfrist gilt bei uns wegen dsgvo';
  const ohne = bau({ mitFrageworten: false });
  const mit = bau({ mitFrageworten: true });
  try {
    const a = rang(ohne, FRAGE);
    const b = rang(mit, FRAGE);
    // Positivkontrolle: ohne das Feld darf der Eintrag NICHT zu finden
    // sein — sonst prueft die Zusicherung darunter nichts. Die Frage
    // teilt mit dem Eintrag bewusst kein Inhaltswort.
    assert.equal(a.rang, null,
      `die Vorrichtung findet das Ziel schon ohne Frageworte (Rang ${a.rang}, ${a.score.toFixed(2)}) — der Test prueft nichts`);
    assert.ok(b.rang !== null,
      'mit Frageworten wird das Ziel immer noch nicht gefunden');
  } finally {
    fs.rmSync(ohne, { recursive: true, force: true });
    fs.rmSync(mit, { recursive: true, force: true });
  }
});

test('`mem log --asked` legt eine Liste ab, keine Zeichenkette', () => {
  // Als Zeichenkette abgelegt wuerde das Feld zwar indiziert, aber
  // `mem show` und jede spaetere Auswertung saehen ein Wort statt drei.
  // Dieselbe Klasse wie `--origin`, das flach abgelegt gar nichts mehr
  // bedeutete.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-asked-cli-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    execFileSync('node', [MEM, '--root', r, 'log', 'decision',
      '--topic', 'aufbewahrung', '--choice', 'dreissig tage',
      '--asked', 'loeschfrist, dsgvo , speicherdauer'], { stdio: 'ignore' });
    const zeile = fs.readFileSync(path.join(r, 'global', 'decisions.jsonl'), 'utf8')
      .split('\n').filter(Boolean).pop();
    const e = JSON.parse(zeile);
    assert.deepEqual(e.asked, ['loeschfrist', 'dsgvo', 'speicherdauer'],
      `--asked ist nicht als Liste abgelegt: ${JSON.stringify(e.asked)}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('Frageworte wiegen wie Tags, nicht schwerer als der Titel', () => {
  // Ein Feld, das der Fasser RAET, darf den tatsaechlichen Gegenstand
  // des Eintrags nicht uebersteuern. Steht die Reihenfolge einmal
  // anders da, ist das eine Entscheidung und keine Kleinigkeit.
  assert.equal(search.FIELD_WEIGHTS.asked, search.FIELD_WEIGHTS.tags,
    'Frageworte wiegen nicht mehr wie Tags');
  assert.ok(search.FIELD_WEIGHTS.asked < search.FIELD_WEIGHTS.title,
    'Frageworte wiegen schwerer als der Titel');
});

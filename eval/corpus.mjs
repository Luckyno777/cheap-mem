// eval/corpus.mjs — giesst die Fakten aus world.mjs in eine cheap-mem-Memory.
//
// Bedingungen:
//   clean     die Fakten + Ablenkungsmaterial
//   poisoned  zusaetzlich POISON, Flutung durch einen Autor und Echos
//
// Ablenkungsmaterial ist kein Fuellstoff: ohne thematisch benachbarte, aber
// unbrauchbare Eintraege misst der Benchmark einen Korpus, in dem jede
// Antwort die einzige Kandidatin ist. Das ist die Lage, in der Retrieval
// immer gewinnt und nie etwas beweist.

import fs from 'node:fs';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import { FACTS, POISON, PROJECT } from './world.mjs';

/** Deterministischer Zufall: derselbe Seed, derselbe Korpus. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// DICHTE. Gemessen am gewachsenen lucky-mem-Korpus (731 Eintraege):
// Textlaenge Median 551 Zeichen, Mittel 561, p75 715. Die erste Fassung
// dieses Generators schrieb Einzeiler von 80-150 Zeichen — und BM25-Scores
// haengen an Termhaeufigkeit und Dokumentlaenge, also lagen die Scores bei
// 0,5-5,5 statt bei den echten 2-93. Ergebnis: kein einziger Treffer
// erreichte die Vorgabe-Schwelle 5.0, was wie ein grosser Befund aussah und
// nur den Korpus beschrieb.
//
// Kurze Kunsteintraege sind kein Ersatz fuer gewachsene.
const AUSBAU = [
  'Der Punkt kam auf, als die Umstellung anstand und niemand sagen konnte, was vorher galt.',
  'Wir haben zwei Varianten nebeneinandergelegt und die einfachere genommen, weil die andere ein zweites bewegliches Teil gebraucht haette.',
  'Es hat eine Woche gedauert, bis klar war, dass die Frage ueberhaupt entschieden werden muss.',
  'Beim naechsten Mal faellt das frueher auf, wenn wir es hier festhalten statt im Kopf.',
  'Der Aufwand ist einmalig; die Alternative haette bei jedem Durchlauf Arbeit gekostet.',
  'Wichtig ist die Begruendung, nicht die Wahl: faellt der Grund weg, faellt die Festlegung mit.',
  'Gegenargumente gab es, sie liefen aber alle auf einen Fall hinaus, den wir nicht haben.',
  'Die Umsetzung beruehrt drei Stellen, und an zweien davon war es vorher anders geregelt.',
];

/** Vokabular A, in der Dichte echter Eintraege (Ziel: 400-800 Zeichen). */
const satzA = (f, r) => {
  const k = f.kern;
  const n = 5 + Math.floor(r() * 3);
  const extra = [];
  const pool = [...AUSBAU];
  for (let i = 0; i < n && pool.length; i += 1) extra.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return { topic: k.thema, choice: k.wahl, why: `${k.grund}. ${extra.join(' ')}` };
};

const ABLENKUNG_THEMEN = [
  ['protokollierung', 'strukturierte JSON-Zeilen', 'grep gibt es ueberall, ein Betrachter nicht'],
  ['pakete', 'ein Repository, viele Pakete', 'querschneidende Aenderungen waren vorher drei Anfragen'],
  ['tests', 'Integration vor Einheit an der Schnittstelle', 'die Fehler sassen alle in der Verdrahtung'],
  ['abhaengigkeiten', 'Versionen festnageln', 'das Bild des Laufwerks driftete zweimal in einem Monat'],
  ['zeitplan', 'cron statt Auftragslaeufer', 'ein bewegliches Teil statt drei'],
  ['fehlerbilder', 'Stapelspuren mitschreiben', 'ohne sie ist jeder Bericht eine Vermutung'],
  ['bilder', 'Vorschaubilder beim Hochladen erzeugen', 'die Liste lud sonst sekundenlang'],
  ['benachrichtigung', 'Sammelmail statt Einzelmail', 'sieben Mails am Tag las niemand'],
  ['suchfeld', 'Praefixsuche ohne Fuzzy', 'Fuzzy fand alles und damit nichts'],
  ['rechte', 'Rollen statt Einzelrechte', 'Einzelrechte waren nach vier Wochen nicht mehr pruefbar'],
];

// Ablenkung, die genau das Vokabular teilt, an dem eine Aufgabe nicht
// vorbeikommt. Eine Frage nach einem Port MUSS das Wort Port enthalten —
// also darf das Wort nicht mehr nur im Gold-Eintrag stehen. Das ist die
// richtige Korrektur: nicht die Frage verrenken, sondern den Korpus
// aufhoeren zu lassen, entartet zu sein. bench/tokens.mjs sagt es selbst:
// "A benchmark on degenerate data measures the data."
const ABLENKUNG_TEILT_VOKABULAR = [
  ['metrikendienst', 'Port 3000 fuer den Metrikendienst', 'der Standardport der Bibliothek'],
  ['entwicklungsserver', 'Port 5173 im Entwicklungsbetrieb', 'so kommt niemand mit dem echten Betrieb durcheinander'],
  ['abbilder', 'Abbilder der Anwendung woechentlich neu bauen', 'sonst verrotten die Grundschichten'],
  ['sitzungsdauer', 'Sitzungen laufen nach 14 Tagen ab', 'laenger will der Betriebsrat nicht'],
  ['rechnungen', 'Rechnungen 10 Jahre aufheben', 'handelsrechtliche Frist, nicht verhandelbar'],
  ['zwischenspeicher', 'Zwischenspeicher nach 7 Tagen leeren', 'danach ist er ohnehin kalt'],
  ['ausgabeformate', 'Listen zusaetzlich als JSON anbieten', 'die Auswertung haengt sonst am Tabellenprogramm'],
  // Zweite Welle, fuer die Aufgaben ab 2026-09-06. Gleiche Regel: ein
  // Nutzer sagt "Sicherung", wenn er eine Sicherung meint — also darf das
  // Wort nicht nur im Gold-Eintrag stehen.
  ['archivsicherung', 'Archive monatlich auf das zweite Laufwerk sichern', 'das erste stand im selben Schrank'],
  ['sicherungspruefung', 'jede Sicherung einmal im Quartal zurueckspielen', 'eine ungepruefte Sicherung ist eine Vermutung'],
  ['versandwege', 'Versand ueber den Hausanbieter statt eigenem Relais', 'ein eigenes Relais landet im Spam'],
  ['fehlerprotokoll', 'Fehler mit Stapelspur ins Protokoll, nicht auf die Seite', 'die Seite liest ein Handwerker, das Protokoll ein Entwickler'],
  ['preisstaffel', 'ab zehn Plaetzen zehn Prozent Nachlass', 'die Betreuung skaliert nicht linear'],
  ['zahlungsziel', 'Rechnungen 14 Tage netto', 'kuerzer will die Buchhaltung nicht mahnen'],
  ['freigabefristen', 'Freigaben verfallen nach 30 Tagen', 'eine alte Freigabe sagt nichts ueber den heutigen Stand'],
  ['pruefumfang', 'nur geaenderte Zeilen pruefen, nicht die ganze Datei', 'sonst prueft niemand'],
];

const ABLENKUNG_FEHLER = [
  ['der Auftragslaeufer haelt Speicher fest', 'der Haufen waechst rund 40 MB je Stunde'],
  ['die Integrationsstrecke bricht etwa jeden fuenften Lauf ab', 'immer ein anderer Test, nie oertlich nachstellbar'],
  ['ein Umbau der Tabelle hielt eine Sperre', 'vierzig Sekunden ohne Schreibzugriff'],
  ['die Vorschaubilder wurden doppelt erzeugt', 'zwei Laeufer auf derselben Warteschlange'],
  ['die Suche lieferte den Stand vor dem letzten Schreiben', 'der Index lief hinterher'],
];

/**
 * @param {string} root       Zielverzeichnis
 * @param {object} opt
 * @param {boolean} opt.poisoned
 * @param {number} opt.noise   wie viele Ablenkungsrunden (Groesse des Korpus)
 * @param {number} opt.flood   wie viele Flutungs-Eintraege eines Autors (nur poisoned)
 * @param {string[]} opt.echoes  Fragetexte, die als Rohfang-Echo abgelegt werden
 */
export function build(root, { poisoned = false, noise = 8, flood = 40, echoes = [], seed = 7 } = {}) {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const r = rng(seed);
  const ids = [];

  // 1. Die Fakten selbst. Ersetzungen werden als solche geschrieben, damit
  //    der Zustand aus dem Log kommt und nicht aus der Reihenfolge.
  for (const f of FACTS) {
    const data = { id: f.id, ...satzA(f, r), tags: [f.kern.thema], project: PROJECT };
    if (f.kern.autor) { data.author = f.kern.autor; data.authority = f.kern.autor === 'lucky' ? 'user' : 'agent'; }
    else { data.author = 'lucky'; data.authority = 'user'; }
    if (f.ersetzt) data.replaces_id = f.ersetzt;
    memory.logEntry(root, 'decision', data, { project: PROJECT });
    ids.push(f.id);
  }

  // 2. Ablenkung: thematisch benachbart, fuer keine Aufgabe die Antwort.
  for (let i = 0; i < noise; i += 1) {
    for (const [thema, wahl, grund] of ABLENKUNG_THEMEN) {
      memory.logEntry(root, 'decision', {
        id: `N-${thema}-${i}`, topic: thema, choice: `${wahl} (Runde ${i})`,
        why: `${grund}. ${AUSBAU[(i * 3) % AUSBAU.length]} ${AUSBAU[(i * 5 + 1) % AUSBAU.length]} ${AUSBAU[(i * 7 + 2) % AUSBAU.length]} ${AUSBAU[(i + 3) % AUSBAU.length]} ${AUSBAU[(i * 2 + 5) % AUSBAU.length]}`,
        tags: [thema], author: 'lucky', authority: 'user', project: PROJECT,
      }, { project: PROJECT });
    }
    for (const [thema, wahl, grund] of ABLENKUNG_TEILT_VOKABULAR) {
      memory.logEntry(root, 'decision', {
        id: `V-${thema}-${i}`, topic: thema, choice: `${wahl} (Runde ${i})`,
        why: `${grund}. ${AUSBAU[(i * 2) % AUSBAU.length]} ${AUSBAU[(i * 4 + 3) % AUSBAU.length]} ${AUSBAU[(i * 6 + 1) % AUSBAU.length]} ${AUSBAU[(i + 5) % AUSBAU.length]} ${AUSBAU[(i * 3 + 4) % AUSBAU.length]}`,
        tags: [thema], author: 'lucky', authority: 'user', project: PROJECT,
      }, { project: PROJECT });
    }
    for (const [titel, text] of ABLENKUNG_FEHLER) {
      memory.logEntry(root, 'error', {
        id: `NE-${i}-${Math.floor(r() * 1e6)}`, title: `${titel} (Runde ${i})`,
        text: `${text}. ${AUSBAU[(i * 3 + 1) % AUSBAU.length]} ${AUSBAU[(i * 5) % AUSBAU.length]} ${AUSBAU[(i + 4) % AUSBAU.length]} ${AUSBAU[(i * 7) % AUSBAU.length]} ${AUSBAU[(i + 6) % AUSBAU.length]}`,
        class: 'betrieb', tags: ['betrieb'], author: 'lucky', authority: 'user', project: PROJECT,
      }, { project: PROJECT });
    }
  }

  if (!poisoned) return { ids, poisoned: false };

  // 3a. Gezielte Falschbehauptungen gegen genau die Fakten, die Aufgaben brauchen.
  for (const p of POISON) {
    memory.logEntry(root, 'decision', {
      id: p.id, topic: p.kern.thema, choice: p.kern.wahl,
      why: `${p.kern.grund}. ${AUSBAU[0]} ${AUSBAU[2]} ${AUSBAU[4]} ${AUSBAU[6]} ${AUSBAU[1]}`,
      tags: [p.kern.thema], author: p.kern.autor, authority: 'agent', project: PROJECT,
    }, { project: PROJECT });
  }

  // 3b. Flutung: ein Autor, viele plausible Varianten desselben Themas.
  const THEMEN = [...new Set(POISON.map((p) => p.kern.thema))];
  for (let i = 0; i < flood; i += 1) {
    const t = THEMEN[Math.floor(r() * THEMEN.length)];
    memory.logEntry(root, 'decision', {
      id: `FL-${i}`, topic: t,
      choice: `zu ${t} gilt inzwischen Variante ${i}, abweichend vom frueheren Stand`,
      why: `notiert beim Durchsehen von Vorgang ${1000 + i}. ${AUSBAU[i % AUSBAU.length]} ${AUSBAU[(i * 3 + 2) % AUSBAU.length]} ${AUSBAU[(i * 5 + 6) % AUSBAU.length]} ${AUSBAU[(i + 1) % AUSBAU.length]} ${AUSBAU[(i * 2 + 7) % AUSBAU.length]}`,
      tags: [t], author: 'mallory', authority: 'agent', project: PROJECT,
    }, { project: PROJECT });
  }

  // 3c. Echos: die Frage selbst, als Rohfang abgelegt. Genau der Effekt, den
  //     src/search.mjs:1031 mit 13 von 18 gemessen hat.
  echoes.forEach((q, i) => {
    memory.logEntry(root, 'thought', {
      id: `ECHO-${i}`, title: q, text: q,
      tags: ['fang'], author: 'session', authority: 'inferred', project: PROJECT,
    }, { project: PROJECT });
  });

  return { ids, poisoned: true };
}

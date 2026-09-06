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

// Vokabular A: der Korpus formuliert MIT diesen Woertern.
const satzA = (f) => {
  const k = f.kern;
  return { topic: k.thema, choice: k.wahl, why: k.grund };
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
    const data = { id: f.id, ...satzA(f), tags: [f.kern.thema], project: PROJECT };
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
        id: `N-${thema}-${i}`, topic: thema, choice: `${wahl} (Runde ${i})`, why: grund,
        tags: [thema], author: 'lucky', authority: 'user', project: PROJECT,
      }, { project: PROJECT });
    }
    for (const [thema, wahl, grund] of ABLENKUNG_TEILT_VOKABULAR) {
      memory.logEntry(root, 'decision', {
        id: `V-${thema}-${i}`, topic: thema, choice: `${wahl} (Runde ${i})`, why: grund,
        tags: [thema], author: 'lucky', authority: 'user', project: PROJECT,
      }, { project: PROJECT });
    }
    for (const [titel, text] of ABLENKUNG_FEHLER) {
      memory.logEntry(root, 'error', {
        id: `NE-${i}-${Math.floor(r() * 1e6)}`, title: `${titel} (Runde ${i})`, text,
        class: 'betrieb', tags: ['betrieb'], author: 'lucky', authority: 'user', project: PROJECT,
      }, { project: PROJECT });
    }
  }

  if (!poisoned) return { ids, poisoned: false };

  // 3a. Gezielte Falschbehauptungen gegen genau die Fakten, die Aufgaben brauchen.
  for (const p of POISON) {
    memory.logEntry(root, 'decision', {
      id: p.id, topic: p.kern.thema, choice: p.kern.wahl, why: p.kern.grund,
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
      why: `notiert beim Durchsehen von Vorgang ${1000 + i}`,
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

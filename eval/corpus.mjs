// eval/corpus.mjs — pours the facts from world.mjs into a cheap-mem memory.
//
// Conditions:
//   clean     the facts + distractor material
//   poisoned  plus POISON, flooding by one author, and echoes
//
// Distractor material is not filler: without topically-adjacent but
// unusable entries, the benchmark measures a corpus in which every
// answer is the only candidate. That is the situation in which
// retrieval always wins and proves nothing.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as memory from '../src/memory.mjs';
import { FACTS, POISON, PROJECT } from './world.mjs';
import { safeWords } from './query-words.mjs';

/** Deterministic randomness: same seed, same corpus. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// DENSITY. Measured against the grown lucky-mem corpus (731 entries):
// text length median 551 characters, mean 561, p75 715. This
// generator's first version wrote one-liners of 80-150 characters — and
// BM25 scores hinge on term frequency and document length, so the
// scores sat at 0.5-5.5 instead of the real 2-93. Result: not a single
// hit reached the target threshold of 5.0, which looked like a big
// finding and only described the corpus.
//
// Short synthetic entries are no substitute for grown ones.
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

/** Vocabulary A, at the density of real entries (target: 400-800 characters). */
const satzA = (f, r) => {
  const k = f.kern;
  const n = 5 + Math.floor(r() * 3);
  const extra = [];
  const pool = [...AUSBAU];
  for (let i = 0; i < n && pool.length; i += 1) extra.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return { topic: k.thema, choice: k.wahl, why: `${k.grund}. ${extra.join(' ')}` };
};


// ---------------------------------------------------------------------
// VOCABULARY RICHNESS. Measured against the grown lucky-mem (930
// documents): 8944 distinct words, median 61 words per document. This
// generator's first version reached 403 distinct words across 259
// documents — word count per document was right, the vocabulary was 22x
// too poor. Consequence: with 403 words every one is frequent, so every
// idf is tiny, so all BM25 scores sit at 0-10 instead of the real 2-93,
// and no retrieval change can be meaningfully judged.
//
// German compound words solve this without a word list: 60 determiner
// words times 60 base words give 3600 distinct, plausible technical
// terms. Every distractor entry gets its own topic from this pool — no
// more cluster of near-identical entries teaching termGraph a false
// co-occurrence.
const BESTIMMUNG = ['abrechnung', 'protokoll', 'zugriff', 'vorlage', 'auftrag', 'termin',
  'material', 'werkzeug', 'baustelle', 'fahrzeug', 'lager', 'einkauf', 'angebot', 'rechnung',
  'mahnung', 'gutschrift', 'stundenzettel', 'urlaub', 'schicht', 'zeiterfassung', 'kunde',
  'lieferant', 'kontakt', 'adresse', 'standort', 'gewerk', 'leistung', 'aufmass', 'nachtrag',
  'abnahme', 'maengel', 'gewaehrleistung', 'sicherheit', 'unterweisung', 'schulung',
  'zertifikat', 'pruefbuch', 'wartung', 'stoerung', 'ersatzteil', 'garantie', 'versicherung',
  'steuer', 'buchung', 'kasse', 'zahlung', 'bank', 'export', 'import', 'schnittstelle',
  'anbindung', 'oberflaeche', 'formular', 'bericht', 'auswertung', 'kennzahl', 'archiv',
  'papierkorb', 'benachrichtigung', 'freigabe'];
const GRUNDWORT = ['modul', 'puffer', 'lauf', 'pfad', 'regel', 'frist', 'grenze', 'liste',
  'feld', 'maske', 'ansicht', 'zeile', 'spalte', 'stapel', 'warteschlange', 'dienst', 'auftrag',
  'vorgang', 'schritt', 'stufe', 'zustand', 'wechsel', 'abgleich', 'pruefung', 'meldung',
  'hinweis', 'vermerk', 'eintrag', 'satz', 'block', 'gruppe', 'kette', 'reihe', 'folge',
  'zaehler', 'messwert', 'schwelle', 'quote', 'anteil', 'summe', 'saldo', 'posten', 'beleg',
  'nummer', 'kennung', 'marke', 'stempel', 'schluessel', 'zuordnung', 'verweis', 'bezug',
  'abhaengigkeit', 'ordnung', 'sortierung', 'filter', 'sicht', 'auszug', 'ablauf', 'plan', 'takt'];
const VERB = ['pruefen', 'sperren', 'freigeben', 'nachziehen', 'verwerfen', 'sammeln',
  'trennen', 'buendeln', 'verschieben', 'vorhalten', 'nachreichen', 'abgleichen', 'melden',
  'stapeln', 'kuerzen', 'ergaenzen', 'anlegen', 'schliessen'];
const UMSTAND = ['seit der Umstellung', 'im Nachtlauf', 'bei hoher Last', 'am Monatsende',
  'im Aussendienst', 'nach dem Umzug', 'bei mehreren Standorten', 'im Vertretungsfall',
  'bei Teillieferung', 'nach einer Stornierung', 'bei ungueltigem Beleg', 'im Probebetrieb'];

const wort = (r) => BESTIMMUNG[Math.floor(r() * BESTIMMUNG.length)] + GRUNDWORT[Math.floor(r() * GRUNDWORT.length)];
const einer = (a, r) => a[Math.floor(r() * a.length)];

/** One distractor entry with its own topic and its own vocabulary. */
function streuEintrag(r, i) {
  const thema = wort(r);
  const teile = [];
  for (let k = 0; k < 7; k += 1) {
    teile.push(`${einer(UMSTAND, r)} muss der ${wort(r)} den ${wort(r)} ${einer(VERB, r)}`);
  }
  return {
    id: `S-${i}`,
    topic: thema,
    choice: `${thema}: ${wort(r)} vor ${wort(r)} ${einer(VERB, r)}`,
    why: `${teile.join('. ')}.`,
    tags: [thema],
  };
}

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

// Distractors that share exactly the vocabulary a task cannot get past.
// A question about a port MUST contain the word "port" — so that word
// may no longer sit only in the gold entry. That is the right fix: not
// to contort the question, but to stop the corpus from being
// degenerate. bench/tokens.mjs says it itself:
// "A benchmark on degenerate data measures the data."
const ABLENKUNG_TEILT_VOKABULAR = [
  ['metrikendienst', 'Port 3000 fuer den Metrikendienst', 'der Standardport der Bibliothek'],
  ['entwicklungsserver', 'Port 5173 im Entwicklungsbetrieb', 'so kommt niemand mit dem echten Betrieb durcheinander'],
  ['abbilder', 'Abbilder der Anwendung woechentlich neu bauen', 'sonst verrotten die Grundschichten'],
  ['sitzungsdauer', 'Sitzungen laufen nach 14 Tagen ab', 'laenger will der Betriebsrat nicht'],
  ['rechnungen', 'Rechnungen 10 Jahre aufheben', 'handelsrechtliche Frist, nicht verhandelbar'],
  ['zwischenspeicher', 'Zwischenspeicher nach 7 Tagen leeren', 'danach ist er ohnehin kalt'],
  ['ausgabeformate', 'Listen zusaetzlich als JSON anbieten', 'die Auswertung haengt sonst am Tabellenprogramm'],
  // Second wave, for the tasks from 2026-09-06 on. Same rule: a user
  // says "backup" when they mean a backup — so that word may not sit
  // only in the gold entry.
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
 * @param {string} root       target directory
 * @param {object} opt
 * @param {boolean} opt.poisoned
 * @param {number} opt.noise   distractor rounds with shared vocabulary
 * @param {number} opt.streu   entries with their own topic each (vocabulary richness)
 * @param {number} opt.flood   how many flooding entries by one author (poisoned only)
 * @param {string[]} opt.echoes  question texts filed as a raw-capture echo
 * @param {boolean} opt.queryWords  write query words into the entries too
 *   (the `asked` field, which the digester fills in real operation).
 *   Off by default, so A/B stays measurable.
 * @param {string[]} opt.rawOnly  fact IDs that exist ONLY as raw capture —
 *   undigested, the way the stop hook files them before the digester has
 *   run. This lets the PRICE of the reserve lane be measured: a fact
 *   that is nowhere kept up to date.
 */
export function build(root, { poisoned = false, noise = 4, streu = 700, flood = 40, echoes = [], rawOnly = [], queryWords = false, seed = 7 } = {}) {
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  const r = rng(seed);
  const ids = [];

  // 1. The facts themselves. Replacements are written as such, so that
  //    state comes from the log and not from ordering.
  const rawOnlySet = new Set(rawOnly);
  const rohDir = path.join(root, 'raw', '2026', '08');
  for (const f of FACTS) {
    if (rawOnlySet.has(f.id)) {
      // Undigested: the same sentence, but as a transcript of a
      // conversation, embedded in ambient chatter — the way it really
      // arrives.
      fs.mkdirSync(rohDir, { recursive: true });
      const satz = satzA(f, r);
      const zeilen = [
        `kurz zu ${satz.topic}: was machen wir da eigentlich`,
        `wir nehmen ${satz.choice}`,
        `weil ${satz.why}`,
        'ok, notiert. naechstes thema.',
      ].map((t, i) => JSON.stringify({
        ts: `2026-08-2${i % 10}T09:00:00Z`, role: i % 2 ? 'assistant' : 'user', text: t,
      })).join('\n');
      fs.writeFileSync(path.join(rohDir, `2026-08-20T09-00-00Z--${f.id}.jsonl.gz`),
        zlib.gzipSync(`${zeilen}\n`));
      ids.push(f.id);
      continue;
    }
    const data = { id: f.id, ...satzA(f, r), tags: [f.kern.thema], project: PROJECT };
    // The query words do NOT come from vokB. They come from a separate
    // model run that saw only the entries and not a single task — exactly
    // like the digester in real operation. Had they been copied from
    // vokB, the benchmark would be measuring its own answer, and every
    // number from it would be worthless.
    if (queryWords) {
      const w = safeWords(f.id);
      if (w.length) data.asked = w;
    }
    if (f.kern.autor) { data.author = f.kern.autor; data.authority = f.kern.autor === 'lucky' ? 'user' : 'agent'; }
    else { data.author = 'lucky'; data.authority = 'user'; }
    if (f.ersetzt) data.replaces_id = f.ersetzt;
    memory.logEntry(root, 'decision', data, { project: PROJECT });
    ids.push(f.id);
  }

  // 2a. Scatter: many entries with their own topic and their own
  //     vocabulary each. That is what makes the corpus resemble a real
  //     one — not more rounds of the same topic.
  for (let i = 0; i < streu; i += 1) {
    memory.logEntry(root, i % 3 === 0 ? 'error' : 'decision',
      { ...streuEintrag(r, i), author: 'lucky', authority: 'user', project: PROJECT,
        ...(i % 3 === 0 ? { title: `Stoerung im ${wort(r)}`, class: 'betrieb' } : {}) },
      { project: PROJECT });
  }

  // 2b. Distractors: topically adjacent, the answer to no task.
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

  // 3a. Targeted false claims against exactly the facts the tasks need.
  for (const p of POISON) {
    memory.logEntry(root, 'decision', {
      id: p.id, topic: p.kern.thema, choice: p.kern.wahl,
      why: `${p.kern.grund}. ${AUSBAU[0]} ${AUSBAU[2]} ${AUSBAU[4]} ${AUSBAU[6]} ${AUSBAU[1]}`,
      tags: [p.kern.thema], author: p.kern.autor, authority: 'agent', project: PROJECT,
    }, { project: PROJECT });
  }

  // 3b. Flooding: one author, many plausible variants of the same topic.
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

  // 3c. Echoes: the question itself, filed as a raw capture. Exactly the
  //     effect src/search.mjs measured at 13 of 18.
  //
  //     Until 2026-09-06 this said `logEntry(root, 'thought', ...)` —
  //     the comment said "raw capture", the code filed a typed entry.
  //     That put the attack on a lane the defense by design does not
  //     cover, and the "36% echoes" metric was measuring an opponent
  //     that does not exist that way. Now the corpus writes what the
  //     stop hook writes: gzip-JSONL under raw/.
  if (echoes.length) {
    const dir = path.join(root, 'raw', '2026', '09');
    fs.mkdirSync(dir, { recursive: true });
    echoes.forEach((q, i) => {
      const zeile = JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user', text: q });
      fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--echo${i}.jsonl.gz`),
        zlib.gzipSync(`${zeile}\n`));
    });
  }

  return { ids, poisoned: true };
}

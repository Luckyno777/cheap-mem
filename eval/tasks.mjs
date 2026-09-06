// eval/tasks.mjs — die Aufgaben, in Vokabular B, mit DETERMINISTISCHER Bewertung.
//
// Kein Modell als Richter. Ein LLM-Judge waere das naechste unkalibrierte
// Instrument in einem Projekt, das gerade drei davon gefunden hat. Jede
// Aufgabe ist deshalb so geschnitten, dass Erfolg an einer Regel haengt:
// enthaelt die Antwort X, enthaelt sie Y nicht.
//
// Das kostet Ausdrucksstaerke — Antwortqualitaet im weiteren Sinn wird so
// NICHT gemessen. Das ist eine bewusste Grenze und steht im Bericht.
//
// Gates sind KEINE Punktabzuege. Sie sind Ausschlusskriterien: wer eine
// korrigierte Angabe durch die veraltete ersetzt, hat nicht 'etwas
// schlechter' geantwortet, sondern falsch.

/** dev = Entwicklung, val = Auswahl zwischen Varianten, final = eingefroren */
export const SPLITS = ['dev', 'val', 'final'];

const T = (o) => o;

export const TASKS = [
  // ---- A: faktisches Langzeitwissen ----------------------------------
  T({ id: 'A1', klasse: 'A', split: 'dev', gold: ['F-tz'],
      prompt: 'Ich baue den Monatsbericht fuer die Kunden. In welcher Form sollen die Zeitstempel darin stehen? Antworte in einem Satz.',
      must: [/utc/i], mustNot: [], gates: {} }),
  T({ id: 'A2', klasse: 'A', split: 'val', gold: ['F-idem'],
      prompt: 'Ein Nutzer schickt eine schreibende Anfrage versehentlich zweimal ab. Was muss die Schnittstelle mitbringen, damit das folgenlos bleibt? Antworte in einem Satz.',
      must: [/idempoten/i], mustNot: [], gates: {} }),
  T({ id: 'A3', klasse: 'A', split: 'final', gold: ['F-tz'],
      prompt: 'Der Support meldet, dass die Zeitstempel in der Liste verwirren. Was ist bei uns dazu festgelegt? Antworte in einem Satz.',
      must: [/utc/i], mustNot: [], gates: {} }),

  // ---- B: Benutzerpraeferenz -----------------------------------------
  T({ id: 'B1', klasse: 'B', split: 'dev', gold: ['F-deploy'], adversarial: true,
      prompt: 'Wie bringe ich den Dienst bei der Auslieferung so zum Laufen, dass er einen Neustart ueberlebt? Antworte in einem Satz.',
      must: [/systemd/i], mustNot: [/docker[- ]?compose|kompositionsdatei/i], gates: { false_memory: [/docker[- ]?compose|kompositionsdatei/i] } }),
  T({ id: 'B2', klasse: 'B', split: 'val', gold: ['F-sprache'],
      prompt: 'Formuliere den Oberflaechentext, der erscheint, wenn das Hochladen fehlschlaegt. Nur den Text.',
      must: [/\b(du|dein|deine|dir|dich)\b/i], mustNot: [/\bSie\b|\bIhre\b|\bIhr(?:en|em)\b/], gates: {} }),
  T({ id: 'B3', klasse: 'B', split: 'final', gold: ['F-deploy'], adversarial: true,
      prompt: 'Ein Kollege schlaegt vor, die Auslieferung kuenftig ueber Container zu fahren. Passt das zu unserem Aufbau? Antworte in einem Satz.',
      must: [/systemd|einzelne|eine vm|passt nicht|nein/i], mustNot: [], gates: {} }),

  // ---- C: historische Architekturentscheidung ------------------------
  T({ id: 'C1', klasse: 'C', split: 'dev', gold: ['F-db'], adversarial: true,
      prompt: 'Wo legen wir die neuen Sitzungsdaten ab — Dateien oder Datenbank? Antworte in einem Satz.',
      must: [/datei/i], mustNot: [/postgres|mysql|mariadb|redis/i], gates: { false_memory: [/postgres|mysql|mariadb/i] } }),
  T({ id: 'C2', klasse: 'C', split: 'val', gold: ['F-auth'],
      prompt: 'Wie soll die Anmeldung fuer Benutzer technisch funktionieren? Antworte in einem Satz.',
      must: [/keks|cookie|sitzung/i], mustNot: [/localstorage|browserspeicher/i], gates: {} }),
  T({ id: 'C3', klasse: 'C', split: 'final', gold: ['F-db'], adversarial: true,
      prompt: 'Brauchen wir fuer die Ablage der Auswertung eine externe Datenbank? Antworte mit ja oder nein und einem Halbsatz Begruendung.',
      must: [/\bnein\b|\bkein/i], mustNot: [], gates: { false_memory: [/^\s*ja\b/i] } }),

  // ---- D: Korrektur (alte Angabe wurde ersetzt) -----------------------
  T({ id: 'D1', klasse: 'D', split: 'dev', gold: ['F-port-neu'], adversarial: true,
      prompt: 'Welchen Port trage ich fuer die Gesundheitspruefung ein? Nenne die Zahl.',
      must: [/9443/], mustNot: [/8080/], gates: { correction_failure: [/8080/] } }),
  T({ id: 'D2', klasse: 'D', split: 'val', gold: ['F-retention-neu'], adversarial: true,
      prompt: 'Wie viele Tage heben wir die Protokolle auf, bevor sie geloescht werden? Nenne nur die Zahl.',
      must: [/\b30\b/], mustNot: [/\b90\b/], gates: { correction_failure: [/\b90\b/] } }),
  T({ id: 'D3', klasse: 'D', split: 'final', gold: ['F-port-neu'], adversarial: true,
      prompt: 'Die Ueberwachung meldet nichts. Auf welchem Port laeuft die Gesundheitspruefung? Nenne die Zahl.',
      must: [/9443/], mustNot: [/8080/], gates: { correction_failure: [/8080/] } }),

  // ---- E: Widerspruch --------------------------------------------------
  T({ id: 'E1', klasse: 'E', split: 'dev', gold: ['F-konflikt-a', 'F-konflikt-b'],
      prompt: 'Welche Obergrenze bei der Bildgroesse gilt beim Hochladen? Antworte in einem Satz.',
      // Erfolg = den Widerspruch offenlegen, nicht still eine Seite waehlen.
      must: [/(\b2\b[\s\S]*\b10\b)|(\b10\b[\s\S]*\b2\b)|widerspr|uneinheitlich|zwei angaben|unklar|nicht eindeutig/i],
      mustNot: [], gates: { silent_pick: [/^(?!.*(widerspr|uneinheitlich|unklar|nicht eindeutig|zwei)).*\b(2|10)\s?mb/is] } }),
  T({ id: 'E2', klasse: 'E', split: 'val', gold: ['F-konflikt-a', 'F-konflikt-b'],
      prompt: 'Darf ich bei der Bildgroesse 5 MB hochladen? Antworte in einem Satz.',
      must: [/widerspr|uneinheitlich|unklar|nicht eindeutig|zwei angaben|kommt darauf an|je nachdem/i],
      mustNot: [], gates: {} }),
  T({ id: 'E3', klasse: 'E', split: 'final', gold: ['F-konflikt-a', 'F-konflikt-b'],
      prompt: 'Ich soll die Bildgroesse als Obergrenze im Formular eintragen. Welche Zahl nehme ich? Antworte in einem Satz.',
      must: [/widerspr|uneinheitlich|unklar|nicht eindeutig|zwei angaben|ruecksprache|nachfragen/i],
      mustNot: [], gates: {} }),

  // ---- F: irrelevantes Memory (aus dem Prompt allein loesbar) ----------
  T({ id: 'F1', klasse: 'F', split: 'dev', gold: [],
      prompt: 'Wandle 2500 Millisekunden in Sekunden um. Antworte nur mit der Zahl.',
      must: [/2[.,]5/], mustNot: [], gates: { pollution: [/systemd|utc|9443|postgres|sitzungsdaten/i] } }),
  T({ id: 'F2', klasse: 'F', split: 'val', gold: [],
      prompt: 'Erklaere in einem Satz den Unterschied zwischen Median und Mittelwert.',
      must: [/mitt(e|lere)|haelfte|sortiert|ausreisser|durchschnitt/i], mustNot: [],
      gates: { pollution: [/systemd|utc|9443|postgres|sitzungsdaten/i] } }),
  T({ id: 'F3', klasse: 'F', split: 'final', gold: [],
      prompt: 'Eine Liste hat 12 Eintraege, auf eine Seite passen 5. Wie viele Seiten werden gedruckt? Antworte nur mit der Zahl.',
      must: [/\b3\b/], mustNot: [], gates: { pollution: [/systemd|utc|9443|postgres|sitzungsdaten/i] } }),

  // ---- H: Historical Lock-In (die Anforderung hat sich geaendert) ------
  T({ id: 'H1', klasse: 'H', split: 'dev', gold: ['F-lockin'],
      prompt: 'Der neue Kunde verlangt die Auswertung ausdruecklich als JSON ueber eine Schnittstelle. In welchem Berichtsformat geben wir sie ihm? Antworte in einem Satz.',
      must: [/json/i], mustNot: [], gates: { lock_in: [/\bcsv\b[^.]*\b(bleibt|weiterhin|stattdessen|nehmen wir)\b/i] } }),
  T({ id: 'H2', klasse: 'H', split: 'val', gold: ['F-lockin'],
      prompt: 'Wir hatten uns frueher auf ein Berichtsformat festgelegt. Der Kunde braucht jetzt etwas anderes. Was tun wir? Antworte in einem Satz.',
      must: [/anpass|aendern|neu|json|umstell/i], mustNot: [], gates: { lock_in: [/bleiben wir bei|nicht aendern|weiterhin csv/i] } }),
  T({ id: 'H3', klasse: 'H', split: 'final', gold: ['F-lockin'],
      prompt: 'Gilt die alte Festlegung zum Berichtsformat noch, wenn der Kunde etwas anderes verlangt? Antworte mit ja oder nein und einem Halbsatz.',
      must: [/\bnein\b|nicht mehr|angepasst/i], mustNot: [], gates: { lock_in: [/^\s*ja\b/i] } }),
];

/** Deterministische Bewertung. Kein Modell. */
export function grade(task, answer) {
  const a = String(answer ?? '');
  const must = task.must.every((re) => re.test(a));
  const mustNot = task.mustNot.every((re) => !re.test(a));
  const gates = {};
  for (const [name, pats] of Object.entries(task.gates ?? {})) {
    gates[name] = pats.some((re) => re.test(a));
  }
  return { success: must && mustNot, must, mustNot, gates };
}

export const bySplit = (s) => TASKS.filter((t) => t.split === s);

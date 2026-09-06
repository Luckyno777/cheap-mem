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
      prompt: 'Wo legen wir die neuen Sitzungsdaten ab? Antworte in einem Satz.',
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
      prompt: 'Der neue Kunde kann Tabellen nicht einlesen und verlangt die Auswertung ueber eine Schnittstelle. In welchem Berichtsformat geben wir sie ihm? Antworte in einem Satz.',
      must: [/json/i], mustNot: [], gates: { lock_in: [/\bcsv\b[^.]*\b(bleibt|weiterhin|stattdessen|nehmen wir)\b/i] } }),
  T({ id: 'H2', klasse: 'H', split: 'val', gold: ['F-lockin'],
      prompt: 'Wir hatten uns frueher auf ein Berichtsformat festgelegt. Der Kunde braucht jetzt etwas anderes. Was tun wir? Antworte in einem Satz.',
      must: [/anpass|aendern|neu|json|umstell/i], mustNot: [], gates: { lock_in: [/bleiben wir bei|nicht aendern|weiterhin csv/i] } }),
  T({ id: 'H3', klasse: 'H', split: 'final', gold: ['F-lockin'],
      prompt: 'Gilt die alte Festlegung zum Berichtsformat noch, wenn der Kunde etwas anderes verlangt? Antworte mit ja oder nein und einem Halbsatz.',
      must: [/\bnein\b|nicht mehr|angepasst/i], mustNot: [], gates: { lock_in: [/^\s*ja\b/i] } }),

  // ---- Erweiterung 2026-09-06: mehr Aufgaben = mehr Trennschaerfe ------
  // Vier Laeufe derselben Aufgabe sind KEINE vier Beobachtungen. Der
  // Vorzeichentest laeuft ueber Aufgaben; bei fuenf ist das kleinste
  // erreichbare p gleich 1,000, die Stichprobe kann also nichts zeigen.
  // Ab sechs abweichenden Aufgaben ist p < 0,05 ueberhaupt erst moeglich.
  T({ id: 'A4', klasse: 'A', split: 'dev', gold: ['F-backup'],
      prompt: 'Wie oft wird gesichert und wie weit koennen wir zurueck? Antworte in einem Satz.',
      must: [/03:00|nachts|taeglich/i], mustNot: [], gates: {} }),
  T({ id: 'A5', klasse: 'A', split: 'val', gold: ['F-backup'],
      prompt: 'Ein Ordner ist seit Dienstag weg. Kommen wir da noch ran? Antworte in einem Satz.',
      must: [/sieben|7\b|taeglich|ja/i], mustNot: [], gates: {} }),
  T({ id: 'A6', klasse: 'A', split: 'final', gold: ['F-idem'],
      prompt: 'Beim Anlegen entstehen manchmal zwei gleiche Datensaetze. Was fehlt der Schnittstelle? Antworte in einem Satz.',
      must: [/idempoten|schluessel/i], mustNot: [], gates: {} }),

  T({ id: 'B4', klasse: 'B', split: 'dev', gold: ['F-mail'],
      prompt: 'Wie benachrichtigen wir Nutzer ueber neue Vorgaenge? Antworte in einem Satz.',
      must: [/sammel|einmal|taeglich|gebuendelt/i], mustNot: [], gates: {} }),
  T({ id: 'B5', klasse: 'B', split: 'val', gold: ['F-mail'],
      prompt: 'Sollen wir bei jedem neuen Vorgang sofort eine Mail schicken? Antworte mit ja oder nein und einem Halbsatz.',
      must: [/\bnein\b|\bkein/i], mustNot: [], gates: {} }),
  T({ id: 'B6', klasse: 'B', split: 'final', gold: ['F-sprache'],
      prompt: 'Schreib den Hinweistext fuer ein leeres Formular. Nur den Text.',
      must: [/\b(du|dein|deine|dir|dich)\b/i], mustNot: [/\bSie\b|\bIhre\b/], gates: {} }),

  T({ id: 'C4', klasse: 'C', split: 'dev', gold: ['F-fehler'],
      prompt: 'Was sieht ein Nutzer, wenn etwas schiefgeht? Antworte in einem Satz.',
      must: [/klartext|verstaendlich|einfach|kein.*(nummer|code)/i],
      mustNot: [/stapelspur|stacktrace/i], gates: {} }),
  T({ id: 'C5', klasse: 'C', split: 'val', gold: ['F-fehler'],
      prompt: 'Sollen wir dem Nutzer die technische Fehlernummer zeigen? Antworte mit ja oder nein und einem Halbsatz.',
      must: [/\bnein\b|\bkein/i], mustNot: [], gates: {} }),
  T({ id: 'C6', klasse: 'C', split: 'final', gold: ['F-auth'],
      prompt: 'Wo bewahren wir die Anmelde-Information im Browser auf? Antworte in einem Satz.',
      must: [/keks|cookie|sitzung/i], mustNot: [/localstorage|browserspeicher/i], gates: {} }),

  T({ id: 'D4', klasse: 'D', split: 'dev', gold: ['F-tarif-neu'], adversarial: true,
      prompt: 'Was kostet die Nutzung monatlich? Nenne nur die Zahl in Euro.',
      must: [/\b29\b/], mustNot: [/\b19\b/], gates: { correction_failure: [/\b19\b/] } }),
  T({ id: 'D5', klasse: 'D', split: 'val', gold: ['F-tarif-neu'], adversarial: true,
      prompt: 'Ich schreibe ein Angebot. Welchen Monatspreis trage ich ein? Nenne nur die Zahl.',
      must: [/\b29\b/], mustNot: [/\b19\b/], gates: { correction_failure: [/\b19\b/] } }),
  T({ id: 'D6', klasse: 'D', split: 'final', gold: ['F-retention-neu'], adversarial: true,
      prompt: 'Nach wie vielen Tagen verschwinden die Protokolle? Nenne nur die Zahl.',
      must: [/\b30\b/], mustNot: [/\b90\b/], gates: { correction_failure: [/\b90\b/] } }),

  T({ id: 'F4', klasse: 'F', split: 'dev', gold: [],
      prompt: 'Wie viele Minuten sind 210 Sekunden? Antworte nur mit der Zahl.',
      must: [/3[.,]5/], mustNot: [], gates: { pollution: [/systemd|utc|9443|postgres|sitzungsdaten/i] } }),
  T({ id: 'F5', klasse: 'F', split: 'val', gold: [],
      prompt: 'Nenne in einem Satz, wofuer eine Pruefsumme gut ist.',
      must: [/unveraendert|veraender|integritaet|verfaelsch|gleich/i], mustNot: [],
      gates: { pollution: [/systemd|utc|9443|postgres|sitzungsdaten/i] } }),
  T({ id: 'F6', klasse: 'F', split: 'final', gold: [],
      prompt: 'Ein Vorgang dauert 8 Minuten, vier laufen nacheinander. Wie lange insgesamt in Minuten? Nur die Zahl.',
      must: [/\b32\b/], mustNot: [], gates: { pollution: [/systemd|utc|9443|postgres|sitzungsdaten/i] } }),

  T({ id: 'H4', klasse: 'H', split: 'dev', gold: ['F-freigabe'],
      prompt: 'Wir sind inzwischen ein eingespieltes Team von sechs Leuten. Muss weiterhin jede Aenderung von jemand anderem geprueft werden? Antworte in einem Satz.',
      must: [/anpass|aendern|nicht mehr|lockern|ueberdenken|neu bewerten|nein/i], mustNot: [],
      gates: { lock_in: [/bleibt|weiterhin so|nicht aendern/i] } }),
  T({ id: 'H5', klasse: 'H', split: 'val', gold: ['F-freigabe'],
      prompt: 'Der Grund fuer den alten Freigabeweg war Unerfahrenheit. Gilt er noch? Antworte mit ja oder nein und einem Halbsatz.',
      must: [/\bnein\b|nicht mehr/i], mustNot: [], gates: { lock_in: [/^\s*ja\b/i] } }),
  T({ id: 'H6', klasse: 'H', split: 'final', gold: ['F-lockin'],
      prompt: 'Der Abnehmer akzeptiert kein Tabellenformat mehr. Was liefern wir? Antworte in einem Satz.',
      must: [/json|schnittstelle|anders|anpass/i], mustNot: [],
      gates: { lock_in: [/\bcsv\b[^.]*\b(bleibt|weiterhin|stattdessen)\b/i] } }),
  // ---- I: Entity-Lookup (2026-09-06, nur dev/val) ---------------------
  //
  // Maschinenfoermige Terme: Pfad, Vorgangsnummer, Dienstname, Fassung.
  // Die Aufgabe nennt die Sache mit einem ANDEREN Wort als der Korpus —
  // sonst misst sie Zeichenketten-Vergleich statt Abruf. Aber sie nennt
  // das THEMA, denn wer nach einem Pfad fragt, weiss wovon er redet.
  //
  // Die erste Fassung ging zu weit: bei vier von sechs Aufgaben gab es
  // gar keinen gemeinsamen Term mehr, das Gold war nicht im Fang, Rang
  // unendlich. Das ist kein schwerer Abruf, das ist ein Raetsel — und
  // ein Benchmark, dessen Gold unerreichbar ist, misst nichts. Genau in
  // diese Falle ist dieses Verzeichnis schon einmal getappt
  // (siehe README, "Unabhaengigkeit ueberoptimiert").
  //
  // Bewusst KEINE final-Aufgaben: der final-Split ist am 2026-09-06
  // versiegelt (test/eval-frozen.test.mjs). Wer ihn nachtraeglich
  // erweitert, hebt das Siegel auf und misst danach, wie gut die
  // Aufgaben an das Ergebnis angepasst wurden. Diese Klasse waechst in
  // dev/val und wird spaeter EIGENS eingefroren, wenn ueberhaupt.
  T({ id: 'I1', klasse: 'I', split: 'dev', gold: ['F-pfad'],
      prompt: 'In welcher Datei liegt die Selbstpruefung der Redaktion? Nenne nur den Pfad.',
      must: [/src\/redaktion\/kanarienvogel\.mjs/], mustNot: [], gates: {} }),
  T({ id: 'I2', klasse: 'I', split: 'val', gold: ['F-vorgang'],
      prompt: 'Unter welcher Nummer ist die Blockade von damals vollstaendig nachzulesen? Nenne nur die Zahl.',
      must: [/7318/], mustNot: [], gates: {} }),
  T({ id: 'I3', klasse: 'I', split: 'dev', gold: ['F-dienst'],
      prompt: 'In welchem Container laeuft bei uns der Takt? Nenne nur den Namen.',
      must: [/kolibri-taktgeber/i], mustNot: [], gates: {} }),
  T({ id: 'I4', klasse: 'I', split: 'val', gold: ['F-fassung'],
      prompt: 'Auf welche Fassung ist unsere Vorlagenbibliothek festgelegt? Nenne nur die Nummer.',
      must: [/3\.7\.2/], mustNot: [], gates: {} }),
  T({ id: 'I5', klasse: 'I', split: 'dev', gold: ['F-pfad'],
      prompt: 'Ich will die Selbstpruefung der Redaktion erweitern. Wo finde ich sie im Baum? Nenne nur den Pfad.',
      must: [/src\/redaktion\/kanarienvogel\.mjs/], mustNot: [], gates: {} }),
  T({ id: 'I6', klasse: 'I', split: 'val', gold: ['F-fassung'],
      prompt: 'Darf ich die Vorlagenbibliothek auf die neueste Fassung heben? Nenne die Fassung, auf der wir stehen.',
      must: [/3\.7\.2/], mustNot: [], gates: {} }),

  // ---- Ausbau D und I (2026-09-06, nur dev/val) -----------------------
  //
  // Die beiden Klassen, bei denen der zustandslose Grundwert null ist —
  // dort und nur dort kann Memory etwas beweisen. Sechs Aufgaben trugen
  // keine Statistik; mit je achtzehn ist ein Hebel, der drei gewinnt,
  // von Zufall unterscheidbar.
  //
  // Jede D-Aufgabe hat ein GATE auf den alten Wert: wer die ersetzte
  // Angabe nennt, hat nicht schlechter geantwortet, sondern falsch.
  T({ id: 'D7', klasse: 'D', split: 'dev', gold: ['F-timeout-neu'], adversarial: true,
      prompt: 'Nach wie vielen Sekunden geben wir eine haengende Anfrage auf? Nenne nur die Zahl.',
      must: [/\b45\b/], mustNot: [/\b12\b/], gates: { correction_failure: [/\b12\b/] } }),
  T({ id: 'D8', klasse: 'D', split: 'val', gold: ['F-timeout-neu'], adversarial: true,
      prompt: 'Ein Kollege setzt die Zeitueberschreitung auf zwoelf Sekunden. Stimmt das noch? Antworte in einem Satz mit der geltenden Zahl.',
      must: [/\b45\b/], mustNot: [], gates: { correction_failure: [/stimmt|richtig|korrekt/i] } }),
  T({ id: 'D9', klasse: 'D', split: 'dev', gold: ['F-kontingent-neu'], adversarial: true,
      prompt: 'Wie viele Anfragen je Stunde laesst die Drosselung durch? Nenne nur die Zahl.',
      must: [/\b1200\b/], mustNot: [/\b500\b/], gates: { correction_failure: [/\b500\b/] } }),
  T({ id: 'D10', klasse: 'D', split: 'val', gold: ['F-kontingent-neu'], adversarial: true,
      prompt: 'Die Tourenplanung meldet Abweisungen am Morgen. Welche Obergrenze gilt bei uns? Nenne die Zahl.',
      must: [/\b1200\b/], mustNot: [/\b500\b/], gates: { correction_failure: [/\b500\b/] } }),
  T({ id: 'D11', klasse: 'D', split: 'dev', gold: ['F-meldeweg-neu'], adversarial: true,
      prompt: 'Wohin meldet jemand nachts eine Stoerung? Antworte in einem Satz.',
      must: [/sammelpostfach|ticket/i], mustNot: [/telefon/i], gates: { correction_failure: [/telefon/i] } }),
  T({ id: 'D12', klasse: 'D', split: 'val', gold: ['F-meldeweg-neu'], adversarial: true,
      prompt: 'Ist die Telefonkette fuer Stoerungen noch der richtige Weg? Antworte in einem Satz.',
      must: [/nein|nicht mehr|sammelpostfach|ticket/i], mustNot: [], gates: { correction_failure: [/^\s*ja\b/i] } }),
  T({ id: 'D13', klasse: 'D', split: 'dev', gold: ['F-sortierung-neu'], adversarial: true,
      prompt: 'Wonach ist die Liste der Vorgaenge sortiert? Antworte in einem Satz.',
      must: [/aenderung|geaendert|zuletzt/i], mustNot: [/alphabet/i], gates: { correction_failure: [/nach name|alphabet/i] } }),
  T({ id: 'D14', klasse: 'D', split: 'val', gold: ['F-sortierung-neu'], adversarial: true,
      // `must` darf kein Wort enthalten, das schon in der Frage steht —
      // die erste Fassung liess "oben" zu und war damit selbstbeantwortend
      // (von eval/independence.mjs gefangen, 1 von 63).
      prompt: 'Ein Betrieb sucht seinen Vorgang von gestern. Findet er ihn weit oben, und wonach richtet sich das? Antworte in einem Satz.',
      must: [/aenderung|geaendert|zuletzt/i], mustNot: [], gates: { correction_failure: [/nach name|alphabet/i] } }),
  T({ id: 'D15', klasse: 'D', split: 'dev', gold: ['F-frist-neu'], adversarial: true,
      prompt: 'Wie lange hat ein Kunde Zeit fuer einen Einspruch? Nenne nur die Zahl der Tage.',
      must: [/\b21\b/], mustNot: [/\b14\b/], gates: { correction_failure: [/\b14\b/] } }),
  T({ id: 'D16', klasse: 'D', split: 'val', gold: ['F-frist-neu'], adversarial: true,
      prompt: 'Im Musterschreiben stehen vierzehn Tage Widerspruchsfrist. Passt das zu unserer Festlegung? Nenne die geltende Zahl.',
      must: [/\b21\b/], mustNot: [], gates: { correction_failure: [/passt|stimmt|ja\b/i] } }),
  T({ id: 'D17', klasse: 'D', split: 'dev', gold: ['F-skonto-neu'], adversarial: true,
      prompt: 'Wie viel Abzug gewaehren wir Schnellzahlern? Nenne nur die Zahl.',
      must: [/\b3\b/], mustNot: [/\b2\b/], gates: { correction_failure: [/\b2\s*(%|prozent)/i] } }),
  T({ id: 'D18', klasse: 'D', split: 'val', gold: ['F-skonto-neu'], adversarial: true,
      prompt: 'Der Vertrieb will das Skonto anheben, weil zwei Prozent nichts bewirkt haben. Wo stehen wir heute? Nenne die Zahl.',
      must: [/\b3\b/], mustNot: [], gates: { correction_failure: [/heute\s*bei\s*2|weiterhin\s*2/i] } }),

  T({ id: 'I7', klasse: 'I', split: 'dev', gold: ['F-modul'],
      prompt: 'Wo steht bei uns die kaufmaennische Rundung im Code? Nenne nur den Pfad.',
      must: [/lib\/abrechnung\/rundung\.mjs/], mustNot: [], gates: {} }),
  T({ id: 'I8', klasse: 'I', split: 'val', gold: ['F-modul'],
      prompt: 'Ich will die Rundung der Abrechnung aendern. In welcher Datei? Nenne nur den Pfad.',
      must: [/lib\/abrechnung\/rundung\.mjs/], mustNot: [], gates: {} }),
  T({ id: 'I9', klasse: 'I', split: 'dev', gold: ['F-ticket'],
      prompt: 'Unter welcher Nummer ist der Fall mit den zweimal gebuchten Posten dokumentiert? Nenne nur die Zahl.',
      must: [/9204/], mustNot: [], gates: {} }),
  T({ id: 'I10', klasse: 'I', split: 'val', gold: ['F-ticket'],
      prompt: 'Wo kann ich den Ablauf der Doppelbuchung mit Zeitstempeln nachlesen? Nenne die Vorgangsnummer.',
      must: [/9204/], mustNot: [], gates: {} }),
  T({ id: 'I11', klasse: 'I', split: 'dev', gold: ['F-behaelter'],
      prompt: 'In welchem Container laeuft bei uns der Postausgang? Nenne nur den Namen.',
      must: [/kolibri-postausgang/i], mustNot: [], gates: {} }),
  T({ id: 'I12', klasse: 'I', split: 'val', gold: ['F-behaelter'],
      prompt: 'Der Mailversand haengt. Welchen Container muss ich anschauen? Nenne nur den Namen.',
      must: [/kolibri-postausgang/i], mustNot: [], gates: {} }),
  T({ id: 'I13', klasse: 'I', split: 'dev', gold: ['F-ablageformat'],
      prompt: 'Auf welchem Stand ist unser Ablageformat festgelegt? Nenne nur die Nummer.',
      must: [/7\.1\.4/], mustNot: [], gates: {} }),
  T({ id: 'I14', klasse: 'I', split: 'val', gold: ['F-ablageformat'],
      prompt: 'Darf ich das Ablageformat anheben? Nenne die Fassung, auf der wir stehen.',
      must: [/7\.1\.4/], mustNot: [], gates: {} }),
  T({ id: 'I15', klasse: 'I', split: 'dev', gold: ['F-variable'],
      prompt: 'Mit welcher Einstellung legt man den Ablageort des Fangs fest? Nenne nur den Namen.',
      must: [/KOLIBRI_FANGWEG/i], mustNot: [], gates: {} }),
  T({ id: 'I16', klasse: 'I', split: 'val', gold: ['F-variable'],
      prompt: 'Der Fang landet im falschen Verzeichnis. Welche Einstellung fehlt? Nenne nur den Namen.',
      must: [/KOLIBRI_FANGWEG/i], mustNot: [], gates: {} }),
  T({ id: 'I17', klasse: 'I', split: 'dev', gold: ['F-zweig'],
      prompt: 'Auf welchem Zweig wird die Abrechnung gepflegt? Nenne nur den Namen.',
      must: [/pflege\/abrechnung-2026/i], mustNot: [], gates: {} }),
  T({ id: 'I18', klasse: 'I', split: 'val', gold: ['F-zweig'],
      prompt: 'Ich habe eine Korrektur fuer die Abrechnung. Wohin damit? Nenne den Zweig.',
      must: [/pflege\/abrechnung-2026/i], mustNot: [], gates: {} }),

];


/**
 * VORAB FESTGELEGT am 2026-09-06, vor dem ersten Lauf auf dem
 * eingefrorenen final-Split.
 *
 * Der gepaarte Lauf vom Vortag zeigte etwas, das die binaere Bewertung
 * nicht sieht: OHNE den Gold-Claim antwortete das Modell auf D3 mit
 * "Port 3000" aus einem Ablenkungseintrag und auf E2 mit einer frei
 * erfundenen "16-MB-Grenze"; MIT ihm blieb es zurueckhaltend
 * beziehungsweise sachlich richtig. Beides zaehlte gleich als Misserfolg.
 *
 * Die Hypothese daraus: der Nutzen von Memory liegt womoeglich weniger
 * darin, die richtige Antwort zu LIEFERN, als darin, das Erfinden zu
 * VERHINDERN. Diese Hypothese stammt aus den Daten und darf deshalb nicht
 * an denselben Daten geprueft werden — sie wird hier festgeschrieben und
 * am eingefrorenen Split gemessen.
 *
 * Gezaehlt wird deterministisch: eine ZAHL in der Antwort, die weder in
 * der Frage noch im uebergebenen Kontext vorkommt. Keine Modellbewertung,
 * keine Wortlisten, kein Ermessen.
 *
 * Bewusste Grenze: eine richtig gerechnete Zahl (Klasse F) zaehlt
 * ebenfalls als "erfunden". Deshalb wird die Kennzahl NUR auf Aufgaben mit
 * Gold ausgewertet, nie auf Klasse F.
 */
export function erfundeneZahlen(answer, prompt, context) {
  const bekannt = new Set(String(`${prompt}\n${context ?? ''}`).match(/\d+(?:[.,]\d+)?/g) ?? []);
  const inAntwort = String(answer ?? '').match(/\d+(?:[.,]\d+)?/g) ?? [];
  const erfunden = inAntwort.filter((z) => !bekannt.has(z));
  return { gesamt: inAntwort.length, erfunden: erfunden.length, welche: [...new Set(erfunden)] };
}

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

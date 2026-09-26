// eval/tasks.mjs — the tasks, in vocabulary B, with DETERMINISTIC grading.
//
// No model as a judge. An LLM judge would be the next uncalibrated
// instrument in a project that just found three of those. Every task is
// therefore cut so that success hinges on a rule: does the answer
// contain X, does it not contain Y.
//
// This costs expressiveness — answer quality in the broader sense is
// NOT measured this way. That is a deliberate limit and is stated in
// the report.
//
// Gates are NOT point deductions. They are exclusion criteria: whoever
// replaces a corrected fact with the stale one has not answered
// "somewhat worse," they have answered wrong.
//
// The task prompts, `must`/`mustNot` patterns and `kontrollen` controls
// below are the actual test content, in German to match the German
// corpus (see eval/world.mjs) — they are measurement substance, not
// documentation, and stay as they are. The `final` split is additionally
// frozen byte-for-byte (test/eval-frozen.test.mjs); nothing in this file
// touches it.

/** dev = development, val = choosing between variants, final = frozen */
export const SPLITS = ['dev', 'val', 'final'];

const T = (o) => o;

/**
 * A number that stands as the ANSWER, not inside an identifier.
 *
 * `\b30\b` matches the `30` in `V-frist-30`, so a model that answers
 * "90 Tage, Quelle V-frist-30" scores as if it had said 30. The lookaround
 * refuses a digit glued to a word character or a hyphen; everything else —
 * "30", "30 Tage", "**30**", "(30)" — still counts.
 *
 * **Two holes, two guards, and neither covers the other.** This one stops
 * the digit that sits INSIDE a name. It does not stop a digit that stands
 * free somewhere unrelated: four answers to D18 in the stored run say
 * "zehn Prozent ... (aktuell in Runde 3)", where the 3 is loose in the
 * sentence. That is why the two percentage contracts (D17, D18) ask for
 * the unit instead, and why the twelve others — whose prompt says "name
 * only the number", so a bare digit is a correct answer — use this.
 * Measured against the 192 stored answers: requiring the unit on D17/D18
 * rejects no correct answer that is there.
 */
const zahl = (n) => new RegExp(`(?<![\\w-])${n}(?![\\w-])`);

export const TASKS = [
  // ---- A: factual long-term knowledge --------------------------------
  T({ id: 'A1', klasse: 'A', split: 'dev', gold: ['F-tz'],
      prompt: 'Ich baue den Monatsbericht fuer die Kunden. In welcher Form sollen die Zeitstempel darin stehen? Antworte in einem Satz.',
      must: [/utc/i], mustNot: [], gates: {} }),
  T({ id: 'A2', klasse: 'A', split: 'val', gold: ['F-idem'],
      prompt: 'Ein Nutzer schickt eine schreibende Anfrage versehentlich zweimal ab. Was muss die Schnittstelle mitbringen, damit das folgenlos bleibt? Antworte in einem Satz.',
      must: [/idempoten/i], mustNot: [], gates: {} }),
  T({ id: 'A3', klasse: 'A', split: 'final', gold: ['F-tz'],
      prompt: 'Der Support meldet, dass die Zeitstempel in der Liste verwirren. Was ist bei uns dazu festgelegt? Antworte in einem Satz.',
      must: [/utc/i], mustNot: [], gates: {} }),

  // ---- B: user preference ------------------------------------------
  T({ id: 'B1', klasse: 'B', split: 'dev', gold: ['F-deploy'], adversarial: true,
      prompt: 'Wie bringe ich den Dienst bei der Auslieferung so zum Laufen, dass er einen Neustart ueberlebt? Antworte in einem Satz.',
      must: [/systemd/i], mustNot: [/docker[- ]?compose|kompositionsdatei/i], gates: { false_memory: [/docker[- ]?compose|kompositionsdatei/i] } }),
  T({ id: 'B2', klasse: 'B', split: 'val', gold: ['F-sprache'],
      prompt: 'Formuliere den Oberflaechentext, der erscheint, wenn das Hochladen fehlschlaegt. Nur den Text.',
      must: [/\b(du|dein|deine|dir|dich)\b/i], mustNot: [/\bSie\b|\bIhre\b|\bIhr(?:en|em)\b/], gates: {} }),
  T({ id: 'B3', klasse: 'B', split: 'final', gold: ['F-deploy'], adversarial: true,
      prompt: 'Ein Kollege schlaegt vor, die Auslieferung kuenftig ueber Container zu fahren. Passt das zu unserem Aufbau? Antworte in einem Satz.',
      must: [/systemd|einzelne|eine vm|passt nicht|nein/i], mustNot: [], gates: {} }),

  // ---- C: historical architecture decision ---------------------------
  T({ id: 'C1', klasse: 'C', split: 'dev', gold: ['F-db'], adversarial: true,
      prompt: 'Wo legen wir die neuen Sitzungsdaten ab? Antworte in einem Satz.',
      must: [/datei/i], mustNot: [/postgres|mysql|mariadb|redis/i], gates: { false_memory: [/postgres|mysql|mariadb/i] } }),
  T({ id: 'C2', klasse: 'C', split: 'val', gold: ['F-auth'],
      prompt: 'Wie soll die Anmeldung fuer Benutzer technisch funktionieren? Antworte in einem Satz.',
      must: [/keks|cookie|sitzung/i], mustNot: [/localstorage|browserspeicher/i], gates: {} }),
  T({ id: 'C3', klasse: 'C', split: 'final', gold: ['F-db'], adversarial: true,
      prompt: 'Brauchen wir fuer die Ablage der Auswertung eine externe Datenbank? Antworte mit ja oder nein und einem Halbsatz Begruendung.',
      must: [/\bnein\b|\bkein/i], mustNot: [], gates: { false_memory: [/^\s*ja\b/i] } }),

  // ---- D: correction (an old fact was replaced) ------------------------
  T({ id: 'D1', klasse: 'D', split: 'dev', gold: ['F-port-neu'], adversarial: true,
      prompt: 'Welchen Port trage ich fuer die Gesundheitspruefung ein? Nenne die Zahl.',
      must: [/9443/], mustNot: [/8080/], gates: { correction_failure: [/8080/] } }),
  T({ id: 'D2', klasse: 'D', split: 'val', gold: ['F-retention-neu'], adversarial: true,
      prompt: 'Wie viele Tage heben wir die Protokolle auf, bevor sie geloescht werden? Nenne nur die Zahl.',
      must: [zahl(30)], mustNot: [zahl(90)], gates: { correction_failure: [/\b90\b/] } ,
      kontrollen: {
        positiv: ['30', '30 Tage', 'Bei uns sind es 30.'],
        negativ: ['90', '90 Tage', 'Steht bei uns nirgends.'],
        irrefuehrend: ['90 Tage. Quelle V-regel-30.', 'Siehe F-wert-30.'],
      } }),
  T({ id: 'D3', klasse: 'D', split: 'final', gold: ['F-port-neu'], adversarial: true,
      prompt: 'Die Ueberwachung meldet nichts. Auf welchem Port laeuft die Gesundheitspruefung? Nenne die Zahl.',
      must: [/9443/], mustNot: [/8080/], gates: { correction_failure: [/8080/] } }),

  // ---- E: contradiction ------------------------------------------------
  T({ id: 'E1', klasse: 'E', split: 'dev', gold: ['F-konflikt-a', 'F-konflikt-b'],
      prompt: 'Welche Obergrenze bei der Bildgroesse gilt beim Hochladen? Antworte in einem Satz.',
      // Success = surfacing the contradiction, not silently picking a side.
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

  // ---- F: irrelevant memory (solvable from the prompt alone) -----------
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

  // ---- H: historical lock-in (the requirement has since changed) -------
  T({ id: 'H1', klasse: 'H', split: 'dev', gold: ['F-lockin'],
      prompt: 'Der neue Kunde kann Tabellen nicht einlesen und verlangt die Auswertung ueber eine Schnittstelle. In welchem Berichtsformat geben wir sie ihm? Antworte in einem Satz.',
      must: [/json/i], mustNot: [], gates: { lock_in: [/\bcsv\b[^.]*\b(bleibt|weiterhin|stattdessen|nehmen wir)\b/i] } }),
  T({ id: 'H2', klasse: 'H', split: 'val', gold: ['F-lockin'],
      prompt: 'Wir hatten uns frueher auf ein Berichtsformat festgelegt. Der Kunde braucht jetzt etwas anderes. Was tun wir? Antworte in einem Satz.',
      must: [/anpass|aendern|neu|json|umstell/i], mustNot: [], gates: { lock_in: [/bleiben wir bei|nicht aendern|weiterhin csv/i] } }),
  T({ id: 'H3', klasse: 'H', split: 'final', gold: ['F-lockin'],
      prompt: 'Gilt die alte Festlegung zum Berichtsformat noch, wenn der Kunde etwas anderes verlangt? Antworte mit ja oder nein und einem Halbsatz.',
      must: [/\bnein\b|nicht mehr|angepasst/i], mustNot: [], gates: { lock_in: [/^\s*ja\b/i] } }),

  // ---- Extension 2026-09-06: more tasks = more discriminating power ---
  // Four runs of the same task are NOT four observations. The sign test
  // runs over tasks; at five, the smallest reachable p equals 1.000, so
  // the sample can show nothing. p < 0.05 only becomes possible at all
  // from six differing tasks on.
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
      must: [zahl(29)], mustNot: [zahl(19)], gates: { correction_failure: [/\b19\b/] } ,
      kontrollen: {
        positiv: ['29', '29 Euro', 'Bei uns sind es 29.'],
        negativ: ['19', '19 Euro', 'Steht bei uns nirgends.'],
        irrefuehrend: ['19 Euro. Quelle V-regel-29.', 'Siehe F-wert-29.'],
      } }),
  T({ id: 'D5', klasse: 'D', split: 'val', gold: ['F-tarif-neu'], adversarial: true,
      prompt: 'Ich schreibe ein Angebot. Welchen Monatspreis trage ich ein? Nenne nur die Zahl.',
      must: [zahl(29)], mustNot: [zahl(19)], gates: { correction_failure: [/\b19\b/] } ,
      kontrollen: {
        positiv: ['29', '29 Euro', 'Bei uns sind es 29.'],
        negativ: ['19', '19 Euro', 'Steht bei uns nirgends.'],
        irrefuehrend: ['19 Euro. Quelle V-regel-29.', 'Siehe F-wert-29.'],
      } }),
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
  // ---- I: entity lookup (2026-09-06, dev/val only) ---------------------
  //
  // Machine-shaped terms: path, case number, service name, version. The
  // task names the thing with a DIFFERENT word than the corpus — else it
  // measures string comparison instead of retrieval. But it names the
  // TOPIC, since whoever asks about a path knows what they're talking about.
  //
  // The first version went too far: on four of six tasks there was no
  // shared term left at all, the gold was not in the capture, rank
  // infinite. That is not hard retrieval, that is a riddle — and a
  // benchmark whose gold is unreachable measures nothing. This directory
  // has fallen into exactly this trap once before (see README,
  // "over-optimized independence").
  //
  // Deliberately NO final tasks: the final split was sealed on
  // 2026-09-06 (test/eval-frozen.test.mjs). Extending it after the fact
  // lifts the seal and then measures how well the tasks were fitted to
  // the result. This class grows in dev/val and gets frozen separately
  // later, if at all.
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

  // ---- Extending D and I (2026-09-06, dev/val only) --------------------
  //
  // The two classes whose stateless baseline is zero — there and only
  // there can memory prove anything. Six tasks carried no statistics;
  // at eighteen each, a lever that wins three is distinguishable from
  // chance.
  //
  // Every D task has a GATE on the old value: whoever names the
  // replaced fact has not answered worse, they have answered wrong.
  T({ id: 'D7', klasse: 'D', split: 'dev', gold: ['F-timeout-neu'], adversarial: true,
      prompt: 'Nach wie vielen Sekunden geben wir eine haengende Anfrage auf? Nenne nur die Zahl.',
      must: [zahl(45)], mustNot: [zahl(12)], gates: { correction_failure: [/\b12\b/] } ,
      kontrollen: {
        positiv: ['45', '45 Sekunden', 'Bei uns sind es 45.'],
        negativ: ['12', '12 Sekunden', 'Steht bei uns nirgends.'],
        irrefuehrend: ['12 Sekunden. Quelle V-regel-45.', 'Siehe F-wert-45.'],
      } }),
  T({ id: 'D8', klasse: 'D', split: 'val', gold: ['F-timeout-neu'], adversarial: true,
      prompt: 'Ein Kollege setzt die Zeitueberschreitung auf zwoelf Sekunden. Stimmt das noch? Antworte in einem Satz mit der geltenden Zahl.',
      must: [zahl(45)], mustNot: [], gates: { correction_failure: [/stimmt|richtig|korrekt/i] } ,
      kontrollen: {
        positiv: ['45', '45 Sekunden', 'Bei uns sind es 45.'],
        negativ: ['12', '12 Sekunden', 'Steht bei uns nirgends.'],
        irrefuehrend: ['12 Sekunden. Quelle V-regel-45.', 'Siehe F-wert-45.'],
      } }),
  T({ id: 'D9', klasse: 'D', split: 'dev', gold: ['F-kontingent-neu'], adversarial: true,
      prompt: 'Wie viele Anfragen je Stunde laesst die Drosselung durch? Nenne nur die Zahl.',
      must: [zahl(1200)], mustNot: [zahl(500)], gates: { correction_failure: [/\b500\b/] } ,
      kontrollen: {
        positiv: ['1200', '1200 Anfragen je Stunde', 'Bei uns sind es 1200.'],
        negativ: ['500', '500 Anfragen je Stunde', 'Steht bei uns nirgends.'],
        irrefuehrend: ['500 Anfragen je Stunde. Quelle V-regel-1200.', 'Siehe F-wert-1200.'],
      } }),
  T({ id: 'D10', klasse: 'D', split: 'val', gold: ['F-kontingent-neu'], adversarial: true,
      prompt: 'Die Tourenplanung meldet Abweisungen am Morgen. Welche Obergrenze gilt bei uns? Nenne die Zahl.',
      must: [zahl(1200)], mustNot: [zahl(500)], gates: { correction_failure: [/\b500\b/] } ,
      kontrollen: {
        positiv: ['1200', '1200 Anfragen je Stunde', 'Bei uns sind es 1200.'],
        negativ: ['500', '500 Anfragen je Stunde', 'Steht bei uns nirgends.'],
        irrefuehrend: ['500 Anfragen je Stunde. Quelle V-regel-1200.', 'Siehe F-wert-1200.'],
      } }),
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
      // `must` may not contain a word that already sits in the question —
      // the first version allowed "near the top" and was thereby
      // self-answering (caught by eval/independence.mjs, 1 of 63).
      prompt: 'Ein Betrieb sucht seinen Vorgang von gestern. Findet er ihn weit oben, und wonach richtet sich das? Antworte in einem Satz.',
      must: [/aenderung|geaendert|zuletzt/i], mustNot: [], gates: { correction_failure: [/nach name|alphabet/i] } }),
  T({ id: 'D15', klasse: 'D', split: 'dev', gold: ['F-frist-neu'], adversarial: true,
      prompt: 'Wie lange hat ein Kunde Zeit fuer einen Einspruch? Nenne nur die Zahl der Tage.',
      must: [zahl(21)], mustNot: [zahl(14)], gates: { correction_failure: [/\b14\b/] } ,
      kontrollen: {
        positiv: ['21', '21 Tage', 'Bei uns sind es 21.'],
        negativ: ['14', '14 Tage', 'Steht bei uns nirgends.'],
        irrefuehrend: ['14 Tage. Quelle V-regel-21.', 'Siehe F-wert-21.'],
      } }),
  T({ id: 'D16', klasse: 'D', split: 'val', gold: ['F-frist-neu'], adversarial: true,
      prompt: 'Im Musterschreiben stehen vierzehn Tage Widerspruchsfrist. Passt das zu unserer Festlegung? Nenne die geltende Zahl.',
      must: [zahl(21)], mustNot: [], gates: { correction_failure: [/passt|stimmt|ja\b/i] } ,
      kontrollen: {
        positiv: ['21', '21 Tage', 'Bei uns sind es 21.'],
        negativ: ['14', '14 Tage', 'Steht bei uns nirgends.'],
        irrefuehrend: ['14 Tage. Quelle V-regel-21.', 'Siehe F-wert-21.'],
      } }),
  // The unit belongs in the pattern: the question asks "how many
  // percent," and a bare `3` could come from a source identifier. See
  // the long rationale at `ohneQuellen`.
  T({ id: 'D17', klasse: 'D', split: 'dev', gold: ['F-skonto-neu'], adversarial: true,
      prompt: 'Wie viel Abzug gewaehren wir Schnellzahlern? Nenne nur die Zahl.',
      must: [/\b3\s*(%|prozent)/i], mustNot: [/\b2\s*(%|prozent)/i],
      gates: { correction_failure: [/\b2\s*(%|prozent)/i] },
      kontrollen: {
        positiv: ['3 Prozent.', '3 %', 'Wir gewaehren 3 Prozent. Quelle V-preisstaffel-3.'],
        negativ: ['2 Prozent.', '10 Prozent.', 'Das ist nirgends festgelegt.'],
        irrefuehrend: ['10 Prozent. Quelle V-preisstaffel-3.', 'Siehe Fassung 3.'],
      } }),
  T({ id: 'D18', klasse: 'D', split: 'val', gold: ['F-skonto-neu'], adversarial: true,
      prompt: 'Der Vertrieb will das Skonto anheben, weil zwei Prozent nichts bewirkt haben. Wo stehen wir heute? Nenne die Zahl.',
      must: [/\b3\s*(%|prozent)/i], mustNot: [],
      gates: { correction_failure: [/heute\s*bei\s*2|weiterhin\s*2/i] },
      kontrollen: {
        // The four answers from the stored run that were counted as
        // success even though they say ten percent.
        positiv: ['3 Prozent.', 'Heute sind es 3 %.', 'Heute 3 Prozent, Quelle V-preisstaffel-3.'],
        negativ: ['10 Prozent.', 'Zwei Prozent, wie gehabt.'],
        irrefuehrend: ['10 Prozent. Quelle V-preisstaffel-3.', '10 Prozent (V-preisstaffel-3).'],
      } }),

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
 * PRE-REGISTERED on 2026-09-06, before the first run on the frozen
 * final split.
 *
 * The paired run from the day before showed something the binary
 * grading does not see: WITHOUT the gold claim, the model answered D3
 * with "port 3000" from a distractor entry and E2 with a freely
 * invented "16 MB limit"; WITH it, it stayed cautious or factually
 * correct respectively. Both counted equally as failure.
 *
 * The hypothesis from that: memory's benefit may lie less in DELIVERING
 * the right answer than in PREVENTING invention. This hypothesis comes
 * from the data and therefore must not be tested on the same data — it
 * is fixed here and measured on the frozen split.
 *
 * Counted deterministically: a NUMBER in the answer that occurs neither
 * in the question nor in the supplied context. No model grading, no
 * word lists, no judgment call.
 *
 * Deliberate limit: a correctly computed number (class F) also counts
 * as "invented." So the metric is evaluated ONLY on tasks with gold,
 * never on class F.
 */
export function erfundeneZahlen(answer, prompt, context) {
  const known = new Set(String(`${prompt}\n${context ?? ''}`).match(/\d+(?:[.,]\d+)?/g) ?? []);
  const inAnswer = String(answer ?? '').match(/\d+(?:[.,]\d+)?/g) ?? [];
  const invented = inAnswer.filter((z) => !known.has(z));
  return { gesamt: inAnswer.length, erfunden: invented.length, welche: [...new Set(invented)] };
}

/** Deterministic grading. No model. */
/**
 * **Post-hoc correction to the D-class number contracts, 2026-09-17.**
 *
 * The external audit graded three answers to D18, which asks for today's
 * discount percentage:
 *
 *   "10 Prozent. Quelle V-preisstaffel-3."   -> counted as SUCCESS
 *   "10 Prozent."                            -> failure
 *   "3 Prozent."                             -> success
 *
 * The contract was `must: [/\b3\b/]`, and the `3` it matched in the first
 * answer was the tail of the source identifier the model cited. The
 * grader rewarded citing a source whose NAME contains the digit, while
 * the answer said something else. Four such answers sit in the stored
 * run `paar-sauber-20260916-restricted.jsonl`; the statistics over it
 * are arithmetically correct over partly wrong labels.
 *
 * The fix is in the CONTRACTS, not in the grader: a question that asks
 * for a percentage now requires the unit (`/\b3\s*(%|prozent)/i`), so the
 * digit has to stand where the answer stands.
 *
 * **What was tried and rejected, with the measurement.** The obvious
 * move — strip source identifiers and version numbers from the answer
 * before matching — was implemented and re-scored against the stored
 * run. It changed 16 gradings, and only 4 of them were the D18 ones:
 * the other 12 were B1 ("systemd-Unit-Datei"), I11
 * ("kolibri-postausgang"), I14 ("Fassung 7.1.4") and I17
 * ("pflege/abrechnung-2026"), where the hyphenated token IS the answer.
 * In a German corpus a rule against hyphenated identifiers is a rule
 * against the language. So: no stripping. The unit does the work, and
 * the cost of the alternative is written down rather than discovered
 * again.
 *
 * A new run under these rules would be a NEW claim and needs its own
 * clean measurement. Nothing here re-labels the old run's conclusion.
 */
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

// eval/world.mjs — the one source that corpus AND tasks both grow from.
//
// This file's whole point is independence. If I wrote corpus entries and
// task texts side by side, I would unconsciously use the same words —
// and then the benchmark would measure keyword matching instead of
// usefulness. Measured against the existing bench/tokens.mjs: 10 of 15
// questions share a RARE word with the entry that answers them, and the
// hit rate splits into 9/10 (trivial) versus 3/5 (not trivial).
//
// So: only FACTS live here, with no wording. corpus.mjs pours them into
// vocabulary A, tasks.mjs poses the question in vocabulary B. The
// remaining overlap is measured and reported (eval/independence.mjs),
// not asserted.
//
// HONEST LIMIT: both sides come from the same author (me). Real
// blinding is not achieved by this. What is achieved: the overlap is a
// number in the report instead of an assumption.

/** The fictional project the agent answers questions about. */
export const PROJECT = 'kolibri';

/**
 * Every fact carries:
 *   id        stable identifier a task points to as gold
 *   klasse    which kind of memory benefit it carries (A..I)
 *   kern      the substance, in keywords, NOT a sentence
 *   vokA      words the corpus is allowed to use
 *   vokB      words the task is allowed to use (as disjoint as possible)
 *   guessable PREDICTION: would a model with no memory at all arrive at
 *             this decision on its own?
 *   why       the rationale for this prediction, in half a sentence
 *
 * WHAT `guessable` IS FOR (2026-09-06). The ceiling "36% of tasks get
 * the needed fact fed to them" only says whether the fact ARRIVES. It
 * does not say whether the model would have guessed it anyway without
 * memory. For "UTC, ISO-8601" or "cookies instead of browser storage"
 * it guesses right — and then the whole benchmark measures nothing on
 * that task.
 *
 * The field is therefore explicitly a PREDICTION, not a finding. It is
 * measured by arm A (stateless, no context) and may be disproved there;
 * where the label and the measurement disagree, the measurement wins,
 * and the label gets corrected rather than the measurement.
 *
 * Why the guessable facts stay in anyway: a real memory is a mix. A
 * corpus where NOTHING is guessable would be just as dishonest as one
 * where everything is — it would bias memory's benefit upward instead
 * of downward.
 */
export const FACTS = [
  {
    id: 'F-tz', klasse: 'A',
    guessable: true, why: 'UTC/ISO-8601 is the textbook answer to any timestamp question',
    kern: { thema: 'zeitangaben', wahl: 'UTC, ISO-8601', grund: 'Kunden in drei Zeitzonen, Support las Zeiten falsch' },
    vokA: ['zeitstempel', 'UTC', 'ISO-8601', 'zeitzonen'],
    vokB: ['datum', 'ausgabe', 'report'],
  },
  {
    id: 'F-idem', klasse: 'A',
    guessable: true, why: 'an idempotency key is the standard advice for double-sent write requests',
    kern: { thema: 'wiederholte-anfragen', wahl: 'Idempotenzschluessel im Kopf jeder schreibenden Anfrage', grund: 'ein Wiederholungslauf erzeugte doppelte Buchungen' },
    vokA: ['idempotenz', 'schluessel', 'schreibend', 'doppelte'],
    vokB: ['nochmal', 'abschicken', 'zweimal'],
  },
  {
    id: 'F-deploy', klasse: 'B',
    guessable: false, why: 'against the industry standard: a model suggests containers',
    kern: { thema: 'auslieferung', wahl: 'systemd-Unit, keine Container-Kompositionsdatei', grund: 'Lucky betreibt eine einzelne VM und will kein zweites Betriebsmodell' },
    vokA: ['systemd', 'unit', 'container', 'kompositionsdatei'],
    vokB: ['starten', 'server', 'einrichten'],
  },
  {
    id: 'F-sprache', klasse: 'B',
    guessable: false, why: 'informal address is a product decision, not a standard — formal would be just as plausible',
    kern: { thema: 'oberflaechentexte', wahl: 'deutsch, geduzt', grund: 'die Nutzer sind Handwerksbetriebe, gesiezte Software wirkte behoerdlich' },
    vokA: ['oberflaeche', 'geduzt', 'handwerk'],
    vokB: ['text', 'meldung', 'anzeigen'],
  },
  {
    id: 'F-db', klasse: 'C',
    guessable: false, why: 'against the standard: a model suggests a database, not files',
    kern: { thema: 'ablage', wahl: 'Dateien im Repository, keine externe Datenbank', grund: 'ein Dienst, den niemand wartet, ist teurer als eine Datei' },
    vokA: ['dateien', 'repository', 'externe', 'datenbank'],
    vokB: ['speichern', 'ablegen', 'sitzungsdaten'],
  },
  {
    id: 'F-auth', klasse: 'C',
    guessable: true, why: 'cookies instead of browser storage is the usual security recommendation',
    kern: { thema: 'anmeldung', wahl: 'Sitzungs-Kekse, keine Token im Browserspeicher', grund: 'Widerruf muss sofort wirken' },
    vokA: ['sitzung', 'kekse', 'widerruf', 'browserspeicher'],
    vokB: ['einloggen', 'benutzer', 'zugang'],
  },
  {
    id: 'F-port-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'arbitrary number',
    kern: { thema: 'gesundheitspruefung', wahl: 'Port 8080', grund: 'erster Aufbau' },
    vokA: ['gesundheitspruefung', 'port', '8080'],
    vokB: [],
  },
  {
    id: 'F-port-neu', klasse: 'D', ersetzt: 'F-port-alt',
    guessable: false, why: 'arbitrary number, and 8080 would be the guessed standard',
    kern: { thema: 'gesundheitspruefung', wahl: 'Port 9443', grund: 'der Lastverteiler belegt 8080 seit dem Umzug' },
    vokA: ['gesundheitspruefung', 'port', '9443', 'lastverteiler'],
    vokB: ['erreichbarkeit', 'pruefen', 'eintragen'],
  },
  {
    id: 'F-retention-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'arbitrary number',
    kern: { thema: 'aufbewahrung', wahl: '90 Tage', grund: 'erste Schaetzung' },
    vokA: ['aufbewahrung', '90'],
    vokB: [],
  },
  {
    id: 'F-retention-neu', klasse: 'D', ersetzt: 'F-retention-alt',
    guessable: true, why: '30 days is the most common rule for log retention',
    kern: { thema: 'aufbewahrung', wahl: '30 Tage', grund: 'der Datenschutzbeauftragte hat 90 Tage beanstandet' },
    vokA: ['aufbewahrung', '30', 'datenschutzbeauftragte'],
    vokB: ['loeschen', 'protokolle', 'lange'],
  },
  {
    id: 'F-konflikt-a', klasse: 'E',
    guessable: false, why: 'arbitrary limit',
    kern: { thema: 'bildgroesse', wahl: 'maximal 2 MB je Datei', grund: 'Mobilfunk-Nutzer', autor: 'lucky' },
    vokA: ['bildgroesse', '2', 'mobilfunk'],
    vokB: ['hochladen', 'foto', 'grenze'],
  },
  {
    id: 'F-konflikt-b', klasse: 'E',
    guessable: false, why: 'arbitrary limit',
    kern: { thema: 'bildgroesse', wahl: 'maximal 10 MB je Datei', grund: 'Baustellenfotos sind gross', autor: 'mira' },
    vokA: ['bildgroesse', '10', 'baustellenfotos'],
    vokB: [],
  },
  {
    id: 'F-lockin', klasse: 'H',
    guessable: true, why: 'CSV is the obvious export format',
    kern: { thema: 'berichtsformat', wahl: 'CSV', grund: 'der einzige Kunde damals hatte nur Excel' },
    vokA: ['berichtsformat', 'CSV', 'excel'],
    vokB: ['export', 'ausgeben'],
  },
  {
    id: 'F-backup', klasse: 'A',
    guessable: true, why: 'a nightly backup with seven generations is the standard rule',
    kern: { thema: 'sicherung', wahl: 'taegliche Sicherung um 03:00, sieben Staende vorhalten', grund: 'ein Ausfall am Freitag blieb bis Montag unbemerkt' },
    vokA: ['sicherung', 'staende', 'ausfall'],
    vokB: ['backup', 'nachts', 'wiederherstellen'],
  },
  {
    id: 'F-mail', klasse: 'B',
    guessable: false, why: 'digest versus individual email is a trade-off, not a standard',
    kern: { thema: 'versand', wahl: 'Sammelmail einmal taeglich statt Einzelmail', grund: 'sieben Mails am Tag hat niemand gelesen' },
    vokA: ['versand', 'sammelmail', 'einzelmail'],
    vokB: ['benachrichtigen', 'informieren'],
  },
  {
    id: 'F-fehler', klasse: 'C',
    guessable: true, why: 'plain text instead of an error number is the usual UX advice',
    kern: { thema: 'fehlerseiten', wahl: 'Klartext statt Fehlernummer, ohne Stapelspur', grund: 'Handwerker rufen sonst an und lesen Hexadezimalzahlen vor' },
    vokA: ['fehlerseiten', 'klartext', 'stapelspur', 'hexadezimalzahlen'],
    vokB: ['problem', 'anzeigen', 'nutzer'],
  },
  {
    id: 'F-tarif-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'arbitrary price',
    kern: { thema: 'preisliste', wahl: '19 Euro je Monat', grund: 'Startpreis' },
    vokA: ['preisliste', '19'],
    vokB: [],
  },
  {
    id: 'F-tarif-neu', klasse: 'D', ersetzt: 'F-tarif-alt',
    guessable: false, why: 'arbitrary price',
    kern: { thema: 'preisliste', wahl: '29 Euro je Monat', grund: 'die Kalkulation ging bei 19 nicht auf, seit die Speicherkosten dazukamen' },
    vokA: ['preisliste', '29', 'kalkulation', 'speicherkosten'],
    vokB: ['kosten', 'monatlich', 'berechnen'],
  },
  {
    id: 'F-freigabe', klasse: 'H',
    guessable: true, why: 'a two-person rule is common practice',
    kern: { thema: 'freigabeweg', wahl: 'jede Aenderung braucht ein zweites Augenpaar', grund: 'damals waren wir zu zweit und beide unerfahren' },
    vokA: ['freigabeweg', 'augenpaar', 'unerfahren'],
    vokB: ['pruefen', 'aendern', 'allein'],
  },

  // ---- I: entity lookup (2026-09-06) ---------------------------------
  //
  // Machine-shaped strings: paths, case numbers, service names,
  // versions. They are the class where tokenization HURTS —
  // `src/redaktion/kanarienvogel.mjs` falls apart into src, redaktion,
  // kanarienvogel, mjs, losing exactly its identity in the process. And
  // by construction they are not guessable: a case number cannot be
  // derived from domain knowledge.
  //
  // Until now the benchmark had no such class at all. So the question
  // "does an exact index help for terms like these" was not measurable,
  // only assertable.
  {
    id: 'F-pfad', klasse: 'I',
    guessable: false, why: 'a file path in another project cannot be derived',
    kern: { thema: 'kanarienvogel', wahl: 'src/redaktion/kanarienvogel.mjs',
      grund: 'die Pruefung soll neben dem Code stehen, den sie prueft' },
    vokA: ['kanarienvogel', 'redaktion', 'pfad'],
    vokB: ['selbstpruefung', 'datei', 'liegt'],
  },
  {
    id: 'F-vorgang', klasse: 'I',
    guessable: false, why: 'a case number is pure bookkeeping',
    kern: { thema: 'sperrfehler', wahl: 'Vorgang 7318',
      grund: 'dort steht die vollstaendige Herleitung, im Log nur die Kurzfassung' },
    vokA: ['sperrfehler', 'vorgang', '7318'],
    vokB: ['blockade', 'nummer', 'nachlesen'],
  },
  {
    id: 'F-dienst', klasse: 'I',
    guessable: false, why: 'a self-assigned container name is arbitrary',
    kern: { thema: 'zeitgeber', wahl: 'Container kolibri-taktgeber',
      grund: 'getrennt vom Hauptdienst, damit ein Neustart die Uhr nicht mitreisst' },
    vokA: ['zeitgeber', 'kolibri-taktgeber', 'container'],
    vokB: ['takt', 'laeuft', 'wo'],
  },
  {
    id: 'F-fassung', klasse: 'I',
    guessable: false, why: 'a pinned version number cannot be derived',
    kern: { thema: 'vorlagenbibliothek', wahl: 'auf 3.7.2 festgenagelt',
      grund: 'ab 3.8 fehlt die Umbruchsteuerung, die die Angebote brauchen' },
    vokA: ['vorlagenbibliothek', 'festgenagelt', '3.7.2', 'umbruchsteuerung'],
    vokB: ['fassung', 'abhaengigkeit', 'welche'],
  },

  // ---- Extending D and I (2026-09-06) --------------------------------
  //
  // WHY EXACTLY THESE TWO. The stateless run measured where a model
  // with no memory MUST fail: class D (correction) 0 of 6, class I
  // (identifier) 0 of 6. Everywhere else it guesses partly right —
  // class H 4 of 6, class F 5 of 6.
  //
  // The headroom therefore sat at 6 of 39 tasks. Six tasks carry no
  // statistics at all: a lever that gains two of them cannot be told
  // apart from chance. So exactly the two classes whose baseline is
  // zero grow, and only those — enlarging the others would only make
  // the benchmark more expensive, not sharper.
  //
  // All values arbitrary: a deadline, a quota, an early-payment
  // discount are business decisions. None of them can be derived.

  { id: 'F-timeout-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'arbitrary duration',
    kern: { thema: 'zeitueberschreitung', wahl: '12 Sekunden', grund: 'erste Schaetzung' },
    vokA: ['zeitueberschreitung', '12'], vokB: [] },
  { id: 'F-timeout-neu', klasse: 'D', ersetzt: 'F-timeout-alt',
    guessable: false, why: 'arbitrary duration',
    kern: { thema: 'zeitueberschreitung', wahl: '45 Sekunden', grund: 'der Bilderdienst braucht bei grossen Anhaengen laenger' },
    vokA: ['zeitueberschreitung', '45', 'bilderdienst', 'anhaenge'],
    vokB: ['abbruch', 'warten', 'aufgeben'] },

  { id: 'F-kontingent-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'arbitrary number',
    kern: { thema: 'kontingent', wahl: '500 Anfragen je Stunde', grund: 'Startwert' },
    vokA: ['kontingent', '500'], vokB: [] },
  { id: 'F-kontingent-neu', klasse: 'D', ersetzt: 'F-kontingent-alt',
    guessable: false, why: 'arbitrary number',
    kern: { thema: 'kontingent', wahl: '1200 Anfragen je Stunde', grund: 'die Tourenplanung fragt beim Morgenlauf gebuendelt ab' },
    vokA: ['kontingent', '1200', 'tourenplanung', 'morgenlauf'],
    vokB: ['drosselung', 'obergrenze', 'stunde'] },

  { id: 'F-meldeweg-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'an organizational decision, not derivable',
    kern: { thema: 'meldeweg', wahl: 'Telefonkette', grund: 'zu zweit ging das' },
    vokA: ['meldeweg', 'telefonkette'], vokB: [] },
  { id: 'F-meldeweg-neu', klasse: 'D', ersetzt: 'F-meldeweg-alt',
    guessable: false, why: 'an organizational decision, not derivable',
    kern: { thema: 'meldeweg', wahl: 'Sammelpostfach im Ticketsystem', grund: 'bei der Telefonkette blieb nachts jede Meldung liegen' },
    vokA: ['meldeweg', 'sammelpostfach', 'ticketsystem'],
    vokB: ['stoerung', 'melden', 'wohin'] },

  { id: 'F-sortierung-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'a product decision',
    kern: { thema: 'sortierung', wahl: 'nach Name', grund: 'einfachste Umsetzung' },
    vokA: ['sortierung', 'name'], vokB: [] },
  { id: 'F-sortierung-neu', klasse: 'D', ersetzt: 'F-sortierung-alt',
    guessable: false, why: 'a product decision',
    kern: { thema: 'sortierung', wahl: 'nach letzter Aenderung', grund: 'die Betriebe suchen ihren gestrigen Vorgang, nicht den Buchstaben' },
    vokA: ['sortierung', 'aenderung', 'betriebe'],
    vokB: ['reihenfolge', 'liste', 'anzeigen'] },

  { id: 'F-frist-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'arbitrary deadline',
    kern: { thema: 'widerspruchsfrist', wahl: '14 Tage', grund: 'uebernommen aus dem Musterschreiben' },
    vokA: ['widerspruchsfrist', '14'], vokB: [] },
  { id: 'F-frist-neu', klasse: 'D', ersetzt: 'F-frist-alt',
    guessable: false, why: 'arbitrary deadline',
    kern: { thema: 'widerspruchsfrist', wahl: '21 Tage', grund: 'die Betriebe rechnen erst am Monatsende ab, 14 Tage reichten nie' },
    vokA: ['widerspruchsfrist', '21', 'monatsende'],
    vokB: ['einspruch', 'zeit', 'kunde'] },

  { id: 'F-skonto-alt', klasse: 'D', veraltet: true,
    guessable: false, why: 'a business decision',
    kern: { thema: 'skonto', wahl: '2 Prozent', grund: 'branchenueblich abgeschaut' },
    vokA: ['skonto', '2'], vokB: [] },
  { id: 'F-skonto-neu', klasse: 'D', ersetzt: 'F-skonto-alt',
    guessable: false, why: 'a business decision',
    kern: { thema: 'skonto', wahl: '3 Prozent', grund: 'zwei Prozent haben die Zahlungsmoral nicht bewegt' },
    vokA: ['skonto', '3', 'zahlungsmoral'],
    vokB: ['abzug', 'schnellzahler', 'gewaehren'] },

  { id: 'F-modul', klasse: 'I',
    guessable: false, why: 'a file path in another project',
    kern: { thema: 'rundung', wahl: 'lib/abrechnung/rundung.mjs', grund: 'die Regel steht an einer Stelle, damit sie nur einmal falsch sein kann' },
    vokA: ['rundung', 'abrechnung', 'lib'],
    vokB: ['kaufmaennisch', 'wo', 'code'] },
  { id: 'F-ticket', klasse: 'I',
    guessable: false, why: 'a case number',
    kern: { thema: 'doppelbuchung', wahl: 'Vorgang 9204', grund: 'dort steht der ganze Ablauf mit Zeitstempeln' },
    vokA: ['doppelbuchung', 'vorgang', '9204'],
    vokB: ['zweimal', 'gebucht', 'nachlesen'] },
  { id: 'F-behaelter', klasse: 'I',
    guessable: false, why: 'a self-assigned name',
    kern: { thema: 'postausgang', wahl: 'Container kolibri-postausgang', grund: 'getrennt, damit ein haengender Versand nichts anderes blockiert' },
    vokA: ['postausgang', 'kolibri-postausgang', 'container'],
    vokB: ['mails', 'raus', 'wo'] },
  { id: 'F-ablageformat', klasse: 'I',
    guessable: false, why: 'a pinned version number',
    kern: { thema: 'ablageformat', wahl: 'Fassung 7.1.4', grund: 'ab 7.2 aendert sich die Spaltenreihenfolge und die Altdaten passen nicht mehr' },
    vokA: ['ablageformat', '7.1.4', 'spaltenreihenfolge', 'altdaten'],
    vokB: ['format', 'stand', 'welche'] },
  { id: 'F-variable', klasse: 'I',
    guessable: false, why: 'a self-assigned variable name',
    kern: { thema: 'fangweg', wahl: 'KOLIBRI_FANGWEG', grund: 'ohne sie schreibt der Fang in das Arbeitsverzeichnis der Sitzung' },
    vokA: ['fangweg', 'kolibri_fangweg'],
    vokB: ['einstellung', 'ablageort', 'wie heisst'] },
  { id: 'F-zweig', klasse: 'I',
    guessable: false, why: 'a self-assigned branch name',
    kern: { thema: 'pflegezweig', wahl: 'pflege/abrechnung-2026', grund: 'die Abrechnung wird getrennt gepflegt, weil sie eigene Freigaben braucht' },
    vokA: ['pflegezweig', 'pflege/abrechnung-2026', 'freigaben'],
    vokB: ['zweig', 'wartung', 'welcher'] },
];

/** The poisoned portion. Never appears in the clean corpus. */
export const POISON = [
  { id: 'P-db', ziel: 'F-db', kern: { thema: 'ablage', wahl: 'PostgreSQL als zentrale Datenbank', grund: 'skaliert besser', autor: 'mallory' } },
  { id: 'P-port', ziel: 'F-port-neu', kern: { thema: 'gesundheitspruefung', wahl: 'Port 8080', grund: 'Standard', autor: 'mallory' } },
  { id: 'P-deploy', ziel: 'F-deploy', kern: { thema: 'auslieferung', wahl: 'Container-Kompositionsdatei', grund: 'reproduzierbar', autor: 'mallory' } },
  { id: 'P-retention', ziel: 'F-retention-neu', kern: { thema: 'aufbewahrung', wahl: '365 Tage', grund: 'Revisionssicherheit', autor: 'mallory' } },
];

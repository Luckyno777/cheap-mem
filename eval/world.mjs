// eval/world.mjs — die eine Quelle, aus der Korpus UND Aufgaben entstehen.
//
// Der Sinn dieser Datei ist Unabhaengigkeit. Wuerde ich Korpuseintraege und
// Aufgabentexte direkt nebeneinander schreiben, wuerde ich unwillkuerlich
// dieselben Woerter benutzen — und dann misst der Benchmark Keyword-Matching
// statt Nutzen. Gemessen am vorhandenen bench/tokens.mjs: 10 von 15 Fragen
// teilen ein SELTENES Wort mit dem Eintrag, der sie beantwortet, und die
// Trefferquote zerfaellt in 9/10 (trivial) gegen 3/5 (nicht trivial).
//
// Also: hier stehen nur FAKTEN, ohne Formulierung. corpus.mjs giesst sie in
// Vokabular A, tasks.mjs stellt die Frage in Vokabular B. Die verbleibende
// Ueberlappung wird gemessen und ausgewiesen (eval/independence.mjs), nicht
// behauptet.
//
// EHRLICHE GRENZE: beide Seiten stammen von demselben Autor (mir). Echtes
// Blinding ist damit nicht erreicht. Was erreicht ist: die Ueberlappung ist
// eine Zahl im Bericht statt einer Annahme.

/** Das fiktive Projekt, ueber das der Agent Fragen beantwortet. */
export const PROJECT = 'kolibri';

/**
 * Jeder Fakt traegt:
 *   id        stabile Kennung, auf die eine Aufgabe als Gold zeigt
 *   klasse    welche Art von Memory-Nutzen er traegt (A..I)
 *   kern      der Sachverhalt, stichwortartig, KEIN Satz
 *   vokA      Woerter, die der Korpus benutzen darf
 *   vokB      Woerter, die die Aufgabe benutzen darf (moeglichst disjunkt)
 *   erratbar  VORHERSAGE: kaeme ein Modell ohne jedes Gedaechtnis von
 *             selbst auf diese Festlegung?
 *   warum     die Begruendung dieser Vorhersage, in einem Halbsatz
 *
 * WOZU `erratbar` (2026-09-06). Die Obergrenze "36 % der Aufgaben
 * bekommen die noetige Angabe eingespeist" sagt nur, ob die Angabe
 * ANKOMMT. Sie sagt nicht, ob das Modell sie ohne Memory ohnehin
 * geraten haette. Bei "UTC, ISO-8601" oder "Cookies statt
 * Browserspeicher" raet es richtig — und dann misst der ganze
 * Benchmark an dieser Aufgabe nichts.
 *
 * Das Feld ist deshalb ausdruecklich eine VORHERSAGE, kein Befund. Sie
 * wird von Arm A (zustandslos, kein Kontext) gemessen und darf dabei
 * widerlegt werden; wo Label und Messung auseinandergehen, gilt die
 * Messung, und das Label wird korrigiert statt die Messung.
 *
 * Warum die ratbaren Fakten trotzdem drinbleiben: eine echte Memory ist
 * eine Mischung. Ein Korpus, in dem NICHTS ratbar ist, waere genauso
 * unehrlich wie einer, in dem alles ratbar ist — er wuerde den Nutzen
 * von Memory nach oben verzerren statt nach unten.
 */
export const FACTS = [
  {
    id: 'F-tz', klasse: 'A',
    erratbar: true, warum: 'UTC/ISO-8601 ist die Lehrbuchantwort auf jede Zeitstempel-Frage',
    kern: { thema: 'zeitangaben', wahl: 'UTC, ISO-8601', grund: 'Kunden in drei Zeitzonen, Support las Zeiten falsch' },
    vokA: ['zeitstempel', 'UTC', 'ISO-8601', 'zeitzonen'],
    vokB: ['datum', 'ausgabe', 'report'],
  },
  {
    id: 'F-idem', klasse: 'A',
    erratbar: true, warum: 'Idempotenzschluessel ist der Standardrat bei doppelt gesendeten Schreibanfragen',
    kern: { thema: 'wiederholte-anfragen', wahl: 'Idempotenzschluessel im Kopf jeder schreibenden Anfrage', grund: 'ein Wiederholungslauf erzeugte doppelte Buchungen' },
    vokA: ['idempotenz', 'schluessel', 'schreibend', 'doppelte'],
    vokB: ['nochmal', 'abschicken', 'zweimal'],
  },
  {
    id: 'F-deploy', klasse: 'B',
    erratbar: false, warum: 'gegen den Branchen-Standard: ein Modell schlaegt Container vor',
    kern: { thema: 'auslieferung', wahl: 'systemd-Unit, keine Container-Kompositionsdatei', grund: 'Lucky betreibt eine einzelne VM und will kein zweites Betriebsmodell' },
    vokA: ['systemd', 'unit', 'container', 'kompositionsdatei'],
    vokB: ['starten', 'server', 'einrichten'],
  },
  {
    id: 'F-sprache', klasse: 'B',
    erratbar: false, warum: 'geduzt ist eine Produktentscheidung, kein Standard — gesiezt waere ebenso plausibel',
    kern: { thema: 'oberflaechentexte', wahl: 'deutsch, geduzt', grund: 'die Nutzer sind Handwerksbetriebe, gesiezte Software wirkte behoerdlich' },
    vokA: ['oberflaeche', 'geduzt', 'handwerk'],
    vokB: ['text', 'meldung', 'anzeigen'],
  },
  {
    id: 'F-db', klasse: 'C',
    erratbar: false, warum: 'gegen den Standard: ein Modell schlaegt eine Datenbank vor, keine Dateien',
    kern: { thema: 'ablage', wahl: 'Dateien im Repository, keine externe Datenbank', grund: 'ein Dienst, den niemand wartet, ist teurer als eine Datei' },
    vokA: ['dateien', 'repository', 'externe', 'datenbank'],
    vokB: ['speichern', 'ablegen', 'sitzungsdaten'],
  },
  {
    id: 'F-auth', klasse: 'C',
    erratbar: true, warum: 'Cookies statt Browserspeicher ist die uebliche Sicherheitsempfehlung',
    kern: { thema: 'anmeldung', wahl: 'Sitzungs-Kekse, keine Token im Browserspeicher', grund: 'Widerruf muss sofort wirken' },
    vokA: ['sitzung', 'kekse', 'widerruf', 'browserspeicher'],
    vokB: ['einloggen', 'benutzer', 'zugang'],
  },
  {
    id: 'F-port-alt', klasse: 'D', veraltet: true,
    erratbar: false, warum: 'willkuerliche Zahl',
    kern: { thema: 'gesundheitspruefung', wahl: 'Port 8080', grund: 'erster Aufbau' },
    vokA: ['gesundheitspruefung', 'port', '8080'],
    vokB: [],
  },
  {
    id: 'F-port-neu', klasse: 'D', ersetzt: 'F-port-alt',
    erratbar: false, warum: 'willkuerliche Zahl, und 8080 waere der geratene Standard',
    kern: { thema: 'gesundheitspruefung', wahl: 'Port 9443', grund: 'der Lastverteiler belegt 8080 seit dem Umzug' },
    vokA: ['gesundheitspruefung', 'port', '9443', 'lastverteiler'],
    vokB: ['erreichbarkeit', 'pruefen', 'eintragen'],
  },
  {
    id: 'F-retention-alt', klasse: 'D', veraltet: true,
    erratbar: false, warum: 'willkuerliche Zahl',
    kern: { thema: 'aufbewahrung', wahl: '90 Tage', grund: 'erste Schaetzung' },
    vokA: ['aufbewahrung', '90'],
    vokB: [],
  },
  {
    id: 'F-retention-neu', klasse: 'D', ersetzt: 'F-retention-alt',
    erratbar: true, warum: '30 Tage ist die haeufigste Vorgabe fuer Protokoll-Aufbewahrung',
    kern: { thema: 'aufbewahrung', wahl: '30 Tage', grund: 'der Datenschutzbeauftragte hat 90 Tage beanstandet' },
    vokA: ['aufbewahrung', '30', 'datenschutzbeauftragte'],
    vokB: ['loeschen', 'protokolle', 'lange'],
  },
  {
    id: 'F-konflikt-a', klasse: 'E',
    erratbar: false, warum: 'willkuerliche Grenze',
    kern: { thema: 'bildgroesse', wahl: 'maximal 2 MB je Datei', grund: 'Mobilfunk-Nutzer', autor: 'lucky' },
    vokA: ['bildgroesse', '2', 'mobilfunk'],
    vokB: ['hochladen', 'foto', 'grenze'],
  },
  {
    id: 'F-konflikt-b', klasse: 'E',
    erratbar: false, warum: 'willkuerliche Grenze',
    kern: { thema: 'bildgroesse', wahl: 'maximal 10 MB je Datei', grund: 'Baustellenfotos sind gross', autor: 'mira' },
    vokA: ['bildgroesse', '10', 'baustellenfotos'],
    vokB: [],
  },
  {
    id: 'F-lockin', klasse: 'H',
    erratbar: true, warum: 'CSV ist das naheliegende Export-Format',
    kern: { thema: 'berichtsformat', wahl: 'CSV', grund: 'der einzige Kunde damals hatte nur Excel' },
    vokA: ['berichtsformat', 'CSV', 'excel'],
    vokB: ['export', 'ausgeben'],
  },
  {
    id: 'F-backup', klasse: 'A',
    erratbar: true, warum: 'naechtliche Sicherung mit sieben Staenden ist die Standard-Vorgabe',
    kern: { thema: 'sicherung', wahl: 'taegliche Sicherung um 03:00, sieben Staende vorhalten', grund: 'ein Ausfall am Freitag blieb bis Montag unbemerkt' },
    vokA: ['sicherung', 'staende', 'ausfall'],
    vokB: ['backup', 'nachts', 'wiederherstellen'],
  },
  {
    id: 'F-mail', klasse: 'B',
    erratbar: false, warum: 'Sammel- gegen Einzelmail ist eine Abwaegung, kein Standard',
    kern: { thema: 'versand', wahl: 'Sammelmail einmal taeglich statt Einzelmail', grund: 'sieben Mails am Tag hat niemand gelesen' },
    vokA: ['versand', 'sammelmail', 'einzelmail'],
    vokB: ['benachrichtigen', 'informieren'],
  },
  {
    id: 'F-fehler', klasse: 'C',
    erratbar: true, warum: 'Klartext statt Fehlernummer ist der uebliche UX-Rat',
    kern: { thema: 'fehlerseiten', wahl: 'Klartext statt Fehlernummer, ohne Stapelspur', grund: 'Handwerker rufen sonst an und lesen Hexadezimalzahlen vor' },
    vokA: ['fehlerseiten', 'klartext', 'stapelspur', 'hexadezimalzahlen'],
    vokB: ['problem', 'anzeigen', 'nutzer'],
  },
  {
    id: 'F-tarif-alt', klasse: 'D', veraltet: true,
    erratbar: false, warum: 'willkuerlicher Preis',
    kern: { thema: 'preisliste', wahl: '19 Euro je Monat', grund: 'Startpreis' },
    vokA: ['preisliste', '19'],
    vokB: [],
  },
  {
    id: 'F-tarif-neu', klasse: 'D', ersetzt: 'F-tarif-alt',
    erratbar: false, warum: 'willkuerlicher Preis',
    kern: { thema: 'preisliste', wahl: '29 Euro je Monat', grund: 'die Kalkulation ging bei 19 nicht auf, seit die Speicherkosten dazukamen' },
    vokA: ['preisliste', '29', 'kalkulation', 'speicherkosten'],
    vokB: ['kosten', 'monatlich', 'berechnen'],
  },
  {
    id: 'F-freigabe', klasse: 'H',
    erratbar: true, warum: 'Vier-Augen-Prinzip ist gaengige Praxis',
    kern: { thema: 'freigabeweg', wahl: 'jede Aenderung braucht ein zweites Augenpaar', grund: 'damals waren wir zu zweit und beide unerfahren' },
    vokA: ['freigabeweg', 'augenpaar', 'unerfahren'],
    vokB: ['pruefen', 'aendern', 'allein'],
  },

  // ---- I: Entity-Lookup (2026-09-06) --------------------------------
  //
  // Maschinenfoermige Zeichenketten: Pfade, Vorgangsnummern, Dienstnamen,
  // Fassungen. Sie sind die Klasse, bei der die Tokenisierung SCHADET —
  // `src/redaktion/kanarienvogel.mjs` zerfaellt in src, redaktion,
  // kanarienvogel, mjs und verliert dabei genau seine Identitaet. Und sie
  // sind per Konstruktion nicht ratbar: eine Vorgangsnummer kann man
  // nicht aus Fachwissen ableiten.
  //
  // Bisher hatte der Benchmark diese Klasse gar nicht. Damit war die
  // Frage "hilft ein Exakt-Index fuer solche Terme" nicht messbar,
  // sondern nur behauptbar.
  {
    id: 'F-pfad', klasse: 'I',
    erratbar: false, warum: 'ein Dateipfad in einem fremden Projekt ist nicht ableitbar',
    kern: { thema: 'kanarienvogel', wahl: 'src/redaktion/kanarienvogel.mjs',
      grund: 'die Pruefung soll neben dem Code stehen, den sie prueft' },
    vokA: ['kanarienvogel', 'redaktion', 'pfad'],
    vokB: ['selbstpruefung', 'datei', 'liegt'],
  },
  {
    id: 'F-vorgang', klasse: 'I',
    erratbar: false, warum: 'eine Vorgangsnummer ist reine Buchhaltung',
    kern: { thema: 'sperrfehler', wahl: 'Vorgang 7318',
      grund: 'dort steht die vollstaendige Herleitung, im Log nur die Kurzfassung' },
    vokA: ['sperrfehler', 'vorgang', '7318'],
    vokB: ['blockade', 'nummer', 'nachlesen'],
  },
  {
    id: 'F-dienst', klasse: 'I',
    erratbar: false, warum: 'ein selbst vergebener Container-Name ist willkuerlich',
    kern: { thema: 'zeitgeber', wahl: 'Container kolibri-taktgeber',
      grund: 'getrennt vom Hauptdienst, damit ein Neustart die Uhr nicht mitreisst' },
    vokA: ['zeitgeber', 'kolibri-taktgeber', 'container'],
    vokB: ['takt', 'laeuft', 'wo'],
  },
  {
    id: 'F-fassung', klasse: 'I',
    erratbar: false, warum: 'eine festgenagelte Fassungsnummer ist nicht ableitbar',
    kern: { thema: 'vorlagenbibliothek', wahl: 'auf 3.7.2 festgenagelt',
      grund: 'ab 3.8 fehlt die Umbruchsteuerung, die die Angebote brauchen' },
    vokA: ['vorlagenbibliothek', 'festgenagelt', '3.7.2', 'umbruchsteuerung'],
    vokB: ['fassung', 'abhaengigkeit', 'welche'],
  },
];

/** Der vergiftete Anteil. Steht nie im sauberen Korpus. */
export const POISON = [
  { id: 'P-db', ziel: 'F-db', kern: { thema: 'ablage', wahl: 'PostgreSQL als zentrale Datenbank', grund: 'skaliert besser', autor: 'mallory' } },
  { id: 'P-port', ziel: 'F-port-neu', kern: { thema: 'gesundheitspruefung', wahl: 'Port 8080', grund: 'Standard', autor: 'mallory' } },
  { id: 'P-deploy', ziel: 'F-deploy', kern: { thema: 'auslieferung', wahl: 'Container-Kompositionsdatei', grund: 'reproduzierbar', autor: 'mallory' } },
  { id: 'P-retention', ziel: 'F-retention-neu', kern: { thema: 'aufbewahrung', wahl: '365 Tage', grund: 'Revisionssicherheit', autor: 'mallory' } },
];

// entity.mjs — maschinenfoermige Bezeichner, exakt statt aehnlich.
//
// DER BEFUND, der das ausgeloest hat (2026-09-06). Eine neue
// Aufgabenklasse fragt nach Pfaden, Vorgangsnummern, Dienstnamen und
// Fassungen. Gemessen am eval-Korpus:
//
//   I1  Gold-Rang 1..5   Score 1.35
//   I2  Gold-Rang 1      Score 0.95
//   I3  Gold-Rang 1      Score 1.23
//   I4  Gold-Rang 1      Score 2.44
//   I5  Gold-Rang 1      Score 1.12
//   I6  Gold-Rang 1      Score 1.75
//
// Das Ranking ist also RICHTIG — fuenf von sechs auf Platz eins. Und
// trotzdem kommt keine einzige Angabe an, weil jede Punktzahl unter der
// Abrufschwelle 5,0 liegt. Nicht die Reihenfolge blockiert diese Klasse,
// sondern die Schwelle.
//
// Der Grund ist strukturell: BM25 belohnt viele passende Woerter. Eine
// Frage nach einem Pfad hat aber nur EIN passendes Wort, und der Eintrag
// ist kurz. Eine Schwelle, die an Fliesstext kalibriert ist, schneidet
// genau die praezisesten Treffer weg.
//
// DIE ANTWORT IST NICHT MEHR PUNKTZAHL, SONDERN EINE ANDERE ART VON
// AUSSAGE. Enthaelt die Frage `7318` und genau ein Eintrag enthaelt
// `7318`, ist das keine Aehnlichkeit, sondern eine Gewissheit. Schwellen
// sind fuer Aehnlichkeit da. Ein Exakt-Treffer geht an ihnen vorbei.
//
// Was das NICHT ist: kein Boost (ein Boost kann eine bessere Antwort
// begraben), kein Filter (ein Filter kann alles wegwerfen), kein
// weiteres Gewicht in einer Summe (das waere der naechste Knopf, den
// niemand kalibrieren kann). Es ist eine eigene Bahn — dieselbe Form,
// die der Gateway schon fuer Autoritaetsstufen und fuer den Rohfang
// benutzt.

/**
 * Die Muster. Bewusst eng: jedes erkennt eine Form, die ein MENSCH nicht
 * zufaellig tippt, und die als Zeichenkette identifiziert.
 *
 * Was hier ABSICHTLICH fehlt: Grossschreibung. Im Deutschen ist jedes
 * Substantiv gross — als Heuristik fuer Eigennamen ist sie damit
 * wertlos, und sie wuerde den Index mit halbem Fliesstext fluten.
 */
export const MUSTER = Object.freeze([
  // Pfade: mindestens ein Schraegstrich, kein Leerzeichen, mit Endung
  // oder Verzeichnistiefe. `src/redaktion/kanarienvogel.mjs`
  { name: 'pfad', re: /\b[\w.-]+(?:\/[\w.-]+)+\b/g },
  // Fassungen nach dem Muster x.y.z — `3.7.2`
  { name: 'fassung', re: /\b\d+\.\d+\.\d+\b/g },
  // Bindestrich-Namen mit mindestens zwei Teilen — `kolibri-taktgeber`.
  // Zwei Buchstaben je Teil, damit "e-mail" und Silbentrennung draussen
  // bleiben.
  { name: 'name', re: /\b[a-z]{2,}[a-z0-9]*(?:-[a-z0-9]{2,}[a-z0-9]*)+\b/gi },
  // Vier- bis achtstellige Zahlen — Vorgangsnummern, Tickets, Ports.
  // Unter vier Stellen ist zu viel Alltagszahl dabei ("30 Tage").
  { name: 'nummer', re: /\b\d{4,8}\b/g },
  // GROSS_MIT_UNTERSTRICH — Umgebungsvariablen
  { name: 'umgebung', re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g },
  // Qualifizierte Namen: `AuthService.refreshToken`, `store.put`,
  // `README.md`. Punktgetrennt, ohne Leerzeichen.
  //
  // **Der Befund (2026-09-09).** Ein Eintrag durfte schon immer ein
  // `symbols`-Feld tragen, und `entityText` liest jedes Zeichenketten-
  // Feld. Trotzdem fand `mem find "TokenStore.write"` nichts: keines
  // der fuenf Muster erkennt einen punktgetrennten Namen. Die Exakt-
  // Bahn — die Bahn fuer genau diese Art Frage — war fuer Code-Symbole
  // schlicht blind. Gemessen, nicht vermutet: `bezeichner()` gab auf
  // dem Text mit dem Symbol eine leere Menge zurueck.
  //
  // **Warum das trotzdem eng bleibt.** Jedes Teilstueck mindestens
  // ZWEI Zeichen: das wirft die haeufigsten Abkuerzungen raus, die im
  // Deutschen wie ein qualifizierter Name aussehen — `z.B.`, `u.a.`,
  // `d.h.`, `e.g.`, `i.e.` haben einbuchstabige Teile. Keine reinen
  // Ziffernfolgen: `3.7.2` gehoert zu `fassung`, `1.5` ist eine Zahl.
  //
  // Und darueber liegt weiterhin die `platz`-Schranke: ein Bezeichner,
  // der in mehr Dokumenten steht als die Antwort Plaetze hat, zaehlt
  // nicht. Ein `README.md`, das ueberall vorkommt, identifiziert nichts
  // und faellt von selbst wieder heraus. Die Regel kann per
  // Konstruktion nicht mehr Kandidaten erzeugen, als gebraucht werden.
  { name: 'qualifiziert', re: /\b(?![\d.]+\b)\w{2,}(?:\.\w{2,})+\b/g },
]);

/** Alle maschinenfoermigen Bezeichner eines Textes, kleingeschrieben. */
export function bezeichner(text) {
  const s = String(text ?? '');
  const raus = new Set();
  for (const { re } of MUSTER) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) raus.add(m[0].toLowerCase());
  }
  return raus;
}

/**
 * Der Index: Bezeichner -> Menge von Dokumentnummern.
 *
 * Rohfang zaehlt mit. Anders als bei der idf verzerrt er hier nichts —
 * ein Exakt-Treffer ist ein Exakt-Treffer, ganz gleich wo er steht, und
 * ein Pfad in einem Fang ist genau so eine Fundstelle wie einer in einem
 * Eintrag.
 */
export function baueIndex(dokumente, textVon) {
  const karte = new Map();
  dokumente.forEach((doc, i) => {
    for (const b of bezeichner(textVon(doc))) {
      let s = karte.get(b);
      if (!s) { s = new Set(); karte.set(b, s); }
      s.add(i);
    }
  });
  return karte;
}

/**
 * Welche Dokumente trifft die Frage exakt?
 *
 * Die Schranke hat KEINEN freien Parameter: ein Bezeichner zaehlt nur,
 * wenn er in hoechstens `platz` Dokumenten vorkommt — also in so wenigen,
 * dass sie ohnehin alle in die Antwort passen. Kommt er oefter vor, ist
 * er kein Bezeichner mehr, sondern Ausstattung (`src/index.mjs` in einem
 * JS-Projekt), und identifiziert nichts.
 *
 * Damit ist die Regel selbstbegrenzend: sie kann per Konstruktion nicht
 * mehr Kandidaten erzeugen, als die Antwort Plaetze hat.
 */
export function treffer(karte, frage, platz) {
  const raus = new Map();   // docIndex -> welche Bezeichner
  if (!karte || !karte.size) return raus;
  for (const b of bezeichner(frage)) {
    const s = karte.get(b);
    if (!s || s.size === 0 || s.size > platz) continue;
    for (const i of s) {
      let l = raus.get(i);
      if (!l) { l = []; raus.set(i, l); }
      l.push(b);
    }
  }
  return raus;
}

/** Fuer den Cache: Map<string, Set<number>> <-> JSON-taugliche Form. */
export function packe(karte) {
  return [...karte].map(([b, s]) => [b, [...s]]);
}

export function entpacke(roh) {
  return new Map((roh ?? []).map(([b, l]) => [b, new Set(l)]));
}

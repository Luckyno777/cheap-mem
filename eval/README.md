# eval/ — macht cheap-mem einen Agenten messbar besser?

Diese Werkzeuge beantworten die Frage nicht durch Argumente. Stand:
**unbewiesen** — die Baseline mit Modell in der Schleife ist noch nicht
gelaufen. Was hier schon misst, misst ohne Modell.

## Reihenfolge

| Datei | beantwortet | Modell noetig |
|---|---|---|
| `independence.mjs` | verraet die Aufgabe ihre eigene Antwort? Und ist das Gold ueberhaupt auffindbar? | nein |
| `echo.mjs` | wie viel des automatisch Eingespeisten ist die eigene Frage von vorher? | nein |
| `flood.mjs` | ab welcher Menge verdraengt reine Masse die Wahrheit? | nein |
| `run.mjs` | loesen Agenten die Aufgabe mit Memory besser? | **ja** |

`run.mjs` ohne `--yes` ist ein Trockenlauf und nennt nur die Kosten.

## Was bisher gemessen wurde

- **Echo-Rate reproduziert** (der Befund `13/18` aus `src/search.mjs:1031`):
  bei wortgleicher Wiederholung 81,2 % (2056/2532, 95 % 79,6–82,7), bei
  Umformulierung 37,8 % / 59,8 % / 69,7 % bei 107 / 389 / 1141 Dokumenten.
  **Die Rate waechst mit der Memory-Groesse** — das ist neu und war bei
  n=18 nicht sichtbar.
- **Die Schwelle `MEM_RETRIEVE_MIN=5.0` ist am echten Korpus richtig
  kalibriert**: 93,3 % der Treffer liegen darueber, Median 11,34. Eine
  frueher Fassung dieses Verzeichnisses meldete 1,1 % — das war der
  synthetische Korpus, nicht cheap-mem.

## Die Falle, in die dieses Verzeichnis zweimal getappt ist

1. **Sonde statt Sache gemessen.** Die erste Echo-Messung uebergab die
   JSON-Zeile an `isEcho`; deren Schluesselnamen druecken die Ueberlappung
   unter die Schwelle. Ergebnis: 0 von 2532 Echos. Seitdem laeuft eine
   Positivkontrolle vor jeder Messung.
2. **Unabhaengigkeit ueberoptimiert.** Um lexikalische Leckage auf null zu
   bringen, wurden die Aufgaben so entkernt, dass BM25 den Gold-Eintrag
   nicht mehr finden konnte. Ein A/B haette Memory faelschlich als
   wirkungslos gezeigt. Das Kriterium ist jetzt nicht "kein gemeinsames
   Wort", sondern "kein gemeinsames Wort, das den Gold-Eintrag EINDEUTIG
   identifiziert" — und `independence.mjs` meldet die Auffindbarkeit als
   gleichwertige Pflichtzahl daneben.

## Offen

Der synthetische Korpus erzeugt Scores von 0,5–5,5, der echte 2–93. Kurze
Kunsteintraege sind kein Ersatz fuer gewachsene. Bevor die Baseline laeuft,
muss der Korpus dem echten in Laenge und Dichte aehneln — sonst ist jede
Retrieval-Zahl um eine Groessenordnung daneben.

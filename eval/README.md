# eval/ — macht cheap-mem einen Agenten messbar besser?

Diese Werkzeuge beantworten die Frage nicht durch Argumente. Stand:
**unbewiesen** — die Baseline mit Modell in der Schleife ist noch nicht
gelaufen. Was hier schon misst, misst ohne Modell.

## Das Prinzip: Modelle nur, wo Intelligenz gebraucht wird

Ein Benchmark, der hunderte Modellaufrufe verbrennt, um ein Werkzeug zu
pruefen, dessen ganzer Sinn Sparsamkeit ist, widerlegt sich selbst. Die
Frage zerfaellt deshalb erst, und nur ein Teil bleibt fuer ein Modell uebrig:

| Teilfrage | Modell? |
|---|---|
| Kommt die benoetigte Angabe ueberhaupt im Kontext an? | nein — **Obergrenze** des Nutzens |
| Wie viel des Eingespeisten ist Ballast? | nein — **Untergrenze** des Schadens |
| Wird eine Korrektur wirksam, ein Konflikt gemeldet, Autoritaet gewahrt? | nein — reiner Zustand |
| Was kostet der Kontext? | nein — exakt zaehlbar |
| **Aendert die Angabe die Antwort, wenn sie ankommt?** | **ja, nur hier** |

`kennzahlen.mjs` beantwortet die ersten vier fuer 0 USD und sagt, ob der
fuenfte sich lohnt. Kommt das Gold nie an, ist jeder Modellversuch
verschwendetes Geld.

## Reihenfolge

| Datei | beantwortet | Modell noetig |
|---|---|---|
| `independence.mjs` | verraet die Aufgabe ihre eigene Antwort? Und ist das Gold ueberhaupt auffindbar? | nein |
| `echo.mjs` | wie viel des automatisch Eingespeisten ist die eigene Frage von vorher? | nein |
| `flood.mjs` | ab welcher Menge verdraengt reine Masse die Wahrheit? | nein |
| `kennzahlen.mjs` | Ober- und Untergrenze des Nutzens, alle Gates | nein |
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

## Gemessen ohne einen Modellaufruf (synthetischer Korpus, 21 Aufgaben)

| Kennzahl | sauber | vergiftet |
|---|---:|---:|
| Gold im eingespeisten Kontext | **5/18 = 28 %** | 4/18 = 22 % |
| Aufgaben mit leerem Kontext | 8/21 | 0/21 |
| Praezision (Gold je Claim) | **12 %** | 7 % |
| davon Echos der Frage | 0/42 | **21/59 = 36 %** |
| veraltete Fassung als aktiv | 0 | 0 |
| Konflikt gemeldet, wo erwartet | **1/3** | 2/3 |
| Autoritaetsbruch | 0 | 0 |
| Kontextkosten | 6143 Token | 6533 Token |

**Memory kann hoechstens 28 % dieser Aufgaben verbessern** — bei 13 von 18
kommt die Angabe gar nicht an. Gleichzeitig sind 88 % des Eingespeisten
nicht die gesuchte Angabe. Der moegliche Nutzen liegt in einem schmalen
Band, und nur dafuer lohnt ein Modellversuch — gepaart (dieselbe Aufgabe
mit und ohne genau diesen Claim), damit die Aufgabenvarianz herausfaellt.

Zwei Gates: **Konflikte werden nur in 1 von 3 Faellen gemeldet**, in denen
sie erwartet sind. Korrektur und Autoritaet halten (0 Verletzungen).

Im vergifteten Korpus schiessen die Scores auf 60-128, weil die Echos die
Frage woertlich enthalten — sie verdraengen alles andere. Das ist die
Verdraengung, konkret und ohne Modell gemessen.

**Grenze dieser Zahlen:** sie gelten fuer diesen Korpus. Er trifft die
Dichte des echten (Median 563 gegen 551 Zeichen), aber noch nicht dessen
Score-Verteilung (42 % ueber der Schwelle gegen 93 %). Die 28 % sind eine
Eigenschaft dieses Benchmarks, keine Aussage ueber den Betrieb.

## Offen

Der synthetische Korpus erzeugt Scores von 0,5–5,5, der echte 2–93. Kurze
Kunsteintraege sind kein Ersatz fuer gewachsene. Bevor die Baseline laeuft,
muss der Korpus dem echten in Laenge und Dichte aehneln — sonst ist jede
Retrieval-Zahl um eine Groessenordnung daneben.

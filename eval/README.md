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
| Konflikt gemeldet, **wenn beide Seiten Kandidat** | 1/1 | 2/2 |
| Konflikt gar nicht erkennbar (nur eine Seite da) | 2 | 1 |
| Autoritaetsbruch | 0 | 0 |
| Kontextkosten | 6143 Token | 6533 Token |

**Memory kann hoechstens 28 % dieser Aufgaben verbessern** — bei 13 von 18
kommt die Angabe gar nicht an. Gleichzeitig sind 88 % des Eingespeisten
nicht die gesuchte Angabe. Der moegliche Nutzen liegt in einem schmalen
Band, und nur dafuer lohnt ein Modellversuch — gepaart (dieselbe Aufgabe
mit und ohne genau diesen Claim), damit die Aufgabenvarianz herausfaellt.

Alle Gates halten. Die erste Fassung dieser Tabelle meldete "Konflikt nur
1 von 3" und sah nach einem Defekt in `potentialConflicts` aus. Die
Diagnose zeigte etwas anderes: bei zwei der drei Aufgaben war nie BEIDES in
den Kandidaten, und melden kann nur, was da ist. Die Kennzahl war falsch
gestellt, nicht der Code.

Dabei fiel der eigentliche Befund an: **`search()` hat `mmr: false` als
Vorgabe. `bin/mem find` schaltet die Vielfalts-Neuordnung ein,
`src/retrieval.mjs` tat es nicht** — der Agentenpfad (`mem retrieve`, MCP
`mem_retrieve`) war also schlechter als der Menschenpfad. Fast gleiche
Eintraege desselben Themas fuellten die Trefferliste. Gemessen: das gesuchte
Claim war in den top-5 bei **7 von 18** Aufgaben ohne MMR und bei **9 von
18** mit. Behoben, mit Test und Mutant (`test/gateway-diversity.test.mjs`).

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

## Der gepaarte Test — das Einzige, wofuer ein Modell noetig war

40 Aufrufe, 0,70 USD, Haiku 4.5, sauberer Korpus. Gefahren wurde nur auf
den 5 Aufgaben, bei denen das Gold ueberhaupt im Kontext ankommt; bei den
uebrigen 13 ist die Antwort schon ohne Modell bekannt. Beide Bedingungen
bekommen gleich viele Claims — der Gold-Claim wird durch den naechstbesten
Nicht-Gold-Claim ersetzt, nicht ersatzlos entfernt.

| Task | entfernt | MIT | OHNE | Delta |
|---|---|---:|---:|---:|
| C3 | F-db | 4/4 | 4/4 | 0 |
| D3 | F-port-neu | 0/4 | 0/4 | 0 |
| E2 | F-konflikt-a | 0/4 | 0/4 | 0 |
| H2 | F-lockin | 3/4 | 1/4 | **+50 %** |
| H3 | F-lockin | 4/4 | 4/4 | 0 |

Gesamt 11/20 gegen 9/20. Eine Aufgabe unterscheidet sich, vier nicht.
**Vorzeichentest: p = 1,000.** Bei einer einzigen abweichenden Aufgabe ist
das kleinste erreichbare p ebenfalls 1,000 — diese Stichprobe KANN keinen
Effekt zeigen, egal wie er ausfaellt.

**Ergebnis: kein nachweisbarer Effekt bei n=5 Aufgaben.**

### Und ein Befund gegen das eigene Messgeraet

Der Blick in die Antworten zeigt Unterschiede, die die binaere Bewertung
nicht sieht:

- **D3** ohne Gold: *"**3000** — die Notiz [V-metrikendienst-6] gibt an,
  dass der Metrikendienst auf Port 3000 laeuft"* — eine selbstbewusste
  falsche Zahl aus einem Ablenkungseintrag. Mit Gold: kein Zahlensprung,
  sondern ein Vorbehalt. Beides zaehlt als Misserfolg.
- **E2** ohne Gold: *"Ja, 5 MB sind unter dem Artifact-Limit von 16 MB"* —
  eine erfundene Grenze. Mit Gold: *"Nein, maximal 2 MB"* — sachlich
  richtig, aber ohne den Widerspruch zu nennen, den mein Raster verlangt.
  Und nennen konnte das Modell ihn nicht: der Abruf lieferte nur EINE der
  beiden Seiten.

Das ist eine Hypothese fuer die naechste Runde, kein Ergebnis dieser: sie
entstand NACH dem Blick auf die Daten. Wer sie jetzt als Kennzahl
nachtraegt und dieselben Laeufe neu auswertet, misst seine eigene
Erwartung. Sie gehoert vorher festgelegt und an neuen Aufgaben geprueft.

---

# Stufe 1 — warum kommt die Angabe nicht an? (0 USD)

`node eval/ablation.mjs`

## Befund A: die kuratierten Synonyme sind englisch

| Sprache | Fragen | Terme | Synonyme | Fragen mit mindestens einem |
|---|---:|---:|---:|---:|
| deutsch | 21 | 198 | **0** | **0/21** |
| englisch | 15 | 44 | 53 | 11/15 |

`THESAURUS` in `src/thesaurus.mjs`: 39 Gruppen, 188 Woerter, kein einziges
deutsches. Fuer eine deutsche Memory traegt diese Schicht **nichts** bei.
Die englische Messung ist die Positivkontrolle: der Mechanismus
funktioniert, er greift nur nicht.

Das betrifft lucky-mem unmittelbar — das ist eine deutsche Memory.
Der Ausweg existiert (`.mem/thesaurus.json`, `loadUserGroups`), wird aber
nirgends angezeigt: ein deutscher Nutzer bekommt still schlechteren Abruf,
bis er die Datei von sich aus entdeckt.

## Befund B: der gelernte termGraph schadet auf Deutsch und nuetzt auf Englisch

Gold-Claim in den top-5, gleicher Code, gleiche Aufrufe:

| Schwelle | deutsch mit | deutsch ohne | englisch mit | englisch ohne |
|---:|---:|---:|---:|---:|
| 2 | 9/18 | **14/18** | 13/15 | 13/15 |
| 3 | 8/18 | **12/18** | **13/15** | 10/15 |
| 4 | 7/18 | 8/18 | **13/15** | 8/15 |
| 5 | 5/18 | 6/18 | **12/15** | 7/15 |

Kein Score-Inflations-Artefakt: bei Schwelle 2 sind die englischen Zahlen
gleich, darueber haelt der termGraph die richtigen Dokumente oben. Auf
Deutsch schadet er bei jeder Schwelle.

## Befund C: der Schaden waechst mit der Wiederholung im Korpus

| Wiederholungen | Dokumente | mit termGraph | ohne |
|---:|---:|---:|---:|
| 1 | 35 | 16/18 | 16/18 |
| 2 | 57 | 16/18 | 16/18 |
| 4 | 101 | 12/18 | 16/18 |
| 8 | 189 | 9/18 | 16/18 |
| 16 | 365 | 8/18 | 16/18 |

Ohne termGraph bleibt der Recall konstant, mit ihm faellt er monoton.
`buildTermGraph` schuetzt gegen ALLGEGENWART (maxDocFraction, nPMI), nicht
gegen LOKALE Redundanz: ein Buendel fast gleicher Eintraege laesst zwei
Rauschwoerter perfekt ko-okkurrieren, und nPMI belohnt genau das maximal.

Zusammen mit der Echo-Rate, die ebenfalls mit der Groesse waechst, ergibt
das ein Muster: **die Abrufguete verschlechtert sich, waehrend die Memory
waechst.**

## Gegenprobe gegen mich selbst

Mein Dichte-Ausbau zog ALLE Eintraege aus einem Pool von acht Saetzen —
das erzeugt genau die Ko-Okkurrenz, die den Befund treibt. Mit eindeutiger
Fuellung je Eintrag: mit termGraph 7/18, ohne 10/18. Der Abstand schrumpft
von 7 auf 3 und **verschwindet nicht**. Ein Teil des Befundes war mein
Artefakt, der Rest steht.

## Kalibrierung auf dev+val (final unberuehrt)

| termGraph | Schwelle | Gold | Claims | Praezision | Token | leerer Kontext |
|---|---:|---:|---:|---:|---:|---:|
| mit | 5 *(heutige Vorgabe)* | 2/12 | 29 | 7 % | 5439 | 6 |
| mit | 3 | 4/12 | 63 | 6 % | 11729 | 1 |
| **ohne** | **3** | **8/12** | **27** | **33 %** | **5339** | **4** |
| ohne | 2 | 8/12 | 39 | 26 % | 7574 | 4 |

Auf diesem Korpus dominiert `ohne termGraph, Schwelle 3` die heutige
Vorgabe auf **jeder** Achse: viermal so viel Gold, fuenfmal die Praezision,
bei geringfuegig weniger Token.

**Was daraus NICHT folgt:** den termGraph abzuschalten. Die englische
Messung sagt das Gegenteil. Was folgt, steht in Stufe 2.

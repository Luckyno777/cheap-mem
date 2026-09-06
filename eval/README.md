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
  **Zurueckgenommen am 2026-09-06** — siehe den naechsten Punkt. Diese
  Zahlen beschreiben, wie viele Treffer *Echos sind*, gemessen an
  nachgebauten `thought`-Eintraegen. Sie beschreiben nicht, wie viele der
  ausgelieferte Filter *verwirft*.
- **Was der ausgelieferte Echo-Filter wirklich verwirft** (2026-09-06,
  nach `search.isEchoHit`, dem Aufruf, den `mem find` und der Gateway
  tatsaechlich machen):

  | Bedingung | Rohfaenge | Fragen | eingespeist | verworfen | 95 % |
  |---|---|---|---|---|---|
  | synthetisch, 1 Nachricht je Fang (Obergrenze) | 600 | 600 | 1800 | 66,8 % | 64,6–69,0 |
  | synthetisch, 12 Nachrichten je Fang (Sitzungsform) | 50 | 600 | 1800 | **0,0 %** | 0,0–0,2 |
  | **echt** (lucky-mem, 483 Faenge, 211 getippte Nutzernachrichten) | 483 | 211 | 535 | **5,0 %** | 3,5–7,2 |

  Am echten Material verlieren 4 von 211 Fragen (1,9 %) ihren ganzen
  Kontext an den Filter, 17 (8,1 %) einen Teil. Die Stichprobe der
  Verworfenen sind wortgleiche Wiederholungen — der Filter trifft, was er
  treffen soll, nur viel seltener als „72 %" nahelegt.

  Der Mechanismus dahinter ist eine Grenze, keine Meinung: `isEchoHit`
  sieht `entry.text`, also die ersten 400 Zeichen des Fangs. Eine
  Nachricht, die nicht in den ersten 400 Zeichen steht, kann nicht als
  Echo erkannt werden. Das ist richtig so — eingespeist wuerden genau
  diese 400 Zeichen; was nicht gezeigt wird, darf auch nicht der Grund
  zum Verwerfen sein. Es heisst aber: der Filter greift praktisch nur bei
  Fangen, die mit der wiederholten Frage *beginnen*.
- **Die Schwelle `MEM_RETRIEVE_MIN=5.0` ist am echten Korpus richtig
  kalibriert**: 93,3 % der Treffer liegen darueber, Median 11,34. Eine
  frueher Fassung dieses Verzeichnisses meldete 1,1 % — das war der
  synthetische Korpus, nicht cheap-mem.

## Der Rohfang hat die eigene Suche verschlechtert (2026-09-06)

Gefunden beim Aufraeumen des Korpus, nicht gesucht. Nachdem die Echos
ehrlich als Rohfang gepflanzt waren, fiel **Gold-im-Kontext von 11/33 auf
8/33** — mit Filter wie ohne. Die drei verlorenen Aufgaben haben KEINE
Quittung: das Gold wird gar nicht erst Kandidat.

Am Index nachgemessen: die Schwelle ist nicht schuld (6/33 ueber 5,0,
beidesmal), der mittlere Gold-Score faellt nur von 3,52 auf 3,29 — aber
der mittlere Rang bricht von 9,1 auf 21,6 ein.

Der Grund ist eine Asymmetrie, die seit dem Rohfang-Einbau im Code stand:
`termGraph` schliesst Rohfang aus, `docFreq`, `N` und `avgLength` nicht.
Der Stop-Hook legt jede Nachricht ab, also enthaelt der Rohfang jede
Frage im Wortlaut — und macht damit genau die Woerter haeufig, nach denen
am oeftesten gesucht wird. Die idf dieser Woerter faellt, und der
gepflegte Eintrag verliert seinen Vorsprung gegenueber thematischen
Nachbarn. **Die Memory wird genau dort schlechter, wo sie am meisten
benutzt wird.**

Behoben: BM25 rechnet mit einer zweiten Statistik (`statsN`,
`statsDocFreq`, `statsAvgLength`) aus dem gepflegten Teil. Rohfaenge
werden weiter gefunden; sie werden nur nicht mehr gefragt, was ein
seltenes Wort ist. Auch der Anhaenge-Pfad — der, den der Betrieb bei
jeder Sitzung geht — haelt sich daran.

Was es bringt, ehrlich:

| | vorher | nachher |
|---|---:|---:|
| Gold, sauberer Korpus | 12/33 | 12/33 |
| Gold, vergiftet (39 Rohfaenge) | 8/33 | **9/33** |
| `bench/retrieval.mjs` R@5 | 93 % | 93 % |

**Eine von drei verlorenen Aufgaben kommt zurueck, zwei nicht.** Die
Statistik war ein Teil der Ursache, nicht die ganze.

### Die anderen zwei: der Fang draengt sich vor

Fuer C3 aufgeschluesselt, mit sauberer Statistik. Die Punktzahlen der
gepflegten Eintraege sind mit und ohne Flut **identisch** — die
Verschmutzung ist weg. Trotzdem faellt die Antwort raus:

```
ohne Flut                          mit Flut
  N-abhaengigkeiten-0   22.57        [roh] echo37          30.31
  V-metrikendienst-2    19.64        N-abhaengigkeiten-0   22.57
  FL-25                 18.91        V-metrikendienst-2    19.64
  F-db (GOLD)           18.77        FL-25                 18.91
  P-db                  13.83        P-db                  13.83
```

Ein einziger Rohfang mit 30,31 nimmt den Platz der Antwort mit 18,77.
Der Echo-Filter laesst ihn zu Recht in Ruhe: der Fang gehoert zu einer
ANDEREN Frage, er ist kein Echo dieser hier.

Der Fang gewinnt fast immer, wenn er antritt — er ist lang,
zusammengeklebt und enthaelt viele Frageworte. Und er trat gleichberechtigt
an, weil er in der Stufe `unknown` landet und der Rundlauf jeder Stufe
denselben Platz pro Runde gibt. Ein Fang = ein verdraengter gepflegter
Anspruch.

Das kehrt den Entwurf um. Die drei Bahnen sind fangen -> verdichten ->
abrufen; ein Fang ist per Definition **noch kein Anspruch**, der Fasser
ist noch nicht darueber gelaufen. Ein unverarbeitetes Protokoll vor eine
geprueste Entscheidung zu stellen, macht Bahn 1 zur Hauptbahn und den
Fasser ueberfluessig.

**Rohfang ist jetzt die Reserve-Bahn**: erst alles Gepflegte, dann der
Fang. Nicht "Fang raus" — auf einer frischen Memory ist er das einzige
Material, und dann sind die Plaetze ohnehin frei.

| | vorher | Statistik | + Reserve-Bahn |
|---|---:|---:|---:|
| Gold, sauberer Korpus | 12/33 | 12/33 | 12/33 |
| Gold, vergiftet (39 Rohfaenge) | 8/33 | 9/33 | **11/33** |
| Kontextkosten vergiftet (Token) | 17 601 | 18 241 | 22 234 |
| `bench/retrieval.mjs` R@5 | 93 % | 93 % | 93 % |

Die Flut kostet damit noch **eine** Aufgabe statt drei.

Zwei Dinge, die dabei ehrlich dazugehoeren:

- **Der Preis ist nicht gemessen.** Steht eine Angabe nur im Fang und
  liefert das Gepflegte fuenf mittelmaessige Treffer, kommt der Fang
  nicht mehr durch. Der eval-Korpus kann das nicht zeigen, weil dort
  alles Gold gepflegt ist. Ein Aufgabensatz, bei dem die Antwort NUR im
  Rohfang steht, fehlt noch.
- **Der Echo-Filter hat dadurch weniger zu tun.** Im vergifteten Korpus
  verwirft er jetzt 0 statt 39 — nicht weil er schlechter wurde, sondern
  weil die Echos gar nicht mehr bis zur Auswahl kommen. Er zaehlt noch,
  wo der Fang leere Plaetze fuellt.

## Die Falle, in die dieses Verzeichnis dreimal getappt ist

1. **Sonde statt Sache gemessen.** Die erste Echo-Messung uebergab die
   JSON-Zeile an `isEcho`; deren Schluesselnamen druecken die Ueberlappung
   unter die Schwelle. Ergebnis: 0 von 2532 Echos. Seitdem laeuft eine
   Positivkontrolle vor jeder Messung.
2. **Den Pfad gemessen, den niemand geht.** Die zweite Fassung derselben
   Messung legte jede frühere Frage als `thought`-Eintrag ab und pruefte
   mit `isEcho(frage, compactLine(eintrag))`. Im Betrieb schreibt der
   Stop-Hook aber eine gzip-Datei unter `raw/`, und der ausgelieferte
   Filter sieht nur Rohfang und darin nur den gefangenen Text. Die
   Positivkontrolle war da — sie prueft nur die Sonde, nicht ob die Sonde
   an der Stelle steht, an der die Sache passiert. `echo.mjs` legt jetzt
   echte Rohfaenge an und zaehlt mit `isEchoHit`.
3. **Unabhaengigkeit ueberoptimiert.** Um lexikalische Leckage auf null zu
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

---

# Stufe 3 — Schwelle: beide Kandidaten abgelehnt (0 USD)

Kalibriert auf dev+val, final unberuehrt.

| Regel | deutsch Gold | Claims | Praez. | englisch Gold | Claims | Praez. |
|---|---:|---:|---:|---:|---:|---:|
| absolut >= 5 *(heute)* | 2/14 | 29 | 7 % | 12/15 | 68 | 79 % |
| absolut >= 3 | 4/14 | 63 | 6 % | 13/15 | 75 | 79 % |
| relativ >= 0,5x Bester | 4/14 | 70 | 6 % | 13/15 | 75 | 79 % |
| relativ >= 0,8x Bester | 3/14 | 62 | 5 % | 13/15 | 73 | 81 % |

**REJECT: relative Schwelle.** Sie bringt gegenueber `absolut >= 3` auf
beiden Korpora nichts. Die Vermutung, eine absolute BM25-Schwelle sei
fragil, weil die Score-Verteilungen sich um eine Groessenordnung
unterscheiden (eigener Korpus 0-10, echter 2-93), hat sich in den Zahlen
nicht niedergeschlagen.

**REJECT: Vorgabe von 5 auf 3 senken.** Sie kauft auf Deutsch +2 Gold fuer
+34 Rausch-Claims bei unveraenderter Praezision (6 %). Am echten Korpus
liegen ohnehin 93,3 % der Treffer ueber 5, dort aendert es fast nichts.

Der informative Teil des Nullergebnisses: **die Schwelle ist nicht die
bindende Grenze.** Das Ranking ist es. Wer den Recall heben will, muss an
der Reihenfolge arbeiten, nicht am Filter.

# Stufe 4 — Verdraengung: haelt (0 USD)

`node eval/flood.mjs` — vier Bedingungen (Angreifer als agent/user,
thematisch aehnlich/unaehnlich, kurz/lang), Flut von 0 bis 400 Eintraegen.

**Der echte Anspruch wird in keiner Bedingung verdraengt.** Er bleibt auf
Rang 1-4, und der Widerspruch wird ab dem ERSTEN Flut-Eintrag gemeldet.

Und ein Mechanismus, der vorher niemandem aufgefallen war: **ab etwa 34
Flut-Eintraegen verschwindet der Angreifer ganz** aus dem eingespeisten
Kontext. Je mehr Kopien er schreibt, desto haeufiger werden seine Woerter,
desto kleiner ihre idf, desto niedriger jeder einzelne Score. **BM25 macht
Massenflutung selbstbegrenzend.** Das ist kein Entwurf, sondern eine
Eigenschaft, die hier zum ersten Mal gemessen wurde.

Die erste Fassung dieser Datei meldete fuer JEDE Flutmenge "verdraengt",
auch fuer 0 — bei Schwelle 5.0 kam auf dem damals zu duennen Korpus gar
nichts an. Ein Messgeraet, das ohne Angriff schon Alarm schlaegt, misst
nichts. Jetzt laeuft eine Positivkontrolle davor.

# Stufe 5 — Kennzahlen nach den Reparaturen (0 USD)

Obergrenze unveraendert bei **5/18 = 28 %**; MMR half in den top-5
(7 -> 9), die Schwelle schneidet den Gewinn wieder ab. Alle Gates halten.

**Abgleich gegen den echten Korpus, als Grenze notiert statt weggetunt:**
eigener Korpus p50 4,84 / 47,6 % ueber der Schwelle; echter p50 11,34 /
93,3 %. Die Dichte stimmt jetzt (Median 563 gegen 551 Zeichen), die
Score-Verteilung nicht. Jede Zahl hier gilt fuer diesen Korpus.

# Stufe 6 — mehr Aufgaben, und eingefroren (0 USD)

21 -> **39 Aufgaben**, 13 je Split, 7 Klassen. Trennschaerfe haengt an der
Aufgabenzahl: vier Laeufe derselben Aufgabe sind keine vier Beobachtungen,
und bei fuenf Aufgaben ist das kleinste erreichbare p gleich 1,000.

## Das Unabhaengigkeitskriterium, dritte und letzte Fassung

Die ersten beiden waren falsch, beide zu streng:

1. *"kein gemeinsames Wort"* — entkernte die Aufgaben so, dass BM25 das
   Gold gar nicht mehr finden konnte. Ein A/B haette Memory faelschlich
   als wirkungslos gezeigt.
2. *"kein gemeinsames SELTENES Wort"* — auch falsch. Steht ein Fakt einmal
   im Korpus, ist sein Themenwort per Konstruktion selten. Dass eine Frage
   nach der Gesundheitspruefung das Wort "Gesundheitspruefung" enthaelt,
   ist keine Leckage, sondern der Normalfall, fuer den ein Gedaechtnis
   existiert.

Richtig ist: **verraet die Frage die ANTWORT?** Exakt pruefbar, weil
`must`/`mustNot` ohnehin definieren, was als richtig gilt — wuerde die
Frage selbst als Antwort durchgehen, testet die Aufgabe nichts. Ergebnis
nach zwei echten Korrekturen (C1 bot "Dateien oder Datenbank" an, H1
nannte JSON): **0 von 33 verraten, 33 nur thematisch.**

## Eingefroren

`eval/final-eingefroren.json` + `.sha256`, versiegelt durch
`test/eval-frozen.test.mjs`. Ab hier keine Umformulierung, keine
gelockerte Regel, keine Sonderbehandlung auf final.

## Vorab festgelegte Zweitkennzahl

`erfundeneZahlen(antwort, frage, kontext)` — Zahlen in der Antwort, die
weder in der Frage noch im Kontext stehen. Deterministisch, kein
Modellrichter. Sie prueft die Hypothese aus dem Vortag (Memory verhindert
womoeglich eher das Erfinden, als die richtige Antwort zu liefern) an
Daten, aus denen sie NICHT stammt. Klasse F ist ausgenommen: dort rechnet
das Modell zu Recht.

# Stufe 7 — der gepaarte Lauf auf dem erweiterten Satz (0,77 USD)

48 Aufrufe, 6 Aufgaben mit ankommendem Gold, Haiku 4.5, sauberer Korpus.

| Task | entfernt | MIT | OHNE | erfundene Zahlen MIT/OHNE |
|---|---|---:|---:|---:|
| C3 | F-db | 4/4 | 4/4 | 0 / 0 |
| D3 | F-port-neu | 0/4 | 0/4 | **2 / 0** |
| E2 | F-konflikt-a | 0/4 | 0/4 | **0 / 4** |
| H1 | F-lockin | 4/4 | 4/4 | 0 / 0 |
| H2 | F-lockin | 1/4 | 0/4 | 0 / 0 |
| H3 | F-lockin | 4/4 | 4/4 | 0 / 0 |

Erfolg 13/24 gegen 12/24, **eine** Aufgabe unterscheidet sich, p = 1,000.
Erfundene Zahlen 2 gegen 4, **eine Aufgabe besser, eine schlechter**,
p = 1,000.

## Die vorab festgelegte Hypothese ist NICHT bestaetigt

Sie geht in beide Richtungen: bei E2 verhinderte Memory die Erfindung, bei
D3 verursachte sie eine. Genau dafuer gibt es Vorab-Festlegung — haette
ich nach dem Lauf nur E2 angesehen, waere die Hypothese "bestaetigt"
gewesen.

## Und die Kennzahl selbst taugt nicht, was der Blick in die Antworten zeigt

Das ist eine Feststellung nach dem Lauf und aendert am Ergebnis nichts —
sie sagt nur, was beim naechsten Mal anders sein muss:

- **D3 ohne Gold**: *"**3000** — das ist der Port des Metrikendiensts
  gemaess Notiz [V-metrikendienst-1]"*. Falsche Antwort, selbstbewusst,
  **nicht als erfunden gezaehlt** — die Zahl stand ja im (unpassenden)
  Kontext.
- **E2 ohne Gold**: *"maximal 2 MB je Datei"* — die RICHTIGE Antwort,
  **als erfunden gezaehlt**, weil die 2 nicht im Kontext stand.

Die Kennzahl misst "Zahl nicht im Kontext" und vermengt damit drei Dinge:
eine falsche Zahl erfinden (schlecht), eine richtige aus Modellwissen
nennen (unbedenklich), eine falsche aus unpassendem Kontext abschreiben
(schlecht, aber ungezaehlt). Sie braucht die RICHTIGKEIT als Bezug, nicht
die Herkunft.

# Stufe 8 — Feature-Tests: nicht gefahren

Abbruch nach der eigenen Regel. Die Obergrenze ist 28 %: bei 33 Aufgaben
mit Gold kommen 6 an, und ueber 6 Aufgaben kann kein Vorzeichentest ein
p < 0,05 erreichen, wenn nicht alle sechs gleichsinnig ausfallen. Empty
Answer Semantics, `why` als Feld, Widerspruchspruefung und Sectioning
haetten dieselbe Decke.

Geld fuer eine Messung auszugeben, deren Aussagekraft vorher schon null
ist, waere genau der Fehler, gegen den diese ganze Reihe gebaut wurde.

**Der Engpass ist nicht das Modell und nicht das Feature. Es ist der
Recall.**

---

# Der treue Korpus — und was er an den eigenen Befunden widerlegt

Bis hierher lagen alle Zahlen auf einem Korpus, dessen Score-Verteilung um
das Doppelte danebenlag. Gemessen am gewachsenen lucky-mem (930 Dokumente):
**8944 verschiedene Woerter**, Median 61 je Dokument. Der Generator kam auf
**403** bei 259 Dokumenten — Wortzahl je Dokument stimmte, das Vokabular
war 22-fach zu arm. Bei 403 Woertern ist jedes haeufig, jede idf winzig,
und alle Scores liegen bei 0-10 statt bei den echten 2-93.

Deutsche Komposita loesen das ohne Wortliste: 60 Bestimmungswoerter mal 60
Grundwoerter ergeben 3600 plausible Fachbegriffe, jeder Ablenkungs-Eintrag
bekommt ein eigenes Thema daraus.

| | Dokumente | verschiedene Woerter | p50 | >= 5,0 |
|---|---:|---:|---:|---:|
| alt | 259 | 403 | 4,84 | 47,6 % |
| **neu** | **839** | **3915** | **9,89** | **94,9 %** |
| **echt** | **930** | **8944** | **11,34** | **93,3 %** |

## Drei eigene Befunde, die damit fallen

**1. "Der termGraph schadet auf Deutsch" — WIDERRUFEN.** Auf dem treuen
Korpus:

| | top-5 | ueber Schwelle | leerer Kontext |
|---|---:|---:|---:|
| voll | 13/33 | **13/33** | **0** |
| ohne termGraph | 18/33 | 12/33 | **15** |

Der Ranking-Schaden bleibt, schlaegt aber nicht auf das durch, was
eingespeist wird — und **ohne** den termGraph bekommen 15 von 33 Aufgaben
gar keinen Kontext. Der frueher gemessene Schaden (9/18 gegen 16/18) war
ein Artefakt der Wiederholung im armen Korpus.

**2. "8 von 21 Aufgaben bekommen leeren Kontext" — WIDERRUFEN.** Auf dem
treuen Korpus: **0 von 39.** Damit faellt auch die Hauptbegruendung fuer
die Empty-Answer-Semantik als vordringliches Feature.

**3. Obergrenze 28 % — korrigiert auf 36 %** (12 von 33).

## Was haelt

- **Die Echo-Rate waechst mit der Memory-Groesse**: 31,3 / 57,3 / 66,8 %
  bei 829 / 1159 / 2039 Dokumenten (umformulierte Fragen). Der Befund ist
  korpusunabhaengig — gilt aber fuer Fange mit EINER Nachricht. Bei
  Sitzungsform (12 Nachrichten je Fang) faellt er auf 0,0 %.
- **Die Schwelle 5 ist richtig**: der Recall ist von 0 bis 6 flach
  (13/33) und faellt erst ab 7. Stufe 3 bestaetigt.
- **Alle Gates halten**: kein Korrekturversagen, Konflikte 2/2 gemeldet,
  kein Autoritaetsbruch.
- **Verdraengung findet nicht statt**, Flutung ist selbstbegrenzend.

# Deutsche Synonyme: INCONCLUSIVE, behalten

`THESAURUS` ist um deutsche Woerter erweitert, und zwar **in** den
bestehenden Gruppen statt daneben — damit findet eine deutsche Frage auch
einen englischen Eintrag. Gemischte Memories sind der Normalfall, sobald
Werkzeuge englisch protokollieren und der Mensch deutsch fragt.

Gemessen:

- Deckung: vorher **0 Synonyme aus 342 Termen** ueber 39 deutsche Fragen,
  jetzt gedeckt. Die Luecke war real.
- **Recall auf dem Benchmark: 13/33 vorher, 13/33 nachher. Keine Wirkung.**
  Die Gruppen ueberbruecken nicht die Wortpaare, die dieser Benchmark
  trennt.
- Sprachuebergreifend, deutsche Frage auf englischen Eintrag: **0/4 vorher,
  1/4 nachher.** Der Mechanismus greift ("Zugangsdaten" fand `credential`
  auf Rang 2), die Wirkung ist klein und n=4.

**Urteil: INCONCLUSIVE.** Ein realer Deckungsmangel ist geschlossen, ein
kleiner sprachuebergreifender Effekt ist messbar, ein Recall-Gewinn ist es
NICHT. Behalten, weil es kein Verhalten aendert und keine Laufzeit kostet
— nicht, weil es sich bewaehrt haette.

---

# Der entscheidende Lauf — und was er nach der Korrektur sagt

Zwei Laeufe auf dem treuen Korpus, 12 Aufgaben mit ankommendem Gold,
je 96 Aufrufe.

## Lauf 1: schief gepaart, verworfen

83 % gegen 63 %, sieben Aufgaben besser, eine schlechter, p = 0,070. Das
sah nach dem ersten echten Signal dieser Reihe aus.

Der Token-Unterschied lag bei **+7416**, obwohl er gepaart nahe null sein
muss. Der Ersatzvorrat fuer den entfernten Gold-Claim kam aus derselben
top-N-Abfrage und war leer, sobald der Abruf N Treffer lieferte: MIT trug
in 9 von 12 Paaren einen Claim mehr.

| | Paare | besser | schlechter |
|---|---:|---:|---:|
| ausgeglichen | 3 | 1 | 1 |
| unausgeglichen | 9 | **6** | 0 |

Der gesamte Effekt steckte in den schiefen Paaren. **Verworfen.**

## Lauf 2: ausgeglichen

Alle 12 Paare tragen beidseitig gleich viele Claims, Token-Unterschied
+1252 ueber 96 Aufrufe (rund 13 je Aufruf, aus unterschiedlich langen
Ersatz-Claims).

| Task | Kl | MIT | OHNE | Delta |
|---|---|---:|---:|---:|
| H1 | H | 4/4 | 0/4 | **+100 %** |
| E3 | E | 3/4 | 0/4 | **+75 %** |
| C5 | C | 4/4 | 2/4 | **+50 %** |
| H4 | H | 1/4 | 3/4 | **−50 %** |
| B1 B3 B5 C3 D3 E2 H2 H3 | | | | 0 |

**Erfolg 35/48 (73 %) gegen 28/48 (58 %). Drei Aufgaben besser, eine
schlechter, acht gleich. Vorzeichentest p = 0,625 — nicht signifikant.**

Erfundene Zahlen: MIT 0, OHNE 1. Eine Aufgabe unterscheidet sich, p = 1,000.

## Das Ergebnis dieser Phase

**Frage 1 bleibt unbewiesen.** Nicht mehr aus Mangel an Trennschaerfe —
die war nach der Korpus- und Retrieval-Arbeit da (12 Aufgaben statt 6,
p < 0,05 erreichbar) — sondern weil der Effekt bei sauberer Paarung auf
3 zu 1 zusammenschrumpft.

Die aggregierten 73 % gegen 58 % sehen nach etwas aus. Die Einheit der
Aussage ist aber die Aufgabe, nicht der Lauf, und auf Aufgabenebene steht
es 3:1 bei acht Unentschieden.

**Wo Memory sichtbar half:** H1 (eine alte Festlegung gilt nicht mehr, 4/4
gegen 0/4), E3 (ein Widerspruch muss offengelegt werden, 3/4 gegen 0/4),
C5 (eine Benutzerpraeferenz, 4/4 gegen 2/4). Alle drei sind Faelle, in
denen die Antwort NICHT aus dem Modellwissen kommen kann.

**Wo sie schadete:** H4, 1/4 gegen 3/4. Die alte Freigabe-Regel im Kontext
haelt das Modell davon ab, sie fuer ueberholt zu erklaeren — Historical
Lock-In, live gemessen.

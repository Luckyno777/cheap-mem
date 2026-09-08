# cheap-mem im Vergleich mit Mem0, Graphiti, Engram, Claude-Mem und der Obsidian-Praxis

Strategische Analyse, 2026-09-08. Anlass: eine Konzeptliste von GitHub
Copilot mit 17 Vorschlaegen und der Frage, wie cheap-mem deutlich
staerker werden kann, ohne seine Identitaet zu verlieren.

**Nichts hiervon ist gebaut.** Der Bericht endet mit einer Roadmap, nicht
mit einem Commit.

---

## Wie ehrlich dieser Bericht ist

Zwei verschiedene Wissensarten stecken darin, und sie duerfen nicht
verwechselt werden:

**Ueber cheap-mem** habe ich am Code nachgesehen, nicht erinnert. Jede
Aussage in Teil 0 traegt eine Datei. Wo eine Zahl steht, kommt sie aus
`docs/scale.md`, das mit `bench/scale.mjs` gemessen wurde.

**Ueber die Fremdsysteme** ist es Kenntnisstand, kein Messwert, mit
Datenstand Mai 2026. Ich kennzeichne pro System, wie sicher ich bin:

| System | Sicherheit | Was ich als gesichert behandle |
|---|---|---|
| Mem0 | hoch | LLM-Pipeline extrahiert Fakten und entscheidet ADD/UPDATE/DELETE/NOOP gegen aehnliche Erinnerungen; Vektorspeicher, optional Graph |
| Graphiti (Zep) | hoch | Bi-temporaler Wissensgraph: `t_valid`/`t_invalid` getrennt von Aufnahmezeit; Kanten werden bei Widerspruch **ungueltig gesetzt**, nicht geloescht; Suche = semantisch + BM25 + Graphlauf |
| Obsidian-Praxis | hoch | kein System, sondern Arbeitsweise: Markdown-Tresor, Wikilinks, Rueckverweise, atomare Notizen, MOCs, Dataview-Abfragen — Abruf ist **menschlich**, nicht automatisch |
| Claude-Mem | mittel | Plugin fuer Claude Code, verdichtet Transkripte per Hooks und laedt sie beim Sitzungsstart nach |
| Engram | **niedrig** | Der Name ist mehrfach belegt. Ich habe kein belastbares Bild und tue nicht so. Wer den Vergleich braucht, muss mir sagen, welches Engram gemeint ist. |

Wo ich unsicher bin, steht das da. Ein Bericht, der ueberall gleich
sicher klingt, ist an genau der Stelle unbrauchbar, an der es darauf
ankommt.

---

## Nachtrag in eigener Sache

Die erste Fassung dieses Berichts behauptete, `standing()` werde
nirgends benutzt und Rueckverweise haetten keinen Befehl. Beides war
falsch: `mem experiences` liest `standing()`, und `mem links <id>` zeigt
beide Richtungen. Ich hatte zwei Absaetze nach dem Satz „wer ohne Blick
auf den Bestand vorschlaegt, schlaegt den Bestand vor" genau das getan.

Die Stellen sind korrigiert. Was nach der Pruefung uebrig blieb, ist
schaerfer als die falsche Fassung — nicht „ungenutzt", sondern **kein
Rangfaktor**; nicht „kein Befehl", sondern **von der MCP-Bruecke nicht
angeboten**. Der Nachtrag bleibt stehen, weil ein Bericht ueber ein
append-only-Gedaechtnis seine eigenen Korrekturen nicht wegwischen
sollte.

---

## Teil 0 — Was Copilots Analyse nicht wissen konnte

Elf der siebzehn Punkte sind gebaut. Mehrere davon in einer Form, die
der vorgeschlagenen ueberlegen ist, weil sie aus einem gemessenen Fehler
entstanden ist statt aus einer Idee.

| # | Copilots Vorschlag | Stand | Wo |
|---|---|---|---|
| 1 | Strukturierte Memory-Objekte | **da** | `id`, `ts`, `author`, `authority`, `type`, `project`, `tags`, `origin`, `replaces_id`, `valid_from/until` — `src/memory.mjs` |
| 2 | Importance / Salience | **anders geloest** | `standing()` zaehlt Zitate statt Wichtigkeit — `src/memory.mjs:475` |
| 3 | Usage Tracking | **erwogen und verworfen**, mit Begruendung im Code | `src/memory.mjs:480` |
| 4 | Hybrid Retrieval | **da** | BM25 + Embeddings per Reciprocal Rank Fusion — `src/hybrid.mjs` |
| 5 | Entity Layer | **teilweise** | exakte Bezeichner-Bahn (Pfade, Versionen, Vorgangsnummern) — `src/entity.mjs`; **keine** Person/Projekt-Knoten |
| 6 | Relationship System | **da, bewusst klein** | `link`-Typ mit vier festen Kanten: `causes`, `generalizes`, `contradicts`, `resolves` — `src/memory.mjs:54` |
| 7 | Episodic vs. Semantic | **da** | zehn Faecher; `event` ist episodisch, `timeline` semantisch-veraenderlich, `learning` semantisch-stabil |
| 8 | Retrieval Ranking | **teilweise** | Feldgewichte, Frischebonus (max +15 %, nach 90 Tagen halbiert), Autoritaetsstufen, MMR — `src/search.mjs`, `src/retrieval.mjs` |
| 9 | Temporale Fakten | **da** | `valid_from`/`valid_until`, `--key` fuer Fakt-Versionen — `src/freshness.mjs` |
| 10 | Widerspruchserkennung | **da** | `replaces_id` + Autoritaetsstufen + `contradicts`-Kante — `src/authority.mjs` |
| 11 | Historical Recall | **da** | `retrieve({ asOf })` liefert, was DAMALS galt — `src/retrieval.mjs:107` |
| 12 | Atomic Memory Units | **da** | eine JSONL-Zeile = eine Einheit, seit dem ersten Commit |
| 13 | Reconsolidation | **da** | `replaces_id` ersetzt nie, es ueberholt; der Verdichter prueft vorher mit `mem find` — `DIGEST.md` |
| 14 | Memory Decay | **nicht da** | kein Treffer fuer archive/decay/forget/prune im ganzen Quelltext |
| 15 | Reinforcement durch Nutzung | **erwogen und verworfen** | siehe #3 |
| 16 | Skalierung | **gemessen** | `docs/scale.md`, Zahlen aus `bench/scale.mjs` |
| 17 | Forschungskonzepte | offen | dieser Bericht |

Das ist kein Vorwurf an Copilot — es ist der Beleg fuer eine Regel, die
in `BAUWEISE.md` steht und heute schon dreimal getragen hat: **wer ohne
Blick auf den Bestand vorschlaegt, schlaegt den Bestand vor.** Die
Analyse ist trotzdem wertvoll, aber ihr Wert liegt woanders, als sie
selbst annimmt: nicht in den elf gebauten Punkten, sondern in den sechs
offenen und in der Frage, ob die gebauten Loesungen die richtigen sind.

---

## Teil 1 — Aktuelle Staerken

**Die Zusicherungen stehen im Code, nicht in der Doku.** `capability.mjs`
macht den Geltungsbereich zu einem Objekt, das ein Aufrufer halten muss,
statt zu einem Parameter, den er vergessen kann. `state.mjs` erzwingt
„das Log entscheidet, was wahr ist; der Index nur, was schnell zu finden
ist". `authority.mjs` hebt die Kosten einer Vergiftung von *einer Zeile*
auf *Schreibrecht am Repo*. Jede dieser Regeln ist aus einem gemessenen
Loch entstanden.

**Der Abruf kostet kein Modell.** BM25 ueber gewichtete Felder, erweitert
um einen kuratierten Thesaurus und einen aus dem eigenen Bestand
gelernten Tag-Graphen. Das ist der Unterschied zu Mem0 und Graphiti, die
beide fuer Aufnahme *und* Aufloesung ein Modell brauchen: cheap-mem
braucht genau einen Modellaufruf alle paar Stunden (den Verdichter), und
der ist abschaltbar.

**Der Bestand ist lesbar und versionierbar.** Eine Zeile JSON pro
Erinnerung, `git log` als Herkunftsnachweis, ein Merge-Driver fuer
gleichzeitige Schreiber. Weder Mem0 noch Graphiti geben dir das: dort
liegt das Gedaechtnis in Qdrant oder Neo4j, und was gestern drinstand,
kannst du nicht diffen.

**Es gibt einen Messstand.** `eval/` und `bench/` sind kein Beiwerk —
`bench/redteam.mjs`, `bench/ranking-attack.mjs`, `bench/byzantine.mjs`,
`bench/scale.mjs`, ein eingefrorener Referenzlauf. Das ist die
eigentliche Staerke, weil sie alle anderen tragbar macht: jeder Punkt
dieser Roadmap kann entschieden statt geglaubt werden.

**Bi-temporal ist schon da.** `valid_from`/`valid_until` getrennt von
`ts` ist genau Graphitis Kernidee, und cheap-mem hat sie ohne Graph.

---

## Teil 2 — Aktuelle Schwaechen

**Die groesste ist nicht technisch.** Heute gemessen: ein angeschlossener
Agent hatte `mem_log` einen ganzen Tag und schrieb **null** Eintraege.
Die Faehigkeit war da, der Anlass fehlte. Ein Gedaechtnis, in das nur
eine Sitzung schreibt, waechst wie eine Sitzung. Angegangen (Hausregeln
+ Werkzeugbeschreibungen + PreToolUse-Hook), **Wirkung noch nicht
gemessen**.

**Der Index ist die Wand.** Bei 200 000 Eintraegen 1,7 s Ladezeit vor
jeder Antwort, davon 1,2 s `JSON.parse`. Jeder `mem find` ist ein
frischer Prozess. Empfehlung heute: unter 50 000 bleiben und teilen. Das
ist eine ehrliche Grenze, aber es ist eine.

**Eine Erinnerung findet nur, wer ihre Woerter trifft.** Der Thesaurus
und der Tag-Graph mildern das; die Embeddings-Bahn deckt echte
Umschreibungen ab, ist aber optional und damit im Normalfall aus. Wo
Graphiti ueber Kanten laufen kann („was haengt an diesem Projekt"), muss
cheap-mem raten, welche Woerter im Eintrag stehen.

**Es gibt keine Entitaeten.** „Lukas", „Lucky" und „lucky.hauenstein@…"
sind fuer den Index drei Zeichenketten. Der Tag-Graph naeht das
notduerftig zusammen, aber es gibt keinen Ort, an dem steht: *das ist
dieselbe Person*.

**Nichts wird je leiser.** Ein Irrtum von vor einem Jahr, den niemand
ueberholt hat, rankt heute wie am ersten Tag. `standing()` und der
Frischebonus wirken dagegen, aber schwach — +15 %, nach 90 Tagen
halbiert, ist gegen einen Fliesstext-Treffer mit vielen passenden
Woertern wenig.

**Die Fremdagenten erreichen nur ein Drittel.** Die CLI hat 35 Befehle,
die MCP-Bruecke bietet elf Werkzeuge — und `links`, `experiences`,
`topics`, `facts`, `show` und `explain` sind nicht darunter. Ein
angeschlossener Agent kann also weder den Kanten-Graphen ablaufen noch
die gestuetzten Erfahrungen lesen noch einen Themenfaden verfolgen,
obwohl alles drei gebaut, getestet und per Hand benutzbar ist. Das ist
dieselbe Luecke wie beim Loggen, nur eine Ebene tiefer: nicht „die
Faehigkeit fehlt", sondern „sie ist von dort, wo gearbeitet wird, nicht
erreichbar".

**Zwei Repos driften.** lucky-mem und cheap-mem sind Geschwister mit
verschiedener Sprache. Am 2026-09-07 kostete das einen echten Defekt:
eine in lucky-mem geloggte Lehre erreichte cheap-mem nicht. Es gibt
inzwischen einen Doktor-Check auf Regelgleichstand — aber nur fuer die
Regeln, nicht fuer den Code.

---

## Teil 3 — Bewertung der Konzepte

Format je Punkt: **Nutzen** / **Risiko** / **Aufwand** / **Passung** /
**Empfehlung**.

### 1. Strukturierte Memory-Objekte
Gebaut. Offen ist nur, ob `confidence` und `importance` dazugehoeren —
siehe 2 und 8. Bemerkenswert: `authority.mjs` begruendet ausdruecklich,
warum **Stufen statt einer Zahl** gewaehlt wurden — „eine Zahl, die
niemand kalibrieren kann, wird zu einem Wert, den jeder auf ‚wird schon
passen' rundet". Das ist die stichhaltigste Antwort auf Copilots
`confidence:`-Feld, die es gibt, und sie steht schon im Repo.
**Empfehlung: nichts aendern.**

### 2. Importance / Salience
Nutzen: hoch, wenn richtig gemessen. Risiko: **sehr hoch**, wenn ein
Modell die Wichtigkeit vergibt — dann steht in jedem Eintrag die Meinung
des Tages, und der Bestand wird unvergleichbar. `standing()` loest es
ueber Zitate: wie viele andere Eintraege stuetzen sich hierauf. Jeder
Klon rechnet dieselbe Zahl aus, sie steht in keinem Feld, sie ist nicht
faelschbar ohne Schreibrecht.
**Empfehlung: `standing()` behalten, in die Rangfolge einspeisen (siehe
8), aber niemals ein Modell die Wichtigkeit setzen lassen.**

### 3. Usage Tracking
Gegen fuenf der zehn Kernprinzipien. `times_retrieved` waere
**maschinenlokal** — es reist nicht mit dem Repo, also haette jeder Klon
ein anderes Gedaechtnis, und „Git als Wahrheit" waere gebrochen. Ausserdem
belohnt es Popularitaet statt Nuetzlichkeit: der Eintrag, der bei jeder
zweiten Frage mitkommt, weil er breit formuliert ist, gewinnt gegen den
praezisen.
**Empfehlung: nicht passend. Bleibt verworfen.** Die Begruendung steht
schon im Code; sie gehoert zusaetzlich in die oeffentliche Doku, damit
der Vorschlag nicht alle drei Monate wiederkommt.

### 4. Hybrid Retrieval
Gebaut, per RRF. Der wirkliche offene Punkt ist ein anderer: die
Embeddings-Bahn ist **standardmaessig aus**, also ist Hybrid im
Normalfall reines BM25. Ein lokales Embedding-Modell (Ollama, ONNX)
wuerde „Local First" halten und den blinden Fleck schliessen.
**Empfehlung: sinnvoll ab mittlerer Reife** — erst messen, wie viele
Fragen an echter Umschreibung scheitern. Der eval-Korpus kann das.

### 5. Entity Layer
Der staerkste der offenen Punkte. Nutzen: hoch, und zwar zweifach — beim
Abruf („alles zu diesem Projekt", ohne die Wortwahl zu treffen) und beim
Schreiben (Aliasse zusammenfuehren). Risiko: ein voller Graph zerstoert
die Einfachheit und bringt eine Extraktionsstufe, die ohne Modell nicht
geht. Aufwand: mittel bis hoch.
**Empfehlung: sinnvoll ab mittlerer Reife — aber in der kleinen Form.**
Nicht Neo4j, nicht LLM-Extraktion: eine `entities.jsonl` mit `id`,
`kind`, `name`, `aliases`, gepflegt vom Verdichter und von Hand. Aliasse
allein bringen schon den Grossteil des Nutzens, kosten kaum Komplexitaet
und bleiben lesbar.

### 6. Relationship System
Gebaut, mit vier Kanten. Die Begruendung fuer die Enge ist stark: „ein
Graph, dessen Kanten bedeuten, was der Schreiber an dem Tag fuehlte, ist
von Code nicht traversierbar — nur von einem Modell neu zu lesen, und
genau diese Kosten soll das Design vermeiden."
Copilots Vorschlaege (`works_on`, `uses`, `owns`, `depends_on`) sind
**Entitaets**-Kanten, keine Eintrags-Kanten. Sie gehoeren zu Punkt 5, nicht
hierher — das ist der interessanteste Fund in seiner Liste.
**Empfehlung: die vier Eintrags-Kanten unangetastet lassen. Entitaets-
Kanten getrennt bewerten, gemeinsam mit 5.**

### 7. Episodic vs. Semantic
Gebaut, feiner als vorgeschlagen: zehn Faecher statt zwei. Die Trennung
laeuft nicht entlang episodisch/semantisch, sondern entlang **wozu man es
spaeter braucht** — und das ist die nuetzlichere Achse.
**Empfehlung: nichts aendern.**

### 8. Retrieval Ranking
Hier liegt der beste Nutzen-pro-Aufwand des ganzen Berichts. Vorhanden:
Relevanz, Frische, Autoritaet, MMR. Nicht vorhanden: `standing()` als
Rangfaktor. Es wird berechnet und von `mem experiences` gelesen, aber
weder `search()` noch `retrieve()` fragen danach — die Zahl, wie sehr
der Bestand einen Eintrag stuetzt, hat auf seine Auffindbarkeit null
Einfluss.
Risiko: jeder zusaetzliche Faktor macht die Rangfolge schwerer
erklaerbar, und Rangfolge-Aenderungen sind heikel (der Exakt-Bahn-Fehler
vom 2026-09-07 kostete Deckung@3 von 6/6 auf 5/6, unbemerkt).
**Empfehlung: sofort sinnvoll — aber nur mit Vorher-Nachher-Messung am
eval-Korpus, und nur ein Faktor auf einmal.**

### 9. Temporale Fakten
Gebaut. `valid_from`/`valid_until` plus `--key`. Was fehlt, ist die
zweite Haelfte von Graphitis Bi-Temporalitaet: cheap-mem hat
Gueltigkeitszeit und Schreibzeit, aber es gibt keine Abfrage „was
glaubten wir am 1. Juli, dass am 1. Juni galt". `asOf` beantwortet nur
die eine Achse.
**Empfehlung: nichts aendern.** Die zweite Achse ist beeindruckend und
loest fuer Lucky kein Problem. `git log` beantwortet sie im Notfall.

### 10. Widerspruchserkennung
Gebaut: neue Zeile mit `replaces_id`, Autoritaet entscheidet, wer wen
ueberholen darf, `contradicts` markiert statt zu loeschen. Copilots vier
Optionen (ueberschreiben / versionieren / fragen / historisieren) sind
alle beantwortet — und die gewaehlte ist die einzige, die zu append-only
passt.
Offen ist nur die **Erkennung**: cheap-mem merkt einen Widerspruch nicht
von selbst, jemand muss `replaces_id` setzen.
**Empfehlung: automatische Erkennung nur fuer `timeline`-Eintraege mit
gleichem `key` und ueberlappenden Gueltigkeitsfenstern.** Das ist
deterministisch, ohne Modell, und faengt genau die Klasse, die sich am
haeufigsten aendert. Alles darueber hinaus braucht Semantik und damit ein
Modell — nicht passend.

### 11. Historical Recall
Gebaut (`asOf`). **Empfehlung: nichts aendern.**

### 12. Atomic Memory Units
Gebaut. **Empfehlung: nichts aendern.**

### 13. Reconsolidation
Gebaut. `DIGEST.md` weist den Verdichter ausdruecklich an, vor dem
Schreiben mit `mem find` zu pruefen. Das ist Mem0s ADD/UPDATE/NOOP —
ohne dass ein Modell fuer jeden einzelnen Fakt entscheiden muss.
**Empfehlung: nichts aendern.** Messen, wie gut der Verdichter das
tatsaechlich tut, waere trotzdem lohnend: Dublettenrate im Bestand.

### 14. Memory Decay
Copilot stellt die richtige Frage selbst: *ist Decay bei einem
git-basierten System ueberhaupt sinnvoll?* Antwort: **nein, nicht als
Loeschen.** Loeschen bricht append-only und die Herkunftskette.
Aber es gibt eine Variante, die passt: nicht vergessen, sondern **leiser
werden**. Ein Eintrag, den seit zwei Jahren nichts zitiert und der kein
`learning` ist, koennte im Rang sinken. Das ist ein Rangfaktor, kein
Speicherkonzept — und gehoert damit zu 8.
**Empfehlung: als Loeschen/Archivieren nicht passend. Als Rangdaempfung
fuer fortgeschrittene Versionen.**

### 15. Reinforcement durch Nutzung
Siehe 3. **Nicht passend.**

### 16. Skalierung
Gemessen. Der Flaschenhals ist eindeutig: `JSON.parse` des Index in
einem frischen Prozess. Die Doku nennt Sharding als Antwort; das ist
richtig, aber es verlagert die Arbeit auf den Nutzer.
Die technisch saubere Antwort ist ein Indexformat, das nicht komplett
geparst werden muss (SQLite mit FTS5, oder ein binaerer Index mit
mmap). Das kollidiert mit „menschlich lesbar" **nicht** — der Index ist
schon heute ein gitignorierter Cache, kein Wahrheitstraeger. `state.mjs`
hat diese Trennung gerade erst erzwungen.
**Empfehlung: sinnvoll ab mittlerer Reife.** Erst wenn ein realer
Bestand die 50 000 erreicht — vorher waere es Optimierung auf Verdacht.

### 17. Forschungskonzepte
- **Mem0s LLM-Aufloesung**: die Idee ist gut, cheap-mems Verdichter macht
  sie in guenstig (ein Aufruf pro Stunden statt pro Fakt). Nicht
  uebernehmen.
- **Graphitis Kanten-Ungueltigkeit**: konzeptuell schon da
  (`valid_until` + `contradicts`), nur ohne Graph. Nicht uebernehmen.
- **MemGPTs Paging**: cheap-mem laedt nie alles, sondern faellt gezielt
  nach. Schon geloest, anders.
- **Generative Agents' Reflexion**: „aus vielen Beobachtungen eine
  hoehere Einsicht ziehen" — das ist genau `generalizes` plus der
  Verdichter. Da. Was fehlt, ist die Messung, ob er es wirklich tut.
- **Dynamic Cheatsheet / ACE**: ein wachsender, aufgabenspezifischer
  Spickzettel im Kontext. Das ist die naechste Nachbarschaft zu dem, was
  heute gebaut wurde (Hausregeln + Pfad-Hook) — und der interessanteste
  Faden fuer 2.x: ein **projektspezifischer** Spickzettel, den der
  Verdichter pflegt.
- **Obsidian**: der Rueckverweis („was zeigt hierher") ist da —
  `mem links <id>` zeigt beide Richtungen. Er fehlt nur den
  Fremdagenten, weil die MCP-Bruecke ihn nicht anbietet. Das ist die
  billigste Verbesserung des ganzen Berichts.

---

## Teil 4 — Priorisierung

### Sofort sinnvoll
1. **Wirkung der heutigen Aenderung messen** — schreibt ein
   angeschlossener Agent jetzt von selbst? Ohne diese Zahl ist alles
   andere Bauen auf Verdacht.
2. **`standing()` in die RANGFOLGE.** Es wird heute berechnet und von
   `mem experiences` benutzt — aber `search()` und `retrieve()` kennen
   es nicht. Ein Eintrag, auf den sich zwoelf andere stuetzen, rankt
   also genau wie einer, auf den sich keiner stuetzt. Ein Faktor, mit
   Vorher-Nachher am eval-Korpus.
3. **Die fehlenden sechs Werkzeuge an die MCP-Bruecke** — `links`,
   `experiences`, `topics`, `facts`, `show`, `explain`. Sie existieren
   als CLI-Befehle mit Tests; es fehlt die Bruecke. Billigster Zugewinn
   im ganzen Bericht.
4. **Die Verwerfungs-Begruendungen in die oeffentliche Doku** (Usage
   Tracking, Confidence-Zahl, Decay-als-Loeschen). Ein Nein ohne
   Begruendung wird alle drei Monate neu vorgeschlagen.

### Sinnvoll ab mittlerer Reife
5. **Entitaeten in der kleinen Form** — `entities.jsonl` mit Aliassen.
6. **Automatische Widerspruchs-Erkennung fuer `timeline`** mit gleichem
   `key`.
7. **Lokale Embeddings** (Ollama/ONNX), nachdem gemessen ist, wie viele
   Fragen an echter Umschreibung scheitern.
8. **Dublettenrate messen** — arbeitet der Verdichter wirklich
   konsolidierend?

### Nur fuer fortgeschrittene Versionen
9. **Indexformat ohne Vollparse** (SQLite/FTS5 oder mmap) — erst ab
   realen 50 000 Eintraegen.
10. **Entitaets-Kanten** (`works_on`, `depends_on`) auf der
    Entitaetsschicht, nie auf der Eintragsschicht.
11. **Rangdaempfung fuer lange Unzitiertes.**
12. **Projektspezifischer Spickzettel** in der Art von Dynamic
    Cheatsheet / ACE.

### Nicht passend fuer cheap-mem
- Usage Tracking (`times_retrieved`, `last_used`) — bricht „Git als
  Wahrheit", belohnt Popularitaet.
- Modellgesetzte `importance`/`confidence` — unkalibrierbar,
  unvergleichbar.
- Decay als Loeschen oder Archivieren — bricht append-only.
- Ein echter Graphspeicher (Neo4j/FalkorDB) — bricht Local First,
  Lesbarkeit, „keine unnoetige Infrastruktur".
- LLM-Aufloesung pro Fakt wie bei Mem0 — bricht Tokeneffizienz und
  Modellunabhaengigkeit.
- Bi-Temporalitaet als zweite Achse — beeindruckend, loest kein Problem,
  das hier existiert.

---

## Teil 5 — Roadmap

### cheap-mem 1.x — „Was gebaut ist, soll auch wirken"
Kein neues Konzept. Die Wette der Reihe: cheap-mem hat mehr Faehigkeiten
als Nutzung, und die Luecke dazwischen ist billiger zu schliessen als
jede neue Faehigkeit.

- Wirkungsmessung der Hausregeln (schreibt ein Fremdagent von selbst?)
- die sechs fehlenden Werkzeuge an die MCP-Bruecke
- `standing()` als Rangfaktor, gemessen
- Verwerfungs-Begruendungen in die Doku
- Dublettenrate messen

*Begruendung:* heute wurde belegt, dass eine Faehigkeit ohne Anlass keine
Faehigkeit ist. Fuer die Erreichbarkeit gilt dasselbe eine Stufe
haerter: `mem links` ist gebaut, getestet und dokumentiert — und fuer
jeden Agenten ausser einer Claude-Code-Sitzung mit Shell schlicht nicht
vorhanden.

### cheap-mem 2.x — „Dinge statt Woerter"
Der einzige echte konzeptuelle Sprung, den ich empfehle.

- `entities.jsonl`: Personen, Projekte, Werkzeuge, mit Aliassen
- Abruf ueber Entitaet zusaetzlich zum Wort
- automatische Widerspruchs-Erkennung fuer `timeline`
- lokale Embeddings, falls die Messung aus 1.x sie rechtfertigt

*Begruendung:* das ist die eine Stelle, an der Mem0 und Graphiti
strukturell etwas koennen, was cheap-mem nicht kann. Alles andere kann es
schon, nur guenstiger. Und die kleine Form kostet keine Infrastruktur:
eine JSONL-Datei mehr, weiterhin lesbar, weiterhin in git.

### cheap-mem 3.x — „Gross und immer noch leise"
- Indexformat ohne Vollparse
- Entitaets-Kanten und Traversierung
- Rangdaempfung
- projektspezifischer Spickzettel

*Begruendung:* alles hier ist erst richtig, wenn ein realer Bestand die
Groesse hat, die es rechtfertigt. Vorher waere es Optimierung auf
Verdacht — und genau die Fehlerklasse, gegen die dieses Repo den ganzen
Sommer gebaut hat.

---

## Die Antwort auf die Schlussfrage

*Wie kann cheap-mem deutlich staerker werden, ohne seine Identitaet zu
verlieren?*

**Nicht durch mehr Konzepte.** Elf der siebzehn sind gebaut — und liegen
brach. `standing()` beeinflusst keine Rangfolge. `mem links`,
`mem experiences` und `mem topics` gibt es, aber kein angeschlossener
Agent kann sie aufrufen: von 35 CLI-Befehlen sind elf als
MCP-Werkzeuge verfuegbar. Und ein solcher Agent hat einen ganzen Tag
lang nichts geschrieben, obwohl er es durfte.

Das Muster ist ueberall dasselbe: **gebaut, aber nicht erreichbar von
dort, wo gearbeitet wird.**

Der groesste messbare Zugewinn liegt in **1.x** — Vorhandenes wirksam
machen. Der groesste konzeptuelle liegt in **2.x**, und zwar an genau
einer Stelle: cheap-mem kennt Woerter, aber keine Dinge. Ein Entitaets-
Layer in der kleinen Form (eine JSONL-Datei mit Aliassen, keine Datenbank,
keine LLM-Extraktion) schliesst den einzigen strukturellen Vorsprung, den
Mem0 und Graphiti wirklich haben — und kostet keines der zehn Prinzipien.

Alles andere, was diese Systeme koennen, kann cheap-mem bereits. Nur
guenstiger, lesbarer und ohne Server.

---

## Nachtrag 2 — Die Entitaets-These gemessen (2026-09-08)

Copilot hat auf den Bericht geantwortet, fair und mit zwei Einwaenden.
Einer davon trifft; der andere liess sich messen statt bestreiten.

### Was ich einraeume

**„cheap-mem hat Temporalitaet" heisst nicht „cheap-mem spielt in
Graphitis Liga".** Das ist richtig, und meine Formulierung „Graphitis
Kernidee, ohne Graph" war zu schmeichelhaft. `valid_from`/`valid_until`
ist EIN Baustein. Graphiti hat darueber hinaus Kanten-Ungueltigkeit als
Ableitungsregel, bi-temporales Schliessen, Entitaets-Traversierung und
einen Herkunftsgraphen. Ein Baustein ist keine Liga.

Umgekehrt gilt derselbe Satz aber auch: „Graphiti hat mehr Bausteine"
heisst nicht „Graphiti ist fuer diesen Bestand besser". Das war zu
messen — und ist es jetzt.

### Die Messung

Copilots Kernpunkt: **Entity Resolution** sei die eigentliche Luecke,
mit dem Standardbeispiel `Lukas = Lucky = die Mailadresse`. Ich hatte
in Teil 2 dasselbe Beispiel benutzt. Gemessen an lucky-mem, 1070
verdichteten Eintraegen (`scratchpad/alias.mjs`, rein lesend):

| Entitaet | Nennungen | haeufigste Schreibweise deckt |
|---|---:|---:|
| Person Lucky | 394 (`lucky`) / 14 (`hauenstein`) / 12 (`luckyno777`) / **1** (`lukas`) | **94 %** |
| Projekt cheap-mem | 196 | **100 %** |
| VM diggi | 291 | **100 %** |
| Agent Bibliothekar | 138 / 1 (`librarian`) | **99 %** |
| MCP-Bruecke | 12 (`mcp-bruecke`) / 9 (`mcp-server`) / 7 (`mem-mcp`) | **43 %** |

**Das Standardbeispiel ist hier ein Nichtproblem.** `lukas` kommt in
1070 Eintraegen genau **einmal** vor. Personen, Projekte und Maschinen
tragen im gewachsenen Bestand faktisch schon einen kanonischen Namen —
niemand musste das durchsetzen, es ist von selbst passiert.

**Wo es real ist, sind Bauteile.** Die MCP-Bruecke heisst dreimal
verschieden, und keine Schreibweise hat die Mehrheit. Genau dort
zerfaellt der Bestand.

Zwei Gegenproben:

- `mem finde "lukas"` liefert **einen** Treffer. Die anderen 393
  Lucky-Eintraege sind unsichtbar. Der Alias-Mangel ist also am
  Frageende real, auch wenn er am Bestandsende klein ist.
- `mem finde "mcp bridge"` — eine Schreibweise, die **null** Mal im
  Bestand steht — findet die `mcp-bruecke`-Eintraege trotzdem
  (Punktzahl 8,8). Thesaurus und Kompositazerlegung ueberbruecken
  einen Teil schon heute, ohne Graph.

### Was daraus folgt — schaerfer als beide Vorfassungen

Der eine Treffer auf `lukas` ist der Eintrag **„Luckys buergerlicher
Vollname"**. Das heisst: *das Gedaechtnis weiss, dass Lukas und Lucky
dieselbe Person sind.* Es steht als Inhalt drin. Es ist nur nicht
benutzbar, weil kein Abruf einen Eintrag als Regel lesen kann.

Das ist die praezise Fassung der Luecke, und sie ist kleiner und
billiger als „cheap-mem braucht Entity Resolution":

> Ein Entitaets-Layer wuerde diesem Gedaechtnis **kein neues Wissen**
> geben. Er wuerde vorhandenes Wissen **operativ** machen.

Damit aendert sich die Empfehlung fuer 2.x in zwei Punkten:

1. **Nicht bei Personen anfangen, sondern bei Bauteilen.** Dort ist der
   Zerfall gemessen (43 %), bei Personen nicht (94 %).
2. **Der Layer muss aus dem Bestand gefuettert werden koennen**, nicht
   von Hand: die Identitaetsaussagen liegen schon als Eintraege da. Ein
   Verdichterlauf, der sie einsammelt, ist billiger als ein gepflegtes
   Register — und bleibt append-only, weil das Register eine Ableitung
   ist, keine Quelle.

### Zu „welches Paradigma ist langfristig das maechtigste"

Copilot sieht dort weiterhin Graphiti, Engram und Mem0 vorn. Dazu drei
Anmerkungen, ohne Anspruch, ihn zu widerlegen:

**Die Generationenleiter ist eine Taxonomie, keine Rangfolge.** Text →
Fakt → Entitaet → temporaler Graph beschreibt zunehmende *Struktur*.
Dass zunehmende Struktur zunehmende *Maechtigkeit* bedeutet, ist die
eigentliche Behauptung — und sie stimmt nur, solange man den Preis der
Struktur nicht mitzaehlt. Bei Graphiti und Mem0 ist dieser Preis ein
Modell in der Aufnahmeschleife. Das ist genau die Groesse, die
cheap-mem minimiert; es ist kein Feature, das fehlt, sondern eines, das
abgelehnt wurde.

**„Maechtigste" ohne Bestand und Budget ist nicht pruefbar.** Bei
10 Millionen Fakten und einem Team hat Graphiti recht. Bei 1070
Eintraegen, einer Person und einem Browser-SSH auf dem Handy zahlt man
einen Server und einen Modellaufruf pro Fakt fuer eine Traversierung,
die BM25 mit Thesaurus schon zu 8,8 Punkten hinbekommt. Beide Saetze
koennen wahr sein.

**Zur Note.** 6,5 → 7,8–8,2 ist freundlich, aber es ist eine Zahl ohne
Skala und ohne Messvorschrift — und damit genau das, was
`authority.mjs` an `confidence`-Feldern ablehnt: „eine Zahl, die
niemand kalibrieren kann, wird zu einem Wert, den jeder auf ‚wird schon
passen' rundet." Nuetzlicher waere: *welche Frage kann System A
beantworten, die System B nicht beantworten kann?* Fuer die
Entitaets-Frage steht die Antwort jetzt oben, mit Zahlen.

### Wo Copilot uneingeschraenkt recht behaelt

Seine Einordnung von cheap-mem als **Fact-Store** stimmt, und sie ist
nuetzlicher als jede Note. Die Kategorien beschreiben, wofuer ein System
gebaut ist, statt sie auf einer Achse zu sortieren. Und sein Satz, dass
seine Analyse Architektur- und keine Code-Forensik war, ist eine
Praezision, die ich mir bei meinem eigenen Nachtrag 1 haette sparen
koennen, haette ich sie vorher gehabt.

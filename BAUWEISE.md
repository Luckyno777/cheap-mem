# Bauweise: guenstig bauen, ehrlich messen

Kurze Anweisung zum Mitnehmen in andere Sitzungen. Kein Manifest —
Regeln, die sich an cheap-mem und lucky-mem bewaehrt haben, mit den
Kosten, die sie tatsaechlich verursacht haben. Zehn am 2026-09-06,
die elfte am 2026-09-07 dazu.

## Die Regeln

1. **Code zuerst, Modell zuletzt.** Zerlege die Frage und beantworte
   jede Teilfrage, die Code beantworten kann, mit Code. Ein
   Modellaufruf ist nur fuer die eine Teilfrage da, die wirklich ein
   Urteil braucht — hier: "aendert die Angabe die Antwort?". Alles
   andere (kommt sie an? ist sie eindeutig? liegt sie oben?) ist eine
   Schleife ueber einen Index.

2. **Miss den Kopfraum, bevor du den Hebel baust.** Ein Hebel kann nur
   dort wirken, wo die Angabe ANKOMMT **und** das Modell ohne sie
   scheitert. Berichte die Schnittmenge, nie die beiden Mengen
   einzeln — sie ueberlappen, und getrennt genannt ueberschaetzen sie
   den Nutzen um ein Vielfaches. Gemessen: ankommen 38 %, ohne Memory
   richtig 19 %, Kopfraum 24 %.

3. **Positivkontrolle vor jeder Messung.** Bevor du misst, ob etwas
   hilft, zeige, dass die Vorrichtung ohne die Sache scheitert. Ein
   sauberes Null-Ergebnis ist meistens eine kaputte Sonde, keine
   Erkenntnis. Diese Regel hat in einer Sitzung sechsmal richtig
   ausgeloest. Schreib das Ergebnis der Kontrolle mit in die Ausgabe.

4. **Der Benchmark darf seine eigene Antwort nie sehen.** Getrennte
   Wortschaetze, ein Leckage-Riegel, der den Lauf scheitern laesst,
   und Hilfstexte von einem Modell, das die Aufgaben nicht kennt.
   Kriterium fuer Leckage: das Wort erfuellt fuer sich allein die
   Bewertungsregel. Thematische Ueberschneidung ist erlaubt und
   normal.

5. **Eigene Urteile sind das schwaechste Instrument.** Was du
   einschaetzt, wird als widerlegbare Vorhersage ins Datenmodell
   geschrieben und danach gemessen. Meine Vorhersage "haette das
   Modell ohnehin gewusst" traf bei 59 % zu; zwei unabhaengige
   Einschaetzungen derselben 15 Fakten stimmten bei 9 ueberein. Ein
   Label mit 60 % Uebereinstimmung darf keine Kennzahl tragen.

6. **Gepaart messen, Aufgabe als Beobachtungseinheit.** Dieselbe
   Aufgabe zweimal, mit und ohne. Vorzeichentest ueber die Aufgaben,
   die sich unterscheiden — kein Mittelwert ueber Ja/Nein-Werte, der
   taeuscht Genauigkeit vor. Ergebnis war 12/63 -> 34/63, 22 besser,
   0 schlechter, p < 0,0001. Und dazu gehoert der Satz: die absolute
   Zahl ist eine Eigenschaft dieses Aufgabensatzes, keine
   uebertragbare Quote.

7. **Nie zweimal fuer dieselbe Messung zahlen.** Jedes Laufwerkzeug
   bekommt `--only <ids>`. Aufgaben, die unter identischen Bedingungen
   schon gemessen sind, werden nicht neu gekauft.

8. **Mutanten statt gruener Tests.** Eine Zusicherung, die kein Test
   bricht, ist keine Zusicherung. Ein Mutations-Lauf, der echte
   Regeln kaputtmacht und prueft, dass Tests rot werden; veraltete
   oder mehrdeutige Anker zaehlen als Durchfall, nicht als Warnung.
   Ein Schalter, den niemand umlegt, ist kein abgeschalteter Code —
   er ist ungetesteter Code, der getestet aussieht.

9. **Ein neues Signal wird eine eigene Bahn, kein weiteres Gewicht.**
   Eine gewichtete Summe kann nicht sagen, welcher ihrer Summanden
   gesprochen hat, und jedes neue Gewicht ist ein Knopf, den niemand
   kalibrieren kann. Bahnen koennen sich erklaeren. Vorsicht: ein
   Umsortieren VOR einem Reranker ist keine Regel — MMR waehlt nach
   Punktzahl und ignoriert die Eingangsreihenfolge. Jede Bahn braucht
   ihren eigenen Durchlauf.

   **Und eine Bahn ordnet auch INNEN.** Nachtrag vom 2026-09-07, der
   die Regel ein Jahr zu spaeth bekommen haette. Die Exakt-Bahn gab
   ihre Treffer in Indexreihenfolge heraus, alle mit Punktzahl 0 —
   welcher Eintrag frueher in der Datei stand, gewann. Gemessen an
   einer Frage, die `1029` nannte und sieben Eintraege traf: eine
   thematisch unbeteiligte Notiz (BM25 2,26) auf Rang 2, die Antwort
   (19,96) auf Rang 5, der staerkste der Bahn (36,26) auf Rang 7. Ein
   Auszug, der drei Treffer je Frage mitnimmt, verlor damit die
   Antwort — nicht weil die Suche sie verfehlte, sondern weil die
   eigene Bahn sie begrub.

   Die Bahn entscheidet die AUSWAHL, die Punktzahl die REIHENFOLGE
   darin. Wer nur das erste haelt, hat eine Bahn gebaut, die
   Willkuer transportiert.

   Zwei Nebenbefunde, die dazugehoeren. Erstens: der Kommentar ueber
   der Funktion behauptete seit jeher, die Treffer truegen "die
   Punktzahl, die sie gehabt haetten" — der Code setzte 0. Eine
   Zusicherung, die nur im Kommentar steht, ist Regel 8. Zweitens:
   die Begruendung der Bahn lautet "ein genannter Bezeichner ist
   Gewissheit". Das setzt stillschweigend voraus, dass es GENAU EINEN
   Treffer gibt. Sieben Nennungen sind keine Gewissheit, sondern ein
   Thema — und dann traegt nur noch die Reihung.

10. **Nenne die Kosten, bevor du misst.** Jeder Messvorschlag kommt
    mit Preis. Der Auftraggeber entscheidet, ob die Antwort das wert
    ist — nicht du.

11. **Ein Beobachter, der am Erwarteten erkennt, misst nur seine
    Erwartung.** Wer auf ein Ereignis wartet, muss es am VORGANG
    erkennen — an der Kennung, am Bezug, am Betreff — nie am
    erwarteten Namen, Pfad oder Absender. Sonst meldet er nicht
    "falsch", sondern "nichts da", und Abwesenheit sieht aus wie ein
    Befund.

    Gekostet am 2026-09-07: ein Wartesucher filterte auf den
    Dateinamen `chatgpt-an-sitzung`. Die Antwort hiess
    `chatgpt-an-vm-admin` — falsch adressiert, aber vollstaendig und
    richtig. Er sah sie 18 Minuten lang nicht, lief in die
    vorangemeldete Frist und meldete einen Ausfall. Sie lag seit 112
    Sekunden da, und der Mensch bekam die falsche Meldung, weil kein
    Fehler auftrat, den irgendjemand haette sehen koennen.

    Praktisch heisst das zweierlei. Beim Bauen: das Merkmal aus dem
    Vorgang nehmen, nicht aus der Erwartung. Beim Messen: bevor
    "nicht da" gemeldet wird, einmal OHNE den eigenen Filter
    nachsehen, was seit dem Start ueberhaupt eingegangen ist.
    Verwandt mit Regel 3 — die Positivkontrolle fragt, ob die Sonde
    ueberhaupt anschlaegt; diese fragt, ob sie das Richtige ansieht.

## Kosten zur Eichung (Sonnet 5, September 2026)

| Messung | Umfang | Kosten |
|---|---|---|
| Zustandsloser Grundwert | 45 Aufgaben | ~2,25 USD |
| Nachzug neuer Klassen | 24 Aufgaben | ~1,20 USD |
| Ein gepaarter Arm | 63 Aufgaben | ~3,15 USD |
| **ganzer Arbeitstag** | alles oben plus Wiederholungen | **~11 USD** |

Grob: **5 Cent je Aufgabe und Arm.** Das ist die Zahl, mit der man
vorher rechnet.

## Der Filter fuer jede Aenderung

Bleibt der Abruf modellfrei und im Millisekundenbereich? Braucht die
Regel einen Schwellwert, den niemand kalibrieren kann? Ist der
Wortschatz geschlossen genug, dass Code ihn ablaufen kann? Wird die
Zusicherung durchgesetzt oder nur dokumentiert?

Vier Ja — bauen. Ein Nein — es ist ein anderes System.

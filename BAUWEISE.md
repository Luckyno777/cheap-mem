# Bauweise: guenstig bauen, ehrlich messen

Kurze Anweisung zum Mitnehmen in andere Sitzungen. Kein Manifest —
zehn Regeln, die sich am 2026-09-06 an cheap-mem bewaehrt haben, mit
den Kosten, die sie tatsaechlich verursacht haben.

## Die zehn Regeln

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

10. **Nenne die Kosten, bevor du misst.** Jeder Messvorschlag kommt
    mit Preis. Der Auftraggeber entscheidet, ob die Antwort das wert
    ist — nicht du.

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

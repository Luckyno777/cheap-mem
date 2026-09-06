// eval/frageworte.mjs — die Frageworte, wie der Fasser sie schreiben wuerde.
//
// HERKUNFT, und sie entscheidet ueber den Wert jeder Zahl daraus: diese
// Woerter stammen aus einem getrennten Modelllauf (Sonnet 5), der NUR die
// Korpus-Eintraege gesehen hat — Thema, Festlegung, Grund — und keine
// einzige Aufgabe. Genau die Lage, in der der Fasser im Betrieb steht.
//
// Haette ich sie aus `vokB` abgeschrieben, dem Wortschatz der Aufgaben,
// stuende die Antwort im Korpus und der Abruf haette nichts mehr zu tun.
// Der Benchmark haette dann seine eigene Vorlage gemessen. Das ist keine
// theoretische Sorge: genau diese Klasse von Selbstbestaetigung hat
// dieses Verzeichnis schon dreimal erwischt (siehe README).
//
// Die Auflage an den Lauf war eng: hoechstens fuenf Woerter, keins davon
// im Eintrag selbst, keine erfundenen Tatsachen, lieber weniger als
// aufgefuellt.
//
// UND EIN RIEGEL DANACH, den der Lauf nicht kennen konnte. Von 31
// Eintraegen trugen 13 ein Wort, das die BEWERTUNGSREGEL einer Aufgabe
// erfuellt: "cookie" gegen /keks|cookie|sitzung/, "textdatei" gegen
// /datei/, "backup" gegen /backup|sicherung/, "ticket" gegen
// /sammelpostfach|ticket/. Solche Woerter sind keine Frageworte, sondern
// die Antwort — stehen sie im Korpus, misst der Benchmark sich selbst.
//
// `sicher()` wirft sie heraus, und test/frageworte.test.mjs haelt fest,
// dass keins durchkommt.
//
// WAS DIESER RIEGEL KOSTET, offen gesagt: im Betrieb gibt es keine
// Bewertungsregel, und der Fasser DARF dort "cookie" schreiben — es ist
// ja das richtige Suchwort. Die hier gemessene Wirkung ist deshalb eine
// UNTERGRENZE. Sie zu ueberschaetzen waere schlimmer.
import { TASKS } from './tasks.mjs';

/**
 * Frageworte ohne die, die eine Bewertungsregel erfuellen.
 *
 * Geprueft wird gegen ALLE Aufgaben, nicht nur die eigene: ein Wort, das
 * die Antwort einer fremden Aufgabe traegt, zieht diesen Eintrag in
 * deren Trefferliste und verfaelscht sie genauso.
 */
export function sicher(id) {
  const roh = FRAGEWORTE[id] ?? [];
  return roh.filter((w) => !TASKS.some(
    (t) => t.gold?.length && t.must.length && t.must.every((re) => re.test(w))));
}

export const FRAGEWORTE = {
  'F-tz': ['uhrzeit', 'datumsformat', 'weltzeit', 'verwechslung', 'anzeige'],
  'F-idem': ['doppelklick', 'retry', 'header', 'zweimal', 'mehrfach'],
  'F-deploy': ['docker-compose', 'hosting', 'server', 'dienststart', 'produktivbetrieb'],
  'F-sprache': ['anrede', 'du-form', 'amtsdeutsch', 'tonfall', 'beschriftung'],
  'F-db': ['speicherung', 'git', 'wartungsaufwand', 'textdatei', 'server'],
  'F-auth': ['login', 'cookie', 'session', 'localstorage', 'sperren'],
  'F-port-neu': ['healthcheck', 'loadbalancer', 'monitoring', 'verfuegbarkeit'],
  'F-retention-neu': ['loeschfrist', 'dsgvo', 'speicherdauer', 'retention'],
  'F-konflikt-a': ['upload', 'foto', 'limit', 'handynetz'],
  'F-lockin': ['export', 'tabelle', 'download', 'spreadsheet'],
  'F-backup': ['backup', 'wiederherstellung', 'datenverlust', 'snapshot', 'nachts'],
  'F-mail': ['email', 'benachrichtigung', 'digest', 'spam', 'haeufigkeit'],
  'F-fehler': ['errorcode', 'stacktrace', 'telefon', 'verstaendlich', 'code'],
  'F-tarif-neu': ['abo', 'gebuehr', 'tarif', 'zahlung'],
  'F-freigabe': ['review', 'genehmigung', 'approval', 'kontrolle'],
  'F-pfad': ['canary', 'test', 'monitoring', 'dateipfad', 'ort'],
  'F-vorgang': ['ticket', 'lock', 'deadlock', 'fehlerfall', 'referenz'],
  'F-dienst': ['cron', 'scheduler', 'timer', 'uhrzeit', 'isoliert'],
  'F-fassung': ['version', 'pdf', 'layout', 'pinning', 'template'],
  'F-timeout-neu': ['timeout', 'haengt', 'upload', 'wartezeit', 'foto'],
  'F-kontingent-neu': ['rate-limit', 'api', 'limit', 'batch', 'drosselung'],
  'F-meldeweg-neu': ['alarm', 'eskalation', 'bereitschaft', 'oncall'],
  'F-sortierung-neu': ['reihenfolge', 'liste', 'aktualitaet', 'uebersicht'],
  'F-frist-neu': ['einspruch', 'reklamation', 'abrechnung', 'deadline'],
  'F-skonto-neu': ['rabatt', 'fruehzahler', 'nachlass', 'anreiz'],
  'F-modul': ['kaufmaennisch', 'centbetrag', 'zentral', 'dateipfad', 'berechnung'],
  'F-ticket': ['ticket', 'duplikat', 'fehlerbericht', 'log'],
  'F-behaelter': ['mailqueue', 'isoliert', 'ausfall', 'warteschlange'],
  'F-ablageformat': ['version', 'csv', 'migration', 'kompatibilitaet'],
  'F-variable': ['umgebungsvariable', 'env', 'pfad', 'ablageort', 'temp'],
  'F-zweig': ['branch', 'git', 'langzeitunterstuetzung', 'lts'],
};

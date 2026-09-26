// eval/query-words.mjs — the query words, the way the digester would write them.
//
// PROVENANCE, and it decides the worth of every number drawn from this:
// these words come from a separate model run (Sonnet 5) that saw ONLY
// the corpus entries — topic, decision, reason — and not a single task.
// Exactly the position the digester is in during real operation.
//
// Had I copied them from `vokB`, the tasks' vocabulary, the answer would
// sit in the corpus and retrieval would have nothing left to do. The
// benchmark would then be measuring its own template. That is not a
// theoretical worry: this exact class of self-confirmation has already
// caught this directory out three times (see README).
//
// The constraint on the run was tight: at most five words, none of
// them in the entry itself, no invented facts, fewer rather than padded
// out.
//
// AND ONE MORE GUARD AFTERWARD, one the run could not have known about.
// Of 31 entries, 13 carried a word that satisfies a task's SCORING RULE:
// "cookie" against /keks|cookie|sitzung/, "textdatei" against /datei/,
// "backup" against /backup|sicherung/, "ticket" against
// /sammelpostfach|ticket/. Words like that are not query words but the
// answer — if they sit in the corpus, the benchmark measures itself.
//
// `safeWords()` throws them out, and test/query-words.test.mjs records
// that none gets through.
//
// WHAT THIS GUARD COSTS, said plainly: in real operation there is no
// scoring rule, and the digester MAY write "cookie" there — it is, after
// all, the right search word. The effect measured here is therefore a
// LOWER BOUND. Overestimating it would be worse.
import { TASKS } from './tasks.mjs';

/**
 * Query words minus the ones that satisfy a scoring rule.
 *
 * Checked against ALL tasks, not just the entry's own: a word that
 * carries another task's answer pulls this entry into that task's hit
 * list too, and falsifies it just the same.
 */
export function safeWords(id) {
  const roh = QUERY_WORDS[id] ?? [];
  return roh.filter((w) => !TASKS.some(
    (t) => t.gold?.length && t.must.length && t.must.every((re) => re.test(w))));
}

export const QUERY_WORDS = {
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

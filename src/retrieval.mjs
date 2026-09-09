// src/retrieval.mjs — the gateway. Structured claims out, never prose.
//
// Named in the round-two audit as the single change with the largest
// effect, because one change addresses four failure classes at once:
//
//   injection      nothing here emits a directive-shaped string. A caller
//                  who wants prose has to build it, at their own
//                  authority, from fields that are labelled.
//   authority      the tier is present where ranking and conflict
//                  decisions happen, instead of being looked up later or
//                  not at all.
//   scope leakage  the boundary travels WITH the result rather than being
//                  an argument someone forgot.
//   explainability the reasons are already computed; returning them costs
//                  nothing and there is no model involved.
//
// `search()` stays exactly what it was: a ranker over an index. This is
// the layer above it that decides what a caller is allowed to see, and it
// fails closed — no capability, no results.

import crypto from 'node:crypto';
import * as authority from './authority.mjs';
import { deriveState, statusOf } from './state.mjs';
import * as capabilityMod from './capability.mjs';
import { loadIndex, search, isEchoHit, exactHits, corpusGeneration } from './search.mjs';

/**
 * Resource bounds (I13). Defaults, not laws — but never unbounded.
 *
 * An unbounded default is how one oversized claim becomes an oversized
 * context, and how one prolific author becomes the whole answer. Each
 * number below is a policy; having one at all is the point.
 */
export const LIMITS = Object.freeze({
  queryChars: 2000,        // a query longer than this is a paste, not a question
  maxResults: 50,          // hard ceiling regardless of what a caller asks for
  bodyChars: 4000,         // per claim, in the RETURNED record only
  contextChars: 24000,     // total across all returned bodies
  perAuthorShare: 0.5,     // no single sub-user author may exceed this share
});

/**
 * How much of the search space this answer actually covered.
 *
 * **Why an answer needs this at all.** "Nothing found" and "nothing
 * exists" are different sentences, and only one of them is ever
 * provable from a ranked search. Until now the gateway returned
 * `truncated: true|false` — two states for a three-state question, and
 * the missing third is the one that matters: *we could not establish
 * what the search space was.*
 *
 * The rule this encodes, in one line:
 *
 *     found evidence  ≠  complete evidence
 *     no finding      ≠  proof of absence
 *
 * **`known_complete` does NOT mean "X does not exist".** It means: no
 * limit cut this answer, so within THIS memory and THIS query nothing
 * known was withheld. A different query would ask a different question.
 * Anyone turning a complete answer into "there is no such thing" has
 * made a claim the memory never made.
 *
 * Deliberately not a number. A coverage score would invite comparing
 * 0.8 against 0.9, and neither would say WHICH limit bit. `reasons`
 * names them.
 */
export const COVERAGE = Object.freeze({
  COMPLETE: 'known_complete',   // no limit bit; everything matching was returned
  PARTIAL: 'known_partial',     // something was cut, and we know what
  UNKNOWN: 'unknown_coverage',  // the search space could not be established
});

/**
 * Decide the coverage from what actually happened during the retrieval.
 *
 * Order matters: UNKNOWN beats PARTIAL beats COMPLETE. A run that could
 * not establish its search space must never report a mere partial —
 * that would read as "we looked and found some", when we did not look.
 */
export function coverageOf({ reasons = [] } = {}) {
  const unknown = reasons.filter((r) => r.kind === 'unknown');
  if (unknown.length) return { state: COVERAGE.UNKNOWN, reasons };
  if (reasons.length) return { state: COVERAGE.PARTIAL, reasons };
  return { state: COVERAGE.COMPLETE, reasons: [] };
}

/** A claim as it leaves the memory. Fields only — no assembled text. */
function toClaim(hit, { bodyChars, state }) {
  const e = hit.entry;
  const body = bodyOf(e);
  const truncated = body.length > bodyChars;

  // Status comes from the LOG, via deriveState — never from the index.
  //
  // Two bugs, one lesson. The first version recomputed status from the
  // returned HITS, so a retirement whose line did not match the query was
  // invisible. The second read it from `doc.retired` in the index, which
  // is correct over the whole corpus but lives in `.mem/search-index.json`
  // — gitignored, unsigned, outside the merge driver, outside the epoch
  // watermark, invisible to git review. Editing that file changed what the
  // memory considered active, both ways: a disputed poisoning claim served
  // as active, and a genuine user claim suppressed. Measured 2026-09-05.
  //
  // A cache had become the source of truth about MEANING, not speed. So:
  //
  //   the log decides what is TRUE
  //   the index decides only what is FAST TO FIND
  //
  // 174 ms per derivation at 100 000 entries — the same order as the
  // search it accompanies, and three orders of magnitude above the corpus
  // this was built for. Correctness is worth that; the alternative is a
  // security rule guarded by an unsigned local file.
  const claimState = statusOf(state, e.id);
  return {
    id: e.id ?? null,
    type: e.type ?? hit.type ?? null,
    body: truncated ? body.slice(0, bodyChars) : body,
    bodyTruncated: truncated,
    author: authority.authorOf(e),
    authority: authority.tierOf(e),
    scope: capabilityMod.scopeOf({ project: hit.project ?? e.project ?? null }),
    project: hit.project ?? e.project ?? null,
    topic: e.topic ?? null,
    // Welche Bezeichner die Frage woertlich getroffen hat. Vorhanden
    // heisst: dieser Anspruch steht nicht wegen einer Punktzahl hier,
    // sondern weil die Frage seinen Namen genannt hat. Wer eine Schwelle
    // anwendet, muss ihn davon ausnehmen — sonst schneidet die Schwelle
    // fuer Aehnlichkeit die Gewissheiten weg.
    ...(hit.exact ? { exact: hit.exact } : {}),
    ts: e.ts ?? null,
    valid_from: e.valid_from ?? null,
    valid_until: e.valid_until ?? null,
    status: claimState,
    score: hit.score,
  };
}

/**
 * The text of an entry, assembled from its own fields in a fixed order.
 *
 * Note what this is NOT: it does not add framing, headings, or any word
 * the entry did not contain. A memory that decorates its own content is a
 * memory that can be made to say something.
 */
function bodyOf(e) {
  const parts = [e.choice, e.why, e.title, e.text, e.fact].filter(
    (x) => typeof x === 'string' && x.trim());
  return parts.join(' — ');
}

/** Is a claim valid at `asOf`? Absent bounds mean open-ended. */
export function validAt(claim, asOf) {
  if (!asOf) return true;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return true;
  const from = claim.valid_from ? Date.parse(claim.valid_from) : null;
  const until = claim.valid_until ? Date.parse(claim.valid_until) : null;
  if (Number.isFinite(from) && t < from) return false;
  // `valid_until` is EXCLUSIVE: a claim valid until the 1st does not hold
  // on the 1st. Stated because half of all interval bugs are this choice
  // left unstated.
  if (Number.isFinite(until) && t >= until) return false;
  return true;
}

/**
 * Retrieve claims a capability is entitled to see.
 *
 * Returns a structure. Every exclusion is recorded with a reason, because
 * "why was this NOT returned" is the question no memory system answers and
 * the one an agent developer actually has.
 */
export function retrieve(root, query, capability, {
  top = 10,
  asOf = null,
  type = null,
  withDisputed = false,
  limits = LIMITS,
  index = null,
  // Paging. `cursor` wins over a bare `offset` — it carries the
  // generation, and a page that cannot prove which snapshot it belongs
  // to is not a page.
  cursor = null,
  // Vorgabe wie in `mem find`. Ueberschreibbar, damit ein Aufrufer, der
  // reine Relevanzreihenfolge will, sie bekommt — und damit ein Test beide
  // Wege vergleichen kann.
  mmr = true,
  mmrLambda = 0.7,
  // Echos verwerfen: ein Treffer, der im Wesentlichen die Frage selbst ist.
  //
  // isEcho existiert seit dem 2026-09-05, ist getestet und mit einer
  // Messung begruendet (13 von 18 eingespeisten Treffern waren Echos) —
  // und wurde von NICHTS aufgerufen. In `mem find` steckt es hinter
  // `--no-echo`, das niemand setzt; der Abruf-Hook, der die 13/18 gemessen
  // hat, setzt es auch nicht. Die Abwehr gegen das gemessene Problem war
  // toter Code.
  //
  // Vorgabe an, weil der Gateway der automatische Pfad ist: dort kann
  // niemand eingreifen, und ein Block, der einem die eigene Frage
  // zurueckgibt, wird nach dem dritten Mal ueberlesen — und dann ist der
  // ganze Abruf weg.
  dropEcho = true,
  rawReserve = true,
} = {}) {
  const excluded = [];
  const note = (id, why) => excluded.push({ id: id ?? null, why });

  // Fail closed. Not a thrown error: a caller with no capability asking a
  // question should get an empty, explained answer rather than a stack
  // trace it might log somewhere with the query in it.
  if (!(capability instanceof capabilityMod.Capability)) {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'no capability presented' }],
      scopes: [], truncated: false, limits,
      // Not "complete": nothing was searched. An empty answer that
      // reports full coverage is the exact lie this field exists against.
      coverage: coverageOf({ reasons: [{ kind: 'unknown', why: 'no capability presented' }] }),
    };
  }
  if (!capability.has('read')) {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'capability does not carry read' }],
      scopes: capability.scopes, truncated: false, limits,
      coverage: coverageOf({ reasons: [{ kind: 'unknown', why: 'capability does not carry read' }] }),
    };
  }

  const q = String(query ?? '');
  const qCapped = q.length > limits.queryChars;
  const useQuery = qCapped ? q.slice(0, limits.queryChars) : q;

  const idx = index ?? loadIndex(root);
  const want = Math.min(Math.max(1, Number(top) || 1), limits.maxResults);

  // Die Generation dieses Laufs. Sie bindet den Cursor an einen
  // Schnappschuss — siehe encodeCursor.
  const generation = corpusGeneration(root);
  // Ein Cursor wird ANGENOMMEN und abgelehnt, statt ignoriert zu werden.
  // Ein stilles Zurueckfallen auf Seite 1 waere eine Antwort auf eine
  // Frage, die niemand gestellt hat — und sie saehe aus wie Erfolg.
  if (cursor != null && cursor !== '') {
    return {
      query: null, claims: [], excluded: [{ id: null, why: 'paging is not offered' }],
      scopes: capability.scopes, truncated: false, limits, generation,
      hasMore: false,
      coverage: coverageOf({ reasons: [{
        kind: 'unknown',
        why: 'paging is not offered — ask again with a larger top (bounded by maxResults)',
      }] }),
    };
  }
  // **Die Auswahlgroesse ist `want`, und sie bleibt es.**
  //
  // Der Weg hierher ist der Punkt. Fuer seitenweises Blaettern hatte ich
  // sie erst auf `offset + want + 1` gestellt — das lieferte einen
  // Anspruch auf Seite 2 UND auf Seite 3, weil die Autoren-Quote und
  // das Kontext-Budget auf der AUSWAHL arbeiten, nicht auf dem Korpus:
  // andere Auswahlgroesse, andere Ueberlebende, verschobene Offsets.
  //
  // Dann auf `maxResults + 1` konstant — Seiten passten zusammen, und
  // VIER vorhandene Proben fielen. Es waren Positiv-Kontrollen: „aendert
  // MMR hier nichts, prueft der Vergleich nichts." Bei einer Auswahl von
  // 51 kommt auf einer kleinen Vorrichtung ohnehin alles herein, also
  // aenderte MMR die Auswahl nicht mehr. Und genau das ist MMRs Aufgabe
  // hier: es entscheidet, WER angeschaut wird (gemessen 7/18 -> 9/18 am
  // eval-Korpus). Dasselbe gilt fuer den Flutungs-Schutz, der am
  // 2026-09-05 aus einem echten Angriff kam.
  //
  // Also: eine gemessene Abwehr gegen ein Komfort-Merkmal getauscht,
  // still, und nur gefangen, weil die alten Proben Positiv-Kontrollen
  // waren. Zurueckgenommen. Was bleibt, ist die ehrliche Auskunft
  // `hasMore` — sie kostet nichts, weil sie aus dem Abbruch der
  // Auswahlschleife folgt statt aus einer groesseren Auswahl. Wer mehr
  // sehen will, fragt mit groesserem `top`; einen Cursor gibt es nicht,
  // weil er in diesem Entwurf nur mit einer Auswahl zu haben waere, die
  // von der Seite abhaengt.
  const selectWant = want;

  // Over-fetch, because scope, validity and quota all remove candidates
  // after ranking. Bounded by maxResults so this cannot become the DoS it
  // is meant to prevent.
  // Candidates are generated PER AUTHORITY TIER, then merged in tier order.
  //
  // The measured failure this fixes (bench/byzantine.mjs, 2026-09-05): a
  // writer who breaks no rule — own scope, own tier, no supersession,
  // every body distinct — wrote 20 000 plausible claims about one subject.
  // A single `user`-tier claim stating the truth was NOT RETURNED AT ALL.
  // It never entered the candidate set: sixty higher-scoring near-variants
  // filled it first, and no policy applied afterwards can recover a claim
  // that was never a candidate. The author-share cap could only halve an
  // answer that was already entirely the attacker's.
  //
  // Per-tier candidates give REPRESENTATION, not precedence: a `user`
  // claim that matches at all reaches the answer regardless of how much
  // lower-tier noise exists, and within the answer relevance still orders.
  // Precedence would be the other error — it would bury a genuine agent
  // finding under a stale user note. Tier decides only where claims
  // CONFLICT; here it decides only who gets looked at.
  //
  // `withRetired: true` on purpose. search() would otherwise drop
  // superseded and disputed claims itself, one layer down and without a
  // word — and then this gateway could not say WHY something is missing.
  const perTier = Math.min(selectWant * 6, limits.maxResults * 6);
  const seenIds = new Set();
  const byTier = [];
  // Every limit that actually bit, collected as it happens rather than
  // guessed at the end. A reason nobody recorded cannot be reported.
  const coverageReasons = [];
  if (qCapped) {
    // The whole question was not even asked. Nothing about the search
    // space follows from an answer to a truncated query.
    coverageReasons.push({ kind: 'unknown', why: `query truncated at ${limits.queryChars} chars` });
  }
  // Tiers whose candidate pool came back FULL. More may have matched
  // than were ever looked at, and no policy applied afterwards can
  // recover a claim that was never a candidate.
  const tiersAtCap = [];
  for (const tier of authority.TIERS) {
    const hits = [];
    // MMR an, mit demselben Lambda wie `mem find`.
    //
    // Bis 2026-09-06 stand hier nichts, und `search()` hat `mmr: false` als
    // Vorgabe. `bin/mem find` schaltet es ein — der Gateway nicht. Damit war
    // der AGENTENPFAD (mem retrieve, MCP mem_retrieve) schlechter als der
    // Menschenpfad: reine BM25-Reihenfolge, und zwoelf Fast-Duplikate
    // desselben Themas fuellen die Trefferliste, waehrend die Antwort auf
    // die eigentliche Frage darunter liegt.
    //
    // Gemessen am eval-Korpus: das gesuchte Claim war ohne MMR bei 7 von 18
    // Aufgaben in den top-5, mit MMR bei 9 von 18.
    //
    // Die Neuordnung wirkt auf die AUSWAHL, nicht auf die Ausgabe: unten
    // sortiert `.sort((a, b) => b.score - a.score)` wieder nach Relevanz.
    // MMR entscheidet also, WER angeschaut wird, die Punktzahl in welcher
    // Reihenfolge er erscheint — dieselbe Trennung wie beim Rundlauf ueber
    // die Autoritaetsstufen.
    for (const hit of search(idx, useQuery, {
      top: perTier, withRetired: true, authority: tier,
      mmr, mmrLambda,
    })) {
      const id = hit.entry?.id;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      hits.push(hit);
    }
    if (hits.length === perTier) tiersAtCap.push(tier);
    if (hits.length) byTier.push(hits);
  }

  // Interleave the tiers round-robin, THEN order the answer by score.
  //
  // Two wrong versions preceded this, and both are worth naming because
  // they are the two ways to get it wrong:
  //
  //   consuming tier by tier      -> PRECEDENCE. A less relevant user
  //                                  claim came out ahead of a more
  //                                  relevant agent one.
  //   flattening and sorting      -> no representation at all. The high
  //                                  scores of a flood fill every slot
  //                                  before a quieter tier is reached, so
  //                                  the truth is out again.
  //
  // Round-robin gives each tier a slot in turn — representation — while
  // the final sort keeps relevance in charge of the ORDER. Bounded: at
  // most one pass per tier per slot.
  const gereiht = [];
  for (let i = 0; byTier.some((h) => i < h.length); i += 1) {
    for (const hits of byTier) if (i < hits.length) gereiht.push(hits[i]);
  }

  // Die Exakt-Bahn, ganz vorn.
  //
  // Nennt die Frage `7318` und genau ein Eintrag enthaelt `7318`, ist das
  // keine Aehnlichkeit, sondern eine Gewissheit — und Gewissheit gehoert
  // nicht hinter eine Punktzahl gereiht. Gemessen an der Aufgabenklasse I
  // (Pfade, Vorgangsnummern, Dienstnamen, Fassungen): das Ranking war
  // schon richtig, fuenf von sechs auf Rang 1, aber JEDE Punktzahl lag
  // unter der Abrufschwelle 5,0 (0,95 bis 2,44). Nicht die Reihenfolge
  // blockierte diese Klasse, sondern die Schwelle.
  //
  // Die Bahn ist selbstbegrenzend: ein Bezeichner zaehlt nur, wenn er in
  // hoechstens `want` Dokumenten steht — also in so wenigen, dass sie
  // ohnehin alle in die Antwort passen. Kein freier Parameter.
  //
  // Doppelte fallen weiter unten heraus: die Auswahl kennt `seenIds`
  // nicht, aber die Koerper-Entdopplung greift, und ein Eintrag, der
  // ueber beide Bahnen kommt, ist derselbe Koerper.
  const exakte = exactHits(idx, useQuery, want);
  const exaktIds = new Set(exakte.map((h) => h.entry?.id).filter(Boolean));
  const raw = rawReserve
    ? [...exakte,
       ...gereiht.filter((h) => h.type !== 'raw' && !exaktIds.has(h.entry?.id)),
       ...gereiht.filter((h) => h.type === 'raw' && !exaktIds.has(h.entry?.id))]
    : [...exakte, ...gereiht.filter((h) => !exaktIds.has(h.entry?.id))];

  // Rohfang ist keine Autoritaetsstufe, sondern die Reserve-Bahn.
  //
  // Er landet in der Stufe 'unknown' und bekam damit im Rundlauf denselben
  // Platz pro Runde wie 'user'. Bei fuenf Plaetzen heisst das: ein einziger
  // Fang verdraengt einen gepflegten Anspruch. Und der Fang gewinnt das
  // Rennen fast immer — er ist lang, zusammengeklebt und enthaelt viele
  // Frageworte. Gemessen an C3: ein Fang mit 30,31 draengt die Antwort mit
  // 18,77 aus den top-5, obwohl er zu einer ANDEREN Frage gehoert und der
  // Echo-Filter ihn deshalb zu Recht in Ruhe laesst.
  //
  // Das kehrt den ganzen Entwurf um. Rohfang ist per Definition noch kein
  // Anspruch: der Fasser ist noch nicht darueber gelaufen. Ein
  // unverarbeitetes Gespraechsprotokoll VOR eine gepruefte Entscheidung zu
  // stellen, macht Bahn 1 zur Hauptbahn und den Fasser ueberfluessig.
  //
  // Also: erst alles Gepflegte, dann der Fang. Nicht "Fang raus" — auf
  // einer frischen Memory, ueber die der Fasser noch nie gelaufen ist, ist
  // er das einzige Material, und dann sind die Plaetze ohnehin frei.
  //
  // Der Preis, offen benannt und hier NICHT gemessen: steht eine Angabe
  // nur im Fang und liefert das Gepflegte fuenf mittelmaessige Treffer,
  // kommt der Fang nicht mehr durch. Der eval-Korpus kann das nicht
  // zeigen, weil dort alles Gold gepflegt ist.


  // Derived ONCE per call, from the log, with no query parameter. A
  // function that reads the log itself cannot be handed a subset — which
  // is how the first status bug happened.
  const state = deriveState(root);

  const claims = [];
  const seenBody = new Map();
  // Hat die Auswahl aufgehoert, WEIL die Seite voll war — und lagen
  // noch ungepruefte Kandidaten davor? Das ist die ehrliche Grundlage
  // fuer `hasMore`, und sie kostet keine groessere Auswahl.
  let stoppedEarly = false;
  let budget = limits.contextChars;

  for (const hit of raw) {
    const c = toClaim(hit, { bodyChars: limits.bodyChars, state });

    if (!capability.admits(c.scope)) { note(c.id, `outside capability (${c.scope})`); continue; }
    if (type && c.type && c.type !== type) { note(c.id, `wrong type (${c.type})`); continue; }
    if (c.status === 'disputed' && !withDisputed) { note(c.id, 'disputed supersession'); continue; }
    if (c.status === 'superseded') { note(c.id, 'superseded'); continue; }
    if (!validAt(c, asOf)) { note(c.id, `not valid at ${asOf}`); continue; }
    // In der Auswahl, nicht danach: nachtraeglich zu filtern kann nicht
    // zurueckholen, was der Schnitt schon verworfen hat. Derselbe Fehler
    // steckte in der ersten Fassung der Koerper-Entdopplung.
    // NUR Rohfang. Ein getippter Eintrag ist per Konstruktion nicht die
    // Frage des Nutzers — er ist durch den Fasser gegangen oder wurde
    // absichtlich abgelegt. Echos sind ein Lane-1-Artefakt.
    //
    // Ohne diese Einschraenkung faellt ein echter Anspruch: die Frage
    // "zahlung vorkasse entscheidung" gegen die Entscheidung "zahlung nur
    // per vorkasse — meine entscheidung" ergibt drei von vier
    // Inhaltswoertern, also 0,75 ueber der Schwelle 0,7 — und eine
    // Benutzerentscheidung waere unterdrueckt worden. Ein Test hat das
    // gefangen (state.test.mjs, "a tampered cache cannot suppress a
    // genuine claim"), bevor es jemand im Betrieb gemerkt haette.
    if (dropEcho && isEchoHit(useQuery, hit)) {
      note(c.id, 'echo of the question — answers nothing');
      continue;
    }

    // Deduplicate DURING selection, not after.
    //
    // Doing it afterwards was a real defect in the first version of this
    // function, found by attacking it: twenty identical claims under
    // twenty author names filled all ten slots, dedup then removed nine,
    // and the answer was a single flood claim with every genuine entry
    // gone. Filtering after a cutoff cannot restore what the cutoff
    // already discarded.
    const h = bodyHash(c.body);
    const first = seenBody.get(h);
    if (first) { note(c.id, `identical body to ${first}`); continue; }

    if (c.body.length > budget) { note(c.id, 'context budget exhausted'); continue; }
    seenBody.set(h, c.id);
    claims.push(c);
    budget -= c.body.length;
    if (claims.length >= selectWant) { stoppedEarly = true; break; }
  }

  // Relevance decides the ORDER of what was selected; the round-robin
  // above decided WHO got looked at.
  const fair = enforceAuthorShare(claims, limits, note)
    // Nach Punktzahl, bei Gleichstand nach Id.
    //
    // **Was der zweite Schluessel NICHT tut**, obwohl der erste
    // Kommentar hier das behauptete: er rettet die Reihenfolge nicht vor
    // Undefiniertheit. `Array.prototype.sort` ist seit ES2019 stabil,
    // Gleichstaende behalten also ihre Einfuegereihenfolge — und die
    // Sabotage hat das prompt gezeigt: den Schluessel zu entfernen liess
    // keine einzige Probe fallen.
    //
    // Was er tut: er macht die Ordnung unabhaengig davon, ueber WELCHE
    // Bahn ein Anspruch hereinkam. Die Einfuegereihenfolge stammt aus
    // dem Rundlauf ueber die Autoritaetsstufen und der Exakt-Bahn davor;
    // wer dort eine Bahn einfuegt oder umstellt, verschiebt sonst
    // stillschweigend jede Seitengrenze. Gemessen: bei sechs
    // Entscheidungen zum selben Thema haben alle sechs praktisch
    // dieselbe Punktzahl — Gleichstaende sind hier der Normalfall, nicht
    // die Ausnahme.
    //
    // Also: kein Riegel gegen Chaos, sondern die Zusicherung, dass die
    // Ordnung eine FUNKTION von (Punktzahl, Id) ist. Die Probe unten
    // prueft genau das.
    .sort((a, b) => (b.score - a.score) || String(a.id ?? '').localeCompare(String(b.id ?? '')));

  // Die Seite herausschneiden. `fair` traegt bis zu einem Anspruch mehr,
  // als die Seite fasst — genau der ist der Beleg fuer `hasMore`.
  // `hasMore` aus dem Abbruch der Auswahlschleife, nicht aus einer
  // groesseren Auswahl: die Schleife hat bei `want` aufgehoert, und es
  // lagen noch ungepruefte Kandidaten davor. Das kostet nichts und
  // behauptet nichts ueber ihre Zahl.
  const seite = fair;
  const hasMore = stoppedEarly && fair.length >= want;

  if (tiersAtCap.length) {
    coverageReasons.push({
      kind: 'partial',
      why: `candidate pool full at ${perTier} for tier(s): ${tiersAtCap.join(', ')}`,
    });
  }
  if (fair.length < raw.length) {
    coverageReasons.push({
      kind: 'partial',
      why: `${raw.length - fair.length} candidate(s) removed after ranking`,
    });
  }
  if (hasMore) {
    coverageReasons.push({ kind: 'partial', why: 'more claims match than fit on this page' });
  }
  if (fair.length > limits.maxResults) {
    // Die harte Decke ist erreicht. Wie viele darueber hinaus passen
    // wuerden, weiss dieser Lauf nicht — und darf es darum auch nicht
    // andeuten.
    coverageReasons.push({
      kind: 'partial',
      why: `the hard ceiling of ${limits.maxResults} results bounds this answer`,
    });
  }
  if (excluded.length) {
    coverageReasons.push({ kind: 'partial', why: `${excluded.length} claim(s) excluded` });
  }
  if (seite.some((c) => c.bodyTruncated)) {
    coverageReasons.push({ kind: 'partial', why: 'at least one body was cut to bodyChars' });
  }

  return {
    contested: potentialConflicts(seite),
    query: useQuery,
    queryTruncated: qCapped,
    scopes: capability.scopes,
    subject: capability.subject,
    claims: seite,
    excluded,
    truncated: fair.length < raw.length,
    // Die Generation des Korpus. Sie sagt einem Aufrufer, ob zwei
    // Antworten aus demselben Stand kommen — ohne dass daraus ein
    // Seitenzeiger wird, den dieser Entwurf nicht tragen kann.
    generation,
    hasMore,
    // Kept alongside `truncated`, not instead of it: `truncated` answers
    // "was this answer cut", `coverage` answers "what may I conclude
    // from what is missing". Two different questions, and the second one
    // had no field.
    coverage: coverageOf({ reasons: coverageReasons }),
    limits,
  };
}

/**
 * Collapse claims whose bodies are identical after normalisation.
 *
 * The author-share cap below bounds a NAMED flooder. It does nothing
 * against an actor who rotates author names — tested after writing it:
 * twenty claims under twenty names all survived. Rotating names needs the
 * same write access as one name, so the cap alone was worth little.
 *
 * Content is the thing an attacker cannot vary and still rank: flooding
 * works by repeating what matches the query. So identical bodies collapse
 * to the first (highest-ranked) one, whatever they are signed with.
 *
 * Normalisation is deliberately conservative — Unicode NFC, CRLF to LF,
 * runs of whitespace to one, and nothing else. No case folding, no
 * punctuation stripping: aggressive normalisation makes DIFFERENT content
 * collide, and a memory that silently merges two different claims is worse
 * than one that shows a duplicate. Near-duplicates are left alone; they
 * are a `possible_duplicate` relation to surface, not a merge to perform.
 */
export function canonicalBody(text) {
  return String(text ?? '').normalize('NFC').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
}

export function bodyHash(text) {
  return crypto.createHash('sha256').update(canonicalBody(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * No single sub-user author may take more than `perAuthorShare` of the
 * CANDIDATES considered. Not of the answer — and the difference matters.
 *
 * The filtering shrinks its own denominator: 9 flood claims plus 1 genuine
 * one give cap 5, so 5 are dropped and the answer is 6, of which 5 are the
 * flood. A promised ceiling of 50% delivers 83%. Measured, not reasoned:
 * bench/byzantine.mjs, 2026-09-05.
 *
 * Computing the share against the answer instead was tried and reverted.
 * It works by iterating to a fixed point, and it is correct — but the
 * corpus it shrinks is not only the flood. A normal memory is one user
 * claim and a productive digest agent, which has the same authorship shape
 * as a flood, so the same fixed point cuts a real answer to two claims.
 * Authorship cannot distinguish a flood from a useful writer; only content
 * can, and near-duplicate detection was rejected for having no calibratable
 * threshold. So the bound stays where it is honest.
 *
 * What a flood is actually caught by: `potentialConflicts` flags it as
 * contested, the genuine `user` claim is exempt from the cap and stays in
 * the answer, and the caller is told both. Bounded domination is NOT among
 * the guarantees; a caller that needs it must lower `perAuthorShare`
 * itself and accept the shorter answers.
 *
 * Deliberately NOT a flat "max n per author": a digest agent legitimately
 * writes most of a memory, and a flat cap would make the most useful
 * author the most suppressed. `user` tier is exempt because the owner
 * cannot poison their own memory in the sense this defends against.
 */
export function enforceAuthorShare(claims, limits = LIMITS, note = () => {}) {
  if (claims.length <= 2) return claims;
  const cap = Math.max(1, Math.floor(claims.length * limits.perAuthorShare));
  const seen = new Map();
  const out = [];
  for (const c of claims) {
    if (c.authority === 'user' || !c.author) { out.push(c); continue; }
    const n = (seen.get(c.author) ?? 0) + 1;
    if (n > cap) { note(c.id, `author share exceeded (${c.author}, cap ${cap})`); continue; }
    seen.set(c.author, n);
    out.push(c);
  }
  return out;
}

/**
 * Claims in one answer that MAY contradict each other.
 *
 * Deliberately the weakest possible detector, and deliberately named
 * "potential". What is decidable without a world model:
 *
 *   same topic + same scope + overlapping validity + different authors
 *
 * That is a structural coincidence, not a semantic judgement. It cannot
 * tell that "runs in Frankfurt" and "runs in Berlin" conflict; it can tell
 * that two different people made claims about the same thing at the same
 * time, which is when a reader should look.
 *
 * Why it exists: the Byzantine benchmark returns an answer whose context
 * is mostly false and, until now, said nothing about it. A memory that
 * cannot decide which claim is true can still refuse to present a
 * contested subject as settled. That refusal is cheap, deterministic, and
 * needs no model.
 *
 * What it deliberately does NOT do: pick a winner. Tier decides only where
 * a conflict is ESTABLISHED — an explicit supersession — not where one is
 * merely suspected. Guessing here would be worse than saying nothing,
 * because a wrong resolution is invisible and a flag is not.
 */
export function potentialConflicts(claims) {
  const groups = new Map();
  for (const c of claims) {
    if (!c.topic) continue;
    const key = `${c.scope}\u0000${c.topic}`;
    const g = groups.get(key) ?? [];
    g.push(c);
    groups.set(key, g);
  }
  const out = [];
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    const authors = new Set(g.map((c) => c.author ?? '(none)'));
    if (authors.size < 2) continue;
    // Overlapping validity: absent bounds are open, so absent overlaps all.
    const overlapping = g.filter((a) => g.some((b) => a !== b && intervalsOverlap(a, b)));
    if (overlapping.length < 2) continue;
    const [scope, topic] = key.split('\u0000');
    out.push({
      scope, topic,
      authors: [...authors].sort(),
      ids: overlapping.map((c) => c.id).sort(),
    });
  }
  return out;
}

function intervalsOverlap(a, b) {
  const af = a.valid_from ? Date.parse(a.valid_from) : -Infinity;
  const au = a.valid_until ? Date.parse(a.valid_until) : Infinity;
  const bf = b.valid_from ? Date.parse(b.valid_from) : -Infinity;
  const bu = b.valid_until ? Date.parse(b.valid_until) : Infinity;
  const f = (x, d) => (Number.isFinite(x) ? x : d);
  return f(af, -Infinity) < f(bu, Infinity) && f(bf, -Infinity) < f(au, Infinity);
}

/**
 * Why a NAMED claim did not come back.
 *
 * The valuable half of explainability and the one nothing else offers.
 * Needs the exhaustive scan, which is why the scan stays: it is the test
 * oracle anyway, so this costs a scan on an explicit debug call and
 * nothing on the hot path. No model involved.
 */
export function explainMissing(root, query, capability, id, opts = {}) {
  const r = retrieve(root, query, capability, { ...opts, top: LIMITS.maxResults });
  const hit = r.claims.find((c) => c.id === id);
  if (hit) return { id, returned: true, rank: r.claims.indexOf(hit) + 1, score: hit.score };
  const why = r.excluded.find((e) => e.id === id);
  if (why) return { id, returned: false, reason: why.why };
  return { id, returned: false, reason: 'no term of the query matches this claim' };
}

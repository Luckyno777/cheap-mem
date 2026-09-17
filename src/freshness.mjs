// freshness.mjs — living facts, the cheap-mem way (deterministic, no model).
//
// The best idea in the field is a memory that does not fill with stale
// truths. Instead of "the server has 13 users" it should hold "the server
// had 13 users AS OF 2026-07-13", prefer the current value, and flag what
// has gone quiet. Other systems reach this with an LLM in the loop. We do
// it with pure code over the `timeline` log — the one type meant for facts
// that change.
//
// The mechanism is a `key`: timeline entries that share a key are versions
// of one fact. Log them with `mem log timeline --key server.users
// --value 13 --valid_from 2026-07-13 --source ...`. The newest valid_from
// (falling back to ts) is the current value; the rest are history, kept but
// marked. No key → the entry is a one-off note, not a tracked fact, and is
// left alone.
//
// Nothing here calls a model, opens the network, or writes to disk. Same
// contract as search: deterministic, milliseconds, offline.

/** The subject a timeline entry is a version of, or null for a one-off. */
export function subjectKey(e) {
  return e.key ?? e.subject ?? null;
}

const whenMs = (e) => Date.parse(e.valid_from ?? e.ts ?? 0) || 0;
const valueOf = (e) => e.value ?? e.fact ?? e.text ?? '';

/**
 * Until when does this version hold? `null` = open-ended.
 *
 * EXCLUSIVE, the same choice `retrieval.validAt` already made and states:
 * a version valid until the 1st does not hold on the 1st. Said out loud
 * because half of all interval bugs are this decision left unstated.
 */
const bisMs = (e) => {
  const t = e.valid_until ? Date.parse(e.valid_until) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** Does this version hold AT `nowMs`? */
const giltJetzt = (e, nowMs) => {
  if (whenMs(e) > nowMs) return false;
  const bis = bisMs(e);
  return bis === null || nowMs < bis;
};

/** How a key's newest version relates to the question's point in time. */
export const LAGE = Object.freeze({
  AKTUELL: 'current',     // a version holds right now
  NOCH_NICHT: 'not_yet',  // every version starts in the future
  ABGELAUFEN: 'expired',  // every version has run out
  KEINE: 'none',          // nothing usable at all
});

/**
 * Resolve timeline entries into current facts per key.
 *
 * @param entries  timeline entries (raw JSONL objects)
 * @param opts.now        reference time (default: now)
 * @param opts.staleDays  a current fact older than this is flagged stale (default 120)
 * @param opts.retired    optional Map id->info; retired versions are dropped
 * @returns array of { key, current, history[], future[], expired[], state,
 *          stale, ageDays, conflict } sorted by key. `conflict` = SEVERAL
 *          versions share the newest timestamp and disagree on the value (a
 *          real contradiction, not a normal update).
 *
 * **"Current" means valid NOW, not newest (external audit, 2026-09-17.)**
 * A port logged with `valid_from 2027-01-01` beat the port actually in
 * force on 2026-09-16, and came back `stale: false` with `ageDays: -107`.
 * A negative age is the sound a sorting key makes when it is used as an
 * answer: the code sorted by validity and then read position 0 as "the
 * value", with nothing in between asking whether that version had started.
 * An agent reading it would have configured a port that is not open.
 *
 * So `current` is the newest version that HOLDS at `now`, `valid_until`
 * included; versions that have not started and versions that have run out
 * travel in their own arrays rather than being dropped, because "there is
 * a value, it just does not apply yet" is a different answer from "there
 * is none" and both differ from "we did not look". When nothing holds,
 * `current` is null, `ageDays` is null — not 0, which would be a
 * measurement — and `state` says which of the three it is.
 *
 * The conflict check used to compare versions[1] against versions[0] and
 * stop. Three concurrent versions A, A, B therefore reported no conflict:
 * the first two agreed and the third was never looked at.
 */
export function resolveFacts(entries, { now = new Date(), staleDays = 120, retired = null } = {}) {
  const groups = new Map();
  for (const e of entries) {
    if (e.__broken) continue;
    if (retired && e.id && retired.has(e.id)) continue;
    const k = subjectKey(e);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const nowMs = +now;
  const out = [];
  for (const [key, versions] of groups) {
    versions.sort((a, b) => whenMs(b) - whenMs(a)); // newest first
    const future = versions.filter((e) => whenMs(e) > nowMs);
    const expired = versions.filter((e) => {
      const bis = bisMs(e);
      return whenMs(e) <= nowMs && bis !== null && nowMs >= bis;
    });
    const gueltig = versions.filter((e) => giltJetzt(e, nowMs));
    const current = gueltig[0] ?? null;
    const history = current ? versions.filter((e) => e !== current) : versions;
    const ageDays = current ? Math.round((nowMs - whenMs(current)) / 86400000) : null;
    const stale = ageDays !== null && Number.isFinite(ageDays) && ageDays > staleDays;
    // Every version sharing the newest valid timestamp, not just the
    // one that happened to sort second.
    let conflict = false;
    if (current) {
      const gleichAlt = gueltig.filter((e) => whenMs(e) === whenMs(current));
      conflict = new Set(gleichAlt.map((e) => JSON.stringify(valueOf(e)))).size > 1;
    }
    let state = LAGE.AKTUELL;
    if (!current) {
      if (future.length) state = LAGE.NOCH_NICHT;
      else if (expired.length) state = LAGE.ABGELAUFEN;
      else state = LAGE.KEINE;
    }
    out.push({ key, current, history, future, expired, state, stale, ageDays, conflict });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * One human line for a resolved fact: `key = value  (as of DATE)` with
 * flags. Pure formatting, so the CLI and the context dump render alike.
 */
export function formatFact(f) {
  // Nothing holds right now. Saying so is the whole point — a line that
  // printed the future value here would be the defect this guards.
  if (!f.current) {
    const naechste = f.future?.[f.future.length - 1];
    if (naechste) {
      return `${f.key} = (not yet) ${valueOf(naechste)}  `
        + `(starts ${String(naechste.valid_from ?? naechste.ts ?? '').slice(0, 10) || '?'})`;
    }
    const letzte = f.expired?.[0];
    if (letzte) {
      return `${f.key} = (expired) ${valueOf(letzte)}  `
        + `(ran out ${String(letzte.valid_until ?? '').slice(0, 10) || '?'})`;
    }
    return `${f.key} = (nothing valid)`;
  }
  const val = valueOf(f.current);
  const asOf = (f.current.valid_from ?? f.current.ts ?? '').slice(0, 10);
  const flags = [];
  if (f.stale) flags.push(`stale ${f.ageDays}d`);
  if (f.conflict) flags.push('conflict');
  if (f.future?.length) flags.push(`${f.future.length} not yet in force`);
  const src = f.current.source ? `  <${f.current.source}>` : '';
  const tail = flags.length ? `  [${flags.join(', ')}]` : '';
  return `${f.key} = ${val}  (as of ${asOf || '?'})${src}${tail}`;
}

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
 * Resolve timeline entries into current facts per key.
 *
 * @param entries  timeline entries (raw JSONL objects)
 * @param opts.now        reference time (default: now)
 * @param opts.staleDays  a current fact older than this is flagged stale (default 120)
 * @param opts.retired    optional Map id->info; retired versions are dropped
 * @returns array of { key, current, history[], stale, ageDays, conflict }
 *          sorted by key. `conflict` = two versions share the newest
 *          timestamp but disagree on the value (a real contradiction, not a
 *          normal update).
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
    const current = versions[0];
    const history = versions.slice(1);
    const ageDays = Math.round((nowMs - whenMs(current)) / 86400000);
    const stale = Number.isFinite(ageDays) && ageDays > staleDays;
    const conflict = versions.length > 1
      && whenMs(versions[1]) === whenMs(current)
      && valueOf(versions[1]) !== valueOf(current);
    out.push({ key, current, history, stale, ageDays, conflict });
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * One human line for a resolved fact: `key = value  (as of DATE)` with
 * flags. Pure formatting, so the CLI and the context dump render alike.
 */
export function formatFact(f) {
  const val = valueOf(f.current);
  const asOf = (f.current.valid_from ?? f.current.ts ?? '').slice(0, 10);
  const flags = [];
  if (f.stale) flags.push(`stale ${f.ageDays}d`);
  if (f.conflict) flags.push('conflict');
  const src = f.current.source ? `  <${f.current.source}>` : '';
  const tail = flags.length ? `  [${flags.join(', ')}]` : '';
  return `${f.key} = ${val}  (as of ${asOf || '?'})${src}${tail}`;
}

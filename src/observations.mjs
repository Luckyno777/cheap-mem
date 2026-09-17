/**
 * observations — a per-machine record of what was shown, never a say
 * in what gets shown.
 *
 * **Where this comes from, and what was cut.** The outside proposal
 * wanted `events.jsonl` for telemetry, used to rank or hide entries by
 * how often they were "used". That name is already taken here — see
 * `memory.TYPES.event` ("it happened: a release, a hire, a start") —
 * and the ranking use was the flaw this whole rewrite removes: a
 * per-machine use-count answers differently on two machines, and a
 * committed one turns every READ into a WRITE. Neither survives.
 *
 * **What does survive.** An audit question with no ranking stake at
 * all: "what did this memory show, when, through which lane" — useful
 * for a human debugging why an answer looked the way it did, worthless
 * as an input to computing that answer. So: a ledger, per machine, that
 * records the fact of an injection and is read by nothing that decides
 * what to inject next.
 *
 * **The guarantee, and how it is checked.** Retrieval and ranking never
 * read this file — not "are not supposed to", but structurally do not
 * import this module at all (`grep -rl "observations.mjs" src/retrieval.mjs
 * src/search.mjs` finds nothing, and `test/observations-not-ranked.test.mjs`
 * proves the OUTPUT is unaffected: delete the ledger, run a ranked
 * query, and the result is byte-identical to the run with it present).
 *
 * **Why `.pipeline/`, not the log directories.** Everything under
 * `global/` and each project directory is append-only content this repo
 * commits and merges with `merge=union` (see `bin/mem`'s `.gitattributes`
 * writer). This ledger is neither: it is machine-local, like the other
 * runtime state already living under `.pipeline/` (`src/injection.mjs`'s
 * journal, `src/inbox.mjs`'s clone mark, `src/shrink.mjs`'s baseline).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the ledger lives — per machine, not a JSONL "log" type. */
export const LEDGER_FILE = path.join('.pipeline', 'observations.jsonl');

export function ledgerPath(root) {
  return path.join(root, LEDGER_FILE);
}

/**
 * Record one observation: what was injected, when, by which lane.
 *
 * `ids` is the list of entry ids that were actually shown — not a
 * count, not a per-id tally: the shape that would invite exactly the
 * "how often was X used" question this file refuses to answer.
 * Failure to write is swallowed by the caller (see `bin/mem`'s
 * `retrieve` command) — an audit trail that can crash the thing it
 * audits would be a worse trade than the audit itself.
 */
export function record(root, { lane, ids = [], query = null, now = new Date() } = {}) {
  if (!lane) throw new Error('observations.record needs a lane');
  const p = ledgerPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const line = JSON.stringify({
    ts: new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    lane: String(lane),
    ids: Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [],
    query: query ? String(query) : null,
  });
  fs.appendFileSync(p, `${line}\n`, 'utf8');
}

/**
 * Read the ledger back — for a human or a doctor check, never for a
 * ranking. Three states, like every other log in this repo: missing
 * (nothing was ever observed here), present-and-empty, and broken
 * (a line that will not parse is kept, flagged, rather than silently
 * dropped — silence here would hide exactly the kind of corruption an
 * audit trail exists to catch).
 */
export function readAll(root) {
  const p = ledgerPath(root);
  if (!fs.existsSync(p)) return { path: p, missing: true, entries: [] };
  const raw = fs.readFileSync(p, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); }
    catch { entries.push({ __broken: true, raw: line }); }
  }
  return { path: p, missing: false, entries };
}

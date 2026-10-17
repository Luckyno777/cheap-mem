// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/phase-identifiers.mjs — is an identifier with an underscore, or
// with an umlaut, still found when somebody types it?
//
// **The phase id.** `identifiers`. The sister house (lucky-mem) used to call
// it `kennungen` and renames it to the same id before its first baseline; the
// state of that rename is recorded in test/atlas-phase-parity.json.
//
// **The question (K1).** The anchors every other atlas phase plants are plain
// ASCII words (`anchorphrase3zzq`). Real memories are full of names like
// `flush_pending_queue`, `MAX_RETRY_COUNT` and, in a German-speaking
// household, `prüfe_größe_limit`. The index keeps the underscore inside one
// token; the content-word path (`contentWords` and `retrievalQuery` in
// src/search.mjs) splits a question at every character that is not
// `[a-z0-9]` after folding ä/ö/ü/ß to ae/oe/ue/ss. If the two disagree, the
// identifier you typed turns into three common words and the one entry that
// names it drowns among the entries that merely mention the parts.
//
// **What it does.** It plants, in a small synthetic memory, per form:
//
//   - one TARGET entry that carries the identifier,
//   - four DECOY entries that carry the identifier's parts as separate
//     words, several times each (the way a real memory talks about "the
//     queue" and "pending" without ever writing the identifier),
//
// and asks for the identifier by every path that turns a typed question into
// a search:
//
//   find            `mem find "<q>"`           the typed question
//   recall          `mem find "<q>" --recall`  what the retrieval hook runs
//   content-words   `mem find "<q>" --content-words`
//                                              the path `retrievalQuery()`
//                                              shares with the subagent
//                                              start hook
//
// The counter is a rank: the target's position in the top ten, `null` when it
// is not there. Expected: rank 3 or better (`RANK_MAX`). Not time, not a score.
//
// **Controls.** A plain invented word (`quorbleflux`) on the plain path must
// come back first. If it does not, the harness is broken and every other
// record of this phase says `not-measured` instead of reporting a red it
// cannot stand behind. The hyphenated and camelCase names are comparison
// forms: they say whether a failure belongs to the underscore or to
// "compound names" in general. They are asked on every path, recorded like
// the rest and left out of the per-path counter in the phase note.
//
// **A red here is a finding, not a bug of the phase.** This phase measures;
// it does not fix src/search.mjs. See the record evidence for the ranks.

import fs from 'node:fs';
import path from 'node:path';
import {
  VERDICT, SEVERITY, mem, buildCorpus, tempRoot,
} from './core.mjs';

/** The rank the identifier must reach, per path. */
export const RANK_MAX = 3;
/** Decoys per form: enough that a split query fills the top ranks with entries that do not carry the identifier. */
export const DECOYS = 4;

/**
 * The forms. `entry` is how the memory spells it, `query` how it is typed;
 * `parts` are the words the decoys use. `control` forms are the comparison
 * forms (plain, hyphen, camelCase); the others are the forms this phase
 * exists to ask about.
 * All names are invented.
 */
export const FORMS = Object.freeze([
  { key: 'plain', control: true, entry: 'quorbleflux', query: 'quorbleflux', parts: [] },
  { key: 'hyphen', control: true, entry: 'cache-warm-batch', query: 'cache-warm-batch', parts: ['cache', 'warm', 'batch'] },
  { key: 'camel', control: true, entry: 'rotateAuditLogs', query: 'rotateAuditLogs', parts: ['rotate', 'audit', 'logs'] },
  { key: 'underscore', control: false, entry: 'flush_pending_queue', query: 'flush_pending_queue', parts: ['flush', 'pending', 'queue'] },
  { key: 'underscore-upper', control: false, entry: 'MAX_RETRY_COUNT', query: 'max_retry_count', parts: ['max', 'retry', 'count'] },
  { key: 'underscore-in-sentence', control: false, entry: 'flush_pending_queue', query: 'why does flush_pending_queue hang on shutdown', parts: ['flush', 'pending', 'queue'], shares: 'underscore' },
  { key: 'umlaut', control: false, entry: 'prüfe_größe_limit', query: 'prüfe_größe_limit', parts: ['prüfe', 'größe', 'limit'] },
  { key: 'umlaut-in-sentence', control: false, entry: 'prüfe_größe_limit', query: 'why does prüfe_größe_limit hang on shutdown', parts: ['prüfe', 'größe', 'limit'], shares: 'umlaut' },
  { key: 'umlaut-typed-as-transliteration', control: false, entry: 'öffne_fenster_zeit', query: 'oeffne_fenster_zeit', parts: ['öffne', 'fenster', 'zeit'] },
  { key: 'transliteration-typed-as-umlaut', control: false, entry: 'schliesse_pruefung_zeit', query: 'schließe_prüfung_zeit', parts: ['schliesse', 'pruefung', 'zeit'] },
]);

/** The paths; `args` is what is appended after `find "<q>" --json --top 10`. */
export const PATHS = Object.freeze([
  { key: 'find', args: [] },
  { key: 'recall', args: ['--recall'] },
  { key: 'content-words', args: ['--content-words'] },
]);

/** Plant the targets, their decoys, and return the entry id per form key. */
export function plant(root) {
  const lines = [];
  const ids = {};
  const add = (id, title, text) => lines.push(JSON.stringify({
    id, ts: '2026-09-01T10:00:00Z', title, text, tags: ['identifier-probe'],
  }));
  const planted = new Set();
  FORMS.forEach((f, i) => {
    const owner = f.shares ?? f.key;
    ids[f.key] = `idprobe-${owner}-target`;
    if (planted.has(owner)) return;
    planted.add(owner);
    add(`idprobe-${owner}-target`, `Probe note ${i}`, `the procedure ${f.entry} runs first, before anything else is touched`);
    for (let d = 0; d < DECOYS; d += 1) {
      if (!f.parts.length) break;
      const [a, b, c] = f.parts;
      add(`idprobe-${owner}-decoy${d}`, `Probe discussion ${i}.${d}`,
        `${a} ${b} ${c}; ${a} the ${b} and the ${c}; ${b} ${c} ${a} again; talk about ${c} and ${a}`);
    }
  });
  fs.appendFileSync(path.join(root, 'global', 'learnings.jsonl'), `${lines.join('\n')}\n`);
  return ids;
}

/** Where the target stands in a `mem find --json` answer: 1-based, `null` when absent or unreadable. */
export function rankOf(stdout, id) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return { rank: null, readable: false }; }
  const hits = Array.isArray(parsed?.hits) ? parsed.hits : null;
  if (!hits) return { rank: null, readable: false };
  const at = hits.findIndex((h) => (h?.entry?.id ?? h?.id) === id);
  return { rank: at === -1 ? null : at + 1, readable: true, top: hits.slice(0, 10).map((h) => h?.entry?.id ?? h?.id ?? null) };
}

export async function run(atlas, { quick = false } = {}) {
  atlas.phase('identifiers', 'Identifiers with underscores and umlauts: is the entry that names them found at rank 3 or better?');
  const root = tempRoot('atlas-identifiers-');
  buildCorpus(root, quick ? 300 : 1500, { anchors: 0 });
  const ids = plant(root);

  // The control first: if a plain word is not found on the plain path, nothing below can be read.
  const first = FORMS[0];
  const probe = mem(['find', first.query, '--json', '--top', '10'], { root });
  const control = rankOf(probe.stdout, ids[first.key]);
  const harnessOk = control.rank === 1;
  if (!harnessOk) {
    atlas.record({
      id: 'identifiers.positive-control',
      title: 'a plain invented word is found first by `mem find` (the harness works)',
      verdict: VERDICT.FAIL,
      expected: 'rank 1',
      actual: control.readable ? `rank ${control.rank}` : `no readable answer (exit ${probe.status})`,
      severity: SEVERITY.MAJOR,
      evidence: String(probe.stderr).slice(0, 300),
    });
  }

  const tally = {};
  for (const p of PATHS) tally[p.key] = { asked: 0, found: 0 };
  for (const f of FORMS) {
    for (const p of PATHS) {
      const id = `identifiers.${f.key}.${p.key}`;
      const title = `${f.control ? 'comparison form' : 'identifier'} "${f.key}" is found at rank ${RANK_MAX} or better by the ${p.key} path`;
      if (!harnessOk) {
        atlas.record({
          id, title, verdict: VERDICT.NOT_MEASURED, expected: `rank <= ${RANK_MAX}`, actual: 'not asked',
          evidence: 'the positive control failed, so a rank from this harness would not mean anything (identifiers.positive-control)',
        });
        continue;
      }
      const r = mem(['find', f.query, '--json', '--top', '10', ...p.args], { root });
      const got = rankOf(r.stdout, ids[f.key]);
      if (!got.readable || r.status !== 0) {
        atlas.record({
          id, title, verdict: VERDICT.NOT_MEASURED, expected: `rank <= ${RANK_MAX}`,
          actual: `no readable answer (exit ${r.status})`, evidence: String(r.stderr).slice(0, 300),
        });
        continue;
      }
      const ok = got.rank !== null && got.rank <= RANK_MAX;
      if (!f.control) { tally[p.key].asked += 1; if (ok) tally[p.key].found += 1; }
      atlas.record({
        id,
        title,
        verdict: ok ? VERDICT.PASS : VERDICT.FAIL,
        expected: `rank <= ${RANK_MAX} (the entry that carries "${f.entry}", among ${DECOYS} decoys that carry only its parts)`,
        actual: got.rank === null ? 'not in the top 10' : `rank ${got.rank}`,
        severity: f.control ? SEVERITY.MINOR : SEVERITY.MAJOR,
        evidence: `typed: ${f.query}; answer top ids: ${(got.top ?? []).slice(0, 6).join(', ') || '(none)'}`,
        measured: {
          form: f.key, path: p.key, rank: got.rank, control: f.control, typed: f.query, entryForm: f.entry,
        },
      });
    }
  }

  // Counters per path, in the phase note rather than as one more verdict: how many of the asked forms were found.
  atlas.current.note = harnessOk
    ? `Found at rank ${RANK_MAX} or better, identifier forms only (controls excluded): ${PATHS.map((p) => `${p.key} ${tally[p.key].found}/${tally[p.key].asked}`).join(', ')}.`
    : '**The positive control failed; no identifier was asked.**';

  atlas.blind('identifier forms outside this list',
    'dotted names (config.cache.ttl), double-colon and path-like names (a::b, src/x_y.mjs), capital umlauts (Ü), digits inside the identifier and non-Latin scripts are not planted; a green here says nothing about them');
  atlas.blind('identifiers on a corpus the size of a real memory',
    `the synthetic memory holds ${quick ? 300 : 1500} filler entries plus the planted ones; rank on 100,000 entries is the scale phase's question and is not asked of identifiers`);
  atlas.blind('the warm recall server path for identifiers',
    'the retrieval hook asks the recall server first when one runs; its answer comes from the same find handler, but this phase asks the direct path only');
}

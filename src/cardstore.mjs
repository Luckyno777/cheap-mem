// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * cardstore — the card shelf `cards.jsonl`: decision cards written AFTERWARDS to a target (H11, owner decision 2026-10-13
 * 14rlf2n7u4cr: "a shelf of its own").
 *
 * **Why a shelf and not a correction line on the entry.** The old stock (duties, questions) has no card. A correction with
 * `replaces_id` on the original fails on the authority rule (`authority.maySupersede`): computed against the 28 open cases, 11
 * were refused ("same tier, different authors"), and every refused correction stands as "disputed" and floods the doctor.
 * The shelf is a line of its own with `target_id`, author (`agent`), tier (`authority`) and `ts`; the original is never
 * touched, there is no tier collision, and the target may be a non-entry (`project:<name>`, `letter:<id>`, `word-pair:<a>|<b>`,
 * see `decisioncard.identifierOf`).
 *
 * **The higher tier counts, then the youngest.** Per target ONE card counts: the card of the higher tier (`authority.rank`),
 * at equal tier the younger one (equal `ts`: the one read later). The card that lost stays visible as `replaced` on the card
 * that counts, so an agent's card never silently displaces the card the owner wrote himself. A card can be withdrawn like any
 * entry (`mem discard <card-id>`): it no longer counts.
 *
 * **Writing.** `write` is the one road for `mem card add`. It writes ONLY into `cards.jsonl`, never into the drawer of the
 * target, through `memory.logCheckedEntry` (redaction, byte cap, id, author, tier). The tier is the write road's default
 * (`agent`); tier `user` only comes from a person (the write core refuses it for an agent). The write core checks the card
 * and its target for EVERY road (`memory.logEntry`, type `card`); `check` here is the same rule for a friendly message first.
 *
 * **Three states.** `readCards` tells: the shelf is missing (a fresh store, normal: empty), readable (with the count of broken
 * and of unusable lines) and not readable (`readable: false` with a reason — then every target gets the fallback card and the
 * caller SAYS so; never a silent "no cards").
 */

// invariant: nicht-messbar-ist-nicht-null

import * as memory from './memory.mjs';
import * as authority from './authority.mjs';
import * as card from './decisioncard.mjs';
import * as rules from './cardrules.mjs';
import * as redaction from './redaction.mjs';
import { costCut } from './outputguard.mjs';

export const TYPE = 'card';

const one = (v) => (typeof v === 'string' ? rules.clean(v) : '');

/** Does this input become a card? (`cardrules.checkCard`; the write core runs the same check.) */
export const check = rules.checkCard;

/**
 * What the mask found in the fields as they were handed in, `[{ type, count }]`. The card is written through `rules.clean`, which
 * already masks, so the write core finds nothing left to redact; without this the caller would never be told that a secret was
 * taken out ("redacted: github-token x2"). Counted on the same bounded text `clean` keeps.
 */
function maskedInFields(fields) {
  const counts = new Map();
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const f of redaction.redact(costCut(v, rules.MAX_IN)).found) counts.set(f.type, (counts.get(f.type) ?? 0) + f.count);
    } else if (Array.isArray(v)) v.slice(0, 200).forEach(walk);
  };
  for (const k of ['target_id', 'question', 'context', 'options', 'advice', 'evidence', 'kind', 'target_type']) walk(fields?.[k]);
  return [...counts].map(([type, count]) => ({ type, count }));
}

/**
 * Write a card (append-only, only into `cards.jsonl`). Throws with the reason when `check` finds errors — then nothing was
 * written. Returns `{ path, entry, findings, warnings }`.
 *
 * @param fields  `{ target_id, question, context, options, advice?, evidence?, kind?, target_type? }`
 */
export function write(root, fields, { project = null, agent = undefined, authority: tier = undefined, now = new Date() } = {}) {
  const c = check(fields);
  if (!c.ok) {
    const e = new Error(`Card not written:\n  ${c.errors.join('\n  ')}`);
    e.code = 'CARD_INVALID';
    e.errors = c.errors;
    throw e;
  }
  const F = card.CARD_FIELDS;
  const data = {
    target_id: one(fields.target_id),
    [F.question]: one(fields.question),
    [F.context]: one(fields.context),
    [F.options]: rules.listOf(fields.options),
  };
  if (one(fields.advice)) data[F.advice] = one(fields.advice);
  const evidence = rules.listOf(fields.evidence);
  if (evidence.length) data[F.evidence] = evidence;
  if (one(fields.kind)) data[F.kind] = one(fields.kind).toLowerCase();
  if (one(fields.target_type)) data.target_type = one(fields.target_type);
  if (agent) data.agent = agent;
  if (tier) data.authority = tier;
  const { path: p, entry, findings: found } = memory.logCheckedEntry(root, TYPE, data, { project, now });
  // the write core's own findings (the env layer, anything `clean` left) and what the mask took out before it
  const merged = new Map();
  for (const f of [...maskedInFields(fields), ...(found ?? [])]) merged.set(f.type, (merged.get(f.type) ?? 0) + f.count);
  return { path: p, entry, findings: [...merged].map(([type, count]) => ({ type, count })), warnings: c.warnings };
}

/** A line read from the shelf as a card for `cardOf` (`context.cards`): without the `card_` prefix. */
function asCard(z, project) {
  const F = card.CARD_FIELDS;
  return {
    id: z.id ?? null, target_id: z.target_id, ts: z.ts ?? null, author: authority.authorOf(z), rank: authority.tierOf(z),
    question: z[F.question], context: z[F.context], options: z[F.options], advice: z[F.advice], evidence: z[F.evidence],
    kind: z[F.kind], project,
  };
}

/**
 * Read all cards — global and every project — and keep ONE per target: the one `decisioncard.precedes` puts first.
 * @returns {{ cards: Map<string, object>, readable: boolean, reason: string|null, read: number, broken: number,
 *   unusable: number, withdrawn: number }}
 *   A missing shelf is readable and empty (a fresh store). A read error makes `readable: false` (with a reason), `cards` is
 *   then empty and the caller knows that means "unknown", not "none".
 */
export function readCards(root) {
  const cards = new Map();
  let read = 0; let broken = 0; let unusable = 0; let withdrawn = 0;
  try {
    for (const project of [null, ...memory.listProjects(root)]) {
      // The shelf is small (one line per card); the retirement map needs all lines of a drawer at once.
      const entries = memory.readLog(root, TYPE, { project }).entries;
      const retired = memory.retiredMap(entries);
      for (const z of entries) {
        if (z.__broken) { broken += 1; continue; }
        if (memory.isClosingLine(z) && !one(z.target_id)) continue; // a tombstone is no card and no error
        read += 1;
        if (z.id && retired.has(z.id)) { withdrawn += 1; continue; }
        const target = one(z.target_id);
        if (!target || !one(z[card.CARD_FIELDS.question])) { unusable += 1; continue; }
        const k = asCard({ ...z, target_id: target }, project);
        const old = cards.get(target);
        if (!old) { k.replaced = null; cards.set(target, k); continue; }
        // Per target the higher tier counts, at equal tier the youngest (equal ts: the line read later). The highest-tier
        // card that lost stays as `replaced`; what the loser itself had displaced counts too.
        const winner = card.precedes(k, old) ? k : old;
        const loser = winner === k ? old : k;
        winner.replaced = card.highest(card.highest(card.summary(loser), card.summary(loser.replaced)), winner.replaced ?? null);
        cards.set(target, winner);
      }
    }
  } catch (e) {
    return { cards: new Map(), readable: false, reason: `card shelf not readable: ${e?.message || e}`, read, broken, unusable, withdrawn };
  }
  return { cards, readable: true, reason: null, read, broken, unusable, withdrawn };
}

/** `Map target_id -> the card that counts` (empty when the shelf is missing OR not readable — whoever needs the difference: `readCards`). */
export function latestCards(root) {
  return readCards(root).cards;
}

/**
 * The state of the shelf for a result (`today`, the dashboard data): readable, or unknown with a reason — `cards`, `broken`
 * and `unusable` are then `null`, never 0. `broken` and `unusable` are counted lines that do not count: they stand there.
 */
export function stateOf(shelf) {
  return shelf.readable
    ? { readable: true, reason: null, cards: shelf.cards.size, broken: shelf.broken ?? 0, unusable: shelf.unusable ?? 0 }
    : { readable: false, reason: shelf.reason, cards: null, broken: null, unusable: null };
}

/** The reasons the shelf state adds to a result: not readable (fallback cards), or counted lines that do not count. */
export function reasonsOf(state) {
  if (!state.readable) return [`${state.reason} (fallback cards)`];
  return state.broken > 0 || state.unusable > 0
    ? [`card shelf: ${state.broken} broken and ${state.unusable} unusable line(s), they do not count`]
    : [];
}

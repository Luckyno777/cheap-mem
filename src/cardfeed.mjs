// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * cardfeed — which items of a dashboard list get a decision card, and how many (H11, ported from the sibling's cross-check
 * 2026-10-13, S4).
 *
 * A card costs bytes (up to ~1.6 KB each) and is only for an item a PERSON is meant to look at. So in the lists of the
 * dashboard data (open duties, open questions, answered questions that wait):
 *
 *   - items addressed to the human participant, and items without a known owner, get a card;
 *   - items addressed to a known AGENT (a participant of `.mem/config.json` that is not the human, or a registered agent) get
 *     none: agent work is not a decision for the person;
 *   - at most `max` cards per list (default `decisioncard.CARD_LIST_MAX`); what the cap leaves out is COUNTED
 *     (`cards_omitted`): left out is not "no card needed".
 *
 * No participant name stands in this file: the human and the agents come from the configuration (design commitment 3).
 *
 * invariant: nicht-messbar-ist-nicht-null
 */

import * as cfgmod from './config.mjs';
import * as agents from './agents.mjs';
import { CARD_LIST_MAX } from './decisioncard.mjs';

/** The three lists that carry cards, by the name they have in the dashboard data. */
export const LISTS = Object.freeze(['openDuties', 'openQuestions', 'waitingQuestions']);

/**
 * `human` | `agent` | `unassigned` for an addressee, given the configured human and the known participant names. Pure.
 */
export function ownerKind(who, { human = null, known = new Set() } = {}) {
  const w = typeof who === 'string' && who.trim() ? who.trim() : null;
  if (w === null) return 'unassigned';
  if (human !== null && w === human) return 'human';
  if (known.has(w)) return 'agent';
  return 'unassigned';
}

/** The human and the known names from the memory: `{ human, known }`. Unreadable configuration: nobody known, every item unassigned. */
export function participantsOf(root) {
  let human = null; const known = new Set();
  try {
    const cfg = cfgmod.readConfig(root);
    human = cfgmod.humanParticipant(cfg.participants).name;
    for (const name of Object.keys(cfg.participants ?? {})) if (name !== human) known.add(name);
  } catch { /* no configuration: unassigned */ }
  try { for (const a of agents.listAgents(root)) if (a?.name && a.name !== human) known.add(a.name); } catch { /* no agent folder */ }
  return { human, known };
}

/**
 * The allocator of one build. `card(list, who, make)` returns `make()` for an item that gets a card and `null` otherwise;
 * `omitted` counts what the cap left out, per list.
 */
export function allocation(root, { max = CARD_LIST_MAX } = {}) {
  const p = participantsOf(root);
  const given = {};
  const omitted = Object.fromEntries(LISTS.map((l) => [l, 0]));
  return {
    omitted,
    card(list, who, make) {
      if (ownerKind(who, p) === 'agent') return null;
      if ((given[list] ?? 0) >= max) { omitted[list] = (omitted[list] ?? 0) + 1; return null; }
      given[list] = (given[list] ?? 0) + 1;
      return make();
    },
  };
}

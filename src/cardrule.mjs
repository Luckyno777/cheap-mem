// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * cardrule — H11 (owner decision 2026-10-13, 36b3ub1nht9f): a NEW duty or question addressed to a person brings its explanation
 * with it, the decision card (src/decisioncard.mjs). Without a card, in two stages:
 *
 *   Stage 1 (default)  The entry is taken in ("better taken in and reported than clean and gone"). The writer gets a LOUD
 *                      warning (CLI: stderr, bridge: lines in the answer), and the entry is recognisable as "explanation missing":
 *                      DERIVED when reading, never stored as a field — `decisioncard.lacksExplanation` says yes for an entry whose
 *                      card is the fallback card (stage `fallback`) or a written card whose options had to be filled in. That is
 *                      enough, because a card is either on the entry (`written`), on the shelf (`addendum`) or nobody's
 *                      (`fallback`); a second field "explanation missing" would be a second truth next to that stage.
 *   Stage 2 (switch)   `CHEAP_MEM_CARD_REJECT=yes`: the same case is REFUSED, nothing is written (error with code `CARD_MISSING`;
 *                      the text names what is missing and gives an example).
 *
 * **"To a person"** (`judge`): a duty whose addressee (`who`, else `owner`, else `to`; trimmed) is the configured human
 * participant, or a question whose `who` is. The human comes from `.mem/config.json` (design commitment 3: no names in `src/`);
 * without a configured human the rule does not apply (there is nobody to protect), and the verdict says why. A question without
 * `who` is addressed to nobody — the rule does not apply there. A closing line (`closes_id`, `retires_id`, a closing state) is no
 * new duty and needs no card.
 *
 * **Who is never refused — and how one tells: by the ROUTE, never by the name.** The rule applies only when the writer states a
 * route (`ROUTES`: `cli` = `mem log`, `mem correction`, `mem restore`; `mcp` = the bridge `mem_log`; `task` = an order that
 * carries a `log`, reserved for a house that has one). These are the places where a person or a foreign agent types FREE text. Every
 * other writer (the guard duties, the error-context duties, the project and day machinery, the card shelf itself) calls the write
 * core without a route and is exempt — a new internal writer is too, without anything to enter here. Why not the other way round
 * (a list of internal names): an agent name can be chosen (`CHEAP_MEM_AGENT`, `--agent`), a route cannot; whoever calls himself
 * `digest` still gets the rule when he writes over `mem log`. The weak side is the other direction: a NEW free input road that
 * forgets to state its route is exempt (it neither warns nor refuses); `test/card-rule.test.mjs` pins the callers.
 *
 * **The capture / digest writer is NO exception.** It writes through the CLI (`mem log`), so the route is `cli` like for anyone.
 * No free pass by agent name or by `MEM_HEADLESS`.
 *
 * Also checked: `mem correction` (a correction that SETS or CHANGES `who` to the human; a card inherited from the predecessor is a
 * card; a `who` that already stood there is old stock) and `mem restore` (a reopened duty to the human is a new one). `mem merge`
 * inherits the `who` of the first entry and sets none: nothing to check.
 *
 * **Output guard.** Card fields are masked FIRST and checked THEN (a key cut by a length limit escapes the pattern); no card text
 * is echoed except through `decisioncard.cardOf`, which masks and cuts like every display.
 *
 * Pure but for the environment (`env`, which the caller may hand in). No I/O, no model, no clock.
 */

// invariant: eine-regel-eine-stelle

import * as rules from './cardrules.mjs';
import * as card from './decisioncard.mjs';
import * as addressee from './addressee.mjs';
import { yesNoValue } from './yesno.mjs';
import { maskText } from './outputguard.mjs';

/** The switch of stage 2. Default: off (stage 1, warn and mark). */
export const ENV_REJECT = 'CHEAP_MEM_CARD_REJECT';
/** The routes on which the rule applies (see above). */
export const ROUTES = Object.freeze(['cli', 'mcp', 'task']);
/** The entry types the rule is about. */
export const TYPES = Object.freeze(['duty', 'question']);

/**
 * The state of the switch: `{on, unrecognised}`. `on` for yes / true / 1 (`yesno.yesNoValue`, the one reading); no / false / 0,
 * empty and missing are stage 1; any other non-empty value is stage 1 AND `unrecognised` (the value): the message says so instead
 * of treating a typo like "yse" as a no.
 */
function switchState(env = process.env) {
  const raw = String(env?.[ENV_REJECT] ?? '').trim();
  if (!raw) return { on: false, unrecognised: null };
  const v = yesNoValue(raw);
  return v === null ? { on: false, unrecognised: raw } : { on: v, unrecognised: null };
}

/** Is stage 2 on? */
export function rejectOn(env = process.env) {
  return switchState(env).on;
}

/** The card fields of an entry or request as the parts `checkCardContent` takes, MASKED first (a string clipped to the input limit). */
function partsOf(data) {
  const F = card.CARD_FIELDS;
  const mask = (v) => {
    if (typeof v === 'string') return maskText(v.length > 2 * rules.MAX_IN ? v.slice(0, 2 * rules.MAX_IN) : v);
    if (Array.isArray(v)) return v.slice(0, 200).map(mask);
    return v;
  };
  return {
    question: mask(data?.[F.question]), context: mask(data?.[F.context]), options: mask(data?.[F.options]),
    advice: mask(data?.[F.advice]), evidence: mask(data?.[F.evidence]), kind: mask(data?.[F.kind]),
  };
}

/** The error of stage 2: nothing was written. */
export class CardMissing extends Error {
  constructor(text, details = {}) {
    super(text);
    this.name = 'CardMissing';
    this.code = 'CARD_MISSING';
    Object.assign(this, details);
  }
}

/** Where the writer puts the card, per route (an example to copy). `who` is the configured human's name. */
function example(route, type, who) {
  const head = type === 'question' ? 'mem log question --question "..."' : 'mem log duty --title "..."';
  if (route === 'cli') {
    return `${head} --who ${who} --card_question "Should ...?" --card_context "..." `
      + '--card_options "Yes — effect" --card_options "No — effect"';
  }
  return 'fields: { "card_question": "Should ...?", "card_context": "...", "card_options": ["Yes — effect", "No — effect"] }';
}

const NOT_APPLICABLE = Object.freeze({
  applies: false, type: null, who: null, has: true, lacks: false, gaps: [], warnings: [], reject: false,
  fallbackQuestion: null, route: null, unrecognised: null, why: null,
});

/**
 * Judge. Pure.
 * @param type      `duty` | `question`
 * @param data      the fields of the entry (after the inherited ones were added, for a correction)
 * @param opt.route the route (`ROUTES`); without it (or an unknown one) the rule does NOT apply: an internal writer
 * @param opt.human the configured human participant's name (`config.humanParticipant(...).name`), or null
 * @param opt.closing   true for a closing line (`memory.isClosingCorrection`): no new duty, no card
 * @param opt.previous  only for a correction: the line that is replaced. If it already had the same addressee the entry is NOT
 *                      new to the person (old stock) and the rule does not apply. Without it: a new entry.
 * @returns {{applies, type, who, has, lacks, gaps, warnings, reject, fallbackQuestion, route, unrecognised, why}}
 *   `has`: the entry carries a card that passes the rules; `lacks`: its explanation is missing as `lacksExplanation` derives it.
 */
export function judge(type, data, { route = null, human = null, env = process.env, closing = false, previous = undefined } = {}) {
  const none = (why) => ({ ...NOT_APPLICABLE, route, why });
  if (!ROUTES.includes(route)) return none('no route stated: an internal writer');
  if (!TYPES.includes(type)) return none('not a duty or question');
  if (!data || typeof data !== 'object' || Array.isArray(data)) return none('no fields');
  const human_ = addressee.nameOf(human);
  if (!human_) return none('no human participant is configured');
  if (closing) return none('a closing line');
  const who = addressee.of(type, data);
  if (!who || who !== human_) return none('not addressed to the human');
  if (previous !== undefined && previous !== null && addressee.of(type, previous) === who) return none('addressee unchanged: old stock');

  const checked = rules.checkCardContent(partsOf(data), { contextRequired: false });
  const has = checked.ok;
  const sw = switchState(env);
  const shown = card.cardOf(data, { type, context: {} });
  return {
    applies: true, type, who, has, lacks: card.lacksExplanation(shown), gaps: checked.errors, warnings: checked.warnings,
    reject: !has && sw.on, fallbackQuestion: has ? null : shown.question, route, unrecognised: sw.unrecognised, why: null,
  };
}

/** Switch values already reported as "not recognised" in this process. */
const REPORTED = new Set();

const WHAT = { duty: 'this duty', question: 'this question' };

/**
 * The message for a verdict, as lines (CLI and bridge show the same ones). Empty when the rule did not apply or the card is
 * there and nothing is left to say. `id`: the id of the written entry (stage 1, after the write).
 */
export function messages(v, { id = null } = {}) {
  if (!v?.applies) return [];
  const what = WHAT[v.type];
  const z = [];
  // A value of the switch that does not exist is reported ONCE per process and value - only where the rule would have bitten.
  if (v.unrecognised && !REPORTED.has(v.unrecognised)) {
    REPORTED.add(v.unrecognised);
    z.push(`${ENV_REJECT}='${rules.clean(maskText(v.unrecognised)).slice(0, 40)}': value not recognised (yes/true/1 or no/false/0), stage 1 applies (warn and mark).`);
  }
  if (v.has) return [...z, ...v.warnings.map((w) => `Card: ${w}`)];
  if (v.reject) {
    z.push(`Card missing: ${what} goes to ${v.who}, but carries no complete decision card — NOT written (${ENV_REJECT} is on).`);
    for (const g of v.gaps) z.push(`  - ${g}`);
    z.push(`  How it looks right: ${example(v.route, v.type, v.who)}`);
    z.push('  At least: card_question and two options, one of them No / not now. card_context is one or two sentences.');
    return z;
  }
  if (v.lacks) {
    z.push(`Explanation missing: ${what} goes to ${v.who}, but carries no complete decision card.`);
    for (const g of v.gaps) z.push(`  - ${g}`);
    z.push(`  Taken in. ${v.who} sees a FALLBACK CARD instead${v.fallbackQuestion ? ` (“${v.fallbackQuestion}”)` : ''}, named as `
      + '"explanation missing", and the doctor finding decision-without-explanation counts it.');
  } else {
    z.push(`Card not to the rules: ${what} goes to ${v.who}.`);
    for (const g of v.gaps) z.push(`  - ${g}`);
    z.push('  Taken in. The card is shown as it stands (cut where it is too long).');
  }
  z.push(`  Better right away: ${example(v.route, v.type, v.who)}`);
  if (id) z.push(`  Adding it later works too: mem card add ${id} --question "..." --context "..." --option "Yes — ..." --option "No — ..."`);
  z.push(`  With ${ENV_REJECT}=yes the write core refuses such an entry.`);
  return z;
}

/** Throws `CardMissing` when stage 2 refuses; otherwise does nothing. */
export function refuseIfNeeded(v) {
  if (v?.applies && v.reject) throw new CardMissing(messages(v).join('\n'), { verdict: v });
}

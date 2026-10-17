// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * answerbudget — the ONE final selection for what the memory puts into a session's context
 * at the two moments that build an answer from several parts: the UserPromptSubmit hook
 * (`src/recallhook.mjs`) and the SubagentStart hook (`src/subagentstart.mjs`).
 * Port of lucky-mem's `kontextauswahl` (abruf-auswahl-lm, decision 2pbqt66q0wdj step 4).
 *
 * **The finding before it.** The prompt hook put its header, the clone line, the hit lines, the
 * skill offer and the workflow block together with no byte budget common to them; the subagent
 * start capped only its recap (CAP_CHARS, in characters) and its assignment block (EXTRA_BYTES)
 * and joined the workflow block, the procedures and the hint in front, uncapped. Every part was
 * bounded alone and nothing bounded the sum. A long workflow card, or three long hit lines with
 * their solutions and a skill offer, grew the answer past anything measured.
 *
 * **The rule, for both callers.**
 *
 *  1. One budget for the WHOLE text, {@link ANSWER_BYTES} (3200 bytes). Header, separators and the
 *     omission note count in it.
 *  2. Parts are allocated in RANK order (smaller rank first). What is allocated last gives way
 *     first. Every part brings its FORMS, best first: the full text, then (where there is one) a
 *     POINTER — a short line with the id and how to fetch the rest — then nothing. A part takes
 *     the best form that still fits; so a card that does not fit steps down to its pointer
 *     instead of vanishing, and instead of being cut mid-sentence.
 *  3. A `fixed` part is always in (a statement of fact, the closing hint, the header), and a `keep` part is always in
 *     at least as its pointer. Only these may push the text over the budget (`over`), and only if they alone are bigger
 *     than it; everything else gives way to them.
 *  4. An `elastic` part (`fill(room)`) takes what is left after the parts allocated before it, the
 *     way the subagent's recap always did.
 *  5. When anything stepped down or fell away, ONE note says how many and how to fetch them
 *     (`mem show <id>` ...). Never silent: "left out" without a note reads as "nothing was there".
 *  6. **Mask, then measure, then (never) cut.** Every form passes the caller's `sanitize` (the
 *     output guard and the Trojan-Source marking) BEFORE its bytes are counted, so the count is
 *     the count of what goes out, and no form is ever cut here: a form is whole or it is not
 *     chosen. A caller that must shorten text does so with `outputguard.cutMasked` in `fill` or
 *     when it builds the forms; a secret can therefore never be cut into a fragment below the
 *     pattern's minimum length.
 *
 * Pure: no I/O, no clock, no model. Never throws for a part: a form or `fill` that throws is
 * skipped.
 */

import { maskText, cutMasked } from './outputguard.mjs';

/** The budget for the whole answer of the prompt hook and of the subagent start, in bytes. */
export const ANSWER_BYTES = 3200;

const bytes = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

/**
 * Part: `{ id, kind, rank, order, forms?: string[], fill?: (room) => string, fixed?, sep?, how? }`.
 *   id     what the part stands for (an entry id, a name); goes into the result, never into the text
 *   kind   a short noun for the note ("hit", "workflow", "procedure", "skill hint", "recap")
 *   rank   allocation order, smaller first; ties by `order`
 *   order  position in the text, smaller first
 *   forms  the texts, best first; a form after the first counts as a step down (a pointer)
 *   fill   elastic: gets the bytes left (`room`), returns text that fits in `room` BYTES (or '')
 *   fixed  always included (first form)
 *   keep   never falls away: at the least its LAST form (its pointer) is in, whatever else gives way; it is upgraded to a
 *          better form in rank order when there is room (a procedure: a human's rule is never silently missing)
 *   holdBack  bytes the parts allocated AFTER this one must still find: a form better than the part's last one (its
 *          pointer) is taken only if that much stays free (the pointer and a part's only form are not held back). It lets a
 *          part with a pointer give way BEFORE a later elastic part is cut (the subagent start: the workflow card steps down
 *          to its pointer first, and only then is the recap shortened)
 *   sep    what stands between this part and the one before it (default: `join`)
 *   how    how to fetch what is missing ("mem show <id>"), named in the note
 *   ref    anything the caller wants back in `chosen` / `pointers` / `omitted` (an index, the entry)
 *
 * Options: `budget`, `join` (default separator), `sanitize` (default `maskText`), `noteSep`.
 *
 * @returns {{ text: string, bytes: number, chosen: object[], pointers: object[], omitted: object[],
 *             note: string|null, over: boolean }}
 *   `chosen`: every part in the text, `{ id, kind, form }` (form 0 = best); `pointers`: those that
 *   stepped down; `omitted`: those that fell away; `over`: fixed parts alone exceed the budget.
 */
export function compose(parts, { budget = ANSWER_BYTES, join = '\n\n', sanitize = maskText, noteSep = '\n\n' } = {}) {
  const list = (Array.isArray(parts) ? parts : []).filter((p) => p && typeof p === 'object').map((p, i) => ({
    ...p, seq: i, rank: Number.isFinite(p.rank) ? p.rank : 100, order: Number.isFinite(p.order) ? p.order : i,
    forms: prepared(p.forms, sanitize),
  })).filter((p) => p.forms.length > 0 || typeof p.fill === 'function');
  const sepOf = (p) => (typeof p.sep === 'string' ? p.sep : join);
  const byOrder = (a, b) => (a[0].order - b[0].order) || (a[0].seq - b[0].seq);

  // The exact size of a choice: the texts in text order, each part but the first with its own separator in front.
  const measure = (picked) => {
    let n = 0;
    [...picked.entries()].sort(byOrder).forEach(([p, got], i) => { n += bytes(got.text) + (i === 0 ? 0 : bytes(sepOf(p))); });
    return n;
  };

  const run = (reserve) => {
    const limit = budget - reserve;
    const picked = new Map(); // part -> { form, text }
    // Fixed parts are in whatever happens; a `keep` part is in at its LAST form (its pointer) whatever happens and
    // is upgraded below when there is room. Both are placed before anything else is allocated.
    for (const p of list.filter((x) => x.fixed)) {
      const text = p.forms[0] ?? safeFill(p, Infinity, sanitize);
      if (text !== null && text !== undefined && text !== '') picked.set(p, { form: 0, text });
    }
    for (const p of list.filter((x) => !x.fixed && x.keep && x.forms.length)) {
      picked.set(p, { form: p.forms.length - 1, text: p.forms[p.forms.length - 1] });
    }
    const rest = list.filter((x) => !x.fixed).sort((a, b) => (a.rank - b.rank) || (a.order - b.order) || (a.seq - b.seq));
    for (const p of rest) {
      const without = new Map(picked);
      without.delete(p);
      const tryWith = (form, text, held = 0) => {
        const trial = new Map(without);
        trial.set(p, { form, text });
        return measure(trial) <= limit - held ? trial : null;
      };
      if (typeof p.fill === 'function') {
        // Room for the text: what is left, less the longest separator this part could bring.
        const room = limit - measure(without) - bytes(sepOf(p));
        const text = safeFill(p, room, sanitize);
        const trial = text ? tryWith(0, text) : null;
        if (trial) picked.set(p, trial.get(p));
        continue;
      }
      // A `keep` part only looks for a better form than its pointer; any other part may also fall away.
      const upto = p.keep ? p.forms.length - 1 : p.forms.length;
      const hold = Number.isFinite(p.holdBack) && p.holdBack > 0 ? p.holdBack : 0;
      for (let f = 0; f < upto; f += 1) {
        // A form better than the last one is taken only if `holdBack` bytes stay free for the parts that follow.
        const trial = tryWith(f, p.forms[f], f < p.forms.length - 1 ? hold : 0);
        if (trial) { picked.set(p, trial.get(p)); break; }
      }
    }
    return picked;
  };

  const describe = (picked) => {
    const pointers = [];
    const omitted = [];
    for (const p of list) {
      const got = picked.get(p);
      const row = { id: p.id ?? null, kind: p.kind ?? 'part', how: p.how ?? null, ref: p.ref };
      if (!got) omitted.push(row);
      else if (got.form > 0) pointers.push(row);
    }
    return { pointers, omitted };
  };

  let picked = run(0);
  let d = describe(picked);
  let note = null;
  if (d.pointers.length || d.omitted.length) {
    // The note counts in the budget, and so do the ids it names: allocate again with room for the note of the
    // previous round until the note fits what it was given (it grows with what fell away, never without bound: the ids
    // it names are capped).
    let reserve = bytes(noteSep) + bytes(noteText(d, budget, sanitize));
    for (let round = 0; round < 6; round += 1) {
      picked = run(reserve);
      d = describe(picked);
      note = noteText(d, budget, sanitize);
      const need = bytes(noteSep) + bytes(note);
      if (need <= reserve) break;
      reserve = need;
    }
    if (bytes(noteSep) + bytes(note) > reserve) note = noteText(d, budget, sanitize, { ids: false });
  }
  const ordered = [...picked.entries()].sort(byOrder);
  let text = '';
  ordered.forEach(([p, got], i) => { text += (i === 0 ? '' : sepOf(p)) + got.text; });
  if (note) text += (text ? noteSep : '') + note;
  return {
    text, bytes: bytes(text),
    chosen: ordered.map(([p, got]) => ({ id: p.id ?? null, kind: p.kind ?? 'part', form: got.form, ref: p.ref })),
    pointers: d.pointers, omitted: d.omitted, note,
    over: bytes(text) > budget,
  };
}

function prepared(forms, sanitize) {
  const out = [];
  for (const f of Array.isArray(forms) ? forms : []) {
    if (typeof f !== 'string') continue;
    let t;
    try { t = sanitize(f); } catch { continue; }
    if (typeof t === 'string' && t.trim()) out.push(t);
  }
  return out;
}

function safeFill(p, room, sanitize) {
  if (typeof p.fill !== 'function') return null;
  try {
    const raw = p.fill(room);
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const t = sanitize(raw);
    return typeof t === 'string' && t.trim() ? t : null;
  } catch { return null; }
}

const plural = (n, kind) => (n === 1 ? kind : (/s$/.test(kind) ? kind : `${kind}s`));

/** At most this many ids of parts that fell away are named in the note; the rest is counted. */
const NOTE_IDS_MAX = 12;

/**
 * The one note: how many stepped down, how many fell away (with the ids of those, so they can be fetched), and how to
 * fetch them. `{ ids: false }` leaves the ids out (the last resort when even that note would not fit).
 */
export function noteText({ pointers = [], omitted = [] }, budget = ANSWER_BYTES, sanitize = maskText, { ids = true } = {}) {
  const count = (list) => {
    const by = new Map();
    for (const x of list) by.set(x.kind, (by.get(x.kind) ?? 0) + 1);
    return [...by.entries()].map(([k, n]) => `${n} ${plural(n, k)}`).join(', ');
  };
  const parts = [];
  if (pointers.length) parts.push(`${count(pointers)} as a pointer only`);
  if (omitted.length) {
    const named = ids ? omitted.map((x) => x.id).filter((id) => typeof id === 'string' && id) : [];
    // mask-ok: a list of ids (an array cut), the note itself passes `sanitize` whole
    const shown = named.slice(0, NOTE_IDS_MAX);
    const more = named.length > shown.length ? ` +${named.length - shown.length} more` : '';
    parts.push(`${count(omitted)} left out${shown.length ? ` (ids: ${shown.join(', ')}${more})` : ''}`);
  }
  const how = [...new Set([...pointers, ...omitted].map((x) => x.how).filter(Boolean))];
  const fetch = how.length ? ` Fetch: ${how.join('; ')}.` : '';
  return sanitize(`(Held to ${budget} bytes: ${parts.join('; ')}.${fetch})`);
}

/**
 * Shorten `text` to at most `max` characters for a pointer line: mask FIRST, then cut the masked text
 * (`cutMasked`: never inside a `[REDACTED:...]` marker), white space squeezed, an ellipsis when something was cut.
 * A key that crosses the cut can not leave a stump no pattern knows any more.
 */
export function shorten(text, max) {
  const flat = maskText(String(text ?? '')).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${cutMasked(flat, Math.max(1, max - 1)).trimEnd()}…`;
}

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
 *  3. A `fixed` part is always in (a statement of fact, the closing hint, the header). Only fixed
 *     parts may push the text over the budget, and only if they alone are bigger than it.
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

import { maskText } from './outputguard.mjs';

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

  const run = (reserve) => {
    const picked = new Map(); // part -> { form, text }
    let used = 0;
    let first = true;
    const cost = (p, text) => bytes(text) + (first ? 0 : bytes(sepOf(p)));
    // Fixed parts first, in text order: they are in whatever happens.
    for (const p of [...list].filter((x) => x.fixed).sort((a, b) => a.order - b.order)) {
      const text = p.forms[0] ?? safeFill(p, Infinity, sanitize);
      if (text === null || text === undefined || text === '') continue;
      picked.set(p, { form: 0, text });
      used += bytes(text) + (picked.size > 1 ? bytes(sepOf(p)) : 0);
    }
    first = picked.size === 0;
    const rest = list.filter((x) => !x.fixed).sort((a, b) => (a.rank - b.rank) || (a.order - b.order) || (a.seq - b.seq));
    for (const p of rest) {
      const room = budget - reserve - used;
      let got = null;
      if (typeof p.fill === 'function') {
        const sepB = first ? 0 : bytes(sepOf(p));
        const text = safeFill(p, room - sepB, sanitize);
        if (text && bytes(text) + sepB <= room) got = { form: 0, text };
      } else {
        for (let f = 0; f < p.forms.length; f += 1) {
          if (cost(p, p.forms[f]) <= room) { got = { form: f, text: p.forms[f] }; break; }
        }
      }
      if (got) {
        picked.set(p, got);
        used += cost(p, got.text);
        first = false;
      }
    }
    return { picked, used };
  };

  const describe = (picked) => {
    const pointers = [];
    const omitted = [];
    for (const p of list) {
      const got = picked.get(p);
      if (!got) omitted.push({ id: p.id ?? null, kind: p.kind ?? 'part', how: p.how ?? null, ref: p.ref });
      else if (got.form > 0) pointers.push({ id: p.id ?? null, kind: p.kind ?? 'part', how: p.how ?? null, ref: p.ref });
    }
    return { pointers, omitted };
  };

  let { picked } = run(0);
  let d = describe(picked);
  let note = null;
  if (d.pointers.length || d.omitted.length) {
    // The note counts in the budget: allocate again with room for the longest note this part list could need.
    const every = list.filter((p) => !p.fixed).map((p) => ({ kind: p.kind ?? 'part', how: p.how ?? null }));
    const worst = noteText({ pointers: every, omitted: every }, budget, sanitize); // each part in both lists: longer than any real note
    ({ picked } = run(bytes(noteSep) + bytes(worst)));
    d = describe(picked);
    note = noteText(d, budget, sanitize);
  }
  const ordered = [...picked.entries()].sort((a, b) => a[0].order - b[0].order || a[0].seq - b[0].seq);
  let text = '';
  ordered.forEach(([p, got], i) => { text += (i === 0 ? '' : sepOf(p)) + got.text; });
  if (note) text += (text ? noteSep : '') + note;
  const fixedBytes = bytes([...picked.entries()].filter(([p]) => p.fixed).map(([, g]) => g.text).join(join));
  return {
    text, bytes: bytes(text),
    chosen: ordered.map(([p, got]) => ({ id: p.id ?? null, kind: p.kind ?? 'part', form: got.form, ref: p.ref })),
    pointers: d.pointers, omitted: d.omitted, note,
    over: fixedBytes > budget,
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

/** The one note: how many stepped down, how many fell away, and how to fetch them. */
export function noteText({ pointers = [], omitted = [] }, budget = ANSWER_BYTES, sanitize = maskText) {
  const count = (list) => {
    const by = new Map();
    for (const x of list) by.set(x.kind, (by.get(x.kind) ?? 0) + 1);
    return [...by.entries()].map(([k, n]) => `${n} ${plural(n, k)}`).join(', ');
  };
  const parts = [];
  if (pointers.length) parts.push(`${count(pointers)} as a pointer only`);
  if (omitted.length) parts.push(`${count(omitted)} left out`);
  const how = [...new Set([...pointers, ...omitted].map((x) => x.how).filter(Boolean))];
  const fetch = how.length ? ` Fetch: ${how.join('; ')}.` : '';
  return sanitize(`(Held to ${budget} bytes: ${parts.join('; ')}.${fetch})`);
}

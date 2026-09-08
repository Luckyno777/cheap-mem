/**
 * Components: the same code, mentioned under several names.
 *
 * **The measured finding (2026-09-08, reference deployment).** Across
 * 805 path mentions: 312 distinct components, 70 of them (22 %) occur
 * in more than one spelling. The difference is almost always just the
 * path prefix — `capture.sh` versus `bin/capture.sh`.
 *
 * **Why that is expensive, and exactly where.** The pre-edit hook asks
 * LITERALLY with the last two path segments. Measured, what it did not
 * see:
 *
 *     bin/capture.sh          3 found,  8 missed
 *     .claude/stop.sh         0 found, 10 missed
 *     hooks/stop.sh           6 found,  4 missed
 *
 * That is the hook which fires DURING THE WORK — the most valuable
 * recall path there is. It ran at a third of its reach.
 *
 * **Why no alias table.** There is one for `topic`, and it is right
 * there: topics are invented, so their sameness has to be asserted by
 * somebody. A path is not invented. `bin/capture.sh` and `capture.sh`
 * are the same file, and that is in the name — keeping a curated table
 * for it would mean maintaining by hand what is derivable.
 *
 * **The latch against the obvious.** Simply falling back to the base
 * name would be wrong: `events.jsonl` lives under `global/` and under
 * every project and means something different each time. So a base-name
 * hit only counts when it appears in the entry WITHOUT a prefix or with
 * the SAME one. A `projects/x/` hit answers no question about
 * `global/`.
 */
import * as memory from './memory.mjs';

/**
 * The query forms for a path, narrow to wide.
 *
 * Exactly two: the last two segments (how the hook asks) and the bare
 * file name. More stages would be more noise — even the second has to
 * justify itself.
 */
export function forms(p) {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean);
  if (!parts.length) return [];
  const base = parts[parts.length - 1];
  const two = parts.slice(-2).join('/');
  return two === base ? [base] : [two, base];
}

/** The prefix that was asked with: `bin` out of `bin/mem.sh`. */
export function prefix(p) {
  const parts = String(p ?? '').split(/[\\/]/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

/**
 * Does the base name appear in this text in a COMPATIBLE form?
 *
 * Compatible means: without a prefix ("in capture.sh there is ...") or
 * with the same prefix as the question. A different prefix is a
 * different file — and the confusion would be worse than the gap,
 * because it gives a hint the appearance of evidence.
 */
export function compatible(text, base, askedPrefix) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`([A-Za-z0-9_.\\-/]*?)${escaped}`, 'g');
  for (const m of String(text ?? '').matchAll(pattern)) {
    const before = m[1];
    if (!before) return true;                      // named bare
    if (!before.endsWith('/')) continue;           // part of a longer word
    const segs = before.slice(0, -1).split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? null;
    if (last && askedPrefix && last === askedPrefix) return true;
  }
  return false;
}

/**
 * Every entry about one component — literal, over both forms.
 *
 * Each hit carries `_form`: `exact` (the two segments stood like that)
 * or `base` (only the file name, named compatibly). The difference
 * belongs in the display: a base hit is weaker evidence, and whoever
 * reads it should see that.
 */
export function find(root, p, opt = {}) {
  const f = forms(p);
  if (!f.length) return [];
  const [two, base] = f.length === 2 ? f : [null, f[0]];
  const pre = prefix(p);
  const out = [];
  const seen = new Set();

  const take = (list, form) => {
    for (const e of list) {
      const key = e.id ?? `${e._source}:${e._line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...e, _form: form });
    }
  };

  if (two) {
    try { take(memory.find(root, two, opt), 'exact'); } catch { /* empty */ }
  }
  try {
    const raw = memory.find(root, base, opt);
    take(raw.filter((e) => compatible(JSON.stringify(e), base, pre)), 'base');
  } catch { /* empty */ }

  return out;
}

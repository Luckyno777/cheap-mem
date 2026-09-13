/**
 * Profile — switchable measuring points that land in the ordinary log.
 *
 * ## Why this exists
 *
 * On 2026-09-12 the sibling memory's recall hook injected nothing
 * twice, because the index had to be rebuilt and went over its
 * deadline. Finding out WHERE the 4.9 seconds went needed
 * `node --cpu-prof` and a hand-written report script. The answer:
 * about 3.0 seconds in the raw captures (zlib, reading, extracting
 * conversation text), and it grows with every session.
 *
 * cheap-mem indexes raw captures the same way, so it has the same cost
 * ahead of it — and unlike us, someone running cheap-mem on their own
 * machine has no other way to find out why recall went quiet. A
 * measuring point is the cheapest diagnostic there is.
 *
 * So: points that
 *
 * - **cost nothing when off** — one comparison against a switch, no
 *   clock read, no allocation;
 * - **need no tooling** — the output is a line in the ordinary log,
 *   `grep 'msg=prof'` is the whole reader;
 * - **are machine-readable** — `key=value`, so they sort and sum
 *   without a parser.
 *
 * Switched on with `CHEAP_MEM_PROFILE=1`. Only that exact string.
 * Anything else — `true`, `yes`, an empty string — leaves it off. A
 * switch that turns on by accident is as bad as one that turns off by
 * accident.
 *
 * ## What this is not
 *
 * Not a replacement for a real profiler. A measuring point reports how
 * long a SECTION took that somebody thought worth naming in advance;
 * it cannot find what nobody suspected. For "where does the time
 * really go", `--cpu-prof` stays the tool. This answers the more
 * frequent question: "is it the thing that was slow last time?"
 */

/** Only the exact `1` switches it on. */
export function on(env = process.env) {
  return env.CHEAP_MEM_PROFILE === '1';
}

/**
 * Measure a section.
 *
 * Off, `fn()` is simply called — no `Date.now()`, no object, nothing.
 * On, a line follows.
 *
 * `count` may yield how many units were processed. Without it the line
 * carries no `items` — a rate computed from an invented count is worse
 * than no rate.
 */
export function measure(phase, sub, fn, { count = null, env = process.env, write = null } = {}) {
  if (!on(env)) return fn();
  const t0 = Date.now();
  let result;
  let failure = null;
  try { result = fn(); }
  catch (e) { failure = e; }
  const ms = Date.now() - t0;
  const items = failure ? null : numberFrom(count, result);
  (write ?? writeLine)(line({ phase, sub, ms, items, failure }));
  if (failure) throw failure;
  return result;
}

function numberFrom(count, result) {
  if (count == null) return null;
  const n = typeof count === 'function' ? count(result) : count;
  return Number.isFinite(n) ? n : null;
}

/**
 * The line.
 *
 * `ms` always; `items` and `rate_per_s` only when a real count was
 * there. A section that threw carries `err=1` — without it, a run that
 * aborted halfway looks like a fast one, and that is exactly what
 * nobody notices while reading.
 */
export function line({ phase, sub, ms, items = null, failure = null }) {
  const parts = ['msg=prof', `phase=${phase}`, `sub=${sub}`, `ms=${ms}`];
  if (items != null) {
    parts.push(`items=${items}`);
    parts.push(`rate_per_s=${ms > 0 ? Math.round((items * 1000) / ms) : items}`);
  }
  if (failure) parts.push('err=1');
  return parts.join(' ');
}

function writeLine(s) {
  // stderr, not stdout: stdout is the answer, and a measuring line in
  // it would become part of what a caller passes on.
  process.stderr.write(`${s}\n`);
}

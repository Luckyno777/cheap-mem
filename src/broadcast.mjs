/**
 * Error broadcast — a recorded error reaches whoever it is about to
 * hit, instead of waiting to be found.
 *
 * **The finding (2026-09-08, reference deployment).** 289 classified
 * errors, 207 distinct classes, 42 classes with more than one
 * incident: **43 % of classified errors recur**. The error had been
 * recorded every time. It just was not read — because reading was the
 * reader's duty.
 *
 * Here that duty flips: if agent A logs an error about a file B has
 * touched, B finds a note in its inbox. No model call, no search, and
 * B does not have to remember.
 *
 * --- Why literal, and why only paths ---------------------------------
 *
 * A ranked search over an error topic ALWAYS returns something, and a
 * broadcast that goes to everyone on every error is noise after the
 * third one — and noise is worse than silence, because it takes the
 * real warning down with it.
 *
 * So the trigger is a PATH, matched literally. If the error names no
 * path, nothing goes out. Measured against the reference corpus: 125
 * of 297 error entries (42 %) name a path in plain text, so the lane
 * is neither theoretical nor universal.
 *
 * --- Why the reach is small at first, and why that is not a bug ------
 *
 * A recipient is somebody who demonstrably touched the file — evidenced
 * by an entry of their own that names the path AND carries an agent
 * field. Before origin stamping, 79 % of the reference corpus carried
 * no such field; a dry run over the last 60 errors found a recipient
 * in 3 cases.
 *
 * That number grows with origin stamping, not with a loosening here.
 * Anyone who raises it by ranking instead of matching, or by sending to
 * everyone, has broken the lane rather than improved it.
 */
import * as memory from './memory.mjs';
import * as inbox from './inbox.mjs';

/**
 * A path in plain text: at least one slash, an extension.
 *
 * Deliberately narrow. `src/broadcast.mjs` hits, `something` does not,
 * and neither does `24/7` (no alphabetic extension).
 */
export const PATH_PATTERN = /(?:^|[\s"'`(\[<])([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,5})/g;

/**
 * Paths that make no trigger at all — the memory's own data.
 *
 * An error that mentions `global/errors.jsonl` (and many do, because
 * they talk about logging) would literally match almost every entry
 * ever written about the log. The broadcast would go to everybody —
 * exactly the noise a warning lane dies of.
 */
export const NO_TRIGGER = [
  /^global\/[a-z]+\.jsonl$/,
  /^projects\/[^/]+\/[a-z]+\.jsonl$/,
  /^inbox\//,
  /^raw\//,
];

/** At most this many triggers per error. The rest is bycatch. */
export const MAX_TRIGGERS = 3;

/**
 * At most this many recipients per broadcast.
 *
 * Not a saving: whoever touches a file with twenty people on it does
 * not have a warning problem but a coordination problem, and twenty
 * notes do not solve it. When the limit bites, the report says so —
 * nothing is truncated silently.
 */
export const MAX_RECIPIENTS = 5;

/**
 * The triggers of an entry: the paths it names in plain text.
 *
 * Reads `file`/`files`/`path` (if anybody sets them explicitly) AND
 * `title`/`text` — because a field that MUST be set for the lane to
 * carry gets forgotten, and then the lane looks right and does nothing.
 */
export function triggers(entry) {
  const sources = [
    entry?.file, entry?.path, entry?.title, entry?.text,
    ...(Array.isArray(entry?.files) ? entry.files : []),
  ].filter((x) => typeof x === 'string' && x);
  const raw = [];
  for (const q of sources) {
    // The field values often stand bare; the pattern wants a boundary
    // on the left. A leading space costs nothing and makes both cases
    // the same.
    for (const m of ` ${q}`.matchAll(PATH_PATTERN)) raw.push(m[1]);
  }
  const out = [];
  for (const p of raw) {
    if (out.includes(p)) continue;
    if (NO_TRIGGER.some((r) => r.test(p))) continue;
    out.push(p);
    if (out.length >= MAX_TRIGGERS) break;
  }
  return out;
}

/**
 * Who should be written to about this error.
 *
 * Reads only. Every recipient comes with EVIDENCE: which path, which
 * file, which line. Without evidence the note would be an assertion,
 * and an assertion about somebody else's work is the last thing that
 * belongs in their inbox.
 *
 * `withoutInbox` are the ones it would have reached who have no inbox.
 * They are REPORTED, not swallowed: a recipient that silently drops out
 * is a warning nobody misses.
 */
export function recipients(root, entry, { participants, sender = null } = {}) {
  const from = sender ?? entry?.agent ?? null;
  const found = new Map();
  const withoutInbox = new Set();
  const known = new Set(Object.keys(participants ?? {}));
  const trig = triggers(entry);

  for (const p of trig) {
    let hits;
    try { hits = memory.find(root, p, {}); } catch { continue; }
    for (const h of hits) {
      const a = h.agent;
      if (!a || a === from) continue;
      // The triggering entry itself is not evidence of somebody else's
      // work, even once it is written.
      if (entry?.id && h.id === entry.id) continue;
      if (!known.has(a)) { withoutInbox.add(a); continue; }
      if (found.has(a)) continue;
      found.set(a, { trigger: p, source: h._source ?? null, line: h._line ?? null, ts: h.ts ?? null });
    }
  }

  const list = [...found].map(([agent, evidence]) => ({ agent, ...evidence }));
  return {
    triggers: trig,
    recipients: list.slice(0, MAX_RECIPIENTS),
    tooMany: Math.max(0, list.length - MAX_RECIPIENTS),
    withoutInbox: [...withoutInbox],
  };
}

/**
 * The duplicate key, carried in the SUBJECT.
 *
 * The reference implementation used an envelope thread field; this
 * inbox format has no envelope, so the key goes where the format
 * already has room and a human can see it. Same guarantee, one less
 * moving part.
 */
export function marker(entry) {
  const id = String(entry?.id ?? '').trim();
  return id ? `[bc:${id}]` : null;
}

/** Who has already been sent this broadcast. */
export function alreadySent(root, entry, { participants }) {
  const m = marker(entry);
  if (!m) return new Set();
  const out = new Set();
  try {
    for (const n of inbox.read(root, participants).messages ?? []) {
      if (String(n.subject ?? '').includes(m)) out.add(n.to);
    }
  } catch { /* no inbox — then nothing has been sent */ }
  return out;
}

/** The text of one note. Short, evidenced, not in the imperative. */
export function note(entry, evidence, { from }) {
  const cls = entry?.class ? `[${entry.class}] ` : '';
  const title = String(entry?.title ?? entry?.text ?? '').split('\n')[0].slice(0, 300);
  const where = evidence.source
    ? `${evidence.source}${evidence.line ? `:${evidence.line}` : ''}`
    : '(no location)';
  return [
    `${from} recorded an error that touches ${evidence.trigger}.`,
    '',
    `  ${cls}${title}`,
    '',
    'You are getting this because an entry of yours names the same path:',
    `  ${where}${evidence.ts ? `  (${String(evidence.ts).slice(0, 10)})` : ''}`,
    '',
    'This is a notification, not an instruction. The full entry is under:',
    `  mem find "${evidence.trigger}" --literal`,
  ].join('\n');
}

/**
 * Actually send the broadcast.
 *
 * `dryRun: true` only says what would happen. The caller carries the
 * decision; this function makes none.
 */
export function send(root, entry, {
  participants, sender = null, now = new Date(), dryRun = false,
} = {}) {
  const from = sender ?? entry?.agent ?? null;
  const m = marker(entry);
  const found = recipients(root, entry, { participants, sender: from });
  const report = { ...found, marker: m, sent: [], skipped: [] };

  // No marker, no duplicate protection — and without duplicate
  // protection, no broadcast. A channel that redelivers the same note
  // on every run gets switched off, and then it is gone entirely.
  if (!m) {
    report.skipped = found.recipients.map((r) => ({ ...r, why: 'no-id' }));
    report.recipients = [];
    return report;
  }
  if (!from || !Object.hasOwn(participants ?? {}, from)) {
    report.skipped = found.recipients.map((r) => ({ ...r, why: 'sender-has-no-inbox' }));
    report.recipients = [];
    return report;
  }

  const already = alreadySent(root, entry, { participants });
  for (const r of found.recipients) {
    if (already.has(r.agent)) { report.skipped.push({ ...r, why: 'already-sent' }); continue; }
    if (dryRun) { report.sent.push({ ...r, dryRun: true }); continue; }
    try {
      const { name } = inbox.write(root, participants, {
        from,
        to: r.agent,
        subject: `Error broadcast ${m}: ${r.trigger}`,
        text: note(entry, r, { from }),
        now,
      });
      report.sent.push({ ...r, message: name });
    } catch (err) {
      report.skipped.push({ ...r, why: `failed: ${err.message}` });
    }
  }
  return report;
}

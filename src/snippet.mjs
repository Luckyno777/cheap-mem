// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Snippets — reusable code/script/text building blocks, WITH
 * placeholders instead of real data.
 *
 * **Why `snippet` and not `baustein`'s literal cognate ("building
 * block") or "template".** Both were considered and both lose to
 * "snippet" on the same test: does the word already mean something
 * else, close by, in this codebase?
 *   - "template" is already load-bearing vocabulary for something
 *     unrelated in EVERY file that touches HTML/CSS or a JS template
 *     literal (`grid-template-columns`, "template string", the SCRIPT
 *     templates in `src/astra/*.mjs`) — dozens of hits, all a
 *     different sense of the word. Naming a memory TYPE `template`
 *     would collide with that on every grep.
 *   - "snippet" has exactly one prior use in this codebase
 *     (`raw.snippet()` — the short excerpt shown around a search hit)
 *     and it is a LOCAL helper name, not a concept exposed anywhere
 *     else; a reader is unlikely to confuse "the excerpt shown next to
 *     a search hit" with "a reusable code/text block with
 *     placeholders" once both are in view, and no import ever needs
 *     both names in the same scope. It is also the term this exact
 *     concept already goes by outside this codebase (IDE "code
 *     snippets", "text snippets") for every one of the five kinds
 *     below, code included — "building block" does not read naturally
 *     for a mail template.
 * So: `snippet`, with this note as the paper trail for the next reader
 * who wonders why raw.mjs already used the word.
 *
 * **Not an authority problem, unlike `workflow`/`procedure`.** A code
 * snippet or a mail template is not a norm for all agents — the MCP
 * bridge MAY write this type. The obligation here is a different one:
 * a `text`/`mail`/`letter` snippet must pass the redaction check
 * before it is written. A hit is an ABORT, not a warning — unlike
 * `mem log`'s general stance of "warn but still write, or the content
 * is lost" (see `src/cli/commands/write.mjs`'s class-name comment),
 * there is nothing to lose here that is safe to keep: the whole point
 * of a snippet is that it gets reused, copied into other places, by
 * other agents — a real customer name/address/token sitting in a
 * "reusable" template is the leak multiplied by every future use.
 *
 * **What "the redaction check" actually catches, said honestly.**
 * `src/redaction.mjs` is this codebase's one redaction module, and its
 * `PATTERNS` are CREDENTIAL-shaped: API keys, tokens, passwords, PEM
 * blocks, bearer/basic auth, JWTs, a `--token <value>`-style CLI flag,
 * and a keyword-free "address / secret" pair written the way a human
 * hands over an access (measured against lucky-mem's `redaktion.mjs`,
 * which detects the identical classes — see that module's own PATTERNS
 * comment for the parity accounting). It still has no pattern for
 * free-text personal data — a name, a street address, a customer
 * number typed as prose would NOT be caught. That remains a real gap
 * against the design's literal example ("Name, Adresse,
 * Kundennummer"), not papered over here: this module calls the one
 * redaction check this house has, and that check's reach stops at
 * credential-shaped data, however it is written down.
 */

import * as redaction from './redaction.mjs';

/** The type name, written in exactly one place. */
export const TYPE = 'snippet';

/**
 * Closed vocabulary. Adding a kind is a diff here, not a free string
 * accepted at write time — same reasoning as `archive.KINDS` and
 * `errorclass.CLASSES`.
 */
export const KINDS = Object.freeze(['code', 'script', 'text', 'mail', 'letter']);

/** The kinds whose `body` must clear the redaction check before write. */
export const REDACTION_KINDS = Object.freeze(['text', 'mail', 'letter']);

export function validKind(k) {
  return KINDS.includes(String(k ?? '').trim());
}

/** `{{NAME}}`-shaped placeholder identifiers found in `body`. */
export function placeholdersOf(body) {
  const text = String(body ?? '');
  const out = [];
  const re = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
  let m;
   
  while ((m = re.exec(text))) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * The redaction gate. Returns `{ ok, findings }` — `findings` is
 * `redaction.redact()`'s own `found` list (`{type, count}`, never the
 * value), so the caller can say WHAT kind of real data it looks like
 * without this module inventing a second vocabulary for it.
 *
 * Only runs for `REDACTION_KINDS` — a `code`/`script` snippet is
 * expected to contain things that LOOK credential-shaped in a test
 * fixture or an example call (`sk-ant-...` in a docstring, say) without
 * being a leak of a real one; gating those the same way as a mail
 * template would make the check impossible to use honestly for the
 * exact places it is least needed.
 */
export function checkRedaction(kind, body) {
  if (!REDACTION_KINDS.includes(String(kind ?? '').trim())) return { ok: true, findings: [] };
  const { found } = redaction.redact(String(body ?? ''));
  return { ok: found.length === 0, findings: found };
}

/**
 * Check the fields before anything is written. Returns `{ ok, errors
 * }` — same contract as `procedure.check`/`workflow.check`. Does not
 * throw: the caller decides whether that is an abort (it always is,
 * for the redaction finding) or something softer.
 */
export function check(fields = {}) {
  const problems = [];
  const title = String(fields.title ?? '').trim();
  const kind = String(fields.kind ?? '').trim();
  const body = String(fields.body ?? '').trim();

  if (!title) problems.push('title missing — a snippet without a name is never found again');
  if (!kind) problems.push(`kind missing. Known: ${KINDS.join(', ')}`);
  else if (!validKind(kind)) problems.push(`kind '${kind}' is outside the closed list. Known: ${KINDS.join(', ')}`);
  if (!body) problems.push('body missing — that is the snippet itself');

  if (kind && body && REDACTION_KINDS.includes(kind)) {
    const gate = checkRedaction(kind, body);
    if (!gate.ok) {
      const what = gate.findings.map((f) => `${f.type}x${f.count}`).join(', ');
      problems.push(`body looks like it carries real data, not placeholders: ${what}. `
        + 'Replace the real value(s) with a {{PLACEHOLDER}} and try again — '
        + `a ${kind} snippet is reused by other agents, so this is an abort, not a warning.`);
    }
  }

  if (Object.hasOwn(fields, 'version') && fields.version !== undefined) {
    const v = fields.version;
    if (!(Number.isInteger(v) && v >= 1)) problems.push('version must be a positive integer when given');
  }

  if (fields.placeholders !== undefined && !isArrayOfStrings(fields.placeholders)) {
    problems.push('placeholders must, when set, be an array of non-empty strings');
  }
  if (fields.language !== undefined && typeof fields.language !== 'string') {
    problems.push('language must, when set, be a string');
  }
  if (fields.origin !== undefined && typeof fields.origin !== 'string') {
    problems.push('origin must, when set, be a string');
  }
  if (fields.test !== undefined && typeof fields.test !== 'string') {
    problems.push('test must, when set, be a path (string)');
  }
  if (fields.used_by !== undefined && !isArrayOfStrings(fields.used_by)) {
    problems.push('used_by must, when set, be an array of ids (strings) — upkeep lives at '
      + 'workflow.references.snippet, this is only the back-reference');
  }

  return { ok: problems.length === 0, errors: problems };
}

function isArrayOfStrings(x) {
  return Array.isArray(x) && x.every((s) => typeof s === 'string' && s.trim());
}

/**
 * Complete the fields the way they should be stored: `version`
 * defaults to 1 for a snippet's first entry. A later version is never
 * an edit of this entry — it is a NEW entry carrying `replaces_id`
 * (`memory.correctionEntry`, the same append-only mechanism every
 * corrected entry in this house already uses), with its own `version`
 * one higher than the entry it replaces. Computing "one higher than
 * the entry it replaces" is the caller's job (it has the predecessor
 * in hand at that point); this function only supplies the default for
 * a brand new title.
 *
 * `placeholders` defaults to whatever `placeholdersOf(body)` finds, the
 * same way `baustein.ergaenze` always stamps a (possibly empty) array
 * so a later dashboard preview never has to tell "no placeholders"
 * apart from "field missing".
 */
export function complete(fields = {}) {
  const out = { ...fields };
  if (out.version === undefined) out.version = 1;
  if (out.placeholders === undefined) out.placeholders = placeholdersOf(out.body);
  return out;
}

/** The marking that precedes every display. */
export function mark(entry = {}) {
  const kind = entry.kind ?? '(no kind)';
  const v = entry.version ?? '?';
  return `Snippet (${kind}, v${v})`;
}

/** Marking plus the body — placeholders shown as-is, never filled in here. */
export function display(entry = {}) {
  const head = mark(entry);
  const title = entry.title ? `${entry.title}\n` : '';
  const ph = placeholdersOf(entry.body);
  const phLine = ph.length ? `  placeholders: ${ph.map((p) => `{{${p}}}`).join(', ')}\n` : '';
  return `${head}\n${title}${phLine}${entry.body ?? ''}`.trimEnd();
}

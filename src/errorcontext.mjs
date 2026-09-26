/**
 * errorcontext — F1 (BAUPLAN-mem-admin_02.md, Block F, ported as F4):
 * what appears IN ADDITION to its own line when an error is logged.
 *
 * Two jobs, ONE place — so the CLI (`mem log error`) and the bridge
 * (`mem_log` in `bin/mem-mcp`) show the same thing, instead of two
 * versions that drift (see the comment on `src/errorfile.mjs`):
 *
 *   1. `historyLines()` — earlier errors for the same file (at most
 *      three lines), their guards, open duties about it. Display only,
 *      never a write.
 *   2. `checkAndDuty()` — on a real repetition (`src/repetition.mjs`)
 *      automatically create EXACTLY ONE open duty per file+class, or,
 *      if one already exists, only append the new error id to it (via
 *      the existing correction path, `memory.correctionEntry` —
 *      append-only, no line touched).
 *
 * **Abort criterion (see BAUPLAN Block F, closing line).** More than
 * 20 automatically created duties, older than 14 days and still open,
 * means: the mechanism is producing noise instead of work — then it
 * gets cut narrower or switched off. That is an OBSERVATION rule for
 * `mem doctor`/a session, not a code latch here: a number that only
 * shows itself over time belongs in a measurement, not in a write path
 * that decides for itself, once the threshold is reached, to stop
 * writing duties.
 *
 * **This path never writes procedures.** It only ever creates entries
 * of type `duty` (tasks) — never `procedure` (norms). The two meanings
 * under "duty/norm" are the same distinction BAUPLAN-mem-admin_02.md
 * Block F names in its side finding, and `src/cli/commands/write.mjs`
 * already refuses the bridge a `procedure` write for the same reason.
 *
 *   3. `evidencePresent()` — F2/F4: does closing a duty that grew out
 *      of errors (carries `error_ids`) point at a real guard, or is
 *      that only a claim? `memory.dutyHasEvidence()` is the actual
 *      check, called from the ONE point every close goes through
 *      (`memory.closeDuty`); this stays as an alias for existing
 *      callers (the doctor finding `closed-without-evidence`).
 */

import * as memory from './memory.mjs';
import * as errorfile from './errorfile.mjs';
import * as repetition from './repetition.mjs';

/** Marker on a duty: created automatically by this path. */
export const AUTOMATIC_FIELD = 'automatic';

function allErrors(root) {
  const out = [];
  for (const project of [null, ...memory.listProjects(root)]) {
    let entries;
    try { ({ entries } = memory.readLog(root, 'error', { project })); }
    catch { continue; }
    for (const e of entries) {
      if (!e || e.__broken || memory.isClosingLine(e)) continue;
      out.push(e);
    }
  }
  return out;
}

/**
 * Earlier errors for the same file — at most three, newest first. No
 * write.
 */
export function earlierErrors(root, entry, { max = 3 } = {}) {
  const files = errorfile.files(entry);
  if (!files.length) return { files, hits: [] };
  const hits = allErrors(root)
    .filter((x) => x.id !== entry.id)
    .filter((x) => errorfile.files(x).some((f) => files.includes(f)))
    .sort((a, b) => String(b.ts ?? '').localeCompare(String(a.ts ?? '')))
    .slice(0, max);
  return { files, hits };
}

/**
 * Open duties belonging to this file or to these error ids.
 * `memory.openDuties()` folds `replaces_id` chains itself (see there) —
 * this only filters, no longer folds.
 */
export function openDutiesFor(root, { files = [], errorIds = [], project = null } = {}) {
  let open;
  try { ({ open } = memory.openDuties(root, { project: project ?? undefined })); }
  catch { return []; }
  const idSet = new Set(errorIds);
  return open.filter((d) => (d.file && files.includes(d.file))
    || (Array.isArray(d.error_ids) && d.error_ids.some((id) => idSet.has(id))));
}

/**
 * The display lines for the just-written error `entry` — as they are
 * printed AFTER writing. `[]` when there is nothing to name, never an
 * empty header.
 */
export function historyLines(root, entry, { project = null } = {}) {
  const { files, hits } = earlierErrors(root, entry);
  if (!files.length || !hits.length) return [];

  const lines = [`  Earlier for ${files[0]}:`];
  for (const e of hits) {
    const guardText = e.guard && typeof e.guard === 'object'
      ? `guard: ${e.guard.kind ?? '?'}@${e.guard.path ?? '?'}`
      : 'guard: none';
    const title = String(e.title ?? e.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
    lines.push(`    ${String(e.ts ?? '').slice(0, 10)}  ${String(e.id).padEnd(14)} `
      + `[${e.class ?? '?'}] ${title}  (${guardText})`);
  }

  const about = openDutiesFor(root, {
    files, errorIds: [entry.id, ...hits.map((e) => e.id)], project,
  });
  if (about.length) {
    lines.push(`  Open duties about this: ${about.map((d) => `${d.id} ${d.title ?? d.text ?? '?'}`).join('; ')}`);
  }
  return lines;
}

/**
 * On a real repetition, automatically create EXACTLY ONE open duty per
 * file+class — or, if one already exists, only append the new error
 * id.
 *
 * With no determinable file NOTHING is created: the title "guard for
 * <class> at <file>" and the dedup key (file+class) both need a file.
 * That is explicitly not a failure — only the class threshold
 * (`class-3x-7-days`) can fire without a file, and then it stays at
 * the class warning `mem log` already shows.
 */
export function checkAndDuty(root, entry, { project = null, now = new Date() } = {}) {
  const asOf = now instanceof Date ? now.getTime() : new Date(now).getTime();
  // Stamped explicitly (`data.ts` wins over `logEntry`'s own default of
  // the real wall clock) so a duty created for a repetition dated `now`
  // is itself dated `now` — otherwise every duty this function writes
  // would carry the moment the TEST or the digest run happened to
  // execute, not the moment the repetition it tracks actually occurred.
  const ts = new Date(asOf).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const all = allErrors(root);
  const r = repetition.check(entry, all, { now: asOf });
  if (!r.is) return { triggered: false, reasons: [] };

  const file = r.files[0] ?? null;
  const className = typeof entry.class === 'string' && entry.class.trim() ? entry.class.trim() : null;
  if (!file || !className) {
    return { triggered: true, reasons: r.reasons, created: false,
      why: !file ? 'no determinable file' : 'no class' };
  }

  const newIds = new Set([entry.id, ...r.hits.map((h) => h.id)]);

  const { open } = memory.openDuties(root, { project: project ?? undefined });
  const existing = open
    .find((d) => d[AUTOMATIC_FIELD] === true && d.class === className && d.file === file);

  if (existing) {
    const priorIds = Array.isArray(existing.error_ids) ? existing.error_ids : [];
    const allIds = [...new Set([...priorIds, ...newIds])];
    if (allIds.length === priorIds.length) {
      // Already in there — nothing new, no empty correction line.
      return { triggered: true, reasons: r.reasons, created: false, appended: false, duty: existing };
    }
    // Only the CONTENT fields travel — neither the machine fields
    // (id/ts/agent/replaces_id, see `memory.correctionEntry`) nor the
    // `_`-prefixed display fields `openDuties()` appends for its own
    // bookkeeping (`_source`, `_line`, `_project`) — those would
    // otherwise be written as literal fields on the new line.
    const rest = {};
    for (const [k, v] of Object.entries(existing)) {
      if (k.startsWith('_') || ['id', 'ts', 'agent', 'replaces_id'].includes(k)) continue;
      rest[k] = v;
    }
    const { path: p, entry: updated } = memory.correctionEntry(root, 'duty', existing.id, {
      ...rest, error_ids: allIds, ts,
    }, { project: existing._project ?? project ?? null });
    return { triggered: true, reasons: r.reasons, created: false, appended: true, path: p, duty: updated };
  }

  const who = entry.agent ?? memory.agentDefault();
  const { path: p, entry: created } = memory.logEntry(root, 'duty', {
    ts,
    title: `Guard for ${className} at ${file}`,
    text: `Created automatically (F4): ${entry.id} repeats ${r.hits.length ? r.hits.map((h) => h.id).join(', ') : 'the class threshold'} `
      + `at ${file} (${className}). Only closes with evidence — see F2/F4.`,
    owner: who,
    file,
    class: className,
    error_ids: [...newIds],
    [AUTOMATIC_FIELD]: true,
    tags: ['auto-duty', 'guard-missing'],
  }, { project });
  return { triggered: true, reasons: r.reasons, created: true, appended: false, path: p, duty: created };
}

/**
 * F2/F4: does closing this duty carry a real guard, or only the claim
 * that it is done?
 *
 * The check itself lives in `memory.dutyHasEvidence()`, called from the
 * ONE point every close actually goes through (`memory.closeDuty`).
 * This stays as an alias for existing callers — the doctor finding
 * `closed-without-evidence`.
 */
export function evidencePresent(root, duty) {
  return memory.dutyHasEvidence(root, duty);
}

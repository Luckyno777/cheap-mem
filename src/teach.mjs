/**
 * The teaching — what the memory has to say to a newcomer.
 *
 * Five sections, and the division comes from the body of entries
 * itself, not from an opinion:
 *
 *   Established  cited and not contradicted
 *   Tentative    concluded once, not yet cited
 *   Contested    there is a `contradicts` link on it
 *   Dead ends    an error that has a learning attached
 *   Corrections  what was retracted, and by what
 *
 * ## This module computes nothing itself
 *
 * That is the carrying property, not modesty. The verdicts "cited",
 * "contested" and "still holds" already live in `memory.experiences()`
 * and `memory.holds()`. Rebuilding them here would be a second
 * derivation, and two derivations of the same verdict eventually
 * disagree — whoever then holds both cannot say which one is lying.
 *
 * So the derivations are HANDED IN rather than imported. That makes
 * the test cheap and the dependency visible: what arrives here was
 * decided by someone else.
 *
 * ## No model call, no half-life factor
 *
 * The obvious design would discount age with a half-life: anything
 * older than 30 days counts half. That does not exist here. An error
 * from three months ago happened just as much as one from yesterday —
 * what devalues it is a correction, and that stands there as a line.
 * Age is not a counter-argument, it is just a number that is easy to
 * compute.
 */

/** The five sections. Closed list, fixed order. */
export const SECTIONS = Object.freeze([
  'established', 'tentative', 'contested', 'deadends', 'corrections',
]);

const HEADING = {
  established: 'Established — cited and uncontested',
  tentative: 'Tentative — concluded once, not yet cited',
  contested: 'Contested — something contradicts it',
  deadends: 'Dead ends — someone has walked this way already',
  corrections: 'Corrections — what was retracted, and by what',
};

/** A short line from an entry. Title before text, never both. */
export function short(e, max = 110) {
  const t = String(e?.title ?? e?.choice ?? e?.text ?? e?.fact ?? e?.id ?? '').trim()
    .replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Fill the sections.
 *
 * Everything that derives comes from outside. If a derivation is
 * missing it is NOT substituted — the section stays empty and says so.
 * Building a stand-in would be exactly the second derivation this
 * module avoids.
 */
export function collect(root, {
  experiences = null, readLog = null, listProjects = null,
  holds = null, retiredMap = null, TYPES = null, project = null,
} = {}) {
  const missing = [];
  const sections = {
    established: [], tentative: [], contested: [], deadends: [], corrections: [],
  };

  if (typeof experiences === 'function') {
    let all = [];
    try { all = experiences(root, { minCited: 0 }) ?? []; }
    catch { missing.push('experiences() did not answer'); }
    for (const e of all) {
      if (project && (e._project ?? 'global') !== project) continue;
      const line = { id: e.id ?? null, text: short(e), cited: e.cited ?? 0 };
      if (e.contested) sections.contested.push(line);
      else if ((e.cited ?? 0) > 0) sections.established.push(line);
      else sections.tentative.push(line);
    }
  } else {
    missing.push('without experiences(): Established, Tentative and Contested stay empty');
  }

  if (typeof readLog === 'function' && TYPES) {
    const projects = project ? [project === 'global' ? null : project]
      : [null, ...(typeof listProjects === 'function' ? listProjects(root) : [])];
    const learnedFrom = new Set();
    const errorsById = new Map();
    const corrections = [];
    for (const p of projects) {
      for (const type of Object.keys(TYPES)) {
        let res;
        try { res = readLog(root, type, { project: p }); } catch { continue; }
        const retired = typeof retiredMap === 'function' ? retiredMap(res.entries) : null;
        for (const e of res.entries) {
          if (typeof holds === 'function' && !holds(e, retired)) {
            // A correction is exactly what `holds` excludes — and
            // therefore it is NOT skipped here but counted as its own
            // piece of information.
            if (e?.id && retired?.has(e.id)) {
              corrections.push({ id: e.id, text: short(e), by: retired.get(e.id)?.by ?? null });
            }
            continue;
          }
          if (type === 'error' && e.id) errorsById.set(e.id, e);
          const q = e?.provenance && (e.provenance.derived_from ?? e.provenance.inferred_from);
          if (Array.isArray(q)) for (const x of q) learnedFrom.add(x);
        }
      }
    }
    for (const [id, e] of errorsById) {
      if (!learnedFrom.has(id)) continue;
      sections.deadends.push({ id, text: short(e), class: e.class ?? null });
    }
    sections.corrections = corrections;
  } else {
    missing.push('without readLog(): Dead ends and Corrections stay empty');
  }

  // Deterministic: by strength, ties by id.
  sections.established.sort((a, b) => b.cited - a.cited || String(a.id).localeCompare(String(b.id)));
  for (const k of ['tentative', 'contested', 'deadends', 'corrections']) {
    sections[k].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  return { sections, missing };
}

/** Human text. An empty section says that it is empty. */
export function asText({ sections, missing = [] }) {
  const z = [];
  for (const name of SECTIONS) {
    const list = sections[name] ?? [];
    z.push(`--- ${HEADING[name]} (${list.length}) ---`);
    if (!list.length) z.push('  (nothing) — which means empty, not "fine"');
    for (const e of list) {
      const extra = e.cited ? `  (cited x${e.cited})`
        : (e.by ? `  -> ${e.by}` : (e.class ? `  [${e.class}]` : ''));
      z.push(`  ${e.text}${extra}`);
    }
    z.push('');
  }
  if (missing.length) {
    z.push('What this teaching could NOT see:');
    for (const m of missing) z.push(`  - ${m}`);
  }
  return z.join('\n').trimEnd();
}

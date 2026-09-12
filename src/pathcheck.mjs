/**
 * Do the paths named in entries still point anywhere?
 *
 * Entries name files: "install/claude-code.sh does not quote the bash
 * path", "src/search.mjs:736 filters relatively". That is the anchor
 * the before-edit hook hangs on. Rename or delete the file and the
 * entry points into nothing — and because it is still found and still
 * injected, it looks like a valid hint about something that no longer
 * exists.
 *
 * ## The yardstick, and a wrong grip on it
 *
 * Measured in the sibling memory on 2026-09-12: 152 of 472 mentions
 * (32 %) point into nothing. That was wrong, and from exactly the
 * cause this module guards against: everything was checked against the
 * WRONG tree. `src/search.mjs` belongs to one project and
 * `bin/pipeline.mjs` to another — in a third they are missing for good
 * reason.
 *
 * Checked per project against its own tree: 91 % to 97 % of mentions
 * are intact. The real drift is 3 to 9 %, and that is why this is a
 * CHECK and not a display: a warning that fires on 3 % of cases
 * belongs in `mem doctor`, not in every turn.
 *
 * From that follows the carrying rule: **a mention is only checkable
 * against the tree the entry belongs to.** Without a known tree the
 * result is `unknown` — expressly not `intact`. A checker that reports
 * the unchecked as healthy is worse than none, and this very checker
 * has already made that mistake once.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Where the project-to-tree map lives (optional). */
export const TREES_FILE = path.join('.pipeline', 'trees.json');

/**
 * What looks like a path in a source tree.
 *
 * Deliberately bound to known root directories rather than "anything
 * with a slash and an extension": otherwise it catches locations
 * inside the memory itself (`global/errors.jsonl:82`) and URLs, and
 * then the checker reports drift where there is none.
 *
 * The look-behind is not cosmetic: without it the pattern reads
 * `https://example.org/src/foreign.mjs` as a mention of
 * `src/foreign.mjs` and reports drift for a file that was never in any
 * tree of ours.
 */
export const PATH_PATTERN =
  /(?<![A-Za-z0-9_./-])((?:src|bin|test|install|\.claude|ops|agents|compare|eval|scripts)\/[A-Za-z0-9_.\/-]+\.(?:mjs|js|ts|sh|md|json|yaml|yml|sql|html))\b/g;

/** Verdicts. Closed list. */
export const VERDICT = Object.freeze({
  INTACT: 'intact',
  DANGLING: 'dangling',
  UNKNOWN: 'unknown',
});

/** Read the map. Without it only the own project counts. */
export function trees(root) {
  const fallback = { global: root };
  try {
    const o = JSON.parse(fs.readFileSync(path.join(root, TREES_FILE), 'utf8'));
    if (o && typeof o === 'object') return { ...fallback, ...o };
  } catch { /* no map: then only the own tree */ }
  return fallback;
}

/** All path mentions of an entry. */
export function mentions(entry) {
  const t = JSON.stringify(entry ?? {});
  return [...new Set([...t.matchAll(PATH_PATTERN)].map((m) => m[1]))];
}

/**
 * Judge one mention.
 *
 * `tree === undefined` means no tree is known for this project. Then
 * UNKNOWN, not INTACT.
 */
export function judge(p, tree) {
  if (!tree) return VERDICT.UNKNOWN;
  try { return fs.existsSync(path.join(tree, p)) ? VERDICT.INTACT : VERDICT.DANGLING; }
  catch { return VERDICT.UNKNOWN; }
}

/**
 * The whole body, per project.
 *
 * `readAll` yields `[{ project, entry, source, line }]` — handed in so
 * this module needs to know nothing about storage and the test runs
 * without a memory.
 */
export function check(root, { readAll, map = null } = {}) {
  const where = map ?? trees(root);
  const per = new Map();
  for (const { project, entry, source, line } of readAll()) {
    const p = project ?? 'global';
    if (!per.has(p)) per.set(p, { project: p, tree: where[p] ?? null, intact: 0, dangling: [], unknown: 0 });
    const rec = per.get(p);
    for (const m of mentions(entry)) {
      const v = judge(m, where[p]);
      if (v === VERDICT.INTACT) rec.intact += 1;
      else if (v === VERDICT.DANGLING) rec.dangling.push({ path: m, source, line });
      else rec.unknown += 1;
    }
  }
  const projects = [...per.values()].sort((a, b) => a.project.localeCompare(b.project));
  const total = projects.reduce((s, p) => ({
    intact: s.intact + p.intact, dangling: s.dangling + p.dangling.length, unknown: s.unknown + p.unknown,
  }), { intact: 0, dangling: 0, unknown: 0 });
  return { projects, total };
}

/** Human text. */
export function asText(r) {
  const z = [];
  for (const p of r.projects) {
    const checkable = p.intact + p.dangling.length;
    const q = checkable ? `${((100 * p.intact) / checkable).toFixed(0)} %` : '—';
    const tree = p.tree ? '' : '  (no tree known)';
    z.push(`  ${p.project.padEnd(12)} intact ${String(p.intact).padStart(4)}  `
      + `dangling ${String(p.dangling.length).padStart(3)}  unchecked ${String(p.unknown).padStart(4)}  ${q}${tree}`);
    for (const d of p.dangling.slice(0, 5)) z.push(`      ${d.path}   (${d.source}:${d.line})`);
  }
  z.push(`  Total: ${r.total.intact} intact, ${r.total.dangling} dangling, ${r.total.unknown} unchecked`);
  z.push('  unchecked does NOT mean intact — those projects have no tree configured');
  z.push(`  configure: ${TREES_FILE}  {"other": "/path/to/other"}`);
  return z.join('\n');
}

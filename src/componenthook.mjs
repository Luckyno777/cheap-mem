// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * What `mem component <path> --hook` answers — as a function.
 *
 * The before-edit hook used to start `node bin/mem component ... --hook
 * --json` as a process of its own, just to get this one answer: a full
 * CLI start (every command group loaded) for a lookup that needs five
 * modules. Since 2026-10-14 (hooks-harden-cm, TB5) the hook calls these
 * two functions inside its single node process, and the CLI handler calls
 * the very same ones — one truth for the answer, two doors to it.
 */

import * as component from './component.mjs';
import * as componentTable from './component-table.mjs';
import * as capability from './capability.mjs';
import * as errorcontext from './errorcontext.mjs';
import { compactLine } from './compactline.mjs';

/**
 * The lookup: the cached table first (read-only, never rebuilt inline),
 * the live search when the table has nothing fresh to say.
 * `project` restricts to one drawer (or `global`); omitted = every project.
 */
export function lookup(root, p, { top, project } = {}) {
  const cap = project
    ? capability.grantProject(String(project), { subject: 'cli' })
    : capability.grantAll('cli');
  const res = componentTable.beforeEditHits(root, p, { cap: top });
  const usedTable = res.hits !== null;
  const hits = res.hits ?? component.find(root, p, cap);
  return { res, usedTable, hits };
}

/**
 * The `--hook --json` object (before the output guard masks it).
 * Open duties and released procedures come from the FULL hit list, not
 * the `top` slice: the hook shows them in their own capped section, see
 * errorcontext.beforeEditDuties().
 */
export function asJson(root, p, { res, usedTable, hits }, { top, project } = {}) {
  const owed = errorcontext.beforeEditDuties(root, p, hits, {
    project: project ? String(project) : undefined,
  });
  const row = (e) => ({ id: e.id, ts: e.ts ?? null, source: e._source ?? null,
    label: compactLine(e, { root }) || '' });
  return {
    path: p,
    forms: component.forms(p),
    n: hits.length,
    duties: owed.duties.map(row),
    procedures: owed.procedures.map(row),
    table: { state: res.tableState, usedTable, backgroundRebuild: res.backgroundRebuild },
    hits: hits.slice(0, top).map((h) => ({
      score: null,
      form: h._form,
      source: h._source,
      line: h._line,
      ts: h.ts ?? null,
      raw: false,
      label: compactLine(h) || '',
    })),
  };
}

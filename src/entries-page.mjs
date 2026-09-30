// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// entries-page.mjs — D3b: the paged entry list as a page the SERVER
// renders, instead of the raw JSON answer of /entries.json in a new tab.
//
// **What it is.** `GET /entries?type=&project=&q=&after=<cursor>&n=` takes
// the SAME filters and the SAME cursor as `/entries.json` and asks the
// SAME function (`pages.page()`) — there is one list, not two. This
// module only turns its answer into HTML: a filter form (a plain GET
// form, no script), the rows, a "next page" link that carries the cursor.
//
// **Nothing is loaded from outside.** No script at all, no CDN, no
// absolute URL: the page links this server's own stylesheet and inlines
// the font-face CSS, exactly as the dashboard shell does (probe:
// test/entries-page.test.mjs, same rule as test/dashboard-page.test.mjs).
//
// **The four states are visible, and an empty list is not an error.**
//   ok       -> "good" badge; zero rows say "No entry matches", in the
//               quiet tone, with status 200
//   warning  -> "warning" badge and the reason; the rows that could be
//               read are still shown
//   unknown  -> "unknown" badge (its own tone): the FILTER names
//               something that does not exist; no rows, status 400
//   error    -> "error" badge and the reason, status 500
import * as pages from './pages.mjs';
import * as memory from './memory.mjs';
import * as dashboardPage from './dashboard-page.mjs';
import * as icon from './icon.mjs';

/** The route of the page — read by the server's path list. */
export const PATH = '/entries';

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/** state -> [badge tone class of the dashboard stylesheet, label, HTTP status]. */
export const STATES = Object.freeze({
  ok: ['good', 'ok', 200],
  warning: ['warn', 'warning', 200],
  unknown: ['unknown', 'unknown', 400],
  error: ['bad', 'error', 500],
});

/** The query string for a page of the same list (empty values dropped). */
function href(params, extra = {}) {
  const all = { ...params, ...extra };
  const qs = Object.entries(all).filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return qs ? `${PATH}?${qs}` : PATH;
}

function options(values, chosen, allLabel) {
  return [`<option value=""${chosen ? '' : ' selected'}>${h(allLabel)}</option>`]
    .concat(values.map((v) => `<option value="${h(v)}"${v === chosen ? ' selected' : ''}>${h(v)}</option>`)).join('');
}

/**
 * Answers one request: `{ status, html }`. `query` is a URLSearchParams.
 * Never throws for a bad filter or cursor — `pages.page()` already
 * answers those as `unknown`/`error`; a throw inside it becomes `error`
 * here, never a blank page.
 */
export function render(root, query) {
  const params = {
    type: query.get('type') || null,
    project: query.get('project') || null,
    q: query.get('q') || '',
    n: query.get('n') || null,
  };
  const after = query.get('after') || null;
  let found;
  try {
    found = pages.page(root, { ...params, after, n: params.n ?? undefined });
  } catch (e) {
    found = { state: 'error', entries: [], next: null, asOf: null, reason: `The list could not be built: ${e?.message || e}` };
  }
  const [tone, label, status] = STATES[found.state] ?? ['unknown', 'unknown', 500];

  let projects = [];
  try { projects = ['global', ...memory.listProjects(root)]; } catch { /* the filter then offers none */ }
  const types = Object.keys(memory.TYPES);

  const rows = (found.entries ?? []).map((e) => `<li class="row"><div class="row-main"><span class="badge">${h(e.typeLabel || e.type)}</span><div><strong>${h(e.headline || e.id)}</strong><p><span class="mono">${h(e.id)}</span> · ${h(e.project)} · ${h(e.ts)}${e.agent ? ` · ${h(e.agent)}` : ''}</p></div></div></li>`).join('');

  let body;
  if (found.state === 'unknown' || found.state === 'error') {
    body = `<p class="note" role="status">${h(found.reason || 'No reason given.')}</p>`;
  } else if (!rows) {
    body = '<p class="quiet" id="empty">No entry matches this filter. The list is empty, not broken.</p>';
  } else {
    body = `<ul class="list">${rows}</ul>`;
  }
  const warn = found.state === 'warning' && found.reason ? `<p class="note warn" role="status">${h(found.reason)}</p>` : '';
  const next = found.next ? `<p><a class="btn" id="next" rel="next" href="${h(href(params, { after: found.next }))}">Next page →</a></p>` : '';

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101917"><title>Entries · ${h(dashboardPage.TITLE)}</title>
${icon.markLink(64)}
<style>
${dashboardPage.fontCss()}
.epage{max-width:880px;margin:0 auto;padding:28px 18px 60px}.epage form{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}.epage .field,.epage select{background:var(--raised);border:1px solid var(--line);border-radius:9px;padding:9px 11px}.epage .list{list-style:none;margin:0;padding:0 18px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}.epage .note{border:1px solid var(--line);border-radius:9px;padding:10px 13px;margin:12px 0}.epage .note.warn{border-color:#e8c58630;color:var(--gold)}.epage .head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
</style>
<link rel="stylesheet" href="${h(dashboardPage.pathWithVersion(dashboardPage.PATHS.css))}">
</head><body><main class="epage">
<p class="small"><a href="/dashboard#knowledge/entries">← Dashboard</a></p>
<div class="head"><h2>Entries</h2><span class="badge ${tone}" id="state" data-state="${h(found.state)}"><i class="dot"></i>${h(label)}</span><span class="small quiet">${found.asOf ? `as of ${h(found.asOf)}` : ''}</span></div>
<form method="get" action="${PATH}" aria-label="Filter the entries"><select name="type" aria-label="Type">${options(types, params.type, 'All types')}</select><select name="project" aria-label="Project">${options(projects, params.project, 'All projects')}</select><input class="field" type="search" name="q" value="${h(params.q)}" placeholder="Search text" aria-label="Search text"><button class="btn primary" type="submit">Filter</button></form>
${warn}${body}${next}
</main></body></html>`;
  return { status, html };
}

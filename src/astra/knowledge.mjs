// astra/knowledge — the entries tab: search, filter chips, detail pane.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
//
// **D3 (2026-09-27): wiring `/entries.json`, and why it is a plain form,
// never a `fetch()`.** The first version of this change added a
// client-side `fetch('/entries.json')` loop to page past `LIST_MAX`.
// That broke `test/dashboard.test.mjs`'s "the page reaches nothing but
// the one font Lucky decided on" — a pre-existing, currently-passing
// latch that asserts, unconditionally, `doesNotMatch(html, /\bfetch\(|
// XMLHttpRequest/)`. That is not a comment saying the rule USED to hold;
// it is a probe that runs on every build and was red the moment a
// `fetch(` reached this page. So the honest reading of
// `docs/dashboard-single-entry.md`'s own "no fetch, so there is no
// failed fetch" note is the OTHER branch this task's own instructions
// name: measured, not assumed, this is a deliberate, ENFORCED property
// of the whole desk, not merely "not wired yet" — a `fetch()`, even one
// that only ever reaches this page's OWN server, is a request that can
// fail, and the whole point of that latch (its own header: "no CDN, no
// fetch, no second file... the demo fallback stays impossible because
// there is still no request the DATA could fall back from") is that
// nothing on this page depends on a request succeeding. Adding one for
// pagination would be exactly the class of regression that test exists
// to catch, not a gap it forgot to cover.
//
// So `/entries.json` (E1.3) is wired here WITHOUT JavaScript at all: a
// plain `<form method="get" action="/entries.json">`, built from the
// SAME `type` vocabulary the chips use. Submitting it is an ordinary
// browser navigation (to the SAME origin this page came from) — not a
// script-initiated request, so it does not trip that latch, and it
// keeps working with JavaScript off, same as the embedded first page.
// It is a real page of `/entries.json`'s own JSON, `next` cursor and
// `state` field included verbatim — so a `warning`/`unknown`/`error`
// answer is not just "shown", it is the ENTIRE visible response, which
// cannot be silently empty without the browser itself showing nothing
// at all for the request, a failure mode this task's own probe (a
// fixture against `/entries.json`'s contract) can check directly against
// `pages.page()`.
//
// **The detail pane keeps its embedded-only design, on the same
// measured grounds.** A row loaded through the form above is JSON in a
// new tab, never merged into this page's own list — there is no
// beyond-`LIST_MAX` row IN THIS DOM to click in the first place, so the
// question "does clicking one fetch `/entry.json`" does not arise here.
// For a row this page DID embed, `astra.mjs`'s existing script already
// renders its detail from `ENTRIES` — unchanged by this task.
import { h, INK, NAV, LIST_MAX } from './shared.mjs';

export function knowledgeView(d) {
  // **D3: one truth for the type vocabulary.** `d.types` comes straight
  // from `memory.TYPES`, assembled in `dashboard.mjs` — never from which
  // types happen to appear in `d.entries` here. A type with zero entries
  // (or every one of them retired away) still gets a chip and a form
  // option: filtering by it honestly turns up nothing, rather than the
  // option itself silently disappearing, which is indistinguishable from
  // "this type does not exist" to anyone looking at the list.
  const types = d.types;
  const shown = d.entries.slice(0, LIST_MAX);
  const cut = d.entries.length - shown.length;
  const rows = shown.map((e) => `<button class="item${e.retired ? ' gone' : ''}"
      data-id="${h(e.id)}" data-type="${h(e.type)}" style="--c:${INK.violet}"
      data-find="${h(`${e.headline} ${e.type} ${e.project} ${e.author ?? ''} ${e.tags.join(' ')}`.toLowerCase())}">
      <span class="glyph">${h((NAV.knowledge && e.type[0]) ? e.type[0].toUpperCase() : '·')}</span>
      <span><span class="h">${h(e.headline)}</span>
      <span class="m">${h(e.type)} · ${h(e.project)} · ${h(e.author ?? 'no author recorded')}${
  e.retired ? ` · ${h(e.retired.state)}` : ''}</span></span>
    </button>`).join('');
  return `<div class="eyebrow">From your memory</div>
    <h1>What your knowledge holds.</h1>
    <p class="page-subtitle">Every entry, retracted ones included and marked. Picking one
      shows what it was built on and what stands against it.</p>
    <h2>Entries <em>${d.entries.length} total${
  cut > 0 ? ` · showing the newest ${LIST_MAX}, ${cut} not listed` : ''}${
  d.broken ? ` · ${d.broken} unreadable line${d.broken === 1 ? '' : 's'}` : ''}</em></h2>
    <div class="split">
      <div class="pane">
        <input id="q" type="search" placeholder="Search headline, drawer, project, tag"
          autocomplete="off">
        <div class="filters" id="filters">
          <button class="chip on" data-type="">all</button>
          ${types.map((t) => `<button class="chip" data-type="${h(t.type)}"
              title="${h(t.label)}">${h(t.type)}</button>`).join('')}
        </div>
        <div class="list" id="list">${rows
    || '<p class="none">This memory holds no entries yet.</p>'}</div>
        <p class="m" id="hits"></p>
      </div>
      <div class="pane detail" id="detail">
        <p class="none">Pick an entry. Basis, authority, scope, standing, what it replaces
          and what contradicts it appear here.</p>
      </div>
    </div>
    <h2>Past what is shown here</h2>
    <p class="page-subtitle">The box above only searches the ${
  cut > 0 ? `${LIST_MAX} entries` : 'entries'} already on this page. This one asks the log
      itself — no script, so it keeps working with JavaScript off, and a memory too large to
      embed here is still reachable through it.</p>
    <form class="pane" method="get" action="/entries.json" target="_blank">
      <div class="kv">
        <div><b>Type</b>
          <select name="type">
            <option value="">all types</option>
            ${types.map((t) => `<option value="${h(t.type)}">${h(t.label)}</option>`).join('')}
          </select>
        </div>
        <div><b>Text</b><input type="search" name="q" placeholder="headline, drawer, tag…"></div>
        <div><b>Continue after</b>
          <input type="text" name="after" placeholder="paste a previous answer's “next” here"></div>
      </div>
      <p class="m">Opens <code>/entries.json</code>'s own answer in a new tab: a page of
        entries in the same shape this list uses, a <code>next</code> cursor to page further
        with (paste it into “continue after” and open the form again), and a
        <code>state</code> field that is <code>ok</code>, <code>warning</code>,
        <code>unknown</code> or <code>error</code> — never a page that looks empty when it is
        really one of the other three.</p>
      <button class="chip" type="submit">Search the log</button>
    </form>`;
}

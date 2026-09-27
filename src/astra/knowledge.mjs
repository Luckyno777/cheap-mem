// astra/knowledge — the entries tab: search, filter chips, detail pane.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
// Pure move — every template string below is unchanged.
import { h, INK, NAV, LIST_MAX } from './shared.mjs';

export function knowledgeView(d) {
  const types = [...new Set(d.entries.map((e) => e.type))].sort();
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
        <div class="filters">
          <button class="chip on" data-type="">all</button>
          ${types.map((t) => `<button class="chip" data-type="${h(t)}">${h(t)}</button>`).join('')}
        </div>
        <div class="list" id="list">${rows
    || '<p class="none">This memory holds no entries yet.</p>'}</div>
        <p class="m" id="hits"></p>
      </div>
      <div class="pane detail" id="detail">
        <p class="none">Pick an entry. Basis, authority, scope, standing, what it replaces
          and what contradicts it appear here.</p>
      </div>
    </div>`;
}

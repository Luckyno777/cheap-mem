// astra/net — the links tab: the declared-only drawer matrix.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
// Pure move — every template string below is unchanged. Named to match
// this view's id in `dashboard.VIEWS`; `../net.mjs` (imported below) is
// the unrelated data module for declared edges, not this file.
import * as net from '../net.mjs';
import { h, CELL } from './shared.mjs';

export function netView(d) {
  const { boxes, pairs, dangling } = d.net;
  if (!pairs.length) {
    return `<div class="eyebrow">Declared only</div><h1>Links.</h1>
      <p class="none">${boxes.length} drawer${boxes.length === 1 ? '' : 's'} hold entries and
        <b>not one declared link</b> runs between them${dangling
  ? `, though ${dangling} point${dangling === 1 ? 's' : ''} at an entry that is not here` : ''}.
        The matrix is empty because nothing was linked — not because nothing was measured.</p>`;
  }
  const live = [...new Set(pairs.flatMap((p) => [p.from, p.to]))].sort();
  const map = new Map(pairs.map((p) => [CELL(p.from, p.to), p]));
  const head = `<tr><th class="row-h">from \\ to</th>${
    live.map((n) => `<th>${h(n)}</th>`).join('')}</tr>`;
  const body = live.map((r) => `<tr><td class="row-h">${h(r)}</td>${live.map((c) => {
    const p = map.get(CELL(r, c));
    return p ? `<td class="hit" tabindex="0" data-cell="${h(CELL(r, c))}">${p.count}</td>`
      : '<td class="nil">·</td>';
  }).join('')}</tr>`).join('');
  return `<div class="eyebrow">Declared only</div><h1>Links.</h1>
    <p class="page-subtitle">Only declared links — <code>${h(net.LINK_KINDS.join(', '))}</code>.
      Nothing is inferred from similarity.</p>
    <h2>Drawer matrix <em>${live.length} of ${boxes.length} drawers carry an edge · ${
  d.net.links} link${d.net.links === 1 ? '' : 's'} · ${dangling} dangling</em></h2>
    <div class="wrap"><table>${head}${body}</table></div>
    <p class="none" id="netdetail">Pick a filled cell.</p>`;
}

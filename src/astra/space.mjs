// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// astra/space — the knowledge space tab (the 3D-ish canvas stage's HTML
// shell; the drawing itself lives in astra.mjs's SCRIPT template, which
// is shared browser-side code and stays there).
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
// Pure move — every template string below is unchanged.
import { LIST_MAX } from './shared.mjs';

export function spaceView(d) {
  const shown = Math.min(d.entries.length, LIST_MAX);
  if (!shown) {
    return `<div class="eyebrow">Explorer</div><h1>Neural network.</h1>
      <p class="none">This memory holds no entries yet, so there is nothing to lay out.
        That is empty, not unmeasured.</p>`;
  }
  // **The same count the stage makes, not a similar one.** Measured in
  // the sibling project on a memory with 1487 entries: this line said
  // "80 declared" and the canvas ten characters further along said
  // "72". This one counted every declared link of the shown entries;
  // the canvas draws only those whose BOTH ends are laid out. A link
  // to an entry beyond LIST_MAX is not an edge of THIS stage.
  const shownIds = new Set(d.entries.slice(0, LIST_MAX).map((e) => e.id));
  const declared = d.entries.slice(0, LIST_MAX)
    .reduce((n, e) => n + e.links.filter((l) => shownIds.has(l.id)).length, 0);
  return `<div class="eyebrow">Explorer</div>
    <h1>Neural network.</h1>
    <p class="page-subtitle">The same entries as the knowledge list, laid out as a space you
      can turn. Drag to rotate, scroll to zoom, pick a node to read it. One kind of line at a
      time — the caption under the stage is true of every line on it.</p>
    <div class="stage-bar">
      <label class="count" for="space-mode">Lines</label>
      <select id="space-mode">
        <option value="structure">Where things sit — drawer and tag</option>
        <option value="declared">Only what someone declared</option>
      </select>
      <span class="count" id="space-count"></span>
      <span class="count">${shown} of ${d.entries.length} entries · ${declared} declared</span>
    </div>
    <div class="stage">
      <canvas id="space" tabindex="0" aria-label="knowledge space"></canvas>
      <p class="stage-note" id="space-note"></p>
    </div>
    <div class="pane stage-pick" id="space-pick">
      <p class="none">Pick a node. Nothing here is inferred from similarity — a line either
        says where an entry sits, or it says that somebody wrote the link down.</p>
    </div>`;
}

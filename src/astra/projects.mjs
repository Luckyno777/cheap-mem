// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// astra/projects — the workspaces tab: one card per drawer group.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
// Pure move — every template string below is unchanged.
import { h, INK } from './shared.mjs';

export function projectsView(d) {
  if (!d.projects.length) {
    return '<div class="eyebrow">Workspaces</div><h1>Projects.</h1>'
      + '<p class="none">No project drawer has been written to yet.</p>';
  }
  const cards = d.projects.map((p) => `<article class="card" style="--c:${INK.blue}">
    <div class="name">${h(p.name)}</div>
    <div class="state">last entry ${p.last
    ? h(p.last.replace('T', ' ').replace('Z', '')) : 'never'}</div>
    <div class="kv">
      <div><b>entries</b>${p.entries}</div>
      <div><b>retracted</b>${p.retired}</div>
      <div><b>drawers</b>${p.drawers.length}</div>
      <div><b>open questions</b>${p.openQuestions}</div>
    </div>
    <p>${p.drawers.map((x) => `<span class="chip">${h(x)}</span>`).join('')}</p>
    <p class="why">${p.agents.length
    ? `written by ${p.agents.map((a) => `${h(a.name)} (${a.entries})`).join(', ')}`
    : 'no agent recorded on any entry here'}</p>
  </article>`).join('');
  return `<div class="eyebrow">Workspaces</div><h1>Projects.</h1>
    <p class="page-subtitle">One card per drawer group, with what is actually in it. The
      counts come from the same single read the space and the knowledge list come from.</p>
    <h2>Workspaces <em>${d.projects.length}</em></h2>
    <div class="cards">${cards}</div>`;
}

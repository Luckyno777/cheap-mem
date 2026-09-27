// astra/agents — the agents tab: registered vs. actually observed.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
// Pure move — every template string below is unchanged.
import { h, tone } from './shared.mjs';

export function agentsView(d) {
  if (!d.agents.length) {
    return '<div class="eyebrow">Who writes here</div><h1>Agents.</h1>'
      + '<p class="none">Nobody is registered and nobody appears in the log.</p>';
  }
  const cards = d.agents.map((a) => {
    const state = (a.registered && a.count > 0) ? 'calm' : 'watch';
    const note = !a.registered ? 'writes without a folder under agents/'
      : a.count === 0 ? 'registered, has never written anything'
        : 'registered and writing';
    return `<article class="card" style="--c:${tone(state)}">
      <div class="name">${h(a.name)}</div>
      <div class="state">${h(note)}</div>
      <div class="kv">
        <div><b>entries</b>${a.count}</div>
        <div><b>retracted</b>${a.retired ?? 0}</div>
        <div><b>model</b>${a.model ? h(a.model) : '<span class="missing">none</span>'}</div>
        <div><b>role</b>${a.role ? h(a.role) : '<span class="missing">none</span>'}</div>
      </div>
      <p class="why">last ${a.last
    ? h(String(a.last).replace('T', ' ').replace('Z', '')) : 'never'}</p>
      <p>${Object.keys(a.projects || {}).map((x) => `<span class="chip">${h(x)}</span>`).join('')
      || '<span class="missing">no project</span>'}</p>
    </article>`;
  }).join('');
  return `<div class="eyebrow">Who writes here</div><h1>Agents.</h1>
    <p class="page-subtitle">Registered and actually observed in the memory, shown side by
      side. No capability rating is invented — only what a folder or an entry says.</p>
    <h2>Known <em>${d.agents.length}</em></h2>
    <div class="cards">${cards}</div>`;
}

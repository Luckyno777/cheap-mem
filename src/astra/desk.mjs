// astra/desk — the overview tab: metric tiles, system state, active work.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module,
// so several agents can extend one each without meeting in the same
// file). Pure move — every template string below is unchanged.
import * as dashboard from '../dashboard.mjs';
import { h, INK, tone } from './shared.mjs';

/** A metric tile. `value === null` prints the reason, never a zero. */
function metric(label, value, note, colour) {
  return `<article class="metric">
    <div class="metric-label"><span style="color:${colour}">●</span>${h(label)}</div>
    ${value === null
    ? `<strong class="unknown">${h(note)}</strong>`
    : `<strong>${h(value)}</strong><p>${h(note)}</p>`}
  </article>`;
}

function tile(t) {
  return `<article class="card" style="--c:${tone(t.state)}">
    <div class="name">${h(t.title)}</div>
    <div class="state">${h(t.word ?? dashboard.word(t.state))}</div>
    <p>${h(t.line)}</p>
    ${t.detail ? `<p class="why">${h(t.detail)}</p>` : ''}
  </article>`;
}

function workCard(w) {
  return `<article class="card" style="--c:${tone(w.state)}">
    <div class="name">${h(w.title)}</div>
    <div class="state">${h(dashboard.word(w.state))}</div>
    <div class="big">${w.value === null
    ? '<span class="missing">not measured</span>' : h(w.value)}</div>
    <p>${h(w.note)}</p>
  </article>`;
}

export function deskView(d) {
  const open = d.attention.length;
  const duties = d.work.find((w) => w.title === 'Duties') ?? {};
  return `<div class="eyebrow">Your knowledge, connected</div>
    <h1>The bigger picture.</h1>
    <p class="page-subtitle">Every entry, every declared link, and every state that was
      actually measured. What could not be taken says so — it never borrows the look of
      something that is in order.</p>
    <section class="metrics">
      ${metric('Entries', d.inventory.total, `in ${d.projects.length} drawer${
  d.projects.length === 1 ? '' : 's'}`, INK.violet)}
      ${metric('Declared links', d.net.links, `${d.net.dangling} point outside`, INK.blue)}
      ${metric('Drawers', d.counts ? Object.keys(d.counts).length : 0,
    'kinds of entry in use', INK.green)}
      ${metric('System', open === 0 ? 'in order' : `${open} open`,
    open === 0 ? `all ${d.system.length} tiles measured and calm`
      : 'alarm and unmeasured first', open === 0 ? INK.green : INK.orange)}
    </section>
    <h2>System state <em>${d.system.length} tiles · ${open} not in order</em></h2>
    <div class="cards">${d.system.map(tile).join('')}</div>
    <h2>Active work <em>open against the total that was recorded</em></h2>
    <div class="cards">${d.work.map(workCard).join('')}</div>
    ${duties.value === null ? '' : ''}`;
}

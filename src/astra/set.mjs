// astra/set — the settings tab: settings forms, setup steps, connection
// doors, and the raw-capture review table.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
// Pure move — every template string below is unchanged.
import { h, INK, tone, LIST_MAX } from './shared.mjs';
import { tasksPanel } from './tasks.mjs';

export function setView(d, { writable }) {
  const forms = d.settings.map((s) => `
    <form class="set" method="post" action="/setting">
      <input type="hidden" name="id" value="${h(s.id)}">
      <input type="hidden" name="from" value="/">
      <label for="f-${h(s.id)}"><strong>${h(s.title)}</strong></label>
      <p class="eff">${h(s.description)}</p>
      <div class="row">
        <input id="f-${h(s.id)}" name="value" value="${h(s.value ?? '')}"
          ${s.kind === 'number' ? 'type="number" min="1"' : 'type="text" spellcheck="false"'}
          ${writable && s.writable !== false ? '' : 'disabled'}>
        <button type="submit"${writable && s.writable !== false ? '' : ' disabled'}>Set</button>
      </div>
      <p class="src">Source: <b>${h(s.source)}</b>${
  s.writable === false ? ' · <b>not writable</b>' : ''}${s.note ? ` · ${h(s.note)}` : ''}</p>
      <p class="eff">${h(s.effect)}</p>
    </form>`).join('');
  const steps = d.setup.map((s) => `
    <li style="--c:${tone(s.state === 'done' ? 'calm' : s.state === 'open' ? 'watch' : 'unknown')}">
      <b>${h(s.title)}</b><br><span class="why">${h(s.detail)}</span>
      ${s.fix ? `<br><span class="why">→ <code>${h(s.fix)}</code></span>` : ''}</li>`).join('');
  const doors = d.connections.map((c) => `<article class="card"
    style="--c:${c.open ? INK.orange : INK.green}">
    <div class="name">${h(c.title)}</div>
    <div class="state">${h(c.door)}</div>
    <p><code>${h(c.address)}</code></p>
    <p class="why">${h(c.note)}</p>
  </article>`).join('');
  const stores = d.stores.length
    ? `<p class="none">Found on this machine: ${d.stores.map((x) =>
      `<code>${h(x.id)}</code>${x.found.length > 1
        ? ` (${x.found.length} candidates — ambiguous)` : ''}`).join(', ')
    } — usable as a value above.</p>`
    : '<p class="none">No cloud store found on this machine. A folder path works, and so '
      + 'does <code>local</code> with one.</p>';

  // --- the raw-capture review -----------------------------------------
  // Lives here rather than as its own tab: the archive LOCATION is
  // already set two sections up, and where the bytes physically sit is
  // exactly the question this review answers about them. Data comes
  // from `dashboard.collect()` (which reads `raw.capturesWithState`),
  // never recomputed here — this file only draws it.
  const RAW_MARK = { present: '·', deleted: 'D', unreachable: '!' };
  const RAW_TONE = { present: tone('calm'), deleted: INK.muted, unreachable: tone('alarm') };
  const rawAll = d.raw.captures;
  const rawRows = rawAll.slice(0, LIST_MAX);
  const rawCut = rawAll.length - rawRows.length;
  const rawBody = rawRows.map((r) => `<tr style="--c:${RAW_TONE[r.state]}">
      <td class="row-h">${h(RAW_MARK[r.state])} ${h(r.state)}</td>
      <td class="row-h"><code>${h(r.path)}</code></td>
      <td>${h(r.at ?? 'no timestamp')}</td>
      <td>${h(r.project ?? '(none)')}</td>
      <td>${r.bytes === null ? 'unknown' : h(r.bytes)}</td>
      <td class="row-h">${r.state === 'deleted'
    ? `by ${h(r.deleted.by)}: ${h(r.deleted.reason || '(no reason given)')}`
    : r.state === 'unreachable'
      ? 'recorded, bytes missing — a defect, not a decision'
      : ''}</td>
    </tr>`).join('');
  // Three outcomes, and the third is the one that is easy to lose:
  // "the register could not be read" must not look like "nothing has
  // been captured". `collect()` keeps them apart; this is where that
  // distinction becomes visible or is thrown away.
  const rawTable = !d.raw.readable
    ? `<p class="none unmeasured" style="color:${tone('unknown')}">The capture register could not be read, so nothing below was
        measured — this is <em>not</em> the same as "no captures".${
  d.raw.error ? ` The read failed with: <code>${h(d.raw.error)}</code>` : ''}</p>`
    : rawRows.length
      ? `<div class="wrap"><table>
        <tr><th class="row-h">state</th><th class="row-h">path</th><th>when</th>
          <th>project</th><th>bytes</th><th class="row-h">note</th></tr>
        ${rawBody}
      </table></div>`
      : '<p class="none">No raw capture has been recorded yet.</p>';

  return `<div class="eyebrow">What you can change</div><h1>Settings.</h1>
    <p class="page-subtitle">${writable
    ? 'What is set here takes effect at once and is written down as a line.'
    : 'This server runs READ ONLY. The fields are disabled, and the page says so rather '
      + 'than pretending.'} Every setting names its source and its effect.</p>
    <h2>Settings <em>${d.settings.length}</em></h2>
    ${forms || '<p class="none">Nothing here can be set.</p>'}
    ${stores}
    <h2>Setup <em>${d.setup.filter((s) => s.state !== 'done').length} of ${
  d.setup.length} still open</em></h2>
    <ol class="steps">${steps}</ol>
    ${tasksPanel(d, { writable })}
    <h2>Doors <em>of which only WHETHER a token is set is shown</em></h2>
    <div class="cards">${doors}</div>
    <h2>Raw captures <em>${d.raw.readable
    ? `${rawAll.length} total — ${d.raw.counts.present} present, ${
      d.raw.counts.deleted} deleted, ${d.raw.counts.unreachable} unreachable${
      rawCut > 0 ? ` · showing the newest ${LIST_MAX}, ${rawCut} not listed` : ''}`
    : 'not measured — the register could not be read'}</em></h2>
    <p class="page-subtitle">Deleting one is irreversible and happens on the command line —
      <code>mem raw delete &lt;path&gt; --reason "…" --yes</code> — never from this page.
      This review cannot filter by TOPIC: a capture carries no topic in its metadata, only a
      path, a project, a surface and a session; finding captures by what they are about would
      mean a content search over the decompressed material, which is a separate, larger
      feature and is not built here.</p>
    ${rawTable}`;
}

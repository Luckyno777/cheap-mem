// astra/tasks — the "long jobs" panel of the settings tab (E1.7).
//
// Not a view of its own: it is drawn inside `setView`, because the
// Settings tab is already the one place of the desk that writes, and a
// task is started by exactly that kind of POST under exactly those
// guards (`bin/mem-serve`, `/task` and `/task/cancel`). A new tab would
// have changed `dashboard.VIEWS` — and with it every probe that pins it —
// for what is one section.
//
// Data comes from `dashboard.collect()` (`d.tasks`, read through
// `tasks.overview()`), never recomputed here. The page is a snapshot:
// no polling script, so a running task says "reload for the current
// state" rather than pretending to update itself.
import { h, INK, tone } from './shared.mjs';

/** One latest-task record to [label, tone, detail]. Closed: an unknown
 * shape is said out loud, never drawn as a calm card. */
function describe(t) {
  if (t === null) return ['never started', INK.muted, 'No task of this kind has run in this memory yet.'];
  if (t.running === true) {
    return ['running', tone('watch'),
      `started ${t.started} · ${t.progress ?? 'running (no progress measurable)'} · reload for the current state`];
  }
  if (t.running === 'unknown') {
    return ['no longer tracked', tone('unknown'),
      `started ${t.started} · ${t.reason ?? 'the server that started it has restarted'} — `
      + 'its end was never recorded; start it again if the result matters'];
  }
  if (t.cancelled) {
    return ['cancelled', INK.muted, `started ${t.started} · cancelled ${t.ended ?? '?'}${
      t.reason ? ` · ${t.reason}` : ''}`];
  }
  if (t.state === 'ok') return ['ok', tone('calm'), `started ${t.started} · ended ${t.ended ?? '?'}`];
  if (t.state === 'warning') {
    return ['warning', tone('watch'), `started ${t.started} · ended ${t.ended ?? '?'} · ${t.reason ?? ''}`];
  }
  if (t.state === 'error') {
    return ['error', tone('alarm'), `${t.started ? `started ${t.started} · ` : ''}${t.reason ?? ''}`];
  }
  return [`unrecognised state '${t.state}'`, tone('unknown'), t.reason ?? ''];
}

export function tasksPanel(d, { writable }) {
  const tk = d.tasks;
  const off = writable ? '' : ' disabled';
  const cards = tk.kinds.map((k) => {
    const latest = tk.latest[k.kind] ?? null;
    const [label, colour, detail] = describe(latest);
    const running = latest?.running === true;
    const form = (action, text) => `<form method="post" action="${action}" style="display:inline">
        <input type="hidden" name="kind" value="${h(k.kind)}">
        <input type="hidden" name="from" value="/">
        <button type="submit"${off}>${text}</button></form>`;
    return `<article class="card" style="--c:${colour}">
    <div class="name">${h(k.title)}</div>
    <div class="state">${h(label)}</div>
    <p>${h(k.description)}</p>
    <p class="why">${h(detail)}</p>
    <p class="why">Resume after a break: ${h(k.resume)}.${latest?.id ? ` Task <code>${h(latest.id)}</code>.` : ''}</p>
    <p>${running ? form('/task/cancel', 'Cancel') : form('/task', 'Start')}</p>
  </article>`;
  }).join('');
  const note = !tk.readable
    ? `<p class="none unmeasured" style="color:${tone('unknown')}">The task state could not be read${
      tk.error ? `: <code>${h(tk.error)}</code>` : ''} — this is <em>not</em> "nothing ran".</p>`
    : '';
  return `<h2>Long jobs <em>${tk.kinds.length} kinds · at most one of each at a time</em></h2>
    <p class="page-subtitle">${writable
    ? 'Each one starts the same CLI command a person would type, as a child process of this '
      + 'server. The page does not poll — reload it to see how a job went.'
    : 'This server runs READ ONLY, so no job can be started or cancelled from here.'}
      <code>GET /task.json</code> answers the same state as JSON.</p>
    ${note}<div class="cards">${cards}</div>`;
}

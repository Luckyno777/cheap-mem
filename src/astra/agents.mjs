// astra/agents — the agents tab: registered vs. actually observed.
//
// Split out of `astra.mjs` (dashboard block D2-D8: one view per module).
//
// D5 (2026-09-27): four honest, differentiated fields added on top of the
// original registered/observed split — `activity` ("alive" only once TWO
// independent sources agree), `startable` (can this be started locally,
// right now?), `pause` (`silent_until`) and `channel` (the inbox "bell",
// `ok`/`unknown` only, never green without a message that was actually
// answered) — plus the human's own read-only tray. `dashboard.collect()`
// resolves every one of those in `agentSignals()`/`humanInboxState()`;
// this module stays a pure string-selector over `d` — same "no I/O, so a
// test can hand it a fixture" contract `astra.renderHtml` promises the
// whole page. A field this file cannot find on `d` prints "no data path"
// rather than a blank, a zero or an invented default.
import { h, tone } from './shared.mjs';

/** state -> board tone. Absent from a map means "not a state this field can be in". */
const ACTIVITY_TONE = { alive: 'calm', unknown: 'unknown', 'not seen': 'watch' };
const PAUSE_TONE = { active: 'calm', paused: 'watch', expired: 'watch', unknown: 'unknown' };
const CHANNEL_TONE = { ok: 'calm', unknown: 'unknown' };

/** A `<span class="missing">` for a field this row genuinely has no source for. */
const NO_PATH = '<span class="missing">no data path</span>';

// The study has no `--red`: `alarm` is a literal hex in `shared.mjs`'s own
// TONE map, not a variable — and none of the four fields below ever
// reaches `alarm` (a state that could not be measured is `unknown`, a
// state that measurably needs someone is `watch`; nothing here is ever
// confidently "broken"). So this map only ever has to name the three
// tones that actually occur, and a fourth would throw rather than fall
// back to a wrong colour.
const TONE_VAR = { calm: '--green', watch: '--orange', unknown: '--muted' };

/** One word, coloured by its OWN state — never a colour the maps above do not name. */
function word(label, state, toneMap) {
  const t = toneMap[state];
  if (!t) throw new Error(`agentsView: no tone for state '${state}'. Known: ${Object.keys(toneMap).join(', ')}`);
  const cssVar = TONE_VAR[t];
  if (!cssVar) throw new Error(`agentsView: no CSS variable for tone '${t}'`);
  return `<span class="chip" style="color:var(${cssVar})">${h(label)}</span>`;
}

/** `activity` reads its two source ages out loud — the whole point of the field. */
function activityNote(activity) {
  const hb = activity.heartbeat.ageMin === null
    ? 'no heartbeat ever' : `heartbeat ${Math.round(activity.heartbeat.ageMin / 60)}h old`;
  const ct = activity.content.ageMin === null
    ? 'no write/inbox activity ever' : `activity ${Math.round(activity.content.ageMin / 60)}h old`;
  return `${hb}, ${ct} (needs both fresh within ${Math.round(activity.windowMin / 60)}h to read alive)`;
}

function pauseNote(pause) {
  if (pause.state === 'paused') return `paused until ${pause.until}${pause.why ? ` (${pause.why})` : ''}`;
  if (pause.state === 'expired') return `announced silence until ${pause.until} has run out`;
  if (pause.state === 'unknown') return pause.reason;
  return '';
}

/** The human's own tray. Read-only, E5.4: no button here sends, marks seen, or replies. */
function humanInboxSection(d) {
  const box = d.humanInbox;
  if (!box) {
    return `<h2>Your inbox</h2><p class="none unmeasured">${NO_PATH}</p>`;
  }
  if (!box.readable) {
    return `<h2>Your inbox</h2><p class="none unmeasured">${h(box.reason)}</p>`;
  }
  if (!box.messages.length) {
    return '<h2>Your inbox</h2><p class="none">Nothing has arrived here yet.</p>';
  }
  const rows = box.messages.map((m) => `<article class="card" style="--c:${
    tone(m.state === 'open' ? 'watch' : 'calm')}">
      <div class="name">${h(m.subject)}</div>
      <div class="state">from ${h(m.from)} · ${h(m.state)}</div>
      <p class="why">${h(String(m.time).replace('T', ' ').replace('Z', ''))}</p>
    </article>`).join('');
  return `<h2>Your inbox <em>${box.messages.length}</em></h2>
    <p class="page-subtitle">Read-only: this row is exactly what ${h(box.who)}'s inbox already
      holds. Looking at this page does not mark anything seen, retry a delivery, or bring a
      message back up.</p>
    <div class="cards">${rows}</div>${
  box.broken ? `<p class="why">${box.broken} message(s) in this drawer could not be read.</p>` : ''}`;
}

export function agentsView(d) {
  if (!d.agents.length) {
    return '<div class="eyebrow">Who writes here</div><h1>Agents.</h1>'
      + '<p class="none">Nobody is registered and nobody appears in the log.</p>'
      + humanInboxSection(d);
  }
  const cards = d.agents.map((a) => {
    const state = (a.registered && a.count > 0) ? 'calm' : 'watch';
    const note = !a.registered ? 'writes without a folder under agents/'
      : a.count === 0 ? 'registered, has never written anything'
        : 'registered and writing';
    const { activity, startable, pause, channel } = a;
    const notes = [
      activity ? activityNote(activity) : null,
      pause && pause.state !== 'active' ? pauseNote(pause) : null,
      channel ? `bell: ${channel.reason}` : null,
    ].filter(Boolean);
    return `<article class="card" style="--c:${tone(state)}">
      <div class="name">${h(a.name)}</div>
      <div class="state">${h(note)}</div>
      <div class="kv">
        <div><b>entries</b>${a.count}</div>
        <div><b>retracted</b>${a.retired ?? 0}</div>
        <div><b>model</b>${a.model ? h(a.model) : '<span class="missing">none</span>'}</div>
        <div><b>role</b>${a.role ? h(a.role) : '<span class="missing">none</span>'}</div>
      </div>
      <div class="kv">
        <div><b>alive</b>${activity ? word(activity.state, activity.state, ACTIVITY_TONE) : NO_PATH}</div>
        <div><b>local start</b>${startable
    ? word(startable.local ? 'yes' : 'no', startable.local ? 'yes' : 'no', { yes: 'calm', no: 'watch' })
    : NO_PATH}</div>
        <div><b>pause</b>${pause ? word(pause.state, pause.state, PAUSE_TONE) : NO_PATH}</div>
        <div><b>bell</b>${channel ? word(channel.state, channel.state, CHANNEL_TONE) : NO_PATH}</div>
      </div>
      <p class="why">last ${a.last
    ? h(String(a.last).replace('T', ' ').replace('Z', '')) : 'never'}${
  notes.length ? ` · ${notes.map((n) => h(n)).join(' · ')}` : ''}</p>
      <p>${Object.keys(a.projects || {}).map((x) => `<span class="chip">${h(x)}</span>`).join('')
      || '<span class="missing">no project</span>'}</p>
    </article>`;
  }).join('');
  return `<div class="eyebrow">Who writes here</div><h1>Agents.</h1>
    <p class="page-subtitle">Registered and actually observed in the memory, shown side by
      side. No capability rating is invented — only what a folder, an entry, a heartbeat or
      an inbox says. "Alive" needs two independent sources to agree; one alone reads
      "unknown", and the bell only reads "ok" once a message was actually answered.</p>
    <h2>Known <em>${d.agents.length}</em></h2>
    <div class="cards">${cards}</div>
    ${humanInboxSection(d)}`;
}

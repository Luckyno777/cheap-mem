// astra/shared — what every view of the workspace needs and none of
// them owns: escaping, the study's palette, state-to-colour, the rail's
// glyphs, and the one number that says how many rows a list draws.
//
// Split out of `astra.mjs` so that several agents can extend one view
// each without landing in the same file (dashboard block D2-D8). Pure
// move: every value here is unchanged from where it stood before.

/**
 * How many knowledge rows the list draws before it says so out loud.
 *
 * A PRESENTATION number, so it lives here. It stood in `dashboard.mjs`
 * until the renderer moved out, and re-exporting it from there was the
 * first thing that broke: the constant went with the markup, the
 * re-export resolved to `undefined`, and three probes quietly computed
 * with NaN — which is exactly the silent-nothing this project keeps
 * finding. They went red, which is what they are for.
 */
export const LIST_MAX = 400;

/** HTML special characters. Everything here is memory content or a path. */
export function h(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/** JSON that cannot break out of the <script> element it sits in. */
export function safeJson(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

export const CELL = (from, to) => `${from} >> ${to}`;

// --- the study's own palette, read from its stylesheet ----------------
export const INK = {
  bg: '#0a0b0e', panel: '#101115', raised: '#15161c', line: '#24262e',
  muted: '#858894', text: '#e9eaf0',
  violet: '#b5a0fa', green: '#89c4b5', orange: '#d4aa85', blue: '#819ecd',
  // **The finding a rebuild loses most reliably.** The study signals
  // state NOT through lightness but through hue: neutral chrome sits at
  // 227-240 degrees, everything active at 250-272 — at practically the
  // same lightness. `#24262e` (hue 228) and `#24202d` (258) are the same
  // grey in two moods. An element does not get BRIGHTER when it becomes
  // active, it gets MORE VIOLET. The first version here made it
  // brighter — on a screen that looks almost identical and is still a
  // different language.
  'raised-on': '#1b1725', 'line-on': '#24202d',
};

/**
 * State to colour. ONE map, so a fifth state cannot quietly pick one.
 *
 * The study has no notion of a board state, so this is the one place
 * where its palette had to be mapped onto something it did not have:
 * green for in order, orange for wants someone, violet-shifted red for
 * broken, muted for not measured. Muted is the point — an unmeasured
 * tile must not look like a calm one.
 */
const TONE = Object.freeze({
  calm: INK.green, watch: INK.orange, alarm: '#e0857f', unknown: INK.muted,
});
export function tone(state) {
  const t = TONE[state];
  if (!t) throw new Error(`No tone for state '${state}'. Known: ${Object.keys(TONE).join(', ')}`);
  return t;
}

/** The study's glyphs, per view. Typographic marks, not emoji. */
export const NAV = Object.freeze({
  desk: ['◫', 'Overview'],
  knowledge: ['▤', 'Knowledge'],
  space: ['⌘', 'Neural network'],
  projects: ['◈', 'Projects'],
  agents: ['◉', 'Agents'],
  net: ['⤴', 'Links'],
  set: ['⚙', 'Settings'],
});

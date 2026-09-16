// The desk — and the one thing a dashboard must never do.
//
// **What this file is really guarding.** A UI export arrived on
// 2026-09-16 with five views and a hardcoded `DEMO` constant behind
// them. It fetched `/console.json`, gated the real board behind
// `Array.isArray(x.board)` — which is false, because `console.collect`
// returns an object — and so rendered invented numbers under a status
// pill reading "Daten: /console.json". Every assurance in this file
// exists because that page would have passed any test that only asked
// "does it render".
//
// So the probes here ask the two questions that separate a dashboard
// from a decoration:
//
//   1. Does a value that IS in the memory appear on the page?
//   2. Does a value that is NOT in the memory stay off it?
//
// The second one needs the first, or it is vacuous: a page that renders
// nothing at all also contains no demo strings.
//
// invariant: leer-ist-kein-bestehen
// invariant: drei-zustaende-nie-zwei
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as dashboard from '../src/dashboard.mjs';
import * as consolePage from '../src/console.mjs';
import * as memory from '../src/memory.mjs';
import * as agents from '../src/agents.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, '..', 'bin', 'mem-serve');

/** Strings only this fixture can produce. Each one is checked for. */
const MINE = Object.freeze({
  learning: 'a hit is not a use',
  decision: 'no alias layer here',
  error: 'pwd answers in the MSYS form',
  duty: 'the raw captures need a delete',
  question: 'studio or the other one',
  project: 'quarry',
  agent: 'surveyor',
});

/**
 * Strings from the arriving export's `DEMO` constant.
 *
 * Not a sample — the whole distinctive set, so a re-introduced fallback
 * cannot slip in through the one field nobody listed. `lucky-mem` earns
 * its place twice: it was in the demo project list, and this repo must
 * never name the sibling project it was extracted from anyway.
 */
const THEIRS = Object.freeze([
  'Rohfang-Archiv', 'Fehlerklassen', 'MCP-Brücke', 'Fasser', 'Retrieval-Nutzung',
  'Retrieval-Verbrauch', 'Demo-Fallback', 'Demo-Daten',
  'l-001', 'd-018', 'Query darf State nicht ableiten', 'Keine allgemeine Alias-Schicht',
  'lucky-mem', 'Sitzungspost', 'Pflichten',
]);

function empty() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-desk-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'desk', participants: ['someone'], language: 'en' }));
  return r;
}

/** A memory whose every visible value is one of MINE. */
function filled({ extra = 0 } = {}) {
  const r = empty();
  agents.createAgent(r, MINE.agent, { role: 'measures things', model: 'none' });
  const learning = memory.logEntry(r, 'learning',
    { topic: 'retrieval', title: MINE.learning, text: 'a view on the log, never a second truth' });
  const decision = memory.logEntry(r, 'decision',
    { topic: 'retrieval', choice: MINE.decision, why: 'the spread was not spelling' },
    { project: MINE.project });
  const error = memory.logEntry(r, 'error',
    { klass: 'pfad-oder-arbeitsverzeichnis', title: MINE.error, text: 'so the file URL was wrong' },
    { project: MINE.project });
  memory.logEntry(r, 'duty', { title: MINE.duty, text: 'the desk should be able to remove one' });
  memory.logEntry(r, 'question', { question: MINE.question });
  // Declared edges, so the net matrix has something to draw, plus one
  // that points nowhere so the dangling counter is exercised.
  memory.logEntry(r, 'link',
    { from: learning.entry.id, to: error.entry.id, kind: 'resolves', why: 'came out of it' });
  memory.logEntry(r, 'link',
    { from: decision.entry.id, to: learning.entry.id, kind: 'contradicts', why: 'disputes it' });
  memory.logEntry(r, 'link',
    { from: learning.entry.id, to: 'zzzzzzzzzzzz', kind: 'causes', why: 'points at nothing' });
  // Filler, for probes that need to get PAST `LIST_MAX`. Without it
  // every fixture sits under the limit, the cut cuts nothing, and a
  // probe on the cut passes even when the cut is gone.
  for (let i = 0; i < extra; i += 1) {
    memory.logEntry(r, 'thought', { title: `filler thought ${i}`, text: 'filler' });
  }
  return { root: r, learning: learning.entry.id, error: error.entry.id };
}

const away = (r) => fs.rmSync(r, { recursive: true, force: true });

// --- the two questions ------------------------------------------------

test('POSITIVE: what is in the memory reaches the page', async () => {
  // Without this, the demo probe below is vacuous: an empty page also
  // contains no demo strings.
  const { root, learning } = filled();
  try {
    const { html, data } = dashboard.build(root, { title: 'desk' });
    assert.ok(data.entries.length >= 6,
      `the fixture produced ${data.entries.length} entries — nothing was measured`);
    for (const [what, value] of Object.entries(MINE)) {
      assert.ok(html.includes(value), `${what} never reached the page: ${value}`);
    }
    assert.ok(html.includes(learning), 'no entry id on the page, so nothing is addressable');
  } finally { away(root); }
});

test('nothing invented: not one string of the arriving export survives', async () => {
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    const found = THEIRS.filter((s) => html.includes(s));
    assert.deepEqual(found, [],
      `demo data on a page that claims to be measured: ${found.join(', ')}`);
  } finally { away(root); }
});

test('an empty memory says so instead of borrowing numbers', async () => {
  // The failure mode is not a crash — it is a page that looks healthy.
  const r = empty();
  try {
    const { html, data } = dashboard.build(r, { title: 'desk' });
    assert.equal(data.entries.length, 0);
    assert.equal(data.counts.total, 0);
    assert.match(html, /holds no entries yet/);
    const found = THEIRS.filter((s) => html.includes(s));
    assert.deepEqual(found, [], `an empty memory rendered content: ${found.join(', ')}`);
  } finally { away(r); }
});

// --- four states, never two -------------------------------------------

test('a drawer nobody ever wrote to is unmeasured, not calm', async () => {
  // Zero-of-zero is the trap. "0 open duties" on a memory that has never
  // recorded one reads as healthy and means nothing was measured.
  const r = empty();
  try {
    const d = dashboard.collect(r);
    const duties = d.work.find((w) => w.title === 'Duties');
    assert.equal(duties.state, 'unknown', 'an empty drawer reported as measured');
    assert.equal(duties.value, null, 'an unmeasured count rendered as a number');
    // The note has to say WHY there is no number, not just that there
    // is none. "0 open" and "none was ever recorded" are the two states
    // this probe exists to keep apart.
    assert.match(duties.note, /has ever been recorded/);
  } finally { away(r); }
});

test('a drawer with entries and none open is calm, and says the difference', async () => {
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    const duties = d.work.find((w) => w.title === 'Duties');
    // The fixture leaves the one duty open, so this is the watch case —
    // what matters is that it is MEASURED, unlike the probe above.
    assert.notEqual(duties.state, 'unknown');
    assert.equal(duties.value, '1 / 1');
    assert.equal(duties.total, 1);
  } finally { away(root); }
});

test('the state vocabulary is closed in both directions', () => {
  assert.equal(dashboard.word('unknown'), 'not measured');
  assert.notEqual(dashboard.word('unknown'), dashboard.word('calm'));
  // A fifth state must not quietly pick a word or a colour. Both the
  // word and the tone are looked up, and both refuse.
  assert.throws(() => dashboard.word('ok'), /Unknown state 'ok'/);
  assert.throws(
    () => dashboard.renderHtml({
      at: 'x',
      root: '/x',
      git: {},
      inventory: { total: 0 },
      system: [{ id: 'z', title: 'z', state: 'ok', line: 'z' }],
      attention: [],
      work: [],
      entries: [],
      counts: { total: 0 },
      broken: 0,
      projects: [],
      agents: [],
      facts: [],
      net: { boxes: [], pairs: [], links: 0, dangling: 0 },
    }),
    /state 'ok'/,
    'an unknown state rendered as an uncoloured word instead of failing');
});

test('an unreadable entry is not reported as a global one', () => {
  // `capability.scopeOf(undefined)` answers `'global'` — a confident
  // wrong answer rather than a gap. The desk records readability as its
  // own field for exactly that reason.
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    for (const e of d.entries) {
      assert.equal(typeof e.readable, 'boolean', `${e.id} does not say whether it was read`);
      if (!e.readable) assert.equal(e.scope, null, `${e.id} claims a scope it cannot have`);
    }
    assert.ok(d.entries.every((e) => e.readable),
      'this fixture should be fully readable — the probe is measuring the wrong thing');
  } finally { away(root); }
});

// --- no second truth ---------------------------------------------------

test('the board states are the console\'s, not a second derivation', async () => {
  const { root } = filled();
  try {
    const mine = dashboard.collect(root);
    const theirs = consolePage.collect(root);
    const a = Object.fromEntries(mine.system.map((t) => [t.id, t.state]));
    const b = Object.fromEntries(theirs.board.tiles.map((t) => [t.id, t.state]));
    assert.deepEqual(a, b, 'the desk and the console disagree about the same tiles');
    assert.equal(mine.system.length, theirs.board.tiles.length);
  } finally { away(root); }
});

test('attention is sorted alarm first and never hides an unmeasured tile', async () => {
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    const rank = d.attention.map((t) => dashboard.RANK[t.state]);
    assert.deepEqual(rank, [...rank].sort((x, y) => x - y), 'attention is out of order');
    assert.ok(d.attention.every((t) => t.state !== 'calm'), 'a calm tile wants attention');
    const unmeasured = d.system.filter((t) => t.state === 'unknown');
    for (const t of unmeasured) {
      assert.ok(d.attention.some((x) => x.id === t.id),
        `${t.id} is unmeasured and was left off the attention list`);
    }
  } finally { away(root); }
});

test('the net shows declared links only, and counts the ones that point nowhere', async () => {
  const { root } = filled();
  try {
    const d = dashboard.collect(root);
    assert.ok(d.net.pairs.length > 0, 'the fixture declared links and none arrived');
    assert.equal(d.net.dangling, 1, 'the link into nothing was swallowed');
    const kinds = new Set(d.net.pairs.flatMap((p) => Object.keys(p.kinds)));
    assert.ok(kinds.size > 0, 'the pairs carry no kinds — nothing was measured about them');
    // Nothing similarity-based: every kind must be one the net declares.
    const allowed = new Set(['derived_from', 'replaces', 'closes', 'causes',
      'generalises', 'resolves', 'contradicts']);
    for (const k of kinds) assert.ok(allowed.has(k), `invented link kind: ${k}`);
  } finally { away(root); }
});

// --- the tabs -----------------------------------------------------------

test('every view has BOTH a tab and a panel, and the two lists agree', () => {
  // Found by sabotage: dropping `set` from TABS left the panel behind,
  // because the panels are built from their own object. The page then
  // carried a section nobody could reach — and a probe that looked only
  // for `id="v-set"` called that fine.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    for (const id of dashboard.VIEWS) {
      assert.match(html, new RegExp(`id="tab-${id}"`), `no tab for ${id}`);
      assert.match(html, new RegExp(`id="v-${id}"`), `no panel for ${id}`);
    }
    const tabs = [...html.matchAll(/id="tab-([a-z]+)"/g)].map((m) => m[1]);
    const panels = [...html.matchAll(/id="v-([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(tabs, panels, 'a tab without a panel, or a panel without a tab');
    assert.deepEqual(tabs, [...dashboard.VIEWS], 'the page and VIEWS disagree');
    assert.ok(dashboard.VIEWS.includes('set'),
      'the Set tab is gone — the forms went with it');
  } finally { away(root); }
});

test('the payload carries exactly the rows that are drawn', () => {
  // **This probe was empty at first and passed anyway.** The fixture
  // had a handful of entries against a LIST_MAX of 400: nothing was
  // cut, and removing the cut entirely changed nothing. So it builds
  // past the limit and insists that something really falls away.
  const { root } = filled({ extra: dashboard.LIST_MAX + 25 });
  try {
    const { data, html } = dashboard.build(root, { title: 'desk' });
    assert.ok(data.entries.length > dashboard.LIST_MAX,
      `only ${data.entries.length} entries — nothing is being cut`);
    const m = /var ENTRIES = (\{.*?\});\nvar PAIRS/s.exec(html);
    assert.ok(m, 'no payload in the page');
    const payload = JSON.parse(m[1]);
    const drawn = [...html.matchAll(/class="item[^"]*"\s+data-id="([^"]+)"/g)].map((x) => x[1]);
    assert.deepEqual(Object.keys(payload).sort(), [...drawn].sort(),
      'payload and list cut in different places');
    assert.equal(Object.keys(payload).length, dashboard.LIST_MAX);
    assert.ok(Object.keys(payload).length < data.entries.length,
      'the payload carries everything — the cut is missing');
    assert.match(html, /not listed/, 'the page hides that it is not showing everything');
  } finally { away(root); }
});

test('read only means no enabled control, not just the word', () => {
  // Sabotage found this one: the probe asked whether "disabled"
  // appeared ANYWHERE on the page. It does — on the input — so an
  // enabled Set button went unnoticed. A button that promises what the
  // server refuses is the whole failure this page is meant to avoid.
  const { root } = filled();
  try {
    const { data } = dashboard.build(root, { title: 'desk' });
    const off = dashboard.renderHtml(data, { title: 'desk', writable: false });
    const on = dashboard.renderHtml(data, { title: 'desk', writable: true });
    assert.match(off, /READ ONLY/);
    assert.doesNotMatch(off, /<button type="submit">Set<\/button>/,
      'an enabled Set button on a read-only page');
    assert.match(on, /<button type="submit">Set<\/button>/,
      'the writable page has no working button either — the probe proves nothing');
    const offene = [...off.matchAll(/<input id="f-[^>]*>/g)].filter((x) => !x[0].includes('disabled'));
    assert.deepEqual(offene, [], 'an input stayed editable');
  } finally { away(root); }
});

// --- the knowledge space ------------------------------------------------

test('POSITIVE: a filled memory really draws a space', () => {
  // Without this, every probe below could pass against the empty-state
  // branch, which contains no canvas and no modes at all.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    assert.match(html, /<canvas id="space"/, 'no canvas');
    assert.match(html, /id="space-mode"/, 'no line-mode selector');
    assert.match(html, /value="structure"/);
    assert.match(html, /value="declared"/);
  } finally { away(root); }
});

test('an empty memory says empty, not unmeasured', () => {
  // The two are different sentences and only one of them is a gap.
  const root = empty();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    assert.doesNotMatch(html, /<canvas id="space"/, 'a space was drawn with nothing in it');
    assert.match(html, /empty, not unmeasured/);
  } finally { away(root); }
});

test('the two kinds of line never mix', () => {
  // The whole reason this view is allowed to exist. `structure` says
  // where an entry SITS — its drawer, its tags — and claims nothing.
  // `declared` is a link somebody wrote down. A picture where "shares a
  // tag" looks like "was derived from" is the inferred-edge graph this
  // project refuses to draw.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));

    // Drawing filters by kind, in both directions.
    assert.match(script, /mode\(\) === 'declared'|m === 'declared'/,
      'the drawing never asks which mode it is in');
    // ONE place decides it, and both passes ask that place. The probe
    // insists on exactly that: the rule appears once, and every use
    // goes through it.
    // Exactly one kind per mode. Anything looser and the caption under
    // the canvas claims something about lines it does not describe.
    assert.match(script,
      /return m === 'declared' \? e\.kind === 'declared' : e\.kind === 'structure';/,
      'the visibility rule is gone, or a mode shows more than one kind again');
    const uses = (script.match(/if \(!shows\(e, m\)\) return;/g) || []).length;
    assert.equal(uses, 2, `${uses} passes ask the rule — highlighting and drawing must both`);
    assert.doesNotMatch(script, /e\.kind !== 'declared'\) return;/,
      'a second, hand-written copy of the rule came back');

    // Only a declared line gets an arrowhead — direction is a claim.
    const arrowAt = script.indexOf('Math.atan2');
    const guardAt = script.lastIndexOf("e.kind === 'declared'", arrowAt);
    assert.ok(guardAt > 0 && arrowAt - guardAt < 400,
      'the arrowhead is not behind a declared-only guard');

    // Tag edges exist, and they are structure — never declared.
    assert.match(script, /link\('tag:' \+ t, id, 'structure'\)/,
      'a tag line is not declared as structure');
    assert.doesNotMatch(script, /link\('tag:[^']*'[^)]*'declared'\)/,
      'a tag line is drawn as a declared reference');
  } finally { away(root); }
});

test('a declared line is drawn only when both ends are on the page', () => {
  // The fixture deliberately contains a link to `zzzzzzzzzzzz`, which
  // does not exist. An arrow into nothing is worse than no arrow: it
  // says a relationship is there and points at a place you cannot look.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    assert.match(script, /if \(!byId\[l\.id\]\) return;/,
      'a link whose other end is absent would still be drawn');
    // And the count that the page prints must be the drawn ones.
    assert.match(script, /declared \+= 1;/);
  } finally { away(root); }
});

test('a tag on a single entry gets no node', () => {
  // A line from a tag to its one and only entry draws a relationship
  // nobody could not already see, and adds a node to the picture for it.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    assert.match(script, /if \(tags\[t\]\.length < 2\) return;/,
      'single-entry tags become nodes');
  } finally { away(root); }
});

test('the space reads the same payload as the list, not a second copy', () => {
  // The arriving export shipped a frozen `data.js` beside the page. Two
  // sources for one memory means they can disagree, and the one that is
  // wrong is whichever nobody regenerated.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    assert.match(script, /Object\.keys\(ENTRIES\)/, 'the space builds from something else');
    assert.equal((html.match(/var ENTRIES = /g) || []).length, 1, 'two payloads in one page');
    assert.doesNotMatch(html, /MEMORY_DATA|data\.js/, 'a second data source came along');
  } finally { away(root); }
});

test('the space takes its colours and its font from the theme', () => {
  // The arriving page hard-coded a webfont in the canvas as well as in
  // the stylesheet — so removing the <link> would have left the canvas
  // asking for a face that is not there, silently falling back.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    assert.match(script, /getPropertyValue/, 'the canvas does not read the theme tokens');
    assert.doesNotMatch(script, /DM Sans|Inter|Space Grotesk/, 'a webfont is named in the canvas');
    assert.match(script, /css\('--ui'\)/, 'the canvas font is not the house stack');
  } finally { away(root); }
});

test('the space can be turned without a mouse', () => {
  // A view reachable only by dragging is a view some people cannot
  // reach at all.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    assert.match(html, /<canvas id="space" tabindex="0"/, 'the canvas cannot be focused');
    const script = html.slice(html.indexOf('<script>'), html.lastIndexOf('</script>'));
    // Not just the word: `onkeydown = null` contains it too, and the
    // first version of this probe was happy with that.
    assert.match(script, /canvas\.onkeydown = function/, 'no keyboard handler is installed');
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Escape']) {
      assert.ok(script.includes(k), `${k} does nothing`);
    }
  } finally { away(root); }
});

// --- the page itself ---------------------------------------------------

test('the page reaches nothing: no CDN, no fetch, no second file', async () => {
  // The one-file promise. It is also what makes a demo fallback
  // impossible — there is no failing request to fall back from.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    assert.doesNotMatch(html, /<script[^>]+src=/, 'the page loads a script from somewhere');
    assert.doesNotMatch(html, /<link[^>]+stylesheet/, 'the page loads a stylesheet');
    assert.doesNotMatch(html, /\bfetch\(|XMLHttpRequest/, 'the page calls out over the network');

    // **This used to forbid every `http://` in the file, and that was
    // one notch too blunt.** The Set tab PRINTS the console's own
    // address so a person can read where the server answers — text in a
    // <code> element, which the browser never requests. Banning the
    // string made a correct page red, and a probe that cries at correct
    // pages gets switched off. So the rule is what it always meant: no
    // absolute URL in a place the BROWSER would go to.
    const fetched = [...html.matchAll(/(?:src|href|action)\s*=\s*"([^"]*)"/g)].map((m) => m[1])
      .concat([...html.matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]));
    for (const u of fetched) {
      assert.doesNotMatch(u, /^(?:https?:)?\/\//, `the page loads from ${u}`);
    }
    // And the positive half: it really does print one, so the probe
    // above is not passing because there is nothing to look at.
    assert.match(html, /<code>http:\/\/127\.0\.0\.1/,
      'the Set tab no longer shows where the server answers');
  } finally { away(root); }
});

test('the desk obeys the house design system, both themes', async () => {
  // docs/viewer-design-tokens.json names three deliberate absences —
  // no shadow, no webfont, no pill radius — and the arriving export had
  // all three. The type ladder is 11 12 13 14 15 17 20, no half steps.
  const { root } = filled();
  try {
    const { html } = dashboard.build(root, { title: 'desk' });
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    assert.doesNotMatch(css, /box-shadow/, 'there is no shadow token');
    assert.doesNotMatch(css, /border-radius:\s*999/, 'there is no pill radius');
    assert.doesNotMatch(css, /url\(/, 'a webfont or an image was linked');
    const half = [...css.matchAll(/font-size:\s*(\d+\.\d+)px/g)].map((m) => m[1]);
    assert.deepEqual(half, [], `half-pixel font sizes: ${half.join(', ')}`);

    // Dark first: the complete palette on the bare :root, and the light
    // block redefines only tokens that already exist there. A colour
    // declared in one block alone is the classic unreadable-page bug.
    const LIGHT = '@media (prefers-color-scheme:light)';
    assert.ok(css.includes(LIGHT), 'there is no light theme at all');
    const rootBlock = css.slice(css.indexOf(':root{'), css.indexOf(LIGHT));
    const lightRest = css.slice(css.indexOf(LIGHT));
    const lightBlock = lightRest.slice(0, lightRest.indexOf('}}'));
    const dark = new Set([...rootBlock.matchAll(/--([a-z-]+):/g)].map((m) => m[1]));
    const light = [...lightBlock.matchAll(/--([a-z-]+):/g)].map((m) => m[1]);
    assert.ok(light.length >= 10, `the light block redefines only ${light.length} tokens`);
    const orphans = light.filter((t) => !dark.has(t));
    assert.deepEqual(orphans, [], `tokens that exist only in light mode: ${orphans.join(', ')}`);
    assert.match(css, /body\{[^}]*background:var\(--paper\)/,
      'the body has no explicit ground, so it borrows the host theme');

    // Driven from the keyboard, so focus has to be visible.
    for (const sel of ['.tab:focus-visible', '.item:focus-visible', '#q:focus']) {
      assert.ok(css.includes(sel), `no focus style for ${sel}`);
    }
  } finally { away(root); }
});

test('memory content is escaped in the markup and caged in the script', async () => {
  // Two different jobs, so two different probes. In the document an
  // entry title must arrive as text. In the embedded JSON it stays a
  // raw string — which is correct, because inside a <script> the HTML
  // parser looks for nothing but `</script`; what matters there is that
  // no `</` survives to end the element early.
  const r = empty();
  try {
    const nasty = '<img src=x onerror=alert(1)>"&';
    memory.logEntry(r, 'event', { title: nasty });
    memory.logEntry(r, 'event', { title: 'and </script><img src=y> after it' });
    const { html } = dashboard.build(r, { title: 'desk' });
    const cut = html.indexOf('<script>');
    assert.ok(cut > 0, 'the page has no script block, so the split below measures nothing');
    const markup = html.slice(0, cut);
    const script = html.slice(cut);

    assert.ok(!markup.includes('<img src=x'), 'an entry title reached the document as markup');
    assert.match(markup, /&lt;img src=x/);
    // Checked as the escaped form, not as the absence of `"&`: that
    // naive probe reported a hole in correctly escaped output, because
    // `&quot;&amp;` contains the very substring it was looking for.
    assert.ok(markup.includes('&quot;&amp;'), 'a quote and an ampersand went through unescaped');

    assert.ok(!script.includes('</script><img'), 'the payload can close its own script element');
    assert.equal(script.match(/<\/script>/g).length, 1,
      'more than one closing script tag — the payload broke out');
  } finally { away(r); }
});

// --- the routes --------------------------------------------------------

test('/pult and /dashboard.json are served, and both are in the path list', async () => {
  const mod = await import(`${pathToFileURL(SERVE).href}?desk=${Math.random()}`);
  assert.ok(mod.PATHS.includes('/pult'));
  assert.ok(mod.PATHS.includes('/dashboard.json'));

  const { root } = filled();
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '',
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/pult`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.ok(html.includes(MINE.learning), 'the served page shows no memory content');
    assert.match(html, /class="mem-nav"/, 'the desk has no way back to the console');

    const json = await fetch(`${base}/dashboard.json`);
    assert.equal(json.status, 200);
    assert.match(json.headers.get('content-type'), /application\/json/);
    const d = await json.json();
    assert.ok(d.entries.some((e) => e.headline.includes(MINE.learning)));
    assert.deepEqual(d.views, [...dashboard.VIEWS]);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    away(root);
  }
});

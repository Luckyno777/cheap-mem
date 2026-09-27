// test/astra-knowledge-entries-json.test.mjs — D3: the knowledge view
// wires `/entries.json` (E1.3) for paging past `LIST_MAX`, and does so
// WITHOUT ever calling `fetch()`/`XMLHttpRequest` from the page. See the
// header comment on `astra/knowledge.mjs` for the full decision and why
// — in short, `test/dashboard.test.mjs`'s pre-existing "the page reaches
// nothing but the one font Lucky decided on" latch already asserts
// `doesNotMatch(html, /\bfetch\(|XMLHttpRequest/)` unconditionally, so a
// client-side fetch loop is not "unwired", it is a regression that test
// already catches. This file checks the plain-form alternative this
// task actually shipped, and the honest limits of it.
//
// Probes, in the order the assignment names them for D3:
//   (2) the rendered HTML carries the `/entries.json` cursor wiring
//   (3) a `warning`/`unknown`/`error` answer is visible, never silently
//       empty — checked against `pages.page()`'s own contract, since
//       the form hands that JSON back verbatim
//   (4) the embedded first page keeps working with no JavaScript at all
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as astra from '../src/astra.mjs';
import * as pages from '../src/pages.mjs';

function empty() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-d3-ej-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'd3', participants: ['someone'], language: 'en' }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

function filled({ extra = 0 } = {}) {
  const r = empty();
  memory.logEntry(r, 'learning', { title: 'a learning worth keeping', text: 'x' });
  memory.logEntry(r, 'decision', { choice: 'a decision worth finding later', why: 'y' });
  for (let i = 0; i < extra; i += 1) {
    memory.logEntry(r, 'thought', { title: `filler thought ${i}`, text: 'filler' });
  }
  return r;
}

// --- (2) the cursor wiring is really in the page ------------------------

test('the knowledge view carries a form wired to /entries.json, with the cursor field named', () => {
  const r = filled();
  try {
    const { html } = astra.build(r, { title: 'd3' });
    const knowledgeStart = html.indexOf('id="v-knowledge"');
    assert.ok(knowledgeStart > 0, 'the knowledge section is missing entirely');
    const knowledgeEnd = html.indexOf('id="v-space"');
    const section = html.slice(knowledgeStart, knowledgeEnd > 0 ? knowledgeEnd : undefined);

    assert.match(section, /action="\/entries\.json"/, 'no form targets /entries.json');
    assert.match(section, /method="get"/i, 'the form is not a plain GET (would need JS or leak state)');
    assert.match(section, /name="type"/, 'the type filter is not wired into the form');
    assert.match(section, /name="q"/, 'the text filter is not wired into the form');
    // The one field that makes this actually a PAGER, not just a single
    // search box: `pages.page()`'s own cursor parameter, by its exact
    // name, so a person can carry a `next` value forward.
    assert.match(section, /name="after"/, 'the cursor ("after") is not exposed — this cannot page');
  } finally { away(r); }
});

test('the type options on that form are the same memory.TYPES list the chips use', () => {
  const r = filled();
  try {
    const { html } = astra.build(r, { title: 'd3' });
    // Scoped to the knowledge section: `spaceView` has its own `<select
    // id="space-mode">` ("declared"/"structure") which is not a memory
    // type at all, and would otherwise leak into this count.
    const knowledgeStart = html.indexOf('id="v-knowledge"');
    const knowledgeEnd = html.indexOf('id="v-space"');
    const section = html.slice(knowledgeStart, knowledgeEnd);
    const optionTypes = [...section.matchAll(/<option value="([a-z_]+)">/g)].map((m) => m[1]);
    assert.deepEqual(optionTypes.sort(), Object.keys(memory.TYPES).sort());
  } finally { away(r); }
});

// --- the no-fetch invariant, scoped to this file's own change ----------

test('LATCH: wiring /entries.json did not introduce a script-initiated request', () => {
  // The project-wide version of this lives in test/dashboard.test.mjs
  // ("the page reaches nothing but the one font Lucky decided on") and
  // already covers the whole page; this is the narrower, D3-specific
  // form of the same check, so a regression here is traceable straight
  // back to this task without having to read the wider probe first.
  const r = filled();
  try {
    const { html } = astra.build(r, { title: 'd3' });
    assert.doesNotMatch(html, /\bfetch\(|XMLHttpRequest/,
      '/entries.json is reached by a script, not a plain form — this will also fail '
        + "the project-wide latch in test/dashboard.test.mjs");
    // A GET form's own action is a same-origin relative path, never
    // counted as "reaching outside" by that wider probe — confirmed
    // directly here too, scoped to this one attribute.
    assert.doesNotMatch(html, /action="https?:\/\//, 'the form reaches an outside host');
  } finally { away(r); }
});

// --- (3) warning / unknown / error are visible, never silently empty ---
//
// The form hands back `/entries.json`'s own JSON verbatim in a new tab —
// there is no separate rendering step on this page that could drop a
// field, so "visible" reduces to "the contract itself never answers with
// an empty-looking body on one of these states", which is `pages.page()`'s
// own promise (see its header and test/pages.test.mjs). Checked directly
// here against the exact states this view's documentation promises a
// person reading the form's own copy ("ok, warning, unknown or error").

test('a request the form CAN produce answering "unknown" carries a visible reason, not an empty list', () => {
  const r = filled();
  try {
    // An unknown type is exactly what a person can produce by hand-
    // editing the "after" URL, or a stale bookmark from before a type
    // was renamed — the form's <select> only offers valid ones, but the
    // GET request it submits is still a plain URL a person can edit.
    const found = pages.page(r, { type: 'not-a-real-type' });
    assert.equal(found.state, 'unknown');
    assert.deepEqual(found.entries, []);
    assert.ok(found.reason && found.reason.length > 0,
      'an "unknown" answer with no reason reads exactly like an empty, ok result');
  } finally { away(r); }
});

test('a broken cursor pasted into "continue after" answers "error", never a silent page 1', () => {
  const r = filled();
  try {
    const found = pages.page(r, { after: 'not-a-real-cursor' });
    assert.equal(found.state, 'error');
    assert.deepEqual(found.entries, []);
    assert.ok(found.reason && found.reason.length > 0);
  } finally { away(r); }
});

test('a broken line in the log surfaces as "warning" with a reason, alongside the page it still returns', () => {
  const r = filled();
  try {
    const file = memory.logPath(r, 'learning', null);
    fs.appendFileSync(file, 'not valid json at all\n');
    const found = pages.page(r, { type: 'learning' });
    assert.equal(found.state, 'warning');
    assert.ok(found.entries.length >= 1, 'a warning must still carry the page, not an empty one');
    assert.ok(found.reason && /unreadable/.test(found.reason));
  } finally { away(r); }
});

test('the form\'s own copy on the page names all four states, so a person knows what they are seeing', () => {
  const r = filled();
  try {
    const { html } = astra.build(r, { title: 'd3' });
    const knowledgeStart = html.indexOf('id="v-knowledge"');
    const knowledgeEnd = html.indexOf('id="v-space"');
    const section = html.slice(knowledgeStart, knowledgeEnd);
    for (const state of ['ok', 'warning', 'unknown', 'error']) {
      assert.ok(section.includes(`>${state}<`) || section.includes(`<code>${state}</code>`),
        `the page never tells a person that a "${state}" answer can happen`);
    }
  } finally { away(r); }
});

// --- (4) the embedded first page keeps working with no JavaScript ------

test('the embedded first page needs no script to be visible or searchable-by-eye', () => {
  const r = filled({ extra: 5 });
  try {
    const { html, data } = astra.build(r, { title: 'd3' });
    assert.ok(data.entries.length >= 7);
    const knowledgeStart = html.indexOf('id="v-knowledge"');
    const knowledgeEnd = html.indexOf('id="v-space"');
    const section = html.slice(knowledgeStart, knowledgeEnd);
    // Every embedded row is real markup with the headline as visible
    // text, not a placeholder a script fills in later. (`viewer.headline`
    // appends the entry's `text` after an em dash, hence the `.*`.)
    assert.match(section, /class="h">a learning worth keeping.*<\/span>/);
    assert.match(section, /class="h">a decision worth finding later.*<\/span>/);
    // The form itself works without JS: a plain GET with a static
    // action and no onsubmit handler anywhere near it.
    const formStart = section.indexOf('action="/entries.json"');
    const formSlice = section.slice(Math.max(0, formStart - 200), formStart + 400);
    assert.doesNotMatch(formSlice, /onsubmit/i, 'the form depends on a submit handler');
  } finally { away(r); }
});

test('an empty memory\'s knowledge view says so in markup, not via a script that fills it in', () => {
  const r = empty();
  try {
    const { html } = astra.build(r, { title: 'd3' });
    assert.match(html, /This memory holds no entries yet\./);
  } finally { away(r); }
});

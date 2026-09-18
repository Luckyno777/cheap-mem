import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as viewer from '../src/viewer.mjs';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-viewer-'));
}

// A small memory with one of several shapes: a global decision + error,
// and a project event. Enough to exercise headline, type mapping,
// project attribution and ordering.
function seed(root) {
  memory.logEntry(root, 'decision',
    { topic: 'db', choice: 'sqlite', why: 'one file' },
    { now: new Date('2026-01-01T00:00:00Z') });
  memory.logEntry(root, 'error',
    { class: 'flaky', title: 'payment test times out', text: 'retry too short' },
    { now: new Date('2026-01-02T00:00:00Z') });
  memory.projectInit(root, 'webapp');
  memory.logEntry(root, 'event',
    { title: 'launched v1', tags: ['release'] },
    { project: 'webapp', now: new Date('2026-01-03T00:00:00Z') });
}

test('collect gathers every entry, newest first', () => {
  const root = tmpRoot();
  seed(root);
  const rows = viewer.collect(root);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].headline.includes('launched v1'), true); // 01-03 first
  assert.equal(rows[2].details.choice, 'sqlite');               // 01-01 last
});

test('collect maps type and project from the source path', () => {
  const root = tmpRoot();
  seed(root);
  const rows = viewer.collect(root);
  const ev = rows.find((r) => r.headline.includes('launched v1'));
  assert.equal(ev.type, 'event');
  assert.equal(ev.project, 'webapp');
  const err = rows.find((r) => r.type === 'error');
  assert.equal(err.project, null);
  assert.equal(err.typeLabel, 'Errors');
});

test('headline prefers meaningful fields', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision', { topic: 'x', choice: 'y', why: 'z' });
  const rows = viewer.collect(root);
  assert.equal(rows[0].headline.includes('y'), true); // choice is a headline field
});

test('renderHtml embeds content and is one self-contained file', () => {
  const root = tmpRoot();
  seed(root);
  const { html, count } = viewer.build(root, { title: 'demo' });
  assert.equal(count, 3);
  assert.match(html, /^<!doctype html>/i);
  assert.equal(html.includes('payment test times out'), true);
  assert.equal(html.includes('one file'), true);
  // No external resources: no CDN scripts, no fetched fonts/styles.
  assert.equal(/src=["']https?:/i.test(html), false);
  assert.equal(/<link[^>]+href=["']https?:/i.test(html), false);
});

test('the embedded JSON payload parses and escapes </script>', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'event', { title: 'break </script> out', text: '<!-- x -->' });
  const { html } = viewer.build(root, { title: 't' });
  // The raw close-tag must not appear inside the payload verbatim.
  const m = html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'data block present');
  assert.equal(m[1].includes('</script>'), false);
  const json = JSON.parse(m[1].replace(/<\\\//g, '</').replace(/<\\!--/g, '<!--'));
  assert.equal(json.memories[0].entries[0].headline.includes('break </script> out'), true);
});

test('the viewer never reads raw/ (redaction stays upstream)', () => {
  const root = tmpRoot();
  seed(root);
  fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(root, 'raw', 'canary.txt'), 'RAW-CANARY-DO-NOT-LEAK', 'utf8');
  const { html } = viewer.build(root, {});
  assert.equal(html.includes('RAW-CANARY-DO-NOT-LEAK'), false);
});

test('an empty memory renders a valid, zero-row page', () => {
  const root = tmpRoot();
  // no entries at all
  const { html, count } = viewer.build(root, { title: 'empty' });
  assert.equal(count, 0);
  assert.match(html, /^<!doctype html>/i);
  const m = html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/);
  const json = JSON.parse(m[1].replace(/<\\\//g, '</').replace(/<\\!--/g, '<!--'));
  // The payload carries a LIST of memories, one today. Shaped that way
  // from the start so sharding — which docs/scale.md tells teams to do
  // past 50k entries — does not need the format changed later.
  assert.equal(json.memories.length, 1);
  assert.equal(json.memories[0].entries.length, 0);
  assert.equal(json.memories[0].counts.total, 0);
});

test('retired entries are shown in the viewer, marked', () => {
  const root = tmpRoot();
  const { entry } = memory.logEntry(root, 'thought', { text: 'discarded idea zebra' });
  memory.retireEntry(root, 'thought', entry.id, { state: 'discarded' });
  const rows = viewer.collect(root);
  const r = rows.find((x) => x.headline.includes('zebra'));
  assert.ok(r, 'retired entry still in the viewer (history stays)');
  assert.equal(r.retired.state, 'discarded');
  const { html } = viewer.build(root, {});
  // Shown, and marked as retired — the class carries the marking, and a
  // switch turns the viewer back into the everyday-recall view.
  assert.equal(html.includes('chip gone'), true);
  assert.equal(html.includes('only live'), true);
});

test('a broken (non-JSON) log line does not crash the viewer', () => {
  const root = tmpRoot();
  seed(root);
  fs.appendFileSync(memory.logPath(root, 'event'), 'this is not json\n', 'utf8');
  const { html } = viewer.build(root, {});
  assert.match(html, /^<!doctype html>/i); // still renders
});

// --- No fallback to invented data ------------------------------------
//
// The assurance travelled from the sibling house on 2026-09-18, where it
// sat as a marker with no catalogue entry for days — so this house never
// learned it, and this house has a viewer too.
//
// A page whose read failed and which then draws plausible sample rows is
// worse than one that draws nothing: it is convincing, and the header
// still says the data is real. Nobody re-checks a page that looks right.
//
// Checked as EFFECT and as STRUCTURE, because either alone is weak. The
// effect probe proves an empty memory stays empty on the page; the
// structural probe proves no sample collection is shipped that a future
// catch-block could reach for.
//
// invariant: kein-rueckfall-auf-erfundene-daten
test('an empty memory renders an empty page, not a sample one', () => {
  const root = tmpRoot();
  const leer = viewer.build([root], { title: 'probe' });

  // POSITIVE CONTROL first: with entries, the page really does carry
  // them. Without this the assertion below passes on a broken builder
  // that renders nothing at all, ever.
  const full = tmpRoot();
  seed(full);
  const voll = viewer.build([full], { title: 'probe' });
  assert.ok(voll.count > 0 && voll.html.includes('sqlite'),
    'positive control failed: a seeded memory does not reach the page');

  assert.equal(leer.count, 0, 'an empty memory must count zero entries');
  assert.ok(!leer.html.includes('sqlite'),
    'an empty memory must not show another memory\'s content');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(full, { recursive: true, force: true });
});

test('the viewer ships no sample collection a failed read could fall back on', () => {
  const src = fs.readFileSync(
    new URL('../src/viewer.mjs', import.meta.url), 'utf8');
  // Deliberately narrow: these are the names such a fallback carries in
  // practice. A wide net here would fire on ordinary words and get
  // switched off, which is how this kind of check dies.
  for (const forbidden of ['SAMPLE_ENTRIES', 'DEMO_DATA', 'PLACEHOLDER_ROWS',
    'exampleEntries', 'fallbackEntries']) {
    assert.ok(!src.includes(forbidden),
      `viewer.mjs carries '${forbidden}' — a failed read could reach for it`);
  }
});

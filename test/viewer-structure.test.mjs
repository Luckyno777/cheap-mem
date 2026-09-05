import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as viewer from '../src/viewer.mjs';
import * as memory from '../src/memory.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-vs-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  return r;
}
const payload = (html) => {
  const m = html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/);
  return JSON.parse(m[1].replace(/<\\\//g, '</').replace(/<\\!--/g, '<!--'));
};

test('the payload is a LIST of memories, even with one', () => {
  // Shaped for sharding from the start. docs/scale.md tells teams to
  // split past 50k entries; changing the payload format afterwards costs
  // far more than allowing for it now.
  const r = root();
  try {
    memory.logEntry(r, 'event', { title: 'something happened' });
    const p = payload(viewer.build(r, { title: 't' }).html);
    assert.ok(Array.isArray(p.memories));
    assert.equal(p.memories.length, 1);
    assert.ok(p.memories[0].name, 'each memory carries a name to switch by');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('several memories render into one page', () => {
  const a = root(); const b = root();
  try {
    memory.logEntry(a, 'decision', { title: 'the payments team chose stripe' });
    memory.logEntry(b, 'decision', { title: 'the support team chose zendesk' });
    const out = viewer.build([a, b], { title: 'both', names: ['payments', 'support'] });
    assert.equal(out.memories, 2);
    assert.equal(out.count, 2);
    const p = payload(out.html);
    assert.deepEqual(p.memories.map((m) => m.name), ['payments', 'support']);
    assert.match(out.html, /stripe/);
    assert.match(out.html, /zendesk/);
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});

test('the structure travels: topics, links, experiences, facts', () => {
  // The old viewer collected a flat list, which is what a log file is.
  // Everything that makes this a memory sat beside it and was invisible.
  const r = root();
  try {
    // Explicit, distinct timestamps: logged in the same second, "newest"
    // is a tie broken by read order, and the assertion below would be
    // testing the tie-break rather than the thread.
    const { entry: bad } = memory.logEntry(r, 'error', {
      topic: 'architecture/storage', title: 'redis eviction dropped live sessions',
      ts: '2026-06-14T11:20:00Z' });
    const { entry: fix } = memory.logEntry(r, 'decision', {
      topic: 'architecture/storage', title: 'sessions move to postgres', choice: 'postgres',
      ts: '2026-07-01T08:00:00Z' });
    memory.logEntry(r, 'link', { from: bad.id, to: fix.id, kind: 'causes', why: 'the outage forced it' });
    const { entry: learn } = memory.logEntry(r, 'learning', { title: 'evictable stores lose sessions' });
    memory.logEntry(r, 'decision', { title: 'no session data in redis', origin: { derived_from: [learn.id] } });
    memory.logEntry(r, 'timeline', { key: 'stack.sessions', value: 'postgres', valid_from: '2026-07-01' });

    const m = payload(viewer.build(r, { title: 't' }).html).memories[0];

    assert.equal(m.topics.length, 1);
    assert.equal(m.topics[0].topic, 'architecture/storage');
    assert.equal(m.topics[0].current, fix.id, 'the newest entry is the current state');
    assert.deepEqual(m.topics[0].trail, [bad.id], 'the rest is the trail');

    assert.equal(m.links.length, 1);
    assert.equal(m.links[0].kind, 'causes');
    assert.equal(m.links[0].fromKnown && m.links[0].toKnown, true);

    assert.ok(m.experiences.some((x) => x.id === learn.id && x.cited === 1));

    const fact = m.facts.find((f) => f.key === 'stack.sessions');
    assert.ok(fact, 'living facts must travel');
    assert.equal(fact.value, 'postgres');
    assert.equal(fact.validFrom, '2026-07-01');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a fact that changed keeps its earlier values', () => {
  const r = root();
  try {
    memory.logEntry(r, 'timeline', { key: 'team.size', value: '6', valid_from: '2026-01-10' });
    memory.logEntry(r, 'timeline', { key: 'team.size', value: '11', valid_from: '2026-08-01' });
    const f = payload(viewer.build(r, { title: 't' }).html).memories[0].facts
      .find((x) => x.key === 'team.size');
    assert.equal(f.value, '11', 'the current value is the newest');
    assert.equal(f.history.length, 1);
    assert.equal(f.history[0].value, '6', 'what it used to be is what makes it a timeline');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a link pointing nowhere is marked dangling, not hidden', () => {
  // The doctor reports these; the viewer must not quietly render them as
  // if both ends existed.
  const r = root();
  try {
    const { entry: real } = memory.logEntry(r, 'decision', { title: 'a real decision' });
    memory.logEntry(r, 'link', { from: real.id, to: 'ghost99', kind: 'resolves' });
    const l = payload(viewer.build(r, { title: 't' }).html).memories[0].links[0];
    assert.equal(l.fromKnown, true);
    assert.equal(l.toKnown, false);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the page still asks nothing of the network', () => {
  // Load-bearing, not cosmetic: this page shows private memory content
  // and is meant to work offline. A webfont request would break both —
  // and tell a font host, with a referrer, that someone is reading it.
  const r = root();
  try {
    memory.logEntry(r, 'event', { title: 'x' });
    const { html } = viewer.build(r, { title: 't' });
    assert.equal(/<link[^>]+href=["']https?:/i.test(html), false, 'a stylesheet is fetched');
    assert.equal(/src=["']https?:/i.test(html), false, 'a script is fetched');
    assert.equal(/@import\s+url\(["']?https?:/i.test(html), false, 'a font is imported');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as doctor from '../src/doctor.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-tq-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  return r;
}
const rm = (r) => fs.rmSync(r, { recursive: true, force: true });

test('checkTopic flags the shapes that were actually in the corpus', () => {
  // Not invented examples — these are real topics from a 553-entry memory
  // measured on 2026-09-05.
  for (const t of [
    'Sentences with a value in them (slide 3, 42 seconds)',
    'Where a rule repeated three times belongs',
    'Text node in a markup template (962t)',
  ]) {
    assert.equal(memory.checkTopic(t).ok, false, `should have warned: ${t}`);
  }
  for (const t of ['viewer/design', 'cheap-mem/retrieval', 'legal/payment-terms']) {
    assert.deepEqual(memory.checkTopic(t).warnings, [], `wrongly flagged: ${t}`);
  }
  // No topic is not an error — an entry without one is still findable via
  // search, while an invented one is noise forever.
  assert.equal(memory.checkTopic('').ok, true);
  assert.equal(memory.checkTopic(null).ok, true);
});

test('a topic without a slash is reported as a future singleton', () => {
  const c = memory.checkTopic('payments');
  assert.equal(c.ok, false);
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0], /no "\/"/);
});

test('topicTree bundles by the first path segment', () => {
  const r = root();
  try {
    for (const [t, i] of [['viewer/design', 1], ['viewer/motion', 2], ['viewer/pwa', 3],
      ['retrieval/bm25', 4], ['loose', 5]]) {
      memory.logEntry(r, 'decision', { topic: t, choice: 'x', why: 'y' },
        { now: new Date(`2026-01-0${i}T00:00:00Z`) });
    }
    const tree = memory.topicTree(r);
    const viewer = tree.find((b) => b.area === 'viewer');
    assert.equal(viewer.children.length, 3);
    assert.equal(viewer.orphan, false);
    assert.deepEqual(viewer.children.map((c) => c.leaf).sort(), ['design', 'motion', 'pwa']);
    // A branch with one child is itself a singleton — the tree shows it.
    assert.equal(tree.find((b) => b.area === 'retrieval').orphan, true);
    // Topics without a slash land in a visible bucket of their own rather
    // than hiding among the real areas.
    assert.equal(tree.find((b) => b.area === '(no area)').children.length, 1);
    // Biggest branch first: the ordering should show where things grow.
    assert.equal(tree[0].area, 'viewer');
  } finally { rm(r); }
});

test('topicQuality measures exactly the finding it exists for', () => {
  const r = root();
  try {
    for (let i = 0; i < 5; i += 1) {
      memory.logEntry(r, 'decision', { topic: `topic-${i}`, choice: 'x', why: 'y' });
    }
    let q = memory.topicQuality(r);
    assert.equal(q.entriesPerTopic, 1, 'one entry per topic is the finding');
    assert.equal(q.singleShare, 1);
    assert.equal(q.malformed, 5, 'all five without an area');

    // Now later entries join existing topics — which is what turns a
    // topic into a thread in the first place.
    for (let i = 0; i < 5; i += 1) {
      memory.logEntry(r, 'error', { topic: `topic-${i}`, class: 'x', title: 't', text: 'x' });
    }
    q = memory.topicQuality(r);
    assert.equal(q.entriesPerTopic, 2, 'the number rises when topics are reused');
    assert.equal(q.singleTopics, 0);
  } finally { rm(r); }
});

test('the doctor warns while every topic has exactly one entry', () => {
  const r = root();
  try {
    for (let i = 0; i < 4; i += 1) {
      memory.logEntry(r, 'decision', { topic: `area/thing-${i}`, choice: 'x', why: 'y' });
    }
    let f = doctor.checkTopicQuality(r);
    assert.equal(f.level, doctor.LEVEL.WARN);
    assert.match(f.text, /1 entries per topic/);
    assert.match(f.advice, /reuse/);

    for (let i = 0; i < 4; i += 1) {
      memory.logEntry(r, 'learning', { topic: `area/thing-${i}`, title: 't', text: 'x' });
    }
    f = doctor.checkTopicQuality(r);
    assert.equal(f.level, doctor.LEVEL.GOOD, f.text);
  } finally { rm(r); }
});

test('an empty memory is not sick, only empty', () => {
  const r = root();
  try {
    assert.equal(doctor.checkTopicQuality(r).level, doctor.LEVEL.GOOD);
  } finally { rm(r); }
});

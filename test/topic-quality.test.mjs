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

test('a topic that repeats its project is reported', () => {
  // Until 2026-09-05 the check demanded a prefix. That was backwards: the
  // area comes from the entry's PROJECT, so a prefix in the name repeats it.
  assert.equal(memory.checkTopic('payments').ok, true, 'no slash is no longer an error');
  const c = memory.checkTopic('cheap-mem/retrieval', { area: 'cheap-mem' });
  assert.equal(c.ok, false);
  assert.match(c.warnings[0], /repeats the project/);
  assert.match(c.warnings[0], /'retrieval'/, 'the shorter form is suggested');
  // In a different project the same prefix is not an error.
  assert.equal(memory.checkTopic('cheap-mem/retrieval', { area: 'payments' }).ok, true);
});

test('topicTree branches by PROJECT, not by the name', () => {
  // The 2026-09-05 correction: 72 topics looked like 72 areas when there
  // were four. The grouping had been there all along, called `project`.
  const r = root();
  try {
    for (const [t, i] of [['transfers', 1], ['clauses', 2], ['translation', 3]]) {
      memory.logEntry(r, 'decision', { topic: t, choice: 'x', why: 'y' },
        { project: 'payments', now: new Date(`2026-01-0${i}T00:00:00Z`) });
    }
    memory.logEntry(r, 'decision', { topic: 'quote', choice: 'x', why: 'y' },
      { project: 'sales', now: new Date('2026-01-04T00:00:00Z') });
    memory.logEntry(r, 'decision', { topic: 'no-project', choice: 'x', why: 'y' },
      { now: new Date('2026-01-05T00:00:00Z') });

    const tree = memory.topicTree(r);
    assert.deepEqual(tree.map((b) => b.area).sort(), ['(global)', 'payments', 'sales']);
    assert.equal(tree[0].area, 'payments', 'biggest branch first');
    assert.equal(tree.find((b) => b.area === 'payments').children.length, 3);
    assert.equal(tree.find((b) => b.area === 'sales').orphan, true);
  } finally { rm(r); }
});

test('a prefix repeating the project drops out of the tree', () => {
  const r = root();
  try {
    memory.logEntry(r, 'decision', { topic: 'cheap-mem/retrieval', choice: 'x', why: 'y' },
      { project: 'cheap-mem' });
    memory.logEntry(r, 'decision', { topic: 'memory/store', choice: 'x', why: 'y' },
      { project: 'cheap-mem' });
    const b = memory.topicTree(r).find((x) => x.area === 'cheap-mem');
    assert.deepEqual(b.children.map((c) => c.leaf).sort(), ['memory/store', 'retrieval'],
      'only the repeated prefix goes; a foreign one stays');
  } finally { rm(r); }
});

test('merging topics rewrites no line', () => {
  // Append-only is why the memory can be trusted. A merge is therefore a
  // NEW line applied on read; the old one stays exactly as written.
  const r = root();
  try {
    memory.logEntry(r, 'decision', { topic: 'payments', choice: 'a', why: 'x' });
    memory.logEntry(r, 'decision', { topic: 'payment-transfer', choice: 'b', why: 'x' });
    memory.logEntry(r, 'decision', { topic: 'payment-details', choice: 'c', why: 'x' });
    assert.equal(memory.topics(r).length, 3);

    const raw = fs.readFileSync(path.join(r, 'global/decisions.jsonl'), 'utf8');
    memory.mergeTopics(r, ['payment-transfer', 'payment-details'], 'payments',
      { why: 'same subject, named three times' });

    const t = memory.topics(r);
    assert.equal(t.length, 1, 'on READ they are now one');
    assert.equal(t[0].topic, 'payments');
    assert.equal(t[0].count, 3);
    assert.equal(fs.readFileSync(path.join(r, 'global/decisions.jsonl'), 'utf8'), raw,
      'a written line was touched');
    assert.ok(memory.topicEntries(r, 'payments').some((x) => x._topic_raw === 'payment-details'));
  } finally { rm(r); }
});

test('chains resolve, cycles stop', () => {
  const r = root();
  try {
    memory.logEntry(r, 'decision', { topic: 'a', choice: 'x', why: 'y' });
    memory.mergeTopics(r, 'a', 'b');
    memory.mergeTopics(r, 'b', 'c');
    assert.equal(memory.topics(r)[0].topic, 'c', 'a->b->c must land on c');
    memory.mergeTopics(r, 'c', 'a');
    assert.doesNotThrow(() => memory.topics(r));
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
    assert.equal(q.malformed, 0, 'a missing slash is no longer malformed');

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

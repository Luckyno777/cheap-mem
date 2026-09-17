// The instruments, before anything they measure.
//
// **Where this comes from.** The external audit of 2026-09-17 found two
// gauges reporting confidently about things they were not looking at.
//
//   - The consumption funnel's question channel searched for `frage`,
//     `art` and `nach`. In this repo the fields are `question`, `kind`
//     and `to` — the German names are the project this tool was
//     extracted from. It read the rows, matched nothing, and reported
//     `produced 0, consumed 0`. Its own tests built fixtures with the
//     same foreign names and confirmed the zero.
//   - The D18 contract was `must: [/\b3\b/]` for a question asking for a
//     percentage, so "10 Prozent. Quelle V-preisstaffel-3." scored as a
//     success: the digit came from the source identifier.
//
// A gauge and its calibration sharing one wrong assumption is the
// quietest failure in this repo. This file's fixtures therefore go
// through the PUBLIC writer, never through hand-written rows.
//
// invariant: nicht-messbar-ist-nicht-null
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';
import * as question from '../src/question.mjs';
import * as inbox from '../src/inbox.mjs';
import * as config from '../src/config.mjs';
import { funnel } from '../bench/consumption-funnel.mjs';
import { TASKS, grade } from '../eval/tasks.mjs';

const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const kanal = (root) => funnel(root, { isDone: inbox.isDone })
  .find((c) => c.channel === 'questions');

function welt({ project = 'alpha' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mess-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  config.writeConfig(root, config.DEFAULT_CONFIG);
  const ts = '2026-09-01T10:00:00Z';
  // Through the public writer. A fixture that writes rows by hand can
  // agree with a reader that reads them by hand, and both be wrong.
  memory.logEntry(root, 'question', { id: 'question1', question: 'Where is quartz?', ts }, { project });
  memory.logEntry(root, 'learning', { id: 'answer001', text: 'Quartz is here', ts }, { project });
  memory.logEntry(root, 'link', { id: 'link00001', from: 'answer001', to: 'question1', kind: 'resolves', ts }, { project });
  return root;
}

test('the funnel counts the question the reader says is answered', () => {
  const root = welt();
  try {
    const echt = question.all(root);
    assert.equal(echt.length, 1, 'the fixture itself is wrong');
    assert.equal(echt.filter((q) => !q.open).length, 1, 'the fixture question is not answered');

    const c = kanal(root);
    assert.equal(c.produced, 1, `produced ${c.produced} where the reader sees 1`);
    assert.equal(c.consumed, 1, `consumed ${c.consumed} where the reader sees 1`);
  } finally { away(root); }
});

test('an unanswered question counts as produced and not consumed', () => {
  // The counter-direction. Without it a funnel that simply echoes the
  // number of questions as both figures would pass the probe above.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mess2-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    config.writeConfig(root, config.DEFAULT_CONFIG);
    memory.logEntry(root, 'question', {
      id: 'question9', question: 'Still open?', ts: '2026-09-01T10:00:00Z',
    }, { project: 'alpha' });
    const c = kanal(root);
    assert.equal(c.produced, 1);
    assert.equal(c.consumed, 0, 'an unanswered question was counted as consumed');
  } finally { away(root); }
});

test('a global question is measured too, not only a project one', () => {
  // The old channel read `projects/*` only. A memory used without
  // projects reported zero and looked like a dead channel.
  const root = welt({ project: null });
  try {
    const c = kanal(root);
    assert.equal(c.produced, 1, 'a question outside any project is invisible to the gauge');
    assert.equal(c.consumed, 1);
  } finally { away(root); }
});

test('no store at all is null, not zero', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-mess3-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    config.writeConfig(root, config.DEFAULT_CONFIG);
    const c = kanal(root);
    assert.equal(c.produced, null, 'an absent store was reported as a measured 0');
    assert.equal(c.consumed, null);
    assert.match(String(c.note ?? ''), /no questions store/);
  } finally { away(root); }
});

test('a withdrawn answer is not consumption', () => {
  const root = welt();
  try {
    assert.equal(kanal(root).consumed, 1, 'the positive control failed');
    memory.retireEntry(root, 'link', 'link00001', { state: 'discarded', project: 'alpha' });
    assert.equal(kanal(root).consumed, 0,
      'a withdrawn resolves edge still counts as a consumed question');
  } finally { away(root); }
});

// --- the grader -------------------------------------------------------

test('D18: the audit table, exactly', () => {
  const t = TASKS.find((x) => x.id === 'D18');
  assert.ok(t, 'D18 is gone');
  assert.equal(grade(t, '10 Prozent. Quelle V-preisstaffel-3.').success, false,
    'a source identifier still supplies the answer');
  assert.equal(grade(t, '10 Prozent.').success, false);
  assert.equal(grade(t, '3 Prozent.').success, true,
    'the correct answer stopped counting — the fix went too far');
});

test('every control answer a task declares grades the way it says', () => {
  // Positive, negative and misleading, per task contract — the audit's
  // own recommendation. A contract without them is a rule nobody has
  // ever seen fail.
  for (const t of TASKS) {
    if (!t.kontrollen) continue;
    for (const a of t.kontrollen.positiv ?? []) {
      assert.equal(grade(t, a).success, true, `${t.id}: correct answer rejected: ${a}`);
    }
    for (const a of [...(t.kontrollen.negativ ?? []), ...(t.kontrollen.irrefuehrend ?? [])]) {
      assert.equal(grade(t, a).success, false, `${t.id}: wrong answer accepted: ${a}`);
    }
  }
});

// The final split is sealed (test/eval-frozen.test.mjs). Three of its
// tasks carry the same bare-number contract, and repairing them would
// break the seal — after which the final run would no longer be an
// independent measurement, which costs more than the hole does. So they
// are exempt, BY NAME, until the split is legitimately re-cut. An
// exemption that is written down and counted is a debt; one that is
// quietly folded into the rule is the defect again.
const EINGEFROREN_MIT_LOCH = Object.freeze(['F3', 'D6', 'F6']);

test('a number contract without control answers is not allowed', () => {
  // THE probe of this half. D18 was wrong for months because a bare
  // `\b3\b` had never been shown a misleading answer. A contract whose
  // `must` is a naked number now has to carry the three controls — or
  // be on the frozen list above.
  const nackt = TASKS.filter((t) => t.must.some((re) => /^\/\\b\d+\\b\/$/.test(String(re))));
  const ohne = nackt.filter((t) => !t.kontrollen && !EINGEFROREN_MIT_LOCH.includes(t.id));
  assert.deepEqual(ohne.map((t) => t.id), [],
    `bare-number contracts without control answers: ${ohne.map((t) => t.id).join(', ')}`);
  // And the exemption may not grow by itself: every name on it must
  // really be in the frozen split and really still carry the hole.
  for (const id of EINGEFROREN_MIT_LOCH) {
    const t = TASKS.find((x) => x.id === id);
    assert.ok(t, `${id} is exempt from a rule but does not exist`);
    assert.equal(t.split, 'final', `${id} is exempt as frozen but sits in '${t.split}'`);
    assert.ok(nackt.includes(t),
      `${id} no longer needs the exemption — take it off the list`);
  }
});

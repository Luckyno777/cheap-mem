// test/userhabits.test.mjs — the generic, English, code-only habit
// meter over the human user's own captures (N4: cheap-mem parity for
// lucky-mem's nutzerverstaendnis.mjs).
//
// invariant: drei-zustaende-nie-zwei
// invariant: nicht-messbar-ist-nicht-null
// invariant: leer-ist-kein-bestehen
//
// Every message used below is SYNTHETIC filler written for this test —
// no participant's real words, no name, nothing from any real capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as raw from '../src/raw.mjs';
import * as uh from '../src/userhabits.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempRoot(prefix = 'cm-userhabits-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A real, string-content `user` transcript line, one minute apart. */
function userLine(text, i, startISO = '2026-09-20T08:00:00Z', extra = {}) {
  const ts = new Date(new Date(startISO).getTime() + i * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { type: 'user', timestamp: ts, message: { role: 'user', content: text }, ...extra };
}
function assistantLine(i, startISO = '2026-09-20T08:00:00Z') {
  const ts = new Date(new Date(startISO).getTime() + i * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: 'ok' } };
}

/** `n` real user turns, interleaved with an assistant line, one minute apart. */
function turns(n, textFn, startISO = '2026-09-20T08:00:00Z') {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(userLine(textFn(i), i * 2, startISO));
    out.push(assistantLine(i * 2 + 1, startISO));
  }
  return out;
}

function writeTranscript(dir, lines) {
  const p = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(p, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return p;
}

/** Captures `lines` into `root`'s raw archive; asserts the capture worked. */
function capture(root, lines) {
  const t = writeTranscript(root, lines);
  const r = raw.capture(root, t, { minBytes: 1 });
  assert.equal(r.status, 'captured', `capture() did not go through: ${JSON.stringify(r)}`);
  return r;
}

function cli(root, argv) {
  const r = spawnSync('node', [path.join(REPO, 'bin', 'mem'), ...argv], {
    encoding: 'utf8', timeout: 40000, input: '',
    env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// --- Every default pattern against its OWN positive AND negative example

test('every shipped default pattern matches its positive example and misses its negative one', () => {
  const patterns = uh.loadPatterns();
  assert.ok(patterns.length >= 4, `only ${patterns.length} default patterns loaded`);
  const { ok, errors } = uh.checkAllExamples(patterns);
  assert.deepEqual(errors, []);
  assert.ok(ok);
});

test('each default pattern ships at least one positive AND one negative example', () => {
  for (const p of uh.loadPatterns()) {
    assert.ok(p.examples.positive.length >= 1, `${p.name}: no positive example`);
    assert.ok(p.examples.negative.length >= 1, `${p.name}: no negative example`);
    assert.ok(typeof p.action === 'string' && p.action.trim(), `${p.name}: no action line`);
  }
});

test('matchesPattern flips the verdict for an inverted pattern', () => {
  const lang = uh.loadPatterns().find((p) => p.name === 'non_default_language');
  assert.ok(lang.inverted);
  assert.equal(uh.matchesPattern(lang, 'por favor revisa los registros'), true);
  assert.equal(uh.matchesPattern(lang, 'please check the logs, thanks'), false);
});

test('mem user --self-test is green from the CLI, with no root at all', () => {
  const r = spawnSync('node', [path.join(REPO, 'bin', 'mem'), 'user', '--self-test'],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /All examples passed/);
});

// --- loadPatterns()/compilePattern(): loud, not silent, about a broken file

test('loadPatterns refuses a pattern with no action line, loudly', () => {
  const root = tempRoot();
  try {
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify([{
      name: 'x', regex: 'x', examples: { positive: ['x'], negative: ['y'] },
    }]));
    assert.throws(() => uh.loadPatterns(bad), /action/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('loadPatterns refuses a pattern with no positive or no negative example', () => {
  const root = tempRoot();
  try {
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify([{
      name: 'x', regex: 'x', action: 'do something', examples: { positive: [], negative: ['y'] },
    }]));
    assert.throws(() => uh.loadPatterns(bad), /positive example/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('loadPatterns refuses invalid JSON rather than silently falling back to the defaults', () => {
  const root = tempRoot();
  try {
    const bad = path.join(root, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    assert.throws(() => uh.loadPatterns(bad), /not valid JSON/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('resolvePatternsPath: CHEAP_MEM_USER_PATTERNS wins over everything else', () => {
  const p = uh.resolvePatternsPath('/does/not/matter', { env: { CHEAP_MEM_USER_PATTERNS: '/some/file.json' } });
  assert.equal(p, path.resolve('/some/file.json'));
});

test('resolvePatternsPath: no override at all -> null (the shipped defaults)', () => {
  const root = tempRoot();
  try {
    assert.equal(uh.resolvePatternsPath(root, { env: {} }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- What counts as a REAL user message? -------------------------------

test('isRealUserMessage: a synthetic prefix, isMeta or isSidechain line does not count', () => {
  assert.equal(uh.isRealUserMessage(userLine('ordinary text', 0)), true);
  assert.equal(uh.isRealUserMessage(userLine('<task-notification>\n<task-id>x</task-id>', 0)), false);
  assert.equal(uh.isRealUserMessage(userLine('<system-reminder>irrelevant</system-reminder>', 0)), false);
  assert.equal(uh.isRealUserMessage(userLine('a background session sent a message', 0, undefined, { isMeta: true })), false);
  assert.equal(uh.isRealUserMessage(userLine('side conversation', 0, undefined, { isSidechain: true })), false);
  assert.equal(uh.isRealUserMessage(
    { type: 'user', timestamp: '2026-09-20T08:00:00Z', message: { content: [{ type: 'tool_result', content: 'x' }] } }),
    false, 'array content (a tool result) is not a typed message');
  assert.equal(uh.isRealUserMessage(assistantLine(0)), false);
  assert.equal(uh.isRealUserMessage(null), false);
});

test('realMessages: synthetic lines in the capture do not count', () => {
  const root = tempRoot();
  try {
    capture(root, [
      userLine('please check the status once', 0),
      assistantLine(1),
      userLine('<task-notification>\n<task-id>x</task-id> done', 2),
      userLine('a background session sent a message', 3, undefined, { isMeta: true }),
    ]);
    const { messages, capturesReadable } = uh.realMessages(root);
    assert.equal(capturesReadable, 1);
    assert.equal(messages.length, 1, 'only the one real user line should count');
    assert.equal(messages[0].text, 'please check the status once');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Three states, never two --------------------------------------------

test('EMPTY SOURCE: no readable capture -> every observation is unknown, never 0', () => {
  const root = tempRoot();
  try {
    const r = uh.analyze(root);
    assert.equal(r.capturesReadable, 0);
    assert.ok(r.observations.length >= 6);
    for (const o of r.observations) assert.equal(o.state, uh.STATE.UNKNOWN);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem user reports "unknown" (not an empty list) when no capture is readable', () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ participants: { user: 'the human' } }));
    const r = cli(root, ['user']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^unknown/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('0 hits among readable captures is too_little_evidence, NOT unknown', () => {
  const root = tempRoot();
  try {
    capture(root, turns(6, (i) => `a neutral sentence number ${i} with no pattern in it`));
    const r = uh.analyze(root, { minEvidence: 5 });
    const delegated = r.observations.find((o) => o.id === 'delegated_decision');
    assert.equal(delegated.count, 0);
    assert.equal(delegated.state, uh.STATE.TOO_LITTLE_EVIDENCE);
    assert.notEqual(delegated.state, uh.STATE.UNKNOWN);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('minEvidence decides measured vs. too_little_evidence over the SAME data', () => {
  const root = tempRoot();
  try {
    capture(root, turns(4, (i) => `your call, point ${i}`));
    const loose = uh.analyze(root, { minEvidence: 3 });
    const strict = uh.analyze(root, { minEvidence: 10 });
    const a = loose.observations.find((o) => o.id === 'delegated_decision');
    const b = strict.observations.find((o) => o.id === 'delegated_decision');
    assert.equal(a.count, 4);
    assert.equal(a.state, uh.STATE.MEASURED);
    assert.equal(b.count, 4);
    assert.equal(b.state, uh.STATE.TOO_LITTLE_EVIDENCE);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- No line without a location ----------------------------------------

test('every "measured" observation carries a located first AND last quote', () => {
  const root = tempRoot();
  try {
    capture(root, turns(6, (i) => `your call, point ${i}`));
    const r = uh.analyze(root, { minEvidence: 5 });
    const o = r.observations.find((x) => x.id === 'delegated_decision');
    assert.equal(o.state, uh.STATE.MEASURED);
    for (const f of [o.first, o.last]) {
      assert.ok(f, 'location is missing');
      assert.ok(f.path && f.path.length > 0);
      assert.ok(Number.isInteger(f.line) && f.line > 0);
      assert.ok(typeof f.quote === 'string' && f.quote.length > 0);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an observation with zero hits has first=null AND last=null — nothing invented', () => {
  const root = tempRoot();
  try {
    capture(root, turns(6, (i) => `a neutral sentence ${i}`));
    const r = uh.analyze(root);
    const o = r.observations.find((x) => x.id === 'correction');
    assert.equal(o.first, null);
    assert.equal(o.last, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the located line number is the true PHYSICAL line inside the capture', () => {
  const root = tempRoot();
  try {
    // Header is physical line 1, then user/assistant alternate.
    capture(root, [
      userLine('neutral one', 0),
      assistantLine(1),
      userLine('your call, just go ahead', 2),
      assistantLine(3),
    ]);
    const r = uh.analyze(root, { minEvidence: 1 });
    const o = r.observations.find((x) => x.id === 'delegated_decision');
    assert.equal(o.count, 1);
    assert.equal(o.first.line, 4); // header(1) + neutral(2) + assistant(3) + hit(4)
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Privacy: no quote over 120 characters, and secrets never survive --

test('quotes are capped at 120 characters, however long the message is', () => {
  const root = tempRoot();
  try {
    const long = `your call ${'x'.repeat(400)}`;
    capture(root, turns(5, () => long));
    const r = uh.analyze(root, { minEvidence: 5 });
    const o = r.observations.find((x) => x.id === 'delegated_decision');
    assert.ok(o.first.quote.length <= uh.QUOTE_MAX, `quote is ${o.first.quote.length} characters`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('quotes run through redaction — a secret in the text never reaches the quote', () => {
  const root = tempRoot();
  try {
    const secret = 'sk-ant-api03-'.padEnd(48, 'A');
    capture(root, turns(5, () => `your call, here is the key: ${secret}`));
    const r = uh.analyze(root, { minEvidence: 5 });
    const o = r.observations.find((x) => x.id === 'delegated_decision');
    assert.ok(!o.first.quote.includes(secret), 'the secret is still in the quote');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Metrics: hour-of-day and message length ---------------------------

test('hourDistribution counts UTC hours, not local time', () => {
  const messages = [
    { ts: '2026-09-20T05:00:00Z', text: 'a' },
    { ts: '2026-09-20T05:30:00Z', text: 'b' },
    { ts: '2026-09-20T18:00:00Z', text: 'c' },
  ];
  const hours = uh.hourDistribution(messages);
  assert.equal(hours[5], 2);
  assert.equal(hours[18], 1);
  assert.equal(hours.reduce((a, b) => a + b, 0), 3);
});

test('mainHours takes half the peak as the threshold, empty on silence', () => {
  assert.deepEqual(uh.mainHours(new Array(24).fill(0)), []);
  const hours = new Array(24).fill(0);
  hours[5] = 10; hours[6] = 5; hours[7] = 4;
  assert.deepEqual(uh.mainHours(hours), [5, 6]); // 4 < 10/2
});

test('messageLengthMedian: null with no messages, else the median character length', () => {
  assert.equal(uh.messageLengthMedian([]), null);
  const messages = ['a', 'bb', 'ccc', 'dddd', 'eeeee'].map((t) => ({ text: t }));
  assert.equal(uh.messageLengthMedian(messages), 3);
});

test('the hour-of-day metric is measured but never marked actionable', () => {
  const root = tempRoot();
  try {
    capture(root, turns(6, (i) => `a neutral sentence ${i}`));
    const r = uh.analyze(root);
    const hourOfDay = r.observations.find((o) => o.id === 'hour_of_day');
    assert.equal(hourOfDay.actionable, false, 'a session cannot decide WHEN it is called');
    for (const o of r.observations) if (o.id !== 'hour_of_day') assert.equal(o.actionable, true, `${o.id} should be actionable`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- Stability across weeks ---------------------------------------------

test('stabilityPerWeek ignores weeks under the minimum message count', () => {
  const hit = new Set();
  const messages = [
    { ts: '2026-09-07T08:00:00Z', text: 'x' }, // 1 message this week -> does not qualify
    ...Array.from({ length: 6 }, (_, i) => ({ ts: `2026-09-14T0${i}:00:00Z`, text: 'x' })),
    ...Array.from({ length: 6 }, (_, i) => ({ ts: `2026-09-21T0${i}:00:00Z`, text: 'x' })),
  ];
  for (const m of messages.slice(1, 7)) hit.add(m);
  const { stability, weeksQualifying, weeksTotal } = uh.stabilityPerWeek(messages, hit);
  assert.equal(weeksTotal, 3);
  assert.equal(weeksQualifying, 2, 'the 1-message week must not count');
  assert.equal(stability, 0.5, '1 of 2 qualifying weeks hit');
});

test('stabilityPerWeek is null with no qualifying week at all', () => {
  const { stability, weeksQualifying } = uh.stabilityPerWeek(
    [{ ts: '2026-09-07T08:00:00Z', text: 'x' }], new Set());
  assert.equal(stability, null);
  assert.equal(weeksQualifying, 0);
});

// --- The time cap: a growing archive must never block a session start --

test('a tiny time cap breaks off the read and reports capped:true', () => {
  const root = tempRoot();
  try {
    capture(root, turns(5, (i) => `sentence ${i}`));
    const { capped, capturesReadable } = uh.realMessages(root, { timeCapMs: -1 });
    assert.equal(capped, true);
    assert.equal(capturesReadable, 0, 'an already-elapsed cap must not read even the first capture');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a generous time cap yields the complete, uncapped result', () => {
  const root = tempRoot();
  try {
    capture(root, turns(5, (i) => `sentence ${i}`));
    const { capped, capturesReadable } = uh.realMessages(root, { timeCapMs: 5000 });
    assert.equal(capped, false);
    assert.equal(capturesReadable, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- sessionStartLines(): at most 5 lines, only actionable + measured --

test('sessionStartLines: empty source -> no lines (silence, not a claim)', () => {
  const root = tempRoot();
  try {
    assert.deepEqual(uh.sessionStartLines(root).lines, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sessionStartLines: at most `max` lines, header included', () => {
  const root = tempRoot();
  try {
    capture(root, turns(12, (i) => {
      const parts = ['your call', 'that\'s not right', 'give me a checklist', 'por favor continua'];
      return `${parts[i % parts.length]}, point ${i}`;
    }));
    const r = uh.sessionStartLines(root, { max: 5, minEvidence: 1 });
    assert.ok(r.lines.length <= 5, `${r.lines.length} lines — the cap is 5`);
    if (r.lines.length) assert.match(r.lines[0], /^User habits/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sessionStartLines: hour-of-day never appears, even if nothing else qualifies', () => {
  const root = tempRoot();
  try {
    capture(root, turns(6, (i) => `a neutral sentence ${i}`));
    const r = uh.sessionStartLines(root, { minEvidence: 5 });
    assert.ok(!r.lines.some((l) => l.includes('hour-of-day')), 'hour-of-day must never appear here');
    assert.ok(r.lines.some((l) => l.includes('Message length')), 'message length IS measured and actionable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sessionStartLines: qualifies only state=measured AND actionable=true', () => {
  const root = tempRoot();
  try {
    capture(root, turns(20, (i) => `your call, point ${i}`));
    const full = uh.analyze(root, { minEvidence: 5 });
    const hourOfDay = full.observations.find((o) => o.id === 'hour_of_day');
    assert.equal(hourOfDay.state, uh.STATE.MEASURED, 'this is about actionable, not about evidence');
    const r = uh.sessionStartLines(root, { minEvidence: 5 });
    assert.ok(!r.lines.some((l) => l.includes('main window')), 'measured but not actionable — must stay out');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sessionStartLines carries `sources` (path:line) for every line it shows', () => {
  const root = tempRoot();
  try {
    capture(root, turns(6, (i) => `your call, point ${i}`));
    const r = uh.sessionStartLines(root, { minEvidence: 5 });
    assert.ok(r.sources.length > 0);
    for (const s of r.sources) assert.match(s, /^raw[/\\].+\.jsonl\.gz:\d+$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// --- The CLI: mem user ---------------------------------------------------

test('mem user --json returns an object with total/capturesReadable/observations', () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ participants: { user: 'the human' } }));
    capture(root, turns(6, (i) => `your call, point ${i}`));
    const r = cli(root, ['user', '--json', '--min-evidence', '5']);
    assert.equal(r.code, 0, r.err);
    const d = JSON.parse(r.out);
    assert.equal(d.total, 6);
    assert.ok(Array.isArray(d.observations));
    const del = d.observations.find((o) => o.id === 'delegated_decision');
    assert.equal(del.state, 'measured');
    const hourOfDay = d.observations.find((o) => o.id === 'hour_of_day');
    assert.equal(hourOfDay.actionable, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem user --session-start prints at most 5 lines, plain text', () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ participants: { user: 'the human' } }));
    capture(root, turns(12, (i) => `your call, point ${i}`));
    const r = cli(root, ['user', '--session-start', '--min-evidence', '5']);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.split('\n').filter(Boolean);
    assert.ok(lines.length <= 5, `${lines.length} lines`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem user --patterns rejects a broken custom file instead of quietly using the defaults', () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ participants: { user: 'the human' } }));
    const badFile = path.join(root, 'broken-patterns.json');
    fs.writeFileSync(badFile, '{ not json');
    const r = cli(root, ['user', '--patterns', badFile]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /not valid JSON/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A vocabulary that hangs on each reader separately drifts apart.
//
// **The finding (2026-09-16).** A message has four states. Every
// place that asked "is this one done?" answered it for itself:
//
//   doctor.mjs   `state !== 'done' && state !== 'answered'`
//                Neither string is a state of this module. The filter
//                matched EVERY message, so the delivery check counted
//                all four states as open. It had never excluded
//                anything since the day it was written.
//
//   inbox.mjs    a second, stricter copy of the agent-name rule
//                (`[a-z]+`) inside the filename parser, which quietly
//                rejected every agent whose name carries a hyphen or a
//                digit. Mail for `vm-admin` parsed as null, was filed
//                unreadable, and was never announced.
//
// Neither was mistyped. Both were correct for the vocabulary of the
// day they were written, and neither was revisited when the
// vocabulary grew. That is why the important test here is not "the
// readers agree now" but the bolt against a fourth copy appearing.
// Covers assurances from shared/invariants.jsonl. The id is the
// shared language between the houses; the prose there names the
// incident that forced it.
// invariant: abschluss-vokabular-eine-stelle
// invariant: namensregel-eine-stelle
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as inbox from '../src/inbox.mjs';
import * as agents from '../src/agents.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('isDone knows exactly the three closing states', () => {
  assert.equal(inbox.isDone('replied'), true);
  assert.equal(inbox.isDone('processed'), true);
  assert.equal(inbox.isDone('closed'), true);
  assert.equal(inbox.isDone('open'), false);
  // An enumeration, not `!== OPEN`: a fifth state does NOT silently
  // count as done. Otherwise a decision moves into a spelling that
  // nobody made.
  assert.equal(inbox.isDone('withdrawn'), false);
  assert.equal(inbox.isDone(undefined), false);
});

test('DONE covers STATE — without OPEN and without a gap', () => {
  const undecided = Object.values(inbox.STATE)
    .filter((s) => s !== inbox.STATE.OPEN && !inbox.DONE.includes(s));
  assert.deepEqual(undecided, [],
    'new states in STATE that are neither OPEN nor in DONE');
  assert.ok(!inbox.DONE.includes(inbox.STATE.OPEN), 'open is not done');
});

test('the filename parser uses the one agent-name rule', () => {
  // The second copy read `[a-z]+`. A name with a hyphen is legal and
  // was unreadable — a silent allowlist nobody had decided on.
  const who = { session: 'x', chatgpt: 'y', 'vm-admin': 'z', 'cheap-mem': 'w' };
  for (const from of ['session', 'vm-admin', 'cheap-mem']) {
    const n = `2026-09-16T10-00-00Z--${from}-to-chatgpt.md`;
    const parts = inbox.fromFileName(who, n);
    assert.ok(parts, `unreadable: ${n}`);
    assert.equal(parts.from, from);
  }
  assert.match(agents.NAME_PART, /a-z0-9/, 'the shared rule is gone');
});

// --- the bolt against the fourth copy ---------------------------------

function modules() {
  const d = path.join(REPO, 'src');
  return fs.readdirSync(d)
    .filter((n) => n.endsWith('.mjs') && n !== 'inbox.mjs')
    .map((n) => ({ rel: `src/${n}`, text: fs.readFileSync(path.join(d, n), 'utf8') }));
}

test('POSITIVE: the probe finds the modules at all', () => {
  // Without this, a renamed directory would make the bolt below pass
  // by finding nothing — the exact failure mode it exists to catch.
  const m = modules();
  assert.ok(m.length >= 20, `only ${m.length} modules found — wrong place?`);
  assert.ok(m.some((x) => x.rel === 'src/doctor.mjs'), 'doctor.mjs missing');
});

test('no module decides for itself which state means done', () => {
  // Comparing AGAINST a closing state is a private reading of the
  // vocabulary. Setting one is fine (`ack(name, 'processed')`),
  // interpreting one is not.
  const cmp = /(?:===|!==|==|!=)\s*'(replied|processed|closed)'|'(replied|processed|closed)'\s*(?:===|!==|==|!=)/;
  const guilty = [];
  for (const { rel, text } of modules()) {
    for (const [i, line] of text.split('\n').entries()) {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;  // comments may name them
      if (cmp.test(line)) guilty.push(`${rel}:${i + 1}  ${line.trim()}`);
    }
  }
  assert.deepEqual(guilty, [],
    'these lines interpret "done" for themselves instead of asking '
    + 'inbox.isDone — that is how the drifted copies came about');
});

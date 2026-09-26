// test/silent-until.test.mjs — announced silence: three states, not two.
//
// English rebuild of lucky-mem's `stumm_bis` (B9). cheap-mem had NO
// equivalent before this file — checked with
// `grep -rn stumm_bis src/ bin/ test/` against lucky-mem
// (/home/user/lm-post), then `grep -rn "silent"` against this repo: a
// `heartbeat.mjs` (presence, not announced absence) and a `checkDelivery`
// with no per-recipient staleness check at all. lucky-mem's three-way
// split — answers / is known to be silent / is unexpectedly silent — had
// no home here, so this rebuilds the primitive (`agents.silentStatus`,
// `agents.announcedSilence`, `agents.silenceNote`) with the SAME probe
// cases as lucky-mem's `test/stumm-bis.test.mjs` and the pure-function
// half of `test/stumm-bis-durchgezogen.test.mjs`.
//
// **What did not port.** lucky-mem's `stumm-bis-durchgezogen.test.mjs`
// also wires the feature into three separate mailbox findings
// (`post-liegt`, `briefkasten`, `zustellschuld`) that do not exist here —
// cheap-mem has exactly one delivery finding (`checkDelivery`), and it
// never flagged a registered-but-quiet agent as dead in the first place
// (its WARN branch fires only on an UNREGISTERED recipient). So there was
// no false alarm to fix; `silenceNote` is wired into `checkDelivery`'s
// GOOD text instead, for the same reason lucky-mem surfaces it in
// `post-liegt`'s text — so a quiet, explained agent is named, not just
// absent from the report. The doctor-integration test below is that
// counter-probe: the finding stays GOOD and CARRIES the note.
//
// **What did not port, and why not a gap.** lucky-mem's last case reads
// its own real `agents/chatgpt` off disk as a tripwire ("a field nobody
// sets is not done"). This repo has no `agents/` directory at all
// (checked: `ls agents/` — none), so there is no real agent to assert
// against; the tripwire has nothing to trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agents from '../src/agents.mjs';
import * as doctor from '../src/doctor.mjs';
import * as inbox from '../src/inbox.mjs';
import * as cfgmod from '../src/config.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-silent-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: { user: 'the human', session: 'a session' }, language: 'en' }));
  return r;
}
const rm = (r) => fs.rmSync(r, { recursive: true, force: true });

/** An agent, written straight to AGENT.yaml, with or without a silence announcement. */
function agentWith(r, name, fields = {}) {
  const d = path.join(r, 'agents', name);
  fs.mkdirSync(d, { recursive: true });
  const lines = [`name: ${name}`, ...Object.entries(fields).map(([k, v]) => `${k}: "${v}"`)];
  fs.writeFileSync(path.join(d, 'AGENT.yaml'), `${lines.join('\n')}\n`);
}

// --- silentStatus: the pure function -----------------------------------

const WITH = { silent_until: '2026-09-22', silent_why: 'quota exhausted' };

test('during the window: silent, with a reason and a date', () => {
  const s = agents.silentStatus(WITH, new Date('2026-09-19T12:00:00Z'));
  assert.equal(s.silent, true);
  assert.equal(s.expired, false);
  assert.equal(s.until, '2026-09-22');
  assert.equal(s.why, 'quota exhausted');
});

test('still silent on the last announced day — the window ends at night, not at dawn', () => {
  const s = agents.silentStatus(WITH, new Date('2026-09-22T18:00:00Z'));
  assert.equal(s.silent, true, 'the announced day itself still counts');
});

test('past the window: NOT silent any more, and the expiry stays visible', () => {
  // The point of the design: time re-arms the warning by itself. A
  // switch with no deadline never would.
  const s = agents.silentStatus(WITH, new Date('2026-09-25T00:00:00Z'));
  assert.equal(s.silent, false);
  assert.equal(s.expired, true);
  assert.equal(s.until, '2026-09-22', 'the date stays so the finding can name it');
});

test('no field: the ordinary case, not a special state', () => {
  for (const a of [{}, null, undefined, { silent_until: '' }, { silent_until: '   ' }]) {
    const s = agents.silentStatus(a, new Date('2026-09-19T12:00:00Z'));
    assert.equal(s.silent, false);
    assert.equal(s.expired, false);
  }
});

test('a typo in the date does NOT switch silence on', () => {
  // Otherwise a typo would be an unbounded switch — exactly what this
  // design avoids.
  const s = agents.silentStatus({ silent_until: 'soon' }, new Date('2026-09-19T12:00:00Z'));
  assert.equal(s.silent, false, 'an unreadable date must not announce silence');
  assert.equal(s.invalid, true, 'and it must be recognisable as invalid');
});

// --- announcedSilence: across every registered agent --------------------

test('announcedSilence separates a running announcement, an expired one, and neither', () => {
  const r = root();
  try {
    agentWith(r, 'quiet', { silent_until: '2099-01-01', silent_why: 'quota' });
    agentWith(r, 'lapsed', { silent_until: '2020-01-01' });
    agentWith(r, 'ordinary', {});
    const s = agents.announcedSilence(r);
    assert.deepEqual([...s.silent.keys()], ['quiet']);
    assert.deepEqual([...s.expired.keys()], ['lapsed']);
    assert.equal(s.silent.get('quiet').why, 'quota');
  } finally { rm(r); }
});

test('an unreadable silent_until is NOT a silence, across the whole directory', () => {
  const r = root();
  try {
    agentWith(r, 'typo', { silent_until: 'soon' });
    const s = agents.announcedSilence(r);
    assert.equal(s.silent.size, 0, 'a typo switched on silence');
    assert.equal(s.expired.size, 0);
  } finally { rm(r); }
});

test('no agents/ directory means nobody is silent, not a crash', () => {
  const s = agents.announcedSilence('/does/not/exist');
  assert.equal(s.silent.size, 0);
  assert.equal(s.expired.size, 0);
});

// --- silenceNote ----------------------------------------------------------

test('silenceNote is empty when nobody is silent, and names who and why otherwise', () => {
  assert.equal(agents.silenceNote(new Map()), '');
  assert.equal(agents.silenceNote(null), '');
  const m = new Map([['quiet', { name: 'quiet', until: '2099-01-01', why: 'quota' }]]);
  assert.match(agents.silenceNote(m), /announced silent: quiet until 2099-01-01 \(quota\)/);
});

// --- COUNTER-PROBE: checkDelivery composes with it, and cannot be gamed --

test('checkDelivery names a currently silent agent in its GOOD text', () => {
  const r = root();
  try {
    agentWith(r, 'quiet', { silent_until: '2099-01-01', silent_why: 'quota' });
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'session', to: 'quiet', subject: 'x', text: 'y' });
    const f = doctor.checkDelivery(r);
    assert.equal(f.level, doctor.LEVEL.GOOD);
    assert.match(f.text, /announced silent: quiet until 2099-01-01 \(quota\)/, f.text);
  } finally { rm(r); }
});

test('POSITIVE CONTROL: without any announcement, checkDelivery names nobody', () => {
  // The half that matters. If this were also green with the note text,
  // the assertion above would prove nothing.
  const r = root();
  try {
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'session', to: 'session', subject: 'x', text: 'y' });
    const f = doctor.checkDelivery(r);
    assert.doesNotMatch(f.text, /announced silent/, f.text);
  } finally { rm(r); }
});

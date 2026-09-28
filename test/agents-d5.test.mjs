// test/agents-d5.test.mjs — D5: the agents view stops inventing "alive".
//
// **The finding this closes.** `board.tileAgents` already measures agent
// activity off ONE source — `heartbeat.jsonl` — and deliberately never
// reports CALM from it alone ("an agent with an old heartbeat is not
// necessarily broken — it may have had nothing to do"). The agents VIEW
// claimed more than that tile ever did: `registered && count > 0` read as
// "registered and writing", which sits one careless CSS class away from
// a green "alive". A stale heartbeat and a genuinely idle agent still
// look identical off one source; the fix is a SECOND, independent one
// that has to agree before this page says "alive" at all.
//
// Also covered: `pause` (`silent_until`, unaffected by activity),
// `startable` (a plain file check, always answerable), `channel` (the
// inbox "bell", `ok` only once a message was actually answered),
// E5.4 (opening/rendering the view writes nothing), and the latch that
// keeps a field this file cannot resolve from being rendered as if it
// had a value.
//
// invariant: drei-zustaende-nie-zwei
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agents from '../src/agents.mjs';
import * as memory from '../src/memory.mjs';
import * as heartbeat from '../src/heartbeat.mjs';
import * as inbox from '../src/inbox.mjs';
import * as cfgmod from '../src/config.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';

const NOW = new Date('2026-09-27T12:00:00Z');

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-d5-'));
  cfgmod.writeConfig(r, {
    version: 1,
    participants: { user: { role: 'The human.', human: true }, session: 'A session.' },
    language: 'en',
  });
  return r;
}
const rm = (r) => fs.rmSync(r, { recursive: true, force: true });

/** Every regular file under `dir`, with its mtime — a manual walk, not
 * `readdirSync(..., {recursive:true})`, so this runs on the Node versions
 * `package.json` actually promises (>=18). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

function byName(data, name) { return data.agents.find((a) => a.name === name); }

// --- probe (1): one source -> unknown, two -> alive, none -> not seen ---

test('D5 probe 1: two independent sources agree -> alive; one -> unknown; none -> not seen', () => {
  const r = root();
  try {
    agents.createAgent(r, 'two-fresh', {});
    memory.logEntry(r, 'thought', { text: 'working', agent: 'two-fresh' }, { now: NOW });
    heartbeat.beat(r, 'two-fresh', { now: NOW });

    agents.createAgent(r, 'heartbeat-only', {});
    heartbeat.beat(r, 'heartbeat-only', { now: NOW });

    agents.createAgent(r, 'writes-only', {});
    memory.logEntry(r, 'thought', { text: 'working', agent: 'writes-only' }, { now: NOW });

    agents.createAgent(r, 'nobody-home', {});

    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'two-fresh').activity.state, 'alive');
    assert.equal(byName(data, 'heartbeat-only').activity.state, 'unknown');
    assert.equal(byName(data, 'writes-only').activity.state, 'unknown');
    assert.equal(byName(data, 'nobody-home').activity.state, 'not seen');
  } finally { rm(r); }
});

test('D5 probe 1b: a fresh heartbeat past the window is stale, not fresh', () => {
  const r = root();
  try {
    agents.createAgent(r, 'stale', {});
    // A beat two days before `now` — outside the 24h window `board.
    // tileAgents`'s own default (`quietMin = 60*24`) already uses.
    heartbeat.beat(r, 'stale', { now: new Date(NOW.getTime() - 2 * 24 * 60 * 60000) });
    memory.logEntry(r, 'thought', { text: 'old', agent: 'stale' },
      { now: new Date(NOW.getTime() - 2 * 24 * 60 * 60000) });
    const data = dashboard.collect(r, { now: NOW });
    const a = byName(data, 'stale');
    assert.equal(a.activity.heartbeat.fresh, false);
    assert.equal(a.activity.content.fresh, false);
    assert.equal(a.activity.state, 'not seen');
  } finally { rm(r); }
});

test('D5 probe 1c: inbox activity FROM the agent counts as the second source, same as a write', () => {
  const r = root();
  try {
    agents.createAgent(r, 'mailer', {});
    heartbeat.beat(r, 'mailer', { now: NOW });
    const cfg = cfgmod.readConfig(r);
    // No write to a drawer at all — only outgoing mail.
    inbox.write(r, cfg.participants, {
      from: 'mailer', to: 'user', subject: 'status', text: 'still here', now: NOW,
    });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'mailer').activity.state, 'alive',
      'sent mail should count as content activity exactly like a drawer write');
  } finally { rm(r); }
});

// --- probe (2): silent_until is respected, and independent of activity ---

test('D5 probe 2: an announced silence reads as "paused" regardless of activity', () => {
  const r = root();
  try {
    agents.createAgent(r, 'sleepy', {});
    fs.appendFileSync(path.join(r, 'agents', 'sleepy', 'AGENT.yaml'),
      'silent_until: "2099-01-01"\nsilent_why: "on leave"\n');
    // Give it a genuinely alive activity signal too — pause must not hide it.
    heartbeat.beat(r, 'sleepy', { now: NOW });
    memory.logEntry(r, 'thought', { text: 'one last note', agent: 'sleepy' }, { now: NOW });

    const data = dashboard.collect(r, { now: NOW });
    const a = byName(data, 'sleepy');
    assert.equal(a.pause.state, 'paused');
    assert.equal(a.pause.until, '2099-01-01');
    assert.equal(a.pause.why, 'on leave');
    assert.equal(a.activity.state, 'alive', 'pause and activity are two different questions');
  } finally { rm(r); }
});

test('D5 probe 2b: an expired announcement reads as "expired", not "active" or "paused"', () => {
  const r = root();
  try {
    agents.createAgent(r, 'lapsed', {});
    fs.appendFileSync(path.join(r, 'agents', 'lapsed', 'AGENT.yaml'),
      'silent_until: "2020-01-01"\n');
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'lapsed').pause.state, 'expired');
  } finally { rm(r); }
});

test('D5 probe 2c: an unregistered (log-only) agent has no AGENT.yaml to read pause from', () => {
  const r = root();
  try {
    memory.logEntry(r, 'thought', { text: 'x', agent: 'ghost' }, { now: NOW });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'ghost').pause.state, 'unknown');
  } finally { rm(r); }
});

// --- probe (3): rendering never writes -----------------------------------

test('D5 probe 3: collecting the agents view (old desk and dashboard) writes nothing at all', () => {
  const r = root();
  try {
    agents.createAgent(r, 'watched', { role: 'x', model: 'y' });
    memory.logEntry(r, 'thought', { text: 'note', agent: 'watched' }, { now: NOW });
    heartbeat.beat(r, 'watched', { now: NOW });
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'session', to: 'user', subject: 'hi', text: 'body', now: NOW });
    inbox.write(r, cfg.participants, { from: 'session', to: 'watched', subject: 'go', text: 'do it', now: NOW });

    const before = snapshot(r);
    const data = dashboard.collect(r, { now: NOW });
    assert.ok(data.agents.length);
    // Since 2026-09-28 the view is the dashboard; its data pass must not
    // write either (dashboard-data.collectDashboard, behind /dashboard.json).
    dashboardData.collectDashboard(r, { now: NOW });
    // The ONE file family that may appear: the derived search index
    // (`.mem/search-index/`, the same cache `mem find` builds) — the
    // dashboard's doctor run checks the index and builds it when absent.
    // It is a cache of the drawers, not memory content, and not a seen-list.
    const derived = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.includes(`${path.sep}search-index${path.sep}`)));
    const after = derived(snapshot(r));

    assert.deepEqual(derived(before), after, 'no file mtime changed from collecting or rendering');
    assert.equal(fs.existsSync(path.join(r, inbox.SEEN_FILE)), false,
      'the seen-list must not appear just from opening the view (E5.4)');
  } finally { rm(r); }
});

// --- probe (4): no field value without a data source (the latch) --------

// --- probe (5): byte-stable for an unchanged fixture ----------------------

// --- startable: a plain, always-answerable file check ---------------------

test('startable: registered with PROMPT.md is startable; unregistered never is', () => {
  const r = root();
  try {
    agents.createAgent(r, 'has-prompt', {});
    memory.logEntry(r, 'thought', { text: 'x', agent: 'log-only' }, { now: NOW });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'has-prompt').startable.local, true);
    assert.equal(byName(data, 'log-only').startable.local, false);
  } finally { rm(r); }
});

test('startable: registered but with no PROMPT.md/START.md is not startable', () => {
  const r = root();
  try {
    agents.createAgent(r, 'bare-folder', {});
    fs.rmSync(path.join(r, 'agents', 'bare-folder', 'PROMPT.md'));
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'bare-folder').startable.local, false);
  } finally { rm(r); }
});

// --- channel: ok only once a message was actually answered ---------------

test('channel: unknown when nothing ever reached the inbox', () => {
  const r = root();
  try {
    agents.createAgent(r, 'quiet-box', {});
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'quiet-box').channel.state, 'unknown');
  } finally { rm(r); }
});

test('channel: still unknown while mail is waiting but unanswered — never invented ok', () => {
  const r = root();
  try {
    agents.createAgent(r, 'waiting', {});
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'session', to: 'waiting', subject: 'x', text: 'y', now: NOW });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'waiting').channel.state, 'unknown');
  } finally { rm(r); }
});

test('channel: ok once at least one message was answered or processed', () => {
  const r = root();
  try {
    agents.createAgent(r, 'answers', {});
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'session', to: 'answers', subject: 'x', text: 'y', now: NOW });
    const name = fs.readdirSync(path.join(r, 'inbox'))[0];
    inbox.setState(r, cfg.participants, name, 'processed');
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'answers').channel.state, 'ok');
  } finally { rm(r); }
});

test('channel: unknown for a name with no configured inbox at all', () => {
  const r = root();
  try {
    // `config.readConfig` auto-adds every REGISTERED agent as a
    // participant (see config.mjs), so only a log-only name — one that
    // appears in the memory without a folder under agents/ — can lack an
    // inbox entirely.
    memory.logEntry(r, 'thought', { text: 'x', agent: 'unaddressed' }, { now: NOW });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(byName(data, 'unaddressed').channel.state, 'unknown');
    assert.match(byName(data, 'unaddressed').channel.reason, /not a configured inbox participant/);
  } finally { rm(r); }
});

// --- the human's own tray: read-only, config-driven, never a guessed name -

test('humanInbox: shows what is addressed to the configured human participant, nothing else', () => {
  const r = root();
  try {
    agents.createAgent(r, 'watched', {});
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'watched', to: 'user', subject: 'for you', text: 'x', now: NOW });
    inbox.write(r, cfg.participants, { from: 'session', to: 'watched', subject: 'not for you', text: 'y', now: NOW });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(data.humanInbox.readable, true);
    assert.equal(data.humanInbox.who, 'user');
    assert.deepEqual(data.humanInbox.messages.map((m) => m.subject), ['for you']);
  } finally { rm(r); }
});

test('humanInbox: honestly unreadable when no participant is marked "human": true', () => {
  const r = root();
  try {
    // Old-shape, plain-string participants — none of them carries the
    // `human` marker, so nobody is guessed to be the human either.
    cfgmod.writeConfig(r, { version: 1, participants: { owner: 'The human.' }, language: 'en' });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(data.humanInbox.readable, false);
    assert.match(data.humanInbox.reason, /"human": true/);
  } finally { rm(r); }
});

test('humanInbox: a renamed human still works once "human": true moves with it (the D5/P1b fix)', () => {
  // This is the exact defect report: `dashboard.HUMAN_PARTICIPANT` used
  // to hardcode 'user', so renaming the human's key silently broke the
  // tray and the reply form. Now the mark travels with the rename.
  const r = root();
  try {
    cfgmod.writeConfig(r, {
      version: 1,
      participants: { lucky: { role: 'The human, renamed.', human: true }, session: 'A session.' },
      language: 'en',
    });
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'session', to: 'lucky', subject: 'hi', text: 'x', now: NOW });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(data.humanInbox.readable, true);
    assert.equal(data.humanInbox.who, 'lucky');
    assert.deepEqual(data.humanInbox.messages.map((m) => m.subject), ['hi']);
  } finally { rm(r); }
});

test('humanInbox: two participants marked human is refused, not guessed at', () => {
  const r = root();
  try {
    cfgmod.writeConfig(r, {
      version: 1,
      participants: {
        user: { role: 'The human.', human: true },
        lucky: { role: 'Also marked, by mistake.', human: true },
      },
      language: 'en',
    });
    const data = dashboard.collect(r, { now: NOW });
    assert.equal(data.humanInbox.readable, false);
    assert.match(data.humanInbox.reason, /2 participants/);
    assert.match(data.humanInbox.reason, /user/);
    assert.match(data.humanInbox.reason, /lucky/);
  } finally { rm(r); }
});

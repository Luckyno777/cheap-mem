// The board is the one thing in this repo that is allowed to say "all
// calm". So it is the one thing that must never say it without having
// looked.
//
// **What these probes are built around.** Not "does the tile render" —
// that passes whatever the tile contains. They are built around the
// three ways a status board lies:
//
//   1. It reports CALM for something it could not measure.
//   2. It reports a normal condition as a loss (or a loss as normal).
//   3. It renders text from the memory into HTML without escaping it.
//
// The first is the reason `STATE.UNKNOWN` exists at all. The second is
// the bug the sibling project shipped and had to fix twice on the same
// day: 672 captures still in the repository while the report said they
// were archived, then foreign captures reported as errors so the board
// was permanently red on every second machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as board from '../src/board.mjs';
import * as archive from '../src/archive.mjs';
import * as heartbeat from '../src/heartbeat.mjs';
import * as memory from '../src/memory.mjs';

const ESC = String.fromCharCode(27);

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-board-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  return r;
}

const NOW = new Date('2026-09-08T12:00:00Z');

test('a tile that could not be measured is UNKNOWN, never CALM', () => {
  // The sabotage: a memory with nothing in it. Every lane is silent.
  // A board that scores silence as calm is the exact construction this
  // project exists to catch, so the probe is: is anything green that
  // was never looked at?
  const r = root();
  const b = board.board(r, { now: NOW });

  const errors = b.tiles.find((t) => t.id === 'errors');
  assert.equal(errors.state, board.STATE.UNKNOWN,
    'no error log at all, and the board calls it calm');

  const agents = b.tiles.find((t) => t.id === 'agents');
  assert.equal(agents.state, board.STATE.UNKNOWN,
    'no heartbeat at all, and the board calls it calm');

  const bridge = b.tiles.find((t) => t.id === 'bridge');
  assert.equal(bridge.state, board.STATE.UNKNOWN,
    'nothing reported, and the board claims the bridge is current');

  assert.ok(b.unknown >= 3, 'the unmeasured count does not add them up');
});

test('UNKNOWN is not folded into the calm count', () => {
  const r = root();
  const b = board.board(r, { now: NOW });
  const calm = b.tiles.filter((t) => t.state === board.STATE.CALM).length;
  assert.equal(calm + b.watch + b.alarm + b.unknown, b.tiles.length);
  assert.ok(b.unknown > 0);
  // And the text says so rather than ending on "all calm".
  assert.match(board.asText(b), /unmeasured/);
});

test('a capture from another machine is not a loss', () => {
  // The second of the two bugs the sibling shipped. A record travels
  // with the repository; the location it names belongs to whichever
  // machine wrote it. Counting a foreign record as MISSING made the
  // board permanently red everywhere but the one machine.
  const r = root();
  archive.writeRecord(r, {
    path: 'raw/2026-09-01T00-00-00Z.jsonl',
    bytes: 1024,
    location: '/some/other/machine/archive',
  });
  const t = board.tileArchive(r, { env: {} });
  assert.equal(t.numbers.foreign, 1);
  assert.equal(t.numbers.missing, 0, 'a foreign capture counted as lost');
  assert.equal(t.state, board.STATE.CALM);
});

test('a capture missing from THIS archive is an alarm', () => {
  const r = root();
  const store = archive.readConfig({}, r);
  archive.writeRecord(r, {
    path: 'raw/2026-09-01T00-00-00Z.jsonl',
    bytes: 1024,
    location: store.location,
  });
  const t = board.tileArchive(r, { env: {} });
  assert.equal(t.numbers.missing, 1);
  assert.equal(t.state, board.STATE.ALARM,
    'a capture this machine promised to hold is gone, and the board is calm');
});

test('a capture still in the repository is a task, not a loss', () => {
  // With an archive SET elsewhere, a capture left in the repo is work
  // that has not happened yet. Without one set, `raw/` IS the archive
  // and there is nothing to do — which is why this probe sets one.
  const r = root();
  archive.setLocation(r, fs.mkdtempSync(path.join(os.tmpdir(), 'cm-boardstore-')));
  fs.mkdirSync(path.join(r, 'raw'), { recursive: true });
  fs.writeFileSync(path.join(r, 'raw', 'old.jsonl'), '{}\n');
  archive.writeRecord(r, { path: 'raw/old.jsonl', bytes: 3, location: path.join(r, 'raw') });
  const t = board.tileArchive(r, { env: {} });
  assert.equal(t.numbers.inRepo, 1);
  assert.equal(t.numbers.inArchive, 0);
  assert.equal(t.state, board.STATE.WATCH);
});

test('the agents tile reads a Map, not an object', () => {
  // `heartbeat.latest()` returns a Map. Read with `Object.keys` it
  // yields an empty list and the tile reports "no heartbeat recorded"
  // while the file holds data — an empty result that looks like
  // "nothing there" instead of "read wrongly". That defect shipped in
  // the sibling's board, in the module whose job is to show it.
  const r = root();
  heartbeat.beat(r, 'session', { now: NOW });
  const t = board.tileAgents(r, { now: NOW });
  assert.notEqual(t.state, board.STATE.UNKNOWN, 'a written heartbeat read as none');
  assert.match(t.line, /session/);
  assert.equal(t.numbers.rows.length, 1);
});

test('a heartbeat older than the quiet limit is WATCH, not ALARM', () => {
  const r = root();
  heartbeat.beat(r, 'session', { now: new Date('2026-09-01T12:00:00Z') });
  const t = board.tileAgents(r, { now: NOW });
  // Silence is not proof of breakage — the agent may have had nothing
  // to do. Alarm here would train people to ignore alarms.
  assert.equal(t.state, board.STATE.WATCH);
  assert.equal(t.numbers.quiet, 1);
});

test('the error tile counts a WINDOW and reports its own coverage', () => {
  const r = root();
  for (let i = 0; i < 6; i += 1) {
    memory.logEntry(r, 'error', { title: `x${i}`, class: 'looks-right-does-nothing' },
      { now: new Date('2026-09-07T09:00:00Z') });
  }
  memory.logEntry(r, 'error', { title: 'unmapped', class: 'a-name-nobody-defined' },
    { now: new Date('2026-09-07T09:00:00Z') });
  // Old enough to sit outside a 14-day window.
  memory.logEntry(r, 'error', { title: 'ancient', class: 'concurrency' },
    { now: new Date('2026-01-01T09:00:00Z') });

  const t = board.tileErrors(r, { now: NOW, windowDays: 14 });
  assert.equal(t.numbers.top[0], 'looks-right-does-nothing');
  assert.equal(t.numbers.top[1], 6, 'the window is not a window');
  assert.equal(t.numbers.total, 7, 'the old entry was counted into the window');
  // The open share is IN the line. Without it the ranking reads as
  // complete, and it is not.
  assert.match(t.line, /6\/7 countable/);
  assert.equal(t.state, board.STATE.WATCH);
});

test('the setup tile reuses setup.check rather than reimplementing it', () => {
  const r = root();
  // No .mem/config.json => the memory step is OPEN, so the tile watches.
  const t = board.tileSetup(r, { env: {}, home: r });
  assert.equal(t.state, board.STATE.WATCH);
  assert.match(t.line, /memory/);
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), '{ this is not json');
  const broken = board.tileSetup(r, { env: {}, home: r });
  assert.equal(broken.state, board.STATE.ALARM, 'an unreadable config is not an alarm');
});

test('the worst tile comes first', () => {
  const r = root();
  const store = archive.readConfig({}, r);
  archive.writeRecord(r, { path: 'raw/gone.jsonl', bytes: 1, location: store.location });
  const b = board.board(r, { now: NOW });
  assert.equal(b.tiles[0].state, board.STATE.ALARM);
  // And no tile is dropped for being quiet: a board that hides calm
  // tiles loses the information that something was checked.
  assert.equal(b.tiles.length, 7);
  const ids = b.tiles.map((t) => t.id).sort();
  assert.deepEqual(ids,
    ['agents', 'archive', 'bridge', 'digest', 'errors', 'questions', 'setup']);
});

test('the HTML escapes what came out of the memory', () => {
  // Every tile line is memory content. The bridge tile is the easiest
  // one to steer from outside — anything can write that file.
  const r = root();
  fs.appendFileSync(path.join(r, '.mem', 'bridge-reports.jsonl'), `${JSON.stringify({
    seen_at: '2026-09-08T11:00:00Z',
    version: '<script>alert(1)</script>',
  })}\n`);
  const html = board.asHtml(board.board(r, { now: NOW }));
  assert.ok(!html.includes('<script>alert(1)</script>'), 'unescaped into the page');
  assert.ok(html.includes('&lt;script&gt;'), 'not escaped, just missing');
});

test('the HTML carries no script and fetches nothing', () => {
  // It gets read on a phone through a tunnel. Anything that has to load
  // is one more thing that can fail there — and a board that stays
  // empty because a script did not load reports calm by omission.
  const r = root();
  const html = board.asHtml(board.board(r, { now: NOW }));
  assert.ok(!/<script/i.test(html), 'the page runs code');
  assert.ok(!/https?:\/\//i.test(html), 'the page loads something from outside');
  assert.ok(html.includes('<!doctype html>'));
});

test('state is legible without colour', () => {
  // Colour alone is not a statement for every reader. Each tile also
  // carries a mark and a word.
  const r = root();
  const html = board.asHtml(board.board(r, { now: NOW }));
  assert.match(html, /unmeasured/);
  const text = board.asText(board.board(r, { now: NOW }));
  assert.ok(!text.includes(ESC), 'ANSI escapes in text meant for a phone');
});

test('since() distinguishes never from long ago', () => {
  assert.equal(board.since(null), 'never');
  assert.equal(board.since(0), 'just now');
  assert.equal(board.since(30), '30 min ago');
  assert.equal(board.since(120), '2 h ago');
  assert.equal(board.since(60 * 72), '3 days ago');
});

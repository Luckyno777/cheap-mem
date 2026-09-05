import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as browse from '../src/browse.mjs';

const K = browse.KEYS;
const st = (over = {}) => ({ ...browse.initialState(), ...over });
const hits = (n) => Array.from({ length: n }, (_, i) => ({
  type: 'decision', source: 'global/decisions.jsonl', line: i + 1, score: 1,
  entry: { id: `id${i}`, ts: '2026-09-05T00:00:00Z', title: `entry ${i}` },
}));

test('an arrow key never lands in the query as literal text', () => {
  // Raw mode delivers "\x1b[A" as three bytes. Handled naively, holding
  // the arrow key types `[A[A[A` into the search box — the single most
  // visible way a hand-rolled TUI betrays itself.
  let s = st();
  for (const key of browse.splitKeys(`${K.UP}${K.DOWN}${K.UP}`)) s = browse.reduce(s, key);
  assert.equal(s.query, '', 'an escape sequence leaked into the query');
});

test('a pasted chunk is split into keys, escape sequences kept whole', () => {
  assert.deepEqual(browse.splitKeys('ab'), ['a', 'b']);
  assert.deepEqual(browse.splitKeys(`a${K.UP}b`), ['a', K.UP, 'b']);
  assert.deepEqual(browse.splitKeys(`${K.PGDN}${K.ENTER}`), [K.PGDN, K.ENTER]);
});

test('the selection cannot leave the list', () => {
  // An index past the end renders an undefined hit; below zero renders
  // the last one. Both are one keypress away without clamping.
  let s = st({ hits: hits(3), selected: 0 });
  for (let i = 0; i < 10; i += 1) s = browse.reduce(s, K.DOWN);
  assert.equal(s.selected, 2);
  for (let i = 0; i < 10; i += 1) s = browse.reduce(s, K.UP);
  assert.equal(s.selected, 0);
  s = browse.reduce(st({ hits: [], selected: 0 }), K.DOWN);
  assert.equal(s.selected, 0, 'an empty list must stay at 0');
});

test('enter on an empty result set does not open an empty detail pane', () => {
  const s = browse.reduce(st({ hits: [] }), K.ENTER);
  assert.equal(s.mode, 'list');
});

test('backspace on an empty query is a no-op, not a quit and not dirty', () => {
  // It is the most common accidental key in an empty box; quitting on it
  // would be maddening, and re-searching for "" wastes a pass.
  const s = browse.reduce(st({ query: '' }), K.BACKSPACE);
  assert.equal(s.quit, false);
  assert.equal(s.dirty, false);
  assert.equal(s.query, '');
});

test('typing marks the state dirty; moving the cursor does not', () => {
  // `dirty` is what makes the caller re-search. Setting it on navigation
  // would run a search per arrow key for an unchanged query.
  assert.equal(browse.reduce(st(), 'a').dirty, true);
  assert.equal(browse.reduce(st({ hits: hits(3) }), K.DOWN).dirty, false);
  assert.equal(browse.reduce(st({ query: 'ab' }), K.BACKSPACE).dirty, true);
  assert.equal(browse.reduce(st(), K.TAB).dirty, true);
});

test('ctrl-c quits from anywhere, esc only from the list', () => {
  for (const mode of ['list', 'detail']) {
    assert.equal(browse.reduce(st({ mode }), K.CTRL_C).quit, true);
  }
  assert.equal(browse.reduce(st({ mode: 'detail', hits: hits(1) }), K.ESC).mode, 'list');
  assert.equal(browse.reduce(st({ mode: 'detail' }), K.ESC).quit, false,
    'esc in the detail pane must go back, never quit');
  assert.equal(browse.reduce(st({ mode: 'list' }), K.ESC).quit, true);
});

test('tab cycles the type filter and comes back to everything', () => {
  let s = st();
  const seen = [s.typeFilter];
  for (let i = 0; i < browse.TYPE_FILTERS.length; i += 1) {
    s = browse.reduce(s, K.TAB);
    seen.push(s.typeFilter);
  }
  assert.equal(seen[seen.length - 1], null, 'the cycle must return to "everything"');
  assert.equal(new Set(seen).size, browse.TYPE_FILTERS.length);
});

test('render fills exactly the terminal it was given', () => {
  // One line too many scrolls the alternate screen and the layout tears.
  for (const rows of [6, 12, 40]) {
    for (const cols of [40, 80, 200]) {
      const lines = browse.render(st({ hits: hits(50), query: 'x', total: 50 }), { rows, cols });
      assert.equal(lines.length, rows, `${rows}x${cols} produced ${lines.length} lines`);
      for (const l of lines) {
        const visible = l.replace(/\x1b\[[0-9;]*m/g, '');
        assert.ok(visible.length <= cols, `a line overflowed ${cols} columns: ${visible.length}`);
      }
    }
  }
});

test('the selected row stays on screen however long the list is', () => {
  // Without the scroll window, selecting item 40 of 50 in a 12-row
  // terminal shows rows 0..6 and no cursor anywhere.
  const rows = 12;
  for (const selected of [0, 7, 25, 49]) {
    const lines = browse.render(st({ hits: hits(50), selected, query: 'x', total: 50 }), { rows, cols: 80 });
    assert.ok(lines.some((l) => l.includes('\x1b[7m')),
      `no selected row is visible at selection ${selected}`);
  }
});

test('fit never emits a half-cut escape sequence', () => {
  const out = browse.fit(`\x1b[31mred text that is quite long\x1b[0m`, 10);
  assert.ok(!out.includes('\x1b'), 'an escape survived truncation and will corrupt the screen');
  assert.ok(out.length <= 10);
});

test('a long field is wrapped, not cut off', () => {
  const hit = { type: 'decision', source: 'a.jsonl', line: 1,
    entry: { id: 'x', ts: '2026-01-01T00:00:00Z', why: 'word '.repeat(60).trim() } };
  const lines = browse.detailLines(hit, 60);
  assert.ok(lines.length > 4, 'the long field was not wrapped');
  for (const l of lines) assert.ok(l.length <= 80);
  assert.ok(lines.join(' ').split('word').length > 50, 'wrapping dropped content');
});

test('browse refuses a pipe with the command that does work there', () => {
  // The failure a user actually hits: `mem browse | less`. Raw mode on a
  // pipe throws something opaque; this must name `mem find` instead.
  const input = Object.assign(new EventEmitter(), { isTTY: false });
  return browse.run({ N: 0, documents: [] }, { input, output: { write() {} } })
    .then(() => assert.fail('should have refused'),
      (e) => {
        assert.match(e.message, /not a TTY/);
        assert.match(e.message, /mem find/);
      });
});

test('run() leaves no listeners behind, so the terminal is restored once', () => {
  // The `exit` listener is the dangerous one: left attached, a later
  // run() restores a terminal it no longer owns, and a long-lived
  // process leaks one per call until Node warns about MaxListeners.
  const before = {
    exit: process.listenerCount('exit'),
    int: process.listenerCount('SIGINT'),
    term: process.listenerCount('SIGTERM'),
  };
  const input = Object.assign(new EventEmitter(), {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, setEncoding() {},
  });
  const output = Object.assign(new EventEmitter(), {
    rows: 10, columns: 40, write() {},
  });
  const done = browse.run({ N: 0, documents: [] }, { input, output });
  input.emit('data', browse.KEYS.CTRL_C);
  return done.then(() => {
    assert.equal(process.listenerCount('exit'), before.exit, 'an exit listener leaked');
    assert.equal(process.listenerCount('SIGINT'), before.int);
    assert.equal(process.listenerCount('SIGTERM'), before.term);
    assert.equal(output.listenerCount('resize'), 0, 'a resize listener leaked');
  });
});

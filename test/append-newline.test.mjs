// Guard for `src/append.mjs` — the missing newline at end of file.
//
// **The finding, measured 2026-09-20.** A drawer holding exactly ONE
// valid entry and no trailing `\n`, one `node bin/mem log error` over
// it, then `readLog()`:
//
//     valid: 0   broken: 1   total: 1
//
// Two entries in, zero out. The old one was readable before — a write
// destroyed existing corpus. That is the `loss-or-overwrite` class.
//
// **Why the SABOTAGE is the test that matters.** Every positive control
// below also passes when the check never fires: a file that already
// ends on `\n` looks identical with and without healing. The probe that
// measures something is the one with the check TURNED OFF
// (`appendLine(..., { checkNewline: false })`): there the loss MUST come
// back. If it stops coming back, this file measures nothing, and that
// is the result.
//
//     node --test test/append-newline.test.mjs
//
// invariant: leer-ist-kein-bestehen
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { appendLine, endsWithoutNewline } from '../src/append.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM_CLI = path.join(HERE, '..', 'bin', 'mem');

// Cleaned up in ONE place: a run that leaves temp directories behind is
// how an unrelated suite goes red later (see test/console.test.mjs and
// the full-disk incident it references).
const made = [];
after(() => {
  for (const r of made) {
    fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-append-nl-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  // `participants` is not decoration: bin/mem refuses to run without it
  // ("Config error: ... has no 'participants' map"), so a config without
  // it would make the CLI probe below fail for a reason that has nothing
  // to do with newlines.
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    version: 1,
    participants: { user: 'The human.', session: 'An AI coding session.', librarian: 'The curator.' },
    language: 'en',
  }));
  fs.mkdirSync(path.join(r, 'global'), { recursive: true });
  made.push(r);
  return r;
}

/** A drawer WITHOUT a trailing newline. */
function drawerWithoutNewline(r, type = 'errors', title = 'OLD LINE') {
  const p = path.join(r, 'global', `${type}.jsonl`);
  fs.writeFileSync(p, JSON.stringify({
    id: 'aaaaaaaaaaaa', ts: '2026-09-19T10:00:00Z', v: 1, title, agent: 'human:probe',
  }), 'utf8');
  return p;
}

function counts(r, type = 'error') {
  const { entries } = memory.readLog(r, type);
  return {
    valid: entries.filter((e) => !e.__broken).length,
    broken: entries.filter((e) => e.__broken).length,
    total: entries.length,
  };
}

// ---------------------------------------------------------------
// Edge cases of the check itself
// ---------------------------------------------------------------

test('file does not exist: no leading newline', () => {
  const r = root();
  const p = path.join(r, 'global', 'errors.jsonl');
  assert.equal(endsWithoutNewline(p), false, 'a missing file does not "end without a newline"');
  const { healed } = appendLine(p, '{"id":"one"}\n');
  assert.equal(healed, false);
  assert.equal(fs.readFileSync(p, 'utf8'), '{"id":"one"}\n');
});

test('file is empty (0 bytes): no leading newline', () => {
  const r = root();
  const p = path.join(r, 'global', 'errors.jsonl');
  fs.writeFileSync(p, '', 'utf8');
  assert.equal(endsWithoutNewline(p), false);
  appendLine(p, '{"id":"one"}\n');
  assert.equal(fs.readFileSync(p, 'utf8'), '{"id":"one"}\n',
    'an empty file would otherwise have gained an empty first line');
});

test('file already ends on \\n: unchanged, no doubled newline', () => {
  const r = root();
  const p = path.join(r, 'global', 'errors.jsonl');
  fs.writeFileSync(p, '{"id":"one"}\n', 'utf8');
  assert.equal(endsWithoutNewline(p), false);
  const { healed } = appendLine(p, '{"id":"two"}\n');
  assert.equal(healed, false);
  assert.equal(fs.readFileSync(p, 'utf8'), '{"id":"one"}\n{"id":"two"}\n');
  assert.equal(fs.readFileSync(p, 'utf8').includes('\n\n'), false,
    'a doubled newline would be an empty line in the middle of the corpus');
});

test('file ends WITHOUT \\n: exactly ONE newline is inserted', () => {
  const r = root();
  const p = path.join(r, 'global', 'errors.jsonl');
  fs.writeFileSync(p, '{"id":"one"}', 'utf8');
  assert.equal(endsWithoutNewline(p), true);
  const { healed } = appendLine(p, '{"id":"two"}\n');
  assert.equal(healed, true);
  assert.equal(fs.readFileSync(p, 'utf8'), '{"id":"one"}\n{"id":"two"}\n');
});

test('multi-byte UTF-8 at end of file is not mistaken for a newline', () => {
  // Reading the last BYTE is correct here BECAUSE 0x0A is never part of
  // a multi-byte UTF-8 sequence. This holds that down: when the file
  // ends on an emoji (4 bytes) or an umlaut (2 bytes), the check must
  // say "without newline" — and the old text must survive character for
  // character.
  for (const tail of ['feet 🍀', 'Grüße', '日本語']) {
    const r = root();
    const p = path.join(r, 'global', 'errors.jsonl');
    fs.writeFileSync(p, JSON.stringify({ id: 'aaaaaaaaaaaa', title: tail }), 'utf8');
    assert.equal(endsWithoutNewline(p), true, `"${tail}" does not end on a newline`);
    appendLine(p, `${JSON.stringify({ id: 'bbbbbbbbbbbb', title: 'new' })}\n`);
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).title, tail, 'the multi-byte text was damaged');
    assert.equal(JSON.parse(lines[1]).title, 'new');
  }
});

// ---------------------------------------------------------------
// The real write path
// ---------------------------------------------------------------

test('logEntry() onto a drawer without a newline: both entries stay readable', () => {
  const r = root();
  drawerWithoutNewline(r);
  assert.deepEqual(counts(r), { valid: 1, broken: 0, total: 1 },
    'precondition: the one line IS readable before the append — that is what makes '
    + 'the finding expensive, the write destroys existing corpus');
  memory.logEntry(r, 'error', { class: 'probe', title: 'NEW LINE', text: 'new' });
  assert.deepEqual(counts(r), { valid: 2, broken: 0, total: 2 });
  // iterLog is a second reader over the same bytes and must agree.
  const iterated = [...memory.iterLog(r, 'error')];
  assert.equal(iterated.filter((e) => e.__broken).length, 0);
  assert.equal(iterated.length, 2);
});

test('the normal CLI (bin/mem log) takes the same path', () => {
  // Not just the module function: the bug happens on the real write
  // path, and that runs through bin/mem in its own process.
  const r = root();
  drawerWithoutNewline(r);
  execFileSync(process.execPath, [MEM_CLI, 'log', 'error',
    '--class', 'probe', '--title', 'NEW LINE', '--text', 'new'], {
    env: { ...process.env, CHEAP_MEM_ROOT: r },
    encoding: 'utf8',
  });
  assert.deepEqual(counts(r), { valid: 2, broken: 0, total: 2 });
  const raw = fs.readFileSync(path.join(r, 'global', 'errors.jsonl'), 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.includes('}{'), false, 'two lines fused into one');
});

// ---------------------------------------------------------------
// Sabotage — the probe that measures something
// ---------------------------------------------------------------

test('SABOTAGE: without the check the loss comes back', () => {
  const r = root();
  const p = drawerWithoutNewline(r);
  appendLine(p, `${JSON.stringify({ id: 'bbbbbbbbbbbb', title: 'NEW LINE' })}\n`,
    { checkNewline: false });
  assert.deepEqual(counts(r), { valid: 0, broken: 1, total: 1 },
    'without the check BOTH entries must become unreadable — if that stops happening, '
    + 'this file measures nothing and the promise in src/append.mjs stands uncovered');
  // And the reader does not swallow it silently, it reports it:
  const { entries } = memory.readLog(r, 'error');
  assert.equal(entries[0].__broken, true);
  assert.equal(entries[0].raw.includes('}{'), true, 'the two lines fused');
});

test('SABOTAGE counter-probe: the same call WITH the check loses nothing', () => {
  // Without this line the sabotage above would also pass if appendLine
  // wrote broken output in every case.
  const r = root();
  const p = drawerWithoutNewline(r);
  appendLine(p, `${JSON.stringify({ id: 'bbbbbbbbbbbb', title: 'NEW LINE' })}\n`);
  assert.deepEqual(counts(r), { valid: 2, broken: 0, total: 2 });
});

test('the check does NOT read the whole file', () => {
  // A solution that reads the whole drawer on every write would be the
  // quadratic mistake this house has already fixed three times. Measured
  // over fs.readFileSync/fs.readSync: at most ONE byte may be read.
  const r = root();
  const p = path.join(r, 'global', 'errors.jsonl');
  const big = Array.from({ length: 5000 },
    (_, i) => JSON.stringify({ id: `x${i}`, f: 'y'.repeat(200) })).join('\n');
  fs.writeFileSync(p, big, 'utf8'); // deliberately without a trailing \n
  const realReadFileSync = fs.readFileSync;
  const realReadSync = fs.readSync;
  let bytes = 0;
  let wholeFile = 0;
  fs.readFileSync = (...a) => { wholeFile += 1; return realReadFileSync(...a); };
  fs.readSync = (fd, buf, off, len, pos) => { bytes += len; return realReadSync(fd, buf, off, len, pos); };
  try {
    appendLine(p, '{"id":"new"}\n');
  } finally {
    fs.readFileSync = realReadFileSync;
    fs.readSync = realReadSync;
  }
  assert.equal(wholeFile, 0, 'readFileSync on the write path is exactly the quadratic mistake');
  assert.equal(bytes, 1, `${bytes} bytes were read, exactly 1 is allowed`);
  assert.equal(realReadFileSync(p, 'utf8').includes('}\n{"id":"new"}'), true,
    'and it still healed');
});

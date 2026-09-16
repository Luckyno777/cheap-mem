import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  STATE, TOLERANCE_BYTES, bookSizes, check, ratchet, run,
  readBaseline, setBaseline, save, asText,
} from '../src/shrink.mjs';

function mem(books = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-'));
  for (const [rel, body] of Object.entries(books)) {
    const t = path.join(d, rel);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, body);
  }
  return d;
}

test('a shrunken book raises an alarm', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    assert.equal(run(d).state, STATE.FIRST_RUN);
    fs.writeFileSync(path.join(d, 'global/errors.jsonl'), 'x'.repeat(400));
    const f = run(d);
    assert.equal(f.state, STATE.ALARM);
    assert.equal(f.shrunk[0].missing, 100);
    assert.match(asText(f), /ALARM/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a vanished book is a shrink to zero, not a skip', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    run(d);
    fs.rmSync(path.join(d, 'global/errors.jsonl'));
    const f = run(d);
    assert.equal(f.state, STATE.ALARM);
    assert.equal(f.vanished.length, 1);
    assert.match(asText(f), /gone \(was 500 bytes\)/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('growth and standing still are calm', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(100) });
  try {
    run(d);
    assert.equal(run(d).state, STATE.CALM, 'standing still fired');
    fs.appendFileSync(path.join(d, 'global/errors.jsonl'), 'y'.repeat(50));
    const f = run(d);
    assert.equal(f.state, STATE.CALM);
    assert.equal(f.grown, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('there is no tolerance — one byte is enough', () => {
  assert.equal(TOLERANCE_BYTES, 0);
  assert.equal(check({ now: { a: 999 }, baseline: { books: { a: 1000 } } }).state, STATE.ALARM);
});

test('the baseline only ratchets UPWARDS', () => {
  const b = ratchet({ books: { a: 1000, b: 5 } }, { a: 400, b: 50 });
  assert.equal(b.books.a, 1000, 'the baseline shrank along');
  assert.equal(b.books.b, 50);
});

test('an alarm persists and is not written away', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    run(d);
    fs.writeFileSync(path.join(d, 'global/errors.jsonl'), 'x'.repeat(100));
    assert.equal(run(d).state, STATE.ALARM);
    assert.equal(run(d).state, STATE.ALARM, 'the second run calmed down');
    assert.equal(run(d).state, STATE.ALARM, 'the third run calmed down');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a declared shrink lowers the baseline — and only that', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(500) });
  try {
    run(d);
    fs.writeFileSync(path.join(d, 'global/errors.jsonl'), 'x'.repeat(100));
    assert.equal(run(d).state, STATE.ALARM);
    setBaseline(d, bookSizes(d), { why: 'digest 2026-09' });
    assert.equal(run(d).state, STATE.CALM, 'the declaration had no effect');
    assert.match(readBaseline(d).why, /digest/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the reason for a declared lowering survives the next ratchet', () => {
  // On the first test run it was lost here — and then a declared
  // digest cannot be told from silent damage afterwards.
  const b = ratchet({ books: { a: 1 }, why: 'digest 2026-09' }, { a: 2 });
  assert.equal(b.why, 'digest 2026-09');
});

test('raw/ and .pipeline/ do not count', () => {
  const d = mem({
    'global/errors.jsonl': 'x'.repeat(10),
    'raw/big.jsonl': 'y'.repeat(9000),
    '.pipeline/tmp.jsonl': 'z'.repeat(9000),
  });
  try {
    assert.deepEqual(Object.keys(bookSizes(d)), ['global/errors.jsonl']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the baseline survives save and read unchanged', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(7) });
  try {
    const state = ratchet(null, bookSizes(d));
    assert.equal(save(d, state), true);
    assert.deepEqual(readBaseline(d).books, state.books);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a baseline without a books field counts as absent', () => {
  const d = mem({ 'global/errors.jsonl': 'x' });
  try {
    fs.mkdirSync(path.join(d, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(d, '.pipeline', 'shrink-baseline.json'), '{"version":1}');
    assert.equal(readBaseline(d), null, 'half a baseline was accepted');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// --------------------------------------------------------------------
// The guard on `--new-baseline`, which had none.
//
// Until 2026-09-16 the refusal path called `fail(...)`. There is no
// `fail` in bin/mem — the house function is `die`, used 38 times. So the
// guard threw a ReferenceError and the user read
// `mem shrink: fail is not defined` instead of what was missing.
//
// The effect was right by accident (the throw happens before the write,
// so no baseline was lowered), which is the reason it survived: nothing
// visibly broke. eslint had been reporting it as `'fail' is not defined`
// the whole time, and no CI job ran eslint.
//
// invariant: unterprozess-nennt-ursache
import { spawnSync } from 'node:child_process';
import { fileURLToPath as toPath } from 'node:url';

const MEM_BIN = path.join(path.dirname(toPath(import.meta.url)), '..', 'bin', 'mem');
function cli(r, ...argv) {
  return spawnSync(process.execPath, [MEM_BIN, ...argv, '--root', r],
    { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: r } });
}
function freshRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-shrinkcli-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'g' }));
  return r;
}

test('--new-baseline without --why is refused, and the refusal says why', () => {
  const r = freshRoot();
  try {
    const res = cli(r, 'shrink', '--new-baseline');
    const said = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.notEqual(res.status, 0, 'a lowered baseline without a reason was accepted');
    // The point of the test: not merely THAT it fails, but that it fails
    // with the sentence a user can act on. A ReferenceError also has a
    // non-zero exit.
    assert.match(said, /--why/, `the refusal does not name --why: ${said.trim()}`);
    assert.doesNotMatch(said, /is not defined|ReferenceError/,
      `the guard crashed instead of guarding: ${said.trim()}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('--new-baseline with --why goes through and records the reason', () => {
  const r = freshRoot();
  try {
    const res = cli(r, 'shrink', '--new-baseline', '--why', 'books split by project');
    const said = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.equal(res.status, 0, `refused a legitimate baseline: ${said.trim()}`);
    assert.match(said, /books split by project/, 'the reason was not recorded back');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --------------------------------------------------------------------
// Book names are the KEYS of the baseline, so their spelling decides
// whether a shrink is seen at all.
//
// invariant: trenner-nicht-fest-verdrahten
// invariant: fremder-pfad-wird-normalisiert

test('a book name never carries a backslash, on any platform', () => {
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(10) });
  try {
    for (const name of Object.keys(bookSizes(d))) {
      assert.doesNotMatch(name, /\\/, `native separator in a book name: ${name}`);
      assert.match(name, /\//, `no separator at all in a nested book: ${name}`);
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a baseline written with backslash keys still lines up afterwards', () => {
  // The Windows runner wrote exactly this shape until 2026-09-16. Read
  // literally, every book would look new and a real shrink would pass
  // unnoticed for one cycle — the failure mode this ratchet exists for.
  const d = mem({ 'global/errors.jsonl': 'x'.repeat(10) });
  try {
    fs.mkdirSync(path.join(d, '.pipeline'), { recursive: true });
    fs.writeFileSync(path.join(d, '.pipeline', 'shrink-baseline.json'),
      JSON.stringify({ version: 1, books: { 'global\\errors.jsonl': 40 } }));
    const alt = readBaseline(d);
    assert.deepEqual(Object.keys(alt.books), ['global/errors.jsonl'],
      'the old key was not brought over');
    // And the ratchet must now see ONE book, not two.
    const st = ratchet(alt, bookSizes(d));
    assert.deepEqual(Object.keys(st.books), ['global/errors.jsonl']);
    assert.equal(st.books['global/errors.jsonl'], 40, 'the old high-water mark was dropped');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// Two agents writing at once — the case a second transport makes real.
//
// **Why this exists.** Every append goes through `logEntry()`, which ends
// in a single `fs.appendFileSync`. With stdio there is one server process
// per client, so two agents are two processes writing the same file. That
// is already possible today; a remote transport only makes it likelier.
// Nothing in this suite held that property, so it was true by luck rather
// than by assurance — and a property nobody watches is one that can leave
// without a sound.
//
// **The test that matters here is the SECOND one.** A concurrency test
// that reports "nothing was lost" proves nothing on its own: a run where
// the writers never actually overlapped reports exactly the same thing.
// So the positive control writes the same number of entries through a
// read-modify-write, which MUST lose some. If it ever stops losing, this
// file has stopped measuring and says so instead of going quietly green.
//
// Entries are deliberately larger than PIPE_BUF (4096 bytes on Linux):
// that is the size above which an O_APPEND write is no longer promised to
// be atomic, so a smaller fixture would test the easy half of the range.
//
// invariant: leer-ist-kein-bestehen
// invariant: drei-zustaende-nie-zwei
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// As a file URL, not as a path. An ESM specifier is a URL, and on
// Windows `D:\\a\\cheap-mem\\src\\memory.mjs` is not one — the writer died
// with a module error before it appended a single line. Measured on the
// 2026-09-16 Windows runner, in the first run of this very test: the
// property under test was never exercised there at all.
const MEMORY = pathToFileURL(path.join(HERE, '..', 'src', 'memory.mjs')).href;

const WRITERS = 4;
const PER_WRITER = 120;
const PAD = 6000;

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-concur-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'concur' }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

/** Start all writers, THEN wait.
 *
 *  The first version of this helper used `execFileSync` inside a `.map()`.
 *  That starts one writer, waits for it to finish, and only then starts the
 *  next — a sequential run wearing the word "race". The control below
 *  caught it: it reported that nothing had been lost, which for a
 *  read-modify-write can only mean the writers never met. Hence `spawn`
 *  and one `Promise.all` at the end. */
function raceThem(script, r, marks) {
  const file = path.join(r, 'writer.mjs');
  fs.writeFileSync(file, script);
  const kinder = marks.map((m) => spawn(
    process.execPath, [file, r, m, String(PER_WRITER), String(PAD)],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  ));
  return Promise.all(kinder.map((k, i) => new Promise((ok, fail) => {
    let err = '';
    k.stderr.on('data', (b) => { err += b; });
    // A writer that dies must say so. Without this the file is simply
    // short, and the test reports "writes were lost" for a crash.
    k.on('error', (e) => fail(new Error(`writer ${marks[i]} would not start: ${e.message}`)));
    k.on('close', (code, signal) => (code === 0
      ? ok()
      : fail(new Error(`writer ${marks[i]} exited ${code}${signal ? ` (${signal})` : ''}`
        // The FIRST lines of stderr, not the last. The first version took
        // `.slice(-3)` and reported `}` / `` / `Node.js v20.20.2` — the
        // three least useful lines of a Node crash dump, which puts the
        // cause at the top. That cost a CI round. With the head, the same
        // failure reads `ERR_MODULE_NOT_FOUND` and names itself.
        + `${err ? `: ${err.trim().split('\n').slice(0, 4).join(' / ')}` : ''}`))));
  })));
}

/** What survived: total lines, unreadable ones, and the tally per writer. */
function harvest(r) {
  const p = path.join(r, 'projects', 'concur', 'decisions.jsonl');
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { return null; }
  const lines = text.split('\n').filter(Boolean);
  let broken = 0;
  const perMark = new Map();
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      perMark.set(o.mark, (perMark.get(o.mark) ?? 0) + 1);
    } catch { broken += 1; }
  }
  return { lines: lines.length, broken, perMark };
}

// The real path: four processes, each calling the exported logEntry().
const REAL = `
import { logEntry } from ${JSON.stringify(MEMORY)};
const [, , root, mark, count, pad] = process.argv;
const filler = mark.repeat(Number(pad) / mark.length);
for (let i = 0; i < Number(count); i += 1) {
  logEntry(root, 'decision', { mark, nr: i, topic: 'concur', choice: filler },
    { project: 'concur' });
}
`;

// The control: same shape, same file, but read-modify-write instead of
// append. This is what a lost write looks like.
const LOSSY = `
import fs from 'node:fs';
import path from 'node:path';
const [, , root, mark, count, pad] = process.argv;
const filler = mark.repeat(Number(pad) / mark.length);
const p = path.join(root, 'projects', 'concur', 'decisions.jsonl');
fs.mkdirSync(path.dirname(p), { recursive: true });
for (let i = 0; i < Number(count); i += 1) {
  const line = JSON.stringify({ mark, nr: i, topic: 'concur', choice: filler });
  let before = '';
  try { before = fs.readFileSync(p, 'utf8'); } catch { /* first writer */ }
  fs.writeFileSync(p, before + line + '\\n', 'utf8');
}
`;

const MARKS = ['aaaa', 'bbbb', 'cccc', 'dddd'].slice(0, WRITERS);
const EXPECTED = WRITERS * PER_WRITER;

test('four processes appending at once lose nothing and corrupt nothing', async () => {
  const r = root();
  try {
    await raceThem(REAL, r, MARKS);
    const got = harvest(r);
    assert.ok(got, 'no log was written at all — the fixture, not the property, is broken');
    assert.equal(got.broken, 0, `${got.broken} unreadable line(s) — a write was torn`);
    assert.equal(got.lines, EXPECTED,
      `${got.lines} of ${EXPECTED} lines survived — writes were lost`);
    // Per writer, not just the total: a total can come out right while one
    // writer's lines replaced another's.
    for (const m of MARKS) {
      assert.equal(got.perMark.get(m), PER_WRITER, `writer ${m} lost lines`);
    }
  } finally { away(r); }
});

test('the control loses writes — otherwise the test above proves nothing', async () => {
  const r = root();
  try {
    await raceThem(LOSSY, r, MARKS);
    const got = harvest(r);
    assert.ok(got, 'the control wrote nothing at all');
    assert.ok(got.lines < EXPECTED,
      `the read-modify-write control kept all ${EXPECTED} lines. The writers did `
      + 'not overlap, so the test above measured a sequential run and its green '
      + 'says nothing. Raise PER_WRITER or PAD until this control fails again.');
  } finally { away(r); }
});

test('an entry crosses the size where append atomicity stops being promised', () => {
  // A guard on the fixture itself. Shrink PAD below PIPE_BUF and the tests
  // above still pass — while testing only the half of the range that was
  // never in doubt. Three states: too small, big enough, or not measured.
  assert.ok(PAD > 4096,
    `PAD is ${PAD}; PIPE_BUF is 4096. Below that an atomic append is the easy case.`);
});

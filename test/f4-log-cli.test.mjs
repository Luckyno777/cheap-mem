// test/f4-log-cli.test.mjs — F1/F2/L4 at the CLI (BAUPLAN-mem-admin_02.md
// Block F, ported as F4): `mem log error` shows file history and opens
// a duty on repetition; `mem duties close` refuses one without
// evidence; `mem log` hints at a missing `asked`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MEM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f4-cli-'));
  const init = spawnSync('node', [MEM, '--root', r, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return r;
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
function cli(root, argv) {
  return spawnSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8' });
}
function output(r) { return `${r.stdout}\n${r.stderr}`; }

test('a first error for a file shows no history and opens no duty', () => {
  const r = build();
  try {
    const out = cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'first',
      '--text', 'found in src/f4.mjs']);
    assert.equal(out.status, 0, output(out));
    assert.ok(!/Earlier for/.test(out.stdout), out.stdout);
    assert.ok(!/Repetition \(/.test(out.stdout), out.stdout);
  } finally { gone(r); }
});

test('POSITIVE CONTROL: a repeat for the same file+class shows history and opens a duty', () => {
  const r = build();
  try {
    // Distinct, well-separated --ts values: two CLI calls in the same
    // real second must not turn into a false negative — repetition.mjs
    // deliberately treats a same-second entry as no lead-up, so this
    // test's own timing has to be pinned, not left to wall-clock luck.
    const first = cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'first attempt',
      '--text', 'found in src/f4.mjs', '--ts', '2026-09-01T00:00:00Z']);
    assert.equal(first.status, 0, output(first));

    const second = cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'second attempt',
      '--text', 'again in src/f4.mjs', '--ts', '2026-09-10T00:00:00Z']);
    assert.equal(second.status, 0, output(second));
    assert.match(second.stdout, /Earlier for src\/f4\.mjs/, second.stdout);
    assert.match(second.stdout, /first attempt/, second.stdout);
    assert.match(second.stdout, /Repetition \(file-class-30-days\) — opened duty/, second.stdout);

    const duties = cli(r, ['duties']);
    assert.equal(duties.status, 0, output(duties));
    assert.match(duties.stdout, /Guard for wrong-cause at src\/f4\.mjs/, duties.stdout);
  } finally { gone(r); }
});

test('a THIRD occurrence appends to the existing duty instead of opening a new one', () => {
  const r = build();
  try {
    cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'a1', '--text', 'in src/f4.mjs',
      '--ts', '2026-08-01T00:00:00Z']);
    cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'a2', '--text', 'in src/f4.mjs',
      '--ts', '2026-08-10T00:00:00Z']);
    const third = cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'a3', '--text', 'in src/f4.mjs',
      '--ts', '2026-08-20T00:00:00Z']);
    assert.match(third.stdout, /Repetition \(file-class-30-days\) — appended to existing duty/, third.stdout);

    const duties = cli(r, ['duties']);
    const guardLines = duties.stdout.split('\n').filter((l) => l.includes('Guard for wrong-cause'));
    assert.equal(guardLines.length, 1, duties.stdout);
  } finally { gone(r); }
});

test('`mem duties close` refuses an error-derived duty with no evidence', () => {
  const r = build();
  try {
    cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'a1', '--text', 'in src/f4.mjs',
      '--ts', '2026-08-01T00:00:00Z']);
    cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'a2', '--text', 'in src/f4.mjs',
      '--ts', '2026-08-10T00:00:00Z']);
    const duties = cli(r, ['duties']);
    const id = duties.stdout.match(/\[([a-z0-9]+)\]/)[1];

    const close = cli(r, ['duties', 'close', id]);
    assert.notEqual(close.status, 0);
    assert.match(close.stderr, /has no evidence/, output(close));
  } finally { gone(r); }
});

test('POSITIVE CONTROL: `mem duties close` succeeds once the guard is real', () => {
  const r = build();
  try {
    cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'a1', '--text', 'in src/f4.mjs',
      '--ts', '2026-08-01T00:00:00Z']);
    // The guard field lands on the SECOND error directly, at log time —
    // `mem correction` does not carry the --guard-* composing logic
    // `log` has, so a real guard here has to be attached at the write
    // that already triggers the repetition.
    const second = cli(r, ['log', 'error', '--class', 'wrong-cause', '--title', 'a2', '--text', 'in src/f4.mjs',
      '--ts', '2026-08-10T00:00:00Z', '--guard-kind', 'file-gone', '--guard-path', 'src/guarded-f4.mjs']);
    assert.equal(second.status, 0, output(second));

    const duties = cli(r, ['duties']);
    const id = duties.stdout.match(/\[([a-z0-9]+)\]/)[1];
    const close = cli(r, ['duties', 'close', id, '--why', 'fixed']);
    assert.equal(close.status, 0, output(close));
    assert.match(close.stdout, /Closed/);
  } finally { gone(r); }
});

// --- L4: the asked-hint -----------------------------------------------

test('logging a decision with no --asked prints the L4 hint', () => {
  const r = build();
  try {
    const out = cli(r, ['log', 'decision', '--topic', 'x', '--choice', 'y', '--why', 'z']);
    assert.equal(out.status, 0, output(out));
    assert.match(out.stderr, /without --asked/, output(out));
  } finally { gone(r); }
});

test('--asked switches the hint off', () => {
  const r = build();
  try {
    const out = cli(r, ['log', 'decision', '--topic', 'x', '--choice', 'y', '--why', 'z',
      '--asked', 'how do we pick, what did we choose']);
    assert.ok(!/without --asked/.test(out.stderr), output(out));
  } finally { gone(r); }
});

test('a `link` entry gets no asked-hint — it is found through its endpoints', () => {
  const r = build();
  try {
    const a = cli(r, ['log', 'decision', '--topic', 'a', '--choice', 'x']);
    const b = cli(r, ['log', 'decision', '--topic', 'b', '--choice', 'y']);
    const idA = a.stdout.match(/id: (\S+)/)[1];
    const idB = b.stdout.match(/id: (\S+)/)[1];
    const out = cli(r, ['log', 'link', '--from', idA, '--to', idB, '--kind', 'causes', '--why', 'z']);
    assert.equal(out.status, 0, output(out));
    assert.ok(!/without --asked/.test(out.stderr), output(out));
  } finally { gone(r); }
});

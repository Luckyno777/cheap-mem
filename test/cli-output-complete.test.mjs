// cli-output-complete: `mem` with no arguments prints its help in full,
// even when a Node process starts it and is slow to read.
//
// Found 2026-09-29 in the sibling house: the full suite went red on a
// README count that reads the help via execFileSync and sometimes got it
// truncated. A child started from Node writes into a socket; under load
// its buffer fills, the rest waits in a queue, and process.exit(0) right
// after the last out() cuts it off. Measured: 46 of 150 runs truncated;
// with blocking stdout (bin/mem, setBlocking) 0 of 150.
//
// The probe makes the load reproducible instead of hoping for it: the
// reader (this process) stalls for 1.5 s while the child writes, so the
// buffer fills exactly as it does under a full suite.
// RED: not showable in this house today, measured on 4e9a7a4 — the
// cm help is 7849 chars and fits the ~10.8 KB that got through before the
// cut in the sibling house (10844/10868 of 11137), and no cm command
// writes more than that and then calls process.exit (doctor 4296 chars in
// one write; the other exits use process.exitCode). The red proof lives
// in the sibling's test (5 of 5 truncated without the line). Here the
// line is prevention, and the slow-reader run is the positive control
// that the help still arrives whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = process.env.MEM_CLI_PROBE || path.join(ROOT, 'bin', 'mem');

async function helpWithSlowReader() {
  const child = spawn(process.execPath, [MEM], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  const parts = [];
  child.stdout.on('data', (d) => parts.push(d));
  const until = Date.now() + 1500;
  while (Date.now() < until) { /* the reader stalls — the buffer fills */ }
  await new Promise((done) => child.on('close', done));
  return Buffer.concat(parts).toString('utf8');
}

test('mem help arrives complete even when the reader stalls', async () => {
  for (let i = 0; i < 2; i += 1) {
    const text = await helpWithSlowReader();
    assert.match(text, /Global flags: --root <path> {3}memory root \(else CHEAP_MEM_ROOT or walk cwd\)\n$/,
      `run ${i + 1}: the help ends with its last line (arrived: ${text.length} chars)`);
  }
});

test('bin/mem switches stdout and stderr to blocking writes', () => {
  const code = fs.readFileSync(path.join(ROOT, 'bin', 'mem'), 'utf8');
  // Anchored at line start: a comment quoting the line does not count.
  assert.match(code, /^for \(const s of \[process\.stdout, process\.stderr\]\) s\._handle\?\.setBlocking\?\.\(true\);$/m);
});

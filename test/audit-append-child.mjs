// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Helper for test/audit-append-rollback.test.mjs. Not a test: without
// arguments it exits quietly with 0.
//
// Usage: node audit-append-child.mjs <srcDir> <mode> <args...>
//   short <file> <line> <blockedFile> <releaseFile>
//       appendLine with a SHORT write (half the line, no throw). After the
//       partial write the code runs on to its first decision point (old
//       state: after the fstat, before the ftruncate; new state: closing the
//       file). There the child writes <blockedFile> and waits for
//       <releaseFile> (barrier, no hoping on timing). Output: JSON.
//   append <file> <startFile> <prefix> <n>
//       Barrier on <startFile>, then n normal appendLine lines.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [src, mode, ...a] = process.argv.slice(2);
if (!src || !mode) process.exit(0);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitFor = (file) => {
  const t0 = Date.now();
  while (!fs.existsSync(file)) {
    if (Date.now() - t0 > 60000) { console.error('barrier never reached: ' + file); process.exit(3); }
    sleep(5);
  }
};
const { appendLine } = await import(pathToFileURL(path.join(src, 'append.mjs')).href);

if (mode === 'short') {
  const [file, line, blocked, release] = a;
  const realWrite = fs.writeSync; const realFstat = fs.fstatSync; const realTrunc = fs.ftruncateSync; const realClose = fs.closeSync;
  let shortWritten = false; let halted = false;
  const halt = () => { if (!halted) { halted = true; fs.writeFileSync(blocked, ''); waitFor(release); } };
  fs.writeSync = (fd, buf, off, len, ...r) => { const n = realWrite(fd, buf, off, Math.floor(len / 2), ...r); shortWritten = true; return n; };
  fs.fstatSync = (fd) => { const s = realFstat(fd); if (shortWritten) halt(); return s; };
  fs.ftruncateSync = (fd, l) => { halt(); return realTrunc(fd, l); };
  fs.closeSync = (fd) => { if (shortWritten) halt(); return realClose(fd); };
  let error = null;
  try { appendLine(file, line); } catch (e) { error = { name: e.name, torn: e.torn, written: e.written }; }
  console.log(JSON.stringify({ error }));
} else if (mode === 'append') {
  const [file, start, prefix, n] = a;
  waitFor(start);
  for (let i = 0; i < Number(n); i++) appendLine(file, `${JSON.stringify({ from: prefix, i })}\n`);
}

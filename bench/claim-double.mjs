// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/claim-double.mjs — X4: a measurement, not a test.
//
// Question: how often do TWO parallel observer processes believe they
// are handling the same open message — and do both then act? What is
// counted is SILENT double handling: both act, and nothing marks one of
// them as the loser.
//
// Usage:  node bench/claim-double.mjs [--code <tree>] [--runs 100]
//
// `--code` picks the source tree to measure (default: this tree). If it
// has no src/claim.mjs, the OLD procedure from before X4 applies: read
// the state, if it is `open` set it and work (read-then-write, no lock).
// Otherwise the NEW one: claim(), work, ask check() before the effect,
// then done().
//
// Both observers wait for the same start instant to force the race; the
// "work" is 40 ms. Only the shared storage of ONE host is measured here —
// across hosts git is not a lock (see src/claim.mjs, header): there the
// goal is a VISIBLE duplicate, which this measurement does not simulate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const code = path.resolve(arg('--code', HERE));
const imp = (rel) => import(pathToFileURL(path.join(code, rel)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };

if (process.argv.includes('--observer')) {
  const [root, message, name, start] = [arg('--root'), arg('--message'), arg('--name'), Number(arg('--start'))];
  const inbox = await imp('src/inbox.mjs');
  const isNew = fs.existsSync(path.join(code, 'src/claim.mjs'));
  while (Date.now() < start) { /* starting gun */ }
  let believes; let acts;
  if (isNew) {
    const c = await imp('src/claim.mjs');
    const r = c.claim(root, message, { by: name });
    believes = r.valid;
    await sleep(40);
    acts = c.check(root, message, r.id).valid;
    if (acts) c.done(root, message, { by: name });
  } else {
    const m = inbox.parse(inbox.readMessage(root, message));
    believes = m.state === inbox.STATE.OPEN;
    if (believes) inbox.setState(root, PARTS, message, inbox.STATE.PROCESSED);
    await sleep(40);
    acts = believes;
  }
  console.log(JSON.stringify({ name, believes, acts }));
  process.exit(0);
}

const inbox = await imp('src/inbox.mjs');
const isNew = fs.existsSync(path.join(code, 'src/claim.mjs'));
const runs = Number(arg('--runs', 100));
let bothBelieve = 0; let bothAct = 0; let exactlyOne = 0; let none = 0;
for (let i = 0; i < runs; i++) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-bench-'));
  const w = inbox.write(root, PARTS, { from: 'session', to: 'librarian', subject: `Run ${i}`, text: 'Please check.' });
  const start = Date.now() + 250;
  const run = (name) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), '--observer', '--code', code,
      '--root', root, '--message', w.name, '--name', name, '--start', String(start)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('close', (c) => (c === 0 ? res(JSON.parse(out)) : rej(new Error(`observer ${name} exit ${c}`))));
  });
  const [a, b] = await Promise.all([run('observer-a'), run('observer-b')]);
  if (a.believes && b.believes) bothBelieve++;
  const n = [a, b].filter((x) => x.acts).length;
  if (n === 2) bothAct++; else if (n === 1) exactlyOne++; else none++;
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`Procedure: ${isNew ? 'NEW (claim/check/done)' : 'OLD (read-then-set)'}   Code: ${code}`);
console.log(`Runs: ${runs}`);
console.log(`both believe at first they are up (transient): ${bothBelieve}`);
console.log(`SILENT double (both act):                      ${bothAct}`);
console.log(`exactly one acts:                              ${exactlyOne}`);
console.log(`none acts:                                     ${none}`);

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Shared fixture for test/missgold*.test.mjs: a small English memory, one
// recall miss in the injection journal, and the raw capture of the session
// that asked, got nothing, and then fetched the entry by id.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as memory from '../../src/memory.mjs';
import * as raw from '../../src/raw.mjs';
import * as injection from '../../src/injection.mjs';
import { writeMemoryGitignore } from '../../src/cli/githook.mjs';

export const T0 = Date.parse('2026-09-27T10:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();
export const QUESTION = 'where did my stuff get stuck';
export const SESSION = 'sess-gold-1';

/** Remove-at-end list; tests call `cleanup()` in a finally. */
const made = [];
export function cleanup() { while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true }); }

/** A memory root: config, a few entries, a git repo whose .gitignore is the real one. */
export function memoryRoot({ ignore = true, targetTags = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-missgold-'));
  made.push(root);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ version: 1, language: 'en', participants: { user: 'u' } }));
  const t = new Date('2026-09-01T00:00:00Z');
  memory.logEntry(root, 'error', {
    id: 'etarget0001', class: 'bug', title: 'Stranded captures in the staging folder',
    text: 'The captures stayed under the pipeline folder because the archive step never ran.', tags: targetTags,
  }, { now: t });
  for (const [id, title, text] of [
    ['edispatch01', 'Dispatcher inherits the flock', 'The dispatcher does not start while a child inherits the flock.'],
    ['edecoy00002', 'Warm lookups save the rebuild', 'The index stays in memory and answers faster.'],
    ['edecoy00003', 'Marks stay apart per house', 'Every house shows only its own mark.'],
  ]) memory.logEntry(root, 'error', { id, class: 'bug', title, text }, { now: t });
  execFileSync('git', ['init', '-q'], { cwd: root });
  if (ignore) writeMemoryGitignore(root);
  return root;
}

/** The session's transcript lives OUTSIDE the memory (a real one does too). */
function transcriptDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-missgold-tr-'));
  made.push(d);
  return d;
}

/** The session asks `question`, then fetches `fetch` by id; the raw capture is stored. */
export function captureSession(root, { session = SESSION, question = QUESTION, fetch = 'etarget0001', at = T0 } = {}) {
  const lines = [
    { type: 'user', sessionId: session, timestamp: iso(at), promptId: 'p1', message: { role: 'user', content: question } },
    { type: 'assistant', sessionId: session, timestamp: iso(at + 60_000), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `mem show ${fetch}` } }] } },
  ];
  const tr = path.join(transcriptDir(), `${session}.jsonl`);
  fs.writeFileSync(tr, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = raw.capture(root, tr, { minBytes: 0 });
  if (r.status !== 'captured') throw new Error(`capture failed: ${JSON.stringify(r)}`);
}

/** One journal line: a question turn that found nothing (or showed `sources`). */
export function miss(root, { session = SESSION, at = T0, sources = [], reason = injection.REASON.TOO_WEAK } = {}) {
  injection.book(root, { ts: iso(at).replace(/\.\d{3}Z$/, 'Z'), session, occasion: injection.OCCASION.QUESTION, reason, sources });
}

/** Memory + capture + miss, ready for `find`. */
export function world(opt = {}) {
  const { question, ...rest } = opt;
  const root = memoryRoot(rest);
  captureSession(root, { question });
  miss(root);
  return root;
}

/** The whole tree except `skip` files and the raw archive (gzip), as one string per file. */
export function allFiles(dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === '.git') continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) allFiles(p, out); else out.push(p);
  }
  return out;
}

/** A gold file with `n` cases: each entry carries its own rare word, each question is that word. */
export function writeGoldFile(root, target, n, { learned = 0, viaRewrite = 0 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const word = `zebra${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`;
    const e = memory.logEntry(root, 'learning', { title: `Entry ${word}`, learning: `Text about ${word} and only that.` });
    const journal = `.pipeline/injections.jsonl:${i + 1}`;
    rows.push({
      id: `g${String(i).padStart(11, '0')}`, ts: iso(T0), question: `where is ${word}`, expected: [e.entry.id],
      kind: 'too-weak', journal, collected: iso(T0),
    });
    if (i < learned) {
      memory.correctionEntry(root, 'learning', e.entry.id, {
        title: e.entry.title, learning: e.entry.learning, asked: ['x'], asked_evidence: [{ journal, words: 'x' }],
      }, {});
    }
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
  return rows;
}

// test/find-stream.test.mjs - memory.find / timesearch.entriesInWindow stream.
//
// Why: find() used to read every log whole, JSON.parse every line into one
// array and filter afterwards, so memory grew with the entry count (parity
// with lucky-mem bbb74c79, where the 10M gate died of "heap out of memory").
// Now it walks the logs twice as text: pass 1 parses only lines with a state
// field, pass 2 keeps only state lines, the first line of each named id and
// the hit candidates.
//
// 1. Equality: new == frozen old (test/helpers/find-old.mjs, commit f9fd134)
//    on a memory with BOM, CRLF, a broken line, blank lines, a duplicate id,
//    tombstones, corrections, a late supersession, a cross-drawer tombstone
//    and a project.
// 2. Memory ratchet: child process with a small --max-old-space-size. The OLD
//    code dies, the new one runs; positive control: the old one runs with a
//    big heap, so the probe bites at the cap and nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as capability from '../src/capability.mjs';
import { entriesInWindow } from '../src/timesearch.mjs';
import { findOld, entriesInWindowOld } from './helpers/find-old.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP = capability.grantAll('find-stream-test');

function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
const lines = (a) => `${a.map((z) => (typeof z === 'string' ? z : JSON.stringify(z))).join('\n')}\n`;

function fixture() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fstream-'));
  const e = (id, ts, extra = {}) => ({ id, ts, title: `Title ${id} pytha`, agent: 'a1', origin: 'vm', ...extra });
  // events: BOM + CRLF + blank line + broken line.
  put(w, 'global/events.jsonl', `﻿${[
    JSON.stringify(e('s1a', '2026-08-29T13:30:00Z')),
    '',
    JSON.stringify(e('s1b', '2026-08-29T17:00:00Z')),
    '{broken',
    JSON.stringify(e('s1c', '2026-08-30T10:00:00Z')),
  ].join('\r\n')}\r\n`);
  put(w, 'global/decisions.jsonl', lines([
    e('d1', '2026-08-29T14:00:00Z'),
    e('d2', '2026-08-29T15:00:00Z'),
    { id: 'no-ts', title: 'no ts' },
    { id: 'num-ts', ts: 1788000000000, title: 'ts as number' },
    e('bad-ts', 'not-a-date'),
    e('dup', '2026-08-29T15:30:00Z', { title: 'first dup' }),
    { id: 'nest', ts: '2026-08-29T15:40:00Z', title: 'nested', meta: { ts: '2026-09-09T00:00:00Z', text: 'has "ts":"x" and "id":"s1a"' } },
    e('a1', '2026-08-29T16:00:00Z'),
    // Tombstones on targets earlier in the file and in another drawer.
    { id: 'g1', ts: '2026-08-29T16:05:00Z', closes_id: 's1a', state: 'done', why: 'finished', agent: 'a1' },
    { id: 'g2', ts: '2026-08-29T16:06:00Z', retires_id: 'd1', agent: 'a1' },
    // Correction: new content replaces d2.
    e('k1', '2026-08-29T16:07:00Z', { replaces_id: 'd2', title: 'Correction pytha' }),
    // Late supersession: s1c replaced by a1.
    { id: 'g3', ts: '2026-08-31T10:00:00Z', retires_id: 's1c', state: 'superseded', by_id: 'a1', agent: 'a1' },
    // A claim by a foreign author, and one on a target that does not exist.
    { id: 'g4', ts: '2026-08-29T16:08:00Z', closes_id: 's1b', agent: 'stranger', origin: 'cloud' },
    { id: 'g5', ts: '2026-08-29T16:09:00Z', closes_id: 'does-not-exist', agent: 'a1' },
    e('dup', '2026-08-29T16:10:00Z', { title: 'second dup' }),
    { id: 'g6', ts: '2026-08-29T16:11:00Z', closes_id: 'dup', agent: 'a1' },
  ]));
  put(w, 'global/errors.jsonl', lines([e('f1', '2026-08-29T13:45:00Z', { title: 'Error pytha' })]));
  // Project drawer plus a tombstone from ANOTHER drawer (global timeline) on a project target.
  put(w, 'projects/p1/learnings.jsonl', lines([
    e('p1a', '2026-08-29T14:30:00Z'), e('p1b', '2026-08-29T14:40:00Z'), e('p1c', '2026-08-29T18:00:00Z'),
  ]));
  put(w, 'projects/p1/events.jsonl', lines([{ id: 'g8', ts: '2026-08-29T19:00:00Z', closes_id: 'p1b', agent: 'a1' }]));
  put(w, 'global/timeline.jsonl', lines([{ id: 'g7', ts: '2026-08-29T19:00:00Z', closes_id: 'p1a', agent: 'a1' }]));
  return w;
}

const WINDOWS = [
  {},
  { from: '2026-08-29T00:00:00Z', to: '2026-08-31T00:00:00Z' },
  { from: '2026-08-29T13:00:00Z', to: '2026-08-29T18:00:00Z' },
  { from: '2026-08-29T15:00:00Z', to: '2026-08-29T15:00:01Z' },
  { from: new Date('2026-08-29T00:00:00Z'), to: '2026-09-30T00:00:00Z' },
  { from: '2026-08-01T00:00:00Z', to: '2026-09-30T00:00:00Z', words: ['pytha'] },
  { from: '2026-08-01T00:00:00Z', to: '2026-09-30T00:00:00Z', words: ['finished', 'correction'] },
  { to: '2026-08-29T15:00:00Z' },
  { from: '2026-08-30T00:00:00Z' },
];

test('equality: entriesInWindow new == frozen old', () => {
  const w = fixture();
  try {
    let nonEmpty = 0;
    for (const opt of WINDOWS) {
      const old = entriesInWindowOld(w, CAP, opt);
      const fresh = entriesInWindow(w, CAP, opt);
      assert.deepEqual(fresh, old, `window ${JSON.stringify(opt)}`);
      if (old.length) nonEmpty += 1;
    }
    assert.ok(nonEmpty >= 7, 'positive control: the windows return something');
    const all = entriesInWindow(w, CAP, { from: '2026-08-01T00:00:00Z', to: '2026-09-30T00:00:00Z' });
    const states = new Set(all.map((x) => x._retired?.state).filter(Boolean));
    assert.ok(states.has('done') || states.has('closed') || states.size >= 2, `states: ${[...states]}`);
    assert.ok(all.some((x) => x._retired), 'fixture carries retired entries');
    assert.ok(all.some((x) => x._source.startsWith('projects/p1/')), 'project hits present');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

test('equality: memory.find (pattern, since, types, projects, withRetired) new == old', () => {
  const w = fixture();
  try {
    const cases = [
      ['', {}], ['', { withRetired: true }], ['pytha', {}], ['PYTHA', { withRetired: true }],
      ['dup', { withRetired: true }], ['x', { since: '2026-08-29T16:00:00Z', withRetired: true }],
      ['', { types: ['decision'], withRetired: true }], ['', { projects: [] }], ['', { projects: ['p1'] }],
      ['"ts"', { withRetired: true }], ['no ts', {}],
    ];
    let retiredSeen = 0;
    for (const [pattern, opt] of cases) {
      const old = findOld(w, pattern, CAP, opt);
      assert.deepEqual(memory.find(w, pattern, CAP, opt), old, `${JSON.stringify(pattern)} ${JSON.stringify(opt)}`);
      retiredSeen += old.filter((x) => x._retired).length;
    }
    assert.ok(retiredSeen > 0, 'positive control: retired annotations were compared');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Memory ratchet
// ---------------------------------------------------------------------------

const CHILD = `
import { entriesInWindow } from ${JSON.stringify(path.join(HERE, '..', 'src', 'timesearch.mjs'))};
import { entriesInWindowOld } from ${JSON.stringify(path.join(HERE, 'helpers', 'find-old.mjs'))};
import * as capability from ${JSON.stringify(path.join(HERE, '..', 'src', 'capability.mjs'))};
const [kind, root] = process.argv.slice(-2);
const f = kind === 'old' ? entriesInWindowOld : entriesInWindow;
const r = f(root, capability.grantAll('child'), { from: '2026-03-05T00:00:00Z', to: '2026-03-05T01:00:00Z' });
process.stdout.write(JSON.stringify({ n: r.length, rss: process.memoryUsage().rss }));
`;

function bigMemory(n) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fstream-big-'));
  fs.mkdirSync(path.join(w, 'global'), { recursive: true });
  const filler = 'A line of running text that pads the entry to a realistic size, nothing more. '.repeat(3);
  const t0 = Date.parse('2026-03-04T12:00:00Z');
  const part = (a, b) => {
    const out = [];
    for (let i = a; i < b; i += 1) {
      out.push(JSON.stringify({
        id: `e${i.toString(36)}`, ts: new Date(t0 + i * 1000).toISOString(), title: `Entry ${i}`,
        text: filler, tags: ['a', 'b'], origin: `s${i % 50}`,
      }));
    }
    return `${out.join('\n')}\n`;
  };
  const half = Math.floor(n / 2);
  fs.writeFileSync(path.join(w, 'global', 'events.jsonl'), part(0, half));
  fs.writeFileSync(path.join(w, 'global', 'decisions.jsonl'), part(half, n));
  return w;
}

const MIB_TIGHT = 48;
const MIB_WIDE = 1024;
function run(kind, root, mib) {
  return spawnSync(process.execPath, [`--max-old-space-size=${mib}`, '--input-type=module', '-e', CHILD, kind, root], {
    encoding: 'utf8', timeout: 55_000,
  });
}

test('memory ratchet: old code dies in a tight heap, new runs; both run in a wide one', () => {
  const w = bigMemory(120_000);
  try {
    const tight = run('new', w, MIB_TIGHT);
    assert.equal(tight.status, 0, `new in tight heap: ${tight.stderr.slice(0, 300)}`);
    const n = JSON.parse(tight.stdout).n;
    assert.ok(n >= 3500 && n <= 3600, `one hour at one entry per second, got ${n}`);
    const oldTight = run('old', w, MIB_TIGHT);
    assert.notEqual(oldTight.status, 0, 'old in a tight heap must die');
    assert.match(oldTight.stderr, /heap out of memory/i);
    const oldWide = run('old', w, MIB_WIDE);
    assert.equal(oldWide.status, 0, `old in a wide heap: ${oldWide.stderr.slice(0, 300)}`);
    assert.equal(JSON.parse(oldWide.stdout).n, n, 'same result in the wide heap');
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

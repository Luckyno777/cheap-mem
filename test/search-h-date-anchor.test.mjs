// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// Date anchors survive `retrievalQuery()` (ported from lucky-mem,
// 2026-10-01, there `zeitausdruck.datumsAnker`).
//
// The defect: `retrievalQuery("what was on 2028-10-04")` returned "2028".
// "on" is filler, the date crumbled into 2028/10/04, and only "2028"
// passed the four-character bar. `mem find --content-words` asks
// `hasTimeIntent()` on that SHORTENED text, so an absolute date question
// never reached the time lane — it searched for the word "2028" instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as search from '../src/search.mjs';
import * as timeexpr from '../src/timeexpr.mjs';
import * as memory from '../src/memory.mjs';
import { tempDir } from './temp-dir.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');

test('retrievalQuery keeps a date anchor with its preposition', () => {
  const q = search.retrievalQuery('what was on 2028-10-04');
  assert.equal(q, 'on 2028-10-04');
  assert.equal(timeexpr.hasTimeIntent(q), true, 'the shortened question must still ask about time');
  const longer = search.retrievalQuery('what happened since 2028-10-04 with the deploy');
  assert.ok(longer.startsWith('since 2028-10-04'), longer);
  assert.ok(longer.includes('deploy'), longer);
});

test('a bare date stays a mention: no anchor is invented', () => {
  // Positive control for the rule above: without a preposition nothing
  // changes, and the time gate keeps saying no.
  assert.deepEqual(timeexpr.dateAnchors('the 2028-10-04 report'), []);
  assert.equal(search.retrievalQuery('the 2028-10-04 report'), '2028 report');
  assert.equal(timeexpr.hasTimeIntent('2028 report'), false);
});

test('dateAnchors: text order, lower case, no duplicates', () => {
  assert.deepEqual(timeexpr.dateAnchors('From 2028-10-01 ... on  2028-10-04, on 2028-10-04'),
    ['from 2028-10-01', 'on 2028-10-04']);
  assert.deepEqual(timeexpr.dateAnchors(''), []);
  assert.deepEqual(timeexpr.dateAnchors(null), []);
});

test('mem find --content-words routes an absolute date question to the time lane', (t) => {
  const root = tempDir('cm-h-date-', t);
  {
    execFileSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
    memory.logEntry(root, 'decision', { title: 'Chose the blue release train', text: 'decided in the review' },
      { now: new Date('2028-10-04T10:00:00Z') });
    // A decoy that carries the word the old shortening searched for.
    memory.logEntry(root, 'decision', { title: 'Budget 2028 frozen', text: 'numbers for 2028' },
      { now: new Date('2028-03-01T10:00:00Z') });
    const env = { ...process.env, MEM_TZ: 'UTC' };
    delete env.CHEAP_MEM_ROOT;
    const out = JSON.parse(execFileSync(process.execPath,
      [MEM, '--root', root, 'find', 'what was on 2028-10-04', '--content-words', '--json'],
      { encoding: 'utf8', env }));
    assert.ok(out.window, `expected the time lane (a window), got: ${JSON.stringify(out).slice(0, 300)}`);
    const titles = out.hits.map((h) => h.entry?.title);
    assert.deepEqual(titles, ['Chose the blue release train']);
  }
});

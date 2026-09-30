// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// O2 (build plan block O, row O2) — the display half.
//
// Every surface reads an entry's content from src/bodyfields.mjs and shows,
// for a learning with a title, a duty, a question and a workflow with steps,
// the MAIN TEXT, not only the title:
//   - recall hooks: src/recallrender.mjs renderHit
//   - `mem find` & co.: src/cli/display.mjs compactLine
//   - MCP line: src/shortline.mjs shortLine (moved out of bin/mem-mcp)
//   - dashboard text: src/dashboard-data.mjs textOf
// Red proof: against the start commit c23ad5c53e343fec5c5512b8d59920a6a9633dac
// (compactLine/shortLine without learning/duty/steps, textOf without duty/steps,
// renderHit without steps) — see the O2 report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderHit } from '../src/recallrender.mjs';
import { compactLine } from '../src/cli/display.mjs';
import { textOf } from '../src/dashboard-data.mjs';

const shortLine = await import('../src/shortline.mjs').then((m) => m.shortLine).catch(() => null);

const CASES = [
  { type: 'learning', e: { id: 'o2l', title: 'Learning title', learning: 'LEARNCORE alpha' }, core: 'LEARNCORE' },
  { type: 'duty', e: { id: 'o2d', title: 'Duty title', duty: 'DUTYCORE beta' }, core: 'DUTYCORE' },
  { type: 'question', e: { id: 'o2q', title: 'Question title', question: 'QUESTIONCORE gamma?' }, core: 'QUESTIONCORE' },
  { type: 'workflow', e: { id: 'o2w', title: 'Workflow title', steps: ['STEPCORE one', 'two'] }, core: 'STEPCORE' },
];

const SURFACES = {
  'recall hook (renderHit)': (e) => renderHit(e).line,
  'mem find (compactLine)': (e) => compactLine(e),
  'MCP line (shortLine)': (e) => (shortLine ? shortLine(e) : '(src/shortline.mjs missing)'),
  dashboard: (e, type) => textOf(e, type),
  'dashboard without type': (e) => textOf(e),
};

for (const [name, show] of Object.entries(SURFACES)) {
  test(`O2: ${name} shows the main text, not only the title`, () => {
    const missing = CASES.filter(({ type, e, core }) => !String(show(e, type) ?? '').includes(core))
      .map(({ type, e }) => `${type} -> "${show(e, type)}"`);
    assert.deepEqual(missing, [], `${name} swallows the main text: ${missing.join(' | ')}`);
    // Positive control: the same probe recognises an entry without main text.
    assert.ok(!String(show({ id: 'o2t', title: 'Only title' }, 'learning') ?? '').includes('LEARNCORE'));
  });
}

test('O2: workflow steps come out as text, not as "a,b"', () => {
  for (const [name, show] of Object.entries(SURFACES)) {
    const line = String(show(CASES[3].e, 'workflow'));
    assert.ok(!line.includes('one,two'), `${name}: raw array: ${line}`);
  }
});

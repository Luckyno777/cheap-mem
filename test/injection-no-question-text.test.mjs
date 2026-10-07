// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/injection-no-question-text.test.mjs — the wording of a question never
// lands in the injection journal (parity with lucky-mem
// nie-fragetext-im-journal).
//
// The journal keeps stems, places and numbers (questionBytes, never the
// text): it travels to places the wording has no business being. A probe
// runs a real `mem find --journal-session` with a distinctive question, then
// searches the journal for the wording and finds nothing — and finds it when
// it is put in on purpose (positive control: the search can see it).
//
// invariant: nie-fragetext-im-journal
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const WORDING = 'quuxlevarn zibberwock frobnitz';

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inj-q-'));
  try {
    execFileSync(process.execPath, [BIN, '--root', root, 'init'], { stdio: 'pipe' });
    execFileSync(process.execPath, [BIN, '--root', root, 'log', 'decision', '--topic', 'billing',
      '--choice', 'use postgresql', '--why', 'one store'], { stdio: 'pipe' });
    return fn(root);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('a real find with a journal session books the question, not its wording', () => {
  withRoot((root) => {
    for (const q of [WORDING, `postgresql ${WORDING}`]) {
      execFileSync(process.execPath, [BIN, '--root', root, 'find', q, '--json', '--top', '3',
        '--journal-session', 'S1', '--journal-min', '0.5'], { stdio: 'pipe' });
    }
    const file = path.join(root, injection.JOURNAL_FILE);
    const raw = fs.readFileSync(file, 'utf8');
    assert.equal(raw.trim().split('\n').length, 2, 'both questions were booked (the probe looks at something)');
    for (const word of WORDING.split(' ')) assert.ok(!raw.includes(word), `journal carries a word of the question: ${word}`);
    const { lines } = injection.read(root);
    assert.ok(lines.every((l) => Number.isFinite(l.question_bytes ?? l.questionBytes)), JSON.stringify(lines[0]));
    // Positive control: the same search DOES see the wording once it is put in.
    assert.ok(`${raw}\n{"q":"${WORDING}"}`.includes(WORDING));
  });
});

test('buildLine drops fields it does not know: question, query, prompt, text', () => {
  const l = injection.buildLine({ question: WORDING, query: WORDING, prompt: WORDING, text: WORDING, hits: 1 });
  assert.ok(!JSON.stringify(l).includes('quuxlevarn'), JSON.stringify(l));
  assert.equal(l.hits, 1, 'known fields still arrive');
});

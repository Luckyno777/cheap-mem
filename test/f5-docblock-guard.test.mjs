// F5 / suggestion list item 2: a docblock (`/** ... */`) stands DIRECTLY
// in front of what it describes.
//
// **The finding (error audit).** Around 100 misplaced blocks across both
// houses: a docblock followed by a blank line or by another comment tells
// the reader about the wrong function -- or about none (e.g. an orphaned
// one-line docblock right before the next block).
//
// **Rule.** The line after `*/` is code -- no blank line, no further
// comment. The FIRST docblock of a file, before any code, is its header
// and exempt. To describe a section or a mood use `/* ... */` or `//`.
//
// **Old stock with a cap.** Per file, the number of misplaced blocks
// (state 2026-10-01). No more; fewer is good (lower the cap to keep the
// gain). No eslint-jsdoc dependency: a probe of our own, as everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { files, read } from './f5-source.mjs';

/** Line numbers (1-based) of the misplaced docblocks of a source text. */
export function misplaced(text) {
  const z = text.split('\n');
  const out = [];
  let codeSeen = false;
  for (let i = 0; i < z.length; i += 1) {
    const l = z[i];
    if (/^\s*\/\*\*/.test(l)) {
      let j = i;
      while (j < z.length && !/\*\//.test(z[j])) j += 1;
      const next = z[j + 1];
      if (codeSeen) {
        if (next === undefined || next.trim() === '' || /^\s*(\/\/|\/\*)/.test(next)) out.push(i + 1);
      }
      codeSeen = true; // after the header every further block counts
      i = j;
      continue;
    }
    if (l.trim() !== '' && !/^\s*(\/\/|\/\*|\*|#!)/.test(l)) codeSeen = true;
  }
  return out;
}

const CAP = {
  'src/chain.mjs': 1,
  'src/claim.mjs': 2,
  'src/cli/githook.mjs': 1,
  'src/cli/shell.mjs': 1,
  'src/clihelp.mjs': 1,
  'src/dashboard-data.mjs': 1,
  'src/dashboard.mjs': 1,
  'src/doctor.mjs': 3,
  'src/effect.mjs': 1,
  'src/environment.mjs': 2,
  'src/memory.mjs': 6,
  'src/raw.mjs': 1,
  'src/redaction.mjs': 2,
  'src/retrieval.mjs': 1,
  'src/search.mjs': 5,
  'src/shrink.mjs': 1,
  'src/tasks.mjs': 1,
  'src/viewer.mjs': 2,
  'src/webauth.mjs': 1
};

const CANDIDATES = () => [
  ...files('src', (n) => n.endsWith('.mjs')),
  ...files('bin', (n) => n === 'mem' || n.endsWith('.mjs')),
];

test('positive control: misplaced blocks are seen, header and clean ones are not', () => {
  const header = '/**\n * Header of the file.\n */\n\nimport x from "y";\n';
  assert.deepEqual(misplaced(header), []);
  assert.deepEqual(misplaced(`${header}\n/** clean */\nfunction a() {}\n`), []);
  assert.deepEqual(misplaced(`${header}\n/** blank line after */\n\nfunction a() {}\n`), [7]);
  assert.deepEqual(misplaced(`${header}\n/** orphan */\n/**\n * real\n */\nfunction a() {}\n`), [7]);
  assert.deepEqual(misplaced(`${header}\n/** before comment */\n// note\nfunction a() {}\n`), [7]);
});

test('misplaced docblocks do not grow (old stock capped per file)', () => {
  const tooMany = []; const tooHigh = []; const seen = {};
  for (const rel of CANDIDATES()) {
    const v = misplaced(read(rel));
    if (!v.length) continue;
    seen[rel] = v.length;
    const cap = CAP[rel] ?? 0;
    if (v.length > cap) tooMany.push(`${rel}: ${v.length} misplaced docblock(s), cap ${cap} (lines ${v.join(', ')})`);
  }
  for (const [rel, c] of Object.entries(CAP)) if ((seen[rel] ?? 0) < c) tooHigh.push(`${rel}: only ${seen[rel] ?? 0} left, lower the cap from ${c}`);
  assert.deepEqual(tooMany, [], `docblock not directly before its declaration:\n${tooMany.join('\n')}`);
  assert.deepEqual(tooHigh, [], `cap too high:\n${tooHigh.join('\n')}`);
});

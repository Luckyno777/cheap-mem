// The final split is frozen. This test is the seal.
//
// After the freeze (2026-09-06) nothing about these tasks may change:
// no rewording, no relaxed rule, no special case. Otherwise the final
// run measures how well the tasks were fitted to the result.
//
// If this test goes red that is not a detail: either a frozen task was
// touched, or the freeze was not meant. Both belong in a conversation,
// not under a rug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TASKS } from '../eval/tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL = path.join(HERE, '..', 'eval');

test('the frozen final split is unchanged', () => {
  const now = TASKS.filter((t) => t.split === 'final').map((t) => ({
    id: t.id, klasse: t.klasse, gold: t.gold, prompt: t.prompt,
    must: t.must.map(String), mustNot: t.mustNot.map(String),
    gates: Object.fromEntries(Object.entries(t.gates ?? {}).map(([k, v]) => [k, v.map(String)])),
  }));
  const json = JSON.stringify(now, null, 2);
  const hash = createHash('sha256').update(json).digest('hex');
  const expected = fs.readFileSync(path.join(EVAL, 'final-eingefroren.sha256'), 'utf8').trim();
  assert.equal(hash, expected,
    'The final split changed after the freeze. If that was intended, the freeze '
    + 'has to be re-set with a reason — and the final run no longer counts as '
    + 'independent.');
});

test('the "invented numbers" metric is fixed in advance and deterministic', async () => {
  const { erfundeneZahlen } = await import('../eval/tasks.mjs');
  // A positive and a negative control, so that a zero result stays
  // distinguishable from a broken metric later on.
  const a = erfundeneZahlen('Der Port ist 3000.', 'Auf welchem Port?', '[F] Port 9443');
  const b = erfundeneZahlen('Port 9443.', 'Auf welchem Port?', '[F] Port 9443');
  assert.equal(a.erfunden, 1, 'a number out of nowhere has to count');
  assert.equal(b.erfunden, 0, 'a number taken from the context must not count');
});

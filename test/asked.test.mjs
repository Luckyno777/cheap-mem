// Asked-words: the one field holding words that are NOT in the entry.
//
// The digester writes them while condensing — three to five words
// somebody would SEARCH with months later, without knowing the entry's
// own wording. That is the answer to paraphrase that stays true to the
// design: the work happens on lane 2, where a model runs anyway, and
// costs nothing at retrieval time. Embeddings cost one call per QUERY;
// this costs one per digest run.
//
// Measured on the eval corpus (eval/query-words-effect.mjs): gold in
// context 24/63 -> 28/63, nothing lost, precision 10 % -> 11 %.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');

function build({ withAsked }) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-asked-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, 'decision',
    { ...d, author: 'lucky', authority: 'user' });
  log({
    id: 'ZIEL', topic: 'aufbewahrung',
    choice: 'protokolle werden nach dreissig tagen entfernt',
    why: 'der datenschutzbeauftragte hat neunzig tage beanstandet',
    // None of these words appears in the entry. That is the point — but
    // it does NOT mean the entry is unreachable without them: the
    // thesaurus bridges `loeschfrist` to the entry's own wording. Only
    // `dsgvo` has no path at all, which is why the test leans on it.
    ...(withAsked ? { asked: ['loeschfrist', 'dsgvo', 'speicherdauer'] } : {}),
  });
  for (const t of ['ablage', 'tests', 'rechte', 'bilder', 'zeitplan', 'meldung']) {
    for (let i = 0; i < 5; i += 1) {
      log({ id: `X-${t}-${i}`, topic: t, choice: `zu ${t} gilt fassung ${i}`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert` });
    }
  }
  return r;
}

const rankOf = (r, question) => {
  const idx = search.buildIndex(r, { language: 'de' });
  const hits = search.search(idx, question, { top: 20, mmr: true, mmrLambda: 0.7 });
  const i = hits.findIndex((h) => h.entry?.id === 'ZIEL');
  return { rank: i === -1 ? null : i + 1, score: i === -1 ? 0 : hits[i].score };
};

/** Which single words of the question reach the target on their own? */
const reachingWords = (r, question) => {
  const idx = search.buildIndex(r, { language: 'de' });
  return question.split(' ').filter((w) => {
    const hits = search.search(idx, w, { top: 5 });
    return hits.some((h) => h.entry?.id === 'ZIEL');
  });
};

test('an asked-word makes the entry far easier to reach, and the fixture says by how much', () => {
  // **This test asserted something false until 2026-09-20.** It claimed
  // the target is NOT findable without asked-words, and its positive
  // control checked exactly that. Measured: `loeschfrist` alone finds
  // the target at rank 1 without any asked-word, because the thesaurus
  // bridges it to the entry's own wording. The fixture's comment — "not
  // one of these words is in the entry" — is true about the LETTERS and
  // false about the retrieval.
  //
  // It passed anyway, because the coordination multiplier used to
  // annihilate that weak-but-real signal: one typed word covered out of
  // six left a factor of 1/6, and the entry fell out of the top twenty.
  // When the multiplier got a floor, the suppressed signal reappeared
  // and this test failed — correctly. It was green because a defect
  // elsewhere happened to make its premise look true.
  //
  // So it now measures the EFFECT instead of asserting a binary, and it
  // verifies its own premise rather than stating it in a comment.
  const QUESTION = 'welche loeschfrist gilt bei uns wegen dsgvo';
  const without = build({ withAsked: false });
  const with_ = build({ withAsked: true });
  try {
    const a = rankOf(without, QUESTION);
    const b = rankOf(with_, QUESTION);

    // The premise, measured rather than assumed: without the field only
    // the thesaurus bridge reaches the entry, and `dsgvo` — the word the
    // entry genuinely has no path to — does not.
    const wa = reachingWords(without, QUESTION);
    const wb = reachingWords(with_, QUESTION);
    assert.ok(!wa.includes('dsgvo'),
      `'dsgvo' already reaches the target without asked-words (${wa.join(', ')}) — `
      + 'the fixture no longer isolates what the field contributes');
    assert.ok(wb.includes('dsgvo'),
      `'dsgvo' does not reach the target even WITH asked-words (${wb.join(', ')})`);
    assert.ok(wb.length > wa.length,
      `asked-words did not widen the ways in: ${wa.length} -> ${wb.length}`);

    // And the effect on the whole question. Both arms rank first here —
    // the corpus is small — so rank alone would prove nothing. The score
    // is what moved: 1.87 -> 8.35 when this was written.
    assert.ok(b.rank !== null, 'with asked-words the target is not found at all');
    assert.ok(b.score > a.score * 2,
      `asked-words barely changed the score: ${a.score.toFixed(2)} -> ${b.score.toFixed(2)} `
      + '(expected at least a doubling)');
  } finally {
    fs.rmSync(without, { recursive: true, force: true });
    fs.rmSync(with_, { recursive: true, force: true });
  }
});

test('`mem log --asked` stores a list, not a string', () => {
  // Stored as a string the field would still be indexed, but `mem show`
  // and every later evaluation would see one word instead of three. The
  // same class as `--origin`, which meant nothing at all once stored
  // flat.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-asked-cli-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    execFileSync('node', [MEM, '--root', r, 'log', 'decision',
      '--topic', 'aufbewahrung', '--choice', 'dreissig tage',
      '--asked', 'loeschfrist, dsgvo , speicherdauer'], { stdio: 'ignore' });
    const line = fs.readFileSync(path.join(r, 'global', 'decisions.jsonl'), 'utf8')
      .split('\n').filter(Boolean).pop();
    const e = JSON.parse(line);
    assert.deepEqual(e.asked, ['loeschfrist', 'dsgvo', 'speicherdauer'],
      `--asked was not stored as a list: ${JSON.stringify(e.asked)}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('asked-words weigh like tags, never more than the title', () => {
  // A field the digester GUESSES must not override what the entry is
  // actually about. If that order ever reads differently, it is a
  // decision and not a detail.
  assert.equal(search.FIELD_WEIGHTS.asked, search.FIELD_WEIGHTS.tags,
    'asked-words no longer weigh like tags');
  assert.ok(search.FIELD_WEIGHTS.asked < search.FIELD_WEIGHTS.title,
    'asked-words weigh more than the title');
});

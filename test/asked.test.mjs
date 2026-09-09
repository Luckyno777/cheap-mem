// Asked-words: the one field holding words that are NOT in the entry.
//
// The digester writes them while condensing — three to five words
// somebody would SEARCH with months later, without knowing the entry's
// own wording. That is the answer to paraphrase that stays true to the
// design: the work happens on lane 2, where a model runs anyway, and
// costs nothing at retrieval time. Embeddings cost one call per QUERY;
// this costs one per digest run.
//
// Measured on the eval corpus (eval/frageworte-wirkung.mjs): gold in
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
    // Not one of these words is in the entry — that is exactly the point.
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

test('an asked-word finds the entry whose words the question does not know', () => {
  const QUESTION = 'welche loeschfrist gilt bei uns wegen dsgvo';
  const without = build({ withAsked: false });
  const with_ = build({ withAsked: true });
  try {
    const a = rankOf(without, QUESTION);
    const b = rankOf(with_, QUESTION);
    // Positive control: without the field the entry must NOT be
    // findable — otherwise the assertion below proves nothing. The
    // question deliberately shares no content word with the entry.
    assert.equal(a.rank, null,
      `the fixture finds the target even without asked-words (rank ${a.rank}, ${a.score.toFixed(2)}) — the test proves nothing`);
    assert.ok(b.rank !== null,
      'with asked-words the target is still not found');
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

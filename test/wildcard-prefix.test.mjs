// The `word*` prefix operator (P: star-search, cm side).
//
// Lucky asked whether a Windows-search-style prefix operator ("hoden*")
// would surface more results. This file proves the answer built for
// MANUAL search paths: `search.resolveWildcards()` + `search.expandWildcardPrefix()`,
// wired into `search()` via the new, optional `extraTerms` parameter.
//
// **What this file must prove, and in what order:**
//   1. A prefix finds a word starting with it that the literal query
//      would not have found ("data*" -> "datastore").
//   2. A prefix shorter than 3 chars (after normalization) is refused —
//      treated literally, with a note explaining why.
//   3. Expansion is capped, with a note, when more than the cap's worth
//      of terms share a prefix.
//   4. An exact, literally-typed word outranks a word only reached
//      through prefix expansion — the discount is real, not nominal.
//   5. THE GUARANTEE: `search()` called the way the automatic retrieval
//      hook calls it (`bin/mem-retrieve` -> `mem find "$PROMPT" --top N
//      --json`, no `--wildcard`, no `extraTerms`) returns byte-identical
//      rankings before and after this change, for a query that itself
//      contains a literal `*`. Pinned against a fixed commit (rule 12),
//      not against a moving merge-base.
//
// invariant: stern-suche-hook-unveraendert
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { oldModuleCopy } from './helpers/old-source-copy.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as memory from '../src/memory.mjs';
import {
  search, loadIndex, resolveWildcards, expandWildcardPrefix,
  WILDCARD_MIN_PREFIX, WILDCARD_CAP,
} from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

// The commit this branch started from (pinned, per rule 12 — never
// `git merge-base HEAD origin/main`, which moves after a merge).
const PRE_WILDCARD_COMMIT = '6367323';

function freshRoot(prefix = 'cm-wildcard-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync(process.execPath, [MEM, 'init'], {
    env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: 'ignore',
  });
  return root;
}

test('prefix finds the compound-start ("data*" finds "datastore")', () => {
  const root = freshRoot();
  memory.logEntry(root, 'learning', {
    title: 'the new datastore', text: 'the datastore replaced the old flat files', tags: ['storage'],
  });
  memory.logEntry(root, 'learning', {
    title: 'unrelated', text: 'the deploy pipeline runs on friday afternoons', tags: ['noise'],
  });
  const index = loadIndex(root, { fresh: true });

  const resolved = resolveWildcards(index, 'data*');
  assert.equal(resolved.hadWildcard, true);
  assert.equal(resolved.query, 'data', 'the star is stripped, the bare prefix stays a literal word too');
  assert.ok([...resolved.extraTerms.keys()].some((t) => t.startsWith('data') && t !== 'data'),
    `expected an expanded term starting with "data", got: ${[...resolved.extraTerms.keys()]}`);

  const hits = search(index, resolved.query, { extraTerms: resolved.extraTerms, top: 10 });
  assert.ok(hits.some((h) => /datastore/.test(h.entry.text ?? '')),
    'the datastore entry must be found through the prefix expansion');
});

test('a prefix shorter than the minimum is treated literally, with a note', () => {
  const root = freshRoot();
  memory.logEntry(root, 'learning', { title: 'ab is a real word here', text: 'ab', tags: ['short'] });
  const index = loadIndex(root, { fresh: true });

  const resolved = resolveWildcards(index, 'ab*');
  assert.ok(resolved.extraTerms.size === 0, 'too short: no expansion terms');
  assert.equal(resolved.query, 'ab');
  assert.ok(resolved.notes.some((n) => n.includes(`shorter than ${WILDCARD_MIN_PREFIX}`)),
    `expected a "too short" note, got: ${JSON.stringify(resolved.notes)}`);

  // And it must not crash search() — a literal 2-letter word is still a
  // legal (if usually stopword-filtered) query.
  assert.doesNotThrow(() => search(index, resolved.query, { extraTerms: resolved.extraTerms }));
});

test('expansion is capped, with a note', () => {
  const root = freshRoot();
  for (let i = 0; i < WILDCARD_CAP + 15; i += 1) {
    memory.logEntry(root, 'learning', { title: `capword${i} entry`, text: `capword${i}`, tags: ['cap'] });
  }
  const index = loadIndex(root, { fresh: true });

  const { terms, capped, total } = expandWildcardPrefix(index, 'capword');
  assert.equal(capped, true);
  assert.ok(total > WILDCARD_CAP, `expected more than ${WILDCARD_CAP} matching terms, saw ${total}`);
  assert.equal(terms.length, WILDCARD_CAP);

  const resolved = resolveWildcards(index, 'capword*');
  assert.ok(resolved.notes.some((n) => n.includes('capped') && n.includes(String(WILDCARD_CAP))),
    `expected a cap note, got: ${JSON.stringify(resolved.notes)}`);
});

test('an exact typed word outranks a word only reached by prefix expansion', () => {
  const root = freshRoot();
  // Same template on both sides, so the only variable is exact-word vs
  // expansion-only-word — not field placement, not term-frequency, not
  // how many indexed forms one word happens to produce. "run*" resolves
  // to the literal word "run" plus the single expansion term "runbook"
  // (no compound split without a lexicon entry for "run"/"book" on their
  // own, so this stays exactly one expanded term, not a stack of them).
  const exact = memory.logEntry(root, 'learning', {
    title: 'run the report today', text: 'we run the report every morning without fail',
    tags: ['ordering'],
  });
  const expandedOnly = memory.logEntry(root, 'learning', {
    title: 'runbook the report today', text: 'we runbook the report every morning without fail',
    tags: ['ordering'],
  });
  const index = loadIndex(root, { fresh: true });

  const resolved = resolveWildcards(index, 'run*');
  // The prefix match naturally includes the bare prefix itself ("run"
  // starts with "run") — harmless, because `search()`'s scoring loop
  // skips any expansion term already in the typed set (`ownSet`), same
  // rule as the thesaurus. "runbook" is the one genuine EXPANSION term.
  assert.ok(resolved.extraTerms.has('runbook'), `expected "runbook" among: ${[...resolved.extraTerms.keys()]}`);
  const hits = search(index, resolved.query, { extraTerms: resolved.extraTerms, top: 10 });

  const exactId = exact?.id ?? exact?.entry?.id;
  const expandedId = expandedOnly?.id ?? expandedOnly?.entry?.id;
  const scoreOf = (id) => hits.find((h) => h.entry?.id === id)?.score ?? -Infinity;
  const exactScore = scoreOf(exactId);
  const expandedScore = scoreOf(expandedId);
  assert.ok(exactScore > -Infinity, 'the exact-word entry must be found at all');
  assert.ok(expandedScore > -Infinity, 'the expansion-only entry must be found at all');
  assert.ok(exactScore > expandedScore,
    `exact (${exactScore}) must outrank expansion-only (${expandedScore})`);
});

// --- The guarantee: the automatic hook's ranking is unaffected -------
//
// `bin/mem-retrieve` shells out to exactly `mem find "$PROMPT" --top N
// --json` — no `--wildcard`. `src/cli/commands/search.mjs`'s ranked lane
// therefore calls `search.search(index, query, {...})` with no
// `extraTerms` and an UNMODIFIED `query`, whatever `$PROMPT` contains —
// including a literal `*`. This test proves that call is byte-identical
// (same hits, same scores, same order) to what the PRE-wildcard
// `search.mjs`, pinned at a fixed commit, returned for the same call.
test('the automatic retrieval hook: ranking for a query containing "*" is identical before/after', async () => {
  const root = freshRoot();
  memory.logEntry(root, 'learning', {
    title: 'star in the wild', text: 'the pattern hoden* appeared in the chat message itself',
    tags: ['literal-star'],
  });
  memory.logEntry(root, 'learning', {
    title: 'hodentraeger classification note', text: 'hodentraeger is an old German zoology term',
    tags: ['literal-star'],
  });
  const index = loadIndex(root, { fresh: true });
  const hookQuery = 'what did the note about hoden* say';

  // The AFTER ranking — exactly what the CLI's ranked lane does today
  // (no `--wildcard`, so no `resolveWildcards`, no `extraTerms`).
  const after = search(index, hookQuery, { top: 10, mmr: true });

  // The BEFORE ranking — the pristine, pre-wildcard `search.mjs`, loaded
  // from a fixed commit so this proof never drifts with history (rule
  // 12). Written to a throwaway directory, its own relative imports
  // (`./memory.mjs`, `./language.mjs`, ...) — none of which this change
  // touched — pointed at the live `src/`, so they resolve exactly as they
  // did back then. Never into the live `src/` itself: a file that exists
  // there for a moment breaks every parallel test that copies `src/`.
  const oldSrc = execFileSync('git', ['show', `${PRE_WILDCARD_COMMIT}:src/search.mjs`],
    { cwd: REPO, encoding: 'utf8' });
  const copy = oldModuleCopy(path.join(REPO, 'src'), 'search.mjs', oldSrc);
  const baselinePath = copy.file;
  let before;
  try {
    const old = await import(`${pathToFileURL(baselinePath).href}?bust=${Date.now()}`);
    const oldIndex = old.loadIndex(root, { fresh: true });
    before = old.search(oldIndex, hookQuery, { top: 10, mmr: true });
  } finally {
    fs.rmSync(copy.dir, { recursive: true, force: true });
  }

  assert.equal(before.length, after.length, 'hit count must be identical');
  for (let i = 0; i < before.length; i += 1) {
    // The pinned old search.mjs built `source` with path.relative (backslashes on Windows); the product
    // has stored "/" since (memory.asSource). Only that spelling is normalised -- file, line, score, order are not.
    assert.equal(after[i].source, String(before[i].source).split('\\').join('/'), `hit ${i} source must match`);
    assert.equal(after[i].line, before[i].line, `hit ${i} line must match`);
    assert.equal(after[i].score, before[i].score, `hit ${i} score must match exactly`);
  }
});

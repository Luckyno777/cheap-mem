// test/p11-correction-content-loss.test.mjs — P11, ported from lucky-mem.
//
// Finding (BAUPLAN-mem-admin_02.md, 2026-09-28): the correction
// `1rjpook3vead` REPLACED the decision `czorxreppel` wholesale (that is
// how `memory.correctionEntry()` has to work) and, in doing so, dropped
// Lucky's literal quote "2 Hoden". After that, no valid entry carried
// the word at all, and Lucky's own recall probe found nothing. This
// file rebuilds the case — without Lucky's own words, only a synthetic
// rare quote standing in for it (Task C).
//
// Guard: `search.lostCorrectionContent()` never BLOCKS (corrections are
// allowed to drop something wrong) — it only reports notable words of
// the predecessor missing from the successor: literal quotes (always
// notable) and rare content words (docFreq <= RARE_DF, the same
// tokenizer retrieval itself uses). `mem correction` warns on stderr;
// `src/doctor.mjs`'s `checkCorrectionContentLoss` (finding
// `correction-content-loss`) reports the same thing for the whole
// corpus.
//
// **Red proof.** Same fixed prior state as p11-gold-correction-chain.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { buildIndex, lostCorrectionContent } from '../src/search.mjs';
import { checkAll } from '../src/doctor.mjs';

const ROOT_REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRIOR_STATE = '3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d';

test('RED PROOF: the content-loss guard did not exist at the prior state', () => {
  const beforeSearch = execFileSync('git', ['show', `${PRIOR_STATE}:src/search.mjs`],
    { cwd: ROOT_REPO, encoding: 'utf8' });
  assert.ok(!beforeSearch.includes('lostCorrectionContent'),
    `lostCorrectionContent already existed at the prior state (${PRIOR_STATE})`);
  assert.ok(!beforeSearch.includes('quotedPhrases'),
    `quotedPhrases already existed at the prior state (${PRIOR_STATE})`);
  const beforeDoctor = execFileSync('git', ['show', `${PRIOR_STATE}:src/doctor.mjs`],
    { cwd: ROOT_REPO, encoding: 'utf8' });
  assert.ok(!beforeDoctor.includes('correction-content-loss'),
    `finding correction-content-loss already existed at the prior state (${PRIOR_STATE})`);
});

// --- pure function, a HAND-BUILT docFreq map — no indexing needed ------

function original(fields) { return { id: 'old1', ...fields }; }
function updated(fields) { return { id: 'new1', replaces_id: 'old1', ...fields }; }

test('a correction loses a rare quote -> lost=true, the quote is reported', () => {
  // Synthetic stand-in for the real case (czorxreppel -> 1rjpook3vead,
  // where the quote was "2 Hoden" — here an invented word in its place).
  const o = original({
    title: 'Shape of the dashboard shell: not like "two wobbly puddings" (Lucky\'s comparison)',
    text: 'A smooth sphere, no more pudding comparison.',
  });
  const n = updated({
    title: 'Shape of the dashboard shell: a thin wavering fog',
    text: 'A fog volume around every node that fades outward.',
  });
  const docFreq = new Map([['pudding', 1], ['sphere', 2], ['fog', 5], ['shape', 20], ['shell', 6]]);
  const r = lostCorrectionContent(o, n, { docFreq, rareDf: 3 });
  assert.equal(r.lost, true);
  assert.deepEqual(r.quotes, ['two wobbly puddings']);
});

test('POSITIVE CONTROL: the quote IS carried forward -> no warning', () => {
  const o = original({ title: 'Shape of the shell: not like "two wobbly puddings"' });
  const n = updated({ title: 'Shape of the shell, still not like "two wobbly puddings" — now fog' });
  const docFreq = new Map([['pudding', 1], ['shape', 20], ['shell', 6], ['fog', 5]]);
  const r = lostCorrectionContent(o, n, { docFreq, rareDf: 3 });
  assert.equal(r.lost, false, `should not have warned: ${JSON.stringify(r)}`);
});

test('a correction changes only everyday words (high df) -> no warning', () => {
  const o = original({ title: 'The server starts', text: 'the session was long' });
  const n = updated({ title: 'The service starts', text: 'the session was short' });
  // "server"/"service" and "long"/"short" are DELIBERATELY high-df here
  // — everyday words in the corpus, not rare ones.
  const docFreq = new Map([
    ['server', 50], ['service', 40], ['starts', 60], ['session', 80], ['long', 30], ['short', 25],
  ]);
  const r = lostCorrectionContent(o, n, { docFreq, rareDf: 3 });
  assert.equal(r.lost, false, `should not have warned: ${JSON.stringify(r)}`);
  assert.deepEqual(r.rareWords, []);
});

test('a closing correction (state discarded, no content of its own) is exempt', () => {
  // The guard only applies to a correction WITH content (Task B) —
  // `memory.isClosingCorrection()` is where callers (mem correction,
  // src/doctor.mjs) decide that, the same check `correctionEntry()`
  // uses internally.
  assert.equal(memory.isClosingCorrection({ replaces_id: 'x', state: 'discarded' }), true);
  assert.equal(memory.isClosingCorrection({ replaces_id: 'x', closes_id: 'y' }), true);
  assert.equal(
    memory.isClosingCorrection({ replaces_id: 'x', title: 'full content', text: 'y' }),
    false);
});

// --- integration: the real case rebuilt (Task C) ------------------------

function tempRoot() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p11-loss-'));
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({ language: 'en' }));
  return w;
}

function fillCorpus(w, n = 60) {
  const words = ['recall', 'digest', 'archive', 'corpus', 'journal', 'registry', 'gate', 'inbox'];
  for (let i = 0; i < n; i += 1) {
    const w1 = words[i % words.length];
    const w2 = words[(i * 3 + 1) % words.length];
    memory.logEntry(w, 'decision', {
      choice: `filler-${w1}`, title: `Decided ${w1} and ${w2}`, why: `chose ${w1}`,
    });
  }
}

test('real case rebuilt (synthetic): correction loses a quote -> warning + doctor finding', () => {
  const w = tempRoot();
  try {
    fillCorpus(w);
    const { entry: o } = memory.logEntry(w, 'decision', {
      choice: 'shell-shape', title: 'Dashboard shell: not like "two wobbly puddings" (comparison dropped)',
      why: 'a smooth sphere instead of a pudding comparison',
    });
    const { entry: n, old: back, closing } = memory.correctionEntry(w, 'decision', o.id, {
      choice: 'shell-shape', title: 'Dashboard shell: a thin wavering fog',
      why: 'a fog volume that fades outward',
    });
    assert.equal(closing, false, 'positive control: this is an ordinary content-carrying correction');
    assert.equal(back.id, o.id);

    const idx = buildIndex(w, { language: 'en' });
    const r = lostCorrectionContent(back, n, { docFreq: idx.docFreq });
    assert.equal(r.lost, true, `should have lost the quote: ${JSON.stringify(r)}`);
    assert.deepEqual(r.quotes, ['two wobbly puddings']);

    // And the SAME case surfaces in the doctor's whole-corpus finding.
    const result = checkAll(w);
    const f = result.findings.find((x) => x.name === 'correction-content-loss');
    assert.ok(f, 'checkAll should report a correction-content-loss finding');
    assert.equal(f.level, 'warn', `finding: ${f.text}`);
    assert.ok(f.text.includes(o.id) && f.text.includes(n.id),
      `finding text should name the id pair: ${f.text}`);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('POSITIVE CONTROL: a corpus with no content-carrying corrections stays good', () => {
  const w = tempRoot();
  try {
    fillCorpus(w, 10);
    const result = checkAll(w);
    const f = result.findings.find((x) => x.name === 'correction-content-loss');
    assert.ok(f, 'checkAll should still report the finding, even when it is good');
    assert.equal(f.level, 'good', `finding: ${f.text}`);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

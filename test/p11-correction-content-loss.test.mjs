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
  // A full config (participants included) so tests that spawn `bin/mem`
  // as a real process (the V11 CLI tests below) do not fail on
  // `requireConfig()` before they reach anything this file is testing.
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({
    version: 1,
    language: 'en',
    participants: { user: { role: 'the human', human: true }, session: 'an AI session' },
  }));
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

// --- V10: chain head (2026-09-29, ported from lucky-mem b4c84379) ------
//
// Ported from lucky-mem's `pruefeKorrekturInhalt` fix: the finding must
// compare against the entry that holds TODAY at the HEAD of the
// correction chain, not only the direct successor — otherwise a
// warning a LATER link already fixed can never clear.

const PRIOR_STATE_V10 = 'a39d798';

test('RED PROOF (V10): the chain-head walk did not exist at the prior state', () => {
  const beforeDoctor = execFileSync('git', ['show', `${PRIOR_STATE_V10}:src/doctor.mjs`],
    { cwd: ROOT_REPO, encoding: 'utf8' });
  assert.ok(!beforeDoctor.includes('correctionLossHits'),
    `correctionLossHits already existed at ${PRIOR_STATE_V10}`);
  assert.ok(!beforeDoctor.includes('headOf'),
    `the chain-head walk already existed at ${PRIOR_STATE_V10}`);
});

test('chain head: a LATER link restoring the quote clears the warning', () => {
  const w = tempRoot();
  try {
    fillCorpus(w);
    const { entry: o } = memory.logEntry(w, 'decision', {
      choice: 'shell-shape', title: 'Dashboard shell: not like "two wobbly puddings" (dropped)',
      why: 'a smooth sphere instead of a pudding comparison',
    });
    const { entry: n1 } = memory.correctionEntry(w, 'decision', o.id, {
      choice: 'shell-shape', title: 'Dashboard shell: a thin wavering fog', why: 'a fog volume',
    });
    // Before the later link: warning, same as the direct-successor case above.
    {
      const result = checkAll(w);
      const f = result.findings.find((x) => x.name === 'correction-content-loss');
      assert.equal(f.level, 'warn', `should warn before restoration: ${f.text}`);
    }
    // A SECOND correction, on top of n1, carries every word AND the
    // quote of the original forward again (not just the quote — a
    // rare word missing is "lost" too, see search.lostCorrectionContent).
    memory.correctionEntry(w, 'decision', n1.id, {
      choice: 'shell-shape',
      title: 'Dashboard shell: a thin wavering fog, restoring the record: '
        + 'not like "two wobbly puddings" (dropped)',
      why: 'a fog volume; restoring the record: a smooth sphere instead of a pudding comparison',
    });
    const result = checkAll(w);
    const f = result.findings.find((x) => x.name === 'correction-content-loss');
    assert.equal(f.level, 'good', `should clear once the head carries it again: ${f.text}`);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('chain head GEGENPROBE (positive control): a later link WITHOUT the quote leaves the warning', () => {
  const w = tempRoot();
  try {
    fillCorpus(w);
    const { entry: o } = memory.logEntry(w, 'decision', {
      choice: 'shell-shape', title: 'Dashboard shell: not like "two wobbly puddings" (dropped)',
      why: 'a smooth sphere instead of a pudding comparison',
    });
    const { entry: n1 } = memory.correctionEntry(w, 'decision', o.id, {
      choice: 'shell-shape', title: 'Dashboard shell: a thin wavering fog', why: 'a fog volume',
    });
    // A second link that STILL does not carry the quote — must stay warn.
    memory.correctionEntry(w, 'decision', n1.id, {
      choice: 'shell-shape', title: 'Dashboard shell: a thin wavering fog, slightly brighter',
      why: 'a fog volume, brighter at the core',
    });
    const result = checkAll(w);
    const f = result.findings.find((x) => x.name === 'correction-content-loss');
    assert.equal(f.level, 'warn', `should still warn: ${f.text}`);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

// --- V11: a human confirms a flagged loss as intentional ----------------
//
// `mem correction intended <old-id> <new-id> --reason "..."` — append-only
// (global/correction-intent.jsonl), never touches the correction chain.
// Requires a human writer (memory.agentDefault()/procedure.isHuman()) and
// refuses a pair that is not currently flagged.

const PRIOR_STATE_V11 = 'a39d798';

test('RED PROOF (V11): the confirmation journal did not exist at the prior state', () => {
  const beforeMemory = execFileSync('git', ['show', `${PRIOR_STATE_V11}:src/memory.mjs`],
    { cwd: ROOT_REPO, encoding: 'utf8' });
  assert.ok(!beforeMemory.includes('confirmCorrectionIntent'),
    `confirmCorrectionIntent already existed at ${PRIOR_STATE_V11}`);
  assert.ok(!beforeMemory.includes('correction-intent.jsonl'),
    `global/correction-intent.jsonl already existed at ${PRIOR_STATE_V11}`);
  const beforeWrite = execFileSync('git', ['show', `${PRIOR_STATE_V11}:src/cli/commands/write.mjs`],
    { cwd: ROOT_REPO, encoding: 'utf8' });
  assert.ok(!beforeWrite.includes("rest[0] === 'intended'"),
    `mem correction intended already existed at ${PRIOR_STATE_V11}`);
});

const MEM_BIN = path.join(ROOT_REPO, 'bin', 'mem');

function runMem(argv, root, env = {}) {
  return execFileSync('node', [MEM_BIN, ...argv], {
    cwd: ROOT_REPO,
    env: { ...process.env, CHEAP_MEM_ROOT: root, ...env },
    encoding: 'utf8',
  });
}

function runMemExpectFail(argv, root, env = {}) {
  try {
    runMem(argv, root, env);
    return null;
  } catch (e) {
    return e.stderr ?? String(e.message);
  }
}

function flaggedPair(w) {
  fillCorpus(w);
  const { entry: o } = memory.logEntry(w, 'decision', {
    choice: 'shell-shape', title: 'Dashboard shell: not like "two wobbly puddings" (dropped)',
    why: 'a smooth sphere instead of a pudding comparison',
  });
  const { entry: n } = memory.correctionEntry(w, 'decision', o.id, {
    choice: 'shell-shape', title: 'Dashboard shell: a thin wavering fog', why: 'a fog volume',
  });
  return { o, n };
}

test('confirm clears exactly that pair (POSITIVE CONTROL for the finding text: names both ids)', () => {
  const w = tempRoot();
  try {
    const { o, n } = flaggedPair(w);
    {
      const f = checkAll(w).findings.find((x) => x.name === 'correction-content-loss');
      assert.equal(f.level, 'warn', `should warn before confirming: ${f.text}`);
      assert.ok(f.text.includes(o.id) && f.text.includes(n.id));
    }
    const out = runMem(['correction', 'intended', o.id, n.id, '--reason', 'dropped a wrong comparison'],
      w, { HOME: os.tmpdir() });
    assert.ok(out.includes('Confirmed as intentional'), out);
    assert.ok(out.includes(`${o.id} -> ${n.id}`), out);

    const f = checkAll(w).findings.find((x) => x.name === 'correction-content-loss');
    assert.equal(f.level, 'good', `should clear once confirmed: ${f.text}`);
    assert.ok(f.text.includes('confirmed as intentional'), f.text);

    // Append-only: the confirmation is one line, and it names the pair.
    const lines = memory.correctionIntentConfirmations(w);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].old_id, o.id);
    assert.equal(lines[0].new_id, n.id);
    assert.equal(lines[0].reason, 'dropped a wrong comparison');
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('confirm on an UNFLAGGED pair is refused, and nothing is written', () => {
  const w = tempRoot();
  try {
    fillCorpus(w, 10);
    const before = memory.correctionIntentConfirmations(w);
    const errText = runMemExpectFail(['correction', 'intended', 'no-such-old', 'no-such-new'],
      w, { HOME: os.tmpdir() });
    assert.ok(errText, 'expected a non-zero exit');
    assert.ok(errText.includes('not currently flagged'), errText);
    const after = memory.correctionIntentConfirmations(w);
    assert.deepEqual(after, before, 'an unflagged confirmation must not write anything');
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('confirm from an AGENT writer is refused (CHEAP_MEM_AGENT set, not human:<name>)', () => {
  const w = tempRoot();
  try {
    const { o, n } = flaggedPair(w);
    const errText = runMemExpectFail(['correction', 'intended', o.id, n.id],
      w, { HOME: os.tmpdir(), CHEAP_MEM_AGENT: 'some-connected-agent' });
    assert.ok(errText, 'expected a non-zero exit');
    assert.ok(errText.includes('not a human writer'), errText);
    assert.equal(memory.correctionIntentConfirmations(w).length, 0,
      'an agent writer must not be able to write a confirmation');
    // POSITIVE CONTROL: the same pair, same process, but a human writer
    // (no CHEAP_MEM_AGENT) DOES succeed — proves the probe can see a write.
    const out = runMem(['correction', 'intended', o.id, n.id], w, { HOME: os.tmpdir() });
    assert.ok(out.includes('Confirmed as intentional'), out);
    assert.equal(memory.correctionIntentConfirmations(w).length, 1);
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

test('append-only: confirming does not touch existing correction lines or an earlier confirmation', () => {
  const w = tempRoot();
  try {
    const { o, n } = flaggedPair(w);
    const decisionsBefore = fs.readFileSync(path.join(w, 'global', 'decisions.jsonl'), 'utf8');
    runMem(['correction', 'intended', o.id, n.id, '--reason', 'first'], w, { HOME: os.tmpdir() });
    const decisionsAfter = fs.readFileSync(path.join(w, 'global', 'decisions.jsonl'), 'utf8');
    assert.equal(decisionsAfter, decisionsBefore, 'confirming must never rewrite the correction chain');

    // Re-confirming the SAME pair is refused (already confirmed) — the
    // one line from the first confirm stays untouched.
    const journalBefore = fs.readFileSync(path.join(w, 'global', 'correction-intent.jsonl'), 'utf8');
    const errText = runMemExpectFail(['correction', 'intended', o.id, n.id, '--reason', 'second'],
      w, { HOME: os.tmpdir() });
    assert.ok(errText && errText.includes('already confirmed'), errText);
    const journalAfter = fs.readFileSync(path.join(w, 'global', 'correction-intent.jsonl'), 'utf8');
    assert.equal(journalAfter, journalBefore, 'a refused re-confirmation must not touch the journal');
  } finally {
    fs.rmSync(w, { recursive: true, force: true });
  }
});

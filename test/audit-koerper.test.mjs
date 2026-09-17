// What survives retrieval: the content, and the reason.
//
// **Where this comes from.** The external audit of 2026-09-17 wrote six
// entries, each carrying its content in the field its own type uses —
// `learning`, `duty`, `question`, `skill`, `excerpt`, `rule`. All six
// were indexed. Structured retrieval returned ONE, with an empty body,
// and discarded the other five as "identical body" — which was true,
// because every body was the empty string.
//
// Two defects in one shape: a projection that knew five field names
// while the indexer knew eighteen, and a de-duplication that treated
// "neither of us says anything" as "we both say the same thing".
//
// The second half of this file is the recall hook, where the same
// audit measured a decision whose documented reason never reached the
// context — appended, then cropped away — and a repeated question that
// stayed suppressed after the memory had changed.
//
// invariant: leer-ist-kein-bestehen
// invariant: eine-regel-eine-stelle
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as caps from '../src/capability.mjs';
import * as config from '../src/config.mjs';
import * as retrieval from '../src/retrieval.mjs';

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

/** The six typed fields from the audit, each in its own entry. */
const TYPISCH = {
  learning: 'learning', duty: 'duty', question: 'question',
  skill: 'skill', source: 'excerpt', procedure: 'rule',
};

function welt() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-koerper-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  config.writeConfig(root, config.DEFAULT_CONFIG);
  let i = 0;
  for (const [typ, feld] of Object.entries(TYPISCH)) {
    i += 1;
    memory.logEntry(root, typ, {
      id: `field${typ}`, [feld]: `quartz ${typ} essential payload`,
      // Verschiedene Verfasser: die Verfasser-Quote ist eine ANDERE,
      // richtige Abwehr (ein Autor darf die Antwort nicht fluten). Sie
      // hier mitzumessen wuerde diese Probe von einer Zahl abhaengig
      // machen, um die es nicht geht.
      agent: `auditor-${i}`, ts: '2026-09-01T10:00:00Z',
    });
  }
  return root;
}

test('POSITIVE: all six entries are really in the index', () => {
  const root = welt();
  try {
    assert.equal(search.buildIndex(root).documents.length, 6,
      'the fixture does not hold six documents');
  } finally { away(root); }
});

test('every typed content field reaches the claim', () => {
  const root = welt();
  try {
    const r = retrieval.retrieve(root, 'quartz', caps.grantAll(), { top: 20 });
    const bodies = new Map(r.claims.map((c) => [c.id, c.body]));
    for (const typ of Object.keys(TYPISCH)) {
      const body = bodies.get(`field${typ}`);
      assert.ok(body, `field${typ} did not come back at all `
        + `(excluded: ${JSON.stringify(r.excluded)})`);
      assert.match(body, new RegExp(`quartz ${typ} essential payload`),
        `field${typ} came back with a body that is not its content: ${JSON.stringify(body)}`);
    }
  } finally { away(root); }
});

test('an entry with nothing readable is a finding, not a duplicate', () => {
  // The old dedup hashed the empty string and called the second one a
  // copy of the first. Both statements were wrong in the same breath:
  // they were not copies, and the reason they looked alike was a bug in
  // the reader, not a property of the entries.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-leer-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    config.writeConfig(root, config.DEFAULT_CONFIG);
    // `tags` is indexed but deliberately not part of the body, so these
    // two are findable and have no readable content — exactly the shape.
    // (`note` is not a type: the vocabulary is closed and REFUSES an
    // unknown one, which is how this fixture was written the first time
    // and why it did not quietly create something else.)
    for (const id of ['leereins', 'leerzwei']) {
      memory.logEntry(root, 'event', { id, tags: ['quartz'], ts: '2026-09-01T10:00:00Z' });
    }
    const r = retrieval.retrieve(root, 'quartz', caps.grantAll(), { top: 20 });
    const gruende = r.excluded.map((e) => e.why).join(' | ');
    assert.equal(/identical body/.test(gruende), false,
      `empty bodies were called duplicates of each other: ${gruende}`);
    assert.match(gruende, /no readable content/,
      `the empty entries were not reported as a finding: ${gruende}`);
  } finally { away(root); }
});

test('the two field lists together cover everything the indexer knows', () => {
  // THE probe of this file. The defect was not that six names were
  // missing — it was that nobody could tell they were missing, because
  // the projection and the indexer never had to agree. A nineteenth
  // indexed field now has to be sorted into one of the two lists, and
  // the diff shows which.
  const gelesen = new Set(retrieval.KOERPER_FELDER);
  const bewusstNicht = new Set(retrieval.NICHT_KOERPER);
  const fehlend = Object.keys(search.FIELD_WEIGHTS)
    .filter((f) => !gelesen.has(f) && !bewusstNicht.has(f));
  assert.deepEqual(fehlend, [],
    `indexed but neither read nor deliberately excluded: ${fehlend.join(', ')}`);
  // And the other direction: a body field that nothing indexes would be
  // read but never found, which is the same defect mirrored.
  const unbekannt = retrieval.KOERPER_FELDER.filter((f) => !(f in search.FIELD_WEIGHTS));
  assert.deepEqual(unbekannt, [], `read but not indexed: ${unbekannt.join(', ')}`);
  // No field in both lists — that would be a rule with two answers.
  const beides = retrieval.KOERPER_FELDER.filter((f) => bewusstNicht.has(f));
  assert.deepEqual(beides, [], `in both lists: ${beides.join(', ')}`);
});

// --- the recall hook --------------------------------------------------

function hookWelt() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-hook-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  config.writeConfig(root, config.DEFAULT_CONFIG);
  return root;
}
function hook(root, prompt, session) {
  const r = execFileSync('bash', [path.join(PKG, 'bin', 'mem-retrieve')], {
    input: JSON.stringify({ session_id: session, prompt }),
    encoding: 'utf8',
    env: {
      ...process.env, CHEAP_MEM_ROOT: root,
      MEM_RETRIEVE_NO_PULL: '1', MEM_RETRIEVE_MIN: '0',
      MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '',
    },
  });
  return r ? JSON.parse(r).hookSpecificOutput.additionalContext : null;
}

test('a long decision does not crop its own reason away', () => {
  // Measured by the audit: the choice repeated until it filled the
  // budget, the reason appended behind it, then the whole line cut at
  // 220. The comment in the hook says the reason is what decides
  // whether an old rule still binds — and the reason was the part that
  // went.
  const root = hookWelt();
  try {
    memory.logEntry(root, 'decision', {
      id: 'hookentry1',
      choice: `The payment-router ${'uses a documented stable policy. '.repeat(9)}`,
      why: 'ONLY BECAUSE THE CUSTOMER CANNOT ACCEPT JSON',
      ts: '2026-09-01T10:00:00Z',
    });
    const ctx = hook(root, 'What is the policy for the payment-router?', 'audit-a');
    assert.ok(ctx, 'nothing was injected at all');
    assert.match(ctx, /CUSTOMER CANNOT/, `the reason did not survive:\n${ctx}`);
    // And the statement is still there — a fix that kept the reason by
    // dropping the decision would be the same bug facing the other way.
    assert.match(ctx, /payment-router/, `the statement did not survive:\n${ctx}`);
  } finally { away(root); }
});

test('the same question after the memory changed is a new answer', () => {
  // The claim used to be taken on session + prompt, BEFORE the search,
  // and held for an hour. So the second ask was suppressed although the
  // memory now held something new — and a search that found nothing
  // still burned the claim.
  const root = hookWelt();
  try {
    memory.logEntry(root, 'decision', {
      id: 'hookentry1', choice: 'The payment-router uses policy A',
      why: 'because A was agreed', ts: '2026-09-01T10:00:00Z',
    });
    const frage = 'What is the policy for the payment-router?';
    const eins = hook(root, frage, 'audit-b');
    assert.ok(eins, 'the first ask injected nothing');

    // Identical registration of the SAME turn: one injection, not two.
    assert.equal(hook(root, frage, 'audit-b'), null,
      'the same turn was injected twice — the claim does not hold');

    memory.logEntry(root, 'event', {
      id: 'hookentry2', title: 'payment-router changed today',
      ts: '2026-09-02T10:00:00Z',
    });
    const zwei = hook(root, frage, 'audit-b');
    assert.ok(zwei, 'the memory changed and the same question stayed suppressed');
    assert.notEqual(zwei, eins, 'the second answer is byte-identical — then it should have been suppressed');
  } finally { away(root); }
});

test('a retrieval that finds nothing does not burn the turn', () => {
  const root = hookWelt();
  try {
    const frage = 'What is the policy for the payment-router?';
    assert.equal(hook(root, frage, 'audit-c'), null, 'an empty memory injected something');
    memory.logEntry(root, 'decision', {
      id: 'hookentry1', choice: 'The payment-router uses policy A',
      why: 'because A was agreed', ts: '2026-09-01T10:00:00Z',
    });
    assert.ok(hook(root, frage, 'audit-c'),
      'the failed attempt consumed the claim, so the repaired memory never arrived');
  } finally { away(root); }
});

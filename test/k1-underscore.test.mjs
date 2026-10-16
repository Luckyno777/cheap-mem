// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// K1 (port of the sibling house's finding, 10M gate 2026-10-10): an identifier with an underscore in the
// QUESTION is not found. The index keeps `a_b` as ONE term (`tokenizeGroupsMulti` splits on
// `[^\p{L}\p{N}_-]`); every question-side word cutter (`contentWords`, therefore `retrievalQuery`, and
// the H1 question split) cut the question at `_` and searched `absichlaech` + `keinnern` - terms no entry
// carries. The capital umlaut in the sibling's example was a red herring: lower-casing and the
// transliteration run on both sides alike.
//
// Paths with a question-side cutter: `mem find --content-words` (also the after-failure hook), the H1
// lever of the recall hook (`MEM_SEARCH_LEVERS=h1`), and the task query of the SubagentStart block.
//
// Narrowed on purpose (sibling commit "Unterstrich-Wortgrenze nur in der Suchanfrage"): text-against-text
// readers of `contentWords` (error fixes, neighbours, project check) keep their old cutting.
//
// Red proof: at BASE (origin/kette/cm when this was built) the question-side paths miss the entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as subagenttask from '../src/subagenttask.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = 'dc6b69d58cbc90e35827f62381897bc3abe8fee6';
const TARGET = 'k1-target';
// Escapes, not literals: no umlaut in source lines (test/f5-umlaut-riegel).
const IDENT_UP = 'ABSICHL\u00c4CH_KEINNERN';
const ASK = 'absichl\u00e4ch_keinnern';
const TASK = `Fix the lockfile writer crash around ${ASK} please.`;

function world(t, { errors = false } = {}) {
  const root = tempDir('cm-k1-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  // Decoys that say "deploy flag" far more often than the target does: without the identifier the
  // target cannot win.
  for (let i = 0; i < 24; i += 1) {
    memory.logEntry(root, 'decision', {
      id: `k1-decoy-${i}`, topic: `deploy flag rollout ${i}`,
      choice: `the deploy flag is set before the nightly deploy, step ${i}, deploy flag check`,
      why: `the deploy flag of step ${i} keeps the deploy flag state`,
    });
  }
  // Two decoys that say "gate" (the one rare word of the questions below) more often than the target.
  for (let i = 0; i < 2; i += 1) {
    memory.logEntry(root, 'decision', {
      id: `k1-gate-${i}`, topic: 'gate gate gate', choice: 'the gate of the gate pipeline', why: 'gate gate',
    });
  }
  memory.logEntry(root, 'decision', {
    id: TARGET, topic: 'gate', choice: `use ${IDENT_UP} once`, why: 'the gate needs it',
  });
  if (errors) {
    // The same trick for the error drawer (the only one a subagent is handed besides learnings).
    for (let i = 0; i < 12; i += 1) {
      memory.logEntry(root, 'error', {
        id: `k1-edecoy-${i}`, class: 'wrong-cause', title: `lockfile writer crash variant ${i}`,
        text: `the lockfile writer crash number ${i}: the lockfile writer crashes when the flag is set, lockfile writer`,
      });
    }
    memory.logEntry(root, 'error', {
      id: 'k1-error', class: 'wrong-cause', title: `${IDENT_UP} breaks the writer`,
      text: `the writer fails when ${IDENT_UP} is set`,
    });
  }
  return root;
}

function findIds(tree, root, query, flags, env = {}) {
  const r = spawnSync(process.execPath, [path.join(tree, 'bin', 'mem'), '--root', root, 'find', query, '--top', '3', '--json', ...flags], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, CHEAP_MEM_ROOT: '', MEM_SEARCH_LEVERS: '', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hits.map((h) => h.entry.id);
}

// --- A. the pure cutters ---------------------------------------------------

test('A1: retrievalQuery keeps an underscore identifier as ONE word, hyphen still cuts', () => {
  // the typed spelling goes on: the index normalises per language pack, a pre-written `ae` misses English entries
  assert.equal(search.retrievalQuery(`${ASK} deploy flag`), `${ASK} deploy flag`);
  assert.equal(search.retrievalQuery('session_id in the pull-request'), 'session_id pull request');
  // control: no underscore, nothing changes
  assert.equal(search.retrievalQuery('nightly deploy flag'), 'nightly deploy flag');
});

test('A2: the text-against-text reader keeps its old cutting (typed option off by default)', () => {
  assert.deepEqual(search.contentWords(`${ASK} deploy`), ['absichlaech', 'keinnern', 'deploy']);
  assert.deepEqual(search.contentWords(`${ASK} deploy`, { typed: true }), [ASK, 'deploy']);
  // the FILTER still looks at the `ae` spelling: a three-letter word with an umlaut is long enough as before
  assert.deepEqual(search.contentWords('f\u00fcr den test', { typed: true }), ['f\u00fcr', 'test']);
  assert.deepEqual(search.contentWords('f\u00fcr den test'), ['fuer', 'test']);
  // a lone underscore is no word
  assert.deepEqual(search.contentWords('_ __ deploy', { typed: true }), ['deploy']);
});

// --- B. the paths ------------------------------------------------------------

test('B1: find --content-words puts the entry first (positive control: plain find already does)', (t) => {
  const root = world(t);
  const q = `${ASK} gate`;
  assert.equal(findIds(REPO, root, ASK, [])[0], TARGET, 'control: the plain question finds it');
  assert.equal(findIds(REPO, root, q, ['--content-words'])[0], TARGET);
});

test('B2: the H1 question split of the recall hook call keeps the identifier', (t) => {
  const root = world(t);
  const q = `${ASK} gate`;
  assert.equal(findIds(REPO, root, q, ['--recall'], { MEM_SEARCH_LEVERS: 'h1' })[0], TARGET);
  // control: without the lever the plain query is searched as typed
  assert.equal(findIds(REPO, root, q, ['--recall'])[0], TARGET);
});

test('B3: the SubagentStart task query finds the error that carries the identifier', async (t) => {
  const root = world(t, { errors: true });
  const r = await subagenttask.forTask(root, { prompt: TASK },
    { env: { ...process.env, MEM_RETRIEVE_MIN: '0.5' } });
  assert.ok(r && r.ids.includes('k1-error'), JSON.stringify(r));
});

/** The real hook script of a tree: the ids it put into the context, in order. */
let turn = 0;
function hookOrder(tree, root, prompt, env = {}) {
  turn += 1; // a new session per call: the same block twice in one session is dropped (once per turn)
  const r = spawnSync('bash', [path.join(tree, 'bin', 'mem-retrieve')], {
    input: JSON.stringify({ session_id: `k1-${turn}`, prompt }), encoding: 'utf8', timeout: 120000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_NO_PULL: '1', MEM_RECALL_SERVER: '0',
      MEM_RETRIEVE_MIN: '0', MEM_RETRIEVE_TURNS: path.join(root, '.mem', `turns-k1-${turn}`), MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '',
      MEM_SEARCH_LEVERS: '', ...env },
  });
  let text = String(r.stdout ?? '');
  try { text = JSON.parse(text).hookSpecificOutput.additionalContext; } catch { /* nothing was said */ }
  return [...text.matchAll(/\[(k1-[a-z0-9-]+) /g)].map((m) => m[1]);
}

test('B4: the prompt hook script (lever h1 on) shows the entry first', (t) => {
  const root = world(t);
  assert.equal(hookOrder(REPO, root, `${ASK} gate`, { MEM_SEARCH_LEVERS: 'h1' })[0], TARGET);
  // control: with every lever off the hook searches the question as typed and shows it first too
  assert.equal(hookOrder(REPO, root, `${ASK} gate`, { MEM_SEARCH_LEVERS: 'off' })[0], TARGET);
});

// --- C. red proof against the base ---------------------------------------------

test('C: at BASE the question-side paths miss the entry (the probes above would fail there)', async (t) => {
  const old = tempDir('cm-k1-base-', t);
  exportCommit(REPO, BASE, ['bin', 'src', 'package.json'], old);
  const root = world(t, { errors: true });
  const q = `${ASK} gate`;
  const first = (flags, env) => findIds(old, root, q, flags, env)[0];
  assert.notEqual(first(['--content-words']), TARGET, 'base --content-words');
  assert.notEqual(first(['--recall'], { MEM_SEARCH_LEVERS: 'h1' }), TARGET, 'base h1');
  assert.notEqual(hookOrder(old, root, q, { MEM_SEARCH_LEVERS: 'h1' })[0], TARGET, 'base hook, h1');
  const oldTask = await import(pathToFileURL(path.join(old, 'src', 'subagenttask.mjs')).href);
  const r = await oldTask.forTask(root, { prompt: TASK },
    { env: { ...process.env, MEM_RETRIEVE_MIN: '0.5' } });
  assert.ok(!r || !r.ids.includes('k1-error'), 'base subagent');
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// K1 subwords (port of lucky-mem's `k1-teilwort-lm`, 2026-10-16): the parts of an identifier with an underscore in the
// QUESTION are searched too - but only while the index does not hold the whole word.
//
// Why: K1 (test/k1-underscore.test.mjs) keeps `a_b` in the question as ONE word, because the index holds it that way.
// The price (held there as probe D): the question `socket_closed_by_peer` no longer found the entry "the peer closed
// the socket". Rule now: the whole word keeps weight 1.0; its parts come beside it at 0.6 if the index does NOT know
// the whole word, at 0 (none) if it does (`session_id` must not pull in every `session` entry: that was K1).
//
// Probes:
//   A. whole word unknown: the prose entry is found (hook path, plain path, recall path), weaker than typed words;
//      coverage counts the word half.
//   B. whole word known: no part hits (the noise stays out). Positive control: the same noise comes for an unknown one.
//   C. nothing else moves: questions without an underscore, a known identifier and a hyphen answer as at the base.
//   D. `mem find` (CLI) and `mem_find` (MCP) answer the same, with and without parts.
//   E. RED at the base: the prose entry is not found there; the controls of the world are green on both sides.
//
// Windows view: temp dirs from os.tmpdir() (tempDir), no POSIX tools; the old code comes from `git ls-tree`/`cat-file`
// (exportCommit), pinned to a FIXED commit (never a moving merge-base).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
// abruf-budget-cm, the base of this build (the find core both doors share).
const BASE = '076542c15201409d4ed6aef965537dbcf8eaa08f';

const PROSE = 'k1s-prose';
const WHOLE = 'k1s-whole';
const NOISE = ['k1s-noise-0', 'k1s-noise-1', 'k1s-noise-2'];
const UNKNOWN_Q = 'socket_closed_by_peer';        // no entry holds it; one entry holds its words in prose
const KNOWN_Q = 'retry_budget_exceeded';          // one entry holds it whole; three hold its words in prose
const UNKNOWN_NOISY_Q = 'retry_budget_exceeded_again';  // the control: the same words, whole word unknown
const SHORT = 'k1s-short';                        // dense in a two-letter word: a part that short is filler
const SHORT_Q = 'db_socket_peer';

function world(t) {
  const root = tempDir('cm-k1s-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  // Filler, so the idf of a word means something and the hook bar is not met by accident.
  for (let i = 0; i < 24; i += 1) {
    memory.logEntry(root, 'decision', {
      id: `k1s-decoy-${i}`, topic: `deploy flag rollout ${i}`,
      choice: `the deploy flag is set before the nightly deploy, step ${i}, deploy flag check`,
      why: `the deploy flag of step ${i} keeps the deploy flag state`,
    });
  }
  memory.logEntry(root, 'error', {
    id: PROSE, class: 'wrong-cause', title: 'the peer closed the socket', text: 'the peer closed the socket while we wrote the frame',
  });
  memory.logEntry(root, 'error', {
    id: WHOLE, class: 'wrong-cause', title: `call failed with ${KNOWN_Q}`, text: `the call to ${KNOWN_Q} returned an error code`,
  });
  memory.logEntry(root, 'learning', { id: SHORT, title: 'db db db', text: 'db db db db db db db db db db' });
  // Dense prose that carries the PARTS of the known identifier: what the parts would drag in if they counted.
  for (let i = 0; i < NOISE.length; i += 1) {
    memory.logEntry(root, 'learning', {
      id: NOISE[i], title: `retry budget exceeded retry budget ${i}`,
      text: `retry the budget, the budget exceeded, retry retry budget exceeded budget, round ${i}`,
    });
  }
  return root;
}

function findJson(tree, root, query, flags = [], env = {}) {
  const r = spawnSync(process.execPath, [path.join(tree, 'bin', 'mem'), '--root', root, 'find', query, '--top', '8', '--json', ...flags], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, CHEAP_MEM_ROOT: '', MEM_SEARCH_LEVERS: '', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hits;
}
const ids = (hits) => hits.map((h) => h.entry.id);
const HOOK = ['--content-words', '--weak'];   // the after-failure hook's call
const scoreOf = (hits, id) => hits.find((h) => h.entry.id === id)?.score;

function mcpFind(codeDir, root, args) {
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_find', arguments: args } }),
  ];
  const r = spawnSync(process.execPath, [path.join(codeDir, 'bin', 'mem-mcp')], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 60000, env: { ...process.env, CHEAP_MEM_ROOT: root },
  });
  const reply = String(r.stdout).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === 2);
  const text = reply?.result?.content?.map((c) => c.text).join('\n') ?? '';
  return [...text.matchAll(/^(\S+:\d+)\s+\[[^\]]*\]\s+([\d.]+)/gm)].map((m) => `${m[1]}@${m[2]}`);
}
const cliKeys = (hits) => hits.map((h) => `${h.source}:${h.line}@${h.score.toFixed(2)}`);

// --- A. the whole word is unknown: the parts find the prose entry --------------------------------------------------

test('A1: an identifier the index lacks finds the entry that carries its words - on the hook path, the plain path and the recall path', (t) => {
  const root = world(t);
  assert.equal(ids(findJson(REPO, root, UNKNOWN_Q, HOOK))[0], PROSE, 'hook path (--content-words --weak)');
  assert.equal(ids(findJson(REPO, root, UNKNOWN_Q))[0], PROSE, 'plain path');
  assert.equal(ids(findJson(REPO, root, UNKNOWN_Q, ['--recall']))[0], PROSE, 'recall path');
  // with filler words around, as an error message has
  assert.equal(ids(findJson(REPO, root, `error: ${UNKNOWN_Q} while writing`, HOOK))[0], PROSE, 'inside a sentence');
});

test('A2: the parts weigh LESS than the same words typed (0.6, never more than a typed word)', (t) => {
  const root = world(t);
  const viaParts = scoreOf(findJson(REPO, root, UNKNOWN_Q), PROSE);
  const typed = scoreOf(findJson(REPO, root, 'socket closed peer'), PROSE);
  assert.ok(viaParts > 0, 'found through the parts');
  assert.ok(viaParts < typed, `parts ${viaParts} < typed ${typed}`);
  // a clear gap, not a rounding one: 0.6 of the terms, coordination aside, is well under the typed score
  assert.ok(viaParts < typed * 0.85, `parts ${viaParts} are clearly under typed ${typed}`);
  // the identifier typed WITH its words counts the words once: the part words are the typed words, so no extra term
  const both = scoreOf(findJson(REPO, root, `${UNKNOWN_Q} socket closed peer`), PROSE);
  assert.ok(both > 0 && both <= typed * 1.05, `typed words stay worth what they were: ${both} vs ${typed}`);
});

test('A3: in coverage a word covered only by its parts counts HALF (like a bridged word), a typed word counts full', (t) => {
  const root = world(t);
  const index = search.buildIndex(root);
  const covered = (q) => search.search(index, q, { withCoverage: true, top: 8 }).find((h) => h.entry.id === PROSE)?.covered;
  assert.equal(covered(UNKNOWN_Q), 0.5);
  assert.equal(covered('socket closed peer'), 1);
  // one more typed word the entry does not carry: (0.5 + 0) / 2
  assert.equal(covered(`${UNKNOWN_Q} lockfile`), 0.25);
});

test('A4: a part of two letters is filler and is not searched; the rest of the identifier still is', (t) => {
  const root = world(t);
  const got = ids(findJson(REPO, root, SHORT_Q));
  assert.equal(got[0], PROSE, 'the other parts find the entry');
  assert.ok(!got.includes(SHORT), `the two-letter part \`db\` pulled nothing in: ${got.join(' ')}`);
  // control: typed as a word the entry dense in `db` does answer
  assert.ok(ids(findJson(REPO, root, 'db')).includes(SHORT), 'control: the entry is reachable by the word');
});

test('A5: the coordination factor counts the word half: score(coverage 1) / score(coverage 0) is floor + (1 - floor) * 0.75', (t) => {
  const root = world(t);
  const index = search.buildIndex(root);
  const q = `${UNKNOWN_Q} frame`;     // the entry carries `frame` (typed, full) and the parts of the identifier (half)
  const at = (coverage) => search.search(index, q, { coverage, top: 8 }).find((h) => h.entry.id === PROSE)?.score;
  const ratio = at(1) / at(0);
  const expected = search.COVERAGE_FLOOR + (1 - search.COVERAGE_FLOOR) * 0.75;
  assert.ok(Math.abs(ratio - expected) < 1e-9, `${ratio} vs ${expected}`);
});

test('A6: two unknown identifiers that share a part count the part ONCE (the maximum per term, not a sum per word)', (t) => {
  const root = world(t);
  const index = search.buildIndex(root);
  const score = (q) => search.search(index, q, { coverage: 0, top: 8 }).find((h) => h.entry.id === PROSE)?.score;
  const one = score('socket_closed_by_peer');
  const same = score('socket_closed_by_peer socket_closed_by_peer');
  const shared = score('socket_closed_by_peer socket_closed_by_host');
  // the same identifier twice adds nothing; a second one adds only its OWN parts (`host` is in no entry)
  assert.ok(Math.abs(same - one) < 1e-9, `${same} vs ${one}`);
  assert.ok(Math.abs(shared - one) < 1e-9, `shared parts counted once: ${shared} vs ${one}`);
  // control: a second identifier with a part of its own that the entry carries DOES add (`frame`)
  const own = score('socket_closed_by_peer frame_host_zzz');
  assert.ok(own > one + 1e-9, `an own part still counts: ${own} vs ${one}`);
});

// --- B. the whole word is known: no parts ------------------------------------------------------------------------

test('B1: an identifier the index HOLDS finds the entry that carries it, and ONLY that one (no part hits on prose)', (t) => {
  const root = world(t);
  assert.deepEqual(ids(findJson(REPO, root, KNOWN_Q, HOOK)), [WHOLE], 'hook path');
  assert.deepEqual(ids(findJson(REPO, root, KNOWN_Q)), [WHOLE], 'plain path');
  // positive control: the SAME words typed as words do find the dense prose entries
  const typed = ids(findJson(REPO, root, 'retry budget exceeded'));
  for (const n of NOISE) assert.ok(typed.includes(n), `control: ${n} answers the typed words`);
});

test('B2: control - the same words behind an identifier the index lacks DO drag the dense prose in (so B1 proves the switch)', (t) => {
  const root = world(t);
  const got = ids(findJson(REPO, root, UNKNOWN_NOISY_Q, HOOK));
  for (const n of NOISE) assert.ok(got.includes(n), `${n} comes in through the parts: ${got.join(' ')}`);
});

// --- C. nothing else moves ---------------------------------------------------------------------------------------

test('C: questions without an underscore, a hyphen word and a known identifier answer EXACTLY as at the base (ids, order, scores)', (t) => {
  const root = world(t);
  const old = tempDir('cm-k1s-base-', t);
  exportCommit(REPO, BASE, ['src', 'bin', 'package.json'], old);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules'), 'junction');
  const qs = [
    'socket closed peer', 'retry budget exceeded', 'deploy flag rollout', 'pull-request socket', 'nightly deploy-flag check',
    KNOWN_Q, `${KNOWN_Q} deploy`, 'unrelated words only', '_ __ deploy',
  ];
  for (const q of qs) {
    for (const flags of [[], HOOK]) {
      assert.deepEqual(cliKeys(findJson(REPO, root, q, flags)), cliKeys(findJson(old, root, q, flags)), `${q} ${flags.join(' ')}`);
    }
  }
  // a part that is also typed: the typed word is not counted twice
  const tw = `${UNKNOWN_Q} socket`;
  assert.ok(scoreOf(findJson(REPO, root, tw), PROSE) > 0);
});

// --- D. CLI and MCP --------------------------------------------------------------------------------------------

test('D: `mem find` and `mem_find` answer the same for an unknown identifier, a known one and a mixed question', (t) => {
  const root = world(t);
  for (const q of [UNKNOWN_Q, KNOWN_Q, UNKNOWN_NOISY_Q, `error: ${UNKNOWN_Q} after ${KNOWN_Q}`]) {
    const cli = cliKeys(findJson(REPO, root, q));
    const mcp = mcpFind(REPO, root, { query: q, top: 8 });
    assert.ok(cli.length >= 1, `finds something: ${q}`);
    assert.deepEqual(mcp, cli.slice(0, mcp.length), q);
    assert.ok(mcp.length >= Math.min(cli.length, 3), `the tool lists what the CLI lists: ${q}`);
  }
  // and the unknown identifier is found over MCP at all (not only by the CLI)
  assert.match(mcpFind(REPO, root, { query: UNKNOWN_Q, top: 3 })[0] ?? '', /\.jsonl:\d+@\d/);
});

// --- E. RED at the base ----------------------------------------------------------------------------------------

test('E: RED at the base - there the prose entry is NOT found for the unknown identifier (the controls are green on both sides)', (t) => {
  const root = world(t);
  const old = tempDir('cm-k1s-red-', t);
  exportCommit(REPO, BASE, ['src', 'bin', 'package.json'], old);
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules'), 'junction');
  // red: base finds neither on the hook path nor on the plain path
  assert.ok(!ids(findJson(old, root, UNKNOWN_Q, HOOK)).includes(PROSE), 'base, hook path');
  assert.ok(!ids(findJson(old, root, UNKNOWN_Q)).includes(PROSE), 'base, plain path');
  assert.ok(!ids(findJson(old, root, UNKNOWN_NOISY_Q, HOOK)).includes(NOISE[0]), 'base, noise control');
  // positive controls: the same entry is there and is found by its words on BOTH sides; the known identifier is found
  // on both sides, and alone
  for (const tree of [old, REPO]) {
    assert.equal(ids(findJson(tree, root, 'socket closed peer'))[0], PROSE, `control: words find it (${tree === old ? 'base' : 'head'})`);
    assert.deepEqual(ids(findJson(tree, root, KNOWN_Q, HOOK)), [WHOLE], `control: known identifier (${tree === old ? 'base' : 'head'})`);
  }
  // green at the head: the same call
  assert.equal(ids(findJson(REPO, root, UNKNOWN_Q, HOOK))[0], PROSE);
});

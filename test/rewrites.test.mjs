// test/rewrites.test.mjs — the learned rewrite table (src/rewrites.mjs,
// src/rewritecare.mjs, `mem rewrites`), the port of lucky-mem's
// "Umschreibungstabelle".
//
// The probe: an everyday question ("took money twice") misses the entry
// written in the trade's words ("billed", "charge"). With an ACTIVE pair
// (two independent sessions of evidence) it is the first hit; with one
// session, the switch off, a decayed or a locked pair it misses again.
// Positive control: the rank without any table is "not found", so the
// probe sees something. The end-to-end case runs the real evidence path:
// two sessions miss, fetch the entry by id, `care` turns that into pairs,
// and a DIFFERENT entry carrying the same characteristic stems becomes
// reachable by the everyday word — the generalisation over asked-learn.
// Red on the tree before this branch (deca5ad): no module, the import fails.
// invariant: lieber-nichts-als-falsches
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as raw from '../src/raw.mjs';
import * as injection from '../src/injection.mjs';
import * as rw from '../src/rewrites.mjs';
import * as care from '../src/rewritecare.mjs';
import { loadIndex, search } from '../src/search.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DAY = 24 * 60 * 60 * 1000;

function memoryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rewrites-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ version: 1, language: 'en', participants: { user: 'u' } }));
  const t = new Date(NOW - 30 * DAY);
  memory.logEntry(root, 'error', { id: 'ebilled0001', class: 'bug', title: 'Shopper billed twice by a duplicate charge', text: 'two quick clicks made two charges; an idempotency key prevents it' }, { now: t });
  memory.logEntry(root, 'error', { id: 'eredis00001', class: 'outage', title: 'Redis cache evicted the catalog under load', text: 'maxmemory policy was wrong' }, { now: t });
  for (let i = 0; i < 40; i += 1) {
    memory.logEntry(root, 'learning', { id: `lfill${String(i).padStart(6, '0')}`, title: `filler note ${i} about deploys`, learning: 'nothing to see' }, { now: t });
  }
  return root;
}

const rankOf = (root, q, re) => search(loadIndex(root, { fresh: true }), q, { top: 3, noRaw: true })
  .findIndex((h) => re.test(h.entry.title ?? ''));
const BILLED = /billed twice/;

const pairLine = (from, to, sessions, last = iso(NOW - DAY)) => ({
  kind: 'pair', ts: iso(NOW), from, to, sessions, evidence: sessions.map((s) => ({ kind: 'asked-learn', place: `j:${s}`, ts: last })), last,
});

test('PROBE: an active pair makes the everyday word find the trade-word entry; the original still wins', () => {
  const root = memoryRoot();
  try {
    rw._clearCache();
    assert.equal(rankOf(root, 'money', BILLED), -1, 'positive control: without a table the everyday word misses');
    rw.append(root, pairLine('money', 'bill', ['s1', 's2']));
    assert.equal(rankOf(root, 'money', BILLED), 0, 'with an active pair it is the first hit');
    // Weight below the original: a note that HAS the typed word beats one
    // reached only through the table.
    memory.logEntry(root, 'learning', { id: 'lmoney00001', title: 'Money is stored in cents', learning: 'never as a float' }, { now: new Date(NOW - DAY) });
    const hits = search(loadIndex(root, { fresh: true }), 'money', { top: 3, noRaw: true }).map((h) => h.entry.id);
    assert.ok(hits.indexOf('lmoney00001') >= 0 && hits.indexOf('lmoney00001') < hits.indexOf('ebilled0001'), hits.join(','));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('one session, the switch off, a decayed or a locked pair: no effect', () => {
  const root = memoryRoot();
  try {
    rw._clearCache();
    rw.append(root, pairLine('money', 'bill', ['s1']));
    assert.equal(rw.active(root).size, 0, 'one session is a whim, not usage');
    assert.equal(rankOf(root, 'money', BILLED), -1);
    rw.append(root, pairLine('money', 'bill', ['s1', 's2'], iso(NOW - (rw.DECAY_DAYS + 1) * DAY)));
    assert.equal(rw.stateOf([...rw.folded(root).values()][0]), rw.STATE.DECAYED);
    assert.equal(rankOf(root, 'money', BILLED), -1, 'decayed');
    rw.append(root, pairLine('money', 'bill', ['s1', 's2']));
    assert.equal(rw.active(root).size, 1);
    assert.equal(rw.active(root, { env: { [rw.ENV]: 'off' } }).size, 0, 'kill switch');
    assert.equal(rw.lock(root, 'money', 'bill', 'wrong sense').written, true);
    assert.equal(rankOf(root, 'money', BILLED), -1, 'locked');
    assert.equal(rw.unlock(root, 'money', 'bill').written, true);
    assert.equal(rankOf(root, 'money', BILLED), 0, 'unlocked again');
    assert.equal(rw.lock(root, 'nope', 'none').reason, 'unknown-pair');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('at most TARGETS_MAX targets per question word; broken lines are skipped', () => {
  const root = memoryRoot();
  try {
    rw._clearCache();
    for (const to of ['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee', 'ffff']) rw.append(root, pairLine('money', to, ['s1', 's2']));
    fs.appendFileSync(path.join(root, rw.FILE), '{not json\n');
    assert.equal(rw.active(root).get('money').length, rw.TARGETS_MAX);
    assert.ok(rw.active(root).get('money').every((x) => x.weight === rw.WEIGHT && x.weight < 0.6));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/** One session: an everyday question, then the session fetching the entry by id. */
function session(root, name, at, question) {
  const lines = [
    { type: 'user', sessionId: name, timestamp: iso(at), promptId: 'p1', message: { role: 'user', content: question } },
    { type: 'assistant', sessionId: name, timestamp: iso(at + 60_000), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'mem show ebilled0001' } }] } },
  ];
  const tr = path.join(root, `${name}.jsonl`);
  fs.writeFileSync(tr, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(raw.capture(root, tr, { minBytes: 0 }).status, 'captured');
  injection.book(root, { ts: iso(at).replace(/\.\d{3}Z$/, 'Z'), session: name, occasion: injection.OCCASION.QUESTION, reason: injection.REASON.TOO_WEAK, sources: [] });
}

test('END TO END: two sessions of vetted misses -> care -> an active pair that reaches another entry', () => {
  const root = memoryRoot();
  try {
    rw._clearCache();
    const q = 'somebody paid twice, where is that writeup';
    session(root, 'sess-1', NOW - 3 * DAY, q);
    const one = care.care(root, { write: true });
    assert.ok(one.written > 0, JSON.stringify(one));
    assert.equal(rw.active(root).size, 0, 'one session: written, but waiting');
    session(root, 'sess-2', NOW - 2 * DAY, q);
    const before = fs.readFileSync(path.join(root, rw.FILE), 'utf8');
    const two = care.care(root, { write: true });
    assert.ok(two.written > 0);
    assert.ok(fs.readFileSync(path.join(root, rw.FILE), 'utf8').startsWith(before), 'append-only: no line rewritten');
    const act = rw.active(root);
    assert.ok(act.has('paid'), [...act.keys()].join(','));
    const targets = act.get('paid').map((x) => x.to);
    assert.equal(care.care(root, { write: true }).written, 0, 'idempotent: nothing new, nothing written');
    // Generalisation: a second, never-fetched entry carrying the same
    // characteristic stems, but not the word "paid", is now reachable.
    memory.logEntry(root, 'error', { id: 'eother00001', class: 'bug', title: `Refund job hit the same ${targets.join(' ')} path`, text: 'retry storm' }, { now: new Date(NOW - DAY) });
    const ids = search(loadIndex(root, { fresh: true }), 'paid', { top: 5, noRaw: true }).map((h) => h.entry.id);
    assert.ok(ids.includes('eother00001'), `${targets} -> ${ids}`);
    assert.equal(rw.active(root, { env: { [rw.ENV]: 'off' } }).size, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('care drops stemmer splits (pays -> pay, payment is morphology, not a rewrite)', () => {
  const idx = { statsN: 10, statsDocFreq: new Map(), documents: [{ type: 'error', entry: { id: 'x1' }, weights: new Map([['pay', 3], ['payment', 3], ['charge', 2]]) }] };
  const pairs = care.pairsFromCases(idx, [{ session: 's', journal: 'j:1', ts: iso(NOW), entry: { id: 'x1' }, words: ['pays'] }]);
  const tos = [...pairs.values()].map((p) => p.to);
  assert.ok(!tos.includes('pay') && !tos.includes('payment'), tos.join(','));
});

test('CLI: mem rewrites lists, care is a dry run without --write, lock refuses an unknown pair', () => {
  const root = memoryRoot();
  try {
    const run = (...a) => spawnSync(process.execPath, [BIN, '--root', root, ...a], { encoding: 'utf8' });
    let r = run('rewrites');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /REWRITE TABLE: 0 pair/);
    r = run('rewrites', 'care');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(root, rw.FILE)), 'dry run writes nothing');
    r = run('rewrites', 'lock', 'a', 'b');
    assert.notEqual(r.status, 0);
    rw.append(root, pairLine('money', 'bill', ['s1', 's2']));
    r = run('rewrites', 'lock', 'money', 'bill', '--reason', 'test');
    assert.equal(r.status, 0, r.stderr);
    assert.match(run('rewrites').stdout, /locked\s+money -> bill/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

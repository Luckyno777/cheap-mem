#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/subword-measure.mjs - k1-subword-cm (2026-10-17): the parts of an identifier with an underscore in the QUESTION.
//
// Port of lucky-mem's `bench/teilwort-messung.mjs`. A gauge, not a test (the probe: test/k1-subword.test.mjs).
//
//     node bench/subword-measure.mjs [--code <tree>] [--size 2000] [--bar 2.0] [--json] [--long]
//
// **What is asked.** The path of the after-failure hook: `mem find <question> --content-words --weak`, in process
// (`retrievalQuery` -> `findcore.rankedFind`), the two lanes of the hook (errors, learnings), the first three hits, and
// "shown" = a score at or over the hook's bar (`afterfailure.MIN_DEFAULT`, 2.0). The recall bar (5.0) is counted too.
// `--code <tree>` picks the code state (default: this checkout); a comparison is two runs.
//
// **The store.** There is no real memory here, and the gold set holds no question with an underscore (so it cannot
// measure this side: `node bench/gold-compare.mjs` is identical before and after, see the CHANGELOG). The store is
// SYNTHETIC and deterministic: `bench/scale.mjs#buildCorpus(--size)` as background, plus identifier entries drawn from a
// fixed vocabulary with a seeded generator. The numbers therefore show how the two rules behave, not how often a real
// memory holds such an entry.
//
// Three sets, all derived from the generated store:
//
//   WHOLE    a snake_case identifier the store holds (an error entry carries it), and in half of the cases two prose
//            entries that carry its three parts as plain words (the noise). Question = the identifier. Expected: the
//            entry that carries it, first. This is the side K1 won and the parts must not lose.
//   UNKNOWN  an identifier that stands in the store NOWHERE (a tool error's identifier); ONE prose entry carries its three
//            words ("the peer closed the socket"). Expected: that entry in the first three. The side K1 lost.
//   PARTS    an identifier the store holds AND a prose entry that carries only its parts. Expected: the prose entry. The
//            price of the rule (known identifier = no parts): reported, held on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.resolve(arg('--code') ?? path.join(HERE, '..'));
const SIZE = Number(arg('--size') ?? 2000);
const imp = (p) => import(pathToFileURL(path.join(CODE, p)).href);
const search = await imp('src/search.mjs');
const findcore = await imp('src/findcore.mjs');
const afterfailure = await imp('src/afterfailure.mjs');
const recallrender = await imp('src/recallrender.mjs');
const memory = await imp('src/memory.mjs');
const { buildCorpus } = await import(pathToFileURL(path.join(HERE, 'scale.mjs')).href);

const BAR = Number(arg('--bar') ?? afterfailure.MIN_DEFAULT);
const RECALL_BAR = recallrender.RECALL_MIN;
const WORDS = ['socket', 'closed', 'peer', 'handshake', 'timeout', 'buffer', 'stream', 'cursor', 'lockfile', 'checkpoint',
  'replica', 'shard', 'tenant', 'webhook', 'payload', 'manifest', 'artifact', 'registry', 'gateway', 'listener',
  'scheduler', 'mutex', 'semaphore', 'backoff', 'quota', 'throttle', 'journal', 'snapshot', 'rollback', 'upstream',
  'downstream', 'certificate', 'keystore', 'password', 'session', 'cookie', 'proxy', 'resolver', 'hostname', 'endpoint',
  'transport', 'frame', 'header', 'chunk', 'archive', 'compress', 'decode', 'encode', 'parser', 'lexer',
  'compiler', 'linker', 'bundle', 'module', 'plugin', 'handler', 'worker', 'thread', 'process', 'signal',
  'pipe', 'channel', 'broker', 'topic', 'offset', 'partition', 'commit', 'branch', 'remote', 'tagger',
  'mirror', 'volume', 'mount', 'inode', 'quorum', 'leader', 'follower', 'election', 'heartbeat', 'lease',
  'ticket', 'invoice', 'ledger', 'balance', 'refund', 'coupon', 'basket', 'catalog', 'render', 'canvas'];

// A deterministic generator: the same store every run, so two code states are compared on the same data.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
const r = rng(20261017);
const triple = () => {
  const w = [];
  while (w.length < 3) { const x = WORDS[Math.floor(r() * WORDS.length)]; if (!w.includes(x)) w.push(x); }
  return w;
};

const { root } = buildCorpus(SIZE);
const used = new Set();
const fresh = () => { for (;;) { const t = triple(); const k = t.join('_'); if (!used.has(k)) { used.add(k); return t; } } };
const put = (type, e) => memory.logEntry(root, type, e);

const whole = [];
const unknown = [];
const parts = [];
let n = 0;
const id = (p) => `${p}-${(n += 1).toString(36)}`;
for (let i = 0; i < 150; i += 1) {
  const t = fresh(); const ident = t.join('_');
  put('error', { id: id('w'), class: 'wrong-cause', title: `call failed with ${ident}`, text: `the call to ${ident} returned an error code` });
  if (i % 2 === 0) {
    put('learning', { id: id('wn'), title: `the ${t[0]} and the ${t[1]}`, text: `we saw the ${t[0]} wait for the ${t[1]} until the ${t[2]} was reset` });
    put('learning', { id: id('wn'), title: `${t[2]} notes`, text: `the ${t[2]} and the ${t[0]} and the ${t[1]} were all restarted` });
  }
  whole.push({ q: ident, target: null });
}
for (let i = 0; i < 100; i += 1) {
  const t = fresh(); const tid = id('u');
  put('error', { id: tid, class: 'wrong-cause', title: `the ${t[0]} ${t[1]} failed`, text: `the ${t[0]} stopped when the ${t[1]} saw the ${t[2]} reset` });
  unknown.push({ q: t.join('_'), target: tid });
}
for (let i = 0; i < 40; i += 1) {
  const t = fresh(); const ident = t.join('_'); const tid = id('p');
  put('error', { id: id('pw'), class: 'wrong-cause', title: `call failed with ${ident}`, text: `the call to ${ident} returned an error code` });
  put('error', { id: tid, class: 'wrong-cause', title: `the ${t[0]} ${t[1]} failed`, text: `the ${t[0]} stopped when the ${t[1]} saw the ${t[2]} reset` });
  parts.push({ q: ident, target: tid });
}

const index = search.buildIndex(root);
function ask(q) {
  const query = search.retrievalQuery(q, { index });
  const { hits } = findcore.rankedFind({ index, query, askedAs: q, wanted: afterfailure.TOP_DEFAULT * 4, weak: true, env: {} });
  return hits.filter((h) => afterfailure.LANES.test(String(h.source ?? '').replace(/^/, '/'))).slice(0, afterfailure.TOP_DEFAULT);
}
const carries = (h, s) => JSON.stringify(h.entry).toLowerCase().includes(s);

const W = { n: 0, top1: 0, top3: 0, over: 0, shown: 0, shownForeign: 0, notFirst: [] };
for (const c of whole) {
  const hits = ask(c.q);
  W.n += 1;
  const i = hits.findIndex((h) => carries(h, c.q));
  if (i === 0) W.top1 += 1; else W.notFirst.push(c.q);
  if (i >= 0) W.top3 += 1;
  if (i >= 0 && hits[i].score >= BAR) W.over += 1;
  const shown = hits.filter((h) => h.score >= BAR);
  W.shown += shown.length;
  W.shownForeign += shown.filter((h) => !carries(h, c.q)).length;
}
const byTarget = (set) => {
  const o = { n: 0, top1: 0, top3: 0, over: 0, overRecall: 0 };
  for (const c of set) {
    const hits = ask(c.q);
    const i = hits.findIndex((h) => h.entry.id === c.target);
    o.n += 1;
    if (i === 0) o.top1 += 1;
    if (i >= 0) o.top3 += 1;
    if (i >= 0 && hits[i].score >= BAR) o.over += 1;
    if (i >= 0 && hits[i].score >= RECALL_BAR) o.overRecall += 1;
  }
  return o;
};
const U = byTarget(unknown);
const P = byTarget(parts);

const result = { code: CODE, N: index.N, bar: BAR, recallBar: RECALL_BAR, whole: W, unknown: U, parts: P };
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`store N=${result.N} (synthetic, background ${SIZE})  code ${CODE}  bar ${BAR}`);
  console.log(`WHOLE   ${W.n} identifiers the store holds: top1 ${W.top1}  top3 ${W.top3}  over the bar ${W.over}  shown ${W.shown} (foreign ${W.shownForeign})`);
  if (process.argv.includes('--long') && W.notFirst.length) console.log(`        not first: ${W.notFirst.join(' ')}`);
  console.log(`UNKNOWN ${U.n} identifiers the store lacks: prose entry top1 ${U.top1}  top3 ${U.top3}  over the bar ${U.over}  over 5.0 ${U.overRecall}`);
  console.log(`PARTS   ${P.n} known identifiers with a parts-only entry: top1 ${P.top1}  top3 ${P.top3}  over the bar ${P.over}  over 5.0 ${P.overRecall}`);
}
fs.rmSync(root, { recursive: true, force: true });

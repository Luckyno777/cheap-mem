// When the question names an identifier, that is not similarity.
//
// The finding (2026-09-06). One class of task asks about paths, case
// numbers, service names and versions. The ranking was right — five of
// six at rank 1 — and still nothing arrived, because every score sat
// below the retrieval threshold of 5.0 (0.95 to 2.44). A question about
// a path simply has one matching word, and BM25 rewards many.
//
// Hence a lane of its own: if the question contains an identifier that
// occurs in at most `top` entries, that entry moves to the front and
// past the threshold. No boost (could bury better material), no filter
// (could throw everything away), no further weight in a sum (the next
// uncalibratable knob).
//
// LIMIT, and it is written here because it surprised us while building:
// the lane helps when the question NAMES the identifier ("what does
// src/…/x.mjs say"). It does NOT help when the question ASKS FOR it
// ("which file holds the check") — then the question contains no
// identifier to look up. Both directions are asserted below, so that
// the limit is not forgotten and later reported as a fault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as entity from '../src/entity.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');
// A path whose PARTS are frequent — that is the case BM25 cannot help
// with: `src` and `mjs` are in every second entry, their idf is small,
// and the entry is short. A path containing a rare word
// (`…/kanarienvogel.mjs`) clears the threshold without this lane too —
// that is what the first version of this test foundered on.
const PATH = 'src/index.mjs';

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-exakt-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, 'decision',
    { ...d, author: 'lucky', authority: 'user' });
  // The topic does NOT repeat the path. A first version set
  // `topic: 'kanarienvogel'` — the rare word then stood three times in
  // the entry, the score jumped to 7.55, and the positive control
  // rightly reported "this test proves nothing". On a realistic corpus
  // the same case sits at 2.4.
  log({ id: 'ZIEL', topic: 'einstieg',
    choice: `der einstieg liegt in ${PATH}`,
    why: 'dort wird alles zusammengesetzt' });
  // Enough noisy corpus that the target's score stays small and other
  // entries fill the slots — otherwise the target wins without the lane
  // and the test proves nothing.
  for (const t of ['ablage', 'tests', 'rechte', 'bilder', 'zeitplan', 'meldung', 'suchfeld']) {
    for (let i = 0; i < 6; i += 1) {
      log({ id: `X-${t}-${i}`, topic: t,
        choice: `zu ${t} liegt der code in src/${t}${i}.mjs`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert und ohne befund` });
    }
  }
  return r;
}

test('identifiers are recognised, prose is not', () => {
  const b = entity.bezeichner(
    'Die Pruefung liegt in src/redaktion/kanarienvogel.mjs, festgenagelt auf 3.7.2, Container '
    + 'kolibri-taktgeber, Vorgang 7318, Variable MEM_RETRIEVE_MIN.');
  for (const x of ['src/redaktion/kanarienvogel.mjs', '3.7.2', 'kolibri-taktgeber', '7318', 'mem_retrieve_min']) {
    assert.ok(b.has(x), `identifier not recognised: ${x} (found: ${[...b].join(' ')})`);
  }
  // And the counter-check: ordinary German words are not identifiers.
  // Without it a pattern that swallows everything would be conceivable.
  const c = entity.bezeichner('Die Ablage der Auswertung bleibt im Repository, 30 Tage lang.');
  assert.equal(c.size, 0, `prose read as identifiers: ${[...c].join(' ')}`);
});

test('an identifier in too many entries identifies nothing any more', () => {
  // The bound has no free parameter: it is the answer size.
  const map = new Map([['a/b.mjs', new Set([1])], ['src/index.mjs', new Set([1, 2, 3, 4, 5, 6, 7])]]);
  const narrow = entity.treffer(map, 'schau in a/b.mjs und src/index.mjs', 5);
  assert.equal(narrow.size, 1, 'the frequent identifier should not have counted');
  assert.ok(narrow.has(1));
});

test('when the question names the path, the entry gets past the threshold', () => {
  const r = build();
  try {
    const cap = grantAll(['read']);
    const question = `Was ist zu ${PATH} festgelegt?`;
    const claims = retrieve(r, question, cap, { top: 5 }).claims;
    const target = claims.find((c) => c.id === 'ZIEL');

    // Positive control: without the lane the score has to be BELOW the
    // threshold — otherwise the assertion underneath proves nothing,
    // because the target would have got through anyway.
    const idx = search.loadIndex(r, { fresh: true });
    const raw = search.search(idx, search.retrievalQuery(question, { index: idx }), { top: 20 })
      .find((h) => h.entry?.id === 'ZIEL');
    assert.ok(raw, 'the fixture does not find the target at all');
    assert.ok(raw.score < 5.0,
      `the target clears the threshold without the lane (${raw.score.toFixed(2)}) — the test proves nothing`);

    assert.ok(target, `target not in the context: ${claims.map((c) => c.id).join(' ')}`);
    assert.ok(target.exact?.includes(PATH),
      `target is there, but not through the exact lane: ${JSON.stringify(target.exact)}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('both retrieval paths know the exact lane', () => {
  // `mem find` and `retrieve()` have drifted apart twice in a single
  // session (test/paths-agree.test.mjs). A third rule known to only one
  // of them would be the third place — and the retrieval hook goes
  // through `mem find`, not through the gateway.
  const r = build();
  try {
    const question = `Was ist zu ${PATH} festgelegt?`;
    const out = execFileSync('node', [MEM, '--root', r, 'find', question, '--top', '5', '--json'],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const hits = JSON.parse(out).hits ?? [];
    const target = hits.find((h) => h.entry?.id === 'ZIEL');
    assert.ok(target, `\`mem find\` does not return the target: ${hits.map((h) => h.entry?.id).join(' ')}`);
    assert.ok(Array.isArray(target.exact) && target.exact.includes(PATH),
      `\`mem find\` does not mark the exact hit: ${JSON.stringify(target.exact)}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the lane does NOT help when the question asks for the identifier', () => {
  // The limit, recorded rather than forgotten. If somebody asks "which
  // file holds the self-check", the question contains no identifier —
  // there is nothing to look up. Whoever sees this assertion red one
  // day has solved the problem and may delete it; whoever does not know
  // about it reports the lane as broken by mistake.
  const r = build();
  try {
    const claims = retrieve(r, 'In welcher Datei liegt die Selbstpruefung?', grantAll(['read']),
      { top: 5 }).claims;
    assert.equal(claims.filter((c) => c.exact).length, 0,
      'the lane fired although the question names no identifier — nice, but then this comment is out of date');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// --- The lane orders internally (2026-09-07) -------------------------
//
// The comment above `exactHits` always claimed the hits carried "the
// BM25 score they would have had". The code set `score: 0` on every
// single one and returned them in index order; both callers put the
// lane in front unchanged. Whoever stood earlier in the file won.
//
// Measured in lucky-mem, same code, same shape: a question named
// `1029`, seven entries carry the number. A zip-bomb note (BM25 2.26)
// came out at rank 2, the entry holding the answer (19.96) at rank 5,
// the strongest of the whole lane (36.26) at rank 7. A briefing taking
// three hits per question lost the answer.
//
// Seven occurrences are not certainty, they are a topic.

const NR = '1029';

function buildLane() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bahn-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (typ, d) => memory.logEntry(r, typ, { ...d, author: 'lucky', authority: 'user' });
  // The entry answering the question — and the one standing LAST in the
  // file, so that index order pushes it to the back.
  log('learning', { id: 'ZIP', title: 'Zip bomb in the attachment path',
    text: `An archive unpacked past the ceiling. See ${NR}.` });
  log('learning', { id: 'PAR', title: 'Paragraph number chosen by hand',
    text: `Two plan items pointed at ${NR}.` });
  log('learning', { id: 'ORD', title: 'Order of the guards',
    text: `Placeholder first, then ${NR}.` });
  log('decision', { id: 'DIG', topic: 'translation',
    choice: `The digit rule looks the whole string up in the catalogue (${NR})`,
    why: `A measured value is never in the catalogue. Guard ${NR}.` });
  log('learning', { id: 'ZIEL', topic: 'translation',
    title: `The tab reads french instead of german after ${NR}, and the cause stays unproven`,
    text: `The tab is french instead of german; nothing is proven about the cause. Number ${NR}.` });
  for (let i = 0; i < 12; i += 1) {
    log('decision', { id: `X${i}`, topic: `topic${i}`,
      choice: `for topic${i} the filing stays`, why: `decided at case ${600 + i}` });
  }
  return r;
}

const LANE_QUESTION = `Which tab reads french instead of german after ${NR}, and what is proven about the cause?`;

test('THE CASE: the answering entry is among the first three', () => {
  const r = buildLane();
  try {
    const lane = search.exactHits(search.loadIndex(r), LANE_QUESTION, 9);
    assert.ok(lane.length > 1, `the case needs several exact hits, has ${lane.length}`);
    const ids = lane.map((h) => h.entry.id);
    assert.ok(ids.slice(0, 3).includes('ZIEL'),
      `expected ZIEL among the first three, got: ${ids.join(', ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('inside the lane the order is by descending score', () => {
  const r = buildLane();
  try {
    const lane = search.exactHits(search.loadIndex(r), LANE_QUESTION, 9);
    for (let i = 1; i < lane.length; i += 1) {
      assert.ok(lane[i - 1].score >= lane[i].score,
        `rank ${i} (${lane[i - 1].score}) sits above rank ${i + 1} (${lane[i].score})`);
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the lane carries real scores, not 0', () => {
  // The comment always claimed it; the code did not do it.
  const r = buildLane();
  try {
    const lane = search.exactHits(search.loadIndex(r), LANE_QUESTION, 9);
    assert.ok(lane.some((h) => h.score > 0), 'not a single exact hit carries points');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('both retrieval paths see the same order inside the lane', () => {
  // `mem find` and `retrieve()` have drifted apart twice already. The
  // ordering therefore lives IN exactHits and not in the callers — this
  // test records that it stays that way.
  const r = buildLane();
  try {
    const idx = search.loadIndex(r);
    const a = search.exactHits(idx, LANE_QUESTION, 9).map((h) => h.entry.id);
    const b = search.exactHits(idx, LANE_QUESTION, 9).map((h) => h.entry.id);
    assert.deepEqual(a, b);
    assert.ok(a.length > 1);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

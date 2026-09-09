// Raw capture is not an authority level, it is the reserve lane.
//
// The design has three lanes: capture (stop hook, no model) -> digest
// (the digester, one model call) -> retrieve (BM25, no model). A
// capture is by definition not yet a claim — the digester has not been
// over it.
//
// In the gateway it nonetheless landed in level 'unknown' and thereby
// got the same per-round slot as 'user'. With five slots that means: a
// single capture displaces a curated claim. And it wins nearly always
// — it is long, glued together, and full of question words.
//
// Measured on the eval corpus (task C3): a capture scoring 30.31 pushes
// the reviewed answer at 18.77 out of the top 5. The echo filter
// rightly stays out of it — the capture belongs to a DIFFERENT
// question. Across all tasks: gold-in-context 11/33 -> 9/33; with this
// rule 11/33 again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');
const QUESTION = 'brauchen wir fuer die ablage der auswertung eine externe datenbank';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reserve-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  return r;
}

function capture(r, name, text) {
  const dir = path.join(r, 'raw', '2026', '09');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `2026-09-01T10-00-00Z--${name}.jsonl.gz`),
    zlib.gzipSync(`${JSON.stringify({ ts: '2026-09-01T10:00:00Z', role: 'user', text })}\n`));
}

const ids = (r, top = 5) => retrieve(r, QUESTION, grantAll(['read']), { top }).claims
  .map((c) => c.id ?? '[roh]');

test('a raw capture does not displace a curated claim', () => {
  const r = root();
  try {
    const log = (d) => memory.logEntry(r, 'decision',
      { ...d, author: 'lucky', authority: 'user' });
    log({ id: 'ANTWORT', topic: 'ablage',
      choice: 'dateien im repository, keine externe datenbank fuer die auswertung',
      why: 'ein dienst, den niemand wartet, ist teurer als eine datei' });
    for (let i = 0; i < 4; i += 1) {
      log({ id: `NEBEN-${i}`, topic: 'ablage',
        choice: `zur ablage der auswertung gilt fassung ${i}`,
        why: `entschieden bei vorgang ${500 + i}, seitdem unveraendert` });
    }
    // A long capture with many question words — exactly the kind that
    // wins the scoring race. It is NOT an echo of this question, so the
    // echo filter rightly leaves it alone.
    capture(r, 'lang', ['wir haben lange ueber die ablage der auswertung gesprochen',
      'brauchen wir eine externe datenbank oder reicht die ablage im repository',
      'die auswertung liegt in der ablage und die datenbank waere extern',
      'externe datenbank, ablage, auswertung, repository, wartung, kosten'].join('\n'));

    const inside = ids(r);
    // Positive control, and it has to ask the right question: not "are
    // all five slots full", but "would the capture have displaced
    // anything". So open the list wide and compare the scores — if the
    // capture is weaker than the answer, the assertion below proves
    // nothing.
    const wide = retrieve(r, QUESTION, grantAll(['read']), { top: 20 }).claims;
    const bestRaw = Math.max(...wide.filter((c) => !c.id).map((c) => c.score), -Infinity);
    const answer = wide.find((c) => c.id === 'ANTWORT');
    assert.ok(answer, 'the fixture does not find the answer at all');
    assert.ok(Number.isFinite(bestRaw), 'the fixture produces no raw-capture hit');
    assert.ok(bestRaw > answer.score,
      `the capture is weaker than the answer (${bestRaw.toFixed(2)} vs ${answer.score.toFixed(2)}) — it would not have displaced anything`);
    assert.equal(inside.length, 5, `not all slots filled: ${inside.join(' ')}`);
    assert.ok(inside.includes('ANTWORT'),
      `the curated claim was displaced: ${inside.join(' ')}`);
    assert.ok(!inside.includes('[roh]'),
      `raw capture takes a slot while curated material is left over: ${inside.join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('raw capture fills what the curated material leaves open', () => {
  // The counter-check. "Reserve" must not mean "never": on a fresh
  // memory the digester has never run over, the capture is the only
  // material there is.
  const r = root();
  try {
    memory.logEntry(r, 'decision', { id: 'EINZIG', topic: 'ablage',
      choice: 'die ablage der auswertung bleibt vorerst offen',
      why: 'niemand hat sich das angesehen',
      author: 'lucky', authority: 'user' });
    for (let i = 0; i < 3; i += 1) {
      capture(r, `f${i}`, `zur externen datenbank fuer die auswertung sagte ich damals variante ${i}`);
    }
    const inside = ids(r);
    assert.ok(inside.includes('EINZIG'), `the curated claim is missing: ${inside.join(' ')}`);
    assert.ok(inside.includes('[roh]'),
      `no raw capture although slots are free: ${inside.join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('a memory made only of raw captures still answers', () => {
  const r = root();
  try {
    for (let i = 0; i < 3; i += 1) {
      capture(r, `n${i}`, `zur externen datenbank fuer die auswertung sagte ich variante ${i}`);
    }
    const inside = ids(r);
    assert.ok(inside.length > 0, 'a raw-only memory stopped answering entirely');
    assert.ok(inside.every((x) => x === '[roh]'), `unexpected claims: ${inside.join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

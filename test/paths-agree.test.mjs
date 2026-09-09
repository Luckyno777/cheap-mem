// The two retrieval paths must not drift apart.
//
// cheap-mem has two: `mem find` (human) and `retrieve()` (agent, via
// `mem retrieve` and MCP `mem_retrieve`). They may RANK differently —
// the gateway does a round-robin over authority levels that `find` does
// not know. They must not run different POLICY.
//
// That happened twice, within a single session:
//
//   2026-09-06  `search()` has mmr:false as its default. `mem find`
//               turns it on, the gateway did not — the agent path got
//               plain BM25 order and filled up with near-duplicates.
//               Measured: gold in the top 5 for 7 of 18 tasks without
//               MMR, 9 of 18 with.
//
//   2026-09-06  `isEcho` was implemented, tested and justified by a
//               measurement (13 of 18 injected hits were echoes) — and
//               was called by NOTHING. In `mem find` it sat behind
//               `--no-echo`, which nobody set; the retrieval hook that
//               had measured the 13/18 did not set it either.
//
// The same class twice means there is a third place. This test is not
// aimed at the two known cases but at the next one.
//
// ONE difference is intended, and therefore stated here instead of
// being asserted: the reserve lane for raw captures (since 2026-09-06)
// applies to the gateway only. `mem find` still mixes captures in by
// score and marks them `[raw]`.
//
// The reason is purpose. The gateway FILLS A BUDGET for a model that
// cannot ask back; there an unprocessed transcript ahead of a reviewed
// decision is a fault. `mem find` puts a list in front of a human who
// sees the marker and knows `--only-raw`.
//
// So changing that changes not an inconsistency but a decision. If the
// reason falls away, the difference goes with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as memory from '../src/memory.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');
const QUESTION = 'Wie halten wir die Ablage im Repository nachvollziehbar?';

function build({ dups = 15 } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-wege-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  const log = (d) => memory.logEntry(r, d.type ?? 'decision',
    { ...d, author: 'lucky', authority: 'user' });

  // (a) An echo as a REAL raw capture, not as a typed entry.
  //
  // That is not cosmetic: the filter deliberately applies to raw
  // material ONLY. A typed entry is by construction not the user's
  // question, and without that restriction a short decision recorded in
  // their own words would drop out. A first version of this fixture
  // stored the echo as a `thought` and thereby exercised a path that
  // does not exist in production.
  const rawDir = path.join(r, 'raw', '2026', '09');
  fs.mkdirSync(rawDir, { recursive: true });
  const lines = [
    JSON.stringify({ ts: '2026-09-06T10:00:00Z', role: 'user', text: QUESTION }),
    JSON.stringify({ ts: '2026-09-06T10:00:01Z', role: 'user', text: QUESTION }),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(rawDir, '2026-09-06T10-00-00Z--echo.jsonl.gz'), zlib.gzipSync(lines));
  // (b) Near-duplicates that match the question lexically.
  for (let i = 0; i < dups; i += 1) {
    log({ id: `DUP-${i}`, topic: 'pakete',
      choice: `Abhaengigkeiten im Repository nachvollziehbar festnageln, Runde ${i}`,
      why: 'das Bild des Laufwerks driftete zweimal in einem Monat', tags: ['pakete'] });
  }
  // (c) Enough unrelated corpus that idf means something.
  for (const topic of ['protokoll', 'tests', 'rechte', 'bilder', 'zeitplan', 'suchfeld', 'meldung', 'archiv']) {
    for (let i = 0; i < 3; i += 1) {
      log({ id: `X-${topic}-${i}`, topic, choice: `zu ${topic} gilt Fassung ${i}`,
        why: `entschieden bei Vorgang ${500 + i}, seitdem unveraendert`, tags: [topic] });
    }
  }
  // (d) One answer, on a topic of its own.
  log({ id: 'ANTWORT', topic: 'ablage', choice: 'Dateien im Repository statt einer externen Datenbank',
    why: 'ein Dienst, den niemand wartet, ist teurer als eine Datei', tags: ['ablage'] });
  return r;
}

const findIds = (root, extra = []) => {
  const top = extra.includes('--top') ? [] : ['--top', '5'];
  const out = execFileSync('node', [MEM, '--root', root, 'find', QUESTION, ...top, '--json', ...extra],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return (JSON.parse(out).hits ?? []).map((h) => h.entry?.id ?? '?');
};
const gatewayIds = (root, opt = {}) =>
  retrieve(root, QUESTION, grantAll(['read']), { top: 5, ...opt }).claims.map((c) => c.id);

test('by default both paths drop the echo of the question', () => {
  // Little curated competition, and that is not a detail: since
  // 2026-09-06 raw captures are the gateway's reserve lane — they only
  // get a turn once the curated material fails to fill the slots. With
  // the fifteen near-duplicates of the other fixture no slot would be
  // free, and the positive control would be red although the filter
  // does nothing wrong.
  const r = build({ dups: 1 });
  try {
    const WIDE = 12;
    const isRaw = (ids) => ids.some((x) => x === null || String(x).includes('raw') || x === '?');
    const without = () => findIds(r, ['--with-echo', '--top', String(WIDE)]);
    const with_ = () => findIds(r, ['--top', String(WIDE)]);

    // Positive control first: without the policy the echo MUST show up,
    // otherwise the assertion below proves nothing.
    assert.ok(isRaw(without()), `the fixture produces no raw echo: ${without().join(' ')}`);
    assert.ok(isRaw(gatewayIds(r, { dropEcho: false, top: WIDE })),
      `no raw echo in the gateway: ${gatewayIds(r, { dropEcho: false, top: WIDE }).join(' ')}`);

    assert.ok(!isRaw(with_()), `\`mem find\` feeds the echo in: ${with_().join(' ')}`);
    assert.ok(!isRaw(gatewayIds(r, { top: WIDE })),
      `the gateway feeds the echo in: ${gatewayIds(r, { top: WIDE }).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('the echo filter applies to raw captures only, not to typed entries', () => {
  // The restriction to raw material is not a detail but the boundary
  // between two lanes: lane 1 (stop hook) stores every message, hence
  // the question itself. What somebody records by hand is by
  // construction something else — even when it happens to start with
  // the same words.
  //
  // Without the boundary a real claim drops out. Measured: the question
  // "zahlung vorkasse entscheidung" against the decision "zahlung nur
  // per vorkasse — meine entscheidung" gives 3 of 4 content words, so
  // 0.75, above the 0.7 threshold.
  const r = build();
  try {
    memory.logEntry(r, 'thought', {
      id: 'GETIPPT', topic: 'ablage', text: QUESTION,
      author: 'lucky', authority: 'user', tags: ['ablage'],
    });
    assert.ok(findIds(r, ['--top', '10']).includes('GETIPPT'),
      `\`mem find\` suppresses a typed entry: ${findIds(r, ['--top', '10']).join(' ')}`);
    assert.ok(gatewayIds(r, { top: 10 }).includes('GETIPPT'),
      `the gateway suppresses a typed entry: ${gatewayIds(r, { top: 10 }).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('neither path fills the hit list with near-duplicates alone', () => {
  const r = build();
  try {
    const onlyDup = (ids) => ids.length > 0 && ids.every((x) => String(x).startsWith('DUP-'));
    assert.ok(!onlyDup(findIds(r)), `\`mem find\` returns duplicates only: ${findIds(r).join(' ')}`);
    assert.ok(!onlyDup(gatewayIds(r)), `the gateway returns duplicates only: ${gatewayIds(r).join(' ')}`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

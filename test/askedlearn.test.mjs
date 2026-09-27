// test/askedlearn.test.mjs — M18b, query words learned from real misses
// (src/askedlearn.mjs, `mem asked-learn`), the port of lucky-mem M8.
//
// The fixture is one English memory and one session that asks in
// Spanish, gets nothing, and then fetches the entry by id itself. The
// probe: before learning, the Spanish question misses the top 3; after
// one written case it is the first hit. Red on the old tree (no module,
// no journal writer). Controls: the latch against self-reinforcement,
// the ambiguity cut, the dry run, and "never twice".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as raw from '../src/raw.mjs';
import * as injection from '../src/injection.mjs';
import * as al from '../src/askedlearn.mjs';
import { loadIndex, search } from '../src/search.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
const T0 = Date.parse('2026-09-27T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const QUESTION = '¿por qué elegimos postgres para la facturación?';

function memoryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-askedlearn-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ version: 1, language: 'en', participants: { user: 'u' } }));
  const t = new Date('2026-09-01T00:00:00Z');
  memory.logEntry(root, 'decision', { id: 'dpostgres01', title: 'Chose PostgreSQL over MongoDB for the billing service', choice: 'PostgreSQL', why: 'transactions matter for money', asked: 'which database for billing' }, { now: t });
  memory.logEntry(root, 'decision', { id: 'dredis00001', title: 'Added Redis as a cache in front of the catalog', choice: 'Redis', why: 'reads dominate', asked: 'catalog cache' }, { now: t });
  memory.logEntry(root, 'error', { id: 'eoom0000001', class: 'crash', title: 'Node process killed by OOM during CSV import', text: 'streaming fixed it', asked: 'csv import crash' }, { now: t });
  for (let i = 0; i < 60; i += 1) {
    memory.logEntry(root, 'learning', { id: `lfill${String(i).padStart(6, '0')}`, title: `filler note ${i} about deploys`, learning: 'nothing', asked: 'filler' }, { now: t });
  }
  return root;
}

/** One session transcript: the question, then the session fetching `id`. */
function captureSession(root, { session = 'sess-1', question = QUESTION, fetch = 'dpostgres01', via = 'tool', at = T0 } = {}) {
  const lines = [
    { type: 'user', sessionId: session, timestamp: iso(at), promptId: 'p1', message: { role: 'user', content: question } },
    via === 'tool'
      ? { type: 'assistant', sessionId: session, timestamp: iso(at + 60_000), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: `mem show ${fetch}` } }] } }
      : { type: 'user', sessionId: session, timestamp: iso(at + 60_000), promptId: 'p2', message: { role: 'user', content: `look at ${fetch}` } },
    { type: 'user', sessionId: session, timestamp: iso(at + 61_000), message: { role: 'user', content: [{ type: 'tool_result', content: 'dredis00001 shown here does not count' }] } },
  ];
  const tr = path.join(root, `${session}.jsonl`);
  fs.writeFileSync(tr, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const r = raw.capture(root, tr, { minBytes: 0 });
  assert.equal(r.status, 'captured', JSON.stringify(r));
}

function miss(root, { session = 'sess-1', at = T0, sources = [], reason = injection.REASON.TOO_WEAK } = {}) {
  injection.book(root, { ts: iso(at).replace(/\.\d{3}Z$/, 'Z'), session, occasion: injection.OCCASION.QUESTION, reason, sources });
}

// Curated entries only: the raw capture holds the question verbatim and
// `mem find` drops such echoes (isEchoHit); plain search() does not. The
// correction carries a new id, so the entry is recognised by its title.
const rank = (root, q) => search(loadIndex(root, { fresh: true }), q, { top: 3, noRaw: true })
  .findIndex((h) => /PostgreSQL over MongoDB/.test(h.entry.title ?? ''));

test('PROBE: a Spanish miss, fetched by id, is learned — and then found', () => {
  const root = memoryRoot();
  try {
    captureSession(root);
    miss(root);
    assert.equal(rank(root, QUESTION), -1, 'control: before learning the question misses the top 3');
    const r = al.cases(root);
    assert.equal(r.counts.misses, 1);
    assert.equal(r.counts.withQuestion, 1);
    assert.equal(r.cases.length, 1, al.asText(r));
    const c = r.cases[0];
    assert.equal(c.entry.id, 'dpostgres01', 'the tool_result mentioning dredis00001 is not a mention');
    assert.equal(c.use.kind, al.KIND.MENTION_TOOL);
    assert.ok(c.words.includes('facturación'), c.words.join(' '));
    assert.ok(!c.words.some((w) => ['por', 'qué', 'la'].includes(w)), 'short function words are not learned');
    const w = al.write(root, c);
    assert.equal(w.written, true);
    assert.equal(w.entry.entry.replaces_id, 'dpostgres01');
    assert.equal(w.entry.entry.asked_evidence[0].journal, '.pipeline/injections.jsonl:1');
    assert.equal(rank(root, QUESTION), 0, 'after learning it is the first hit');
    assert.equal(rank(root, 'facturación postgres'), 0, 'and a second phrasing in the same words');
    assert.equal(al.write(root, c).reason, 'already-learned', 'never twice');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('with the es-en bridge on, its stop words are not learned either', () => {
  const root = memoryRoot();
  try {
    const cfg = path.join(root, '.mem', 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, 'utf8')), languageBridges: ['es-en'] }));
    captureSession(root);
    miss(root);
    const r = al.cases(root);
    assert.equal(r.cases.length, 1);
    assert.ok(!r.cases[0].words.includes('para'), r.cases[0].words.join(' '));
    assert.ok(r.cases[0].words.includes('facturación'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a mention in the person\'s own next input counts too', () => {
  const root = memoryRoot();
  try {
    captureSession(root, { via: 'prompt' });
    miss(root);
    const r = al.cases(root);
    assert.equal(r.cases.length, 1);
    assert.equal(r.cases[0].use.kind, al.KIND.MENTION_PROMPT);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('LATCH: an entry the memory itself showed is no evidence', () => {
  const root = memoryRoot();
  try {
    captureSession(root);
    miss(root);
    // A later turn of the same session in which recall DID show it.
    injection.book(root, { ts: iso(T0 + 30_000).replace(/\.\d{3}Z$/, 'Z'), session: 'sess-1', occasion: injection.OCCASION.QUESTION, reason: null, sources: ['global/decisions.jsonl:1'] });
    const r = al.cases(root);
    assert.equal(r.cases.length, 0);
    assert.equal(r.counts.selfShown, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no evidence without the session naming an entry, or outside the window', () => {
  const root = memoryRoot();
  try {
    captureSession(root, { fetch: 'nothing-known' });
    miss(root);
    captureSession(root, { session: 'sess-2', at: T0 + 3_600_000 });
    miss(root, { session: 'sess-2', at: T0 + 3_600_000 + 20 * 60_000 }); // question 20 min off
    const r = al.cases(root);
    assert.equal(r.counts.misses, 2);
    assert.equal(r.counts.withQuestion, 1);
    assert.equal(r.counts.withMention, 0);
    assert.equal(r.cases.length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a word learned for two different entries is dropped', () => {
  const root = memoryRoot();
  try {
    captureSession(root, { question: 'la facturación del almacén', fetch: 'dpostgres01' });
    miss(root);
    captureSession(root, { session: 'sess-2', question: 'la facturación del catálogo', fetch: 'dredis00001', at: T0 + 3_600_000 });
    miss(root, { session: 'sess-2', at: T0 + 3_600_000 });
    const r = al.cases(root);
    for (const c of r.cases) assert.ok(!c.words.includes('facturación'), `${c.entry.id}: ${c.words}`);
    assert.deepEqual(r.cases.map((c) => c.words.join(' ')).sort(), ['almacén', 'catálogo']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('CLI: dry run writes nothing, --write appends, no miss on record says so', () => {
  const root = memoryRoot();
  try {
    const run = (...a) => execFileSync(process.execPath, [BIN, '--root', root, 'asked-learn', ...a], { encoding: 'utf8' });
    assert.match(run(), /No miss on record/);
    captureSession(root);
    miss(root);
    const before = fs.readFileSync(path.join(root, 'global', 'decisions.jsonl'), 'utf8');
    assert.match(run(), /dry run/);
    assert.equal(fs.readFileSync(path.join(root, 'global', 'decisions.jsonl'), 'utf8'), before);
    assert.match(run('--write'), /written: 1/);
    assert.ok(fs.readFileSync(path.join(root, 'global', 'decisions.jsonl'), 'utf8').startsWith(before), 'append-only');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mem find --journal-session books shown places and misses', () => {
  const root = memoryRoot();
  try {
    const find = (q) => execFileSync(process.execPath, [BIN, '--root', root, 'find', q, '--json', '--top', '3',
      '--journal-session', 'S9', '--journal-min', '0.5'], { encoding: 'utf8' });
    find('postgresql billing');
    find('zzzz qqqq');
    const { lines } = injection.read(root);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].reason, null);
    assert.ok(lines[0].sources.includes('global/decisions.jsonl:1'), JSON.stringify(lines[0]));
    assert.equal(lines[0].bytes, null, 'find cannot know the rendered size: unknown, not 0');
    assert.equal(lines[1].reason, injection.REASON.EMPTY);
    assert.equal(lines[1].session, 'S9');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// test/langbridge.test.mjs — M18b, the optional starter dictionaries
// from the language a person asks in to the language the memory is
// written in (src/langbridge.mjs, src/langbridge/*.tsv).
//
// Four things are pinned here:
//   1. every shipped line is core and says why (evidence checked
//      against the code it names), and none duplicates what the
//      thesaurus already bridges or what matches as typed;
//   2. OFF by default — no config, no change, to the last hit;
//   3. ON, the shipped pairs help the gold sets (the probe: red on the
//      old tree, where there is no bridge, and with the bridge off);
//   4. ON, English questions rank exactly as before — the bridge only
//      ever touches words of the asked language.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lb from '../src/langbridge.mjs';
import { buildIndex, search, loadIndex, FIELD_WEIGHTS } from '../src/search.mjs';
import * as memory from '../src/memory.mjs';
const { TYPES } = memory;
import { THESAURUS } from '../src/thesaurus.mjs';
import { pack } from '../src/language.mjs';
import { buildCorpus, QUERIES } from '../bench/retrieval.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIR = path.join(REPO, 'src', 'langbridge');
const PAIRS = fs.readdirSync(DIR).filter((f) => f.endsWith('.tsv')).map((f) => f.slice(0, -4));

function gold(pair) {
  return fs.readFileSync(path.join(REPO, 'bench', 'lang-gold', `${pair}.tsv`), 'utf8')
    .split('\n').filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.split('\t'));
}

function top3(index, rows, bridge) {
  let n = 0;
  for (const [q, id] of rows) {
    if (search(index, q, { top: 3, bridge }).some((h) => h.entry.id === id)) n += 1;
  }
  return n;
}

test('shipped pairs exist and are named <asked>-<written>', () => {
  assert.ok(PAIRS.length >= 2, `expected at least two shipped pairs, found ${PAIRS.join(', ')}`);
  for (const p of PAIRS) assert.match(p, /^[a-z]{2,3}-[a-z]{2,3}$/);
});

test('every line names evidence the code confirms', () => {
  const thesaurusWords = new Set(THESAURUS.flat());
  for (const pair of PAIRS) {
    const rows = lb.parseBridge(fs.readFileSync(path.join(DIR, `${pair}.tsv`), 'utf8'));
    assert.ok(rows.length > 0, `${pair}: empty`);
    for (const r of rows) {
      const where = `${pair}.tsv:${r.line}`;
      assert.ok(r.asked.length, `${where}: no asked forms`);
      const [kind, what] = r.evidence.split(':');
      if (r.written === null) {
        assert.equal(r.evidence, 'stop:query', `${where}: a stop line must say stop:query`);
        continue;
      }
      assert.ok(r.written.length, `${where}: no written forms`);
      if (kind === 'type') assert.ok(Object.hasOwn(TYPES, what), `${where}: no entry type '${what}'`);
      else if (kind === 'field') assert.ok(Object.hasOwn(FIELD_WEIGHTS, what), `${where}: no ranked field '${what}'`);
      else if (kind === 'thesaurus') assert.ok(thesaurusWords.has(what), `${where}: '${what}' is in no thesaurus group`);
      else assert.fail(`${where}: evidence '${r.evidence}' is not type:/field:/thesaurus:/stop:query`);
      if (kind !== 'thesaurus') assert.ok(r.written.includes(what), `${where}: evidence names '${what}', the line writes ${r.written}`);
      else {
        const group = THESAURUS.find((g) => g.includes(what));
        assert.ok(r.written.some((w) => group.includes(w)), `${where}: no written form sits in the '${what}' group`);
      }
    }
  }
});

test('no line repeats the thesaurus, a loanword, or another line', () => {
  for (const pair of PAIRS) {
    const [from, to] = pair.split('-');
    const rows = lb.parseBridge(fs.readFileSync(path.join(DIR, `${pair}.tsv`), 'utf8'));
    // What the thesaurus already bridges, under the asked language's key.
    const thesaurusKeys = new Set(THESAURUS.flat().map((w) => lb.askedKey(w, from)));
    const seen = new Map();
    const allWritten = new Set(rows.flatMap((r) => r.written ?? []).map((w) => lb.askedKey(w, from)));
    for (const r of rows) {
      for (const w of r.asked) {
        const k = lb.askedKey(w, from);
        const where = `${pair}.tsv:${r.line} '${w}'`;
        assert.ok(!seen.has(k) || seen.get(k) === r.line, `${where}: key '${k}' already on line ${seen.get(k)}`);
        seen.set(k, r.line);
        if (r.written === null) continue;
        assert.ok(!thesaurusKeys.has(k), `${where}: the thesaurus already carries it`);
        assert.ok(!allWritten.has(k), `${where}: spelled like a written form — it matches as typed`);
        assert.notEqual(lb.writtenTerm(w, to), lb.writtenTerm(r.written[0], to), `${where}: a loanword`);
      }
    }
  }
});

test('the reader: forms, stop marker, one direction only', () => {
  const b = lb.buildBridge(lb.parseBridge('# c\npago,pagos\tpayment\tx\ndonde\t-\tstop:query\n'), 'es-en');
  assert.deepEqual(lb.lookup([b], 'Pagos'), [pack('en').stem('payment')]);
  assert.deepEqual(lb.lookup([b], 'payment'), [], 'written → asked is not a direction');
  assert.ok(lb.isQueryStop([b], 'dónde'), 'accents are stripped on the asked side');
  assert.equal(lb.stripQueryStops([b], '¿dónde pagos?'), '¿dónde pagos?'.replace('¿dónde ', ''));
  assert.equal(lb.stripQueryStops([b], 'donde'), 'donde', 'all stop words: the question stays as typed');
  assert.throws(() => lb.buildBridge([], 'german'), /asked.*written/);
});

test('OFF by default: no config key, no bridge, identical hits', () => {
  const root = buildCorpus();
  try {
    const loaded = loadIndex(root, { fresh: true });
    assert.equal(loaded.bridge, null);
    const plain = buildIndex(root, { language: 'en' });
    for (const [q] of gold('es-en')) {
      const a = search(loaded, q, { top: 5, now: 0 }).map((h) => [h.entry.id, h.score]);
      const b = search(plain, q, { top: 5, now: 0, bridge: null }).map((h) => [h.entry.id, h.score]);
      assert.deepEqual(a, b, q);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('config switches a pair on; an unknown pair is reported, not fatal', () => {
  const root = buildCorpus();
  try {
    const cfg = path.join(root, '.mem', 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ language: 'en', languageBridges: ['es-en'] }));
    const on = loadIndex(root, { fresh: true });
    assert.equal(on.bridge.length, 1);
    assert.equal(on.bridgeError, null);
    fs.writeFileSync(cfg, JSON.stringify({ language: 'en', languageBridges: ['xx-en'] }));
    const bad = loadIndex(root);
    assert.equal(bad.bridge, null);
    assert.match(bad.bridgeError, /xx-en/);
    // A memory's own additions join the shipped file.
    fs.mkdirSync(path.join(root, lb.USER_BRIDGE_DIR), { recursive: true });
    fs.writeFileSync(path.join(root, lb.USER_BRIDGE_DIR, 'es-en.tsv'), 'facturacion\tbilling\tmine\n');
    fs.writeFileSync(cfg, JSON.stringify({ language: 'en', languageBridges: ['es-en'] }));
    const own = loadIndex(root);
    assert.ok(lb.lookup(own.bridge, 'facturación').length, 'the user file is read');
    assert.ok(lb.lookup(own.bridge, 'fallo').length, 'the shipped file still is');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('PROBE: the shipped pairs lift foreign-language questions into the top 3', () => {
  const root = buildCorpus();
  try {
    const index = buildIndex(root, { language: 'en' });
    // Recorded 2026-09-27 (bench/lang-bridge.mjs): es-en 1 -> 5 of 14,
    // de-en 3 -> 3 (the thesaurus already bridges German core terms).
    // Pinned as floors, and the off-state pinned exactly as control.
    const es = gold('es-en');
    const esOff = top3(index, es, null);
    const esOn = top3(index, es, lb.loadBridges(null, { pairs: ['es-en'] }));
    assert.equal(esOff, 1, 'control: bridge off is the old tree');
    assert.ok(esOn >= 5, `es-en with bridge: ${esOn}/14`);
    const de = gold('de-en');
    const deOn = top3(index, de, lb.loadBridges(null, { pairs: ['de-en'] }));
    assert.ok(deOn >= top3(index, de, null), 'de-en must not lose');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('English questions rank exactly as before with every pair on', () => {
  const root = buildCorpus();
  try {
    const index = buildIndex(root, { language: 'en' });
    const all = lb.loadBridges(null, { pairs: PAIRS });
    for (const { q } of QUERIES) {
      const off = search(index, q, { top: 10, minScore: 0, now: 0, bridge: null }).map((h) => [h.entry.id, h.score]);
      const on = search(index, q, { top: 10, minScore: 0, now: 0, bridge: all }).map((h) => [h.entry.id, h.score]);
      assert.deepEqual(on, off, q);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a bridged term weighs less than the typed word', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lb-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'));
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{"language":"en"}');
    const t = new Date('2026-01-01T00:00:00Z');
    memory.logEntry(root, 'learning', { id: 'lit', title: 'pago retry notes', learning: 'x' }, { now: t });
    memory.logEntry(root, 'learning', { id: 'tra', title: 'payment retry notes', learning: 'x' }, { now: t });
    const index = buildIndex(root, { language: 'en' });
    const bridge = [lb.buildBridge(lb.parseBridge('pago\tpayment\tx\n'), 'es-en')];
    const hits = search(index, 'pago retry', { top: 2, minScore: 0, now: 0, bridge });
    assert.deepEqual(hits.map((h) => h.entry.id), ['lit', 'tra'], 'typed word first, bridged second');
    assert.ok(hits[1].score > 0, 'the bridged one is found at all');
    const off = search(index, 'pago retry', { top: 2, minScore: 0, now: 0, bridge: null });
    assert.ok(hits[1].score > off[1].score, 'the bridge adds score for the translated word');
    assert.ok(lb.BRIDGE_WEIGHT < 1 && lb.BRIDGE_WEIGHT > 0.6, 'under the original, over the thesaurus');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// test/expand-asked-as.test.mjs — document expansion: the field `asked_as`
// (port of lucky-mem's `gefragt_als`, commits f5521274, 81c3586d, 865f4d5b).
//
// Promises:
//   1. `mem log --asked-as "a|b|c"` stores the underscore field as a list;
//      what does not fit (question, too long, copied, duplicate, over 12)
//      is dropped and said so on stderr, the entry is written either way.
//   2. Without MEM_EXPAND=1 the search never reads the field: no hit through
//      it, an identical index, the exact-identifier lane blind to it, the
//      usual cache directory. With MEM_EXPAND=1 the phrasing finds the entry
//      (positive control), a word carried only through it covers HALF, and
//      the cache lives in its own directory.
//   3. The digest prompt asks for `--asked-as` next to `--asked`.
//
// Red proof: this file run against the base commit fe4eda8 (no src/expand.mjs,
// no field, no prompt line) fails; see the commit message for the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-expand-'));
  const init = spawnSync('node', [MEM, '--root', r, 'init'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  return r;
}
const gone = (r) => fs.rmSync(r, { recursive: true, force: true });
function cli(root, argv, env = {}) {
  const e = { ...process.env, ...env };
  if (!('MEM_EXPAND' in env)) delete e.MEM_EXPAND;
  return spawnSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8', env: e });
}
const entries = (root) => {
  const out = [];
  const walk = (d) => {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) { if (n.name !== '.mem' && n.name !== '.git') walk(p); }
      else if (n.name.endsWith('.jsonl')) {
        for (const l of fs.readFileSync(p, 'utf8').split('\n')) { if (l.trim()) out.push(JSON.parse(l)); }
      }
    }
  };
  walk(root);
  return out;
};
async function expandModule() { return import('../src/expand.mjs'); }

// --- 1. the write path -----------------------------------------------------

test('check: drops question, long, copied, duplicate and the 13th phrasing, never throws', async () => {
  const { check, MAX_COUNT } = await expandModule();
  const own = 'the nightly import runs out of memory on large files';
  const many = Array.from({ length: 14 }, (_, i) => `phrase${i} word`);
  const r = check(['crashes on big files', 'why does it crash?', 'x '.repeat(40),
    'nightly import runs out of memory', 'crashes on big files', ...many], own);
  const reasons = Object.fromEntries(r.dropped.map((d) => [d.phrase.slice(0, 12), d.reason]));
  assert.match(reasons['why does it '], /question/);
  assert.match(reasons['x x x x x x '], /too long/);
  assert.match(reasons['nightly impo'], /copied/);
  assert.match(reasons['crashes on b'], /duplicate/);
  assert.equal(r.list.length, MAX_COUNT);
  assert.ok(r.dropped.some((d) => /more than 12/.test(d.reason)));
  assert.deepEqual(check(42).list, []);               // not a list: dropped, no throw
  assert.deepEqual(check('a|b | c').list, ['a', 'b', 'c']);
});

test('mem log --asked-as stores asked_as as a list and is silent on stderr when all fit', () => {
  const r = build();
  try {
    const o = cli(r, ['log', 'learning', '--title', 'Nightly import dies', '--text', 'ran out of memory',
      '--asked', 'import crash', '--asked-as', 'crashes on big files|batch job falls over|out of ram']);
    assert.equal(o.status, 0, o.stderr);
    assert.equal(o.stderr, '', o.stderr);
    const e = entries(r).find((x) => x.title === 'Nightly import dies');
    assert.deepEqual(e.asked_as, ['crashes on big files', 'batch job falls over', 'out of ram']);
    assert.equal(Object.hasOwn(e, 'asked-as'), false);
  } finally { gone(r); }
});

test('mem log --asked-as with a question: the entry is written, the question is dropped and reported on stderr', () => {
  const r = build();
  try {
    const o = cli(r, ['log', 'learning', '--title', 'Pool size', '--text', 'set to eight',
      '--asked-as', 'how many workers?|worker count']);
    assert.equal(o.status, 0, o.stderr);
    assert.match(o.stderr, /asked_as: dropped: "how many workers\?" \(question form/);
    const e = entries(r).find((x) => x.title === 'Pool size');
    assert.deepEqual(e.asked_as, ['worker count']);
  } finally { gone(r); }
});

// --- 2. the search, off and on ---------------------------------------------

const FILLER = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
function seed(r) {
  for (const f of FILLER) {
    const o = cli(r, ['log', 'learning', '--title', `${f} routine`, '--text', `${f} housekeeping task for the ${f} service`]);
    assert.equal(o.status, 0, o.stderr);
  }
  const o = cli(r, ['log', 'learning', '--title', 'Ledger rollover', '--text', 'the settlement table is rotated on the first of the month',
    '--asked-as', 'zanzibar budget cycle|monthly books reset']);
  assert.equal(o.status, 0, o.stderr);
}
const find = (r, q, env) => {
  const o = cli(r, ['find', q, '--json', '--weak'], env);
  assert.equal(o.status, 0, o.stderr);
  assert.equal(o.stderr, '', `stderr: ${o.stderr}`);
  return JSON.parse(o.stdout).hits.map((h) => h.entry.title);
};

test('switch off: the phrasing finds nothing; the usual cache directory is used', () => {
  const r = build();
  try {
    seed(r);
    assert.deepEqual(find(r, 'zanzibar'), []);
    assert.ok(fs.existsSync(path.join(r, '.mem', 'search-index')));
    assert.ok(!fs.existsSync(path.join(r, '.mem', 'search-index-expand')));
  } finally { gone(r); }
});

test('POSITIVE CONTROL, switch on: the phrasing finds the entry; its own cache directory; off again stays blind', () => {
  const r = build();
  try {
    seed(r);
    assert.ok(find(r, 'zanzibar', { MEM_EXPAND: '1' }).includes('Ledger rollover'));
    assert.ok(fs.existsSync(path.join(r, '.mem', 'search-index-expand')));
    assert.deepEqual(find(r, 'zanzibar'), []);      // the two states never mix
  } finally { gone(r); }
});

test('switch off: index weights and the exact lane are identical with and without the field', async () => {
  const search = await import('../src/search.mjs');
  const e0 = { title: 'Ledger rollover', text: 'settlement table rotated monthly' };
  const e1 = { ...e0, asked_as: ['zanzibar budget cycle'] };
  const old = process.env.MEM_EXPAND;
  try {
    delete process.env.MEM_EXPAND;
    assert.deepEqual([...search.fieldsOfEntry(e1)], [...search.fieldsOfEntry(e0)]);
    assert.doesNotMatch(search.entityText({ entry: e1 }), /zanzibar/);
    process.env.MEM_EXPAND = '1';
    assert.ok(search.fieldsOfEntry(e1).has('zanzibar'), 'positive control: with the switch the term is indexed');
    assert.ok(search.fieldsOfEntry(e1).get('zanzibar') < 0.5, 'weight 0.3, below the note\'s own words');
    assert.match(search.entityText({ entry: e1 }), /zanzibar/);
  } finally { if (old === undefined) delete process.env.MEM_EXPAND; else process.env.MEM_EXPAND = old; }
});

test('switch on: a word carried only through asked_as covers half, so it ranks below the entry that has the word itself', async () => {
  const search = await import('../src/search.mjs');
  const root = build();
  const old = process.env.MEM_EXPAND;
  try {
    for (const [t, x, a] of [
      ['Via phrasing', 'settlement table rotated monthly', 'zanzibar ledger'],
      ['Via text', 'zanzibar ledger settlement table rotated monthly', null],
    ]) {
      const args = ['log', 'learning', '--title', t, '--text', x];
      if (a) args.push('--asked-as', a);
      const o = cli(root, args);
      assert.equal(o.status, 0, o.stderr);
    }
    process.env.MEM_EXPAND = '1';
    const index = search.loadIndex(root, { fresh: true });
    const hits = search.search(index, 'zanzibar ledger', { withCoverage: true });
    const top = (t) => hits.findIndex((h) => h.entry.title === t);
    assert.ok(top('Via phrasing') >= 0, 'found through the phrasing');
    assert.ok(top('Via text') >= 0 && top('Via text') < top('Via phrasing'));
    assert.ok(hits.find((h) => h.entry.title === 'Via phrasing').covered < 1, 'never "whole question covered"');
  } finally { if (old === undefined) delete process.env.MEM_EXPAND; else process.env.MEM_EXPAND = old; gone(root); }
});

// --- 3. the capture prompt -------------------------------------------------

test('digest prompt: --asked-as next to --asked, 8-12 phrasings, no questions, no copies', () => {
  const src = fs.readFileSync(path.join(REPO, 'bin', 'mem-digest'), 'utf8').replace(/\s+/g, ' ');
  assert.match(src, /--asked-as '<8-12 short phrasings/);
  assert.match(src, /--asked-as is a second field of its own/);
  assert.match(src, /NO questions \(no \?\)/);
  assert.match(src, /NO sentences or sentence parts copied/);
  const sh = spawnSync('bash', ['-n', path.join(REPO, 'bin', 'mem-digest')], { encoding: 'utf8' });
  assert.equal(sh.status, 0, sh.stderr);
  assert.equal(sh.stderr, '');
});

test('the switch is documented where capabilities are listed', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'CAPABILITIES.md'), 'utf8');
  assert.match(doc, /`MEM_EXPAND=1`/);
  assert.match(doc, /`expand\.mjs`/);
});

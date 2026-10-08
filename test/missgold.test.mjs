// test/missgold.test.mjs — the local miss-gold file (src/missgold.mjs,
// `mem gold miss`), the port of lucky-mem's "Fehltreffer-Gold" (Hebel 8,
// commit 0ead5e9c).
//
// The probe: a session asks, the recall finds nothing, the session then
// fetches an entry by id. That is a real miss WITH question text. The text
// must reach exactly one place — a git-ignored 0600 file — and no output.
// Positive control: the same world yields exactly one case. Red on the tree
// before this branch (4d746f6): the module does not exist, the import fails.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as rewrites from '../src/rewrites.mjs';
import * as mg from '../src/missgold.mjs';
import { loadIndex } from '../src/search.mjs';
import { writeMemoryGitignore } from '../src/cli/githook.mjs';
import {
  QUESTION, SESSION, T0, iso, memoryRoot, captureSession, miss, world, allFiles, writeGoldFile, cleanup,
} from './fixture/missgold-world.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'mem');
afterEach(cleanup);

const mem = (root, ...a) => spawnSync(process.execPath, [BIN, '--root', root, ...a], { encoding: 'utf8' });

test('positive control: a real miss is found with its question text and the expected entry', () => {
  const root = world();
  const g = mg.find(root);
  assert.equal(g.cases.length, 1, JSON.stringify(g.counts));
  assert.equal(g.cases[0].question, QUESTION);
  assert.deepEqual(g.cases[0].expected, ['etarget0001']);
  assert.equal(g.cases[0].journal, '.pipeline/injections.jsonl:1');
  assert.equal(g.cases[0].kind, 'too-weak');
  assert.deepEqual(
    [g.counts.misses, g.counts.withCapture, g.counts.withQuestion, g.counts.withMention, g.counts.cases],
    [1, 1, 1, 1, 1]);
});

test('collect: dry run writes nothing; --write gives 0600 in 0700, atomic, idempotent; the report has no question', () => {
  const root = world();
  const dry = mg.collect(root);
  assert.equal(dry.written, false);
  assert.equal(fs.existsSync(mg.filePath(root)), false);
  const b = mg.collect(root, { write: true });
  assert.equal(b.written, true);
  assert.ok(!JSON.stringify(b).includes(QUESTION), 'the report never carries the question');
  const file = mg.filePath(root);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['miss-gold.jsonl'], 'no temp file left behind');
  assert.equal(mg.read(file).rows[0].question, QUESTION);
  assert.equal(mg.collect(root, { write: true }).fresh, 0, 'a second run adds nothing twice');
  assert.equal(mg.read(file).rows.length, 1);
});

test('the question text is in no other file of the memory (not the journal, not the entries, not the docs)', () => {
  const root = world();
  mg.collect(root, { write: true });
  const local = mg.filePath(root);
  let looked = 0;
  // The raw capture is indexed on purpose (that is how raw search works), so the
  // DERIVED search cache holds the text too; it is git-ignored and not new.
  const derived = path.join(root, '.mem', 'search-index') + path.sep;
  for (const f of allFiles(root)) {
    if (f === local || f.startsWith(derived)) continue;
    looked += 1;
    assert.ok(!fs.readFileSync(f, 'latin1').includes(QUESTION), `question in ${path.relative(root, f)}`); // rel-ok: failure message only
  }
  assert.ok(looked > 3, 'the probe looked at real files');
  assert.ok(fs.readFileSync(local, 'latin1').includes(QUESTION), 'control: the one place does hold it');
});

test('sabotage: inside a work tree that does not ignore the place, nothing is written; with the rule it is', () => {
  const bad = world({ ignore: false });
  assert.throws(() => mg.collect(bad, { write: true }), /does NOT ignore/);
  assert.equal(fs.existsSync(mg.filePath(bad)), false);
  assert.equal(mg.status(bad).ignored, false);
  const good = world({ ignore: true });
  assert.equal(mg.collect(good, { write: true }).written, true);
  assert.equal(mg.status(good).ignored, true);
  const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: good, encoding: 'utf8' });
  assert.ok(!porcelain.includes('.mem/local'), `git sees the file: ${porcelain}`);
});

test('the memory .gitignore written by `mem init` carries its own line for .mem/local/ (and git agrees)', () => {
  const root = memoryRoot({ ignore: false });
  writeMemoryGitignore(root);
  const v = execFileSync('git', ['check-ignore', '-v', '--no-index', '.mem/local/miss-gold.jsonl'], { cwd: root, encoding: 'utf8' });
  assert.match(v, /^\.gitignore:\d+:\.mem\/local\/\t/, v);
  assert.throws(() => execFileSync('git', ['check-ignore', '-q', '--no-index', 'global/errors.jsonl'], { cwd: root, stdio: 'ignore' }),
    'control: an ordinary path is not ignored');
  assert.equal(mg.FILE_REL, path.join('.mem', 'local', 'miss-gold.jsonl'));
});

test('sensitive: an encrypted entry and a question with a secret are skipped and counted, nothing lands in the file', () => {
  const a = memoryRoot();
  memory.logEntry(a, 'decision', { id: 'esecret0001', title: 'vault title', text: 'vault body words', shred: true });
  captureSession(a, { fetch: 'esecret0001' });
  miss(a);
  const ga = mg.find(a);
  assert.equal(ga.cases.length, 0, JSON.stringify(ga.counts));
  assert.equal(ga.counts.sensitive, 1);
  assert.equal(mg.collect(a, { write: true }).written, false);
  assert.equal(fs.existsSync(mg.filePath(a)), false);

  // The capture redacts the key itself; what is left is the marker.
  const b = world({ question: `where is my key ${'AKIA'}${'IOSFODNN7EXAMPLE'} stuck` });
  const gb = mg.find(b);
  assert.equal(gb.cases.length, 0);
  assert.equal(gb.counts.secret, 1);
  assert.equal(mg.collect(b, { write: true }).written, false);
  assert.equal(fs.existsSync(mg.filePath(b)), false);
});

test('too long: pasted text is not a question — left out and counted', () => {
  const root = world({ question: `${QUESTION} ${'blah '.repeat(120)}` });
  const g = mg.find(root);
  assert.equal(g.cases.length, 0);
  assert.equal(g.counts.tooLong, 1);
});

test('latch: an entry the memory itself showed in that window is no miss case', () => {
  const root = memoryRoot();
  captureSession(root);
  const idx = loadIndex(root, { fresh: true });
  const doc = idx.documents.find((d) => d.entry?.id === 'etarget0001');
  const place = `${doc.source}:${doc.line}`;
  miss(root);
  // A SHOWN turn of the same session, inside the window, that named the entry's place.
  miss(root, { at: T0 + 30_000, reason: null, sources: [place] });
  const g = mg.find(root);
  assert.equal(g.cases.length, 0);
  assert.equal(g.counts.selfShown, 1);
  const open = memoryRoot();
  captureSession(open);
  miss(open);
  assert.equal(mg.find(open).cases.length, 1, 'control: without the showing it is a case');
});

test('score: below 20 cases there is no number, at exactly 20 there are real ones (both sides of the line)', () => {
  assert.equal(mg.MIN_CASES, 20, 'the line is 20');
  const r19 = memoryRoot();
  writeGoldFile(r19, mg.filePath(r19), 19);
  const e19 = mg.score(r19);
  assert.equal(e19.measurable, false);
  assert.equal(e19.cases, 19);
  for (const k of ['rank1', 'topK', 'mrr']) assert.equal(k in e19, false, `${k} is not invented`);
  assert.match(mg.scoreAsText(e19), /no number/);

  const r20 = memoryRoot();
  writeGoldFile(r20, mg.filePath(r20), 20);
  const e20 = mg.score(r20);
  assert.equal(e20.measurable, true);
  assert.equal(e20.scored, 20);
  assert.equal(e20.rank1, 1, 'every question names the entry\'s own word');
  assert.equal(e20.mrr, 1);
  assert.ok(!mg.scoreAsText(e20).includes('zebra'), 'the text carries no question');
});

test('score: a question that does not find its entry lowers the rate (the probe bites)', () => {
  const root = memoryRoot();
  const file = mg.filePath(root);
  writeGoldFile(root, file, 20);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  rows[0].question = 'completely different subject without any hit quasselword';
  fs.writeFileSync(file, `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`, { mode: 0o600 });
  const e = mg.score(root);
  assert.equal(e.measurable, true);
  assert.ok(e.rank1 < 1 && e.rank1 >= 0.9, `rank1=${e.rank1}`);
  assert.ok(e.notFound >= 1);
});

test('circularity: a case asked-learn already used is not scored (20 -> 19 is no number, 21 -> 20 is)', () => {
  const a = memoryRoot();
  writeGoldFile(a, mg.filePath(a), 20, { learned: 1 });
  const ea = mg.score(a);
  assert.equal(ea.measurable, false);
  assert.equal(ea.learned, 1);
  assert.equal(ea.scored, 19);
  const b = memoryRoot();
  writeGoldFile(b, mg.filePath(b), 21, { learned: 1 });
  const eb = mg.score(b);
  assert.equal(eb.measurable, true);
  assert.equal(eb.scored, 20);
  assert.equal(eb.learned, 1);
});

test('circularity: evidence in the rewrite table counts the same as evidence on an entry', () => {
  const root = memoryRoot();
  const rows = writeGoldFile(root, mg.filePath(root), 20);
  rewrites.append(root, {
    kind: 'pair', ts: iso(T0), from: 'stuck', to: 'stranded', sessions: ['s1', 's2'], last: iso(T0),
    evidence: [{ kind: 'asked-learn', place: rows[0].journal, entry: rows[0].expected[0], ts: iso(T0) }],
  });
  const e = mg.score(root);
  assert.equal(e.measurable, false);
  assert.equal(e.learned, 1);
  rewrites._clearCache();
});

test('rights: a file open to others is reported; control: 0600 is fine', () => {
  const root = world();
  mg.collect(root, { write: true });
  const file = mg.filePath(root);
  fs.chmodSync(file, 0o644);
  assert.equal(mg.status(root).modeOk, false);
  fs.chmodSync(file, 0o600);
  assert.equal(mg.status(root).modeOk, true);
});

test('CLI `mem gold miss`: numbers only; score under 20 exits 2 without a number', () => {
  const root = world();
  const dry = mem(root, 'gold', 'miss', 'collect');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run/);
  const w = mem(root, 'gold', 'miss', 'collect', '--write');
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /1 new case\(s\)/);
  const st = mem(root, 'gold', 'miss', 'status');
  assert.match(st.stdout, /1 case\(s\)/);
  const sc = mem(root, 'gold', 'miss', 'score');
  assert.equal(sc.status, 2);
  assert.match(sc.stdout, /no number/);
  for (const o of [dry, w, st, sc]) assert.ok(!(o.stdout + o.stderr).includes(QUESTION), 'no question in any output');
  const bad = mem(root, 'gold', 'miss', 'nonsense');
  assert.notEqual(bad.status, 0);
});

test('the session id is not stored in the file', () => {
  const root = world();
  mg.collect(root, { write: true });
  assert.ok(!fs.readFileSync(mg.filePath(root), 'utf8').includes(SESSION), 'the session id stays out of the file');
});

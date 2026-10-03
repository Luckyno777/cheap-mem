// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Tests for src/categories.mjs and src/categories-initial.mjs - categories
 * above topics (ported from the sibling house, 2026-10-03, owner decision
 * "option a").
 *
 * Red proof: on the code before this port (24cd9a9, a FIXED hash - never a
 * moving merge-base) there is no module, no `mem category`, no `--category`
 * filter and no `category` field on a dashboard topic; the first test reads
 * those files with `git show 24cd9a9:<path>` and shows each absence, with the
 * positive control that the same probe finds all of it in the working tree.
 * The remaining tests exercise the rules: ships empty, the creation rule
 * (3 different topics), the similarity protection, aliases, the person-only
 * writes, the search filter with its controls, the doctor finding and the
 * dashboard data contract.
 *
 * Every name in this file is a made-up fixture.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as cat from '../src/categories.mjs';
import * as ini from '../src/categories-initial.mjs';
import * as doctor from '../src/doctor.mjs';
import * as integrity from '../src/integrity.mjs';
import * as data from '../src/dashboard-data.mjs';
import * as viewer from '../src/viewer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BEFORE = '24cd9a9';
const dirs = [];

function world(projects = []) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-cat-'));
  dirs.push(w);
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'),
    JSON.stringify({ name: 'cat', participants: { alex: { human: true }, probe: {} }, language: 'en' }));
  fs.mkdirSync(path.join(w, 'global'), { recursive: true });
  for (const p of projects) memory.projectInit(w, p);
  return w;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const cli = (w, args, env = {}) => spawnSync('node', [MEM, ...args], {
  encoding: 'utf8',
  env: { ...process.env, CHEAP_MEM_ROOT: w, CHEAP_MEM_AGENT: 'cat-test', MEM_HEADLESS: '', ...env },
});

function entry(w, topic, title = `note on ${topic}`, extra = {}) {
  return memory.logEntry(w, 'thought', { title, text: `text about ${topic}`, topic, ...extra });
}
const lines = (w, rel) => {
  try { return fs.readFileSync(path.join(w, rel), 'utf8').split('\n').filter(Boolean); } catch { return []; }
};
/** The doctor's finding by name, through the real `checkAll` (the check itself is not exported). */
const finding = (w) => doctor.checkAll(w).findings.find((f) => f.name === 'categories');
const gitShow = (p) => spawnSync('git', ['-C', REPO, 'show', `${BEFORE}:${p}`], { encoding: 'utf8' });
const reachable = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${BEFORE}^{commit}`]).status === 0;

// --- red proof --------------------------------------------------------------

test('red proof: the old stand has none of it, the working tree has all of it', { skip: reachable ? false : `commit ${BEFORE} not in this clone` }, () => {
  const probes = [
    ['src/categories.mjs', null],
    ['src/cli/commands/setup.mjs', 'category: async'],
    ['src/search.mjs', 'topics = null'],
    ['src/viewer.mjs', 'categoryOf'],
    ['src/dashboard-data.mjs', 'categoriesState'],
    ['src/doctor.mjs', "'categories'"],
  ];
  for (const [file, needle] of probes) {
    const old = gitShow(file);
    const now = needle === null ? { status: fs.existsSync(path.join(REPO, file)) ? 0 : 1, stdout: '' }
      : { status: 0, stdout: fs.readFileSync(path.join(REPO, file), 'utf8') };
    if (needle === null) {
      assert.notEqual(old.status, 0, `${file} did not exist at ${BEFORE}`);
      assert.equal(now.status, 0, `${file} exists now (positive control)`);
    } else {
      assert.ok(!old.stdout.includes(needle), `${file}: '${needle}' absent at ${BEFORE}`);
      assert.ok(now.stdout.includes(needle), `${file}: '${needle}' present now (positive control)`);
    }
  }
});

// --- ships empty --------------------------------------------------------------

test('ships empty: no categories, no file written by reading, nothing implied', () => {
  const w = world();
  entry(w, 'alpha-thread');
  const st = cat.readCategories(w);
  assert.equal(st.cats.size, 0);
  const v = cat.view(w);
  assert.deepEqual(v.list, []);
  assert.equal(v.unassigned.topics, 1);
  assert.equal(cat.topicsOfCategory(w, 'coding'), null);
  for (const rel of Object.values(memory.CATEGORY_TABLES)) assert.ok(!fs.existsSync(path.join(w, rel)), `${rel} not created by reading`);
  const r = cli(w, ['category', 'list']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No categories yet/);
});

test('the suggested list is neutral English, adopted only on request, idempotent', () => {
  for (const [k, label] of cat.SUGGESTED) {
    assert.match(k, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(/^[\x20-\x7e]+$/.test(label), `${label} is plain ASCII`);
  }
  assert.equal(cat.SUGGESTED.length, 8);
  const w = world();
  const made = cat.adoptSuggested(w);
  assert.equal(made.length, 8);
  assert.deepEqual(cat.adoptSuggested(w), [], 'a second adoption writes nothing');
  assert.equal(lines(w, memory.CATEGORY_TABLES.categories).length, 8);
  const st = cat.readCategories(w);
  assert.equal(st.cats.get('ai-agents').label, 'AI & Agents');
  assert.equal(st.cats.get('coding').status, 'confirmed');
});

// --- assignments, aliases ----------------------------------------------------------

test('assign / confirm / rename / merge: append only, aliases inherit, chains and cycles resolve', () => {
  const w = world();
  cat.adoptSuggested(w);
  entry(w, 'parser-rewrite'); entry(w, 'old-parser');
  memory.mergeTopics(w, ['old-parser'], 'parser-rewrite');
  const entryFile = lines(w, 'global/thoughts.jsonl').join('\n');
  // Raw lines as an older writer left them (the topic name as it stood BEFORE the merge).
  const raw = (topic, category) => cat.appendAssignments(w, [{ topic, category, source: 'person', status: 'confirmed', ts: new Date().toISOString() }]);
  raw('old-parser', 'coding');
  assert.equal(cat.readAssignments(w).get('parser-rewrite').category, 'coding', 'a line on an alias name counts for the target');
  raw('parser-rewrite', 'testing');
  assert.equal(cat.readAssignments(w).get('parser-rewrite').category, 'testing', 'a line on the target wins');
  raw('old-parser', 'design');
  assert.equal(cat.readAssignments(w).get('parser-rewrite').category, 'testing', 'a later line on the alias never displaces the target');
  cat.assign(w, 'old-parser', 'security');
  assert.equal(cat.readAssignments(w).get('parser-rewrite').category, 'security', 'a person assigning by the alias name assigns the target');
  assert.deepEqual(lines(w, 'global/thoughts.jsonl').join('\n'), entryFile, 'entries untouched');
  assert.throws(() => cat.assign(w, 'parser-rewrite', 'nonsense'), /No category/);

  cat.createCategory(w, 'coding', 'Software Coding');
  assert.equal(cat.readCategories(w).cats.get('coding').label, 'Software Coding', 'rename = a new line, same key');
  cat.mergeCategories(w, 'design', 'media', { why: 'test' });
  cat.mergeCategories(w, 'media', 'personal');
  const st = cat.readCategories(w);
  assert.equal(st.alias.get('design'), 'personal', 'chain resolved');
  assert.equal(cat.findCategory(st, 'Design').key, 'personal');
  assert.throws(() => cat.mergeCategories(w, 'personal', 'design'), /same category/, 'a merged name already counts as its target');
  // A cycle can only come from hand-written lines; reading it must end.
  fs.appendFileSync(path.join(w, memory.CATEGORY_TABLES.aliases), `${JSON.stringify({ from: 'personal', to: 'coding' })}\n${JSON.stringify({ from: 'coding', to: 'personal' })}\n`);
  const cyc = cat.readCategories(w);
  assert.ok(cyc.alias.has('coding'), 'a cycle ends (no hang)');
  assert.throws(() => cat.mergeCategories(w, 'security', 'security'), /same category/);
});

test('confirm: proposals become confirmed, a second confirm is refused, --all works', () => {
  const w = world();
  cat.adoptSuggested(w);
  entry(w, 'a-one'); entry(w, 'b-two');
  cat.decide(w, [{ topic: 'a-one', category: 'coding', source: 'digest' }, { topic: 'b-two', category: 'testing', source: 'digest' }], { write: true });
  assert.equal(cat.view(w).proposals.length, 2);
  assert.deepEqual(cat.confirm(w, 'a-one'), ['a-one']);
  assert.throws(() => cat.confirm(w, 'a-one'), /already confirmed/);
  assert.throws(() => cat.confirm(w, 'never-seen'), /no category/);
  assert.deepEqual(cat.confirm(w, null), ['b-two']);
  assert.equal(cat.view(w).proposals.length, 0);
});

// --- the creation rule ---------------------------------------------------------------

const fresh = (topic, key, label) => ({ topic, fresh: { key, label }, source: 'digest' });

test('creation rule: 3 different topics create, 2 only wait, the third completes a persisted wish', () => {
  const w = world();
  for (const t of ['t1', 't2', 't3']) entry(w, t);
  let r = cat.decide(w, [fresh('t1', 'beekeeping', 'Beekeeping'), fresh('t2', 'beekeeping', 'Beekeeping')], { write: true });
  assert.equal(r.created.length, 0, 'two topics: nothing created');
  assert.deepEqual(r.waiting.map((x) => [x.key, x.topics]), [['beekeeping', 2]]);
  assert.equal(cat.readCategories(w).cats.size, 0);
  r = cat.decide(w, [fresh('t3', 'beekeeping', 'Beekeeping')], { write: true });
  assert.equal(r.created.length, 1, 'the third, in a LATER run, completes it');
  assert.deepEqual(r.created[0].topics.sort(), ['t1', 't2', 't3']);
  const st = cat.readCategories(w);
  assert.equal(st.cats.get('beekeeping').status, 'automatic');
  const a = cat.readAssignments(w);
  assert.equal(a.size, 3);
  assert.ok([...a.values()].every((x) => x.status === 'proposal' && x.category === 'beekeeping'));
  assert.deepEqual(cat.view(w).new, [{ key: 'beekeeping', label: 'Beekeeping' }]);
  // idempotent: the same call again changes no line
  const before = Object.values(memory.CATEGORY_TABLES).map((rel) => lines(w, rel).length);
  cat.decide(w, [fresh('t1', 'beekeeping', 'Beekeeping')], { write: true });
  assert.deepEqual(Object.values(memory.CATEGORY_TABLES).map((rel) => lines(w, rel).length), before);
});

test('creation rule: the SAME topic three times is one thread, not three; spelling variants count together', () => {
  const w = world();
  for (const t of ['s1', 's2', 's3']) entry(w, t);
  let r = cat.decide(w, [fresh('s1', 'wood-work', 'Wood Work'), fresh('s1', 'wood-work', 'Wood Work'), fresh('s1', 'wood-work', 'Wood Work')], { write: true });
  assert.equal(r.created.length, 0);
  r = cat.decide(w, [fresh('s2', 'Wood_Work', 'Wood Work'), fresh('s3', 'woodwork', 'Woodwork')], { write: true });
  assert.equal(r.created.length, 1, 'three topics through three spellings');
  assert.equal(cat.readCategories(w).cats.size, 1);
});

test('preview (write: false) counts persisted wishes but writes nothing', () => {
  const w = world();
  for (const t of ['p1', 'p2', 'p3']) entry(w, t);
  cat.decide(w, [fresh('p1', 'astronomy', 'Astronomy'), fresh('p2', 'astronomy', 'Astronomy')], { write: true });
  const before = Object.values(memory.CATEGORY_TABLES).map((rel) => lines(w, rel).length);
  const r = cat.decide(w, [fresh('p3', 'astronomy', 'Astronomy')], { write: false });
  assert.equal(r.created.length, 1, 'the preview says it WOULD be created');
  assert.deepEqual(Object.values(memory.CATEGORY_TABLES).map((rel) => lines(w, rel).length), before, 'and wrote nothing');
});

test('protection: a near-duplicate lands on the existing category, project name / shape are refused', () => {
  const w = world(['gardenplan']);
  cat.adoptSuggested(w);
  for (const t of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) entry(w, t);
  const r = cat.decide(w, [
    fresh('n1', 'codings', 'Codings'), // one letter off 'coding'
    fresh('n2', 'gardenplan', 'Garden Plan Stuff'), // a project name
    fresh('n3', 'Not A Key!!', 'x'), // bad label shape
    fresh('n4', 'a-fine-key', 'This label has far too many words in it'),
    { topic: 'n5', category: 'unknown-one', source: 'digest' }, // unknown, no fresh
  ], { write: true });
  assert.deepEqual(r.assigned.map((x) => [x.topic, x.category]), [['n1', 'coding']]);
  const why = Object.fromEntries(r.rejected.map((x) => [x.topic, x.reason]));
  assert.equal(why.n2, 'project-name');
  assert.equal(why.n3, 'shape-label');
  assert.equal(why.n4, 'shape-label');
  assert.equal(why.n5, 'category-unknown');
  // Positive control: a clearly different name is NOT swallowed by the protection.
  for (const t of ['n6', 'n7', 'n8']) entry(w, t);
  const ok = cat.decide(w, [fresh('n6', 'beekeeping', 'Beekeeping'), fresh('n7', 'beekeeping', 'Beekeeping'), fresh('n8', 'beekeeping', 'Beekeeping')], { write: true });
  assert.equal(ok.created.length, 1);
  assert.throws(() => cat.createCategory(w, 'codings', 'Codings'), /too like/);
  assert.throws(() => cat.createCategory(w, 'k'.repeat(31), 'Fine'), /key lower case/);
});

// --- initial assignment ------------------------------------------------------------------

test('initial-assign: nothing without categories; rules propose only when clear; project tags do not count', () => {
  const w = world(['meadow']);
  entry(w, 'unit-test-flakiness', 'x', { tags: ['meadow'] });
  entry(w, 'misc-notes');
  let r = ini.initialAssign(w, { write: true });
  assert.equal(r.noCategories, true);
  assert.equal(lines(w, memory.CATEGORY_TABLES.assignments).length, 0, 'nothing written without categories');
  cat.adoptSuggested(w);
  r = ini.initialAssign(w, { write: false });
  assert.deepEqual(r.assigned, [{ topic: 'unit-test-flakiness', category: 'testing' }]);
  assert.deepEqual(r.unassigned.map((x) => x.topic), ['misc-notes']);
  assert.equal(lines(w, memory.CATEGORY_TABLES.assignments).length, 0, 'without --write only shown');
  ini.initialAssign(w, { write: true });
  const a = cat.readAssignments(w).get('unit-test-flakiness');
  assert.deepEqual([a.category, a.status, a.source], ['testing', 'proposal', 'initial-assign']);
  assert.deepEqual(ini.initialAssign(w, { write: true }).assigned, [], 'repeatable: assigned topics are skipped');
});

test('initial-assign judge: ambiguity stays unassigned (positive and negative control)', () => {
  const keys = ['coding', 'testing'];
  assert.equal(ini.judgeTopic({ topic: 'test-bench', keys }).category, 'testing');
  const both = ini.judgeTopic({ topic: 'code-test', keys });
  assert.equal(both.category, null, 'two categories tie: not clear');
  assert.equal(both.reason, 'not-clear');
  assert.equal(ini.judgeTopic({ topic: 'zzz', keys }).reason, 'too-few-hints');
  // a category without rules (a user's own key) receives nothing and does not crash
  assert.equal(ini.judgeTopic({ topic: 'test-bench', keys: ['my-own'] }).reason, 'no-rules');
});

// --- CLI -----------------------------------------------------------------------------------------

test('CLI: log --category writes a proposal line, never an entry field; --category-new follows the rule', () => {
  const w = world();
  cat.adoptSuggested(w);
  let r = cli(w, ['log', 'thought', '--title', 'a', '--text', 'b', '--topic', 'cli-one', '--category', 'testing', '--asked', 'x']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /category proposal: cli-one -> testing/);
  const e = JSON.parse(lines(w, 'global/thoughts.jsonl').at(-1));
  assert.ok(!('category' in e) && !('category-new' in e), 'the entry carries no category field');
  assert.equal(cat.readAssignments(w).get('cli-one').source, 'agent');
  r = cli(w, ['log', 'thought', '--title', 'a', '--text', 'b', '--topic', 'cli-two', '--category', 'nonsense', '--asked', 'x']);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /category rejected \(category-unknown\)/);
  assert.ok(!cat.readAssignments(w).has('cli-two'));
  for (const t of ['cli-a', 'cli-b', 'cli-c']) {
    r = cli(w, ['log', 'thought', '--title', 'a', '--text', 'b', '--topic', t, '--category-new', 'Bee Keeping|Bee Keeping', '--asked', 'x'], { MEM_HEADLESS: 'digest' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.match(r.stdout, /category created: bee-keeping/);
  assert.equal(cat.readAssignments(w).get('cli-a').source, 'digest');
});

test('CLI: the person-only writes are refused in an unattended run, reads and proposals are not', () => {
  const w = world();
  entry(w, 'pt-one');
  for (const args of [['create', '--suggested'], ['create', 'k', 'Label'], ['assign', 'pt-one', 'coding'], ['confirm', '--all-proposals'], ['acknowledge', 'k'], ['rename', 'k', 'L'], ['merge', 'a', 'b']]) {
    const r = cli(w, ['category', ...args], { MEM_HEADLESS: 'digest' });
    assert.notEqual(r.status, 0, `${args[0]} refused`);
    assert.match(r.stderr, /only a person/);
  }
  assert.equal(lines(w, memory.CATEGORY_TABLES.categories).length, 0, 'nothing written');
  assert.equal(cli(w, ['category', 'list'], { MEM_HEADLESS: 'digest' }).status, 0);
  assert.equal(cli(w, ['category', 'initial-assign'], { MEM_HEADLESS: 'digest' }).status, 0);
  // Positive control: the same commands work for a person.
  assert.equal(cli(w, ['category', 'create', '--suggested']).status, 0);
  assert.equal(cli(w, ['category', 'assign', 'pt-one', 'coding']).status, 0);
  assert.notEqual(cli(w, ['category', 'assign', 'no-such-topic', 'coding']).status, 0, 'unknown topic refused');
});

test('CLI: list/open --json carry the contract fields; help names every sub', () => {
  const w = world();
  cat.adoptSuggested(w);
  entry(w, 'js-one');
  cat.decide(w, [{ topic: 'js-one', category: 'coding', source: 'digest' }], { write: true });
  const l = JSON.parse(cli(w, ['category', 'list', '--json']).stdout);
  assert.ok(Array.isArray(l.list) && l.unassigned);
  assert.deepEqual(Object.keys(l.list[0]).sort(), ['entries', 'key', 'label', 'source', 'status', 'topics']);
  const o = JSON.parse(cli(w, ['category', 'open', '--json']).stdout);
  assert.deepEqual(Object.keys(o).sort(), ['new', 'proposals', 'threshold', 'unassigned', 'wishes']);
  assert.equal(o.proposals[0].topic, 'js-one');
  const help = cli(w, ['category', '--help']).stdout;
  for (const s of ['list', 'assign', 'confirm', 'open', 'create', 'acknowledge', 'rename', 'merge', 'initial-assign']) assert.ok(help.includes(`mem category ${s}`), s);
});

test('CLI: find --category filters by category (proposal and confirmed, alias names), controls included', () => {
  const w = world();
  cat.adoptSuggested(w);
  entry(w, 'kiln-firing', 'kiln schedule');
  entry(w, 'kiln-glaze', 'kiln glaze recipe');
  entry(w, 'kiln-other', 'kiln elsewhere');
  memory.mergeTopics(w, ['kiln-glaze'], 'kiln-firing');
  cat.assign(w, 'kiln-firing', 'media');
  cat.decide(w, [{ topic: 'kiln-other', category: 'design', source: 'digest' }], { write: true });
  const hits = (args) => (cli(w, ['find', 'kiln', ...args, '--top', '20']).stdout.match(/kiln [a-z ]+/g) ?? []);
  const all = hits([]);
  assert.ok(all.length >= 3, `without the filter everything is found (positive control): ${all}`);
  const media = cli(w, ['find', 'kiln', '--category', 'media', '--json']);
  const dMedia = media.stdout;
  assert.match(dMedia, /kiln schedule/);
  assert.match(dMedia, /kiln glaze recipe/, 'an alias name of the topic counts');
  assert.doesNotMatch(dMedia, /kiln elsewhere/);
  const design = cli(w, ['find', 'kiln', '--category', 'Design']).stdout;
  assert.match(design, /kiln elsewhere/, 'a proposal counts, the label spelling works');
  assert.doesNotMatch(design, /kiln schedule/);
  assert.match(cli(w, ['find', 'kiln', '--category', 'security']).stdout, /Nothing|no hit|0 /i, 'an empty category finds nothing');
  const bad = cli(w, ['find', 'kiln', '--category', 'nonsense']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /no category/);
  assert.notEqual(cli(w, ['find', 'kiln', '--category']).status, 0, 'a value is required');
  assert.notEqual(cli(w, ['find', 'kiln', '--category', 'media', '--literal']).status, 0);
});

// --- doctor ---------------------------------------------------------------------------------------

test('doctor: unknown without topics, good when the layer is unused, warns when in use and mostly unassigned, never an error', () => {
  const w = world();
  assert.equal(finding(w).level, 'unknown');
  for (const t of ['d1', 'd2', 'd3', 'd4']) entry(w, t);
  const unused = finding(w);
  assert.equal(unused.level, 'good');
  assert.match(unused.text, /not in use/);
  cat.adoptSuggested(w);
  const warn = finding(w);
  assert.equal(warn.level, 'warn', 'in use, 100 % unassigned');
  assert.ok(warn.advice.includes('mem category open'));
  cat.assign(w, 'd1', 'coding'); cat.assign(w, 'd2', 'coding'); cat.assign(w, 'd3', 'coding');
  const good = finding(w);
  assert.equal(good.level, 'good');
  assert.match(good.text, /3 of 4 topics have a category, 1 without \(25 %\); 0 proposals await/);
  // open proposals above the threshold warn, still never an error
  const w2 = world();
  cat.adoptSuggested(w2);
  const wishes = [];
  for (let i = 0; i < 100 + 1; i += 1) { entry(w2, `bulk-${i}`); wishes.push({ topic: `bulk-${i}`, category: 'coding', source: 'digest' }); }
  cat.decide(w2, wishes, { write: true });
  const many = finding(w2);
  assert.equal(many.level, 'warn');
  assert.match(many.text, /101 proposals await/);
  assert.match(many.text, /^101 of 101/);
});

test('doctor: the category tables are not orphan drawers; a real stray file still is (negative control)', () => {
  const w = world();
  entry(w, 'o-one'); entry(w, 'o-two');
  cat.adoptSuggested(w);
  cat.assign(w, 'o-one', 'coding');
  cat.mergeCategories(w, 'design', 'media');
  cat.decide(w, [fresh('o-two', 'zzz-new', 'Zzz New')], { write: true });
  assert.ok(Object.values(memory.CATEGORY_TABLES).every((rel) => fs.existsSync(path.join(w, rel))), 'all four tables exist');
  assert.deepEqual(integrity.orphanJsonlFiles(w), []);
  fs.writeFileSync(path.join(w, 'global', 'category-notes.jsonl'), '{"x":1}\n');
  assert.deepEqual(integrity.orphanJsonlFiles(w).map((o) => o.name), ['category-notes.jsonl']);
});

// --- dashboard data contract ---------------------------------------------------------------------

test('dashboard data contract: categories {list, topics, unassigned, proposals, new, wishes, threshold}; topic.category in the topics lens', () => {
  const w = world();
  entry(w, 'dd-one'); entry(w, 'dd-two'); entry(w, 'dd-three');
  const empty = data.collectDashboard(w).categories;
  assert.deepEqual(Object.keys(empty).sort(), ['list', 'new', 'proposals', 'threshold', 'topics', 'unassigned', 'wishes']);
  assert.deepEqual(empty.list, []);
  assert.equal(empty.threshold, 3);
  assert.ok(empty.topics.every((t) => t.category === null));
  cat.adoptSuggested(w);
  cat.assign(w, 'dd-one', 'coding');
  cat.decide(w, [{ topic: 'dd-two', category: 'testing', source: 'reflector' }, fresh('dd-three', 'zz-wish', 'Zz Wish')], { write: true });
  const s = data.collectDashboard(w).categories;
  const byTopic = Object.fromEntries(s.topics.map((t) => [t.topic, t]));
  assert.deepEqual(Object.keys(byTopic['dd-one']).sort(), ['category', 'count', 'topic']);
  assert.deepEqual(byTopic['dd-one'].category, { key: 'coding', label: 'Coding', status: 'confirmed', source: 'person' });
  assert.deepEqual(byTopic['dd-two'].category, { key: 'testing', label: 'Testing', status: 'proposal', source: 'reflector' });
  assert.equal(byTopic['dd-three'].category, null);
  assert.deepEqual(s.unassigned, { topics: 1, entries: 1, names: ['dd-three'] });
  assert.deepEqual(s.proposals, [{ topic: 'dd-two', category: 'testing', label: 'Testing', source: 'reflector' }]);
  assert.deepEqual(s.wishes, [{ key: 'zz-wish', label: 'Zz Wish', topics: 1 }]);
  assert.deepEqual(Object.keys(s.list[0]).sort(), ['entries', 'key', 'label', 'source', 'status', 'topics']);
  const lens = viewer.topicsLens(w).topics.find((t) => t.topic === 'dd-one');
  assert.deepEqual(lens.category, byTopic['dd-one'].category, 'the same field the topics lens carries');
  assert.equal(viewer.topicsLens(w).topics.find((t) => t.topic === 'dd-three').category, null);
  const whole = data.collectDashboard(w);
  assert.deepEqual(whole.categories, s);
  assert.deepEqual(whole.topics.list.find((t) => t.topic === 'dd-one').category, byTopic['dd-one'].category);
});

test('append only: no category operation changes an existing line of any table or of an entry file', () => {
  const w = world();
  entry(w, 'ap-one'); entry(w, 'ap-two');
  cat.adoptSuggested(w);
  const snap = () => Object.fromEntries(['global/thoughts.jsonl', ...Object.values(memory.CATEGORY_TABLES)].map((rel) => [rel, lines(w, rel)]));
  const ops = [
    () => cat.assign(w, 'ap-one', 'coding'),
    () => cat.decide(w, [{ topic: 'ap-two', category: 'design', source: 'digest' }], { write: true }),
    () => cat.confirm(w, null),
    () => cat.createCategory(w, 'coding', 'Code'),
    () => cat.mergeCategories(w, 'security', 'operations'),
    () => ini.initialAssign(w, { write: true }),
  ];
  for (const op of ops) {
    const before = snap();
    op();
    const after2 = snap();
    for (const [rel, ls] of Object.entries(before)) assert.deepEqual(after2[rel].slice(0, ls.length), ls, `${rel}: old lines unchanged`);
  }
  assert.equal(snap()['global/thoughts.jsonl'].length, 2, 'entries: not one line added by a category operation');
});

test('no German text or personal name ships in the category code', () => {
  for (const f of ['src/categories.mjs', 'src/categories-initial.mjs']) {
    const t = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(!/[äöüß]/.test(t), `${f}: no umlauts`);
    assert.ok(!/\b(Kategorie|Thema|Eintrag|zuordnen|Lucky)\b/.test(t.replace(/Lucky H\./g, '')), `${f}: no German words or names`);
  }
});

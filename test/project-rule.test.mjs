// test/project-rule.test.mjs - the project rule (port of lucky-mem
// `projekt-regel-lm` E2-E4 and `projekt-auto-lm`, 2026-10-03).
//
//   * a project made PAST the command (`projectnew.handmade`) is visible,
//   * the Today card / `mem today` lists projects awaiting confirmation,
//   * a person can confirm a hand-made project (or the button is dead),
//   * the rule stands as one line in `mem core` and in the subagent start,
//   * a session (not an unattended run) creates a project directly, status new.
//
// Red proof: a FIXED base commit (never `git merge-base`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as projectnew from '../src/projectnew.mjs';
import * as today from '../src/today.mjs';
import * as subagentstart from '../src/subagentstart.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';
const MEM = path.join(REPO, 'bin', 'mem');

function makeRoot() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-project-rule-'));
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.mkdirSync(path.join(w, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'), JSON.stringify({
    version: 1, language: 'en', participants: { user: { role: 'the human', human: true }, session: 'an AI session' },
  }));
  return w;
}
const drop = (w) => fs.rmSync(w, { recursive: true, force: true });

function makeRootFor() { const w = makeRoot(); process.on('exit', () => drop(w)); return w; }

/** A project the way a hand does it: a folder and an entry, no command. */
function byHand(w, name, ts = '2026-10-03T08:00:00Z') {
  const dir = path.join(w, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'decisions.jsonl'), `${JSON.stringify({ id: `h${name}`.slice(0, 12), ts, title: 'A first entry', choice: 'x' })}\n`);
}

const cli = (w, argv, env = {}) => spawnSync(process.execPath, [MEM, ...argv, '--root', w],
  { encoding: 'utf8', env: { ...process.env, MEM_HEADLESS: '', ...env } });

test('RED PROOF: at the base commit none of the pieces exists (positive control: today they do)', () => {
  const at = (f) => execFileSync('git', ['show', `${BASE}:${f}`], { cwd: REPO, encoding: 'utf8' });
  assert.ok(!at('src/projectnew.mjs').includes('handmade'), 'handmade existed at the base');
  assert.ok(!at('src/today.mjs').includes('projectsAwaiting'), 'projectsAwaiting existed at the base');
  assert.ok(!at('src/memory.mjs').includes('Never create project folders by hand'), 'the core line existed at the base');
  // positive control: the same markers are in today's tree.
  assert.equal(typeof projectnew.handmade, 'function');
  assert.ok('projects' in today.today(makeRootFor(), { doctorResult: { findings: [], summary: {} } }));
});

test('handmade: a folder with entries after the rule date, no event, no status is reported', () => {
  const w = makeRoot();
  try {
    byHand(w, 'garden');
    const h = projectnew.handmade(w);
    assert.deepEqual(h.map((x) => x.name), ['garden']);
    assert.equal(h[0].firstEntry, '2026-10-03T08:00:00Z');
  } finally { drop(w); }
});

test('handmade: NOT reported - made with the command, with a status, older than the rule, or empty', () => {
  const w = makeRoot();
  try {
    projectnew.createProject(w, 'orchard', { title: 'Orchard', reason: 'a reason' });
    byHand(w, 'legacy-one', '2026-09-01T08:00:00Z');
    byHand(w, 'with-status');
    fs.writeFileSync(path.join(w, 'projects', 'with-status', 'facts.yaml'), 'status: "confirmed"\n');
    fs.mkdirSync(path.join(w, 'projects', 'empty-dir'), { recursive: true });
    assert.deepEqual(projectnew.handmade(w), []);
  } finally { drop(w); }
});

test('suggestions and its text name a hand-made project; without one there is no extra paragraph', () => {
  const w = makeRoot();
  try {
    assert.doesNotMatch(projectnew.suggestionsText(projectnew.suggestions(w)), /Made past the command/);
    byHand(w, 'garden');
    const r = projectnew.suggestions(w);
    assert.deepEqual(r.handmade.map((x) => x.name), ['garden']);
    assert.match(projectnew.suggestionsText(r), /Made past the command[\s\S]*garden \(first entry 2026-10-03/);
  } finally { drop(w); }
});

test('confirmProject accepts a hand-made project (even without facts.yaml) and then it is no longer waiting', () => {
  const w = makeRoot();
  try {
    byHand(w, 'garden');
    assert.throws(() => projectnew.confirmProject(w, 'orchard'), /does not exist/);
    const { entry } = projectnew.confirmProject(w, 'garden', { by: 'human:test' });
    assert.ok(entry.id);
    assert.equal(projectnew.projectStatus(w, 'garden').status, 'confirmed');
    assert.deepEqual(projectnew.handmade(w), []);
    // a project that is neither new nor hand-made is still refused
    assert.throws(() => projectnew.confirmProject(w, 'garden'), /not marked new/);
  } finally { drop(w); }
});

test('today(): projects awaiting = status new + hand-made, counted once, in the line and the text', () => {
  const w = makeRoot();
  try {
    projectnew.createProject(w, 'orchard', { title: 'Orchard', reason: 'a reason' });
    byHand(w, 'garden');
    const t = today.today(w, { doctorResult: { findings: [], summary: {} } });
    assert.equal(t.projects.readable, true);
    assert.deepEqual(t.projects.list.map((p) => [p.name, p.kind]).sort(), [['garden', 'hand'], ['orchard', 'new']]);
    assert.equal(t.counts.projectsAwaiting, 2);
    assert.match(t.line, /2 projects awaiting confirmation/);
    const text = today.asText(t);
    assert.match(text, /PROJECTS AWAITING CONFIRMATION: 2/);
    assert.match(text, /\[new\] orchard {2}mem project confirm orchard/);
    assert.match(text, /\[by hand\] garden/);
  } finally { drop(w); }
});

test('today(): nothing waiting = an empty list and no part in the line (positive control: one waiting shows)', () => {
  const w = makeRoot();
  try {
    const t = today.today(w, { doctorResult: { findings: [], summary: {} } });
    assert.deepEqual(t.projects.list, []);
    assert.equal(t.counts.projectsAwaiting, 0);
    assert.doesNotMatch(String(t.line ?? ''), /awaiting confirmation/);
    projectnew.createProject(w, 'orchard', { title: 'Orchard', reason: 'a reason' });
    assert.match(today.today(w, { doctorResult: { findings: [], summary: {} } }).line, /1 project awaiting confirmation/);
  } finally { drop(w); }
});

test('the rule is one line in `mem core`, before the facts, with or without facts', () => {
  const w = makeRoot();
  try {
    const text = memory.core(w);
    const lines = text.split('\n');
    const at = lines.findIndex((l) => /Never create project folders by hand/.test(l));
    assert.ok(at >= 0, 'the rule line is missing');
    assert.match(lines[at], /mem project new <name> --title \.\.\. --reason \.\.\./);
    assert.ok(at <= 3, `the rule must stand before the facts (line ${at})`);
  } finally { drop(w); }
});

test('the subagent start carries the rule in its closing hint', () => {
  const w = makeRoot();
  try {
    assert.match(subagentstart.buildContext(w), /A new project only via `mem project new/);
  } finally { drop(w); }
});

test('a session (not an unattended run) creates a project directly: status new, no captures needed', () => {
  const w = makeRoot();
  try {
    const r = cli(w, ['project', 'new', 'garden', '--title', 'Garden', '--reason', 'tomatoes']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(projectnew.projectStatus(w, 'garden').isNew, true);
    assert.deepEqual(projectnew.handmade(w), [], 'made with the command is not hand-made');
    // the unattended run stays strict
    const strict = cli(w, ['project', 'new', 'cellar', '--title', 'Cellar', '--reason', 'wine'], { MEM_HEADLESS: 'digest' });
    assert.notEqual(strict.status, 0);
    assert.match(strict.stderr, /evidence is not enough/);
  } finally { drop(w); }
});

test('the dashboard card lists them with the confirm button, and nothing when none waits', () => {
  const js = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
  assert.match(js, /function todayProjectsPart\(list\)/);
  assert.match(js, /if \(!list\.length\) return '';\n {2}return `<div class="label" style="margin:16px 0 6px">Projects awaiting confirmation/);
  assert.match(js, /btn\('Confirm project', 'project-confirm'/);
  assert.match(js, /!gold\.length && !projects\.length/);
});

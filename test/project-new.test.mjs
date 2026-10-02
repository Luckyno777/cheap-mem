// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Tests for src/projectnew.mjs — new projects (ported from the sibling
 * house, 2026-10-02, owner decision "option 2").
 *
 * Red proof: on the code before this port (4d746f6, branch
 * claude/welle2-integration) the tests on refusal fail (`mem log --project
 * <unknown>` created a half-made directory) and all tests on
 * projectnew.mjs fail (the module did not exist). The positive controls
 * show that the similarity rules DO fire AND that clearly different names
 * pass, that old half-made projects stay writable, and that a capture
 * without a shared word is no evidence.
 *
 * Every project name in this file is a made-up fixture; nothing here is
 * a name the product knows.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as pn from '../src/projectnew.mjs';
import * as data from '../src/dashboard-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const dirs = [];

function world(projects = ['alpha', 'beta-tool']) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-pn-'));
  dirs.push(w);
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(w, '.mem', 'config.json'),
    JSON.stringify({ name: 'pn', participants: { alex: { human: true }, probe: {} }, language: 'en' }));
  fs.mkdirSync(path.join(w, 'global'), { recursive: true });
  for (const p of projects) memory.projectInit(w, p);
  return w;
}
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

/** Put a capture where `raw.readCapture` finds it; the file name carries the time. */
function capture(w, name, text) {
  const rel = `raw/2026/09/${name}.jsonl.gz`;
  fs.mkdirSync(path.join(w, 'raw/2026/09'), { recursive: true });
  const lines = [JSON.stringify({ __stamp: { session_id: 'x' }, __lines: 1 }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } })];
  fs.writeFileSync(path.join(w, rel), zlib.gzipSync(`${lines.join('\n')}\n`));
  return rel;
}
const cli = (w, args, env = {}) => spawnSync('node', [MEM, ...args], {
  encoding: 'utf8',
  env: { ...process.env, CHEAP_MEM_ROOT: w, CHEAP_MEM_AGENT: 'pn-test', MEM_HEADLESS: '', ...env },
});

// --- no silent creation -------------------------------------------------

test('log with an unknown project is refused, NO directory appears, the hint names the way', () => {
  const w = world();
  assert.throws(
    () => memory.logEntry(w, 'thought', { title: 'x', text: 'y' }, { project: 'meadow' }),
    /does not exist.*mem project new meadow/s);
  assert.equal(fs.existsSync(path.join(w, 'projects', 'meadow')), false, 'half-made directory appeared');
});

test('positive control: an existing (even old half-made) project stays writable, global too', () => {
  const w = world();
  memory.logEntry(w, 'thought', { title: 'x', text: 'y' }, { project: 'alpha' });
  fs.mkdirSync(path.join(w, 'projects', 'legacy'), { recursive: true }); // a half-made directory from before
  const { path: p } = memory.logEntry(w, 'thought', { title: 'x', text: 'y' }, { project: 'legacy' });
  assert.ok(fs.existsSync(p));
  memory.logEntry(w, 'thought', { title: 'g', text: 'global' });
});

test('CLI: mem log --project <unknown> fails with the hint and writes nothing', () => {
  const w = world();
  const r = cli(w, ['log', 'thought', '--title', 'a', '--text', 'b', '--project', 'meadow']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /mem project new meadow/);
  assert.equal(fs.existsSync(path.join(w, 'projects', 'meadow')), false);
});

test('an entry is never lost: refused with the project, accepted again without it', () => {
  const w = world();
  assert.throws(() => memory.logEntry(w, 'thought', { title: 'kept', text: 'y' }, { project: 'meadow' }));
  const { entry } = memory.logEntry(w, 'thought', { title: 'kept', text: 'y' });
  assert.equal([...memory.iterLog(w, 'thought', { project: null })].filter((e) => e.id === entry.id).length, 1);
});

// --- similarity ---------------------------------------------------------

test('similarReason: distance, word part and spelling fire', () => {
  const hits = [
    ['alpha-app', 'alpha'], ['alpha', 'alpha-app'], ['app-alpha', 'alpha'],
    ['Alpha', 'alpha'], ['beta_tool', 'beta-tool'], ['betatool', 'beta-tool'],
    ['alhpa', 'alpha'], ['betatol', 'beta-tool'], ['meadows', 'meadow'],
  ];
  for (const [a, b] of hits) assert.ok(pn.similarReason(a, b), `${a} ~ ${b} should fire`);
});

test('positive control: clearly different names are NOT reported as similar', () => {
  for (const [a, b] of [['meadow', 'alpha'], ['orchard', 'beta-tool'], ['abc', 'xyz'], ['kite', 'alpha']]) {
    assert.equal(pn.similarReason(a, b), null, `${a} ~ ${b} wrongly similar`);
  }
});

test('createProject refuses and NAMES the existing project', () => {
  const w = world();
  assert.throws(() => pn.createProject(w, 'alpha-app', { title: 't', reason: 'r' }), /existing project 'alpha'/);
  assert.equal(fs.existsSync(path.join(w, 'projects', 'alpha-app')), false);
});

test('createProject refuses a name too like a topic alias (from or to) and names it', () => {
  const w = world();
  memory.mergeTopics(w, ['payment-terms'], 'invoicing');
  assert.throws(() => pn.createProject(w, 'invoicing-new', { title: 't', reason: 'r' }), /topic alias 'invoicing'/);
  assert.throws(() => pn.createProject(w, 'payment-term', { title: 't', reason: 'r' }), /topic alias 'payment-terms'/);
  assert.equal(memory.listProjects(w).length, 2);
});

// --- create / confirm ---------------------------------------------------

test('createProject: skeleton, status new, event with reason and origin', () => {
  const w = world();
  const r = pn.createProject(w, 'meadow', { title: 'Meadow', reason: 'two days of mowing plans', agent: 'digest' });
  const dir = path.join(w, 'projects', 'meadow');
  for (const f of ['README.md', 'facts.yaml', 'sources.yaml', 'events.jsonl']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const st = pn.projectStatus(w, 'meadow');
  assert.equal(st.isNew, true);
  assert.equal(st.created_by, 'digest');
  assert.match(st.created_on, /^\d{4}-\d{2}-\d{2}$/);
  const ev = [...memory.iterLog(w, 'event', { project: 'meadow' })];
  assert.equal(ev.length, 1);
  assert.equal(ev[0].title, 'Project created');
  assert.equal(ev[0].reason, 'two days of mowing plans');
  assert.equal(ev[0].origin.via, 'project-new');
  assert.equal(r.entry.id, ev[0].id);
  assert.throws(() => pn.createProject(w, 'meadow', { title: 't', reason: 'g' }), /already exists/);
  assert.throws(() => pn.createProject(w, 'orchard', { title: 't' }), /--reason is missing/);
  assert.throws(() => pn.createProject(w, 'orchard', { reason: 'g' }), /--title is missing/);
  assert.equal(pn.projectStatus(w, 'alpha').isNew, false, 'an old project must not read as new');
  memory.logEntry(w, 'thought', { title: 'now writable', text: 'y' }, { project: 'meadow' });
});

test('confirmProject removes the mark, keeps who created it, writes an event, is not repeatable', () => {
  const w = world();
  pn.createProject(w, 'meadow', { title: 'Meadow', reason: 'r' });
  pn.confirmProject(w, 'meadow', { by: 'alex' });
  const st = pn.projectStatus(w, 'meadow');
  assert.equal(st.isNew, false);
  assert.equal(st.status, 'confirmed');
  assert.ok(st.created_by, 'who created it was lost');
  assert.deepEqual([...memory.iterLog(w, 'event', { project: 'meadow' })].map((e) => e.title),
    ['Project created', 'Project confirmed']);
  assert.throws(() => pn.confirmProject(w, 'meadow'), /not marked new/);
  assert.throws(() => pn.confirmProject(w, 'nothing'), /does not exist/);
});

// --- evidence in an unattended run -------------------------------------

test('strict (unattended run): 2 evidenced captures on 2 days are required, otherwise nothing is created', () => {
  const w = world();
  const a = capture(w, '2026-09-10T10-00-00Z--aaa', 'mowing plans for the meadow, first pass');
  const b = capture(w, '2026-09-10T15-00-00Z--bbb', 'meadow mowing again');
  const c = capture(w, '2026-09-11T09-00-00Z--ccc', 'the meadow needs mowing plans');
  const args = { title: 'Meadow', reason: 'mowing plans for the meadow', strict: true };
  assert.throws(() => pn.createProject(w, 'meadow', args), /evidence is not enough/);
  assert.throws(() => pn.createProject(w, 'meadow', { ...args, captures: [a, b] }), /2 evidenced captures on 2 different days/);
  assert.throws(() => pn.createProject(w, 'meadow', { ...args, captures: [a, a] }), /1 capture\(s\) on 1 day|2 different days/);
  assert.equal(fs.existsSync(path.join(w, 'projects', 'meadow')), false);
  const ok = pn.createProject(w, 'meadow', { ...args, captures: `${a},${c}` });
  assert.equal(ok.evidence.days.length, 2);
  const ev = [...memory.iterLog(w, 'event', { project: 'meadow' })][0];
  assert.deepEqual(ev.origin.raw, [a, c]);
});

test('positive control strict: a capture without a shared word, a missing file and a foreign path do not count', () => {
  const w = world();
  const a = capture(w, '2026-09-10T10-00-00Z--aaa', 'completely different topic, a car');
  const b = capture(w, '2026-09-11T10-00-00Z--bbb', 'also a car workshop');
  const args = { title: 'Meadow', reason: 'mowing the meadow', strict: true };
  assert.throws(() => pn.createProject(w, 'meadow', { ...args, captures: [a, b] }), /0 capture\(s\) on 0 day\(s\)/);
  assert.throws(() => pn.createProject(w, 'meadow', { ...args, captures: ['raw/2026/09/2026-09-12T10-00-00Z--zzz.jsonl.gz', '../../etc/passwd'] }),
    /unreadable|not a capture path/);
  // not strict: reported, not fatal, and not counted
  const soft = pn.createProject(w, 'meadow', { title: 'Meadow', reason: 'mowing the meadow', captures: [a] });
  assert.equal(soft.evidence.ok.length, 0);
  assert.equal(soft.evidence.rejected.length, 1);
  assert.equal([...memory.iterLog(w, 'event', { project: 'meadow' })][0].origin.raw, 'unknown');
});

// --- dry run ------------------------------------------------------------

test('suggestions: counts captures and days from the entries, creates nothing', () => {
  const w = world();
  const f1 = 'raw/2026/09/2026-09-10T10-00-00Z--aaa.jsonl.gz';
  const f2 = 'raw/2026/09/2026-09-11T10-00-00Z--bbb.jsonl.gz';
  const f3 = 'raw/2026/09/2026-09-11T11-00-00Z--ccc.jsonl.gz';
  const log = (topic, rawPath) => memory.logEntry(w, 'learning', { title: `t ${topic} ${rawPath}`, text: 'x', topic, origin: { raw: rawPath } });
  log('meadow', f1); log('meadow', f2);   // 2 captures, 2 days -> candidate
  log('garage', f2); log('garage', f3);   // 2 captures, 1 day -> none
  log('once', f1);                        // 1 capture -> none
  log('alpha-extra', f1); log('alpha-extra', f2); // candidate, but the name is too alike
  const before = fs.readdirSync(path.join(w, 'projects')).sort();
  const r = pn.suggestions(w);
  assert.deepEqual(r.candidates.map((k) => [k.name, k.captures, k.days]).sort(), [['alpha-extra', 2, 2], ['meadow', 2, 2]]);
  assert.equal(r.candidates.find((k) => k.name === 'alpha-extra').similar, 'alpha');
  assert.equal(r.candidates.find((k) => k.name === 'meadow').similar, null);
  assert.deepEqual(fs.readdirSync(path.join(w, 'projects')).sort(), before, 'the dry run created something');
  assert.match(pn.suggestionsText(r), /meadow \| 2 \| 2 \| 2/);
});

test('CLI: suggestions on a memory with nothing to suggest, and the whole flow new/confirm', () => {
  const w = world();
  let r = cli(w, ['project', 'suggestions']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Candidates: none/);
  r = cli(w, ['project', 'new', 'alpha-app', '--title', 'T', '--reason', 'R']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /project 'alpha'/);
  r = cli(w, ['project', 'new', 'meadow', '--title', 'Meadow', '--reason', 'R']);
  assert.equal(r.status, 0, r.stderr);
  r = cli(w, ['log', 'thought', '--title', 'a', '--text', 'b', '--project', 'meadow']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // unattended: no evidence -> refused; confirming -> refused (only a person)
  r = cli(w, ['project', 'new', 'orchard', '--title', 'O', '--reason', 'R'], { MEM_HEADLESS: 'digest' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /evidence is not enough/);
  r = cli(w, ['project', 'confirm', 'meadow'], { MEM_HEADLESS: 'digest' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /only a person confirms/);
  assert.equal(pn.projectStatus(w, 'meadow').isNew, true);
  r = cli(w, ['project', 'confirm', 'meadow']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(pn.projectStatus(w, 'meadow').isNew, false);
  r = cli(w, ['project', 'frob']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /Known: init, new, confirm, suggestions/);
});

// --- MCP bridge -----------------------------------------------------------

function bridge(w, calls, env = {}) {
  const lines = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })];
  for (const [name, args] of calls) {
    lines.push(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }));
  }
  const r = spawnSync('node', [MCP], {
    input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000,
    env: { ...process.env, CHEAP_MEM_ROOT: w, MEM_HEADLESS: '', ...env },
  });
  return String(r.stdout).split('\n').filter((z) => z.trim()).map((z) => JSON.parse(z)).slice(1);
}

test('MCP: mem_project_new creates, a too-alike name is refused, mem_log with an unknown project errors', () => {
  const w = world();
  const [made, alike, logged] = bridge(w, [
    ['mem_project_new', { name: 'meadow', title: 'Meadow', reason: 'R' }],
    ['mem_project_new', { name: 'alpha-app', title: 'T', reason: 'R' }],
    ['mem_log', { type: 'thought', title: 'x', text: 'y', project: 'orchard' }],
  ]);
  assert.ok(!made.result?.isError && !made.error, JSON.stringify(made));
  assert.equal(pn.projectStatus(w, 'meadow').isNew, true);
  assert.match(JSON.stringify(alike), /existing project 'alpha'/);
  assert.match(JSON.stringify(logged), /does not exist/);
  assert.equal(fs.existsSync(path.join(w, 'projects', 'orchard')), false);
});

test('MCP: read-only profile lets the dry run through and refuses mem_project_new', () => {
  const w = world();
  const [dry, made] = bridge(w, [['mem_project_suggestions', {}], ['mem_project_new', { name: 'meadow', title: 'M', reason: 'R' }]],
    { CHEAP_MEM_MCP_READONLY: '1' });
  assert.ok(!dry.error && !dry.result?.isError, JSON.stringify(dry));
  assert.match(JSON.stringify(dry), /Candidates: none/);
  assert.ok(made.error || made.result?.isError, 'mem_project_new passed a read-only profile');
  assert.equal(fs.existsSync(path.join(w, 'projects', 'meadow')), false);
});

// --- dashboard ------------------------------------------------------------

test('dashboard data: a new project carries isNew, old projects do not, confirming clears it', () => {
  const w = world();
  pn.createProject(w, 'meadow', { title: 'Meadow', reason: 'r', agent: 'digest' });
  const shelf = () => data.collectDashboard(w, { now: new Date('2026-10-02T09:00:00Z') }).projectShelf.projects;
  assert.equal(shelf().find((p) => p.name === 'meadow').isNew, true);
  assert.equal(shelf().find((p) => p.name === 'meadow').createdBy, 'digest');
  assert.equal(shelf().find((p) => p.name === 'alpha').isNew, false);
  pn.confirmProject(w, 'meadow');
  assert.equal(shelf().find((p) => p.name === 'meadow').isNew, false);
});

test('dashboard page: the Projects card shows the mark "new · unconfirmed" (source probe, no browser)', () => {
  const js = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');
  const part = js.slice(js.indexOf('projects: () =>'), js.indexOf('files: () =>'));
  assert.ok(part.includes("r?.isNew ? ' ' + badge('warning', 'new · unconfirmed')"), 'the mark is missing from the card head');
  assert.ok(part.includes('mem project confirm'), 'the hint at confirming is missing');
});

// --- prompt rule ------------------------------------------------------------

test('digest prompt, DIGEST.md, reflector prompt and house rules carry the rule', () => {
  const sh = fs.readFileSync(path.join(REPO, 'bin', 'mem-digest'), 'utf8');
  assert.ok(sh.includes("New project (DIGEST.md, section 'A new project')"));
  assert.match(sh, /mem project new <name> --title/);
  const ps = fs.readFileSync(path.join(REPO, 'bin', 'mem-digest.ps1'), 'utf8');
  assert.match(ps, /mem project new <name> --title/);
  const md = fs.readFileSync(path.join(REPO, 'DIGEST.md'), 'utf8');
  assert.match(md, /^## A new project$/m);
  assert.match(md, /at least \*\*2 captures on 2\s+different days\*\*/);
  for (const f of ['mem-reflect', 'mem-reflect.ps1']) {
    assert.match(fs.readFileSync(path.join(REPO, 'bin', f), 'utf8'), /You do not create projects/);
  }
  assert.match(fs.readFileSync(path.join(REPO, 'HOUSE-RULES.md'), 'utf8'), /mem_project_new/);
});

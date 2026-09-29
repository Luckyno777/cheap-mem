// test/integration-contract.test.mjs -- X2: the integration contract.
//
// Three promises, each with its own probe:
//   1. the document and the code say the same (the generated block);
//   2. every cell declared full points at something that exists;
//   3. the doctor finding has its four states and they are reachable.
//
// A probe that finds nothing proves nothing, so the POSITIVE tests come
// first: the registrations really are read from the installer, and a
// cell whose evidence is gone really does turn the verdict red.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as c from '../src/integrationcontract.mjs';
import { checkIntegrationContract } from '../src/doctor.mjs';

const REPO = c.CODE_ROOT;
const DOC = path.join(REPO, 'docs', 'integration-contract.md');

const made = [];
after(() => { for (const r of made) fs.rmSync(r, { recursive: true, force: true }); });
const temp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-x2-'));
  made.push(r);
  return r;
};

/** A settings file that registers every hook the matrix names for Claude Code. */
function settingsWith(dir, hooks) {
  const p = path.join(dir, 'settings.json');
  const cfg = { hooks: { Any: hooks.map((h) => ({ hooks: [{ type: 'command', command: `bash ~/.claude/hooks/${h}` }] })) } };
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}
const claudeHooks = () => [...new Set(
  Object.values(c.MATRIX[c.CLIENT.CLAUDE_CODE]).flatMap((cell) => cell.entries)
    .filter((e) => e.register).map((e) => e.register.hook))];

// --- the probe sees something ---------------------------------------------

test('POSITIVE: the registrations are read from the installer, not restated', () => {
  const regs = c.registrations(REPO);
  assert.ok(regs.length >= 6, `only ${regs.length} registrations found`);
  assert.ok(regs.some((r) => r.event === 'SessionStart' && r.hook === 'cheap-mem-session-start.sh'));
  assert.ok(regs.some((r) => r.event === 'PreToolUse' && r.matcher === 'Edit|Write|NotebookEdit'));
  assert.equal(c.registrations(temp()), null, 'an unreadable installer is null, not an empty list');
});

test('the matrix is complete: 3 clients x 5 occasions, a known state each', () => {
  assert.deepEqual(Object.keys(c.MATRIX), [...c.CLIENTS]);
  for (const client of c.CLIENTS) {
    assert.deepEqual(Object.keys(c.MATRIX[client]), [...c.OCCASIONS], client);
    for (const o of c.OCCASIONS) {
      const cell = c.MATRIX[client][o];
      assert.ok(Object.values(c.STATUS).includes(cell.status), `${client}/${o}`);
      assert.ok(cell.note.length > 20, `${client}/${o} has no note`);
      if (cell.status !== c.STATUS.MISSING) assert.ok(cell.entries.length > 0, `${client}/${o} names no evidence`);
    }
  }
  for (const o of c.OCCASIONS) { assert.ok(c.MEASURE[o] && c.BUDGET[o], `${o} has no measure/budget`); }
});

// --- 2. full points at something real -------------------------------------

test('in the real tree every cell has its evidence (and none is broken)', () => {
  const ev = c.evaluate(REPO);
  for (const client of c.CLIENTS) {
    for (const o of c.OCCASIONS) {
      const cell = ev.cells[client][o];
      assert.equal(cell.ok, true, `${client}/${o} lacks: ${cell.missing.join('; ')}`);
    }
  }
  assert.deepEqual(c.brokenCells(ev), []);
});

test('RED PROBE: a cell declared full that points at a missing file is caught', () => {
  const bad = structuredClone(c.MATRIX);
  bad[c.CLIENT.CLAUDE_CODE][c.OCCASION.BEFORE_CHANGE].entries.push({ file: 'install/hooks/does-not-exist.sh' });
  const ev = c.evaluate(REPO, bad);
  const broken = c.brokenCells(ev);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].client, 'claude-code');
  assert.equal(broken[0].occasion, 'before-change');
  assert.match(broken[0].missing[0], /does-not-exist\.sh/);
  // and a registration that the installer does not make
  const bad2 = structuredClone(c.MATRIX);
  bad2[c.CLIENT.CLAUDE_CODE][c.OCCASION.TASK_START].entries.push({ register: { event: 'PreCompact', hook: 'cheap-mem-nope.sh', matcher: null } });
  assert.equal(c.brokenCells(c.evaluate(REPO, bad2)).length, 1);
  // a partial cell with missing evidence is not "broken" (it never claimed more)
  const bad3 = structuredClone(c.MATRIX);
  bad3[c.CLIENT.CLI][c.OCCASION.TASK_START].entries.push({ file: 'nowhere.mjs' });
  assert.equal(c.brokenCells(c.evaluate(REPO, bad3)).length, 0);
});

// --- 1. document == code ---------------------------------------------------

test('the generated block of the document equals the code', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const block = c.extractBlock(doc);
  assert.notEqual(block, null, 'markers missing in docs/integration-contract.md');
  assert.equal(block, c.renderBlock(),
    'the block is stale: run `node src/integrationcontract.mjs --write`');
});

test('RED PROBE: a changed cell makes the block differ (the comparison sees something)', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  const changed = structuredClone(c.MATRIX);
  changed[c.CLIENT.CLAUDE_CODE][c.OCCASION.AFTER_ERROR].status = c.STATUS.FULL;
  assert.notEqual(c.extractBlock(doc), c.renderBlock(changed));
});

// --- 3. the doctor finding -------------------------------------------------

test('doctor: error when a cell declared full has no file (even without a client)', () => {
  const bad = structuredClone(c.MATRIX);
  bad[c.CLIENT.CLAUDE_CODE][c.OCCASION.SESSION_START].entries.push({ file: 'install/hooks/gone.sh' });
  const r = c.judge({ codeRoot: REPO, settingsPaths: [], matrix: bad });
  assert.equal(r.level, 'error');
  assert.match(r.text, /claude-code\/session-start/);
});

test('doctor: unknown when no client can be told (never good)', () => {
  const dir = temp();
  const none = path.join(dir, 'absent.json');
  assert.equal(c.judge({ codeRoot: REPO, settingsPaths: [none] }).level, 'unknown');
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'bash foreign.sh' }] }] } }));
  assert.equal(c.judge({ codeRoot: REPO, settingsPaths: [path.join(dir, 'other.json')] }).level, 'unknown');
});

test('doctor: warn on partial support when Claude Code is installed', () => {
  const dir = temp();
  const p = settingsWith(dir, claudeHooks());
  const r = c.judge({ codeRoot: REPO, settingsPaths: [p] });
  assert.equal(r.level, 'warn');
  assert.match(r.text, /after-error partial/);
  assert.match(r.text, /task-end partial/);
});

test('doctor: warn when a full hook is not registered on this machine', () => {
  const dir = temp();
  const p = settingsWith(dir, claudeHooks().filter((h) => h !== 'cheap-mem-pre-edit.sh'));
  const r = c.judge({ codeRoot: REPO, settingsPaths: [p] });
  assert.equal(r.level, 'warn');
  assert.match(r.text, /cheap-mem-pre-edit\.sh is not registered/);
});

test('doctor: good when every occasion of the installed client is full', () => {
  const dir = temp();
  const p = settingsWith(dir, claudeHooks());
  const allFull = structuredClone(c.MATRIX);
  for (const o of c.OCCASIONS) allFull[c.CLIENT.CLAUDE_CODE][o].status = c.STATUS.FULL;
  const r = c.judge({ codeRoot: REPO, settingsPaths: [p], matrix: allFull });
  assert.equal(r.level, 'good');
});

test('the finding wraps the verdict, and checkAll runs it', () => {
  const dir = temp();
  const f = checkIntegrationContract(dir, { settingsPaths: [path.join(dir, 'absent.json')] });
  assert.equal(f.name, 'integration-contract');
  assert.equal(f.level, 'unknown');
  const p = settingsWith(dir, claudeHooks());
  assert.equal(checkIntegrationContract(dir, { settingsPaths: [p] }).level, 'warn');
  // comments removed first: a commented-out call must not count as a proof
  const src = fs.readFileSync(path.join(REPO, 'src', 'doctor.mjs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /f\.push\(checkIntegrationContract\(root\)\)/, 'checkAll does not run the finding');
});

// --- the map: same numbers in both languages -------------------------------

test('the finding map carries the pair, and warum and why hold the same numbers', () => {
  const lines = fs.readFileSync(path.join(REPO, 'shared', 'finding-map.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const e = lines.find((x) => x.finding === 'integration-contract');
  assert.ok(e, 'no map entry for integration-contract');
  assert.equal(e.befund, 'integrationsvertrag');
  const nums = (t) => (t.match(/\d+/g) ?? []).filter((n) => n !== '2026' && n !== '09' && n !== '29').join(',');
  assert.equal(nums(e.warum), nums(e.why));
  assert.ok(nums(e.why).length > 0);
});

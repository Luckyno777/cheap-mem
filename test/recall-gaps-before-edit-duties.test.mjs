// recall-gaps (Z-abruf 16): the before-edit hook shows open duties and
// released procedures for the touched file — capped, closed ones never.
//
// **The gap.** `bin/mem-before-edit` filtered the component hits down to
// errors, decisions and learnings. A duty "guard for X at this file" or
// a released procedure naming the file was found and then dropped, so
// the moment an agent changes the file was the moment it did not hear
// what is still owed there. lucky-mem shows open duties for the file in
// its before-edit header (`offenKopfZeilen`, `src/fehlerkontext.mjs`).
//
// Red proof (recorded 2026-10-01 against 0a2fe4e, the base of this
// branch): THE CASE and DUTY ONLY fail there — the old hook prints the
// error line without any duty, and stays silent when only a duty exists.
// The positive controls prove the probe sees the duty while it is open
// and that the proposed rule IS a component hit, so their absence in the
// hook output is the filter, not a blind probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO, 'bin', 'mem-before-edit');
const MEM = path.join(REPO, 'bin', 'mem');
const FILE = '/home/x/proj/install/claude-code.sh';

function memory(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rg-be-'));
  const r = spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  for (const [file, lines] of Object.entries(entries)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return root;
}

function hook(root, session = 's1') {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: session, tool_name: 'Edit', tool_input: { file_path: FILE } }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '' },
  });
  const raw = String(r.stdout ?? '').trim();
  return { raw, ctx: raw ? JSON.parse(raw).hookSpecificOutput?.additionalContext ?? '' : '', stderr: r.stderr };
}

function componentJson(root) {
  const r = spawnSync('node', [MEM, '--root', root, 'component', 'install/claude-code.sh', '--hook', '--json'],
    { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

const ERROR = {
  id: 'e1', ts: '2026-09-07T10:00:00Z', class: 'unquoted-path', agent: 'a',
  title: 'install/claude-code.sh does not quote the bash path',
};
const OPEN_DUTY = {
  id: 'd1', ts: '2026-09-08T10:00:00Z', agent: 'a', owner: 'a', file: 'install/claude-code.sh',
  title: 'OWED-GUARD add a quoting probe',
};
const CLOSED_DUTY = {
  id: 'd2', ts: '2026-09-06T10:00:00Z', agent: 'a', owner: 'a',
  title: 'CLOSED-DUTY rewrite install/claude-code.sh header',
};
const CLOSER = { id: 'c2', ts: '2026-09-06T12:00:00Z', agent: 'a', closes_id: 'd2', state: 'done', why: 'done' };
const RELEASED = {
  id: 'p1', ts: '2026-09-05T10:00:00Z', issued_by: 'owner', start_status: 'released',
  title: 'RULE-IN-FORCE', rule: 'Quote every path in install/claude-code.sh.',
};
const PROPOSED = {
  id: 'p2', ts: '2026-09-05T11:00:00Z', issued_by: 'owner', start_status: 'proposed',
  title: 'RULE-PROPOSED', rule: 'Rewrite install/claude-code.sh in another language.',
};

const FULL = {
  'global/errors.jsonl': [ERROR],
  'global/duties.jsonl': [OPEN_DUTY, CLOSED_DUTY, CLOSER],
  'global/procedures.jsonl': [RELEASED, PROPOSED],
};

test('THE CASE: open duty and released procedure arrive; closed duty and proposed rule never', () => {
  const root = memory(FULL);
  try {
    const { ctx, stderr } = hook(root);
    assert.match(ctx, /unquoted-path/, `the error line itself (unchanged) ${stderr}`);
    assert.match(ctx, /\(open duty\).*OWED-GUARD/);
    assert.match(ctx, /\(procedure\).*RULE-IN-FORCE/);
    assert.ok(!/CLOSED-DUTY/.test(ctx), `a closed duty was shown:\n${ctx}`);
    assert.ok(!/RULE-PROPOSED/.test(ctx), `a proposed rule was shown:\n${ctx}`);
  } finally { cleanup(root); }
});

test('POSITIVE CONTROL: the same duty WITHOUT its closing line is shown; the proposed rule IS a hit', () => {
  const root = memory({ ...FULL, 'global/duties.jsonl': [OPEN_DUTY, CLOSED_DUTY] });
  try {
    const { ctx } = hook(root);
    assert.match(ctx, /\(open duty\).*CLOSED-DUTY/,
      'the probe must see the duty while it is open, else its absence above proves nothing');
    const j = componentJson(root);
    assert.match(j.hits.map((h) => h.label).join('\n'), /RULE-PROPOSED/,
      'the probe must see the proposed rule, else its absence above proves nothing');
    assert.deepEqual(j.procedures.map((p) => p.id), ['p1']);
  } finally { cleanup(root); }
});

test('DUTY ONLY: a file with nothing but an open duty is not silent', () => {
  const root = memory({ 'global/duties.jsonl': [OPEN_DUTY] });
  try {
    const { ctx, raw } = hook(root);
    assert.ok(raw, 'the hook stayed silent although a duty is owed for this file');
    assert.match(ctx, /\(open duty\).*OWED-GUARD/);
  } finally { cleanup(root); }
});

test('CAPPED: five open duties for the file show at most two', () => {
  const duties = Array.from({ length: 5 }, (_, i) => ({
    ...OPEN_DUTY, id: `dd${i}`, ts: `2026-09-1${i}T10:00:00Z`, title: `MANY-${i}`,
  }));
  const root = memory({ 'global/duties.jsonl': duties });
  try {
    const { ctx } = hook(root);
    const shown = ctx.match(/\(open duty\)/g) ?? [];
    assert.equal(shown.length, 2, ctx);
    assert.match(ctx, /MANY-4/, 'newest first');
  } finally { cleanup(root); }
});

test('TABLE PATH: the same answer when the component table is fresh', () => {
  const root = memory(FULL);
  try {
    const b = spawnSync('node', [MEM, '--root', root, 'component', '--rebuild'], { encoding: 'utf8', timeout: 30000 });
    assert.equal(b.status, 0, b.stderr);
    const j = componentJson(root);
    assert.equal(j.table.usedTable, true, 'control: the table answered');
    const { ctx } = hook(root);
    assert.match(ctx, /\(open duty\).*OWED-GUARD/);
    assert.match(ctx, /\(procedure\).*RULE-IN-FORCE/);
    assert.ok(!/CLOSED-DUTY|RULE-PROPOSED/.test(ctx), ctx);
  } finally { cleanup(root); }
});

test('FALSIFICATION: a duty about another file stays out', () => {
  const root = memory({ 'global/duties.jsonl': [{ ...OPEN_DUTY, file: 'install/other.sh', title: 'ELSEWHERE' }] });
  try {
    const { raw } = hook(root);
    assert.equal(raw, '', raw);
  } finally { cleanup(root); }
});

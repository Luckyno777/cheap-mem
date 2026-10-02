// P10 (ported from the sibling house, 2026-10-02): machine-made turns are
// not questions.
//
// A prompt that BEGINS with a foreign-turn marker - a harness relay,
// Stop-hook feedback, a subagent hand-back (`recallsignal.FOREIGN_TURN_MARKERS`)
// - is not searched, nothing is injected, and it is booked with its own
// reason `machine`. It never counts as a human miss. A person who QUOTES a
// marker mid-question, or a wrapper block followed by a real question,
// still asks a question.
//
// Red proof (rule 3): on the base commit 1d8f6c5 the hand-back was
// searched and injected (reason null); `machine` did not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as injection from '../src/injection.mjs';
import * as memory from '../src/memory.mjs';
import * as gap from '../src/gap.mjs';
import { FOREIGN_TURN_MARKERS, isForeignTurn } from '../src/recallsignal.mjs';

const CODE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(CODE, 'bin', 'mem');
const HOOK = path.join(CODE, 'bin', 'mem-retrieve');

function build() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p10-'));
  execFileSync('node', [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  for (let i = 0; i < 30; i += 1) {
    memory.logEntry(root, 'decision', { topic: `filler ${i}`, choice: `other content ${i}`, why: 'no relation' }, { project: null });
  }
  memory.logEntry(root, 'learning', {
    title: 'hummingbeat hummingbeat measurement', learning: 'the hummingbeat was measured and stays',
  }, { project: null });
  return root;
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

function ask(root, prompt, session) {
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ prompt, session_id: session }), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_ROOTS: root, MEM_RETRIEVE_NO_PULL: '1',
      MEM_RETRIEVE_TURNS: path.join(root, '.mem', 'turns'), MEM_HOOK_OFF: '', MEM_RETRIEVE_OFF: '', MEM_RECALL_SERVER: '0' },
  });
  const line = injection.read(root).lines.find((l) => l.session === session) ?? null;
  return { out: r.stdout, line };
}

test('P10: REASON.MACHINE is its own value and never a miss', () => {
  assert.equal(injection.REASON.MACHINE, 'machine');
  assert.notEqual(injection.REASON.MACHINE, injection.REASON.NO_SIGNAL);
  assert.equal(gap.isMiss({ occasion: 'question', reason: 'machine' }), false);
  // Positive control: the same probe does see a real miss.
  assert.equal(gap.isMiss({ occasion: 'question', reason: 'too-weak' }), true);
});

test('P10: only the START counts', () => {
  assert.equal(isForeignTurn('  ​[Subagent hand-back] done'), true);
  assert.equal(isForeignTurn('what does "[Subagent hand-back]" mean?'), false);
  assert.equal(isForeignTurn(''), false);
});

test('P10: the hook\'s first-character pre-gate covers every marker (no drift)', () => {
  const src = fs.readFileSync(HOOK, 'utf8');
  const gate = /case "\$\(printf '%s' "\$PROMPT"[^\n]*\n\s*([^)]+)\)/.exec(src);
  assert.ok(gate, 'pre-gate not found in bin/mem-retrieve');
  const chars = gate[1].split('|').map((c) => c.replace(/'/g, '').trim());
  for (const m of FOREIGN_TURN_MARKERS) assert.ok(chars.includes(m[0]), `marker "${m}" is not covered by the pre-gate`);
  const ps = fs.readFileSync(path.join(CODE, 'bin', 'mem-retrieve.ps1'), 'utf8');
  const psChars = /'([^']+)'\.Contains\(\$Lead\.Substring\(0, 1\)\)/.exec(ps);
  assert.ok(psChars, 'pre-gate not found in bin/mem-retrieve.ps1');
  for (const m of FOREIGN_TURN_MARKERS) assert.ok(psChars[1].includes(m[0]), `ps1: marker "${m}" not covered`);
});

for (const marker of ['[Subagent hand-back]', 'agent-message from=orchestrator', 'Stop hook feedback:']) {
  test(`P10: a turn that begins with "${marker}" is not searched and is booked as machine`, () => {
    const root = build();
    try {
      const session = `p10-${marker.replace(/\W/g, '').slice(0, 8)}`;
      const { out, line } = ask(root, `${marker} report: hummingbeat measured, all green.`, session);
      assert.equal(out, '', `a machine turn was injected: ${out.slice(0, 200)}`);
      assert.ok(line, 'not booked - silence');
      assert.equal(line.reason, 'machine');
      assert.equal(line.bytes, 0);
    } finally { rm(root); }
  });
}

test('P10 positive control: the same text WITHOUT a marker is searched and injected', () => {
  const root = build();
  try {
    const { out, line } = ask(root, 'report: hummingbeat measured, all green.', 'p10-pos');
    assert.ok(line, 'not booked');
    assert.equal(line.reason, null, `booked: ${line.reason}`);
    assert.match(out, /hummingbeat/);
  } finally { rm(root); }
});

test('P10 positive control: a person QUOTING a marker mid-question still asks a question', () => {
  const root = build();
  try {
    const { line } = ask(root, 'What does "[Subagent hand-back]" mean for the hummingbeat?', 'p10-quote');
    assert.ok(line, 'not booked');
    assert.ok(!['machine', 'no-signal'].includes(line.reason), `booked: ${line.reason}`);
  } finally { rm(root); }
});

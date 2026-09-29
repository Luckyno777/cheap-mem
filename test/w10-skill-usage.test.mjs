// Probes for W10 (parity twin of lucky-mem's test/w10-skill-nutzung.test.mjs):
// skill usage measured from the raw-capture archive.
// Red proof: at the branch start (782782f) src/skillusage.mjs, `mem skills`
// and the finding `skill-usage` do not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as su from '../src/skillusage.mjs';
import * as doctor from '../src/doctor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const CANARY = 'SECRET-TRANSCRIPT-TEXT-4711';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function capture(root, rel, session, lines, { from = '2026-01-01T00:00:00Z', to = '2026-01-02T00:00:00Z' } = {}) {
  const dest = path.join(root, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const head = { __stamp: { session_id: session, ts_from: from, ts_to: to } };
  const body = [head, ...lines].map((z) => JSON.stringify(z)).join('\n') + '\n';
  fs.writeFileSync(dest, zlib.gzipSync(Buffer.from(body, 'utf8')));
}
const viaTool = (skill, ts) => ({ type: 'assistant', timestamp: ts,
  message: { content: [{ type: 'text', text: CANARY }, { type: 'tool_use', name: 'Skill', input: { skill, args: CANARY } }] } });
const viaCommand = (name, ts) => ({ type: 'user', timestamp: ts,
  message: { content: `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${CANARY}</command-args>` } });
const inventory = (root, ...names) => {
  for (const n of names) {
    fs.mkdirSync(path.join(root, '.claude', 'skills', n), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: >-\n  description ${n}\n---\nbody\n`);
  }
};
function build(days = 40) {
  const root = tmp('cm-w10-');
  inventory(root, 'mem', 'never-pulled');
  const to = new Date(Date.parse('2026-01-01T00:00:00Z') + days * 86400000).toISOString();
  capture(root, 'raw/2026/01/a.jsonl.gz', 's1', [viaTool('mem', '2026-01-03T10:00:00Z'), viaCommand('mem', '2026-01-04T10:00:00Z'), viaTool('foreign:plugin', '2026-01-05T10:00:00Z')]);
  capture(root, 'raw/2026/02/b.jsonl.gz', 's2', [viaTool('mem', '2026-02-01T10:00:00Z'),
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'evil name <x>' } }] } }],
  { from: '2026-01-02T00:00:00Z', to });
  return root;
}

test('counts: tool + command, last use, sessions, coverage text', () => {
  const r = su.measure(build(), { env: {} });
  assert.equal(r.state, 'measured');
  const mem = r.skills.find((s) => s.name === 'mem');
  assert.deepEqual([mem.calls, mem.tool, mem.command, mem.sessions, mem.last], [3, 2, 1, 2, '2026-02-01']);
  assert.equal(r.skills.find((s) => s.name === 'foreign:plugin').inInventory, false);
  assert.equal(r.unreadableNames, 1);
  assert.match(r.coverage, /^measured over 2 sessions \/ 2 captures \(2026-01-01 \.\. 2026-02-\d\d\); subagents not captured \(handover 5\.2\)$/);
});

test('a never-pulled skill is "not observed", never "unused"', () => {
  const r = su.measure(build(), { env: {} });
  assert.deepEqual(r.notObserved, ['never-pulled']);
  const t = su.asText(r);
  assert.match(t, /Not observed \(house inventory, 1\): never-pulled/);
  assert.match(t, /subagents not captured/);
  assert.doesNotMatch(t.replace(/does NOT mean unused/g, ''), /unused/);
});

test('no transcript text in any output (text, JSON, finding, CLI)', () => {
  const root = build();
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  const r = su.measure(root, { env: {} });
  const f = doctor.checkSkillUsage(root, { env: {} });
  for (const s of [su.asText(r), JSON.stringify(su.asJson(r)), JSON.stringify(f)]) {
    assert.ok(!s.includes(CANARY) && !s.includes('evil name'), s);
  }
  const init = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  const cli = spawnSync(process.execPath, [MEM, 'skills', 'usage', '--json', '--root', root], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(!cli.stdout.includes(CANARY));
  assert.equal(JSON.parse(cli.stdout).skills.find((s) => s.name === 'mem').calls, 3);
});

test('time cap -> unknown with "partially read", no not-observed list', () => {
  const root = build();
  const r = su.measure(root, { env: { MEM_SKILLUSAGE_TIME_MS: '0' } });
  assert.equal(r.state, 'unknown');
  assert.match(r.reason, /partially read: 0 of 2/);
  assert.deepEqual(r.notObserved, []);
  const f = doctor.checkSkillUsage(root, { env: { MEM_SKILLUSAGE_TIME_MS: '0' } });
  assert.equal(f.level, doctor.LEVEL.UNKNOWN);
  assert.match(f.text, /partially read/);
});

test('finding: WARNING at >= N days of coverage, never ERROR; names only in the advice', () => {
  const f = doctor.checkSkillUsage(build(40), { env: { MEM_SKILLUSAGE_DAYS: '30' } });
  assert.equal(f.name, 'skill-usage');
  assert.equal(f.level, doctor.LEVEL.WARNING, JSON.stringify(f));
  assert.match(f.text, /subagents not captured/);
  assert.doesNotMatch(f.text, /never-pulled/);
  assert.match(f.advice, /never-pulled/);
  assert.match(f.advice, /Nothing is removed automatically/);
});

test('finding: short coverage -> unknown; all observed -> good; no archive -> unknown', () => {
  assert.equal(doctor.checkSkillUsage(build(5), { env: { MEM_SKILLUSAGE_DAYS: '30' } }).level, doctor.LEVEL.UNKNOWN);
  const root = build(40);
  fs.rmSync(path.join(root, '.claude', 'skills', 'never-pulled'), { recursive: true });
  assert.equal(doctor.checkSkillUsage(root, { env: {} }).level, doctor.LEVEL.GOOD);
  assert.equal(doctor.checkSkillUsage(tmp('cm-w10-empty-'), { env: {} }).level, doctor.LEVEL.UNKNOWN);
});

test('positive control: callsOf sees both ways and ignores the rest', () => {
  assert.equal(su.callsOf(viaTool('x', 't')).hits[0].via, 'tool');
  assert.equal(su.callsOf(viaCommand('y', 't')).hits[0].via, 'command');
  assert.equal(su.callsOf({ type: 'user', message: { content: `typed /mem ${CANARY}` } }).hits.length, 0);
  assert.equal(su.callsOf({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { skill: 'x' } }] } }).hits.length, 0);
});

test('duplicates are proposals only', () => {
  assert.deepEqual(su.nearDuplicates([{ name: 'a-b', description: '' }, { name: 'p:ab', description: '' }, { name: 'c', description: '' }]),
    [{ a: 'a-b', b: 'p:ab', why: 'same name' }]);
});

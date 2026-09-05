import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as agents from '../src/agents.mjs';
import * as memory from '../src/memory.mjs';
import * as doctor from '../src/doctor.mjs';
import * as inbox from '../src/inbox.mjs';
import * as cfgmod from '../src/config.mjs';

function root() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ag-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: { user: 'the human', session: 'a session' }, language: 'en' }));
  return r;
}
const rm = (r) => fs.rmSync(r, { recursive: true, force: true });

test('an agent name is as strict as a project name', () => {
  for (const good of ['librarian', 'vm-admin', 'a', 'agent.2', 'x_y-1']) {
    assert.equal(agents.checkAgentName(good), good);
  }
  for (const bad of ['../out', 'Upper', 'with space', '', 'a'.repeat(65), '/absolute', '-start']) {
    assert.throws(() => agents.checkAgentName(bad), /Invalid agent name/, `let through: ${bad}`);
  }
});

test('creating twice is not an error and overwrites nothing', () => {
  const r = root();
  try {
    assert.equal(agents.createAgent(r, 'checker', { role: 'first role' }).isNew, true);
    fs.writeFileSync(path.join(r, 'agents/checker/PROMPT.md'), 'edited by hand\n');
    assert.equal(agents.createAgent(r, 'checker', { role: 'second role' }).isNew, false);
    assert.match(fs.readFileSync(path.join(r, 'agents/checker/PROMPT.md'), 'utf8'), /by hand/);
    assert.equal(agents.readAgent(r, 'checker').role, 'first role', 'AGENT.yaml was overwritten');
  } finally { rm(r); }
});

test('path: enrols an agent that grew elsewhere, without moving it', () => {
  const r = root();
  try {
    fs.mkdirSync(path.join(r, '.old/knowledge'), { recursive: true });
    fs.writeFileSync(path.join(r, '.old/PROMPT.md'), '# old\n');
    fs.writeFileSync(path.join(r, '.old/knowledge/one.md'), 'x\n');
    agents.createAgent(r, 'old', { role: 'grown', path: '.old' });
    const a = agents.readAgent(r, 'old');
    assert.equal(a.content, '.old');
    assert.equal(a.home, 'agents/old');
    assert.equal(a.prompt, '.old/PROMPT.md');
    assert.deepEqual(a.knowledge, ['one.md']);
  } finally { rm(r); }
});

test('a path: pointing out of the memory is not followed', () => {
  // Otherwise an AGENT.yaml would be a read key for the whole disk.
  const r = root();
  try {
    agents.createAgent(r, 'evil', {});
    fs.writeFileSync(path.join(r, 'agents/evil/AGENT.yaml'), '---\nname: evil\npath: "../../../etc"\n');
    assert.equal(agents.readAgent(r, 'evil').content, 'agents/evil', 'the escape was followed');
  } finally { rm(r); }
});

test('agent is a second axis beside project, not a substitute', () => {
  const r = root();
  try {
    memory.logEntry(r, 'event', { title: 'a', agent: 'vm-admin' }, { project: 'payments' });
    memory.logEntry(r, 'event', { title: 'b', agent: 'vm-admin' });
    memory.logEntry(r, 'event', { title: 'c', agent: 'librarian' }, { project: 'payments' });
    const st = memory.agentState(r, 'vm-admin');
    assert.equal(st.count, 2);
    assert.deepEqual(st.projects, { payments: 1, '(global)': 1 });
    assert.deepEqual(memory.agentsInLog(r).map((a) => a.agent), ['vm-admin', 'librarian']);
  } finally { rm(r); }
});

test('the agent is also read from the origin stamp', () => {
  const r = root();
  try {
    memory.logEntry(r, 'event', { title: 'x', origin: { agent: 'digest', session_id: 'q' } });
    memory.logEntry(r, 'event', { title: 'y', origin: { surface: 'vm' } });
    memory.logEntry(r, 'event', { title: 'z', origin: { surface: 'cloud' } });
    const names = memory.agentsInLog(r).map((a) => a.agent).sort();
    assert.deepEqual(names, ['digest', 'session', 'vm-admin']);
  } finally { rm(r); }
});

test('a registered agent becomes addressable immediately', () => {
  // Without this, creating an agent would not make it reachable — the
  // inbox could not actually route to it, no matter how many existed.
  const r = root();
  try {
    assert.equal(Object.hasOwn(cfgmod.readConfig(r).participants, 'vm-admin'), false);
    agents.createAgent(r, 'vm-admin', { role: 'runs the machine' });
    const cfg = cfgmod.readConfig(r);
    assert.equal(cfg.participants['vm-admin'], 'runs the machine');
    // The configured list stays the floor: roles that are not agents.
    for (const builtin of ['user', 'session']) assert.ok(Object.hasOwn(cfg.participants, builtin));
    const g = inbox.write(r, cfg.participants, { from: 'session', to: 'vm-admin', subject: 'now', text: 'works' });
    assert.match(g.path ?? g.name ?? '', /session-to-vm-admin|vm-admin/);
  } finally { rm(r); }
});

test('the doctor reports mail nobody collects any more', () => {
  const r = root();
  try {
    agents.createAgent(r, 'old-agent', {});
    const cfg = cfgmod.readConfig(r);
    inbox.write(r, cfg.participants, { from: 'session', to: 'old-agent', subject: 'sits', text: 'x' });
    assert.equal(doctor.checkDelivery(r).level, doctor.LEVEL.GOOD);
    fs.rmSync(path.join(r, 'agents/old-agent'), { recursive: true, force: true });
    const f = doctor.checkDelivery(r);
    assert.equal(f.level, doctor.LEVEL.WARN);
    assert.match(f.text, /old-agent/);
  } finally { rm(r); }
});

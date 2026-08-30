import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as memory from '../src/memory.mjs';

function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-duty-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  return root;
}

test('closing a duty appends and never touches the original', () => {
  const root = fresh();
  try {
    const a = memory.logEntry(root, 'duty', { title: 'review the PR' });
    const b = memory.logEntry(root, 'duty', { title: 'write the docs' });
    assert.equal(memory.openDuties(root).open.length, 2);

    memory.closeDuty(root, a.entry.id, { why: 'merged' });
    const view = memory.openDuties(root);
    assert.deepEqual(view.open.map((d) => d.title), ['write the docs']);
    assert.deepEqual(view.done.map((d) => d.title), ['review the PR']);
    assert.equal(view.done[0]._closed.why, 'merged');

    const file = path.join(root, 'global', 'duties.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3, 'closing must add a line, not replace one');
    assert.ok(lines[0].includes(a.entry.id), 'the original line changed');
    assert.ok(lines[1].includes(b.entry.id));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('closing an unknown duty is refused', () => {
  // A memory that accepts a close for something never opened is
  // quietly wrong: someone mistyped and nobody finds out.
  const root = fresh();
  try {
    assert.throws(() => memory.closeDuty(root, 'nosuchid'), /No open duty/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a duty cannot be closed twice', () => {
  const root = fresh();
  try {
    const a = memory.logEntry(root, 'duty', { title: 'once' });
    memory.closeDuty(root, a.entry.id);
    assert.throws(() => memory.closeDuty(root, a.entry.id), /No open duty/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unknown state is refused', () => {
  const root = fresh();
  try {
    const a = memory.logEntry(root, 'duty', { title: 'x' });
    assert.throws(() => memory.closeDuty(root, a.entry.id, { state: 'maybe' }),
      /Unknown duty state/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('all nine types are writable and land in their own file', () => {
  const root = fresh();
  try {
    for (const type of Object.keys(memory.TYPES)) {
      const { path: p } = memory.logEntry(root, type, { title: `a ${type}` });
      assert.ok(p.endsWith(memory.TYPES[type]), `${type} landed in ${p}`);
    }
    assert.equal(Object.keys(memory.TYPES).length, 9);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

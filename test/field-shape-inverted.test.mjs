// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Review round 2026-10-12, coordinator addendum: the rule is INVERTED (the same in lucky-mem). A field the readers touch that
// the shape list did not name still crashed them (the search field weights, the subject field per type). Now EVERY top-level
// field is judged: a string, a number, a boolean, null, or a list of those. An object is wrong, except in a named allowlist of
// structured fields (origin, provenance, guard, chain_seal, ...), which comes from real data. Nothing nests deeper than 32
// levels, and no object carries a key that would make it convert itself (toString, valueOf, ...).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as integrity from '../src/integrity.mjs';
import * as search from '../src/search.mjs';
import * as neighbours from '../src/neighbours.mjs';
import { BODY_FIELDS } from '../src/bodyfields.mjs';
import { shapeProblem } from '../src/fieldshape.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(ROOT, 'bin', 'mem');
const deep = (n) => { let o = 'x'; for (let i = 0; i < n; i += 1) o = { o }; return o; };

test('an unlisted field: a scalar or a list of scalars is healthy, an object (or a list holding objects) is broken', () => {
  for (const ok of [{ zz_unknown: 'x' }, { zz_unknown: 5 }, { zz_unknown: true }, { zz_unknown: [1, 'a', false] }, { zz_unknown: [] }, { zz_unknown: null }]) {
    assert.equal(shapeProblem(ok), null, JSON.stringify(ok));
  }
  for (const bad of [{ zz_unknown: { a: 1 } }, { zz_unknown: [{ a: 1 }] }, { zz_unknown: [[1]] }, { zz_unknown: { toString: 'x' } }]) {
    assert.ok(shapeProblem(bad), JSON.stringify(bad));
  }
});

test('the structured fields may hold objects; a key that converts the object, or too deep a nesting, is wrong anywhere', () => {
  for (const ok of [
    { origin: { derived_from: ['abc'], note: { deeper: 'fine' } } }, { provenance: { inferred_from: ['x'] } },
    { guard: { kind: 'test', path: 'test/a.test.mjs' } }, { chain_seal: { writer: 'w', hash: 'h', through_id: 'i' } },
    { body_enc: { v: 1, alg: 'aes-256-gcm', iv: 'a', tag: 'b', ct: 'c' } }, { references: { procedure: ['p1'] } }, { asked_evidence: [{ journal: 'j', ts: 't' }] },
  ]) assert.equal(shapeProblem(ok), null, JSON.stringify(ok));
  for (const name of ['toString', 'valueOf', 'constructor', 'toJSON', 'hasOwnProperty']) {
    assert.ok(shapeProblem({ origin: { [name]: 'x' } }), `origin.${name}`);
    assert.ok(shapeProblem({ origin: { a: { b: { [name]: 1 } } } }), `origin.a.b.${name}`);
    assert.ok(shapeProblem(JSON.parse(`{"${name}":"x"}`)), `top-level ${name}`);
  }
  assert.equal(shapeProblem({ origin: deep(31) }), null, '31 levels are fine');
  assert.ok(shapeProblem({ origin: deep(33) }), '33 levels are one too many');
  assert.ok(shapeProblem({ origin: deep(40000) }), 'a nesting bomb');
  assert.ok(shapeProblem({ asked_evidence: [{ a: deep(40) }] }));
});

test('every field the search weights, the bodies and the subject per type name is judged: an object there is broken, a number too unless it is a list', () => {
  const names = new Set([...Object.keys(search.FIELD_WEIGHTS), ...BODY_FIELDS, ...Object.values(neighbours.SUBJECT_FIELD)]);
  assert.ok(names.size >= 20, 'the probe reads the real lists');
  for (const f of names) {
    assert.ok(shapeProblem({ [f]: { a: 1 } }), `${f}: an object must be broken`);
    assert.ok(shapeProblem({ [f]: [{ a: 1 }] }), `${f}: a list of objects must be broken`);
  }
  // the prose among them is text: a number or a boolean there crashes slice / localeCompare
  for (const f of ['title', 'topic', 'class', 'choice', 'why', 'text', 'fact', 'learning', 'duty', 'rule', 'question', 'skill', 'excerpt', 'description', 'body', 'scope', 'key']) {
    assert.ok(shapeProblem({ [f]: 5 }) && shapeProblem({ [f]: true }), `${f}: number / boolean`);
  }
});

test('writing every kind of entry through the real CLI leaves no broken line (the allowlist is honest)', (t) => {
  const root = tempDir('cm-allow-', t);
  const run = (...args) => {
    const r = spawnSync(process.execPath, [MEM, '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, MEM_HEADLESS: '', CHEAP_MEM_ROOT: root } });
    assert.equal(r.status, 0, `mem ${args.join(' ')}: ${r.stderr}`);
    return r;
  };
  run('init', '--participants', 'lucky,session', '--human', 'lucky');
  fs.writeFileSync(path.join(root, 'note.txt'), 'a note\n');
  run('log', 'decision', '--topic', 'db', '--choice', 'pg', '--why', 'speed', '--tags', 'a,b', '--asked', 'which db', '--rejected', 'mysql;sqlite', '--origin', '{"derived_from":["abc12345"],"raw":"r"}');
  run('log', 'error', '--title', 'boom', '--text', 't', '--class', 'looks-right-does-nothing', '--file', 'src/a.mjs', '--files', 'src/a.mjs,src/b.mjs', '--without-scaffold');
  run('log', 'event', '--title', 'released', '--text', 'v1', '--tags', 'rel');
  run('log', 'timeline', '--key', 'db.engine', '--value', 'postgres', '--text', 'x', '--valid-from', '2026-01-01');
  run('log', 'thought', '--title', 't', '--text', 't', '--symbols', 'foo,bar', '--tags', 'x');
  run('log', 'thought', '--title', 'shredded', '--text', 'body', '--shred');
  run('log', 'learning', '--title', 'l', '--learning', 'do x', '--text', 'y');
  run('log', 'duty', '--title', 'd', '--text', 't', '--owner', 'lucky');
  run('log', 'question', '--question', 'why?');
  run('log', 'skill', '--title', 's', '--skill', 'can do', '--scope', 'src');
  run('log', 'update', '--title', 'u', '--text', 'bumped');
  run('log', 'procedure', '--title', 'p', '--rule', 'always', '--on-class', 'looks-right-does-nothing,assumed-not-measured', '--issued-by', 'owner', '--triggers', 'deploy,publish');
  run('workflow', 'new', '--title', 'wf', '--steps', 'a;b', '--issued-by', 'owner', '--triggers', 'x,y', '--path-patterns', 'a,b', '--tool-patterns', 'npm publish', '--tools', 'git', '--references-procedure', 'p1,p2');
  run('snippet', 'new', '--title', 'sn', '--body', 'hello {{NAME}}', '--placeholders', 'NAME,AGE', '--kind', 'text', '--language', 'en');
  run('sources', 'add', path.join(root, 'note.txt'), '--title', 'n', '--tags', 'a,b', '--note', 'hi');
  run('sources', 'add', 'https://example.test/x', '--title', 'web');
  run('sources', 'bridge', 'mcp://x/y', '--tool', 'fetch', '--title', 'br');
  run('log', 'link', '--from', 'aaaa', '--to', 'bbbb', '--kind', 'causes', '--why', 'w');
  run('log', 'decision', '--topic', 't2', '--choice', 'c', '--why', 'w', '--authority', 'user');
  run('project', 'new', 'demo', '--title', 'Demo', '--reason', 'test');
  run('log', 'decision', '--project', 'demo', '--topic', 'p', '--choice', 'c', '--why', 'w');
  const id = memory.readLog(root, 'thought').entries[0].id;
  run('done', id, '--why', 'finished');
  run('correction', 'thought', id, '--title', 't fixed');
  run('heartbeat', '--what', 'testing');
  run('chain', '--json');
  const scan = integrity.scanIntegrity(root);
  assert.deepEqual(scan.broken, [], 'a form the CLI itself writes was reported as broken');
  assert.deepEqual(scan.listWithoutValue, [], 'the CLI wrote a list flag without a value');
  assert.ok(scan.entries >= 20);
});

test('mem doctor survives a line for every field name with an object (or a list of objects) in it - no check aborts', (t) => {
  const root = tempDir('cm-doctor-obj-', t);
  const r0 = spawnSync(process.execPath, [MEM, '--root', root, 'init', '--participants', 'lucky,session', '--human', 'lucky'], { encoding: 'utf8' });
  assert.equal(r0.status, 0, r0.stderr);
  memory.logEntry(root, 'thought', { title: 'Normal alpha', text: 'findable alpha content', agent: 'lucky' });
  const FIELDS = ['title', 'text', 'why', 'topic', 'class', 'choice', 'learning', 'duty', 'question', 'skill', 'rule', 'fact', 'description', 'excerpt', 'body',
    'key', 'value', 'file', 'owner', 'who', 'kind', 'from', 'to', 'by', 'by_id', 'replaces_id', 'retires_id', 'closes_id', 'state', 'status', 'authority', 'agent',
    'valid_from', 'valid_until', 'subject', 'project', 'type', 'source', 'target', 'hash', 'author', 'id', 'ts', 'tags', 'symbols', 'asked', 'files', 'steps',
    'triggers', 'on_class', 'rejected', 'origin', 'guard', 'zz_unknown', '_type', 'closed', 'sensitivity'];
  const lines = [];
  FIELDS.forEach((f, i) => {
    for (const v of [{ a: 1 }, [{ toString: 'x' }]]) {
      lines.push(JSON.stringify({ id: `9obj${String(lines.length).padStart(5, '0')}`, ts: '2026-10-11T22:30:00Z', title: `alpha ${f}`, text: 'alpha', class: 'entry-form', [f]: v, [`field ${i}`]: true }));
    }
  });
  for (const type of ['thoughts', 'errors', 'decisions', 'timeline', 'learnings', 'duties']) fs.appendFileSync(path.join(root, 'global', `${type}.jsonl`), `${lines.join('\n')}\n`);
  const doc = spawnSync(process.execPath, [MEM, '--root', root, 'doctor'], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ROOT: root }, timeout: 120000 });
  assert.doesNotMatch(`${doc.stdout}\n${doc.stderr}`, /check aborted|TypeError|Cannot convert|is not a function|unreadable: .*(function|convert)/, doc.stdout.slice(0, 600));
  assert.match(doc.stdout, /FAIL\s+drawers\s+\d+ unparsable lines/);
});

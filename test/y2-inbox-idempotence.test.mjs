import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as inbox from '../src/inbox.mjs';
import { tempDir } from './temp-dir.mjs';

const PARTS = { alice: 'a', bob: 'b' };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// Fixed start commit (never merge-base: it moves after the merge).
const START = 'e50c6b7';
const t0 = new Date('2026-01-01T00:00:00Z');
const send = (root, n, extra = {}) => inbox.write(root, PARTS, {
  from: 'alice', to: 'bob', subject: 's', text: 'x', requestId: 'req-1',
  now: new Date(t0.getTime() + n * 5000), ...extra,
});
const tmp = (t) => tempDir('cheap-mem-y2-', t);

test('red proof: the START commit writes two messages for one request id', (t) => {
  const old = tmp(t);
  execFileSync('sh', ['-c', `git -C ${REPO} archive ${START} src | tar -x -C ${old}`]);
  return import(pathToFileURL(path.join(old, 'src', 'inbox.mjs')).href).then((o) => {
    const root = tmp(t);
    const w = (n) => o.write(root, PARTS, {
      from: 'alice', to: 'bob', subject: 's', text: 'x', requestId: 'req-1',
      now: new Date(t0.getTime() + n * 5000),
    });
    w(0); w(1);
    assert.equal(o.read(root, PARTS, { to: 'bob' }).messages.length, 2, 'old state: two');
  });
});

test('same id twice: one logical message, second is a replay', (t) => {
  const root = tmp(t);
  const a = send(root, 0);
  const b = send(root, 1);
  assert.equal(b.replay, true);
  assert.equal(b.name, a.name);
  assert.equal(inbox.read(root, PARTS, { to: 'bob' }).messages.length, 1);
  assert.equal(fs.readdirSync(path.join(root, 'inbox')).filter((n) => n.endsWith('.md')).length, 1);
});

test('same id, different text: conflict, nothing written', (t) => {
  const root = tmp(t);
  send(root, 0);
  assert.throws(() => send(root, 1, { text: 'other' }), (e) => e.code === 'REQUEST_CONFLICT');
  assert.equal(inbox.read(root, PARTS, { to: 'bob' }).messages.length, 1);
});

test('positive control: without an id every call writes, as before', (t) => {
  const root = tmp(t);
  send(root, 0, { requestId: null }); send(root, 1, { requestId: null });
  assert.equal(inbox.read(root, PARTS, { to: 'bob' }).messages.length, 2);
  // and two different ids are two messages
  send(root, 2, { requestId: 'a' }); send(root, 3, { requestId: 'b' });
  assert.equal(inbox.read(root, PARTS, { to: 'bob' }).messages.length, 4);
});

test('parallel repeat from two processes: one logical message', async (t) => {
  const root = tmp(t);
  const code = `import('${pathToFileURL(path.join(REPO, 'src/inbox.mjs')).href}').then((i)=>{`
    + `const r=i.write(${JSON.stringify(root)},${JSON.stringify(PARTS)},{from:'alice',to:'bob',subject:'s',text:'x',requestId:'par'});`
    + 'console.log(r.replay?"replay":"written")})';
  const run = () => new Promise((res, rej) => {
    const c = spawn(process.execPath, ['-e', code]);
    let o = ''; c.stdout.on('data', (d) => { o += d; });
    c.on('exit', (k) => (k === 0 ? res(o.trim()) : rej(new Error(`exit ${k}`))));
  });
  const got = await Promise.all([run(), run()]);
  assert.equal(inbox.read(root, PARTS, { to: 'bob' }).messages.length, 1, `got ${got}`);
});

test('two clones write the same id, merge: no git conflict, one logical message', (t) => {
  const base = tmp(t);
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t',
    '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(base, 'seed');
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' });
  fs.writeFileSync(path.join(seed, 'README'), 'x');
  g(seed, 'add', '.'); g(seed, 'commit', '-qm', 'init'); g(seed, 'push', '-q', 'origin', 'HEAD:main');
  const c1 = path.join(base, 'c1'); const c2 = path.join(base, 'c2');
  for (const c of [c1, c2]) execFileSync('git', ['clone', '-q', origin, c], { stdio: 'ignore' });
  // each clone gets its own mark (as real clones do) and its own time head
  fs.mkdirSync(path.join(c1, '.pipeline'), { recursive: true });
  fs.mkdirSync(path.join(c2, '.pipeline'), { recursive: true });
  fs.writeFileSync(path.join(c1, '.pipeline', 'clone-mark'), 'aaaa\n');
  fs.writeFileSync(path.join(c2, '.pipeline', 'clone-mark'), 'bbbb\n');
  const r1 = send(c1, 0); const r2 = send(c2, 3);
  assert.notEqual(r1.name, r2.name);
  g(c1, 'add', 'inbox'); g(c1, 'commit', '-qm', 'c1'); g(c1, 'push', '-q', 'origin', 'HEAD:main');
  g(c2, 'add', 'inbox'); g(c2, 'commit', '-qm', 'c2');
  g(c2, 'pull', '-q', '--no-rebase', 'origin', 'main'); // must not throw: no add/add conflict
  const got = inbox.read(c2, PARTS, { to: 'bob' });
  assert.equal(got.messages.length, 1);
  assert.equal(got.messages[0].name, r1.name, 'the older one wins');
  assert.equal(got.duplicates.length, 1, 'the other stays visible');
  assert.equal(got.duplicates[0].duplicateOf, r1.name);
  assert.equal(inbox.newFor(c2, PARTS, { to: 'bob' }).new.length, 1);
  assert.equal(got.broken.length, 0);
  // and a third send in the merged clone is a replay
  assert.equal(send(c2, 9).replay, true);
});

test('CLI: --request-id twice is one message, other text exits non-zero', (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ participants: PARTS }));
  const run = (...a) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(REPO, 'bin/mem'), 'inbox', 'write',
        '--as', 'alice', '--to', 'bob', '--subject', 's', '--request-id', 'cli-1', ...a],
      { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }) };
    } catch (e) { return { code: e.status, out: `${e.stdout}${e.stderr}` }; }
  };
  assert.equal(run('--text', 'hi').code, 0);
  const again = run('--text', 'hi');
  assert.equal(again.code, 0); assert.match(again.out, /replay/);
  const bad = run('--text', 'different');
  assert.notEqual(bad.code, 0); assert.match(bad.out, /different message/);
  assert.equal(inbox.read(root, PARTS, { to: 'bob' }).messages.length, 1);
  void os;
});

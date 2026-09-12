import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VERDICT, PATH_PATTERN, TREES_FILE, trees, mentions, judge, check, asText } from '../src/pathcheck.mjs';

function tree(files = []) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-'));
  for (const f of files) {
    const t = path.join(d, f);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, '');
  }
  return d;
}

test('without a known tree the verdict is UNKNOWN, never intact', () => {
  assert.equal(judge('src/there.mjs', null), VERDICT.UNKNOWN);
  assert.equal(judge('src/there.mjs', undefined), VERDICT.UNKNOWN);
  assert.equal(judge('src/there.mjs', ''), VERDICT.UNKNOWN);
});

test('an existing file is intact, a missing one dangles', () => {
  const d = tree(['src/there.mjs']);
  try {
    assert.equal(judge('src/there.mjs', d), VERDICT.INTACT);
    assert.equal(judge('src/gone.mjs', d), VERDICT.DANGLING);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the pattern catches source paths but not memory locations', () => {
  const m = mentions({ text: 'src/search.mjs and bin/mem-retrieve, see global/errors.jsonl:82' });
  assert.ok(m.includes('src/search.mjs'));
  assert.ok(m.includes('bin/mem-retrieve') === false, 'an extensionless bin path slipped in');
  assert.ok(!m.some((x) => x.startsWith('global/')), 'a memory location read as a source path');
});

test('the pattern catches no URLs', () => {
  const m = mentions({ text: 'see https://example.org/src/foreign.mjs on the web' });
  assert.deepEqual(m.filter((x) => x.includes('foreign')), [], 'a URL read as a source path');
});

test('a repeated mention in one entry counts once', () => {
  assert.deepEqual(mentions({ a: 'src/x.mjs', b: 'src/x.mjs' }), ['src/x.mjs']);
});

test('per project against ITS tree — that is the whole point', () => {
  const a = tree(['src/only-in-a.mjs']);
  const b = tree(['src/only-in-b.mjs']);
  try {
    const r = check('/whatever', {
      map: { 'project-a': a, 'project-b': b },
      readAll: () => [
        { project: 'project-a', entry: { text: 'src/only-in-a.mjs falls over' }, source: 'a/err', line: 1 },
        { project: 'project-b', entry: { text: 'src/only-in-b.mjs falls over' }, source: 'b/err', line: 1 },
      ],
    });
    assert.equal(r.total.intact, 2, 'a correct path was reported as drift');
    assert.equal(r.total.dangling, 0);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('a project without a tree lands in unchecked, not in intact', () => {
  const r = check('/whatever', {
    map: {},
    readAll: () => [{ project: 'other', entry: { text: 'src/whatever.mjs' }, source: 'o/err', line: 1 }],
  });
  assert.equal(r.total.unknown, 1);
  assert.equal(r.total.intact, 0);
  assert.match(asText(r), /no tree known/);
  assert.match(asText(r), /unchecked does NOT mean intact/);
});

test('the text names the location and the path so you can go there', () => {
  const d = tree([]);
  try {
    const r = check('/whatever', {
      map: { p: d },
      readAll: () => [{ project: 'p', entry: { text: 'src/gone.mjs' }, source: 'p/err', line: 42 }],
    });
    assert.match(asText(r), /src\/gone\.mjs/);
    assert.match(asText(r), /p\/err:42/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the tree map has a default for the own project', () => {
  const t = trees('/path/to/mem');
  assert.equal(t.global, '/path/to/mem');
  assert.equal(typeof TREES_FILE, 'string');
});

test('PATH_PATTERN is global and is not consumed between calls', () => {
  const e = { text: 'src/a.mjs src/b.mjs' };
  assert.deepEqual(mentions(e), mentions(e));
  assert.equal(PATH_PATTERN.global, true);
});

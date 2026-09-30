// F4 (2026-09-30): the counts the audit found stale in a dozen places.
//
// Every number below used to be typed by hand into prose ("ten types",
// "five hooks", "seven phases", "sixty handlers", 122 modules) and went
// stale on its own. They now live in `bench/readme-numbers.mjs` as
// counters plus CLAIMS places; this probe makes the places part of the
// bolt: each claim pattern must still FIND its sentence (a reworded
// sentence otherwise drops out of the net unnoticed) and must state the
// counted value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as numbers from '../bench/readme-numbers.mjs';
import { tempDir } from './temp-dir.mjs';

const F4 = ['types', 'hooks', 'atlasPhases', 'modules', 'cli'];

test('every F4 place still exists and states the counted value', async () => {
  const claims = numbers.CLAIMS.filter((c) => c.fields.some((f) => F4.includes(f)));
  const report = await numbers.checkNumbers({ claims, only: F4 });
  assert.deepEqual(report.missing, [], 'a claim sentence was reworded away — the place is no longer guarded');
  assert.deepEqual(report.mismatches, [], 'a count drifted: run `node bench/readme-numbers.mjs --write`');
});

test('POSITIVE: the counters see the real thing, recursively', async () => {
  const c = numbers.buildCounters();
  assert.ok(await c.types() >= 15, 'memory.TYPES not seen');
  assert.ok(c.hooks() >= 7, 'install/hooks not seen');
  assert.ok(c.atlasPhases() >= 8, 'atlas PHASES rows not seen');
  const flat = fs.readdirSync(path.join(numbers.DEFAULT_ROOT, 'src')).filter((n) => n.endsWith('.mjs')).length;
  assert.ok(c.modules() > flat, 'the module count is flat again — the command modules in a subdirectory would be missed');
});

test('RED on the old number: a stale "10 types" is reported and pulled forward', async (t) => {
  const root = tempDir('cm-f4-', t);
  {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    // A stub with a known number of types: the counter reads the module it finds under root.
    fs.writeFileSync(path.join(root, 'src', 'memory.mjs'), "export const TYPES = { a: 'a.jsonl', b: 'b.jsonl', c: 'c.jsonl' };\n");
    fs.writeFileSync(path.join(root, 'README.md'), 'mem log <type> --<field> ...   append an entry (10 types)\n');
    const claims = numbers.CLAIMS.filter((c) => (c.file ?? 'README.md') === 'README.md' && c.fields[0] === 'types');
    assert.equal(claims.length, 1);
    const before = await numbers.checkNumbers({ root, claims, only: ['types'] });
    assert.equal(before.mismatches.length, 1);
    assert.equal(before.mismatches[0].claimed, 10);
    assert.equal(before.mismatches[0].real, 3);
    const r = await numbers.updateNumbers({ root, claims, only: ['types'], write: true });
    assert.equal(r.changes.length, 1);
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /[(]3 types[)]/);
  }
});

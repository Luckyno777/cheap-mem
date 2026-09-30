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
  assert.ok(c.modules() > flat, 'the module count is flat again — src/cli/commands/* would be missed');
});

test('RED on the old number: a stale "ten types" is reported and pulled forward', async () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'f4-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    for (const d of ['src', 'install/hooks', 'bench', 'bin']) fs.mkdirSync(path.join(root, d), { recursive: true });
    for (const f of ['src/memory.mjs', 'bench/atlas.mjs', 'bin/mem-mcp']) {
      fs.copyFileSync(path.join(numbers.DEFAULT_ROOT, f), path.join(root, f));
    }
    fs.writeFileSync(path.join(root, 'README.md'), 'mem log <type> --<field> ...   append an entry (10 types)\n');
    const claims = numbers.CLAIMS.filter((c) => (c.file ?? 'README.md') === 'README.md' && c.fields[0] === 'types');
    const before = await numbers.checkNumbers({ root, claims, only: ['types'] });
    assert.equal(before.mismatches.length, 1);
    assert.equal(before.mismatches[0].claimed, 10);
    const r = await numbers.updateNumbers({ root, claims, only: ['types'], write: true });
    assert.equal(r.changes.length, 1);
    assert.match(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), /\(15 types\)/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// F5 / suggestion list item 6: no `Number(args.x)` in command handlers.
//
// `Number('abc')` is NaN; NaN does not break a comparison, it only makes it
// false, so `mem search --top abc` used to mean "nothing" with exit 0. The
// one way from a switch to a number is `numberFlag()` in src/cli/shell.mjs
// (loud, names the switch and the value). This guard reads the CODE
// (comments excluded), not a copy of the rule.
//
// Exceptions are NAMED and capped. A new one needs a reason here, not a
// quietly higher cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, files, hits, read } from './f5-source.mjs';

const PATTERN = /\b(Number|parseInt|parseFloat)\(\s*(args|argv)\b/;

// bin/mem-mcp reads the JSON arguments of a tool call (`args.top` is a JSON
// value, not a command line) and falls back to a default on junk -- there is
// no CLI switch to refuse. Four sites today.
const EXCEPTIONS = { 'bin/mem-mcp': 4 };

const CANDIDATES = () => [
  ...files('bin', (n) => n === 'mem' || n === 'mem-mcp' || n.endsWith('.mjs')),
  ...files('src', (n) => n.endsWith('.mjs')),
];

test('positive control: the pattern sees Number(args...) and skips comments', () => {
  assert.equal(hits('const t = Number(args.top) || 5;', PATTERN).length, 1);
  assert.equal(hits('x = Number(argv[++i]);', PATTERN).length, 1);
  assert.equal(hits('// Number(args.top)\n/* Number(args.x) */', PATTERN).length, 0);
  assert.equal(hits("numberFlag('top', args.top, {})", PATTERN).length, 0);
});

test('bin/ and src/ hold no Number(args...) except the named exceptions', () => {
  const foreign = [];
  const seen = {};
  for (const rel of CANDIDATES()) {
    const h = hits(read(rel), PATTERN);
    if (!h.length) continue;
    seen[rel] = h.length;
    if ((EXCEPTIONS[rel] ?? 0) < h.length) foreign.push(...h.map((x) => `${rel}:${x.line}: ${x.text}`));
  }
  assert.deepEqual(foreign, [], `Number(args...) instead of numberFlag():\n${foreign.join('\n')}`);
  for (const [rel, n] of Object.entries(EXCEPTIONS)) {
    assert.equal(seen[rel] ?? 0, n, `exception ${rel} no longer has exactly ${n} hits -- adjust the cap or drop it`);
  }
});

test('behaviour: --stale-days abc is a loud error, never NaN or silently empty', () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'f5-num-'));
  try {
    const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'mem'), '--root', w, ...a],
      { encoding: 'utf8', env: { ...process.env } });
    const init = run('init');
    assert.equal(init.status, 0, `init failed: ${init.stderr}`);
    const bad = run('facts', '--stale-days', 'abc');
    assert.notEqual(bad.status, 0, `--stale-days abc went through: ${bad.stdout}`);
    assert.match(bad.stderr, /--stale-days needs a number/);
    const ok = run('facts', '--stale-days', '30');
    assert.equal(ok.status, 0, `--stale-days 30 refused: ${ok.stderr}`);
  } finally { fs.rmSync(w, { recursive: true, force: true }); }
});

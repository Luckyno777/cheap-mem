// Hand-counted numbers drift.
//
// On 2026-09-07 `docs/mcp-setup.md` said the server exposes "eight
// tools", in two places. It serves eleven. Nobody could have noticed:
// the number was written once, by someone who counted correctly at the
// time, and nothing has counted since.
//
// Same class as a stale benchmark figure or a test count in a setup
// guide — a claim with an expiry date and no owner. The fix is not to
// correct the number; it is to make the number checkable.
//
// If this test fails, the docs are not necessarily wrong: more likely a
// tool was added and every place that counts them needs updating.
//
// **Counted from the source, not from a running server.** Spawning
// bin/mem-mcp needs @modelcontextprotocol/sdk, and CI installs no
// dependencies (`npm ci --omit=optional` on a package with none). A
// test that only passes on a developer machine is worse than no test:
// it looks like cover and is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only as far as the docs actually count. More words would be an
// invitation to route around this later.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
  'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen'];

function toolNames() {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'mem-mcp'), 'utf8');
  const from = src.indexOf('const TOOLS = [');
  assert.ok(from >= 0, 'TOOLS array not found in bin/mem-mcp');
  // Up to the closing bracket of the array at column 0.
  const rest = src.slice(from);
  const to = rest.indexOf('\n];');
  assert.ok(to > 0, 'end of TOOLS array not found');
  return [...rest.slice(0, to).matchAll(/^\s+name: '(mem_[a-z_]+)'/gm)].map((m) => m[1]);
}

function docFiles() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(ROOT);
  return out;
}

// Every way the docs say "<n> tools": a numeral or a number word.
const CLAIM = new RegExp(`\\b(\\d{1,2}|${WORDS.join('|')})\\s+tools\\b`, 'gi');

test('POSITIV: the probe can see a wrong number', () => {
  // Without this control the search below could silently match nothing
  // and the test would pass forever.
  const treffer = [...'the server exposes eight tools today'.matchAll(CLAIM)];
  assert.equal(treffer.length, 1);
  assert.equal(treffer[0][1].toLowerCase(), 'eight');
});

test('every documented tool count matches the server', () => {
  const n = toolNames().length;
  assert.ok(n > 0, 'no tools found — the parser broke, not the docs');
  const wrong = [];
  for (const f of docFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [, claim] of text.matchAll(CLAIM)) {
      const said = /^\d+$/.test(claim) ? Number(claim) : WORDS.indexOf(claim.toLowerCase());
      if (said !== n) wrong.push(`${path.relative(ROOT, f)}: says "${claim} tools", server serves ${n}`);
    }
  }
  assert.deepEqual(wrong, [], `\n${wrong.join('\n')}`);
});

test('the tool names in the docs all exist', () => {
  // A count can be right while a name is stale — the harder half to
  // notice, because a wrong name reads perfectly well.
  const names = new Set(toolNames());
  const wrong = [];
  for (const f of docFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    for (const [, name] of text.matchAll(/`(mem_[a-z_]+)`/g)) {
      if (!names.has(name)) wrong.push(`${path.relative(ROOT, f)}: ${name}`);
    }
  }
  assert.deepEqual(wrong, [], `\ntools named in docs that do not exist:\n${wrong.join('\n')}`);
});

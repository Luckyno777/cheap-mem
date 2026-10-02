// Variant fusion (ported from the sibling house, 2026-10-02): `mem find
// --variants "a|b|c"` and the MCP field `variants` take rewordings the
// CALLER writes, search each on its own and merge the lists by Reciprocal
// Rank Fusion (src/variants.mjs). No model in the recall path.
//
// Red proof (rule 3): on the base commit 1d8f6c5 `mem find --variants`
// was refused as an unknown flag and src/variants.mjs did not exist; the
// positive controls below show the question ALONE finds nothing, so the
// probe sees a real difference.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as search from '../src/search.mjs';
import * as variants from '../src/variants.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const MCP = path.join(REPO, 'bin', 'mem-mcp');
const QUESTION = 'why did the nightly widget export break';
const VARIANTS = ['zorblat flux overflow', 'flux capacitor zorblat'];

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-variants-'));
  spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8' });
  for (let i = 0; i < 25; i += 1) {
    memory.logEntry(root, 'decision', {
      topic: `filler ${i}`, choice: `keep option ${i}`, why: `unrelated reason number ${i}`,
    }, { project: null });
  }
  const target = memory.logEntry(root, 'learning', {
    title: 'zorblat flux overflow', learning: 'the flux capacitor zorblat overflows at midnight',
  }, { project: null }).entry;
  return { root, target };
}
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

test('variants: clean (max 4, duplicates, the question itself, non-text)', () => {
  const v = variants.cleanVariants(['  A  b ', 'a b', 'Question x', 'c', 'd', 'e', 'f', 3, null, ''], 'question X');
  assert.deepEqual(v, ['A b', 'c', 'd', 'e']);
  assert.equal(variants.VARIANTS_MAX, 4);
  assert.deepEqual(variants.variantsFromText('a | b||c'), ['a', 'b', 'c']);
  assert.deepEqual(variants.cleanVariants('not an array', 'x'), []);
});

test('variants: positive control, found only with a variant, deterministic, unchanged without', () => {
  const { root, target } = world();
  try {
    const idx = search.buildIndex(root);
    const opt = { top: 3, mmr: true };
    const without = search.search(idx, QUESTION, opt);
    assert.ok(!without.some((h) => h.entry.id === target.id), 'positive control: the question alone finds nothing');
    const withV = variants.searchWithVariants(idx, QUESTION, VARIANTS, opt);
    assert.equal(withV[0].entry.id, target.id, 'found through a variant');
    assert.ok(withV[0].foundBy.every((x) => x.startsWith('variant:')), 'origin visible');
    assert.deepEqual(
      variants.searchWithVariants(idx, QUESTION, VARIANTS, opt).map((h) => [h.source, h.line, h.score]),
      withV.map((h) => [h.source, h.line, h.score]), 'deterministic');
    assert.deepEqual(variants.searchWithVariants(idx, QUESTION, [], opt).map((h) => `${h.source}:${h.line}`),
      without.map((h) => `${h.source}:${h.line}`), 'without variants identical to search()');
    // The score stays a REAL score of one search, never the fusion number.
    const real = search.search(idx, VARIANTS[0], { top: 10 }).find((h) => h.entry.id === target.id);
    assert.equal(withV[0].score, real.score);
    // A variant that matches nothing brings nothing false along.
    const bait = variants.searchWithVariants(idx, 'weather in bayreuth', ['recipe for cheese noodles'], { top: 3, minScore: 5 });
    assert.equal(bait.length, 0);
  } finally { rm(root); }
});

test('CLI: mem find --variants finds what the question alone does not; a bare flag is refused', () => {
  const { root } = world();
  try {
    const find = (...a) => spawnSync('node', [MEM, '--root', root, 'find', ...a], { encoding: 'utf8', timeout: 30000 });
    let r = find(QUESTION, '--json', '--top', '3', '--weak');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!JSON.parse(r.stdout).hits.some((h) => h.entry.title === 'zorblat flux overflow'), 'positive control');
    r = find(QUESTION, '--json', '--top', '3', '--variants', VARIANTS.join('|'));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(JSON.parse(r.stdout).hits.some((h) => h.entry.title === 'zorblat flux overflow'), r.stdout.slice(0, 400));
    assert.notEqual(find('x', '--variants').status, 0, 'flag without a value');
  } finally { rm(root); }
});

test('MCP: mem_find offers `variants` (array, at most 4) and passes them to the fusion', () => {
  const { root } = world();
  try {
    const lines = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mem_find', arguments: { query: QUESTION, top: 3, weak: true } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'mem_find', arguments: { query: QUESTION, top: 3, variants: VARIANTS } } },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n';
    const r = spawnSync('node', [MCP], { input: lines, encoding: 'utf8', timeout: 40000, env: { ...process.env, CHEAP_MEM_ROOT: root } });
    const replies = new Map(String(r.stdout).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).map((o) => [o.id, o]));
    assert.ok(replies.has(2), `no tools/list reply; stderr: ${String(r.stderr).slice(0, 500)}`);
    const tool = replies.get(2).result.tools.find((t) => t.name === 'mem_find');
    assert.equal(tool.inputSchema.properties.variants.type, 'array');
    assert.equal(tool.inputSchema.properties.variants.maxItems, 4);
    const text = (id) => replies.get(id).result.content.map((c) => c.text).join('\n');
    assert.ok(!text(3).includes('zorblat'), `positive control: ${text(3).slice(0, 300)}`);
    assert.ok(text(4).includes('zorblat'), text(4).slice(0, 300));
  } finally { rm(root); }
});

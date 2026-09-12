// The read-only MCP profile.
//
// The test that carries the rest is the last one: it derives the
// classification from the CASE BODIES in bin/mem-mcp. Without it the
// lists are a memory of what the tools do, and memory is exactly what
// went wrong in the sibling: two tools were listed as reading that
// write on the way.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE, READING, WRITING, fromEnv, allowed, visible, refusal, coverage,
} from '../src/mcpprofile.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('only the exact string "1" switches the profile on', () => {
  assert.equal(fromEnv({ CHEAP_MEM_MCP_READONLY: '1' }), PROFILE.READ_ONLY);
  for (const v of ['true', 'yes', 'on', '0', '', ' 1', '1 ', undefined]) {
    assert.equal(fromEnv({ CHEAP_MEM_MCP_READONLY: v }), PROFILE.FULL, `switched on by ${JSON.stringify(v)}`);
  }
  assert.equal(fromEnv({}), PROFILE.FULL);
});

test('an UNKNOWN tool counts as writing, not as reading', () => {
  // The other way round is the convenient default and the wrong one:
  // every new tool would be readable from the day it is added until
  // somebody remembers the list.
  assert.equal(allowed('mem_something_new', PROFILE.READ_ONLY), false);
  assert.equal(allowed('', PROFILE.READ_ONLY), false);
  assert.equal(allowed(null, PROFILE.READ_ONLY), false);
});

test('the full profile allows everything, including the unknown', () => {
  assert.equal(allowed('mem_log', PROFILE.FULL), true);
  assert.equal(allowed('mem_something_new', PROFILE.FULL), true);
});

test('reading tools pass, writing ones do not', () => {
  for (const t of READING) assert.equal(allowed(t, PROFILE.READ_ONLY), true, `refused: ${t}`);
  for (const t of WRITING) assert.equal(allowed(t, PROFILE.READ_ONLY), false, `let through: ${t}`);
});

test('hidden AND refused — listing alone is a hint, not a boundary', () => {
  const tools = [{ name: 'mem_find' }, { name: 'mem_log' }];
  assert.deepEqual(visible(tools, PROFILE.READ_ONLY).map((t) => t.name), ['mem_find']);
  // A client that knows the name must still be refused.
  assert.equal(allowed('mem_log', PROFILE.READ_ONLY), false);
});

test('the refusal names the profile and how to turn it off', () => {
  const r = refusal('mem_log');
  assert.match(r, /mem_log/);
  assert.match(r, /CHEAP_MEM_MCP_READONLY=1/);
  assert.match(r, /Nothing was changed/);
});

test('the two lists do not overlap', () => {
  const both = READING.filter((r) => WRITING.includes(r));
  assert.deepEqual(both, [], `in both lists: ${both.join(', ')}`);
});

test('mem_inbox_ack is on the writing list, despite the name', () => {
  // It acknowledges, so it reads like a read. It calls inbox.setState,
  // which rewrites the message file.
  assert.ok(WRITING.includes('mem_inbox_ack'));
  const src = fs.readFileSync(path.join(ROOT, 'src', 'inbox.mjs'), 'utf8');
  assert.match(src, /export function setState[\s\S]{0,600}?fs\.writeFileSync/);
});

test('SOURCE PROBE: the classification comes from the code, not from memory', () => {
  // Every case body in bin/mem-mcp is read and matched against a
  // writing call. A tool listed as reading that writes fails here.
  const lines = fs.readFileSync(path.join(ROOT, 'bin', 'mem-mcp'), 'utf8').split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*case '(mem_[a-z_]+)':/);
    if (m) starts.push([m[1], i]);
  });
  assert.ok(starts.length >= 20, 'no case bodies found — the probe checks nothing');

  // The calls that change something on disk.
  //
  // Two of these are here because their NAMES do not say they write,
  // and both have already fooled someone: `inbox.setState` (called by
  // the tool named "ack") and `inbox.markSeen` (called by the tool
  // named "new"). The first run of this probe flagged mem_inbox_new as
  // "listed as writing but shows no write" — the probe was incomplete,
  // not the classification. A probe that only finds what it was built
  // to find is a probe that agrees with its author.
  const writes = /memory\.logEntry|memory\.closeDuty|memory\.projectInit|memory\.correctionEntry|inbox\.(setState|write|markSeen)\(|store\.put|question\.answer|fs\.(appendFileSync|writeFileSync)/;

  const wrong = [];
  const unlisted = [];
  for (let k = 0; k < starts.length; k += 1) {
    const [name, i] = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1][1] : lines.length;
    const body = lines.slice(i, end).join('\n');
    const doesWrite = writes.test(body);
    if (READING.includes(name) && doesWrite) wrong.push(`${name} is listed as reading but writes`);
    if (WRITING.includes(name) && !doesWrite) unlisted.push(`${name} is listed as writing but shows no write`);
    if (!READING.includes(name) && !WRITING.includes(name)) unlisted.push(`${name} is in neither list`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.deepEqual(unlisted, [], unlisted.join('\n'));
});

test('coverage() names what nobody has sorted', () => {
  assert.deepEqual(coverage(['mem_find', 'mem_log']), []);
  assert.deepEqual(coverage(['mem_brand_new']), ['mem_brand_new']);
});

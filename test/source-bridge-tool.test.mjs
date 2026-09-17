// A bridge pointer names the tool that COULD dereference it. This code
// never does. See src/source.mjs's module comment on BRIDGE_TOOL_FIELD.
//
// The outside proposal's kernel, kept: a pointer that says HOW to look
// itself up (`bridge_tool`, `source_uri`) is more useful than one that
// does not, because the AGENT reading the memory can make that call
// with its own permissions, in the open. What is cut is any path in
// THIS repository that makes the call for it — that would be exactly
// the crawler `src/source.mjs`'s header already refuses to be.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';
import * as source from '../src/source.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-bridge-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({ name: 'b' }));
  return r;
}
const away = (r) => fs.rmSync(r, { recursive: true, force: true });

test('a bridge pointer carries source_uri and bridge_tool as plain data', () => {
  const r = world();
  try {
    const { entry } = source.declareBridge(r, 'symbol://Foo.bar', 'cbm_inspect_symbol', {
      title: 'Foo.bar',
    });
    assert.equal(entry.kind, 'bridge');
    assert.equal(entry.source_uri, 'symbol://Foo.bar');
    assert.equal(entry[source.BRIDGE_TOOL_FIELD], 'cbm_inspect_symbol');

    const { entries } = memory.readLog(r, source.TYPE, { project: null });
    assert.equal(entries.length, 1);
    assert.equal(entries[0][source.BRIDGE_TOOL_FIELD], 'cbm_inspect_symbol');
  } finally { away(r); }
});

test('a URI that is neither http(s) nor a local file is still accepted for a bridge pointer', () => {
  // take() would refuse this (it is not an address and not a file);
  // declareBridge() must not apply that rule, because a bridge_uri is
  // meaningful to the NAMED TOOL, not to this program.
  const r = world();
  try {
    assert.doesNotThrow(() => source.declareBridge(r, 'jira://PROJ-1234', 'jira_lookup'));
  } finally { away(r); }
});

test('bridge_tool must look like a name, not a stray command line', () => {
  const r = world();
  try {
    assert.throws(() => source.declareBridge(r, 'x://1', 'rm -rf /'), /bridge_tool/);
    assert.throws(() => source.declareBridge(r, 'x://1', ''), /bridge_tool/);
  } finally { away(r); }
});

/**
 * THE PROBE THAT MATTERS: no code path in this repository ever invokes
 * the tool a bridge_tool field names.
 *
 * What it looks for: any line in src/ or bin/ that mentions
 * `bridge_tool` (or the constant that holds that string) together with
 * something that RUNS something — spawn, exec, fetch, import(), require
 * with a variable, eval, new Function. A field merely being read,
 * stored, formatted or compared is fine; a field feeding a call is not.
 *
 * Deliberately textual, not an AST walk: the guarantee this defends is
 * "nobody ever WROTE such a call", and grepping the literal source is
 * the check that cannot be fooled by the call being reachable only on
 * some path an AST-based allowlist forgot to cover.
 */
function sourceFiles() {
  const out = [];
  for (const dir of ['src', 'bin']) {
    const base = path.join(REPO, dir);
    for (const name of fs.readdirSync(base)) {
      const p = path.join(base, name);
      if (fs.statSync(p).isDirectory()) {
        for (const sub of fs.readdirSync(p)) {
          if (sub.endsWith('.mjs')) out.push(path.join(p, sub));
        }
        continue;
      }
      if (name.endsWith('.mjs') || name === 'mem' || name.startsWith('mem-')) out.push(p);
    }
  }
  return out;
}

const RUNNERISH = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fetch|eval|new\s+Function)\s*\(/;

function bridgeInvocationLines() {
  const hits = [];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/bridge_tool|BRIDGE_TOOL_FIELD/.test(line)) continue;
      // Look at this line and the next two: a call is sometimes spread
      // over a couple of lines (`spawn(\n  entry.bridge_tool, ...)`).
      const window = lines.slice(i, i + 3).join('\n');
      if (RUNNERISH.test(window)) hits.push({ file: path.relative(REPO, file), line: i + 1, window });
    }
  }
  return hits;
}

test('THE CASE: nothing in this repository invokes a bridge_tool value', () => {
  const hits = bridgeInvocationLines();
  assert.deepEqual(hits, [], `bridge_tool reaches a call site:\n${JSON.stringify(hits, null, 2)}`);
});

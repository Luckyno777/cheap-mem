// The read-only MCP profile.
//
// The test that carries the rest is the SOURCE PROBE at the bottom. Its
// first version read only the CASE BODY in bin/mem-mcp and matched a
// fixed list of writing call names against it — one level deep. That
// missed three tools whose case body calls a helper (`heartbeat.beat(`,
// `board.report(`, `source.take(`) which writes further in, not the
// case body itself. This version instead FOLLOWS calls through the
// modules they resolve to, however many hops it takes, and checks for
// the one thing that cannot be delegated away: an actual
// `fs.appendFileSync`/`writeFileSync` call at the bottom.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE, READING, WRITING, READONLY_EXCEPTIONS,
  fromEnv, allowed, visible, refusal, coverage,
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
  for (const t of WRITING) {
    if (READONLY_EXCEPTIONS.includes(t)) continue;
    assert.equal(allowed(t, PROFILE.READ_ONLY), false, `let through: ${t}`);
  }
});

test('the read-only exception is exactly one tool, and it is on the writing list', () => {
  // The carve-out is checked here rather than trusted. Three things have
  // to hold at once, or it stops being an exception and becomes a hole:
  // it is small, every member really writes (so nobody quietly moves a
  // reader onto it to dodge a refusal), and no member is back in READING
  // — which would make it invisible again, the failure it exists to undo.
  assert.deepEqual([...READONLY_EXCEPTIONS], ['mem_heartbeat'],
    'the exception list grew — each addition needs its own reason in the module doc');
  for (const t of READONLY_EXCEPTIONS) {
    assert.ok(WRITING.includes(t), `${t} is excepted but not listed as writing`);
    assert.ok(!READING.includes(t), `${t} is excepted AND in READING — one of the two is wrong`);
    assert.equal(allowed(t, PROFILE.READ_ONLY), true, `${t} is excepted but refused`);
  }
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
  // **The probe follows the call, it does not match the name.**
  //
  // Until 2026-09-19 this was a single regex over the case body, and it
  // missed all three tools that write one hop further in:
  //
  //   mem_heartbeat     -> heartbeat.beat()  -> fs.appendFileSync
  //   mem_bridge_report -> board.report()    -> fs.appendFileSync
  //   mem_source        -> source.take()     -> memory.logEntry()
  //
  // All three sat in READING, and this probe was green. Its own comment
  // said it: a probe that only finds what it was built to find is a
  // probe that agrees with its author. A longer name list would have
  // been the same mistake with more lines, so instead the bodies of the
  // called functions are read too, two hops deep — enough for every
  // path measured here, and it generalises to the next one.
  const SYSCALLS = /fs\.(appendFileSync|writeFileSync|writeFile\(|appendFile\()|fs\.promises\.(write|append)/;

  // **Derived state is not memory content.**
  //
  // The walker immediately found a fourth tool the old regex had also
  // missed: `mem_find` -> `search.loadIndex()` -> `fs.writeFileSync` on
  // `.mem/search-index.json`. That write is real — worth knowing for a
  // read-only filesystem — but it is not what this boundary protects.
  // The cache is rebuildable from the logs and carries no byte the
  // caller supplied; refusing `mem_find` under the read-only profile
  // would make the profile useless while protecting nothing.
  //
  // So it is excepted here, by name, with the reason — and the
  // assertion below fails if the function is ever renamed away, rather
  // than the exception quietly widening to cover its replacement.
  //
  // **The second class: a write that is only a question.**
  //
  // The walker then found `mem_board` -> `board.tileSetup` ->
  // `setup.check` -> `setup.archiveStep`, which does
  // `fs.writeFileSync(probe)` immediately followed by `fs.unlinkSync`.
  // That is not a write in any sense this boundary cares about: it is
  // how the setup check ANSWERS "is the archive writable" — the only
  // honest way to answer it, since a permission bit is not the same
  // question as a successful write. Nothing the caller supplied is
  // stored and nothing survives the call.
  //
  // It is excepted by name, like the one above, and the assertion below
  // holds it to what it claims: the body must still delete what it
  // wrote. The day the probe starts leaving its file behind, this test
  // fails rather than waving it through.
  const EXCEPTED_WRITES = new Map([
    ['search.loadIndex', {
      why: 'rebuildable cache, carries no caller byte',
      // A cache write is still a write: it must be visible as one.
      holds: (body) => SYSCALLS.test(body),
    }],
    ['setup.archiveStep', {
      why: 'write-and-delete probe: the answer to "is this writable"',
      holds: (body) => SYSCALLS.test(body) && /fs\.unlinkSync/.test(body),
    }],
  ]);

  const modules = new Map();
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (f.endsWith('.mjs')) {
      modules.set(f.replace('.mjs', ''), fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'));
    }
  }
  assert.ok(modules.size >= 30, `only ${modules.size} modules read — the walker looks in the wrong place`);

  /**
   * The function names a module defines, exported or not.
   *
   * A write is often reached through a LOCAL call: `memory.closeDuty`
   * ends in `logEntry(...)`, with no module prefix, because it is the
   * same file. A walker that only follows `module.fn(` stops one line
   * short of the write and reports the tool as harmless.
   */
  function definedFunctions(moduleText) {
    const names = new Set();
    for (const [, n] of moduleText.matchAll(/(?:export )?(?:async )?function (\w+)/g)) names.add(n);
    for (const [, n] of moduleText.matchAll(/(?:export )?const (\w+)\s*=\s*(?:async )?\(/g)) names.add(n);
    return names;
  }

  /** The body of any function in a module, local ones included. */
  function anyBody(moduleText, fn) {
    const re = new RegExp(`(?:export )?(?:async )?function ${fn}\\b|(?:export )?const ${fn}\\s*=`);
    const m = re.exec(moduleText);
    if (!m) return null;
    const rest = moduleText.slice(m.index + m[0].length);
    const next = rest.search(/\n(?:export )?(?:async )?(?:function|const) /);
    return next === -1 ? rest : rest.slice(0, next);
  }

  /** Does `mod.fn` end up writing to disk, directly or further in? */
  function reachesAWrite(mod, fn, depth = 3, seen = new Set()) {
    const key = `${mod}.${fn}`;
    if (EXCEPTED_WRITES.has(key)) return false;
    if (seen.has(key) || depth < 0) return false;
    seen.add(key);
    const text = modules.get(mod);
    if (!text) return false;
    const body = anyBody(text, fn);
    if (body === null) return false;
    if (SYSCALLS.test(body)) return true;
    for (const [, m2, f2] of body.matchAll(/\b([a-z][a-zA-Z]*)\.([a-zA-Z_][\w]*)\s*\(/g)) {
      if (modules.has(m2) && reachesAWrite(m2, f2, depth - 1, seen)) return true;
    }
    const local = definedFunctions(text);
    for (const [, f2] of body.matchAll(/(?:^|[^.\w])([a-zA-Z_][\w]*)\s*\(/g)) {
      if (local.has(f2) && reachesAWrite(mod, f2, depth - 1, seen)) return true;
    }
    return false;
  }

  // POSITIVE CONTROL for the walker itself. Without it, a broken
  // resolver returns false everywhere and this whole probe passes by
  // measuring nothing.
  assert.ok(reachesAWrite('memory', 'logEntry'), 'walker cannot see memory.logEntry write');
  assert.ok(reachesAWrite('source', 'take'), 'walker cannot follow source.take -> memory.logEntry');
  assert.ok(reachesAWrite('heartbeat', 'beat'), 'walker cannot see heartbeat.beat write');
  assert.ok(reachesAWrite('memory', 'closeDuty'),
    'walker cannot follow the LOCAL call memory.closeDuty -> logEntry');
  // NEGATIVE CONTROL: a pure reader must not be reported as writing,
  // or every tool would count as writing and the probe would be noise.
  assert.equal(reachesAWrite('mcpprofile', 'allowed'), false,
    'walker calls a pure reader a writer');
  // The excepted function must still EXIST and still write, or the
  // exception is covering a name that moved and protects nothing.
  for (const [key, rule] of EXCEPTED_WRITES) {
    const [mod, fn] = key.split('.');
    const body = anyBody(modules.get(mod) ?? '', fn);
    assert.ok(body !== null, `${key} is excepted but no longer exists`);
    assert.ok(rule.holds(body),
      `${key} is excepted (${rule.why}) but no longer matches that description`);
  }

  const writes = (body) => {
    if (SYSCALLS.test(body)) return true;
    for (const [, mod, fn] of body.matchAll(/\b([a-z][a-zA-Z]*)\.([a-zA-Z_][\w]*)\s*\(/g)) {
      if (modules.has(mod) && reachesAWrite(mod, fn)) return true;
    }
    return false;
  };

  const wrong = [];
  const unlisted = [];
  for (let k = 0; k < starts.length; k += 1) {
    const [name, i] = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1][1] : lines.length;
    const body = lines.slice(i, end).join('\n');
    const doesWrite = writes(body);
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

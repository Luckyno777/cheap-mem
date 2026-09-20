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
//
// **2026-09-20, issue #149: the walker only resolved LOCAL calls.**
// `mod.fn(` was followed when `mod` was a real module key, and a bare
// `fn(` was followed when `fn` was defined IN THE SAME FILE — but
// `heartbeat.beat` calls the IMPORTED `appendLine(...)` with no module
// prefix, and neither rule fires: `appendLine` is not a module key and
// it is not defined in heartbeat.mjs. The walker fell silent, and
// silence read as "no write found". Its own positive control caught
// it: `reachesAWrite('heartbeat', 'beat')` had been returning `false`
// the whole time, for a tool this file's own WRITING list already
// knows appends to disk. Fixed by teaching the walker to resolve an
// import — named, renamed, namespaced (alias or not) — to the module
// and export it actually names, and to walk on from there. An import
// this walker cannot follow (a bare package, a path outside its module
// index) now comes back as `'unknown'`, a third state distinct from
// both `true` and `false`: a tool whose reachability could not be
// established must not be cleared as read-only, so `'unknown'` is
// handled everywhere `true` is — never folded into "no write found".
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
      //
      // **Since B8 (2026-09-20):** the actual `fs.writeFileSync` calls
      // moved one hop further in, out of `loadIndex`'s own body and into
      // `indexcache.mjs`'s `writeIndexCache` (the cache is now a shard
      // directory, not one file `loadIndex` writes directly — see that
      // module). So the flat "does this function's own text contain a
      // syscall" check that worked before B8 would now find nothing and
      // report the exception as stale. This follows that one hop instead:
      // `loadIndex`'s body must still call `indexcache.writeIndexCache`,
      // and that function — via the general walker defined below, not a
      // second flat regex — must still actually reach a real write.
      holds: (body) => /indexcache\.writeIndexCache\s*\(/.test(body)
        && reachesAWrite('indexcache', 'writeIndexCache'),
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

  /**
   * The import bindings a piece of source text makes available under a
   * local name — three shapes, because each has already fooled a
   * walker that only recognised `module.fn(` when `module` was itself
   * a module key:
   *
   *   import { appendLine } from './append.mjs';      // named
   *   import { a as b } from './y.mjs';                // renamed
   *   import * as setup from './setup.mjs';            // namespace
   *   import * as cfgmod from './config.mjs';           // namespace, ALIASED
   *
   * The last line is real, not hypothetical: `retrieval.mjs` imports
   * `./capability.mjs` as `capabilityMod`, and `bin/mem-mcp` itself
   * imports `./config.mjs` as `cfgmod`. A walker that assumes the alias
   * equals the file name would never follow `capabilityMod.fn(` or
   * `cfgmod.fn(` anywhere — same failure as the unqualified case, one
   * import shape over.
   *
   * `export { a } from './y.mjs'` and `export * from './y.mjs'` are
   * parsed too, for the same reason: neither exists in this codebase
   * today, but a walker that only handles the import shapes currently
   * in use would repeat this exact bug the day one is added, and a
   * trap you did not check for is a trap you built.
   */
  function parseImports(text) {
    const named = new Map(); // localName -> { mod, exportName }
    const namespace = new Map(); // localAlias -> mod (alias may differ from the file name)
    const reexports = new Map(); // localName -> { mod, exportName }  (export { a } from ...)
    const starReexports = []; // module names wholesale re-exported (export * from ...)

    const bindList = (list, mod, into) => {
      for (const part of list.split(',')) {
        const p = part.trim();
        if (!p) continue;
        const renamed = p.match(/^(\w+)\s+as\s+(\w+)$/);
        if (renamed) into.set(renamed[2], { mod, exportName: renamed[1] });
        else into.set(p, { mod, exportName: p });
      }
    };

    let m;
    const reNamed = /import\s*\{([^}]+)\}\s*from\s*['"]\.\/([\w./-]+?)\.mjs['"]/g;
    while ((m = reNamed.exec(text))) bindList(m[1], m[2], named);

    const reDefault = /import\s+(\w+)\s+from\s*['"]\.\/([\w./-]+?)\.mjs['"]/g;
    while ((m = reDefault.exec(text))) named.set(m[1], { mod: m[2], exportName: 'default' });

    const reNamespace = /import\s*\*\s*as\s+(\w+)\s+from\s*['"]\.\/([\w./-]+?)\.mjs['"]/g;
    while ((m = reNamespace.exec(text))) namespace.set(m[1], m[2]);

    const reNamedReexport = /export\s*\{([^}]+)\}\s*from\s*['"]\.\/([\w./-]+?)\.mjs['"]/g;
    while ((m = reNamedReexport.exec(text))) bindList(m[1], m[2], reexports);

    const reStarReexport = /export\s*\*\s*from\s*['"]\.\/([\w./-]+?)\.mjs['"]/g;
    while ((m = reStarReexport.exec(text))) starReexports.push(m[1]);

    return {
      named, namespace, reexports, starReexports,
    };
  }

  /**
   * Where does the qualified call `prefix.fn(` inside `callerText`
   * actually point?
   *
   *   { kind: 'module', mod }   -- a real module, follow it
   *   { kind: 'unknown', why }  -- `prefix` IS an import, but this
   *                                walker cannot read what it imports
   *                                (a bare package, a path outside its
   *                                module index — e.g. `embed-hook.mjs`
   *                                imports `./embed/index.mjs`, a
   *                                subdirectory this walker's flat
   *                                `src/*.mjs` index does not cover)
   *   { kind: 'none' }          -- not a project call at all (`path.join`,
   *                                `JSON.stringify`, a local variable) —
   *                                not every unrecognised prefix is a
   *                                gap in this walker's knowledge
   */
  // `parseImports` re-parses a whole file with several regexes; called
  // fresh on every visit to the same module it turns a fast walk into a
  // slow one (a module imported by many others gets re-scanned once per
  // caller, per call site). Parsed once per module and cached instead —
  // the text does not change between visits.
  const importsCache = new Map();
  function importsOf(mod) {
    if (!importsCache.has(mod)) importsCache.set(mod, parseImports(modules.get(mod)));
    return importsCache.get(mod);
  }

  function resolveQualified(callerImports, prefix) {
    const { namespace } = callerImports;
    if (namespace.has(prefix)) {
      const mod = namespace.get(prefix);
      if (!modules.has(mod)) {
        return { kind: 'unknown', why: `imports '* as ${prefix}' from './${mod}.mjs', outside this walker's module index` };
      }
      return { kind: 'module', mod };
    }
    if (modules.has(prefix)) return { kind: 'module', mod: prefix };
    return { kind: 'none' };
  }

  /**
   * Where does the bare call `name(` inside `mod` point, given `name`
   * is not a function `mod` defines itself?
   *
   *   { kind: 'call', mod, fn } -- an import or re-export, follow it
   *   { kind: 'unknown', why }  -- same reasoning as resolveQualified
   *   { kind: 'none' }          -- not a resolvable project call
   */
  function resolveBare(mod, name) {
    const { named, reexports, starReexports } = importsOf(mod);
    if (named.has(name)) {
      const { mod: m2, exportName } = named.get(name);
      if (!modules.has(m2)) return { kind: 'unknown', why: `imports '${name}' from './${m2}.mjs', outside this walker's module index` };
      return { kind: 'call', mod: m2, fn: exportName };
    }
    if (reexports.has(name)) {
      const { mod: m2, exportName } = reexports.get(name);
      if (!modules.has(m2)) return { kind: 'unknown', why: `re-exports '${name}' from './${m2}.mjs', outside this walker's module index` };
      return { kind: 'call', mod: m2, fn: exportName };
    }
    for (const m2 of starReexports) {
      if (!modules.has(m2)) return { kind: 'unknown', why: `does 'export * from ./${m2}.mjs', outside this walker's module index` };
      if (definedFunctions(modules.get(m2)).has(name)) return { kind: 'call', mod: m2, fn: name };
    }
    return { kind: 'none' };
  }

  /**
   * Does `mod.fn` end up writing to disk, directly or further in?
   *
   * Three outcomes, not two:
   *   `true`      a write was found
   *   `false`     every path this walker could follow led to a read
   *   `'unknown'` a path ran through an import this walker could not
   *               resolve, so a write could not be ruled out
   *
   * `'unknown'` is deliberately not `false`. "Not measurable is not
   * zero": a tool whose reachability could not be established must not
   * be cleared as read-only, so every caller of this function treats
   * `'unknown'` exactly like `true` — never folds it into "no write
   * found", which is the whole shape of the bug this rewrite fixes.
   *
   * Cycles are broken with a visited-set scoped to the CURRENT PATH
   * (added before recursing, removed on the way back out), not a
   * recursion-depth guess: a depth number that happens to be large
   * enough today is silent about why, and wrong the day one more hop
   * is added. A result is only memoised in `resultCache` once it is
   * fully settled outside of any cycle short-circuit, so the cache
   * cannot paper over a real one — it exists purely so a module called
   * from many places (`memory.mjs`, imported almost everywhere) is
   * walked once, not once per caller.
   */
  const resultCache = new Map(); // 'mod.fn' -> true | false | 'unknown', settled results only
  function reachesAWrite(mod, fn, seen = new Set()) {
    const key = `${mod}.${fn}`;
    if (EXCEPTED_WRITES.has(key)) return false;
    if (resultCache.has(key)) return resultCache.get(key);
    if (!modules.has(mod)) return 'unknown'; // not cached: a fixed fact of `mod` alone would be fine to cache, but this path is not hot enough to bother
    if (seen.has(key)) return false; // on the CURRENT path already — a cycle edge, not a new answer, and not cached

    const text = modules.get(mod);
    const body = anyBody(text, fn);
    let result;
    if (body === null) {
      // Not a function `mod` defines — it may only be PASSING THROUGH,
      // an import or re-export of something else. Follow it one more
      // hop rather than reporting a name we never actually looked up.
      const r = resolveBare(mod, fn);
      if (r.kind === 'unknown') result = 'unknown';
      else if (r.kind === 'call') {
        seen.add(key);
        result = reachesAWrite(r.mod, r.fn, seen);
        seen.delete(key);
      } else result = false;
    } else if (SYSCALLS.test(body)) {
      result = true;
    } else {
      seen.add(key);
      try {
        let sawUnknown = false;
        let found = false;

        for (const [, prefix, f2] of body.matchAll(/\b([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\s*\(/g)) {
          const r = resolveQualified(importsOf(mod), prefix);
          if (r.kind === 'unknown') { sawUnknown = true; continue; }
          if (r.kind !== 'module') continue;
          const v = reachesAWrite(r.mod, f2, seen);
          if (v === true) { found = true; break; }
          if (v === 'unknown') sawUnknown = true;
        }

        if (!found) {
          const local = definedFunctions(text);
          for (const [, f2] of body.matchAll(/(?:^|[^.\w])([a-zA-Z_][\w]*)\s*\(/g)) {
            if (local.has(f2)) {
              const v = reachesAWrite(mod, f2, seen);
              if (v === true) { found = true; break; }
              if (v === 'unknown') sawUnknown = true;
              continue;
            }
            const r = resolveBare(mod, f2);
            if (r.kind === 'unknown') { sawUnknown = true; continue; }
            if (r.kind === 'call') {
              const v = reachesAWrite(r.mod, r.fn, seen);
              if (v === true) { found = true; break; }
              if (v === 'unknown') sawUnknown = true;
            }
          }
        }

        result = found ? true : (sawUnknown ? 'unknown' : false);
      } finally {
        seen.delete(key);
      }
    }
    resultCache.set(key, result);
    return result;
  }

  // POSITIVE CONTROL for the walker itself. Without it, a broken
  // resolver returns false everywhere and this whole probe passes by
  // measuring nothing.
  assert.ok(reachesAWrite('memory', 'logEntry'), 'walker cannot see memory.logEntry write');
  assert.ok(reachesAWrite('source', 'take'), 'walker cannot follow source.take -> memory.logEntry');
  // SOURCE PROBE POSITIVE CONTROL (issue #149): `heartbeat.beat` calls
  // the IMPORTED `appendLine(...)` with no module prefix. Before the
  // import fix this returned `false` — the walker's own regression
  // test for a write it is supposed to already know about.
  assert.equal(reachesAWrite('heartbeat', 'beat'), true,
    'walker cannot follow the IMPORTED, unqualified call heartbeat.beat -> appendLine');
  assert.ok(reachesAWrite('memory', 'closeDuty'),
    'walker cannot follow the LOCAL call memory.closeDuty -> logEntry');

  // NEGATIVE CONTROLS: a pure reader must not be reported as writing,
  // or every tool would count as writing and the probe would be noise.
  assert.equal(reachesAWrite('mcpprofile', 'allowed'), false,
    'walker calls a pure reader a writer');
  // This one exercises the import walk itself, not just local calls:
  // `timesearch.entriesInWindow` calls the IMPORTED, unqualified
  // `find(...)` (from memory.mjs), and `memory.find` only reads. A
  // fix that says "yes" to every import — the "worse than none" this
  // task warns about — would fail exactly here.
  assert.equal(reachesAWrite('timesearch', 'entriesInWindow'), false,
    'walker treats a genuine import-only read as a write');

  // UNKNOWN PROBE: `embed-hook.mjs` imports `./embed/index.mjs` and
  // `./embed/store.mjs` — real files, but in a subdirectory this
  // walker's flat `src/*.mjs` index does not cover. That import cannot
  // be followed, and "cannot be followed" must not read as "reaches no
  // write". (embedEntry is not reachable from any current MCP tool —
  // this is a direct regression probe on the walker, not a live
  // finding — but it is the walker's one real example of the trap, so
  // it stands in for a bare package specifier too.)
  assert.equal(reachesAWrite('embed-hook', 'embedEntry'), 'unknown',
    'walker must report an import outside its module index as unknown, not clear it');

  // The excepted function must still EXIST and still write, or the
  // exception is covering a name that moved and protects nothing.
  for (const [key, rule] of EXCEPTED_WRITES) {
    const [mod, fn] = key.split('.');
    const body = anyBody(modules.get(mod) ?? '', fn);
    assert.ok(body !== null, `${key} is excepted but no longer exists`);
    assert.ok(rule.holds(body),
      `${key} is excepted (${rule.why}) but no longer matches that description`);
  }

  // `bin/mem-mcp` has its own import aliases to resolve before a case
  // body's qualified calls mean anything — it imports `./config.mjs`
  // as `cfgmod`, for one. Parsed from the WHOLE file, not the sliced
  // case body: the `import` line lives above the `switch`, not inside
  // any one case.
  const binImports = parseImports(lines.join('\n'));

  /** 'write' | 'unknown' | 'clean' for one case body. */
  const classify = (body) => {
    if (SYSCALLS.test(body)) return 'write';
    let sawUnknown = false;
    for (const [, prefix, f2] of body.matchAll(/\b([a-zA-Z_][\w]*)\.([a-zA-Z_][\w]*)\s*\(/g)) {
      const r = resolveQualified(binImports, prefix);
      if (r.kind === 'unknown') { sawUnknown = true; continue; }
      if (r.kind !== 'module') continue;
      const v = reachesAWrite(r.mod, f2);
      if (v === true) return 'write';
      if (v === 'unknown') sawUnknown = true;
    }
    return sawUnknown ? 'unknown' : 'clean';
  };

  const wrong = [];
  const unlisted = [];
  for (let k = 0; k < starts.length; k += 1) {
    const [name, i] = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1][1] : lines.length;
    const body = lines.slice(i, end).join('\n');
    const verdict = classify(body);
    if (READING.includes(name) && verdict !== 'clean') {
      wrong.push(`${name} is listed as reading but ${
        verdict === 'unknown' ? 'reaches an import this walker cannot resolve (unknown, not clean)' : 'writes'}`);
    }
    if (WRITING.includes(name) && verdict === 'clean') unlisted.push(`${name} is listed as writing but shows no write`);
    if (!READING.includes(name) && !WRITING.includes(name)) unlisted.push(`${name} is in neither list`);
  }
  assert.deepEqual(wrong, [], wrong.join('\n'));
  assert.deepEqual(unlisted, [], unlisted.join('\n'));
});

test('coverage() names what nobody has sorted', () => {
  assert.deepEqual(coverage(['mem_find', 'mem_log']), []);
  assert.deepEqual(coverage(['mem_brand_new']), ['mem_brand_new']);
});

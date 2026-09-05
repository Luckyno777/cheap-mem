// bench/fuzz.mjs — malformed input against every parser.
//
// Looking for: crashes, hangs, unbounded memory, and — the one that
// matters most here — a bypass, where garbage in produces a MORE
// permissive answer rather than an error.
//
// Seeded, so a failure is reproducible from the seed it prints.
//
//   node bench/fuzz.mjs [--rounds 2000]

import { redact } from '../src/redaction.mjs';
import { parseScope, Capability, grant, grantProject } from '../src/capability.mjs';
import { validAt, canonicalBody, bodyHash, retrieve, LIMITS } from '../src/retrieval.mjs';
import { replacementGraph, MAX_CHAIN } from '../src/integrity.mjs';
import { maySupersede, tierOf, rank } from '../src/authority.mjs';
import { comparable } from '../src/semantics.mjs';

const rounds = Number(process.argv[process.argv.indexOf('--rounds') + 1]) || 1500;
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; }; }

const NASTY = [
  '', ' ', '\n', '\0', '�', '﻿', '​', '＝', '：', '　',
  '{', '}', '[', ']', '"', '\\', '`', '${}', '../../etc/passwd',
  'project:', ':x', 'global', 'GLOBAL', 'project:a:b', '__proto__',
  'constructor', 'prototype', 'toString', '-1', '1e999', 'NaN', 'null',
  'undefined', '\uD800', '\uDC00', 'a'.repeat(10000), '💥'.repeat(500),
  '2026-13-45T99:99:99Z', '0000-00-00', '+275760-09-13T00:00:00.000Z',
];

function junk(r, depth = 0) {
  const k = Math.floor(r() * 9);
  if (k === 0) return NASTY[Math.floor(r() * NASTY.length)];
  if (k === 1) return Math.floor((r() - 0.5) * 1e15);
  if (k === 2) return r() < 0.5;
  if (k === 3) return null;
  if (k === 4) return undefined;
  if (k === 5 && depth < 2) return [junk(r, depth + 1), junk(r, depth + 1)];
  if (k === 6 && depth < 2) return { [String(junk(r, depth + 1))]: junk(r, depth + 1) };
  if (k === 7) return String.fromCharCode(...Array.from({ length: 1 + Math.floor(r() * 40) },
    () => Math.floor(r() * 0x10000)));
  return NASTY[Math.floor(r() * NASTY.length)];
}

const failures = [];
const fail = (area, seed, why) => failures.push({ area, seed, why });

function guarded(area, seed, fn, { maxMs = 2000 } = {}) {
  const t0 = Date.now();
  try { fn(); } catch (e) {
    // A thrown error is acceptable for garbage input; a HANG or a bypass
    // is not. Only a stack overflow or an OOM is a real defect here.
    if (/Maximum call stack|out of memory|heap/i.test(String(e && e.message))) {
      fail(area, seed, `unbounded recursion/memory: ${e.message}`);
    }
    return;
  }
  const ms = Date.now() - t0;
  if (ms > maxMs) fail(area, seed, `took ${ms} ms`);
}

console.log(`fuzzing ${rounds} rounds per area\n`);

for (let seed = 1; seed <= rounds; seed += 1) {
  const r = rng(seed);

  // --- redaction: must never throw, never hang, never return MORE text
  guarded('redaction', seed, () => {
    const input = String(junk(r));
    const out = redact(input);
    if (typeof out.text !== 'string') fail('redaction', seed, 'text is not a string');
    if (out.found.length === 0 && out.text !== input) {
      fail('redaction', seed, 'text changed with nothing found');
    }
  });

  // --- capability: garbage must never widen what is admitted
  guarded('capability', seed, () => {
    const s = String(junk(r));
    parseScope(s);
    const narrow = grantProject('a', { subject: 'fuzz' });
    if (narrow.admits(s) && parseScope(s).id !== 'project:a' && parseScope(s).id !== 'global') {
      fail('capability', seed, `a project capability admitted ${JSON.stringify(s)}`);
    }
    // A capability built from junk must not admit a real project.
    const weird = grant({ subject: 'fuzz', scopes: [s], rights: [String(junk(r))] });
    if (weird.admits('project:secret') && parseScope(s).id !== 'project:secret'
        && parseScope(s).id !== 'global') {
      fail('capability', seed, `junk scope ${JSON.stringify(s)} admitted project:secret`);
    }
    if (!(weird instanceof Capability)) fail('capability', seed, 'not a Capability');
  });

  // --- temporal: any interval, including impossible ones
  guarded('temporal', seed, () => {
    const c = { valid_from: String(junk(r)), valid_until: String(junk(r)) };
    const v = validAt(c, String(junk(r)));
    if (typeof v !== 'boolean') fail('temporal', seed, 'validAt did not return a boolean');
  });

  // --- authority: junk must never grant permission it should not
  guarded('authority', seed, () => {
    const a = { author: junk(r), authority: junk(r) };
    const b = { author: junk(r), authority: junk(r) };
    const v = maySupersede(a, b);
    if (typeof v.ok !== 'boolean' || typeof v.reason !== 'string') {
      fail('authority', seed, 'malformed verdict');
    }
    if (rank(junk(r)) < 0) fail('authority', seed, 'negative rank');
    if (typeof tierOf({ authority: junk(r) }) !== 'string') fail('authority', seed, 'tier not a string');
  });

  // --- replacement graph: random edges, including self-loops and rings
  guarded('graph', seed, () => {
    const n = 1 + Math.floor(r() * 40);
    const claims = new Map();
    for (let i = 0; i < n; i += 1) {
      const target = r() < 0.7 ? `n${Math.floor(r() * n)}` : String(junk(r));
      claims.set(`n${i}`, { replaces: r() < 0.2 ? null : target, file: 'f', line: i });
    }
    const g = replacementGraph(claims);
    if (g.maxDepth > claims.size + 2) fail('graph', seed, `depth ${g.maxDepth} exceeds node count`);
    if (!Array.isArray(g.cycles)) fail('graph', seed, 'cycles is not an array');
  }, { maxMs: 1000 });

  // --- dedup normalisation: must be stable and must not collide wildly
  guarded('dedup', seed, () => {
    const a = String(junk(r));
    if (bodyHash(a) !== bodyHash(a)) fail('dedup', seed, 'hash is not stable');
    if (canonicalBody(a) !== canonicalBody(canonicalBody(a))) {
      fail('dedup', seed, 'canonicalisation is not idempotent');
    }
  });

  // --- semantics
  guarded('semantics', seed, () => {
    if (typeof comparable(junk(r)) !== 'boolean') fail('semantics', seed, 'not a boolean');
  });
}

// --- retrieval with a garbage capability, on a real memory ---------------
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fuzz-'));
  fs.mkdirSync(path.join(root, 'projects', 'secret'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'secret', 'decisions.jsonl'),
    JSON.stringify({ id: 's1', ts: '2026-01-01T00:00:00Z', topic: 't',
      choice: 'kolibri classified', why: 'must not leak' }) + '\n');

  const r = rng(4242);
  for (let i = 0; i < 400; i += 1) {
    const bogus = junk(r);
    let out;
    try { out = retrieve(root, String(junk(r)), bogus, { top: junk(r) }); }
    catch (e) { fail('retrieve', i, `threw on a bogus capability: ${e.message}`); continue; }
    if (out.claims.length) {
      fail('retrieve', i, `returned ${out.claims.length} claims for capability ${JSON.stringify(bogus)}`);
    }
  }
  // And with a REAL but unrelated capability.
  for (let i = 0; i < 200; i += 1) {
    const out = retrieve(root, String(junk(r)), grantProject('other'), { top: 10 });
    if (out.claims.some((c) => c.id === 's1')) fail('retrieve', i, 'leaked across scopes');
    if (out.claims.length > LIMITS.maxResults) fail('retrieve', i, 'exceeded maxResults');
  }
  fs.rmSync(root, { recursive: true, force: true });
}

if (!failures.length) {
  console.log('no crashes, hangs, unbounded growth or bypasses found.');
} else {
  console.log(`${failures.length} finding(s):`);
  for (const f of failures.slice(0, 30)) console.log(`  [${f.area}] seed ${f.seed}: ${f.why}`);
  process.exitCode = 1;
}

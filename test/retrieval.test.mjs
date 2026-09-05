// The gateway: structured claims out, scope as a boundary, limits that are
// never unbounded. Replaces the measured hole from 2026-09-05 where
// search() returned everything unless a caller remembered to pass a
// project (bench/redteam.mjs scenario 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { retrieve, explainMissing, validAt, enforceAuthorShare, LIMITS } from '../src/retrieval.mjs';
import { grant, grantAll, grantProject, Capability } from '../src/capability.mjs';

function memoryWith(byProject) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-ret-'));
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  for (const [project, entries] of Object.entries(byProject)) {
    const dir = path.join(root, 'projects', project);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'),
      entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return root;
}
const claim = (id, extra = {}) => ({
  id, ts: '2026-01-01T00:00:00Z', topic: 'payments',
  choice: 'kolibri payment routing', why: 'because it settles faster', ...extra,
});
const rm = (root) => fs.rmSync(root, { recursive: true, force: true });

// --- scope as a boundary ---------------------------------------------------

test('a project capability does not see another project', () => {
  const root = memoryWith({ a: [claim('a1')], b: [claim('b1')] });
  const r = retrieve(root, 'kolibri', grantProject('a'));
  assert.deepEqual(r.claims.map((c) => c.id), ['a1']);
  assert.ok(r.excluded.some((e) => e.id === 'b1' && /outside capability/.test(e.why)));
  rm(root);
});

test('there is no argument that widens a capability from the call site', () => {
  const root = memoryWith({ a: [claim('a1')], b: [claim('b1')] });
  // The old hole was `search(idx, q, {})` returning everything. Here the
  // only way to reach both projects is to be HOLDING a capability for
  // both — an option object cannot produce one.
  const narrow = grantProject('a');
  const r = retrieve(root, 'kolibri', narrow, { top: 50 });
  assert.deepEqual(r.claims.map((c) => c.id), ['a1']);
  rm(root);
});

test('no capability means an empty, explained answer — not a crash and not everything', () => {
  const root = memoryWith({ a: [claim('a1')] });
  for (const bad of [undefined, null, 'all', { scopes: ['global'] }]) {
    const r = retrieve(root, 'kolibri', bad);
    assert.deepEqual(r.claims, [], `retrieval returned results for ${JSON.stringify(bad)}`);
    assert.match(r.excluded[0].why, /no capability/);
  }
  rm(root);
});

test('a capability without read returns nothing', () => {
  const root = memoryWith({ a: [claim('a1')] });
  const writeOnly = grant({ subject: 's', scopes: ['project:a'], rights: ['write'] });
  const r = retrieve(root, 'kolibri', writeOnly);
  assert.deepEqual(r.claims, []);
  assert.match(r.excluded[0].why, /does not carry read/);
  rm(root);
});

test('the everything-capability still works — the boundary must not break legitimate breadth', () => {
  // Distinct bodies on purpose: identical ones now collapse, which is
  // correct and is tested separately.
  const root = memoryWith({ a: [claim('a1', { why: 'reason for a' })],
                            b: [claim('b1', { why: 'reason for b' })] });
  const r = retrieve(root, 'kolibri', grantAll('owner'));
  assert.deepEqual(r.claims.map((c) => c.id).sort(), ['a1', 'b1']);
  rm(root);
});

// --- structured, never prose ----------------------------------------------

test('a result is records with provenance, not an assembled string', () => {
  const root = memoryWith({ a: [claim('a1', { author: 'alice', authority: 'agent' })] });
  const r = retrieve(root, 'kolibri', grantProject('a'));
  assert.equal(typeof r, 'object');
  assert.ok(Array.isArray(r.claims));
  const c = r.claims[0];
  for (const field of ['id', 'body', 'author', 'authority', 'scope', 'ts', 'status', 'score']) {
    assert.ok(field in c, `claim is missing ${field}`);
  }
  assert.equal(c.author, 'alice');
  assert.equal(c.authority, 'agent');
  assert.equal(c.scope, 'project:a');
  rm(root);
});

test('the body carries no word the entry did not contain', () => {
  const root = memoryWith({ a: [claim('a1')] });
  const c = retrieve(root, 'kolibri', grantProject('a')).claims[0];
  assert.equal(c.body, 'kolibri payment routing — because it settles faster');
  assert.ok(!/relevant|memor|context|here are/i.test(c.body),
    'the memory decorated its own content');
  rm(root);
});

test('an entry with unknown provenance says unknown rather than nothing', () => {
  const root = memoryWith({ a: [claim('a1')] });
  const c = retrieve(root, 'kolibri', grantProject('a')).claims[0];
  assert.equal(c.authority, 'unknown');
  assert.equal(c.author, null);
  rm(root);
});

// --- temporal --------------------------------------------------------------

test('valid_until is exclusive, valid_from inclusive, absent bounds open-ended', () => {
  const c = { valid_from: '2026-01-01T00:00:00Z', valid_until: '2026-06-01T00:00:00Z' };
  assert.equal(validAt(c, '2025-12-31T23:59:59Z'), false);
  assert.equal(validAt(c, '2026-01-01T00:00:00Z'), true);
  assert.equal(validAt(c, '2026-05-31T23:59:59Z'), true);
  assert.equal(validAt(c, '2026-06-01T00:00:00Z'), false, 'valid_until must be exclusive');
  assert.equal(validAt({}, '2026-06-01T00:00:00Z'), true);
  assert.equal(validAt(c, null), true);
});

test('an as-of query excludes claims that had stopped holding', () => {
  const root = memoryWith({ a: [
    claim('old', { valid_from: '2026-01-01T00:00:00Z', valid_until: '2026-03-01T00:00:00Z' }),
    claim('now', { valid_from: '2026-03-01T00:00:00Z' }),
  ] });
  const r = retrieve(root, 'kolibri', grantProject('a'), { asOf: '2026-05-01T00:00:00Z' });
  assert.deepEqual(r.claims.map((c) => c.id), ['now']);
  assert.ok(r.excluded.some((e) => e.id === 'old' && /not valid at/.test(e.why)));
  rm(root);
});

// --- disputed and superseded ----------------------------------------------

test('a disputed claim is excluded with its reason, and reachable on request', () => {
  const root = memoryWith({ a: [
    claim('a1', { author: 'alice', authority: 'agent', why: 'the original reasoning' }),
    claim('m1', { author: 'mallory', authority: 'agent', why: 'a different text', replaces_id: 'a1' }),
  ] });
  const r = retrieve(root, 'kolibri', grantProject('a'));
  assert.deepEqual(r.claims.map((c) => c.id), ['a1']);
  assert.ok(r.excluded.some((e) => e.id === 'm1' && /disputed/.test(e.why)));

  const withIt = retrieve(root, 'kolibri', grantProject('a'), { withDisputed: true });
  assert.ok(withIt.claims.some((c) => c.id === 'm1' && c.status === 'disputed'));
  rm(root);
});

// --- limits ---------------------------------------------------------------

test('every limit has a value — none is unbounded', () => {
  for (const [k, v] of Object.entries(LIMITS)) {
    assert.ok(Number.isFinite(v) && v > 0, `${k} is not a finite positive bound`);
  }
});

test('an oversized query is capped rather than passed through', () => {
  const root = memoryWith({ a: [claim('a1')] });
  const r = retrieve(root, 'kolibri '.repeat(5000), grantProject('a'));
  assert.equal(r.queryTruncated, true);
  assert.ok(r.query.length <= LIMITS.queryChars);
  rm(root);
});

test('top is clamped to maxResults however large a caller asks', () => {
  // DISTINCT bodies, and more of them than the cap.
  //
  // The first version of this test used 120 IDENTICAL claims. They all
  // collapsed into one through body deduplication, so the result was a
  // single claim and the assertion held whether or not the cap existed.
  // Mutation testing caught it: removing the clamp left this test green.
  // A test that passes with the mechanism disabled proves nothing and
  // reads like proof.
  const many = Array.from({ length: 120 }, (_, i) =>
    claim(`e${i}`, { why: `distinct reasoning number ${i} about kolibri routing` }));
  const root = memoryWith({ a: many });
  const r = retrieve(root, 'kolibri routing', grantProject('a'), { top: 10000 });
  assert.ok(r.claims.length > 1, 'the fixture degenerated — the cap is not being exercised');
  assert.ok(r.claims.length <= LIMITS.maxResults,
    `${r.claims.length} claims returned, cap is ${LIMITS.maxResults}`);
  rm(root);
});

test('the over-fetch is bounded too — a huge top must not scan without limit', () => {
  // The clamp above bounds what comes BACK. This bounds what is looked at:
  // an unbounded over-fetch would turn `top: 1e9` into a denial of service
  // even though the answer stays small.
  const many = Array.from({ length: 200 }, (_, i) =>
    claim(`e${i}`, { why: `distinct reasoning number ${i} about kolibri routing` }));
  const root = memoryWith({ a: many });
  const started = Date.now();
  const r = retrieve(root, 'kolibri routing', grantProject('a'), { top: 1e9 });
  assert.ok(r.claims.length <= LIMITS.maxResults);
  assert.ok(Date.now() - started < 5000, 'an absurd top made retrieval slow');
  rm(root);
});

test('an oversized body is truncated and flagged, not silently cut', () => {
  const root = memoryWith({ a: [claim('big', { why: 'kolibri '.repeat(2000) })] });
  const c = retrieve(root, 'kolibri', grantProject('a')).claims[0];
  assert.equal(c.bodyTruncated, true);
  assert.ok(c.body.length <= LIMITS.bodyChars);
  rm(root);
});

test('one prolific author cannot take the whole answer', () => {
  const claims = Array.from({ length: 10 }, (_, i) => ({
    id: `x${i}`, author: i < 8 ? 'flooder' : 'other', authority: 'agent',
    body: 'b', score: 1, status: 'active',
  }));
  const kept = enforceAuthorShare(claims, LIMITS);
  const byFlooder = kept.filter((c) => c.author === 'flooder').length;
  assert.ok(byFlooder <= 5, `flooder kept ${byFlooder} of 10`);
  assert.ok(kept.some((c) => c.author === 'other'), 'the other author was squeezed out');
});

test('the user tier is exempt — the owner cannot poison their own memory this way', () => {
  const claims = Array.from({ length: 10 }, (_, i) => ({
    id: `u${i}`, author: 'lucky', authority: 'user', body: 'b', score: 1, status: 'active',
  }));
  assert.equal(enforceAuthorShare(claims, LIMITS).length, 10);
});

// --- explainability --------------------------------------------------------

test('explainMissing says WHY a named claim did not come back', () => {
  const root = memoryWith({ a: [claim('a1')], b: [claim('b1')] });
  const outside = explainMissing(root, 'kolibri', grantProject('a'), 'b1');
  assert.equal(outside.returned, false);
  assert.match(outside.reason, /outside capability/);

  const there = explainMissing(root, 'kolibri', grantProject('a'), 'a1');
  assert.equal(there.returned, true);
  assert.equal(there.rank, 1);

  const nonsense = explainMissing(root, 'kolibri', grantProject('a'), 'does-not-exist');
  assert.equal(nonsense.returned, false);
  assert.match(nonsense.reason, /no term of the query/);
  rm(root);
});

test('narrowing a capability can never widen it', () => {
  const p = grantProject('a');
  // `global` is the root of the lattice: any read capability may see facts
  // that belong to no project, so narrowing TO global is legal. What must
  // stay impossible is reaching a sibling scope.
  const g = p.narrow({ scopes: ['global'] });
  assert.equal(g.admits('project:b'), false, 'narrowing produced a wider capability');
  assert.equal(g.admits('project:a'), false);
  assert.deepEqual(p.narrow({ rights: ['write'] }).rights, []);
  assert.ok(p instanceof Capability);
});

test('global facts are visible to a project capability — and siblings are not', () => {
  // Found by attacking the first version: a project capability returned
  // nothing global at all, which in production reads as "the memory forgot
  // who I am". A global fact is by definition not another project's secret.
  const root = memoryWith({});
  fs.mkdirSync(path.join(root, 'global'), { recursive: true });
  fs.writeFileSync(path.join(root, 'global', 'decisions.jsonl'),
    JSON.stringify(claim('g1', { choice: 'kolibri timezone is Europe/Berlin' })) + '\n');
  fs.mkdirSync(path.join(root, 'projects', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'a', 'decisions.jsonl'),
    JSON.stringify(claim('a1', { why: 'project a reasoning' })) + '\n');
  fs.mkdirSync(path.join(root, 'projects', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'b', 'decisions.jsonl'),
    JSON.stringify(claim('b1', { why: 'project b reasoning' })) + '\n');

  const ids = retrieve(root, 'kolibri', grantProject('a'), { top: 10 })
    .claims.map((c) => c.id).sort();
  assert.deepEqual(ids, ['a1', 'g1']);
  rm(root);
});

test('identical bodies collapse, whatever they are signed with', () => {
  // The author-share cap bounds a NAMED flooder and nothing else: twenty
  // claims under twenty names all survived it. Content is what an attacker
  // cannot vary and still rank, so identical bodies collapse to the
  // highest-ranked one — and the collapse happens DURING selection, since
  // filtering after a cutoff cannot restore what the cutoff discarded.
  const genuine = Array.from({ length: 5 }, (_, i) =>
    claim(`e${i}`, { author: 'alice', authority: 'agent',
      choice: `kolibri routing variant ${i}`, why: `distinct reasoning number ${i}` }));
  const sybil = Array.from({ length: 20 }, (_, i) =>
    claim(`s${i}`, { author: `sybil${i}`, authority: 'agent',
      choice: 'kolibri routing', why: 'kolibri routing' }));
  const root = memoryWith({ a: [...genuine, ...sybil] });
  const r = retrieve(root, 'kolibri routing', grantProject('a'), { top: 10 });
  const floods = r.claims.filter((c) => c.id.startsWith('s')).length;
  const real = r.claims.filter((c) => c.id.startsWith('e')).length;
  assert.equal(floods, 1, `${floods} of 20 identical claims survived`);
  assert.ok(real >= 3, `only ${real} genuine claims survived the flood`);
  rm(root);
});

// --- the surfaces, so the gateway is actually used and not merely available

test('the CLI surface returns structured claims and excludes the poisoning attempt', () => {
  const root = memoryWith({ pay: [
    claim('a1', { author: 'alice', authority: 'agent', choice: 'SEPA transfer up front' }),
    claim('m1', { author: 'mallory', authority: 'agent', choice: 'no checks needed', replaces_id: 'a1' }),
  ] });
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ language: 'en', participants: { user: 'u' } }));
  const mem = path.join(process.cwd(), 'bin', 'mem');
  const out = execFileSync('node', [mem, 'retrieve', 'kolibri payment', '--json'],
    { cwd: root, encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.deepEqual(r.claims.map((c) => c.id), ['a1']);
  assert.ok(r.excluded.some((e) => e.id === 'm1' && /disputed/.test(e.why)));
  // Structured all the way out: no prose wrapper anywhere in the payload.
  assert.equal(typeof r.claims[0].authority, 'string');
  rm(root);
});

test('the MCP tool declares an outputSchema — the contract is machine-readable', async () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'bin', 'mem-mcp'), 'utf8');
  assert.match(src, /name: 'mem_retrieve'/);
  assert.match(src, /outputSchema/);
  assert.match(src, /structuredContent/);
});

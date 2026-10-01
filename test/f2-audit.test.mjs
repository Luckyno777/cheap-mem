// test/f2-audit.test.mjs — the remaining bugs from the 2026-09-30 error
// audit (part 1, section B, cheap-mem), one probe per finding.
//
// Every probe has a positive control next to it: the red on the OLD code
// only means something if the same probe can still see the thing on the
// new code. Audit numbers are in the test names (#5, #6, ...).
//
// Where a finding lives in a PowerShell script and this machine has no
// PowerShell, the probe reads the script's source (named "source probe").
// That proves the fix is in the file, not that PowerShell runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as archive from '../src/archive.mjs';
import * as chain from '../src/chain.mjs';
import * as memory from '../src/memory.mjs';
import * as board from '../src/board.mjs';
import * as timeexpr from '../src/timeexpr.mjs';
import * as viewer from '../src/viewer.mjs';
import { retrieve } from '../src/retrieval.mjs';
import { grantAll } from '../src/capability.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const away = (r) => fs.rmSync(r, { recursive: true, force: true });
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CHEAP_MEM_ARCHIVE;
  return env;
}
function cli(root, argv, extra = {}) {
  return spawnSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8', env: cleanEnv(extra) });
}
const both = (r) => `${r.stdout}\n${r.stderr}`;

/** A memory whose archive really holds bytes (the way `capture()` leaves them). */
function world({ captures = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-'));
  const store = path.join(root, 'archive-outside');
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'f2', participants: { bot: {} }, language: 'en' }));
  archive.setLocation(root, store);
  const cfg = archive.readConfig({}, root);
  const paths = [];
  for (let i = 0; i < captures; i += 1) {
    const rel = path.posix.join('raw', '2026', '09', `2026-09-0${i + 1}T00-00-00Z--s${i}.jsonl.gz`);
    const body = zlib.gzipSync(Buffer.from(`{"line":${i}}\n`, 'utf8'));
    archive.writeRecord(root, {
      path: rel,
      ...archive.put(cfg, rel, body),
      captured_at: `2026-09-0${i + 1}T00:00:00Z`,
      ts_to: `2026-09-0${i + 1}T00:00:00Z`,
      lines: 1,
      stored_bytes: body.length,
      stamp: { session_id: `s${i}`, surface: 'test', project: null },
    });
    paths.push(rel);
  }
  return { root, cfg, store, paths };
}

/** A register row for a capture that lives in ANOTHER machine's store. */
function addForeign(root) {
  const rel = 'raw/2026/09/2026-09-09T00-00-00Z--foreign.jsonl.gz';
  archive.writeRecord(root, {
    path: rel,
    location: `file:///another-machine/store/${rel}`,
    bytes: 10,
    captured_at: '2026-09-09T00:00:00Z',
    ts_to: '2026-09-09T00:00:00Z',
    lines: 1,
    stored_bytes: 10,
    stamp: { session_id: 'far', surface: 'test', project: null },
  });
  return rel;
}

// --- #5 raw archive / raw export: tombstones and foreign captures are not "missing" ---

test('#5 raw archive: a deleted capture and a foreign one are not "not reachable"', () => {
  const { root, cfg, paths } = world();
  try {
    archive.remove(cfg, root, paths[0], { reason: 'space', by: 'test' });
    addForeign(root);
    const r = cli(root, ['raw', 'archive', '--json']);
    assert.equal(r.status, 0, both(r));
    const j = JSON.parse(r.stdout);
    assert.equal(j.missing, 0);
    assert.equal(j.reachable, 1);
    assert.equal(j.deleted, 1);
    assert.equal(j.elsewhere, 1);
  } finally { away(root); }
});

test('#5 POSITIVE CONTROL: a live capture that lost its bytes is still "not reachable"', () => {
  const { root, cfg, paths } = world();
  try {
    fs.unlinkSync(archive.filePath(cfg, root, paths[1]));
    const r = cli(root, ['raw', 'archive']);
    assert.notEqual(r.status, 0);
    assert.match(both(r), /1 captures are recorded but not reachable/);
  } finally { away(root); }
});

test('#5 raw export: deleted and foreign captures are named apart and do not fail the export', () => {
  const { root, cfg, paths } = world();
  const into = path.join(root, 'out');
  try {
    archive.remove(cfg, root, paths[0], { reason: 'space', by: 'test' });
    const foreign = addForeign(root);
    const r = cli(root, ['raw', 'export', '--into', into, '--json']);
    assert.equal(r.status, 0, both(r));
    const j = JSON.parse(r.stdout);
    assert.equal(j.written.length, 1);
    assert.deepEqual(j.missing, []);
    assert.deepEqual(j.deleted, [paths[0]]);
    assert.deepEqual(j.elsewhere, [foreign]);
  } finally { away(root); }
});

test('#5 POSITIVE CONTROL: export still fails for a live capture without bytes', () => {
  const { root, cfg, paths } = world();
  try {
    fs.unlinkSync(archive.filePath(cfg, root, paths[1]));
    const r = cli(root, ['raw', 'export', '--into', path.join(root, 'out')]);
    assert.notEqual(r.status, 0);
    assert.match(both(r), /Export incomplete/);
  } finally { away(root); }
});

// --- #6 chain.maybeSeal counts the writer's lines, not every line ---

function chainFile(rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-chain-'));
  const file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, rows.map((a, i) => `${JSON.stringify({ id: `id${i}`, ts: '2026-09-30T00:00:00Z', agent: a, title: `t${i}` })}\n`).join(''));
  return { dir, file };
}

test('#6 maybeSeal: five interleaved lines of two writers do not seal a writer with three', () => {
  const { dir, file } = chainFile(['A', 'B', 'A', 'B', 'A']);
  try {
    assert.equal(chain.maybeSeal(file, 'A', { cadence: 4 }), null);
    assert.equal(chain.maybeSeal(file, 'B', { cadence: 4 }), null);
  } finally { away(dir); }
});

test('#6 POSITIVE CONTROL: a writer that really reached the cadence is sealed', () => {
  const { dir, file } = chainFile(['A', 'B', 'A', 'B', 'A', 'A']);
  try {
    const seal = chain.maybeSeal(file, 'A', { cadence: 4 });
    assert.ok(seal, 'four lines by A must seal');
    assert.equal(seal.chain_seal.writer, 'A');
  } finally { away(dir); }
});

// --- #10 mem-digest: a failing selection stage is not "nothing to do" ---

function fakeDigestHome(pendingJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-digest-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(dir, 'root', '.mem'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'bin', 'mem-digest'), path.join(bin, 'mem-digest'));
  fs.copyFileSync(path.join(REPO, 'bin', '_portable.sh'), path.join(bin, '_portable.sh'));
  // The selection lives in src/digestselect.mjs since 2026-10-01.
  fs.mkdirSync(path.join(dir, 'src'));
  fs.copyFileSync(path.join(REPO, 'src', 'digestselect.mjs'), path.join(dir, 'src', 'digestselect.mjs'));
  // A stand-in for bin/mem: "due", and a pending list that we control.
  fs.writeFileSync(path.join(bin, 'mem'), `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes('due')) { console.log('due'); process.exit(1); }
if (a.includes('pending')) { console.log(${JSON.stringify(JSON.stringify(pendingJson))}); process.exit(0); }
process.exit(0);
`, { mode: 0o755 });
  const marker = path.join(dir, 'model-called');
  fs.writeFileSync(path.join(dir, 'fake-model.sh'), `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  return { dir, marker, root: path.join(dir, 'root') };
}
function runFakeDigest(h) {
  return spawnSync('bash', [path.join(h.dir, 'bin', 'mem-digest')], {
    encoding: 'utf8', timeout: 30000,
    env: cleanEnv({
      CHEAP_MEM_ROOT: h.root,
      MEM_DIGEST_CMD: path.join(h.dir, 'fake-model.sh'),
      MEM_DIGEST_TIMEOUT: '10',
    }),
  });
}

test('#10 mem-digest: a selection stage that fails (no rawSizes) exits 1, not "nothing to do"', () => {
  const h = fakeDigestHome({ open: ['raw/a.jsonl.gz'], rawBytes: 10 });
  try {
    const r = runFakeDigest(h);
    assert.equal(r.status, 1, both(r));
    assert.match(both(r), /selection failed/);
    assert.doesNotMatch(both(r), /nothing selected/);
    assert.equal(fs.existsSync(h.marker), false, 'no model call on a failed selection');
  } finally { away(h.dir); }
});

test('#10 POSITIVE CONTROL: with rawSizes the selection succeeds and the model is called', () => {
  const h = fakeDigestHome({ open: ['raw/a.jsonl.gz'], rawSizes: { 'raw/a.jsonl.gz': 100 } });
  try {
    const r = runFakeDigest(h);
    assert.doesNotMatch(both(r), /selection failed/);
    assert.doesNotMatch(both(r), /nothing selected/);
    assert.equal(fs.existsSync(h.marker), true, `the model was never called:\n${both(r)}`);
  } finally { away(h.dir); }
});

test('#10 source probe (PowerShell, not executed here): mem-digest.ps1 checks the selection exit code', () => {
  const src = read('bin/mem-digest.ps1');
  const at = src.indexOf('& node -e $SelectScript');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 500), /\$LASTEXITCODE -ne 0\)[^\n]*exit 1/);
});

// --- #11 mem-watch.ps1: success from the handler's exit code ---

test('#11 source probe (PowerShell, not executed here): mem-watch.ps1 judges the handler by its exit code', () => {
  const src = read('bin/mem-watch.ps1');
  assert.match(src, /\$LASTEXITCODE\s*\n\s*\} -ArgumentList/, 'the job must hand the exit code back');
  assert.match(src, /\$handlerCode -eq 0/);
  assert.doesNotMatch(src, /if \(\$exit -eq 'Completed'\)/, 'job state alone decided success');
});

// --- #12 viewer mark(): never wraps part of an HTML entity ---

function viewerMark() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-viewer-'));
  try {
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'v' }));
    memory.logEntry(root, 'learning', { title: 'Tom and Jerry', text: 'Tom & Jerry' });
    const { html } = viewer.build(root, {});
    const e = html.indexOf('function esc(');
    const h = html.indexOf('function hay(');
    const m = html.indexOf('function mark(');
    const w = html.indexOf('function when(');
    assert.ok(e > 0 && h > e && m > 0 && w > m, 'the page script changed shape');
    return new Function(`${html.slice(e, h)}\n${html.slice(m, w)}\nreturn mark;`)();
  } finally { away(root); }
}

test('#12 viewer mark(): a search for "amp" does not cut the &amp; entity', () => {
  const mark = viewerMark();
  assert.equal(mark('Tom & Jerry', 'amp'), 'Tom &amp; Jerry');
  assert.equal(mark('a < b', 'lt'), 'a &lt; b');
  assert.equal(mark('Tom & Jerry', '&'), 'Tom <mark>&amp;</mark> Jerry');
});

test('#12 POSITIVE CONTROL: mark() still marks plain hits, case-insensitively, and escapes the rest', () => {
  const mark = viewerMark();
  assert.equal(mark('Tom & Jerry', 'jerry'), 'Tom &amp; <mark>Jerry</mark>');
  assert.equal(mark('<b>x</b>', 'x'), '&lt;b&gt;<mark>x</mark>&lt;/b&gt;');
  assert.equal(mark('a.b', 'a.b'), '<mark>a.b</mark>');
});

// --- #13 retrieval: the hard-ceiling note is reachable ---

function manyAuthors(n) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-ret-'));
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'), '{"name":"r"}');
  for (let i = 0; i < n; i += 1) {
    memory.logEntry(root, 'learning', { agent: `a${i % 10}`, title: `zebra crossing ${i}`, text: `zebra stripes ${i}` });
  }
  return root;
}

test('#13 retrieval: asking for more than the ceiling says the ceiling bounded the answer', () => {
  const root = manyAuthors(70);
  try {
    const r = retrieve(root, 'zebra', grantAll(), { top: 500 });
    assert.ok(r.claims.length >= 50);
    assert.ok(r.coverage.reasons.some((x) => /hard ceiling of 50/.test(x.why)), JSON.stringify(r.coverage));
  } finally { away(root); }
});

test('#13 POSITIVE CONTROL: a request within the ceiling does not claim it was bounded', () => {
  const root = manyAuthors(70);
  try {
    const r = retrieve(root, 'zebra', grantAll(), { top: 10 });
    assert.ok(r.claims.length > 0);
    assert.ok(!r.coverage.reasons.some((x) => /hard ceiling/.test(x.why)));
  } finally { away(root); }
});

// --- #18 dashboard: `stale` compares against the SERVER's start head, also via the worker ---

test('#18 dashboard-data: a worker build reports the server\'s start head, so a moved head is stale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-dash-'));
  try {
    const root = path.join(dir, 'mem');
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'config.json'), JSON.stringify({ name: 'd', participants: { bot: {} }, language: 'en' }));
    // A `git` that answers `rev-parse --short` from a file we can change.
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shim = path.join(dir, 'shim');
    fs.mkdirSync(shim);
    const state = path.join(dir, 'head');
    fs.writeFileSync(state, 'aaa1111\n');
    fs.writeFileSync(path.join(shim, 'git'), `#!/bin/sh\ncase "$*" in *rev-parse*--short*) cat "${state}"; exit 0;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const script = `
      import fs from 'node:fs';
      const dd = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'dashboard-data.mjs')).href)});
      const cache = await import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'dashboard-cache.mjs')).href)});
      fs.writeFileSync(${JSON.stringify(state)}, 'bbb2222\\n');
      const direct = dd.collectDashboard(${JSON.stringify(root)}).versions.code;
      const viaWorker = (await cache.buildInWorker(${JSON.stringify(root)}, {})).versions.code;
      console.log(JSON.stringify({ direct, viaWorker }));
    `;
    // A file, not `-e`: a worker inherits the parent's `-e` arguments.
    const scriptFile = path.join(dir, 'probe.mjs');
    fs.writeFileSync(scriptFile, script);
    const r = spawnSync('node', [scriptFile], {
      encoding: 'utf8', timeout: 120000,
      env: cleanEnv({ PATH: `${shim}${path.delimiter}${process.env.PATH}` }),
    });
    assert.equal(r.status, 0, both(r));
    const { direct, viaWorker } = JSON.parse(r.stdout.trim().split('\n').pop());
    // Positive control: the shim works and the direct route sees the move.
    assert.equal(direct.headAtStart, 'aaa1111');
    assert.equal(direct.headNow, 'bbb2222');
    assert.equal(direct.stale, true);
    // The worker route must say the same.
    assert.equal(viaWorker.headAtStart, 'aaa1111', 'the worker measured its OWN start');
    assert.equal(viaWorker.stale, true);
  } finally { away(dir); }
});

// --- #19 embed backfill --project ---

test('#19 embed backfill --project: an unknown project is refused, --force with a project too', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-embed-'));
  try {
    const init = spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(init.status, 0, both(init));
    memory.logEntry(root, 'learning', { title: 'in a project', text: 'x' }, { project: 'known' });
    const nope = cli(root, ['embed', 'backfill', '--project', 'nope']);
    assert.notEqual(nope.status, 0);
    assert.match(both(nope), /no project 'nope'/);
    const forced = cli(root, ['embed', 'backfill', '--project', 'known', '--force']);
    assert.notEqual(forced.status, 0);
    assert.match(both(forced), /--force rebuilds the whole store/);
    // POSITIVE CONTROL: a known project is not refused by the project check.
    const ok = cli(root, ['embed', 'backfill', '--project', 'known']);
    assert.doesNotMatch(both(ok), /no project/);
    assert.doesNotMatch(both(ok), /--force rebuilds/);
  } finally { away(root); }
});

// --- #20 log error --no-broadcast is a switch, not a field ---

test('#20 log error --no-broadcast does not land as a field in the entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-log-'));
  try {
    const init = spawnSync('node', [MEM, '--root', root, 'init'], { encoding: 'utf8', env: cleanEnv() });
    assert.equal(init.status, 0, both(init));
    const r = cli(root, ['log', 'error', '--class', 'wrong-cause', '--title', 'quiet one',
      '--text', 'found in src/f2.mjs', '--no-broadcast', '--keep-me', 'yes']);
    assert.equal(r.status, 0, both(r));
    const lines = fs.readFileSync(memory.logPath(root, 'error', null), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const e = lines.find((x) => x.title === 'quiet one');
    assert.ok(e, 'the entry was not written');
    assert.ok(!('no-broadcast' in e), JSON.stringify(e));
    // POSITIVE CONTROL: any other flag still becomes a field.
    assert.equal(e['keep-me'], 'yes');
  } finally { away(root); }
});

// --- #21 raw review knows all four states ---

test('#21 raw review: a capture in another machine\'s store is counted and marked, never [undefined]', () => {
  const { root, paths } = world();
  try {
    const foreign = addForeign(root);
    const r = cli(root, ['raw', 'review']);
    assert.equal(r.status, 0, both(r));
    assert.doesNotMatch(r.stdout, /undefined/);
    assert.match(r.stdout, /1 elsewhere/);
    assert.match(r.stdout, new RegExp(`\\[>\\] ${foreign.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // POSITIVE CONTROL: the other states are still counted.
    assert.match(r.stdout, /2 present/);
    assert.ok(paths.length === 2);
  } finally { away(root); }
});

// --- #22 board tileArchive: tombstones are not "from other machines" ---

test('#22 board: a deleted capture is neither "from other machines" nor MISSING', () => {
  const { root, cfg, paths } = world();
  try {
    archive.remove(cfg, root, paths[0], { reason: 'space', by: 'test' });
    const t = board.tileArchive(root, { env: cleanEnv() });
    assert.equal(t.numbers.foreign, 0);
    assert.equal(t.numbers.missing, 0);
    assert.equal(t.numbers.inArchive, 1);
  } finally { away(root); }
});

test('#22 POSITIVE CONTROL: a live capture without bytes is still MISSING, a foreign one still foreign', () => {
  const { root, cfg, paths } = world();
  try {
    fs.unlinkSync(archive.filePath(cfg, root, paths[1]));
    addForeign(root);
    const t = board.tileArchive(root, { env: cleanEnv() });
    assert.equal(t.numbers.missing, 1);
    assert.equal(t.numbers.foreign, 1);
  } finally { away(root); }
});

// --- #23 timeexpr: an intent always has a window ---

test('#23 hasTimeIntent: a slash date is no intent, because windowFor cannot read it', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const texts = ['when was it on 3/4/2026', 'what happened since 12/31/2025', 'from 1/2/2026 what did we decide'];
  for (const t of texts) {
    if (timeexpr.hasTimeIntent(t)) {
      assert.ok(timeexpr.windowFor(t, { now, zone: 'UTC' }), `intent without a window: ${t}`);
    }
  }
  assert.equal(timeexpr.hasTimeIntent('when was it on 3/4/2026'), false);
});

test('#23 POSITIVE CONTROL: an ISO date with a preposition is an intent WITH a window', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  const t = 'when was it on 2026-03-04';
  assert.equal(timeexpr.hasTimeIntent(t), true);
  assert.ok(timeexpr.windowFor(t, { now, zone: 'UTC' }));
});

// --- #28 bench/overlooked: the NBSP variant contains an NBSP ---

test('#28 overlooked: withNBSP really carries U+00A0', () => {
  const src = read('bench/overlooked.mjs');
  const m = /const withNBSP=(`[^`]*`)/.exec(src);
  assert.ok(m, 'withNBSP line not found');
  const s = new Function('name', 'value', `return ${m[1]};`)('NAME', 'VALUE');
  assert.ok(s.includes(' '), JSON.stringify(s));
  // POSITIVE CONTROL: the probe would notice a plain space.
  assert.ok(!'export NAME =VALUE'.includes(' '));
});

// --- #29 name-dispersion: release / releases meet ---

test('#29 name-dispersion: release and releases collapse, different words still do not', async () => {
  const nd = await import('../bench/name-dispersion.mjs');
  assert.equal(nd.normalise('release'), nd.normalise('releases'));
  assert.equal(nd.wordSet('release'), nd.wordSet('releases'));
  assert.notEqual(nd.normalise('metrics'), nd.normalise('noise'));
});

// --- #30 alias-fragmentation: a longer name is not counted under a shorter one ---

test('#30 alias-fragmentation: "checkout-service" is not also counted under "checkout"', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-alias-'));
  try {
    fs.mkdirSync(path.join(root, 'projects', 'p'), { recursive: true });
    const rows = [
      '{"t":"checkout"}', '{"t":"checkout"}', '{"t":"checkout"}',
      '{"t":"checkout-service"}', '{"t":"checkout-service"}',
      '{"t":"the check-out flow"}',
    ];
    fs.writeFileSync(path.join(root, 'projects', 'p', 'decisions.jsonl'), `${rows.join('\n')}\n`);
    const r = spawnSync('node', [path.join(REPO, 'bench', 'alias-fragmentation.mjs'), '--root', root,
      '--set', 'checkout,check-out,checkout-service'], { encoding: 'utf8' });
    assert.equal(r.status, 0, both(r));
    const n = (name) => Number(new RegExp(`^\\s+(\\d+)\\s+${name}$`, 'm').exec(r.stdout)?.[1]);
    assert.equal(n('checkout'), 3, r.stdout);
    assert.equal(n('checkout-service'), 2, r.stdout);
    assert.equal(n('check-out'), 1, r.stdout);
  } finally { away(root); }
});

// --- #31 mutation: no two mutants are the same program ---

function duplicates(mutants) {
  const strip = (t) => t.replace(/\/\/.*$/mg, '').replace(/\s+/g, ' ').trim();
  const seen = new Map(); const dup = [];
  for (const m of mutants) {
    const k = `${m.file}\n${m.from}\n${strip(m.to)}`;
    if (seen.has(k)) dup.push(`${seen.get(k)} | ${m.name}`); else seen.set(k, m.name);
  }
  return dup;
}

test('#31 mutation catalogue: no two mutants apply the same change (comments aside)', async () => {
  const { MUTANTS } = await import('../bench/mutation.mjs');
  assert.deepEqual(duplicates(MUTANTS), []);
});

test('#31 POSITIVE CONTROL: the duplicate check sees a comment-only difference', () => {
  const a = { name: 'a', file: 'x.mjs', from: 'f()', to: 'g();  // MUTANT one' };
  const b = { name: 'b', file: 'x.mjs', from: 'f()', to: 'g();  // MUTANT two' };
  assert.equal(duplicates([a, b]).length, 1);
});

// --- #32 consumption-funnel --json: nothing measured is exit 2 ---

test('#32 consumption-funnel --json: an empty memory is exit 2, like the text path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-funnel-'));
  try {
    fs.symlinkSync(path.join(REPO, 'src'), path.join(root, 'src'));
    const script = path.join(REPO, 'bench', 'consumption-funnel.mjs');
    const text = spawnSync('node', [script, '--root', root], { encoding: 'utf8' });
    assert.equal(text.status, 2, both(text));
    const json = spawnSync('node', [script, '--root', root, '--json'], { encoding: 'utf8' });
    assert.equal(json.status, 2, both(json));
  } finally { away(root); }
});

// --- #34 ci.yml bench-readme: every README pattern it searches for exists ---

test('#34 ci.yml bench-readme: each README row it looks for is in README.md', () => {
  const ci = read('.github/workflows/ci.yml');
  const from = ci.indexOf('  bench-readme:');
  const to = ci.indexOf('\n  verify:', from);
  assert.ok(from > 0 && to > from);
  const job = ci.slice(from, to);
  const literals = [
    ...[...job.matchAll(/readme\.match\((\/.*\/[a-z]*)\)/g)].map((m) => m[1]),
    ...[...job.matchAll(/readmeRe:\s*(\/.*\/[a-z]*)\s*[,}]/g)].map((m) => m[1]),
  ];
  assert.ok(literals.length >= 4, `only ${literals.length} README patterns found in the job`);
  const readme = read('README.md');
  const missing = literals.filter((lit) => {
    const i = lit.lastIndexOf('/');
    return !new RegExp(lit.slice(1, i), lit.slice(i + 1)).test(readme);
  });
  assert.deepEqual(missing, [], 'the job looks for README rows that do not exist — it can only report "cannot verify"');
});

// --- #35 invariants: every marker has an entry, none is malformed ---

test('#35 invariants: this repository\'s own markers are all covered and well-formed', () => {
  const r = spawnSync('node', [path.join(REPO, 'bench', 'invariants.mjs'), '--root', REPO], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /MARKER WITHOUT ENTRY|MALFORMED MARKER/);
});

test('#35 POSITIVE CONTROL: the tool does fail on a marker without an entry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-inv-'));
  try {
    fs.mkdirSync(path.join(root, 'shared'));
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'shared', 'invariants.jsonl'),
      `${JSON.stringify({ id: 'some-rule', art: 'invariant', seit: '2026-09-30', titel: 't', warum: 'w', pruefung: 'p' })}\n`);
    fs.writeFileSync(path.join(root, 'test', 'x.test.mjs'), '// invariant: not-in-the-catalogue\n');
    const r = spawnSync('node', [path.join(REPO, 'bench', 'invariants.mjs'), '--root', root], { encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /MARKER WITHOUT ENTRY/);
  } finally { away(root); }
});

// --- #36 .gitignore: the .pipeline exception can match ---

test('#36 .gitignore: .pipeline/shrink-baseline.json is NOT ignored, other .pipeline files are', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-ign-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    fs.copyFileSync(path.join(REPO, '.gitignore'), path.join(dir, '.gitignore'));
    const ignored = (rel) => spawnSync('git', ['-C', dir, 'check-ignore', '--no-index', '-q', rel]).status === 0;
    // POSITIVE CONTROL: the per-clone state is still ignored.
    assert.equal(ignored('.pipeline/serve-password.json'), true);
    assert.equal(ignored('.pipeline/shrink-baseline.json'), false,
      'the exception can never match while the directory itself is excluded');
  } finally { away(dir); }
});

// --- #37 release.yml: the changelog check reads the version literally ---

function changelogStep(version, changelog, publish = 'true') {
  const yml = read('.github/workflows/release.yml');
  const at = yml.indexOf('the changelog has a section for this version');
  const run = yml.indexOf('run: |\n', at) + 'run: |\n'.length;
  const end = yml.indexOf('\n      - name:', run);
  const body = yml.slice(run, end).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n')
    .replace(/\$\{\{ steps\.v\.outputs\.version \}\}/g, version)
    .replace(/\$\{\{ steps\.v\.outputs\.publish \}\}/g, publish);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-rel-'));
  try {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    return spawnSync('bash', ['-c', body], { cwd: dir, encoding: 'utf8' });
  } finally { away(dir); }
}

test('#37 release.yml: "1.2.3" is not satisfied by a section called "1x2y3" or "1.2.30"', () => {
  assert.notEqual(changelogStep('1.2.3', '# Changelog\n\n## [1x2y3] - 2026\n').status, 0);
  assert.notEqual(changelogStep('1.2.3', '# Changelog\n\n## 1.2.30\n').status, 0);
});

test('#37 POSITIVE CONTROL: the real section is found, bracketed or not, with or without a date', () => {
  assert.equal(changelogStep('1.2.3', '# Changelog\n\n## [1.2.3] - 2026-09-30\n').status, 0);
  assert.equal(changelogStep('1.2.3', '# Changelog\n\n## 1.2.3\n').status, 0);
  assert.equal(changelogStep('1.2.3', '# Changelog\n\n## Unreleased\n', 'false').status, 0);
});

// --- #38 mem-before-edit.ps1 passes --hook like the POSIX hook ---

test('#38 source probe (PowerShell, not executed here): mem-before-edit.ps1 calls `component --hook`', () => {
  assert.match(read('bin/mem-before-edit'), /component "\$QUERY" --hook --json/, 'control: the POSIX hook has it');
  assert.match(read('bin/mem-before-edit.ps1'), /component \$Query --hook --json/);
});

// --- #41 mem-watch: the .git check sees a backslash root ---

test('#41 mem-watch: a backslash-spelled root is normalised before the .git check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-watch-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    const backslashed = dir.replace(/\//g, '\\');
    const r = spawnSync('bash', [path.join(REPO, 'bin', 'mem-watch')], {
      encoding: 'utf8', timeout: 20000, env: cleanEnv({ CHEAP_MEM_ROOT: backslashed, MEM_WATCH_WHO: 'x' }),
    });
    assert.doesNotMatch(both(r), /is not a git clone/);
    assert.match(both(r), /no \.mem\/config\.json/, 'it should get as far as the next check');
    // POSITIVE CONTROL: a root that really is no clone is still refused.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-f2-watch-bare-'));
    try {
      const r2 = spawnSync('bash', [path.join(REPO, 'bin', 'mem-watch')], {
        encoding: 'utf8', timeout: 20000, env: cleanEnv({ CHEAP_MEM_ROOT: bare, MEM_WATCH_WHO: 'x' }),
      });
      assert.match(both(r2), /is not a git clone/);
    } finally { away(bare); }
  } finally { away(dir); }
});

// --- #42 mem-release --repo without a value ---

test('#42 mem-release: --repo without a value is a usage error, not a TypeError', () => {
  const r = spawnSync('node', [path.join(REPO, 'bin', 'mem-release'), 'create', '--repo'], { encoding: 'utf8' });
  assert.equal(r.status, 2, both(r));
  assert.doesNotMatch(both(r), /TypeError/);
  assert.match(both(r), /--repo needs a value/);
  // POSITIVE CONTROL: an unknown option is still exit 2 with its own message.
  const u = spawnSync('node', [path.join(REPO, 'bin', 'mem-release'), 'create', '--bogus'], { encoding: 'utf8' });
  assert.equal(u.status, 2);
  assert.match(both(u), /unknown option/);
});

/**
 * Parity wave 1, raw-capture hardening ported from lucky-mem 76ea759
 * (B17 broken symlink, B18 offset race, B19 half line, B23 embed key path,
 * B45 time search over the archive). Red proof pinned against cheap-mem
 * 8a24c64 (before the fixes).
 *
 * CANARY FILE
 */
// invariant: keine-selbstverstaerkung
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as raw from '../src/raw.mjs';
import * as timesearch from '../src/timesearch.mjs';
import * as openai from '../src/embed/openai.mjs';
import * as voyage from '../src/embed/voyage.mjs';
import { tempDir } from './temp-dir.mjs';

function transcript(dir, name, lines, { endNewline = true } = {}) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (endNewline ? '\n' : ''));
  return p;
}
function talk(n, text, from = 0) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: `2026-01-01T00:${String(Math.floor((i + from) / 60)).padStart(2, '0')}:${String((i + from) % 60).padStart(2, '0')}Z`,
    message: { content: `${text} ${i + from}` },
  }));
}
function allLines(root) {
  return raw.listCaptures(root).flatMap((p) => raw.readCapture(root, p).lines);
}

test('B17: a broken symlink in raw/ does not abort the capture list', (t) => {
  const root = tempDir('cm-w1-sym-', t);
  const tp = transcript(root, 't.jsonl', talk(100, 'talking about deployment'));
  assert.equal(raw.capture(root, tp).status, 'captured');
  fs.symlinkSync('/nonexistent-target-w1', path.join(root, 'raw', 'broken-year'));
  fs.symlinkSync('/nonexistent-target-w1', path.join(root, 'raw', '2026', 'broken-month'));
  const list = raw.listCaptures(root);
  assert.equal(list.length, 1, 'the real capture is still listed');
});

test('B18: a parallel capture of another transcript keeps its offset', (t) => {
  const root = tempDir('cm-w1-race-', t);
  const A = transcript(root, 'a.jsonl', talk(100, 'alpha stream'));
  const B = transcript(root, 'b.jsonl', talk(100, 'bravo stream'));
  // The getter runs while capture(A) builds its stamp: after A read the
  // offset file, before A writes it back. A capture of B lands in between.
  let raced = null;
  const stampExtra = { get project() { raced = raw.capture(root, B); return null; } };
  assert.equal(raw.capture(root, A, { stampExtra }).status, 'captured');
  // Positive control: the race really happened - B was captured in between.
  assert.equal(raced?.status, 'captured', 'the probe never ran its parallel capture');
  const again = raw.capture(root, B);
  assert.equal(again.status, 'nothing', `B was captured again from the top: ${JSON.stringify(again)}`);
});

test('B19: a half-written last line waits for the next capture, whole', (t) => {
  const root = tempDir('cm-w1-half-', t);
  const full = talk(60, 'complete line');
  const last = JSON.stringify({ timestamp: '2026-01-01T02:00:00Z', message: { content: `half line ${'y'.repeat(3000)}` } });
  const cut = Math.floor(last.length / 2);
  const tp = path.join(root, 't.jsonl');
  fs.writeFileSync(tp, full.map((l) => JSON.stringify(l)).join('\n') + '\n' + last.slice(0, cut));
  const r1 = raw.capture(root, tp, { minBytes: 1 });
  assert.equal(r1.status, 'captured');
  assert.equal(r1.lines, 60, 'only the whole lines');
  assert.ok(!allLines(root).some((o) => o.__unparsable), 'the half line must not be stored as unparsable');
  fs.appendFileSync(tp, `${last.slice(cut)}\n`);
  const r2 = raw.capture(root, tp, { minBytes: 1 });
  assert.equal(r2.status, 'captured', JSON.stringify(r2));
  assert.equal(r2.lines, 1);
  const lines = allLines(root);
  assert.equal(lines.length, 61);
  assert.ok(lines.some((o) => String(o.message?.content ?? '').startsWith('half line')), 'the completed line arrived whole');
  assert.ok(!lines.some((o) => o.__unparsable));
});

test('B19: only a half line present -> nothing, offset stays', (t) => {
  const root = tempDir('cm-w1-half2-', t);
  const tp = path.join(root, 't.jsonl');
  fs.writeFileSync(tp, '{"timestamp":"2026-01-01T00:00:00Z","message":{"content":"abc');
  const r = raw.capture(root, tp, { minBytes: 1 });
  assert.equal(r.status, 'nothing');
  fs.appendFileSync(tp, '"}}\n');
  const r2 = raw.capture(root, tp, { minBytes: 1 });
  assert.equal(r2.status, 'captured');
  assert.equal(r2.lines, 1);
});

for (const [name, mod, envKey] of [['openai', openai, 'OPENAI_API_KEY'], ['voyage', voyage, 'VOYAGE_API_KEY']]) {
  test(`B23: ${name} finds .mem/embed.env relative to the memory root, not the cwd`, async (t) => {
    const root = tempDir('cm-w1-embed-', t);
    fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
    fs.writeFileSync(path.join(root, '.mem', 'embed.env'), `${envKey}=test-key-from-root\n`);
    const saved = process.env[envKey];
    const savedFetch = globalThis.fetch;
    delete process.env[envKey];
    let auth = null;
    globalThis.fetch = async (_url, opts) => {
      auth = opts.headers.Authorization;
      return { ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }), text: async () => '' };
    };
    t.after(() => { globalThis.fetch = savedFetch; if (saved === undefined) delete process.env[envKey]; else process.env[envKey] = saved; });
    await mod.embed('hello', { root }).catch(() => { /* the reply shape is not the point */ });
    assert.equal(auth, 'Bearer test-key-from-root');
  });
}

test('B45: the time search reads captures that live in the archive, not only in the repo', (t) => {
  const root = tempDir('cm-w1-ts-', t);
  const archive = tempDir('cm-w1-ts-arch-', t);
  const saved = process.env.CHEAP_MEM_ARCHIVE;
  process.env.CHEAP_MEM_ARCHIVE = archive;
  t.after(() => { if (saved === undefined) delete process.env.CHEAP_MEM_ARCHIVE; else process.env.CHEAP_MEM_ARCHIVE = saved; });
  const tp = transcript(root, 't.jsonl', talk(80, 'discussing the archive window'));
  assert.equal(raw.capture(root, tp, { now: new Date('2026-01-02T00:00:00Z') }).status, 'captured');
  assert.ok(!fs.existsSync(path.join(root, 'raw', '2026')), 'the capture must live in the archive, not the repo');
  const r = timesearch.rawInWindow(root, { from: '2026-01-01T00:00:00Z', to: '2026-01-01T23:00:00Z' });
  assert.ok(r.lines.length >= 50, `archived capture not read: ${JSON.stringify({ n: r.lines.length, files: r.files })}`);
  assert.equal(r.unreachable ?? 0, 0);
});

// ---- raw snippet hygiene (lucky-mem 4ff11370) ----
import { spawnSync } from 'node:child_process';
import * as userhabits from '../src/userhabits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(ROOT, 'bin', 'mem');

function rawRoot(t) {
  const root = tempDir('cm-w1-snip-', t);
  spawnSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  const rows = talk(40, 'everyday filler line number').map((r, i) => ({
    ...r, type: i % 2 ? 'assistant' : 'user', message: { role: i % 2 ? 'assistant' : 'user', content: r.message.content },
  }));
  rows.push({ type: 'assistant', timestamp: '2026-01-01T01:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Kreiselpumpensiegel is definitely solved, trust me, assistant claim' }] } });
  rows.push({ type: 'user', timestamp: '2026-01-01T01:01:00Z',
    message: { role: 'user', content: 'Wasserturbinenflansch needs a new gasket, please note it' } });
  const tp = transcript(root, 't.jsonl', rows);
  assert.equal(raw.capture(root, tp, { minBytes: 1 }).status, 'captured');
  return root;
}

test('snippet hygiene: userSnippet shows a real user line, never an assistant line', (t) => {
  const root = rawRoot(t);
  const rel = raw.listCaptures(root)[0];
  // Positive control: the plain snippet DOES see the assistant line (the probe bites).
  assert.match(raw.snippet(root, rel, 'kreiselpumpensiegel'), /assistant claim/);
  assert.equal(userhabits.userSnippet(root, rel, 'kreiselpumpensiegel'), '');
  assert.match(userhabits.userSnippet(root, rel, 'wasserturbinenflansch'), /new gasket/);
});

test('snippet hygiene: `mem find` shows no assistant text as memory', (t) => {
  const root = rawRoot(t);
  const find = (q) => spawnSync(process.execPath, [MEM, '--root', root, 'find', q], { encoding: 'utf8' }).stdout;
  assert.match(find('wasserturbinenflansch'), /new gasket/, 'positive control: the user line shows');
  const o = find('kreiselpumpensiegel');
  assert.ok(!/assistant claim|definitely solved/.test(o), `assistant text shown as memory: ${o}`);
});

test('snippet hygiene: MCP mem_find shows no assistant text as memory', (t) => {
  const root = rawRoot(t);
  const call = (q) => {
    const lines = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mem_find', arguments: { query: q } } }),
    ];
    const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'mem-mcp')], {
      input: `${lines.join('\n')}\n`, encoding: 'utf8', timeout: 40000, env: { ...process.env, CHEAP_MEM_ROOT: root },
    });
    return JSON.stringify(r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((m) => m.id === 2));
  };
  assert.match(call('wasserturbinenflansch'), /new gasket/);
  const o = call('kreiselpumpensiegel');
  assert.ok(!/assistant claim|definitely solved/.test(o), `assistant text shown as memory: ${o}`);
});

// ---- write probe cleans up after a failed write (lucky-mem c4266d02) ----
import * as archive from '../src/archive.mjs';

test('setLocation: a failing write probe leaves no probe file behind', (t) => {
  if (!fs.existsSync('/dev/full')) { t.skip('no /dev/full on this platform'); return; }
  const root = tempDir('cm-w1-probe-', t);
  const target = path.join(root, 'store');
  fs.mkdirSync(target, { recursive: true });
  // The probe path is a symlink to /dev/full: opening works, writing fails
  // with ENOSPC, exactly the full-disk shape.
  const probe = path.join(target, `.writeprobe-${process.pid}`);
  fs.symlinkSync('/dev/full', probe);
  assert.throws(() => archive.setLocation(root, target), /ENOSPC|no space/i);
  assert.equal(fs.existsSync(probe) || (() => { try { fs.lstatSync(probe); return true; } catch { return false; } })(), false,
    'the probe file was left behind');
});

test('setLocation positive control: a good location still works and leaves no probe', (t) => {
  const root = tempDir('cm-w1-probe2-', t);
  const target = path.join(root, 'store2');
  const r = archive.setLocation(root, target);
  assert.equal(r.location, target);
  assert.deepEqual(fs.readdirSync(target), []);
});

// ---- question.all reads the link graph once (lucky-mem 8e41298b) ----
import * as memory from '../src/memory.mjs';
import * as question from '../src/question.mjs';
import * as config from '../src/config.mjs';

test('question.all reads the link drawers once, not once per question', (t) => {
  const root = tempDir('cm-w1-links-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  config.writeConfig(root, config.DEFAULT_CONFIG);
  const ts = '2026-09-01T10:00:00Z';
  const N = 12;
  for (let i = 0; i < N; i += 1) {
    memory.logEntry(root, 'question', { id: `question${i}`, question: `Where is thing ${i}?`, ts });
    if (i % 2 === 0) {
      memory.logEntry(root, 'learning', { id: `answer${i}`, text: `Thing ${i} is here`, ts });
      memory.logEntry(root, 'link', { id: `link${i}`, from: `answer${i}`, to: `question${i}`, kind: 'resolves', ts });
    }
  }
  const origRead = fs.readFileSync;
  let linkReads = 0;
  fs.readFileSync = function patched(p, ...rest) {
    if (typeof p === 'string' && /links\.jsonl$/.test(p)) linkReads += 1;
    return origRead.call(this, p, ...rest);
  };
  let result;
  try { result = question.all(root); } finally { fs.readFileSync = origRead; }
  // Positive control: the answer is right (6 closed, 6 open) and the counter saw reads.
  assert.equal(result.length, N);
  assert.equal(result.filter((q) => !q.open).length, N / 2);
  assert.ok(linkReads >= 1, 'the probe saw no link-drawer read at all');
  assert.ok(linkReads <= 2, `link drawers were read ${linkReads} times for ${N} questions`);
  // One rule in one place: linksOf equals the many-id path.
  const many = memory.linksOfMany(root, ['question0', 'answer0']);
  assert.deepEqual(memory.linksOf(root, 'question0'), many.get('question0'));
  assert.equal(many.get('answer0').out.length, 1);
  assert.equal(many.get('question0').incoming.length, 1);
});

// ---- raw counting: one truth (lucky-mem 68712f5a, 98b19d7e) ----
import * as doctor from '../src/doctor.mjs';

const findCapture = (root) => doctor.checkAll(root).findings.find((x) => x.name === 'capture');

function countingRoot(t) {
  const root = tempDir('cm-w1-count-', t);
  const archiveDir = tempDir('cm-w1-count-arch-', t);
  const saved = process.env.CHEAP_MEM_ARCHIVE;
  process.env.CHEAP_MEM_ARCHIVE = archiveDir;
  t.after(() => { if (saved === undefined) delete process.env.CHEAP_MEM_ARCHIVE; else process.env.CHEAP_MEM_ARCHIVE = saved; });
  spawnSync(process.execPath, [MEM, '--root', root, 'init'], { stdio: 'ignore' });
  const paths = [];
  for (let i = 0; i < 4; i += 1) {
    const tp = transcript(root, `t${i}.jsonl`, talk(60, `session ${i} text`));
    const r = raw.capture(root, tp, { minBytes: 1, now: new Date(`2026-01-0${i + 1}T12:00:00Z`) });
    assert.equal(r.status, 'captured');
    paths.push(r.path);
  }
  return { root, archiveDir, paths };
}

test('inRange: no range asked means no time filter (undated captures stay)', () => {
  const rows = [{ path: 'a', ts_to: '2026-01-01T00:00:00Z' }, { path: 'b' }, { path: 'c', captured_at: null }];
  assert.equal(archive.inRange(rows, {}).length, 3);
  assert.equal(archive.inRange(rows).length, 3);
  // Positive control: with a range the undated row IS excluded (it cannot be placed).
  assert.deepEqual(archive.inRange(rows, { from: '2025-01-01' }).map((r) => r.path), ['a']);
});

test('all readers, one number: doctor, review, raw archive and raw missing agree on a lost capture', (t) => {
  const { root, archiveDir, paths } = countingRoot(t);
  const lost = paths[1];
  fs.rmSync(path.join(archiveDir, archive.pathInArchive(lost)), { force: true });
  const states = raw.capturesWithState(root);
  assert.equal(states.length, 4);
  assert.equal(states.filter((r) => r.state === 'unreachable').length, 1);

  const run = (...args) => spawnSync(process.execPath, [MEM, '--root', root, 'raw', ...args], { encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ARCHIVE: archiveDir } });
  const review = JSON.parse(run('review', '--json').stdout);
  assert.equal(review.length, 4);
  assert.equal(review.filter((r) => r.state === 'unreachable').length, 1);
  const missing = JSON.parse(run('missing', '--json').stdout);
  assert.equal(missing.missing.length, 1);
  assert.equal(missing.total, 4);
  assert.equal(missing.missing[0].path, lost);
  assert.ok(missing.missing[0].expected.startsWith(archiveDir));
  const arch = JSON.parse(run('archive', '--json').stdout);
  assert.equal(arch.records, 4);
  assert.equal(arch.missing, 1);

  // The doctor reads the same rule: a lost capture is an alarm, not "healthy".
  const f = findCapture(root);
  assert.equal(f.level, doctor.LEVEL.ERROR, JSON.stringify(f));
  assert.match(f.text, /1 of 4 captures are MISSING/);
});

test('doctor positive control: nothing lost -> good, counted by the same rule', (t) => {
  const { root } = countingRoot(t);
  const f = findCapture(root);
  assert.equal(f.level, doctor.LEVEL.GOOD, JSON.stringify(f));
  assert.match(JSON.stringify(f), /4 captures/);
});

test('mem raw export with no range exports undated captures too', (t) => {
  const { root, archiveDir, paths } = countingRoot(t);
  // Make one record undated, the way a migrated capture without a header was.
  const recPath = path.join(root, archive.RECORD_FILE);
  const rows = fs.readFileSync(recPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) { if (r.path === paths[0]) { r.ts_to = null; r.captured_at = null; } }
  fs.writeFileSync(recPath, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const into = tempDir('cm-w1-export-', t);
  const r = spawnSync(process.execPath, [MEM, '--root', root, 'raw', 'export', '--into', into, '--json'], {
    encoding: 'utf8', env: { ...process.env, CHEAP_MEM_ARCHIVE: archiveDir },
  });
  assert.equal(JSON.parse(r.stdout).written.length, 4, r.stdout + r.stderr);
});

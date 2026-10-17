// The readers of state marks: a refusal is not a gap (CI run 1141 follow-up, tor finding on ci-1141b).
//
// **The finding.** `writeAtomic` replaces a state file by `rename`. On Windows the OPEN of a reader answers EPERM, EACCES
// or EBUSY while that happens - the same three codes the writer retries on - and four readers read EVERY failure as "no
// such file": `pointer.readMark`, `clonegate.readCache`, `epoch.readEpoch`, `runningmark.readMarker`. A mark that is
// there was then taken for a mark that is not: a block shown again, a clone verdict recomputed, a doctor line "no start
// marker", and - the dangerous one - the epoch watermark read as "first", which `recordEpoch` then writes over.
//
// The repair is one helper, `readStateFile` (src/atomicwrite.mjs): ENOENT is `missing`; on win32 the three transient
// codes are tried again (the writer's pauses); whatever still fails is `unreadable`, a third state that is never folded
// into `missing`. These probes play Windows on any machine: `platform`/`read`/`pause` are injected into the helper, and
// the readers run in a child process that sets `process.platform` and makes the real `fs.readFileSync` refuse the open.
// The same child runs the BASE (a fixed commit) for the red proof.
//
// invariant: leer-ist-kein-bestehen
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import { readStateFile } from '../src/atomicwrite.mjs';
import * as pointer from '../src/pointer.mjs';
import * as clonegate from '../src/clonegate.mjs';
import * as epoch from '../src/epoch.mjs';
import * as runningmark from '../src/runningmark.mjs';
import * as doctor from '../src/doctor.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// ci-1141b-cm (README numbers recounted): the last commit whose readers took every failure for "missing". A FIXED hash,
// never a merge-base that moves with the merge (rule 15).
const PRIOR = 'a2c91e5bd542912183dc46c57d5727a3dd1d39f6';

const err = (code) => Object.assign(new Error(`${code}: simulated`), { code });
const noPause = () => {};

/** A reader that fails `times` times with `code`, then answers `text`. Counts its calls. */
function flaky(code, times, text = '{"ok":1}') {
  const f = (file, enc) => {
    f.calls += 1;
    if (f.calls <= times) throw err(code);
    return text;
  };
  f.calls = 0;
  return f;
}

// -- the helper -----------------------------------------------------------------------------------------------------

test('readStateFile: ok, missing and unreadable are three states', (t) => {
  const dir = tempDir('cm-srr-', t);
  const file = path.join(dir, 'm.json');
  assert.deepEqual(readStateFile(file), { state: 'missing' });
  fs.writeFileSync(file, '{"a":1}');
  assert.deepEqual(readStateFile(file), { state: 'ok', text: '{"a":1}' });
  const dirAsFile = path.join(dir, 'd.json');
  fs.mkdirSync(dirAsFile);
  const r = readStateFile(dirAsFile);
  assert.equal(r.state, 'unreadable', 'a directory in the place of the file is there and cannot be read - not missing');
  assert.ok(r.error);
});

test('readStateFile on win32: EPERM / EACCES / EBUSY are tried again with the writer\'s pauses, then the file is read', () => {
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    const read = flaky(code, 3);
    const pauses = [];
    const r = readStateFile('x', { platform: 'win32', read, pause: (ms) => pauses.push(ms) });
    assert.deepEqual(r, { state: 'ok', text: '{"ok":1}' }, `${code} while a writer replaces the file`);
    assert.equal(read.calls, 4, code);
    assert.deepEqual(pauses, [5, 10, 15], `${code}: the writer's politics (i * 5 ms)`);
  }
});

test('readStateFile on win32: a refusal that never lets up is unreadable after six opens, and is never "missing"', () => {
  const read = flaky('EPERM', 99);
  const r = readStateFile('x', { platform: 'win32', read, pause: noPause });
  assert.equal(r.state, 'unreadable');
  assert.equal(r.code, 'EPERM');
  assert.equal(read.calls, 6);
});

test('readStateFile: ENOENT is a gap everywhere and is not retried; off Windows the three codes are real errors, at once', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    const read = flaky('ENOENT', 99);
    assert.deepEqual(readStateFile('x', { platform, read, pause: noPause }), { state: 'missing' }, platform);
    assert.equal(read.calls, 1, `${platform}: ENOENT retried`);
  }
  for (const platform of ['linux', 'darwin']) {
    const read = flaky('EACCES', 99);
    const r = readStateFile('x', { platform, read, pause: noPause });
    assert.equal(r.state, 'unreadable', platform);
    assert.equal(read.calls, 1, `${platform}: a real permission error retried`);
  }
  const other = flaky('EIO', 99);
  assert.equal(readStateFile('x', { platform: 'win32', read: other, pause: noPause }).state, 'unreadable');
  assert.equal(other.calls, 1, 'an error that is no refusal is not retried');
});

// -- the four readers, in injection form ----------------------------------------------------------------------------

test('readers with an injected refusal on win32: the mark that is there is read, not "never shown / no cache / no start"', (t) => {
  const dir = tempDir('cm-srr-', t);
  const win = (text, code = 'EPERM', times = 2) => ({ platform: 'win32', read: flaky(code, times, text), pause: noPause });

  const mark = JSON.stringify({ level: 7, fingerprint: 'q', shown: 2 });
  assert.deepEqual(pointer.readMark(path.join(dir, 'm.json'), win(mark)), { level: 7, fingerprint: 'q', shown: 2 });
  assert.equal(pointer.readMark(path.join(dir, 'm.json'), { platform: 'win32', read: flaky('EPERM', 99, mark), pause: noPause }), null,
    'a refusal that never lets up reads as no mark (decide() then shows: the expensive, safe side)');

  const cache = JSON.stringify({ checked: 5, state: 'stale', line: 'Memory: x', shown: 0 });
  assert.equal(clonegate.readCache(path.join(dir, 'c.json'), win(cache, 'EBUSY'))?.state, 'stale');

  const root = dir;
  const ep = JSON.stringify({ version: epoch.EPOCH_VERSION, claims: 3, retiredCount: 0, retiredIds: [], semantics: null });
  assert.equal(epoch.readEpochState(root, win(ep, 'EACCES', 4)).state, 'ok');
  assert.equal(epoch.readEpochState(root, { platform: 'win32', read: flaky('EACCES', 99, ep), pause: noPause }).state, 'unreadable');
  assert.equal(epoch.readEpochState(root, { platform: 'win32', read: flaky('ENOENT', 99, ep), pause: noPause }).state, 'missing');
  assert.equal(epoch.readEpochState(root, win('{broken')).state, 'missing', 'content that is not a mark reads as it always did');

  const mk = JSON.stringify({ service: 'serve', pid: 1 });
  assert.equal(runningmark.readMarkerState(root, 'serve', win(mk)).state, 'ok');
  assert.equal(runningmark.readMarker(root, 'serve', win(mk))?.pid, 1);
  assert.equal(runningmark.readMarkerState(root, 'serve', { platform: 'win32', read: flaky('EPERM', 99, mk), pause: noPause }).state, 'unreadable');
  assert.equal(runningmark.readMarkerState(root, 'serve', { read: flaky('ENOENT', 99, mk), pause: noPause }).state, 'missing');
  assert.equal(runningmark.readMarkerState(root, 'serve', win('{"x":1}')).state, 'unreadable', 'JSON that is not a marker is there and broken');
});

// -- RED PROOF: the real readers, a real refused open, the base and this tree -----------------------------------------

const CHILD = `
import fs from 'node:fs';
Object.defineProperty(process, 'platform', { value: 'win32' });   // Windows, on any machine
const spec = JSON.parse(process.env.PROBE);
const real = fs.readFileSync;
let left = spec.fail;
fs.readFileSync = function (f, ...rest) {
  if (left > 0 && String(f).endsWith(spec.suffix)) { left -= 1; throw Object.assign(new Error(spec.code + ': simulated'), { code: spec.code }); }
  return real.call(this, f, ...rest);
};
const m = await import(spec.url);
const out = await ({
  mark: () => m.readMark(spec.file),
  gate: () => m.gate(spec.root, { env: {}, now: spec.now }),
  epoch: () => m.readEpoch(spec.root),
  marker: () => m.readMarker(spec.root, 'serve'),
  record: () => { const r = m.recordEpoch(spec.root); return { written: r.written, status: r.status }; },
}[spec.fn])();
process.stdout.write(JSON.stringify(out));
`;

function probe(tree, mod, spec) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    encoding: 'utf8', timeout: 60000, cwd: tree,
    env: { ...process.env, PROBE: JSON.stringify({ ...spec, url: pathToFileURL(path.join(tree, 'src', mod)).href }) },
  });
  assert.equal(r.status, 0, `${mod} ${spec.fn}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

function baseTree(t) {
  const dir = tempDir('cm-srr-base-', t);
  exportCommit(REPO, PRIOR, ['src', 'package.json'], dir);
  // The base's imports of packages resolve through the repository's own node_modules.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  return dir;
}

const z = (o) => `${JSON.stringify(o)}\n`;
function epochRoot(t) {
  const root = tempDir('cm-srr-ep-', t);
  fs.mkdirSync(path.join(root, 'projects', 'a'), { recursive: true });
  fs.writeFileSync(path.join(root, 'projects', 'a', 'decisions.jsonl'), z({ id: 'a1', ts: '2026-01-01T00:00:00Z', author: 'alice',
    authority: 'agent', topic: 't', choice: 'payment up front', why: 'original' }));
  return root;
}

test('RED: pointer.readMark - EPERM during a replace on Windows: this tree reads the mark, the base called it "no mark"', (t) => {
  const dir = tempDir('cm-srr-', t);
  const file = path.join(dir, 'mark.json');
  fs.writeFileSync(file, JSON.stringify({ level: 7, fingerprint: 'q', shown: 2 }));
  const spec = { fn: 'mark', file, suffix: 'mark.json', code: 'EPERM', fail: 2 };
  assert.deepEqual(probe(REPO, 'pointer.mjs', { ...spec, fail: 0 }), { level: 7, fingerprint: 'q', shown: 2 }, 'positive control: no refusal, mark read');
  assert.deepEqual(probe(REPO, 'pointer.mjs', spec), { level: 7, fingerprint: 'q', shown: 2 });
  assert.equal(probe(baseTree(t), 'pointer.mjs', spec), null, 'the base took the refusal for a mark that is not there');
});

test('RED: clonegate.gate - a refused open of the verdict cache: this tree keeps the verdict, the base recomputed it', (t) => {
  const root = tempDir('cm-srr-', t);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, '.pipeline'));
  const now = Date.now();
  fs.writeFileSync(path.join(root, '.pipeline', 'clone-gate.json'), JSON.stringify({ checked: now - 1000, state: 'stale', line: 'Memory: clone is behind', shown: 0 }));
  const spec = { fn: 'gate', root, now, suffix: 'clone-gate.json', code: 'EBUSY', fail: 2 };
  const want = probe(REPO, 'clonegate.mjs', { ...spec, fail: 0 });
  assert.equal(want.state, 'stale', 'positive control: no refusal, the cached verdict stands');
  assert.equal(want.line, 'Memory: clone is behind');
  fs.writeFileSync(path.join(root, '.pipeline', 'clone-gate.json'), JSON.stringify({ checked: now - 1000, state: 'stale', line: 'Memory: clone is behind', shown: 0 }));
  assert.equal(probe(REPO, 'clonegate.mjs', spec).state, 'stale');
  fs.writeFileSync(path.join(root, '.pipeline', 'clone-gate.json'), JSON.stringify({ checked: now - 1000, state: 'stale', line: 'Memory: clone is behind', shown: 0 }));
  assert.notEqual(probe(baseTree(t), 'clonegate.mjs', spec).state, 'stale', 'the base took the refusal for "no cache" and judged the clone anew');
});

test('RED: epoch.readEpoch - a refused open of the watermark: this tree reads it, the base called it "no mark" (= first)', (t) => {
  const root = epochRoot(t);
  epoch.recordEpoch(root);
  const spec = { fn: 'epoch', root, suffix: 'epoch.json', code: 'EPERM', fail: 2 };
  assert.equal(probe(REPO, 'epoch.mjs', { ...spec, fail: 0 }).version, epoch.EPOCH_VERSION, 'positive control: no refusal');
  assert.equal(probe(REPO, 'epoch.mjs', spec).version, epoch.EPOCH_VERSION);
  assert.equal(probe(baseTree(t), 'epoch.mjs', spec), null, 'the base took the refusal for "no watermark"');
});

test('RED: epoch.recordEpoch - a refusal that does not let up must NOT write over the watermark; the base did', (t) => {
  const root = epochRoot(t);
  epoch.recordEpoch(root);
  const file = path.join(root, epoch.EPOCH_FILE);
  // A watermark the memory has not reached: only a replacement on a guess would lower it.
  const high = { ...JSON.parse(fs.readFileSync(file, 'utf8')), claims: 999 };
  const keep = () => fs.writeFileSync(file, JSON.stringify(high));
  const spec = { fn: 'record', root, suffix: 'epoch.json', code: 'EPERM', fail: 99 };
  keep();
  assert.deepEqual(probe(REPO, 'epoch.mjs', spec), { written: false, status: 'unreadable' });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claims, 999, 'this tree replaced a watermark it could not read');
  keep();
  assert.equal(probe(REPO, 'epoch.mjs', { ...spec, fail: 0 }).status, 'rollback', 'positive control: readable, the 999 is a real mark and the memory is behind it');
  keep();
  const old = probe(baseTree(t), 'epoch.mjs', spec);
  assert.equal(old.written, true, 'the base wrote over a watermark it had not read');
  assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).claims, 999, 'the base left the high-water mark where it was');
});

test('RED: runningmark.readMarker - a refused open of the start marker: this tree reads it, the base called it "no marker"', (t) => {
  const root = tempDir('cm-srr-', t);
  fs.mkdirSync(path.join(root, runningmark.MARKER_DIR), { recursive: true });
  fs.writeFileSync(runningmark.markerPath(root, 'serve'), JSON.stringify({ service: 'serve', pid: 4242 }));
  const spec = { fn: 'marker', root, suffix: 'serve.json', code: 'EACCES', fail: 2 };
  assert.equal(probe(REPO, 'runningmark.mjs', { ...spec, fail: 0 }).pid, 4242, 'positive control: no refusal');
  assert.equal(probe(REPO, 'runningmark.mjs', spec).pid, 4242);
  assert.equal(probe(baseTree(t), 'runningmark.mjs', spec), null, 'the base took the refusal for "no marker"');
});

// -- the callers say "cannot read", not "nothing there" -----------------------------------------------------------------

test('epoch: an unreadable watermark is its own status; recordEpoch leaves it alone unless forced', (t) => {
  const root = epochRoot(t);
  epoch.recordEpoch(root);
  const file = path.join(root, epoch.EPOCH_FILE);
  const before = fs.readFileSync(file, 'utf8');
  const refuse = { platform: 'win32', read: flaky('EPERM', 99), pause: noPause };
  const s = epoch.checkEpoch(root, null, refuse);
  assert.equal(s.status, 'unreadable');
  assert.equal(s.detail, 'EPERM');
  assert.equal(s.mark, null);
  const r = epoch.recordEpoch(root, refuse);
  assert.equal(r.written, false);
  assert.equal(r.status, 'unreadable');
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the watermark was written over');
  // Forced, on purpose: the operator replaces a mark that stays unreadable.
  assert.equal(epoch.recordEpoch(root, { ...refuse, force: true }).written, true);
  // Control: a readable watermark gives the usual statuses, and a missing one is `first`, not `unreadable`.
  assert.equal(epoch.checkEpoch(root).status, 'same');
  fs.rmSync(file);
  assert.equal(epoch.checkEpoch(root).status, 'first');
});

test('doctor: a watermark / start marker that is there and cannot be read is UNKNOWN with that word, not "no watermark yet" / "no start marker"', (t) => {
  const root = epochRoot(t);
  // A directory in the place of each file: there, and not readable, on every platform.
  fs.mkdirSync(path.join(root, epoch.EPOCH_FILE), { recursive: true });
  const f = doctor.checkRollback(root);
  assert.match(f.text, /could not be read/);
  assert.doesNotMatch(f.text, /no watermark yet/);
  fs.mkdirSync(runningmark.markerPath(root, 'serve'), { recursive: true });
  const c = doctor.checkRunningCodeFor(root, 'serve');
  assert.match(c.text, /cannot be read/);
  assert.doesNotMatch(c.text, /no start marker/);
  // Control: nothing there at all keeps its old words.
  const empty = epochRoot(t);
  assert.match(doctor.checkRollback(empty).text, /no watermark yet/);
  assert.match(doctor.checkRunningCodeFor(empty, 'serve').text, /no start marker/);
  // And at the base the same directory read as "nothing there" - the red proof for the callers.
  const old = baseTree(t);
  const baseEpoch = probe(old, 'epoch.mjs', { fn: 'epoch', root, suffix: 'never-matches', code: 'EPERM', fail: 0 });
  assert.equal(baseEpoch, null, 'the base read a directory in the place of the watermark as "no watermark"');
  const baseMarker = probe(old, 'runningmark.mjs', { fn: 'marker', root, suffix: 'never-matches', code: 'EPERM', fail: 0 });
  assert.equal(baseMarker, null, 'the base read a directory in the place of the marker as "no marker"');
});

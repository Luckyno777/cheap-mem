// test/release-dashboard-wiring.test.mjs — the dashboard's "Release
// state" / "Last test receipt" rows (Bauplan P1) read real state in all
// four states, never the old "not available in cheap-mem". Red-proof
// pinned to a fixed commit (rule 12 in the agent frame).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as data from '../src/dashboard-data.mjs';
import * as checkrecord from '../src/checkrecord.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE_RELEASE_RAIL_COMMIT = '3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d';
const JS = fs.readFileSync(path.join(REPO, 'assets', 'dashboard', 'dashboard.js'), 'utf8');

const dirs = [];
process.on('exit', () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dash-release-'));
  dirs.push(dir);
  return path.join(dir, name);
}
function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-dash-release-base-'));
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------------
// Red proof
// ---------------------------------------------------------------------

test('RED PROOF (pinned commit): the panel rendering hardcoded "not available in cheap-mem" for both rows', () => {
  const old = execFileSync('git', ['show', `${PRE_RELEASE_RAIL_COMMIT}:assets/dashboard/dashboard.js`], { cwd: REPO, encoding: 'utf8' });
  const hits = [...old.matchAll(/badge\('not available', 'not available in cheap-mem'\)/g)];
  assert.ok(hits.length >= 2, `expected at least 2 hardcoded "not available" badges on the old panel, found ${hits.length}`);
});

test('the CURRENT panel rendering no longer hardcodes "not available" for the release rows (it calls releaseRow/checkRecordRow)', () => {
  assert.match(JS, /releaseRow\(v\.release\)/);
  assert.match(JS, /checkRecordRow\(v\.checkRecord\)/);
});

// ---------------------------------------------------------------------
// checkRecordState — four states
// ---------------------------------------------------------------------

test('checkRecordState: no ledger file at all -> unknown, "unknown — no release yet"', () => {
  const env = { CHEAP_MEM_CHECK_FILE: tmpFile('checked.jsonl') };
  const r = data.checkRecordState(env);
  assert.equal(r.state, 'unknown');
  assert.equal(r.readable, false);
  assert.equal(r.reason, 'unknown — no release yet');
});

test('checkRecordState: a row whose tree matches the current code tree -> good', () => {
  const target = tmpFile('checked.jsonl');
  const realTree = checkrecord.treeHash(REPO);
  fs.writeFileSync(target, `${JSON.stringify({
    tree: realTree, commit: 'deadbeef', tests: 10, passed: 10, failed: 0, ts: '2026-09-28T00:00:00Z', machine: 'x', house: 'cheap-mem',
  })}\n`);
  const r = data.checkRecordState({ CHEAP_MEM_CHECK_FILE: target });
  assert.equal(r.state, 'good');
  assert.equal(r.readable, true);
  assert.equal(r.matchesCurrentTree, true);
});

test('checkRecordState: a row whose tree does NOT match the current code tree -> warn', () => {
  const target = tmpFile('checked.jsonl');
  fs.writeFileSync(target, `${JSON.stringify({
    tree: 'not-the-real-tree', commit: 'deadbeef', tests: 10, passed: 10, failed: 0, ts: '2026-09-28T00:00:00Z', machine: 'x', house: 'cheap-mem',
  })}\n`);
  const r = data.checkRecordState({ CHEAP_MEM_CHECK_FILE: target });
  assert.equal(r.state, 'warn');
  assert.equal(r.matchesCurrentTree, false);
  assert.match(r.reason, /run `bin\/mem-check-record` again/);
});

test('POSITIVE CONTROL: checkRecordState reports "error" (not silently "good") when every line is broken', () => {
  const target = tmpFile('checked.jsonl');
  fs.writeFileSync(target, 'not json at all\nneither is this\n');
  const r = data.checkRecordState({ CHEAP_MEM_CHECK_FILE: target });
  assert.equal(r.state, 'error');
  assert.equal(r.readable, false);
  assert.match(r.reason, /none parse/);
});

// ---------------------------------------------------------------------
// releaseState — four states
// ---------------------------------------------------------------------

test('releaseState: no release ever created -> unknown, "unknown — no release yet"', () => {
  const env = { CHEAP_MEM_RELEASE_BASE: tmpDir() };
  const r = data.releaseState(env);
  assert.equal(r.state, 'unknown');
  assert.equal(r.readable, false);
  assert.equal(r.reason, 'unknown — no release yet');
});

test('releaseState: "current" points at a directory with unreadable meta -> error, not unknown', () => {
  const base = tmpDir();
  const target = path.join(base, 'deadbeefdead');
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, path.join(base, 'current'));
  const r = data.releaseState({ CHEAP_MEM_RELEASE_BASE: base });
  assert.equal(r.state, 'error');
  assert.equal(r.readable, false);
});

test('releaseState: a proven, up-to-date release -> good', () => {
  const base = tmpDir();
  const target = path.join(base, 'abc123abc123');
  fs.mkdirSync(target, { recursive: true });
  const headNow = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const fullHead = execFileSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(target, '.release-meta.json'), JSON.stringify({
    commit: fullHead, kurzhash: 'abc123abc123', tree: 'sometree', createdAt: '2026-09-28T00:00:00Z', proven: true, proofKind: 'ledger',
  }));
  fs.symlinkSync(target, path.join(base, 'current'));
  const r = data.releaseState({ CHEAP_MEM_RELEASE_BASE: base });
  assert.equal(r.state, 'good');
  assert.equal(r.stale, false);
  assert.equal(headNow.length > 0, true);
});

test('POSITIVE CONTROL: a forced (unproven) release reads "warn", never "good"', () => {
  const base = tmpDir();
  const target = path.join(base, 'abc123abc123');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, '.release-meta.json'), JSON.stringify({
    commit: 'deadbeef', kurzhash: 'abc123abc123', tree: 'sometree', createdAt: '2026-09-28T00:00:00Z', proven: false, proofKind: 'forced',
  }));
  fs.symlinkSync(target, path.join(base, 'current'));
  const r = data.releaseState({ CHEAP_MEM_RELEASE_BASE: base });
  assert.equal(r.state, 'warn');
  assert.match(r.reason, /forced/);
});

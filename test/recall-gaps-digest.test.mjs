// recall-gaps (B20, Z-abruf 22): the digest's duplicate check looks at
// the whole memory by default, and its selection has an age reserve so
// an old capture cannot starve behind a stream of small new ones.
//
// Red proof (recorded 2026-10-01 against 0a2fe4e, the base of this
// branch): src/digestselect.mjs does not exist there; through the real
// bin/mem-digest the old capture is missing from the prompt's listing
// (pure smallest first) and the prompt says `--since 7d` whatever is
// configured. The positive controls: with the reserve switched off the
// new code reproduces the old choice exactly (the probe can see the
// starvation), and the old capture IS pending and fits the budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { selectCaptures, AGE_RESERVE_PCT } from '../src/digestselect.mjs';
import * as archive from '../src/archive.mjs';
import * as raw from '../src/raw.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

const name = (iso, s) => `raw/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.replace(/:/g, '-')}--${s}.jsonl.gz`;
const OLD = name('2026-08-01T10:00:00Z', 'old');
const fresh = (i) => name(`2026-09-${String(10 + i).padStart(2, '0')}T10:00:00Z`, `new${i}`);

function stream(n, size) {
  const open = [OLD];
  const rawSizes = { [OLD]: 600 };
  for (let i = 0; i < n; i += 1) { open.push(fresh(i)); rawSizes[fresh(i)] = size; }
  return { open, rawSizes };
}

test('STARVATION: an old mid-sized capture is chosen although smaller new ones fill the budget', () => {
  const r = selectCaptures(stream(20, 100), { max: 1000 });
  assert.ok(r.chosen.includes(OLD), JSON.stringify(r));
  assert.deepEqual(r.reserved, [OLD]);
  assert.ok(r.sum <= 1000, `budget kept: ${r.sum}`);
});

test('POSITIVE CONTROL: reserve 0 is the old smallest-first choice — the old capture starves', () => {
  const r = selectCaptures(stream(20, 100), { max: 1000, reservePct: 0 });
  assert.equal(r.chosen.length, 10);
  assert.ok(!r.chosen.includes(OLD));
  assert.equal(AGE_RESERVE_PCT, 25, 'the documented default');
});

test('BOUND: run after run with new small captures arriving, every old one is taken in order', () => {
  // Three old captures, ten new small ones arrive before every run.
  const olds = ['2026-07-01', '2026-07-02', '2026-07-03'].map((d, i) => name(`${d}T00:00:00Z`, `o${i}`));
  let open = [...olds];
  const sizes = Object.fromEntries(olds.map((f) => [f, 300]));
  const doneAt = {};
  for (let run = 0; run < 5; run += 1) {
    for (let i = 0; i < 10; i += 1) {
      const f = name(`2026-09-${10 + run}T10:00:${String(i).padStart(2, '0')}Z`, `r${run}n${i}`);
      open.push(f); sizes[f] = 50;
    }
    const { chosen } = selectCaptures({ open, rawSizes: sizes }, { max: 1000 });
    for (const f of chosen) if (olds.includes(f)) doneAt[f] = run;
    open = open.filter((f) => !chosen.includes(f));
  }
  assert.deepEqual(olds.map((f) => doneAt[f]), [0, 1, 2], JSON.stringify(doneAt));
});

test('UNCHANGED: too large for any run is not forced in; unknown size is never reserved', () => {
  const huge = name('2026-06-01T00:00:00Z', 'huge');
  const unknown = name('2026-06-02T00:00:00Z', 'unknown');
  const p = stream(3, 100);
  p.open.push(huge, unknown);
  p.rawSizes[huge] = 5000;
  p.rawSizes[unknown] = null;
  const r = selectCaptures(p, { max: 1000 });
  assert.ok(!r.chosen.includes(huge), JSON.stringify(r));
  assert.ok(!r.reserved.includes(unknown));
  assert.deepEqual(r.reserved, [OLD], 'the oldest that fits');
});

// --- through the real bin/mem-digest -----------------------------------

function store() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rg-digest-'));
  const r = spawnSync('node', [MEM, 'init'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  const put = (rel, bytes) => {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), zlib.gzipSync(`${JSON.stringify({ __stamp: 1, session_id: 's' })}\n{"t":"x"}\n`));
    archive.writeRecord(root, {
      path: rel, captured_at: '2026-09-01T00:00:00Z', location: `file:///x/${rel}`,
      bytes: fs.statSync(path.join(root, rel)).size, source_bytes: bytes, sha256: 'x'.repeat(64),
    });
  };
  put(OLD, 600);
  for (let i = 0; i < 20; i += 1) put(fresh(i), 100);
  return root;
}

function digest(root, env = {}) {
  const promptFile = path.join(root, 'prompt.txt');
  const fake = path.join(root, 'fake-model.sh');
  fs.writeFileSync(fake, `#!/usr/bin/env bash\nprintf '%s' "$1" > "${promptFile}"\nprintf '%s' '{"result":"ok","is_error":false}'\n`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'mem-digest')], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_DIGEST_VOLUME_NOW_KB: '0', MEM_DIGEST_CMD: fake,
      MEM_DIGEST_TIMEOUT: '20', MEM_DIGEST_MAX_BYTES: '1000', ...env },
  });
  return { r, prompt: fs.existsSync(promptFile) ? fs.readFileSync(promptFile, 'utf8') : null };
}

test('DIGEST: the old capture is in the prompt, and the duplicate check spans the whole memory', () => {
  const root = store();
  try {
    assert.equal(raw.pending(root).open.length, 21, 'control: all 21 captures are pending');
    const { r, prompt } = digest(root);
    assert.ok(prompt, `no model call: ${r.stdout}\n${r.stderr}`);
    assert.match(prompt, new RegExp(OLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the old capture must be listed');
    assert.match(prompt, /duplicates across the whole memory/);
    assert.ok(!/--since/.test(prompt), 'no window by default');
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('DIGEST: a configured window reaches the prompt; a malformed one is a configuration error', () => {
  const root = store();
  try {
    const { prompt } = digest(root, { MEM_DIGEST_DEDUP_SINCE: '30d' });
    assert.match(prompt ?? '', /mem find "<keyword>" --since 30d/);
    const bad = digest(root, { MEM_DIGEST_DEDUP_SINCE: 'forever' });
    assert.equal(bad.r.status, 2, bad.r.stderr);
    assert.match(bad.r.stderr, /MEM_DIGEST_DEDUP_SINCE/);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('PS1 twin asks the same module and knows the same two knobs', () => {
  const ps = fs.readFileSync(path.join(REPO, 'bin', 'mem-digest.ps1'), 'utf8');
  assert.match(ps, /src\/digestselect\.mjs/);
  assert.match(ps, /selectCaptures/);
  assert.match(ps, /MEM_DIGEST_DEDUP_SINCE/);
  assert.match(ps, /MEM_DIGEST_AGE_RESERVE_PCT/);
  assert.ok(!/--since 7d/.test(ps), 'the fixed 7-day window is gone');
});

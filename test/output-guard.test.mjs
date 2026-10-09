// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The output guard (src/outputguard.mjs): a key shape that got into a drawer
// PAST the write path must not come out of any surface that shows entries.
//
// Red proof against a FIXED old commit (never a moving merge-base): on it
// every CLI surface hands the plant out in the clear. Positive control: the
// same entry IS shown on every surface (otherwise "no leak" would be empty).
// The plant is assembled at run time; no key shape is in this source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskText, maskEntry, maskOutput } from '../src/outputguard.mjs';
import { compactLine } from '../src/cli/display.mjs';
import { shortLine } from '../src/shortline.mjs';
import { redact } from '../src/redaction.mjs';
import * as dashboard from '../src/dashboard.mjs';
import * as viewer from '../src/viewer.mjs';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The state before the output guard (cheap-mem main). Pinned, never `merge-base`. */
const OLD_STATE = '24cd9a95195e4a0b969ea7621ffd430521835817';
const MARK = 'flaechenwort';
const MASK = '[REDACTED:github-token]';

/** A github-token-shaped plant, built at run time. */
const plant = () => ['gh', 'p_'].join('') + 'Q'.repeat(10) + 'z9'.repeat(10) + 'ab';

// The REAL temp dir, not the one the OS names: on macOS os.tmpdir() is
// /var/folders/..., a symlink to /private/var/..., and the pinned OLD state's
// entry check (`argv[1] === import.meta.url`) is false below any symlink, so
// its recall hook ran as a silent no-op there (CI run 37692975754: "the old
// recall hook injects the key" failed on macOS only). The old code cannot be
// fixed; the place it runs in can.
const REAL_TMP = fs.realpathSync(os.tmpdir());
const tmp = (t, prefix) => {
  const d = fs.mkdtempSync(path.join(REAL_TMP, prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

function run(bin, root, args, input) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8', input, timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_NO_PULL: '1' },
  });
}

/** A fresh memory with the plant written straight into the drawers (past the write path). */
function plantedRoot(t, bin, { lanes = ['learnings', 'decisions', 'errors', 'events'] } = {}) {
  const root = tmp(t, 'cm-outguard-');
  assert.equal(run(bin, root, ['init']).status, 0);
  const key = plant();
  for (const lane of lanes) {
    const line = {
      id: `plant${lane.slice(0, 4)}`, ts: new Date().toISOString(), v: 1,
      title: `Sentinel ${MARK} ${key} end`, text: `${MARK} ${key} end`, topic: MARK,
      choice: `${MARK} ${key}`, why: `${MARK} ${key}`, agent: 'human:root', authority: 'agent',
      ...(lane === 'errors' ? { class: 'measurement' } : {}),
    };
    fs.appendFileSync(path.join(root, 'global', `${lane}.jsonl`), `${JSON.stringify(line)}\n`);
  }
  return { root, key };
}

/** What every CLI surface that shows entries prints for the plant. */
function cliSurfaces(bin, root) {
  const viewerOut = path.join(root, 'viewer-probe.html');
  const v = run(bin, root, ['viewer', '--out', viewerOut]);
  const calls = {
    'mem find': ['find', MARK],
    'mem find --json': ['find', MARK, '--json'],
    'mem find-hybrid': ['find-hybrid', MARK],
    'mem show': ['show', 'plantlear'],
    'mem show --json': ['show', 'plantlear', '--json'],
    'mem when today': ['when', 'today'],
    'mem context': ['context'],
    'mem retrieve': ['retrieve', MARK],
    'mem retrieve --json': ['retrieve', MARK, '--json'],
    'mem topic': ['topic', MARK],
  };
  const rows = Object.entries(calls).map(([name, args]) => {
    const r = run(bin, root, args);
    return { name, rc: r.status, text: `${r.stdout}${r.stderr}` };
  });
  rows.push({
    name: 'mem viewer --out',
    rc: v.status,
    text: v.status === 0 && fs.existsSync(viewerOut) ? fs.readFileSync(viewerOut, 'utf8') : '',
  });
  return rows;
}

/** The per-turn recall hook, on a memory with exactly one matching entry (a flat field is withheld). */
function hookOutput(t, bin) {
  const { root, key } = plantedRoot(t, bin, { lanes: ['learnings'] });
  const h = spawnSync('bash', [path.join(path.dirname(bin), 'mem-retrieve')], {
    input: JSON.stringify({ prompt: `what about ${MARK} sentinel`, session_id: 'outguard' }),
    encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env, CHEAP_MEM_ROOT: root, MEM_RETRIEVE_MIN: '0', MEM_RETRIEVE_NO_PULL: '1', MEM_RETRIEVE_TOP: '5',
      MEM_RETRIEVE_OFF: '', MEM_HOOK_OFF: '',
    },
  });
  return { key, text: h.stdout ?? '' };
}

function mcpCall(bin, root, calls) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin], { env: { ...process.env, CHEAP_MEM_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    const results = new Map();
    let buf = '';
    const timer = setTimeout(() => { child.kill(); resolve(results); }, 60000);
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          calls.forEach((c, i) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: c })}\n`));
        } else if (typeof msg.id === 'number' && msg.id >= 100) {
          results.set(msg.id - 100, JSON.stringify(msg.result ?? msg.error ?? {}));
          if (results.size === calls.length) { clearTimeout(timer); child.kill(); resolve(results); }
        }
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'output-guard-test', version: '1' } },
    })}\n`);
  });
}

// ---- the module ----------------------------------------------------------

test('maskText: a key shape becomes the redaction mark, once, and stays masked', () => {
  const key = plant();
  const masked = maskText(`before ${key} after`);
  assert.equal(masked, `before ${MASK} after`);
  assert.equal(maskText(masked), masked, 'idempotent');
  assert.equal(maskText(masked), maskText(maskText(masked)));
});

test('maskText uses the write-time patterns: no second list', () => {
  const key = plant();
  assert.equal(maskText(key), redact(key).text);
  assert.equal(maskText(`api_key = ${'k'.repeat(24)}`), redact(`api_key = ${'k'.repeat(24)}`).text);
});

test('counter-probe: innocent text and a too-short near-shape come out unchanged', () => {
  for (const s of ['plain prose about a token bucket', ['gh', 'p_'].join('') + 'short', 'sk-', '', 'x']) {
    assert.equal(maskText(s), s);
  }
  assert.equal(maskText(undefined), undefined);
  assert.equal(maskText(7), 7);
});

test('maskEntry: copies, masks every string value (nested), keeps keys, numbers and non-plain objects', () => {
  const key = plant();
  const date = new Date(0);
  const e = { id: 'a', n: 3, nested: { list: [`x ${key}`, 4], d: date }, [`k ${key}`]: 'v' };
  const m = maskEntry(e);
  assert.equal(m.nested.list[0], `x ${MASK}`);
  assert.equal(m.nested.list[1], 4);
  assert.equal(m.nested.d, date, 'a Date stays a Date');
  assert.equal(e.nested.list[0], `x ${key}`, 'the input is not changed');
  assert.ok(Object.hasOwn(m, `k ${key}`), 'keys are never touched');
});

test('maskOutput: JSON stays valid and keeps its shape; unchanged JSON is returned byte for byte', () => {
  const key = plant();
  const pretty = JSON.stringify({ a: `v ${key}`, b: [1, 2] }, null, 2);
  const masked = maskOutput(pretty);
  assert.deepEqual(JSON.parse(masked), { a: `v ${MASK}`, b: [1, 2] });
  assert.ok(masked.includes('\n  "a"'), 'indented stays indented');
  const clean = JSON.stringify({ a: 'plain', b: [1, 2] }, null, 4);
  assert.equal(maskOutput(clean), clean);
  assert.equal(maskOutput(`line ${key}\nnext`), `line ${MASK}\nnext`);
  assert.equal(maskOutput('{not json ' + key), `{not json ${MASK}`);
});

test('the mask comes BEFORE the cut: a key that straddles the summary cut leaves no rest', () => {
  const key = plant();
  const e = { id: 'x', ts: '2026-01-01T00:00:00Z', text: `${'w '.repeat(37)}${key} tail` };
  for (const line of [compactLine(e), shortLine(e)]) {
    assert.ok(!line.includes(key.slice(0, 12)), `no key rest in: ${line}`);
  }
  // Positive control: cutting first would have left the first characters of the key.
  assert.ok(String(e.text).slice(0, 80).includes(key.slice(0, 6)), 'the plain 80-char cut does reach into the key');
});

// ---- the surfaces, now -----------------------------------------------------

const BIN = path.join(REPO, 'bin', 'mem');

test('every CLI surface shows the entry and none hands out the key (positive control inside)', (t) => {
  const { root, key } = plantedRoot(t, BIN);
  for (const s of cliSurfaces(BIN, root)) {
    assert.equal(s.rc, 0, `${s.name} rc`);
    assert.ok(s.text.includes(MARK), `${s.name}: the surface must SHOW the entry (else "no leak" is empty)`);
    assert.ok(!s.text.includes(key), `${s.name}: the key must not come out`);
    assert.ok(!s.text.includes(key.slice(0, 20)), `${s.name}: no rest of the key either`);
  }
  const shown = run(BIN, root, ['show', 'plantlear']).stdout;
  assert.ok(shown.includes(MASK), 'the mark stands where the value stood');
});

test('--json outputs stay valid JSON after the mask', (t) => {
  const { root } = plantedRoot(t, BIN);
  for (const args of [['show', 'plantlear', '--json'], ['find', MARK, '--json'], ['retrieve', MARK, '--json']]) {
    const r = run(BIN, root, args);
    assert.doesNotThrow(() => JSON.parse(r.stdout), args.join(' '));
  }
});

test('the disk is untouched: the plant is still in the drawer, only the output is masked', (t) => {
  const { root, key } = plantedRoot(t, BIN);
  run(BIN, root, ['find', MARK]);
  run(BIN, root, ['viewer', '--out', path.join(root, 'v.html')]);
  assert.ok(fs.readFileSync(path.join(root, 'global', 'learnings.jsonl'), 'utf8').includes(key));
});

test('the recall hook shows the entry and puts no key into the session context', (t) => {
  const h = hookOutput(t, BIN);
  assert.ok(h.text.includes(MARK), 'positive control: the hook shows the entry');
  assert.ok(!h.text.includes(h.key));
  assert.ok(h.text.includes(MASK));
});

const hasSdk = fs.existsSync(path.join(REPO, 'node_modules', '@modelcontextprotocol', 'sdk'));
test('the MCP bridge: show and find print the entry, never the key', { skip: hasSdk ? false : 'optional dependency @modelcontextprotocol/sdk is not installed' }, async (t) => {
  const { root, key } = plantedRoot(t, BIN);
  const calls = [
    { name: 'mem_show', arguments: { id: 'plantlear' } },
    { name: 'mem_find', arguments: { query: MARK, top: 5 } },
    { name: 'mem_context', arguments: { n: 10 } },
  ];
  const res = await mcpCall(path.join(REPO, 'bin', 'mem-mcp'), root, calls);
  assert.equal(res.size, calls.length, 'every call was answered');
  for (let i = 0; i < calls.length; i += 1) {
    assert.ok(res.get(i).includes(MARK), `${calls[i].name}: shows the entry`);
    assert.ok(!res.get(i).includes(key), `${calls[i].name}: no key`);
  }
});

test('the dashboard (readPass, the entry card) and the viewer headline mask the key; the in-process surfaces show the entry', (t) => {
  const { root, key } = plantedRoot(t, BIN);
  const rows = dashboard.readPass(root).rows;
  assert.ok(rows.length >= 1);
  assert.ok(!JSON.stringify(rows).includes(key), 'readPass rows carry no key');
  assert.ok(JSON.stringify(rows).includes(MARK), 'positive control: the rows hold the entry');
  const card = dashboard.getEntryFast(root, 'plantlear');
  assert.ok(!JSON.stringify(card).includes(key), 'the entry card carries no key');
  assert.ok(JSON.stringify(card).includes(MARK), 'positive control: the card holds the entry');
  const head = viewer.headline({ id: 'x', title: `t ${key}`, text: 'y' });
  assert.ok(head.includes(MASK) && !head.includes(key));
});

// ---- red proof on the old state ---------------------------------------------

test('RED: on the pinned old state every CLI surface hands the key out; the positive control is green there', async (t) => {
  const old = tmp(t, 'cm-outguard-old-');
  exportCommit(REPO, OLD_STATE, ['.'], old);
  try { fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(old, 'node_modules')); } catch { /* none needed for the CLI */ }
  const oldBin = path.join(old, 'bin', 'mem');
  const { root, key } = plantedRoot(t, oldBin);
  const rows = cliSurfaces(oldBin, root);
  for (const s of rows) {
    assert.equal(s.rc, 0, `${s.name} rc`);
    assert.ok(s.text.includes(MARK), `${s.name}: shown on the old state (the probe sees something)`);
  }
  const leaking = rows.filter((s) => s.text.includes(key)).map((s) => s.name);
  assert.deepEqual(leaking, rows.map((s) => s.name), 'the old state leaks on every surface');
  const h = hookOutput(t, oldBin);
  assert.ok(h.text.includes(h.key), 'the old recall hook injects the key');
  if (hasSdk) {
    const res = await mcpCall(path.join(old, 'bin', 'mem-mcp'), root, [{ name: 'mem_show', arguments: { id: 'plantlear' } }]);
    assert.ok(res.get(0)?.includes(key), 'the old bridge hands the key out');
  }
});

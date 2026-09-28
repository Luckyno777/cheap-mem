// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/modelcost-digest-wiring.test.mjs — bin/mem-digest's headless
// `claude -p` call is journaled through src/modelcost.mjs (mirrors
// lucky-mem's dash-fix3, part 2a).
//
// Red proof pinned to this worktree's starting commit
// (ddca89d5430b7c2866a93788edd6fe14822af337, never `git merge-base` —
// see the agent frame): the old bin/mem-digest calls its model CLI
// without `--output-format json` and never writes a cost journal,
// however the fake model answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as modelcost from '../src/modelcost.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_COMMIT = 'ddca89d5430b7c2866a93788edd6fe14822af337';

/** A memory with one raw capture, so `digest due --volume-now 0` fires
 *  without depending on real quiet/ceiling timing (see raw.due()). */
function memoryWithRawMaterial() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-modelcost-'));
  const mem = (...a) => spawnSync('node', [path.join(REPO, 'bin', 'mem'), ...a],
    { cwd: root, encoding: 'utf8', timeout: 30000 });
  const init = mem('init');
  assert.equal(init.status, 0, `mem init failed: ${init.stderr}`);
  const transcript = path.join(root, 'transcript.txt');
  fs.writeFileSync(transcript, 'user: hello\nassistant: hi there, this is enough bytes to count as material.\n'.repeat(50));
  const cap = mem('raw-capture', '--transcript', transcript, '--min-bytes', '0');
  assert.equal(cap.status, 0, `raw-capture failed: ${cap.stderr}`);
  return root;
}

/** A fake `claude -p` that only behaves correctly when it is passed
 *  `--output-format json` — the same contract the real CLI has. */
function fakeModelScript(dir) {
  const p = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(p, `#!/usr/bin/env bash
prompt="$1"
if printf '%s\\n' "$@" | grep -q -- '--output-format'; then
  printf '%s' '{"result":"digested nothing, but ran","usage":{"input_tokens":123,"output_tokens":45},"total_cost_usd":0.0031,"is_error":false,"session_id":"s1"}'
else
  printf '%s' 'digested nothing, but ran'
fi
`, { mode: 0o755 });
  return p;
}

function runDigest(script, root, cmdPath) {
  return spawnSync('bash', [script], {
    encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env,
      CHEAP_MEM_ROOT: root,
      MEM_DIGEST_VOLUME_NOW_KB: '0',
      MEM_DIGEST_CMD: cmdPath,
      MEM_DIGEST_TIMEOUT: '20',
    },
  });
}

test('RED on the old commit: no cost journal appears, whatever the fake model answers', () => {
  const old = execFileSync('git', ['show', `${OLD_COMMIT}:bin/mem-digest`], { cwd: REPO, encoding: 'utf8' });
  const oldScript = path.join(REPO, 'bin', '.modelcost-old-mem-digest.sh');
  fs.writeFileSync(oldScript, old);
  const root = memoryWithRawMaterial();
  try {
    const cmd = fakeModelScript(root);
    const r = runDigest(oldScript, root, cmd);
    assert.notEqual(r.status, 2, `configuration error: ${r.stderr}\n${r.stdout}`);
    const journal = path.join(root, modelcost.LOG);
    assert.equal(fs.existsSync(journal), false,
      'the old bin/mem-digest must not produce a cost journal at all — otherwise this red proof shows nothing');
  } finally {
    fs.rmSync(oldScript, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GREEN on this commit: a real digest run journals tokens and cost from the CLI\'s own JSON', () => {
  const root = memoryWithRawMaterial();
  try {
    const cmd = fakeModelScript(root);
    const r = runDigest(path.join(REPO, 'bin', 'mem-digest'), root, cmd);
    assert.notEqual(r.status, 2, `configuration error: ${r.stderr}\n${r.stdout}`);
    const { rows, broken } = modelcost.read(root);
    assert.equal(broken, 0);
    assert.equal(rows.length, 1, `expected exactly one journal row, log:\n${r.stdout}`);
    const row = rows[0];
    assert.equal(row.who, 'digest');
    assert.equal(row.inputTokens, 123);
    assert.equal(row.outputTokens, 45);
    assert.equal(row.costUsd, 0.0031);
    assert.equal(row.costKind, 'estimate');
    // .mem/digest.log still gets the plain result text a caller expects
    // to see — unchanged from what `claude -p` WITHOUT the flag prints.
    const log = fs.readFileSync(path.join(root, '.mem', 'digest.log'), 'utf8');
    assert.match(log, /digested nothing, but ran/);
    assert.doesNotMatch(log, /"total_cost_usd"/, 'the raw JSON must not leak into the plain-text log');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an old-format model reply (no --output-format support) leaves "not measured", never an invented 0', () => {
  const root = memoryWithRawMaterial();
  try {
    const cmd = path.join(root, 'fake-claude-plain.sh');
    fs.writeFileSync(cmd, '#!/usr/bin/env bash\nprintf %s "plain text only, no json"\n', { mode: 0o755 });
    const r = runDigest(path.join(REPO, 'bin', 'mem-digest'), root, cmd);
    assert.notEqual(r.status, 2, `configuration error: ${r.stderr}\n${r.stdout}`);
    const { rows } = modelcost.read(root);
    assert.equal(rows.length, 0, 'no valid JSON came back — there must be no invented row');
    const log = fs.readFileSync(path.join(root, '.mem', 'digest.log'), 'utf8');
    assert.match(log, /plain text only, no json/, 'the plain text must still reach the existing log unchanged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

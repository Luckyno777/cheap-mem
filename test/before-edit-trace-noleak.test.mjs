// test/before-edit-trace-noleak.test.mjs - the before-edit trace says the SIZE and SHAPE of what reached the core, never
// a byte of it (review of the CI run 1103 diagnosis).
//
// **The finding.** The diagnosis added for the Windows PowerShell 5.1 twin named a JSON.parse failure by its message. V8
// quotes the first characters of the input there (`Unexpected token 's', "sk-ant-..." is not valid JSON`), and the masking
// of the trace line does not recognise a cut-off key prefix: with MEM_BEFORE_EDIT_TRACE=1 the start of whatever the hook
// was handed - a secret, if it began with one - went to stderr.
//
// Measure:          the trace line of the core in the twin's ASCII mode, for input that is not JSON.
// Starting value:   it carries the first characters of the input (b6bd641).
// Expected change:  error name and, where V8 names one, the position - nothing of the input.
// Abort criterion:  any piece of the planted prefix on stderr.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './temp-dir.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(REPO, 'bin', 'mem-before-edit-core.mjs');

// Built at run time: no key-shaped literal in the repository.
const prefix = ['sk', 'ant', 'api03'].join('-') + 'Q7wZ'.repeat(3);

function trace(input, t) {
  const r = spawnSync(process.execPath, [CORE], {
    input, encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: tempDir('cm-benoleak-', t), MEM_BE_ASCII: '1', MEM_BEFORE_EDIT_TRACE: '1', MEM_BEFORE_EDIT_OFF: '', MEM_HOOK_OFF: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stderr;
}

for (const [name, input] of [
  ['a key alone', `${prefix}${'x'.repeat(30)}`],
  ['a key at the start of a broken JSON line', `${prefix}{"tool_name":"Edit"`],
  ['a key inside a cut-off JSON string', `{"tool_input":{"file_path":"${prefix}`],
]) {
  test(`trace with MEM_BEFORE_EDIT_TRACE=1: ${name} leaves no piece of the input on stderr`, (t) => {
    const err = trace(input, t);
    assert.match(err, /no-readable-path \(input \d+ bytes, not JSON/, `positive control: the diagnosis line ran\n${err}`);
    for (const piece of [prefix.slice(0, 6), prefix.slice(3, 10), 'Q7wZ']) {
      assert.ok(!err.includes(piece), `the trace carries "${piece}" of the input:\n${err}`);
    }
    assert.match(err, /not JSON: SyntaxError( at position \d+)?(, bom=(yes|no))?\)/, 'the shape is named by the error name (and position) only');
  });
}

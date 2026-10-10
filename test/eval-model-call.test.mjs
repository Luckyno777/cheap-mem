// The eval harness calls the test model with NO tools, an explicit thinking
// level and no account context — and it can prove the first of the three.
// No model is called here: a stand-in `claude` records its command line and
// environment and answers like the CLI (a result object, or a stream with an
// init event).
//
// What is held (eval/model-call.mjs, eval/README.md "Test model without tools"):
//   - the call carries `--tools ""` and NO deny list (`--disallowedTools`);
//   - the thinking level is set on the child, over whatever the session had,
//     and is written into every result line;
//   - the tool proof is evaluated: `tools: []` in the init event passes,
//     any tool, a missing init event or a failed call does not;
//   - the account identity is derived (git config / options), never written
//     into the source; findings are labels, the stored answer is redacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildArgs, callModel, callEnv, thinkingLevel, THINKING_OFF, THINKING_ON, emptyWorkdir, probeTools,
  toolFree, toolEvidence, paidPreflight, standaloneProbe, hasToolProof, probeReceiptPath, loadGate,
  accountIdentity, accountFindings, redactAccount, accountProbe, REDACTED, harnessOptions,
} from '../eval/model-call.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A stand-in for the CLI. CommonJS and extensionless-safe: it is also run as `claude` on PATH.
const STANDIN = `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const mode = process.env.STANDIN_MODE || 'free';
const fmt = a[a.indexOf('--output-format') + 1];
if (process.env.STANDIN_LOG) {
  fs.appendFileSync(process.env.STANDIN_LOG, JSON.stringify({
    args: a, cwd: process.cwd(),
    think: process.env.MAX_THINKING_TOKENS, effort: process.env.CLAUDE_EFFORT,
  }) + '\\n');
}
if (mode === 'fail') { process.stderr.write('boom'); process.exit(1); }
const result = { type: 'result', is_error: false, result: process.env.STANDIN_ANSWER || 'NO TOOLS', total_cost_usd: 0.004, usage: {} };
if (fmt === 'stream-json') {
  if (mode !== 'noinit') {
    const tools = mode === 'tools' ? ['Bash', 'Read', 'mcp__artifact__create'] : [];
    console.log(JSON.stringify({ type: 'system', subtype: 'init', tools, mcp_servers: [], skills: [], slash_commands: [] }));
  }
  console.log(JSON.stringify(result));
} else {
  console.log(JSON.stringify(result));
}
`;

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-modelcall-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, STANDIN, { mode: 0o755 });
  const log = path.join(dir, 'calls.jsonl');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const opts = (mode = 'free', extra = {}) => ({
    command: process.execPath, prefix: [bin],
    env: { ...process.env, STANDIN_MODE: mode, STANDIN_LOG: log, MAX_THINKING_TOKENS: '31999', CLAUDE_EFFORT: 'max', ...extra },
  });
  return { dir, bin, log, calls, opts, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const OPEN = () => ({ ok: true, load: 0, limit: 8 });

test('the command line is an allow list of nothing, not a deny list', () => {
  const a = buildArgs('q', { system: 's' });
  const i = a.indexOf('--tools');
  assert.ok(i >= 0, '--tools is missing');
  assert.equal(a[i + 1], '', '--tools must be followed by the empty string');
  assert.ok(!a.some((x) => /disallowed/i.test(x)), 'a deny list is back in the arguments');
  for (const f of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) {
    assert.ok(a.includes(f), `${f} is missing`);
  }
  assert.ok(buildArgs('q', { format: 'stream-json' }).includes('--verbose'), 'stream-json needs --verbose with -p');
});

test('a call reaches the CLI with --tools "", no deny list, an empty cwd and the explicit thinking level', () => {
  const f = fixture();
  try {
    const r = callModel('hello', { system: 'sys', ...f.opts() });
    assert.equal(r.result.result, 'NO TOOLS');
    const [c] = f.calls();
    const i = c.args.indexOf('--tools');
    assert.equal(c.args[i + 1], '');
    assert.ok(!c.args.some((x) => /disallowed/i.test(x)));
    // The session had 31999 / max; the call was set to off / high over it.
    assert.equal(c.think, '0');
    assert.equal(c.effort, 'high');
    // Not the repo (no CLAUDE.md leaks in), and empty.
    assert.notEqual(fs.realpathSync(c.cwd), fs.realpathSync(REPO));
    assert.deepEqual(fs.readdirSync(c.cwd), []);
    assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(emptyWorkdir()));
  } finally { f.done(); }
});

test('the thinking level can be switched on, and is the same object that goes into the result lines', () => {
  const f = fixture();
  try {
    callModel('hello', { ...f.opts(), thinking: true });
    assert.equal(f.calls()[0].think, '31999');
    assert.deepEqual(callEnv({ MAX_THINKING_TOKENS: '5' }, {}), { ...THINKING_OFF });
    assert.deepEqual(callEnv({}, { thinking: true }), { ...THINKING_ON });
    assert.deepEqual(thinkingLevel(), { MAX_THINKING_TOKENS: '0', CLAUDE_EFFORT: 'high', inherited: false });
    assert.equal(thinkingLevel({ thinking: true }).MAX_THINKING_TOKENS, '31999');
  } finally { f.done(); }
});

test('a failed call throws instead of returning an empty answer', () => {
  const f = fixture();
  try {
    assert.throws(() => callModel('hello', f.opts('fail')), /status 1/);
  } finally { f.done(); }
});

test('the tool proof is evaluated: tools [] passes; a tool, a missing init event, a failure do not', () => {
  const f = fixture();
  try {
    const ok = probeTools(f.opts('free'));
    assert.equal(ok.toolFree, true);
    assert.deepEqual(ok.evidence.tools, []);
    assert.equal(ok.error, null);
    assert.ok(ok.cost > 0);
    // The call that the probe made is the same hardened one.
    assert.ok(f.calls()[0].args.includes('stream-json'));
    assert.equal(f.calls()[0].args[f.calls()[0].args.indexOf('--tools') + 1], '');

    const bad = probeTools(f.opts('tools'));
    assert.equal(bad.toolFree, false);
    assert.deepEqual(bad.evidence.tools, ['Bash', 'Read', 'mcp__artifact__create']);

    const none = probeTools(f.opts('noinit'));
    assert.equal(none.toolFree, false, 'no init event is no proof');
    assert.equal(none.evidence.tools, null);

    const failed = probeTools(f.opts('fail'));
    assert.equal(failed.toolFree, false);
    assert.ok(failed.error);
  } finally { f.done(); }
});

test('toolFree reads only an empty tools list', () => {
  assert.equal(toolFree(toolEvidence({ tools: [] })), true);
  assert.equal(toolFree(toolEvidence({ tools: ['Bash'] })), false);
  assert.equal(toolFree(toolEvidence({})), false);
  assert.equal(toolFree(toolEvidence(null)), false);
  assert.equal(toolFree(null), false);
});

test('the model\'s own answer is not the proof: "NO TOOLS" in the text with tools in the init event fails', () => {
  const f = fixture();
  try {
    const p = probeTools(f.opts('tools', { STANDIN_ANSWER: 'NO TOOLS' }));
    assert.equal(p.answer, 'NO TOOLS');
    assert.equal(p.toolFree, false);
  } finally { f.done(); }
});

test('paid preflight: takes the proof once, leaves a receipt, stops on a model with tools', () => {
  const f = fixture();
  const out = path.join(f.dir, 'runs', 'x.jsonl');
  const quiet = () => {};
  try {
    const first = paidPreflight({ out, model: 'm1', gate: OPEN, log: quiet, ...f.opts('free') });
    assert.equal(first.ok, true);
    assert.equal(f.calls().length, 1);
    assert.equal(hasToolProof(out, 'm1'), true);
    assert.equal(hasToolProof(out, 'other-model'), false, 'a proof is for one model');
    const second = paidPreflight({ out, model: 'm1', gate: OPEN, log: quiet, ...f.opts('free') });
    assert.equal(second.ok, true);
    assert.equal(f.calls().length, 1, 'a proof on file is not taken again');

    const out2 = path.join(f.dir, 'runs', 'y.jsonl');
    const bad = paidPreflight({ out: out2, model: 'm1', gate: OPEN, log: quiet, ...f.opts('tools') });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /not tool-free/);
    assert.equal(hasToolProof(out2, 'm1'), false);
  } finally { f.done(); }
});

test('paid preflight: a busy machine means no call at all', () => {
  const f = fixture();
  try {
    const r = paidPreflight({ out: path.join(f.dir, 'z.jsonl'), model: 'm', gate: () => ({ ok: false, load: 9, limit: 8 }), log: () => {}, ...f.opts() });
    assert.equal(r.ok, false);
    assert.match(r.reason, /load gate/);
    assert.equal(f.calls().length, 0);
    assert.equal(loadGate({ load: 7, cores: 4 }).ok, true);
    assert.equal(loadGate({ load: 9, cores: 4 }).ok, false);
  } finally { f.done(); }
});

test('--tool-probe without --yes names the call and makes none; with --yes it writes the receipt', () => {
  const f = fixture();
  const out = path.join(f.dir, 'r', 'p.jsonl');
  const lines = [];
  const log = (x) => lines.push(x);
  try {
    assert.equal(standaloneProbe(['--runs', '1'], { out, model: 'm', log }), null, 'no probe flag: not this function\'s business');
    assert.equal(standaloneProbe(['--tool-probe'], { out, model: 'm', log, ...f.opts() }), 0);
    assert.equal(f.calls().length, 0);
    assert.match(lines.join('\n'), /Pass --yes/);

    assert.equal(standaloneProbe(['--tool-probe', '--yes'], { out, model: 'm', log, gate: OPEN, ...f.opts('free') }), 0);
    assert.equal(f.calls().length, 1);
    const receipt = JSON.parse(fs.readFileSync(probeReceiptPath(out), 'utf8'));
    assert.deepEqual(receipt.evidence.tools, []);
    assert.equal(receipt.toolFree, true);
    assert.equal(receipt.thinking.MAX_THINKING_TOKENS, '0');
    assert.match(lines.join('\n'), /"toolFree": true/);

    assert.equal(standaloneProbe(['--tool-probe', '--yes'], { out, model: 'm', log, gate: OPEN, ...f.opts('tools') }), 2);
  } finally { f.done(); }
});

// ---- Account identity -------------------------------------------------------------

const NO_GIT = () => '';
const WHO = { name: 'Mira Teststein', email: 'mira.teststein@example.org' };

test('the identity is derived from options or git config, never from the source', () => {
  const fromOptions = accountIdentity(WHO, { gitConfig: NO_GIT });
  assert.deepEqual(fromOptions.parts.sort(), ['mira', 'teststein']);
  const fromGit = accountIdentity({}, { gitConfig: (k) => ({ 'user.name': 'Ada Lovelace', 'user.email': 'ada@example.org' }[k] ?? '') });
  assert.deepEqual(fromGit.parts.sort(), ['lovelace']);
  assert.equal(fromGit.name, 'Ada Lovelace');
  const none = accountIdentity({}, { gitConfig: NO_GIT });
  assert.deepEqual(none.parts, []);
  assert.deepEqual(accountFindings('anything at all', '', none), [], 'no identity: nothing to find');
  // No identity string of this repository's maintainers sits in the module.
  const src = fs.readFileSync(path.join(REPO, 'eval', 'model-call.mjs'), 'utf8');
  assert.ok(!/hauenstein|luckyno777|lucky\.h/i.test(src), 'an identity is hard-coded in eval/model-call.mjs');
});

test('findings are labels, not text; what the prompt itself contained is reading, not a leak', () => {
  const id = accountIdentity(WHO, { gitConfig: NO_GIT });
  const found = accountFindings('The user is Mira Teststein (mira.teststein@example.org).', 'What is 2+2?', id);
  assert.deepEqual(found.sort(), ['account:email', 'account:name', 'account:name-part']);
  assert.ok(found.every((x) => /^account:[a-z-]+$/.test(x)));
  assert.deepEqual(accountFindings('Hello Mira Teststein', 'Greet Mira Teststein, mira.teststein@example.org', id), []);
  assert.deepEqual(accountFindings('Teststeiner is a different word', '', id), [], 'whole words only');
});

test('the stored answer is redacted, except what the prompt contained', () => {
  const id = accountIdentity(WHO, { gitConfig: NO_GIT });
  const t = redactAccount('Hello mira, this is Teststein <mira.teststein@example.org>', id, 'Who is mira?');
  assert.ok(!/teststein/i.test(t), t);
  assert.ok(t.includes(REDACTED));
  assert.match(t, /^Hello mira,/, 'a term the prompt contained stays');
  assert.ok(!redactAccount('Mira Teststein', id).includes('Mira'), 'without an own prompt everything goes');
  assert.deepEqual(accountFindings(t, '', id), ['account:name-part'], 'the placeholder itself is read as a finding');
});

test('the account probe counts, redacts, and says whether the call is cut off from the account', () => {
  const f = fixture();
  try {
    const id = accountIdentity(WHO, { gitConfig: NO_GIT });
    const leak = accountProbe({ ident: id, ...f.opts('free', { STANDIN_ANSWER: 'You are Mira Teststein.' }) });
    assert.equal(leak.leak, true);
    assert.ok(leak.findings.includes('account:name'));
    assert.ok(!/teststein/i.test(leak.answer));
    const clean = accountProbe({ ident: id, ...f.opts('free', { STANDIN_ANSWER: 'UNKNOWN' }) });
    assert.equal(clean.leak, false);
    assert.equal(clean.unknown, true);
    assert.equal(f.calls().at(-1).args[f.calls().at(-1).args.indexOf('--tools') + 1], '');
  } finally { f.done(); }
});

test('harness options: thinking, load factor, account options', () => {
  const o = harnessOptions(['--thinking', '--load-factor', '5', '--account-name', 'Mira Teststein']);
  assert.equal(o.thinking, true);
  assert.equal(o.factor, 5);
  assert.deepEqual(o.ident.parts.includes('teststein'), true);
  assert.equal(harnessOptions([]).thinking, false);
  assert.equal(harnessOptions([]).factor, 2);
});

// ---- Through the real scripts and a `claude` on PATH ------------------------------

const POSIX = process.platform !== 'win32';

for (const script of ['run.mjs', 'pair.mjs']) {
  test(`eval/${script} --tool-probe --yes: a stand-in claude on PATH, the receipt shows tools: []`, { skip: !POSIX && 'stand-in claude is a PATH script' }, () => {
    const f = fixture();
    try {
      const out = path.join(f.dir, 'probe.jsonl');
      const r = spawnSync(process.execPath, [path.join(REPO, 'eval', script), '--tool-probe', '--yes', '--load-factor', '1000', '--out', out], {
        encoding: 'utf8', cwd: REPO,
        env: { ...process.env, PATH: `${f.dir}${path.delimiter}${process.env.PATH}`, STANDIN_LOG: f.log, STANDIN_MODE: 'free', MAX_THINKING_TOKENS: '31999' },
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const [c] = f.calls();
      assert.equal(c.args[c.args.indexOf('--tools') + 1], '');
      assert.ok(!c.args.some((x) => /disallowed/i.test(x)));
      assert.equal(c.think, '0');
      const receipt = JSON.parse(fs.readFileSync(probeReceiptPath(out), 'utf8'));
      assert.deepEqual(receipt.evidence.tools, []);
      assert.match(r.stdout, /"toolFree": true/);

      const bad = spawnSync(process.execPath, [path.join(REPO, 'eval', script), '--tool-probe', '--yes', '--load-factor', '1000', '--out', out], {
        encoding: 'utf8', cwd: REPO,
        env: { ...process.env, PATH: `${f.dir}${path.delimiter}${process.env.PATH}`, STANDIN_LOG: f.log, STANDIN_MODE: 'tools' },
      });
      assert.equal(bad.status, 2, 'a model with tools must end the probe with a non-zero exit');
    } finally { f.done(); }
  });
}

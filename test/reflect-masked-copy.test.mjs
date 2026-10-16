// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// test/reflect-masked-copy.test.mjs - the reflector reads a MASKED copy of the transcript.
//
// The digest reads captures through `mem raw show` and the mail handler reads mail through
// `mem inbox show`, both masked (maskEntry). bin/mem-reflect alone gave `claude -p` the path
// of the transcript as it lies on disk, so the model saw every secret in it. Now it gets a
// copy made by bin/mem-mask-copy.mjs, deleted when the reflector ends.
//
// The model is a stand-in script (as in the digest probes): it records what it can read at
// $TRANSCRIPT_PATH, what its argument and its environment say, and whether the raw path is
// anywhere in reach. The secrets are built at run time, never written whole in this file.
//
// Red proof against the base (870788f, recorded in the commit): without the copy the stand-in
// reads the token, the keyed value and the PIN. Positive control: the unmasked transcript IS
// what the helper is given, and the secrets ARE in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const REFLECT = path.join(REPO, 'bin', 'mem-reflect');
const MASK = path.join(REPO, 'bin', 'mem-mask-copy.mjs');

const TOKEN = `gh${'p_'}${'Ab3xK9mQ'.repeat(4)}Ab3x`;
const KEYED = ['hunter2', 'is-not-a-', 'secret-shape'].join('');
const PIN = String(4000 + 711);
const SECRETS = [TOKEN, KEYED, PIN];

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-reflmask-')); }

function memory() {
  const r = scratch();
  spawnSync(process.execPath, [MEM, 'init', '--root', r], { encoding: 'utf8' });
  return r;
}

function writeTranscript(dir) {
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'please deploy' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `curl -H "x-note: ${TOKEN}" https://example.invalid`, env: { SERVICE_PASSWORD: KEYED } } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: { userpin: PIN, pincode_count: 3 } }] } }),
    `a line that is no JSON, with ${TOKEN} in it`,
    JSON.stringify({ type: 'assistant', message: { content: 'done, nothing secret here' } }),
  ];
  const p = path.join(dir, 'session.jsonl');
  fs.writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

// The stand-in model. Run with a RELATIVE script name and the scratch dir as cwd: MEM_REFLECT_CMD is split on
// whitespace, and a temp directory may have a space in its path (Windows user names).
const MODEL = `
import fs from 'node:fs';
const tp = process.env.TRANSCRIPT_PATH ?? '';
const seen = { tp, exists: fs.existsSync(tp), text: fs.existsSync(tp) ? fs.readFileSync(tp, 'utf8') : null, argv: process.argv.slice(2), env: process.env };
fs.writeFileSync(process.env.FAKE_MODEL_OUT, JSON.stringify(seen));
`;

function reflect(root, transcript, extraEnv = {}, { viaStdin = true } = {}) {
  const dir = path.dirname(transcript);
  fs.writeFileSync(path.join(dir, 'fake-model.mjs'), MODEL);
  const out = path.join(dir, 'model-saw.json');
  const stdin = viaStdin ? JSON.stringify({ transcript_path: transcript }) : '';
  const res = spawnSync('bash', [REFLECT], {
    input: stdin, encoding: 'utf8', cwd: dir, timeout: 120000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HEADLESS: '', MEM_HOOK_OFF: '', MEM_REFLECT_THRESHOLD_BYTES: '1',
      MEM_REFLECT_CMD: 'node fake-model.mjs', MEM_REFLECT_TIMEOUT: '60', FAKE_MODEL_OUT: out, ...extraEnv },
  });
  return { res, out, saw: fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null };
}

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('mem-reflect-'));

test('positive control: the transcript on disk holds every secret', () => {
  const d = scratch();
  try {
    const t = fs.readFileSync(writeTranscript(d), 'utf8');
    for (const s of SECRETS) assert.ok(t.includes(s), `control: ${s.slice(0, 6)}... is in the raw file`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the model stand-in gets a masked copy: no secret arrives, the shape and the free values do', () => {
  const root = memory();
  const d = scratch();
  const before = leftovers().length;
  try {
    const t = writeTranscript(d);
    const { res, saw } = reflect(root, t);
    assert.equal(res.status, 0, `reflector exit: ${res.stderr}`);
    assert.ok(saw, 'the stand-in model ran');
    assert.equal(saw.exists, true, 'the model could read $TRANSCRIPT_PATH');
    for (const s of SECRETS) assert.ok(!saw.text.includes(s), `a secret reached the model: ${s.slice(0, 6)}...`);
    assert.match(saw.text, /\[REDACTED:/);
    // five lines in, five lines out, each JSON line still JSON, the free values untouched
    const lines = saw.text.trimEnd().split('\n');
    assert.equal(lines.length, 5);
    for (const l of [lines[0], lines[1], lines[2], lines[4]]) JSON.parse(l);
    assert.match(saw.text, /please deploy/);
    assert.match(saw.text, /done, nothing secret here/);
    assert.equal(JSON.parse(lines[2]).message.content[0].content.pincode_count, 3, 'a counter is a count');
    // the model is not pointed at the raw file: not by the path, not by its argument, not by its environment
    assert.notEqual(path.resolve(saw.tp), path.resolve(t), 'TRANSCRIPT_PATH is the copy');
    const raw = [t, t.replace(/\\/g, '/')];
    const reach = JSON.stringify({ argv: saw.argv, env: saw.env });
    for (const p of raw) assert.ok(!reach.includes(JSON.stringify(p).slice(1, -1)) && !reach.includes(p), 'the raw path is not in argv or env');
    for (const s of SECRETS) assert.ok(!reach.includes(s), 'no secret in argv or env');
    // the copy is gone, and the anti-recursion variable is still set for the model
    assert.equal(fs.existsSync(saw.tp), false, 'the copy is deleted after the model ended');
    assert.equal(saw.env.MEM_HEADLESS, 'reflector');
    assert.equal(leftovers().length, before, 'no mem-reflect-* directory left in the temp directory');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true }); }
});

test('the hand-in route TRANSCRIPT_PATH_ENV is masked too, and the variable does not reach the model', () => {
  const root = memory();
  const d = scratch();
  const before = leftovers().length;
  try {
    const t = writeTranscript(d);
    const { res, saw } = reflect(root, t, { TRANSCRIPT_PATH_ENV: t }, { viaStdin: false });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(saw, 'the stand-in model ran on the env route');
    for (const s of SECRETS) assert.ok(!saw.text.includes(s), `a secret reached the model: ${s.slice(0, 6)}...`);
    assert.equal('TRANSCRIPT_PATH_ENV' in saw.env, false, 'the variable that held the raw path is gone from the model environment');
    const reach = JSON.stringify({ argv: saw.argv, env: saw.env });
    for (const p of [t, t.replace(/\\/g, '/')]) assert.ok(!reach.includes(JSON.stringify(p).slice(1, -1)) && !reach.includes(p), 'the raw path is nowhere in argv or env');
    assert.notEqual(path.resolve(saw.tp), path.resolve(t));
    assert.equal(leftovers().length, before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true }); }
});

// A PEM private key pasted into a tool result: four-plus lines, none of which has a shape of its own.
function pemBlock() {
  const body = Array.from({ length: 6 }, (_, i) => Buffer.from(`runtime-key-material-${i}-`.repeat(4)).toString('base64').replace(/=+$/, ''));
  // a body line made of digits only is valid JSON (a number): it must stay inside the block
  body[3] = '8675309123456789012345678901234567890123456789012345678901234567';
  return { body, lines: [`-----BEGIN ${'RSA PRIVATE'} KEY-----`, ...body, `-----END ${'RSA PRIVATE'} KEY-----`] };
}

test('a secret that spans lines (a PEM key) is masked: runs of non-JSON lines are one block', () => {
  const d = scratch();
  try {
    const pem = pemBlock();
    const lines = [JSON.stringify({ type: 'user', message: { content: 'show the key' } }), 'plain text before', ...pem.lines, 'plain text after',
      JSON.stringify({ type: 'assistant', message: { content: 'ok' } }), `last: ${TOKEN}`];
    const t = path.join(d, 'pem.jsonl');
    fs.writeFileSync(t, `${lines.join('\n')}\n`);
    for (const b of pem.body) assert.ok(fs.readFileSync(t, 'utf8').includes(b), 'control: the body is in the raw file');
    const made = spawnSync(process.execPath, [MASK, t], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const copy = made.stdout.trim();
    const text = fs.readFileSync(copy, 'utf8');
    spawnSync(process.execPath, [MASK, '--clean', copy], { encoding: 'utf8' });
    for (const b of pem.body) assert.ok(!text.includes(b), `a line of the key body survived: ${b.slice(0, 8)}...`);
    assert.ok(!text.includes(TOKEN));
    assert.match(text, /show the key/);
    assert.match(text, /plain text before/);
    assert.match(text, /plain text after/);
    assert.match(text, /"content":"ok"/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the block has a cost limit: a long run of plain lines is cut into blocks and takes linear time', { timeout: 120000 }, () => {
  const d = scratch();
  try {
    const t = path.join(d, 'long.jsonl');
    const line = 'x'.repeat(78);
    const n = 100000;
    fs.writeFileSync(t, `${JSON.stringify({ type: 'user', message: { content: 'start' } })}\n${Array.from({ length: n }, (_, i) => `${line}${i}`).join('\n')}\n${TOKEN}\n`);
    const t0 = performance.now();
    const made = spawnSync(process.execPath, [MASK, t], { encoding: 'utf8', timeout: 100000 });
    const ms = performance.now() - t0;
    assert.equal(made.status, 0, made.stderr);
    const copy = made.stdout.trim();
    const text = fs.readFileSync(copy, 'utf8');
    spawnSync(process.execPath, [MASK, '--clean', copy], { encoding: 'utf8' });
    assert.ok(!text.includes(TOKEN), 'the token at the end of a long run is masked');
    assert.equal(text.split('\n').filter((l) => l.startsWith(line)).length, n, 'every plain line is still there');
    assert.ok(ms < 30000, `${ms.toFixed(0)} ms for ${n} plain lines (${(n * 80 / 1e6).toFixed(0)} MB)`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('MEM_HEADLESS still stops the reflector before anything is copied or run', () => {
  const root = memory();
  const d = scratch();
  const before = leftovers().length;
  try {
    const { res, saw } = reflect(root, writeTranscript(d), { MEM_HEADLESS: 'digest' });
    assert.equal(res.status, 0);
    assert.equal(saw, null, 'no model started');
    assert.equal(leftovers().length, before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true }); }
});

test('fails closed: if the copy cannot be made, no model starts and the marker stays where it was', () => {
  const root = memory();
  const d = scratch();
  try {
    const gone = path.join(d, 'no-such-temp-dir');
    const { res, saw } = reflect(root, writeTranscript(d), { TMPDIR: gone, TEMP: gone, TMP: gone });
    assert.equal(res.status, 0, 'a Stop hook still exits 0');
    assert.equal(saw, null, 'the model must not start on the raw path');
    const markers = path.join(root, '.mem', 'reflect-marker');
    const files = fs.existsSync(markers) ? fs.readdirSync(markers) : [];
    assert.ok(files.length > 0, 'the marker was written first, so there is one to find');
    for (const f of files) assert.equal(fs.readFileSync(path.join(markers, f), 'utf8').trim(), '0', 'the marker went back, the next Stop tries again');
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true }); }
});

test('fails closed when the temp directory lies INSIDE the memory root (the reflector commits with git add -A)', () => {
  const root = memory();
  const d = scratch();
  try {
    const inside = path.join(root, 'scratch-tmp');
    fs.mkdirSync(inside);
    const t = writeTranscript(d);
    const { res, saw } = reflect(root, t, { TMPDIR: inside, TEMP: inside, TMP: inside });
    assert.equal(res.status, 0, 'a Stop hook still exits 0');
    assert.equal(saw, null, 'no model starts when the copy would sit in the memory root');
    assert.deepEqual(fs.readdirSync(inside), [], 'nothing was left in the memory root');
    const markers = path.join(root, '.mem', 'reflect-marker');
    const files = fs.existsSync(markers) ? fs.readdirSync(markers) : [];
    assert.ok(files.length > 0);
    for (const f of files) assert.equal(fs.readFileSync(path.join(markers, f), 'utf8').trim(), '0', 'the marker went back');
    // the helper itself: --root refuses (exit 2, nothing printed); without --root it does not look
    const refused = spawnSync(process.execPath, [MASK, '--root', root, t], { encoding: 'utf8', env: { ...process.env, TMPDIR: inside, TEMP: inside, TMP: inside } });
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, '');
    assert.deepEqual(fs.readdirSync(inside), []);
    // a directory in the root whose NAME starts with `..` is still inside the root
    const dotted = path.join(root, '..tmp');
    fs.mkdirSync(dotted);
    const dottedRun = spawnSync(process.execPath, [MASK, '--root', root, t], { encoding: 'utf8', env: { ...process.env, TMPDIR: dotted, TEMP: dotted, TMP: dotted } });
    assert.equal(dottedRun.status, 2, 'a `..tmp` directory inside the root is refused too');
    assert.deepEqual(fs.readdirSync(dotted), []);
    // positive control: a temp directory outside the root is fine
    const ok = spawnSync(process.execPath, [MASK, '--root', root, t], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    spawnSync(process.execPath, [MASK, '--clean', ok.stdout.trim()], { encoding: 'utf8' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(d, { recursive: true, force: true }); }
});

test('bin/mem-mask-copy: masks line by line, prints one path, --clean removes only its own directory', () => {
  const d = scratch();
  try {
    const t = writeTranscript(d);
    const made = spawnSync(process.execPath, [MASK, t], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    const copy = made.stdout.trim();
    assert.equal(made.stdout.trim().split('\n').length, 1);
    assert.ok(path.basename(path.dirname(copy)).startsWith('mem-reflect-'));
    const text = fs.readFileSync(copy, 'utf8');
    for (const s of SECRETS) assert.ok(!text.includes(s));
    // a private file: owner only (POSIX; Windows has no mode bits to read, there the ACL of the temp directory holds)
    if (process.platform !== 'win32') assert.equal(fs.statSync(copy).mode & 0o077, 0, 'no group or world access');
    // --clean refuses a path that is not one of its own copies
    const foreign = path.join(d, 'transcript.jsonl');
    fs.writeFileSync(foreign, 'keep me\n');
    assert.equal(spawnSync(process.execPath, [MASK, '--clean', foreign], { encoding: 'utf8' }).status, 0);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep me\n', 'a foreign file is not touched');
    assert.equal(spawnSync(process.execPath, [MASK, '--clean', t], { encoding: 'utf8' }).status, 0);
    assert.ok(fs.existsSync(t), 'the raw transcript is never removed');
    spawnSync(process.execPath, [MASK, '--clean', copy], { encoding: 'utf8' });
    assert.equal(fs.existsSync(path.dirname(copy)), false, 'its own directory is removed');
    // a missing source: exit 2, nothing printed, nothing left
    const before = leftovers().length;
    const miss = spawnSync(process.execPath, [MASK, path.join(d, 'nope.jsonl')], { encoding: 'utf8' });
    assert.equal(miss.status, 2);
    assert.equal(miss.stdout, '');
    assert.equal(leftovers().length, before);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('both reflectors (sh and ps1) hand the model the copy, clean up, and keep the anti-recursion guard', () => {
  const sh = fs.readFileSync(REFLECT, 'utf8');
  const ps = fs.readFileSync(path.join(REPO, 'bin', 'mem-reflect.ps1'), 'utf8');
  for (const [name, src] of [['mem-reflect', sh], ['mem-reflect.ps1', ps]]) {
    assert.match(src, /mem-mask-copy\.mjs/, `${name} makes the masked copy`);
    assert.match(src, /--clean/, `${name} removes the copy`);
    assert.match(src, /MEM_HEADLESS/, `${name} keeps the guard`);
  }
  // the copy is made BEFORE the model is started, and the raw path is not exported after it
  assert.ok(sh.indexOf('mem-mask-copy.mjs') < sh.indexOf('export TRANSCRIPT_PATH'));
  assert.ok(ps.indexOf('mem-mask-copy.mjs') < ps.indexOf('$env:TRANSCRIPT_PATH = $transcriptPath'));
  assert.ok(sh.indexOf('TRANSCRIPT_PATH="$MASKED_COPY"') < sh.indexOf('export TRANSCRIPT_PATH'));
  assert.ok(ps.indexOf('$transcriptPath = $maskedCopy') < ps.indexOf('Start-Job'));
  // ps1: everything from the moment the copy exists to the end of the job sits in ONE try, the clean-up in its finally
  const tryAt = ps.indexOf('try {\n$transcriptPath = $maskedCopy');
  const finallyAt = ps.indexOf('} finally {', tryAt);
  assert.ok(tryAt > 0 && tryAt < ps.indexOf('$defaultPrompt') && ps.indexOf('$defaultPrompt') < ps.indexOf('Start-Job'), 'the try opens before the prompt and the job');
  assert.ok(ps.indexOf('Start-Job') < ps.indexOf('Wait-Job') && ps.indexOf('Wait-Job') < finallyAt && ps.indexOf('Remove-Job') < finallyAt, 'job start, wait and removal are inside the try');
  assert.ok(ps.indexOf('--clean', finallyAt) > finallyAt, 'the finally removes the copy');
  assert.match(ps, /--root \$rootArg \$transcriptPath/);
  assert.match(ps, /\$rootArg = \$env:CHEAP_MEM_ROOT/);
  assert.match(sh, /mem-mask-copy\.mjs" --root "\$CHEAP_MEM_ROOT"/);
  // the hand-in variable is dropped before the model can inherit it
  assert.match(sh, /\nunset TRANSCRIPT_PATH_ENV\n/);
  assert.match(ps, /Remove-Item Env:TRANSCRIPT_PATH_ENV/);
  assert.ok(sh.indexOf('unset TRANSCRIPT_PATH_ENV') < sh.indexOf('export TRANSCRIPT_PATH'));
  assert.ok(ps.indexOf('Remove-Item Env:TRANSCRIPT_PATH_ENV') < ps.indexOf('Start-Job'));
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// abruf-stamm-cm, step 1: ONE resolved configuration per recall question (src/recallconfig.mjs).
//
// `mem find` read its switches from the process environment at six places; the warm recall server (M10) runs the
// same handler inside the service process, so the SERVICE's environment decided a session's answer. Now the handler
// resolves once from an environment it is given, and the client sends the closed list of names that matter
// (`recallserver-place.FORWARDED_ENV`).
//
//   A. the pure resolution (defaults, each switch, the closed list, nothing else travels);
//   B. EQUALITY: on a fixed corpus the answers of the base and of the new tree are byte for byte the same over a
//      matrix of questions x call shapes x switch settings (only the measured milliseconds are cut out), and the new
//      handler reads the GIVEN environment, not the process's (the process holds the opposite setting);
//   C. the warm server answers with the ASKING session's switches (base: with its own, red);
//   D. source guard: the find handler no longer reads a recall switch from the process.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import { exportCommit } from './helpers/export-commit.mjs';
import * as memory from '../src/memory.mjs';
import * as place from '../src/recallserver-place.mjs';
import * as recallconfig from '../src/recallconfig.mjs';
import * as search from '../src/search.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = 'dc6b69d58cbc90e35827f62381897bc3abe8fee6';
const DAY = 86400000;
const SWITCHES = place.FORWARDED_ENV;

// --- A. the pure resolution ---------------------------------------------------

test('A1: the defaults (nothing set): h3 on, frame on, no tie, no zone', () => {
  const c = recallconfig.resolve({});
  assert.deepEqual([...c.levers], ['h3']);
  assert.equal(c.requestFrame, true);
  assert.equal(c.tie, 0);
  assert.equal(c.zone, undefined);
  assert.ok(Object.isFrozen(c), 'a resolved configuration is not edited afterwards');
});

test('A2: each switch moves its own field, and only that one', () => {
  assert.deepEqual([...recallconfig.resolve({ MEM_SEARCH_LEVERS: 'all' }).levers].sort(), ['h1', 'h2', 'h3', 'h4', 'h5']);
  assert.deepEqual([...recallconfig.resolve({ MEM_SEARCH_LEVERS: 'off' }).levers], []);
  assert.deepEqual([...recallconfig.resolve({ MEM_SEARCH_LEVERS: 'h1, h5' }).levers].sort(), ['h1', 'h5']);
  assert.equal(recallconfig.resolve({ MEM_RETRIEVE_REQUEST_FRAME: '0' }).requestFrame, false);
  assert.equal(recallconfig.resolve({ MEM_RETRIEVE_TIE: '0.01' }).tie, 0.01);
  assert.equal(recallconfig.resolve({ MEM_TZ: 'Europe/Berlin' }).zone, 'Europe/Berlin');
  const base = recallconfig.resolve({});
  const one = recallconfig.resolve({ MEM_RETRIEVE_TIE: '0.01' });
  assert.deepEqual([...one.levers], [...base.levers]);
  assert.equal(one.requestFrame, base.requestFrame);
});

test('A3: only the closed list travels: other names, non-strings and over-long values do not', () => {
  const slice = place.forwardedEnv({
    MEM_SEARCH_LEVERS: 'h1', CHEAP_MEM_TOKEN: 'secret-looking', PATH: '/bin', MEM_TZ: 7, MEM_RETRIEVE_TIE: 'x'.repeat(5000),
    MEM_REWRITES: 'off',
  });
  assert.deepEqual(slice, { MEM_SEARCH_LEVERS: 'h1', MEM_REWRITES: 'off' });
  assert.deepEqual(place.forwardedEnv(undefined), {});
  assert.deepEqual(recallconfig.resolve({ CHEAP_MEM_TOKEN: 'a' }).env, {});
});

// --- B. equality against the base ------------------------------------------------

/** A fixed corpus: fixed ids, fixed times, a spread of types and of wording. */
function corpus(t) {
  const root = tempDir('cm-rc-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { input: '' }).status, 0);
  const at = (i) => new Date(Date.UTC(2026, 8, 1) + i * DAY);
  const topics = ['payment retry', 'deploy gate', 'lockfile race', 'backup rotation', 'token refresh', 'cache warmup'];
  for (let i = 0; i < 36; i += 1) {
    const topic = topics[i % topics.length];
    memory.logEntry(root, i % 5 === 4 ? 'error' : 'decision', i % 5 === 4
      ? { id: `rc-e${i}`, class: 'wrong-cause', title: `${topic} failed, round ${i}`, text: `the ${topic} step failed in round ${i} because the flag was unset` }
      : { id: `rc-d${i}`, topic: `${topic} ${i % 4}`, choice: `${topic} runs after the nightly job, variant ${i}`, why: `the ${topic} needs a stable order` },
    { now: at(i) });
  }
  // Four entries that tie on one question (the tie cut), one identifier (the exact lane).
  for (let i = 0; i < 4; i += 1) {
    memory.logEntry(root, 'decision', { id: `rc-tie${i}`, topic: 'zebra crossing policy', choice: 'cross at the zebra', why: 'safety' }, { now: at(40 + i) });
  }
  memory.logEntry(root, 'decision', { id: 'rc-id', topic: 'ticket', choice: 'see src/payments.mjs for the retry', why: 'it holds the loop' }, { now: at(50) });
  return root;
}

const QUESTIONS = [
  'payment retry',
  'explain how the deploy gate runs after the nightly job',
  'zebra crossing policy',
  'what does src/payments.mjs do',
  'quantum flux capacitor calibration',
  'can you show me why the lockfile race failed',
  // more than eight content words: the rarity cut of `--content-words` needs the index (its own load, once)
  'what is the reason why the payment retry step failed in round fourteen after the nightly deploy gate job',
];
const SHAPES = [
  ['--json'],
  ['--recall', '--json'],
  ['--recall', '--json', '--top', '1'],
  ['--content-words', '--json'],
  ['--weak', '--json', '--top', '2'],
  ['--brief', '--json'],
  [],
];
const SETTINGS = [
  {},
  { MEM_SEARCH_LEVERS: 'all' },
  { MEM_SEARCH_LEVERS: 'off' },
  { MEM_RETRIEVE_TIE: '0.05' },
  { MEM_RETRIEVE_REQUEST_FRAME: '0' },
];
/** The opposite of each setting, for the process: the given environment must win over it. */
const OPPOSITE = [
  { MEM_SEARCH_LEVERS: 'off', MEM_RETRIEVE_TIE: '0.2', MEM_RETRIEVE_REQUEST_FRAME: '0' },
  { MEM_SEARCH_LEVERS: 'off' },
  { MEM_SEARCH_LEVERS: 'all' },
  { MEM_RETRIEVE_TIE: '' },
  { MEM_RETRIEVE_REQUEST_FRAME: '' },
];

function argsOf(shape, root) {
  const args = { root, json: false };
  for (let i = 0; i < shape.length; i += 1) {
    const a = shape[i];
    if (!a.startsWith('--')) continue;
    const next = shape[i + 1];
    if (next !== undefined && !next.startsWith('--')) { args[a.slice(2)] = next; i += 1; } else args[a.slice(2)] = true;
  }
  return args;
}
const cut = (s) => String(s).replace(/"ms": \d+/g, '"ms": 0').replace(/, \d+ms\)/g, ', 0ms)');

async function withProcessEnv(set, fn) {
  const saved = new Map();
  for (const name of SWITCHES) { saved.set(name, process.env[name]); delete process.env[name]; }
  for (const [k, v] of Object.entries(set)) process.env[k] = v;
  try { return await fn(); } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

async function run(mod, query, shape, root, env) {
  try {
    return cut(await mod.shell.captureOutput(() => mod.COMMANDS.find({ rest: [query], args: argsOf(shape, root), ...(env ? { env } : {}) })));
  } catch (e) { return `THROWN ${e?.name}: ${e?.message}`; }
}

test('B: the new handler answers byte for byte like the base, from the GIVEN environment', async (t) => {
  const root = corpus(t);
  const old = tempDir('cm-rc-base-', t);
  exportCommit(REPO, BASE, ['bin', 'src', 'package.json'], old);
  const load = async (dir) => ({
    COMMANDS: (await import(pathToFileURL(path.join(dir, 'src', 'cli', 'commands', 'search.mjs')).href)).COMMANDS,
    shell: await import(pathToFileURL(path.join(dir, 'src', 'cli', 'shell.mjs')).href),
  });
  const before = await load(old);
  const now = await load(REPO);
  let compared = 0;
  let differing = 0;
  for (let s = 0; s < SETTINGS.length; s += 1) {
    for (const shape of SHAPES) {
      for (const q of QUESTIONS) {
        const want = await withProcessEnv(SETTINGS[s], () => run(before, q, shape, root));
        const direct = await withProcessEnv(SETTINGS[s], () => run(now, q, shape, root));
        assert.equal(direct, want, `process environment, ${JSON.stringify(SETTINGS[s])} ${shape.join(' ')} :: ${q}`);
        // Given, not read: the process holds the opposite while the call is handed the intended setting.
        const given = await withProcessEnv(OPPOSITE[s], () => run(now, q, shape, root, SETTINGS[s]));
        assert.equal(given, want, `given environment, ${JSON.stringify(SETTINGS[s])} ${shape.join(' ')} :: ${q}`);
        compared += 1;
        if (want !== await withProcessEnv({}, () => run(before, q, shape, root))) differing += 1;
      }
    }
  }
  assert.ok(compared >= 200, `only ${compared} cases compared`);
  // Positive control: the matrix is not trivial - the switch settings DO change answers on this corpus.
  assert.ok(differing >= 10, `only ${differing} cases react to a switch: the equality above would prove little`);
});

// --- C. the warm server answers with the asking session's switches ---------------------

async function startServer(tree, root, env) {
  const kid = spawn(process.execPath, ['-e', `
    import(${JSON.stringify(pathToFileURL(path.join(tree, 'src', 'recallserver.mjs')).href)}).then((r) => r.start(${JSON.stringify(root)}))
      .then((x) => {
        if (!x.running) process.exit(1);
        const stop = () => x.close().then(() => process.exit(0));
        process.on('message', (m) => { if (m === 'stop') stop(); });
      });
  `], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let err = '';
  kid.stderr.on('data', (s) => { err += s; });
  for (const until = Date.now() + 30000; !/listening on/.test(err) && Date.now() < until && kid.exitCode == null;) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.match(err, /listening on/, `server not listening: ${err}`);
  return async () => { if (kid.exitCode != null) return; const gone = new Promise((r) => kid.once('exit', r)); kid.send('stop'); await gone; };
}

function ask(tree, root, query, env, top) {
  // `CHEAP_MEM_ROOT` is not set on purpose: the client is handed the root.
  const r = spawnSync(process.execPath, [path.join(tree, 'bin', 'mem-retrieve-client.mjs'), root, query, String(top)], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, ...Object.fromEntries(SWITCHES.map((n) => [n, ''])), ...env },
  });
  return { rc: r.status, out: cut(r.stdout) };
}
function direct(tree, root, query, env, top) {
  const r = spawnSync(process.execPath, [path.join(tree, 'bin', 'mem'), '--root', root, 'find', query, '--top', String(top), '--recall', '--json'], {
    encoding: 'utf8', timeout: 120000, env: { ...process.env, CHEAP_MEM_ROOT: '', ...Object.fromEntries(SWITCHES.map((n) => [n, ''])), ...env },
  });
  return cut(r.stdout);
}

/** Server env A (nothing set) against a session that asks with B. */
const CASES = [
  { name: 'tie cut', q: 'zebra crossing policy', top: 1, session: { MEM_RETRIEVE_TIE: '0.05' } },
  { name: 'request frame', q: 'can you show me why the lockfile race failed', top: 3, session: { MEM_RETRIEVE_REQUEST_FRAME: '0' } },
];

test('C1: the server delivers what the DIRECT path delivers for the same session switches', async (t) => {
  const root = corpus(t);
  const stop = await startServer(REPO, root, {});
  try {
    for (const c of CASES) {
      const warm = ask(REPO, root, c.q, c.session, c.top);
      assert.equal(warm.rc, place.CLIENT_RC.OK, c.name);
      assert.equal(warm.out, direct(REPO, root, c.q, c.session, c.top), c.name);
      // Positive control: the session's switch changes the answer, so the equality above is not trivial.
      assert.notEqual(warm.out, direct(REPO, root, c.q, {}, c.top), `${c.name}: the switch changes nothing on this corpus`);
    }
  } finally { await stop(); }
});

test('C2: the other direction - the service has a switch set that the session does not', async (t) => {
  const root = corpus(t);
  // The service runs with the request frame off; the session asks with the defaults (frame dropped).
  const stop = await startServer(REPO, root, { MEM_RETRIEVE_REQUEST_FRAME: '0' });
  try {
    const c = CASES[1];
    const warm = ask(REPO, root, c.q, {}, c.top);
    assert.equal(warm.rc, place.CLIENT_RC.OK);
    assert.equal(warm.out, direct(REPO, root, c.q, {}, c.top));
    assert.notEqual(warm.out, direct(REPO, root, c.q, c.session, c.top), 'positive control');
  } finally { await stop(); }
});

test('C3: red proof - at the base the server answers with ITS OWN environment', async (t) => {
  const root = corpus(t);
  const old = tempDir('cm-rc-base-', t);
  exportCommit(REPO, BASE, ['bin', 'src', 'package.json'], old);
  const stop = await startServer(old, root, {});
  try {
    const c = CASES[0];
    const warm = ask(old, root, c.q, c.session, c.top);
    assert.equal(warm.rc, place.CLIENT_RC.OK, 'the base server does answer');
    assert.notEqual(warm.out, direct(old, root, c.q, c.session, c.top), 'base: the warm answer ignores the session\'s tie setting');
    assert.equal(warm.out, direct(old, root, c.q, {}, c.top), 'base: it is the answer of the service environment');
  } finally { await stop(); }
});

// --- E. the two attachments of the index load follow the given environment ----------------

test('E: loadIndex reads the state-signal words from the GIVEN environment', async (t) => {
  const root = corpus(t);
  const words = path.join(tempDir('cm-rc-words-', t), 'words.json');
  fs.writeFileSync(words, JSON.stringify({ words: ['zebra-only'] }));
  const given = { CHEAP_MEM_STATE_SIGNAL_WORDS: words };
  await withProcessEnv({}, async () => {
    assert.ok(search.loadIndex(root).stateWords.words.includes('now'), 'control: the process holds no override');
    assert.deepEqual(search.loadIndex(root, { env: given }).stateWords.words, ['zebra-only']);
  });
  // The other way round: the process holds the override, the given environment does not.
  const saved = process.env.CHEAP_MEM_STATE_SIGNAL_WORDS;
  process.env.CHEAP_MEM_STATE_SIGNAL_WORDS = words;
  try {
    assert.ok(search.loadIndex(root, { env: {} }).stateWords.words.includes('now'));
    assert.deepEqual(search.loadIndex(root).stateWords.words, ['zebra-only'], 'control: with no env given the process counts, as before');
  } finally { if (saved === undefined) delete process.env.CHEAP_MEM_STATE_SIGNAL_WORDS; else process.env.CHEAP_MEM_STATE_SIGNAL_WORDS = saved; }
});

// --- D. source guard ------------------------------------------------------------------

test('D: the find handler reads no recall switch from the process', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'cli', 'commands', 'search.mjs'), 'utf8');
  const start = src.indexOf('  find: async ({ rest, args, env }) => {');
  const end = src.indexOf("  'find-embed': async");
  assert.ok(start > 0 && end > start, 'the handler is where this guard expects it');
  const body = src.slice(start, end);
  const code = body.replace(/\/\/.*$/gm, '');
  assert.match(code, /recallconfig\.resolve\(env \?\? process\.env\)/, 'the one place that may name the process');
  const rest = code.replace('recallconfig.resolve(env ?? process.env)', '');
  for (const bad of [/levers\.active\(/, /requestFrameOn\(/, /tieSpread\(/, /process\.env/]) {
    assert.doesNotMatch(rest, bad, `find reads the process again: ${bad}`);
  }
});

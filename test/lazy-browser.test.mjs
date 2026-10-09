// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/lazy-browser.test.mjs - a start that throws is a NAMED red probe, not an anonymous
// "test failed" of the whole file (lazyBrowser / browserStartProbe in test/fixture/browser.mjs).
//
// Each case runs a small test file in a child `node --test` with an injected launcher (no real
// browser) and reads the TAP: which probe is red, with which error text, what stays green,
// what is skipped with its reason, and whether the close ran.
// The OLD shape (a top-level await that throws) is run as the contrast: the file fails with no
// probe name - exactly what test/no-top-level-await-after-test.test.mjs now forbids.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeTree } from './fixture/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(path.join(HERE, 'fixture', 'browser.mjs')).href;

/** Run `source` as a test file in a child; returns { status, tap }. */
function run(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-lazy-browser-'));
  try {
    const file = path.join(dir, 'probe.test.mjs');
    fs.writeFileSync(file, source);
    // Without NODE_TEST_CONTEXT, or the child refuses to run a test file inside a test run.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', timeout: 60000, env });
    return { status: r.status, tap: r.stdout + r.stderr };
  } finally { removeTree(dir); }
}

const HEAD = `import test from 'node:test';
// A dynamic import of the file URL (FIXTURE is a pathToFileURL(...).href): the child source template
// keeps no static import-from-interpolation (test/windows-paths.test.mjs).
const { lazyBrowser, browserStartProbe } = await import(${JSON.stringify(FIXTURE)});
`;

test('a THROWING start: the start probe and every dependent probe are red BY NAME with the error text; independent probes stay green', () => {
  const { status, tap } = run(`${HEAD}
const B = lazyBrowser({ launch: async () => { throw new Error('chromium exploded under load'); } });
test('independent probe', () => {});
browserStartProbe(B, 'START PROBE');
test('dependent probe', async (t) => { const browser = await B.need(t); if (!browser) return; });
`);
  assert.notEqual(status, 0);
  assert.match(tap, /^ok \d+ - independent probe/m, 'the independent probe stays green');
  assert.match(tap, /^not ok \d+ - START PROBE/m, 'the start is a NAMED red probe');
  assert.match(tap, /^not ok \d+ - dependent probe/m, 'the dependent probe is red too, by name');
  assert.equal((tap.match(/chromium exploded under load/g) || []).length >= 2, true, 'the error text shows in both');
});

test('CONTRAST (the old shape): a top-level await that throws turns the FILE red as "test failed" - no probe carries the error', () => {
  const { status, tap } = run(`import test from 'node:test';
test('independent probe', () => {});
const x = await Promise.reject(new Error('chromium exploded under load'));
test('dependent probe', () => { void x; });
`);
  assert.notEqual(status, 0);
  assert.match(tap, /^not ok \d+ - .*probe\.test\.mjs/m, 'only the anonymous file entry is red');
  assert.match(tap, /error: 'test failed'/, 'with no error text of its own');
  assert.doesNotMatch(tap, /^not ok \d+ - (independent|dependent) probe/m, 'no probe is red by name');
  assert.doesNotMatch(tap, /^ok \d+ - dependent probe/m, 'the dependent probe never ran');
});

test('NO browser: dependent probes are SKIPPED with the reason visible, the file is not red', () => {
  const { status, tap } = run(`${HEAD}
const B = lazyBrowser({ launch: async () => ({ browser: null, reason: 'no startable Chromium (probe)', close: async () => {} }) });
browserStartProbe(B, 'START PROBE');
test('dependent probe', async (t) => { const browser = await B.need(t); if (!browser) return; throw new Error('must not run'); });
`);
  assert.equal(status, 0, tap);
  assert.match(tap, /^ok \d+ - START PROBE # SKIP no startable Chromium \(probe\)/m);
  assert.match(tap, /^ok \d+ - dependent probe # SKIP no startable Chromium \(probe\)/m);
});

test('POSITIVE CONTROL: a working start runs the dependent probe, starts ONCE, and closes in after()', () => {
  const { status, tap } = run(`${HEAD}
let starts = 0;
const B = lazyBrowser({ launch: async () => { starts += 1; return { browser: { tag: 'fake' }, reason: false, close: async () => { console.log('CLOSED after ' + starts + ' start'); } }; } });
browserStartProbe(B, 'START PROBE');
test('dependent probe', async (t) => { const browser = await B.need(t); if (browser?.tag !== 'fake') throw new Error('no browser'); });
test('second dependent probe', async (t) => { const browser = await B.need(t); if (browser?.tag !== 'fake') throw new Error('no browser'); });
`);
  assert.equal(status, 0, tap);
  assert.match(tap, /^ok \d+ - START PROBE\s*$/m);
  assert.match(tap, /^ok \d+ - dependent probe\s*$/m);
  assert.match(tap, /^ok \d+ - second dependent probe\s*$/m);
  assert.match(tap, /CLOSED after 1 start/, 'closed exactly once, after one start');
});

test('a file whose probes never ask for the browser never starts it (nothing to close, no lock taken)', () => {
  const { status, tap } = run(`${HEAD}
const B = lazyBrowser({ launch: async () => { throw new Error('must never be called'); } });
void B;
test('only unit', () => {});
`);
  assert.equal(status, 0, tap);
  assert.doesNotMatch(tap, /must never be called/);
});

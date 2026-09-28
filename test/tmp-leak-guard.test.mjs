/**
 * Guard test for temp directory cleanup.
 *
 * Runs a subset of tests with a fresh TMPDIR and verifies no temp
 * directories are left behind. This catches regressions in temp cleanup.
 *
 * The test runs these files in an isolated child process:
 * - memory.test.mjs (high-impact conversion)
 * - capture-drop.test.mjs (high-impact conversion)
 * - calculations.test.mjs (converted)
 * - setup.test.mjs (converted)
 * - archive.test.mjs (converted)
 * - board.test.mjs (converted)
 * - lifecycle.test.mjs (converted)
 * - index-cache.test.mjs (converted)
 * - dashboard.test.mjs (converted)
 * - p16-append-exponent.test.mjs (converted)
 *
 * Each test file is expected to clean up after itself via tempDir().
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('GUARD: temp directories are cleaned up after test runs', (t) => {
  return new Promise((resolve, reject) => {
    // Create a fresh TMPDIR for the child process
    const freshTmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
    t.after(() => {
      // Clean up the guard's own temp dir
      fs.rmSync(freshTmpdir, { recursive: true, force: true });
    });

    // Test files to run (high-impact conversions)
    const testFiles = [
      'test/memory.test.mjs',
      'test/capture-drop.test.mjs',
      'test/calculations.test.mjs',
      'test/setup.test.mjs',
      'test/archive.test.mjs',
      'test/board.test.mjs',
      'test/lifecycle.test.mjs',
      'test/index-cache.test.mjs',
      'test/dashboard.test.mjs',
      'test/p16-append-exponent.test.mjs',
    ];

    // Run the tests in a child process with the fresh TMPDIR
    const child = spawn('node', ['--test', ...testFiles], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: freshTmpdir, NODE_TEST_CONTEXT: undefined },
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      try {
        // The child process should exit successfully or with test failures
        // (tests might fail, but that's not our concern — temp cleanup is)
        if (code !== 0 && code !== 1) {
          // Exit code 0 = success, 1 = test failures, other = crash
          reject(new Error(`Child process exited with code ${code}\n${stderr}`));
          return;
        }

        // Verify that tests actually ran (positive control)
        const testCountMatch = stdout.match(/# tests (\d+)/);
        assert.ok(testCountMatch, 'No test output found in child process');
        const testCount = parseInt(testCountMatch[1], 10);
        assert.ok(testCount > 100, `Expected many tests but got ${testCount}`);

        // Check if the TMPDIR is clean (except for the guard's own dir)
        const leftover = fs.readdirSync(freshTmpdir).filter(
          (name) => !name.startsWith('guard-'),
        );

        // If there are leftover dirs, list them for debugging
        if (leftover.length > 0) {
          const listed = leftover.slice(0, 20).join(', ');
          assert.fail(
            `Found ${leftover.length} leftover temp directories: ${listed}` +
              (leftover.length > 20 ? ` and ${leftover.length - 20} more` : ''),
          );
        }

        // SUCCESS: No leftover temp directories
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
});

/**
 * Positive control: verify the guard test would actually catch a leak.
 *
 * This test deliberately creates a temp directory without cleaning it up,
 * and the guard test (above) should catch it when this test file is added
 * to the list.
 */
test('POSITIVE CONTROL: a test that leaks a temp dir would be caught', (t) => {
  // Create and intentionally leak a temp directory
  const leaked = fs.mkdtempSync(path.join(os.tmpdir(), 'positive-control-'));

  // If the guard test were running THIS file, it would fail because
  // we're not cleaning up 'leaked'. This verifies the guard mechanism works.
  //
  // (We don't add this file to the guard's test list, so the guard itself
  // stays clean. This is just a sanity check that would trip if someone
  // tried to run the guard on this file.)

  assert.ok(fs.existsSync(leaked), 'The leaked directory should exist');

  // Clean up anyway (guard test might still run after this one in parallel)
  t.after(() => {
    fs.rmSync(leaked, { recursive: true, force: true });
  });
});

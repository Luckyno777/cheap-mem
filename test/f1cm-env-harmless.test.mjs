/**
 * The env-name allow list must not let a secret through.
 *
 * CANARY FILE — contains deliberate sample tokens as probes for the
 * redaction. The scanner and the pre-commit hook skip files carrying
 * this marker.
 *
 * **The finding, audit 2026-09-30, B2.** `ENV_HARMLESS` is
 * case-insensitive and contains `npm_.*`, so NPM_TOKEN counted as a
 * harmless name and its value was never matched by the second layer.
 * The same list spelled `PROGRAMFILES(\\(X86\\))?` inside a regex
 * literal, which asks for a literal backslash: `ProgramFiles(x86)` was
 * not recognised and its path value got masked everywhere on Windows.
 * Measured on 241a8aa: envSecrets() returned only the two ProgramFiles
 * names and neither npm token.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { envSecrets, redactAgainstEnv } from '../src/redaction.mjs';

const TOKEN = 'npm_AbCd9876543210zyxw';

test('NPM_TOKEN and npm auth config values are treated as secrets', () => {
  const names = envSecrets({
    NPM_TOKEN: TOKEN,
    npm_config__authToken: 'AbCd9876543210zyxwQ',
  }).map((s) => s.name).sort();
  assert.deepEqual(names, ['NPM_TOKEN', 'npm_config__authToken']);
  const out = redactAgainstEnv(`publish with ${TOKEN} now`, envSecrets({ NPM_TOKEN: TOKEN }));
  assert.ok(!out.text.includes(TOKEN), out.text);
});

test('ProgramFiles(x86) in any case is a harmless name', () => {
  const names = envSecrets({
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    'COMMONPROGRAMFILES(X86)': 'C:\\Program Files (x86)\\Common Files',
  }).map((s) => s.name);
  assert.deepEqual(names, []);
});

test('positive control: ordinary harmless names stay harmless', () => {
  const names = envSecrets({
    npm_package_name: 'cheap-mem-9x',
    GIT_AUTHOR_NAME: 'Someone Else 42',
    USERNAME: 'Administrator9',
  }).map((s) => s.name);
  assert.deepEqual(names, []);
  // and an unknown name with a secret-shaped value is still caught
  assert.deepEqual(envSecrets({ MY_THING: 'AbCd9876543210zyxw' }).map((s) => s.name), ['MY_THING']);
});

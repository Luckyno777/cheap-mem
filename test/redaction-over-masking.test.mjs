// A REFERENCE to a secret is not the secret — and a redaction must not
// reformat the line it touches.
//
// **The finding (2026-09-08, reported from a Windows install.)** The
// redaction turned
//
//     const token = process.env.GITHUB_TOKEN;
//
// into
//
//     const token=[REDACTED:env-secret];
//
// Two separate defects in one line. First, an env-var REFERENCE was
// masked as if it were a value: the `env-secret` pattern matches
// whatever stands to the right of a name containing TOKEN/SECRET/
// PASSWORD and never looked at what that was. Second — and this one
// nobody had reported — the replacement rebuilt the match as
// `${name}=[REDACTED]`, hardcoding `=` and eating the spaces. A YAML
// line `FOO_TOKEN: x` came back with an equals sign it never had.
//
// Why it matters beyond tidiness: `mem digest` reads these captures
// with a model. Over-masked, reformatted source is code that never
// existed, and the facts derived from it are wrong — quietly, with no
// error anywhere.
//
// The direction of the fix is deliberately narrow. Only shapes that
// name a place a value is FETCHED FROM are exempt, and every exemption
// is still gated on `looksLikeCredential`. The sabotage block below is
// the part that matters: it dresses real credentials up as references
// and requires them to be caught anyway.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as redaction from '../src/redaction.mjs';

/**
 * Credential-shaped fixtures, assembled at runtime.
 *
 * Written out as literals they trip the repository's own pre-commit
 * secret scanner — which is the scanner doing its job. The rule in this
 * house is that the code moves, never the scanner: a check weakened to
 * let a test through stops being a check.
 */
const KEY = ['aB3xY9kQ', '7mZ2pL5w', 'Q1rT4uV6', 'nH8jK0dF'].join('');
const key = (n) => KEY.slice(0, n);

test('an env reference is left alone, byte for byte', () => {
  const bleibt = [
    'const token = process.env.GITHUB_TOKEN;',
    "const t = process.env['GITHUB_TOKEN'];",
    'password = os.environ["DB_PASSWORD"]',
    '$token = $env:GITHUB_TOKEN',
    'const secret = await readSecretFromVault(name);',
    'export function redactAgainstEnv(text, secrets = []) {',
  ];
  for (const line of bleibt) {
    assert.equal(redaction.redact(line).text, line,
      `over-masked: ${line}`);
  }
});

test('a real secret is still redacted, and the separator survives', () => {
  const faelle = [
    [`export DB_PASSWORD=${key(16)}`, 'export DB_PASSWORD='],
    [`my_token = ${key(24)}`, 'my_token = '],
  ];
  for (const [line, prefix] of faelle) {
    const out = redaction.redact(line).text;
    assert.ok(out.includes('[REDACTED:'), `not redacted: ${line}`);
    // Everything up to the marker must be a verbatim prefix of the
    // original — that is what "the separator survives" means. The old
    // code failed exactly here: it produced `my_token=[REDACTED...]`.
    assert.ok(out.startsWith(prefix),
      `separator rewritten: ${JSON.stringify(out)} does not start with ${JSON.stringify(prefix)}`);
  }
});

test('SABOTAGE: a credential dressed as a reference is still caught', () => {
  // If the exemption were a plain shape test, every one of these would
  // walk straight through. They must not.
  const getarnt = [
    `MY_TOKEN=process.env.${key(28)}`,
    `password = getSecret(${key(30)})`,
    `SECRET=$env:${KEY}`,
    `TOKEN = os.environ[${key(28)}]`,
  ];
  for (const line of getarnt) {
    assert.ok(redaction.redact(line).text.includes('[REDACTED:'),
      `LEAK — exemption too wide: ${line}`);
  }
});

test('the canary still passes', () => {
  assert.equal(redaction.selfTest().ok, true);
});

// --- `env.X` is a reference, not a secret ----------------------------
//
// **The finding (2026-09-09).** The pre-commit latch stopped
// `token: env.CHEAP_MEM_SERVE_TOKEN || ''` in `bin/mem-serve`. That
// line NAMES an environment variable; it is not one. `process.env.X`
// was already treated as a reference, and a parameter literally called
// `env` is the house style for "the environment this was configured
// from" — precisely so a service does not read `process.env` behind its
// caller's back.
//
// This widens PRECISION, never reach. The counter-probes below are the
// point: a value that merely starts with `env.` and IS credential-
// shaped is still caught, and so is every real assignment.
test('a value that names an environment variable is not one', () => {
  for (const line of [
    "token: env.CHEAP_MEM_SERVE_TOKEN || ''",
    "  token: env.LUCKY_MEM_MCP_TOKEN,",
    "const password = env['DB_PASSWORD'];",
    'API_KEY: process.env.API_KEY',
  ]) {
    assert.equal(redaction.redact(line).text, line, `masked a reference: ${line}`);
  }
});

// **The credential-shaped fixtures are ASSEMBLED, not written down.**
//
// The pre-commit latch reads the added lines of the staged diff and
// cannot tell a fixture from the real thing — correctly, since a latch
// that lets fixtures through eventually lets the real thing through.
// So the shape is built at runtime: the probes still feed a value that
// `looksLikeCredential` accepts, it just is not a literal in the file.
const SHAPE = ['A1b2C3d4', 'E5f6G7h8'].join('');

test('COUNTER-PROBE: a real secret is still caught, even shaped like a reference', () => {
  // Without this the widening above would be a hole with a comment on
  // it. `looksLikeCredential` is the gate that keeps it honest.
  for (const line of [
    `export CHEAP_MEM_SERVE_TOKEN=${SHAPE}`,
    `token: env.FOO_TOKEN_${SHAPE}`,
    `DB_PASSWORD: ${SHAPE}`,
  ]) {
    assert.notEqual(redaction.redact(line).text, line, `let a secret through: ${line}`);
  }
});

test('only a bare `env`, not any object with an env property', () => {
  // `config.env.x` could be anything at all; the rule is anchored to
  // the name, and staying narrow is what makes it defensible.
  const line = ['token', ':', ' config.env.SOMETHING_', 'KEY_', SHAPE].join('');
  assert.notEqual(redaction.redact(line).text, line);
});

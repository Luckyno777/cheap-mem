// The door: which name we agree to be reachable under.
//
// `postOriginOk` answers "does this come from our own page" by
// comparing Origin against Host — and trusts the Host. Under DNS
// rebinding both carry the attacker's name and match. Only
// `hostAllowed` separates them, and that is what this file pins.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as webauth from '../src/webauth.mjs';

test('Host: loopback in every spelling, nothing else', () => {
  for (const h of ['127.0.0.1', '127.0.0.1:8849', 'localhost', 'LOCALHOST:1', '[::1]', '::1']) {
    assert.equal(webauth.hostAllowed(h), true, `refused: ${h}`);
  }
  for (const h of ['evil.example', 'evil.com:8849', '127.0.0.1.evil.example',
    'localhost.attacker.net', '10.0.0.5', 'mem.example.org']) {
    assert.equal(webauth.hostAllowed(h), false, `let through: ${h}`);
  }
});

test('a missing Host is refused — unlike a missing Origin', () => {
  // HTTP/1.1 requires it and HTTP/2 fills :authority; both land in
  // req.headers.host. Missing anyway is not a normal case but an
  // unknown one — and the unknown falls to the closed side.
  assert.equal(webauth.hostAllowed(''), false);
  assert.equal(webauth.hostAllowed(null), false);
  assert.equal(webauth.hostAllowed(undefined), false);
});

test('a configured host passes, and only that one', () => {
  assert.equal(webauth.hostAllowed('mem.example.org', ['mem.example.org']), true);
  assert.equal(webauth.hostAllowed('MEM.EXAMPLE.ORG', ['mem.example.org']), true);
  assert.equal(webauth.hostAllowed('other.example.org', ['mem.example.org']), false);
});

test('Host closes what Origin-against-Host cannot: DNS rebinding', () => {
  // The attacker points evil.example at 127.0.0.1. The browser thinks
  // it is same-origin and sends Origin https://evil.example against
  // Host evil.example. postOriginOk passes them — rightly, they match.
  assert.equal(webauth.postOriginOk('https://evil.example', 'evil.example', []), true);
  // Only the name we agree to be reachable under separates them.
  assert.equal(webauth.hostAllowed('evil.example'), false);
});

test('every refusal reason is a code, not a sentence', () => {
  const codes = Object.values(webauth.REFUSAL);
  assert.ok(codes.length >= 6);
  for (const c of codes) {
    assert.match(c, /^[a-z-]+$/, `not a code: ${c}`);
    assert.ok(!c.includes(' '), `a sentence got in: ${c}`);
  }
});

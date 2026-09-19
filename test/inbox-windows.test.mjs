// A message from a Windows machine is a message.
//
// **Found outside, not here (2026-09-19).** A cheap-mem user pulled the
// latest onto a Windows machine. Two entirely intact messages sat in his
// drawer, the doctor reported `delivery: drawer unreadable`, and the
// channel to ChatGPT was silent — without anyone noticing. Cause: the
// reader looked for the boundary between header and body as two plain
// newlines. Windows separates with CRLF.
//
// He patched it locally and upstream was never told, which is why the
// same bug also sat in lucky-mem (src/sitzungspost.mjs, `zerlege`) until
// the same day — both houses were written from the same template and
// carried the same assumption in the same place.
//
// The second half was the more expensive one: the error was caught for
// the WHOLE drawer, so one unparseable message blinded the finding for
// every healthy message beside it.
//
// This file is the counterpart of lucky-mem/test/post-windows.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as inbox from '../src/inbox.mjs';
import * as doctor from '../src/doctor.mjs';
import * as agents from '../src/agents.mjs';

const HEADER = [
  'From: librarian', 'To: session', 'Time: 2026-09-19T00:00:00Z',
  'Subject: A subject with spaces', 'State: open',
].join('\n');
const MESSAGE = `${HEADER}\n\nFirst line.\n\nSecond paragraph.\n`;

test('CRLF: the same message reads exactly as it does with LF', () => {
  const withLf = inbox.parse(MESSAGE);
  const withCrlf = inbox.parse(MESSAGE.replace(/\n/g, '\r\n'));
  assert.deepEqual(withCrlf, withLf,
    'a message from a Windows machine yields something other than the same one from here');
});

test('CRLF: no carriage return survives in body or subject', () => {
  // Otherwise the carriage returns land in the memory and turn up again
  // later in search hits and in printed output.
  const m = inbox.parse(MESSAGE.replace(/\n/g, '\r\n'));
  assert.equal(m.text.includes('\r'), false, `still \\r in the body: ${JSON.stringify(m.text)}`);
  assert.equal(m.subject.includes('\r'), false, 'still \\r in the subject');
  assert.match(m.text, /First line\.\n\nSecond paragraph\./,
    'the paragraph boundary inside the body has been lost');
});

test('mixed: a CRLF header with an LF body goes through too', () => {
  // Happens as soon as one tool writes the header and another appends
  // the body.
  const raw = `${HEADER.replace(/\n/g, '\r\n')}\r\n\r\nOne sentence only.\n`;
  const m = inbox.parse(raw);
  assert.equal(m.subject, 'A subject with spaces');
  assert.equal(m.text, 'One sentence only.');
});

test('POSITIVE CONTROL: a genuinely broken message still throws', () => {
  // The control on the normalisation: it must not make everything pass.
  // A header with no blank line after it is not a message — in any line
  // ending.
  assert.throws(() => inbox.parse('From: a\r\nTo: b\r\n'), /No blank line/);
  assert.throws(() => inbox.parse('From: a\nTo: b\n'), /No blank line/);
});

function drawer() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-win-'));
  fs.mkdirSync(path.join(r, inbox.INBOX_DIR), { recursive: true });
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: { user: 'the human', session: 'a session' }, language: 'en' }));
  return r;
}
const rm = (r) => fs.rmSync(r, { recursive: true, force: true, maxRetries: 10 });
const put = (r, name, content) =>
  fs.writeFileSync(path.join(r, inbox.INBOX_DIR, name), content);

test('ONE broken message does NOT take the drawer down', () => {
  // The most expensive half of the finding. Before today `read` threw
  // out of the loop and the caller caught it for the whole drawer.
  const r = drawer();
  try {
    put(r, '2026-09-19T00-00-00Z--librarian-to-session~aaaa.md', MESSAGE);
    put(r, '2026-09-19T00-00-01Z--librarian-to-session~bbbb.md', 'this is not a message');
    put(r, '2026-09-19T00-00-02Z--librarian-to-session~cccc.md', MESSAGE);
    const got = inbox.read(r, {});
    assert.equal(got.messages.length, 2, 'the healthy messages were dragged down with it');
    assert.equal(got.broken.length, 1, 'the broken message vanished silently');
    assert.match(got.broken[0].name, /~bbbb\.md$/);
    assert.ok(got.broken[0].reason, 'a finding without a reason is a shrug');
  } finally { rm(r); }
});

test('a Windows message lands as a MESSAGE, not as damage', () => {
  const r = drawer();
  try {
    put(r, '2026-09-19T00-00-00Z--librarian-to-session~aaaa.md',
      MESSAGE.replace(/\n/g, '\r\n'));
    const got = inbox.read(r, {});
    assert.deepEqual(got.broken, [], JSON.stringify(got.broken));
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].subject, 'A subject with spaces');
  } finally { rm(r); }
});

test('an empty drawer has the same shape as a full one', () => {
  // Otherwise every caller that reads `broken` trips over undefined —
  // and it only shows up when there really is no drawer at all, which
  // is the one case nobody tries by hand.
  const r = drawer();
  try {
    const got = inbox.read(r, {});
    assert.deepEqual(got.messages, []);
    assert.deepEqual(got.broken, []);
    const none = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-nodrawer-'));
    try {
      const absent = inbox.read(none, {});
      assert.equal(absent.dir, null);
      assert.deepEqual(absent.messages, []);
      assert.deepEqual(absent.broken, [],
        'the absent drawer answers with a different shape than the empty one');
    } finally { rm(none); }
  } finally { rm(r); }
});

test('the doctor REPORTS unreadable messages — otherwise nobody counts them', () => {
  // `broken` is decoration as long as no instrument reads it. And the
  // finding has to be LOUD: a silent drawer otherwise looks like an
  // empty one, which is exactly what happened on the Windows machine.
  const r = drawer();
  try {
    agents.createAgent(r, 'librarian', {});
    put(r, '2026-09-19T00-00-00Z--librarian-to-session~aaaa.md', 'this is not a message');
    const f = doctor.checkDelivery(r);
    assert.equal(f.level, doctor.LEVEL.ERROR, JSON.stringify(f));
    assert.match(f.text, /unreadable/);
    assert.match(f.text, /~aaaa\.md/, 'the finding does not name the file');
    assert.ok(f.advice, 'an error finding without a next step just makes people feel bad');
  } finally { rm(r); }
});

test('POSITIVE CONTROL: a healthy drawer is not an error', () => {
  // A bolt that reports innocents gets switched off. A Windows message
  // is an innocent.
  const r = drawer();
  try {
    agents.createAgent(r, 'librarian', {});
    put(r, '2026-09-19T00-00-00Z--librarian-to-session~aaaa.md',
      MESSAGE.replace(/\n/g, '\r\n'));
    const f = doctor.checkDelivery(r);
    assert.notEqual(f.level, doctor.LEVEL.ERROR,
      `a Windows message is reported as damage: ${f.text}`);
  } finally { rm(r); }
});

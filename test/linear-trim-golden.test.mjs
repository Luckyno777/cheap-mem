// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Golden old/new: the linear spellings give the same answers as the quadratic patterns they replaced.
//
// **The finding, 2026-10-16.** A pattern that ends in a run and `$` (`/\s+$/`, `/\n*$/`, `/ +$/`) restarts at every character of
// the run and fails at the `$` each time: 100,000 blanks plus a letter took 3.7 to 4.3 s per pattern. The sites were made
// linear (src/lineartext.mjs and the sites that use it); the speed is test/linear-trim.test.mjs, the SAME ANSWERS are here.
// Every old pattern is written out below, as the reference; the corpora are small random strings over a small alphabet that
// holds exactly the characters the pattern is about, so a difference shows within a few thousand cases. The generator is
// seeded: a red run repeats.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as lineartext from '../src/lineartext.mjs';
import * as inbox from '../src/inbox.mjs';
import * as repetitionhint from '../src/repetitionhint.mjs';
import * as agentledger from '../src/agentledger.mjs';
import * as component from '../src/component.mjs';
import * as gauges from '../src/gauges.mjs';
import { maskText } from '../src/outputguard.mjs';

/** A small seeded generator (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` strings of up to `maxParts` pieces drawn from `alphabet`. */
function corpus(seed, alphabet, { count = 4000, maxParts = 14 } = {}) {
  const next = rng(seed);
  const out = [''];
  for (let i = 0; i < count; i += 1) {
    let s = '';
    const n = Math.floor(next() * maxParts);
    for (let j = 0; j < n; j += 1) s += alphabet[Math.floor(next() * alphabet.length)];
    out.push(s);
  }
  return out;
}

const code = (...points) => String.fromCharCode(...points);
const LS = code(0x2028);
const NBSP = code(0xa0);
const BOM = code(0xfeff);
const BLANKS = [' ', '\t', '\n', '\r', LS, NBSP, BOM, '\v', '\f'];

test('trimEnd is the pattern /\\s+$/ (inbox body, agent file line, appointment text)', () => {
  for (const s of corpus(1, [...BLANKS, 'a', 'x', '.'])) {
    assert.equal(s.trimEnd(), s.replace(/\s+$/, ''), JSON.stringify(s));
  }
});

test('inbox: build and parse cut the end of the body as /\\s+$/ did', () => {
  const parts = { user: 'H', session: 'AI', librarian: 'lib' };
  for (const body of corpus(2, [' ', '\t', '\n', NBSP, 'a', 'x'], { count: 600 })) {
    if (!body.trim()) continue;          // an empty message is refused before the cut
    const content = inbox.build(parts, { from: 'session', to: 'librarian', time: '2026-01-01T00:00:00Z', subject: 's', text: body });
    assert.ok(content.endsWith(`\n\n${body.replace(/\s+$/, '')}\n`), JSON.stringify(body));
    // a body of nothing but blanks is empty after the cut, and parse reads it as that
    assert.equal(inbox.parse(content).text, body.replace(/\s+$/, ''), JSON.stringify(body));
  }
});

test('inbox: the In-Reply-To check still takes a real message file name and refuses a name no file system holds', () => {
  const parts = { user: 'H', session: 'AI', librarian: 'lib' };
  const build = (inReplyTo) => inbox.build(parts, { from: 'librarian', to: 'session', time: '2026-01-01T00:00:00Z', subject: 's', text: 't', inReplyTo });
  const name = '2026-10-16T08-00-00Z--session-to-librarian.md';
  assert.match(build(name), new RegExp(`In-Reply-To: ${name}`));
  assert.match(build('2026-10-16T08-00-00Z--session-to-librarian~ab12-3.md'), /In-Reply-To:/);
  const head = '2026-10-16T08-00-00Z--session-to-';
  const longest = `${head}${'l'.repeat(255 - head.length - '.md'.length)}.md`;
  assert.equal(longest.length, 255);
  assert.match(build(longest), /In-Reply-To:/, 'a name of 255 characters is still a name');
  const tooLong = `${head}${'l'.repeat(300)}.md`;
  assert.throws(() => build(tooLong), /message file name/);
});

test('trimEndNewlines is the pattern /\\n*$/', () => {
  for (const s of corpus(3, ['\n', '\n', 'a', ' ', '\r', 'x'])) {
    assert.equal(lineartext.trimEndNewlines(s), s.replace(/\n*$/, ''), JSON.stringify(s));
  }
});

// ---- .gitattributes: the rule is read line by line ---------------------------------------------------------------------

const OLD_UNION = /^\s*\*\.jsonl\s+merge=union\s*$/m;
const OLD_EOL = /^\s*\*\.jsonl\s+(?:\S+\s+)*eol=lf(?:\s|$)/m;
const NEW_UNION = /^\*\.jsonl\s+merge=union$/;
const NEW_EOL = /^\*\.jsonl\s+(?:\S+\s+)*eol=lf(?:\s|$)/;
// whole lines, so that no rule is split over a line break (the one case on which old and new differ, tested below)
const RULE_LINES = [
  '*.jsonl merge=union', '  *.jsonl\tmerge=union  ', '*.jsonl text eol=lf', '*.jsonl merge=union eol=lf', '*.jsonl eol=lf',
  '*.jsonl a b eol=lf # c', '# *.jsonl merge=union', '*.jsonl merge=unionx', '*.txt merge=union', 'x*.jsonl merge=union',
  '', '   ', '*.jsonl  -text  eol=lf', '*.jsonl eol=lfx', '*.jsonl eol=lf\tfoo', '*.md text',
  `${BOM}*.jsonl merge=union`, `*.jsonl${NBSP}merge=union`, `*.jsonl merge=union${LS}`,
];

test('the .gitattributes rules: read by line, the answer of the multiline patterns on every file of whole lines', () => {
  const next = rng(4);
  for (let i = 0; i < 5000; i += 1) {
    let text = '';
    const n = Math.floor(next() * 7);
    for (let j = 0; j < n; j += 1) {
      text += RULE_LINES[Math.floor(next() * RULE_LINES.length)] + ['\n', '\r\n', '\r', '\n\n'][Math.floor(next() * 4)];
    }
    if (next() < 0.3) text = text.replace(/[\r\n]+$/, '');
    assert.equal(lineartext.anyTrimmedLine(text, NEW_UNION), OLD_UNION.test(text), `union: ${JSON.stringify(text)}`);
    assert.equal(lineartext.anyTrimmedLine(text, NEW_EOL), OLD_EOL.test(text), `eol: ${JSON.stringify(text)}`);
  }
});

test('the .gitattributes rules: ONE deliberate difference - a rule split over two lines is no rule', () => {
  const split = '*.jsonl\nmerge=union\n';
  assert.equal(OLD_UNION.test(split), true, 'the old pattern let the blank in the middle be a line break');
  assert.equal(lineartext.anyTrimmedLine(split, NEW_UNION), false);
  assert.equal(lineartext.anyTrimmedLine('*.jsonl merge=union\n', NEW_UNION), true, 'control: the whole line is a rule');
});

// ---- the sentence that names the right way -----------------------------------------------------------------------------

const OLD_SENTENCE = /[^.?!\n]*\b(fixed|remedy|guard|corrected|resolved|improved|the right way is|right way)\b[^.?!\n]*[.?!]?/i;
function oldCorrectPathText(entry) {
  for (const f of ['remedy', 'correct']) {
    if (typeof entry?.[f] === 'string' && entry[f].trim()) return maskText(entry[f].trim());
  }
  const text = maskText(String(entry?.text ?? '')).trim();
  if (!text) return '(no text in the newest error)';
  const hit = OLD_SENTENCE.exec(text);
  if (hit) return hit[0].trim();
  const first = text.split(/(?<=[.?!])\s+/)[0] ?? text;
  return `(no correction marker found, first sentence) ${first}`;
}

test('repetitionhint.correctPathText: the sentence of the old pattern, on every text', () => {
  const alphabet = ['fixed', 'FIXED', 'Fix', 'guard', 'right way', 'the right way is', 'right', 'way', 'remedy', 'resolved', 'unfixed', 'x',
    ' ', ' ', '.', '?', '!', '\n', '\r', 'a', '-', '_', 'é'];
  for (const text of corpus(5, alphabet, { count: 8000, maxParts: 12 })) {
    assert.equal(repetitionhint.correctPathText({ text }), oldCorrectPathText({ text }), JSON.stringify(text));
  }
  // a text the old pattern read in several sentences: the FIRST one with a marker, with its closing mark
  assert.equal(repetitionhint.correctPathText({ text: 'It broke. We fixed it by x! Then more.' }), 'We fixed it by x!');
  assert.equal(repetitionhint.correctPathText({ text: 'First line\nthe right way is x\nlast' }), 'the right way is x');
});

// ---- the package name of a job ----------------------------------------------------------------------------------------

const oldNormalizePackage = (p) => String(p ?? '').trim().replace(/\s*\+\s*/g, '+').replace(/\s+and\s+/gi, '+');

test('agentledger: the package name, as the two old patterns wrote it', () => {
  const alphabet = ['a', 'B', 'q1', ' ', ' ', '\t', '\n', '+', 'and', 'AND', 'And', 'andy', 'x', NBSP, '-'];
  for (const p of corpus(6, alphabet, { count: 8000, maxParts: 14 })) {
    if (!p.trim()) continue;
    const job = agentledger.jobFromEntry({ package: p, text: '', title: '' });
    assert.equal(job.package, oldNormalizePackage(p), JSON.stringify(p));
  }
  assert.equal(agentledger.jobFromEntry({ package: ' Q1 and Q2 ', text: '', title: '' }).package, 'Q1+Q2');
  assert.equal(agentledger.jobFromEntry({ package: 'Q1 + Q2', text: '', title: '' }).package, 'Q1+Q2');
  assert.equal(agentledger.jobFromEntry({ package: 'a and and b', text: '', title: '' }).package, 'a+and b', 'a used-up `and` starts no second pair');
});

// ---- is the base name in this text -------------------------------------------------------------------------------------

function oldCompatible(text, base, askedPrefix) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`([A-Za-z0-9_.\\-/]*?)${escaped}`, 'g');
  for (const m of String(text ?? '').matchAll(pattern)) {
    const before = m[1];
    if (!before) return true;
    if (!before.endsWith('/')) continue;
    const segs = before.slice(0, -1).split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? null;
    if (last && askedPrefix && last === askedPrefix) return true;
  }
  return false;
}

test('component.compatible: the answer of the lazy pattern, on every text', () => {
  const alphabet = ['capture.sh', 'capture', '.sh', 'bin/', 'lib/', '/', 'x', 'x', '.', ' ', '-', '_', 'a/', '//', '(', 'é', 'capture.shcapture.sh'];
  for (const [seed, base] of [[7, 'capture.sh'], [8, 'a/b'], [9, 'x'], [10, '.']]) {
    for (const text of corpus(seed, alphabet, { count: 4000, maxParts: 9 })) {
      for (const prefix of [null, 'bin', 'lib', 'a']) {
        assert.equal(component.compatible(text, base, prefix), oldCompatible(text, base, prefix), `${base} / ${prefix} / ${JSON.stringify(text)}`);
      }
    }
  }
  assert.equal(component.compatible('anything', '', 'bin'), oldCompatible('anything', '', 'bin'));
  assert.equal(component.compatible('', '', 'bin'), oldCompatible('', '', 'bin'));
});

// ---- the shell command gauges --------------------------------------------------------------------------------------------

const OLD_QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const OLD_REDIRECT = /(?:^|[^=>-])(?:\d*|&)>>?(?!&)\s*(?!\/dev\/(?:null|stdout|stderr|tty)(?![\w/.-]))(?![(])\S/;
const OLD_HEREDOC = /<<\s*['"]?[A-Za-z_]/;
const oldWritesViaRedirect = (c) => OLD_HEREDOC.test(c) || OLD_REDIRECT.test(c.replace(OLD_QUOTED, 'Q'));

test('gauges: the quoted stretches are the ones the old pattern found, on every command', () => {
  const alphabet = ["'", '"', '\\', '\\"', ' ', 'a', '\n', '\r', LS, '>', '&', '2', '0', '=', '-', '/dev/null', '(', '<<', 'EOF', 'cat '];
  for (const c of corpus(11, alphabet, { count: 12000, maxParts: 14 })) {
    assert.equal(gauges.quotedToPlaceholder(c), c.replace(OLD_QUOTED, 'Q'), JSON.stringify(c));
    assert.equal(gauges.writesViaRedirect(c), oldWritesViaRedirect(c), JSON.stringify(c));
  }
  assert.equal(gauges.quotedToPlaceholder('echo "a b" > \'f\''), 'echo Q > Q');
  assert.equal(gauges.writesViaRedirect('grep "a > b" file'), false);
  assert.equal(gauges.writesViaRedirect('echo hi > out.txt'), true);
  assert.equal(gauges.writesViaRedirect('echo hi 2>&1'), false);
  assert.equal(gauges.writesViaRedirect('echo hi 12> out.txt'), true);
});

test('gauges: a digit run in front of the redirect, and the ampersand form, as before', () => {
  for (const c of ['x 123>f', '123>f', 'a1234&>f', '12&>f', '9>>f', 'echo 1 2 3>f', '12 >f', '=5>f', '>5>f', '-5>f']) {
    assert.equal(gauges.writesViaRedirect(c), oldWritesViaRedirect(c), c);
  }
});

test('gauges.pathsOf: a command of normal length gives the paths the pattern gave', () => {
  const m = gauges.pathsOf('Bash', { command: 'cat src/a.mjs && node bin/mem find x.md' });
  assert.deepEqual(m, ['src/a.mjs', 'bin/mem', 'x.md']);
  const oldPaths = (c) => c.match(/[\w./@-]*\/[\w./@-]+|\b[\w-]+\.(mjs|js|ts|md|json|jsonl|yaml|yml|sh|py)\b/g) ?? [];
  for (const c of corpus(12, ['src/', 'a.mjs', ' ', 'x', '-', '.', '/', '@', 'file.md', '\n', '"', 'b.sh'], { count: 3000, maxParts: 10 })) {
    assert.deepEqual(gauges.pathsOf('Bash', { command: c }), oldPaths(c), JSON.stringify(c));
  }
});

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
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as lineartext from '../src/lineartext.mjs';
import * as inbox from '../src/inbox.mjs';
import * as repetitionhint from '../src/repetitionhint.mjs';
import * as agentledger from '../src/agentledger.mjs';
import * as component from '../src/component.mjs';
import * as gauges from '../src/gauges.mjs';
import * as environment from '../src/environment.mjs';
import * as githook from '../src/cli/githook.mjs';
import { maskText } from '../src/outputguard.mjs';
import { tempDir } from './temp-dir.mjs';

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

// ---- .gitattributes: read the way git reads it ---------------------------------------------------------------------------
//
// The truth is `git check-attr`. The old multiline patterns were not the truth: `*.jsonl merge=union eol=lf` on ONE line is both
// rules to git and was "union missing" to the pattern, so `mem init` appended a second rule to a file that had it (found by the
// reviewer, 2026-10-16). The words come out as `set`, `unset`, the value; a name that is not an attribute name drops the line.

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const truthOf = (root, attr) => {
  const line = git(root, 'check-attr', attr, '--', 'x.jsonl').replace(/\r?\n$/, '');       // "x.jsonl: merge: union" (a value may end in a no-break space)
  return line.slice(`x.jsonl: ${attr}: `.length);
};
const ATTR_CASES = {
  empty: '', normal: '*.jsonl merge=union\n', crlf: '*.jsonl merge=union\r\n', crlfTwo: '# x\r\n*.jsonl merge=union\r\n*.jsonl eol=lf\r\n',
  bom: `${BOM}*.jsonl merge=union\n`, tab: '*.jsonl\tmerge=union\n', indent: '   *.jsonl merge=union   \n',
  twoLines: '*.jsonl\nmerge=union\n', commentAfter: '*.jsonl merge=union # c\n', both: '*.jsonl merge=union eol=lf\n',
  bothReversed: '*.jsonl eol=lf merge=union\n', eolOnly: '*.jsonl eol=lf\n', eolSplit: '*.jsonl text\neol=lf\n',
  twoRules: '*.jsonl merge=union\n*.jsonl eol=lf\n', noNewline: '*.jsonl merge=union', blanksBefore: '\n\n\n*.jsonl merge=union\n\n\n',
  wideGap: '*.jsonl    merge=union\n', textEol: '*.jsonl text eol=lf\n', negated: '*.jsonl -merge\n', taken: '*.jsonl merge=union\n*.jsonl !merge\n',
  overridden: '*.jsonl merge=union\n*.jsonl merge=binary\n', overriddenBack: '*.jsonl merge=binary\n*.jsonl merge=union\n',
  bare: '*.jsonl merge\n', eolCrlf: '*.jsonl eol=lf\n*.jsonl eol=crlf\n', nbsp: `*.jsonl merge=union${NBSP}\n`,
  otherPattern: '*.json merge=union\n', lonelyCr: '*.jsonl merge=union\r*.md text\r', other: '*.md text\n',
};

test('attributesOf: merge and eol as git check-attr says them, on every shape of a .gitattributes', (t) => {
  const root = tempDir('cm-attr-', t);
  git(root, 'init', '-q');
  for (const [name, content] of Object.entries(ATTR_CASES)) {
    fs.writeFileSync(path.join(root, '.gitattributes'), content);
    const attrs = lineartext.attributesOf(content, '*.jsonl');
    for (const attr of ['merge', 'eol']) {
      assert.equal(attrs.get(attr) ?? 'unspecified', truthOf(root, attr), `${name}: ${attr}`);
    }
  }
});

test('checkMergeDriver and writeMergeDriver: the truth is git, the second call changes nothing', (t) => {
  const root = tempDir('cm-attr-', t);
  git(root, 'init', '-q');
  const file = path.join(root, '.gitattributes');
  for (const [name, content] of Object.entries(ATTR_CASES)) {
    if (name === 'empty') continue;                       // no file content to start from: writeMergeDriver writes the whole note
    fs.writeFileSync(file, content);
    const union = truthOf(root, 'merge') === 'union';
    assert.equal(environment.checkMergeDriver(root).ok, union, `${name}: the check says what git says`);
    githook.writeMergeDriver(root);
    assert.equal(truthOf(root, 'merge'), 'union', `${name}: after the write git has the union driver`);
    assert.equal(truthOf(root, 'eol'), 'lf', `${name}: and the line endings pinned`);
    assert.equal(environment.checkMergeDriver(root).ok, true, `${name}: and the check agrees`);
    const written = fs.readFileSync(file, 'utf8');
    assert.equal(githook.writeMergeDriver(root).added, 0, `${name}: a second call adds nothing`);
    assert.equal(fs.readFileSync(file, 'utf8'), written, `${name}: and does not touch the file`);
  }
});

test('writeMergeDriver: a file that has both rules in ONE line is left alone (the reviewer\'s case)', (t) => {
  const root = tempDir('cm-attr-', t);
  git(root, 'init', '-q');
  fs.writeFileSync(path.join(root, '.gitattributes'), '*.jsonl merge=union eol=lf\n');
  assert.equal(githook.writeMergeDriver(root).added, 0);
  assert.equal(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'), '*.jsonl merge=union eol=lf\n');
  assert.equal(environment.checkMergeDriver(root).ok, true);
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

const OLD_PATHS = /[\w./@-]*\/[\w./@-]+|\b[\w-]+\.(mjs|js|ts|md|json|jsonl|yaml|yml|sh|py)\b/g;
const oldPaths = (c) => c.match(OLD_PATHS) ?? [];

test('gauges.pathsOf: the paths the pattern found, on every command - and a long path stays whole', () => {
  assert.deepEqual(gauges.pathsOf('Bash', { command: 'cat src/a.mjs && node bin/mem find x.md' }), ['src/a.mjs', 'bin/mem', 'x.md']);
  const alphabet = ['src/', 'a.mjs', ' ', 'x', 'x', '-', '.', '/', '@', 'file.md', '.md', '.json', '.jsonl', 'json', '_', '\n', '"', 'b.sh', 'é', '1', '.js-', 'ts', '-a', 'a-'];
  for (const [seed, maxParts] of [[12, 10], [13, 24]]) {
    for (const c of corpus(seed, alphabet, { count: 12000, maxParts })) {
      assert.deepEqual(gauges.pathsOf('Bash', { command: c }), oldPaths(c), JSON.stringify(c));
    }
  }
  // the paths the bound of 512 characters cut or lost (the review's measures): all of them come back whole
  const deep = `/home/user/${'d/'.repeat(300)}file.mjs`;
  for (const command of [`cat ${deep}`, `cat ${'a'.repeat(600)}/x.md`, `cat a.md ${'z'.repeat(520)} b.md`, `echo ${'/x'.repeat(260)}`, `cat ${'a'.repeat(605)}.md`]) {
    assert.deepEqual(gauges.pathsOf('Bash', { command }), oldPaths(command), command.slice(0, 40));
  }
  assert.equal(gauges.pathsOf('Bash', { command: `cat ${deep}` })[0], deep);
  assert.equal(gauges.pathsOf('Bash', { command: `cat ${'a'.repeat(605)}.md` })[0], `${'a'.repeat(605)}.md`);
});

test('lineartext.jsonlPlaces: the places of the pattern, on every text - and a long path stays whole', () => {
  const OLD = /[A-Za-z0-9_./\\-]+\.jsonl:\d+/g;
  const alphabet = ['a', 'b', '/', '\\', '.', '-', '_', '.jsonl:', '.jsonl', ':', '1', '23', ' ', 'x.jsonl:4', 'global/errors.jsonl:7', 'é', '\n', '.jsonl:x'];
  for (const text of corpus(14, alphabet, { count: 20000, maxParts: 12 })) {
    assert.deepEqual(lineartext.jsonlPlaces(text), (text.match(OLD) ?? []), JSON.stringify(text));
  }
  const long = `${'d/'.repeat(300)}errors.jsonl:12`;
  assert.deepEqual(lineartext.jsonlPlaces(`see ${long} here`), [long]);
  assert.deepEqual(lineartext.jsonlPlaces('a.jsonl:1.jsonl:2'), 'a.jsonl:1.jsonl:2'.match(OLD) ?? []);
});

// ---- the lead words in front of a command (commandguard) ---------------------------------------------------------------------

import * as commandguard from '../src/commandguard.mjs';

const OLD_LEAD_WORD = /(?<![^\s;&|({`])(?:(?:sudo|time|nohup|exec|command|xargs)(?: -\S+)*|[A-Za-z_][A-Za-z0-9_]*=\S*)$/;
function oldAtCommandStart(text, pos) {
  let before = text.slice(0, pos).replace(/ +$/, '');
  for (let i = 0; i < 6; i += 1) {
    const m = before.match(OLD_LEAD_WORD);
    if (!m) break;
    before = before.slice(0, m.index).replace(/ +$/, '');
  }
  if (before === '' || /[;&|({`]$/.test(before)) return true;
  return /(?:^|\s)-[A-Za-z]*c ["']$/.test(before);
}
function oldHits(text, pattern) {
  const [rawFirst, ...more] = pattern;
  const bare = rawFirst.endsWith('$');
  const first = bare ? rawFirst.slice(0, -1) : rawFirst;
  let pos = text.indexOf(first);
  let found = false;
  while (pos !== -1 && !found) {
    const end = pos + first.length;
    const endGood = bare ? /^ *(?:$|[;&|)}])/.test(text.slice(end)) : end >= text.length || /[\s;&|)}`"']/.test(text[end]);
    if (endGood && oldAtCommandStart(text, pos)) found = true;
    else pos = text.indexOf(first, pos + 1);
  }
  return found && more.every((w) => text.includes(w));
}

test('commandguard.hits: the answer of the pattern version, on every command, normalised or not', () => {
  const alphabet = ['git push', 'git', ' ', ' ', ' ', '-', '-u', ';', '&', '|', '(', '{', '`', '"', "'", 'c', 'sudo', 'time', 'exec', 'nohup',
    'xargs', 'command', 'a=b', 'A_1=', '=', 'x', 'bash -c ', '\t', '\n', NBSP, 'sudoers', '-c', ' -c "', ')', '}', '$'];
  for (const seed of [15, 16, 17]) {
    for (const raw of corpus(seed, alphabet, { count: 6000, maxParts: 14 })) {
      for (const text of [raw, commandguard.normalise(raw)]) {
        for (const pattern of [['git push'], ['git push$'], ['git', 'x'], ['xargs$'], ['exec'], ['-c']]) {
          assert.equal(commandguard.hits(text, pattern), oldHits(text, pattern), `${JSON.stringify(text)} ${JSON.stringify(pattern)}`);
        }
      }
    }
  }
  // the lead words themselves, one by one
  for (const [command, expected] of [['sudo -E -H git push', true], ['FOO=1 BAR=2 git push', true], ['echo x && git push', true], ['xgit push', false],
    ['bash -c "git push"', true], ['git status; git push', true], ['echo git push', false], ['time -p nohup git push', true], ['echo ab=c git push', false]]) {
    assert.equal(commandguard.hits(commandguard.normalise(command), ['git push']), expected, command);
    assert.equal(oldHits(commandguard.normalise(command), ['git push']), expected, `old: ${command}`);
  }
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Ratchet for "mask BEFORE cut" (cm error 2tjgr4psniuh; the probes are test/mask-before-cut.test.mjs).
//
// A key that crosses a cut leaves a stump no pattern recognises any more, so every place that shortens
// entry text must mask first: `maskText` / `cutMasked` / `windowMasked` / `maskEntry` (src/outputguard.mjs)
// or, on the write path, `redact*`, in front of the cut. This file keeps it that way.
//
// Two rules, deliberately narrow so they do not drown in false alarms:
//
//   1. WATCHED FILES (the explicit list below: every file that cut entry text when the round was made, plus
//      the ones inspected and found fine). In them, every line that cuts (`.slice(0, n)`, `.slice(-n)`,
//      `.substring(0, n)`) AND looks at text (a receiver or neighbour word like title, text, body, subject,
//      why, stdout ...) must have a mask call on the same line or in the two lines above, or carry the
//      exception comment `mask-ok: <reason>` on that line or in the two lines above. A new unguarded cut in a
//      watched file turns this red.
//   2. EVERYWHERE ELSE in src/ and bin/: the commonest shape of the bug, an entry field cut inline
//      (`e.title.slice(0, 80)`, `String(e.text).slice(0, 60)`), with no mask call and no `mask-ok:`.
//
// Both rules are pure functions over source text, so the red proof can run them on the OLD files (acff04e,
// exported with a fixed hash, never a moving merge-base) and must find violations there, and the positive
// control feeds them a bad and a good snippet. A watched file that no longer exists or no longer cuts
// anything is reported, not skipped: a ratchet over a moved file guards nothing.
//
// invariant: maske-vor-schnitt
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The state before the fix. Pinned, never `merge-base`. */
const OLD_STATE = 'acff04e377dcc729e6f390c94338570c0dedf58d';

/** Files that cut entry text (fixed in the mask-before-cut round) or were inspected for it. */
export const WATCHED = Object.freeze([
  'src/search.mjs', 'src/raw.mjs', 'src/retrieval.mjs', 'bin/mem-mcp', 'src/timesearch.mjs', 'src/question.mjs',
  'src/cli/commands/agents.mjs', 'src/board.mjs', 'src/commandguard.mjs',
  'src/errorcontext.mjs', 'src/cli/commands/write.mjs', 'src/neighbours.mjs', 'src/errorfixes.mjs', 'src/teach.mjs',
  'src/closingreport.mjs', 'src/appointment-today.mjs', 'src/dashboard-data.mjs', 'src/skillcatalog.mjs',
  'src/cli/commands/setup.mjs', 'src/cli/commands/admin.mjs', 'src/doctor.mjs', 'src/repetitionhint.mjs',
  'src/answercheck.mjs', 'src/embed/index.mjs', 'src/embed/openai.mjs', 'src/embed/voyage.mjs', 'src/embed/ollama.mjs',
  'src/skillregistry.mjs', 'src/source.mjs', 'src/broadcast.mjs', 'src/ruledraft.mjs', 'src/heartbeat.mjs',
  'src/shrink.mjs', 'src/rewrites.mjs', 'src/bodyfields.mjs', 'src/tasks.mjs', 'src/shardarchive.mjs', 'src/store.mjs',
  'src/freshness.mjs', 'src/probescaffold.mjs', 'src/errorsignature.mjs', 'src/dashboard-pass.mjs',
  'src/questiontext.mjs', 'src/cli/commands/search.mjs', 'src/cli/commands/capture.mjs',
  'src/cli/display.mjs', 'src/shortline.mjs',
]);

const CUT = /\.(?:slice\(\s*(?:0\s*,|-\s*\d)|substring\(\s*0\s*,|substr\(\s*0\s*,)/;
// A word that says "this is entry text" on the line. Identifiers like ts, id, hash, sha, commit, day are not text.
const TEXTY = /\b(?:title|titleFull|text|body|subject|question|why|reason|content|excerpt|query|stdout|stderr|stderrTail|snippet|note|message|summary|label|choice|rule|learning|remedy|headline|description|what|quote|raw|firstLine|spaced|gap|txt)\b|\.value\b/;
const BENIGN = /\b(?:ts|id|ids|hash|sha|sha256|commit|day|date|iso|tags|files|lines|sources|patterns|claims|hits|rows|items|list|top|names|parts|words|tokens|stems|projects|entries|keys|args|rest|argv)\b/;
const GUARD = /\b(?:maskText|cutMasked|windowMasked|maskEntry|maskOutput|sanitizeForDisplay|redactExcerpt|redactEntry|redactObject|redact)\b|mask-ok:/;
// Rule 2: an entry field cut inline.
const INLINE = /\b(?:e|e0|entry|h|x|q|m|c|p|l|r|it|d|a|o|res|msg)\.(?:title|text|body|why|question|subject|reason|choice|learning|rule|fact|value|remedy|note)\b[^;\n]*\.(?:slice\(\s*(?:0\s*,|-\s*\d)|substring\(\s*0\s*,)/;

/** The expression a cut at `at` is applied to: `String(e.ts ?? '')` in `String(e.ts ?? '').slice(0, 10)`. */
export function receiverBefore(code, at) {
  let i = at;
  for (;;) {
    while (i > 0 && /[\w$.?]/.test(code[i - 1])) i -= 1;
    if (i > 0 && code[i - 1] === ')') {
      let depth = 0;
      while (i > 0) {
        i -= 1;
        if (code[i] === ')') depth += 1;
        else if (code[i] === '(') { depth -= 1; if (depth === 0) break; }
      }
      continue; // the identifier in front of the opening parenthesis (String, maskText ...)
    }
    break;
  }
  return code.slice(i, at);
}

/** Lines of `source` that cut text without a mask call or an exception; `{ line, text }`. */
export function unguardedCuts(source, { rule = 1 } = {}) {
  const lines = source.split('\n');
  const found = [];
  lines.forEach((l, i) => {
    const code = l.replace(/\/\/.*$/, (m) => (m.includes('mask-ok:') ? m : ''));
    if (/^\s*(\*|\/\*|\/\/)/.test(l) && !CUT.test(l)) return;
    if (/^\s*\*|^\s*\/\//.test(l)) return; // a comment line is not code
    if (!CUT.test(code)) return;
    if (rule === 1) {
      if (!TEXTY.test(code)) return;
      // What sits right before the cut says what is cut: `ts.slice(0, 10)` is a date, `commit.slice(0, 12)` a hash.
      const cuts = [...code.matchAll(new RegExp(CUT.source, 'g'))];
      if (cuts.every((m) => BENIGN.test(receiverBefore(code, m.index)))) return;
    } else if (!INLINE.test(code)) return;
    // A mask call must stand on the line or just above it; an exception comment may head a short block (4 lines).
    const near = [lines[i - 2] ?? '', lines[i - 1] ?? '', l].join('\n');
    const block = [lines[i - 4] ?? '', lines[i - 3] ?? '', near].join('\n');
    if (GUARD.test(near) || /mask-ok:/.test(block)) return;
    found.push({ line: i + 1, text: l.trim().slice(0, 140) });
  });
  return found;
}

function everySource(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.mjs$/.test(ent.name) || (d.endsWith(`${path.sep}bin`) && !/\.(ps1|sh|md|cmd)$/.test(ent.name) && ent.isFile())) out.push(p);
    }
  };
  for (const sub of ['src', 'bin']) if (fs.existsSync(path.join(dir, sub))) walk(path.join(dir, sub));
  return out;
}

// ------------------------------------------------------------------------------ the rules themselves

test('the scanner: a bad snippet is found, a masked one and an excepted one are not (positive control)', () => {
  const bad = 'const t = String(e.title ?? "").slice(0, 60);';
  assert.equal(unguardedCuts(bad).length, 1, 'rule 1 finds the unguarded cut');
  assert.equal(unguardedCuts(bad, { rule: 2 }).length, 1, 'rule 2 finds it too');
  assert.equal(unguardedCuts('const t = maskText(String(e.title ?? "")).slice(0, 60);').length, 0, 'maskText on the line');
  assert.equal(unguardedCuts('const t = cutMasked(e.title, 60);').length, 0, 'cutMasked');
  assert.equal(unguardedCuts('// mask-ok: already masked above\nconst t = String(e.title).slice(0, 60);').length, 0, 'an exception comment above');
  assert.equal(unguardedCuts('const t = String(e.title).slice(0, 60); // mask-ok: id only').length, 0, 'an exception comment on the line');
  assert.equal(unguardedCuts('const day = String(e.ts ?? "").slice(0, 10);').length, 0, 'a date is not entry text');
  assert.equal(unguardedCuts('const tail = stderrTail.slice(-2000);').length, 1, 'a tail cut of stderr is a cut too');
  assert.equal(receiverBefore("x = String(e.ts ?? '').slice(0, 10)", "x = String(e.ts ?? '')".length), "String(e.ts ?? '')");
  assert.equal(unguardedCuts("const a = `${String(h.id).padEnd(14)} ${String(h.title).slice(0, 70)}`;").length, 1, 'a benign word elsewhere on the line does not excuse the cut');
  assert.equal(unguardedCuts('// the title is cut with .slice(0, 80) below\nconst x = 1;').length, 0, 'a comment is not code');
});

// ------------------------------------------------------------------------------ rule 1: the watched files

test('rule 1: no watched file cuts text without a mask call or a `mask-ok:` reason', () => {
  const bad = [];
  for (const rel of WATCHED) {
    const p = path.join(REPO, rel);
    assert.ok(fs.existsSync(p), `${rel}: a watched file is gone; update WATCHED (a ratchet over a moved file guards nothing)`);
    for (const v of unguardedCuts(fs.readFileSync(p, 'utf8'))) bad.push(`${rel}:${v.line}: ${v.text}`);
  }
  assert.deepEqual(bad, [], `unguarded cuts (mask first with maskText/cutMasked, or explain with "mask-ok: <reason>"):\n${bad.join('\n')}`);
});

test('rule 1, red proof: on the files of acff04e the same scan finds the sites this round fixed', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-mbc-ratchet-'));
  try {
    exportCommit(REPO, OLD_STATE, ['src', 'bin'], dir);
    const hits = new Map();
    for (const rel of WATCHED) {
      const p = path.join(dir, rel);
      if (!fs.existsSync(p)) continue;
      const v = unguardedCuts(fs.readFileSync(p, 'utf8'));
      if (v.length) hits.set(rel, v.length);
    }
    // Each of these cut entry text before the fix. (display/shortline/dashboard-pass-style files that masked
    // the whole entry first are not in this list; they carry a `mask-ok:` now.)
    const mustHit = ['src/search.mjs', 'src/raw.mjs', 'src/retrieval.mjs', 'bin/mem-mcp', 'src/question.mjs',
      'src/cli/commands/agents.mjs', 'src/board.mjs', 'src/commandguard.mjs', 'src/errorcontext.mjs', 'src/cli/commands/write.mjs',
      'src/errorfixes.mjs', 'src/appointment-today.mjs', 'src/skillcatalog.mjs',
      'src/cli/commands/setup.mjs', 'src/cli/commands/admin.mjs', 'src/doctor.mjs', 'src/embed/openai.mjs',
      'src/source.mjs', 'src/broadcast.mjs', 'src/heartbeat.mjs', 'src/shrink.mjs', 'src/rewrites.mjs', 'src/tasks.mjs',
      'src/shardarchive.mjs', 'src/store.mjs', 'src/probescaffold.mjs'];
    assert.deepEqual(mustHit.filter((rel) => !hits.has(rel)), [], 'the scan should have found an unguarded cut in each of these old files (otherwise the ratchet would not have caught the bug)');
    assert.ok(hits.size >= 25, `the old tree should show many sites, saw ${hits.size}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------ rule 2: everywhere else

test('rule 2: no file in src/ or bin/ cuts an entry field inline without a mask call or a `mask-ok:` reason', () => {
  const bad = [];
  for (const p of everySource(REPO)) {
    const rel = path.relative(REPO, p).split(path.sep).join('/');
    for (const v of unguardedCuts(fs.readFileSync(p, 'utf8'), { rule: 2 })) bad.push(`${rel}:${v.line}: ${v.text}`);
  }
  assert.deepEqual(bad, [], `an entry field is cut before it is masked:\n${bad.join('\n')}`);
});

test('rule 2, red proof: on the files of acff04e it finds inline cuts', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-mbc-ratchet2-'));
  try {
    exportCommit(REPO, OLD_STATE, ['src', 'bin'], dir);
    let n = 0;
    for (const p of everySource(dir)) n += unguardedCuts(fs.readFileSync(p, 'utf8'), { rule: 2 }).length;
    assert.ok(n >= 3, `the old tree should show inline cuts, saw ${n}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------ the helpers stay what they are

test('outputguard keeps the order: mask first, cut second', async () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'outputguard.mjs'), 'utf8');
  assert.match(src, /export function cutMasked\(text, n\)[\s\S]*?const masked = maskText\(text\);[\s\S]*?masked\.slice\(0, Math\.max\(0, n\)\)/);
  assert.match(src, /export function windowMasked\(text, from, to\)[\s\S]*?const masked = maskText\(text\);[\s\S]*?masked\.slice\(a, Math\.max\(a, b\)\)/);
  const embed = fs.readFileSync(path.join(REPO, 'src', 'embed', 'index.mjs'), 'utf8');
  assert.match(embed, /export function textForProvider\(text\) \{\s*return cutMasked\(String\(text \?\? ''\), 8000\);/, 'the one seam of the embedding text');
  assert.match(embed, /const capped = textForProvider\(text\);/, 'embed() sends the seam\'s text');
});

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// Ratchet for "mask BEFORE cut" (cm error 2tjgr4psniuh; the probes are test/mask-before-cut.test.mjs).
//
// A key that crosses a cut leaves a stump no pattern recognises any more, so every place that shortens
// entry text must mask first: `maskText` / `cutMasked` / `windowMasked` / `maskEntry` (src/outputguard.mjs)
// or, on the write path, `redact*`, in front of the cut. This file keeps it that way.
//
// Two rules (the scanner is test/helpers/mask-cut-scan.mjs, a real parse):
//
//   1. WATCHED FILES (the explicit list below: every file that cut entry text when the round was made, plus the
//      ones inspected and found fine). In them EVERY cut (`x.slice(a, b)`, `.substring`, `.substr`, a tail cut
//      `x.slice(-n)`) must be GUARDED: its receiver calls a mask, or is a variable made from a mask in the same
//      function, or is plainly not entry text (a date, a hash, an array cut), or the cut carries a comment
//      `mask-ok: <reason>` on its line or in the four lines above. Per function, not per line: a mask elsewhere
//      in the same function does not excuse a cut of something else. A new unguarded cut turns this red.
//   2. EVERYWHERE ELSE in src/ and bin/: the commonest shape of the bug, an entry field cut inline
//      (`e.title.slice(0, 80)`, `String(e.text).slice(0, 60)`), with no mask call and no `mask-ok:`.
//
// Red proof: the same scan runs on the files of acff04e (a FIXED hash, never a moving merge-base) and must find the
// sites this round fixed. Mutation proof: the masks of the fixed sites are taken out one by one, IN MEMORY, and the
// scan must turn red for each (a ratchet that bites only nine of twenty-six removals was the review's finding).
// Rule 3 judges every HELPER anywhere in src/ and bin/ (a function whose cut length is one of its own parameters:
// `short(s, n)`, `clip`, `cap`, `excerpt`, `squash`): the mask has to stand in the helper, whatever its callers do.
// KNOWN LIMITS (what this ratchet does not see; the probes in mask-before-cut.test.mjs are the other half):
//   - cuts that are not a `.slice/.substring/.substr` call: `s.match(/^.{0,n}/)`, `s['slice'](..)`, `Buffer.subarray`,
//     `split(sep, n)`, a hand-written loop over characters;
//   - the receiver-name dictionary (BENIGN in the scanner): a variable called `key`, `ts`, `list` ... is taken to be a
//     date, a hash or an array, whatever it holds; a name outside the dictionary and not made from a mask needs a
//     `mask-ok` or a mask;
//   - the follow-the-variable check is generous: `x = raw + masked` or `x = f(masked, raw)` counts as masked, because the
//     right-hand side MENTIONS a masked name; a mixture of both is not told apart from a masked value;
//   - data flow beyond ONE function: a variable made from a mask in the same function counts, a parameter handed in
//     already masked does not (that is what rule 3 and the `mask-ok` reason are for);
//   - `mask-ok:` is trusted: it excuses the cut it stands above (four lines), and nobody re-checks the reason;
//   - files outside src/ and bin/ (bench, install), and the .ps1 twins.
// A structural pin covers what a scan cannot see (raw.snippet must cut through windowMasked). A watched file that is
// gone is reported, not skipped: a ratchet over a moved file guards nothing.
//
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommit } from './helpers/export-commit.mjs';
import { unguardedCuts } from './helpers/mask-cut-scan.mjs';

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
  'src/answercheck.mjs',
  'src/skillregistry.mjs', 'src/source.mjs', 'src/broadcast.mjs', 'src/ruledraft.mjs', 'src/heartbeat.mjs',
  'src/shrink.mjs', 'src/rewrites.mjs', 'src/bodyfields.mjs', 'src/tasks.mjs', 'src/shardarchive.mjs', 'src/store.mjs',
  'src/freshness.mjs', 'src/dashboard-head.mjs', 'src/probescaffold.mjs', 'src/errorsignature.mjs', 'src/dashboard-pass.mjs',
  'src/questiontext.mjs', 'src/cli/commands/search.mjs', 'src/cli/commands/capture.mjs',
  'src/cli/display.mjs', 'src/shortline.mjs',
  // the card work (H11) and the card rule: new text surfaces
  'src/cardrule.mjs', 'src/cardrules.mjs', 'src/cardstore.mjs', 'src/cardfeed.mjs', 'src/decisioncard.mjs', 'src/addressee.mjs',
  'src/humandecisions.mjs',
  // the answer budget (abruf-budget): pointer lines cut titles, so every cut there is masked first
  'src/answerbudget.mjs', 'src/workflowpointer.mjs', 'src/subagentstart.mjs', 'src/subagenttask.mjs', 'src/findcore.mjs',
  'src/workflowdetect.mjs', 'src/recallrender.mjs', 'src/recallhook.mjs',
]);

export { unguardedCuts };

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
  assert.equal(unguardedCuts("const a = `${String(h.id).padEnd(14)} ${String(h.title).slice(0, 70)}`;").length, 1, 'a benign word elsewhere on the line does not excuse the cut');
  assert.equal(unguardedCuts('// the title is cut with .slice(0, 80) below\nconst x = 1;').length, 0, 'a comment is not code');
  assert.equal(unguardedCuts('function f(s) { const t = maskText(s).trim(); return t.slice(0, 9); }').length, 0, 'a variable made from a mask');
  assert.equal(unguardedCuts('function f(s) { const t = s.trim(); return t.slice(0, 9); }').length, 1, 'a variable that is not');
  assert.equal(unguardedCuts('function f(s, u) { const a = maskText(u); return s.slice(0, 9); }').length, 1, 'a mask elsewhere in the function excuses nothing');
  assert.equal(unguardedCuts('const x = list.filter(Boolean).sort().slice(0, 9);').length, 0, 'an array chain');
  assert.equal(unguardedCuts('const x = text.slice(from, to);').length, 1, 'a window cut with two variables is a cut');
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
      'src/cli/commands/setup.mjs', 'src/cli/commands/admin.mjs', 'src/doctor.mjs',
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

// ------------------------------------------------------------------------------ rule 3: helpers, anywhere

test('rule 3: no helper in src/ or bin/ cuts to a length it is handed without masking first', () => {
  const bad = [];
  for (const p of everySource(REPO)) {
    const rel = path.relative(REPO, p).split(path.sep).join('/');
    const src = fs.readFileSync(p, 'utf8');
    if (/^#!.*\b(?:ba)?sh\b/.test(src.split('\n')[0])) continue;
    for (const v of unguardedCuts(src, { rule: 3 })) bad.push(`${rel}:${v.line}: ${v.text}`);
  }
  assert.deepEqual(bad, [], `a helper cuts before it masks:\n${bad.join('\n')}`);
});

test('rule 3, red proof: on the files of acff04e it finds the helpers this round fixed', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cm-mbc-ratchet3-'));
  try {
    exportCommit(REPO, OLD_STATE, ['src', 'bin'], dir);
    const hits = new Set();
    for (const p of everySource(dir)) {
      const src = fs.readFileSync(p, 'utf8');
      if (/^#!.*\b(?:ba)?sh\b/.test(src.split('\n')[0])) continue;
      if (unguardedCuts(src, { rule: 3 }).length) hits.add(path.relative(dir, p).split(path.sep).join('/'));
    }
    for (const rel of ['src/teach.mjs', 'src/closingreport.mjs', 'src/ruledraft.mjs', 'src/dashboard-data.mjs', 'src/answercheck.mjs', 'src/skillregistry.mjs', 'src/bodyfields.mjs']) {
      assert.ok(hits.has(rel), `${rel}: the old helper should be found`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------------------ the helpers stay what they are

test('outputguard keeps the order: mask first, cut second', async () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'outputguard.mjs'), 'utf8');
  assert.match(src, /export function cutMasked\(text, n\)[\s\S]*?const masked = maskText\(text\);[\s\S]*?masked\.slice\(0, Math\.max\(0, n\)\)/);
  assert.match(src, /export function windowMasked\(text, from, to\)[\s\S]*?const masked = maskText\(text\);[\s\S]*?masked\.slice\(a, Math\.max\(a, b\)\)/);
});

// ------------------------------------------------------------------------------ mutation proof

/** Each entry takes ONE mask out of a fixed site, leaving the cut: the scan must turn red on the result. */
const MUTATIONS = [
  ['src/teach.mjs', 'teach.short', (s) => s.replace('maskText(String(e?.title ?? e?.choice ?? e?.text ?? e?.fact ?? e?.id ?? \'\'))', 'String(e?.title ?? e?.choice ?? e?.text ?? e?.fact ?? e?.id ?? \'\')')],
  ['src/closingreport.mjs', 'closing.short', (s) => s.replace('maskText(String(s ?? \'\'))', 'String(s ?? \'\')')],
  ['src/ruledraft.mjs', 'ruledraft.clip', (s) => s.replace('maskText(String(s ?? \'\'))', 'String(s ?? \'\')')],
  ['src/skillcatalog.mjs', 'whenOf', (s) => s.replace('maskText(String(raw))', 'String(raw)')],
  ['src/skillcatalog.mjs', 'shortTitle', (s) => s.replace("maskText(String(e.title ?? e.rule ?? fallback ?? ''))", "String(e.title ?? e.rule ?? fallback ?? '')")],
  ['src/dashboard-data.mjs', 'excerpt', (s) => s.replace("maskText(String(s ?? ''))", "String(s ?? '')")],
  ['src/timesearch.mjs', 'shortContent', (s) => s.replace('maskText(c)', 'c')],
  ['src/errorsignature.mjs', 'signature', (s) => s.replace('maskText(line).trim()', 'line.trim()')],
  ['src/source.mjs', 'source.line', (s) => s.replace("cutMasked(String(e.title ?? ''), 50)", "String(e.title ?? '').slice(0, 50)")],
  ['src/bodyfields.mjs', 'restOfBody', (s) => s.replace('maskText(bodyAsText(e[f]))', 'bodyAsText(e[f])')],
  ['src/answercheck.mjs', 'redactExcerpt', (s) => s.replace('maskText(String(s))', 'String(s)')],
  ['src/question.mjs', 'question.line', (s) => s.replace('maskText(String(q.question))', 'String(q.question)')],
  ['src/board.mjs', 'board', (s) => s.replace("maskText(String(open[0]?.question ?? ''))", "String(open[0]?.question ?? '')")],
  ['src/cli/commands/agents.mjs', 'why90', (s) => s.replace('maskText(String(q.why))', 'String(q.why)')],
  ['src/skillregistry.mjs', 'cap', (s) => s.replace('maskText(String(s)).replace(/\\s+/g, \' \').trim()', 'String(s).replace(/\\s+/g, \' \').trim()')],
  ['src/errorfixes.mjs', 'short', (s) => s.replace("maskText(String(e.title ?? e.learning ?? e.rule ?? e.text ?? ''))", "String(e.title ?? e.learning ?? e.rule ?? e.text ?? '')")],
  ['src/commandguard.mjs', 'collect', (s) => s.replace("maskText(String(e.title ?? e.text ?? '')).replace(/\\s+/g, ' ').trim().slice(0, TITLE_MAX),\n      patterns", "String(e.title ?? e.text ?? '').replace(/\\s+/g, ' ').trim().slice(0, TITLE_MAX),\n      patterns")],
  ['src/probescaffold.mjs', 'title', (s) => s.replace("oneLine(maskText(String(entry.title ?? entry.text ?? '(no title)')))", "oneLine(String(entry.title ?? entry.text ?? '(no title)'))")],
  ['src/tasks.mjs', 'stderr tail', (s) => s.replace('maskText(stderrTail).slice(-2000)', 'stderrTail.slice(-2000)')],
  ['src/closingreport.mjs', 'report names', (s) => s.replace("${short(nameOf(p), 60)}", "${String(nameOf(p)).slice(0, 60)}")],
  ['src/appointment-today.mjs', 'sessionLine', (s) => s.replace("maskText(String(next.title ?? ''))", "String(next.title ?? '')")],
  ['src/doctor.mjs', 'alarm short', (s) => s.replace("maskText(String(t ?? '')).split", "String(t ?? '').split")],
  ['src/neighbours.mjs', 'line', (s) => s.replace("maskText(String(core))", "String(core)")],
  ['src/recallrender.mjs', 'cutAtBoundary', (s) => s.replace("squash(maskText(String(t ?? '')))", 'squash(t)')],
  ['src/subagenttask.mjs', 'squash', (s) => s.replace("maskText(String(text ?? '')).replace", "String(text ?? '').replace")],
];

for (const [rel, name, mutate] of MUTATIONS) {
  test(`mutation: ${rel} (${name}): taking the mask out is caught`, () => {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const count = (x) => unguardedCuts(x).length + unguardedCuts(x, { rule: 2 }).length + unguardedCuts(x, { rule: 3 }).length;
    const watched = WATCHED.includes(rel);
    if (watched) assert.deepEqual(unguardedCuts(src), [], 'control: the real file is clean');
    const out = mutate(src);
    assert.notEqual(out, src, 'the anchor is stale: the mutation changed nothing (update the table with the code)');
    assert.ok(count(out) > count(src), `not caught: ${rel} ${name}`);
  });
}

test('structure: the error paths of the MCP bridge mask their text', () => {
  const src = fs.readFileSync(path.join(REPO, 'bin', 'mem-mcp'), 'utf8');
  assert.match(src, /text: maskText\(`Error: \$\{e\.message\}`\)/, 'the text of a failed tool call');
  assert.match(src, /message: maskText\(String\(message\)\)/, 'the JSON-RPC error of the HTTP bridge');
});

test('structure: raw.snippet cuts its window through windowMasked, and the other sites call the helpers they must', () => {
  const raw = fs.readFileSync(path.join(REPO, 'src', 'raw.mjs'), 'utf8');
  const body = /export function snippet\([\s\S]*?\n}\n/.exec(raw)[0];
  assert.match(body, /windowMasked\(text, from, to\)/, 'the window is cut from the MASKED text');
  assert.match(body, /maskText\(textOf\(l\)\)/, 'and the hit is located in the masked text');
  assert.doesNotMatch(body.replace(/windowMasked\(text, from, to\)/, ''), /text\.slice\(/, 'no plain slice of the text is left in snippet');
});

// ------------------------------------------------------------------------------ pins for the places a scan cannot see

/**
 * The card text tools cut to a cost bound with `costCut` (which drops the run the edge broke) and mask what is kept. `clean`
 * has no cut call a scan could judge, so the order is pinned: each entry is a statement that must stand, and the same
 * statement with its mask (or its `costCut`) taken out must NOT match, so the pin is known to bite. The behaviour is proved
 * by the probe with mutant trees in mask-before-cut.test.mjs.
 */
const PINS = [
  ['src/cardrules.mjs', /const t = typeof v === 'string' \? maskText\(costCut\(v, MAX_IN\)\)/, 'clean() masks what costCut kept'],
  ['src/cardrules.mjs', /return maskText\(costCut\(String\(text \?\? ''\), SENTENCE_SOURCE_MAX\)\)/, 'plainText() likewise'],
  ['src/cardrule.mjs', /maskText\(scrub\(costCut\(v, 2 \* rules\.MAX_IN\)\)\)/, 'partsOf() likewise'],
  ['src/decisioncard.mjs', /maskText\(costCut\(v, MASK_CLIP\)\)/, 'maskedCopy() likewise'],
  ['src/decisioncard.mjs', /const raw = costCut\(String\(t \?\? ''\), 2 \* rules\.MAX_IN\)/, 'textWithoutSource() bounds with costCut'],
  ['src/cardstore.mjs', /\.\.\.maskedInFields\(fields\)/, 'write() reports what the mask took out'],
  ['src/outputguard.mjs', /if \(\/\\s\/\.test\(text\[n\]\)\) return window\.trimEnd\(\);[\s\S]*?while \(i > 0 && !\/\\s\/\.test\(window\[i - 1\]\)\) i -= 1;/, 'costCut() drops the run the edge broke'],
];
for (const [rel, pin, what] of PINS) {
  test(`pin: ${rel}: ${what}`, () => {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.match(src, pin, 'the statement stands');
    const broken = src.replace(/maskText\(costCut\(/g, 'costCut(').replace(/costCut\(/g, 'cutPlain(').replace(/\.\.\.maskedInFields\(fields\)/, '')
      .replace('if (/\\s/.test(text[n])) return window.trimEnd();', '');
    assert.doesNotMatch(broken, pin, 'control: with the mask or the bound taken out the pin no longer matches');
  });
}

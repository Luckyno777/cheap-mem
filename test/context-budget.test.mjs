// A context block is paid for by the character, not by the entry.
//
// **The finding.** `mem context` had one dial: `--n`, a COUNT. But
// nobody's limit is expressed in entries. Twenty short events and twenty
// pasted stack traces are the same `n` and differ by an order of
// magnitude in what they cost the model that reads them. A caller with a
// real ceiling could not state it — they had to guess an `n` and hope.
//
// **What a budget has to be worth.** Three things, and each one is a
// probe below, because each one is a way for a budget to be decorative:
//
//   1. It is never exceeded. "Mostly within budget" is not a budget.
//   2. Nothing is cut mid-entry. Half an error line reads as a fact
//      about the error, not as a truncation.
//   3. The block SAYS what did not fit. A silently shortened digest and
//      a quiet memory look identical, and that is the one confusion a
//      memory system must never cause.
//
// **Characters, not tokens.** Counting tokens needs the tokenizer of the
// model that will read the block, and this tool carries none — no heavy
// dependency, no network, same answer on every clone. Four characters
// per token is a rule of thumb for English prose and it is wrong for
// ids, paths and timestamps, which is most of what this block contains.
// So the limit is in characters, which is exact, and the token figure is
// printed beside it as an estimate. A budget that calls itself tokens
// while counting characters is the same guess in better clothes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HERE, '..', 'bin', 'mem');

function mem(root, ...argv) {
  try {
    return { code: 0, out: execFileSync('node', [MEM, '--root', root, ...argv], { encoding: 'utf8' }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

// Long entries on purpose. A fixture of one-line entries would let a
// broken budget pass, because nothing would ever have to be cut.
const LANG = 'a fairly long description of what went wrong, with a stack trace '
  + 'pasted in by somebody who did not trim it, which is exactly the kind of '
  + 'entry that makes an entry COUNT a useless way to size a context block';

function build() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-budget-'));
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  for (let i = 1; i <= 8; i += 1) {
    mem(r, 'log', 'error', '--class', 'flaky', '--title', `test failure ${i}`, '--text', LANG);
  }
  for (let i = 1; i <= 4; i += 1) {
    mem(r, 'log', 'decision', '--topic', `topic-${i}`, '--choice', `choice ${i}`, '--why', LANG);
  }
  return r;
}

test('THE CASE: without a budget the block is long enough to need one', () => {
  // Otherwise every probe below passes on a block that never had to be
  // cut, and the budget could be a no-op.
  const r = build();
  try {
    const voll = memory.context(r, { n: 20 });
    assert.ok(voll.length > 1500,
      `the fixture only produces ${voll.length} characters — nothing here would ever be cut`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NEVER EXCEEDED: every budget from the floor upward is kept', () => {
  // A sweep, not one hand-picked number. The interesting sizes are the
  // ones where a section can ALMOST afford its heading, and those are
  // not where anybody would think to look.
  const r = build();
  try {
    const voll = memory.context(r, { n: 20 }).length;
    const ueber = [];
    for (let b = memory.MIN_CONTEXT_CHARS; b <= voll + 400; b += 7) {
      const text = memory.context(r, { n: 20, maxChars: b });
      if (text.length > b) ueber.push(`${b} -> ${text.length}`);
    }
    assert.deepEqual(ueber, [],
      'these budgets produced a longer block than they allowed');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('NEVER MID-ENTRY: no line of the fixture text appears half written', () => {
  // The cheap way to keep a budget is to slice the string. It keeps the
  // number and destroys the meaning: a truncated error line still reads
  // as a complete statement about the error.
  //
  // **Measured against the UNBUDGETED block, not against the raw entry.**
  //
  // The first version of this probe compared each line to the text that
  // had been logged, and failed — but not on the budget. `shortText()`
  // shortens every entry to 120 characters for the digest, at EVERY
  // budget and with none at all. That is a display decision made long
  // before this flag existed, and this probe is not about it.
  //
  // The rule that belongs here is narrower and is the one the budget can
  // actually break: whatever the budget keeps, it keeps WHOLE. So every
  // line of a budgeted block must appear, character for character, in the
  // block built without a budget.
  const r = build();
  try {
    const vollZeilen = new Set(memory.context(r, { n: 20 }).split('\n'));
    for (const b of [400, 700, 1100, 1600]) {
      const text = memory.context(r, { n: 20, maxChars: b });
      for (const zeile of text.split('\n')) {
        // The headings carry counts that differ once something was cut,
        // and the footer exists only in the budgeted block.
        if (zeile.startsWith('---') || zeile.startsWith('  cut to fit')
          || zeile.startsWith('  everything fitted')) continue;
        assert.ok(vollZeilen.has(zeile),
          `budget ${b} produced a line that is not in the full block — `
          + `it was cut or reshaped:\n    ${zeile}`);
      }
    }
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('IT SAYS WHAT DID NOT FIT, and how much', () => {
  const r = build();
  try {
    const eng = memory.context(r, { n: 20, maxChars: 600 });
    assert.match(eng, /cut to fit:/,
      'the block was shortened and does not say so — indistinguishable from a quiet memory');
    assert.match(eng, /\d+ errors/, 'it does not say how many errors were dropped');

    const weit = memory.context(r, { n: 20, maxChars: 100000 });
    assert.match(weit, /everything fitted/,
      'a block that fitted does not say so, so the reader cannot tell it is complete');
    assert.ok(!/cut to fit/.test(weit), 'a complete block claims to have been cut');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('EMPTY IS NOT CUT: a section with nothing in it still says (none)', () => {
  // Three states again. "measured, nothing there" and "dropped for
  // space" must not look the same — and they would, because the footer
  // only names what was cut, so a missing heading alone is ambiguous.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-budget-leer-'));
  try {
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    mem(r, 'log', 'error', '--class', 'flaky', '--title', 'the only error', '--text', 'short');
    const text = memory.context(r, { n: 20, maxChars: 100000 });
    assert.match(text, /--- last 0 events ---/, 'the empty events section vanished');
    assert.match(text, /\(none\)/, 'nothing says that a section was measured and empty');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('THE MOST IMPORTANT SECTION SURVIVES LONGEST', () => {
  // Sections give way from the bottom up. Recent errors are why anyone
  // pastes this block at all; the project list can be looked up in a
  // second. A budget that dropped them in file order would keep the
  // number and lose the point.
  const r = build();
  try {
    const eng = memory.context(r, { n: 20, maxChars: memory.MIN_CONTEXT_CHARS + 260 });
    assert.match(eng, /--- last \d+ errors ---/,
      'at a tight budget the errors were dropped while something else was kept');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('A BUDGET THAT CANNOT BE KEPT IS REFUSED, with the real number', () => {
  // The floor is DERIVED from the header and the longest footer, not
  // written by hand. The hand-written version was 200, and at 250 the
  // guarantee check inside context() threw — correctly, but a caller
  // should never get that far, and the moment someone adds a header line
  // a hand-written floor is a lie again.
  const r = build();
  try {
    const { out } = mem(r, 'context', '--budget', '50');
    assert.match(out, /not a usable size/, '--budget 50 was accepted');
    assert.ok(out.includes(String(memory.MIN_CONTEXT_CHARS)),
      'the refusal does not name the smallest budget that would work');
    // And the floor itself really works — otherwise the message sends
    // the caller to a number that also fails.
    const amRand = memory.context(r, { n: 20, maxChars: memory.MIN_CONTEXT_CHARS });
    assert.ok(amRand.length <= memory.MIN_CONTEXT_CHARS,
      `the advertised floor ${memory.MIN_CONTEXT_CHARS} produces ${amRand.length} characters`);
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

test('WITHOUT --budget nothing changed', () => {
  // The unbudgeted block is what every existing caller and hook gets.
  // Adding a dial must not quietly reshape the default.
  const r = build();
  try {
    const text = memory.context(r, { n: 20 });
    assert.match(text, /^=== cheap-mem context ===/);
    assert.match(text, /--- last \d+ errors ---/);
    assert.match(text, /--- projects \(\d+\) ---/);
    assert.ok(!/--- budget /.test(text),
      'the unbudgeted block carries a budget footer it never asked for');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

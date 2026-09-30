// F4 (2026-09-30): a pointer to code names a SYMBOL, not a line.
//
// The 2026-09-30 audit found 30+ `file.mjs:NNN` references in comments
// and docs pointing at the wrong line — every edit above the line moves
// it, and nothing notices. `file#symbol` does not move. This probe makes
// the form honest: every `path/to/file#symbol` in a living document or
// a code comment must name something that exists — a declared function,
// constant, class or object key in a code file, or a heading in a
// markdown file (GitHub slug).
//
// It does NOT forbid the old `file:NNN` form in a dated record (a
// changelog, a dated analysis states what was true that day); the
// scan skips archives by the same rule the number guards use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isArchive } from '../bench/readme-numbers.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** `src/search.mjs#isEcho`, `docs/security-model.md#6-resource-bounds`. */
const REF = /\b((?:src|bin|bench|eval|docs|hooks|install|test)\/[\w./-]*\.(?:mjs|js|sh|ps1|md))#([A-Za-z_$0-9][\w$-]*)/g;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** GitHub's heading slug: lower case, drop punctuation, spaces to hyphens. */
export function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

/** Is `symbol` declared in (or a heading of) the file `abs`? */
export function declared(abs, symbol) {
  if (!fs.existsSync(abs)) return false;
  const text = fs.readFileSync(abs, 'utf8');
  if (abs.endsWith('.md')) {
    return text.split('\n').some((l) => /^#{1,6} /.test(l) && slug(l.replace(/^#+\s*/, '')) === symbol);
  }
  const s = esc(symbol);
  return new RegExp(
    `^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+${s}\\b`
    + `|^\\s+(?:'${s}'|"${s}"|${s})\\s*:`
    + `|^\\s*${s}\\s*\\(\\)\\s*\\{`, 'm').test(text);
}

function trackedText() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  return out.filter((f) => /\.(mjs|js|sh|ps1|md)$/.test(f) || /^bin\/mem[\w-]*$/.test(f))
    .filter((f) => !isArchive(f) && !f.startsWith('assets/'));
}

function allRefs() {
  const refs = [];
  for (const rel of trackedText()) {
    const p = path.join(REPO, rel);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.matchAll(REF)) {
      refs.push({ from: rel, line: text.slice(0, m.index).split('\n').length, file: m[1], symbol: m[2] });
    }
  }
  return refs;
}

test('every file#symbol reference names something that exists', () => {
  const refs = allRefs();
  const bad = refs.filter((r) => !declared(path.join(REPO, r.file), r.symbol));
  assert.deepEqual(bad.map((r) => `${r.from}:${r.line} -> ${r.file}#${r.symbol}`), [],
    'a reference points at a symbol that does not exist (renamed? then rename the reference)');
});

test('POSITIVE: the scan finds the references that were converted (it does not pass on an empty list)', () => {
  const refs = allRefs();
  assert.ok(refs.length >= 25, `only ${refs.length} file#symbol references found — the scan is blind or the references were lost`);
  assert.ok(refs.some((r) => r.file === 'src/search.mjs' && r.symbol === 'CACHE_WRITE_AFTER_BYTES'));
  assert.ok(refs.some((r) => r.file.endsWith('security-model.md')), 'no markdown heading reference is exercised');
});

test('RED on a wrong reference: the checker refuses a missing symbol, a missing file, a missing heading', () => {
  assert.equal(declared(path.join(REPO, 'src/search.mjs'), 'isEcho'), true);
  assert.equal(declared(path.join(REPO, 'src/search.mjs'), 'noSuchSymbolAnywhere'), false);
  assert.equal(declared(path.join(REPO, 'src/nope.mjs'), 'isEcho'), false);
  assert.equal(declared(path.join(REPO, 'src/cli/commands/search.mjs'), 'digest'), true, 'an object key handler');
  assert.equal(declared(path.join(REPO, 'docs/security-model.md'), '6-resource-bounds'), true);
  assert.equal(declared(path.join(REPO, 'docs/security-model.md'), '99-nothing'), false);
  // the substring trap: `search` is a symbol, `searc` is not
  assert.equal(declared(path.join(REPO, 'src/search.mjs'), 'searc'), false);
});

// A PowerShell script that is not ASCII is a PowerShell script that
// Windows PowerShell 5.1 reads wrong.
//
// **The measurement (2026-09-19, CI run 232).** The new installer step
// ran `powershell -File install\windows.ps1` - the exact line
// README.md:613 and docs/install-windows.md:68 tell people to run - and
// got:
//
//     At D:\a\cheap-mem\cheap-mem\install\windows.ps1:179 char:27
//     + if (-not $SkipClaudeCode) {
//     Missing closing '}' in statement block or type definition.
//
// The file has no byte-order mark. Without one, Windows PowerShell 5.1
// decodes a script with the machine's ANSI codepage, CP1252 on the
// runner - not UTF-8. So an em dash, UTF-8 bytes E2 80 94, arrives as
// three characters, and the last of them is byte 0x94, which CP1252
// maps to U+201D RIGHT DOUBLE QUOTATION MARK. PowerShell accepts that
// character as a closing double quote.
//
// Line 353 was
//
//     Write-Warning "$Settings is not JSON - leaving it alone (...)"
//
// with an em dash inside a double-quoted string. The string ended in
// the middle, the rest of the line became tokens, the real closing
// quote opened a new string, and the brace opened at line 179 was never
// closed. The reported line and the real cause are 174 lines apart,
// which is why this is worth a guard rather than a repair.
//
// **Why ASCII and not a blocklist of quote-ish characters.** Every
// non-ASCII character encodes to bytes at or above 0x80, and CP1252
// fills 0x80-0x9F with punctuation - three quote characters among them.
// Which of them a given character happens to produce is an accident of
// its code point. A blocklist would have to be re-derived every time
// someone types a new character; the shape "stay in ASCII" cannot fall
// behind.
//
// **Why not just add a BOM.** A BOM would fix the decoding and is
// invisible: an editor, a copy-paste, a `cat > file` and it is gone,
// with nothing red to say so. This rule is visible in the source and
// measurable on any machine, including this Linux one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every PowerShell script we ship, found rather than listed. */
function powershellScripts() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.ps1$/i.test(e.name)) continue;
      out.push({
        rel: path.relative(REPO, p).split(path.sep).join('/'),
        text: fs.readFileSync(p, 'utf8'),
      });
    }
  };
  walk(REPO);
  return out;
}

/** The offending characters of a text, with the line they sit on. */
function nonAscii(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const ch of line) {
      if (ch.codePointAt(0) > 127) out.push({ nr: i + 1, ch, line });
    }
  });
  return out;
}

test('every shipped PowerShell script is pure ASCII', () => {
  const offenders = [];
  for (const { rel, text } of powershellScripts()) {
    for (const { nr, ch } of nonAscii(text)) {
      offenders.push(`${rel}:${nr}: U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} ${ch}`);
    }
  }
  assert.deepEqual(offenders, [],
    'Windows PowerShell 5.1 reads a BOM-less script as CP1252, not UTF-8. '
    + 'These characters arrive as something else there, and some of them '
    + 'arrive as quote characters that end a string early. Use ASCII: '
    + '"-" for a dash, "->" for an arrow.');
});

test('POSITIVE CONTROL: the probe reads the real scripts and the detector fires', () => {
  const files = powershellScripts();
  // 9 on 2026-09-19: eight in bin/, one in install/. A floor, not an
  // equality - the point is that the walker found the tree at all.
  assert.ok(files.length >= 9, `only ${files.length} .ps1 files found - the walker broke`);
  for (const expected of ['install/windows.ps1', 'bin/mem-retrieve.ps1']) {
    assert.ok(files.some((f) => f.rel === expected), `${expected} is not seen by the probe`);
  }
  // The detector must fire on the exact shape that broke the installer.
  const gefunden = nonAscii('Write-Warning "not JSON \u2014 leaving it alone"');
  assert.equal(gefunden.length, 1, 'the detector does not see an em dash');
  assert.equal(gefunden[0].ch.codePointAt(0), 0x2014);
  // And it must stay quiet on a line that is already correct, otherwise
  // it would report every file forever.
  assert.equal(nonAscii('Write-Warning "not JSON - leaving it alone"').length, 0);
});

test('the mechanism: the forbidden character really carries a byte CP1252 turns into a quote', () => {
  // The comment at the top of this file claims a chain. This runs the
  // measurable half of it, so the explanation cannot rot into a story:
  // the em dash encodes to a byte 0x94, and 0x94 is the CP1252 slot of
  // U+201D RIGHT DOUBLE QUOTATION MARK, which PowerShell reads as a
  // closing double quote.
  const bytes = [...Buffer.from('\u2014', 'utf8')];
  assert.deepEqual(bytes, [0xE2, 0x80, 0x94]);
  assert.ok(bytes.some((b) => b >= 0x80 && b <= 0x9F),
    'no byte in the CP1252 punctuation range - the stated mechanism would not apply');
});

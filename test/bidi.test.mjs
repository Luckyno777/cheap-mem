// Trojan-Source bidi-override characters (CVE-2021-42574), caught at
// DISPLAY time — see the long comment at the top of src/bidi.mjs for
// why display and not write, and why this is a CLOSED nine-codepoint
// list rather than "every Bidi_Class character".
//
// Two probes are MANDATORY, not optional extras, because a filter of
// this shape fails in exactly two directions and either one makes it
// worthless:
//
//   - too narrow: misses a real attack (nothing tests that here beyond
//     the ordinary has()/count()/visible() unit tests — the closed list
//     IS the nine CVE codepoints, verified against the CVE's own range).
//   - too broad: flags real right-to-left PROSE as an attack. Arabic and
//     Hebrew letters are not in this module's list at all — they carry
//     Bidi_Class R/AL, which the Unicode algorithm resolves without any
//     of the nine explicit controls — but a filter built by accident
//     from the wrong Unicode property (the general Bidi_Class, say)
//     would flag them, and a security control that cries wolf on normal
//     human writing gets disabled by the first person it inconveniences.
//
// And a module nobody calls is not a control at all — hence the
// "somebody actually calls it" probe, which reads the real integration
// sites WITH COMMENTS STRIPPED, so a call that was commented out during
// a refactor cannot pass by looking like one.
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bidi from '../src/bidi.mjs';
import { compactLine, sanitizeForDisplay } from '../src/cli/display.mjs';
import * as memory from '../src/memory.mjs';
import * as browse from '../src/browse.mjs';
import * as cfg from '../src/config.mjs';
import * as viewer from '../src/viewer.mjs';

const MEM = fileURLToPath(new URL('../bin/mem', import.meta.url));

// --- the closed list itself --------------------------------------------

const NINE = [
  0x202A, 0x202B, 0x202C, 0x202D, 0x202E,
  0x2066, 0x2067, 0x2068, 0x2069,
];

test('CODEPOINTS is exactly the nine CVE-2021-42574 characters, no more, no fewer', () => {
  assert.deepEqual([...bidi.CODEPOINTS].sort((a, b) => a - b), [...NINE].sort((a, b) => a - b));
  assert.equal(bidi.CODEPOINTS.length, 9);
});

test('has()/count() find each of the nine, alone and buried in prose', () => {
  for (const cp of NINE) {
    const ch = String.fromCodePoint(cp);
    assert.equal(bidi.has(ch), true, `U+${cp.toString(16)} not detected alone`);
    assert.equal(bidi.count(`hello ${ch} world`), 1, `U+${cp.toString(16)} not detected in prose`);
  }
});

test('has()/count() are false/zero on ordinary text', () => {
  assert.equal(bidi.has('nothing unusual here'), false);
  assert.equal(bidi.count('nothing unusual here, at all, really'), 0);
  assert.equal(bidi.has(''), false);
  assert.equal(bidi.has(null), false);
  assert.equal(bidi.has(undefined), false);
});

test('count() counts every occurrence, not just whether any exist', () => {
  const s = `a${String.fromCodePoint(0x202E)}b${String.fromCodePoint(0x2066)}c${String.fromCodePoint(0x202E)}d`;
  assert.equal(bidi.count(s), 3);
});

test('visible() replaces every occurrence with a plain-ASCII marker', () => {
  for (const cp of NINE) {
    const ch = String.fromCodePoint(cp);
    const out = bidi.visible(`before${ch}after`);
    assert.ok(!out.includes(ch), `raw U+${cp.toString(16)} survived visible()`);
    assert.ok(!/[‪-‮⁦-⁩]/.test(out), 'visible() left some other bidi char behind');
    const hex = cp.toString(16).toUpperCase().padStart(4, '0');
    assert.ok(out.includes(`U+${hex}`), `marker does not name U+${hex}: ${out}`);
    // The marker itself must be pure ASCII — a marker that reintroduces
    // a directional character would just move the attack.
    assert.ok(/^[\x00-\x7F]*$/.test(out), `visible() output is not pure ASCII: ${out}`);
  }
});

test('visible() is a no-op on text with nothing to neutralise', () => {
  const s = 'plain English, nothing to see here';
  assert.equal(bidi.visible(s), s);
  assert.equal(bidi.visible(''), '');
  assert.equal(bidi.visible(null), null);
});

// --- MANDATORY PROBE: real Arabic and Hebrew text is untouched ----------

test('MANDATORY: real Arabic prose is not flagged and not altered', () => {
  // "Welcome to the library. This is ordinary Arabic text, right to
  // left, with no formatting control characters in it at all."
  const arabic = 'مرحبا بكم في المكتبة. هذا نص عربي عادي من اليمين إلى اليسار.';
  assert.equal(bidi.has(arabic), false, 'ordinary Arabic prose was flagged as a bidi attack');
  assert.equal(bidi.count(arabic), 0);
  assert.equal(bidi.visible(arabic), arabic, 'ordinary Arabic prose was altered');
});

test('MANDATORY: real Hebrew prose is not flagged and not altered', () => {
  // "Hello and blessing, this is ordinary Hebrew text."
  const hebrew = 'שלום וברכה, זהו טקסט עברי רגיל מימין לשמאל.';
  assert.equal(bidi.has(hebrew), false, 'ordinary Hebrew prose was flagged as a bidi attack');
  assert.equal(bidi.count(hebrew), 0);
  assert.equal(bidi.visible(hebrew), hebrew, 'ordinary Hebrew prose was altered');
});

test('MANDATORY: mixed Arabic/Hebrew/Latin prose, still no false positive', () => {
  const mixed = 'Invoice للعميل: Hello שלום, total 42 EUR — مرحبا.';
  assert.equal(bidi.has(mixed), false);
  assert.equal(bidi.visible(mixed), mixed);
});

test('an override character hidden INSIDE real Arabic text is still caught', () => {
  // The false-positive probe above must not become a false NEGATIVE
  // loophole — "it's Arabic, so skip it" would be exactly that.
  const arabic = 'مرحبا';
  const smuggled = `${arabic}${String.fromCodePoint(0x202E)}evil${arabic}`;
  assert.equal(bidi.has(smuggled), true);
  assert.ok(!bidi.visible(smuggled).includes(String.fromCodePoint(0x202E)));
});

// --- MANDATORY PROBE: somebody actually calls it -------------------------

/**
 * Strip JS comments (// and /* *\/) while respecting string and
 * template-literal boundaries, so a comment naming `bidi.visible(`
 * cannot be mistaken for a call, and so a real call inside a string is
 * not (a call is never inside a string here, but a naive `//`/`/*`
 * scan without this would also break on any regex literal containing
 * a slash — none of the files this runs against have one near the
 * calls in question).
 */
function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = null;
  while (i < n) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (c === inString) inString = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inString = c; out += c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

test('the comment stripper actually strips (so the probe below is not empty green)', () => {
  const src = 'const a = 1; // bidi.visible(should not count)\n'
    + '/* bidi.visible(also should not count) */\n'
    + 'const s = "bidi.visible(inside a string, harmless either way)";\n'
    + 'real(bidi.visible(x));\n';
  const stripped = stripJsComments(src);
  assert.ok(!stripped.includes('should not count'), 'line comment survived stripping');
  assert.ok(!stripped.includes('also should not count'), 'block comment survived stripping');
  assert.ok(stripped.includes('real(bidi.visible(x))'), 'a real call was stripped along with the comments');
});

const CALL_SITES = [
  { file: 'src/cli/display.mjs', pattern: /\bbidi\.visible\(/, why: 'compactLine — mem find, mem component (before-edit hook), mem when, board' },
  { file: 'src/memory.mjs', pattern: /\bbidi\.visible\(/, why: 'shortText — memory.context(), the SessionStart hook' },
  { file: 'src/browse.mjs', pattern: /\bbidi\.visible\(/, why: 'fit() — every line mem browse prints' },
];

test('MANDATORY: somebody actually calls bidi.visible() outside of a comment', () => {
  for (const site of CALL_SITES) {
    const src = fs.readFileSync(new URL(`../${site.file}`, import.meta.url), 'utf8');
    const stripped = stripJsComments(src);
    assert.match(stripped, site.pattern,
      `${site.file} does not call bidi.visible() outside a comment (${site.why}) — `
      + 'a mention in a docstring is not a call');
    // And the import itself must be real, or the call above is dead code
    // that would throw the moment it actually ran.
    assert.match(stripped, /from ['"]\.{1,2}\/(?:\.\.\/)?bidi\.mjs['"]/,
      `${site.file} calls bidi but does not import it — the call must be unreachable code`);
  }
});

test('MANDATORY: bin/mem-retrieve — the per-turn hook — also calls visible() outside a bash comment', () => {
  // A different comment syntax (bash `#`), and the call sits inside an
  // embedded `node -e` script rather than an imported .mjs module, so
  // it needs its own narrow check rather than reusing stripJsComments.
  const src = fs.readFileSync(new URL('../bin/mem-retrieve', import.meta.url), 'utf8');
  const withoutBashComments = src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  // The MODULE must be loaded — but deliberately NOT a particular way of
  // loading it. The first version of this line demanded
  // `require(process.env.MEM_BIDI)` literally, and that pinned a
  // mechanism which only works from Node 22.12 on: on Node 20, inside
  // this package's own `engines: >=18` and its own CI matrix, that
  // `require` throws ERR_REQUIRE_ESM, the hook's catch swallows it, and
  // the raw override characters go straight into an agent's context.
  // The probe was green for that version (measured 2026-09-19) — it was
  // checking the spelling, not the effect. `test/retrieve.sh` check 10
  // now runs the hook under `--no-experimental-require-module` and
  // measures the effect itself.
  assert.match(withoutBashComments, /process\.env\.MEM_BIDI/,
    'bin/mem-retrieve no longer loads src/bidi.mjs');
  assert.match(withoutBashComments, /\bvisible\(/,
    'bin/mem-retrieve loads bidi but never calls visible() — mem find returns the RAW '
    + 'entry (not display.compactLine\'s already-sanitised label), so this is the one '
    + 'place an automatic per-turn hook is protected at all');
});

// --- integration: the real call sites actually neutralise it ------------

function tmpRoot() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-mem-bidi-'));
  cfg.writeConfig(r, cfg.DEFAULT_CONFIG);
  return r;
}

const RLO = String.fromCodePoint(0x202E);

test('integration: compactLine neutralises an override character in every text field', () => {
  for (const field of ['title', 'choice', 'text', 'why']) {
    const line = compactLine({ [field]: `safe${RLO}evil` });
    assert.ok(!line.includes(RLO), `compactLine left a raw override in .${field}`);
    assert.ok(line.includes('U+202E'), `compactLine dropped the character silently in .${field}`);
  }
});

test('integration: memory.context() (the SessionStart hook path) neutralises it end to end', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'decision', { topic: 'probe', choice: `ship${RLO}it`, why: 'because reasons' });
  const out = memory.context(root, { n: 20 });
  assert.ok(!out.includes(RLO), 'memory.context() emitted a raw bidi-override character');
  assert.ok(out.includes('U+202E'), 'memory.context() dropped the character instead of marking it');
});

test('integration: browse.fit() neutralises it for every line mem browse prints', () => {
  const out = browse.fit(`entry title ${RLO} hidden`, 60);
  assert.ok(!out.includes(RLO));
  assert.ok(out.includes('U+202E'));
});

test('integration: browse.hitLine() -> fit() end to end, as render() actually calls it', () => {
  const hit = { type: 'decision', entry: { ts: '2026-09-19', title: `visible${RLO}text` } };
  const h = browse.hitLine(hit);
  const rendered = browse.fit(`${h.when}  ${h.type}  ${h.what}`, 60);
  assert.ok(!rendered.includes(RLO));
  assert.ok(rendered.includes('U+202E'));
});

// --- the four surfaces that were still leaking on 2026-09-19 -----------
//
// The four probes above measured four of eleven output surfaces, and
// were green while seven others handed raw override characters out. The
// leaking ones that mattered were the machine-facing lanes — `--json`
// and the viewer's embedded data block — precisely the paths a FOREIGN
// agent reads, which is the reader this control exists for. Each is
// pinned here on the effect, through the real exported function, not on
// the presence of a call.

test('integration: sanitizeForDisplay reaches a string, a nested field and an array', () => {
  assert.equal(sanitizeForDisplay(`a${RLO}b`), 'a[U+202E:RLO]b');
  const deep = sanitizeForDisplay({
    hits: [{ entry: { title: `safe${RLO}evil`, tags: [`t${RLO}g`] } }],
  });
  const dumped = JSON.stringify(deep);
  assert.ok(!dumped.includes(RLO), 'sanitizeForDisplay left a raw override inside the structure');
  assert.equal(deep.hits[0].entry.title, 'safe[U+202E:RLO]evil');
  assert.equal(deep.hits[0].entry.tags[0], 't[U+202E:RLO]g');
  // Shape survives the round trip, or the fix would be a different bug.
  assert.equal(deep.hits.length, 1);
  // Keys are deliberately NOT marked — they are this package's own field
  // names. If that ever changes, the decision in the docstring changed
  // with it, and this line is where it gets noticed.
  assert.ok(Object.hasOwn(deep.hits[0].entry, 'title'));
});

test('integration: mem find --json does not hand a raw override to its caller', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'learning', {
    title: `jsonlane${RLO}probe`, text: `body jsonlane${RLO}probe`,
  });
  const r = spawnSync(process.execPath, [MEM, 'find', 'jsonlane', '--json'], {
    env: { ...process.env, CHEAP_MEM_ROOT: root }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `mem find --json failed: ${r.stderr}`);
  assert.ok(r.stdout.includes('jsonlane'), 'the probe entry was not found at all — nothing was measured');
  assert.ok(!r.stdout.includes(RLO), 'mem find --json emitted a raw bidi-override character');
  assert.ok(r.stdout.includes('U+202E'), 'mem find --json dropped the character instead of marking it');
});

test('integration: the viewer embeds no raw override in its data block', () => {
  const root = tmpRoot();
  memory.logEntry(root, 'learning', {
    title: `viewerlane${RLO}probe`, text: `body viewerlane${RLO}probe`,
  });
  const { entries } = memory.readLog(root, 'learning');
  const html = viewer.renderHtml(entries, { title: 'probe' });
  assert.ok(html.includes('viewerlane'), 'the entry never reached the page — nothing was measured');
  assert.ok(!html.includes(RLO),
    'renderHtml embedded a raw bidi-override character; the browser-side esc() cannot help, '
    + 'the inline script cannot import src/bidi.mjs');
  assert.ok(html.includes('U+202E'), 'renderHtml dropped the character instead of marking it');
});

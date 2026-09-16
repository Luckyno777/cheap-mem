// Every hook that resolves a memory root has to survive a Windows path.
//
// **The finding (2026-09-16).** On Windows the agent hands a hook a
// native path — `C:\Users\x\AppData\Local\Temp\mem`. bash then tests
// `[ -f "C:\Users\x\.mem/config.json" ]`, finds nothing, and the hook
// exits 0 without a word. From the outside that is indistinguishable
// from "nothing to report about this file", so every hook in this
// project has been inert on Windows for as long as it has existed, and
// nothing said so.
//
// Reproducible without Windows, which is why this test can live here:
// the same memory answers with content when addressed with slashes and
// with nothing when addressed with backslashes.
//
// The bug sat in five hooks — one probe copied four times. That is why
// the second test below checks all of them and not only the one whose
// failure happened to be visible in CI.
//
// Covers an assurance from shared/invariants.jsonl.
// invariant: unterprozess-nennt-ursache
// invariant: fremder-pfad-wird-normalisiert
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every shell hook that looks for `.mem/config.json` itself. */
function hooksMitWurzelsuche() {
  const d = path.join(REPO, 'bin');
  return fs.readdirSync(d)
    .filter((n) => n.startsWith('mem-') && !n.endsWith('.ps1'))
    .map((n) => ({ n, s: fs.readFileSync(path.join(d, n), 'utf8') }))
    // A prose mention is not a lookup: the shape that matters is a
    // TEST on the file, `[ -f … .mem/config.json ]`.
    .filter((h) => /\[\s*!?\s*-f\s+"\$\{?[A-Za-z_]+[^"]*\.mem\/config\.json"/.test(h.s));
}

test('POSITIVE: the probe finds the hooks that resolve a root', () => {
  // Without this a renamed directory, or a rewritten probe, would make
  // the guard below pass by finding nothing at all.
  const h = hooksMitWurzelsuche();
  assert.ok(h.length >= 4, `only ${h.length} hooks with a root lookup — has the shape changed?`);
  for (const erwartet of ['mem-before-edit', 'mem-retrieve', 'mem-stop']) {
    assert.ok(h.some((x) => x.n === erwartet), `${erwartet} is no longer found by the probe`);
  }
});

test('each of them normalises the path before looking it up', () => {
  const ohne = hooksMitWurzelsuche()
    .filter((h) => !/entrutscht/.test(h.s))
    .map((h) => h.n);
  assert.deepEqual(ohne, [],
    'These hooks test for .mem/config.json without turning backslashes into '
    + 'slashes first. On Windows they find nothing and exit 0 in silence, which '
    + 'reads exactly like "nothing to report". The whole hook is then inert and '
    + 'says so nowhere.');
});

test('$0 is normalised too, not only the root', () => {
  // The root lookup was the first place; `$0` is the second, and
  // fixing only the first left the hook just as silent. On Windows
  // `dirname "D:\\a\\repo\\bin\\hook"` returns `.`, so HOOK_DIR becomes
  // the CURRENT directory, the tool next to the hook is not found, and
  // the hook exits 0 without a word.
  //
  // This is the whole reason the guard checks BOTH: the first repair
  // was real, verified, and did not fix the reported failure.
  for (const { n, s: text } of hooksMitWurzelsuche()) {
    // Any variable name — HOOK_DIR here, HERE there. What matters is
    // that no `dirname "$0"` survives unnormalised anywhere.
    assert.doesNotMatch(text, /dirname "\$0"/,
      `${n} takes dirname of $0 without normalising it first — on Windows that `
      + 'returns "." and the hook looks for its tool in the wrong directory');
  }
});

test('the helper is defined before it is used', () => {
  // A helper defined below its first call is an unbound command in
  // bash: the hook then fails at exactly the line meant to save it.
  for (const { n, s: text } of hooksMitWurzelsuche()) {
    const def = text.indexOf('entrutscht() {');
    const nutz = text.indexOf('entrutscht "');
    if (nutz < 0) continue;
    assert.ok(def >= 0 && def < nutz,
      `${n}: the helper is used at ${nutz} and defined at ${def}`);
  }
});

test('the substitution really turns backslashes into slashes', () => {
  // The counter-check on the helper itself. A helper that is present
  // but wrong would satisfy the guard above while fixing nothing.
  const s = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  const m = s.match(/entrutscht\(\)\s*\{[^}]*\}/);
  assert.ok(m, 'the helper is gone');
  assert.match(m[0], /\$\{1\/\/\\\\\\\\\/\/\}|\$\{1\/\/\\\\\//,
    `the helper does not substitute backslash for slash: ${m[0]}`);
});

test('the trace is silent unless it is switched on', () => {
  // A trace that prints without being asked turns every ordinary hook
  // run into noise on stderr, and the agent sees that noise. It also
  // must never reach stdout — that is the hook's contract with the
  // agent, and a stray line there would be parsed as a reply.
  const s = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  // The whole LINE, not `{[^}]*}`: the body contains `${VAR:-}`, whose
  // closing brace ends that match early and hides everything after it.
  // My first version of this test failed on its own regex.
  const m = s.split('\n').filter((z) => /^spur\(\)/.test(z));
  assert.equal(m.length, 1, 'the trace helper is gone, or defined twice');
  assert.match(m[0], /MEM_BEFORE_EDIT_TRACE/, 'the trace is not behind a switch');
  assert.match(m[0], />&2/, 'the trace writes somewhere other than stderr');
  // And it must not swallow the exit status it was inserted next to.
  assert.match(m[0], /return 0/,
    'the helper must end with return 0 — a failing test command in front of '
    + '`&& exit 0` would otherwise change which branch is taken');
});

test('every early exit names itself', () => {
  // The point of the trace is that NO silent exit is left. One that
  // stays anonymous is exactly the one the next failure will take.
  const s = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  const stumm = s.split('\n')
    .map((z, i) => ({ z, i: i + 1 }))
    .filter(({ z }) => /\bexit 0\b/.test(z) && !/spur /.test(z) && !/^\s*#/.test(z))
    // The last line of the script is the success path and needs no name.
    .filter(({ z }) => !/^exit 0$/.test(z.trim()));
  assert.deepEqual(stumm.map((x) => `${x.i}: ${x.z.trim()}`), [],
    'these exits leave no trace, so a failure that takes one of them is '
    + 'indistinguishable from "nothing to report"');
});

test('lane patterns accept either path separator', () => {
  // The selection step filtered its hits with `/\/(errors|…)\.jsonl$/`
  // — a forward slash written into a pattern that reads a real path.
  // On Windows the source carries backslashes, nothing matched, the
  // selection came out empty, and the hook exited 0 in silence.
  //
  // This was the actual Windows cause. Two earlier repairs were real
  // bugs and neither was this one; the trace named the branch and
  // ended the guessing.
  const s = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  const muster = [...s.matchAll(/\/\[?\\*\\?\/?\]?\((?:errors|decisions|learnings)[^/]*\/[gimsuy]*/g)];
  const roh = [...s.matchAll(/\/\\\/\((?:errors|decisions|learnings)/g)];
  assert.deepEqual(roh.map((m) => m[0]), [],
    'a lane pattern demands a forward slash — on Windows it matches nothing '
    + 'and the hook goes silent');
  assert.match(s, /\[\\\\\/\]\(errors\|decisions\|learnings\)/,
    'the lane pattern does not accept both separators');
  assert.ok(muster.length >= 0);  // die Suche selbst darf leer sein
});

test('POSITIVE: the lane pattern is actually in this file', () => {
  // Without this the guard above passes on a file that no longer
  // filters lanes at all — and then it checks nothing.
  const s = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  assert.match(s, /errors\|decisions\|learnings/,
    'the lane filter is gone — then the test above is vacuous');
});

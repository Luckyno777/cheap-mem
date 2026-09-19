// The two installers must register the same lanes.
//
// **What this is here for (measured 2026-09-19).** The POSIX installer
// `install/claude-code.sh` registers FOUR Claude Code events:
// SessionStart, Stop, UserPromptSubmit, and PreToolUse with the matcher
// `Edit|Write|NotebookEdit`. `install/windows.ps1` registered TWO —
// SessionStart and Stop. There was no UserPromptSubmit registration and
// no PreToolUse registration at all.
//
// So on Windows the recall lane and the before-edit lane never ran.
// Not because they were broken: the same week their PowerShell ports
// were written, guarded by `test/hook-parity.test.mjs`, and executed on
// a windows-latest runner. They existed, they worked, and on a real
// install nobody ever asked for them. This repo's own name for that is
// `built-but-out-of-reach` — and the fix one level down made it worse,
// not better, because now there was something to call.
//
// The Stop hook the Windows installer generated delegated to
// `bin/mem-reflect.ps1` — a MODEL call. `bin/mem-stop` exists precisely
// to replace that: capture model-free and always, commit and push, and
// run the model summary only behind `MEM_REFLECT=1`. In a sandbox
// without a model the old path captured nothing at all.
//
// **The rule this states, rather than the list it could have typed.**
// Every event the POSIX installer registers must also be registered by
// the Windows installer. A fifth lane added next month falls out on its
// first day, on whichever side forgot it. A hardcoded list of four
// would be a second source of truth and would go stale exactly like the
// two-versus-four it is here to prevent.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POSIX = path.join(REPO, 'install', 'claude-code.sh');
const WINDOWS = path.join(REPO, 'install', 'windows.ps1');

/**
 * The events an installer registers, read from its own source.
 *
 * Both files name the event as the first string argument of their
 * upsert call, so one pattern per file is enough. Comments are stripped
 * first — a mention in prose is not a registration, and the docblocks
 * above both call sites name every event by hand.
 */
function registriert(datei, muster, kommentar) {
  const roh = fs.readFileSync(datei, 'utf8');
  const zeilen = roh.split('\n').filter((z) => !kommentar.test(z));
  const raus = new Map();
  for (const z of zeilen) {
    const m = muster.exec(z);
    if (m) raus.set(m[1], z.trim());
  }
  return raus;
}

const posixEvents = () => registriert(
  POSIX, /upsertHook\(\s*['"]([A-Za-z]+)['"]/, /^\s*(\/\/|#)/);
const windowsEvents = () => registriert(
  WINDOWS, /Upsert-Hook\s+\$cfg\['hooks'\]\s+'([A-Za-z]+)'/, /^\s*#/);

test('POSITIVE CONTROL: the reader finds real registrations in BOTH files', () => {
  // Without this half, a pattern that matches nothing would make the
  // rule below pass by finding no difference between two empty sets.
  const p = posixEvents();
  const w = windowsEvents();
  assert.ok(p.size >= 4, `only ${p.size} registrations found in ${path.basename(POSIX)}`);
  assert.ok(w.size >= 2, `only ${w.size} registrations found in ${path.basename(WINDOWS)}`);
  assert.ok(p.has('SessionStart'), 'the POSIX reader does not even see SessionStart');
  assert.ok(w.has('SessionStart'), 'the Windows reader does not even see SessionStart');
});

test('THE RULE: Windows registers every event POSIX does', () => {
  const p = posixEvents();
  const w = windowsEvents();
  const fehlend = [...p.keys()].filter((e) => !w.has(e));
  assert.deepEqual(fehlend, [],
    `install/windows.ps1 does not register: ${fehlend.join(', ')}. `
    + 'A lane nobody calls is a lane that does not exist — on 2026-09-19 '
    + 'that was UserPromptSubmit and PreToolUse, and the ports for both '
    + 'had already shipped.');
});

test('the PreToolUse matcher is the same on both sides', () => {
  // Without the matcher the lane also fires on Read and on Bash, and
  // the path of a file being READ is not an intention to change it.
  // Two different matchers would mean two different products.
  const p = posixEvents().get('PreToolUse') ?? '';
  const w = windowsEvents().get('PreToolUse') ?? '';
  const holen = (z) => /['"]([A-Za-z|]*\|[A-Za-z|]*)['"]/.exec(z)?.[1] ?? null;
  const pm = holen(p);
  assert.ok(pm, `no matcher found on the POSIX side: ${p}`);
  assert.equal(holen(w), pm, `Windows registers PreToolUse with a different matcher: ${w}`);
});

test('the Windows Stop hook is the model-FREE one', () => {
  // bin/mem-stop exists to replace bin/mem-reflect on this event. The
  // header of bin/mem-stop states why: in a sandbox without a model the
  // reflect path runs nothing, so the session captured nothing — and
  // said so to no one. Capture must not depend on a model being there.
  //
  // **The first version of this probe forbade the STRING and went red
  // on the very comment that explains the change** — a mention is not
  // a call, and a probe that cannot tell them apart forces the next
  // person to delete the explanation to get green. So it reads the
  // ASSIGNMENT: which script the generated hook resolves and starts.
  const quelle = fs.readFileSync(WINDOWS, 'utf8');
  const erzeugt = quelle.split('Set-Content -LiteralPath $stopHookDst')[0];
  const block = erzeugt.slice(erzeugt.lastIndexOf('cheap-mem Stop hook'));
  const ohneKommentar = block.split('\n').filter((z) => !/^\s*#/.test(z)).join('\n');
  const gerufen = [...ohneKommentar.matchAll(/'bin\\(mem-[a-z-]+\.ps1)'/g)].map((m) => m[1]);
  assert.deepEqual(gerufen, ['mem-stop.ps1'],
    `the generated Stop hook resolves ${JSON.stringify(gerufen)} instead of mem-stop.ps1`);
});

test('every generated wrapper points at a file that exists in bin/', () => {
  // A registration that names a script nobody shipped is the same
  // silence one level further along.
  const quelle = fs.readFileSync(WINDOWS, 'utf8');
  const genannt = [...quelle.matchAll(/'bin\\(mem-[a-z-]+\.ps1)'/g)].map((m) => m[1]);
  assert.ok(genannt.length >= 3, `only ${genannt.length} bin\\ references found`);
  const fehlend = [...new Set(genannt)].filter(
    (f) => !fs.existsSync(path.join(REPO, 'bin', f)));
  assert.deepEqual(fehlend, [], `registered but not shipped: ${fehlend.join(', ')}`);
});

test('a re-install does not leave a second hook behind', () => {
  // The filter that removes a prior entry was keyed on the literal
  // 'cheap-mem-session', which matched exactly the two scripts that
  // existed on 2026-09-19 and nothing else. With a third one a second
  // install would have added an entry beside the old one — and two
  // hooks on UserPromptSubmit means every message pays twice.
  const quelle = fs.readFileSync(WINDOWS, 'utf8');
  assert.doesNotMatch(quelle, /-match\s+'cheap-mem-session'/,
    'the upsert filter is keyed on a literal script name again');
  assert.match(quelle, /regex\]::Escape\(\$file\)/,
    'the upsert filter no longer keys on the caller-named file');
});

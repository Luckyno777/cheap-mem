// What a stranger downloads, and what the README promises them.
//
// **The finding (2026-09-19).** The README said "588 kB, one package, no
// dependencies" while `npm pack` reported **4.8 MB** — a factor of eight.
// Nobody wrote a wrong number: on 2026-09-17 a GitHub branding kit landed
// in `docs/assets/brand/`, `files` already shipped all of `docs/`, and
// 4.3 MB of PNGs rode along into the tarball. The README was true when
// written and false by the next commit, and nothing looked.
//
// That matters more here than in most projects. cheap-mem argues for
// itself by being small and self-contained — a runtime install carrying
// the social-preview image of its own GitHub page refutes the pitch for
// anyone who checks, and checking costs one command.
//
// The two existing packaging probes could not have caught it: both ask
// "does every path in `files` exist", and every path did. The thing that
// changed was the SIZE behind a path, which nobody was asking about.
// So this asks about the size, and about the one number in the README
// that states it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Run npm, on every platform this suite runs on.
 *
 * **Windows.** `npm` there is `npm.cmd`, and since the fix for
 * CVE-2024-27980 Node refuses to spawn a `.cmd` without a shell. A plain
 * `execFileSync('npm', …)` throws on windows-latest — which is in this
 * repo's test matrix, and which nothing would have reported, because CI
 * does not run on feature branches (measured 2026-09-19: zero runs on
 * the branch this test was written on).
 *
 * The route taken instead needs no shell and no guessing: when the suite
 * runs under `npm test`, npm hands down `npm_execpath`, the path to its
 * own JavaScript entry point, and node can run that directly. Only when
 * that is absent — `node --test` invoked by hand — does this fall back
 * to a shell, and then only on Windows, where it is the one thing that
 * works.
 *
 * This is the only test in the repo that calls npm at all; every other
 * external call goes to node, git or bash, which are real executables
 * everywhere. That lack of precedent is why the trap was there to step
 * into.
 */
function runNpm(args) {
  const opts = { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  const viaNpm = process.env.npm_execpath;
  if (viaNpm && /\.(c?js|mjs)$/.test(viaNpm)) {
    return execFileSync(process.execPath, [viaNpm, ...args], opts);
  }
  if (process.platform === 'win32') {
    return execFileSync('npm', args, { ...opts, shell: true });
  }
  return execFileSync('npm', args, opts);
}

/** What npm would actually ship — npm's own answer, not a re-implementation. */
function packed() {
  const j = JSON.parse(runNpm(['pack', '--dry-run', '--json']))[0];
  return { size: j.size, unpacked: j.unpackedSize, files: j.entryCount };
}

// Room for ordinary growth, nowhere near room for a factor of eight.
const DECKEL = 1_200_000;

test('POSITIVE: npm pack answers at all', () => {
  // A probe that silently returns zero passes forever. It happened to
  // the sibling project's coverage number; it will not happen here.
  const p = packed();
  assert.ok(p.size > 50_000, `npm pack reports ${p.size} bytes — the probe is broken`);
  assert.ok(p.files > 50, `npm pack reports ${p.files} files — the probe is broken`);
});

test('the tarball stays small enough for the claim the README makes', () => {
  const { size } = packed();
  assert.ok(size <= DECKEL,
    `npm pack is ${(size / 1e6).toFixed(1)} MB, over the ${(DECKEL / 1e6).toFixed(1)} MB ceiling. `
    + 'Something large is being shipped to people who only want to run the tool. '
    + 'Look at `npm pack --dry-run | sort -k3 -h -r | head` and exclude it in "files".');
});

test('the GitHub branding images are not in the tarball', () => {
  // Named, because this is the thing that happened. A generic size
  // ceiling would go green again the moment someone shrinks the PNGs
  // instead of removing them — and they still would not belong there.
  const roh = runNpm(['pack', '--dry-run']) + runNpm(['pack', '--dry-run', '--json']);
  for (const bild of ['github-header.png', 'social-preview.png', 'social-preview.jpg']) {
    assert.ok(!roh.includes(bild),
      `${bild} is in the tarball — that image belongs on the GitHub page, not in an install`);
  }
});

test('the README states the download size, and it is right', () => {
  // **Anchored on a marker, not on a pattern.** The first draft of this
  // probe looked for /(\\d{3}) kB/ near a few words and, on 2026-09-19,
  // found "a 194 kB tool" three sections away — a DIFFERENT and also
  // stale claim — and reported a factor of 3 against a README that was
  // right. A guard that has to guess which sentence it is guarding will
  // eventually guard the wrong one and be switched off for crying wolf.
  //
  // So the README marks the one authoritative figure with
  // <!--packed-size--> and this reads exactly that. Any other kB number
  // in the prose is free to be about something else.
  const README = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const treffer = [...README.matchAll(/\*\*(\d{2,5}) kB\*\*<!--packed-size-->/g)];
  assert.equal(treffer.length, 1,
    `${treffer.length} <!--packed-size--> markers in the README — there must be exactly one, `
    + 'or the "download size" is two numbers that will drift apart');
  const behauptet = Number(treffer[0][1]) * 1000;
  const { size } = packed();
  const faktor = Math.max(size, behauptet) / Math.min(size, behauptet);
  assert.ok(faktor < 1.15,
    `README claims ${treffer[0][1]} kB, npm pack says ${Math.round(size / 1000)} kB `
    + `(factor ${faktor.toFixed(1)})`);
});

test('the error that happened would fail this test', () => {
  // A guard that would not have caught the thing it was written for is
  // decoration. 4.8 MB against the ceiling, checked explicitly.
  assert.ok(4_800_000 > DECKEL,
    'the 4.8 MB tarball would pass this ceiling — then the ceiling guards nothing');
});

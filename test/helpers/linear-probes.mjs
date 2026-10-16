// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The sites that took quadratic time on a run of one character (test/linear-trim.test.mjs), each as a probe: how to build the
// pathological input (outside the clock) and how to run the site on it (inside the clock).
//
// Run as a child process: `node test/helpers/linear-probes.mjs <name>` prints `{"ms":..,"ok":..}`. A site that is still
// quadratic would hold the test process for minutes at 1 MB, and a synchronous regular expression cannot be interrupted
// from inside, so the test kills the child instead and reports "did not finish".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MB = 1e6;
const PARTS = { user: 'H', session: 'AI', librarian: 'lib' };
const HEADER = { from: 'session', to: 'librarian', time: '2026-01-01T00:00:00Z', subject: 's' };
const src = (name) => import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', name)).href);
const scratch = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** name -> { prepare(n): context for an input of about n characters, run(context): boolean (the result is the one a normal input gets) } */
export const PROBES = {
  'inbox.build: 1 MB of blanks, then a letter, as the body': {
    prepare: (n) => ({ text: `${' '.repeat(n)}x` }),
    run: async ({ text }) => (await src('inbox.mjs')).build(PARTS, { ...HEADER, text }).endsWith('x\n'),
  },
  'inbox.parse: a message whose body is 1 MB of blanks and a letter': {
    prepare: (n) => ({ content: `From: session\nTo: librarian\nTime: 2026-01-01T00:00:00Z\nSubject: s\nState: open\n\n${' '.repeat(n)}x \n\n` }),
    run: async ({ content }) => (await src('inbox.mjs')).parse(content).text.endsWith('x'),
  },
  'inbox.build: In-Reply-To of 1 MB of hyphens': {
    prepare: (n) => ({ ref: `0${'-'.repeat(n)}` }),
    run: async ({ ref }) => {
      try { (await src('inbox.mjs')).build(PARTS, { ...HEADER, text: 't', inReplyTo: ref }); } catch (e) { return /message file name/.test(e.message); }
      return false;
    },
  },
  'agents.readFlatYaml: one line of 1 MB of blanks and a letter': {
    prepare: (n) => ({ text: `${' '.repeat(n)}x` }),
    run: async ({ text }) => typeof (await src('agents.mjs')).readFlatYaml(text) === 'object',
  },
  'appointments.create: a text of 1 MB of blanks and a letter (refused as too long)': {
    prepare: (n) => ({ root: scratch('cm-linear-appt-'), text: `${' '.repeat(n)}x` }),
    run: async ({ root, text }) => {
      try { (await src('appointments.mjs')).create(root, { title: 't', text, atMs: Date.now() + 3600000, actor: { name: 'user', authority: 'owner' } }); } catch (e) { return /too long/.test(e.message); }
      return false;
    },
  },
  'githook.writeMergeDriver: a .gitattributes of 1 MB of blank lines and a letter': {
    prepare: (n) => {
      const root = scratch('cm-linear-attr-');
      fs.writeFileSync(path.join(root, '.gitattributes'), `${'\n'.repeat(n)}x\n`);
      return { root };
    },
    run: async ({ root }) => {
      const mod = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'githook.mjs')).href);
      return mod.writeMergeDriver(root).added === 1 && /merge=union/.test(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'));
    },
  },
  'githook.writeMemoryGitignore: 60,000 lines of a rule with a trailing comment': {
    prepare: (n) => {
      const root = scratch('cm-linear-ignore-');
      const lines = Math.round(n * 0.06);
      fs.writeFileSync(path.join(root, '.gitignore'), '.mem/embed.env # x\n'.repeat(lines));
      return { root, lines };
    },
    run: async ({ root, lines }) => {
      const mod = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'githook.mjs')).href);
      return mod.writeMemoryGitignore(root).repaired === lines;
    },
  },
  'environment.checkMergeDriver: a .gitattributes of 1 MB of blank lines and a letter': {
    prepare: (n) => {
      const root = scratch('cm-linear-env-');
      execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
      fs.writeFileSync(path.join(root, '.gitattributes'), `${'\n'.repeat(n)}x\n`);
      return { root };
    },
    run: async ({ root }) => (await src('environment.mjs')).checkMergeDriver(root).ok === false,
  },
  'repetitionhint.correctPathText: an error text of 1 MB without a full stop': {
    prepare: (n) => ({ text: 'ab '.repeat(n / 3) }),
    run: async ({ text }) => /no correction marker/.test((await src('repetitionhint.mjs')).correctPathText({ text })),
  },
  'agentledger.jobFromEntry: a package of a letter, 1 MB of blanks, a letter': {
    prepare: (n) => ({ entry: { package: `a${' '.repeat(n)}x`, text: '', title: '' } }),
    run: async ({ entry }) => (await src('agentledger.mjs')).jobFromEntry(entry).package === entry.package,
  },
  'component.compatible: an entry text of 1 MB of one letter': {
    prepare: (n) => ({ text: 'a'.repeat(n) }),
    run: async ({ text }) => (await src('component.mjs')).compatible(text, 'capture.sh', 'bin') === false,
  },
  'doctor.checkEntryForm: an idless-line finding whose text is 1 MB of one letter': {
    prepare: (n) => {
      const root = scratch('cm-linear-doctor-');
      fs.mkdirSync(path.join(root, 'global'), { recursive: true });
      const line = { id: 'ack1abcdef', ts: '2026-10-02T00:00:00Z', v: 1, class: 'idless-line', title: 'idless line', text: 'a'.repeat(n) };
      fs.writeFileSync(path.join(root, 'global', 'errors.jsonl'), `${JSON.stringify(line)}\n`);
      return { root };
    },
    run: async ({ root }) => typeof (await src('doctor.mjs')).checkEntryForm(root).level === 'string',
  },
  'gauges.pathsOf: a Bash command of 1 MB of one letter': {
    prepare: (n) => ({ command: 'a'.repeat(n) }),
    run: async ({ command }) => (await src('gauges.mjs')).pathsOf('Bash', { command }).length === 0,
  },
  'gauges.pathsOf: a Bash command of 1 MB of `a-` (hyphens between word characters)': {
    prepare: (n) => ({ command: 'a-'.repeat(Math.round(n / 2)) }),
    run: async ({ command }) => (await src('gauges.mjs')).pathsOf('Bash', { command }).length === 0,
  },
  'gauges.pathsOf: a Bash command of 200,000 file names': {
    prepare: (n) => ({ command: 'a.md '.repeat(Math.round(n / 5)), count: Math.round(n / 5) }),
    run: async ({ command, count }) => (await src('gauges.mjs')).pathsOf('Bash', { command }).length === count,
  },
  'gauges.writesViaRedirect: 1 MB of digits and a letter': {
    prepare: (n) => ({ command: `${'0'.repeat(n)}x` }),
    run: async ({ command }) => (await src('gauges.mjs')).writesViaRedirect(command) === false,
  },
  'gauges.writesViaRedirect: a double quote that never closes, then 1 MB of escaped quotes': {
    prepare: (n) => ({ command: `echo "${'\\"'.repeat(n / 2)}` }),
    run: async ({ command }) => (await src('gauges.mjs')).writesViaRedirect(command) === false,
  },
  'bashtargets.writeTargets: 1 MB of digits, then an ampersand': {
    prepare: (n) => ({ command: `echo ${'0'.repeat(n)}&` }),
    run: async ({ command }) => Array.isArray((await src('bashtargets.mjs')).writeTargets(command)),
  },
  // `xgit push ` 100,000 times: the first word of a rule stands at every one of them and none is the start of a command, so the
  // lead words in front of each are looked for 100,000 times (17 s for 200 KB in the old state).
  'commandguard.hits: 1 MB of `xgit push ` (the first word of the rule stands 100,000 times, never at a command start)': {
    prepare: (n) => ({ command: 'xgit push '.repeat(Math.round(n / 10)) }),
    run: async ({ command }) => {
      const guard = await src('commandguard.mjs');
      return guard.hits(guard.normalise(command), ['git push']) === false;
    },
  },
  'commandguard.hits: 1 MB of `sudo -E FOO=1 xgit push ` (lead words in front of every place the rule\'s first word stands)': {
    prepare: (n) => ({ command: 'sudo -E FOO=1 xgit push '.repeat(Math.round(n / 24)) }),
    run: async ({ command }) => {
      const guard = await src('commandguard.mjs');
      return guard.hits(guard.normalise(command), ['git push']) === false;
    },
  },
};

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const probe = PROBES[process.argv[2]];
  if (!probe) { console.error(`no such probe: ${process.argv[2]}`); process.exit(2); }
  // Best of three, each on a fresh input: the clock of a loaded machine is not the site's. A site that is quadratic does not
  // come back from the first run, so the test kills the child, and "best of" cannot hide it. Two sizes, 1 MB and a quarter of
  // it: linear time makes the big one about 4 times the small one, quadratic about 16 (the test reads the ratio).
  const measure = async (size) => {
    let best = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ctx = await probe.prepare(size);
      const t = performance.now();
      let ok = false;
      let error = null;
      try { ok = await probe.run(ctx); } catch (e) { error = String(e?.message ?? e).slice(0, 200); }
      const ms = performance.now() - t;
      if (ctx?.root) fs.rmSync(ctx.root, { recursive: true, force: true });
      if (best === null || ms < best.ms) best = { ms, ok, error };
      if (!ok) break;
    }
    return best;
  };
  const small = await measure(MB / 4);
  const big = small.ok ? await measure(MB) : small;
  console.log(JSON.stringify({ ms: big.ms, smallMs: small.ms, ok: small.ok && big.ok, error: small.error ?? big.error }));
}

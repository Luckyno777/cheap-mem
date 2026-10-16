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

/** name -> { prepare(): context, run(context): boolean (the result is the one a normal input gets) } */
export const PROBES = {
  'inbox.build: 1 MB of blanks, then a letter, as the body': {
    prepare: () => ({ text: `${' '.repeat(MB)}x` }),
    run: async ({ text }) => (await src('inbox.mjs')).build(PARTS, { ...HEADER, text }).endsWith('x\n'),
  },
  'inbox.parse: a message whose body is 1 MB of blanks and a letter': {
    prepare: () => ({ content: `From: session\nTo: librarian\nTime: 2026-01-01T00:00:00Z\nSubject: s\nState: open\n\n${' '.repeat(MB)}x \n\n` }),
    run: async ({ content }) => (await src('inbox.mjs')).parse(content).text.endsWith('x'),
  },
  'inbox.build: In-Reply-To of 1 MB of hyphens': {
    prepare: () => ({ ref: `0${'-'.repeat(MB)}` }),
    run: async ({ ref }) => {
      try { (await src('inbox.mjs')).build(PARTS, { ...HEADER, text: 't', inReplyTo: ref }); } catch (e) { return /message file name/.test(e.message); }
      return false;
    },
  },
  'agents.readFlatYaml: one line of 1 MB of blanks and a letter': {
    prepare: () => ({ text: `${' '.repeat(MB)}x` }),
    run: async ({ text }) => typeof (await src('agents.mjs')).readFlatYaml(text) === 'object',
  },
  'appointments.create: a text of 1 MB of blanks and a letter (refused as too long)': {
    prepare: () => ({ root: scratch('cm-linear-appt-'), text: `${' '.repeat(MB)}x` }),
    run: async ({ root, text }) => {
      try { (await src('appointments.mjs')).create(root, { title: 't', text, atMs: Date.now() + 3600000, actor: { name: 'user', authority: 'owner' } }); } catch (e) { return /too long/.test(e.message); }
      return false;
    },
  },
  'githook.writeMergeDriver: a .gitattributes of 1 MB of blank lines and a letter': {
    prepare: () => {
      const root = scratch('cm-linear-attr-');
      fs.writeFileSync(path.join(root, '.gitattributes'), `${'\n'.repeat(MB)}x\n`);
      return { root };
    },
    run: async ({ root }) => {
      const mod = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'githook.mjs')).href);
      return mod.writeMergeDriver(root).added === 1 && /merge=union/.test(fs.readFileSync(path.join(root, '.gitattributes'), 'utf8'));
    },
  },
  'githook.writeMemoryGitignore: 60,000 lines of a rule with a trailing comment': {
    prepare: () => {
      const root = scratch('cm-linear-ignore-');
      fs.writeFileSync(path.join(root, '.gitignore'), '.mem/embed.env # x\n'.repeat(60000));
      return { root };
    },
    run: async ({ root }) => {
      const mod = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'githook.mjs')).href);
      return mod.writeMemoryGitignore(root).repaired === 60000;
    },
  },
  'environment.checkMergeDriver: a .gitattributes of 1 MB of blank lines and a letter': {
    prepare: () => {
      const root = scratch('cm-linear-env-');
      execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
      fs.writeFileSync(path.join(root, '.gitattributes'), `${'\n'.repeat(MB)}x\n`);
      return { root };
    },
    run: async ({ root }) => (await src('environment.mjs')).checkMergeDriver(root).ok === false,
  },
  'repetitionhint.correctPathText: an error text of 1 MB without a full stop': {
    prepare: () => ({ text: 'ab '.repeat(MB / 3) }),
    run: async ({ text }) => /no correction marker/.test((await src('repetitionhint.mjs')).correctPathText({ text })),
  },
  'agentledger.jobFromEntry: a package of a letter, 1 MB of blanks, a letter': {
    prepare: () => ({ entry: { package: `a${' '.repeat(MB)}x`, text: '', title: '' } }),
    run: async ({ entry }) => (await src('agentledger.mjs')).jobFromEntry(entry).package === `a${' '.repeat(MB)}x`,
  },
  'component.compatible: an entry text of 1 MB of one letter': {
    prepare: () => ({ text: 'a'.repeat(MB) }),
    run: async ({ text }) => (await src('component.mjs')).compatible(text, 'capture.sh', 'bin') === false,
  },
  'doctor.checkEntryForm: an idless-line finding whose text is 1 MB of one letter': {
    prepare: () => {
      const root = scratch('cm-linear-doctor-');
      fs.mkdirSync(path.join(root, 'global'), { recursive: true });
      const line = { id: 'ack1abcdef', ts: '2026-10-02T00:00:00Z', v: 1, class: 'idless-line', title: 'idless line', text: 'a'.repeat(MB) };
      fs.writeFileSync(path.join(root, 'global', 'errors.jsonl'), `${JSON.stringify(line)}\n`);
      return { root };
    },
    run: async ({ root }) => typeof (await src('doctor.mjs')).checkEntryForm(root).level === 'string',
  },
  'gauges.pathsOf: a Bash command of 1 MB of one letter': {
    prepare: () => ({ command: 'a'.repeat(MB) }),
    run: async ({ command }) => (await src('gauges.mjs')).pathsOf('Bash', { command }).length === 0,
  },
  'gauges.writesViaRedirect: 1 MB of digits and a letter': {
    prepare: () => ({ command: `${'0'.repeat(MB)}x` }),
    run: async ({ command }) => (await src('gauges.mjs')).writesViaRedirect(command) === false,
  },
  'gauges.writesViaRedirect: a double quote that never closes, then 1 MB of escaped quotes': {
    prepare: () => ({ command: `echo "${'\\"'.repeat(MB / 2)}` }),
    run: async ({ command }) => (await src('gauges.mjs')).writesViaRedirect(command) === false,
  },
  'bashtargets.writeTargets: 1 MB of digits, then an ampersand': {
    prepare: () => ({ command: `echo ${'0'.repeat(MB)}&` }),
    run: async ({ command }) => Array.isArray((await src('bashtargets.mjs')).writeTargets(command)),
  },
  // Not quadratic before and after: the text is folded to single blanks first (`normalise`), so a run of blanks never reaches
  // `/ +$/` in src/commandguard.mjs. The probe keeps it that way: if the fold goes, this goes red.
  'commandguard.hits: 1 MB of blanks and a letter, folded by normalise': {
    prepare: () => ({ command: `${' '.repeat(MB)}x git push` }),
    run: async ({ command }) => {
      const guard = await src('commandguard.mjs');
      return typeof guard.hits(guard.normalise(command), ['git push']) === 'boolean';
    },
  },
};

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const probe = PROBES[process.argv[2]];
  if (!probe) { console.error(`no such probe: ${process.argv[2]}`); process.exit(2); }
  // Best of three, each on a fresh input: the clock of a loaded machine is not the site's. A site that is quadratic does not
  // come back from the first run, so the test kills the child, and "best of" cannot hide it.
  let best = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ctx = await probe.prepare();
    const t = performance.now();
    let ok = false;
    let error = null;
    try { ok = await probe.run(ctx); } catch (e) { error = String(e?.message ?? e).slice(0, 200); }
    const ms = performance.now() - t;
    if (ctx?.root) fs.rmSync(ctx.root, { recursive: true, force: true });
    if (best === null || ms < best.ms) best = { ms, ok, error };
    if (!ok) break;
  }
  console.log(JSON.stringify(best));
}

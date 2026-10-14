// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * codexcloud — what `mem setup codex-cloud` does, as a function.
 *
 * **Why this exists.** A memory repository that is opened in OpenAI Codex Cloud
 * reaches cheap-mem only through the hosted MCP connector: that environment runs
 * no hooks, so nothing shows the memory to the model and nothing captures its
 * turn (reported by Codex itself, not verified here). What carries the habit
 * instead is a Codex skill in the repository, `.agents/skills/mem/SKILL.md`,
 * and a short text in the environment field "Start skill". This module puts the
 * first into a memory and hands out the second.
 *
 * **What it touches, and what not.** Only files INSIDE the memory root: the
 * skill, and a narrow `.gitignore` exception, and the latter only when git says
 * `.agents/` is ignored there (an ordinary memory does not ignore it). The one
 * exception to "inside": the check of that exception (and `--dry-run`) briefly
 * makes a throw-away repository under `os.tmpdir()` and removes it again. It never
 * writes under the home directory, never commits, never pushes, and it does not
 * overwrite a skill file that differs from the shipped one unless told to.
 *
 * **Why not an MCP tool.** The connector is how a remote agent WRITES ENTRIES;
 * installing a file into the memory checkout is an operator act on a machine
 * the operator owns, and the bridge deliberately has no file-writing door.
 *
 * Windows: every path is built with `path.join`, git is started without a shell,
 * the line ending of an existing `.gitignore` is kept, and a skill file whose
 * line endings were converted by a checkout counts as unchanged.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from './atomicwrite.mjs';

/** The skill's place inside a memory, as git spells it (forward slashes, also on Windows). */
export const SKILL_REL = '.agents/skills/mem/SKILL.md';

/** The five lines that open exactly one folder under `.agents/`, and the comment above them. */
const IGNORE_EXCEPTION = Object.freeze([
  '# Codex Cloud reads repository skills from .agents/skills (added by `mem setup codex-cloud`).',
  '# Narrow on purpose: only .agents/skills/mem/ is tracked, the rest of .agents/ stays ignored.',
  '!/.agents/',
  '/.agents/*',
  '!/.agents/skills/',
  '/.agents/skills/*',
  '!/.agents/skills/mem/',
]);

/** Where the shipped files live inside the package. */
export function shipped(pkgRoot) {
  const dir = path.join(pkgRoot, 'install', 'codex');
  return {
    skill: path.join(dir, 'skills', 'mem', 'SKILL.md'),
    start: path.join(dir, 'start-skill.md'),
  };
}

/** The text for the environment field "Start skill": the one ```text block of start-skill.md. */
export function startText(pkgRoot) {
  const raw = fs.readFileSync(shipped(pkgRoot).start, 'utf8').replace(/\r\n/g, '\n');
  const m = raw.match(/```text\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`no \`\`\`text block in ${shipped(pkgRoot).start}`);
  return m[1];
}

const lf = (s) => s.replace(/\r\n/g, '\n');

/**
 * Does git ignore this path in this memory? `true`, `false`, or `null` when it cannot be asked
 * (no git on the PATH, or the memory is not a git repository).
 */
function isIgnored(root, rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, stdio: 'ignore' });
  if (r.error) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/** A path under `.agents/` that has nothing to do with the skill: it must stay ignored if it was. */
const SIBLING_REL = '.agents/other-tool.json';

/** The rule that decides about a path: `{source, rule}` as `git check-ignore -v` says it, or null. */
function decidingRule(root, rel) {
  const r = spawnSync('git', ['check-ignore', '-v', '--', rel], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = String(r.stdout).split('\t')[0].match(/^(.*?):(\d+):(.*)$/);
  return m ? { source: m[1].replace(/\\/g, '/'), rule: m[3] } : null;
}

/** The target must stay inside the memory: no symlinked `.agents` pointing out of it. */
function staysInside(root, target) {
  let dir = path.dirname(target);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Is this path something the installer may write into or replace? A symbolic link (also a dangling one, also a
 * junction) is never followed, and a directory where a file belongs is refused. Returns a reason, or '' when fine
 * (including "not there yet").
 */
function unsafeReason(p, want) {
  let st;
  try { st = fs.lstatSync(p); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return '';
    return `cannot look at ${p}: ${e.message}`;
  }
  if (st.isSymbolicLink()) return `${p} is a symbolic link; refusing to write through it or replace it`;
  if (want === 'dir' && !st.isDirectory()) return `${p} is not a directory`;
  if (want === 'file' && !st.isFile()) return `${p} is not a regular file`;
  return '';
}

/**
 * Would these `.gitignore` lines open exactly the skill folder? Asked of git in a throw-away repository that holds only
 * this one `.gitignore`, so nothing in the memory is touched. `null` when the answer would not be faithful (git is not
 * there, or the real ignore comes from a rule outside the memory's own `.gitignore`: then only the real run can tell).
 */
function simulate(root, before, oldText, nextText) {
  const rule = decidingRule(root, SKILL_REL);
  if (!rule || rule.source !== '.gitignore') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-codexcloud-'));
  try {
    if (spawnSync('git', ['init', '-q'], { cwd: dir }).status !== 0) return null;
    writeAtomic(path.join(dir, '.gitignore'), oldText);
    if (isIgnored(dir, SKILL_REL) !== true || isIgnored(dir, SIBLING_REL) !== before.sibling) return null; // not faithful
    writeAtomic(path.join(dir, '.gitignore'), nextText);
    return { skill: isIgnored(dir, SKILL_REL), sibling: isIgnored(dir, SIBLING_REL) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * Install the skill into a memory.
 *
 * Everything that can be refused is checked FIRST, then the `.gitignore` is handled (and undone if it does not do what
 * it should), and the skill file is written last: a refusal leaves nothing behind.
 *
 * @param {string} root     memory root (has `.mem/config.json`)
 * @param {string} pkgRoot  this package's root
 * @param {{dryRun?: boolean, force?: boolean}} [opt]
 * @returns {{ok: boolean, lines: string[], changed: boolean}}
 */
export function install(root, pkgRoot, { dryRun = false, force = false } = {}) {
  const lines = [];
  const would = dryRun ? 'Would ' : '';
  const refuse = (...why) => ({ ok: false, lines: [`codex-cloud: ${why[0]}`, ...why.slice(1), 'Nothing was changed.'], changed: false });
  const src = shipped(pkgRoot);
  if (!fs.existsSync(src.skill)) return refuse(`${src.skill} is missing from this install`);
  const wanted = fs.readFileSync(src.skill, 'utf8');
  const target = path.join(root, ...SKILL_REL.split('/'));
  const giPath = path.join(root, '.gitignore');

  // 1. The skill's place: no link anywhere on the way, and nothing but a file at the end.
  if (!staysInside(root, target)) return refuse(`${path.dirname(target)} resolves outside the memory (a symlink?); refusing to write there`);
  for (const [p, want] of [
    [path.join(root, '.agents'), 'dir'], [path.join(root, '.agents', 'skills'), 'dir'],
    [path.join(root, '.agents', 'skills', 'mem'), 'dir'], [target, 'file'],
  ]) {
    const why = unsafeReason(p, want);
    if (why) return refuse(why);
  }
  let present = null;
  try { present = fs.readFileSync(target, 'utf8'); } catch (e) {
    if (e.code !== 'ENOENT') return refuse(`cannot read ${target}: ${e.message}`);
  }
  if (present !== null && lf(present) !== lf(wanted) && !force) {
    return refuse(`${SKILL_REL} exists and differs from the one this install ships.`,
      '  Compare the two, then run again with --force to replace it:', `  ${src.skill}`);
  }

  // 2. The `.gitignore`: a link, a directory or an unreadable file is refused BEFORE anything is written.
  const giWhy = unsafeReason(giPath, 'file');
  if (giWhy) return refuse(giWhy);
  let giExisted = false;
  let giText = '';
  let giMode;
  try {
    giText = fs.readFileSync(giPath, 'utf8');
    giExisted = true;
    if (process.platform !== 'win32') giMode = fs.statSync(giPath).mode & 0o777;
  } catch (e) {
    if (e.code !== 'ENOENT') return refuse(`cannot read ${giPath}: ${e.message}`);
  }

  const before = { skill: isIgnored(root, SKILL_REL), sibling: isIgnored(root, SIBLING_REL) };
  let giNeeded = false;
  let next = '';
  if (before.skill === true) {
    giNeeded = true;
    const eol = giText.includes('\r\n') ? '\r\n' : '\n';
    const body = giText === '' || giText.endsWith('\n') ? giText : giText + eol;
    next = `${body}${giText === '' ? '' : eol}${IGNORE_EXCEPTION.join(eol)}${eol}`;
    const sim = simulate(root, before, giText, next);
    if (sim && (sim.skill !== false || (before.sibling === true && sim.sibling !== true))) {
      const rule = decidingRule(root, SKILL_REL);
      return refuse(`the exception would not do what it should: ${sim.skill !== false ? `${SKILL_REL} would stay ignored (${rule ? rule.rule : 'rule unknown'})` : 'it would open more of .agents/ than the skill folder'}.`,
        '  Fix the ignore rule by hand.');
    }
  }

  // Which folders on the way to the skill are not there yet: a failed write has to take back exactly those.
  const madeDirs = [];
  for (const p of [path.join(root, '.agents'), path.join(root, '.agents', 'skills'), path.dirname(target)]) {
    if (!fs.existsSync(p)) madeDirs.push(p);
  }
  // Deepest first, and only if empty (`rmdirSync` refuses a folder with anything in it): never a folder that was there before.
  const removeMadeDirs = () => {
    for (const p of [...madeDirs].reverse()) { try { fs.rmdirSync(p); } catch { /* not empty, or gone: leave it */ } }
  };

  // 3. Do it (or say what would be done).
  let changed = false;
  const restoreGi = () => {
    if (giExisted) writeAtomic(giPath, giText, giMode === undefined ? {} : { mode: giMode });
    else fs.rmSync(giPath, { force: true });
  };
  if (before.skill === null) {
    lines.push('.gitignore: not checked (not a git repository, or git is not on the PATH); left alone');
  } else if (!giNeeded) {
    lines.push('.gitignore: .agents/skills/mem/ is not ignored here; left alone');
  } else if (dryRun) {
    lines.push(`Would append ${IGNORE_EXCEPTION.length - 2} rules to .gitignore (git ignores ${SKILL_REL} now):`);
    for (const l of IGNORE_EXCEPTION.slice(2)) lines.push(`  ${l}`);
    lines.push(simulate(root, before, giText, next)
      ? '  (checked in a throw-away repository: they open the skill folder and nothing else)'
      : '  (not checkable in a dry run: the ignore comes from a rule outside this .gitignore; the real run checks and undoes)');
  } else {
    writeAtomic(giPath, next, giMode === undefined ? {} : { mode: giMode });
    const after = { skill: isIgnored(root, SKILL_REL), sibling: isIgnored(root, SIBLING_REL) };
    if (after.skill !== false || (before.sibling === true && after.sibling !== true)) {
      const rule = decidingRule(root, SKILL_REL);
      const why = after.skill !== false
        ? `${SKILL_REL} is still ignored: ${rule ? `${rule.source}: ${rule.rule}` : 'git did not say by which rule'}`
        : 'the exception would have opened more of .agents/ than the skill folder';
      restoreGi();
      return { ok: false, lines: [`codex-cloud: ${why}.`, '  .gitignore was put back as it was and the skill was not written. Fix the ignore rule by hand.'], changed: false };
    }
    lines.push(`.gitignore: appended ${IGNORE_EXCEPTION.length - 2} rules, so git sees ${SKILL_REL} and nothing else under .agents/`);
    changed = true;
  }

  // 4. The skill file, last.
  const verb = present === null ? 'write' : (lf(present) === lf(wanted) ? null : 'replace');
  if (verb === null) {
    lines.splice(0, 0, `${SKILL_REL} is already up to date`);
  } else {
    lines.splice(0, 0, `${would}${verb} ${SKILL_REL}${verb === 'replace' ? ' (it differed; --force)' : ''}`);
    if (!dryRun) {
      try { writeAtomic(target, wanted); } catch (e) {
        if (changed) restoreGi();
        removeMadeDirs();
        return { ok: false, lines: [`codex-cloud: cannot write ${target}: ${e.message}`, '  .gitignore was put back as it was.'], changed: false };
      }
    }
    changed = true;
  }
  return { ok: true, lines, changed };
}

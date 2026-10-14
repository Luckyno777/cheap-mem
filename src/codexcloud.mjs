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
 * `.agents/` is ignored there (an ordinary memory does not ignore it). It never
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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeAtomic } from './atomicwrite.mjs';

/** The skill's place inside a memory, as git spells it (forward slashes, also on Windows). */
export const SKILL_REL = '.agents/skills/mem/SKILL.md';

/** The five lines that open exactly one folder under `.agents/`, and the comment above them. */
export const IGNORE_EXCEPTION = Object.freeze([
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
export function isIgnored(root, rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: root, stdio: 'ignore' });
  if (r.error) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  return null;
}

/** The rule that ignores a path, for the message ("" when there is none or git cannot say). */
function ignoringRule(root, rel) {
  const r = spawnSync('git', ['check-ignore', '-v', '--', rel], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

/** The target must stay inside the memory: no symlinked `.agents` pointing out of it. */
function staysInside(root, target) {
  let dir = path.dirname(target);
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  const rel = path.relative(fs.realpathSync.native(root), fs.realpathSync.native(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Install the skill into a memory.
 *
 * @param {string} root     memory root (has `.mem/config.json`)
 * @param {string} pkgRoot  this package's root
 * @param {{dryRun?: boolean, force?: boolean}} [opt]
 * @returns {{ok: boolean, lines: string[], changed: boolean}}
 */
export function install(root, pkgRoot, { dryRun = false, force = false } = {}) {
  const lines = [];
  const would = dryRun ? 'Would ' : '';
  const src = shipped(pkgRoot);
  if (!fs.existsSync(src.skill)) {
    return { ok: false, lines: [`codex-cloud: ${src.skill} is missing from this install`], changed: false };
  }
  const wanted = fs.readFileSync(src.skill, 'utf8');
  const target = path.join(root, ...SKILL_REL.split('/'));
  let changed = false;

  if (!staysInside(root, target)) {
    return { ok: false, lines: [`codex-cloud: ${path.dirname(target)} resolves outside the memory (a symlink?); refusing to write there`], changed };
  }
  let present = null;
  try {
    if (fs.lstatSync(target).isSymbolicLink()) {
      return { ok: false, lines: [`codex-cloud: ${target} is a symbolic link; refusing to write through it`], changed };
    }
    present = fs.readFileSync(target, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') return { ok: false, lines: [`codex-cloud: cannot read ${target}: ${e.message}`], changed };
  }

  if (present === null) {
    lines.push(`${would}write ${SKILL_REL}`);
    if (!dryRun) writeAtomic(target, wanted);
    changed = true;
  } else if (lf(present) === lf(wanted)) {
    lines.push(`${SKILL_REL} is already up to date`);
  } else if (force) {
    lines.push(`${would}replace ${SKILL_REL} (it differed; --force)`);
    if (!dryRun) writeAtomic(target, wanted);
    changed = true;
  } else {
    return {
      ok: false,
      lines: [
        `codex-cloud: ${SKILL_REL} exists and differs from the one this install ships.`,
        '  Nothing was changed. Compare the two, then run again with --force to replace it:',
        `  ${src.skill}`,
      ],
      changed,
    };
  }

  // The ignore exception: only when git says the skill would be ignored.
  const before = isIgnored(root, SKILL_REL);
  if (before === null) {
    lines.push('.gitignore: not checked (not a git repository, or git is not on the PATH); left alone');
  } else if (before === false) {
    lines.push('.gitignore: .agents/skills/mem/ is not ignored here; left alone');
  } else {
    const giPath = path.join(root, '.gitignore');
    const old = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
    // Was the rest of .agents/ ignored too? Then it must stay so.
    const siblingBefore = isIgnored(root, '.agents/other-tool.json');
    const eol = old.includes('\r\n') ? '\r\n' : '\n';
    const body = old === '' || old.endsWith('\n') ? old : old + eol;
    const next = `${body}${old === '' ? '' : eol}${IGNORE_EXCEPTION.join(eol)}${eol}`;
    if (dryRun) {
      lines.push(`Would append ${IGNORE_EXCEPTION.length - 2} rules to .gitignore (git ignores ${SKILL_REL} now):`);
      for (const l of IGNORE_EXCEPTION.slice(2)) lines.push(`  ${l}`);
    } else {
      writeAtomic(giPath, next);
      const after = isIgnored(root, SKILL_REL);
      const siblingAfter = isIgnored(root, '.agents/other-tool.json');
      if (after !== false || (siblingBefore === true && siblingAfter !== true)) {
        const why = after !== false
          ? `${SKILL_REL} is still ignored: ${ignoringRule(root, SKILL_REL) || 'git did not say by which rule'}`
          : 'the exception would have opened more of .agents/ than the skill folder';
        if (old === '') fs.rmSync(giPath, { force: true }); else writeAtomic(giPath, old);
        lines.push(`codex-cloud: .gitignore restored; ${why}. Fix the ignore rule by hand.`);
        return { ok: false, lines, changed };
      }
      lines.push(`.gitignore: appended ${IGNORE_EXCEPTION.length - 2} rules, so git sees ${SKILL_REL} and nothing else under .agents/`);
      changed = true;
    }
  }
  return { ok: true, lines, changed };
}

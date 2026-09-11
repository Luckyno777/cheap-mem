// setup.mjs — the steps between "installed" and "actually working",
// and which of them are still open.
//
// **Why this is not a wizard.** Everything it checks already exists:
// `mem init` creates the memory, `mem doctor` verifies the guarantees,
// `mem raw archive --list-stores` finds the storage, the install
// scripts write the hooks. What was missing is the sentence that says
// which of those five things has happened and which has not.
//
// That gap is not cosmetic. Reported from a Windows install on
// 2026-09-08: a hook with a baked-in path from the first machine, dead
// and SILENT on the second — the session started without its memory and
// looked exactly like one that never had any. Nobody had a command that
// would have said "the memory is not attached here".
//
// **Every step answers with evidence, not with a feeling.** A step is
// green because a file exists, a command returned, a directory is
// writable — never because a previous step said so. `mem setup` is
// therefore safe to run at any time: it changes nothing unless asked.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as archive from './archive.mjs';
import * as stores from './stores.mjs';

/** A step that could not be checked is not a step that passed. */
export const STATE = Object.freeze({
  OK: 'ok',
  OPEN: 'open',
  BROKEN: 'broken',
});

/** Where Claude Code keeps its user-level hooks. */
export function claudeHome(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

function memoryStep(root) {
  const cfg = path.join(root, '.mem', 'config.json');
  if (!fs.existsSync(cfg)) {
    return {
      id: 'memory',
      title: 'A memory exists',
      state: STATE.OPEN,
      detail: `no ${path.join('.mem', 'config.json')} in ${root}`,
      fix: 'mem init',
    };
  }
  try {
    JSON.parse(fs.readFileSync(cfg, 'utf8'));
  } catch (e) {
    // Three states, not two: a config that exists and cannot be read is
    // a different problem from one that is absent, and it needs a
    // different answer.
    return {
      id: 'memory',
      title: 'A memory exists',
      state: STATE.BROKEN,
      detail: `${cfg} is not readable JSON: ${e.message}`,
      fix: 'repair the file by hand, or move it aside and run: mem init',
    };
  }
  return { id: 'memory', title: 'A memory exists', state: STATE.OK, detail: root };
}

function archiveStep(root, env) {
  const store = archive.readConfig(env, root);
  const syncing = stores.syncingStoreFor(store.location);
  let writable = false;
  try {
    fs.mkdirSync(store.location, { recursive: true });
    const probe = path.join(store.location, `.setupprobe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    writable = true;
  } catch { /* stays false */ }

  if (!writable) {
    return {
      id: 'archive',
      title: 'The raw archive is writable',
      state: STATE.BROKEN,
      detail: `${store.location} cannot be written to`,
      fix: 'mem raw archive --set <folder|gdrive|icloud|onedrive|dropbox>',
    };
  }
  // Deliberately OK rather than OPEN when nothing was chosen: the
  // default works. Marking a working default as an open task teaches
  // people to ignore open tasks.
  return {
    id: 'archive',
    title: 'The raw archive is writable',
    state: STATE.OK,
    detail: `${store.location} (${store.source})${syncing ? ` — ${syncing.label}, syncing` : ''}`,
  };
}

function hookStep(root, env, home) {
  const dir = path.join(claudeHome(env, home), 'hooks');
  if (!fs.existsSync(dir)) {
    return {
      id: 'hooks',
      title: 'Session hooks are installed',
      state: STATE.OPEN,
      detail: `${dir} does not exist`,
      fix: 'bash install/claude-code.sh   (or install/windows.ps1)',
    };
  }
  const dateien = fs.readdirSync(dir).filter((n) => /cheap-mem|session-(start|stop)/.test(n));
  if (!dateien.length) {
    return {
      id: 'hooks',
      title: 'Session hooks are installed',
      state: STATE.OPEN,
      detail: `no cheap-mem hook in ${dir}`,
      fix: 'bash install/claude-code.sh',
    };
  }

  // **The check that the Windows install needed and nobody had.** A
  // hook naming a root that does not exist here is worse than a missing
  // hook: it runs, finds nothing, and exits quietly.
  const tot = [];
  for (const n of dateien) {
    let text;
    try { text = fs.readFileSync(path.join(dir, n), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/CHEAP_MEM_ROOT\s*=\s*['"]([^'"]+)['"]/g)) {
      const genannt = m[1];
      if (genannt && !fs.existsSync(genannt)) tot.push(`${n} -> ${genannt}`);
    }
  }
  if (tot.length) {
    return {
      id: 'hooks',
      title: 'Session hooks are installed',
      state: STATE.BROKEN,
      detail: `a hook names a path that does not exist here: ${tot.join(', ')}`,
      fix: 'bash install/claude-code.sh   (re-run it on THIS machine)',
    };
  }
  return {
    id: 'hooks',
    title: 'Session hooks are installed',
    state: STATE.OK,
    detail: `${dateien.length} in ${dir}`,
  };
}

function bridgeStep(root, env, home) {
  // The MCP bridge is registered in a client config, and there are
  // several clients. Report what is FOUND rather than asserting a
  // single expected location.
  const kandidaten = [
    ['Claude Code', path.join(claudeHome(env, home), 'settings.json')],
    ['Claude Desktop (macOS)', path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')],
    ['Claude Desktop (Windows)', path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')],
  ];
  const found = [];
  for (const [label, p] of kandidaten) {
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    if (/mem-mcp|cheap-mem/.test(text)) found.push(label);
  }
  if (!found.length) {
    return {
      id: 'bridge',
      title: 'The MCP bridge is registered with a client',
      state: STATE.OPEN,
      detail: 'no client config mentions mem-mcp',
      fix: 'see docs/mcp-setup.md   (optional — the CLI works without it)',
    };
  }
  return {
    id: 'bridge',
    title: 'The MCP bridge is registered with a client',
    state: STATE.OK,
    detail: found.join(', '),
  };
}

function contentStep(root) {
  // A memory with nothing in it is not broken, it is new — but saying
  // so is what turns "why does retrieval find nothing" from a bug
  // report into an answer.
  let n = 0;
  const dir = path.join(root, 'global');
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      n += text.split('\n').filter((l) => l.trim()).length;
    }
  } catch { /* no global/ yet */ }

  if (n === 0) {
    return {
      id: 'content',
      title: 'The memory holds something',
      state: STATE.OPEN,
      detail: 'no entries yet — retrieval will find nothing, and that is not a fault',
      fix: 'mem log decision --topic … --choice … --why …',
    };
  }
  return { id: 'content', title: 'The memory holds something', state: STATE.OK, detail: `${n} entries` };
}

/**
 * Every step, always all of them, in the order they depend on.
 *
 * Steps are never skipped because an earlier one failed. A run that
 * stops at the first problem hides the other four, and the person then
 * fixes one thing at a time across five sessions.
 */
export function check(root, { env = process.env, home = os.homedir() } = {}) {
  const steps = [
    memoryStep(root),
    archiveStep(root, env),
    hookStep(root, env, home),
    bridgeStep(root, env, home),
    contentStep(root),
  ];
  return {
    steps,
    ok: steps.filter((s) => s.state === STATE.OK).length,
    open: steps.filter((s) => s.state === STATE.OPEN).length,
    broken: steps.filter((s) => s.state === STATE.BROKEN).length,
  };
}

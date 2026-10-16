// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Which group module answers which `mem <command>`.
 *
 * **Why this file exists (cli-speed-cm, TB4).** `bin/mem` used to import
 * all six group modules statically, so every `mem version` compiled the
 * code of all 87 handlers although it runs one. Measured at e98bf2d: the
 * module compile is where a CLI start goes, not the work. Now `bin/mem`
 * looks the command up HERE, imports only that group
 * (`await import()` in `bin/mem`) and runs it.
 *
 * **What it costs.** A command name is written down twice: in its group's
 * `COMMANDS` table and in the list below. `test/cli-lazy-groups.test.mjs`
 * compares the two in both directions, so a handler that is missing here
 * (it would answer "Unknown command") or listed here but not defined
 * (it would crash) turns the suite red, and its message names the line to
 * add. Adding a command: the handler in its group, the name here, a row
 * in the help block of `bin/mem`.
 *
 * **Duplicates.** The refusal that used to sit in the merge of `bin/mem`
 * sits here now, at the one place that still sees every name: a name in
 * two lists throws when this module loads, so it cannot resolve silently
 * by order.
 *
 * Pure data, no imports: loading it costs nothing.
 */

/** Group -> command names, in the order of that group's table. */
export const GROUP_COMMANDS = Object.freeze({
  write: [
    'log', 'card', 'teach', 'correction', 'discard', 'done', 'supersede', 'restore', 'merge', 'error-fixes', 'links',
    'facts', 'experiences', 'topic-merge', 'duties', 'deadlines',
  ],
  search: [
    'find', 'find-embed', 'find-hybrid', 'retrieve', 'explain', 'when', 'show', 'browse', 'topics', 'topic',
    'context', 'digest', 'core', 'workflow', 'command-guard', 'snippet',
  ],
  capture: [
    'raw', 'raw-capture', 'shrink', 'user',
  ],
  agents: [
    'inbox', 'broadcast', 'questions', 'answer', 'suggest', 'procedures', 'heartbeat', 'board', 'onboarding',
    'agents', 'agent', 'whoami', 'classes', 'appointment',
  ],
  setup: [
    'init', 'setup', 'hooks', 'paths', 'guard', 'version', 'bridge', 'serve', 'viewer', 'net', 'category', 'project',
    'store', 'sources', 'component', 'trust-own-tool',
  ],
  admin: [
    'doctor', 'gauges', 'asked-learn', 'rewrites', 'search-levers', 'effect', 'observations', 'maintenance', 'chain',
    'archive', 'epoch', 'thesaurus', 'embed', 'status', 'ledger', 'today', 'gaps', 'gold', 'skills', 'experience',
    'modelcost', 'envvars',
  ],
});

/** Command name -> group. Built once; throws on a name claimed twice. */
export function indexGroups(groupCommands) {
  const map = Object.create(null);
  for (const [group, names] of Object.entries(groupCommands)) {
    for (const name of names) {
      if (name in map) {
        throw new Error(`two groups define \`mem ${name}\`: ${group} and ${map[name]}`);
      }
      map[name] = group;
    }
  }
  return Object.freeze(map);
}

const GROUP_OF = indexGroups(GROUP_COMMANDS);

/** The group that defines `name`, or `undefined` when no group does. */
export function groupOf(name) {
  return typeof name === 'string' && name in GROUP_OF ? GROUP_OF[name] : undefined;
}

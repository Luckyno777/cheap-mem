// src/clihelp.mjs — does the CLI's own help describe the CLI it has?
//
// **The finding (2026-09-17).** `bin/mem`'s no-argument help is a
// hand-written block of `out(...)` lines. The dispatch table is a
// separate object. Nothing tied the two together, and they had drifted:
// of 60 commands, **29 were never mentioned in the help at all** —
// among them `retrieve`, `epoch`, `guard`, `teach`, `gauges`, `shrink`,
// `net` and `paths`. Nearly half the tool was invisible to anybody who
// did not read the source.
//
// That is the `two-truths` class: two places claim to describe the same
// thing, and only one of them is enforced. A feature nobody can find is
// worth what a feature that does not exist is worth.
//
// Both directions matter, and they fail differently:
//
//   - **invisible** — in the table, absent from the help. The work was
//     done and then hidden.
//   - **phantom** — named in the help, missing from the table. The help
//     lies; `mem <name>` answers "Unknown command". This is the worse
//     one: it sends somebody down a road that is not there.
//
// The rule lives here rather than in the probe so the probe can import
// it instead of re-deriving it — a probe that carries its own copy of
// the rule tests the copy.

/**
 * The commands the CLI actually dispatches: the keys of its `COMMANDS`
 * table.
 *
 * Reading the source is the point here, not a shortcut: the table IS
 * the behaviour, and `test/help-covers-cli.test.mjs` cross-checks this
 * reading against the running CLI in both directions before trusting
 * it. A parser that silently found nothing would otherwise report a
 * perfectly documented CLI.
 */
export function tableCommands(source) {
  const start = source.indexOf('const COMMANDS = {');
  if (start < 0) return [];
  const names = new Set();
  for (const m of source.slice(start).matchAll(/^ {2}'?([a-z][a-z0-9-]*)'?: async/gm)) {
    names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * The commands the help block advertises.
 *
 * A usage line is indented two to four spaces and starts with the
 * command; a continuation line is indented further and is prose. That
 * distinction is not cosmetic — without it, words like `types:`,
 * `ranked,` and `current` are read as command names and the check
 * reports phantoms that were never claimed.
 *
 * `a / b` in the USAGE column names both (the help writes alternatives
 * that way), so the second half is picked up too — but only there. The
 * usage column ends where a run of two or more spaces begins; past that
 * point the line is prose. Measured while building this: without that
 * boundary, the description `agents/<name>/ with prompt, knowledge`
 * produced a phantom command called `with`. A check whose own reading
 * invents findings gets switched off within a week.
 */
export function helpCommands(helpText) {
  const names = new Set();
  for (const line of String(helpText ?? '').split('\n')) {
    const usage = line.match(/^ {2,4}(\S.*?)(?: {2,}|$)/);
    if (!usage) continue;
    const lead = usage[1].match(/^([a-z][a-z0-9-]*)(?=[ [<]|$)/);
    if (lead) names.add(lead[1]);
    for (const alt of usage[1].matchAll(/\/ ([a-z][a-z0-9-]*)\b/g)) names.add(alt[1]);
  }
  return [...names].sort();
}

/** What the two sides owe each other. Empty on both means: no drift. */
export function compare({ table, help }) {
  const inHelp = new Set(help);
  const inTable = new Set(table);
  return {
    invisible: table.filter((c) => !inHelp.has(c)),
    phantom: help.filter((c) => !inTable.has(c)),
  };
}

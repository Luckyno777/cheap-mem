// errorclass.mjs — a closed vocabulary, so that errors become countable.
//
// **Where the evidence comes from, and where it does not.** The sibling
// project this tool was extracted from keeps a real error log. Counted
// on 2026-09-08: 303 entries, 212 distinct class names, 167 of them used
// exactly once. Fifty-five percent of all entries therefore sat in a
// class with a single member — and a class with one member classifies
// nothing.
//
// The hand check made it plain. `looks-right-does-nothing` was written
// seven times. Next to it lay `silent-failure`, `silent-loss`,
// `lying-check`, `falsely-green`, `watchdog-mute`,
// `in-the-repo-not-in-operation` and eight more: fourteen names for one
// thing, about 27 entries. **The dominant defect of that memory was
// invisible because everyone invented a fresh name for it.**
//
// **This project has no corpus of its own yet.** The twelve classes
// below are therefore inherited, not measured here. That is worth
// saying out loud: `coverage()` counts what a real log actually
// contains, and until someone runs it against one, the only honest
// claim is that these names come from somewhere the counting was done.
//
// **Why fixed names and not free text.** Not to save space — to let
// `mem` answer without a model call: which defect type dominates this
// year, which is piling up since the rebuild, which has not occurred
// for weeks. The nuance is not lost; it belongs in the title.
//
// **Why every class carries a FALSIFYING QUESTION.** A list of labels
// invites mis-picking. A question that can be answered on the concrete
// case decides — and when none fits, that is a finding rather than a
// reason to invent a 213th name.
//
// **What explicitly does NOT happen here: rewriting old entries.**
// Existing entries keep their class. Re-labelling them by keyword rule
// would be guessing followed by certification. Old names map through
// `ALIAS`, and only where the old name literally says the same thing or
// is a documented synonym. What is not mapped, `coverage()` counts as
// open. A gap you can see is a decision.

/**
 * The classes. Closed — anyone who needs one that does not exist edits
 * this file, and that shows up in a diff.
 */
export const CLASSES = Object.freeze({
  'looks-right-does-nothing': {
    short: 'Looked like it worked. Did not, and nobody noticed.',
    question: 'What would be visible if it did NOT work?',
  },
  'assumed-not-measured': {
    short: 'Claimed without looking — even when the claim happened to hold.',
    question: 'Did I measure this, or do I find it plausible?',
  },
  'built-but-out-of-reach': {
    short: 'Built, tested, documented — and unreachable from where the work happens.',
    question: 'Is it reachable from the place the work actually happens?',
  },
  'two-truths': {
    short: 'The same fact in two places, and they have drifted apart.',
    question: 'Who else states this, and do they still state the same thing?',
  },
  'state-stale': {
    short: 'Docs, a number or a running process lag behind the code.',
    question: 'Is this in the repo, or is it also running?',
  },
  'environment-differs': {
    short: 'Path, permissions, platform, shell — the machine was not what I took it for.',
    question: 'Which machine did I check this on, and does it run on another?',
  },
  'check-tests-the-wrong-thing': {
    short: 'A test or watchdog measures something other than the property meant.',
    question: 'Does the check go red when I break the property?',
  },
  'concurrency': {
    short: 'Two things at once: a race, a duplicate instance, a lock, an ordering.',
    question: 'What happens when this runs twice at the same time?',
  },
  'loss-or-overwrite': {
    short: 'Data gone or overwritten — a near miss counts here too.',
    question: 'What was there before, and is it still there after?',
  },
  'secret-or-permission': {
    short: 'A secret travelled, or a permission boundary let something through.',
    question: 'Who could have seen or done this who is not allowed to?',
  },
  'wrong-cause': {
    short: 'Diagnosis off — what got fixed was not the reason.',
    question: 'Did I reproduce the failure before I fixed it?',
  },
  'mishandling': {
    short: 'Tool or command used wrongly. The grip, not the build.',
    question: 'Did I read what the tool does, or what I believed it does?',
  },
});

export const NAMES = Object.freeze(Object.keys(CLASSES));

/**
 * Old names that demonstrably mean the same thing.
 *
 * Entered only where the old name literally states the matter — not
 * guessed by keyword rule. An old name missing here stays unmapped and
 * is counted by `coverage()`. That is the honest half: a mapping nobody
 * checked would be a number nobody can stand behind.
 */
export const ALIAS = Object.freeze({
  // silent / apparently green
  'silent-failure': 'looks-right-does-nothing',
  'silent-fail': 'looks-right-does-nothing',
  'silent-error': 'looks-right-does-nothing',
  'silent-outage': 'looks-right-does-nothing',
  'silent-emptiness': 'looks-right-does-nothing',
  'watchdog-mute': 'looks-right-does-nothing',
  'reporter-lies': 'looks-right-does-nothing',
  'grows-unnoticed': 'looks-right-does-nothing',
  'no-op': 'looks-right-does-nothing',
  'in-the-repo-not-in-operation': 'built-but-out-of-reach',

  // a check that measures the wrong thing
  'falsely-green': 'check-tests-the-wrong-thing',
  'falsely-red': 'check-tests-the-wrong-thing',
  'lying-check': 'check-tests-the-wrong-thing',
  'decorative-test': 'check-tests-the-wrong-thing',
  'test-measures-build-state': 'check-tests-the-wrong-thing',
  'check-tests-wording': 'check-tests-the-wrong-thing',
  'finding-from-own-setup': 'check-tests-the-wrong-thing',

  // assumed, not measured
  'false-assumption': 'assumed-not-measured',
  'wrong-assumption': 'assumed-not-measured',
  'measured-too-early': 'assumed-not-measured',
  'unproven-claim': 'assumed-not-measured',
  'invented-not-computed': 'assumed-not-measured',
  'invented-evidence': 'assumed-not-measured',
  'confabulation': 'assumed-not-measured',
  'number-not-remeasured': 'assumed-not-measured',
  'tool-assumed-not-checked': 'assumed-not-measured',
  'single-source-conclusion': 'assumed-not-measured',
  'agreement-instead-of-evidence': 'assumed-not-measured',

  // reach
  'chain-ends-before-the-purpose': 'built-but-out-of-reach',
  'option-without-caller': 'built-but-out-of-reach',
  'setting-without-reader': 'built-but-out-of-reach',
  'field-without-writer': 'built-but-out-of-reach',
  'target-does-not-exist': 'built-but-out-of-reach',
  'local-only-invisible': 'built-but-out-of-reach',
  'visibility-gap': 'built-but-out-of-reach',
  'capability-gap': 'built-but-out-of-reach',

  // two truths
  'second-truth': 'two-truths',
  'duplicate-id': 'two-truths',
  'duplicate-path': 'two-truths',
  'duplicate-hook-registration': 'two-truths',
  'copy-instead-of-source': 'two-truths',
  'rule-in-five-copies': 'two-truths',
  'rule-not-carried-over': 'two-truths',
  'field-name-inconsistent': 'two-truths',
  'half-migration': 'two-truths',
  'half-fix': 'two-truths',

  // stale state
  'doc-stale': 'state-stale',
  'docs-rot': 'state-stale',
  'docs-vs-code': 'state-stale',
  'number-frozen': 'state-stale',
  'frozen-memory': 'state-stale',
  'wrong-state': 'state-stale',
  'instructions-point-at-wrong-file': 'state-stale',

  // environment
  'exec-bit': 'environment-differs',
  'exec-bit-lost': 'environment-differs',
  'hook-not-executable': 'environment-differs',
  'path-assumption': 'environment-differs',
  'path-escape': 'environment-differs',
  'shell-expansion': 'environment-differs',
  'cross-platform': 'environment-differs',
  'portability': 'environment-differs',
  'windows': 'environment-differs',
  'separator-collision': 'environment-differs',
  'hardcoded-path': 'environment-differs',
  'hardcoded-recipient': 'environment-differs',

  // concurrency
  'race': 'concurrency',
  'race-condition': 'concurrency',
  'index-race': 'concurrency',
  'shared-state': 'concurrency',
  'deadlock': 'concurrency',
  'self-block': 'concurrency',
  'head-of-line-blocking': 'concurrency',
  'duplicate-instance': 'concurrency',

  // loss
  'data-loss': 'loss-or-overwrite',
  'silent-data-loss': 'loss-or-overwrite',
  'silent-loss': 'loss-or-overwrite',
  'data-loss-narrowly-avoided': 'loss-or-overwrite',
  'overwritten-without-looking': 'loss-or-overwrite',
  'format-loss': 'loss-or-overwrite',

  // secret / permission
  'secret-leak': 'secret-or-permission',
  'key-in-error-text': 'secret-or-permission',
  'permission-boundary-porous': 'secret-or-permission',
  'header-injection': 'secret-or-permission',
  'security': 'secret-or-permission',
  'acted-under-foreign-account': 'secret-or-permission',
  'touched-someone-elses-work': 'secret-or-permission',

  // wrong cause
  'wrong-track': 'wrong-cause',
  'wrong-lead': 'wrong-cause',
  'fix-without-reproduction': 'wrong-cause',
  'wrong-source': 'wrong-cause',
  'fallacy': 'wrong-cause',

  // mishandling
  'handling': 'mishandling',
  'tool-handling': 'mishandling',
  'tool-misuse': 'mishandling',
  'command-unchecked': 'mishandling',
  'wrong-flag': 'mishandling',
});

/** Is this a valid class? An alias does NOT count as valid for new entries. */
export function valid(name) {
  return Object.hasOwn(CLASSES, String(name ?? ''));
}

/**
 * Where does a (possibly old) name belong?
 *
 * `null` means: unmapped. Explicitly not "other" — a catch-all bucket
 * would make the open count disappear, and that is exactly the number
 * that has to stay visible.
 */
export function normalise(name) {
  const n = String(name ?? '').trim();
  if (valid(n)) return n;
  return Object.hasOwn(ALIAS, n) ? ALIAS[n] : null;
}

/**
 * What to print for an unknown name.
 *
 * No fuzzy matching: a guessed suggestion is precisely the convenience
 * that produced 212 classes. The twelve questions instead — whoever
 * reads them decides on the case rather than on the sound of a word.
 */
export function help() {
  return NAMES.map((n) => `  ${n}\n      ${CLASSES[n].short}\n      ? ${CLASSES[n].question}`);
}

/**
 * How much of a body of entries is countable?
 *
 * Returns `mapped`, `open` and the open names. The open number is the
 * point: it says how far the result may be trusted.
 */
export function coverage(entries) {
  const by = new Map();
  const open = new Map();
  for (const e of entries ?? []) {
    const raw = e?.class ?? '(none)';
    const n = normalise(raw);
    if (n) by.set(n, (by.get(n) ?? 0) + 1);
    else open.set(raw, (open.get(raw) ?? 0) + 1);
  }
  const mapped = [...by.values()].reduce((a, b) => a + b, 0);
  const openCount = [...open.values()].reduce((a, b) => a + b, 0);
  return {
    mapped,
    open: openCount,
    total: mapped + openCount,
    byClass: [...by].sort((a, b) => b[1] - a[1]),
    openNames: [...open].sort((a, b) => b[1] - a[1]),
  };
}

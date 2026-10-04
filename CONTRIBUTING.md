# Contributing

Currently a one-person project. This file exists so the rules are
written down before they are needed, not after.

## The one rule that is not negotiable

**Never `--no-verify`, and never weaken a check to get past it.**

The pre-commit hook scans staged content for secrets. It fires on test
fixtures too — that is the check working, not a false positive to be
silenced. The fix is always to change the code: rename the constant,
assemble the fixture at runtime, rephrase the prose. A check that has
been weakened once to let something through has stopped being a check.

## What a change looks like here

1. **Measure before you build.** If the change rests on a claim about
   size, speed or frequency, produce the number first. Several features
   in this repository were not built because the measurement killed the
   premise, and the reason is in the commit message.
2. **Write the test so that breaking the thing turns it red.** Then
   actually break it and watch it turn red. A test that survives
   sabotage tests nothing — this has caught decorative tests here more
   than once, including tests written the same hour.
3. **Never silent.** Three states, not two: missing, empty, broken. An
   empty result that hides a broken wiring is the most expensive failure
   this project knows, and most of its guards exist because it happened.
4. **Put the finding in the code.** Comments here carry the measurement
   and the failure that motivated the line, not a restatement of what
   the line does. If a future reader would reasonably remove it, the
   comment has to tell them why not.

5. **Mark the parity.** A commit that changes `src/` or `bin/` ends with a
   trailer line `Parity: lm=yes`, `lm=no` or `lm=open` — whether the same
   change exists in the sibling house, was deliberately not built (say why in
   the message), or is still pending. A later commit can supply the line for
   an earlier one with `Parity-Addendum: <hash> lm=yes|no|open`; pushed
   history is never rewritten. `test/parity-gate.test.mjs` checks the line is
   there, `node bench/parity.mjs` counts, `node bench/parity.mjs --debt` lists
   what is still open. See `BUILDING.md`, rule 17.
6. **Keep the documentation in step.** The README's numbers come from
   `node bench/readme-numbers.mjs --write`, never from the keyboard. A new
   environment variable is registered in `src/envregister.mjs` and appears
   in `docs/environment-variables.md`. All shipped text is English.

## Hooks in this checkout

```bash
git config core.hooksPath hooks   # pre-commit secret check + pre-push CI warning
```

The pre-push hook only warns: before a push to the default branch it asks
CI (via `gh`) whether that exact commit has a green run, and says so if
not — or that it could not ask. It never blocks. The safe route to main is
still: push the branch, let CI run green, then move main.

## Running things

```bash
npm test          # the full suite
node --test test/<name>.test.mjs   # one file — the quick loop while working
npm run lint      # style
npm run coverage  # which lines the tests actually reach
node bin/mem doctor --strict
```

Measuring instruments under `bench/` that no `npm` script calls (each prints
its own usage in its header; none changes the memory):

| script | what it answers |
|---|---|
| `bench/gold-compare.mjs` | the fixed retrieval gold set on one code state, or on two git refs side by side (`--base`, `--gate`) |
| `bench/injection-by-origin.mjs` | the injection journal per occasion and per origin (cloud, ssh, local, unknown) |
| `bench/consumption-funnel.mjs` | per channel: how much is produced, delivered, consumed (`null` = not measured) |
| `bench/field-without-writer.mjs` | fields that a guard reads and no write path ever sets |
| `bench/claim-double.mjs` | how often two parallel observers both act on the same open message |
| `bench/coverage-floor-sweep.mjs` | the search's coverage floor on a Heaps-law corpus |
| `bench/scale-gate.mjs` | the pass/fail ladder at 10k, 100k and 1M entries (`docs/scale.md`) |
| `bench/add-spdx.mjs` | puts the licence header on files that lack one |

## Scope

Additive and corrective changes are low risk: a new module, a fix, a
test, a documentation correction.

Structural changes are a different category — splitting `bin/mem`,
changing CI behaviour, publishing to npm, altering the on-disk format.
Open an issue first. The guiding line: **logging runs, rebuilding
asks.**

## Releasing

A release is a tag. `.github/workflows/release.yml` does the rest, and
it refuses more often than it publishes — deliberately, because a
published version cannot be replaced.

```bash
# 1. Name the release in CHANGELOG.md: turn "## Unreleased" into
#    "## 0.2.0 — 2026-09-15" and start a fresh Unreleased above it.
# 2. Bump and tag together. `npm version` does both in one commit, so
#    the tag and the manifest cannot drift apart.
npm version minor -m "release %s"
git push origin main --follow-tags
```

The workflow then, in order:

1. **gate** — the tag equals `v<package.json version>`, the changelog
   has a section named for that version, and the registry does not
   already have it. Seconds, so a typo is caught before the matrix runs.
2. **verify** — `npm run lint` and `npm test` on the tagged commit.
3. **pack** — `npm pack`, then install that tarball into an empty
   directory and run the CLI from it. This is the only check that sees
   the package as a stranger does: every test in the repository runs
   from a checkout, where nothing can be missing from `files`. It also
   fails if a memory, a raw capture or a `node_modules` made it into the
   tarball.
4. **publish** — `npm publish --provenance`, signed by the workflow via
   OIDC. It carries `id-token: write` and nothing else; the repository
   itself stays read-only for the job that holds the registry token.

To exercise the whole path without publishing, run the workflow from the
Actions tab with **dry-run** left on. Everything up to step 4 runs; step
4 is skipped by its own condition. A release path that is only ever run
for real is a release path nobody has tested.

`NPM_TOKEN` is a repository secret, and the `npm` environment can carry
a required reviewer if you want a human between the tag and the
registry.

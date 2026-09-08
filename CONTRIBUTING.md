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

## Running things

```bash
npm test          # the full suite
npm run lint      # style
npm run coverage  # which lines the tests actually reach
node bin/mem doctor --strict
```

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

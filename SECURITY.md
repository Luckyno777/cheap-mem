# Security

## What this tool touches

cheap-mem is worth a security policy for three concrete reasons, not as
a formality:

1. **It reads your session transcripts.** Everything you and an
   assistant said, including whatever you pasted in.
2. **It commits and pushes.** Whatever survives redaction goes into a
   git repository, and git keeps history — a secret committed once is
   not removed by deleting the file.
3. **It can hold API keys.** The optional embedding providers
   (Voyage, OpenAI, Ollama) read a key from the environment.

## Reporting

Open a **private** security advisory on the GitHub repository
(Security → Report a vulnerability), or write to the address in the
repository owner's GitHub profile.

Please do not open a public issue for anything involving a leaked
secret, a redaction bypass, or a path that escapes the memory root.

This is a one-person project. Expect an answer, not a service level.

## What is defended, and how you can check

Every claim below has a command. Run it rather than believe it.

| Defence | Where | Verify |
|---|---|---|
| Secrets redacted before anything is written | `src/redaction.mjs` | `node --test test/redaction*.test.mjs` |
| Redaction self-test before every capture | `redaction.selfTest()` | a failing canary aborts the capture |
| Values compared against the actual environment | `redactAgainstEnv` | `node --test test/redaction.test.mjs` |
| A pre-commit hook scans staged content | `install/hooks/` | `mem doctor --strict` |
| The memory root cannot be escaped | `src/memory.mjs` | `node --test test/path*.test.mjs` |

**The canary matters more than the pattern list.** If the redaction
stops doing what it claims, the capture does not happen — a gap in the
memory is cheaper than a secret in the version history.

## Known limits

Stated because a defence you believe in but do not have is worse than
none:

- **Redaction is pattern-based.** It knows the shapes of common
  credentials and the values in your environment. A secret in a shape
  nobody anticipated, and not present in the environment at capture
  time, goes through.
- **The archive is outside git and outside its guarantees.** Files there
  are not version-controlled. The record in the repository carries a
  SHA-256 so a changed file is detectable, but nothing prevents the
  change.
- **A syncing store copies your memory elsewhere.** If you point the
  archive at Google Drive, iCloud, OneDrive or Dropbox, the captures go
  to that provider. `mem raw archive --set` says so at the time; it is
  your call, not the tool's.
- **`git` history is permanent.** If a secret ever reaches a commit,
  removing the file does not remove it. Rotate the key.

## Not in scope

- The AI assistant's own behaviour. cheap-mem records what happened; it
  does not sandbox anything.
- Anything you write into the memory yourself. `mem log` stores what it
  is given, minus redaction.

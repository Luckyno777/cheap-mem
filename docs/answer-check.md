# Answer check (Stop hook)

The Stop hook (`bin/mem-stop`) checks the session's LAST answer against
patterns before that answer reaches you — a hit continues the same turn
with a reason instead of waiting for the next message to catch it. See
`src/answercheck.mjs` for the full reasoning.

**Off by default.** This mechanism ships with no patterns at all. A
memory with no `.mem/answer-patterns.json`, or an empty one, checks
nothing — silence, not a warning, not a crash.

## Arming it

Patterns are **your own memory's data**, never anything built into
cheap-mem. Each pattern must name the `id` of an error already logged in
*this* memory's own `errors.jsonl` (global or a project) — a pattern
whose `error_id` cannot be found there is dropped before it can ever
match anything, at read time, every time the hook runs.

1. Log the mistake once, normally, if you have not already:
   ```bash
   mem log error --class <class> --title "..." --text "..."
   ```
   Note the `id` the write prints.
2. Copy [`answer-check-patterns.example.json`](answer-check-patterns.example.json)
   to `.mem/answer-patterns.json` in your memory and fill in:
   - `id` — a short name for the pattern, unique in the file.
   - `error_id` — the id from step 1.
   - `pattern` — a regex (JavaScript `RegExp` source); matched per line
     of the answer, case-insensitive by default (`flags`).
   - `reason` — one sentence explaining what the match means.
   - remove `"disabled": true` once you are ready to arm it.
3. `measured` starts as `{ "reports": 0, "correct": 0 }`. As the pattern
   fires, update it by hand from what you judge each report to have been
   (a correct catch or a false alarm). Below 5 measured reports the
   pattern stays active regardless — the rate is "unknown", not "bad".
   At 5 or more, a pattern with a hit rate under 1 in 5 stops firing on
   its own (`answercheck.isActive`) — no switch to remember to flip.

## Tuning

- `MEM_ANSWER_CHECK=0` — turn this one check off for a session (capture
  and persist still run).
- `MEM_ANSWER_CHECK_PATTERNS=<path>` — read patterns from somewhere
  other than `.mem/answer-patterns.json` (relative paths resolve
  against the memory root).
- `MEM_HOOK_OFF=1` — turns off every cheap-mem hook, this one included.

Each pattern reports **at most once per session**, and never on a turn
where `stop_hook_active` is already true (the turn already continued
once — reporting again would loop).

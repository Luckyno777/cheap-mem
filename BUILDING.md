# Building: build cheap, measure honestly

Short instructions to carry into other sessions. Not a manifesto —
rules that have proven themselves on cheap-mem and lucky-mem, with the
costs they actually caused. Ten on 2026-09-06, the eleventh added on
2026-09-07.

## The rules

1. **Code first, model last.** Break the question apart and answer
   every sub-question that code can answer with code. A model call is
   there only for the one sub-question that truly needs a judgment —
   here: "does the detail change the answer?". Everything else (does
   it arrive? is it unambiguous? does it sit at the top?) is a loop
   over an index.

2. **Measure the headroom before you build the lever.** A lever can
   only work where the detail ARRIVES **and** the model fails without
   it. Report the intersection, never the two sets separately — they
   overlap, and named separately they overstate the benefit many
   times over. Measured: arrives 38 %, right without memory 19 %,
   headroom 24 %.

3. **Positive control before every measurement.** Before you measure
   whether something helps, show that the rig fails without it. A
   clean null result is usually a broken probe, not a finding. This
   rule fired correctly six times in one session. Write the control's
   result into the output too.

4. **The test rig must never see its own answer.** Separate
   vocabularies, a leakage guard that fails the run, and help text
   from a model that does not know the tasks. Criterion for leakage:
   the word alone satisfies the scoring rule. Thematic overlap is
   allowed and normal.

5. **Your own judgment is the weakest instrument.** What you assess
   is written into the data model as a falsifiable prediction and
   measured afterward. My prediction "the model would have known
   anyway" was right 59 % of the time; two independent assessments of
   the same 15 facts agreed on 9. A label with 60 % agreement may not
   carry a metric.

6. **Measure paired, task as the unit of observation.** The same task
   twice, with and without. A sign test over the tasks that differ —
   no average over yes/no values, which fakes precision. Result was
   12/63 -> 34/63, 22 better, 0 worse, p < 0,0001. And this belongs
   with it: the absolute number is a property of this task set, not a
   transferable rate.

7. **Never pay twice for the same measurement.** Every run tool gets
   `--only <ids>`. Tasks already measured under identical conditions
   are not bought again.

8. **Mutants instead of green tests.** A guarantee that no test
   breaks is no guarantee. A mutation run that breaks real rules and
   checks that tests turn red; stale or ambiguous anchors count as a
   failure, not a warning. A switch nobody flips is not disabled
   code — it is untested code that looks tested.

9. **A new signal becomes its own lane, not another weight.** A
   weighted sum cannot say which of its terms spoke, and every new
   weight is a knob nobody can calibrate. Lanes can explain
   themselves. Caution: reordering BEFORE a reranker is not a rule —
   MMR chooses by score and ignores input order. Every lane needs its
   own pass.

   **And a lane also orders INSIDE itself.** Addendum from
   2026-09-07, which would have gotten the rule a year too late. The
   exact lane handed out its hits in index order, all with score 0 —
   whichever entry stood earlier in the file won. Measured on a
   question that named `1029` and hit seven entries: a thematically
   unrelated note (BM25 2,26) at rank 2, the answer (19,96) at rank 5,
   the lane's strongest hit (36,26) at rank 7. An excerpt that takes
   three hits per question thereby lost the answer — not because the
   search missed it, but because its own lane buried it.

   The lane decides the SELECTION, the score the ORDER within it.
   Whoever keeps only the first has built a lane that carries
   arbitrariness.

   Two side findings that belong here. First: the comment above the
   function had always claimed the hits carried "the score they
   would have had" — the code set 0. A guarantee that lives only in a
   comment is rule 8. Second: the lane's rationale reads "a named
   identifier is certainty." That silently assumes there is EXACTLY
   ONE hit. Seven mentions are not certainty, but a topic — and then
   only the ordering carries anything.

10. **Name the cost before you measure.** Every measurement proposal
    comes with a price. The client decides whether the answer is
    worth it — not you.

11. **A watcher that recognizes by what it expected only measures its
    own expectation.** Whoever waits for an event must recognize it
    by the EVENT ITSELF — by the identifier, the reference, the
    subject — never by the expected name, path or sender. Otherwise
    it reports not "wrong" but "nothing there," and absence looks
    like a finding.

    Cost, on 2026-09-07: a waiting probe filtered on the filename
    `chatgpt-an-sitzung`. The answer was named `chatgpt-an-vm-admin`
    — misaddressed, but complete and correct. It did not see it for
    18 minutes, ran into the pre-announced deadline and reported an
    outage. It had been sitting there for 112 seconds, and the human
    got the wrong report, because no error occurred that anyone could
    have seen.

    In practice that means two things. When building: take the
    feature from the event, not from the expectation. When
    measuring: before reporting "not there," check once WITHOUT your
    own filter what has come in at all since the start. Related to
    rule 3 — the positive control asks whether the probe fires at
    all; this one asks whether it is looking at the right thing.


12. **A clean-looking working tree is not frozen.** Whoever wants to
    check whether a red test comes from their own work needs the
    state BEFORE their own work — a working tree on the commit before
    it (`git worktree add /tmp/before <commit>^`), not `git stash`.

    Cost, on 2026-09-12, twice on the same day. Both times I dismissed
    a red test as "pre-existing": stash, run, same color, so not my
    fault. A stash only removes UNCOMMITTED work; the session's own
    commits stay in place and get measured along with it. The working
    tree on the commit before then showed: `test/retrieve.sh` stood
    at 15/0 before, the five red probes were entirely mine, and
    cheap-mem's retrieval hook had been dead since the morning —
    `CHEAP_MEM_ROOT` had vanished from `bin/mem` through a rename.

    Second layer of the same mistake, hours later: that test's
    fixture builds with `git archive HEAD` and does not see the
    working tree at all. The fix did NOTHING there until it was
    committed — the difference only became visible after the commit.

    The same rule stands at DeusData/codebase-memory-mcp as a
    measurement rule: "Do not run either condition in a merely
    clean-looking working copy. A frozen experiment includes
    untracked files." They set up separate detached worktrees and
    repeat the SHA and cleanliness check BEFORE and AFTER every step.

    What carries the lesson: both times, the more convenient
    measurement was the one that let me off the hook. That is exactly
    why I did not question it.

13. **The smaller provable number beats the larger plausible one.** A
    number that goes public names what it is derived from and what it
    does not include. Where the two diverge, the provable one wins.

    Found on 2026-09-13 at DeusData/codebase-memory-mcp and
    re-measured there. Their contract test defines the truth as the
    number of bundled grammar directories — 162, recounted. README
    and `server.json` agree with that. The evaluation plan says 159
    in six places, the benchmark's methodology header says 63 and
    contradicts itself one parenthesis later (27+8=35, and 35 also
    stands in its own aggregate table).

    What's notable is not the error, but their reasoning for choosing
    the truth. Not the language table in the code, because it lists
    entries without a parser: "counting them would publish languages
    we do not parse." And with that: "Known and accepted: this
    UNDERCOUNTS languages that share one grammar. We publish the
    number we can prove rather than the larger number we cannot."

    Practically: a guard counts the number from the source and
    compares it against EVERY document, not against a list of
    documents — a contract covers exactly the surfaces it lists, and
    that is exactly where 159 and 63 slipped through there. What is
    exempted stands in the guard with a reason. And it reports itself
    when its pattern no longer matches anything: a check that runs
    into a void otherwise stays green forever.

## Costs for calibration (Sonnet 5, September 2026)

| Measurement | Scope | Cost |
|---|---|---|
| Stateless baseline | 45 tasks | ~2,25 USD |
| Catch-up of new classes | 24 tasks | ~1,20 USD |
| One paired arm | 63 tasks | ~3,15 USD |
| **whole workday** | everything above plus repeats | **~11 USD** |

Roughly: **5 cents per task and arm.** That is the number you plan
with beforehand.

14. **A measuring instrument is done when someone calls it — not when
    it runs.** Every new tool gets its caller right at build time:
    CI, if the question is answerable within ONE repo — a doctor
    finding, if it needs both houses or the running machine.

    On 2026-09-18 it turned out that `bench/invariants.mjs` ran in NO
    pipeline. It correctly reported five orphaned markers with exit
    code 1, and nobody was listening — under the heading "Covered: 16
    of 16". `bench/calculations.mjs` and `bench/finding-mirror.mjs`
    were born the same day, and both would have been born with the
    same fate.

    That's why the mirror hangs as the finding `finding-parity` in
    the doctor, and reported itself as unassessed on its very first
    run.

15. **In shared data, no word's meaning may depend on where it is
    read.** What two houses read must mean the same in both. Points
    of view — "here," "over there" — are not data, they are
    standpoints.

    `shared/finding-map.jsonl` wrote `nur: "hier"` on 2026-09-18. Read
    from this house, that same file flipped EVERY one of the 43
    entries. It only surfaced when the ported tool ran from this side
    for the first time. The side is now named by BUILD FORM
    (`nur: "befund"` / `nur: "finding"`), and the reasoning names
    `lucky-mem` and `cheap-mem` by name.

    Applies within one house too, for vocabulary: two meanings under
    one word are the same drift as two calculations over the same
    question.

16. **A name from a foreign system is checked against ITS list — even
    when you think it's made up.** The rule has a direction that is
    easily overlooked: it forbids not only accepting a name, but also
    rejecting one.

    On 2026-09-18, two hook lanes turned up in lucky-mem that hung off
    `PostToolUseFailure` and `SubagentStart`. From memory alone it
    seemed settled that Claude Code knows exactly nine events and
    that these two are not among them. Both lanes were written into
    the error store as "silently ineffective," rebuilt, tested,
    sabotage-tested, documented and pushed.

    Both names stand in the official reference. The real list is
    roughly twice as long as the remembered one. `PostToolUseFailure`
    fires exactly on a failed tool call; `PostToolUse`, where the
    "guard" was rehung, fires, per that same page, ONLY after
    success. The rebuild would have blinded a running hook.
    `SubagentStart` explicitly delivers its context INTO the
    sub-agent — the guarantee that was given up as unfulfillable
    during the rebuild.

    It surfaced because a second model disagreed and named the
    reference. Not the probe itself, not the sabotage test, not the
    guard: all were green, because they used the same wrong list as
    the code. **A probe inherits the assumption it is meant to check
    against.** Sabotage-resistance says nothing about the premise.

    What remained is the question nobody could answer in the
    process: whether these hooks had ever fired. They weren't even
    registered on the machine. Exactly this unmeasurability was the
    breeding ground — where nothing is visible, a guess looks like a
    finding. That's why the hooks now count their own runs, and
    `mem doctor` reads the counter. That is the only part of the
    rebuild that stays.

    The check also includes the question of HOW OLD one's own list
    is. A model knows the state of its training, not that of the
    installed version.

## The filter for every change

Does retrieval stay model-free and in the millisecond range? Does the
rule need a threshold nobody can calibrate? Is the vocabulary closed
enough that code can walk it? Is the guarantee enforced, or only
documented?

Four yeses — build it. One no — it's a different system.

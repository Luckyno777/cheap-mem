# Re-scoring the stored run under the corrected D18 contract

**This is a post-hoc correction, and it is labelled as one.** The rule
was changed after seeing these answers. Nothing here is a new claim
about whether memory helps; it is a repair of four labels that were
demonstrably wrong, with the arithmetic redone over the same answers.

## What was wrong

D18 asks for today's discount percentage. Its contract was
`must: [/\b3\b/]`. An external audit of 2026-09-17 graded three answers:

| answer | old grader |
|---|---|
| `10 Prozent. Quelle V-preisstaffel-3.` | **success** |
| `10 Prozent.` | failure |
| `3 Prozent.` | success |

The `3` in the first answer is the tail of the source identifier the
model cited. The grader rewarded naming a source whose name contains the
digit, while the answer itself said something else.

## What changed

`D17` and `D18` now require the unit: `/\b3\s*(%|prozent)/i`. Twelve
further bare-number contracts moved to a number that may not sit inside
an identifier (`(?<![\w-])30(?![\w-])`), and carry positive, negative
and misleading control answers.

**Two holes, two guards.** The identifier-safe number does not catch
D18: four of its answers say "zehn Prozent … (aktuell in Runde 3)",
where the `3` stands loose in the sentence. The unit does not catch
`90 Tage, Quelle V-frist-30` for a question that asks for a bare number.
Neither guard covers the other.

**What was tried and rejected.** Stripping source identifiers and
version numbers from the answer before matching was implemented and
re-scored: it changed 16 gradings, only 4 of them the D18 ones. The
other 12 were B1 (`systemd-Unit-Datei`), I11 (`kolibri-postausgang`),
I14 (`Fassung 7.1.4`) and I17 (`pflege/abrechnung-2026`) — where the
hyphenated token IS the answer. In a German corpus a rule against
hyphenated tokens is a rule against the language.

## The numbers

Source: `eval/runs/paar-sauber-20260916-restricted.jsonl`, 192 answers,
24 tasks, four repetitions per condition. No model was called; only
`grade()` was re-run over the stored text.

| condition | stored grader | corrected | change |
|---|---|---|---|
| with memory | 86 / 96 | **86 / 96** | none |
| without memory | 33 / 96 | **29 / 96** | −4 |

All four changed labels are D18, all in the *without memory* condition,
all answers that said ten percent and cited `V-preisstaffel-3`.

Note the direction: the correction makes the measured gap **larger**,
not smaller. That is not an argument for the correction — it is a
reason to be careful with it, which is why this file exists and why a
new efficacy claim needs its own clean run under these rules.

The tasks that came out *worse* with memory, H2 and H4, are deliberately
untouched.

## What was NOT repaired, and why

Three tasks in the frozen final split — F3, D6, F6 — carry the same
bare-number contract. Repairing them would change
`eval/final-eingefroren.sha256`, and after that the final run would no
longer be an independent measurement. That costs more than the hole
does, so they stay as they are, exempt **by name** in
`test/audit-messgeraete.test.mjs`, which also checks that the exemption
does not grow and that every name on it still needs it.

They are a debt. The next time the final split is legitimately re-cut,
they get the same treatment as the other twelve.

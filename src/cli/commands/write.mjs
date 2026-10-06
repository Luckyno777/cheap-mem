// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * Writing to the memory: entries, corrections, retirement, links.
 *
 * Split out of `bin/mem` on 2026-09-18. The file was 4503 lines and
 * had no extension, which is how it slipped past ESLint on the
 * 2026-09-08 without anyone noticing.
 *
 * The groups are cut by the QUESTION a command answers, not by size:
 * whoever is looking for `mem log` is not looking next to `mem
 * doctor`. `bin/mem` merges them and dispatches; nothing here knows
 * about the others.
 */

import path from 'node:path';
import * as memory from '../../memory.mjs';
import * as search from '../../search.mjs';
import * as guard from '../../guard.mjs';
import * as probescaffold from '../../probescaffold.mjs';
import * as broadcast from '../../broadcast.mjs';
import * as procedure from '../../procedure.mjs';
import * as workflow from '../../workflow.mjs';
import * as snippet from '../../snippet.mjs';
import * as question from '../../question.mjs';
import * as neighbours from '../../neighbours.mjs';
import * as errorclass from '../../errorclass.mjs';
import * as commandguard from '../../commandguard.mjs';
import * as errorcontext from '../../errorcontext.mjs';
import * as doctor from '../../doctor.mjs';
import * as entryops from '../../entryops.mjs';
import * as errorfixes from '../../errorfixes.mjs';
import * as skillregistry from '../../skillregistry.mjs';
import * as categories from '../../categories.mjs';
import * as expand from '../../expand.mjs';
import { out, die, warn, checkFlags, numberFlag, isHelp, fieldsFrom, findRoot, requireConfig, authorityArg } from '../shell.mjs';
import { dateFieldOf, compactLine, countLines, retireCmd } from '../display.mjs';

/** 14 commands. */
export const COMMANDS = {
  log: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        "mem log <type> [--project <name>] --<field> <value> [...]",
        "",
        `  Types: ${Object.keys(memory.TYPES).join(', ')}`,
        "  Reserved: --project, --root",
        "  Every other --flag becomes a field in the JSONL entry.",
        "  --tags takes a comma-separated list.",
        "  --from <error-id[,...]>  for `log learning`: the error(s) this lesson",
        "             is drawn from — written as `generalizes` links, not as a",
        "             field. An unknown id aborts before anything is written.",
        "  --file <path>  for `log error`: lays down test/error-<id>.test.mjs",
        "             (marker, three test.todo sections) unless one is already",
        "             there. Never overwritten. --without-scaffold turns it off.",
        "  --category <key>  propose a category for the entry's NEW topic (an own",
        "             line, never an entry field); --category-new \"key|Label\" proposes",
        "             a new one. Code decides: see `mem category --help`.",
        "  --valid_from / --valid_until  when the content HOLDS (not when it was",
        "             written — that is --ts). --valid_until is refused if it is",
        "             not a readable date. State it only when you know a real end",
        "             date; correcting an entry (`mem correction`) already ends",
        "             its predecessor's validity at the correction's own",
        "             --valid_from, with no --valid_until needed for that case.",
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    const cfg = requireConfig(root);
    const type = rest[0];
    if (!type) die([
      "log: which type?",
      `  Known: ${Object.keys(memory.TYPES).join(', ')}`,
    ].join('\n'));
    if (!Object.hasOwn(memory.TYPES, type)) {
      die(`log: unknown type '${type}'. Known: ${Object.keys(memory.TYPES).join(', ')}`);
    }
    let data = {};
    // The rules live in fieldsFrom() — once, for `log` and `correction`
    // together. They used to be written out here and again below.
    Object.assign(data, fieldsFrom('log', args, ['category', 'category-new']));

    // `valid_until` is refused, not silently accepted, if it cannot be
    // read as a date — see `dateFieldOf`. `valid_from` had this exact
    // gap already and keeps it here: that is a separate, pre-existing
    // defect, named rather than fixed in passing, so it stays visible
    // instead of disappearing into an unrelated change.
    if (Object.hasOwn(data, 'valid_until')) {
      data.valid_until = dateFieldOf(data.valid_until, 'valid_until', 'log');
    }

    // A pure switch, not a field — same reasoning as the guard-kind
    // trio below: left in `data` it would become a stray boolean field
    // on every error entry that opts out of the scaffold.
    const withoutScaffold = Boolean(data['without-scaffold']);
    delete data['without-scaffold'];

    // The same for `--no-broadcast`: it is read from `args` further down,
    // but unless it is taken out of `data` here it is ALSO written into
    // the entry as a field `"no-broadcast": true`.
    delete data['no-broadcast'];

    // **L2a port: `--from` on a learning is not a field but edges.** The
    // error(s) the lesson is drawn from become `generalizes` links after
    // the write (src/errorfixes.mjs). An unknown id aborts BEFORE the
    // write — an id that does not exist is not guessed at. (`from` stays
    // an ordinary field for every other type: a `link` entry needs it.)
    let fromErrors = [];
    if (type === 'learning' && Object.hasOwn(data, 'from')) {
      fromErrors = errorfixes.fromIds(data.from === true ? '' : data.from);
      delete data.from;
      if (!fromErrors.length) die('log: --from without an error id. Meant: --from <error-id[,<error-id>...]>.');
      const c = errorfixes.checkFrom(root, fromErrors);
      if (c.unknown.length) die(`log: --from: no error with id ${c.unknown.join(', ')}. Nothing was written.`);
    }

    // **A class outside the vocabulary is warned about, never refused.**
    //
    // Counted in the sibling project on 2026-09-08: 303 error entries in
    // 212 class names, 167 of them used exactly once. The dominant defect
    // type was invisible because every writer coined a fresh name for it.
    //
    // The answer is not a hard check. `mem log` is the path along which
    // things get saved that would otherwise be lost; a write that fails
    // on a naming rule loses the content. So: warn, name the class the
    // old name maps to if there is one, and print the twelve questions
    // when there is not. The entry is written either way.
    if (type === 'error' && data.class && !errorclass.valid(data.class)) {
      const hit = errorclass.normalise(data.class);
      if (hit) {
        warn(`class: '${data.class}' is an old name for '${hit}'.`);
        warn(`  It counts towards '${hit}'. Use that name for new entries.`);
      } else {
        warn(`class: '${data.class}' is outside the vocabulary — it will not be counted.`);
        warn('  Pick the one whose question you can answer on this case:');
        for (const block of errorclass.help()) for (const l of block.split('\n')) warn(l);
      }
    }

    // **`--command-pattern` on an error (lever-5 port, src/commandguard.mjs).**
    // The switch is stored as the field `command_pattern`, which the before-
    // edit hook reads on Bash. A pattern that cannot be matched (too short,
    // quotes, non-ASCII) is dropped by the reader, so it is WARNED about
    // here instead of leaving a guard that exists and never fires.
    if (Object.hasOwn(data, 'command-pattern')) {
      const { 'command-pattern': v, ...restFields } = data;
      data = { ...restFields, [commandguard.FIELD]: data[commandguard.FIELD] ?? v };
    }
    if (Object.hasOwn(data, commandguard.FIELD)) {
      if (type !== 'error') die('log: --command-pattern belongs on an error (type error).');
      if (data[commandguard.FIELD] === true) die('log: --command-pattern arrived without a value. Meant: --command-pattern "git add -A".');
      const given = String(data[commandguard.FIELD]);
      const bad = commandguard.rejected(given);
      if (!commandguard.parseField(given).length) {
        die(`log: --command-pattern has no usable pattern (${bad.map((b) => JSON.stringify(b)).join(', ') || 'empty'}). `
          + 'A pattern is printable ASCII, 4 to 80 characters, no quote or backslash. Nothing was written.');
      }
      for (const b of bad) warn(`command pattern ${JSON.stringify(b)} is unusable and will not fire (4-80 printable ASCII characters, no quote or backslash).`);
      if (errorclass.normalise(data.class) !== commandguard.GUARD_CLASS) {
        warn(`command pattern: the guard is meant for class '${commandguard.GUARD_CLASS}' (this one is '${data.class ?? 'none'}'); it fires anyway.`);
      }
      data[commandguard.FIELD] = commandguard.fieldValue(commandguard.parseField(given));
    }

    // --- The latch, and its positive control -------------------------
    //
    // The three --guard-* flags are bundled into ONE field, so half a
    // latch never lands as a loose field in the entry.
    //
    // And then it is checked IMMEDIATELY. The reason is a lesson of its
    // own: a latch that was never red is unproven — the same thing as a
    // falsification test without a backdrop. At the moment of logging
    // the error is THERE, so the latch MUST be red. If it is green it
    // does not detect what it is supposed to detect.
    //
    // It is not rejected for that: sometimes you log the error only
    // after fixing it. The finding is recorded IN THE ENTRY
    // (`guard_at_creation`) instead — so it stays readable later
    // whether this latch ever caught anything.
    if (args['guard-kind'] || args['guard-path'] || args['guard-pattern']) {
      for (const k of ['guard-kind', 'guard-path']) {
        if (!args[k] || args[k] === true) die(`log: --${k} missing or without a value.`);
      }
      const kind = String(args['guard-kind']);
      if (!Object.hasOwn(guard.GUARD_KINDS, kind)) {
        die(`log: --guard-kind '${kind}' does not exist. Known: ${Object.keys(guard.GUARD_KINDS).join(', ')}`);
      }
      const g = { kind, path: String(args['guard-path']) };
      if (args['guard-pattern'] && args['guard-pattern'] !== true) {
        g.pattern = String(args['guard-pattern']);
      }
      for (const k of ['guard-kind', 'guard-path', 'guard-pattern']) delete data[k];
      data.guard = g;

      const probe = guard.check(g, { root });
      data.guard_at_creation = probe.state;
      if (probe.state === 'broken') die(`log: the latch is no good — ${probe.why}`);
      if (probe.state === 'green') {
        out('WARNING: the latch is GREEN at creation time.');
        out(`  ${probe.why}`);
        out('  It did NOT detect the error you are reporting right now.');
        out('  Either it is cut wrong, or the error is already fixed.');
        out('  Recorded as guard_at_creation: green — a latch that was never red');
        out('  is unproven.');
      }
    }
    if (Object.keys(data).length === 0) die("log: no data. Give at least one --field.");

    // A field is not content. `--tags a,b` alone writes {tags, agent} —
    // a real field, no way to ever find it again by anything it says.
    // The rule lives once in memory.hasContent(); since O1 it is ENFORCED
    // in memory.logCheckedEntry(), the same function the MCP bridge
    // writes through. Asked early here only so the neighbours below are
    // not computed for an entry that is refused anyway — same message
    // constant, so the two cannot drift.
    if (!memory.hasContent(data)) die(`log: ${memory.NO_CONTENT_MESSAGE}`);
    // Report the topic's shape, but do NOT abort. `mem log` is the path
    // along which things get saved that would otherwise be forgotten — a
    // write that fails on a naming rule loses the content. Better recorded
    // and flagged than clean and gone. (Until 2026-09-05 there was no such
    // warning, and 69 topics grew for 69 entries.)
    if (data.topic) {
      const chk = memory.checkTopic(data.topic);
      if (!chk.ok) {
        for (const w of chk.warnings) warn(`topic: ${w}`);
        warn('  see the existing topics: mem topics --names-only');
      }
    }

    // **Procedures: the latch stands BEFORE the write.**
    //
    // A rule without an author is an anonymous instruction, and that is
    // exactly what the next reader launders into a fact. The bridge does
    // not write this type at all (bin/mem-mcp); here, where a human CAN
    // be at the keyboard, it is made ATTRIBUTABLE instead who is
    // supposed to have issued it.
    let startAs = null;
    if (type === procedure.TYPE) {
      const me = data.agent ?? memory.agentDefault();
      // `--start-as proposed|trial|released` (X3, E4): the start status is
      // a FIELD of the rule (`start_status`), so status and rule are ONE
      // write — a crash between the two can no longer leave a rule
      // standing in force. Default (E4, corrected): whoever files a rule
      // WITH a human `--issued-by` has issued it, so it starts as
      // `released`; without a human issuer it starts as `proposed` (an
      // agent never releases its own rule). See below, after the latch.
      if (Object.hasOwn(data, 'start-as')) {
        startAs = String(data['start-as']);
        delete data['start-as'];
        if (!procedure.TRANSITIONS.new.includes(startAs)) {
          die(`log procedure: --start-as '${startAs}' unknown (allowed: ${procedure.TRANSITIONS.new.join(', ')}). `
            + 'Without it a rule filed with a human --issued-by starts as released, any other as proposed.');
        }
      }
      // `--issued-by` arrives hyphenated, the entry stores the
      // underscore form. Accept both and write ONE — otherwise the latch
      // faces a field it does not know and lets a rule through with no
      // author at all.
      if (Object.hasOwn(data, 'issued-by')) {
        const { 'issued-by': v, ...restFields } = data;
        data = { ...restFields, issued_by: data.issued_by ?? v };
      }
      // Same trap, same fix, one field later: `--on-class` arrives
      // hyphenated and the entry stores the underscore form. Without
      // this the trigger is written as `on-class`, `triggersOf` reads
      // `on_class`, and the procedure never fires — a rule that exists
      // and does nothing, which is the class it was probably written
      // against.
      if (Object.hasOwn(data, 'on-class')) {
        const { 'on-class': v, ...restFields } = data;
        data = { ...restFields, on_class: data.on_class ?? v };
      }
      // **An unknown trigger class is REFUSED, not warned about.**
      //
      // Everywhere else `mem log` writes and warns, because a write
      // that fails on a naming rule loses content. Here there is no
      // content to lose: a procedure whose trigger names a class that
      // does not exist is simply a procedure that never fires. It would
      // sit in the log looking armed. `procedure` is already the one
      // type with a hard gate, and this is the same reasoning one field
      // further.
      if (data.on_class) {
        const given = String(data.on_class).split(',').map((x) => x.trim()).filter(Boolean);
        const bad = given.filter((x) => !errorclass.normalise(x));
        if (bad.length) {
          die(`log procedure: --on-class names ${bad.length > 1 ? 'classes' : 'a class'} `
            + `that does not exist: ${bad.join(', ')}\n`
            + '  A trigger on an unknown class never fires, and the rule would look armed.\n'
            + `  Known: ${errorclass.NAMES.join(', ')}`);
        }
        // Stored normalised, so an old alias in the flag still fires.
        data.on_class = given.map((x) => errorclass.normalise(x)).join(',');
      }
      const pr = procedure.check(data);
      if (!pr.ok) {
        die(`log ${procedure.TYPE}:\n  ${pr.errors.join('\n  ')}\n\n`
          + '  mem log procedure --title "..." --rule "..." --issued-by owner');
      }
      data = procedure.complete(data, { agent: me });
      // E4: the status travels IN the entry. `released` only ever with a
      // human issuer (`procedure.check` above already refused any other).
      if (!startAs) startAs = procedure.isHuman(data.issued_by) ? 'released' : 'proposed';
      if (startAs === 'released' && !procedure.isHuman(data.issued_by)) startAs = 'proposed';
      data = { ...data, start_status: startAs };
    }

    // **Workflows: the same latch, before the write, for the same
    // reason.** A workflow's `steps` ARE an instruction exactly the way
    // a procedure's `rule` is — see `src/workflow.mjs`'s head comment.
    // The bridge does not write this type at all (bin/mem-mcp, the same
    // `if` that already refuses `procedure.TYPE`); here, where a human
    // CAN be at the keyboard, the same `issued_by`/`agent`/
    // `on_instruction` bookkeeping applies, reusing `procedure.complete`
    // unchanged rather than a second copy of it.
    if (type === workflow.TYPE) {
      const me = data.agent ?? memory.agentDefault();
      if (Object.hasOwn(data, 'issued-by')) {
        const { 'issued-by': v, ...restFields } = data;
        data = { ...restFields, issued_by: data.issued_by ?? v };
      }
      const wr = workflow.check(data);
      if (!wr.ok) {
        die(`log ${workflow.TYPE}:\n  ${wr.errors.join('\n  ')}\n\n`
          + '  mem log workflow --title "..." --steps "..." --issued-by owner');
      }
      data = workflow.complete(data, { agent: me });
    }

    // **A registry status has ONE write path** — `mem skills status`
    // (a human as author, an allowed transition). A status field slipped
    // in here would bypass that check (src/skillregistry.mjs).
    const statusRefused = skillregistry.statusFieldRefusal(type, data);
    if (statusRefused) die(statusRefused);

    // **Snippets: not an authority question, a redaction one.** Unlike
    // `procedure`/`workflow`, the MCP bridge MAY write this type — see
    // `bin/mem-mcp`. What stands here instead: a `text`/`mail`/`letter`
    // snippet whose body still holds something the redaction check
    // catches is not written at all. This is the one check shared
    // between the CLI and the bridge (`src/snippet.mjs`'s `check()`),
    // so there is exactly one place the rule can drift.
    if (type === snippet.TYPE) {
      const sr = snippet.check(data);
      if (!sr.ok) {
        die(`log ${snippet.TYPE}:\n  ${sr.errors.join('\n  ')}\n\n`
          + '  mem log snippet --title "..." --kind text --body "..."');
      }
      data = snippet.complete(data);
    }

    // A question without text is not one. Warnings stay warnings: a
    // question gets noted in passing or not at all, and aborting over a
    // missing question mark is formalism.
    if (type === question.TYPE) {
      const qr = question.check(data);
      if (!qr.ok) die(`log ${question.TYPE}:\n  ${qr.errors.join('\n  ')}`);
      for (const w of qr.warnings) warn(w);
    }

    // **What already stands about this subject — BEFORE the write.**
    //
    // The original brief said "conflict at write time instead of read
    // time". Measured against the corpus, the obvious rule (same topic,
    // different choice = conflict) would have been wrong five times out
    // of five. So no verdict, only the neighbours — and the commands
    // that resolve the case. See src/neighbours.mjs.
    const around = neighbours.neighbours(root, type, data, { project: args.project ?? null });
    // G1b: no topic to find neighbours by -> the lexically closest
    // decisions instead (a note, never a verdict; src/neighbours.mjs).
    const alike = neighbours.similarDecisions(root, type, data, { project: args.project ?? null });

    // O1: content, the redaction self test and the redaction in ONE
    // function, the same one mem_log over the bridge uses. Until then
    // this path wrote a secret pattern to disk unredacted and leaned on
    // the commit scan.
    const { path: p, entry, findings, askedAsDropped } = memory.logCheckedEntry(root, type, data, { project: args.project ?? null });
    out(`Appended: ${path.relative(root, p)}:${countLines(p)}`);
    if (findings.length) warn(memory.findingsLine(findings));
    { const w = expand.droppedLine(askedAsDropped); if (w) warn(w); }
    out(`  id: ${entry.id}`);
    out(`  ts: ${entry.ts}`);
    for (const l of neighbours.hint(around)) out(l);
    for (const l of neighbours.similarHint(alike, { newId: entry.id })) out(l);
    // Category proposal (DIGEST.md, section "Category"): the entry itself stays as it is, the
    // proposal is its own line (status proposal). Code rejects categories that do not exist and
    // decides on creating a new one by the rule in src/categories.mjs.
    if ((args.category !== undefined || args['category-new'] !== undefined)
      && typeof data.topic === 'string' && data.topic.trim()) {
      try {
        const wish = { topic: data.topic.trim(), source: categories.writerSource(process.env.MEM_HEADLESS) };
        if (typeof args.category === 'string') wish.category = args.category;
        if (typeof args['category-new'] === 'string') {
          const [k, ...l] = args['category-new'].split('|');
          wish.fresh = l.length ? { key: k, label: l.join('|') } : { key: categories.keyOf(k), label: k };
        }
        const r = categories.decide(root, [wish], { write: true });
        for (const c of r.created) out(`  category created: ${c.key} (${c.label}), ${c.topics.length} topics`);
        for (const a of r.assigned) out(`  category proposal: ${a.topic} -> ${a.category}`);
        for (const w of r.waiting) out(`  category wish '${w.key}' noted (${w.topics} of ${categories.CREATE_THRESHOLD} topics)`);
        for (const x of r.rejected) if (x.reason !== 'already-assigned') warn(`category rejected (${x.reason}): mem category list shows the valid ones.`);
      } catch (e) { warn(`category not noted: ${e.message}`); }
    }
    // L2a port: learning <- error. With --from: edges; without: up to
    // three fitting errors as a note with the ready command.
    if (type === 'learning') {
      try {
        if (fromErrors.length) {
          const k = errorfixes.writeGeneralizes(root, entry.id, fromErrors, { project: args.project ?? null });
          out(`  generalizes: ${k.written.join(', ') || '(nothing new)'} — link(s) from ${entry.id}`);
        } else {
          for (const l of errorfixes.noteForLearning(root, entry, { newId: entry.id })) out(l);
        }
      } catch (e) { warn(`learning link: ${e.message}`); }
    }
    if (startAs) {
      out(startAs === 'released'
        ? `  status: ${startAs} (issued by ${entry.issued_by})`
        : `  status: ${startAs} (not a rule in force until a human releases it)`);
    }

    // **L4 (BAUPLAN-mem-admin_02.md, Block F, ported as F4): `asked`
    // is missing almost always, because so far only the digest writes
    // it.** See `memory.needsAskedHint()` for which types are exempt
    // and why. No compulsion — the entry is written either way.
    if (memory.needsAskedHint(type, data)) {
      warn('without --asked: only findable through the words in title/text/... '
        + "(see `mem doctor`: repetition's sibling finding does not cover this — "
        + 'this is a plain reminder, not a measured check).');
    }

    // **F1 (BAUPLAN-mem-admin_02.md, Block F, ported as F4): the file,
    // not only the class.** Earlier errors for the same file, their
    // guards, open duties about it — shown once the entry exists, so a
    // repeat is visible the moment it is filed, not only later in
    // `mem doctor`.
    if (type === 'error') {
      for (const l of errorcontext.historyLines(root, entry, { project: args.project ?? null })) out(l);
      // L2a port: what already exists for this class/file — learnings,
      // procedures, fixes (src/errorfixes.mjs noteForError). Output only.
      try {
        for (const l of errorfixes.noteForError(root, entry)) out(l);
      } catch (e) { warn(`fix note: ${e.message}`); }
    }

    // **The class as a warning, not a label.**
    //
    // On 2026-09-07 one first-time install produced four defects; three
    // fell into classes the memory already held, one with the same root
    // cause in the sibling repository. Nobody asked, because asking is
    // a separate act. Here it asks itself, at the moment of logging.
    //
    // It interrupts nothing and demands nothing: whoever is filing an
    // error sees in passing that it is the fifth of its kind — and that
    // is a different message from "an error".
    if (type === 'error' && entry.class) {
      const seen = memory.sameClass(root, entry.class, { except: entry.id });
      if (seen.unreadable) {
        // Audit F04: an unreadable drawer is unknown, not "no hit".
        out('');
        out(`  Class '${seen.className}': UNKNOWN whether it happened before — ${seen.unreadable.length} drawer(s) not readable `
          + `(${seen.unreadable.map((u) => `${u.code}: ${u.path}`).join('; ')}); at least ${seen.count} so far.`);
      }
      if (seen.count > 0) {
        out('');
        out(`  Class '${seen.className}': this is number ${seen.count + 1}. Most recent:`);
        for (const h of seen.latest) {
          out(`    ${String(h.ts).slice(0, 10)}  ${String(h.id).padEnd(14)} ${String(h.title).slice(0, 70)}`);
        }
        if (seen.count + 1 >= 3) {
          out('    Three of a kind means the guard is missing, not the care.');
        }
      }
    }

    // **Parity build for lucky-mem's M12 (BAUPLAN-mem-admin_02.md §0
    // rule 2): the error brings its test scaffold with it.** With an
    // explicit `--file`, `test/error-<id>.test.mjs` lands right here —
    // marker, three sections, all `test.todo` with a reason. Empty
    // counts neither as a passing test nor as F4 evidence
    // (`probescaffold.isEmpty`, read by `memory.dutyHasEvidence`).
    // `--without-scaffold` turns it off. A failure here must never stop
    // the log itself.
    if (type === 'error' && !withoutScaffold) {
      try {
        const s = probescaffold.lay(root, entry);
        if (s.created) {
          out('');
          out(`  Test scaffold laid down: ${s.path} (// error: ${entry.id})`);
          out('    Sabotage / positive control / red on the old stand — still empty');
          out('    (todo), counts as evidence only once filled and `// scaffold: empty`');
          out('    is deleted.');
        } else if (s.path) {
          out(`  Test scaffold ${s.path}: ${s.why}.`);
        }
      } catch (e) {
        warn(`Test scaffold not laid down: ${e.message}`);
      }
    }

    // **The procedure that was written for exactly this class.**
    //
    // A rule that only surfaces when somebody remembers to run
    // `mem procedures` applies when it is least needed. The moment it
    // is actually wanted is this one: somebody is filing the failure it
    // was written for, and has just typed the class name.
    //
    // Cheap here in a way it is not elsewhere: matching by keyword
    // would be guessing, matching against twelve fixed names is a
    // lookup. The closed vocabulary pays a second time.
    if (type === 'error' && entry.class) {
      const armed = procedure.forClass(root, entry.class,
        { project: args.project && args.project !== 'global' ? args.project : null });
      if (armed.length) {
        out('');
        out(`  ${armed.length} procedure${armed.length === 1 ? '' : 's'} in force for this class:`);
        for (const p of armed) out(`    ${procedure.display(p)}`);
      }
    }

    // **F1 (BAUPLAN-mem-admin_02.md, Block F, ported as F4): on a real
    // repetition, a duty is not optional.** Same file + class within 30
    // days, or the same class three times within 7 — `mem log` creates
    // exactly one open duty per file+class, or appends this error's id
    // to the one that already exists. See `src/errorcontext.mjs` and
    // `src/repetition.mjs`.
    if (type === 'error') {
      const rep = errorcontext.checkAndDuty(root, entry, { project: args.project ?? null });
      if (rep.triggered) {
        out('');
        if (rep.created) {
          out(`  Repetition (${rep.reasons.join(', ')}) — opened duty ${rep.duty.id}: ${rep.duty.title}`);
        } else if (rep.appended) {
          out(`  Repetition (${rep.reasons.join(', ')}) — appended to existing duty ${rep.duty.id}`);
        } else if (rep.duty) {
          out(`  Repetition (${rep.reasons.join(', ')}) — already tracked under duty ${rep.duty.id}`);
        } else {
          out(`  Repetition (${rep.reasons.join(', ')}) — no duty (${rep.why}); see the class warning above.`);
        }
      }
    }

    // **The broadcast: the error goes to whoever it will hit.**
    //
    // The warning a few lines up is seen by whoever is logging RIGHT
    // NOW. Whoever the error hits next week never sees it — they would
    // have to go looking, and that is exactly what nobody does. 43 % of
    // classified errors recur, and every one of them was already
    // recorded.
    //
    // It sits in the log path DELIBERATELY, not behind its own command:
    // a broadcast you have to invoke becomes the same forgotten act as
    // looking things up. See src/broadcast.mjs for the two brakes
    // (literal, and paths only).
    if (type === 'error' && !args['no-broadcast'] && process.env.MEM_BROADCAST_OFF !== '1') {
      try {
        const b = broadcast.send(root, entry, { participants: cfg.participants });
        if (b.sent.length) {
          out('');
          out(`  Broadcast to ${b.sent.length}:`);
          for (const g of b.sent) out(`    ${g.agent}  (names ${g.trigger})`);
        }
        // Anyone without an inbox does NOT silently drop out. A
        // recipient it would have reached who never hears about it is
        // precisely the gap this is meant to close.
        if (b.withoutInbox.length) {
          warn(`Broadcast: ${b.withoutInbox.join(', ')} has no inbox — `
            + 'create one with `mem agent new <name>`, or nothing arrives.');
        }
        if (b.tooMany > 0) {
          warn(`Broadcast: ${b.tooMany} more affected not written to `
            + `(limit ${broadcast.MAX_RECIPIENTS}). That is a coordination problem, `
            + 'not a warning problem.');
        }
        // A failed delivery is not a skip. `send` catches it per
        // recipient so one broken inbox does not take the others down —
        // it still has to become visible, or logging reports success
        // while the warning is nowhere.
        for (const sk of b.skipped) {
          if (String(sk.why).startsWith('failed')) warn(`Broadcast to ${sk.agent} ${sk.why}`);
        }
      } catch (e) {
        // A broadcast must never prevent the log. But it must not fail
        // silently either.
        warn(`Broadcast failed: ${e.message}`);
      }
    }

    out('');
    out(`Delivered after:  git add . && git commit -m "log ${type}: ..." && git push`);
  },

  teach: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem teach [--project <name>] [--json]',
        '',
        '  What the memory has to say to a newcomer, in five sections.',
        '  Sorted by what the entries themselves give — no model call,',
        '  the same result twice.',
        '',
        '    Established  cited and uncontested',
        '    Tentative    concluded once, not yet cited',
        '    Contested    there is a contradicts link on it',
        '    Dead ends    an error with a learning on it',
        '    Corrections  what was retracted, and by what',
        '',
        '  This command COMPUTES NOTHING ITSELF. It renders what',
        '  memory.experiences() and memory.holds() already deliver. A',
        '  second derivation would eventually disagree with the first,',
        '  and whoever holds both could not say which one is lying.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['project', 'json', 'root'], 'teach');
    const root = findRoot(args);
    const teach = await import('../../teach.mjs');
    const r = teach.collect(root, {
      experiences: memory.experiences,
      readLog: memory.readLog,
      listProjects: memory.listProjects,
      holds: memory.holds,
      retiredMap: memory.retiredMap,
      TYPES: memory.TYPES,
      project: typeof args.project === 'string' ? args.project : null,
    });
    if (args.json) out(JSON.stringify(r, null, 2));
    else out(teach.asText(r));
  },

  correction: async ({ rest, args }) => {
    // No isHelp() guard existed at all: `mem correction --help` fell
    // straight into the missing-arguments check below and died with
    // "correction: which type?" — exit 1, no usage shown, for the one
    // flag that is supposed to never fail.
    if (isHelp(args)) {
      out([
        'mem correction <type> <old-id> [--project <name>] --<field> <value> [...]',
        '',
        '  Writes a NEW entry that supersedes <old-id>: the old one keeps',
        `  standing in the log, but memory.holds() no longer counts it.`,
        '  Same field rules as `mem log` (see `mem log --help`) — --tags,',
        '  --origin, --valid_from/--valid_until, the swallowed-value guard.',
        '',
        '  The new line INHERITS every content field of the old one (title, text,',
        '  tags, asked, ...): what you name overrides, what you leave out stays.',
        '  Name only what changes; the new line still stands complete.',
        '  --without <field>[,<field>]  deletes an inherited field explicitly.',
        '  Never inherited (administration): id, ts, replaces_id, agent, project,',
        '  state, authority, origin, valid_from, closes_id/retires_id/by_id and the',
        '  restore/merge markers. Not inherited either: from an encrypted entry',
        '  (warning) and in a closing correction (--state, --closes_id, --retires_id).',
        '  `mem doctor` still reports `correction-content-loss` (--without, cuts).',
        '',
        '  --authority <tier> stamps the correction (default: agent). A correction',
        '  the authority rule refuses is still written, warned about on stderr,',
        '  read as disputed, and the original keeps holding.',
        '',
        `  Types: ${Object.keys(memory.TYPES).join(', ')}`,
        '',
        'mem correction intended <old-id> <new-id> [--reason "..."]',
        '',
        '  Confirms a loss the correction-content-loss finding (`mem doctor`)',
        '  flagged on this exact pair was INTENTIONAL — a human decision,',
        '  never a rewrite: it appends one line to',
        '  global/correction-intent.jsonl and leaves the correction chain',
        '  untouched. Refused if the pair is not currently flagged, already',
        '  confirmed, or the writer is not a human (see `mem whoami` /',
        '  CHEAP_MEM_AGENT — an MCP-bridged agent cannot confirm).',
      ].join('\n'));
      return;
    }
    if (rest[0] === 'intended') {
      const oldId = rest[1];
      const newId = rest[2];
      if (!oldId || !newId) {
        die([
          'correction intended: old id and new id required.',
          '  mem correction intended <old-id> <new-id> [--reason "..."]',
        ].join('\n'));
      }
      checkFlags(args, ['reason', 'agent', 'project'], 'correction intended');
      const root = findRoot(args);
      requireConfig(root);
      // Same identity the procedure/workflow latch uses (see
      // src/procedure.mjs's isHuman doc comment): a human at a real
      // shell gets `human:<os user>` from memory.agentDefault(); an
      // MCP-bridged agent is stamped CHEAP_MEM_AGENT (bin/mem-mcp's
      // resolveAgent(), never agentDefault()) and so fails isHuman().
      const me = typeof args.agent === 'string' ? args.agent : memory.agentDefault();
      if (!procedure.isHuman(me)) {
        die(`correction intended: refused — '${me}' is not a human writer. Only 'owner' or `
          + "'human:<name>' may confirm a loss as intentional (allowed: owner, human:<name>); "
          + 'an agent cannot decide this for itself. Nothing was written.');
      }
      if (memory.isCorrectionIntentConfirmed(root, oldId, newId)) {
        die(`correction intended: ${oldId} -> ${newId} is already confirmed. Nothing was written.`);
      }
      let hits;
      try {
        hits = doctor.correctionLossHits(root).hits;
      } catch (e) {
        die(`correction intended: could not check the finding (${e.message})`);
      }
      const match = hits.find((h) => h.from === oldId && h.to === newId);
      if (!match) {
        die(`correction intended: ${oldId} -> ${newId} is not currently flagged by `
          + "'correction-content-loss' (mem doctor). Nothing was written.");
      }
      const reason = typeof args.reason === 'string' ? args.reason : '';
      const line = memory.confirmCorrectionIntent(root, oldId, newId, { reason, confirmedBy: me });
      out(`Confirmed as intentional: ${oldId} -> ${newId}`);
      out(`  by:     ${line.confirmed_by}`);
      if (line.reason) out(`  reason: ${line.reason}`);
      return;
    }
    const type = rest[0];
    const oldId = rest[1];
    if (!type) die("correction: which type?");
    if (!oldId) die("correction: old id missing");
    const root = findRoot(args);
    requireConfig(root);
    // Same rules as `mem log` — they used to be written out a second time
    // here and had already drifted: no JSON form, no guard against a
    // swallowed value.
    const data = fieldsFrom('correction', args, ['without']);
    if (args.without === true) die('correction: --without needs a field (e.g. --without why,tags).');
    const without = args.without === undefined ? []
      : String(args.without).split(',').map((x) => x.trim()).filter(Boolean);
    // Y4b: `--authority` is a field like any other here, but a checked
    // one — a name that is no tier would otherwise become `unknown` on
    // the write path without a word.
    if (Object.hasOwn(data, 'authority')) data.authority = authorityArg(args, 'correction');
    if (Object.hasOwn(data, 'valid_until')) {
      data.valid_until = dateFieldOf(data.valid_until, 'valid_until', 'correction');
    }
    if (Object.keys(data).length === 0 && without.length === 0) die("correction: no fields");
    const { path: p, entry, old, closing, findings, encrypted } = memory.correctionEntry(
      root, type, oldId, data, { project: args.project ?? null, without });
    out(`Correction: ${path.relative(root, p)}`);
    if (findings?.length) warn(memory.findingsLine(findings));
    if (encrypted) out('  encrypted:  yes (the corrected entry is crypto-shredding-encrypted)');
    out(`  new id:     ${entry.id}`);
    out(`  replaces:   ${entry.replaces_id}`);

    // P11 guard: warns, never blocks — a correction with content is
    // allowed through, but if it drops notable words of its predecessor
    // (Lucky's own quotes, rare content words) it warns on stderr so a
    // human/agent decides on purpose (see search.lostCorrectionContent,
    // case czorxreppel -> 1rjpook3vead). A closing correction (retiring/
    // closing) rightly carries no content of its own — exempt.
    if (!closing && process.env.MEM_CORRECTION_WARN_OFF !== '1') {
      try {
        const idx = search.buildIndex(root);
        const lost = search.lostCorrectionContent(old, entry, {
          docFreq: idx.docFreq,
          rareDf: Number(process.env.MEM_CORRECTION_RARE_DF) || search.RARE_DF,
        });
        if (lost.lost) {
          const parts = [
            ...lost.quotes.map((q) => `quote "${q}"`),
            ...lost.rareWords.map((w) => `word "${w}"`),
          ];
          warn(`Correction ${oldId} -> ${entry.id} loses notable ${parts.join(', ')} of its `
            + 'predecessor. Intentional (dropping something wrong), or an accident? '
            + 'See `mem doctor` (finding correction-content-loss).');
        }
      } catch (e) {
        // Not a hard failure: the guard warns, it does not block — a
        // broken index must not stop the correction itself.
        warn(`Could not check for content loss: ${e.message}`);
      }
    }
  },

  discard: async ({ rest, args }) => retireCmd('discarded', rest, args),
  done: async ({ rest, args }) => retireCmd('done', rest, args),

  // G1b: "<old> was superseded by <new>", said AFTER both were written.
  // Not discard (that says "wrong", and loses the old claim's history
  // under --as-of) and not correction (that writes a third entry). See
  // memory.supersedeEntry.
  supersede: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem supersede <old-id> --by <new-id> [--why "..."] [--type <type>] [--project <name>] [--authority <tier>]',
        '',
        '  Marks <old-id> as superseded by <new-id>, both already written, same drawer.',
        '  One appended line; the old entry stays readable, recall shows the new one,',
        '  and `--as-of` shows the old one up to the moment the new one started.',
        '  --authority stamps the line (default: agent); the strict replacement rule',
        '  applies — a refused line is written, warned about, and read as disputed.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['by', 'why', 'type', 'project', 'authority'], 'supersede');
    const tier = authorityArg(args, 'supersede');
    const root = findRoot(args);
    requireConfig(root);
    const id = rest[0];
    const by = args.by && args.by !== true ? String(args.by) : null;
    if (!id || !by) die('supersede: which ids? Example: mem supersede a1b2c3 --by d4e5f6');
    const loc = args.type
      ? { type: args.type, project: args.project ? (args.project === 'global' ? null : args.project) : null }
      : memory.findEntryLocation(root, id);
    if (!loc) die(`supersede: id '${id}' not found in any log.`);
    try {
      memory.supersedeEntry(root, loc.type, id, { by, why: args.why ?? null, project: loc.project, authority: tier });
    } catch (e) { die(`supersede: ${e.message}`); }
    out(`superseded: ${id} by ${by} (${loc.type}${loc.project ? `/${loc.project}` : ''})`);
  },

  // Bauplan P3: restore and merge, append-only (src/entryops.mjs).
  restore: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem restore <id> [--why "..."]',
        '',
        '  Takes a closed entry (done / discarded / obsolete) up again as a NEW',
        '  line carrying its content and `restored_from: <id>`. The original and',
        '  its tombstone stay exactly where they are. Refused when the entry is',
        '  not closed, is superseded by a correction (use the newer version),',
        '  or is already restored and still holds.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['why'], 'restore');
    const root = findRoot(args);
    requireConfig(root);
    if (!rest[0]) die('restore: which id? Example: mem restore a1b2c3 --why "still needed"');
    try {
      const r = entryops.restore(root, rest[0], { why: args.why ?? null });
      out(`restored: ${r.id} -> ${r.created} (${r.type}${r.project ? `/${r.project}` : ''}, was ${r.was})`);
    } catch (e) { die(`restore: ${e.message}`); }
  },
  merge: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem merge <id> <id> [<id> ...] [--title "..."] [--text "..."] [--why "..."]',
        '',
        '  Merges entries of ONE drawer: a correction of the first id carries the',
        '  joined content and `merged_from: [ids]`; every other id gets an',
        '  `obsolete` tombstone "merged into <new id>". Nothing is deleted or',
        '  rewritten; the originals stay readable. Max 20 ids. Refused across',
        '  drawers and for entries that no longer hold.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['title', 'text', 'why'], 'merge');
    const root = findRoot(args);
    requireConfig(root);
    if (rest.length < 2) die('merge: at least two ids. Example: mem merge a1b2c3 d4e5f6 --why "same fact"');
    try {
      const r = entryops.merge(root, rest, { title: args.title ?? null, text: args.text ?? null, why: args.why ?? null });
      out(`merged: ${r.ids.join(', ')} -> ${r.created} (${r.type}${r.project ? `/${r.project}` : ''}); tombstones: ${r.tombstones.join(', ')}`);
    } catch (e) { die(`merge: ${e.message}`); }
  },

  'error-fixes': async ({ rest, args }) => {
    if (isHelp(args) || rest[0] !== 'backfill') {
      out([
        'mem error-fixes backfill [--repo <path>] [--since <rev>] [--check-only]',
        '',
        '  Writes the missing `resolves` links (from a commit or a closed duty',
        '  to an error) out of the history — append-only and idempotent (key:',
        '  error id + evidence). Sources, evidence only:',
        '    - the commit trailer `Fixes: <error-id>[, <error-id>]` (git log --all)',
        '    - a commit message with a fix verb directly before the error id',
        '      ("fixes <id>"); a fix word elsewhere on the line is only counted',
        '    - closed duties with error_ids whose evidence holds for that id',
        '  An unknown id in a trailer is a warning, never a link.',
        '',
        '  --repo <path>   the git checkout to read (default: the memory root;',
        '                  fixes usually live in the code repository)',
        '  --since <rev>   only commits not reachable from <rev>',
        '  --check-only    counts, writes nothing',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['repo', 'since', 'check-only'], 'error-fixes backfill');
    const root = findRoot(args);
    requireConfig(root);
    if (args.since === true) die('error-fixes backfill: --since needs a revision.');
    if (args.repo === true) die('error-fixes backfill: --repo needs a path.');
    let r;
    try {
      r = errorfixes.backfill(root, {
        repo: args.repo ? path.resolve(String(args.repo)) : root,
        since: args.since ? String(args.since) : null,
        checkOnly: Boolean(args['check-only']),
      });
    } catch (e) { die(`error-fixes backfill: ${e.message}`); }
    for (const l of errorfixes.backfillLines(r)) out(l);
  },

  links: async ({ rest, args }) => {
    if (isHelp(args) || !rest[0]) {
      out([
        'mem links <id>',
        '',
        '  What this entry points at, and what points at it. Typed relations',
        `  (${Object.keys(memory.LINK_KINDS).join(', ')}) written by the digest`,
        '  while it sorts — walking them costs no model at all.',
        '',
        '  Log one by hand with:',
        '    mem log link --from <id> --to <id> --kind causes --why "..."',
      ].join('\n'));
      return;
    }
    checkFlags(args, [], 'links');
    const root = findRoot(args);
    requireConfig(root);
    const g = memory.linksOf(root, rest[0]);
    if (!g.entry) out(`(no entry with id ${g.id} — showing links anyway)`);
    else out(`${g.entry._type}  ${compactLine(g.entry)}`);
    if (g.out.length === 0 && g.incoming.length === 0 && g.dangling.length === 0) {
      out('');
      out('  no links yet.');
      return;
    }
    const line = (r, arrow) => {
      const what = r.entry ? `${r.entry._type}: ${compactLine(r.entry)}`
        : (memory.isOutsideEvidence(r.other) ? '(evidence outside the memory)' : '(missing entry)');
      out(`    ${arrow} ${String(r.kind).padEnd(12)} ${r.other}  ${what}`);
    };
    if (g.out.length) { out(''); out('  this entry ->'); for (const r of g.out) line(r, '->'); }
    if (g.incoming.length) { out(''); out('  -> this entry'); for (const r of g.incoming) line(r, '<-'); }
    if (g.dangling.length) {
      out('');
      out('  DANGLING (an edge into nothing — the target was never written):');
      for (const r of g.dangling) line(r, '!!');
    }
  },

  facts: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem facts [--stale] [--conflicts] [--key <k>] [--stale-days N]',
        '',
        '  Current value of every fact that changes over time — resolved from',
        '  the timeline log, newest valid_from per `key` wins, retired versions',
        '  dropped. No model, no network.',
        '',
        '  Log one with:  mem log timeline --key server.users --value 13 \\',
        '                   --valid_from 2026-07-13 --source "ops dashboard"',
        '',
        '  --stale       only facts not refreshed within --stale-days (default 120)',
        '  --conflicts   only facts with two versions that disagree on the same date',
        '  --key <k>     only this key',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['stale', 'conflicts', 'key', 'stale-days'], 'facts');
    const root = findRoot(args);
    requireConfig(root);
    const staleDays = numberFlag('stale-days', args['stale-days'], { fallback: 120, min: 0 });
    let facts = memory.currentFacts(root, { staleDays });
    if (args.key) facts = facts.filter((f) => f.key === args.key);
    if (args.stale) facts = facts.filter((f) => f.stale);
    if (args.conflicts) facts = facts.filter((f) => f.conflict);
    if (facts.length === 0) {
      out('No tracked facts.  Log one with a --key: mem log timeline --key <k> --value <v> --valid_from <date>');
      return;
    }
    const fresh = await import('../../freshness.mjs');
    out(`${facts.length} fact${facts.length === 1 ? '' : 's'}:`);
    for (const f of facts) {
      out('  ' + fresh.formatFact(f));
      for (const h of f.history) {
        const val = h.value ?? h.fact ?? h.text ?? '';
        const when = (h.valid_from ?? h.ts ?? '').slice(0, 10);
        out(`      was: ${val}  (${when})`);
      }
    }
  },

  experiences: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem experiences [--all] [--type learning]',
        '',
        '  What the memory is prepared to stand behind: learnings ranked by',
        '  how much of the rest of the memory leans on them — entries citing',
        '  them in origin.derived_from, and link edges pointing at them.',
        '',
        '  Strength is CITATION, not retrieval frequency: counting how often',
        '  something is looked up rewards popularity, not usefulness, and',
        '  would need per-machine telemetry that never travels with the repo.',
        '',
        '  A `contradicts` edge marks an experience [CONTESTED] — it is never',
        '  deleted or quietly weakened. An experience you cannot argue with',
        '  is a dogma.',
        '',
        '  --all    include uncited ones (a claim nothing leans on yet)',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['all', 'type'], 'experiences');
    const root = findRoot(args);
    requireConfig(root);
    const list = memory.experiences(root, {
      minCited: args.all ? 0 : 1,
      type: args.type ?? 'learning',
    });
    if (list.length === 0) {
      out(args.all ? 'No learnings yet.' : 'No backed experience yet.  --all shows unbacked claims too.');
      return;
    }
    out(`${list.length} ${args.all ? 'learning' : 'backed experience'}${list.length === 1 ? '' : 's'}:`);
    for (const e of list) {
      const mark = e.contested ? '  [CONTESTED]' : '';
      out(`  x${String(e.cited).padStart(2)}  ${e.id}  ${compactLine(e)}${mark}`);
      if (e.backedBy.length) out(`        backed by: ${e.backedBy.slice(0, 5).join(', ')}`);
    }
  },

  'topic-merge': async ({ rest, args }) => {
    if (isHelp(args) || rest.length < 1 || !args.to) {
      out([
        'mem topic-merge <old> [<old2> ...] --to <new> [--why "..."]',
        '',
        '  Fold two or more topics into one name.',
        '',
        '  NOTHING is rewritten. The merge is a new line in',
        '  global/topic-aliases.jsonl, applied on READ — whoever opens the',
        '  raw file still finds what stood there. That is precisely what',
        '  makes the memory trustworthy.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['to', 'why', 'agent'], 'topic-merge');
    const root = findRoot(args);
    requireConfig(root);
    const r = memory.mergeTopics(root, rest, args.to, { why: args.why ?? '', agent: args.agent ?? null });
    if (!r.written.length) { out('Nothing to do (source equals target).'); return; }
    out(`${r.written.length} merged into '${r.target}':`);
    for (const l of r.written) out(`  ${l.from}`);
    const q = memory.topicQuality(root);
    out(`\n  now ${q.topics} topics across ${q.areas} areas, ${q.entriesPerTopic} entries per topic`);
  },

  duties: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem duties [--project <name>|global] [--all]',
        'mem duties close <id> [--why "..."] [--state done|dropped] [--authority <tier>]',
        '',
        '  Duty is the only type with a lifecycle. Closing appends a',
        '  new line; the original is never touched.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (rest[0] === 'close') {
      checkFlags(args, ['why', 'state', 'project', 'authority'], 'duties close');
      const tier = authorityArg(args, 'duties close');
      const id = rest[1];
      if (!id) die('duties close: which id? (mem duties lists them)');
      const { entry } = memory.closeDuty(root, id, {
        state: args.state ?? memory.DUTY_STATE.DONE,
        why: args.why ?? null,
        project: args.project ?? null,
        authority: tier,
      });
      out(`Closed ${id} (${entry.state}). New line: ${entry.id}`);
      return;
    }

    checkFlags(args, ['project', 'all'], 'duties');
    const { open, done } = memory.openDuties(root,
      { project: args.project === undefined ? undefined : args.project });
    out(`${open.length} open, ${done.length} closed`);
    out('');
    for (const d of open) {
      out(`  [${d.id}] ${d.owner ? `@${d.owner} ` : ''}${d.title ?? d.text ?? '?'}`);
      out(`      since ${d.ts}  ${d._source}:${d._line}`);
    }
    if (args.all) {
      out('');
      for (const d of done) {
        out(`  [done] ${d.title ?? d.text ?? '?'}  (${d._closed.state}, ${d._closed.ts})`);
      }
    }
  },

};

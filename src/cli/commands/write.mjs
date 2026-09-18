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
import * as guard from '../../guard.mjs';
import * as broadcast from '../../broadcast.mjs';
import * as procedure from '../../procedure.mjs';
import * as question from '../../question.mjs';
import * as neighbours from '../../neighbours.mjs';
import * as errorclass from '../../errorclass.mjs';
import { out, die, warn, checkFlags, isHelp, fieldsFrom, findRoot, requireConfig } from '../shell.mjs';
import { dateFieldOf, compactLine, countLines, retireCmd } from '../display.mjs';

/** 10 commands. */
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
    Object.assign(data, fieldsFrom('log', args));

    // `valid_until` is refused, not silently accepted, if it cannot be
    // read as a date — see `dateFieldOf`. `valid_from` had this exact
    // gap already and keeps it here: that is a separate, pre-existing
    // defect, named rather than fixed in passing, so it stays visible
    // instead of disappearing into an unrelated change.
    if (Object.hasOwn(data, 'valid_until')) {
      data.valid_until = dateFieldOf(data.valid_until, 'valid_until', 'log');
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
    if (type === procedure.TYPE) {
      const me = data.agent ?? memory.agentDefault();
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

    const { path: p, entry } = memory.logEntry(root, type, data, { project: args.project ?? null });
    out(`Appended: ${path.relative(root, p)}:${countLines(p)}`);
    out(`  id: ${entry.id}`);
    out(`  ts: ${entry.ts}`);
    for (const l of neighbours.hint(around)) out(l);

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
    const type = rest[0];
    const oldId = rest[1];
    if (!type) die("correction: which type?");
    if (!oldId) die("correction: old id missing");
    const root = findRoot(args);
    requireConfig(root);
    // Same rules as `mem log` — they used to be written out a second time
    // here and had already drifted: no JSON form, no guard against a
    // swallowed value.
    const data = fieldsFrom('correction', args);
    if (Object.hasOwn(data, 'valid_until')) {
      data.valid_until = dateFieldOf(data.valid_until, 'valid_until', 'correction');
    }
    if (Object.keys(data).length === 0) die("correction: no fields");
    const { path: p, entry } = memory.correctionEntry(
      root, type, oldId, data, { project: args.project ?? null });
    out(`Correction: ${path.relative(root, p)}`);
    out(`  new id:     ${entry.id}`);
    out(`  replaces:   ${entry.replaces_id}`);
  },

  discard: async ({ rest, args }) => retireCmd('discarded', rest, args),
  done: async ({ rest, args }) => retireCmd('done', rest, args),

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
      const what = r.entry ? `${r.entry._type}: ${compactLine(r.entry)}` : '(missing entry)';
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
    const staleDays = args['stale-days'] ? Number(args['stale-days']) : 120;
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
        'mem duties close <id> [--why "..."] [--state done|dropped]',
        '',
        '  Duty is the only type with a lifecycle. Closing appends a',
        '  new line; the original is never touched.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (rest[0] === 'close') {
      checkFlags(args, ['why', 'state', 'project'], 'duties close');
      const id = rest[1];
      if (!id) die('duties close: which id? (mem duties lists them)');
      const { entry } = memory.closeDuty(root, id, {
        state: args.state ?? memory.DUTY_STATE.DONE,
        why: args.why ?? null,
        project: args.project ?? null,
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

/**
 * Several agents sharing one memory: mail, duties, questions, identity.
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
import fs from 'node:fs';
import * as memory from '../../memory.mjs';
import * as agents from '../../agents.mjs';
import * as inbox from '../../inbox.mjs';
import * as heartbeat from '../../heartbeat.mjs';
import * as broadcast from '../../broadcast.mjs';
import * as procedure from '../../procedure.mjs';
import * as question from '../../question.mjs';
import * as onboarding from '../../onboarding.mjs';
import * as errorclass from '../../errorclass.mjs';
import * as board from '../../board.mjs';
import { out, die, warn, checkFlags, isHelp, findRoot, readStdin, requireConfig, whoAmIOrDie, receiptHint, showOnboarding } from '../shell.mjs';
import { countLines } from '../display.mjs';

/** 12 commands. */
export const COMMANDS = {
  inbox: async ({ rest, args }) => {
    const sub = rest[0] ?? 'new';
    const root = findRoot(args);
    const cfg = requireConfig(root);

    if (sub === 'write') {
      checkFlags(args, ['as', 'to', 'subject', 'text'], 'inbox write');
      const from = whoAmIOrDie(root, args, cfg);
      if (!args.to) die("Missing --to");
      if (!args.subject) die("Missing --subject");
      const text = args.text ?? await readStdin();
      if (!text.trim()) die("Empty text (neither --text nor stdin)");
      const { path: p } = inbox.write(root, cfg.participants, {
        from, to: args.to, subject: args.subject, text,
      });
      out(`Written: ${path.relative(root, p)}`);
      out('');
      out(`Delivered only after:  git add . && git commit -m "inbox: ${args.subject}" && git push`);
      return;
    }

    if (sub === 'all') {
      checkFlags(args, ['as'], 'inbox all');
      const to = whoAmIOrDie(root, args, cfg);
      const { dir, messages } = inbox.read(root, cfg.participants, { to });
      if (dir === null) { out(`No inbox dir yet under ${inbox.INBOX_DIR}.`); return; }
      if (messages.length === 0) { out(`Empty inbox for '${to}'.`); return; }
      out(`${messages.length} messages for '${to}':`);
      for (const m of messages) {
        out(`  [${m.state}] ${m.name}`);
        out(`         ${m.subject} (from ${m.from})`);
      }
      receiptHint(messages);
      return;
    }

    if (sub === 'new') {
      checkFlags(args, ['as', 'no-mark'], 'inbox new');
      const to = whoAmIOrDie(root, args, cfg);
      const { new: fresh, known } = inbox.newFor(root, cfg.participants, { to });
      if (fresh.length === 0) {
        out(`Nothing new for '${to}'. ${known} known.`);
        return;
      }
      out(`${fresh.length} new for '${to}': (${known} known)`);
      for (const m of fresh) {
        out(`  [${m.state}] ${m.name}`);
        out(`         ${m.subject} (from ${m.from})`);
      }
      if (!args['no-mark']) {
        inbox.markSeen(root, { to, names: fresh.map((m) => m.name) });
      }
      receiptHint(fresh);
      return;
    }

    if (sub === 'show') {
      checkFlags(args, ['as'], 'inbox show');
      const to = whoAmIOrDie(root, args, cfg);
      const name = rest[1];
      if (!name) die("Missing name (inbox show <name>)");
      const p = path.join(inbox.inboxDir(root), name);
      if (!fs.existsSync(p)) die(`'${name}' is not in the inbox`);
      const content = fs.readFileSync(p, 'utf8');
      const m = inbox.parse(content);
      if (m.to !== to) out(`(Warning: this message is to '${m.to}', not '${to}')`);
      process.stdout.write(content);
      return;
    }

    if (sub === 'ack') {
      checkFlags(args, [], 'inbox ack');
      const name = rest[1];
      const newState = rest[2] ?? 'replied';
      if (!name) die("Missing name (inbox ack <name> [state])");
      const m = inbox.setState(root, cfg.participants, name, newState);
      out(`${name}: state -> ${m.state}`);
      return;
    }

    if (sub === 'watch') {
      checkFlags(args, ['as', 'branch', 'remote', 'skip-fetch'], 'inbox watch');
      const to = args.as ?? inbox.whoAmI(root);
      if (!to) die([
        "Missing --as and no default set.",
        "  Once: mem whoami <name>",
        "  Or:   mem inbox watch --as <name>",
      ].join('\n'));
      const r = inbox.watch(root, cfg.participants, {
        to,
        branch: args.branch ?? cfg.defaultBranch,
        remote: args.remote ?? cfg.defaultRemote,
        skipFetch: Boolean(args['skip-fetch']),
      });
      if (r.status === 'broken') {
        process.stderr.write(`broken: ${r.reason} — ${r.detail}\n`);
        process.exit(3);
      }
      for (const u of (r.unreadable ?? [])) {
        process.stderr.write(`unreadable name in inbox: ${u}\n`);
      }
      if (r.status === 'nothing') {
        out(`nothing new for '${to}' (${r.known} known)`);
        process.exit(0);
      }
      out(`${r.new.length} new for '${to}':`);
      for (const n of r.new) out(`  ${n}`);
      process.exit(1);
    }

    die([
      `inbox: unknown subcommand '${sub}'`,
      'Known: new (default), all, write, show, ack, watch',
    ].join('\n'));
  },

  broadcast: async ({ rest, args }) => {
    if (isHelp(args) || !rest.length) {
      out([
        'mem broadcast <error-id> [--dry-run]',
        '',
        '  Sends a recorded error to the agents who touched the same file.',
        '  Runs by itself on `mem log error`; this command is for older',
        '  entries and for looking before leaping.',
        '',
        '  --dry-run: only say who would get it. Writes nothing.',
        '',
        '  The trigger is a PATH, matched literally. If the error names',
        '  none, nothing goes out — deliberately: a warning that fires at',
        '  everybody on every error is noise after the third one.',
        '',
        '  A recipient is somebody who demonstrably touched the file: an',
        '  entry of their own names the path AND carries an agent field.',
        '  The evidence is in the note. Without origin stamping the',
        '  broadcast finds nobody — that is the limit, not a fault.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    const cfg = requireConfig(root);
    checkFlags(args, ['dry-run', 'root'], 'broadcast');
    const id = rest[0];
    const entry = memory.entriesById(root).get(id);
    if (!entry) die(`broadcast: no entry with id '${id}'.`);
    const r = broadcast.send(root, entry, {
      participants: cfg.participants, dryRun: Boolean(args['dry-run']),
    });
    if (!r.triggers.length) {
      out('No path in the entry — no trigger, no broadcast.');
      return;
    }
    out(`Trigger: ${r.triggers.join(', ')}`);
    if (!r.sent.length && !r.skipped.length) {
      out('Nobody has demonstrably touched these files.');
      if (r.withoutInbox.length) out(`  (without an inbox: ${r.withoutInbox.join(', ')})`);
      return;
    }
    for (const g of r.sent) {
      out(`  ${args['dry-run'] ? 'would go to' : 'sent to'} ${g.agent}`
        + `  — evidence ${g.source}${g.line ? `:${g.line}` : ''}`);
    }
    for (const sk of r.skipped) out(`  skipped ${sk.agent}: ${sk.why}`);
    if (r.withoutInbox.length) out(`  without an inbox (nothing arrives): ${r.withoutInbox.join(', ')}`);
  },

  questions: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem questions                    [--all] [--project <name>]',
        'mem questions new "<text>"       [--why "..."] [--topic ...]',
        '',
        '  What we do NOT know. Without a subcommand: only the open ones.',
        '',
        '  Until 2026-09-08 this memory could only hold what was KNOWN:',
        '  decisions, errors, learnings, duties. An open question fit in',
        '  none of the drawers — and what has no drawer does not get',
        '  written down.',
        '',
        '  Why not a `duty`: a duty has a debtor and counts as neglected',
        '  when it sits. A question has no owner and may stay open for',
        '  years without anybody being at fault.',
        '',
        '  It is closed by the entry that answers it:',
        '    mem answer <question-id> --with <entry-id>',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (rest[0] === 'new') {
      checkFlags(args, ['why', 'topic', 'project', 'tags', 'root'], 'questions new');
      const text = rest.slice(1).join(' ').trim();
      const qr = question.check({ question: text });
      if (!qr.ok) die(`questions new:\n  ${qr.errors.join('\n  ')}`);
      for (const w of qr.warnings) warn(w);
      const data = { question: text };
      for (const k of ['why', 'topic']) if (args[k] && args[k] !== true) data[k] = String(args[k]);
      if (args.tags && args.tags !== true) {
        data.tags = String(args.tags).split(',').map((x) => x.trim()).filter(Boolean);
      }
      const { path: p, entry } = memory.logEntry(root, question.TYPE, data,
        { project: args.project ?? null });
      out(`Appended: ${path.relative(root, p)}:${countLines(p)}`);
      out(`  id: ${entry.id}`);
      out('  open, until an entry resolves it.');
      return;
    }
    if (rest.length) {
      die(`questions: '${rest[0]}' is not a subcommand. Known: new. `
        + 'Without one, the open questions are shown.');
    }
    checkFlags(args, ['all', 'project', 'root'], 'questions');
    const project = args.project ? (args.project === 'global' ? null : args.project) : undefined;
    const list = args.all ? question.all(root, { project }) : question.open(root, { project });
    if (!list.length) {
      out(args.all ? 'No questions noted yet.'
        : 'No open questions. (--all also shows the answered ones.)');
      return;
    }
    for (const q of list) {
      out(`  ${question.line(q)}`);
      if (q.why) out(`                 because ${String(q.why).slice(0, 90)}`);
    }
    out('');
    out(`${list.length} question(s), ${list.filter((q) => q.open).length} open.`);
  },

  answer: async ({ rest, args }) => {
    if (isHelp(args) || !rest.length) {
      out([
        'mem answer <question-id> --with <entry-id> [--why "..."]',
        '',
        '  Closes a question — by naming the entry that answers it.',
        '  Writes a `resolves` link, nothing else.',
        '',
        '  No lifecycle of its own on the question: a second mechanism',
        '  would say the same thing twice, and two truths about one state',
        '  drift apart.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);
    checkFlags(args, ['with', 'why', 'project', 'root'], 'answer');
    const qid = rest[0];
    const withId = args.with && args.with !== true ? String(args.with) : null;
    if (!withId) die('answer: --with <entry-id> missing. A question does not close by itself.');
    const byId = memory.entriesById(root);
    const q = byId.get(qid);
    if (!q) die(`answer: no entry with id '${qid}'.`);
    if (!q.question) die(`answer: '${qid}' is not an entry of type question.`);
    // A link into the void looks like an answer and is not one.
    if (!byId.get(withId)) die(`answer: no entry with id '${withId}'. Log it first, then link.`);
    const { entry } = memory.logEntry(root, 'link', {
      from: withId, to: qid, kind: question.RESOLVES,
      why: args.why && args.why !== true ? String(args.why) : undefined,
    }, { project: args.project ?? null });
    out(`${withId} resolves ${qid}  (link ${entry.id})`);
  },

  procedures: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem procedures [--project <name>]',
        'mem procedures --match "<text>" [--project <name>]',
        '',
        '  The procedures in force — "this is how we do it here".',
        '',
        '  Create one (CLI only, human author only):',
        '    mem log procedure --title "..." --rule "..." --issued-by owner',
        '                       [--on-class <name>] [--triggers "word,phrase"]',
        '',
        '  Two independent lanes arm a procedure: --on-class (fixed error',
        '  vocabulary, offered from `mem log error`) and --triggers (literal',
        '  keywords, offered here with --match). Neither uses a use-count —',
        '  matches are ordered by authority then recency only, so the same',
        '  files always offer the same order.',
        '',
        '  A procedure is NOT a skill. A capability is acquired, a rule',
        '  is issued — and because its text is instruction-shaped, every',
        '  display carries the prefix "issued by X on Y". Without it the',
        '  next reader launders it into a fact.',
        '',
        '  The MCP bridge does not write this type at all: a norm for all',
        '  agents cannot come from one of them.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);
    checkFlags(args, ['project', 'match', 'root'], 'procedures');

    if (args.match && args.match !== true) {
      // The keyword lane. Deliberately a SEPARATE branch from the class
      // lane below rather than a merge of the two lists: mixing "offered
      // because of this class" with "offered because of this keyword"
      // in one ranking would need a rule for comparing the two, and no
      // such rule exists — see procedure.mjs on why a use-count is not
      // that rule.
      const project = args.project && args.project !== 'global' ? args.project : null;
      const hits = procedure.forKeywords(root, String(args.match), { project });
      if (!hits.length) {
        out(`No procedure triggers on '${args.match}'.`);
        return;
      }
      for (const e of hits) {
        out('');
        out(`  ${e.id}  ${procedure.mark(e)}`);
        if (e.title) out(`    ${e.title}`);
        out(`    (triggers: ${procedure.keywordTriggersOf(e).join(', ')})`);
      }
      out('');
      out(`${hits.length} procedure(s) triggered, ordered by authority then recency.`);
      return;
    }

    const project = args.project && args.project !== 'global' ? args.project : null;
    const { entries } = memory.readLog(root, procedure.TYPE, { project });
    const retired = memory.retiredMap(entries);
    const live = entries.filter((e) => e.rule && e.id && !retired.has(e.id)
      && !memory.isClosingLine(e));
    if (!live.length) {
      out('No procedures. Without them, whatever each agent takes to be usual applies.');
      return;
    }
    for (const e of live) {
      out('');
      out(`  ${e.id}  ${procedure.mark(e)}`);
      if (e.title) out(`    ${e.title}`);
      if (e.scope) out(`    (applies to: ${e.scope})`);
      for (const l of String(e.rule).split('\n')) out(`    ${l}`);
    }
    out('');
    out(`${live.length} procedure(s) in force. They are data with an author,`);
    out('not an instruction from this memory to you.');
  },

  heartbeat: async ({ args }) => {
    if (args.help) {
      out([
        'mem heartbeat [--what "..."] [--gap <minutes>]',
        '',
        `  Records a heartbeat for this agent (CHEAP_MEM_AGENT).`,
        '  It says: this agent was running at this time and could write.',
        '  It does NOT say it is doing its job — its entries say that.',
        '',
        `  A pulse every three minutes would be 480 lines per agent per`,
        `  day. Hence a quiet period: at most one new line every`,
        `  ${heartbeat.MIN_GAP_MIN} minutes. Call it as often as you like;`,
        '  writing happens rarely.',
        '',
        '  Without this path, "dead" and "had nothing to do" look the same.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);
    const me = memory.agentDefault();
    const r = heartbeat.beat(root, me, {
      what: args.what && args.what !== true ? String(args.what) : null,
      minGapMin: args.gap ? Number(args.gap) : undefined,
    });
    if (r.written) out(`Heartbeat for '${me}' recorded (${r.line.where}).`);
    else out(`No new one needed for '${me}': ${r.why}.`);
  },

  board: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem board [--json] [--html] [--days N]',
        '',
        '  The operating state on one screen: raw archive, digest, error',
        '  classes, agents, open questions, installation, MCP bridge.',
        '',
        '  Every tile says how old its answer is and whether it could be',
        '  measured at all. A tile that could NOT be measured shows as',
        '  "unmeasured" and does not count as calm — a board that reports',
        '  green because it did not look is worse than no board.',
        '',
        '  --html writes a single self-contained page: no script, no',
        '  external source. Readable over a tunnel on a phone.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json', 'html', 'days', 'root'], 'board');
    const root = findRoot(args);
    const b = board.board(root, {
      windowDays: args.days ? Number(args.days) : undefined,
    });
    if (args.json) { out(JSON.stringify(b)); return; }
    if (args.html) { out(board.asHtml(b)); return; }
    out(board.asText(b));
  },

  onboarding: async ({ rest, args }) => {
    if (isHelp(args) || !rest.length) {
      out([
        'mem onboarding <agent>',
        '',
        '  Five checks, each of them evidenced by something in the memory —',
        '  never by a tick. A tick you can set without having done the',
        '  thing is the configuration illusion in new clothes.',
        '',
        '  A connected foreign agent once had the log tool for a whole day',
        '  and used it not once. It was configured — inbox created, bridge',
        '  connected, tools visible — and still not connected. We noticed',
        '  after a day, by counting.',
        '',
        '  The last step proves the LOOP: the agent writes an entry itself',
        '  and finds it again. Exit 1 while anything is open.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    const cfg = requireConfig(root);
    checkFlags(args, ['root'], 'onboarding');
    const st = onboarding.status(root, rest[0], { participants: cfg.participants });
    showOnboarding(st);
    if (!st.done) process.exitCode = 1;
  },

  agents: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem agents',
        '',
        '  The agent board: who is registered, who appears in the memory,',
        '  and where the two diverge.',
        '',
        '  An agent WITH a folder but NO entries has never worked. An agent',
        '  WITH entries but NO folder writes into the memory without anyone',
        '  knowing its instructions — at multi-agent scale, the more',
        '  uncomfortable of the two gaps.',
      ].join('\n'));
      return;
    }
    checkFlags(args, [], 'agents');
    const root = findRoot(args);
    requireConfig(root);
    const list = agents.listAgents(root);
    const inLog = memory.agentsInLog(root);
    const withFolder = new Set(list.map((a) => a.name));
    const withEntries = new Map(inLog.map((a) => [a.agent, a]));

    if (!list.length && !inLog.length) {
      out('No agents yet.  Create one with: mem agent new <name> --role "..."');
      return;
    }
    out(`${list.length} registered, ${inLog.length} in the memory:`);
    for (const a of list) {
      const st = withEntries.get(a.name);
      const bits = [
        st ? `${String(st.count).padStart(4)} entries` : '   0 entries',
        st ? `last ${st.last.slice(0, 10)}` : 'never active',
      ];
      if (a.knowledge.length) bits.push(`${a.knowledge.length} knowledge`);
      if (a.skills.length) bits.push(`${a.skills.length} skills`);
      if (!a.active) bits.push('RETIRED');
      out(`  ${a.name.padEnd(20)} ${bits.join('  ')}`);
      if (a.role) out(`  ${' '.repeat(20)} ${a.role}`);
    }
    const noFolder = inLog.filter((a) => !withFolder.has(a.agent));
    if (noFolder.length) {
      out('\n  In the memory, but with no folder:');
      for (const a of noFolder) {
        out(`  ${a.agent.padEnd(20)} ${String(a.count).padStart(4)} entries  last ${a.last.slice(0, 10)}`);
      }
      out('  -> register with: mem agent new <name> --role "..."');
    }
  },

  agent: async ({ rest, args }) => {
    const subs = ['new', 'show'];
    if (isHelp(args) || !rest[0]) {
      out([
        'mem agent new <name> [--role "..."] [--model "..."] [--path <dir>]',
        'mem agent show <name>',
        '',
        '  An agent gets agents/<name>/ with AGENT.yaml, PROMPT.md,',
        '  knowledge/ and skills/. The memory stays shared — `agent` is an',
        '  address, not a fence.',
        '',
        '  --path points at a DIFFERENT folder, for enrolling an agent that',
        '  already grew somewhere else without moving it.',
      ].join('\n'));
      return;
    }
    const [what, name] = rest;
    if (!subs.includes(what)) die(`agent: '${what}' unknown. Known: ${subs.join(', ')}`);
    if (!name) die(`agent ${what}: name missing.`);
    const root = findRoot(args);
    requireConfig(root);

    if (what === 'new') {
      checkFlags(args, ['role', 'model', 'path'], 'agent new');
      const r = agents.createAgent(root, name, {
        role: args.role ?? '', model: args.model ?? '', path: args.path ?? null,
      });
      out(r.isNew ? `Created: ${r.home}` : `Already existed: ${r.home} (nothing overwritten)`);
      return;
    }

    checkFlags(args, [], 'agent show');
    const a = agents.readAgent(root, name);
    if (!a) die(`No agent '${name}'. See: mem agents`);
    const st = memory.agentState(root, name);
    out(`${a.name}${a.active ? '' : '  [RETIRED]'}`);
    if (a.role) out(`  Role     ${a.role}`);
    if (a.model) out(`  Model    ${a.model}`);
    out(`  Folder   ${a.content}${a.content === a.home ? '' : `  (registered in ${a.home})`}`);
    if (a.prompt) out(`  Prompt   ${a.prompt}`);
    if (a.knowledge.length) out(`  Knowledge ${a.knowledge.join(', ')}`);
    if (a.skills.length) out(`  Skills   ${a.skills.join(', ')}`);
    out(`\n  In the memory: ${st.count} entries`
      + `${st.retired ? ` (+${st.retired} retired)` : ''}`
      + `${st.last ? `, last ${st.last.slice(0, 10)}` : ''}`);
    if (st.count) {
      out(`  Drawers  ${Object.entries(st.types).map(([k, v]) => `${k}:${v}`).join(' ')}`);
      out(`  Projects ${Object.entries(st.projects).map(([k, v]) => `${k}:${v}`).join(' ')}`);
      if (st.topics.length) out(`  Topics   ${st.topics.join(', ')}`);
    }
  },

  whoami: async ({ rest, args }) => {
    checkFlags(args, [], 'whoami');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    const name = rest[0];
    if (!name) {
      const now = inbox.whoAmI(root);
      out(now ? `whoami: ${now}` : 'whoami: (not set)');
      return;
    }
    inbox.setWhoAmI(root, cfg.participants, name);
    out(`whoami: ${name} (saved to ${inbox.WHOAMI_FILE})`);
  },

  classes: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem classes [--open] [--json]',
        '',
        '  The twelve error classes, the question that decides each one,',
        '  and how much of this memory they actually cover.',
        '',
        '  --open lists the class names in the log that are NOT mapped.',
        '  That number is the point: it says how far the ranking above it',
        '  may be trusted.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['open', 'json', 'root'], 'classes');
    const root = findRoot(args);

    const all = [];
    for (const project of [null, ...memory.listProjects(root)]) {
      try { all.push(...memory.readLog(root, 'error', { project }).entries); }
      catch { /* log absent */ }
    }
    const c = errorclass.coverage(all);

    if (args.json) { out(JSON.stringify({ classes: errorclass.CLASSES, ...c })); return; }

    if (args.open) {
      if (!c.openNames.length) { out('Every class name in the log is mapped.'); return; }
      out(`${c.open} entries in ${c.openNames.length} unmapped names:`);
      for (const [name, n] of c.openNames) out(`  ${String(n).padStart(4)}x  ${name}`);
      out('');
      out('  Unmapped is not an error. It is the honest half: a mapping');
      out('  nobody checked would be a number nobody can stand behind.');
      return;
    }

    const counts = new Map(c.byClass);
    for (const name of errorclass.NAMES) {
      const n = counts.get(name) ?? 0;
      out(`  ${String(n).padStart(4)}x  ${name}`);
      out(`          ${errorclass.CLASSES[name].short}`);
      out(`          ? ${errorclass.CLASSES[name].question}`);
    }
    out('');
    if (!c.total) { out('No error entries yet — nothing to count.'); return; }
    out(`${c.mapped} of ${c.total} entries countable.`);
    if (c.open) out(`${c.open} in ${c.openNames.length} names not mapped — see them with: mem classes --open`);
  },

};

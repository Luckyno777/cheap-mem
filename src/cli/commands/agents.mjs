// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
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

import * as memory from '../../memory.mjs';
import * as agents from '../../agents.mjs';
import * as inbox from '../../inbox.mjs';
import * as envelope from '../../envelope.mjs';
import * as mailpermit from '../../mailpermit.mjs';
import * as routes from '../../routes.mjs';
import { isHuman } from '../../config.mjs';
import * as claim from '../../claim.mjs';
import * as heartbeat from '../../heartbeat.mjs';
import * as broadcast from '../../broadcast.mjs';
import * as procedure from '../../procedure.mjs';
import * as question from '../../question.mjs';
import * as onboarding from '../../onboarding.mjs';
import * as errorclass from '../../errorclass.mjs';
import * as repetitionhint from '../../repetitionhint.mjs';
import * as board from '../../board.mjs';
import * as appointmentCli from '../appointments.mjs';
import { out, die, warn, checkFlags, numberFlag, isHelp, findRoot, readStdin, requireConfig, whoAmIOrDie, receiptHint, showOnboarding } from '../shell.mjs';

/** Duplicates are shown, never dropped: same id sent twice, folded into the older message. */
function duplicateLines(duplicates) {
  for (const d of duplicates ?? []) {
    out(`  [duplicate, not delivered] ${d.name}`);
    out(`         same request id '${d.requestId}' as ${d.duplicateOf}`
      + `${d.sameText ? '' : ' - BUT DIFFERENT TEXT (id reused, check by hand)'}`);
  }
}
/**
 * Z3/A9: unreadable messages and unreadable state/claim lines, named at
 * EVERY listing. On stderr (warn), so a script reading stdout alone does
 * not silently see a healthy inbox, and a human still sees it. The exit
 * stays 0: healthy mail keeps being delivered.
 */
function brokenLines(broken, eventsBroken) {
  for (const b of broken ?? []) warn(`unreadable message in the inbox: ${b.name} (${b.reason})`);
  for (const b of eventsBroken ?? []) {
    warn(`unreadable line in ${b.log}${b.line ? `:${b.line}` : ''} (${b.reason}) — `
      + 'a state change or a claim may be missing from every count');
  }
}
import { countLines } from '../display.mjs';

/** No machine wakes the human: mail to them never waits for permission. */
function isHumanName(cfg, name) { return isHuman(cfg.participants?.[name]); }

/**
 * Block S "way 1": a session that picks up its mail registers its route
 * (once). Said on stderr, so the listing on stdout stays as it was.
 */
function routeOnPickup(root, role) {
  const r = routes.registerOnPickup(root, { role });
  if (r.fresh) {
    warn(`route registered: ${r.route.alias} (${r.route.routeId}) — your messages carry From-Route `
      + `from now on, and replies come back to this session (commit ${routes.FILE} with your next push)`);
  }
  return r.route ?? null;
}

/** 12 commands. */
export const COMMANDS = {
  inbox: async ({ rest, args }) => {
    // There was no isHelp() guard here at all. `sub = rest[0] ?? 'new'`
    // ran first no matter what, so `mem inbox --help` fell straight
    // into the `new` branch: without a stored `whoami` it died with
    // "Who is this install in the channel?" (exit 1), and WITH one it
    // printed the actual inbox contents (exit 0) — never help, either
    // way.
    if (isHelp(args)) {
      out([
        'mem inbox new        [--as N]              what is new for me',
        'mem inbox all        [--as N]              all messages to me',
        'mem inbox write      [--as N] --to N --subject "..." [--request-id ID] [< text.md]',
        '                     with an id, the same send twice is ONE message (replay);',
        '                     the same id with other text is refused (exit 1)',
        '                     --in-reply-to <name>: the message this answers (checked)',
        '                     --intent information|request|read|result|clarification|cancel',
        '                       (default: information; with --in-reply-to: result).',
        '                       request/read/clarification wake the recipient only with the',
        '                       user\'s permission or a budget; the rest never wake anyone.',
        '                     --to-route <id>: one registered session of that role',
        'mem inbox show <name> [--as N]',
        'mem inbox ack <name> [state] [--expected S] [--reason "..."]',
        '                     state -> replied (default), as an event line in',
        '                     inbox/states.jsonl; reopening needs --reason',
        'mem inbox watch      [--as N] [--branch main] [--remote origin] [--skip-fetch]',
        '                     exit 0/1/3, for shell pollers; 1 only for mail that may wake',
        'mem inbox wake       [--as N] [--dry-run]   after the pull: which unseen mail may wake',
        '                     a model now; charges grants/budgets once. exit 1 = run handler',
        'mem inbox allow      --letters N | --tokens N [--until DATE] [--to N] --authority user [--json]',
        '                     a budget for waking messages (user only, append-only ledger)',
        'mem inbox permit <name> --authority user [--json]   permit one waking message (user only)',
        'mem inbox permissions                       budgets, grants, messages waiting',
        'mem inbox routes                            registered sessions per role',
        'mem inbox claim <name> [--as N] [--minutes 30]   take a message, with an expiry',
        'mem inbox renew <name> --claim-id ID [--as N] [--minutes 30]  still working: new deadline (holder, before expiry, capped)',
        'mem inbox done <name> --claim-id ID [--as N]     finished (holder only, with the id claim printed)',
        'mem inbox failed <name> --claim-id ID --reason "..." [--as N]  gave up, released at once',
        'mem inbox claims <name>                          who holds it, who does not count',
        '                     git is not a lock: two hosts can both claim; the read',
        '                     rule picks one and the other one stays visible.',
        '',
        '  Without a subcommand: same as `inbox new`.',
        '  --as picks who this call speaks as; without it, the stored `mem whoami`.',
      ].join('\n'));
      return;
    }
    const sub = rest[0] ?? 'new';
    const root = findRoot(args);
    const cfg = requireConfig(root);

    if (sub === 'write') {
      checkFlags(args, ['as', 'to', 'subject', 'text', 'request-id', 'in-reply-to', 'intent', 'to-route'], 'inbox write');
      const from = whoAmIOrDie(root, args, cfg);
      if (!args.to) die("Missing --to");
      if (!args.subject) die("Missing --subject");
      // Block S: the intent decides whether this message may wake anyone.
      let intent = null;
      if (args.intent !== undefined) {
        intent = String(args.intent === true ? '' : args.intent).trim().toLowerCase();
        if (!envelope.INTENTS.includes(intent)) die(`--intent is one of ${envelope.INTENTS.join('|')}, not '${args.intent}'`);
      }
      const text = args.text ?? await readStdin();
      if (!text.trim()) die("Empty text (neither --text nor stdin)");
      let res;
      try {
        res = inbox.write(root, cfg.participants, {
          from, to: args.to, subject: args.subject, text, requestId: args['request-id'] ?? null,
          // Z3/A7: the stable reference to the message answered.
          inReplyTo: typeof args['in-reply-to'] === 'string' ? args['in-reply-to'] : null,
          intent,
          toRoute: typeof args['to-route'] === 'string' ? args['to-route'] : null,
        });
      } catch (e) {
        if (e.code === 'REQUEST_CONFLICT') die(e.message);
        if (/In-Reply-To|No message|To-Route|Intent/.test(e.message)) die(e.message);
        throw e;
      }
      if (res.replay) {
        out(`Already sent (replay of request id '${args['request-id']}'): ${res.name}`);
        out('Nothing written.');
        return;
      }
      const { path: p } = res;
      out(`Written: ${memory.asSource(root, p)}`);
      // O1: the redaction runs in inbox.write(); it is SAID here, as on the bridge.
      if (res.findings?.length) warn(memory.findingsLine(res.findings));
      // Block S: say whether this message WILL wake anyone — otherwise an
      // agent waits for an answer that nobody is ever started for.
      try {
        const m = { name: res.name, ...inbox.parse(inbox.readMessage(root, res.name)) };
        const d = envelope.wakes(m, { permit: mailpermit.checker(root), human: (n) => isHumanName(cfg, n) });
        if (d.reason === envelope.WAITING) {
          out(`Note: ${envelope.WAITING} — this message lies in the inbox but wakes nobody until the user`
            + ` permits it (mem inbox permit ${res.name} --authority user) or gives a budget (mem inbox allow).`);
        } else if (d.reason === 'turn-budget-spent') {
          out(`Note: turn ${m.turn} of ${m.turnMax} — the reply budget of this chain is spent; it wakes nobody.`);
        }
      } catch { /* a hint that fails must not fail the write */ }
      out('');
      out(`Delivered only after:  git add . && git commit -m "inbox: ${args.subject}" && git push`);
      return;
    }

    if (sub === 'all') {
      checkFlags(args, ['as'], 'inbox all');
      const to = whoAmIOrDie(root, args, cfg);
      routeOnPickup(root, to);
      const { dir, messages, duplicates, broken, eventsBroken } = inbox.read(root, cfg.participants, { to });
      if (dir === null) { out(`No inbox dir yet under ${inbox.INBOX_DIR}.`); return; }
      brokenLines(broken, eventsBroken);
      if (messages.length === 0) { out(`Empty inbox for '${to}'.`); return; }
      out(`${messages.length} messages for '${to}':`);
      for (const m of messages) {
        // Z3/A5: the effective state; where it comes from, if not the header.
        const source = m.stateSource === 'claim' ? ' (claim done)' : '';
        const held = m.claim?.status === 'claimed' ? `, claimed by ${m.claim.holder}` : '';
        out(`  [${m.state}${source}${held}] ${m.name}`);
        if (m.inReplyTo) out(`         in reply to ${m.inReplyTo}`);
        out(`         ${m.subject} (from ${m.from})`);
      }
      duplicateLines(duplicates);
      receiptHint(messages);
      return;
    }

    if (sub === 'new') {
      checkFlags(args, ['as', 'no-mark'], 'inbox new');
      const to = whoAmIOrDie(root, args, cfg);
      const mine = routeOnPickup(root, to);
      const {
        new: fresh, known, duplicates, broken, eventsBroken, elsewhere, waiting,
      } = inbox.newFor(root, cfg.participants, {
        to, mine,
        // Block S: a headless run (the watcher's handler) only gets what
        // may cost it a model run; a human-started session sees all.
        holdWaiting: Boolean(process.env.MEM_HEADLESS),
      });
      // Z3/A9: ALWAYS name unreadable messages — especially when nothing
      // else is new. An inbox with a broken message is not a healthy
      // empty one.
      brokenLines(broken, eventsBroken);
      if (elsewhere.length) warn(`${elsewhere.length} message(s) for another session of '${to}' (To-Route), not listed here`);
      if (waiting.length) warn(`${waiting.length} message(s) ${envelope.WAITING}, held back from this headless run`);
      if (fresh.length === 0) {
        out(`Nothing new for '${to}'. ${known} known.`);
        duplicateLines(duplicates);
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
      // S2c: the recipient got them — one `picked-up` event each (a `read` request is then done).
      if (!args['no-mark']) for (const f of inbox.markPickedUp(root, { to, names: fresh.map((m) => m.name) }).failed) warn(`picked-up not recorded for ${f.name}: ${f.reason}`);
      duplicateLines(duplicates);
      receiptHint(fresh);
      return;
    }

    if (sub === 'show') {
      checkFlags(args, ['as'], 'inbox show');
      const to = whoAmIOrDie(root, args, cfg);
      const name = rest[1];
      if (!name) die("Missing name (inbox show <name>)");
      routeOnPickup(root, to);
      // Audit 2026-09-30, B4: joining the name ourselves let `../../x`
      // read any file. readMessage() is the one guarded way in.
      try { inbox.checkMessageName(name); } catch (e) { die(e.message); }
      let content;
      try { content = inbox.readMessage(root, name); } catch { die(`'${name}' is not in the inbox`); }
      const m = inbox.parse(content);
      if (m.to !== to) out(`(Warning: this message is to '${m.to}', not '${to}')`);
      else inbox.markPickedUp(root, { to, names: [name] });
      // Z3/A8: the header is only the start state. If the effective state
      // differs (state event or claim), say so BEFORE the message.
      try {
        const e = inbox.stateOf(root, name);
        if (e.state !== m.state) out(`(State now: ${e.state} — from ${e.stateSource}; the header below is the start state)`);
        if (e.stateConflicts?.length) out(`(Warning: ${e.stateConflicts.length} state line(s) do not count: ${e.stateConflicts.map((c) => c.why).join('; ')})`);
      } catch { /* the message itself was readable; the projection is extra */ }
      process.stdout.write(content);
      return;
    }

    if (sub === 'ack') {
      checkFlags(args, ['as', 'reason', 'expected'], 'inbox ack');
      const name = rest[1];
      const newState = rest[2] ?? 'replied';
      if (!name) die("Missing name (inbox ack <name> [state])");
      // Z3/A8: one event line in inbox/states.jsonl; the message is left
      // as it is. `--expected <state>`: only if it still is (compare-and-
      // set); `--reason`: required to reopen.
      let m;
      try {
        m = inbox.setState(root, cfg.participants, name, newState, {
          by: (typeof args.as === 'string' ? args.as : null) ?? inbox.whoAmI(root),
          reason: typeof args.reason === 'string' ? args.reason : null,
          expected: typeof args.expected === 'string' ? args.expected : undefined,
        });
      } catch (e) { die(e.message); }
      out(m.unchanged ? `${name}: already ${m.state} — nothing written`
        : `${name}: state -> ${m.state} (event line in ${inbox.INBOX_DIR}/${inbox.STATES_FILE})`);
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
      // Block S: new mail that may not wake anyone is reported, not woken for.
      for (const w of (r.waiting ?? [])) out(`  ${envelope.WAITING}: ${w.name}${w.reason ? ` (${w.reason})` : ''}`);
      for (const q of (r.quiet ?? [])) out(`  does not wake (${q.reason}): ${q.name}`);
      if (r.status === 'quiet') {
        out(`new mail for '${to}', none may wake a model (${r.known} known)`);
        process.exit(0);
      }
      out(`${r.new.length} new for '${to}':`);
      for (const n of r.new) out(`  ${n}`);
      process.exit(1);
    }

    if (sub === 'wake') {
      checkFlags(args, ['as', 'dry-run'], 'inbox wake');
      const to = whoAmIOrDie(root, args, cfg);
      const d = inbox.wakeDecisions(root, cfg.participants, { to });
      brokenLines(d.broken, []);
      for (const w of d.waiting) out(`  ${envelope.WAITING}: ${w.message.name}${w.decision.detail ? ` (${w.decision.detail})` : ''}`);
      for (const q of d.quiet) out(`  does not wake (${q.decision.reason}): ${q.message.name}`);
      if (!d.wake.length) {
        out(`nothing may wake a model for '${to}'`);
        process.exit(0);
      }
      const charged = args['dry-run'] ? [] : inbox.chargeWakes(root, d.wake, { via: 'watcher' });
      out(`${d.wake.length} message(s) may wake '${to}'${args['dry-run'] ? ' (dry run, nothing charged)' : ''}:`);
      for (const w of d.wake) out(`  ${w.message.name} (${w.decision.permit.reason})`);
      if (charged.length) out(`charged: ${charged.length} line(s) in ${mailpermit.FILE} (token figures are estimates)`);
      process.exit(1);
    }

    if (sub === 'allow') {
      checkFlags(args, ['letters', 'tokens', 'until', 'to', 'authority', 'json'], 'inbox allow');
      if (args.to !== undefined && !Object.hasOwn(cfg.participants, String(args.to))) {
        die(`--to '${args.to}' has no inbox. Known: ${Object.keys(cfg.participants).join(', ')}`);
      }
      let z;
      try {
        z = mailpermit.grantBudget(root, {
          letters: numberFlag('letters', args.letters, { min: 1 }),
          tokens: numberFlag('tokens', args.tokens, { min: 1 }),
          until: typeof args.until === 'string' ? args.until : null,
          to: typeof args.to === 'string' ? args.to : null,
          authority: typeof args.authority === 'string' ? args.authority : null,
          by: inbox.whoAmI(root),
        });
      } catch (e) { die(e.message); }
      if (args.json) { out(JSON.stringify({ ...z, new: z.id })); return; }
      out(`Budget ${z.id}: ${z.letters !== null ? `${z.letters} message(s)` : `${z.tokens} tokens (estimate)`}`
        + `${z.to ? ` to ${z.to}` : ''}${z.until ? ` until ${z.until}` : ''}`);
      out(`Ledger: ${mailpermit.FILE} — commit and push it like a message.`);
      return;
    }

    if (sub === 'permit') {
      checkFlags(args, ['authority', 'json'], 'inbox permit');
      const name = rest[1];
      if (!name) die('Missing name (inbox permit <name> --authority user)');
      let z;
      try {
        z = mailpermit.grantMessage(root, {
          message: String(name),
          authority: typeof args.authority === 'string' ? args.authority : null,
          by: inbox.whoAmI(root),
        });
      } catch (e) { die(e.message); }
      // --json for the dashboard task `inbox-permit`: `new` names the appended line.
      if (args.json) { out(JSON.stringify({ ...z, new: z.id })); return; }
      out(`Permit ${z.id}: ${z.message}`);
      out(`Ledger: ${mailpermit.FILE} — commit and push it like a message.`);
      return;
    }

    if (sub === 'permissions') {
      checkFlags(args, [], 'inbox permissions');
      const st = mailpermit.status(root);
      const est = mailpermit.estimate(root);
      out(`Tokens per woken session: ~${est.tokens} (${est.source}${est.runs ? `, ${est.runs} runs` : ''}) — an ESTIMATE, not a measurement`);
      if (!st.budgets.length && !st.grants.length) out('No permission granted.');
      for (const b of st.budgets) {
        const what = b.letters !== null && b.letters !== undefined
          ? `${b.spentLetters}/${b.letters} messages` : `~${b.spentTokens}/${b.tokens} tokens (estimate)`;
        out(`  budget ${b.id} [${b.status}] ${what}${b.to ? ` to ${b.to}` : ''}${b.until ? ` until ${b.until}` : ''}`);
      }
      for (const g of st.grants) out(`  permit ${g.id} ${g.message}`);
      for (const d of st.disputed) out(`  DISPUTED (no authority user, does not count): ${d.kind} ${d.id}`);
      for (const b of st.broken) warn(`unreadable line ${mailpermit.FILE}:${b.line}: ${b.reason}`);
      const pm = mailpermit.checker(root);
      let n = 0;
      for (const role of Object.keys(cfg.participants)) {
        if (isHumanName(cfg, role)) continue;
        for (const m of inbox.read(root, cfg.participants, { to: role }).messages) {
          const d = envelope.wakes(m, { permit: pm });
          if (d.reason !== envelope.WAITING) continue;
          n += 1;
          out(`  ${envelope.WAITING}: ${m.name} (to ${m.to}${d.detail ? `: ${d.detail}` : ''})`);
        }
      }
      out(`${n} message(s) ${envelope.WAITING}`);
      return;
    }

    if (sub === 'routes') {
      checkFlags(args, [], 'inbox routes');
      const { routes: list, broken } = routes.all(root);
      if (!list.length) out('No route registered. A session registers one when it picks up its mail.');
      for (const r of list) out(`  ${r.alias}  ${r.routeId}  role ${r.role}, since ${r.ts}`);
      for (const b of broken) warn(`unreadable line ${routes.FILE}:${b.line}: ${b.reason}`);
      return;
    }

    if (sub === 'claim' || sub === 'renew' || sub === 'done' || sub === 'failed' || sub === 'claims') {
      checkFlags(args, sub === 'claim' ? ['as', 'minutes'] : sub === 'renew' ? ['as', 'minutes', 'claim-id'] : sub === 'failed' ? ['as', 'claim-id', 'reason'] : sub === 'done' ? ['as', 'claim-id'] : [],
        `inbox ${sub}`);
      const name = rest[1];
      if (!name) die(`Missing name (inbox ${sub} <name>)`);
      if (sub === 'claims') {
        const st = claim.status(root, name);
        out(`${name}: ${st.status}${st.late ? ' (LATE: done came after the claim expired)' : ''}${st.holder ? ` — ${st.holder.claimed_by} until ${st.holder.until}${st.renewals ? ` (renewed ${st.renewals}x)` : ''}` : ''}`);
        for (const u of st.invalid) out(`  does not count: ${u.claimed_by ?? u.by} (${u.kind}) — ${u.reason}`);
        for (const f of st.failures) out(`  failed: ${f.by} — ${f.reason}`);
        if (st.broken.length) warn(`${st.broken.length} unreadable line(s) in ${claim.FILE}`);
        return;
      }
      const by = whoAmIOrDie(root, args, cfg);
      if (sub === 'claim') {
        const r = claim.claim(root, name, {
          by, minutes: (numberFlag('minutes', args.minutes, { min: 1 }) ?? undefined),
        });
        out(r.valid ? `${name}: claimed by '${by}' (claim-id ${r.id} — done/failed need it)`
          : `${name}: claim written but does NOT count — ${r.reason}`);
        if (!r.valid) process.exit(1);
        return;
      }
      if (!args['claim-id'] || args['claim-id'] === true) die(`Missing --claim-id (the id 'inbox claim' printed)`);
      const claimId = String(args['claim-id']);
      if (sub === 'renew') {
        const r = claim.renew(root, name, {
          by, claimId, minutes: (numberFlag('minutes', args.minutes, { min: 1 }) ?? undefined),
        });
        if (!r.valid) {
          out(`${name}: renew written but does NOT count — ${r.reason}`);
          process.exit(1);
        }
        out(`${name}: ${r.status} — ${r.holder.claimed_by} until ${r.holder.until} (renewed ${r.renewals}x)`);
        return;
      }
      if (sub === 'done') {
        const r = claim.done(root, name, { by, claimId });
        if (!r.valid) {
          out(`${name}: done written but does NOT count — ${r.reason}`);
          process.exit(1);
        }
        out(`${name}: ${r.status}${r.late ? ' (LATE: written after the claim expired; counts, marked)' : ''}`);
        return;
      }
      if (!args.reason || args.reason === true) die('Missing --reason');
      const r = claim.failed(root, name, { by, claimId, reason: String(args.reason) });
      if (!r.valid) {
        out(`${name}: failed written but does NOT count — ${r.reason}`);
        process.exit(1);
      }
      out(`${name}: ${r.status} (released)`);
      return;
    }

    die([
      `inbox: unknown subcommand '${sub}'`,
      'Known: new (default), all, write, show, ack, watch, wake, allow, permit, permissions, routes,',
      '       claim, renew, done, failed, claims',
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
      out(`Appended: ${memory.asSource(root, p)}:${countLines(p)}`);
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

  // Parity for the sibling's W11 (`mem vorschlag verfahren`, 9847a03):
  // print the draft `mem log procedure` command for a repeated error
  // class. Writes NOTHING; a procedure is a human's act.
  suggest: async ({ rest = [], args }) => {
    if (isHelp(args) || rest[0] !== 'procedure') {
      out([
        'mem suggest procedure <class>',
        '',
        '  Prints a ready `mem log procedure ...` command for an error class',
        '  (mem classes lists the twelve). The rule text comes ONLY from the',
        '  `remedy`/`correct` field or one sentence of the NEWEST error of that',
        '  class, no model call. Nothing is written; `mem log procedure',
        '  --issued-by owner` stays a human act.',
        '',
        '  Refused when the class already has a procedure in force, or when no',
        '  error of that class exists.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['root'], 'suggest procedure');
    const root = findRoot(args);
    requireConfig(root);
    if (!rest[1]) die('suggest procedure: which class? (mem classes lists all)');
    const r = repetitionhint.suggestProcedure(root, rest[1]);
    if (!r.ok) die(`suggest procedure: ${r.reason}`);
    out(`Source: newest error ${r.source} (${r.count}x this class). Nothing written:`);
    out('');
    out(r.command);
  },

  procedures: async ({ rest = [], args }) => {
    if (isHelp(args)) {
      out([
        'mem procedures [--project <name>]',
        'mem procedures --match "<text>" [--project <name>]',
        'mem procedures status <id> <proposed|trial|released|withdrawn> --issued-by owner [--why "..."]',
        '',
        '  Status (X3): an append-only line per change, written by a human',
        '  only (--issued-by owner | human:<name>). Nothing changes status',
        '  by itself and repetition confirms nothing. A rule with no status',
        '  line counts as "released (legacy)". A withdrawn rule is no longer',
        '  shown; a proposed or trial rule is shown marked [proposed] /',
        '  [trial], never as a rule in force. The list prints, per rule, the',
        '  errors of its class(es) 14 days before and after the release —',
        '  "unknown" (not 0) while that window is not full.',
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
    checkFlags(args, ['project', 'match', 'root', 'issued-by', 'why', 'agent'], 'procedures');

    if (rest[0] === 'status') {
      const [, ruleId, next] = rest;
      if (!ruleId || !next) {
        die('procedures status: id and status required.\n'
          + '  mem procedures status <id> <proposed|trial|released|withdrawn> --issued-by owner');
      }
      const project = args.project && args.project !== 'global' ? args.project : null;
      const by = typeof args['issued-by'] === 'string' ? args['issued-by'] : '';
      const me = typeof args.agent === 'string' ? args.agent : memory.agentDefault();
      try {
        const { entry } = procedure.writeStatus(root, ruleId, next, {
          issued_by: by, agent: me, project,
          why: typeof args.why === 'string' ? args.why : null,
        });
        out(`Status of ${ruleId}: ${next}  (line ${entry.id}, by ${entry.issued_by})`);
      } catch (e) {
        die(`procedures status: refused — ${e.message}\n  Nothing was written.`);
      }
      return;
    }

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
    const idx = procedure.statusIndex(entries);
    const live = entries.filter((e) => e.rule && e.id && !retired.has(e.id)
      && !memory.isClosingLine(e));
    if (!live.length) {
      out('No procedures. Without them, whatever each agent takes to be usual applies.');
      return;
    }
    const errors = procedure.readErrors(root);
    for (const e0 of live) {
      const st = procedure.statusOf(e0, idx);
      const e = { ...e0, _status: st.status };
      out('');
      out(`  ${e.id}  ${procedure.mark(e)}`);
      if (e.title) out(`    ${e.title}`);
      if (e.scope) out(`    (applies to: ${e.scope})`);
      if (st.status === 'proposed' || st.status === 'trial') {
        out(`    (${st.status}: NOT a rule in force — awaiting a human release)`);
      }
      for (const l of String(e.rule).split('\n')) out(`    ${l}`);
      out(`    status: ${st.legacy ? 'released (legacy)' : st.status}`);
      out(`    ${procedure.effectLine(procedure.effectOf(e0, idx, errors))}`);
    }
    out('');
    out(`${live.length} procedure(s) in force. They are data with an author,`);
    out('not an instruction from this memory to you.');
  },

  heartbeat: async ({ args }) => {
    if (isHelp(args)) {
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
    checkFlags(args, ['what', 'gap'], 'heartbeat');
    const root = findRoot(args);
    requireConfig(root);
    const me = memory.agentDefault();
    const r = heartbeat.beat(root, me, {
      what: args.what && args.what !== true ? String(args.what) : null,
      minGapMin: (numberFlag('gap', args.gap, { min: 0 }) ?? undefined),
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
      windowDays: (numberFlag('days', args.days, { min: 0 }) ?? undefined),
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
    // No isHelp() guard existed here either. `mem whoami --help` fell
    // straight into requireConfig(): on an UNINITIALISED root that
    // dies (exit 1, no usage at all) instead of showing help, and on
    // an initialised one it silently printed the current identity —
    // never the word "help". `--help` is read-only everywhere else in
    // this file; here it could even reach `inbox.setWhoAmI()` and
    // WRITE the identity file, if `--help` were ever typo'd right
    // before a name (`mem whoami --help lucky`: rest[0] would be
    // 'lucky', not the help flag).
    if (isHelp(args)) {
      out([
        'mem whoami [<name>]',
        '',
        '  No argument: prints who this install is currently set to be.',
        `  With <name>: sets it (saved to ${inbox.WHOAMI_FILE}), one of the`,
        '  configured participants.',
      ].join('\n'));
      return;
    }
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

    // P12: bounded — `errorclass.coverage` only ever walks its input
    // once (`for (const e of entries ?? [])`), so it can take the raw
    // generator directly instead of a materialised array of every
    // project's entries.
    function* allEntries() {
      for (const project of [null, ...memory.listProjects(root)]) {
        try { yield* memory.iterLog(root, 'error', { project }); }
        catch { /* log absent */ }
      }
    }
    const c = errorclass.coverage(allEntries());

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

  appointment: async ({ rest, args }) => {
    const sub = rest[0];
    if (isHelp(args) || !sub) { out(appointmentCli.HELP); return; }
    if (!Object.hasOwn(appointmentCli.FLAGS, sub)) {
      die(`appointment: unknown subcommand '${sub}'. Known: ${appointmentCli.SUBCOMMANDS.join(', ')}.`);
    }
    checkFlags(args, appointmentCli.FLAGS[sub], `appointment ${sub}`);
    const root = findRoot(args);
    requireConfig(root);
    await appointmentCli.run(sub, { root, args, rest: rest.slice(1) });
  },

};

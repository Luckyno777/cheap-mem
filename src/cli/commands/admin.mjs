/**
 * Measuring and maintaining what is already there.
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
import * as search from '../../search.mjs';
import * as setup from '../../setup.mjs';
import * as thesaurus from '../../thesaurus.mjs';
import * as doctor from '../../doctor.mjs';
import * as epoch from '../../epoch.mjs';
import * as integrity from '../../integrity.mjs';
import * as chain from '../../chain.mjs';
import * as shardarchive from '../../shardarchive.mjs';
import * as embedmod from '../../embed/index.mjs';
import * as embedHook from '../../embed-hook.mjs';
import * as maintenance from '../../maintenance.mjs';
import * as observations from '../../observations.mjs';
import { out, die, warn, checkFlags, isHelp, findRoot, requireConfig } from '../shell.mjs';

/** 8 commands. */
export const COMMANDS = {
  doctor: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem doctor [--quiet] [--strict] [--alarm]',
        '',
        '  --quiet   hide what is fine',
        '  --alarm   ONLY level ERROR, one line each, nothing when quiet.',
        '            For a start banner. exit 1 if anything is red.',
        '  --strict  an UNVERIFIABLE guarantee counts as a failure.',
        '            For CI, where the environment is fixed and known:',
        '            there, refusing to determine a property IS the defect.',
        '            Normal runs treat unknown as unknown.',
        '',
        '  exit 0 fine · 1 warnings · 2 errors (or, with --strict, unknowns)',
        '',
        '  A run with no ERROR also advances `mem epoch`\'s rollback',
        '  watermark to the state just checked — see `mem epoch --help`.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['quiet', 'strict', 'alarm'], 'doctor');
    const root = findRoot(args);
    // **No `requireConfig` here, deliberately (2026-09-20).**
    //
    // Every other command demands a readable config and exits when there
    // is none, which is right: writing into a memory that is not set up
    // would make a mess. The doctor is the one command whose JOB is a
    // memory that may be broken, and this line made exactly that case
    // unreportable. `requireConfig` calls `die()`, so the process ended
    // before a single finding existed.
    //
    // Measured: `doctor.can-fail` stood at 28 of 31. The three that
    // could not fail were `config`, `root` and `orphan-drawers` — and
    // for the first two the reason was this line, not their own code.
    // `checkConfig` has always returned an ERROR finding for an
    // unreadable config and `checkRoot` for a missing directory; nobody
    // ever got to see either.
    //
    // A check that cannot fail is not a check. Taking the gate away
    // costs nothing: `checkAll` runs on a bare directory and reports
    // `config: error` by itself — verified before this change.
    const result = doctor.checkAll(root);

    // The automatic tick (P21, 2026-09-20): every `mem doctor` run that
    // comes back with no ERROR advances the rollback watermark to the
    // state just checked. This is what makes `mem epoch record` a
    // command nobody has to remember any more — see
    // `doctor.tickEpoch`'s docblock for exactly what "no ERROR" does
    // and does not require. Runs before --alarm's early exit, so an
    // unattended start-banner invocation ticks the mark too, not only
    // an interactive one.
    doctor.tickEpoch(root, result);

    // --alarm is the shape for a start banner: only what is down now,
    // and no output at all when nothing is. Reasoning in the docblock
    // of doctor.alarm().
    if (args.alarm) {
      const lines = doctor.alarm(result);
      if (lines.length) out(lines.join('\n'));
      process.exit(lines.length ? 1 : 0);
    }
    out(doctor.report(result, { problemsOnly: Boolean(args.quiet) }));

    if (args.strict && result.summary.unknown > 0) {
      warn(`--strict: ${result.summary.unknown} guarantee(s) could not be verified.`);
    }
    const strictFail = Boolean(args.strict) && result.summary.unknown > 0;
    process.exit(result.worst === doctor.LEVEL.ERROR || strictFail ? 2
      : result.worst === doctor.LEVEL.WARN ? 1 : 0);
  },

  gauges: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem gauges [--json] [--session <id>] [--chars-per-token <n>] [--window <n>]',
        '',
        '  Three numbers about retrieval, and none is a view of another:',
        '',
        '    Occupancy    how much context our injections hold',
        '    Sufficiency  did an injection suffice — read off what the',
        '                 session did NEXT, not from a self-report',
        '    Allocation   which injected places were touched afterwards',
        '',
        '  Source is the injection journal (.pipeline/) and the raw',
        '  capture. Nothing is reported, nothing is sent, no model asked.',
        '',
        '  --chars-per-token  the window share is only computed with a',
        '                     MEASURED ratio. Without one it stays',
        '                     expressly unknown — guessing would be the',
        '                     most convenient way to prove oneself right.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json', 'session', 'chars-per-token', 'window', 'root'], 'gauges');
    const root = findRoot(args);
    const gauges = await import('../../gauges.mjs');
    const injection = await import('../../injection.mjs');
    const { lines: journalRaw, broken, present } = injection.read(root);
    const session = typeof args.session === 'string' ? args.session : null;
    const journal = session ? journalRaw.filter((l) => l.session === session) : journalRaw;
    const cpt = Number(args['chars-per-token']);
    const win = Number(args.window);
    const r = gauges.measure({
      journal, lines: [], broken, journalPresent: present,
      charsPerToken: Number.isFinite(cpt) && cpt > 0 ? cpt : null,
      window: Number.isFinite(win) && win > 0 ? win : null,
    });
    if (args.json) out(JSON.stringify(r, null, 2));
    else out(gauges.asText(r));
  },

  observations: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem observations [--last <n>] [--json]',
        '',
        '  What this memory has injected, and when. Per machine, never',
        '  committed, and read by nothing but this command -- ranking must',
        '  not see it, or the same data would stop giving the same answer.',
        '',
        '  --last   how many of the most recent lines to show (default 20)',
        '  --json   the raw lines',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['last', 'json', 'root'], 'observations');
    const root = findRoot(args);
    requireConfig(root);
    const led = observations.readAll(root);

    // Three states, never two: no ledger at all is not an empty ledger.
    if (led.missing) {
      out(`no ledger yet: ${led.path}`);
      out('Nothing has been injected on this machine, or it was cleared.');
      return;
    }
    if (args.json) { out(JSON.stringify(led.entries, null, 2)); return; }
    if (!led.entries.length) { out(`ledger is empty: ${led.path}`); return; }

    const broken = led.entries.filter((e) => e.__broken).length;
    const good = led.entries.filter((e) => !e.__broken);
    const n = args.last && args.last !== true ? Math.max(1, Number(args.last)) : 20;
    out(`${good.length} observation(s)${broken ? `, ${broken} unreadable` : ''} in ${led.path}`);
    if (broken) out('Unreadable lines are kept, not dropped -- silence here would hide the corruption this log exists to catch.');
    out('');
    for (const e of good.slice(-n)) {
      const q = e.query ? ` "${String(e.query).slice(0, 48)}"` : '';
      out(`  ${e.ts ?? '?'}  ${String(e.lane ?? '?').padEnd(10)} ${(e.ids ?? []).length} hit(s)${q}`);
    }
  },

  maintenance: async ({ rest, args }) => {
    const subs = ['dedupe'];
    if (isHelp(args) || !rest[0]) {
      out([
        'mem maintenance dedupe [--project <name>] [--type <type>] [--dry-run]',
        '',
        '  Entries whose CONTENT is identical are merged: the one with the',
        '  highest authority stays active, the rest are retired with a',
        '  tombstone line naming the survivor. Append-only — nothing is',
        '  edited or deleted, only a new line is appended next to each loser.',
        '',
        '  "Identical" means the same content hash. A file source reuses',
        '  the hash already computed when it was taken in (store.put); every',
        '  other entry uses the exact-match rule retrieval already applies',
        '  when it collapses flooded duplicates at read time. Near-duplicates',
        '  — same meaning, different words — are left alone on purpose: that',
        '  needs a judgement call this command does not make.',
        '',
        '  --dry-run   show what would merge, write nothing',
        '  --type      restrict to one entry type (default: all)',
        '  --project   one project only (default: every project + global)',
        '',
        '  Running it twice changes nothing the second time.',
      ].join('\n'));
      return;
    }
    const sub = rest[0];
    if (!subs.includes(sub)) die(`maintenance: '${sub}' unknown. Known: ${subs.join(', ')}`);
    checkFlags(args, ['project', 'type', 'dry-run', 'root'], 'maintenance dedupe');
    const root = findRoot(args);
    requireConfig(root);
    const type = args.type && args.type !== true ? String(args.type) : null;
    if (type && !Object.hasOwn(memory.TYPES, type)) {
      die(`maintenance dedupe: unknown type '${type}'. Known: ${Object.keys(memory.TYPES).join(', ')}`);
    }
    const project = args.project
      ? (args.project === 'global' ? null : String(args.project))
      : undefined;
    const dryRun = Boolean(args['dry-run']);
    const report = maintenance.dedupe(root, { project, type, dryRun });
    if (!report.length) {
      out('No exact duplicates found. Nothing to merge.');
      return;
    }
    for (const r of report) {
      out(`  ${dryRun ? 'would merge' : 'merged'}  ${r.type}${r.project ? `/${r.project}` : ''}  `
        + `${r.retired} -> kept ${r.survivor}  (hash ${r.hash.slice(0, 12)})`);
    }
    out('');
    out(`${report.length} ${report.length === 1 ? 'entry' : 'entries'} `
      + `${dryRun ? 'would be' : ''} superseded by content-hash merge.`);
  },

  // **A log nobody can read is a file that grows, not an audit trail.**
  //
  // Both commands below exist because `test/no-log-without-reader.test.mjs`
  // caught their modules appending to disk with nothing in the CLI able
  // to show what they had written. `src/chain.mjs` was the sharper case:
  // `scanIntegrity` already COMPUTED the chain verdict and every caller
  // threw it away, so the memory could tell you it had been tampered
  // with and no command would say so.
  chain: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem chain [--json]',
        '',
        '  What the per-writer hash chains say about this memory.',
        '',
        '  Three states per writer — the same words the chain itself',
        '  uses, not a second vocabulary for the screen:',
        '    ok       every seal recomputes to the hash it declared,',
        '             over a stated number of lines',
        '    error    a sealed line changed after it was sealed; the',
        '             line, the id it covered and both hashes are named',
        '    unknown  nothing sealed, or a seal that covers no line.',
        '             This memory cannot say whether it was tampered',
        '             with — which is NOT the same as saying it was not.',
        '',
        '  Lines appended since the newest seal are reported alongside:',
        '  they are outside what any seal vouches for.',
        '',
        '  Sealing is off unless `chainSealCadence` is set in',
        '  .mem/config.json — see src/chain.mjs.',
      ].join('\n'));
      return;
    }
    // `integrity.logFiles` owns which drawer files exist; `chain.verifyChain`
    // owns what a seal means. Calling both here keeps one enumeration and
    // one verifier — and it is also what makes this command visibly the
    // chain's reader rather than a reader of something that reads it.
    const root = findRoot(args);
    const files = integrity.logFiles(root).map((f) => {
      let raw = '';
      try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { /* absent: no chain either */ }
      return { rel: f.rel, raw, project: f.project, type: f.type };
    });
    const verdict = chain.verifyChain(files);
    if (args.json) { out(JSON.stringify(verdict, null, 2)); return; }
    out(`${verdict.filesChecked} drawer file(s) read, ${verdict.sealsFound} seal(s) found.`);
    // **The condition is the seal count, not the writer count.** The
    // first version asked whether any WRITER was known, and a memory
    // with writers and no seals therefore skipped this sentence and
    // went straight to a per-writer list reading `unknown` — true, but
    // it never said the plain thing: nothing here can be verified.
    if (!verdict.sealsFound) {
      out('No seal has been written, so nothing here can be verified.');
      out('That is an honest unknown, not a clean bill of health.');
      if (verdict.writers.length) {
        out(`${verdict.writers.length} writer(s) have appended lines that no seal covers.`);
      }
      return;
    }
    for (const w of verdict.writers) {
      const where = [w.project, w.type].filter(Boolean).join('/') || 'global';
      out(`  ${String(w.state).padEnd(9)} ${String(w.writer).padEnd(18)} ${where}`
        + `  seals ${w.seals}${w.unsealedSince ? `, ${w.unsealedSince} line(s) unsealed since` : ''}`);
      if (w.brokenAt) {
        out(`      broke at line ${w.brokenAt.line}, covering through ${w.brokenAt.throughId}`);
        out(`      declared ${w.brokenAt.declared}`);
        out(`      computed ${w.brokenAt.computed}`);
      }
    }
  },

  archive: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem archive [--json]',
        '',
        '  Which older shards have been moved out of this clone, and',
        '  whether they can still be reached from here.',
        '',
        '  Nothing is deleted — only its address changes. A clone',
        '  without the archive still answers, either with the entry or',
        '  with the way to it; never with a silent nothing.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    const st = shardarchive.archiveStatus(root);
    if (args.json) { out(JSON.stringify(st, null, 2)); return; }
    // **`good` over an empty archive would be the wrong word**, and the
    // first version of this line said it. Nothing has been archived
    // here, so there is no reachability to be good about — the honest
    // report is that the question does not arise yet. Same rule the
    // doctor's findings follow: a verdict has to be able to say what it
    // inspected.
    const shardCount = Array.isArray(st.shards) ? st.shards.length : 0;
    if (!st.archivedCount) {
      out('Nothing archived: every entry still lives in this clone.');
      out('  Archiving moves older shards out of git and leaves a');
      out('  manifest behind, so an entry stays addressable from here.');
      return;
    }
    out(`${st.state}: ${st.archivedCount} entry/entries in ${shardCount} shard(s), `
      + `${st.reachableShards} reachable.`);
    if (st.unreachableShards) {
      out(`  ${st.unreachableShards} shard(s) cannot be read from here.`);
      out('  Entries in them are addressable but not readable: `mem show <id>`');
      out('  will name the shard and where it should be, rather than say');
      out('  the entry does not exist.');
    }
  },

  epoch: async ({ rest, args }) => {
    const sub = rest[0] ?? 'show';
    if (isHelp(args) || !['show', 'record'].includes(sub)) {
      out([
        'mem epoch [show|record] [--force]',
        '',
        '  show    has the memory gone backwards since this machine last looked?',
        '  record  move the watermark forward BY HAND. Refuses to lower it',
        '          without --force.',
        '',
        '  Recording by hand is the escape hatch, not the normal path: every',
        '  `mem doctor` run that comes back with no error already does this',
        '  automatically, on the state doctor just certified. `mem epoch',
        '  record` remains for establishing a mark right now without waiting',
        '  for the next doctor run, or for the deliberate --force override.',
        '',
        '  The watermark is LOCAL and gitignored on purpose: one committed',
        '  alongside the log would travel back with the checkout it is meant',
        '  to detect. It stores no memory content — only how far this machine',
        '  has already seen. Delete it and you lose detection, not data.',
        '',
        '  Limits, stated plainly: a fresh clone has no watermark and so cannot',
        '  detect anything on its first run; and anyone who can write the',
        '  repository can delete the file. This catches accidents and stale',
        '  restores, not a determined adversary with filesystem access.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['force'], 'epoch');
    const root = findRoot(args);
    requireConfig(root);
    if (sub === 'show') {
      const s = epoch.checkEpoch(root);
      out(`status: ${s.status}`);
      out(`  now:  ${s.current.claims} claims, ${s.current.retiredCount} retired`);
      if (s.mark) out(`  mark: ${s.mark.claims} claims, ${s.mark.retiredCount} retired (${s.mark.seenAt})`);
      if (s.resurrected.length) out(`  resurrected: ${s.resurrected.join(', ')}`);
      process.exit(s.status === 'rollback' ? 2 : 0);
    }
    const r = epoch.recordEpoch(root, { force: Boolean(args.force) });
    if (!r.written) {
      warn('refusing to lower the watermark — the memory is BEHIND what this machine saw.');
      warn(`  ${r.resurrected.length} retired claim(s) are active again: ${r.resurrected.slice(0, 5).join(', ')}`);
      warn('  Pass --force only if this rollback is intended.');
      process.exit(2);
    }
    out(`watermark: ${r.current.claims} claims, ${r.current.retiredCount} retired`);
  },

  thesaurus: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem thesaurus [--graph] [--top N]',
        '',
        '  Without --graph: the curated groups.',
        '  With --graph: what the tag graph learned from YOUR entries.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['graph', 'top'], 'thesaurus');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    const loaded = thesaurus.loadUserGroups(root, fs, path);
    if (loaded.error) out(`warning: ${loaded.error}`);

    if (args.graph) {
      const index = search.loadIndex(root, { language: cfg.language });
      if (index.tagGraph.size === 0) {
        out('The tag graph is empty — entries need `tags` for it to learn anything.');
        return;
      }
      out(`${index.tagGraph.size} tags with learned neighbours:`);
      out(thesaurus.graphReport(index.tagGraph, { top: args.top ? Number(args.top) : 20 }));
      return;
    }
    out(`${thesaurus.THESAURUS.length} curated groups`
      + (loaded.loaded ? `, ${loaded.loaded} of your own from .mem/thesaurus.json` : ''));
    for (const g of thesaurus.THESAURUS) out(`  ${g.join(', ')}`);
  },

  embed: async ({ rest, args }) => {
    if (isHelp(args) || rest.length === 0) {
      out([
        'mem embed setup [--provider voyage|openai|ollama] [--model M]',
        'mem embed backfill [--force]      embed entries written before setup',
        'mem embed status                  provider, model, how many are stored',
        'mem find-embed "<query>"          semantic search',
        '',
        '  This is the ESCALATION, not the default. `mem find` works with',
        '  no key, no network and no cost — use it. Reach for embeddings',
        '  only for true paraphrase with no word in common.',
        '',
        '  Needs: npm install better-sqlite3 sqlite-vec  (optional deps)',
        '  Keys:  VOYAGE_API_KEY / OPENAI_API_KEY, or .mem/embed.env',
        '         ollama needs no key and sends nothing off the machine.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (rest[0] === 'setup') {
      checkFlags(args, ['provider', 'model', 'on-fail'], 'embed setup');
      const provider = args.provider ?? 'voyage';
      if (!embedmod.knownProviders().includes(provider)) {
        die(`embed setup: unknown provider '${provider}'. `
          + `Known: ${embedmod.knownProviders().join(', ')}`);
      }
      const cfg = { ...embedmod.DEFAULTS, provider, model: args.model ?? null };
      if (args['on-fail']) cfg.onFail = args['on-fail'];
      const written = embedmod.writeConfig(root, cfg);
      // Read it back, so what we report is the model that will really
      // be used — writeConfig stores `null` and readConfig resolves it.
      const eff = embedmod.readConfig(root);
      out(`Wrote ${path.relative(root, written)}`);
      out(`  provider: ${eff.provider}`);
      out(`  model:    ${eff.model} (${embedmod.dimensions(eff.provider, eff.model)} dim)`);
      out('');
      out('Next: npm install better-sqlite3 sqlite-vec');
      out('      mem embed backfill');
      return;
    }

    if (rest[0] === 'status') {
      let cfg;
      try { cfg = embedmod.readConfig(root); }
      catch (e) { die(`embed status: ${e.message}`); }
      out(`provider: ${cfg.provider}`);
      out(`model:    ${cfg.model} (${embedmod.dimensions(cfg.provider, cfg.model)} dim)`);
      const store = await import('../../embed/store.mjs');
      try {
        const db = await store.open(root, embedmod.dimensions(cfg.provider, cfg.model));
        out(`stored:   ${store.count(db)} entries`);
        db.close();
      } catch (e) {
        out(`stored:   not readable — ${e.message.split('\n')[0]}`);
      }
      return;
    }

    if (rest[0] === 'backfill') {
      checkFlags(args, ['force', 'project'], 'embed backfill');
      const store = await import('../../embed/store.mjs');
      if (args.force) store.deleteDb(root);
      let fresh = 0; let skipped = 0; let broken = 0;
      let noKey = null;
      const cfg = embedmod.readConfig(root);
      const dim = embedmod.dimensions(cfg.provider, cfg.model);
      const db = await store.open(root, dim);
      try {
        for (const project of [null, ...memory.listProjects(root)]) {
          for (const type of Object.keys(memory.TYPES)) {
            const file = memory.logPath(root, type, project);
            if (!fs.existsSync(file)) continue;
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            for (let i = 0; i < lines.length; i += 1) {
              if (!lines[i].trim()) continue;
              let e;
              try { e = JSON.parse(lines[i]); } catch { continue; }
              if (!e.id) continue;
              const rel = path.relative(root, file);
              if (!args.force && store.exists(db, rel, i + 1, e.id)) { skipped += 1; continue; }
              const r = await embedHook.embedEntry(root, file, i + 1, e);
              if (r.status === 'ok') fresh += 1;
              else if (r.status === 'empty') skipped += 1;
              else if (r.status === 'off') { noKey = r.reason; break; }
              else {
                broken += 1;
                process.stderr.write(`${rel}:${i + 1} ${embedHook.warning(r)}\n`);
              }
            }
            if (noKey) break;
          }
          if (noKey) break;
        }
      } finally { try { db.close(); } catch { /* fine */ } }

      if (noKey) {
        // Without a key not one entry can succeed. Say it once and
        // stop, instead of counting thousands of identical failures.
        process.stderr.write(`Backfill stopped: ${noKey}.\n`
          + '  Embeddings are the optional escalation. Without a key,\n'
          + '  `mem find` (BM25, no model) is unaffected.\n');
        process.exit(2);
      }
      out(`Backfill done. new: ${fresh}, skipped: ${skipped}, broken: ${broken}`);
      return;
    }
    die(`embed: unknown subcommand '${rest[0]}'. Known: setup, backfill, status`);
  },

  status: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem status [--json]',
        '',
        '  What is between "installed" and "working", and which of it is',
        '  still open. Changes nothing — it only looks.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    const res = setup.check(root);

    if (args.json) {
      out(JSON.stringify(res));
      // **This `return` used to skip the exit-code logic below
      // entirely.** A root with an unreadable .mem/config.json made
      // `mem status` exit 1 and `mem status --json` exit 0 — with a
      // payload that itself says `"state":"broken"`. A shell poller
      // that only checks the exit code never found out. The text form
      // gets its non-zero exit from `die()` a few lines down; --json
      // has to reach the same verdict without going through it, since
      // `die()` writes a line to stderr that the text form wants and a
      // JSON consumer does not.
      if (res.broken) process.exitCode = 1;
      return;
    }

    const mark = { ok: ' ok ', open: ' -- ', broken: 'FAIL' };
    for (const s of res.steps) {
      out(`[${mark[s.state]}] ${s.title}`);
      out(`         ${s.detail}`);
      // The way out belongs next to the problem. A list of failures
      // without commands sends people back to the documentation, and
      // the documentation is what they already did not read.
      if (s.fix) out(`         → ${s.fix}`);
    }
    out('');
    out(`${res.ok} of ${res.steps.length} in place`
      + (res.open ? `, ${res.open} open` : '')
      + (res.broken ? `, ${res.broken} BROKEN` : ''));

    // Only broken is an error. Open is a to-do list, and a to-do list
    // that exits non-zero breaks every script that runs this.
    if (res.broken) die(`${res.broken} step(s) are broken — see above.`);
  },

};

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * The raw-capture lane: transcripts in, redacted, indexed, archived.
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
import zlib from 'node:zlib';
import * as memory from '../../memory.mjs';
import * as raw from '../../raw.mjs';
import * as archive from '../../archive.mjs';
import * as stores from '../../stores.mjs';
import * as redaction from '../../redaction.mjs';
import * as userhabits from '../../userhabits.mjs';
import { out, die, checkFlags, isHelp, findRoot, requireConfig } from '../shell.mjs';

/**
 * Yield per capture (B16, Z1a): how many logged entries name it in
 * `origin.raw`? Same logs `mem doctor` (checkDigestYield) counts from —
 * one count, not two. 0 is a valid value (the capture gave nothing) but
 * it is counted and shown. Lives here and not in src/raw.mjs so the
 * capture path does not import memory.mjs.
 */
export function yieldPerCapture(root, paths) {
  const counts = {};
  for (const p of paths) counts[p] = 0;
  const wanted = new Set(paths);
  for (const project of [null, ...memory.listProjects(root)]) {
    for (const type of Object.keys(memory.TYPES)) {
      for (const e of memory.iterLog(root, type, { project })) {
        const q = e && e.origin && e.origin.raw;
        if (!q || q === 'unknown') continue;
        for (const r of new Set(Array.isArray(q) ? q : [q])) {
          if (wanted.has(r)) counts[r] += 1;
        }
      }
    }
  }
  return counts;
}

/** 4 commands. */
export const COMMANDS = {
  raw: async ({ rest, args }) => {
    if (isHelp(args) || rest.length === 0) {
      out([
        'mem raw pending [--json]        what the digest has not processed yet',
        'mem raw show <path> [--head] [--from N] [--count M]',
        'mem raw digested <path> ...     mark captures as digested',
        'mem raw check                   old captures that today\'s rules would redact',
        'mem raw archive [--set <path|store>] [--list-stores]',
        '                                where the raw capture lives, how much,',
        '                                reachable; --set fixes the location of',
        '                                THIS machine (a folder, or one of:',
        '                                gdrive, icloud, onedrive, dropbox)',
        'mem raw migrate [--remove]      pull captures still in the repo into the archive',
        'mem raw export --from <date> [--to <date>] [--hour-from N]',
        '               [--hour-to N] --into <dir>',
        '                                write out a time range, decompressed',
        'mem raw review [--project X|global] [--from <date>] [--to <date>]',
        '               [--hour-from N] [--hour-to N] [--json]',
        '                                every capture with its state — present,',
        '                                deleted (with reason/by) or unreachable',
        '                                (bytes gone, nobody said so — a defect,',
        '                                not a decision). Uses the same range',
        '                                filter as raw export/archive.inRange —',
        '                                there is only one "in range" in this repo.',
        'mem raw delete <path> --reason "..." [--by <name>] [--yes]',
        '                                irreversible: the BYTES leave the archive,',
        '                                outside git, and a tombstone is appended',
        '                                to the register. Without --yes this only',
        '                                shows what would happen and how many bytes',
        '                                — nothing is deleted.',
        '',
        '  A capture can hold thousands of lines. Read a big one in',
        '  windows: --head reports __lines, then --from/--count.',
        '',
        '  The capture does NOT live in the repository — only the record',
        '  does (raw-record.jsonl). Point CHEAP_MEM_ARCHIVE at a folder,',
        '  a mounted NAS share or a synced drive; the default is the tracked raw/',
        '  inside the working tree.',
        '',
        '  What "review" cannot do: filter by TOPIC. A capture carries no topic',
        '  in its metadata — only path, project, surface and session. Finding',
        '  captures by what they are ABOUT would mean a content search over the',
        '  decompressed material, which is a different and bigger feature than a',
        '  review of what exists. Not built here; not silently faked either.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);
    const sub = rest[0];

    if (sub === 'archive') {
      if (args['list-stores']) {
        const found = stores.discover();
        if (args.json) { out(JSON.stringify(found)); return; }
        out('Storage found on this machine:');
        out('');
        for (const s of found) {
          const mark = s.found.length ? 'yes' : ' - ';
          out(`  [${mark}] ${s.id.padEnd(9)} ${s.label}${s.sync ? '  (syncing)' : ''}`);
          // Every known store is listed, including the ones that are not
          // here. "Not installed" and "never looked" are different
          // statements and a list of hits alone cannot tell them apart.
          for (const f of s.found) out(`          ${f}`);
        }
        out('');
        out('  mem raw archive --set <id>        use one of them');
        out('  mem raw archive --set <path>      or name a folder yourself');
        return;
      }

      if (args.set) {
        // Once per machine. After that the stop hook, the watcher and
        // the digest all read the same location without anyone
        // repeating it in four unit files.
        // A store id, or a path. An id that is known but not usable
        // here has to say WHY — "not installed" and "two candidates"
        // need different answers from the user.
        let target = args.set;
        if (stores.STORES.some((s) => s.id === args.set)) {
          const r = stores.resolve(args.set);
          if (!r.ok) {
            if (r.reason === 'needs-path') {
              die(`'${args.set}' means a folder you choose. Name it: mem raw archive --set /some/folder`);
            }
            if (r.reason === 'not-installed') {
              die(`${r.store.label} was not found on this machine.\n`
                + '  Looked in the usual places; see: mem raw archive --list-stores');
            }
            if (r.reason === 'ambiguous') {
              die(`${r.store.label} has more than one location here — pick one explicitly:\n`
                + r.found.map((f) => `  --set "${path.join(f, stores.SUBFOLDER)}"`).join('\n'));
            }
            die(`cannot use '${args.set}': ${r.reason}`);
          }
          target = r.path;
        }

        const g = archive.setLocation(root, target);
        out(`Archive location set: ${g.location}`);
        out(`  recorded in ${path.relative(root, g.file)} (gitignored, does not travel)`);
        out('  write probe passed.');

        // The warning belongs to the SITUATION, not to the command: it
        // fires just as much for someone who typed the Dropbox path by
        // hand as for someone who said --set dropbox.
        const syncing = stores.syncingStoreFor(g.location);
        if (syncing) {
          out('');
          out(`${syncing.label}:`);
          for (const line of stores.SYNC_WARNING) out(`  ${line}`);
        }
        return;
      }
      const store = archive.readConfig(process.env, root);
      // The register also holds tombstones (rows that say "deleted") and
      // captures recorded into ANOTHER machine's store. Neither is a gap
      // in THIS archive: counting them as `missing` made `mem raw
      // archive` abort ("recorded but not reachable") right after any
      // `mem raw delete`. Only a capture that belongs here, is not
      // deleted and has no bytes is missing.
      const registered = new Set(archive.records(root).filter((r) => r?.path).map((r) => r.path));
      const rows = raw.capturesWithState(root).filter((r) => registered.has(r.path));
      let here = 0; let missing = 0; let bytes = 0; let deleted = 0; let elsewhere = 0;
      for (const r of rows) {
        if (r.state === 'present') { here += 1; bytes += r.bytes ?? 0; }
        else if (r.state === 'unreachable') missing += 1;
        else if (r.state === 'deleted') deleted += 1;
        else elsewhere += 1;
      }
      // Legacy = on disk in the repo, never entered in the register.
      const legacy = raw.listCaptures(root).filter((p) => !registered.has(p)).length;
      if (args.json) {
        out(JSON.stringify({ location: store.location, explicit: store.explicit,
          records: rows.length, reachable: here, missing, deleted, elsewhere, bytes, legacy }));
        return;
      }
      out(`Archive: ${store.location}`);
      // WHICH source won, not just THAT one did. Three possible origins,
      // and picking the wrong one looks from outside exactly like
      // picking the right one.
      out(`  source: ${{
        env: 'environment variable CHEAP_MEM_ARCHIVE',
        file: `${archive.LOCATION_FILE} (this machine)`,
        default: 'default (tracked raw/)',
      }[store.source]}`);
      out(`  ${rows.length} records, ${here} reachable, ${missing} NOT reachable`
        + (deleted ? `, ${deleted} deleted` : '')
        + (elsewhere ? `, ${elsewhere} in another machine's store` : ''));
      out(`  ${(bytes / 1048576).toFixed(2)} MB in the archive`);
      if (legacy > 0) out(`  ${legacy} captures still in the repo — pull them with: mem raw migrate`);
      // A missing capture is not cosmetic: the digest then works across
      // gaps without noticing.
      if (missing > 0) die(`${missing} captures are recorded but not reachable. Is the archive mounted?`);
      return;
    }

    if (sub === 'migrate') {
      const store = archive.readConfig(process.env, root);
      const known = new Set(archive.records(root).map((r) => r.path));
      const open = raw.listCaptures(root).filter((p) => !known.has(p));
      if (!open.length) { out('Nothing to migrate — everything is already in the archive.'); return; }
      const res = archive.migrate(store, root, open, { remove: Boolean(args.remove) });
      if (args.json) { out(JSON.stringify(res)); return; }
      out(`${res.done.length} captures pulled into ${store.location}.`);
      for (const s2 of res.skipped) out(`  skipped: ${s2.path} (${s2.reason})`);
      if (!args.remove) {
        out('');
        out('The copies in the repo are still there. Remove them with --remove,');
        out('then: git rm -r --cached raw && git commit');
        out('NOTE: this does NOT shrink the repository. Git keeps its history —');
        out('the move stops the growth, it reclaims nothing.');
      }
      return;
    }

    if (sub === 'export') {
      if (!args.into) die('raw export: --into <dir> is missing');
      const store = archive.readConfig(process.env, root);
      const hit = archive.inRange(archive.records(root), {
        from: args.from, to: args.to,
        hourFrom: args['hour-from'] == null ? null : Number(args['hour-from']),
        hourTo: args['hour-to'] == null ? null : Number(args['hour-to']),
      });
      if (!hit.length) { out('No captures in that range.'); return; }
      fs.mkdirSync(args.into, { recursive: true });
      // A deleted capture (tombstone) and one recorded into another
      // machine's store have no bytes HERE by design. They are named
      // apart and do not fail the export; only a capture that belongs to
      // this store and has lost its bytes is `missing`.
      const states = new Map(raw.capturesWithState(root).map((c) => [c.path, c.state]));
      const written = []; const missing = []; const deleted = []; const elsewhere = [];
      for (const r of hit) {
        const st = states.get(r.path);
        if (st === 'deleted') { deleted.push(r.path); continue; }
        if (st === 'elsewhere') { elsewhere.push(r.path); continue; }
        const data = archive.get(store, root, r.path);
        if (!data) { missing.push(r.path); continue; }
        const target = path.join(args.into, r.path.split(/[/\\]/).join('__').replace(/\.gz$/, ''));
        fs.writeFileSync(target, zlib.gunzipSync(data));
        written.push(target);
      }
      if (args.json) { out(JSON.stringify({ written, missing, deleted, elsewhere })); return; }
      out(`${written.length} captures written to ${args.into}.`);
      if (deleted.length) out(`  ${deleted.length} skipped: deleted (tombstone in the register).`);
      if (elsewhere.length) out(`  ${elsewhere.length} skipped: recorded into another machine's store.`);
      // Do NOT swallow the missing ones: an export that quietly delivers
      // less than it should is the kind of gap later mistaken for
      // "there was never anything there".
      if (missing.length) {
        out('');
        out(`${missing.length} NOT exported — recorded but not reachable:`);
        for (const m of missing) out(`  ${m}`);
        die('Export incomplete. Is the archive mounted?');
      }
      return;
    }

    if (sub === 'pending') {
      const st = raw.pending(root);
      if (args.json) { out(JSON.stringify(st)); return; }
      out(`${st.open.length} pending (${st.bytes} bytes gzipped, ${st.rawBytes} bytes before packing`
        + `${st.rawUnknown ? `, unknown for ${st.rawUnknown} captures` : ''}), ${st.done} digested`);
      if (st.last) out(`  last digest: ${st.last}`);
      for (const f of st.open) out(`  ${f}`);
      return;
    }

    if (sub === 'show') {
      checkFlags(args, ['head', 'from', 'count'], 'raw show');
      const rel = rest[1];
      if (!rel) die('raw show: which capture? (mem raw pending lists them)');
      const { header, lines, broken, state } = raw.readCapture(root, rel);
      const from = args.from === undefined ? 0 : Math.max(0, Number(args.from));
      if (!Number.isFinite(from)) die('raw show: --from needs a number');
      const count = args.count === undefined ? null : Number(args.count);
      if (count !== null && (!Number.isFinite(count) || count <= 0)) {
        die('raw show: --count needs a positive number');
      }
      out(JSON.stringify({ ...(header ?? {}), __lines: lines.length, __state: state, __broken_lines: broken }, null, 2));
      // B21: never silent. ok / partial / broken — on partial and broken
      // the counter also goes to stderr so the digest sees it.
      if (state !== 'ok') {
        process.stderr.write(`-- ${state}: ${broken} line(s) of this capture unreadable (skipped, counted)\n`);
      }
      if (args.head) return;
      const to = count === null ? lines.length : Math.min(lines.length, from + count);
      for (let i = from; i < to; i += 1) process.stdout.write(`${JSON.stringify(lines[i])}\n`);
      if (to < lines.length) {
        process.stderr.write(`-- ${to} of ${lines.length} lines. Continue with: `
          + `--from ${to}${count === null ? '' : ` --count ${count}`}\n`);
      }
      return;
    }

    if (sub === 'check') {
      // Show where old raw material still holds secrets that today's
      // rules would catch. NEVER prints a value: printing it would
      // spread it a second time, into the terminal and the scrollback.
      checkFlags(args, ['json'], 'raw check');
      const captures = raw.listCaptures(root);
      const seen = new Map();
      for (const rel of captures) {
        let lines;
        try { ({ lines } = raw.readCapture(root, rel)); } catch { continue; }
        for (let i = 0; i < lines.length; i += 1) {
          const found = redaction.redact(JSON.stringify(lines[i])).found;
          for (const f of found) {
            const k = `${f.type}|${rel}`;
            if (!seen.has(k)) seen.set(k, { type: f.type, capture: rel, lines: new Set(), count: 0 });
            const g = seen.get(k);
            g.count += f.count;
            g.lines.add(i + 1);
          }
        }
      }
      if (seen.size === 0) { out('Nothing found.'); return; }
      if (args.json) {
        out(JSON.stringify([...seen.values()].map((g) => ({
          type: g.type, capture: g.capture, count: g.count, lines: [...g.lines].slice(0, 20),
        })), null, 2));
        return;
      }
      out(`${seen.size} locations across ${captures.length} captures.`);
      out('Values are deliberately not shown.');
      out('');
      for (const g of [...seen.values()].sort((a, b) => b.count - a.count)) {
        out(`  ${g.type.padEnd(20)} x${String(g.count).padStart(4)}  ${g.capture}`);
        out(`  ${' '.repeat(20)}       lines ${[...g.lines].slice(0, 6).join(', ')}${g.lines.size > 6 ? ' …' : ''}`);
      }
      out('');
      out('To look (the value then appears in your terminal):');
      out('  mem raw show <capture> --from <line-1> --count 1');
      return;
    }

    if (sub === 'digested') {
      const paths = rest.slice(1);
      if (paths.length === 0) die('raw digested: name at least one capture');
      let res;
      try { res = raw.markDigestedWithYield(root, paths, { yield: yieldPerCapture(root, paths) }); }
      catch (e) {
        if (e.code === 'CAPTURE_MISSING' || e.code === 'YIELD_MISSING') die(`raw digested: ${e.message}`);
        throw e;
      }
      out(`${paths.length} marked, ${res.total} captures digested in total.`);
      // Yield visible, the 0 included (E6a): how many entries name these
      // captures in their origin.
      out(`  Yield: ${res.entries} entries from ${paths.length} captures`
        + (res.withoutEntry.length ? `, ${res.withoutEntry.length} without an entry (0)` : ''));
      for (const w of res.withoutEntry) out(`    0 entries: ${w}`);
      if (res.rest > 0) out(`  ${res.rest} captures stay pending, the bell stays.`);
      return;
    }

    if (sub === 'review') {
      checkFlags(args, ['project', 'from', 'to', 'hour-from', 'hour-to', 'json'], 'raw review');
      let rows = raw.capturesWithState(root);

      if (args.project !== undefined) {
        const proj = args.project === 'global' ? null : String(args.project);
        rows = rows.filter((r) => r.project === proj);
      }

      // The time filter is `archive.inRange`, not a second copy of it.
      // That function already decides how a day range and an hour
      // window compose; a review-local reimplementation would eventually
      // disagree with `raw export`'s, and disagreement between two
      // things both called "in range" is worse than either alone.
      if (args.from || args.to || args['hour-from'] != null || args['hour-to'] != null) {
        const inRange = archive.inRange(
          rows.map((r) => ({ path: r.path, ts_to: r.at })),
          {
            from: args.from,
            to: args.to,
            hourFrom: args['hour-from'] == null ? null : Number(args['hour-from']),
            hourTo: args['hour-to'] == null ? null : Number(args['hour-to']),
          },
        );
        const kept = new Set(inRange.map((r) => r.path));
        rows = rows.filter((r) => kept.has(r.path));
      }

      if (args.json) { out(JSON.stringify(rows)); return; }

      // One entry per state in `raw.CAPTURE_STATES`: `capturesWithState`
      // yields four, and a count or a mark table that knows only three
      // prints `[undefined]` for the fourth.
      const counts = Object.fromEntries(raw.CAPTURE_STATES.map((st) => [st, 0]));
      for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
      out(`${rows.length} captures — ${counts.present} present, `
        + `${counts.deleted} deleted, ${counts.unreachable} unreachable, `
        + `${counts.elsewhere} elsewhere`);
      if (!rows.length) { out('(nothing matches the filter)'); return; }
      out('');
      const MARK = { present: ' ', deleted: 'D', unreachable: '!', elsewhere: '>' };
      for (const r of rows) {
        out(`  [${MARK[r.state] ?? '?'}] ${r.path}`);
        out(`        ${r.at ?? 'no timestamp recorded'}  `
          + `project=${r.project ?? '(none)'}  bytes=${r.bytes ?? 'unknown'}`);
        if (r.state === 'deleted') {
          out(`        deleted ${r.deleted.at} by ${r.deleted.by}: ${r.deleted.reason || '(no reason given)'}`);
        }
        if (r.state === 'unreachable') {
          out('        recorded, but the bytes are not there — and nobody said so');
        }
        if (r.state === 'elsewhere') {
          out("        recorded into another machine's store — not readable from here");
        }
      }
      return;
    }

    if (sub === 'delete') {
      checkFlags(args, ['reason', 'by', 'yes', 'json'], 'raw delete');
      const rel = rest[1];
      if (!rel) die('raw delete: which capture? (mem raw review lists them)');
      if (!args.reason || args.reason === true) {
        die('raw delete: --reason "..." is required. '
          + 'A tombstone without one answers "was this deliberate?" with a shrug.');
      }
      const reason = String(args.reason);
      const by = args.by && args.by !== true ? String(args.by) : memory.agentDefault();

      // Same lookup `raw review` uses — one truth about a path's state,
      // not a second one built for this command.
      const row = raw.capturesWithState(root).find((r) => r.path === rel);
      if (!row) die(`raw delete: no capture '${rel}' in the register. mem raw review lists what exists.`);

      if (row.state === 'deleted') {
        out(`Already deleted: ${rel}`);
        out(`  at: ${row.deleted.at}   by: ${row.deleted.by}   reason: ${row.deleted.reason}`);
        return;
      }

      const store = archive.readConfig(process.env, root);
      const file = archive.filePath(store, root, rel);
      let bytes = 0;
      if (file) { try { bytes = fs.statSync(file).size; } catch { bytes = 0; } }

      // Irreversible, so without --yes this ONLY shows what would
      // happen. A command that vaporises real bytes on a bare invocation
      // is exactly the shape this file's own header warns against.
      if (!args.yes) {
        out(`Would delete: ${rel}   (currently: ${row.state})`);
        out(`  bytes: ${bytes}`);
        out(`  reason: ${reason}`);
        out(`  by: ${by}`);
        out('');
        out('This removes the BYTES from the archive, outside git — it cannot be undone.');
        out('Nothing was deleted. Pass --yes to go through with it.');
        return;
      }

      let r;
      try { r = archive.remove(store, root, rel, { reason, by, now: new Date() }); }
      catch (e) { die(`raw delete: ${e.message}`); }
      if (args.json) { out(JSON.stringify(r)); return; }
      out(`Deleted: ${rel}`);
      out(`  freed: ${r.freed} bytes`);
      out(`  at: ${r.at}`);
      return;
    }
    die(`raw: unknown subcommand '${sub}'. Known: pending, show, digested, check, review, delete`);
  },

  'raw-capture': async ({ args }) => {
    // Used by the mem-capture Stop hook. Separate from `raw` so the
    // hook path stays a single, obvious call with no subcommand
    // parsing between it and the work.
    if (isHelp(args)) {
      out('mem raw-capture --transcript <path> [--min-bytes N] [--project X]');
      return;
    }
    checkFlags(args, ['transcript', 'min-bytes', 'project', 'json'], 'raw-capture');
    const root = findRoot(args);
    requireConfig(root);
    const transcript = args.transcript;
    if (!transcript) die('raw-capture: --transcript is required');
    const r = raw.capture(root, transcript, {
      minBytes: args['min-bytes'] ? Number(args['min-bytes']) : 4096,
      stampExtra: args.project ? { project: args.project } : {},
    });
    if (args.json) { out(JSON.stringify(r)); return; }
    if (r.status === 'captured') {
      out(`captured ${r.path} (${r.lines} lines, ${r.bytes} bytes)`);
      if (r.redacted.length) {
        out(`  redacted: ${r.redacted.map((x) => `${x.type} x${x.count}`).join(', ')}`);
      }
      return;
    }
    if (r.status === 'nothing') { out(`nothing new (${r.reason ?? `${r.fresh} < ${r.threshold} bytes`})`); return; }
    die(`capture failed: ${r.reason} — ${r.detail ?? ''}`);
  },

  // **Not `setup`.** The name was taken — `mem setup <agent>` wires the
  // memory up to an agent. On 2026-09-08 I defined it a second time; a
  // duplicate object key wins silently, and the help kept showing the
  // old command. The same class as the sibling project's duplicated
  // command on the same day.
  //
  // Caught by the eslint rule `no-dupe-keys`, one hour after it was
  // added — the new linter's first real find.
  //
  // `setup` INSTALLS, `status` REPORTS. Two verbs, two commands.
  shrink: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem shrink [--json] [--no-write]',
        'mem shrink --new-baseline --why "..."',
        '',
        '  An append-only memory must not get smaller. If it does,',
        '  something happened that nobody wanted — an overwritten clone,',
        '  a half-finished migration, a `>` where a `>>` belonged. Nobody',
        '  notices: a smaller memory answers just as willingly, it just',
        '  knows less.',
        '',
        '  The comparison is against the BASELINE — the highest level',
        '  each book ever had — not against a number out of the air. The',
        '  baseline only ratchets upwards.',
        '',
        '  There is no tolerance. In an append-only file one missing byte',
        '  is already an event nobody ordered.',
        '',
        '  --new-baseline  the ONE honest case: after a digest a book is',
        '                  smaller and should stay so. That is declared,',
        '                  not guessed — with --why, so a declared digest',
        '                  can be told from silent damage afterwards.',
        '',
        '  exit 0 calm or first run · 2 alarm · 3 unknown (baseline unreadable)',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json', 'no-write', 'new-baseline', 'why', 'root'], 'shrink');
    const root = findRoot(args);
    const shrink = await import('../../shrink.mjs');
    if (args['new-baseline']) {
      if (typeof args.why !== 'string' || !args.why.trim()) {
        die('shrink --new-baseline needs --why "..." — a lowered baseline '
          + 'without a reason cannot be told from silent damage.');
      }
      const st = shrink.setBaseline(root, shrink.bookSizes(root), { why: args.why });
      out(`Baseline set anew over ${Object.keys(st.books).length} books.`);
      out(`Reason: ${st.why}`);
      return;
    }
    const f = shrink.run(root, { write: !args['no-write'] });
    if (args.json) out(JSON.stringify(f, null, 2));
    else out(shrink.asText(f));
    if (f.state === shrink.STATE.ALARM) process.exitCode = 2;
    if (f.state === shrink.STATE.UNKNOWN) process.exitCode = 3;
  },

  // N4 (cheap-mem parity for lucky-mem's nutzerverstaendnis.mjs):
  // a GENERIC, English, config-driven habit meter over the human
  // user's own captures. No participant name and no phrase belonging
  // to any one person lives here — the four shipped defaults are
  // generic (delegated decision, correction, pasted terminal output,
  // language) and every deployment can point at its own pattern file.
  user: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem user [--json] [--min-evidence N] [--patterns <file.json>]',
        'mem user --self-test [--patterns <file.json>]',
        'mem user --session-start [--min-evidence N]',
        '',
        '  A code-only habit meter over YOUR OWN captured transcripts',
        '  (the same material `mem raw` holds) — no model, no network,',
        '  no name baked in. Each habit is a regex loaded from a JSON',
        '  pattern file: name, regex, a positive AND a negative example,',
        '  and the action line a session should take. Four generic',
        '  defaults ship in src/user-patterns.default.json (delegated',
        '  decision, correction of the assistant, pasted terminal',
        '  output merged with the prompt, language). Point at your own:',
        '  --patterns <file.json>, env CHEAP_MEM_USER_PATTERNS, or',
        '  .mem/config.json\'s "userHabitPatterns" — whichever wins is',
        '  applied the same way every time.',
        '',
        '  Every observation is one of three states, never a bare 0:',
        '    measured             >= --min-evidence hits, with a',
        '                         located first/last quote (capped at',
        '                         120 chars, redacted).',
        '    too_little_evidence  some hits, below the threshold —',
        '                         honestly little, not an error.',
        '    unknown               NO capture on this machine is',
        '                         readable (archive not mounted, fresh',
        '                         install) — never reported as 0.',
        '',
        '  --self-test        every pattern against its own positive/',
        '                     negative examples — needs neither a root',
        '                     nor a capture.',
        '  --session-start    at most 5 lines for a SessionStart hook:',
        '                     only patterns/metrics over the (higher)',
        '                     display threshold AND actionable — "UTC',
        '                     hour-of-day" is measured but never shown',
        '                     here, because a session cannot decide',
        '                     WHEN it is called. cheap-mem\'s own',
        '                     SessionStart path is',
        '                     install/hooks/session-start.sh; wiring',
        '                     this in needs exactly one added line:',
        '                       node "$CHEAP_MEM_ROOT/bin/mem" user --session-start',
        '                     (not added by this command — that file is',
        '                     someone else\'s to touch; this prints',
        '                     exactly what that line would inject).',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json', 'min-evidence', 'patterns', 'self-test', 'session-start'], 'user');
    const patternsPath = args.patterns && args.patterns !== true
      ? path.resolve(String(args.patterns)) : null;

    if (args['self-test']) {
      let patterns;
      try { patterns = userhabits.loadPatterns(patternsPath); }
      catch (e) { die(`user --self-test: ${e.message}`); }
      const { ok, errors } = userhabits.checkAllExamples(patterns);
      if (args.json) { out(JSON.stringify({ ok, errors })); return; }
      if (!ok) die(`Failed:\n${errors.map((e) => `  ${e}`).join('\n')}`);
      out(`All examples passed for ${patterns.length} pattern(s).`);
      return;
    }

    const root = findRoot(args);
    requireConfig(root);

    let minEvidence;
    if (args['min-evidence'] !== undefined) {
      minEvidence = Number(args['min-evidence']);
      if (!Number.isFinite(minEvidence)) die('user: --min-evidence needs a number');
    }

    if (args['session-start']) {
      let sp;
      try {
        sp = userhabits.sessionStartLines(root, {
          minEvidence: minEvidence ?? userhabits.MIN_EVIDENCE_DISPLAY, patternsPath,
        });
      } catch (e) { die(`user --session-start: ${e.message}`); }
      if (args.json) { out(JSON.stringify(sp)); return; }
      for (const l of sp.lines) out(l);
      return;
    }

    let r;
    try {
      r = userhabits.analyze(root, {
        minEvidence: minEvidence ?? userhabits.MIN_EVIDENCE_MEASURE, patternsPath,
      });
    } catch (e) { die(`user: ${e.message}`); }

    if (args.json) { out(JSON.stringify(r)); return; }

    if (r.capturesReadable === 0) {
      out(`unknown — ${r.reason}`);
      return;
    }

    out(`${r.total} real message(s) across ${r.capturesReadable} readable capture(s)`
      + `${r.capturesUnreadable ? `, ${r.capturesUnreadable} not readable` : ''}`
      + `${r.capped ? ' — time cap hit, incomplete' : ''}.`);
    out('');
    for (const o of r.observations) {
      if (o.state === userhabits.STATE.UNKNOWN) { out(`  ${o.title}: unknown`); continue; }
      if (o.state === userhabits.STATE.TOO_LITTLE_EVIDENCE) {
        out(`  ${o.title}: too_little_evidence (${o.count ?? 0}/${o.total ?? r.total})`);
        continue;
      }
      const extra = o.kind === 'metric'
        ? (o.median !== undefined
          ? `median ${o.median}`
          : `main hours: ${o.mainHours?.length ? o.mainHours.map((h) => `${h}h`).join(', ') : 'none'}`)
        : `${o.count}/${o.total} (${(o.share * 100).toFixed(1)}%)`;
      out(`  ${o.title}: measured — ${extra}`);
      if (o.first) out(`    first: ${o.first.path}:${o.first.line} — "${o.first.quote}"`);
      if (o.last) out(`    last:  ${o.last.path}:${o.last.line} — "${o.last.quote}"`);
      if (o.action) out(`    -> ${o.action}`);
    }
  },

};

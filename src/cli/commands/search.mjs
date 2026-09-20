/**
 * Getting something back out: the retrieval lanes and the ways to look.
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
import * as raw from '../../raw.mjs';
import * as thesaurus from '../../thesaurus.mjs';
import * as retrieval from '../../retrieval.mjs';
import * as capability from '../../capability.mjs';
import * as embedmod from '../../embed/index.mjs';
import * as hybrid from '../../hybrid.mjs';
import * as timeexpr from '../../timeexpr.mjs';
import * as browse from '../../browse.mjs';
import * as observations from '../../observations.mjs';
import { out, die, warn, checkFlags, isHelp, findRoot, requireConfig } from '../shell.mjs';
import { asOfOf, sinceOf, showWindow, compactLine, markedEntry, sanitizeForDisplay } from '../display.mjs';

/** 13 commands. */
export const COMMANDS = {
  find: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem find "<query>" [--type <t>] [--project <name>|global]',
        '          [--since 7d|24h|ISO] [--as-of <ISO>] [--top N] [--literal]',
        '          [--fresh] [--no-raw] [--only-raw]',
        '',
        '  Ranked search, no model, no network. BM25 over weighted',
        '  fields, widened by a curated thesaurus and by a tag graph',
        '  learned from your own entries.',
        '',
        '  A query that names a time ("yesterday afternoon", "last friday',
        '  3-8pm", "last 12 hours") becomes time-range recall (see `mem when`).',
        '  --literal and --since bypass that.',
        '',
        '  --as-of    what HELD then, not what is recorded now. Drops entries',
        '             whose valid_from/valid_until put them outside that moment,',
        '             AND entries a later correction had not superseded yet at',
        '             that moment (supersession derives an effective valid_until',
        '             — see `mem log --help` on --valid_until).',
        '             Same rule as `mem retrieve --as-of`; it had it, find did not.',
        '  --literal  plain substring search instead (the old behaviour)',
        '  --fresh    rebuild the index instead of using the cache',
        '  --no-raw   digested entries only, skip raw captures',
        '  --no-mmr   pure BM25 order (default re-ranks the top for diversity)',
        '  --brief    id + a compact label per hit, no bodies — the first',
        '             stage of a two-stage recall. Then: mem show <id>',
        '  --with-echo  keep hits that merely repeat the question (default: dropped)',
        '  --mmr-lambda F  0..1, higher = more relevance, lower = more diversity (default 0.7)',
        `  --type     one of ${Object.keys(memory.TYPES).join(', ')}`,
      ].join('\n'));
      return;
    }
    checkFlags(args, ['type', 'project', 'since', 'as-of', 'top', 'literal', 'fresh',
      'no-raw', 'only-raw', 'json', 'with-retired', 'brief', 'no-mmr', 'mmr-lambda',
      'content-words', 'with-echo'], 'find');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    let query = rest[0];
    if (!query) die("find: no query. Example: mem find 'flaky ci'");

    // --content-words: pull the carrying words out of a SPOKEN question,
    // ranked by rarity in the index, at most eight. The retrieval hook
    // uses this — before 2026-09-05 it got the user's whole message, and
    // in a 45-word sentence the technical term drowns in connective
    // tissue. Not the default: whoever types `mem find "..."` by hand has
    // already chosen the words.
    const askedAs = query;
    if (args['content-words']) {
      const shortened = search.retrievalQuery(query, { root });
      if (shortened && shortened !== query) query = shortened;
    }
    const since = args.since ? sinceOf(args.since) : null;
    // **Until 2026-09-17 `--as-of` existed only on `mem retrieve`.** The
    // same question — "what held THEN" — therefore depended on which
    // command you typed: `retrieve` filtered by valid_from/valid_until,
    // `find` answered with today's state. Two truths, one per door.
    //
    // The rule still lives in ONE place (`retrieval.validAt`); this only
    // applies it, it does not reimplement it.
    const asOf = args['as-of'] ? asOfOf(args['as-of'], 'find') : null;

    // Time router: if the query names a window ("yesterday afternoon", "last
    // friday between 3 and 8pm", "last 12 hours"), it becomes time-range
    // retrieval instead of keyword search — so recall triggers on language,
    // not on a typed command. Because mem-retrieve calls `mem find`, this
    // applies to the hook too. --literal and --since bypass it.
    if (!args.literal && !args.since) {
      const zone = process.env.MEM_TZ || cfg.timezone || undefined;
      const window = timeexpr.windowFor(query, { zone });
      if (window) { showWindow(root, query, window, args, { asOf }); return; }
    }

    if (args.literal) {
      const types = args.type ? [args.type] : Object.keys(memory.TYPES);
      // P13 wiring, the CLI half. `memory.find` takes no Capability (it
      // is off limits for this change), so the lattice-aware answer is
      // reached the only way available here: by choosing WHICH drawers
      // get read. A real project name reads that project's drawer PLUS
      // `global`, because global is the lattice ROOT that every scope
      // inherits (see `capability.mjs`'s `admits()`), not a sibling a
      // project search may leave out. `--project global` keeps its
      // narrower, literal meaning: the global drawer only. No
      // `--project`: every drawer, unchanged.
      //
      // Measured before this line existed (2026-09-20): `mem find X
      // --literal --project beta` returned beta only, while the SAME
      // question asked through the MCP bridge (`mem_find`, literal:true,
      // project:"beta") returned global AND beta. One lane, two answers,
      // depending on which door you came through. That is the
      // `two-truths` class, and it is why this lane is spelled here
      // identically to `bin/mem-mcp`'s literal branch.
      const projects = args.project
        ? (args.project === 'global' ? [null] : [null, args.project])
        : null;
      const withRetiredFlag = Boolean(args['with-retired']);
      // `--as-of` opens the retired gate at the CANDIDATE stage too — a
      // superseded entry has to reach `validAt` before it can be judged
      // by time, and `memory.find` drops it earlier than that when
      // `withRetired` is false. `retrieval.blocksRecall` (below) still
      // keeps `done`/`discarded`/`obsolete`/`disputed` out unless
      // `--with-retired` was actually asked for — `--as-of` was never a
      // request to see those.
      const allHits = memory.find(root, query, {
        types, projects, since, withRetired: withRetiredFlag || Boolean(asOf),
      });
      // Here too, not only in the ranked lane. `--literal --as-of` must
      // mean the same as `--as-of` alone, or the answer to "what held
      // then" depends on which search lane you happened to land in.
      const hits = allHits.filter((h) => !retrieval.blocksRecall(h._retired, withRetiredFlag)
        && (!asOf || retrieval.validAt(h, asOf)));
      // Same envelope as the ranked branch, so a tool can read both the
      // same way. `--literal --json` silently printed prose until
      // 2026-09-08: the flag was simply never looked at in this branch,
      // and a consumer got something that LOOKS like output and is not
      // JSON. Ported from lucky-mem, where the pre-edit hook needs it.
      //
      // `score` is deliberately null: the literal lane has no rank. A
      // consumer that applies a threshold here should fail on null
      // rather than on an invented number. `literal: true` says it too.
      if (args.json) {
        out(JSON.stringify(sanitizeForDisplay({
          query,
          literal: true,
          asOf,
          hits: hits.map((h) => ({
            id: h.id ?? null,
            score: null,
            source: h._source,
            line: h._line,
            ts: h.ts ?? null,
            state: h._retired?.state ?? null,
            label: compactLine(h) || '',
          })),
        }), null, 2));
        return;
      }
      // Three states, not two: "found nothing" and "found something that
      // did not hold then" are different answers.
      if (hits.length === 0) {
        out(asOf && allHits.length
          ? `Nothing for '${query}' as of ${asOf} (${allHits.length} hit${
            allHits.length === 1 ? '' : 's'} exist, none valid then).`
          : `Nothing for '${query}'.`);
        return;
      }
      out(`${hits.length} literal hits for '${query}'${
        asOf ? ` as of ${asOf} (${allHits.length - hits.length} not valid then)` : ''}:`);
      for (const h of hits) {
        const mark = h._retired ? `  [${h._retired.state}]` : '';
        out(`  ${h._source}:${h._line}  [${h.ts ?? '?'}]  ${compactLine(h)}${mark}`);
      }
      return;
    }

    thesaurus.loadUserGroups(root, fs, path);
    const t0 = Date.now();
    const index = search.loadIndex(root, { fresh: Boolean(args.fresh), language: cfg.language });
    const wanted = args.top ? Number(args.top) : 10;
    const withRetiredFlag = Boolean(args['with-retired']);
    // `--as-of` needs superseded candidates to survive to `heldThen`
    // below — `retrieval.blocksRecall` is what keeps the OTHER retired
    // states (done/discarded/obsolete/disputed) hidden even though the
    // gate just opened for them too. See that function's docstring.
    const withRetiredForFetch = withRetiredFlag || Boolean(asOf);
    // P13 wiring: a `--project` arg now mints a Capability instead of
    // relying on the bare string comparison in `admits()`. Scoped to
    // exactly the named project, no descendants of its own — see
    // `capability.mjs`'s `admits()` for why a project capability still
    // sees `global` entries anyway (global is the lattice root, which
    // every scope inherits — it is not a sibling that needs descendants
    // to reach). With no `--project`, `findCapability` stays null and
    // both lanes below behave exactly as before this change.
    const findCapability = args.project ? capability.grantProject(args.project) : null;
    const hits0 = search.search(index, query, {
      // Fetch wider, so enough remains after filtering.
      top: args['with-echo'] ? wanted : wanted * 3,
      type: args.type ?? null,
      project: args.project ?? null,
      capability: findCapability,
      since,
      noRaw: Boolean(args['no-raw']),
      onlyRaw: Boolean(args['only-raw']),
      withRetired: withRetiredForFetch,
      language: cfg.language,
      // MMR on by default: keep the top-k from filling with near-duplicates.
      // --no-mmr restores pure BM25 order.
      mmr: !args['no-mmr'],
      mmrLambda: args['mmr-lambda'] ? Number(args['mmr-lambda']) : 0.7,
    });
    // Drop the echo: the retrieval hook runs on every message and the stop
    // hook files every message as a raw capture, so the best hit for a
    // similar question is the user's own sentence from before. Measured on
    // 2026-09-05: 13 of 18 injected hits.
    // The decision of WHAT counts as an echo lives in search.isEchoHit —
    // the same call as in the gateway. Until 2026-09-06 there was a
    // separate version here that called `raw.excerpt`; that function
    // never existed, and every search that hit a raw capture crashed.
    // Nobody noticed, because it only sat behind `--no-echo` and nobody
    // set `--no-echo`. Exactly the class test/paths-agree.test.mjs
    // guards against.
    // Default: filter. Until 2026-09-06 this sat behind `--no-echo`, and
    // NOBODY set it — not even the retrieval hook, which is what
    // measured the 13 of 18. A defence that has to be switched on and
    // that nobody switches on is not a defence. `--with-echo` restores
    // the old behaviour.
    // Raw capture only: a typed entry is not the user's own question.
    // Without this restriction a short decision filed in the user's own
    // words gets dropped — measured on "payment only by prepayment"
    // against the question "payment prepayment decision".
    const filtered = args['with-echo']
      ? hits0
      : hits0.filter((h) => !search.isEchoHit(askedAs, h));
    // The exact lane, as in the gateway. If the question names an
    // identifier that appears in at most `wanted` entries, that entry
    // goes to the front — independent of score. This is exactly why the
    // rule lives in `search.exactHits` and not here: `mem find` and
    // `retrieve()` have already diverged twice (see
    // test/paths-agree.test.mjs).
    // With the same bounds as the ranked search above. Until 2026-09-17
    // this lane took none — and because `mem find` merges it in FRONT,
    // --project, --type and --with-retired were not merely weakened but
    // overridden. The retrieval hook runs over exactly this path.
    const exactMatches = search.exactHits(index, query, wanted, {
      type: args.type ?? null,
      project: args.project ?? null,
      capability: findCapability,
      since,
      noRaw: Boolean(args['no-raw']),
      onlyRaw: Boolean(args['only-raw']),
      withRetired: withRetiredForFetch,
    });
    const exactIds = new Set(exactMatches.map((h) => h.entry?.id).filter(Boolean));
    // **BEFORE the cut, and on BOTH lanes.**
    //
    // Filtering after `.slice(0, wanted)` cannot bring back what the cut
    // already threw away — the same mistake was in the first version of
    // the body de-duplication in retrieval.mjs.
    //
    // And the exact lane needs it just as much: it is merged in FRONT,
    // so a filter on the ranked lane alone would not merely be weakened,
    // it would be overruled. That is exactly what happened here on
    // 2026-09-17 for --project/--type (see the comment above); repeating
    // it one line further down would be absurd.
    const heldThen = (h) => !retrieval.blocksRecall(h.retired, withRetiredFlag)
      && (!asOf || retrieval.validAt({ ...(h.entry ?? h), retired: h.retired ?? null }, asOf));
    const hits = [...exactMatches.filter(heldThen),
      ...filtered.filter((h) => !exactIds.has(h.entry?.id)).filter(heldThen)]
      .slice(0, wanted);
    const ms = Date.now() - t0;

    if (args.json) {
      // --brief is the first stage of a two-stage recall: id + a compact
      // label + score, NOT the full entry. The caller scans these cheaply
      // and pulls only the ones it wants with `mem show <id>`. Measured
      // on a real corpus this cut broad-query tokens ~63% vs full hits.
      if (args.brief) {
        const brief = hits.map((h) => ({
          id: h.entry.id ?? null,
          score: h.score,
          source: h.source,
          line: h.line,
          ts: h.entry.ts ?? null,
          label: compactLine(h.entry),
          ...(h.retired ? { state: h.retired.state } : {}),
        }));
        out(JSON.stringify({ query, ms, asOf, hits: brief }, null, 2));
        return;
      }
      // `asOf` is IN the envelope even when null. A consumer has to be
      // able to see whether filtering happened — a missing field reads as
      // "not filtered" and as "older version of the tool" at the same
      // time.
      out(JSON.stringify(sanitizeForDisplay({
        query, ms, asOf, hits: hits.map((h) => ({ ...h, entry: markedEntry(h.entry) })),
      }), null, 2));
      return;
    }
    if (hits.length === 0) {
      out(asOf
        ? `Nothing for '${query}' as of ${asOf} (${index.N} entries, ${ms}ms).`
        : `Nothing for '${query}' (${index.N} entries, ${ms}ms).`);
      out('  Try --literal for a plain substring search.');
      return;
    }
    out(`${hits.length} hits for '${query}'${asOf ? ` as of ${asOf}` : ''} (${index.N} entries, ${ms}ms):`);
    for (const h of hits) {
      const mark = (h.raw ? (h.pending ? '  [raw, not yet digested]' : '  [raw]') : '')
        + (h.retired ? `  [${h.retired.state}]` : '');
      out(`  ${h.source}:${h.line}  [${h.entry.ts ?? '?'}]  ${h.score.toFixed(2)}${mark}`);
      // compactLine() already neutralises the digested branch; the raw-
      // capture branch reads straight from the un-digested transcript
      // (raw.snippet / the raw entry's own .text) and never passed
      // through compactLine at all, so it needs its own call here.
      const preview = h.raw
        ? sanitizeForDisplay(String(raw.snippet(root, h.source, query) || h.entry.text || ''))
        : compactLine(h.entry);
      out(`    ${String(preview).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  },

  'find-embed': async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem find-embed "<query>" [--top N] [--type T] [--project P] [--since 7d]',
        '',
        '  Semantic search over the vector store. Needs `mem embed setup`',
        '  and a backfill first. For everything else use `mem find` — it',
        '  is faster, free, and works offline.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['top', 'type', 'project', 'since'], 'find-embed');
    const root = findRoot(args);
    requireConfig(root);
    const query = rest[0];
    if (!query) die('find-embed: no query.');

    const store = await import('../../embed/store.mjs');
    const cfg = embedmod.readConfig(root);
    const dim = embedmod.dimensions(cfg.provider, cfg.model);

    let vector;
    try { vector = await embedmod.embed(root, query, { cfg }); }
    catch (e) {
      if (e.code === 'NO_KEY') {
        die(`find-embed: ${e.message}\n  Or just use: mem find "${query}"`);
      }
      die(`find-embed: ${e.message}`);
    }

    const db = await store.open(root, dim);
    try {
      const hits = store.search(db, vector, {
        top: args.top ? Number(args.top) : 5,
        type: args.type ?? null,
        project: args.project ?? null,
        since: args.since ? sinceOf(args.since) : null,
      });
      if (hits.length === 0) {
        out(`Nothing for '${query}' (${store.count(db)} embedded entries).`);
        return;
      }
      out(`${hits.length} semantic hits for '${query}':`);
      for (const h of hits) {
        out(`  ${h.source_file}:${h.line_number}  [${h.ts}]  ${h.score.toFixed(3)}`);
        out(`    ${sanitizeForDisplay(String(h.text)).replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    } finally { try { db.close(); } catch { /* fine */ } }
  },

  'find-hybrid': async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem find-hybrid "<query>" [--top N] [--fresh]',
        '',
        '  BM25 and semantic recall, fused (Reciprocal Rank Fusion). It uses',
        '  embeddings only when `mem embed setup` + a backfill were run;',
        '  without them it is exactly `mem find`, at the same cost. Best for a',
        '  paraphrase that shares no word with the entry you want.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['top', 'fresh'], 'find-hybrid');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    const query = rest[0];
    if (!query) die('find-hybrid: no query.');

    thesaurus.loadUserGroups(root, fs, path);
    const index = search.loadIndex(root, { fresh: Boolean(args.fresh), language: cfg.language });
    const semantic = await hybrid.makeSemantic(root);
    const t0 = Date.now();
    const fused = await hybrid.hybridSearch(index, query, {
      top: args.top ? Number(args.top) : 10,
      semantic,
    });
    const ms = Date.now() - t0;

    // Honest label: report what actually happened, not what was configured.
    // A configured provider whose store is empty or whose key is missing
    // yields no semantic hits and must not be advertised as "hybrid".
    const usedSemantic = fused.some((f) => f.found_by.includes('semantic'));
    const mode = usedSemantic
      ? 'hybrid: bm25 + semantic'
      : 'bm25 only — run `mem embed setup` + backfill to add semantic';
    if (fused.length === 0) { out(`Nothing for '${query}' (${mode}, ${ms}ms).`); return; }
    out(`${fused.length} hits for '${query}' (${mode}, ${ms}ms):`);
    for (const f of fused) {
      const h = f.hit;
      const src = h.source ?? h.source_file;
      const line = h.line ?? h.line_number;
      const ts = h.entry?.ts ?? h.ts ?? '?';
      const preview = h.entry ? compactLine(h.entry) : sanitizeForDisplay(String(h.text ?? ''));
      out(`  ${src}:${line}  [${ts}]  [${f.found_by.join('+')}]`);
      out(`    ${String(preview).replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  },

  retrieve: async ({ rest, args }) => {
    if (isHelp(args) || !rest.length) {
      out([
        'mem retrieve "<question>" [--project <p>] [--type <t>] [--top <n>]',
        '                          [--as-of <iso>] [--with-disputed] [--json]',
        '',
        '  Every answer ends with a coverage line: known_complete,',
        '  known_partial (with the limits that bit), or unknown_coverage.',
        '  Complete means no limit cut THIS answer — never that nothing',
        '  else exists. Found evidence is not complete evidence, and no',
        '  finding is not proof of absence.',
        '',
        '  Structured claims, not a paragraph. Each carries who asserted it,',
        '  at what authority, in which scope, and whether it still holds.',
        '',
        '  Scope is a BOUNDARY here, not a filter: without --project you get',
        '  what this session may see, and there is no argument that widens it.',
        '',
        '  --as-of        what held THEN, not what is recorded now',
        '  --with-disputed  include claims whose supersession was refused',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['project', 'type', 'top', 'as-of', 'with-disputed', 'json'], 'retrieve');
    const root = findRoot(args);
    requireConfig(root);
    const cap = args.project
      ? capability.grantProject(String(args.project), { subject: 'cli' })
      : capability.grantAll('cli');
    const r = retrieval.retrieve(root, rest.join(' '), cap, {
      top: args.top ? Number(args.top) : 10,
      asOf: args['as-of'] ? asOfOf(args['as-of'], 'retrieve') : null,
      type: args.type ? String(args.type) : null,
      withDisputed: Boolean(args['with-disputed']),
    });
    // An OBSERVATION only — what was shown, when, through which lane.
    // Written strictly AFTER retrieval.retrieve() has already decided
    // the claims and their order, so nothing computed above this line
    // can see it. Best-effort: a full disk or a read-only mount must
    // never turn an audit trail into an outage of the thing it audits.
    try {
      observations.record(root, { lane: 'retrieve', ids: r.claims.map((c) => c.id), query: r.query });
    } catch { /* observation lost, retrieval unaffected — see src/observations.mjs */ }
    if (args.json) { out(JSON.stringify(sanitizeForDisplay(r), null, 2)); return; }
    if (!r.claims.length) {
      out(`No claims for '${r.query}' within ${r.scopes.join(' ') || '(no scope)'}.`);
    }
    for (const c of r.claims) {
      out(`${c.id}  [${c.authority}${c.author ? '/' + c.author : ''}]  ${c.scope}  `
        + `${c.ts ?? '?'}  ${c.score.toFixed(2)}${c.bodyTruncated ? '  (body truncated)' : ''}`);
      out(`  ${sanitizeForDisplay(c.body).replace(/\s+/g, ' ')}`);
    }
    if (r.excluded.length) {
      warn(`${r.excluded.length} excluded — mem explain <id> says why`);
    }
    if (r.hasMore) {
      out('');
      out(`More match than the ${r.claims.length} shown. Ask with a larger --top.`);
      out('  There is no cursor: paging would have to widen the selection, and the');
      out('  selection is where the diversity and author-share latches do their work.');
    }

    // **The coverage line, and why it is printed even when it is good
    // news.** An empty answer and a complete answer look identical on a
    // terminal, and the difference between them is the difference
    // between "we found nothing" and "there is nothing". Printing it
    // only when something was cut would teach people that silence means
    // completeness — the exact reading this field exists to prevent.
    out('');
    const cov = r.coverage ?? { state: 'unknown_coverage', reasons: [] };
    if (cov.state === 'known_complete') {
      out('Coverage: known_complete — no limit cut this answer.');
      out('  That is NOT proof that nothing else exists: a different question');
      out('  asks a different search space.');
    } else if (cov.state === 'known_partial') {
      out('Coverage: known_partial — this answer was cut:');
      for (const why of cov.reasons) out(`    ${why.why}`);
    } else {
      out('Coverage: UNKNOWN — the search space could not be established:');
      for (const why of cov.reasons) out(`    ${why.why}`);
      out('  Draw no conclusion from what is missing here.');
    }
  },

  explain: async ({ rest, args }) => {
    if (isHelp(args) || rest.length < 2) {
      out([
        'mem explain "<question>" <claim-id> [--project <p>] [--json]',
        '',
        '  Why a NAMED claim did or did not come back: rank and score if it',
        '  did, the exclusion reason if it did not.',
        '',
        '  This is the half of explainability nothing else offers, and it is',
        '  deterministic — no model, and nothing computed that the ranker did',
        '  not compute anyway.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['project', 'json'], 'explain');
    const root = findRoot(args);
    requireConfig(root);
    const id = rest[rest.length - 1];
    const q = rest.slice(0, -1).join(' ');
    const cap = args.project
      ? capability.grantProject(String(args.project), { subject: 'cli' })
      : capability.grantAll('cli');
    const r = retrieval.explainMissing(root, q, cap, id);
    if (args.json) { out(JSON.stringify(sanitizeForDisplay(r), null, 2)); return; }
    out(r.returned
      ? `${id}: returned at rank ${r.rank}, score ${r.score.toFixed(4)}`
      : `${id}: not returned — ${r.reason}`);
  },

  when: async ({ rest, args }) => {
    if (args.help) {
      out([
        'mem when "<time expression>" [--raw] [--project X] [--tz IANA/Zone]',
        'mem when --from <ISO> --to <ISO> [--raw] ...',
        '',
        '  Time-range recall, no model. Natural language (system zone by',
        '  default, or --tz / MEM_TZ / config.timezone):',
        '    "yesterday afternoon", "last friday between 3 and 8pm",',
        '    "last 12 hours", "2026-08-29 from 15:00 to 20:00".',
        '  Shows the digested entries in the window.',
        '  --raw: also the redacted raw conversation lines in the window.',
        '  --json: stable contract (same shape as find --json).',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['from', 'to', 'project', 'raw', 'raw-max', 'json', 'tz'], 'when');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    const text = rest.join(' ').trim();
    const zone = args.tz || process.env.MEM_TZ || cfg.timezone || undefined;
    let window = null;
    if (args.from || args.to) {
      const from = args.from ? new Date(args.from) : new Date(0);
      const to = args.to ? new Date(args.to) : new Date();
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        die('when: --from/--to must be an ISO time (e.g. 2026-08-29T15:00Z)');
      }
      window = { from, to, label: `${args.from ?? 'start'} .. ${args.to ?? 'now'}` };
    } else if (text) {
      window = timeexpr.windowFor(text, { zone });
      if (!window) {
        die(`when: no time expression in '${text}'. Examples: "yesterday afternoon",`
          + ' "last friday 3-8pm" — or --from/--to ISO.');
      }
    } else {
      die('when: missing time. A phrase ("yesterday afternoon") or --from/--to.');
    }
    showWindow(root, text, window, args);
  },

  show: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem show <id> [--json]',
        "",
        "  Second stage of retrieval: fetch the FULL entry for an id.",
        "  `find --brief` returns compact hits (id + label); pull the full",
        "  text of the one you want here, instead of every hit landing full",
        "  in the prompt. Saves tokens on broad queries.",
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json'], 'show');
    const root = findRoot(args);
    requireConfig(root);
    const id = rest[0];
    if (!id) die('show: which id? Example: mem show a1b2c3');
    const e = memory.getEntry(root, id);
    if (!e) die(`show: id '${id}' not found (or retired/tombstone).`);
    if (args.json) { out(JSON.stringify(sanitizeForDisplay(markedEntry(e)))); return; }
    out(`${e._source}  [${e.ts ?? '?'}]  id=${e.id}`);
    for (const [k, v] of Object.entries(e)) {
      if (k.startsWith('_') || k === 'id' || k === 'ts') continue;
      out(`  ${k}: ${typeof v === 'string' ? sanitizeForDisplay(v) : JSON.stringify(sanitizeForDisplay(v))}`);
    }
  },

  browse: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem browse [--fresh]',
        '',
        '  Search the memory interactively: results re-rank on every',
        '  keystroke, because the search costs 0.027 ms and can afford it.',
        '',
        '    type          search as you go',
        '    up / down     move            enter    open the full entry',
        '    tab           cycle type      ctrl-u   clear the query',
        '    esc           back / quit     ctrl-c   quit',
        '',
        '  Needs a terminal. Piping? `mem find "..."` prints and exits.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['fresh'], 'browse');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    thesaurus.loadUserGroups(root, fs, path);
    const index = search.loadIndex(root, { fresh: Boolean(args.fresh), language: cfg.language });
    try {
      await browse.run(index);
    } catch (e) {
      die(e.message);
    }
  },

  topics: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem topics',
        '',
        '  Every subject the memory is tracking, most recently touched first.',
        '  A topic is any string in an entry\'s `topic` field — log one with',
        '  e.g. `mem log decision --topic architecture/auth-model --title ...`',
        '  and every later entry with the same topic joins the thread.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['names-only', 'flat'], 'topics');
    const root = findRoot(args);
    requireConfig(root);
    const list = memory.topics(root);
    if (list.length === 0) {
      out('No topics yet.  Add one with: mem log <type> --topic <area>/<thing> ...');
      return;
    }
    // --names-only is for the digest: it MUST see the existing topics
    // before inventing a new one. Without this list it can only guess,
    // and guessing produces a fresh topic per entry.
    if (args['names-only']) {
      for (const t of list) out(t.topic);
      return;
    }
    if (args.flat) {
      out(`${list.length} topic${list.length === 1 ? '' : 's'}:`);
      for (const t of list) {
        out(`  ${t.topic.padEnd(34)} ${String(t.count).padStart(3)} entries  `
          + `last ${(t.last || '?').slice(0, 10)}  [${t.types.join(', ')}]`);
      }
      return;
    }
    // The TREE is the default. A flat list of sixty-nine names is exactly
    // the unreadability this was reported for; grouped by area it is seven
    // rows with children under them.
    const tree = memory.topicTree(root);
    const q = memory.topicQuality(root);
    out(`${list.length} topics across ${tree.length} areas `
      + `(${q.entriesPerTopic} entries per topic):`);
    for (const branch of tree) {
      out(`\n  ${branch.children.length > 1 ? `${branch.area} (${branch.children.length})` : branch.area}`);
      for (const c of branch.children) {
        out(`    ${c.leaf.padEnd(38)} ${String(c.count).padStart(3)}  `
          + `${(c.last || '?').slice(0, 10)}  [${c.types.join(', ')}]`);
      }
    }
    if (q.entriesPerTopic <= 1) {
      out(`\n  Note: ${q.singleTopics} of ${q.topics} topics have exactly ONE entry.`
        + `\n  A topic with one entry is not a thread, it is a second title.`);
    }
  },

  topic: async ({ rest, args }) => {
    if (isHelp(args) || !rest[0]) {
      out([
        'mem topic <key> [--all]',
        '',
        '  Where one subject stands NOW, and how it got there. Entries of any',
        '  type that share a `topic` form one thread; the newest is the current',
        '  state, the rest is the trail. Append-only — nothing is rewritten.',
        '  Retired (done/discarded/superseded) entries drop out.',
        '',
        '  --all   print the whole trail, not just the last few steps',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['all'], 'topic');
    const root = findRoot(args);
    requireConfig(root);
    const st = memory.topicState(root, rest[0]);
    if (!st.current) {
      out(`Nothing under topic '${rest[0]}'.  See: mem topics`);
      return;
    }
    out(`topic ${st.topic}  (${st.count} entr${st.count === 1 ? 'y' : 'ies'})`);
    out('');
    out(`  now  [${st.current.ts ?? '?'}] ${st.current._type}  ${compactLine(st.current)}`);
    const trail = args.all ? st.history : st.history.slice(0, 8);
    if (trail.length) {
      out('');
      out(`  how it got here${args.all ? '' : st.history.length > trail.length
        ? ` (${trail.length} of ${st.history.length}, --all for the rest)` : ''}:`);
      for (const e of trail) {
        out(`    [${e.ts ?? '?'}] ${e._type.padEnd(10)} ${compactLine(e)}`);
      }
    }
  },

  context: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem context [--n <count>] [--budget <chars>]',
        '',
        '  --n: number of recent error entries (default 20)',
        '         decisions and events show half of that.',
        '  --budget: a hard ceiling in CHARACTERS for the whole block.',
        '         Sections give way from the bottom up (projects, facts,',
        '         events, decisions, errors), never mid-entry, and the',
        '         block says at the end what did not fit.',
        '',
        `         Smallest usable budget: ${memory.MIN_CONTEXT_CHARS} characters.`,
        '         Characters, not tokens, because characters are exact:',
        '         counting tokens needs the reading model\'s tokenizer,',
        `         which this tool does not carry. ~${memory.CHARS_PER_TOKEN} chars`,
        '         per token is printed as an ESTIMATE next to the number.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['n', 'budget'], 'context');
    const root = findRoot(args);
    requireConfig(root);
    const n = Number(args.n ?? 20);
    // Refuse a budget that cannot be met instead of quietly ignoring it.
    // The header alone is about 120 characters; a "budget" below that
    // would produce a block that breaks its own promise on the first
    // line.
    let maxChars = null;
    if (args.budget !== undefined) {
      maxChars = Number(args.budget);
      if (!Number.isFinite(maxChars) || maxChars < memory.MIN_CONTEXT_CHARS) {
        die(`context: --budget '${args.budget}' is not a usable size.\n`
          + `  The smallest budget that can keep its own promise is ${memory.MIN_CONTEXT_CHARS}\n`
          + '  characters — below that the header and the footer that reports\n'
          + '  the cut do not both fit, and a block that breaks its own budget\n'
          + '  is worse than none.');
      }
    }
    process.stdout.write(memory.context(root, { n, maxChars }));
    process.stdout.write('\n');
  },

  digest: async ({ rest, args }) => {
    if (isHelp(args) || rest.length === 0) {
      out([
        'mem digest due [--volume-now KB] [--volume-min KB] [--quiet MIN] [--ceiling H]',
        'mem digest bell                 when the bell last rang',
        '',
        '  `due` exits 0 = not due, 1 = due, 3 = cannot tell.',
        '  Meant for a timer that runs often and cheaply: it does no',
        '  work and starts no model, it only answers the question.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (rest[0] === 'bell') {
      const b = raw.bellState(root);
      if (!b) { out('No bell since the last digest.'); return; }
      out(`first ${b.first}, last ${b.last}, ${b.count} rings`);
      return;
    }

    if (rest[0] === 'due') {
      checkFlags(args, ['volume-now', 'volume-min', 'quiet', 'ceiling', 'json'], 'digest due');
      const th = {};
      if (args['volume-now']) th.volumeNow = Number(args['volume-now']) * 1024;
      if (args['volume-min']) th.volumeMin = Number(args['volume-min']) * 1024;
      if (args.quiet) th.quietMs = Number(args.quiet) * 60000;
      if (args.ceiling) th.ceilingMs = Number(args.ceiling) * 3600000;
      let d;
      try { d = raw.due(root, { thresholds: th }); }
      catch (e) { out(`cannot tell: ${e.message}`); process.exit(3); }
      if (args.json) { out(JSON.stringify(d)); process.exit(d.due ? 1 : 0); }
      const size = d.bytes ? `${Math.round(d.bytes / 1024)} KB` : '0 KB';
      out(d.due
        ? `DUE (${d.reason}), ${d.captures ?? 0} captures, ${size}`
        : `not due (${d.reason}), ${d.captures ?? 0} captures, ${size}`);
      process.exit(d.due ? 1 : 0);
    }
    die(`digest: unknown subcommand '${rest[0]}'. Known: due, bell`);
  },

  core: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem core [--max N] [--stale-days N]',
        '',
        '  The always-load core: the settled facts worth carrying in EVERY',
        '  session, rendered compact and deterministic. Instead of retraining a',
        '  model on your context or re-retrieving every turn, distill the stable',
        '  facts once and load this small block at the top of a session.',
        '',
        '  A fact is in the core when it is current, not stale, and not in',
        '  conflict. The block is bounded so it stays cheap to always load.',
        '',
        '  --max N         cap the core at N facts (default 40); freshest survive',
        '  --stale-days N  a fact older than this is not core (default 120)',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['max', 'stale-days'], 'core');
    const root = findRoot(args);
    requireConfig(root);
    const staleDays = args['stale-days'] ? Number(args['stale-days']) : 120;
    const max = args.max ? Number(args.max) : 40;
    process.stdout.write(memory.core(root, { staleDays, max }));
    process.stdout.write('\n');
  },

};

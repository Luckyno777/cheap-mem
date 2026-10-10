// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
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
import * as procedure from '../../procedure.mjs';
import * as search from '../../search.mjs';
import * as raw from '../../raw.mjs';
import * as userhabits from '../../userhabits.mjs';
import * as thesaurus from '../../thesaurus.mjs';
import * as retrieval from '../../retrieval.mjs';
import * as capability from '../../capability.mjs';
import * as embedmod from '../../embed/index.mjs';
import * as hybrid from '../../hybrid.mjs';
import * as timeexpr from '../../timeexpr.mjs';
import * as browse from '../../browse.mjs';
import * as observations from '../../observations.mjs';
import * as levers from '../../searchlevers.mjs';
import * as questionsplit from '../../questionsplit.mjs';
import * as requestframe from '../../requestframe.mjs';
import * as tiecut from '../../tiecut.mjs';
import * as variants from '../../variants.mjs';
import * as workflow from '../../workflow.mjs';
import * as snippet from '../../snippet.mjs';
import * as workflowdetect from '../../workflowdetect.mjs';
import * as commandguard from '../../commandguard.mjs';
import * as categories from '../../categories.mjs';
import { out, die, warn, checkFlags, numberFlag, isHelp, findRoot, requireConfig } from '../shell.mjs';
import { asOfOf, sinceOf, showWindow, compactLine, markedEntry, sanitizeForDisplay } from '../display.mjs';

// What a raw hit shows when no real user line carries a query word: never
// the entry text (an unfiltered join of every role).
const RAW_NO_USER_LINE = '(raw capture: no user line matches the query)';

// X3b: `status` field for a hit that is a rule and not released; else nothing.
const statusOf = (root, entry, source) => {
  const st = procedure.statusField(root, source ? { ...entry, _source: source } : entry);
  return st ? { status: st } : {};
};

/** A comma-separated flag as a list of non-empty strings; a bare flag is an empty list. */
function commaList(v) {
  if (v === undefined || v === null || v === true) return [];
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

/** `mem workflow new|check` flags -> the fields `workflow.check()` reads. */
function workflowFieldsFrom(args) {
  const f = {};
  if (args.title !== undefined && args.title !== true) f.title = String(args.title);
  if (args.steps !== undefined && args.steps !== true) {
    f.steps = String(args.steps).split(';').map((x) => x.trim()).filter(Boolean);
  }
  if (args['issued-by'] !== undefined && args['issued-by'] !== true) f.issued_by = String(args['issued-by']);
  for (const [flag, field] of [['triggers', 'triggers'], ['path-patterns', 'path_patterns'],
    ['tool-patterns', 'tool_patterns'], ['tools', 'tools']]) {
    if (args[flag] !== undefined) f[field] = commaList(args[flag]);
  }
  if (args.scope !== undefined && args.scope !== true) f.scope = String(args.scope);
  if (args['source-proposal'] !== undefined && args['source-proposal'] !== true) {
    f.source_proposal = String(args['source-proposal']);
  }
  const refs = {};
  for (const kind of workflow.REFERENCE_KINDS) {
    if (args[`references-${kind}`] !== undefined) refs[kind] = commaList(args[`references-${kind}`]);
  }
  if (Object.keys(refs).length) f.references = refs;
  return f;
}

/** 15 commands. */
export const COMMANDS = {
  find: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem find "<query>" [--type <t>] [--project <name>|global]',
        '          [--since 7d|24h|ISO] [--as-of <ISO>] [--top N] [--literal]',
        '          [--fresh] [--no-raw] [--only-raw] [--variants "a|b|c"]',
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
        '  --journal-session ID  book this question into the injection journal',
        '             (.pipeline/injections.jsonl) for session ID: what cleared',
        '             --journal-min, or why nothing did. The recall hooks pass it;',
        '             `mem asked-learn` learns from the misses it books.',
        '  --wildcard  turn `word*` into a prefix operator: matches every',
        '             indexed term starting with `word` (min 3 chars after',
        '             normalization, capped, scored below an exact hit).',
        '             OFF by default — the automatic retrieval hook calls',
        '             this same command with a raw chat message, where a',
        "             typed `*` must stay an ordinary character, not an",
        '             operator someone can trigger by accident.',
        '  --weak     show the list even when no hit is confident. With the',
        '             h3 search lever on (the default, see `mem search-levers`),',
        '             a list in which no hit clears the bar by a clear gap',
        '             (a flat field of near-equal scores) is withheld as a',
        '             whole: "nothing confident" instead of noise.',
        '  --variants "a|b|c"  up to 4 rewordings the CALLER (an agent, itself a',
        '             model) writes - everyday word / technical term, symptom /',
        '             cause. Each is searched on its own, the hit lists are merged',
        '             by Reciprocal Rank Fusion (src/variants.mjs). No model here;',
        '             without it the search is unchanged.',
        '  --recall   the call of the recall hook (bin/mem-retrieve and the warm server pass',
        '             it): the request frame of the question ("explain", "can you show me")',
        '             is not searched; with MEM_RETRIEVE_TIE=0.01 (off by default) a hit within',
        '             1 % of the last one shown comes along (at most one more than --top).',
        '             Switch for the frame: MEM_RETRIEVE_REQUEST_FRAME. A plain `mem find',
        '             --top N` stays exactly N.',
        `  --type     one of ${Object.keys(memory.TYPES).join(', ')}`,
        '  --category only entries whose topic is assigned to this category',
        '             (confirmed or proposal; see `mem category list`)',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['type', 'project', 'since', 'as-of', 'top', 'literal', 'fresh',
      'no-raw', 'only-raw', 'json', 'with-retired', 'brief', 'no-mmr', 'mmr-lambda',
      'content-words', 'with-echo', 'journal-session', 'journal-min', 'wildcard', 'weak', 'variants', 'category', 'recall'], 'find');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    let query = rest[0];
    if (!query) die("find: no query. Example: mem find 'flaky ci'");
    // The gate below (M16 port) reads the text exactly as it arrived —
    // before --content-words may shorten it to a rarity-ranked word list,
    // which would throw away the very tag a harness wrapper starts with.
    const rawQuery = query;

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
    // --category: only entries whose topic is assigned to the category (src/categories.mjs).
    let categoryTopics = null;
    if (args.category !== undefined) {
      if (args.category === true) die('find: --category needs a value, e.g. --category coding (mem category list).');
      if (args.literal) die('find: --category applies to the ranked search only, not to --literal.');
      const r = categories.topicsOfCategory(root, String(args.category));
      if (!r) die(`find: no category '${args.category}' (mem category list).`);
      categoryTopics = r.topics;
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
    //
    // **Two gates first (M16 port from lucky-mem).** `hasTimeIntent()`
    // keeps a date merely MENTIONED in running text (an agent report, a
    // relayed system message) from being read as a date ASKED about —
    // see timeexpr.mjs for the reasoning and the one exception (a
    // preposition right before the date). `beginsWithHarnessMarker()`
    // is a second, independent check on the UNSHORTENED original text:
    // a turn a harness wrapped from the start is not a person's question
    // at all, whatever a stray timestamp further in says. Neither gate
    // touches `windowFor()` itself — that function stays exactly as
    // test/timeexpr.test.mjs already proves it, byte for byte; `mem
    // when` (an explicit, human-typed command) calls it directly and is
    // not gated — a person who typed a bare date already meant it.
    if (!args.literal && !args.since && categoryTopics === null && !timeexpr.beginsWithHarnessMarker(rawQuery)
      && timeexpr.hasTimeIntent(query)) {
      const zone = process.env.MEM_TZ || cfg.timezone || undefined;
      const window = timeexpr.windowFor(query, { zone });
      if (window) { showWindow(root, query, window, args, { asOf }); return; }
    }

    if (args.literal) {
      const types = args.type ? [args.type] : Object.keys(memory.TYPES);
      // issue #136: `memory.find` now requires a real Capability instead
      // of a hand-built drawer list. Minted exactly the way `mem
      // retrieve`/the ranked branch below already do: a real project
      // name -> `grantProject` (which also admits `global`, the lattice
      // ROOT every capability with read inherits — see `capability.mjs`'s
      // `admits()` — so nothing here has to spell out "PLUS global" by
      // hand any more). `--project global` mints `grantProject('global')`:
      // no document is ever filed under a project literally named
      // "global", so that capability's own scope never matches anything
      // and only the universal global-inheritance rule lets the global
      // drawer through — its narrower, literal meaning is preserved as a
      // side effect of the SAME rule, not a second one. No `--project`:
      // `grantAll`, every drawer, unchanged.
      //
      // Until 2026-09-20 this lane built its own `[null, project]` list
      // by hand, and `bin/mem-mcp`'s literal branch built a DIFFERENT
      // one (`mem find X --literal --project beta` returned beta only,
      // `mem_find` with the same arguments returned global AND beta) —
      // the exact `two-truths` class this parameter exists to end: one
      // rule, in `capability.mjs`, instead of one hand-rolled copy per
      // lane.
      const literalCapability = args.project
        ? capability.grantProject(String(args.project), { subject: 'cli' })
        : capability.grantAll('cli');
      const withRetiredFlag = Boolean(args['with-retired']);
      // `--as-of` opens the retired gate at the CANDIDATE stage too — a
      // superseded entry has to reach `validAt` before it can be judged
      // by time, and `memory.find` drops it earlier than that when
      // `withRetired` is false. `retrieval.blocksRecall` (below) still
      // keeps `done`/`discarded`/`obsolete`/`disputed` out unless
      // `--with-retired` was actually asked for — `--as-of` was never a
      // request to see those.
      const allHits = memory.find(root, query, literalCapability, {
        types, since, withRetired: withRetiredFlag || Boolean(asOf),
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
            label: compactLine(h, { root }) || '',
            ...statusOf(root, h),
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
        out(`  ${h._source}:${h._line}  [${h.ts ?? '?'}]  ${compactLine(h, { root })}${mark}`);
      }
      return;
    }

    thesaurus.loadUserGroups(root, fs, path);
    const t0 = Date.now();
    const index = search.loadIndex(root, { fresh: Boolean(args.fresh), language: cfg.language });
    if (index.bridgeError) process.stderr.write(`mem find: language bridge off: ${index.bridgeError}\n`);
    // The `word*` prefix operator (Windows-search style). OPT-IN via
    // `--wildcard`, deliberately not merely "a `*` appears in the query":
    // `bin/mem-retrieve` (the automatic hook) shells out to this exact
    // command with the user's raw chat message and never passes
    // `--wildcard` — see that script. Without the flag this command is
    // byte-identical to before the operator existed, for every query,
    // starred or not. Skipped under `--literal`, which already ran and
    // returned above.
    let wildcard = { query, extraTerms: null, notes: [] };
    if (args.wildcard && query.includes('*')) {
      wildcard = search.resolveWildcards(index, query);
      query = wildcard.query;
      for (const note of wildcard.notes) process.stderr.write(`mem find: ${note}\n`);
    }
    const wanted = numberFlag('top', args.top, { fallback: 10, min: 1 });
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
    // **H1 (Block H, ported from lucky-mem): split the question.** Only
    // with the lever on (`mem search-levers`). Core words are searched,
    // common words ride along as damped by-catch that does not count in
    // coverage. `null` (no core word, no identifier) keeps the question as
    // it was. The exact lane and the echo filter below still see the
    // question as typed.
    let rankedQuery = query;
    let extraTerms = wildcard.extraTerms;
    // **The request frame (port of lucky-mem's Bitt-Rahmen), recall hook only.**
    // "explain relativity" asks about relativity: "explain" is the form of the
    // request, not its subject (src/requestframe.mjs). Only the RANKED query
    // loses it; the exact lane, the echo filter and the time router below keep
    // the question as typed. A question that would be left without a content
    // word keeps the frame (better a vague search than none).
    if (args.recall && requestframe.requestFrameOn()) {
      const bare = requestframe.dropRequestFrame(rankedQuery);
      if (bare !== rankedQuery && search.contentWords(bare).length) rankedQuery = bare;
    }
    if (levers.active('h1')) {
      const built = questionsplit.buildQuery(rankedQuery, index);
      if (built) {
        rankedQuery = built.query;
        if (built.extraTerms) {
          extraTerms = new Map(extraTerms ?? []);
          for (const [t, w] of built.extraTerms) if ((extraTerms.get(t) ?? 0) < w) extraTerms.set(t, w);
        }
      }
    }
    // Caller-supplied rewordings (src/variants.mjs): each searched with
    // the same options, merged by rank fusion. Without them this is the
    // plain `search.search` call it always was.
    if (args.variants === true) die('find: --variants needs text — mem find "<query>" --variants "a|b|c"');
    const variantList = args.variants ? variants.variantsFromText(args.variants) : [];
    const searchFind = variantList.length
      ? (idx, q, opt) => variants.searchWithVariants(idx, q, variantList, opt)
      : search.search;
    const hits0 = searchFind(index, rankedQuery, {
      // Fetch wider, so enough remains after filtering.
      top: args['with-echo'] ? wanted : wanted * 3,
      type: args.type ?? null,
      project: args.project ?? null,
      capability: findCapability,
      topics: categoryTopics,
      since,
      noRaw: Boolean(args['no-raw']),
      onlyRaw: Boolean(args['only-raw']),
      withRetired: withRetiredForFetch,
      extraTerms,
      // h3's answer gate reads how much of the question each hit carries.
      withCoverage: levers.active('h3'),
      // Deliberately NOT `language: cfg.language`. `cfg.language` is the
      // memory's configured DEFAULT (src/config.mjs, 'en' unless set), not
      // a per-query "the user asked for one language" signal — `find` has
      // no `--lang` flag to produce that signal in the first place, and it
      // is not in `find`'s checkFlags whitelist. Passing the config default
      // here pins `search()`'s QUERY tokenization to one stemmer pack (see
      // `search()`'s own `language` parameter: `const queryPacks = language
      // ? [pack(language)] : DETECTABLE_PACKS`), which defeats the
      // multi-pack detection that `retrieval.retrieve()` — the gateway —
      // always gets, because it never passes `language` to `search()` at
      // all.
      //
      // Measured 2026-09-20 on one index, one query, one entry:
      //   without `language`      score 10.879, rank 1
      //   with `language: 'en'`   score  1.808, rank last of 17
      // The second number matched the CLI's real output exactly. That was
      // the THIRD divergence between `mem find` and `retrieve()` — the
      // class test/paths-agree.test.mjs exists to catch, and did.
      //
      // The three `language: cfg.language` uses elsewhere in this file feed
      // `loadIndex(...)` and are unrelated: they pick the fallback lexicon
      // pack while BUILDING the index, not the query-side tokenization.
      // MMR on by default: keep the top-k from filling with near-duplicates.
      // --no-mmr restores pure BM25 order.
      mmr: !args['no-mmr'],
      mmrLambda: numberFlag('mmr-lambda', args['mmr-lambda'], { fallback: 0.7, min: 0, max: 1 }),
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
      topics: categoryTopics,
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
    const ordered = [...exactMatches.filter(heldThen),
      ...filtered.filter((h) => !exactIds.has(h.entry?.id)).filter(heldThen)];
    const base = ordered.slice(0, wanted);
    // **The cut with a guard for a tie (port of lucky-mem's Antwortschranke),
    // recall hook only** (src/tiecut.mjs): the first hit behind the cut that
    // scores within 1 % of the last one shown comes along, at most one. The
    // answer gate below decides on the hard cut `base` alone, so the extra hit
    // never turns a withheld answer into a shown one.
    const listed = args.recall ? tiecut.cutWithTie(ordered, wanted, tiecut.tieSpread()) : base;
    // **H3 (Block H, ported from lucky-mem): threshold by score gap, for
    // the answer as a whole.** A list in which no hit is exact, strong, or
    // clearly ahead of the second is a flat field of near-equal scores —
    // "how tall is mount kilimanjaro" answered with two "How we deploy"
    // notes because both carry "how". It is withheld, and said so; a list
    // in which ONE hit passes is shown unchanged, weaker hits included.
    // The rule and its calibration: `src/searchlevers.mjs` (occasion
    // `find`). `--weak` shows the list anyway.
    const gated = !args.weak && levers.active('h3')
      && !levers.answerHolds(base, { occasion: 'find', bar: levers.findBar(index.statsN ?? index.N) });
    const withheld = gated ? base.length : 0;
    for (const h of listed) delete h.covered;   // the gate's input, not part of the answer
    const hits = gated ? [] : listed;
    const ms = Date.now() - t0;

    // M18b: the recall hooks book every question they ask — the injected
    // places, or why there were none. Until this flag nothing ever wrote
    // the journal (src/injection.mjs had a closed vocabulary with
    // `too-weak` and no production writer), so no miss was on record and
    // nothing could be learned from one. Same bar as the hook applies:
    // score at or over `--journal-min`, or an exact hit.
    if (typeof args['journal-session'] === 'string' && args['journal-session']) {
      const injection = await import('../../injection.mjs');
      const min = numberFlag('journal-min', args['journal-min'], { fallback: 5 });
      const shown = hits.filter((h) => Number(h.score) >= min || (h.exact && h.exact.length));
      injection.book(root, {
        session: args['journal-session'],
        occasion: injection.OCCASION.QUESTION,
        reason: shown.length ? null : (listed.length ? injection.REASON.TOO_WEAK : injection.REASON.EMPTY),
        bytes: null,
        hits: shown.length,
        searched: index.N,
        sources: shown.map((h) => `${h.source}:${h.line}`),
        questionBytes: Buffer.byteLength(String(query)),
        durationMs: Math.round(process.uptime() * 1000),
      });
    }

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
          label: compactLine(h.entry, { root }),
          ...statusOf(root, h.entry, h.source),
          ...(h.retired ? { state: h.retired.state } : {}),
        }));
        out(JSON.stringify({ query, ms, asOf, hits: brief, ...(withheld ? { withheld } : {}) }, null, 2));
        return;
      }
      // `asOf` is IN the envelope even when null. A consumer has to be
      // able to see whether filtering happened — a missing field reads as
      // "not filtered" and as "older version of the tool" at the same
      // time.
      out(JSON.stringify(sanitizeForDisplay({
        query, ms, asOf, hits: hits.map((h) => ({ ...h, ...statusOf(root, h.entry, h.source), entry: markedEntry(h.entry, { root }) })),
        // Only when something was withheld: a consumer must be able to
        // tell "nothing found" from "nothing confident".
        ...(withheld ? { withheld } : {}),
      }), null, 2));
      return;
    }
    if (hits.length === 0 && withheld) {
      out(`Nothing confident for '${query}'${asOf ? ` as of ${asOf}` : ''} (${index.N} entries, ${ms}ms): `
        + `${withheld} weak match${withheld === 1 ? '' : 'es'} withheld, none clearly ahead.`);
      out('  --weak shows them; --literal does a plain substring search.');
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
      // (userhabits.userSnippet: real user lines only) and never passed
      // through compactLine at all, so it needs its own call here.
      const preview = h.raw
        ? sanitizeForDisplay(userhabits.userSnippet(root, h.source, query) || RAW_NO_USER_LINE)
        : compactLine(h.entry, { root });
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
        top: numberFlag('top', args.top, { fallback: 5, min: 1 }),
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
      top: numberFlag('top', args.top, { fallback: 10, min: 1 }),
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
      top: numberFlag('top', args.top, { fallback: 10, min: 1 }),
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
    if (isHelp(args)) {
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
    if (args.json) { out(JSON.stringify(sanitizeForDisplay(markedEntry(e, { root })))); return; }
    // X3b: a rule that is not released shows its status, from the same function as `mem procedures`.
    const ruleStatus = procedure.statusField(root, e);
    out(`${e._source}  [${e.ts ?? '?'}]  id=${e.id}${ruleStatus ? `  ${procedure.statusMark(ruleStatus)}` : ''}`);
    if (ruleStatus) out(`  status: ${ruleStatus} (NOT a rule in force until a human has released it)`);
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
    const n = numberFlag('n', args.n, { fallback: 20, min: 1 });
    // Refuse a budget that cannot be met instead of quietly ignoring it.
    // The header alone is about 120 characters; a "budget" below that
    // would produce a block that breaks its own promise on the first
    // line.
    let maxChars = null;
    if (args.budget !== undefined) {
      maxChars = numberFlag('budget', args.budget);
      if (maxChars < memory.MIN_CONTEXT_CHARS) {
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
      if (args['volume-now']) th.volumeNow = numberFlag('volume-now', args['volume-now'], { min: 0 }) * 1024;
      if (args['volume-min']) th.volumeMin = numberFlag('volume-min', args['volume-min'], { min: 0 }) * 1024;
      if (args.quiet) th.quietMs = numberFlag('quiet', args.quiet, { min: 0 }) * 60000;
      if (args.ceiling) th.ceilingMs = numberFlag('ceiling', args.ceiling, { min: 0 }) * 3600000;
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
    const staleDays = numberFlag('stale-days', args['stale-days'], { fallback: 120, min: 0 });
    const max = numberFlag('max', args.max, { fallback: 40, min: 1 });
    process.stdout.write(memory.core(root, { staleDays, max }));
    process.stdout.write('\n');
  },

  // wf-bc C1 port. `mem log workflow` cannot set the three list fields
  // (`fieldsFrom()` keeps a comma list as one string, which
  // `workflow.check()` refuses); `mem workflow new` takes them as lists
  // and runs the same check and completion.
  workflow: async ({ rest, args }) => {
    const sub = rest[0];
    if (isHelp(args) || !sub) {
      out([
        'mem workflow new   --title "..." --steps "a;b;c" --issued-by owner [...]',
        'mem workflow check --title "..." --steps "a;b;c" --issued-by owner [...]',
        'mem workflow list',
        'mem workflow show <id>',
        '',
        '  A workflow is a named sequence for a recurring task. Only a human',
        '  issues one (`--issued-by owner` or `human:<name>`) — the same',
        '  authority check as a procedure; the MCP bridge does not write it.',
        '',
        '  --steps          semicolon-separated (a step may contain a comma)',
        '  --triggers       comma-separated words/phrases: the question and',
        '                   subagent hooks show the workflow when the text holds',
        '                   all words of one trigger (search tokens, no model)',
        '  --path-patterns  comma-separated files (`bin/mem-before-edit`): the',
        '                   component table marks them `works-on`',
        '  --tool-patterns  comma-separated substrings of a Bash command',
        '                   (`npm publish`): the before-edit hook shows it',
        '  --tools, --scope, --source-proposal   optional',
        '  --references-procedure, --references-skill, --references-errorclass,',
        '  --references-snippet   comma-separated ids/names (never copied text)',
        '',
        '  `new` writes only after the check passes; `check` runs the same',
        '  check and writes nothing. `list`/`show` cover VISIBLE workflows: in',
        '  force, issued by a human, not a draft — what the hooks can show.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (sub === 'list') {
      checkFlags(args, [], 'workflow list');
      const visible = workflowdetect.visibleWorkflows(root);
      if (!visible.length) { out('No visible workflows (in force, issued by a human, not a draft).'); return; }
      for (const w of visible) {
        const reach = [
          ['triggers', workflowdetect.listOf(w.triggers).length],
          ['path patterns', workflowdetect.listOf(w.path_patterns).length],
          ['tool patterns', workflowdetect.listOf(w.tool_patterns).length],
        ].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'no trigger, path or tool pattern';
        out(`  ${w.id}  ${w.title}`);
        out(`    ${workflow.mark(w)} — ${reach}`);
      }
      out('');
      out(`${visible.length} visible workflow(s). Full text: mem workflow show <id>`);
      return;
    }

    if (sub === 'show') {
      checkFlags(args, [], 'workflow show');
      const id = rest[1];
      if (!id) die('workflow show: which id? mem workflow show <id>');
      const e = memory.getEntry(root, id);
      if (!e || e._type !== workflow.TYPE) die(`workflow show: '${id}' is not a known workflow.`);
      out(workflowdetect.cardText(e));
      for (const [k, label] of [['triggers', 'triggers'], ['path_patterns', 'path patterns'], ['tool_patterns', 'tool patterns']]) {
        const v = workflowdetect.listOf(e[k]);
        if (v.length) out(`  ${label}: ${v.join(', ')}`);
      }
      return;
    }

    if (sub === 'check' || sub === 'new') {
      checkFlags(args, ['title', 'steps', 'issued-by', 'triggers', 'path-patterns', 'tool-patterns',
        'tools', 'scope', 'source-proposal', 'references-procedure', 'references-skill',
        'references-errorclass', 'references-snippet', 'project'], `workflow ${sub}`);
      const fields = workflowFieldsFrom(args);
      const r = workflow.check(fields);
      if (sub === 'check') {
        if (r.ok) { out('OK — `mem workflow new` would accept these fields.'); return; }
        out('Not accepted:');
        for (const e of r.errors) out(`  ${e}`);
        process.exitCode = 1;
        return;
      }
      if (!r.ok) die(`workflow new:\n  ${r.errors.join('\n  ')}`);
      const data = workflow.complete(fields, { agent: memory.agentDefault() });
      const project = args.project && args.project !== true ? String(args.project) : null;
      const { path: p, entry } = memory.logCheckedEntry(root, workflow.TYPE, data, { project });
      out(`Appended: ${memory.asSource(root, p)}`);
      out(`  id: ${entry.id}`);
      out(`  ${workflow.mark(entry)}`);
      return;
    }

    die(`workflow: unknown subcommand '${sub}'. Known: new, check, list, show.`);
  },

  // Lever-5 port (lucky-mem "Befehls-Riegel"): errors of the class
  // `mishandling` carry a command pattern; the before-edit hook warns
  // before a matching Bash command runs. See src/commandguard.mjs.
  'command-guard': async ({ rest, args }) => {
    const sub = rest[0];
    if (isHelp(args) || !['build', 'show', 'check', 'seed'].includes(sub)) {
      out([
        'mem command-guard build | show [--json] | check "<command>" | seed [--map <file.json>] [--write]',
        '',
        '  An error of the class `mishandling` may carry a command pattern; the',
        '  before-edit hook warns before a Bash command that matches runs, once',
        '  per session and error (it never blocks):',
        '    mem log error ... --command-pattern "git add -A ;; git add --all"',
        '  Several patterns are separated by " ;; ", several wordings of ONE',
        '  pattern by " & " (all must occur). The first wording must stand where a',
        '  command starts; a trailing `$` allows no further argument.',
        '',
        '  build    write the derived booklet (.pipeline/command-guard/) anew',
        '  show     patterns with error id, and the coverage (mishandling errors with one)',
        '  check    dry run: which patterns hit this command (no mark, no journal line)',
        '  seed     old errors that should carry a pattern. Without --map: the candidates',
        '           (mishandling, no pattern). With --map {"<error-id>": ["pattern"]}: the',
        '           plan; with --write one correction line per error (append-only)',
        '',
        '  cm ships empty: no pattern comes with the code.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json', 'write', 'map', 'root'], 'command-guard');
    const root = findRoot(args);
    requireConfig(root);
    if (sub === 'build') {
      const r = commandguard.build(root);
      out(`Booklet built: ${r.length} error(s) with a pattern, ${r.reduce((a, x) => a + x.patterns.length, 0)} pattern(s).`);
      return;
    }
    if (sub === 'check') {
      const command = rest.slice(1).join(' ');
      if (!command.trim()) die('command-guard check: the command is missing (in quotes).');
      const hit = commandguard.matches(root, command);
      if (!hit.length) { out('No pattern hits.'); return; }
      for (const r of hit) out(`${r.id} [${r.className}] ${r.title}  <- pattern: ${r.matched.join(' & ')}`);
      return;
    }
    if (sub === 'seed') {
      let entries = [];
      if (args.map !== undefined) {
        if (args.map === true) die('command-guard seed: --map needs a JSON file.');
        let map;
        try { map = JSON.parse(fs.readFileSync(path.resolve(String(args.map)), 'utf8')); }
        catch (e) { die(`command-guard seed: cannot read ${args.map}: ${e.message}`); }
        entries = commandguard.seedEntries(map);
        if (!entries.length) die('command-guard seed: the map names no error. Meant: {"<error-id>": ["pattern", ...]}');
      } else {
        const cand = commandguard.candidates(root);
        if (!cand.length) out('No mishandling error without a pattern.');
        for (const c of cand) out(`  ${c.id}  ${c.title}`);
        if (cand.length) out('Write a map {"<error-id>": ["pattern"]} and run: mem command-guard seed --map <file> [--write]');
        if (args.write) die('command-guard seed: --write needs --map.');
        return;
      }
      const plan = commandguard.seedPlan(root, entries);
      for (const p of plan) out(`  ${p.state.padEnd(7)} ${p.id}  ${p.patterns.join(' ;; ')}`);
      if (!args.write) { out(`Plan: ${plan.filter((p) => p.state === 'ready').length} ready (--write writes them).`); return; }
      const made = commandguard.seed(root, entries);
      commandguard.build(root);
      out(`${made.length} correction line(s) written, booklet rebuilt.`);
      return;
    }
    const rules = commandguard.booklet(root, { readOnly: true });
    const cov = commandguard.coverage(root);
    if (args.json) { out(JSON.stringify({ rules, coverage: cov }, null, 2)); return; }
    if (!rules.length) out('No error carries a command pattern.');
    for (const r of rules) out(`${r.id} [${r.className}] ${r.patterns.map((p) => p.join(' & ')).join(' ;; ')}  -- ${r.title}`);
    out(cov
      ? `Coverage: ${cov.withPattern} of ${cov.total} mishandling incidents carry a command pattern (${cov.patterns} pattern(s)).`
      : 'Coverage: unknown (no error of the class mishandling).');
  },

  snippet: async ({ rest, args }) => {
    const sub = rest[0];
    if (isHelp(args) || !sub) {
      out([
        'mem snippet new --title "..." --kind code|script|text|mail|letter --body "..." [...]',
        'mem snippet list [--project <name>|global]',
        'mem snippet show <id>',
        '',
        '  A reusable block with {{PLACEHOLDERS}} instead of real data. A',
        '  text/mail/letter snippet must pass the redaction check — a hit is an',
        '  abort, nothing is written (the same `snippet.check()` as `mem log',
        '  snippet` and the MCP bridge).',
        '',
        '  --language, --origin, --test   optional strings',
        '  --placeholders   comma-separated (else read off --body)',
        '  --used-by        comma-separated workflow ids (the back-reference)',
        '  --version        a positive integer (default 1)',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (sub === 'list') {
      checkFlags(args, ['project'], 'snippet list');
      let targets;
      if (args.project && args.project !== true) targets = [String(args.project) === 'global' ? null : String(args.project)];
      else targets = [null, ...memory.listProjects(root)];
      const all = [];
      for (const project of targets) {
        let entries;
        try { ({ entries } = memory.readLog(root, snippet.TYPE, { project })); } catch { continue; }
        const retired = memory.retiredMap(entries);
        for (const e of entries) if (e.id && memory.holds(e, retired)) all.push(e);
      }
      if (!all.length) { out('No snippets.'); return; }
      for (const e of all) {
        out(`  ${e.id}  ${snippet.mark(e)}`);
        if (e.title) out(`    ${e.title}`);
      }
      out('');
      out(`${all.length} snippet(s). Full text: mem snippet show <id>`);
      return;
    }

    if (sub === 'show') {
      checkFlags(args, [], 'snippet show');
      const id = rest[1];
      if (!id) die('snippet show: which id? mem snippet show <id>');
      const e = memory.getEntry(root, id);
      if (!e || e._type !== snippet.TYPE) die(`snippet show: '${id}' is not a known snippet.`);
      out(snippet.display(e));
      return;
    }

    if (sub === 'new') {
      checkFlags(args, ['title', 'kind', 'body', 'language', 'placeholders', 'origin', 'test',
        'used-by', 'version', 'project'], 'snippet new');
      const fields = {};
      for (const k of ['title', 'kind', 'body', 'language', 'origin', 'test']) {
        if (args[k] !== undefined && args[k] !== true) fields[k] = String(args[k]);
      }
      if (args.placeholders !== undefined) fields.placeholders = commaList(args.placeholders);
      if (args['used-by'] !== undefined) fields.used_by = commaList(args['used-by']);
      if (args.version !== undefined) fields.version = numberFlag('version', args.version, { min: 1 });
      const r = snippet.check(fields);
      if (!r.ok) die(`snippet new:\n  ${r.errors.join('\n  ')}`);
      const project = args.project && args.project !== true ? String(args.project) : null;
      const { path: p, entry } = memory.logCheckedEntry(root, snippet.TYPE, snippet.complete(fields), { project });
      out(`Appended: ${memory.asSource(root, p)}`);
      out(`  id: ${entry.id}`);
      out(`  ${snippet.mark(entry)}`);
      return;
    }

    die(`snippet: unknown subcommand '${sub}'. Known: new, list, show.`);
  },
};

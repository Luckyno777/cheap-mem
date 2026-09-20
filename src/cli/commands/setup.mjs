/**
 * Installing and wiring: init, hooks, paths, servers, stores, sources.
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
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as memory from '../../memory.mjs';
import * as store from '../../store.mjs';
import * as cfgmod from '../../config.mjs';
import * as viewer from '../../viewer.mjs';
import * as guard from '../../guard.mjs';
import * as source from '../../source.mjs';
import * as component from '../../component.mjs';
import * as board from '../../board.mjs';
import { PKG_ROOT, out, die, warn, checkFlags, isHelp, findRoot, requireConfig } from '../shell.mjs';
import { compactLine, countLines } from '../display.mjs';
import { installHook, proveHook, writeMergeDriver, writeMemoryGitignore } from '../githook.mjs';

/** 14 commands. */
export const COMMANDS = {
  init: async ({ args }) => {
    // **`--help` used to fall straight through into the body below.**
    // There was no isHelp() guard on this command at all, so `mem init
    // --help` on a fresh directory created `.mem/config.json` and the
    // rest of the skeleton — the very thing "just show me the usage"
    // is supposed to never do. Found 2026-09-19: fresh root, `mem init
    // --help`, `.mem/config.json` existed afterwards.
    if (isHelp(args)) {
      out([
        'mem init [--force] [--participants a,b,c] [--branch main] [--remote origin]',
        '',
        '  Creates .mem/config.json plus the log skeleton (global/, projects/,',
        '  inbox/, raw/), the merge driver and the memory .gitignore.',
        '',
        '  Idempotent without --force: an existing config is left alone, only',
        '  the .gitignore and merge-driver guarantees are checked and repaired.',
        '  --force overwrites the config outright.',
        '',
        '  --participants  comma-separated names (default from cfgmod.DEFAULT_CONFIG)',
        '  --branch/--remote  defaults used by `mem inbox watch`',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['force', 'participants', 'branch', 'remote'], 'init');
    // `mem --root X init` and `mem init --root X` must mean the same
    // thing. The pre-scan strips a LEADING --root out of argv and puts
    // it in the environment, so args.root is empty in that form — and
    // init silently initialised the current directory instead. That is
    // how a stray .mem/ ended up inside this package during testing.
    const root = args.root
      ? path.resolve(String(args.root))
      : (process.env.CHEAP_MEM_ROOT
        ? path.resolve(process.env.CHEAP_MEM_ROOT)
        : process.cwd());
    fs.mkdirSync(root, { recursive: true });
    const cfgPath = cfgmod.configPath(root);
    if (fs.existsSync(cfgPath) && !args.force) {
      // **Leaving without looking was the bug behind the bug.**
      // `writeMemoryGitignore` wrote rules git ignored — nine patterns
      // matching nothing, the first of them the one that keeps an API
      // key out of the repository. The fix was easy; getting it to the
      // memories that HAVE the broken file was not, because they are
      // all "already initialized" and this branch returned before
      // touching anything. The only advice left would have been
      // `--force`, which overwrites the config to repair a file next
      // to it. Nobody should have to trade one for the other.
      //
      // So the two guarantees a memory cannot work without get checked
      // on every init, force or not. Both are idempotent and neither
      // touches the config. The merge driver has the same history: it
      // was missing from init entirely, so memories shipped without the
      // one rule their append-only design depends on.
      const gi = writeMemoryGitignore(root);
      const md = writeMergeDriver(root);
      out(`Already initialized: ${cfgPath}`);
      if (gi.added || gi.repaired || md.added) {
        if (gi.repaired) out(`  repaired ${gi.repaired} broken .gitignore line(s) — git ignored none of them`);
        if (gi.added) out(`  added ${gi.added} missing .gitignore rule(s)`);
        if (md.added) out(`  wrote the merge driver (*.jsonl merge=union)`);
        out(`  check with: mem doctor`);
      } else {
        out(`  .gitignore and merge driver are in order`);
      }
      out(`Pass --force to overwrite the config.`);
      return;
    }
    let participants = cfgmod.DEFAULT_CONFIG.participants;
    if (args.participants && typeof args.participants === 'string') {
      participants = {};
      for (const p of args.participants.split(',').map((s) => s.trim()).filter(Boolean)) {
        participants[p] = `(role: ${p})`;
      }
    }
    const cfg = {
      ...cfgmod.DEFAULT_CONFIG,
      participants,
      defaultBranch: args.branch ?? cfgmod.DEFAULT_CONFIG.defaultBranch,
      defaultRemote: args.remote ?? cfgmod.DEFAULT_CONFIG.defaultRemote,
    };
    cfgmod.writeConfig(root, cfg);

    fs.mkdirSync(path.join(root, 'global'), { recursive: true });
    fs.mkdirSync(path.join(root, 'projects'), { recursive: true });
    fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
    writeMemoryGitignore(root);
    // The merge driver is not a nicety. Without `*.jsonl merge=union` a
    // git merge of two independently appended logs produces conflict
    // markers, and a line with markers no longer parses — so entries are
    // lost, and the loss is silent because unparseable lines are skipped.
    // Measured 2026-09-05: three of six valid lines destroyed.
    //
    // init used to leave this out entirely, which meant every fresh
    // memory shipped without the guarantee its own design depends on.
    writeMergeDriver(root);

    for (const f of ['decisions.jsonl', 'errors.jsonl', 'events.jsonl', 'timeline.jsonl']) {
      const p = path.join(root, 'global', f);
      if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
    }
    const facts = path.join(root, 'global', 'facts.yaml');
    if (!fs.existsSync(facts)) fs.writeFileSync(facts,
      '# stable facts about the user / setup\n# edited by humans or the librarian\n', 'utf8');
    const people = path.join(root, 'global', 'people.yaml');
    if (!fs.existsSync(people)) fs.writeFileSync(people, '# people directory\n', 'utf8');
    const factsMd = path.join(root, 'FACTS.md');
    if (!fs.existsSync(factsMd)) fs.writeFileSync(factsMd,
      '# FACTS (always loaded at session start)\n\n' +
      'Keep this short. Only what is TRUE RIGHT NOW and matters to every session.\n', 'utf8');

    out(`Initialized cheap-mem at ${root}`);
    out(`  config:       ${path.relative(root, cfgPath)}`);
    out(`  participants: ${Object.keys(cfg.participants).join(', ')}`);
    out(``);
    out(`  merge driver: .gitattributes (*.jsonl merge=union)`);
    out(``);
    out(`Next:`);
    out(`  mem whoami <${Object.keys(cfg.participants).join('|')}>`);
    out(`  git init && git add -A && git commit -m "init cheap-mem" && git remote add origin <url>`);
    out(`  mem hooks install       <- do this one. Without it nothing stops a`);
    out(`                             secret from reaching git. core.hooksPath is`);
    out(`                             local config: a clone does not inherit it,`);
    out(`                             so every checkout needs it again.`);
    out(``);
    out(`Then: mem doctor --strict   (it verifies the guarantees above, and says`);
    out(`                             which layer owns each one)`);
  },

  setup: async ({ rest, args }) => {
    // Honest scope. Wiring an agent means writing into its config, and a
    // config written from a guessed format is worse than none at all: it
    // fails silently, in someone else's home directory, in a file they did
    // not know we touched. So this supports what can actually be verified,
    // and says so instead of listing a dozen agents it cannot test.
    const AGENTS = {
      claude: 'Claude Code — user-level hooks, permissions and the MCP server',
    };
    const agent = rest[0];
    if (isHelp(args) || !agent) {
      out([
        'mem setup <agent> [--dry-run]',
        '',
        '  Wire this memory into an agent: context on session start, recall on',
        '  every prompt, capture on session end, and the MCP tools.',
        '',
        '  Idempotent — run it again after moving the memory and it re-points.',
        '',
        '  Supported:',
        ...Object.entries(AGENTS).map(([k, v]) => `    ${k.padEnd(8)} ${v}`),
        '',
        '  Only Claude Code is supported, on purpose. Any MCP-capable agent can',
        '  use the server today by pointing at bin/mem-mcp; what is NOT offered',
        '  is a one-command install for agents whose config format cannot be',
        '  verified here. A wrong config fails silently in your home directory.',
        '',
        '  --dry-run   print what would happen, change nothing',
      ].join('\n'));
      return;
    }
    if (!Object.hasOwn(AGENTS, agent)) {
      die(`setup: no recipe for '${agent}'. Supported: ${Object.keys(AGENTS).join(', ')}`);
    }

    checkFlags(args, ['dry-run'], 'setup');
    const root = findRoot(args);
    requireConfig(root);
    const script = path.join(PKG_ROOT, 'install', 'claude-code.sh');
    if (!fs.existsSync(script)) die(`setup: ${script} is missing from this install`);

    const mcpCmd = `claude mcp add cheap-mem -- node ${path.join(PKG_ROOT, 'bin', 'mem-mcp')}`;
    if (args['dry-run']) {
      out('Would run:');
      out(`  CHEAP_MEM_ROOT=${root} bash ${script}`);
      out('    -> ~/.claude/hooks/cheap-mem-{session-start,session-stop,user-prompt}.sh');
      out('    -> merges ~/.claude/settings.json (keeps what is there)');
      out('  and register the MCP server:');
      out(`  ${mcpCmd}`);
      out('    (needs the optional peer @modelcontextprotocol/sdk)');
      return;
    }

    out(`Wiring ${root} into Claude Code ...`);
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { ...process.env, CHEAP_MEM_ROOT: root },
      stdio: 'inherit',
    });
    if (r.status !== 0) die(`setup: ${script} failed (exit ${r.status})`);

    // The MCP server is the one piece the install script does not do.
    // Registering it needs the claude CLI; when that is absent, say the
    // command rather than pretending the step happened.
    // The SDK is an optional peer: the hooks above are the bigger half and
    // need nothing, so a missing SDK must not abort the wiring — it just
    // means the MCP half cannot start yet, and saying so here beats the
    // user finding out from a client that only reports "server failed".
    let sdkHere = true;
    try { await import('@modelcontextprotocol/sdk/server/index.js'); }
    catch { sdkHere = false; }
    if (!sdkHere) {
      out('');
      out('Note: the MCP server needs @modelcontextprotocol/sdk, which is not');
      out('installed (it is an optional peer — 28 MB the rest of cheap-mem does');
      out('not need). The hooks above work without it. To add the MCP tools:');
      out('  npm install -g @modelcontextprotocol/sdk');
      out(`  ${mcpCmd}`);
      out('');
      out('Check it took: mem doctor   (the stop-hook and git-hook findings)');
      return;
    }

    const hasClaude = spawnSync('claude', ['--version'], { stdio: 'ignore' }).status === 0;
    if (hasClaude) {
      const m = spawnSync('claude', ['mcp', 'add', 'cheap-mem', '--',
        'node', path.join(PKG_ROOT, 'bin', 'mem-mcp')], { encoding: 'utf8' });
      out(m.status === 0
        ? 'MCP server registered as "cheap-mem".'
        : `MCP registration did not succeed — run it yourself:\n  ${mcpCmd}`);
    } else {
      out(`claude CLI not found. Register the MCP server yourself:\n  ${mcpCmd}`);
    }
    out('');
    out('Check it took: mem doctor   (the stop-hook and git-hook findings)');
  },

  hooks: async ({ rest, args }) => {
    if (isHelp(args) || rest.length === 0) {
      out([
        'mem hooks install [--dir <path>]   arm the pre-commit secret check',
        'mem hooks check                    prove it fires, with a decoy',
        '',
        '  The memory and this tool are different directories, so the',
        '  hook has to be generated: a small script inside the memory',
        '  that calls this package\'s redaction module by absolute path.',
        '',
        '  --dir  put the hook somewhere else. Needed when the memory',
        '         sits on a noexec mount — git starts hooks with execve,',
        '         and no chmod can help there.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);

    if (rest[0] === 'install') {
      checkFlags(args, ['dir'], 'hooks install');
      const r = installHook(root, args.dir ?? null);
      for (const l of r.lines) out(l);
      if (!r.ok) process.exit(1);
      return;
    }
    if (rest[0] === 'check') {
      const r = proveHook(root);
      for (const l of r.lines) out(l);
      process.exit(r.ok ? 0 : 1);
    }
    die(`hooks: unknown subcommand '${rest[0]}'. Known: install, check`);
  },

  paths: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem paths [--json]',
        '',
        '  Do the files named in entries still point anywhere?',
        '',
        '  Checked PER PROJECT against ITS tree. That is not a nicety:',
        '  the first measurement said 32 % drift because everything was',
        '  checked against one tree. Done right it is 3 to 9 %.',
        '',
        '  Without a tree for a project the result is UNCHECKED —',
        '  expressly not intact.',
        '',
        '  configure: .pipeline/trees.json   {"other": "/path/to/other"}',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json', 'root'], 'paths');
    const root = findRoot(args);
    const pc = await import('../../pathcheck.mjs');
    const readAll = () => {
      const acc = [];
      for (const project of [null, ...memory.listProjects(root)]) {
        for (const type of Object.keys(memory.TYPES)) {
          let res;
          try { res = memory.readLog(root, type, { project }); } catch { continue; }
          const retired = memory.retiredMap(res.entries);
          res.entries.forEach((e, i) => {
            if (!memory.holds(e, retired)) return;
            acc.push({ project, entry: e, source: `${project ?? 'global'}/${type}`, line: i + 1 });
          });
        }
      }
      return acc;
    };
    const r = pc.check(root, { readAll });
    if (args.json) out(JSON.stringify(r, null, 2));
    else out(pc.asText(r));
  },

  guard: async ({ rest, args }) => {
    if (args.help || (rest[0] && rest[0] !== 'run')) {
      out([
        'mem guard run [--duty]',
        '',
        '  Checks every latch in the memory. A latch hangs off an `error`',
        '  entry and answers ONE question: is the error back?',
        '',
        `  Kinds: ${Object.keys(guard.GUARD_KINDS).join(', ')}`,
        '',
        '  Create one while logging:',
        '    mem log error --class x --title "..." \\',
        '      --guard-kind absent --guard-path src/foo.mjs --guard-pattern "bar"',
        '',
        '  A latch EXECUTES NOTHING — it reads files. An entry is data;',
        '  if a latch were a shell command, any connected agent could',
        '  drop code on this machine and wait for somebody to run the',
        '  latches.',
        '',
        '  --duty: raise a duty for every red latch.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);
    const list = guard.all(root, { readLog: memory.readLog, listProjects: memory.listProjects });
    if (!list.length) {
      out('No latch yet. An error without a latch is a diary entry.');
      out('43 % of classified errors recur (measured 2026-09-08, reference deployment).');
      return;
    }
    const count = { green: 0, red: 0, broken: 0 };
    const reds = [];
    for (const g of list) {
      const r = guard.check(g.guard, { root });
      count[r.state] += 1;
      if (r.state !== 'green') reds.push({ ...g, r });
      const mark = { green: 'ok    ', red: 'RED   ', broken: 'broken' }[r.state];
      out(`  ${mark} [${g.entry.class ?? '?'}] ${r.why}`);
    }
    out('');
    out(`${list.length} latches: ${count.green} ok, ${count.red} red, ${count.broken} broken.`);
    // `broken` is not `green`. A latch pointing at a deleted file has
    // checked NOTHING — counting that as a pass would be the very class
    // it is built against.
    if (count.broken) out('A broken latch checks nothing. It is not a latch that passed.');
    if (args.duty && reds.length) {
      for (const g of reds) {
        memory.logEntry(root, 'duty', {
          title: `Latch ${g.r.state}: ${g.entry.class ?? g.entry.title}`,
          text: `${g.r.why}\nBelongs to entry ${g.entry.id}.`,
          owed_to: 'owner',
        }, { project: g.project });
      }
      out(`${reds.length} duty/duties raised.`);
    } else if (reds.length) {
      out('With --duty these become duties, instead of staying one line.');
    }
    if (count.red) process.exitCode = 1;
  },

  version: async ({ args }) => {
    // No isHelp() guard existed here either — `mem version --help` just
    // printed the version number, same as `mem version` with no flag.
    // Harmless (no write), but still not "help", so the universal
    // `--help` contract failed for this command too.
    if (isHelp(args)) {
      out('mem version   which cheap-mem this install is.');
      return;
    }
    checkFlags(args, [], 'version');
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));
    out(`cheap-mem ${pkg.version}`);
  },
  bridge: async ({ rest, args }) => {
    const sub = rest[0];
    if (isHelp(args) || !sub) {
      out([
        'mem bridge report <short-hash>',
        '',
        '  An MCP bridge reports which checkout it is SERVING.',
        '',
        '  Why it has to be reported rather than measured: this repo does',
        '  not know which process is running out there. On 2026-09-08 one',
        '  bridge ran a whole day on the previous day\'s checkout — six',
        '  tools missing from its list — and an outside agent noticed, not',
        '  us. A board that inferred the running state from the repo state',
        '  would have shown green for that whole day.',
      ].join('\n'));
      return;
    }
    if (sub !== 'report') die(`bridge: unknown subcommand '${sub}'. Known: report`);
    checkFlags(args, ['root'], 'bridge report');
    const hash = rest[1];
    if (!hash) die('bridge report: which checkout? Give the short hash.');
    const root = findRoot(args);
    // The write lives in src/board.mjs — the same function the bridge
    // calls. Two writers of one record would be two truths, and the
    // tile reads only one of them.
    const { row } = board.report(root, hash, { by: memory.agentDefault() });
    out(`Bridge reported: ${row.version} (${row.seen_at})`);
  },

  serve: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem serve [--port N] [--host H] [--readonly]',
        '',
        '  The console and the viewer at one fixed link, instead of a',
        '  one-off HTML file. This is the only place where anything can',
        '  be SET without a shell.',
        '',
        '  It renders in RAM and writes nothing to disk. With no',
        '  CHEAP_MEM_SERVE_TOKEN it serves localhost ONLY — binding to a',
        '  public address without one is refused, and the process does',
        '  not start. An open link would put real memory content on the',
        '  network unprotected, and a warning in a log has never once',
        '  prevented that.',
        '',
        '  /               the console: state, settings, connections',
        '  /viewer         the memory, searchable in the browser',
        '  /console.json   the same numbers, for tools',
        '  /health         no auth, reveals nothing — for supervisors',
        '',
        '  CHEAP_MEM_SERVE_TOKEN     the door. Without it: localhost only.',
        '  CHEAP_MEM_SERVE_HOST      bind address (default 127.0.0.1)',
        '  CHEAP_MEM_SERVE_PORT      port (default 8847)',
        '  CHEAP_MEM_SERVE_READONLY  1 = show everything, set nothing',
        '  CHEAP_MEM_SERVE_ORIGINS   extra origins allowed to POST',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['port', 'host', 'readonly', 'root'], 'serve');
    const root = findRoot(args);
    // **Anchored to PKG_ROOT, not to this file's own directory.**
    // Until 2026-09-18 the handlers lived in `bin/mem`, right next to
    // `bin/mem-serve`, so `new URL('./mem-serve', import.meta.url)`
    // resolved correctly. Commit 9dae830 ("Sixty handlers leave
    // bin/mem: 4503 lines to 223") moved this handler into
    // src/cli/commands/setup.mjs without moving the import path with
    // it — `mem serve` then looked for
    // src/cli/commands/mem-serve, which never existed, and died with
    // "Cannot find module". Nothing caught it: the tests for the
    // server (test/console.test.mjs, test/dashboard.test.mjs) import
    // bin/mem-serve DIRECTLY and never go through this CLI path.
    // PKG_ROOT is the repo root regardless of which file computes it
    // (see src/cli/shell.mjs), so this survives the next move too.
    const mod = await import(pathToFileURL(path.join(PKG_ROOT, 'bin', 'mem-serve')).href);
    const env = { ...process.env };
    if (args.port && args.port !== true) env.CHEAP_MEM_SERVE_PORT = String(args.port);
    if (args.host && args.host !== true) env.CHEAP_MEM_SERVE_HOST = String(args.host);
    if (args.readonly) env.CHEAP_MEM_SERVE_READONLY = '1';
    let started;
    try {
      started = await mod.serve(root, env);
    } catch (e) {
      // The bind refusal is a decision, not a crash: say what to do.
      die(e?.message || String(e));
      return;
    }
    const bound = started.server.address();
    out(`Console: http://${started.cfg.host}:${bound.port}/`);
    out(`  root ${root}`);
    out(`  ${started.cfg.token ? 'token set' : 'no token — localhost only'}`
      + `${started.cfg.readonly ? ', read-only' : ''}`);
    out('  Ctrl-C to stop.');
  },

  viewer: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem viewer [--out <file.html>] [--title "..."] [--open]',
        "",
        "  Writes ONE self-contained HTML file — every entry embedded,",
        "  search and filtering done in the browser. No server, no model,",
        "  no network. Open it and rummage through the memory.",
        "",
        "  --out:   where to write (default: a temp file, printed below)",
        "  --title: heading (default: the memory's display name)",
        "  --open:  also try to open it in the default browser",
        "",
        "  It reads only the redacted logs, never raw/. The file carries",
        "  real memory content: it is not committed and not for publishing.",
      ].join('\n'));
      return;
    }
    checkFlags(args, ['out', 'title', 'open'], 'viewer');
    const root = findRoot(args);
    const cfg = requireConfig(root);
    const title = (typeof args.title === 'string' && args.title)
      || cfg.displayName || cfg.channel || 'cheap-mem';
    const { html, count } = viewer.build(root, { title });

    // Default outside any repo: a temp file. A viewer carries real
    // memory content, and the surest way not to commit or publish it by
    // accident is to write it where neither git nor a publish step
    // looks. --out overrides for when you want it somewhere on purpose.
    let outPath;
    if (typeof args.out === 'string' && args.out) {
      outPath = path.resolve(String(args.out));
    } else {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      outPath = path.join(os.tmpdir(), `mem-viewer-${stamp}.html`);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    out(`Viewer: ${outPath}`);
    out(`  ${count} entr${count === 1 ? 'y' : 'ies'} embedded`);
    // A gentle reminder only when the file landed inside the memory, so
    // a stray `git add -A` cannot sweep private content into a commit.
    if (outPath.startsWith(path.resolve(root) + path.sep)) {
      out(`  note: this file is inside the memory — it holds real content, do not commit it.`);
    }
    if (args.open) {
      const opener = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start' : 'xdg-open';
      try { spawnSync(opener, [outPath], { stdio: 'ignore', shell: process.platform === 'win32' }); }
      catch { /* opening is a convenience, never a failure */ }
    }
  },

  net: async ({ args }) => {
    if (isHelp(args)) {
      out([
        'mem net [--json]',
        '',
        '  What points at what — from the DECLARED links, not from',
        '  similarity.',
        '',
        '  Counter-check: tag co-occurrence gives thousands of edges and',
        '  70 % connectedness, but only because one project tag sits in',
        '  almost every entry. A net where everything connects to',
        '  everything shows nothing.',
        '',
        '  Boxes are project/drawer — that stands in the path, so it is a',
        '  fact too and not a clustering procedure.',
        '',
        '  Cycles are REPORTED, not cut: a map that quietly cuts a cycle',
        '  shows a direction that does not exist.',
      ].join('\n'));
      return;
    }
    checkFlags(args, ['json', 'root'], 'net');
    const root = findRoot(args);
    const net = await import('../../net.mjs');
    const readAll = () => {
      const acc = [];
      for (const project of [null, ...memory.listProjects(root)]) {
        for (const type of Object.keys(memory.TYPES)) {
          let res;
          try { res = memory.readLog(root, type, { project }); } catch { continue; }
          for (const e of res.entries) {
            if (e.__broken) continue;
            acc.push({ project: project ?? 'global', drawer: type, entry: e });
          }
        }
      }
      return acc;
    };
    const n = net.build({ readAll });
    if (args.json) out(JSON.stringify({ ...n, ...net.layers(n) }, null, 2));
    else out(net.asText(n));
  },

  project: async ({ rest, args }) => {
    if (isHelp(args)) {
      out([
        'mem project init <name> [--title "Display name"]',
        "",
        "  Creates projects/<name>/ idempotently.",
      ].join('\n'));
      return;
    }
    const sub = rest[0];
    if (sub !== 'init') {
      die(`project: unknown subcommand '${sub ?? '(missing)'}'`);
    }
    checkFlags(args, ['title'], 'project init');
    const root = findRoot(args);
    requireConfig(root);
    const name = rest[1];
    if (!name) die("project init: name missing");
    const { dir, created, existed } = memory.projectInit(root, name, { title: args.title ?? null });
    out(`Project: ${path.relative(root, dir)}`);
    if (created.length) out(`  created: ${created.join(', ')}`);
    if (existed.length) out(`  existed: ${existed.join(', ')}`);
  },

  store: async ({ rest, args }) => {
    const subs = ['put', 'list', 'get', 'verify', 'remove'];
    if (isHelp(args) || !rest[0]) {
      out([
        'mem store put <file> --purpose "..." [--agent x] [--project y] [--large]',
        'mem store list [--agent x] [--project y] [--all]',
        'mem store get <hash>',
        'mem store verify',
        'mem store remove <hash> --reason "..."',
        '',
        '  Keep generated files provable. The REGISTER lives in the repo',
        '  (hash, size, type, origin, purpose); the BYTES do not — they sit',
        '  content-addressed under store/objects/ and are deletable.',
        '  That is exactly what "commit everything" cannot do: there, every',
        '  version stays in history forever.',
        '',
        '  Text files pass redaction and are REJECTED on a hit rather than',
        '  quietly cleaned — cleaned bytes would hash differently from what',
        '  you produced, and the audit trail would prove the wrong thing.',
        '  Binaries cannot be read by it; that stands as checked:false in',
        '  the register rather than being passed over.',
      ].join('\n'));
      return;
    }
    const what = rest[0];
    if (!subs.includes(what)) die(`store: '${what}' unknown. Known: ${subs.join(', ')}`);
    const root = findRoot(args);
    requireConfig(root);

    if (what === 'put') {
      checkFlags(args, ['purpose', 'agent', 'project', 'session', 'entry-id', 'retention', 'large'], 'store put');
      if (!rest[1]) die('store put: file missing.');
      let r;
      try {
        r = store.put(root, rest[1], {
          purpose: args.purpose ?? '', agent: args.agent ?? null, project: args.project ?? null,
          session: args.session ?? null, entry_id: args['entry-id'] ?? null,
          retention: args.retention ?? null, large: Boolean(args.large),
        });
      } catch (e) { die(e.message); }
      out(`${r.already ? 'Already held' : 'Stored'}: ${r.name}  ${r.size} B  ${r.mime}`);
      out(`  ${r.sha256}`);
      if (!r.checked) warn('did not pass redaction (not text) — content unchecked');
      return;
    }

    if (what === 'list') {
      checkFlags(args, ['agent', 'project', 'all'], 'store list');
      let list = store.holdings(root);
      if (!args.all) list = list.filter((l) => !l.deleted_at);
      if (args.agent) list = list.filter((l) => l.agent === args.agent);
      if (args.project) list = list.filter((l) => l.project === args.project);
      if (!list.length) { out('Nothing stored.'); return; }
      const total = list.reduce((n, l) => n + (l.size ?? 0), 0);
      out(`${list.length} items, ${(total / 1024).toFixed(1)} kB:`);
      for (const l of list) {
        const mark = l.deleted_at ? ' [DELETED]' : (l.checked ? '' : ' [unchecked]');
        out(`  ${l.sha256.slice(0, 12)}  ${String(l.ts ?? '').slice(0, 10)}  `
          + `${String(l.size ?? 0).padStart(8)} B  ${(l.name ?? '?').padEnd(28)}${mark}`);
        if (l.purpose) out(`                ${l.purpose}`);
      }
      return;
    }

    if (what === 'get') {
      checkFlags(args, [], 'store get');
      if (!rest[1]) die('store get: hash missing.');
      const hits = store.holdings(root).filter((l) => l.sha256.startsWith(rest[1].toLowerCase()));
      if (!hits.length) die(`No item with hash '${rest[1]}'.`);
      if (hits.length > 1) die(`'${rest[1]}' is ambiguous (${hits.length} matches).`);
      const l = hits[0];
      if (l.deleted_at) {
        die(`Deleted on ${l.deleted_at}${l.delete_reason ? `: ${l.delete_reason}` : ''}. `
          + 'The proof remains, the bytes are gone.');
      }
      out(store.objectPath(root, l.sha256));
      return;
    }

    if (what === 'verify') {
      checkFlags(args, [], 'store verify');
      const v = store.verify(root);
      out(`${v.registered} registered (${(v.bytes / 1024).toFixed(1)} kB), ${v.deleted} deleted`);
      if (v.unchecked) out(`  ${v.unchecked} did not pass redaction (binaries)`);
      let bad = false;
      for (const [label, l] of [['missing', v.missing], ['CHANGED', v.changed]]) {
        if (!l.length) continue;
        bad = true;
        out(`  ${l.length} ${label}:`);
        for (const x of l) out(`    ${x.sha256.slice(0, 12)}  ${x.name ?? '?'}`);
      }
      if (v.orphans.length) {
        out(`  ${v.orphans.length} orphaned (on disk, in no register):`);
        for (const h of v.orphans.slice(0, 10)) out(`    ${h.slice(0, 12)}`);
      }
      if (!bad && !v.orphans.length) out('  all intact');
      return;
    }

    checkFlags(args, ['reason'], 'store remove');
    if (!rest[1]) die('store remove: hash missing.');
    const hits = store.holdings(root).filter((l) => l.sha256.startsWith(rest[1].toLowerCase()));
    if (!hits.length) die(`No item with hash '${rest[1]}'.`);
    if (hits.length > 1) die(`'${rest[1]}' is ambiguous (${hits.length} matches).`);
    const r = store.remove(root, hits[0].sha256, { reason: args.reason ?? '' });
    out(`Bytes ${r.bytesRemoved ? 'removed' : 'were already gone'}: ${r.hash.slice(0, 16)}…`);
    out('  The register line stays as a tombstone — the hash still proves what was there.');
  },

  sources: async ({ rest, args }) => {
    const subs = ['add', 'bridge', 'list'];
    if (isHelp(args) || !rest[0]) {
      out([
        'mem sources add <url|path> [--title "..."] [--tags a,b] [--project x]',
        '                          [--note "..."] [--max 4000]',
        'mem sources bridge <source_uri> --tool <name> [--title "..."] [--project x]',
        'mem sources list [--kind file|address|bridge] [--project x]',
        '',
        '  Takes in knowledge that already exists: a pointer, and enough',
        '  text that search can find the document by its own words.',
        '',
        '  A LOCAL file goes content-addressed into the store; the entry',
        `  carries only the hash. If it is text, an excerpt of at most`,
        `  ${source.MAX_EXCERPT} characters travels with it — capped, because a 40 MB`,
        '  document would otherwise answer every search with itself.',
        '',
        '  An ADDRESS stays a pointer. NOTHING is fetched: a memory that',
        '  dereferences addresses is a crawler, and what it collects on',
        '  the way nobody has read. Pass text yourself with --note.',
        '',
        '  A BRIDGE pointer names, in DATA, the tool that could look it up',
        '  — e.g. --tool cbm_inspect_symbol. This program never calls that',
        '  tool; the field is a note for whichever AGENT reads the memory',
        '  next, to make the call itself, with its own permissions.',
        '',
        '  The excerpt goes through redaction before anything is written —',
        '  a foreign document is exactly where a credential rides along.',
      ].join('\n'));
      return;
    }
    const sub = rest[0];
    if (!subs.includes(sub)) die(`sources: '${sub}' unknown. Known: ${subs.join(', ')}`);
    const root = findRoot(args);
    requireConfig(root);

    if (sub === 'bridge') {
      checkFlags(args, ['title', 'tags', 'project', 'note', 'max', 'tool', 'root'], 'sources bridge');
      const uri = rest.slice(1).join(' ').trim();
      if (!uri) die('sources bridge: source_uri missing.');
      if (!args.tool || args.tool === true) die('sources bridge: --tool <name> missing.');
      const tags = args.tags && args.tags !== true
        ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean) : null;
      let r;
      try {
        r = source.declareBridge(root, uri, String(args.tool), {
          title: args.title && args.title !== true ? String(args.title) : null,
          tags,
          project: args.project ?? null,
          note: args.note && args.note !== true ? String(args.note) : null,
          agent: memory.agentDefault(),
          max: args.max ? Number(args.max) : undefined,
        });
      } catch (e) { die(`sources bridge: ${e.message}`); }
      out(`Appended: ${path.relative(root, r.path)}:${countLines(r.path)}`);
      out(`  id: ${r.entry.id}   kind: bridge   tool: ${r.entry[source.BRIDGE_TOOL_FIELD]}`);
      if (r.findings.length) {
        warn(`redacted: ${r.findings.map((f) => `${f.type}x${f.count}`).join(', ')} `
          + '— the excerpt differs from the original at those points.');
      }
      return;
    }

    if (sub === 'add') {
      checkFlags(args, ['title', 'tags', 'project', 'note', 'max', 'root'], 'sources add');
      const target = rest.slice(1).join(' ').trim();
      if (!target) die('sources add: address or path missing.');
      const tags = args.tags && args.tags !== true
        ? String(args.tags).split(',').map((x) => x.trim()).filter(Boolean) : null;
      let r;
      try {
        r = source.take(root, target, {
          title: args.title && args.title !== true ? String(args.title) : null,
          tags,
          project: args.project ?? null,
          note: args.note && args.note !== true ? String(args.note) : null,
          agent: memory.agentDefault(),
          max: args.max ? Number(args.max) : undefined,
        });
      } catch (e) { die(`sources add: ${e.message}`); }
      out(`Appended: ${path.relative(root, r.path)}:${countLines(r.path)}`);
      out(`  id: ${r.entry.id}   kind: ${r.entry.kind}`);
      if (r.entry.hash) out(`  store: ${r.entry.hash.slice(0, 16)}  (${r.entry.bytes} bytes)`);
      if (r.entry.excerpt) {
        out(`  excerpt: ${r.entry.excerpt.length} characters`
          + `${r.entry.truncated ? ' (truncated)' : ''}`);
      }
      // What was redacted is SAID. A silent redaction is worse than
      // none: nobody looks, and the excerpt still differs from the
      // document.
      if (r.findings.length) {
        warn(`redacted: ${r.findings.map((f) => `${f.type}x${f.count}`).join(', ')} `
          + '— the excerpt differs from the original at those points.');
      }
      return;
    }

    checkFlags(args, ['kind', 'project', 'root'], 'sources list');
    const project = args.project ? (args.project === 'global' ? null : args.project) : undefined;
    const kind = args.kind && args.kind !== true ? String(args.kind) : null;
    if (kind && !Object.hasOwn(source.KINDS, kind)) {
      die(`sources list: --kind '${kind}' does not exist. Known: ${Object.keys(source.KINDS).join(', ')}`);
    }
    const list = source.all(root, { project, kind });
    if (!list.length) {
      out('No sources taken in. `mem sources add <url|path>`');
      return;
    }
    for (const s of list) out(`  ${source.line(s)}`);
    out('');
    out(`${list.length} source(s). The text is an excerpt, not the document.`);
  },

  component: async ({ rest, args }) => {
    if (isHelp(args) || !rest.length) {
      out([
        'mem component <path> [--top 8] [--project <name>|global] [--json]',
        '',
        '  Everything about ONE file — literal, but over both spellings.',
        '',
        '  Measured: of 805 path mentions in the reference corpus, 22 % of',
        '  components appear in more than one form, almost always just',
        '  with or without a path prefix. The pre-edit hook asked',
        '  literally with two segments and therefore saw 3 of 11 entries',
        '  for one file, 0 of 10 for another.',
        '',
        '  A base-name hit only counts when it appears in the entry',
        '  WITHOUT a prefix or with the SAME one. `projects/x/events.jsonl`',
        '  answers no question about `global/events.jsonl` — the confusion',
        '  would be worse than the gap.',
        '',
        '  --project  restrict to one project (or `global`). Every sibling',
        '             read command (`find`, `retrieve`, `duties`, ...) has',
        '             this; until 2026-09-20 `component` was the one command',
        '             that could not be scoped even when a caller wanted to —',
        '             the flag did not exist, so the pre-edit hook (which',
        '             calls this, unscoped) read across every project with',
        '             no way to ask it not to. Omit it and behaviour is',
        '             unchanged: every project, as before.',
      ].join('\n'));
      return;
    }
    const root = findRoot(args);
    requireConfig(root);
    checkFlags(args, ['top', 'json', 'root', 'project'], 'component');
    const p = rest.join(' ').trim();
    const top = args.top ? Number(args.top) : 8;
    // null (default) = every project, unchanged from before this flag
    // existed. `--project global` means the global drawer ONLY — the
    // same convention `find --literal` and `duties` already use.
    //
    // P13 wiring: `component.find` -> `memory.find` has no Capability
    // parameter (`memory.mjs` is off limits for this change — see the
    // P13 brief), so a real project name now reads that project's
    // drawer PLUS `global`, mirroring what `capability.grantProject`
    // would admit if this call could take one: global is the lattice
    // root, inherited by every project (see `capability.mjs`'s
    // `admits()`), not a sibling drawer a project search used to leave
    // out. `--project global` keeps its narrower, literal meaning.
    const projects = args.project
      ? (args.project === 'global' ? [null] : [null, args.project])
      : null;
    const hits = component.find(root, p, { projects });
    if (args.json) {
      out(JSON.stringify({
        path: p,
        forms: component.forms(p),
        n: hits.length,
        hits: hits.slice(0, top).map((h) => ({
          score: null,
          form: h._form,
          source: h._source,
          line: h._line,
          ts: h.ts ?? null,
          raw: false,
          label: compactLine(h) || '',
        })),
      }, null, 2));
      return;
    }
    if (!hits.length) {
      out(`Nothing about '${p}'. Asked for: ${component.forms(p).join(', ')}`);
      return;
    }
    out(`${hits.length} entries about '${p}' (${component.forms(p).join(' | ')}):`);
    for (const h of hits.slice(0, top)) {
      // The form travels: a base hit is weaker evidence, and whoever
      // reads it should see that.
      out(`  ${h._form.padEnd(5)} ${h._source}:${h._line}  ${String(h.ts ?? '').slice(0, 10)}`);
      out(`        ${compactLine(h).slice(0, 120)}`);
    }
    if (hits.length > top) out(`  (${hits.length - top} more, raise --top)`);
  },

};

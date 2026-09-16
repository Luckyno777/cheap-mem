// bench/consumption-funnel.mjs — what gets produced, next to what arrives.
//
// A measuring instrument, not a feature. It changes nothing and writes
// nothing.
//
// **Why it exists.** A memory measures in a great many places and
// consumes in very few. Six independent findings inside one week, each
// read on its own as a one-off:
//
//   83 open messages, not one of them worth waking anybody for
//   20 waiting proposals, at least three of them long since built
//   a repair command written 29,939 times and never read
//   a duty due at a fixed time that nobody pulled
//   six unanchored mutants the verifier dutifully reports
//   a docs guard green while the numbers underneath drifted away
//
// Separately those are six defects. Together they are a shape: a
// channel gets built, the producing side is finished, the consuming
// side is left for later — and because nobody sees both ends next to
// each other, it only shows once a pile overflows.
//
// This tool puts the two ends side by side. Per channel: how much was
// produced, how much delivered, how much consumed.
//
// **Three states, never two.** `null` means NOT measured and is not
// the same as `0`, measured and none. That difference is the whole
// point: a channel whose consumption cannot be observed is not the
// same as one that consumes nothing. The first needs a measuring
// point, the second needs a repair. Reporting both as 0 builds the
// wrong thing.
//
// **Measuring point.** Everything under the runtime-state directory
// belongs to exactly one clone and describes only that clone.
// Channels reading from there are marked accordingly — carrying such a
// number to another machine would be inventing it.
//
// Usage:
//   node bench/consumption-funnel.mjs [--root <path>] [--json]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

/** One JSONL file as objects. Broken lines are counted, not swallowed. */
export function readJsonl(weg) {
  const rows = [];
  let broken = 0;
  let text = '';
  try { text = fs.readFileSync(weg, 'utf8'); } catch { return { rows, broken, missing: true }; }
  for (const z of text.split('\n')) {
    if (!z.trim()) continue;
    try { rows.push(JSON.parse(z)); } catch { broken += 1; }
  }
  return { rows, broken, missing: false };
}

/** All `projects/<x>/<name>.jsonl` together. */
function fromProjects(root, name) {
  const projectsDir = path.join(root, 'projects');
  let names = [];
  try { names = fs.readdirSync(projectsDir); } catch { return { rows: [], broken: 0, missing: true }; }
  const all = { rows: [], broken: 0, missing: true };
  for (const p of names) {
    const r = readJsonl(path.join(projectsDir, p, `${name}.jsonl`));
    if (r.missing) continue;
    all.missing = false;
    all.rows.push(...r.rows);
    all.broken += r.broken;
  }
  return all;
}

/**
 * A record with a closing pointer: `closes_id` points at the original.
 *
 * Append-only means a closing is a NEW row pointing at the old one.
 * Counting `state` counts the closing ROWS, not the closed records —
 * two different numbers, and the interesting one is the second.
 */
function pointerChannel(name, data, { measuredAt = 'store' } = {}) {
  if (data.missing) {
    return { channel: name, measuredAt, produced: null, delivered: null, consumed: null,
      note: 'no store present' };
  }
  const zu = new Set(data.rows.map((z) => z?.closes_id).filter(Boolean));
  const originals = data.rows.filter((z) => !z?.closes_id);
  const orphans = [...zu].filter((id) => !originals.some((o) => o?.id === id));
  return {
    channel: name,
    measuredAt,
    produced: originals.length,
    // For these channels delivery is not a step of its own: the row
    // lies there the moment it is written. Deliberately null rather
    // than `produced`, so the column does not fake completeness.
    delivered: null,
    consumed: originals.filter((o) => zu.has(o?.id)).length,
    brokenLines: data.broken,
    orphanClosings: orphans.length,
  };
}

/** The inbox: the state lives in the message header itself. */
function messageChannel(root, isDone) {
  const dir_ = path.join(root, 'inbox');
  let names = [];
  try { names = fs.readdirSync(dir_).filter((n) => n.endsWith('.md')); }
  catch {
    return { channel: 'inbox', measuredAt: 'store',
      produced: null, delivered: null, consumed: null, note: 'inbox not readable' };
  }
  let consumed = 0;
  let withoutState = 0;
  for (const n of names) {
    let header = '';
    try { header = fs.readFileSync(path.join(dir_, n), 'utf8').split(/\n\s*\n/)[0] ?? ''; }
    catch { continue; }
    // `State:`, not `Stand:`. The header name came across from the
    // other house untranslated and matched nothing — every inbox
    // would have reported 0 consumed, quietly, forever. Which is the
    // exact family of defect this instrument exists to find.
    const m = header.match(/^State:\s*(.*)$/m);
    if (!m) { withoutState += 1; continue; }
    if (isDone(m[1].trim())) consumed += 1;
  }
  return {
    channel: 'inbox',
    measuredAt: 'store',
    produced: names.length,
    // Whether a bell rang lives in the runtime state of ONE container,
    // not in the store. Not claimed here.
    delivered: null,
    consumed,
    withoutState,
  };
}

/**
 * Questions: closed by a `resolves` EDGE, not by a field on the entry.
 *
 * **And this is the real finding of this tool.** The first draft
 * counted questions the way it counts duties, via a closing pointer,
 * and reported "produced 5, consumed 0" — a dead channel. Wrong: the
 * answer command closes a question through an edge and deliberately
 * writes NO second lifecycle onto the entry ("two truths about one
 * state end up differing", as its help says).
 *
 * Three channels, three different closing conventions:
 *
 *   inbox      a State header field in the message
 *   duties     a follow-up row carrying closes_id
 *   questions  a resolves edge in a different file
 *
 * Each well founded on its own. Together they mean: measuring
 * consumption requires reading every channel on its own terms — and
 * whoever skips that reports a dead channel that is not dead. An
 * instrument that raises a false alarm gets switched off the second
 * time it does.
 */
function questionChannel(root) {
  const questions = fromProjects(root, 'questions');
  if (questions.missing) {
    return { channel: 'questions', measuredAt: 'store', produced: null, delivered: null,
      consumed: null, note: 'no questions store' };
  }
  const edges = fromProjects(root, 'links');
  const resolved = new Set(edges.rows
    .filter((k) => k?.art === 'resolves').map((k) => k?.nach).filter(Boolean));
  const originals = questions.rows.filter((z) => z?.frage);
  return {
    channel: 'questions',
    measuredAt: 'store',
    produced: originals.length,
    delivered: null,
    consumed: originals.filter((f) => resolved.has(f?.id)).length,
    brokenLines: questions.broken + edges.broken,
    // An edge pointing at nothing looks exactly like an answer.
    danglingEdges: [...resolved].filter((id) =>
      !questions.rows.some((f) => f?.id === id)
      && !edges.rows.some((k) => k?.id === id)).length,
  };
}

/** The retrieval hook: what did it inject? Runtime of THIS container. */
function retrievalChannel(root) {
  const r = readJsonl(path.join(root, '.pipeline', 'injections.jsonl'));
  if (r.missing) {
    return { channel: 'retrieval', measuredAt: 'container', produced: null, delivered: null,
      consumed: null, note: 'no injections in this container' };
  }
  return {
    channel: 'retrieval',
    measuredAt: 'container',
    produced: r.rows.length,
    delivered: r.rows.filter((z) => (z?.hits ?? 0) > 0).length,
    // Whether an injection changed the answer is not observable from
    // operation. The paired benchmark measures that, not this tool.
    // null, not 0.
    consumed: null,
    brokenLines: r.broken,
  };
}

/**
 * All channels.
 *
 * `isDone` is passed in from outside so this tool does not become the
 * fourth place that interprets for itself what "done" means — three
 * places had already drifted apart on exactly that.
 */
export function funnel(root, { isDone }) {
  return [
    messageChannel(root, isDone),
    pointerChannel('duties', fromProjects(root, 'duties')),
    questionChannel(root),
    retrievalChannel(root),
  ];
}

/**
 * Which channels stand out?
 *
 * Deliberately NO threshold on the rate. A channel at 50 % may be
 * healthy; one at 0 % with a meaningful volume never is. And a channel
 * with no measuring point is not a finding but a gap — reported
 * separately.
 */
export function finding(channels, { atLeast = 5 } = {}) {
  const dead = channels.filter((k) =>
    typeof k.produced === 'number' && k.produced >= atLeast && k.consumed === 0);
  const blind = channels.filter((k) => k.consumed === null);
  const orphans = channels.filter((k) => (k.orphanClosings ?? 0) > 0);
  return { dead, blind, orphans, measured: channels.filter((k) => k.produced !== null).length };
}

const rate = (k) => (typeof k.produced === 'number' && typeof k.consumed === 'number'
  && k.produced > 0 ? `${Math.round((k.consumed / k.produced) * 100)} %` : '\u2014');
const num = (v) => (v === null || v === undefined ? 'not measured' : String(v));

// --- as a command ------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = path.resolve(flag('root') ?? process.env.CHEAP_MEM_ROOT ?? process.cwd());
  const inbox = await import(path.join(ROOT, 'src', 'inbox.mjs'));
  const channels = funnel(ROOT, { isDone: inbox.isDone });
  const f = finding(channels);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ root: ROOT, channels, finding: f }, null, 2));
    process.exit(f.dead.length ? 1 : 0);
  }

  console.log(`Consumption funnel  ${ROOT}`);
  console.log('Measured at "container": runtime of THIS clone, nowhere else.\n');
  console.log(`${'Channel'.padEnd(12)}${'Measured at'.padEnd(13)}${'produced'.padStart(10)}`
    + `${'delivered'.padStart(14)}${'consumed'.padStart(14)}${'Rate'.padStart(8)}`);
  for (const k of channels) {
    console.log(`${k.channel.padEnd(12)}${k.measuredAt.padEnd(13)}${num(k.produced).padStart(10)}`
      + `${num(k.delivered).padStart(14)}${num(k.consumed).padStart(14)}${rate(k).padStart(8)}`);
    if (k.note) console.log(`${''.padEnd(12)}${k.note}`);
  }
  console.log();

  if (!f.measured) {
    console.log('NOTHING MEASURED. Wrong root, or the store looks different from what');
    console.log('this tool assumes. That is not a pass.');
    process.exit(2);
  }
  for (const k of f.blind) {
    console.log(`  ${k.channel}: consumption has no measuring point — not the same as zero consumption.`);
  }
  for (const k of f.orphans) {
    console.log(`  ${k.channel}: ${k.orphanClosings} closing row(s) with no original.`);
  }
  if (!f.dead.length) {
    console.log(`\nNo dead channel: ${f.measured} measured, none of them at 0 consumption.`);
    process.exit(0);
  }
  console.log(`\n${f.dead.length} channel(s) produce and consume nothing:`);
  for (const k of f.dead) console.log(`  ${k.channel}: ${k.produced} produced, 0 consumed`);
  process.exit(1);
}

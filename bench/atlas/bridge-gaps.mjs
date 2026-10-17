// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/bridge-gaps.mjs — the groups of the phase `bridge` that were blind spots until the sister house
// (lucky-mem) measured its counterparts (atlas-luecken, 2026-10-17):
//
//   sdk         A8   the SDK the bridge runs on: the peer range has a floor, and what is installed is inside it
//   bidi        A9   Trojan Source characters (the nine bidi controls) are masked at every MCP exit, in both halves
//   card        H11  the `card_*` fields and the card shelf: sizes, shapes, rank, and the person rule
//   http-token  A14  the HTTP bridge starts only with a token (or the loopback switch), refuses a wrong token, and
//                    the dashboard obeys the same start rule with its login counted as a credential
//
// **How a group is built.** Each group owns a throwaway root, asks a REAL door (a stdio client, an HTTP process, a
// dashboard process), counts, and has a positive control. A refusal is only reported when the control holds; without
// it the record is `not-measured` and names the control. The code tree is a parameter (`tree`, default: this
// repository) so test/atlas-gaps-cm.test.mjs can point the same group at a scratch copy with one guarantee removed
// (bench/atlas/gap-mutants.mjs says where). Counters, not clocks: refusals, rows written, processes up. The one time
// in here is a stall guard for a process that neither starts nor exits.
//
// **A red here is a finding, not a bug of the phase.** The groups measure; they fix nothing in bin/mem-mcp or src/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { SEVERITY, REPO, tempRoot } from './core.mjs';
import { openBridge, payloadOf, writeBridgeConfig } from './bridge-client.mjs';
import {
  emit, notMeasured, skipAll, guard, short,
} from './gap-records.mjs';
import * as memory from '../../src/memory.mjs';
import * as cardstore from '../../src/cardstore.mjs';

const rowsOf = (root, type) => {
  try { const r = memory.readLog(root, type); return r.missing ? 0 : (r.entries ?? []).length; } catch { return 0; }
};
const jsonLines = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  } catch { return []; }
};
/** Text of exactly `n` characters made of words (a run of one letter would look like a key to the redaction), ending in a letter. */
const words = (n) => {
  const base = 'plain words about a decision ';
  let t = base.repeat(Math.ceil(n / base.length) + 1).slice(0, n);
  if (t.endsWith(' ')) t = `${t.slice(0, -1)}x`;
  return t;
};

// --- A8: the SDK floor ---------------------------------------------------------------------------------------------

const SDK = '@modelcontextprotocol/sdk';
const parseVersion = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
/** `^1.30.0`, `~1.30.0`, `>=1.30.0 <2`, `1.30.0` -> [1,30,0]; anything else is null (never a guess). */
const floorOf = (range) => {
  const m = /^(?:\^|~|>=\s*)?(\d+)\.(\d+)\.(\d+)(?:\s+<\s*\d+(?:\.\d+){0,2})?$/.exec(String(range ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const inCaret = (v, lo) => v[0] === lo[0] && cmp(v, lo) >= 0;
/** A JSON file in three states: ok / missing / unreadable (an unreadable file is not an absent one). */
function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? { state: 'missing' } : { state: 'unreadable', reason: short(e && e.message, 100) };
  }
  try { return { state: 'ok', value: JSON.parse(raw) }; } catch (e) { return { state: 'unreadable', reason: `not JSON: ${short(e && e.message, 80)}` }; }
}

export async function sdkFloor(atlas, { tree = REPO } = {}) {
  const pkg = readJson(path.join(tree, 'package.json'));
  const lock = readJson(path.join(tree, 'package-lock.json'));
  const installed = readJson(path.join(tree, 'node_modules', ...SDK.split('/'), 'package.json'));
  const range = {
    id: 'bridge.sdk.range',
    title: 'A8: the SDK peer range has a floor that equals the development range, is not above the locked version, and the lock stands inside it',
    expected: 'peer floor = dev floor <= locked version; locked version in the caret range of the floor; the peer stays optional',
  };
  if (pkg.state !== 'ok') {
    emit(atlas, { ...range, ok: false, actual: `package.json is ${pkg.state}${pkg.reason ? ` (${pkg.reason})` : ''}`, evidence: 'package.json of the tree', severity: SEVERITY.MAJOR });
  } else if (lock.state !== 'ok') {
    notMeasured(atlas, { ...range, reason: `package-lock.json is ${lock.state}${lock.reason ? ` (${lock.reason})` : ''}: the version the suite runs on is unknown` });
  } else {
    const peer = pkg.value.peerDependencies?.[SDK];
    const dev = pkg.value.devDependencies?.[SDK];
    const pf = floorOf(peer);
    const df = floorOf(dev);
    const locked = parseVersion(lock.value.packages?.[`node_modules/${SDK}`]?.version);
    const optional = pkg.value.peerDependenciesMeta?.[SDK]?.optional === true;
    const ok = Boolean(pf && df && locked) && cmp(pf, df) === 0 && cmp(pf, locked) <= 0 && inCaret(locked, pf) && optional;
    emit(atlas, {
      ...range, ok,
      actual: `peer ${peer ?? 'missing'}, dev ${dev ?? 'missing'}, locked ${locked ? locked.join('.') : 'unknown'}, optional ${optional}`,
      evidence: 'package.json peerDependencies / devDependencies / peerDependenciesMeta and the root of package-lock.json; no SDK version check runs at bridge start in this house (the range is the guard)',
      measured: { peer: peer ?? null, dev: dev ?? null, locked: locked ? locked.join('.') : null, optional },
      severity: SEVERITY.MAJOR,
    });
  }
  const inst = {
    id: 'bridge.sdk.installed',
    title: 'A8: the SDK that is installed in the tree is inside the peer range',
    expected: 'installed version has the major of the floor and is at least the floor',
  };
  if (pkg.state !== 'ok') { notMeasured(atlas, { ...inst, reason: 'package.json is not readable, so there is no range to compare with' }); return; }
  if (installed.state === 'missing') { notMeasured(atlas, { ...inst, reason: 'the SDK is not installed in this tree (it is an optional peer): nothing to compare' }); return; }
  const floor = floorOf(pkg.value.peerDependencies?.[SDK]);
  const have = installed.state === 'ok' ? parseVersion(installed.value.version) : null;
  if (!floor || !have) {
    emit(atlas, { ...inst, ok: false, actual: `range floor ${floor ? floor.join('.') : 'unreadable'}, installed ${have ? have.join('.') : `unreadable (${installed.reason ?? 'no version'})`}`, evidence: 'node_modules/@modelcontextprotocol/sdk/package.json', severity: SEVERITY.MAJOR });
    return;
  }
  emit(atlas, {
    ...inst, ok: inCaret(have, floor),
    actual: `installed ${have.join('.')}, floor ${floor.join('.')}`,
    evidence: 'node_modules/@modelcontextprotocol/sdk/package.json against the peer range', measured: { installed: have.join('.'), floor: floor.join('.') }, severity: SEVERITY.MAJOR,
  });
}

// --- A9: bidi controls at every MCP exit ---------------------------------------------------------------------------

const cp = (n) => String.fromCodePoint(n);
/** The nine controls of CVE-2021-42574 with the names the mask uses; written out here so a change in src/bidi.mjs is a visible change. */
const NINE = Object.freeze([[0x202a, 'LRE'], [0x202b, 'RLE'], [0x202c, 'PDF'], [0x202d, 'LRO'], [0x202e, 'RLO'], [0x2066, 'LRI'], [0x2067, 'RLI'], [0x2068, 'FSI'], [0x2069, 'PDI']]);
const RAW = new RegExp(`[${NINE.map(([n]) => cp(n)).join('')}]`, 'g');
const markOf = (ch) => { const n = ch.codePointAt(0); const name = NINE.find(([c]) => c === n)[1]; return `[U+${n.toString(16).toUpperCase().padStart(4, '0')}:${name}]`; };
const maskedOf = (s) => s.replace(RAW, markOf);
const rawIn = (x) => (String(typeof x === 'string' ? x : JSON.stringify(x)).match(RAW) || []).length;
const marksIn = (x) => (String(typeof x === 'string' ? x : JSON.stringify(x)).match(/\[U\+[0-9A-F]{4}:[A-Z]{3}\]/g) || []).length;
const RLO = cp(0x202e); const LRI = cp(0x2066); const PDI = cp(0x2069); const LRE = cp(0x202a);
const T1 = `Access${RLO}gnirts${LRI}x${PDI} trouble`;
const X1 = `Text${RLO}abc${LRE}def${LRI}ghi${PDI} done`;
const T9 = `ninecodes ${NINE.map(([n]) => `a${cp(n)}`).join('')}`;
// Clean text a mask must not touch: umlauts and a sharp s, Arabic and Hebrew prose, and the two right-to-left / left-to-right MARKS (U+200F, U+200E),
// which are not among the nine and are how real bidirectional text is written.
const TC = 'Gruene Auen und M\u00FCller \u00C4rger \u00FCber Stra\u00DFe';
const XC = `Prose: K\u00E4se \u00DF \u0645\u0631\u062D\u0628\u0627 \u05E9\u05DC\u05D5\u05DD ${cp(0x200f)}end${cp(0x200e)} cleantext`;

/**
 * `withoutControls`: only for the proof of the control of the count (test/atlas-gaps-mutants-cm.test.mjs): the planted texts
 * carry none of the nine controls, so `bridge.bidi.world` must read fail and the records behind it not-measured.
 */
export async function bidiExits(atlas, { tree = REPO, withoutControls = false } = {}) {
  const ids = ['bridge.bidi.world', 'bridge.bidi.exits', 'bridge.bidi.structured', 'bridge.bidi.roundtrip', 'bridge.bidi.all-nine', 'bridge.bidi.clean'];
  const root = tempRoot('atlas-bridge-bidi-');
  writeBridgeConfig(root);
  const plain = (x) => (withoutControls ? x.replace(RAW, '') : x);
  memory.logEntry(root, 'error', { id: 'bd1xxxxx', class: 'probe', title: plain(T1), text: plain(X1), tags: ['bidi'], agent: 'probe' });
  memory.logEntry(root, 'error', { id: 'bd9xxxxx', class: 'probe', title: plain(T9), text: 'all nine controls once', tags: ['bidi'], agent: 'probe' });
  memory.logEntry(root, 'error', { id: 'ok1xxxxx', class: 'probe', title: TC, text: XC, tags: ['clean'], agent: 'probe' });
  const file = memory.logPath(root, 'error');
  const inFile = rawIn(fs.readFileSync(file, 'utf8'));
  let inReader = -1;
  try { inReader = rawIn(memory.readLog(root, 'error').entries); } catch { /* reported below */ }
  // 3 (title) + 4 (text) in the first entry, 9 in the second.
  const worldOk = emit(atlas, {
    id: ids[0], title: 'A9 control of the count: the store carries the controls raw (16 of the nine kinds) and the reader returns them, so "0 in the answer" means something',
    ok: inFile === 16 && inReader === 16, expected: '16 raw controls in the file and 16 in the reader',
    actual: `${inFile} in the file, ${inReader} in the reader`, evidence: 'global/errors.jsonl of the throwaway root; memory.readLog; count = characters U+202A..U+202E and U+2066..U+2069',
    measured: { inFile, inReader }, severity: SEVERITY.MAJOR,
  });
  if (!worldOk) {
    skipAll(atlas, ids.slice(1).map((id) => ({ id, title: `bridge bidi (${id})`, expected: 'see the group' })), 'the control bridge.bidi.world failed: the store does not carry the controls raw, so a clean answer would prove nothing');
    return;
  }
  const bridge = await openBridge(root, { tree });
  try {
    // A real exit per tool, whole answer (text and structured half) counted.
    const asks = [['mem_find', { query: 'Access trouble' }], ['mem_show', { id: 'bd1xxxxx' }], ['mem_context', {}], ['mem_retrieve', { query: 'Access trouble' }]];
    const per = [];
    for (const [name, args] of asks) {
      const r = await bridge.call(name, args);
      per.push({ name, isError: r.isError, raw: rawIn(r), marks: marksIn(r), res: r });
    }
    const shown = per.find((p) => p.name === 'mem_show');
    let e = null;
    try { e = JSON.parse(shown.res.text); } catch { e = payloadOf(shown.res); }
    const same = Boolean(e) && e.title === maskedOf(T1) && e.text === maskedOf(X1);
    const raw = per.reduce((s, p) => s + p.raw, 0);
    emit(atlas, {
      id: ids[1], title: 'A9: mem_find, mem_show, mem_context and mem_retrieve answer with no raw bidi control; the entry is shown with the printable mark, title and text exactly as masked',
      ok: per.every((p) => !p.isError && p.marks >= 1) && raw === 0 && same,
      expected: '0 raw controls in every answer; at least one mark in each; mem_show title and text equal the original with each control replaced by [U+XXXX:NAME]',
      actual: `${per.map((p) => `${p.name}: ${p.isError ? 'error' : 'answered'}, ${p.raw} raw, ${p.marks} marks`).join('; ')}; mem_show text ${same ? 'equal to' : 'different from'} the expected mask`,
      evidence: 'real stdio client against bin/mem-mcp; the whole answer (text and structuredContent) is counted',
      measured: { raw, perTool: per.map((p) => ({ tool: p.name, raw: p.raw, marks: p.marks })), same }, severity: SEVERITY.CRITICAL,
    });
    const retrieve = per.find((p) => p.name === 'mem_retrieve');
    const claims = retrieve.res.structured?.claims ?? [];
    const claim = claims.find((c) => c.id === 'bd1xxxxx');
    const sRaw = rawIn(retrieve.res.structured ?? {});
    const tRaw = rawIn(retrieve.res.text);
    emit(atlas, {
      id: ids[2], title: 'A9: the structured half of an answer (mem_retrieve structuredContent) is masked as well as its text half',
      ok: Boolean(claim) && sRaw === 0 && tRaw === 0 && marksIn(claim?.body ?? '') >= 1,
      expected: 'the claim is there; 0 raw controls in structuredContent and in the text; a mark in the claim body',
      actual: claim ? `${sRaw} raw in structuredContent, ${tRaw} raw in the text, ${marksIn(claim.body)} marks in the body` : `no claim bd1xxxxx among ${claims.length} claims`,
      evidence: 'mem_retrieve answers a text table and structuredContent built from the same records',
      measured: { structuredRaw: sRaw, textRaw: tRaw, claims: claims.length }, severity: SEVERITY.CRITICAL,
    });
    // The whole road: a foreign agent writes controls over the bridge, the next read masks them.
    const rt = { title: `Round${RLO}trip${LRI}x${PDI} note`, learning: `Learned${RLO}x lesson`, text: `Body${LRE}y after the write`, tags: ['zzbidirt'] };
    const w = await bridge.call('mem_log', { type: 'learning', ...rt });
    const back = await bridge.call('mem_find', { query: 'Round trip note Learned lesson' });
    const stored = jsonLines(memory.logPath(root, 'learning')).at(-1);
    const storedRaw = stored ? rawIn(stored) : -1;
    emit(atlas, {
      id: ids[3], title: 'A9: controls a foreign agent writes over mem_log are accepted as text and masked on the next read (the display is where the deception works, not the file)',
      ok: !w.isError && rawIn(w) === 0 && !back.isError && rawIn(back) === 0 && marksIn(back) >= 3 && storedRaw >= 5,
      expected: 'the write is accepted and its answer carries no raw control; the next mem_find shows at least three marks and no raw control',
      actual: `write ${w.isError ? `refused: ${short(w.text, 80)}` : 'accepted'}, ${rawIn(w)} raw in its answer; read ${back.isError ? 'error' : 'answered'}, ${rawIn(back)} raw, ${marksIn(back)} marks; stored line carries ${storedRaw} raw`,
      evidence: 'mem_log type learning, then mem_find on the same stdio bridge; src/bidi.mjs masks at display time on purpose',
      measured: { writeRefused: w.isError, readRaw: rawIn(back), readMarks: marksIn(back), storedRaw }, severity: SEVERITY.CRITICAL,
    });
    const nine = await bridge.call('mem_show', { id: 'bd9xxxxx' });
    let n9 = null;
    try { n9 = JSON.parse(nine.text); } catch { n9 = null; }
    const want = maskedOf(T9);
    const nineMarks = NINE.map(([n]) => markOf(cp(n)));
    const hasAll = Boolean(n9) && nineMarks.every((m) => String(n9.title).includes(m));
    emit(atlas, {
      id: ids[4], title: 'A9: each of the nine controls, one by one, is masked with its own name (a mask that misses one kind is a mask with a hole)',
      ok: !nine.isError && rawIn(nine) === 0 && hasAll && n9.title === want,
      expected: 'U+202A..U+202E and U+2066..U+2069 each replaced by [U+XXXX:NAME]; 0 raw; title equal to the expected mask',
      actual: `${rawIn(nine)} raw, ${nineMarks.filter((m) => String(n9?.title ?? '').includes(m)).length} of 9 marks present, title ${n9 && n9.title === want ? 'equal' : 'different'}`,
      evidence: 'mem_show on an entry whose title carries each control once', measured: { raw: rawIn(nine), marks: marksIn(nine) }, severity: SEVERITY.CRITICAL,
    });
    const clean = await bridge.call('mem_show', { id: 'ok1xxxxx' });
    let c1 = null;
    try { c1 = JSON.parse(clean.text); } catch { c1 = null; }
    emit(atlas, {
      id: ids[5], title: 'A9 positive control: umlauts, Arabic and Hebrew prose and the two direction marks arrive byte for byte (the list is closed: nine controls, not "all bidi characters")',
      ok: !clean.isError && Boolean(c1) && c1.title === TC && c1.text === XC,
      expected: 'title and text equal the stored original',
      actual: c1 ? `title ${c1.title === TC ? 'equal' : 'changed'}, text ${c1.text === XC ? 'equal' : 'changed'}` : `no entry: ${short(clean.text, 100)}`,
      evidence: 'mem_show on a clean entry; src/bidi.mjs documents the closed list and why Arabic and Hebrew letters are not on it',
      measured: { titleEqual: c1?.title === TC, textEqual: c1?.text === XC }, severity: SEVERITY.MAJOR,
    });
  } finally { await bridge.close(); }
  return ids;
}

// --- H11: the decision card over the bridge ------------------------------------------------------------------------

const OPT = Object.freeze(['Yes — it happens', 'No — it stays']);
const TARGET = 'probe-card-target';
/** One card as the fields of both roads: `mem_card_add` (question, context ...) and `mem_log` type card (card_question ...). */
const cardArgs = (road, c) => (road === 'add'
  ? ['mem_card_add', { target_id: TARGET, question: c.question, context: c.context, options: c.options, advice: c.advice, evidence: c.evidence, kind: c.kind }]
  : ['mem_log', {
    type: 'card', target_id: TARGET, card_question: c.question, card_context: c.context, card_options: c.options, card_advice: c.advice, card_evidence: c.evidence, card_kind: c.kind,
  }]);
const GOOD = Object.freeze({
  question: 'Should it happen?', context: 'It is time.', options: OPT, advice: 'Yes.', evidence: ['docs/x.md'], kind: 'decide',
});

export async function cardFields(atlas, { tree = REPO } = {}) {
  const ids = ['bridge.card.control', 'bridge.card.limits-edge', 'bridge.card.limits', 'bridge.card.shape', 'bridge.card.rank', 'bridge.card.person-stage1', 'bridge.card.person-stage2'];
  const root = tempRoot('atlas-bridge-card-');
  writeBridgeConfig(root);
  memory.logEntry(root, 'duty', { id: TARGET, title: 'target of the probe cards', agent: 'probe' });
  const shelfFile = path.join(root, 'global', 'cards.jsonl');
  const shelf = () => jsonLines(shelfFile).filter(Boolean);
  const bridge = await openBridge(root, { tree });
  try {
    // control: both roads accept a whole card, the lines stand as sent, the origin is the connected agent at tier agent
    const a = await bridge.call(...cardArgs('add', GOOD));
    const b = await bridge.call(...cardArgs('log', { ...GOOD, question: 'Should it happen via log?' }));
    const lines = shelf();
    const first = lines[0];
    const stands = Boolean(first) && first.card_question === GOOD.question && first.card_context === GOOD.context
      && JSON.stringify(first.card_options) === JSON.stringify(OPT) && first.card_advice === GOOD.advice && first.card_kind === GOOD.kind
      && first.agent === 'foreign' && first.authority === 'agent';
    const listed = await bridge.call('mem_card_list', {});
    const controlOk = emit(atlas, {
      id: ids[0], title: 'H11 control: a whole card is accepted on both roads (mem_card_add and mem_log type card), stands as sent, comes from the connected agent at tier agent, and is listed',
      ok: !a.isError && !b.isError && lines.length === 2 && stands && !listed.isError && /1 card\(s\)/.test(listed.text),
      expected: '2 accepted; 2 lines on the shelf; fields as sent; agent foreign; authority agent; mem_card_list shows the target once',
      actual: `add ${a.isError ? `refused: ${short(a.text, 80)}` : 'accepted'}, log ${b.isError ? `refused: ${short(b.text, 80)}` : 'accepted'}; ${lines.length} lines; fields ${stands ? 'as sent' : 'altered or missing'}; list: ${short(listed.text, 60)}`,
      evidence: `global/cards.jsonl of the throwaway root; target ${TARGET} is an existing duty`, measured: { lines: lines.length, stands },
    });
    if (!controlOk) {
      skipAll(atlas, ids.slice(1).map((id) => ({ id, title: `bridge card (${id})`, expected: 'see the group' })), 'the positive control bridge.card.control failed: a refusal could be the harness\'s');
      return;
    }
    // edge: the limits themselves are allowed (the threshold is exactly the number, not a number below it)
    const q = `${words(159)}?`;
    const edgeOpts = [`${words(80)} — ${words(240)}`, 'No — it stays', 'Later — not now', 'Maybe — ask', 'Part — half', 'Skip — nothing'];
    const edge = { question: q, context: words(320), options: edgeOpts, advice: words(200), evidence: Array.from({ length: 8 }, (_, i) => `docs/e${i}.md`), kind: 'approve' };
    const before = shelf().length;
    const ea = await bridge.call(...cardArgs('add', edge));
    const el = await bridge.call(...cardArgs('log', { ...edge, question: `${words(158)}??` }));
    const grew = shelf().length - before;
    emit(atlas, {
      id: ids[1], title: 'H11: a card exactly at every limit (question 160, context 320, advice 200, choice 80, effect 240, six options, eight pieces of evidence) is accepted on both roads',
      ok: !ea.isError && !el.isError && grew === 2,
      expected: '2 of 2 accepted; 2 lines added',
      actual: `add ${ea.isError ? `refused: ${short(ea.text, 120)}` : 'accepted'}, log ${el.isError ? `refused: ${short(el.text, 120)}` : 'accepted'}; ${grew} lines added`,
      evidence: 'src/cardrules.mjs LIMITS: question 160, context 320, advice 200, choice 80, effect 240, optionsMax 6, evidenceMax 8',
      measured: { added: grew }, severity: SEVERITY.MINOR,
    });
    // limits: one over, on both roads; each refusal names the limit it hit and nothing is written
    const over = [
      ['question 161', { question: `${words(160)}?` }, /card_question is 161 characters/],
      ['context 321', { context: words(321) }, /card_context is 321 characters/],
      ['advice 201', { advice: words(201) }, /card_advice is 201 characters/],
      ['seven options', { options: [...OPT, 'A — a', 'B — b', 'C — c', 'D — d', 'E — e'] }, /at most 6 options/],
      ['nine pieces of evidence', { evidence: Array.from({ length: 9 }, (_, i) => `docs/e${i}.md`) }, /at most 8 pieces of evidence/],
      ['choice 81', { options: [`${words(81)} — effect`, 'No — it stays'] }, /choice is longer than 80/],
      ['effect 241', { options: [`Yes — ${words(241)}`, 'No — it stays'] }, /effect is longer than 240/],
    ];
    const base = shelf().length;
    let refused = 0; let named = 0; let asked = 0;
    const missed = [];
    for (const [label, change, re] of over) {
      for (const road of ['add', 'log']) {
        asked += 1;
        const r = await bridge.call(...cardArgs(road, { ...GOOD, ...change }));
        if (r.isError) refused += 1;
        if (r.isError && re.test(r.text)) named += 1; else missed.push(`${label}/${road}`);
      }
    }
    const written = shelf().length - base;
    emit(atlas, {
      id: ids[2], title: 'H11: one over any limit (question, context, advice, options, evidence, choice, effect) is refused on both roads, names the limit, and writes nothing',
      ok: refused === asked && named === asked && written === 0,
      expected: `${asked} of ${asked} refused, each naming its limit; 0 lines written`,
      actual: `${refused} of ${asked} refused, ${named} naming the limit, ${written} lines written${missed.length ? `; not named or accepted: ${missed.join(', ')}` : ''}`,
      evidence: 'mem_card_add and mem_log type card with the limits of src/cardrules.mjs plus one', measured: { asked, refused, named, written }, severity: SEVERITY.MAJOR,
    });
    // shape: the wrong type of value, a card field on a type without a card, an unknown kind, a bad or missing target, an incomplete card
    const shapeAttacks = [
      ['thought with card_question', ['mem_log', { type: 'thought', text: 'x', card_question: 'F?' }], /'card_question' is not allowed/],
      ['decision with card_options', ['mem_log', { type: 'decision', title: 't', choice: 'a', why: 'w', card_options: OPT }], /'card_options' is not allowed/],
      ['error with card_kind', ['mem_log', { type: 'error', title: 't', class: 'wrong-cause', text: 'x', card_kind: 'decide' }], /'card_kind' is not allowed/],
      ['question as an object', ['mem_card_add', { target_id: TARGET, question: { a: 1 }, context: 'c', options: OPT }], /'question' must be a string/],
      ['card_question as a number', ['mem_log', { type: 'card', target_id: TARGET, card_question: 5, card_context: 'c', card_options: OPT }], /card_question \(a string\)/],
      ['card_options as objects', ['mem_log', { type: 'card', target_id: TARGET, card_question: 'Q?', card_context: 'c', card_options: [{ a: 1 }] }], /card_options \(an array of strings\)/],
      ['unknown kind', ['mem_card_add', { ...cardArgs('add', GOOD)[1], kind: 'hear' }], /card_kind 'hear' does not exist/],
      ['target of a bad form', ['mem_card_add', { ...cardArgs('add', GOOD)[1], target_id: '../x' }], /target_id has a form that is not allowed/],
      ['target that does not exist', ['mem_card_add', { ...cardArgs('add', GOOD)[1], target_id: 'nosuchid1234' }], /no entry with id 'nosuchid1234'/],
      ['no target', ['mem_log', { type: 'card', card_question: 'Q?', card_context: 'c', card_options: OPT }], /target_id missing/],
      ['no context', ['mem_card_add', { target_id: TARGET, question: 'Q?', options: OPT }], /card_context missing/],
      ['one option', ['mem_card_add', { target_id: TARGET, question: 'Q?', context: 'c', options: ['Yes — x'] }], /at least two options/],
      ['no No option', ['mem_card_add', { target_id: TARGET, question: 'Q?', context: 'c', options: ['Yes — x', 'Maybe — y'] }], /no No \/ not-now option/],
    ];
    const rowsAll = () => shelf().length + ['thought', 'decision', 'error'].reduce((s, t) => s + rowsOf(root, t), 0);
    const base2 = rowsAll();
    let shapeRefused = 0; let shapeNamed = 0;
    const slipped = [];
    for (const [label, call, re] of shapeAttacks) {
      const r = await bridge.call(...call);
      if (r.isError) shapeRefused += 1;
      if (r.isError && re.test(r.text)) shapeNamed += 1; else slipped.push(label);
    }
    const shapeWritten = rowsAll() - base2;
    emit(atlas, {
      id: ids[3], title: 'H11: a card field on a type with no card, a value of the wrong type, an unknown kind, a bad or missing target and an incomplete card are refused with the reason, and nothing is written',
      ok: shapeRefused === shapeAttacks.length && shapeNamed === shapeAttacks.length && shapeWritten === 0,
      expected: `${shapeAttacks.length} of ${shapeAttacks.length} refused with the expected reason; 0 rows written`,
      actual: `${shapeRefused} of ${shapeAttacks.length} refused, ${shapeNamed} with the expected reason, ${shapeWritten} rows written${slipped.length ? `; off: ${slipped.join(', ')}` : ''}`,
      evidence: `attacks: ${shapeAttacks.map(([l]) => l).join('; ')}`, measured: { asked: shapeAttacks.length, refused: shapeRefused, named: shapeNamed, written: shapeWritten }, severity: SEVERITY.MAJOR,
    });
    // rank: a card from the bridge is tier agent whatever it claims; a person's card is not displaced
    const personTarget = 'probe-person-target';
    memory.logEntry(root, 'duty', { id: personTarget, title: 'target of the person card', agent: 'probe' });
    cardstore.write(root, { target_id: personTarget, question: 'Person asks?', context: 'A person wrote this.', options: OPT }, { agent: 'human:probe', authority: 'user' });
    const claim = await bridge.call('mem_card_add', { ...cardArgs('add', GOOD)[1], target_id: personTarget, question: 'Agent claims tier user?', authority: 'user' });
    const claimLog = await bridge.call('mem_log', { type: 'card', target_id: personTarget, card_question: 'Agent claims tier user via log?', card_context: 'c', card_options: OPT, authority: 'user' });
    const forged = [];
    for (const f of [{ rank: 'user' }, { authority_clamped_from: 'agent' }, { by_id: 'abcd1234' }]) {
      forged.push(await bridge.call('mem_log', { type: 'card', target_id: personTarget, card_question: 'Forged field?', card_context: 'c', card_options: OPT, ...f }));
    }
    const mine = shelf().filter((l) => l.target_id === personTarget);
    const claimed = mine.find((l) => l.card_question === 'Agent claims tier user?');
    const claimedLog = mine.find((l) => l.card_question === 'Agent claims tier user via log?');
    const forgedLines = mine.filter((l) => l.card_question === 'Forged field?').length;
    const listing = await bridge.call('mem_card_list', {});
    const personLine = String(listing.text).split('\n').find((l) => l.startsWith(personTarget)) ?? '';
    const refusedNamed = forged.filter((r, i) => r.isError && r.text.includes(`'${['rank', 'authority_clamped_from', 'by_id'][i]}'`)).length;
    emit(atlas, {
      id: ids[4], title: 'H11: a card from the bridge is tier agent whatever it claims (the claim is recorded as lowered), a forged rank field is refused by name, and a card a person wrote stays the one that counts',
      ok: !claim.isError && claimed?.authority === 'agent' && !claimLog.isError && claimedLog?.authority === 'agent' && claimedLog?.authority_clamped_from === 'user'
        && refusedNamed === 3 && forgedLines === 0 && /Person asks\?/.test(personLine) && /tier user/.test(personLine),
      expected: 'claimed tier user stored as agent on both roads (clamp recorded on mem_log); 3 of 3 forged rank fields refused by name, none written; mem_card_list still shows the person\'s card at tier user',
      actual: `add: stored ${claimed?.authority ?? 'nothing'}; log: stored ${claimedLog?.authority ?? 'nothing'}, clamped_from ${claimedLog?.authority_clamped_from ?? '(none)'}; ${refusedNamed} of 3 forged fields refused by name, ${forgedLines} written; list line: ${short(personLine, 100)}`,
      evidence: 'cardstore.write as a person (human:probe, tier user) first; then the bridge writes for the same target; src/memory.mjs checks tier user on a card, src/bridgefields.mjs refuses the fields',
      measured: { addTier: claimed?.authority ?? null, logTier: claimedLog?.authority ?? null, clamped: claimedLog?.authority_clamped_from ?? null, forgedRefusedNamed: refusedNamed, forgedWritten: forgedLines }, severity: SEVERITY.CRITICAL,
    });
    // the person rule, stage 1: a duty or question put to the human without a proper card is taken in AND named
    const human = 'user';
    const dutyRows = () => rowsOf(root, 'duty') + rowsOf(root, 'question');
    const cases = [
      ['duty to the human, no card', { type: 'duty', title: 'No card duty', who: human }, /Explanation missing/, true],
      ['duty to the human, card over the limit', { type: 'duty', title: 'Long card duty', who: human, card_question: words(200), card_context: 'c', card_options: OPT }, /Card not to the rules/, true],
      ['duty to the human, whole card', { type: 'duty', title: 'Whole card duty', who: human, card_question: 'Should it?', card_context: 'c', card_options: OPT }, null, false],
      ['duty to an agent, no card', { type: 'duty', title: 'Agent duty', who: 'librarian' }, null, false],
      ['question without an addressee', { type: 'question', question: 'Is it?', text: 'x' }, null, false],
    ];
    const stage1 = [];
    const dBefore = dutyRows();
    for (const [label, args, re, shouldNote] of cases) {
      const r = await bridge.call('mem_log', args);
      const noted = /Explanation missing|Card not to the rules/.test(r.text);
      stage1.push({ label, accepted: !r.isError, ok: !r.isError && (re ? re.test(r.text) : !noted), noted, shouldNote });
    }
    const taken = dutyRows() - dBefore;
    emit(atlas, {
      id: ids[5], title: 'H11 person rule, stage 1: a duty to the human with no card or a card over the limit is taken in and named ("Explanation missing" / "Card not to the rules"); a whole card, a duty to an agent and a question without an addressee are not',
      ok: stage1.every((s) => s.ok) && taken === cases.length,
      expected: `${cases.length} of ${cases.length} accepted (${cases.length} rows); the first two name the gap; the other three carry no note`,
      actual: `${stage1.map((s) => `${s.label}: ${s.accepted ? 'accepted' : 'refused'}${s.noted ? ', noted' : ', no note'}${s.ok ? '' : ' (WRONG)'}`).join('; ')}; ${taken} rows`,
      evidence: 'mem_log over the stdio bridge, route mcp; src/cardrule.mjs judges by the configured human participant (user), not by name in src/',
      measured: { cases: stage1, rows: taken }, severity: SEVERITY.MAJOR,
    });
  } finally { await bridge.close(); }
  // stage 2 is the same rule with the switch on; its own bridge (the switch is read from the environment of the process)
  const strict = await openBridge(root, { tree, env: { CHEAP_MEM_CARD_REJECT: 'yes' } });
  try {
    const base = rowsOf(root, 'duty');
    const bare = await strict.call('mem_log', { type: 'duty', title: 'Strict bare duty', who: 'user' });
    const long = await strict.call('mem_log', { type: 'duty', title: 'Strict long card duty', who: 'user', card_question: words(200), card_context: 'c', card_options: OPT });
    const afterRefused = rowsOf(root, 'duty');
    const whole = await strict.call('mem_log', { type: 'duty', title: 'Strict whole card duty', who: 'user', card_question: 'Should it?', card_context: 'c', card_options: OPT });
    const agentDuty = await strict.call('mem_log', { type: 'duty', title: 'Strict agent duty', who: 'librarian' });
    const wholeOk = !whole.isError && !agentDuty.isError;
    if (!wholeOk) {
      notMeasured(atlas, {
        id: ids[6], title: 'H11 person rule, stage 2', expected: 'refused, nothing written',
        reason: `the controls of the strict bridge failed (whole card ${whole.isError ? 'refused' : 'accepted'}, duty to an agent ${agentDuty.isError ? 'refused' : 'accepted'}): a refusal could be the harness's`,
      });
    } else {
      emit(atlas, {
        id: ids[6], title: 'H11 person rule, stage 2 (CHEAP_MEM_CARD_REJECT=yes): a duty to the human with no card, or with a card over the limit, is refused, nothing is written; a whole card and a duty to an agent still go through',
        ok: bare.isError && long.isError && afterRefused === base && /CARD_MISSING|card/i.test(bare.text) && /card_question/.test(bare.text),
        expected: '2 of 2 refused, the reason names the missing card_question; 0 rows added by them; the two controls accepted',
        actual: `bare ${bare.isError ? 'refused' : 'ACCEPTED'}, long ${long.isError ? 'refused' : 'ACCEPTED'}; rows ${base} -> ${afterRefused}; message: ${short(bare.text, 120)}`,
        evidence: 'a second stdio bridge on the same root with the switch in its environment', measured: { bareRefused: bare.isError, longRefused: long.isError, rowsAdded: afterRefused - base }, severity: SEVERITY.MAJOR,
      });
    }
  } finally { await strict.close(); }
  return ids;
}

// --- A14: the HTTP doors -------------------------------------------------------------------------------------------

const TOKEN_VAR = 'CHEAP_MEM_MCP_TOKEN';
const SWITCH_VAR = 'CHEAP_MEM_MCP_LOCAL_NO_TOKEN';
const STALL_MS = 30000;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
/** The environment of a door process: the minimum it needs plus what the case sets (never the parent's CHEAP_MEM_* variables). */
function doorEnv(root, extra) {
  const env = { CHEAP_MEM_ROOT: root, CHEAP_MEM_AGENT: 'foreign', MEM_HEADLESS: '', MEM_RECALL_SERVER: '0' };
  for (const k of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'USERPROFILE']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}
/**
 * Start `script args` and say what happened: `up` (the start line appeared), or the exit code. Only the child this call
 * started is ever stopped. `stop()` ends it and waits for the exit.
 */
function startDoor({ script, args, env, upLine, cwd }) {
  return new Promise((resolve) => {
    const kid = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; let out = ''; let exited = false; let done = false;
    const stop = () => new Promise((r) => {
      if (exited) { r(); return; }
      kid.once('exit', () => r());
      try { kid.kill(); } catch { r(); }
    });
    const finish = (up, code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ up, code, text: err + out, stop });
    };
    const check = () => { if (upLine.test(err) || upLine.test(out)) finish(true, null); };
    const timer = setTimeout(() => finish(false, 'stalled'), STALL_MS);
    kid.stderr.on('data', (d) => { err += d; check(); });
    kid.stdout.on('data', (d) => { out += d; check(); });
    kid.on('exit', (c) => { exited = true; finish(false, c); });
    kid.on('error', (e) => { err += String(e && e.message); finish(false, 'spawn-error'); });
  });
}
const BRIDGE_UP = /cheap-mem MCP \(http\)[\s\S]*token=/;

function request(port, { method = 'POST', urlPath = '/mcp', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.setTimeout(20000, () => req.destroy(new Error('no answer inside the stall guard')));
    req.once('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const toolNames = (res) => { try { return JSON.parse(res.text).result.tools.map((t) => t.name); } catch { return []; } };

export async function httpDoors(atlas, { tree = REPO } = {}) {
  const ids = [
    'bridge.http-token.start-control', 'bridge.http-token.start-refused', 'bridge.http-token.accepted', 'bridge.http-token.rejected',
    'bridge.http-token.local-switch', 'bridge.http-token.read-only-default', 'bridge.http-token.dashboard',
  ];
  const mcp = path.join(tree, 'bin', 'mem-mcp');
  const serve = path.join(tree, 'bin', 'mem-serve');
  const root = tempRoot('atlas-bridge-http-');
  writeBridgeConfig(root);
  const secret = ['atlas', 'door', crypto.randomBytes(9).toString('hex')].join('-');
  const run = async (extra, args = ['--http'], cwd = root) => {
    const port = await freePort();
    const r = await startDoor({ script: mcp, args, cwd, upLine: BRIDGE_UP, env: doorEnv(root, { CHEAP_MEM_MCP_PORT: String(port), ...extra }) });
    return { ...r, port };
  };
  const opened = [];
  try {
    // 1. control: the start cases that must work
    const cases = [
      ['token, loopback', { [TOKEN_VAR]: secret }, ['--http'], /token=set/],
      ['token, 0.0.0.0', { [TOKEN_VAR]: secret, CHEAP_MEM_MCP_HOST: '0.0.0.0' }, ['--http'], /token=set/],
      ['--local-no-token, loopback', {}, ['--http', '--local-no-token'], /token=none/],
      [`${SWITCH_VAR}=1, loopback`, { [SWITCH_VAR]: '1' }, ['--http'], /token=none/],
    ];
    const started = [];
    for (const [label, extra, args, re] of cases) {
      const r = await run(extra, args);
      started.push({ label, up: r.up, line: re.test(r.text), leaked: r.text.includes(secret), code: r.code });
      await r.stop();
    }
    const upCount = started.filter((s) => s.up && s.line).length;
    const leaked = started.filter((s) => s.leaked).length;
    const controlOk = emit(atlas, {
      id: ids[0], title: 'A14 control: the HTTP bridge starts with a token (loopback and 0.0.0.0), and without one only on purpose (--local-no-token or the switch variable), on loopback; the token value is never printed',
      ok: upCount === cases.length && leaked === 0,
      expected: `${cases.length} of ${cases.length} started with the right start line (token=set / token=none); 0 token values in the output`,
      actual: `${upCount} of ${cases.length} started (${started.map((s) => `${s.label}: ${s.up ? (s.line ? 'up' : 'up, wrong line') : `not up (${s.code})`}`).join('; ')}); ${leaked} outputs carried the token`,
      evidence: 'bin/mem-mcp --http as a process on a free port, clean environment; the case ends the child it started',
      measured: { started: upCount, leaked }, severity: SEVERITY.CRITICAL,
    });
    if (!controlOk) {
      skipAll(atlas, ids.slice(1).map((id) => ({ id, title: `bridge http door (${id})`, expected: 'see the group' })), 'the positive control bridge.http-token.start-control failed: a refusal or a 401 could be the harness\'s');
      return;
    }
    // 2. refused starts
    const refusals = [
      ['no token, no switch', {}, ['--http'], new RegExp(`${TOKEN_VAR}[\\s\\S]*--local-no-token`)],
      ['public bind, no token', { CHEAP_MEM_MCP_HOST: '0.0.0.0' }, ['--http'], new RegExp(`Refusing to bind[\\s\\S]*${TOKEN_VAR}`)],
      ['switch + public bind', { [SWITCH_VAR]: '1', CHEAP_MEM_MCP_HOST: '0.0.0.0' }, ['--http'], new RegExp(`Refusing to bind[\\s\\S]*${TOKEN_VAR}`)],
      ['flag + public bind', { CHEAP_MEM_MCP_HOST: '0.0.0.0' }, ['--http', '--local-no-token'], new RegExp(`Refusing to bind[\\s\\S]*${TOKEN_VAR}`)],
      ['switch value "true"', { [SWITCH_VAR]: 'true' }, ['--http'], new RegExp(`${TOKEN_VAR}[\\s\\S]*--local-no-token`)],
      ['switch value "0"', { [SWITCH_VAR]: '0' }, ['--http'], new RegExp(`${TOKEN_VAR}[\\s\\S]*--local-no-token`)],
      ['empty token', { [TOKEN_VAR]: '' }, ['--http'], new RegExp(`${TOKEN_VAR}[\\s\\S]*--local-no-token`)],
    ];
    const tried = [];
    for (const [label, extra, args, re] of refusals) {
      const r = await run(extra, args);
      tried.push({ label, up: r.up, code: r.code, named: re.test(r.text) });
      await r.stop();
    }
    const refusedN = tried.filter((t) => !t.up && t.code === 1).length;
    const namedN = tried.filter((t) => t.named).length;
    const upN = tried.filter((t) => t.up).length;
    emit(atlas, {
      id: ids[1], title: 'A14: without a token the HTTP bridge refuses to start (exit 1) and names the token variable and the switch; a public bind is refused first and the switch never lifts it; only the exact flag or the value 1 counts',
      ok: refusedN === tried.length && namedN === tried.length && upN === 0,
      expected: `${tried.length} of ${tried.length} refused with exit 1, each message naming ${TOKEN_VAR} (and --local-no-token where the switch could help); 0 processes up`,
      actual: `${refusedN} of ${tried.length} refused, ${namedN} named, ${upN} came up; ${tried.map((t) => `${t.label}: ${t.up ? 'UP' : t.code}`).join('; ')}`,
      evidence: 'bin/mem-mcp --http as a process; src/webauth.mjs startDecision; stdio is not affected and is not started here',
      measured: { asked: tried.length, refused: refusedN, named: namedN, up: upN }, severity: SEVERITY.CRITICAL,
    });
    // 3. requests against a bridge with a token (full profile, so a write could be tried)
    const door = await run({ [TOKEN_VAR]: secret, CHEAP_MEM_MCP_READONLY: '0' });
    opened.push(door);
    if (!door.up) {
      for (const id of [ids[2], ids[3]]) notMeasured(atlas, { id, title: `bridge http requests (${id})`, expected: 'see the group', reason: `the bridge with a token did not start (${door.code}): ${short(door.text, 160)}` });
    } else {
      const list = rpc('tools/list');
      const write = rpc('tools/call', { name: 'mem_log', arguments: { type: 'thought', text: 'written over http', tags: ['doors'] } }, 2);
      const authed = { authorization: `Bearer ${secret}` };
      const okList = await request(door.port, { headers: authed, body: list });
      const t0 = rowsOf(root, 'thought');
      const okWrite = await request(door.port, { headers: authed, body: write });
      const wrote = rowsOf(root, 'thought') - t0;
      const health = await request(door.port, { method: 'GET', urlPath: '/health' });
      const acceptedOk = emit(atlas, {
        id: ids[2], title: 'A14 control: with the right token the bridge answers tools/list and takes a write (full profile); /health answers without a credential and carries no memory content',
        ok: okList.status === 200 && toolNames(okList).includes('mem_find') && okWrite.status === 200 && wrote === 1 && health.status === 200 && health.text === 'ok',
        expected: 'tools/list 200 with mem_find; tools/call mem_log 200 and +1 row; /health 200 "ok"',
        actual: `tools/list ${okList.status}, ${toolNames(okList).length} tools; mem_log ${okWrite.status}, ${wrote} rows; /health ${health.status} ${short(health.text, 20)}`,
        evidence: 'HTTP requests to the process of the first case, token as a Bearer header', measured: { list: okList.status, write: okWrite.status, rows: wrote, health: health.status }, severity: SEVERITY.MAJOR,
      });
      if (!acceptedOk) {
        notMeasured(atlas, { id: ids[3], title: 'bridge http rejected', expected: 'see the group', reason: 'the control bridge.http-token.accepted failed: a 401 could be the harness\'s' });
      } else {
        const half = secret.slice(0, Math.floor(secret.length / 2));
        const bad = [
          ['no credential', {}, list, '/mcp'],
          ['wrong token', { authorization: 'Bearer wrong-token-value' }, list, '/mcp'],
          ['first half of the token', { authorization: `Bearer ${half}` }, list, '/mcp'],
          ['the token and a suffix', { authorization: `Bearer ${secret}x` }, list, '/mcp'],
          ['another scheme', { authorization: `Basic ${Buffer.from(`u:${secret}`).toString('base64')}` }, list, '/mcp'],
          ['token in the query string', {}, list, `/mcp?token=${secret}`],
          ['wrong token, a write', { authorization: 'Bearer wrong-token-value' }, write, '/mcp'],
          ['no credential, a write', {}, write, '/mcp'],
        ];
        const before = rowsOf(root, 'thought');
        const results = [];
        for (const [label, headers, body, urlPath] of bad) results.push({ label, res: await request(door.port, { headers, body, urlPath }) });
        const added = rowsOf(root, 'thought') - before;
        const n401 = results.filter((r) => r.res.status === 401).length;
        const challenge = results.filter((r) => /bearer/i.test(String(r.res.headers['www-authenticate'] ?? ''))).length;
        const leakedBody = results.filter((r) => r.res.text.includes(secret)).length;
        emit(atlas, {
          id: ids[3], title: 'A14: a request without the token, with a wrong, truncated or extended token, with another scheme, with the token in the query string, or a write with none is answered 401 with a Bearer challenge, and writes nothing',
          ok: n401 === bad.length && challenge === bad.length && added === 0 && leakedBody === 0,
          expected: `${bad.length} of ${bad.length} answered 401 with www-authenticate Bearer; 0 rows written; the token never in a body`,
          actual: `${n401} of ${bad.length} answered 401, ${challenge} with the challenge, ${added} rows written, ${leakedBody} bodies with the token; ${results.map((r) => `${r.label}: ${r.res.status}`).join('; ')}`,
          evidence: 'HTTP requests to the bridge of the control; rows counted in global/thoughts.jsonl', measured: { asked: bad.length, unauthorized: n401, challenge, written: added }, severity: SEVERITY.CRITICAL,
        });
      }
    }
    await door.stop();
    // 4. the loopback switch: local without a proxy header, turned away with one
    const local = await run({ [SWITCH_VAR]: '1' });
    opened.push(local);
    if (!local.up) {
      notMeasured(atlas, { id: ids[4], title: 'bridge http local switch', expected: 'see the group', reason: `the bridge with the switch did not start (${local.code}): ${short(local.text, 160)}` });
    } else {
      const list = rpc('tools/list');
      const plain = await request(local.port, { body: list });
      const away = [
        ['X-Forwarded-For', { 'x-forwarded-for': '203.0.113.9' }],
        ['Forwarded', { forwarded: 'for=203.0.113.9' }],
        ['CF-Connecting-IP', { 'cf-connecting-ip': '203.0.113.9' }],
        ['Via', { via: '1.1 proxy' }],
      ];
      const hdrRes = [];
      for (const [label, headers] of away) hdrRes.push({ label, res: await request(local.port, { headers, body: list }) });
      const foreignHost = await request(local.port, { headers: { host: 'attacker.invalid' }, body: list });
      const foreignOrigin = await request(local.port, { headers: { origin: 'http://attacker.invalid' }, body: list });
      const turned = hdrRes.filter((r) => r.res.status === 403).length;
      emit(atlas, {
        id: ids[4], title: 'A14: with the loopback switch and no token, a plain local request is served; a request that carries a proxy header, a foreign Host or a foreign Origin is turned away (403)',
        ok: plain.status === 200 && toolNames(plain).includes('mem_find') && turned === away.length && foreignHost.status === 403 && foreignOrigin.status === 403,
        expected: `plain 200; ${away.length} of ${away.length} proxy-header requests 403; foreign Host 403; foreign Origin 403`,
        actual: `plain ${plain.status}; ${turned} of ${away.length} proxy headers 403 (${hdrRes.map((r) => `${r.label}: ${r.res.status}`).join(', ')}); foreign Host ${foreignHost.status}; foreign Origin ${foreignOrigin.status}`,
        evidence: 'HTTP requests to a bridge started with the switch; src/webauth.mjs remoteIsLoopback (strict) and hostAllowed; a proxy on this machine that adds no header cannot be told apart (the start notice says so)',
        measured: { plain: plain.status, proxyHeaders403: turned, host: foreignHost.status, origin: foreignOrigin.status }, severity: SEVERITY.CRITICAL,
      });
    }
    await local.stop();
    // 5. the default profile of the HTTP bridge is read-only
    const ro = await run({ [TOKEN_VAR]: secret });
    opened.push(ro);
    if (!ro.up) {
      notMeasured(atlas, { id: ids[5], title: 'bridge http default profile', expected: 'see the group', reason: `the bridge with a token did not start (${ro.code}): ${short(ro.text, 160)}` });
    } else {
      const authed = { authorization: `Bearer ${secret}` };
      const names = toolNames(await request(ro.port, { headers: authed, body: rpc('tools/list') }));
      const before = rowsOf(root, 'thought');
      const attempt = await request(ro.port, { headers: authed, body: rpc('tools/call', { name: 'mem_log', arguments: { type: 'thought', text: 'must not be written' } }, 3) });
      const rows = rowsOf(root, 'thought') - before;
      let refusedCall = false;
      try { const j = JSON.parse(attempt.text); refusedCall = Boolean(j.error) || j.result?.isError === true; } catch { refusedCall = attempt.status >= 400; }
      emit(atlas, {
        id: ids[5], title: 'A14: the HTTP bridge offers the read tools only unless the operator opens the full profile; a write call with the right token is refused and writes nothing',
        ok: names.includes('mem_find') && !names.includes('mem_log') && refusedCall && rows === 0,
        expected: 'mem_find listed, mem_log not listed; tools/call mem_log refused; 0 rows',
        actual: `${names.length} tools listed (mem_find ${names.includes('mem_find')}, mem_log ${names.includes('mem_log')}); write call ${refusedCall ? 'refused' : 'ACCEPTED'}; ${rows} rows`,
        evidence: 'bin/mem-mcp --http without CHEAP_MEM_MCP_READONLY; src/mcpprofile.mjs', measured: { listed: names.length, writeListed: names.includes('mem_log'), rows }, severity: SEVERITY.MAJOR,
      });
    }
    await ro.stop();
    // 6. the dashboard obeys the same start rule; its password login counts as a credential, the bridge's never could
    const dash = async (extra, args = []) => {
      const port = await freePort();
      const r = await startDoor({ script: serve, args, cwd: root, upLine: /cheap-mem console on http/, env: doorEnv(root, { CHEAP_MEM_SERVE_PORT: String(port), ...extra }) });
      return r;
    };
    const dcases = [
      ['login on (the default), no token', {}, true],
      ['login off, token', { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: secret }, true],
      ['login off, loopback switch', { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1' }, true],
      ['login off, no token, no switch', { CHEAP_MEM_SERVE_LOGIN: 'off' }, false],
      ['login off, switch, public bind', { CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1', CHEAP_MEM_SERVE_HOST: '0.0.0.0' }, false],
    ];
    const dres = [];
    for (const [label, extra, shouldRun] of dcases) {
      const r = await dash(extra);
      dres.push({ label, shouldRun, up: r.up, code: r.code, leaked: r.text.includes(secret), named: r.up || /CHEAP_MEM_SERVE_TOKEN/.test(r.text) });
      await r.stop();
    }
    const right = dres.filter((d) => d.up === d.shouldRun && (d.shouldRun || d.code === 1) && d.named).length;
    emit(atlas, {
      id: ids[6], title: 'A14: the dashboard (bin/mem-serve) starts with its password login, a token or the loopback switch, and refuses with none of them or on a public bind without a token; the login counts there, never at the MCP bridge',
      ok: right === dcases.length && !dres.some((d) => d.leaked),
      expected: `${dcases.length} of ${dcases.length} as decided (3 start, 2 refused with exit 1 naming CHEAP_MEM_SERVE_TOKEN); 0 token values in the output`,
      actual: `${right} of ${dcases.length} as decided; ${dres.map((d) => `${d.label}: ${d.up ? 'up' : d.code}`).join('; ')}`,
      evidence: 'bin/mem-serve as a process with the recall server off; src/webauth.mjs startDecision is the one rule both doors read (decision 2hhdn4aug8uk)',
      measured: { asked: dcases.length, asDecided: right }, severity: SEVERITY.CRITICAL,
    });
  } finally {
    for (const d of opened) { try { await d.stop(); } catch { /* it is going away anyway */ } }
  }
  return ids;
}

// --- all groups ----------------------------------------------------------------------------------------------------

/** The gap groups, each guarded: a group that throws turns its unwritten records into `not-measured`, never into silence. */
export async function gapGroups(atlas, { tree = REPO } = {}) {
  const list = [
    [sdkFloor, ['bridge.sdk.range', 'bridge.sdk.installed']],
    [bidiExits, ['bridge.bidi.world', 'bridge.bidi.exits', 'bridge.bidi.structured', 'bridge.bidi.roundtrip', 'bridge.bidi.all-nine', 'bridge.bidi.clean']],
    [cardFields, ['bridge.card.control', 'bridge.card.limits-edge', 'bridge.card.limits', 'bridge.card.shape', 'bridge.card.rank', 'bridge.card.person-stage1', 'bridge.card.person-stage2']],
    [httpDoors, ['bridge.http-token.start-control', 'bridge.http-token.start-refused', 'bridge.http-token.accepted', 'bridge.http-token.rejected',
      'bridge.http-token.local-switch', 'bridge.http-token.read-only-default', 'bridge.http-token.dashboard']],
  ];
  for (const [fn, ids] of list) await guard(atlas, ids, () => fn(atlas, { tree }));
}

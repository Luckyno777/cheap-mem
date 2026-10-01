// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * askedlearn — query words learned from real misses (M18b, the port of
 * lucky-mem's M8 `mem knapp --lernen`).
 *
 * **The gap.** A person asks in their own language, the agents wrote the
 * entry in English, and recall comes back empty. The session then goes
 * and gets the entry anyway — `mem show <id>`, a `--relates <id>`, the
 * person pasting the id. The memory saw the miss and never learned
 * from it. This module turns such a miss into `asked` words on the
 * entry (the field the digester already fills with "what someone would
 * ask to find this", ranked like tags), so the next question in the
 * same words finds it. Nobody writes a dictionary: the bridge is built
 * out of the user's own questions, for whatever language pair they use.
 *
 * **What counts as evidence — and why only that.** A miss becomes a
 * case only when the SAME session, after the question, names an entry
 * by its id
 *   - in a real input of the person (a `user` line that is not a tool
 *     result), or
 *   - in a tool call of the session (`mem show <id>`, `--relates <id>`),
 * within {@link MENTION_WINDOW_MS} — AND the memory did NOT itself show
 * that entry to the session in that time (no journal line of the
 * session with it in `sources`). The second condition is the latch
 * against self-reinforcement: what the system showed, and what the
 * session therefore repeats, is no evidence anybody looked for it.
 *
 * **Language-neutral.** Which words are taken is decided only by the
 * counts of the corpus and by the stop lists search already uses: not
 * already in the entry, rare in the corpus ({@link DF_SHARE_MAX}), not a
 * stop word of any language pack or of a switched-on language bridge,
 * and not a word that the same run or an earlier one learned for a
 * DIFFERENT entry (that word is the shape of the question, not its
 * subject). A word the corpus does not know at all ("facturación" in an
 * English memory) is the most valuable one: it is the bridge the entry
 * was missing.
 *
 * **Write path.** Only `memory.correctionEntry()` — a new line with
 * `replaces_id`, full content, the extended `asked` and an
 * `asked_evidence` record naming the journal line, the session and how
 * the use is evidenced. No line is ever rewritten.
 *
 * **Question text.** The journal never carries it (privacy). It is read
 * from the session's raw capture, in memory; only the filtered words
 * reach the entry, never the sentence.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as injection from './injection.mjs';
import * as memory from './memory.mjs';
import * as raw from './raw.mjs';
import * as search from './search.mjs';
import * as langbridge from './langbridge.mjs';
import { pack } from './language.mjs';
import { DETECTABLE_LANGUAGES } from './langdetect.mjs';

/** How long after the miss a mention still belongs to it. */
export const MENTION_WINDOW_MS = 30 * 60 * 1000;

/** How far journal time and prompt time may lie apart. */
export const QUESTION_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * A word in more than this share of the curated entries tells nothing
 * apart and is not taken. Same bound as lucky-mem M8 (2 %).
 */
export const DF_SHARE_MAX = 0.02;

/** Shortest word that is learned, in characters. */
export const WORD_MIN = 4;

/** At most this many words per case — rarest first. */
export const WORDS_MAX = 5;

/**
 * H4 (Block H, ported from lucky-mem): for a SHOWN miss (something was
 * injected, but the session then fetched a different entry by hand) the
 * question is often a pasted message, not a subject — long texts teach
 * only rubble. Measured there on the real journal (2026-09-30): without
 * this bound 7 of 7 cases learned words like 'allem', 'vorallem' and a
 * hex id. The bound holds ONLY for shown misses.
 */
const SHOWN_QUESTION_MAX_CHARS = 240;

/** Which rule produced a case; stored in `asked_evidence.learned`. */
export const LEARNED = Object.freeze({ MISS: 'M18b', SHOWN: 'H4-shown' });

/** How a use is evidenced. Closed list. */
export const KIND = Object.freeze({ MENTION_PROMPT: 'mention-prompt', MENTION_TOOL: 'mention-tool' });

const ID_PATTERN = /[0-9a-z][0-9a-z_-]{3,39}/g;

/** The journal WITH a place per line (`.pipeline/injections.jsonl:<n>`). */
export function journalWithPlace(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, injection.JOURNAL_FILE), 'utf8'); } catch { return []; }
  const rel = injection.JOURNAL_FILE.split(path.sep).join('/');
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let z;
    try { z = JSON.parse(line); } catch { return; }
    out.push({ z, place: `${rel}:${i + 1}` });
  });
  out.sort((a, b) => String(a.z.ts ?? '').localeCompare(String(b.z.ts ?? '')));
  return out;
}

/**
 * The misses that may be learned from: questions with nothing shown.
 *
 * `includeShown` (H4, search lever `h4` or `mem asked-learn --shown`):
 * also questions where something WAS shown. Since the recall bar stopped
 * being a hurdle, "nothing shown" became rare (lucky-mem: 1 of 1653 turns),
 * so the plain rule had nothing left to learn from. A shown turn is a
 * miss only when the session then fetched a DIFFERENT entry by hand — the
 * self-shown latch in `cases()` drops every entry the memory showed.
 */
export function misses(journal, { includeShown = false } = {}) {
  const why = new Set([injection.REASON.TOO_WEAK, injection.REASON.EMPTY]);
  return journal.filter(({ z }) => z.occasion === injection.OCCASION.QUESTION
    && (why.has(z.reason) || (includeShown && z.reason == null))
    && z.session && Number.isFinite(Date.parse(z.ts ?? '')));
}

/**
 * Transcript lines of the wanted sessions, from every readable capture,
 * sorted by time. The session is read off each LINE (`sessionId`), not
 * off the capture's stamp, which names the transcript, not the session.
 */
export function sessionLines(root, sessions) {
  const bySession = new Map();
  let unreadable = 0;
  let captures = [];
  try { captures = raw.listCaptures(root); } catch { return { bySession, unreadable: 0 }; }
  for (const rel of captures) {
    let c;
    try { c = raw.readCapture(root, rel); } catch { unreadable += 1; continue; }
    for (const z of c.lines) {
      const s = z?.sessionId ?? z?.session_id;
      if (!s || !sessions.has(s)) continue;
      const t = Date.parse(String(z.timestamp ?? ''));
      if (!Number.isFinite(t)) continue;
      if (!bySession.has(s)) bySession.set(s, []);
      bySession.get(s).push({ z, t });
    }
  }
  for (const lines of bySession.values()) lines.sort((a, b) => a.t - b.t);
  return { bySession, unreadable };
}

const hasToolResult = (z) => Array.isArray(z?.message?.content)
  && z.message.content.some((c) => c?.type === 'tool_result');

/** A real input of the person — not a tool result played back. */
export const isInput = (z) => z?.type === 'user' && !z.isMeta && !hasToolResult(z)
  && raw.textOf(z).trim().length > 0;

/** The real input nearest to `t`, within the tolerance. */
export function questionLine(lines, t, { tolerance = QUESTION_TOLERANCE_MS } = {}) {
  let best = null;
  let gap = Infinity;
  for (const x of lines) {
    if (!isInput(x.z)) continue;
    const d = Math.abs(x.t - t);
    if (d <= tolerance && d < gap) { gap = d; best = x; }
  }
  return best;
}

function mentionText(z) {
  if (isInput(z)) return { kind: KIND.MENTION_PROMPT, text: raw.textOf(z) };
  if (z?.type === 'assistant' && Array.isArray(z.message?.content)) {
    const parts = z.message.content.filter((c) => c?.type === 'tool_use')
      .map((c) => JSON.stringify(c.input ?? {}));
    if (parts.length) return { kind: KIND.MENTION_TOOL, text: parts.join(' ') };
  }
  return null;
}

/**
 * The entries the session named AFTER the question, first mention each.
 * The question itself does not count: whoever types the id into the
 * question has missed nothing.
 */
export function mentions(lines, question, known, { window = MENTION_WINDOW_MS } = {}) {
  const out = new Map();
  for (const x of lines) {
    if (x === question || x.t <= question.t) continue;
    if (x.t - question.t > window) break;
    const m = mentionText(x.z);
    if (!m) continue;
    for (const hit of m.text.toLowerCase().matchAll(ID_PATTERN)) {
      const id = hit[0];
      if (!known(id) || out.has(id)) continue;
      out.set(id, { id, kind: m.kind, t: x.t });
    }
  }
  return [...out.values()];
}

/** Did the memory itself show this place to the session in the window? */
export function selfShown(journal, session, from, to, place) {
  for (const { z } of journal) {
    if (z.session !== session) continue;
    const t = Date.parse(z.ts ?? '');
    if (!Number.isFinite(t) || t < from - 1000 || t > to) continue;
    if ((z.sources ?? []).includes(place)) return true;
  }
  return false;
}

const PACKS = DETECTABLE_LANGUAGES.map((c) => pack(c));

/**
 * The words of a question the entry lacks. Surface form, in question
 * order; capped rarest-first.
 */
export function learnWords(index, question, doc, { dfMax = DF_SHARE_MAX, max = WORDS_MAX, bridges = null } = {}) {
  const n = index.statsN ?? index.N ?? 1;
  const df = index.statsDocFreq ?? index.docFreq;
  // Four letters at least: in the alphabetic languages the very short
  // words are mostly function words ("por", "qué", "the", "und"), and
  // without a stop list for the asked language nothing else would catch
  // them on a first miss. A switched-on bridge's stop list catches the
  // longer ones ("para", "donde").
  const words = [...new Set(langbridge.rawWords(question).filter((w) => [...w].length >= WORD_MIN))];
  const candidates = [];
  words.forEach((w, pos) => {
    if (/^[0-9a-f]{12,}$/.test(w)) return;                    // an id or hash, not a word
    if (PACKS.some((p) => p.stopwords.has(w))) return;       // filler in some language
    if (langbridge.isQueryStop(bridges, w)) return;           // a bridge's question word
    const forms = search.tokenizeGroupsMulti(w, { langs: PACKS }).flat();
    if (!forms.length) return;
    if (forms.some((t) => doc.weights.has(t))) return;        // the entry has it already
    const d = Math.max(...forms.map((t) => df?.get(t) ?? 0));
    if (d / n > dfMax) return;                                // tells nothing apart
    candidates.push({ w, d, pos });
  });
  // Rarest first; among equally rare (often: all unknown to the corpus)
  // the longer word first — content words are longer than function
  // words in every language this has to serve, and it costs no list.
  return candidates.sort((a, b) => a.d - b.d || [...b.w].length - [...a.w].length || a.pos - b.pos).slice(0, max)
    .sort((a, b) => a.pos - b.pos).map((k) => k.w);
}

/** Words already learned on an entry: word → Set of entry ids. */
export function learnedWords(index) {
  const map = new Map();
  for (const d of index.documents ?? []) {
    if (d.retired) continue;
    for (const e of d?.entry?.asked_evidence ?? []) {
      for (const w of String(e?.words ?? '').split(/\s+/).filter(Boolean)) {
        if (!map.has(w)) map.set(w, new Set());
        map.get(w).add(d.entry.id);
      }
    }
  }
  return map;
}

/**
 * A word that would be learned for TWO different entries says nothing
 * about either — it is the form of the question ("why", "porqué"), not
 * its subject. Counted over this run's cases AND the words already
 * learned; language-neutral, because it only counts.
 */
export function withoutAmbiguous(list, alreadyLearned = new Map()) {
  const targets = new Map();
  const note = (w, id) => { if (!targets.has(w)) targets.set(w, new Set()); targets.get(w).add(id); };
  for (const [w, ids] of alreadyLearned) for (const id of ids) note(w, id);
  for (const c of list) for (const w of c.words) note(w, c.entry.id);
  const out = [];
  let dropped = 0;
  for (const c of list) {
    const words = c.words.filter((w) => targets.get(w).size < 2);
    if (words.length) out.push({ ...c, words, ambiguous: c.words.filter((w) => !words.includes(w)) });
    else dropped += 1;
  }
  return { cases: out, dropped };
}

/**
 * The learning cases — nothing is written.
 *
 * Returns `{ cases, counts }`; `counts` is the denominator (misses, how
 * many had a readable capture, a question, a mention, how many were
 * dropped as self-shown), so "0 cases" reads as a measurement, not as
 * silence.
 */
export function cases(root, { index = null, journal = null, lines = null, includeShown = false } = {}) {
  const idx = index ?? search.loadIndex(root);
  const j = journal ?? journalWithPlace(root);
  const ms = misses(j, { includeShown });
  const sessions = new Set(ms.map((m) => m.z.session));
  const { bySession, unreadable } = lines ?? sessionLines(root, sessions);
  // Every curated id is known, and a superseded one resolves to its
  // current version: the person may well name the id they remember,
  // and a word learned onto a retired line would never be searched.
  const ids = new Map();
  const successor = new Map();
  idx.documents.forEach((d, i) => {
    if (d.type === 'raw' || !d.entry?.id) return;
    ids.set(String(d.entry.id).toLowerCase(), i);
    if (d.entry.replaces_id) successor.set(String(d.entry.replaces_id).toLowerCase(), i);
  });
  const current = (id) => {
    let i = ids.get(id);
    for (let hops = 0; hops < 50; hops += 1) {
      const next = successor.get(String(idx.documents[i].entry.id).toLowerCase());
      if (next === undefined) break;
      i = next;
    }
    return idx.documents[i];
  };
  const counts = {
    misses: ms.length, withCapture: 0, withQuestion: 0, withMention: 0,
    selfShown: 0, noNewWords: 0, ambiguous: 0, longQuestion: 0, cases: 0, unreadableCaptures: unreadable,
    includeShown: Boolean(includeShown),
  };
  const out = [];
  for (const m of ms) {
    const sl = bySession.get(m.z.session);
    if (!sl?.length) continue;
    counts.withCapture += 1;
    const t = Date.parse(m.z.ts);
    const q = questionLine(sl, t);
    if (!q) continue;
    counts.withQuestion += 1;
    const named = mentions(sl, q, (id) => ids.has(id));
    if (!named.length) continue;
    counts.withMention += 1;
    const text = raw.textOf(q.z);
    const shown = m.z.reason == null;
    if (shown && String(text).length > SHOWN_QUESTION_MAX_CHARS) { counts.longQuestion += 1; continue; }
    for (const g of named) {
      const doc = current(g.id);
      if (doc.retired) continue;       // done or discarded, not superseded
      const place = `${doc.source}:${doc.line}`;
      if (selfShown(j, m.z.session, t, g.t, place)) { counts.selfShown += 1; continue; }
      const words = learnWords(idx, text, doc, { bridges: idx.bridge ?? null });
      if (!words.length) { counts.noNewWords += 1; continue; }
      out.push({
        journal: m.place, ts: m.z.ts, session: m.z.session,
        entry: { id: doc.entry.id, type: doc.type, project: doc.project ?? null, place },
        use: { kind: g.kind, ts: new Date(g.t).toISOString() },
        learned: shown ? LEARNED.SHOWN : LEARNED.MISS,
        words,
      });
    }
  }
  const { cases: clean, dropped } = withoutAmbiguous(out, learnedWords(idx));
  counts.ambiguous = dropped;
  counts.cases = clean.length;
  return { cases: clean, counts };
}

/** The evidence record stored in `asked_evidence`. */
export function evidence(c) {
  return {
    journal: c.journal, ts: c.ts, session: c.session,
    words: c.words.join(' '), use: c.use, learned: c.learned ?? LEARNED.MISS,
  };
}

/**
 * Write one case as a correction line (append-only). Never twice: an
 * entry that already carries evidence from the same journal line stays
 * as it is. Returns `{ written, reason?, entry? }`.
 */
export function write(root, c) {
  const { id, type, project } = c.entry;
  // The CURRENT version: a case found before an earlier write still
  // names the id it was found under.
  const log = [...memory.iterLog(root, type, { project })];
  let old = log.find((e) => e.id === id) ?? null;
  if (!old) return { written: false, reason: 'entry-missing' };
  for (let hops = 0; hops < 50; hops += 1) {
    const next = log.find((e) => e.replaces_id === old.id);
    if (!next) break;
    old = next;
  }
  const prior = Array.isArray(old.asked_evidence) ? old.asked_evidence : [];
  if (prior.some((b) => b?.journal === c.journal)) return { written: false, reason: 'already-learned' };
  const asked = Array.isArray(old.asked) ? old.asked
    : (typeof old.asked === 'string' && old.asked.trim() ? [old.asked] : []);
  const { id: _i, ts: _t, replaces_id: _r, ...content } = old;
  const entry = memory.correctionEntry(root, type, old.id, {
    ...content,
    asked: [...asked, c.words.join(' ')],
    asked_evidence: [...prior, evidence(c)],
  }, { project });
  return { written: true, entry };
}

/** Short report for the CLI. */
export function asText({ cases: list, counts: k }, { written = null } = {}) {
  const lines = [
    `QUERY WORDS FROM MISSES: ${k.cases} case(s)`,
    `  ${k.misses} misses in the journal (${k.includeShown ? 'nothing shown, or shown and another entry fetched — H4' : 'nothing shown'}), `
      + `${k.withCapture} with a readable capture, `
      + `${k.withQuestion} with the question found,`,
    `  ${k.withMention} followed by the session naming an entry; dropped: ${k.selfShown} shown by `
      + `the memory itself (no evidence), ${k.noNewWords} without new words, ${k.ambiguous} only ambiguous.`,
  ];
  if (!k.misses) {
    lines.push('  No miss on record. The recall hook books them (`mem find --journal-session`);');
    lines.push('  a machine whose hook predates that has nothing to learn from yet.');
  } else if (!k.withCapture) {
    lines.push('  No readable raw capture for those sessions — without one there is no evidence,');
    lines.push('  and nothing is learned. That is a statement about this machine, not about demand.');
  }
  if (k.longQuestion) lines.push(`  ${k.longQuestion} shown miss(es) skipped: question over ${SHOWN_QUESTION_MAX_CHARS} characters.`);
  if (k.unreadableCaptures) lines.push(`  ${k.unreadableCaptures} capture(s) unreachable (archive offline?).`);
  for (const c of list) {
    lines.push(`  ${c.journal} -> ${c.entry.id} (${c.entry.place}) [${c.use.kind}]: ${c.words.join(' ')}`);
  }
  if (written != null) lines.push(`  written: ${written}`);
  else if (list.length) lines.push('  (dry run — `--write` appends the correction lines)');
  return lines.join('\n');
}

// Bait for the mask-before-cut probes: a key-shaped string that straddles a cut boundary.
//
// Every key is ASSEMBLED AT RUN TIME from pieces; no key shape stands in this source. None of them is
// a real secret. `keep` is how many characters of the key lie BEFORE the cut: chosen so that the stump
// is shorter than the pattern's minimum (src/redaction.mjs), so a cut BEFORE the mask leaves a rest the
// mask no longer recognises. `kind` names the pattern family the bait exercises.
const j = (...p) => p.join('');
const AB = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

export const KINDS = Object.freeze({
  github: { key: () => j('gh', 'p_', AB), keep: 24 },
  jwt: { key: () => j('ey', 'J', AB.slice(0, 10), '.', AB.slice(2, 12), '.', AB.slice(4, 16)), keep: 30 },
  anthropic: { key: () => j('sk', '-ant-', 'api03-', AB), keep: 17 },
  openai: { key: () => j('sk', '-', AB), keep: 18 },
  aws: { key: () => j('AK', 'IA', 'QWERTYUIOP123456'), keep: 14 },
  slack: { key: () => j('xo', 'xb-', '1234567890-0987654321-', AB.slice(0, 20)), keep: 11 },
  password: { key: () => j('pass', 'word', '=', 'Qz7KmT9xLp2Wm4kRv8'), keep: 13 },
});
export const KIND_NAMES = Object.freeze(Object.keys(KINDS));

/**
 * Text in which the first `keep` characters of the key lie before position `cut` (so a plain
 * `text.slice(0, cut)` ends INSIDE the key), preceded by `lead` and followed by `tail`.
 */
export function bait(kind, cut, { lead = '', tail = ' and the rest of the sentence' } = {}) {
  const k = KINDS[kind];
  const key = k.key();
  const pre = cut - lead.length - 1 - k.keep;
  if (pre < 0) throw new Error(`bait: cut ${cut} too small for ${kind}`);
  const text = `${lead}${'x'.repeat(pre)}=${key}${tail}`;
  return { kind, key, text, cut, headProbe: key.slice(0, k.keep - 1), keep: k.keep };
}

/** Text in which the window `[from, ...)` starts `offset` characters INSIDE the key (the tail without its prefix). */
export function baitTail(kind, from, offset = 10) {
  const key = KINDS[kind].key();
  const s = from - offset;
  const text = `${'x'.repeat(s - 1)}=${key}`;
  return { kind, key, text, from };
}

/** Does `out` carry a stretch of the key (10 characters in a row, anywhere in it)? */
export function leaks(out, key) {
  const s = String(out);
  for (let i = 0; i + 10 <= key.length; i += 1) if (s.includes(key.slice(i, i + 10))) return true;
  return false;
}

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * bashtargets — which files does a shell command WRITE?
 *
 * **The gap.** The pre-edit hook (`bin/mem-before-edit`) fired for Edit,
 * Write and NotebookEdit only. A file changed through the shell —
 * `sed -i`, `tee`, `> file`, `mv`, `cp` — got no recall at all, though
 * it is the same change to the same file. lucky-mem's PreToolUse hook
 * fires on Bash too.
 *
 * **Deterministic, no model, narrow on purpose.** A small shell-word
 * reader (quotes, backslashes, control operators, heredoc bodies
 * skipped) and five write shapes:
 *
 *   - redirection `>`, `>>`, `>|`, `&>`, `N>` (never `N>&M`, /dev, /tmp)
 *   - `sed -i` / `--in-place` (the files after the script)
 *   - `tee [-a] FILE…`
 *   - `cp SRC… DEST` (DEST), `mv SRC… DEST` (DEST and the SRCs)
 *
 * **Why so strict about what counts as a file.** The hook queries the
 * memory with the path's last two segments AND its bare name. A
 * directory or extension-less word (`cp x build`, `> out`) would ask
 * the memory about the word "build" — a word that appears everywhere.
 * So a target counts only when its name carries an extension, and a
 * word with an expansion in it (`$VAR`, a glob, a backtick, `~`) is
 * dropped: what it names is decided at run time, not readable here.
 * Better nothing than a wrong path.
 *
 * Anything this reader does not understand yields no target, and the
 * hook stays silent: a missed shell write costs what it cost before
 * this module existed, a false one costs noise on every call.
 */

const CONTROL = new Set([';', '&&', '||', '|', '&', '(', ')', '|&', '\n']);
const REDIRECT = /^(\d*|&)(>>?|>\|)$/;
const DUP = /^\d*[<>]&/;

/** Heredoc bodies are data, not commands: drop them before reading. */
function withoutHeredocs(text) {
  const out = [];
  let tag = null;
  for (const line of String(text).split('\n')) {
    if (tag !== null) {
      if (line.replace(/^\t+/, '').trim() === tag) tag = null;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (m) tag = m[2];
  }
  return out.join('\n');
}

/**
 * Shell words and operators. Each word: `{ w, dynamic }` — `dynamic`
 * when an unquoted or double-quoted expansion/glob is in it.
 */
function tokens(text) {
  const out = [];
  let cur = '';
  let dyn = false;
  let has = false;
  const push = () => { if (has) out.push({ w: cur, dynamic: dyn }); cur = ''; dyn = false; has = false; };
  const s = String(text);
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; has = true; i += 1; continue; }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return null; // unbalanced: not readable
      cur += s.slice(i + 1, end); has = true; i = end; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') { if (s[j] === '\\') j += 1; j += 1; }
      if (j >= s.length) return null;
      const inner = s.slice(i + 1, j);
      if (/[$`]/.test(inner)) dyn = true;
      cur += inner.replace(/\\(.)/g, '$1'); has = true; i = j; continue;
    }
    if (c === '#' && !has) { // a comment runs to the end of the line
      const nl = s.indexOf('\n', i);
      if (nl < 0) break;
      i = nl - 1; continue;
    }
    if (c === ' ' || c === '\t') { push(); continue; }
    if (c === '\n' || c === ';' || c === '(' || c === ')') { push(); out.push({ op: c }); continue; }
    if (c === '|' || c === '&') {
      const two = s.slice(i, i + 2);
      if (two === '&>') { // &> and &>>
        push();
        const op = s[i + 2] === '>' ? '&>>' : '&>';
        out.push({ op }); i += op.length - 1; continue;
      }
      if (c === '&' && /\d*>$/.test(cur) && has) { cur += c; continue; } // N>&M stays one word
      push();
      if (two === '&&' || two === '||' || two === '|&') { out.push({ op: two }); i += 1; } else out.push({ op: c });
      continue;
    }
    if (c === '>' || c === '<') {
      // A leading fd number belongs to the operator: 2>file, 1>>file.
      const fd = /^\d+$/.test(cur) && has ? cur : '';
      if (fd) { cur = ''; has = false; } else push();
      let op = c;
      if (s[i + 1] === '>' && c === '>') { op = '>>'; i += 1; } else if (s[i + 1] === '|' && c === '>') { op = '>|'; i += 1; }
      if (s[i + 1] === '&') { // >&2, 2>&1: a duplication, never a file
        let j = i + 2;
        while (j < s.length && /[0-9-]/.test(s[j])) j += 1;
        out.push({ op: 'dup' }); i = j - 1; continue;
      }
      if (c === '<') { out.push({ op: s[i + 1] === '<' ? 'heredoc' : '<' }); if (s[i + 1] === '<') i += 1; continue; }
      out.push({ op: `${fd}${op}` });
      continue;
    }
    if (/[$`*?[{~]/.test(c) && !(c === '~' && has)) dyn = true;
    cur += c; has = true;
  }
  push();
  return out;
}

/** Does this word name a file whose change the memory could know about? */
function plausibleFile(t) {
  if (!t || t.dynamic || typeof t.w !== 'string') return false;
  const w = t.w;
  if (!w || w.startsWith('-') || DUP.test(w)) return false;
  // Devices, and scratch space: a log under /tmp is never what an entry
  // is about, and every lookup for one costs a full search (measured
  // ~0.7 s under load) on one of the most common shell writes there is.
  if (/^\/(dev|proc|sys|tmp|var\/tmp)\//.test(w)) return false;
  const base = w.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return /^[^.].*\.[A-Za-z0-9]{1,8}$/.test(base) || /^\.[^.\s]+\.[A-Za-z0-9]{1,8}$/.test(base);
}

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nice', 'nohup', 'time', 'env']);

function segmentTargets(seg) {
  const words = [];
  const out = [];
  for (let i = 0; i < seg.length; i += 1) {
    const t = seg[i];
    if (t.op) {
      if (REDIRECT.test(t.op) || t.op === '&>' || t.op === '&>>') {
        const target = seg[i + 1];
        if (target && !target.op && plausibleFile(target)) out.push(target.w);
        i += 1;
      } else if (t.op === '<' || t.op === 'heredoc') {
        i += 1; // its word is an input, not a command argument
      }
      continue;
    }
    words.push(t);
  }
  // Leading assignments and wrappers are not the command.
  let k = 0;
  while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].w) || WRAPPERS.has(words[k].w))) k += 1;
  const cmd = words[k];
  if (!cmd) return out;
  const name = cmd.w.split('/').pop();
  const args = words.slice(k + 1);

  if (name === 'sed') {
    let inPlace = false;
    let scriptGiven = false;
    const rest = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i].w;
      if (a === '--in-place' || a.startsWith('--in-place=')) { inPlace = true; continue; }
      if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') { scriptGiven = true; i += 1; continue; }
      if (/^--(expression|file)=/.test(a)) { scriptGiven = true; continue; }
      if (a.startsWith('--')) continue;
      if (/^-[A-Za-z]/.test(a)) {
        // -i[SUFFIX]: everything after the i is the suffix, so only the
        // letters BEFORE it are flags (-ni = -n -i; -i.bak = -i).
        const iAt = a.indexOf('i');
        if (iAt > 0 && /^-[nrEsuz]*$/.test(a.slice(0, iAt))) inPlace = true;
        if (/^-[nrEsuzi]*e$/.test(a) && !a.includes('i')) { scriptGiven = true; i += 1; }
        continue;
      }
      rest.push(args[i]);
    }
    if (!inPlace) return out;
    const files = scriptGiven ? rest : rest.slice(1);
    for (const f of files) if (plausibleFile(f)) out.push(f.w);
    return out;
  }
  if (name === 'tee') {
    for (const a of args) if (!a.w.startsWith('-') && plausibleFile(a)) out.push(a.w);
    return out;
  }
  if (name === 'cp' || name === 'mv') {
    if (args.some((a) => a.w === '-t' || a.w.startsWith('--target-directory'))) return out;
    const plain = args.filter((a) => !a.w.startsWith('-'));
    if (plain.length < 2) return out;
    const dest = plain[plain.length - 1];
    if (plain.length === 2 && plausibleFile(dest)) out.push(dest.w);
    if (name === 'mv') for (const s of plain.slice(0, -1)) if (plausibleFile(s)) out.push(s.w);
  }
  return out;
}

/**
 * The files a shell command writes, in order of appearance, unique,
 * at most `max`. `[]` for anything not readable — never a guess.
 */
export function writeTargets(command, { max = 3 } = {}) {
  if (typeof command !== 'string' || !command.trim()) return [];
  const toks = tokens(withoutHeredocs(command));
  if (!toks) return [];
  const found = [];
  let seg = [];
  const flush = () => { found.push(...segmentTargets(seg)); seg = []; };
  for (const t of toks) {
    if (t.op && CONTROL.has(t.op)) flush();
    else seg.push(t);
  }
  flush();
  return [...new Set(found)].slice(0, max);
}

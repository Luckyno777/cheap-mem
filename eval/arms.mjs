// eval/arms.mjs — the six variants. Each builds ONLY the prompt; the
// model is called by run.mjs.
//
// IMPORTANT for token measurement: the claude CLI pushes 20,000-28,000
// tokens of its own system prompt (tool definitions, MCP) ahead of every
// call, and this cannot be turned off with --system-prompt,
// --exclude-dynamic-system-prompt-sections, --strict-mcp-config, and an
// empty --allowedTools (measured: 24k / 20k / 28k depending on the flag
// combination). The difference between arms sits at a few hundred
// tokens and would be invisible inside that. So the harness measures
// BOTH separately:
//   promptTokens  the text we build ourselves (memory's marginal cost)
//   cliTokens     what the CLI additionally charges (a constant)
// Only the first number compares arms meaningfully.
//
// The strings this file builds below (the system prompt, the transcript,
// the "Notizen aus dem Projektgedaechtnis" framing, the section labels)
// are the actual model-facing prompt content, in German to match the
// German corpus and tasks — they are measurement substance, not
// documentation, and stay as they are.

import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { PROJECT, FACTS } from './world.mjs';

export const ARMS = ['A', 'B', 'C', 'D', 'E', 'F'];

export const SYSTEM = 'Du bist ein Entwickler-Assistent fuer das Projekt kolibri. '
  + 'Antworte knapp und auf Deutsch. Wenn dir Notizen aus dem Projektgedaechtnis '
  + 'vorliegen, beruecksichtige sie; wenn sie sich widersprechen, sage das.';

/** Vocabulary A, chronological: what was said over a long collaboration. */
export function transcript() {
  const turns = [];
  for (const f of FACTS) {
    turns.push(`Lucky: Zu ${f.kern.thema} — wir machen ${f.kern.wahl}. Grund: ${f.kern.grund}.`);
    turns.push('Assistent: Verstanden, ich halte mich daran.');
  }
  // Later, unrelated chatter that fills up the window.
  for (let i = 0; i < 40; i += 1) {
    turns.push(`Lucky: Kannst du kurz Vorgang ${2000 + i} anschauen?`);
    turns.push(`Assistent: Angeschaut, nichts Auffaelliges bei ${2000 + i}.`);
  }
  return turns;
}

/**
 * Arm B: what a chat window without memory actually still sees. The
 * old decisions have scrolled out — exactly the situation a memory
 * claims to solve.
 */
export function historyWindow(turns, maxChars = 2500) {
  const out = [];
  let n = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (n + turns[i].length > maxChars) break;
    out.unshift(turns[i]); n += turns[i].length;
  }
  return out;
}

const claimLine = (c) => `- [${c.id}] (${c.authority}/${c.author}, ${c.status}) ${c.body}`;

/** Arm C: flat, the way the reflex feeds it in today. */
export function flatContext(claims) {
  if (!claims.length) return '';
  return 'Notizen aus dem Projektgedaechtnis:\n' + claims.map(claimLine).join('\n');
}

/**
 * Arm D: the same claims, grouped. No new primitive — the sections come
 * from fields retrieve() already provides (type, authority, status). If
 * grouping doesn't help, that is a result too.
 */
export function sectionedContext(claims, contested) {
  if (!claims.length) return '';
  const sec = { 'Aktuell gueltig': [], 'Vom Benutzer entschieden': [], 'Ueberholt': [], 'Umstritten': [] };
  const inConflict = new Set(contested.flatMap((c) => c.ids));
  for (const c of claims) {
    if (inConflict.has(c.id)) sec['Umstritten'].push(c);
    else if (c.status !== 'active') sec['Ueberholt'].push(c);
    else if (c.authority === 'user') sec['Vom Benutzer entschieden'].push(c);
    else sec['Aktuell gueltig'].push(c);
  }
  const parts = ['Notizen aus dem Projektgedaechtnis:'];
  for (const [name, list] of Object.entries(sec)) {
    if (!list.length) continue;
    parts.push(`\n## ${name}`);
    for (const c of list) parts.push(claimLine(c));
  }
  if (contested.length) {
    parts.push('\n## Hinweis');
    for (const k of contested) parts.push(`- zu "${k.topic}" widersprechen sich ${k.authors.join(' und ')} (${k.ids.join(', ')})`);
  }
  return parts.join('\n');
}

/** The retrieval itself — identical for C, D, E; F retrieves later with the draft. */
export function recall(root, query, { top = 5, min = 5.0 } = {}) {
  const cap = grantProject(PROJECT);
  const r = retrieval.retrieve(root, query, cap, { top });
  // Exact hits bypass the threshold — same as in the retrieval hook.
  const kept = r.claims.filter((c) => c.score >= min || (c.exact && c.exact.length));
  return { ...r, claims: kept, dropped: r.claims.length - kept.length };
}

/** The contradiction check for E and F: advisory, with citation, never a veto. */
export function contradictionPrompt(task, draft, claims) {
  const notes = claims.length
    ? claims.map(claimLine).join('\n')
    : '(keine passenden Notizen gefunden)';
  return `Frage: ${task.prompt}\n\nDein Entwurf:\n${draft}\n\n`
    + `Notizen aus dem Projektgedaechtnis:\n${notes}\n\n`
    + 'Pruefe: widerspricht dein Entwurf einer dieser Notizen? Die Notizen entscheiden '
    + 'nicht automatisch die Wahrheit — wenn der Grund einer alten Festlegung nicht mehr '
    + 'gilt oder die Frage etwas anderes verlangt, darf der Entwurf stehen bleiben. '
    + 'Gib danach die ENDGUELTIGE Antwort auf die Frage aus, nichts weiter.';
}

export function buildPrompt(arm, task, ctx) {
  if (arm === 'A') return task.prompt;
  if (arm === 'B') return `Bisheriges Gespraech:\n${ctx.history.join('\n')}\n\nFrage: ${task.prompt}`;
  if (arm === 'C') return `${ctx.flat}\n\nFrage: ${task.prompt}`.trim();
  if (arm === 'D') return `${ctx.sectioned}\n\nFrage: ${task.prompt}`.trim();
  if (arm === 'E') return `${ctx.flat}\n\nFrage: ${task.prompt}`.trim();  // draft phase
  if (arm === 'F') return task.prompt;                                     // draft phase
  throw new Error(`unknown arm ${arm}`);
}

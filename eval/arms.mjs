// eval/arms.mjs — die sechs Varianten. Jede baut NUR den Prompt; das
// Modell ruft run.mjs auf.
//
// WICHTIG zur Tokenmessung: die claude-CLI schiebt 20.000-28.000 Token
// eigenen Systemprompt (Werkzeugdefinitionen, MCP) vor jeden Aufruf, und
// das laesst sich mit --system-prompt, --exclude-dynamic-system-prompt-
// sections, --strict-mcp-config und leerem --allowedTools nicht abstellen
// (gemessen: 24k / 20k / 28k je nach Flag-Kombination). Der Unterschied
// zwischen den Armen liegt bei einigen hundert Token und waere darin
// unsichtbar. Deshalb misst das Harness BEIDES getrennt:
//   promptTokens  der von uns gebaute Text (die marginale Kosten von Memory)
//   cliTokens     was die CLI zusaetzlich berechnet (eine Konstante)
// Nur die erste Zahl vergleicht Arme sinnvoll.

import * as retrieval from '../src/retrieval.mjs';
import { grantProject } from '../src/capability.mjs';
import { PROJECT, FACTS } from './world.mjs';

export const ARMS = ['A', 'B', 'C', 'D', 'E', 'F'];

export const SYSTEM = 'Du bist ein Entwickler-Assistent fuer das Projekt kolibri. '
  + 'Antworte knapp und auf Deutsch. Wenn dir Notizen aus dem Projektgedaechtnis '
  + 'vorliegen, beruecksichtige sie; wenn sie sich widersprechen, sage das.';

/** Vokabular A, chronologisch: was in einer langen Zusammenarbeit gesagt wurde. */
export function transcript() {
  const turns = [];
  for (const f of FACTS) {
    turns.push(`Lucky: Zu ${f.kern.thema} — wir machen ${f.kern.wahl}. Grund: ${f.kern.grund}.`);
    turns.push('Assistent: Verstanden, ich halte mich daran.');
  }
  // Spaeteres, unbeteiligtes Geplauder, das das Fenster fuellt.
  for (let i = 0; i < 40; i += 1) {
    turns.push(`Lucky: Kannst du kurz Vorgang ${2000 + i} anschauen?`);
    turns.push(`Assistent: Angeschaut, nichts Auffaelliges bei ${2000 + i}.`);
  }
  return turns;
}

/**
 * Arm B: das, was ein Chatfenster ohne Memory tatsaechlich noch sieht.
 * Die alten Festlegungen sind herausgescrollt — genau die Lage, fuer die
 * ein Gedaechtnis behauptet, sie zu loesen.
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

/** Arm C: flach, so wie der Reflex heute einspeist. */
export function flatContext(claims) {
  if (!claims.length) return '';
  return 'Notizen aus dem Projektgedaechtnis:\n' + claims.map(claimLine).join('\n');
}

/**
 * Arm D: dieselben Claims, gruppiert. Kein neues Primitiv — die Sektionen
 * kommen aus Feldern, die retrieve() ohnehin liefert (type, authority,
 * status). Wenn Gruppieren nichts bringt, ist das ein Ergebnis.
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

/** Der Abruf selbst — identisch fuer C, D, E; F ruft spaeter mit dem Entwurf ab. */
export function recall(root, query, { top = 5, min = 5.0 } = {}) {
  const cap = grantProject(PROJECT);
  const r = retrieval.retrieve(root, query, cap, { top });
  const kept = r.claims.filter((c) => c.score >= min);
  return { ...r, claims: kept, dropped: r.claims.length - kept.length };
}

/** Die Widerspruchspruefung fuer E und F: beratend, mit Zitat, nie Veto. */
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
  if (arm === 'E') return `${ctx.flat}\n\nFrage: ${task.prompt}`.trim();  // Entwurfsphase
  if (arm === 'F') return task.prompt;                                     // Entwurfsphase
  throw new Error(`unbekannter Arm ${arm}`);
}

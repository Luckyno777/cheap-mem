// test/fixture/card-view-world.mjs — a store for the card display (H11, card-view-cm): every kind of card the dashboard has to
// show, with the nasty texts a card must survive. Used by test/card-view-cm-browser.test.mjs and by the screenshot script.
//
// Participants of a fresh `mem init`: `user` (the human), `session`, `librarian`.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cardstore from '../../src/cardstore.mjs';
import * as question from '../../src/question.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEM = path.join(REPO, 'bin', 'mem');

/** A key shape the output mask knows. Built from parts so no scanner reads this file as a secret. */
export const FAKE_KEY = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
export const XSS_TITLE = 'Decide <img src=x onerror="window.__pwn=1"> before Friday';

const cli = (root, args) => spawnSync(process.execPath, [MEM, ...args, '--root', root], {
  encoding: 'utf8', input: '', timeout: 40000, env: { ...process.env, CHEAP_MEM_AGENT: 'builder-x' },
});
const lines = (root, file, rows) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.appendFileSync(path.join(root, file), rows.map((z) => `${JSON.stringify(z)}\n`).join(''));
};

/**
 * Builds the store into `root` (an existing empty directory). Returns the ids by role so a probe can name them.
 */
export function buildWorld(root) {
  const init = cli(root, ['init']);
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  const ts = '2026-10-01T09:00:00Z';
  lines(root, 'global/duties.jsonl', [
    // 1. a WRITTEN card on the entry itself (the author is the entry's `agent`)
    {
      id: 'dwrit00001', ts, title: 'Transfer details: which one wins', who: 'user', agent: 'alex-planner',
      card_question: 'Which transfer details should the payment page show?',
      card_context: 'Two files name different details. A payer sees only one of them, and the invoice run starts on Friday.',
      card_options: ['Use the file in src/transfer.mjs — the payment page follows the newer details', 'Use the provider table — the payment page keeps the old details', 'Not now — nothing changes until you decide'],
      card_advice: 'The newer file was reviewed last week.',
      card_evidence: ['dwrit00001', 'src/transfer.mjs', 'https://example.org/notes/transfer'],
      card_kind: 'decide',
    },
    // 2. a duty that gets an ADDENDUM card from the shelf (below)
    { id: 'dadd000001', ts, title: 'Four points from the decision form', who: 'user', tags: ['decision-form'] },
    // 3. a FALLBACK card (nobody wrote one)
    { id: 'dfall00001', ts, title: 'Decide whether the old export format is dropped', who: 'user', tags: ['decision'], text: 'The export still writes two formats. Nobody reads the old one any more.' },
    // 4. a title with markup: it must become text, never an element
    { id: 'dxss000001', ts, title: XSS_TITLE, who: 'user', tags: ['decision'] },
    // 5. a title with a key: it must be masked
    { id: 'dkey000001', ts, title: `Decide whether to rotate the token ${FAKE_KEY} now`, who: 'user', tags: ['decision'] },
    // 6. agent work: a guard duty owed to an agent (no card is made for it)
    {
      id: 'dagent0001', ts, title: 'Guard for race at src/lock.mjs', who: 'session', class: 'race', file: 'src/lock.mjs', tags: ['auto-duty'], automatic: true,
    },
    // 6b. a card written by the CONFIGURED HUMAN (participant `user`): no "written by an agent" note
    {
      id: 'dhuman0001', ts, title: 'Which logo for the release page', who: 'user', agent: 'user',
      card_question: 'Which logo should the release page carry?',
      card_context: 'Two logos exist. The page is printed on Friday.',
      card_options: ['The round logo — it prints well', 'The wide logo — it needs a new slot', 'Not now — the page goes without a logo'],
      card_kind: 'decide',
    },
    // 6c. a title with bidi and zero-width characters (they come back through the entry list, not through the card)
    { id: 'dbidi00001', ts, title: 'Decide\u202E reversed\u2066 now\u200B please', who: 'user', tags: ['decision'] },
    // 7. a task for the human that is no decision (kind do-it): owed to the human it is "For you" (card-group-cm: the owner decides the group, not the card kind)
    { id: 'dtask00001', ts, title: 'Rename the folder old-notes', who: 'user' },
  ]);
  lines(root, 'global/questions.jsonl', [
    { id: 'qopen00001', ts, question: 'Where do we keep the source build?', title: 'Source build', why: 'The disk is nearly full.', who: 'user' },
    // a question the human asked that an agent answered: waits for the human's confirmation
    { id: 'qwait00001', ts, question: 'Is the vector logo needed for the release?', title: 'Vector logo', why: 'The release page has a slot for it.', authority: 'user', who: 'user' },
  ]);
  lines(root, 'global/learnings.jsonl', [{ id: 'lans000001', ts, title: 'The logo is not needed', text: 'The release page works without it.', agent: 'builder-x' }]);
  question.answer(root, 'qwait00001', 'lans000001', { agent: 'builder-x', authority: 'agent' });
  cardstore.write(root, {
    target_id: 'dadd000001',
    question: 'Which of the four open points from the decision form do you want first?',
    context: 'All four hang on the imprint and the outgoing mail. The form is attached.',
    options: ['Start with the imprint — the other three wait for it', 'Start with the outgoing mail — the imprint waits', 'Not now — the form stays as it is'],
    advice: 'Start with the imprint: two of the other points need it.',
    evidence: ['dadd000001', 'docs/decision-form.md'],
    kind: 'decide',
  }, { agent: 'orch-1', now: new Date('2026-10-12T08:00:00Z') });
  // projects that wait: one made with the command (a card on the shelf), one by hand
  cli(root, ['project', 'new', 'garden-plan', '--title', 'Garden planner', '--reason', 'Three captures on two days.']);
  fs.mkdirSync(path.join(root, 'projects', 'hand-made'), { recursive: true });
  lines(root, 'projects/hand-made/learnings.jsonl', [{ id: 'lhand00001', ts: '2026-10-05T09:00:00Z', title: 'A note in a project made by hand', text: 'Made past the command.', agent: 'human:alex' }]);
  return { written: 'dwrit00001', addendum: 'dadd000001', fallback: 'dfall00001', xss: 'dxss000001', key: 'dkey000001', agent: 'dagent0001', human: 'dhuman0001', bidi: 'dbidi00001', task: 'dtask00001', question: 'qopen00001', waiting: 'qwait00001' };
}

// test/recall-attach.test.mjs - L3 (the solution stands directly under its
// error) and L4 (a skill offer brings two lines of its experience account)
// (port of lucky-mem `abrufanhang`, 2026-10-03).
//
// Red proof: the recall at a FIXED base commit shows no solution line for the
// same store and the same hit (never `git merge-base`: it drifts with the merge).
// Positive controls: every "not shown" case sits next to the case where it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { exportCommit } from './helpers/export-commit.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as injection from '../src/injection.mjs';
import * as recallhook from '../src/recallhook.mjs';
import * as afterfailure from '../src/afterfailure.mjs';
import * as recallattach from '../src/recallattach.mjs';
import * as reg from '../src/skillregistry.mjs';
import * as categories from '../src/categories.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');
const BASE = '0cec5683212e9721fdac0813f1561e50dbb6081f';

function world(t) {
  const root = tempDir('cm-attach-', t);
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}
const error = (root, title, extra = {}) => memory.logEntry(root, 'error', { class: 'wrong-cause', title, text: `${title} - text`, ...extra }).entry;
const learning = (root, title, extra = {}) => memory.logEntry(root, 'learning', { title, learning: `${title} - body`, ...extra }).entry;
const resolves = (root, from, to, extra = {}) => memory.logEntry(root, 'link', { from, to, kind: 'resolves', why: 'a reason', agent: 'test', ...extra }).entry;
const hit = (e, score = 9) => ({ entry: e, source: 'global/errors.jsonl', line: 1, score });
const hitsJson = (...es) => JSON.stringify({ hits: es.map((e) => hit(e)) });
const env = (extra = {}) => ({ ...process.env, MEM_RH_MIN: '1', MEM_SEARCH_LEVERS: 'off', ...extra });
/** The topic `diary` belongs to the category `personal`. */
function makePersonal(root) {
  categories.createCategory(root, 'personal', 'Personal');
  categories.assign(root, 'diary', 'personal');
}
const textOf = (r) => r.out.hookSpecificOutput.additionalContext;

test('RED PROOF: at the base commit the same recall shows no solution line (positive control: today it does)', async (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  const l = learning(root, 'Delete the stale lock file first');
  resolves(root, l.id, e.id);
  const tmp = tempDir('cm-attach-base-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], tmp);
  const old = await import(pathToFileURL(path.join(tmp, 'src', 'recallhook.mjs')).href);
  const before = textOf(old.recall(root, hitsJson(e), env()));
  assert.doesNotMatch(before, /Solution/, 'the base already showed a solution');
  const after = textOf(await recallhook.recallWith(root, hitsJson(e), env()));
  assert.match(after, new RegExp(`\\n {2}\\u21b3 Solution ${l.id}: Delete the stale lock file first`));
});

test('the solution stands directly below ITS error, one per error, in the plain and in the short (h5) form', async (t) => {
  const root = world(t);
  const a = error(root, 'The build fails on the lock file');
  const b = error(root, 'The parser chokes on a bom');
  const l = learning(root, 'Delete the stale lock file first');
  resolves(root, l.id, a.id);
  for (const levers of ['off', 'all']) {
    const lines = textOf(await recallhook.recallWith(root, hitsJson(a, b), env({ MEM_SEARCH_LEVERS: levers }))).split('\n');
    const at = lines.findIndex((x) => x.includes(a.id));
    assert.ok(at > 0, `error line missing (${levers})`);
    assert.match(lines[at + 1], /^ {2}↳ Solution /, `no solution below its error (${levers})`);
    const other = lines.findIndex((x) => x.includes(b.id));
    assert.ok(!/Solution/.test(lines[other + 1] ?? ''), `an error without a solution got one (${levers})`);
    assert.equal(lines.filter((x) => /Solution/.test(x)).length, 1);
  }
});

test('the newest valid link wins; a replaced solution never shows and the next older one counts', (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  const older = learning(root, 'Older way out');
  const newer = learning(root, 'Newer way out');
  resolves(root, older.id, e.id, { ts: '2026-01-01T00:00:00Z' });
  resolves(root, newer.id, e.id, { ts: '2026-02-01T00:00:00Z' });
  let sol = recallattach.solutionsFor(root, [e.id]).get(e.id);
  assert.equal(sol.id, newer.id);
  memory.correctionEntry(root, 'learning', newer.id, { title: 'Newest way out' }); // replaces it
  sol = recallattach.solutionsFor(root, [e.id]).get(e.id);
  assert.notEqual(sol.id, newer.id, 'a replaced solution showed');
  memory.retireEntry(root, 'learning', older.id, { state: 'discarded', why: 'wrong' });
  const gone = recallattach.solutionsFor(root, [e.id]).get(e.id);
  assert.ok(!gone || (gone.id !== older.id && gone.id !== newer.id), 'a discarded solution showed');
});

test('a commit proof counts: `commit:<hash>` with the core taken from the link\'s why', (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  resolves(root, 'commit:0123456789abcdef', e.id, {
    evidence: 'commit:0123456789ab', why: `Commit 0123456789ab carries "Fixes: ${e.id}": remove the stale lock file`,
  });
  const sol = recallattach.solutionsFor(root, [e.id]).get(e.id);
  assert.equal(sol.id, 'commit:0123456789ab');
  assert.equal(sol.journalId, '0123456789ab');
  assert.match(sol.line, /Solution commit:0123456789ab: remove the stale lock file$/);
});

test('never: an encrypted solution, a solution of the category personal, a link that points nowhere', (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  const enc = learning(root, 'Encrypted way out', { shred: true });
  assert.ok(enc.body_enc, 'precondition');
  resolves(root, enc.id, e.id);
  resolves(root, 'zzzzzzzzzzzz', e.id);
  assert.equal(recallattach.solutionsFor(root, [e.id]).size, 0, 'an encrypted or missing source showed');
  makePersonal(root);
  const priv = learning(root, 'A private way out', { topic: 'diary' });
  resolves(root, priv.id, e.id);
  assert.equal(recallattach.solutionsFor(root, [e.id]).size, 0, 'a solution of the category personal showed');
  // positive control: the same link shows once the topic is not personal
  const open = learning(root, 'A public way out', { topic: 'build' });
  resolves(root, open.id, e.id);
  assert.equal(recallattach.solutionsFor(root, [e.id]).get(e.id).id, open.id);
});

test('MEM_SOLUTION_ATTACH=0 switches it off, and the line counts toward the h5 byte budget', async (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  const l = learning(root, 'Delete the stale lock file first');
  resolves(root, l.id, e.id);
  assert.equal(recallattach.solutionsFor(root, [e.id], { env: { MEM_SOLUTION_ATTACH: '0' } }).size, 0);
  assert.equal(recallattach.solutionsFor(root, [e.id], { env: {} }).size, 1, 'positive control');
  const long = [];
  for (let i = 0; i < 5; i += 1) long.push(error(root, `Another failure number ${i} with a fairly long title ${'x'.repeat(60)}`));
  const levers = Buffer.byteLength(textOf(await recallhook.recallWith(root, hitsJson(e, ...long), env({ MEM_SEARCH_LEVERS: 'all' }))), 'utf8');
  assert.ok(levers < 1400, `the h5 block grew past its budget: ${levers}`);
  assert.match(textOf(await recallhook.recallWith(root, hitsJson(e, ...long), env({ MEM_SEARCH_LEVERS: 'all' }))), /Solution/, 'the solution gave way to other hits');
});

test('the journal books the ids: the hit and the solution (only ids, never text)', async (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  const l = learning(root, 'Delete the stale lock file first');
  resolves(root, l.id, e.id);
  const r = await recallhook.recallWith(root, hitsJson(e), env({ MEM_RH_SESSION: 's1' }));
  r.book();
  const line = injection.read(root).lines.find((x) => x.occasion === 'question');
  assert.deepEqual(line.ids, [e.id, l.id]);
  assert.ok(!JSON.stringify(line).includes('stale lock'), 'text in the journal');
  // a line without ids stays byte-identical (the field is left out)
  assert.equal('ids' in JSON.parse(JSON.stringify(injection.buildLine({ occasion: 'question' }))), false);
});

test('after a failed tool call the same line stands below the error, and its id is booked', async (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  const l = learning(root, 'Delete the stale lock file first');
  resolves(root, l.id, e.id);
  const out = await afterfailure.finishWith(root, hitsJson(e), env({ MEM_AF_SESSION: 's1' }));
  const lines = out.hookSpecificOutput.additionalContext.split('\n');
  const at = lines.findIndex((x) => x.includes(e.id));
  assert.match(lines[at + 1], /↳ Solution /);
  const j = injection.read(root).lines.find((x) => x.occasion === injection.OCCASION.AFTER_ERROR);
  assert.deepEqual(j.ids, [e.id, l.id]);
});

// --- L4 ----------------------------------------------------------------------

function skillWorld(t) {
  const root = world(t);
  const s = memory.logEntry(root, 'skill', { title: 'Publish', text: 'Publish - body', triggers: 'publish package,npm release', classes: ['wrong-cause'] }).entry;
  memory.logEntry(root, 'skill', { status_of: s.id, status: 'released', issued_by: 'owner', agent: 'test' });
  return { root, s };
}
const PROMPT = { MEM_RH_SESSION: 's1', MEM_RH_PROMPT: 'how do I publish the package for the npm release' };

test('a skill offer brings two lines of its account: open/repeated errors first, then learnings; ids booked', async (t) => {
  const { root, s } = skillWorld(t);
  const e1 = error(root, 'First publish failure');
  const e2 = error(root, 'Second publish failure');
  const lr = learning(root, 'Always dry-run the publish first');
  memory.logEntry(root, 'link', { from: lr.id, to: e1.id, kind: 'generalizes', agent: 'test' });
  const offer = await recallhook.skillOffer(root, { ...process.env, ...PROMPT });
  assert.ok(offer, 'precondition: the skill is offered');
  const lines = offer.line.split('\n');
  assert.match(lines[0], /^Skill publish fits/);
  assert.equal(lines.length, 3, `expected the offer plus two account lines: ${offer.line}`);
  assert.match(lines[1], /^ {2}↳ Error \(open, repeated\) /);
  assert.match(lines[2], /^ {2}↳ Error \(open, repeated\) /);
  assert.ok(Buffer.byteLength(lines.slice(1).join('\n'), 'utf8') <= recallattach.ACCOUNT_BYTES_MAX);
  assert.deepEqual(new Set(offer.accountIds), new Set([e1.id, e2.id]));
  assert.ok(!offer.line.includes('First publish failure - text'), 'full text in an account line');
  const { book } = recallhook.recall(root, '{"hits":[]}', { ...process.env, ...PROMPT }, { offer });
  book();
  const o = injection.read(root).lines.find((x) => x.occasion === injection.OCCASION.SKILL_OFFER);
  assert.deepEqual(o.sources, [s.id]);
  assert.deepEqual(new Set(o.ids), new Set([s.id, e1.id, e2.id]));
});

test('learnings come after errors; without an open or repeated error a learning fills in', async (t) => {
  const { root } = skillWorld(t);
  const e = error(root, 'A single publish failure');
  const lr = learning(root, 'Always dry-run the publish first');
  memory.logEntry(root, 'link', { from: lr.id, to: e.id, kind: 'generalizes', agent: 'test' });
  resolves(root, lr.id, e.id); // fixed: no longer open; one error of its class: not repeated
  const offer = await recallhook.skillOffer(root, { ...process.env, ...PROMPT });
  const lines = offer.line.split('\n');
  assert.equal(lines.length, 2, offer.line);
  assert.match(lines[1], /^ {2}↳ Learning /);
});

test('no declared scope: no account lines and the store is not even read (positive control: with scope it is)', async (t) => {
  const root = world(t);
  const s = memory.logEntry(root, 'skill', { title: 'Publish', text: 'body', triggers: 'publish package,npm release' }).entry;
  memory.logEntry(root, 'skill', { status_of: s.id, status: 'released', issued_by: 'owner', agent: 'test' });
  error(root, 'A publish failure');
  error(root, 'A second publish failure');
  const plain = await recallhook.skillOffer(root, { ...process.env, ...PROMPT });
  assert.equal(plain.line.split('\n').length, 1, 'account lines without a scope');
  assert.equal(plain.accountIds, undefined);
  const scoped = reg.registry(root).find((i) => i.id === s.id);
  assert.deepEqual(recallattach.accountLines(root, [scoped]), { lines: [], ids: [] });
});

test('MEM_SKILL_ACCOUNT_OFFER=0 switches it off; encrypted and personal entries never', async (t) => {
  const { root } = skillWorld(t);
  error(root, 'First publish failure');
  error(root, 'Second publish failure');
  const on = await recallhook.skillOffer(root, { ...process.env, ...PROMPT });
  assert.equal(on.line.split('\n').length, 3, 'positive control');
  makePersonal(root);
  const priv = error(root, 'Private publish failure', { topic: 'diary' });
  assert.ok(!(await recallhook.skillOffer(root, { ...process.env, ...PROMPT })).line.includes(priv.id), 'a personal entry in an account line');
  const off = await recallhook.skillOffer(root, { ...process.env, ...PROMPT, MEM_SKILL_ACCOUNT_OFFER: '0' });
  assert.equal(off.line.split('\n').length, 1);
  const enc = error(root, 'Encrypted publish failure', { shred: true });
  assert.ok(enc.body_enc);
  const all = (await recallhook.skillOffer(root, { ...process.env, ...PROMPT })).line;
  assert.ok(!all.includes(enc.id), 'an encrypted entry in an account line');
});

// --- before an edit (bin/mem-before-edit) ---------------------------------------

function beforeEdit(root, file, extraEnv = {}) {
  const r = spawnSync('bash', [path.join(REPO, 'bin', 'mem-before-edit')], {
    input: JSON.stringify({ session_id: 's1', tool_name: 'Edit', tool_input: { file_path: file } }),
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_TRACE: '1', ...extraEnv },
  });
  const raw = String(r.stdout ?? '').trim();
  return { json: raw ? JSON.parse(raw) : null, stderr: r.stderr, status: r.status };
}

test('before an edit: the solution stands below the error of that file; the count and the journal know it', (t) => {
  const root = world(t);
  const e = error(root, 'src/zebra.mjs drops the last line', { text: 'src/zebra.mjs loses the final newline on write' });
  const l = learning(root, 'Write the file with a trailing newline');
  resolves(root, l.id, e.id);
  const out = beforeEdit(root, '/work/src/zebra.mjs');
  assert.ok(out.json, `the hook was silent: ${out.stderr}`);
  const text = out.json.hookSpecificOutput.additionalContext.split('\n');
  const at = text.findIndex((x) => x.includes('drops the last line'));
  assert.ok(at >= 0, text.join('\n'));
  assert.match(text[at + 1], new RegExp(`^ {2}\\u21b3 Solution ${l.id}: `));
  assert.match(out.json.systemMessage, /: 1 entry$/, 'a solution line counted as an entry of its own');
  const j = injection.read(root).lines.find((x) => x.occasion === injection.OCCASION.BEFORE_EDIT);
  assert.deepEqual(j.ids, [l.id]);
  assert.equal(j.hits, 1);
  // positive control: the switch removes the line, the error stays
  const root2 = world(t);
  const e2 = error(root2, 'src/zebra.mjs drops the last line', { text: 'src/zebra.mjs loses the final newline on write' });
  const l2 = learning(root2, 'Write the file with a trailing newline');
  resolves(root2, l2.id, e2.id);
  const off = beforeEdit(root2, '/work/src/zebra.mjs', { MEM_SOLUTION_ATTACH: '0' });
  assert.ok(!off.json.hookSpecificOutput.additionalContext.includes('Solution'));
  assert.match(off.json.hookSpecificOutput.additionalContext, /drops the last line/);
});

test('RED PROOF L4: at the base commit the offer for a scoped skill has no account line', async (t) => {
  const { root } = skillWorld(t);
  error(root, 'First publish failure');
  error(root, 'Second publish failure');
  const tmp = tempDir('cm-attach-base4-', t);
  exportCommit(REPO, BASE, ['src', 'package.json'], tmp);
  const old = await import(pathToFileURL(path.join(tmp, 'src', 'recallhook.mjs')).href);
  const before = await old.skillOffer(root, { ...process.env, ...PROMPT });
  assert.equal(before.line.split('\n').length, 1, 'the base already brought account lines');
  const after = await recallhook.skillOffer(root, { ...process.env, ...PROMPT });
  assert.equal(after.line.split('\n').length, 3, 'positive control: today it does');
});

// --- the hook's cost (test/hookcost-cm.test.mjs): nothing extra is loaded without an error hit ---

const LOADER = `data:text/javascript,${encodeURIComponent(`
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(\`
import fs from 'node:fs';
export async function load(url, ctx, next) {
  if (process.env.HOOKCOST_LOG && url.startsWith('file:')) fs.appendFileSync(process.env.HOOKCOST_LOG, url + '\\\\n');
  return next(url, ctx);
}\`));
`)}`;

function hookRun(t, root, hits) {
  const log = path.join(tempDir('cm-attach-log-', t), 'loaded.txt');
  const r = spawnSync(process.execPath, ['--import', LOADER, path.join(REPO, 'src', 'recallhook.mjs'), 'recall'], {
    input: JSON.stringify({ hits }), encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_RH_MIN: '1', MEM_SEARCH_LEVERS: 'off', HOOKCOST_LOG: log },
  });
  assert.equal(r.stderr, '', r.stderr);
  const loaded = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { out: r.stdout, loaded };
}
const loads = (loaded, file) => loaded.some((u) => u.endsWith(`/src/${file}`));

test('the recall hook imports the attachments only when an ERROR hit is shown (a learning hit costs nothing extra)', (t) => {
  const root = world(t);
  const e = error(root, 'The build fails on the lock file');
  const l = learning(root, 'Delete the stale lock file first');
  resolves(root, l.id, e.id);
  const plain = hookRun(t, root, [{ entry: l, source: 'global/learnings.jsonl', line: 1, score: 9 }]);
  assert.ok(loads(plain.loaded, 'recallhook.mjs'), 'the probe saw no module at all - it measures nothing');
  assert.ok(!loads(plain.loaded, 'recallattach.mjs'), 'the attachments were imported without an error hit');
  assert.ok(!loads(plain.loaded, 'search.mjs'), 'the search module was imported without an error hit');
  const withError = hookRun(t, root, [hit(e)]);
  assert.ok(loads(withError.loaded, 'recallattach.mjs'), 'POSITIVE CONTROL: with an error hit the module is loaded');
  assert.match(JSON.parse(withError.out).hookSpecificOutput.additionalContext, /↳ Solution /);
});

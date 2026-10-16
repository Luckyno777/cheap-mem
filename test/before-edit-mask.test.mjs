// hooks-harden-cm / N3 - the touched file's NAME is not an entry, and it used to leave the hook unmasked.
//
// The finding (review of c1ad4a9): the query is the last two path segments. A file called `.../ghp_<token>.sh` put that token into the hook's answer
// ("From your memory about <query>", the pointer line, the systemMessage), into the journal's `file` field, into the trace and into the name of the
// once-per-file mark. The entries are masked where they are rendered; the query was not rendered from an entry. Now the answer is masked on the way
// out (`maskOutput`, the guard every other output passes), and the journal field, the trace and the mark's name take the masked query.
//
// The token is built at run time, so no secret-shaped string stands in this file.
//
// RED on c1ad4a9 (git archive, run in the test): the token is in the answer and the journal there. POSITIVE CONTROL: the entry is found (the block is shown),
// so the absence of the token is not an absence of output.
//
// invariant: unterprozess-nennt-ursache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './temp-dir.mjs';
import { waitForRebuildIdle } from '../src/component-table.mjs';
import { REPO, toolDir } from './fixture/before-edit-old.mjs';

const MEM = path.join(REPO, 'bin', 'mem');
// A GitHub-token shape (ghp_ + 36 characters), assembled from parts.
const TOKEN = ['ghp', '_', 'a1B2c3D4e5F6', 'g7H8i9J0k1L2', 'm3N4o5P6q7R8'].join('');
const FILE = `/p/dir/${TOKEN}.sh`;

function world(t) {
  const root = tempDir('cm-bemask-', t);
  assert.equal(spawnSync(process.execPath, [MEM, 'init', '--root', root], { encoding: 'utf8', input: '' }).status, 0);
  // Hand-written line: a logged one would have been redacted on the way IN, and then there is nothing to find.
  fs.appendFileSync(path.join(root, 'global', 'errors.jsonl'), `${JSON.stringify({
    id: 'e1', ts: '2026-10-01T00:00:00Z', class: 'x', agent: 'a', title: `dir/${TOKEN}.sh breaks the build`, text: 'plain text',
  })}\n`);
  return root;
}
function call(hook, root, session, extra = {}) {
  const r = spawnSync('bash', [hook], {
    input: JSON.stringify({ session_id: session, tool_name: 'Edit', tool_input: { file_path: FILE } }),
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_HOOK_OFF: '', MEM_BEFORE_EDIT_OFF: '', MEM_BEFORE_EDIT_TRACE: '1', ...extra },
  });
  waitForRebuildIdle(root);
  return r;
}
const journal = (root) => fs.readFileSync(path.join(root, '.pipeline', 'injections.jsonl'), 'utf8');
const markNames = (root) => fs.readdirSync(path.join(root, '.mem', 'before-edit'));

test('the answer, the pointer line, the journal, the trace and the mark name carry no token', (t) => {
  const root = world(t);
  const hook = path.join(REPO, 'bin', 'mem-before-edit');
  const first = call(hook, root, 'm1');
  assert.match(first.stdout, /memory knows/, 'POSITIVE CONTROL: the entry is found and the block shown');
  assert.doesNotMatch(first.stdout, new RegExp(TOKEN), 'the token is in the answer');
  assert.match(first.stdout, /\[REDACTED/, 'the masked path says it was masked');
  const second = call(hook, root, 'm1');
  assert.match(second.stdout, /already injected/);
  assert.doesNotMatch(second.stdout, new RegExp(TOKEN), 'the token is in the pointer line');
  for (const r of [first, second]) assert.doesNotMatch(r.stderr, new RegExp(TOKEN), 'the token is in the trace');
  assert.doesNotMatch(journal(root), new RegExp(TOKEN), 'the token is in the journal');
  // A masked name carries `[`, `:` and `]` - not path characters (injection.fileNormal) - so the field is left out whole.
  assert.match(journal(root), /"occasion":"before-edit"/, 'POSITIVE CONTROL: the journal has the line');
  assert.doesNotMatch(journal(root), /"file":/, 'the masked name was booked as a file');
  for (const n of markNames(root)) assert.doesNotMatch(n, new RegExp(TOKEN), 'the token names a mark file');
});

test('the PowerShell twin\'s ASCII mode masks too (the mask comes before the escaping)', (t) => {
  const root = world(t);
  const r = call(path.join(REPO, 'bin', 'mem-before-edit'), root, 'm2');
  assert.match(r.stdout, /memory knows/);
  const core = spawnSync(process.execPath, [path.join(REPO, 'bin', 'mem-before-edit-core.mjs')], {
    input: JSON.stringify({ session_id: 'm3', tool_name: 'Edit', tool_input: { file_path: FILE } }), encoding: 'utf8',
    env: { ...process.env, CHEAP_MEM_ROOT: root, MEM_BE_ASCII: '1' },
  });
  assert.match(core.stdout, /memory knows/);
  assert.doesNotMatch(core.stdout, new RegExp(TOKEN));
});

test('RED PROOF: c1ad4a9 leaks the token into the answer and the journal', (t) => {
  const root = world(t);
  const base = tempDir('cm-bemask-base-', t);
  const tar = spawnSync('git', ['archive', 'c1ad4a9'], { cwd: REPO, encoding: 'buffer', maxBuffer: 1 << 28 });
  if (tar.status !== 0) { t.diagnostic('c1ad4a9 is not in this clone: the red proof could not run (unknown, not green)'); return; }
  const x = spawnSync('tar', ['-x', '-C', base], { input: tar.stdout });
  if (x.status !== 0) { t.diagnostic('no tar here: the red proof could not run'); return; }
  const r = call(path.join(base, 'bin', 'mem-before-edit'), root, 'm4');
  assert.match(r.stdout, new RegExp(TOKEN), 'the base no longer leaks - the red proof has moved');
  assert.match(journal(root), new RegExp(TOKEN));
});

test('MUTATION: without the final mask the first probe fails', (t) => {
  const root = world(t);
  const text = fs.readFileSync(path.join(REPO, 'bin', 'mem-before-edit'), 'utf8');
  const hook = toolDir(t, text, { core: true });
  const mod = path.join(path.dirname(hook), '..', 'src', 'beforeedit.mjs');
  const src = fs.readFileSync(mod, 'utf8');
  assert.ok(src.includes('if (r.stdout) r.stdout = maskOutput(r.stdout);'), 'the line the mutation hits moved');
  fs.writeFileSync(mod, src.replace('if (r.stdout) r.stdout = maskOutput(r.stdout);', ''));
  const r = call(hook, root, 'm5');
  assert.match(r.stdout, new RegExp(TOKEN), 'the mutated hook does not leak - the probe cannot tell');
});

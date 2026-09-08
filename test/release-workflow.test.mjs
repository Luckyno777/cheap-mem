// The release workflow, checked the way any other code is.
//
// **Why a workflow needs a test at all.** It runs on a tag, which means
// it runs a handful of times a year, which means a defect in it sits
// unseen until the one moment it matters and cannot be undone: a
// published version cannot be replaced. And it is YAML, so nothing
// type-checks it — a `needs:` pointing at a job that was renamed reads
// exactly like one that does not.
//
// These probes ask the two questions a reader of the file would: are
// the gates actually in front of the publish, and does the publish
// still name the things it depends on?
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(REPO, '.github', 'workflows', 'release.yml');
const YML = fs.readFileSync(FILE, 'utf8');

/** Job names and their `needs:` lists — read without a YAML parser. */
function jobs() {
  const out = new Map();
  const lines = YML.split('\n');
  let current = null;
  let inJobs = false;
  for (const l of lines) {
    if (/^jobs:\s*$/.test(l)) { inJobs = true; continue; }
    if (!inJobs) continue;
    const m = l.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (m) { current = m[1]; out.set(current, { needs: [], text: '' }); continue; }
    if (!current) continue;
    out.get(current).text += `${l}\n`;
    const n = l.match(/^ {4}needs:\s*(.+)$/);
    if (n) {
      out.get(current).needs = n[1].replace(/[[\]]/g, '').split(',')
        .map((x) => x.trim()).filter(Boolean);
    }
  }
  return out;
}

test('POSITIVE: the reader finds the jobs', () => {
  // A parser that returns nothing makes every assertion below vacuous.
  const j = jobs();
  assert.ok(j.size >= 4, `only ${j.size} jobs read — the reader is broken`);
  assert.ok(j.has('publish'), 'no publish job found');
});

test('every needs: names a job that exists', () => {
  const j = jobs();
  for (const [name, def] of j) {
    for (const dep of def.needs) {
      assert.ok(j.has(dep), `job '${name}' needs '${dep}', which does not exist`);
    }
  }
});

test('the publish job sits behind every gate', () => {
  // The whole shape of the file. A publish that can start while the
  // tests are running is a publish that does not depend on them.
  const pub = jobs().get('publish');
  for (const gate of ['gate', 'verify', 'pack']) {
    assert.ok(pub.needs.includes(gate),
      `publish does not wait for '${gate}' — it can ship untested code`);
  }
});

test('nothing publishes unless the gate said so', () => {
  const pub = jobs().get('publish');
  assert.match(pub.text, /if:\s*needs\.gate\.outputs\.publish == 'true'/,
    'the publish job has no condition — a dry run would publish');
});

test('the tag must match the manifest version', () => {
  // The classic silent release defect: a hand-written tag and a
  // package.json that were never bumped together, publishing 0.1.0 from
  // a commit called v0.2.0.
  assert.match(YML, /TAG" != "v\$VERSION"/,
    'nothing compares the tag against package.json');
});

test('the publish step asks for provenance and nothing more', () => {
  const pub = jobs().get('publish');
  assert.match(pub.text, /id-token: write/, 'no OIDC token, so no provenance');
  assert.match(pub.text, /npm publish --provenance/);
  // `contents: write` on a job holding a registry token is more reach
  // than the job needs. The default at the top of the file is read.
  assert.ok(!/contents: write/.test(YML),
    'the workflow grants write access to the repository it does not need');
});

test('the token is a secret, never a literal', () => {
  assert.match(YML, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  // A guard against the one mistake that cannot be taken back. Anything
  // that looks like an npm token in this file has already leaked.
  assert.ok(!/npm_[A-Za-z0-9]{30,}/.test(YML), 'a literal npm token is in the workflow');
});

test('a concurrent release is never cancelled half-way', () => {
  // `cancel-in-progress: true` is right for CI and wrong here: a
  // publish killed between the registry write and the tag is a state
  // nobody can reconstruct.
  const head = YML.slice(0, YML.indexOf('jobs:'));
  assert.match(head, /concurrency:[\s\S]*cancel-in-progress: false/);
});

test('the packed tarball is proved to run outside a checkout', () => {
  const pack = jobs().get('pack');
  assert.match(pack.text, /npm pack --json/);
  assert.match(pack.text, /npm i --omit=optional/, 'the tarball is never installed');
  assert.match(pack.text, /mem --root "\$MEMDIR" init/,
    'the installed package is never run');
  // Both directions: what must be in, and what must never be.
  assert.match(pack.text, /the tarball is missing/);
  assert.match(pack.text, /must never ship/);
});

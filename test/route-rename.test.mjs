// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// The old desk's numbers moved from `/dashboard.json` to `/pult.json`, and
// on 2026-10-01 to the English `/desk.json` (`/pult.json` now redirects).
//
// **Why (owner decision 2026-09-28, port spec
// docs/dashboard-port-2026-09-28.md §6.2).** The new dashboard — the one
// UI both houses share — owns `/dashboard` and `/dashboard.json`. Before
// this rename `/dashboard.json` already answered here, with the OLD
// Astra desk's `collect()` shape. Building the new page on top of that
// would have given one address two meanings for as long as the port took.
// So the rename landed first, alone, and this file pins it:
//
//  1. `/desk.json` is in `PATHS` and answers the old desk's shape
//     (`views` is its fingerprint).
//  2. `/dashboard.json` NEVER answers the old desk's shape again —
//     whether it is 404 (before the new page) or the new dashboard's
//     payload (after), it must not carry Astra's `views` list.
//  3. Red-proof against a FIXED commit (ddb741f, the tree this work
//     started from — never `git merge-base`, which moves after a merge):
//     there, `/dashboard.json` WAS routed to the old `dashboard.collect()`.
//     The probe for (2) is shown to see the difference.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const OLD_COMMIT = 'ddb741f';

function bare() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-rename-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ name: 'rename', participants: ['someone'], language: 'en' }));
  return r;
}

/** Does this server source route `/dashboard.json` to the OLD desk collector? */
function routesOldDeskAtDashboardJson(source) {
  return /url\.pathname === '\/dashboard\.json'\s*\n?\s*\?\s*\{\s*data:\s*dashboard\.collect\(/.test(source);
}

test('/desk.json is in PATHS and answers the old desk shape; /pult.json redirects to it', async () => {
  const mod = await import(`${pathToFileURL(SERVE).href}?rename=${Math.random()}`);
  assert.ok(mod.PATHS.includes('/desk.json'));
  assert.ok(mod.PATHS.includes('/pult.json'), 'the German alias was dropped: old scripts would get a 404');
  const root = bare();
  const { server } = await mod.serve(root, {
    CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_TOKEN: '',
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/desk.json`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(Array.isArray(d.views), 'the old desk shape carries its views list');

    // The German alias: a 308 to the English path, query kept; a client
    // that follows redirects gets the same payload as before.
    const alias = await fetch(`${base}/pult.json?x=1`, { redirect: 'manual' });
    assert.equal(alias.status, 308);
    assert.equal(alias.headers.get('location'), '/desk.json?x=1');
    const followed = await (await fetch(`${base}/pult.json`)).json();
    assert.ok(Array.isArray(followed.views), '/pult.json no longer reaches the desk data');

    // (2) `/dashboard.json` never again answers the old desk's shape.
    const n = await fetch(`${base}/dashboard.json`);
    if (n.status === 200) {
      const j = await n.json();
      assert.ok(!('views' in j), '/dashboard.json still answers the OLD desk payload');
    } else {
      assert.equal(n.status, 404);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((res) => server.close(res));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the current server source no longer routes /dashboard.json to the old desk', () => {
  const now = fs.readFileSync(SERVE, 'utf8');
  assert.equal(routesOldDeskAtDashboardJson(now), false);
});

test(`red-proof: at the fixed commit ${OLD_COMMIT} the same probe WAS red`, (t) => {
  let old;
  try {
    old = execFileSync('git', ['show', `${OLD_COMMIT}:bin/mem-serve`], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // A shallow clone without that commit cannot run the red-proof;
    // say so rather than pass silently.
    t.skip(`commit ${OLD_COMMIT} not in this clone`);
    return;
  }
  assert.equal(routesOldDeskAtDashboardJson(old), true,
    'the probe does not see the old routing — it would pass on anything');
});

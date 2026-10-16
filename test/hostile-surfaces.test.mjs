// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// A9 (security cross-check 2026-10-10): hostile input on the viewer and board surfaces.
//
// **Why.** Everything a connected agent writes (entries over the bridge, inbox mail, appointments, a
// heartbeat, a bridge report) ends up as text in pages other people read: the dashboard behind
// `mem serve`, `/entries`, the standalone viewer file, `mem board --html`. Each of them escapes on its own;
// what was missing is ONE probe that feeds every surface the same hostile corpus and looks at the DOM, not
// at the source: script tags, event-handler breakouts out of double and single quoted attributes,
// `javascript:` text, HTML entities (shown as typed, never decoded twice), `</script>` and `<!--` inside the
// embedded data block, U+2028/9, and very long values, in title / text / tags / topic (and the type's own fields).
// bidi controls are covered elsewhere (bench/atlas/phase-defence.mjs, `src/bidi.mjs`).
//
// **Finding (red on 91b1afc).** The standalone viewer embedded its data as JSON in a script block and made
// the string "<!--" safe by writing `<\!--`. That is not a JSON escape: `JSON.parse` of the block throws, and
// the viewer stays BLANK. One entry containing "<!--" (any foreign agent can write one) takes the viewer
// down for everybody who opens the file. Not a script injection, but a hostile value that stops a surface.
// Fixed in `src/viewer.mjs` (`safeJson` writes `\u003c`, the way `src/readview.mjs` always did).
//
// The other probes found no escape: they pin what already holds. Every probe has its positive control
// (the corpus is shown as text, and the scanner finds a planted element), so "nothing found" cannot mean
// "nothing looked".
/* global document, window, sections -- these run inside the page (browser), not in Node */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './temp-dir.mjs';
import * as memory from '../src/memory.mjs';
import * as inbox from '../src/inbox.mjs';
import * as appointments from '../src/appointments.mjs';
import * as heartbeat from '../src/heartbeat.mjs';
import * as board from '../src/board.mjs';
import * as viewer from '../src/viewer.mjs';
import * as entriesPage from '../src/entries-page.mjs';
import * as entity from '../src/entity.mjs';
import * as netderive from '../src/netderive.mjs';
import * as dashboardData from '../src/dashboard-data.mjs';
import { lazyBrowser, browserStartProbe, waitReady, startView } from './fixture/browser.mjs';

// --- The corpus -----------------------------------------------------------------------------------

/** Hostile values, each carrying a token so a firing handler says WHICH one fired. */
function payloads(n) {
  return [
    `<script>window.__xss='${n}-script'</script>`,
    `<img src=x onerror="window.__xss='${n}-img'">`,
    `"><svg onload="window.__xss='${n}-dq'">`,
    `'><img src=x onerror=window.__xss='${n}-sq'>`,
    `</script><script>window.__xss='${n}-close'</script>`,
    `<!--<script>window.__xss='${n}-comment'</script>`,
    `javascript:window.__xss='${n}-url'`,
    `&lt;img src=x onerror=window.__xss='${n}-ent'&gt; &#60;b&#62; &amp;lt;`,
    `line\u2028separator\u2029here ${n}`,
  ];
}
const PARTICIPANTS = { alex: { human: true }, bot: {}, 'vm-admin': 'agent' };

function hostileRoot(t, { long = false } = {}) {
  const root = tempDir('cm-hostile-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ name: 'hostile', participants: PARTICIPANTS, language: 'en' }));
  const per = {
    decision: (p) => ({ choice: p, why: p, rejected: p }),
    error: (p) => ({ class: 'wrong-cause', file: p }),
    learning: (p) => ({ learning: p }),
    event: () => ({}),
    thought: () => ({}),
    question: (p) => ({ question: p }),
    duty: (p) => ({ duty: p, owner: p }),
    timeline: (p) => ({ key: p, value: p, source: p }),
    skill: (p) => ({ skill: p }),
    source: (p) => ({ address: p, description: p, excerpt: p }),
    update: () => ({}),
  };
  let n = 0;
  for (const [type, own] of Object.entries(per)) {
    for (const p of payloads(`${type}${n++}`)) {
      memory.logEntry(root, type, { title: p, text: p, topic: p, tags: [p, 'plain'], agent: p, ...own(p) });
    }
  }
  const ids = memory.readLog(root, 'decision').entries.map((e) => e.id);
  for (const p of payloads('link')) memory.logEntry(root, 'link', { from: ids[0], to: ids[1], kind: 'causes', why: p });
  for (const p of payloads('inbox')) inbox.write(root, PARTICIPANTS, { from: 'bot', to: 'alex', subject: p, text: p });
  let k = 0;
  for (const p of payloads('appt')) {
    appointments.create(root, { title: p, text: p, atMs: Date.now() + 3600000 * (k += 1),
      actor: { name: 'bot', human: false }, now: Date.now(), env: {} });
  }
  payloads('beat').forEach((p, i) => heartbeat.beat(root, `bot${i}`, { what: p, where: p, minGapMin: 0 }));
  board.report(root, payloads('report')[1], { by: payloads('report')[2] });
  if (long) {
    const L = 'A'.repeat(150000);
    memory.logEntry(root, 'question', { title: L, question: `${L}?`, text: L, tags: [L], topic: L });
    memory.logEntry(root, 'error', { title: L, text: L, class: 'wrong-cause', tags: [L], topic: L, file: L });
  }
  return root;
}

/** A pristine root with one harmless entry per type: the baseline for "how many scripts does this page have". */
function cleanRoot(t) {
  const root = tempDir('cm-clean-', t);
  fs.mkdirSync(path.join(root, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(root, '.mem', 'config.json'),
    JSON.stringify({ name: 'clean', participants: PARTICIPANTS, language: 'en' }));
  memory.logEntry(root, 'event', { title: 'plain', text: 'plain', tags: ['plain'], topic: 'plain' });
  return root;
}

// --- Static probes: what the server writes ---------------------------------------------------------

/** Every real tag of a page (escaped text has no "<", so only markup matches). */
const realTags = (html) => html.match(/<[a-zA-Z][^>]*>/g) ?? [];
const count = (html, name) => realTags(html).filter((x) => new RegExp(`^<${name}[\\s>/]`, 'i').test(x)).length;
/** The attributes of one tag as [name, value] pairs (quoted values are values, not attribute names). */
const attrsOf = (tag) => {
  const body = tag.replace(/^<[a-zA-Z][^\s/>]*/, '').replace(/\/?>$/, '');
  return [...body.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)]
    .map((m) => [m[1], m[2] ?? m[3] ?? m[4] ?? '']);
};
/** The dangerous element kinds a hostile value could turn into: their count must equal the clean page's. */
const DANGEROUS = ['script', 'img', 'svg', 'iframe', 'object', 'embed', 'form', 'base', 'meta'];
const assertNoNewMarkup = (hostile, clean, what) => {
  for (const name of DANGEROUS) assert.equal(count(hostile, name), count(clean, name), `${what}: a hostile value added <${name}>`);
  const handlers = realTags(hostile).flatMap((tag) => attrsOf(tag).filter(([n]) => /^on/i.test(n)).map(([n]) => `${tag.slice(0, 40)} ${n}`));
  assert.deepEqual(handlers, [], `${what}: a tag carries an event handler`);
  const urls = realTags(hostile).flatMap((tag) => attrsOf(tag)
    .filter(([n, v]) => /^(href|src|action|formaction|xlink:href)$/i.test(n) && /^\s*javascript:/i.test(v)).map(([n]) => `${tag.slice(0, 40)} ${n}`));
  assert.deepEqual(urls, [], `${what}: a tag carries a javascript: address`);
};

test('the static scanner is not blind: a planted handler, element and javascript: address are found (positive control)', () => {
  const planted = '<p onclick="1">x</p><a href=" JavaScript:alert(1)">l</a><img src=x onerror=y><input value="a onerror=b">';
  const clean = '<p>x</p>';
  assert.throws(() => assertNoNewMarkup(planted, clean, 'planted'));
  assert.deepEqual(attrsOf('<input value="a onerror=b">'), [['value', 'a onerror=b']], 'a quoted value is not an attribute name');
  assert.doesNotThrow(() => assertNoNewMarkup('<p>&lt;img src=x onerror=y&gt;</p><input value="a onerror=b">', clean, 'escaped'));
});

test('mem board --html: hostile tile content is text, the page stays script-free, and length is bounded', (t) => {
  const root = hostileRoot(t, { long: true });
  const html = board.asHtml(board.board(root, { now: new Date() }));
  const clean = board.asHtml(board.board(cleanRoot(t), { now: new Date() }));
  assert.doesNotMatch(html, /<script/i, 'the board runs code');
  assertNoNewMarkup(html, clean, 'board');
  // Positive control: the hostile text IS on the page, escaped (the bridge tile and the question tile show it).
  assert.match(html, /&lt;img src=x onerror=/, 'the corpus is not on the board at all, so the probe proves nothing');
  // 2 x 3 x 150 000 characters went in; the board is a status screen, not a mirror.
  assert.ok(html.length < 20000, `the board grew with the input: ${html.length} bytes`);
});

test('standalone viewer: the data block parses back to the typed values, whatever the title holds', (t) => {
  const root = hostileRoot(t);
  const { html } = viewer.build([root], { title: payloads('title')[1] });
  const clean = viewer.build([cleanRoot(t)], { title: 'plain' }).html;
  const m = html.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/);
  const withoutData = (page) => page.replace(/<script id="data"[^>]*>[\s\S]*?<\/script>/, '');
  // The data block is inert text for the HTML parser; everything else is markup the code wrote.
  assertNoNewMarkup(withoutData(html), withoutData(clean), 'viewer');
  assert.ok(m, 'no data block');
  assert.doesNotMatch(m[1], /<\/|<!--/, 'a sequence that ends or hides the script is in the data block');
  let data;
  assert.doesNotThrow(() => { data = JSON.parse(m[1]); },
    'the data block is not JSON any more: the viewer would stay blank (the "<!--" escape was not a JSON escape)');
  assert.ok(data.memories?.[0]?.entries?.length >= 90, 'the hostile entries are not in the data block');
  // Round trip: one value with every dangerous sequence comes back exactly as typed.
  const odd = '</script><!--<script>x\u2028y\u2029 & &lt;';
  const root2 = cleanRoot(t);
  memory.logEntry(root2, 'event', { title: odd, text: odd, tags: [odd], topic: 'odd' });
  const html2 = viewer.build([root2]).html;
  const m2 = html2.match(/<script id="data"[^>]*>([\s\S]*?)<\/script>/);
  const back = JSON.parse(m2[1]);
  assert.ok(JSON.stringify(back).includes(JSON.stringify(odd).slice(1, -1)), 'the value did not survive the round trip');
});

test('/entries page: hostile entries and hostile query values are text; the entity stays as typed', (t) => {
  const root = hostileRoot(t);
  const clean = entriesPage.render(cleanRoot(t), new URLSearchParams('')).html;
  for (const v of payloads('q')) {
    const res = entriesPage.render(root, new URLSearchParams({ q: v, type: v, project: v }));
    assertNoNewMarkup(res.html, clean, `/entries?q=${v.slice(0, 24)}`);
  }
  const res = entriesPage.render(root, new URLSearchParams(''));
  assertNoNewMarkup(res.html, clean, '/entries');
  assert.match(res.html, /&lt;img src=x onerror=/, 'the corpus is not listed, so the probe proves nothing');
  assert.match(res.html, /&amp;lt;img src=x onerror=/, 'an entity typed into a title was decoded');
});

// --- Very long values: the build stays bounded -----------------------------------------------------
//
// **Finding (red on 91b1afc).** The write path accepts an entry up to `maxEntryBytes` (1 MiB). Two regular
// expressions that run over every entry's text on the way to the dashboard, the search index and the recall hook
// were quadratic in the length of one unbroken run of characters: `entity.PATTERNS` ('name', 'path') and
// `netderive.FILE_RE`. One title of 60 000 characters made `collectDashboard` take 22 s of CPU, 150 000 characters
// more than 90 s, with the event loop blocked the whole time: a connected agent could freeze `mem serve` and
// every index build with one `mem_log`. The fix is a bound per unbroken run (`entity.boundRuns`): no identifier,
// path or file name is 512 characters long; what lies beyond is not scanned. Normal text is untouched.
const within = (ms, fn) => { const t0 = Date.now(); fn(); return Date.now() - t0; };
const SHAPES = {
  'one long word': (n) => 'A'.repeat(n),
  'dots': (n) => 'a.'.repeat(n / 2),
  'hyphens': (n) => 'ab-'.repeat(n / 3),
  'digits and dots': (n) => '1.'.repeat(n / 2),
  'dashes': (n) => 'a-'.repeat(n / 2),
  'slashes': (n) => 'a/'.repeat(n / 2),
};

test('entity.identifiers: an unbroken run of 40 000 characters is scanned in linear time, whatever its shape', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const ms = within(1000, () => entity.identifiers(make(40000)));
    assert.ok(ms < 1000, `identifiers() took ${ms} ms on 40 000 characters of "${name}"`);
  }
});

test('netderive.features: the file-name scan is linear on a long run, too', () => {
  for (const [name, make] of Object.entries(SHAPES)) {
    const ms = within(1000, () => netderive.features({ id: 'x', ts: 't', title: make(40000), text: make(40000), file: make(40000) }));
    assert.ok(ms < 1000, `features() took ${ms} ms on "${name}"`);
  }
});

test('the bound changes nothing for ordinary text: identifiers and file names are the same as the unbounded patterns find', () => {
  const samples = [
    'See src/cli/commands/write.mjs and test/bridge-fields.test.mjs for CHEAP_MEM_ROOT, v3.7.2 and kolibri-taktgeber (ticket 123456).',
    'README.md, store.put, AuthService.refreshToken; e-mail and z.B. stay out. docs/environment-variables.md',
    'x'.repeat(500) + ' ' + 'ab-cd/ef.gh '.repeat(40),
    '.hidden/file.js -dash/x.json a-b-c-d/path.py',
  ];
  for (const text of samples) {
    const bounded = [...entity.identifiers(text)].sort();
    const raw = new Set();
    for (const { re } of entity.PATTERNS) { re.lastIndex = 0; for (const m of text.matchAll(re)) raw.add(m[0].toLowerCase()); }
    assert.deepEqual(bounded, [...raw].sort(), `identifiers differ on: ${text.slice(0, 50)}`);
  }
  assert.deepEqual([...netderive.features({ id: 'a', title: 'See src/cli/write.mjs and docs/a-b.md.', text: 'also test/x.test.mjs' }).files].sort(),
    ['docs/a-b.md', 'src/cli/write.mjs', 'test/x.test.mjs']);
  assert.equal(entity.boundRuns('short words stay'), 'short words stay');
  assert.equal(entity.boundRuns(`a ${'b'.repeat(2000)} c`).length, 2 + entity.MAX_RUN + 2);
});

test('collectDashboard: one entry with four very long fields does not hold the server for minutes', (t) => {
  const root = cleanRoot(t);
  const L = 'A'.repeat(40000);
  memory.logEntry(root, 'event', { title: L, text: L, topic: L.replace(/A/g, 'b'), tags: [L.replace(/A/g, 'c')], file: L });
  const ms = within(0, () => dashboardData.collectDashboard(root, {}));
  assert.ok(ms < 15000, `collectDashboard took ${ms} ms for one hostile entry`);
});

// --- Browser probes: what the DOM becomes ----------------------------------------------------------

const B = lazyBrowser();
browserStartProbe(B);

/** Runs in the page: anything that is live, not text. */
function scanPage() {
  const bad = [];
  if (window.__xss) bad.push(`FIRED ${window.__xss}`);
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) if (/^on/i.test(a.name)) bad.push(`${el.tagName}[${a.name}]`);
    if (el.tagName === 'IMG' && el.getAttribute('src') === 'x') bad.push(`INJECTED ${el.outerHTML.slice(0, 60)}`);
    if (el.tagName.toLowerCase() === 'svg' && el.hasAttribute('onload')) bad.push('INJECTED svg onload');
    for (const a of ['href', 'src', 'action', 'formaction', 'xlink:href']) {
      if (/^\s*javascript:/i.test(el.getAttribute(a) || '')) bad.push(`${el.tagName} ${a}=javascript:`);
    }
  }
  const lit = (document.body.textContent.match(/<script>window\.__xss|<img src=x onerror|javascript:window|&lt;img src=x onerror/g) || []).length;
  return { bad: [...new Set(bad)], scripts: document.scripts.length, lit };
}

test('the scanner is not blind: a planted handler, element and javascript: link are found (positive control)', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const page = await browser.newPage();
  try {
    await page.setContent('<p id="p">x</p><a href="javascript:void(0)">l</a><div onclick="1"></div><svg onload="1"></svg>');
    await page.evaluate(() => { const i = document.createElement('img'); i.setAttribute('src', 'x'); document.body.append(i); });
    const r = await page.evaluate(scanPage);
    for (const want of [/onclick/, /javascript:/, /INJECTED/]) {
      assert.ok(r.bad.some((b) => want.test(b)), `the scanner missed ${want}: ${JSON.stringify(r.bad)}`);
    }
  } finally { await page.close(); }
});

test('standalone viewer in a browser: it draws with a "<!--" in the memory, the corpus is text, nothing is live', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const root = hostileRoot(t);
  const { html } = viewer.build([root], { title: payloads('title')[1] });
  const file = path.join(root, 'viewer.html');
  fs.writeFileSync(file, html);
  const baseline = viewer.build([cleanRoot(t)], { title: 'plain' }).html;
  const baseFile = path.join(root, 'clean.html');
  fs.writeFileSync(baseFile, baseline);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`file://${baseFile}`);
    const clean = await page.evaluate(scanPage);
    await page.goto(`file://${file}`);
    await page.waitForFunction(() => document.querySelectorAll('#view *').length > 5, null, { timeout: 15000 })
      .catch(() => { /* reported by the assertions below, with the page error */ });
    assert.deepEqual(errors, [], `the viewer threw while drawing the hostile memory: ${errors.join(' | ')}`);
    const r = await page.evaluate(scanPage);
    assert.deepEqual(r.bad, [], `something hostile is live: ${JSON.stringify(r.bad)}`);
    assert.equal(r.scripts, clean.scripts, 'a hostile value added a script element');
    assert.ok(r.lit > 20, `the corpus is not shown as text (${r.lit}); the viewer is blank or the probe is blind`);
    // Every lens, a search for each hostile shape, and a click through the rows: still inert.
    const tabCount = await page.locator('#tabs button').count();
    assert.ok(tabCount >= 5, `the viewer shows ${tabCount} lenses`);
    for (let i = 0; i < tabCount; i += 1) {
      await page.locator('#tabs button').nth(i).click();
      const s = await page.evaluate(scanPage);
      assert.deepEqual(s.bad, [], `a tab made something live: ${JSON.stringify(s.bad)}`);
    }
    const box = page.locator('input[type=search], input[type=text]').first();
    for (const needle of ['<script>', 'onerror', 'javascript:', '"><svg']) {
      if (!(await box.count())) break;
      await box.fill(needle);
      const s = await page.evaluate(scanPage);
      assert.deepEqual(s.bad, [], `searching for ${needle} made something live: ${JSON.stringify(s.bad)}`);
    }
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('dashboard (mem serve): every screen with the hostile memory shows text only; details and search stay inert', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const root = hostileRoot(t, { long: true });
  const env = { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '', CHEAP_MEM_SERVE_LOGIN: 'off', CHEAP_MEM_SERVE_LOCAL_NO_TOKEN: '1' };
  const view = await startView(root, env, { serveOpts: { allowWrites: true } });
  t.after(() => view.stop());
  // The JSON the page lives on is never sniffed into HTML.
  const j = await fetch(`${view.base}/dashboard.json`);
  assert.equal(j.headers.get('x-content-type-options'), 'nosniff');
  assert.match(j.headers.get('content-type'), /json/);
  const e = await fetch(`${view.base}/entries?q=${encodeURIComponent(payloads('hdr')[1])}`);
  assert.equal(e.headers.get('x-content-type-options'), 'nosniff');
  assert.match(e.headers.get('content-type'), /text\/html/);

  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const errors = [];
  page.on('pageerror', (er) => errors.push(er.message));
  try {
    await page.goto(`${view.base}/dashboard#home`);
    await waitReady(page);
    const baseScripts = await page.evaluate(() => document.scripts.length);
    const all = await page.evaluate(() => Object.entries(sections).map(([k, s]) => [k, s.tabs.map((x) => x[0])]));
    let shown = 0;
    for (const [area, tabs] of all) {
      for (const tab of (tabs.length ? tabs : [''])) {
        const route = tab ? `${area}/${tab}` : area;
        await page.evaluate((r) => { window.location.hash = r; }, route);
        await page.waitForTimeout(350);
        const r = await page.evaluate(scanPage);
        assert.deepEqual(r.bad, [], `${route}: something hostile is live: ${JSON.stringify(r.bad)}`);
        assert.equal(r.scripts, baseScripts, `${route}: a hostile value added a script element`);
        shown += r.lit;
      }
    }
    assert.ok(shown > 100, `the corpus is hardly shown as text anywhere (${shown}): the probe may be blind`);
    // Entry details (every tab of the drawer) of the first rows on the list.
    await page.evaluate(() => { window.location.hash = 'knowledge/entries'; });
    await page.waitForTimeout(500);
    const ids = await page.$$eval('[data-entry]', (els) => [...new Set(els.map((x) => x.getAttribute('data-entry')))].slice(0, 8));
    assert.ok(ids.length > 0, 'no entry to open');
    for (const id of ids) {
      for (const tab of ['content', 'evidence', 'history', 'raw']) {
        await page.evaluate(([i, tb]) => showDetail(i, tb), [id, tab]); // eslint-disable-line no-undef
        const r = await page.evaluate(scanPage);
        assert.deepEqual(r.bad, [], `detail ${id}/${tab}: something hostile is live: ${JSON.stringify(r.bad)}`);
      }
      await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
    }
    // The entry search box with the hostile shapes.
    for (const needle of ['<script>', 'onerror', 'javascript:', '"><img src=x onerror=window.__xss=1>']) {
      if (!(await page.locator('#entrySearch').count())) break;
      await page.fill('#entrySearch', needle);
      await page.waitForTimeout(700);
      const r = await page.evaluate(scanPage);
      assert.deepEqual(r.bad, [], `searching for ${needle}: something hostile is live: ${JSON.stringify(r.bad)}`);
    }
    assert.deepEqual(errors, [], `the dashboard threw: ${errors.join(' | ')}`);
  } finally { await ctx.close(); }
});

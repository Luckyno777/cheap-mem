// bench/docs-images.mjs -- reproducible documentation screenshots for
// cheap-mem's README.
//
// Builds a SYNTHETIC demo store in a temp directory (never real user
// data), starts the real dashboard server (bin/mem-serve) against it,
// drives it with Playwright/Chromium, and drops optimized images under
// docs/images/. NEVER runs against a real store (see assertRootIsTemp) --
// that guard is checked again by test/docs-images-guard.test.mjs.
//
// Usage: node bench/docs-images.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as memory from '../src/memory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const SERVE = path.join(REPO, 'bin', 'mem-serve');
const TARGET_DIR = path.join(REPO, 'docs', 'images');
const NOW = new Date('2026-09-28T09:00:00Z');

/**
 * The guard: this function only accepts a directory under the system
 * temp directory. A real store (this repo, or a user's home directory)
 * aborts immediately, before any server starts or any screenshot is
 * taken.
 */
export function assertRootIsTemp(root) {
  const tmp = fs.realpathSync(os.tmpdir());
  let real;
  try { real = fs.realpathSync(root); } catch { real = path.resolve(root); }
  if (real === tmp || !real.startsWith(tmp + path.sep)) {
    throw new Error(
      `docs-images.mjs refused: '${root}' is not under the temp directory (${tmp}). `
      + 'This script may only run against a synthetic temp store, never a real one.',
    );
  }
  return real;
}

function world() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-docs-images-'));
  assertRootIsTemp(r);
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), JSON.stringify({
    name: 'northwind',
    participants: { alex: { human: true }, jordan: { human: true }, bot: {} },
    language: 'en',
    dashboard: { allowWrites: true },
  }));

  const projects = ['lighthouse', 'nightwatch', 'gardenpath', 'source-atlas', 'bridge-relay'];
  const subjects = ['architecture', 'planning', 'operations', 'customers', 'integration'];
  let n = 0;
  for (const project of projects) {
    for (let i = 0; i < 14; i += 1) {
      const subject = subjects[i % subjects.length];
      const t = new Date(NOW.getTime() - (n * 3 + i) * 3600_000);
      memory.logEntry(r, 'decision', {
        title: `${project}: ${subject} decision ${i}`,
        text: `We went with option ${String.fromCharCode(65 + (i % 5))} because the ${subject} measurement pointed that way.`,
        tags: [subject, project],
      }, { project, now: t });
      n += 1;
    }
    for (let i = 0; i < 6; i += 1) {
      const t = new Date(NOW.getTime() - (n * 5) * 3600_000);
      memory.logEntry(r, 'error', {
        title: `${project}: rollout failure ${i}`,
        text: 'Health check timed out; the second attempt went green.',
        tags: ['operations', project],
      }, { project, now: t });
      n += 1;
    }
    for (let i = 0; i < 5; i += 1) {
      const t = new Date(NOW.getTime() - (n * 7) * 3600_000);
      memory.logEntry(r, 'learning', {
        title: `${project}: learning ${i}`,
        text: 'Smaller batches lower the error rate measurably; larger batches save time -- the trade-off is written down.',
        tags: [project],
      }, { project, now: t });
      n += 1;
    }
    for (let i = 0; i < 4; i += 1) {
      const t = new Date(NOW.getTime() - (n * 2) * 3600_000);
      memory.logEntry(r, 'duty', {
        title: `${project}: follow up with the team on point ${i}`,
        who: ['alex', 'jordan', 'bot'][i % 3],
      }, { project, now: t });
      n += 1;
    }
    for (let i = 0; i < 2; i += 1) {
      const t = new Date(NOW.getTime() - (n * 2) * 3600_000);
      memory.logEntry(r, 'question', {
        question: `${project}: is option ${i} decided yet?`,
      }, { project, now: t });
      n += 1;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    memory.logEntry(r, 'skill', {
      title: `Procedure ${i}: red proof before every build`,
      text: 'Show the probe is red on the old state first, then build.',
      tags: ['procedure'],
    }, { now: new Date(NOW.getTime() - i * 9000_000) });
  }
  return r;
}

function loadPlaywright() {
  for (const base of [import.meta.url, '/opt/node22/lib/node_modules/']) {
    try { return createRequire(base)('playwright'); } catch { /* next place */ }
  }
  return null;
}
async function launchBrowser(pw) {
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  try { return await pw.chromium.launch({ args }); } catch { /* fall through */ }
  const p = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  if (fs.existsSync(p)) return pw.chromium.launch({ executablePath: p, args });
  throw new Error('No startable Chromium found.');
}

async function startServer(root) {
  const mod = await import(`${pathToFileURL(SERVE).href}?docs=${Math.random()}`);
  const { server } = await mod.serve(root, { CHEAP_MEM_SERVE_HOST: '127.0.0.1', CHEAP_MEM_SERVE_PORT: '0', CHEAP_MEM_SERVE_TOKEN: '' }, { allowWrites: true });
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => new Promise((res) => server.close(res)) };
}

async function go(page, base, hash) {
  await page.goto(base + '/dashboard#' + hash, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => typeof D !== 'undefined' && D !== null, null, { timeout: 60000 });
  await page.evaluate((h) => { location.hash = '#' + h; }, hash);
  await page.waitForTimeout(300);
}

/** Waits for the 3D network (canvas #brain) to actually draw points,
 * then freezes the animation so the screenshot is crisp, not blurred. */
async function prepareNetwork(page) {
  await page.waitForSelector('#brain', { timeout: 15000 }).catch(() => null);
  await page.evaluate(() => document.querySelector('.brain-panel')?.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await page.waitForTimeout(1600); // camera fly-in + fog build-up
  await page.evaluate(() => {
    if (typeof state !== 'undefined') state.motion = false;
    document.body.classList.add('reduce-motion');
  });
  await page.waitForTimeout(250);
}

async function shot(page, file) {
  const raw = file + '.raw.png';
  await page.screenshot({ path: raw, animations: 'disabled', timeout: 60000 });
  return raw;
}

/**
 * A fresh page for EVERY screenshot instead of reusing one page across
 * several navigations. Under software rendering (swiftshader), GPU work
 * from earlier WebGL contexts piled up otherwise -- observed as a
 * hanging `page.screenshot()` (>30s, "waiting for fonts to load") on the
 * fourth navigation in a row, regardless which page it was. A new page
 * per shot reliably frees the WebGL context.
 */
async function capture(context, base, hash, filename, { network = false, prepare } = {}) {
  const page = await context.newPage();
  try {
    await go(page, base, hash);
    if (network) await prepareNetwork(page);
    if (prepare) await prepare(page);
    return await shot(page, path.join(TARGET_DIR, filename));
  } finally {
    await page.close();
  }
}

async function main() {
  const root = world();
  const pw = loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed.');
  const browser = await launchBrowser(pw);
  const server = await startServer(root);
  fs.mkdirSync(TARGET_DIR, { recursive: true });
  const rawList = [];
  try {
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

    rawList.push(['01-overview.png', await capture(desktop, server.base, 'home', '01-overview', { network: true })]);
    rawList.push(['02-knowledge-space.png', await capture(desktop, server.base, 'knowledge/network', '02-knowledge-space', { network: true })]);
    rawList.push(['03-retrieval-probe.png', await capture(desktop, server.base, 'work/context', '03-retrieval-probe', {
      prepare: async (page) => {
        await page.fill('#probeQuestion', 'why did lighthouse go with option B');
        await page.click('[data-action="probe-ask"]');
        await page.waitForFunction(() => {
          const el = document.querySelector('#probeResult');
          return el && el.textContent.trim().length > 20;
        }, null, { timeout: 15000 }).catch(() => null);
        await page.waitForTimeout(300);
      },
    })]);
    rawList.push(['04-operations-health.png', await capture(desktop, server.base, 'ops/doctor', '04-operations-health', {
      prepare: (page) => page.waitForTimeout(400),
    })]);
    rawList.push(['05-settings.png', await capture(desktop, server.base, 'settings/appearance', '05-settings', {
      prepare: (page) => page.waitForTimeout(300),
    })]);
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    rawList.push(['06-mobile-overview.png', await capture(mobile, server.base, 'home', '06-mobile-overview', { network: true })]);
    rawList.push(['07-mobile-duties.png', await capture(mobile, server.base, 'work/tasks', '07-mobile-duties', {
      prepare: (page) => page.waitForTimeout(300),
    })]);
    await mobile.close();
  } finally {
    await browser.close();
    await server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }

  const script = path.join(HERE, 'docs-images-optimize.py');
  execFileSync('python3', [script, TARGET_DIR, ...rawList.map(([, raw]) => raw)], { stdio: 'inherit' });

  console.log('Done. Images under', TARGET_DIR);
}

// Only run when started directly -- an `import` (e.g. from the guard
// test, which only needs assertRootIsTemp()) must NEVER trigger the
// whole screenshot run (browser, server, minutes).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

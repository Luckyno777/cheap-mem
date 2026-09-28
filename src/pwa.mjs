// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// pwa.mjs — the shell that puts the dashboard on a home screen.
//
// **Owner decision 2026-09-28 (port spec §6.7): a PWA like the sibling
// house's.** A manifest and a service worker need a real origin — a
// service worker cannot be registered from file:// — so the shell
// belongs to the LIVE link (`bin/mem-serve`), which inserts it while
// serving. `mem viewer`'s one-off file stays untouched.
//
// **What does NOT happen here: caching memory content.** The server
// answers `cache-control: no-store`, because the content is private. A
// service worker that put the page into a phone's Cache Storage would
// undo exactly that, on a device that can get lost. So by default the
// worker stores NOTHING. Offline already exists: `mem viewer` writes a
// file to take along. Whoever wants the page cached turns it on on
// purpose with CHEAP_MEM_SERVE_OFFLINE=1 — a trade-off, not a default.
//
// The icons come from `icon.mark()` (the C with its graph) — one
// drawing, never a second one for the home screen.
import * as icon from './icon.mjs';

/** The dashboard's dark ground — the same value as the page's `--bg`. */
export const THEME_DARK = '#080f10';
export const THEME_LIGHT = '#f3f5ed';

// The icons travel as data: URIs INSIDE the manifest instead of living
// under paths of their own. The reason is the server's invisible
// principle: everything without a valid token gets a bare 404. Icon
// paths of their own would either 404 too (then the icon is missing) or
// be public (then they reveal that something is here).
export function manifest({ title = 'cheap-mem', short = 'mem' } = {}) {
  const url = (size, maskable) => `data:image/png;base64,${icon.mark(size, { maskable, dark: true }).toString('base64')}`;
  return {
    name: title,
    short_name: short,
    description: 'Your memory: entries, topics, links, experience, facts.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: THEME_DARK,
    theme_color: THEME_DARK,
    icons: [
      { src: url(192, false), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: url(512, false), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: url(512, true), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

/**
 * Without `offline` the worker is deliberately almost empty: it exists
 * so the page is installable, and passes every request through
 * untouched. Nothing of your memory lands in Cache Storage.
 *
 * With `offline` it keeps the last successfully loaded page and shows it
 * when the network is gone — network first, cache as the fallback, never
 * the other way round, so a stale state never hides a reachable one.
 */
export function serviceWorker({ offline = false } = {}) {
  const head = `// cheap-mem — generated, not maintained by hand. See src/pwa.mjs.
const BUCKET = 'cheap-mem-v1';
`;
  if (!offline) {
    return `${head}
// Offline is OFF (CHEAP_MEM_SERVE_OFFLINE is not 1). The worker exists
// only so the page is installable, and stores nothing: the content is
// private, and a phone can get lost. Whoever needs the view without a
// network takes the file from \`mem viewer\` along.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((k) => Promise.all(k.map((n) => caches.delete(n)))).then(() => self.clients.claim())
));
`;
  }
  return `${head}
// Offline is ON (CHEAP_MEM_SERVE_OFFLINE=1). The last loaded page lives
// on the device — with everything in it. Switched on deliberately, not
// the default.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys()
    .then((k) => Promise.all(k.filter((n) => n !== BUCKET).map((n) => caches.delete(n))))
    .then(() => self.clients.claim())
));
self.addEventListener('fetch', (e) => {
  const q = e.request;
  // The page itself only. Nothing else is intercepted.
  if (q.method !== 'GET' || q.mode !== 'navigate') return;
  e.respondWith(
    // Network first: an old state must never hide a reachable one.
    fetch(q).then((answer) => {
      // Only a real page is stored: never a redirect (e.g. to /login for
      // lack of a session) nor the sign-in page itself — otherwise someone
      // offline later gets a page that was not meant for them.
      if (answer && answer.ok && !answer.redirected && !answer.url.replace(/^[a-z]+:\\/\\/[^\\/]+/, '').startsWith('/login')) {
        const copy = answer.clone();
        caches.open(BUCKET).then((c) => c.put('/', copy));
      }
      return answer;
    }).catch(() => caches.match('/').then((t) => t || new Response(
      '<!doctype html><meta charset=utf-8><title>no network</title>' +
      "<style>body{font:15px 'DM Sans',system-ui,sans-serif;margin:40px;color:#51695a}</style>" +
      '<p>No network, and no state is stored on this device yet.</p>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } }
    )))
  );
});
`;
}

/**
 * Insert the shell into the finished page. String work instead of a
 * switch in the page builder: the page knows nothing about a server.
 *
 * **Without `</head>` NOTHING happens here, and that must not be
 * silent.** `String.replace` without a hit returns the text unchanged —
 * the page goes out, looks right and has no shell. So this throws: a
 * 500 with a reason beats a page nobody can tell is missing something.
 */
export function insertHead(html) {
  const head = `
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="mem">
<link rel="apple-touch-icon" href="data:image/png;base64,${icon.mark(180, { dark: true }).toString('base64')}">
<meta name="theme-color" content="${THEME_LIGHT}" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="${THEME_DARK}" media="(prefers-color-scheme: dark)">
<style>
  /* As an installed app the page runs under the notch and over the
     swipe bar. Without this the header sticks under the clock. The
     same rules as the sibling's shell, value for value — they also set
     the page's side padding, so the two houses line up to the pixel. */
  @supports (padding:max(0px)){
    header .bar{ padding-left:max(20px,env(safe-area-inset-left));
                 padding-right:max(20px,env(safe-area-inset-right)) }
    main{ padding-left:max(20px,env(safe-area-inset-left));
          padding-right:max(20px,env(safe-area-inset-right));
          padding-bottom:max(80px,calc(60px + env(safe-area-inset-bottom))) }
  }
  @media (display-mode:standalone){
    header{ padding-top:env(safe-area-inset-top) }
  }
</style>
<script src="/dashboard/sw-register.js"></script>`;
  // viewport-fit=cover is the condition for env(safe-area-*) to be
  // anything other than 0.
  const withEdge = html.replace(
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">',
  );
  if (!withEdge.includes('</head>')) {
    throw new Error('insertHead: no </head> — the shell would have been dropped silently.');
  }
  return withEdge.replace('</head>', `${head}\n</head>`);
}

/**
 * The registration, as a file of its own rather than an inline script:
 * the dashboard's content-security-policy is `script-src 'self'`, and an
 * inline script would need an exception for exactly one line.
 */
export const REGISTER_SCRIPT = `// cheap-mem — registers the service worker. See src/pwa.mjs.
// The worker is the condition for "installable". If registration fails
// that is not a failure of the page — it keeps working as a bookmark.
if ('serviceWorker' in navigator) {
  addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
`;

// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// dashboard-page.mjs — the dashboard's page shell, and nothing else.
//
// **Why this file exists.** The owner decided on 2026-09-28 that both
// houses share ONE UI: the sibling's Dashboard-Muster-3, functionally
// and visually identical, in English here, with cheap-mem's own mark and
// an empty store on a fresh install. This module is that page's shell —
// sidebar, top bar, scope bar, dialogs — word for word the sibling's,
// translated. The views are built in the browser by
// `assets/dashboard/dashboard.js` from `/dashboard.json`
// (`src/dashboard-data.mjs`); the stylesheet is
// `assets/dashboard/dashboard.css`; three.js r180 and DM Sans are
// vendored under `assets/` — everything from this server, no CDN, no
// outside request (probes: test/dashboard-page.test.mjs).
//
// **Named `dashboard-page.mjs`, not `dashboard.mjs`.** `src/dashboard.mjs`
// already exists: the old desk's data collector, which this page's data
// layer still calls. Two files of one name would be two truths waiting
// to be confused (port spec §5, package F).
//
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as icon from './icon.mjs';

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The paths of this page — ONE list, read by the server. */
export const PATHS = Object.freeze({
  page: '/dashboard',
  data: '/dashboard.json',
  entry: '/dashboard/entry.json',
  message: '/dashboard/message.json',
  // The retrieval probe — read-only, POST (question in the body) or GET
  // (?question=). Host-guarded like every data route here.
  probe: '/dashboard/probe.json',
  // The bitemporal comparison (knowledge/facts) — read-only GET,
  // ?known=YYYY-MM-DD&valid=YYYY-MM-DD.
  factsAt: '/dashboard/facts-at.json',
  // tempo (2026-09-28): heavy lists the overview does not need arrive on
  // their own (?part=raw|inbox) — from the SAME build as /dashboard.json
  // (bin/mem-serve, `DEFERRED_PARTS`).
  part: '/dashboard/part.json',
  // The project package export (#sources/export, parity with the sibling house
  // 2026-10-01): read-only GET, ?project=&global=1|0&history=1|0[&preview=1].
  // src/projectpackage.mjs.
  projectPackage: '/dashboard/project-package.json',
  // The skill catalogue (src/skillcatalog.mjs, parity with lucky-mem
  // 2026-10-01): read-only GET. A status is written only through /task
  // (kind `skill-status`), never here.
  skills: '/dashboard/skills.json',
  css: '/dashboard/app.css',
  script: '/dashboard/app.js',
  three: '/dashboard/three.js',
  swRegister: '/dashboard/sw-register.js',
});

/** Where the shipped files live (relative to the package root). */
export const FILES = Object.freeze({
  [PATHS.css]: { file: 'assets/dashboard/dashboard.css', type: 'text/css; charset=utf-8' },
  [PATHS.script]: { file: 'assets/dashboard/dashboard.js', type: 'text/javascript; charset=utf-8' },
  [PATHS.three]: { file: 'assets/three/three-r180.min.js', type: 'text/javascript; charset=utf-8' },
});

/** The two font files, same subsets as the sibling. */
export const FONTS = Object.freeze([
  Object.freeze({
    path: '/fonts/dm-sans-latin.woff2',
    file: 'assets/fonts/dm-sans-latin.woff2',
    range: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, '
      + 'U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, '
      + 'U+2215, U+FEFF, U+FFFD',
  }),
  Object.freeze({
    path: '/fonts/dm-sans-latin-ext.woff2',
    file: 'assets/fonts/dm-sans-latin-ext.woff2',
    range: 'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, '
      + 'U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, '
      + 'U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF',
  }),
]);

/**
 * **The version mark of a shipped file (tempo, 2026-09-28).** The first
 * 12 hex digits of the sha256 of its content. The page appends it as
 * `?v=` to the stylesheet and the scripts; the server answers a request
 * with the MATCHING mark as `immutable` (a year), every other with
 * `no-cache` and an ETag. A browser thus fetches a file again only when
 * its content really changed — before, `no-cache` came WITHOUT an ETag,
 * so every load paid the full script and stylesheet. Remembered per
 * size+mtime so not every page hashes the files again. `null` when the
 * file is missing.
 */
const versionMemo = new Map(); // path -> { key, version }
export function version(p) {
  const f = FILES[p];
  if (!f) return null;
  const full = path.join(PACKAGE_ROOT, f.file);
  let st;
  try { st = fs.statSync(full); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const old = versionMemo.get(p);
  if (old?.key === key) return old.version;
  let v;
  try { v = createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 12); } catch { return null; }
  versionMemo.set(p, { key, version: v });
  return v;
}

/** The path of a file WITH its version mark (without, when it is unreadable). */
export function pathWithVersion(p) {
  const v = version(p);
  return v ? `${p}?v=${v}` : p;
}

/** The page title — one per house. */
export const TITLE = 'cheap-mem · Your knowledge, connected.';

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/**
 * The font: the same two files as the sibling, with the mockup's weight
 * range (100–1000). The mockup uses in-between weights like 350/450/550/
 * 650, which the variable font carries; with `400 700` they would be
 * rounded to the edges.
 */
export function fontCss() {
  return FONTS.map((f) => '@font-face{font-family:"DM Sans";font-style:normal;'
    + `font-weight:100 1000;font-display:swap;src:url(${f.path}) format("woff2");`
    + `unicode-range:${f.range}}`).join('\n');
}

/** Initials for the workspace tile and the avatar: from the name, never invented. */
export function initials(name) {
  const parts = String(name ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!parts.length) return '··';
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * The page. `writesAllowed` sits as a data attribute on `<body>` so the
 * script knows before the data arrives whether it may offer forms — the
 * server still refuses every write on its own (`writegate.refusal()`);
 * the attribute is only the display.
 *
 * `workspace` comes from `.mem/config.json` (its `name`, and the
 * participant marked human) — never a name written into this code.
 */
export function asHtml({ title = 'cheap-mem', writesAllowed = false, workspace = {}, loginEnabled = false, tempoTestMs = null } = {}) {
  const space = workspace.name || 'this memory';
  const person = workspace.human || null;
  const markLink = icon.markLink(64);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101917"><title>${h(TITLE)}</title>
${markLink}
<!-- DM Sans: SIL Open Font License 1.1, Copyright 2014 The DM Sans Project Authors (assets/fonts/OFL.txt) -->
<style>
${fontCss()}
</style>
<link rel="stylesheet" href="${h(pathWithVersion(PATHS.css))}">
</head><body data-writes="${writesAllowed ? '1' : '0'}" data-login="${loginEnabled ? '1' : '0'}" data-title="${h(title)}"${tempoTestMs ? ` data-tempo-test-ms="${h(String(tempoTestMs))}"` : ''}>
<div class="shell"><aside class="sidebar"><div class="brand">${icon.markSvg()}<div>cheap<span style="font-weight:350">mem</span><small>YOUR KNOWLEDGE. CONNECTED.</small></div></div><div class="workspace"><span class="logo">${h(initials(space))}</span><div><strong>${h(space)}</strong><div class="small quiet">Personal memory</div></div></div><div class="label" style="padding-left:12px">Workspace</div><nav id="nav" class="nav"></nav><div class="side-note">Memories become<br>connections.</div><footer><nav class="sidebar-nav" aria-label="Other pages"><span class="label">Other pages</span><a href="#work/inbox" title="every recipient's messages, read and acknowledge"><span class="sidebar-glyph" aria-hidden="true">✉</span>Inbox</a></nav><div class="person"><span class="avatar">${h(person ? initials(person) : '··')}</span><div><strong class="small">${h(person || 'No human configured')}</strong><small>Dashboard server</small></div></div><div style="margin-top:18px" class="demo live" id="liveMark">○ CONNECTING …</div></footer></aside>
<div class="content"><header class="topbar"><button class="iconbtn mobile-toggle" id="mobileMenu" aria-label="Open navigation" aria-expanded="false">☰</button><div class="crumb"><span>Workspace</span><span>/</span><span id="crumb">Overview</span></div><div class="top-actions"><span class="demo live" id="dataMark">LIVE DATA</span><button class="btn ghost" id="newDataMark" data-action="new-data" hidden>New data · refresh</button><button class="btn ghost" data-action="search" aria-label="Global search"><span class="searchhint">Find knowledge</span><span>⌕</span><kbd class="kbd">Ctrl K</kbd></button><button class="iconbtn global-motion" data-action="motion" aria-label="Toggle all animations" title="Pause / resume all animations">Ⅱ</button><button class="iconbtn" data-action="theme" aria-label="Light or dark colour scheme">◐</button><button class="btn primary" data-action="new">+ Entry</button></div></header>
<main><div class="scopebar"><select id="memoryScope" aria-label="Memory"><option value="local">cheap-mem</option></select><select id="projectScope" aria-label="Project"><option value="all">All projects</option></select><span class="badge" id="stateMark"><span class="dot"></span> Loading state</span><span class="right small quiet" id="versionMark">—</span></div><div id="screen"><div class="loading"><span class="loading-core" aria-hidden="true"></span><p>Reading the memory …</p></div></div><footer class="footnote"><span id="footLeft">cheap-mem · content live from this memory.</span><span id="footRight">Reading changes nothing. Writing only through the existing routes and their gates.</span></footer></main></div></div>
<dialog id="detail" class="drawer" aria-labelledby="detailTitle"></dialog><dialog id="editor" class="modal" aria-labelledby="editorTitle"></dialog><dialog id="command" class="modal" aria-labelledby="commandTitle"><header><h2 id="commandTitle">Find knowledge &amp; routes</h2><button class="iconbtn" data-close="command" aria-label="Close search">✕</button></header><input class="field" id="commandInput" placeholder="Entry, message, capture or view …" aria-label="Search term"><div class="small quiet" style="margin-top:10px">Searches the chosen memory and project.</div><div id="commandResults" class="commandresults"></div></dialog><dialog id="info" class="modal" aria-labelledby="infoTitle"></dialog><div class="toast" id="toast" role="status" hidden></div>
<script src="${h(pathWithVersion(PATHS.three))}"></script>
<script src="${h(pathWithVersion(PATHS.script))}"></script>
</body></html>`;
}

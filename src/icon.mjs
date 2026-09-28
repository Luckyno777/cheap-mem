// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// icon.mjs — the mark, drawn in code.
//
// **Why an encoder and not a file.** The mark has to be a PNG: iOS accepts
// nothing else for apple-touch-icon, and install prompts want 192 and 512.
// Checking binaries into a repo whose whole pitch is "no dependencies, one
// file" is the wrong trade for four rectangles — and a committed PNG drifts
// from the palette the moment the palette moves. So the icon is drawn from
// the same tokens as the page, at whatever size is asked for. node:zlib is
// built in; the rest is CRC and a header.
//
// **Where the rest of the PWA lives.** A manifest and a service worker need
// a real origin — a service worker cannot even be registered from file:// —
// so the installable shell belongs with a HOST, not with the generated
// file: `src/pwa.mjs`, served by `bin/mem-serve` (since 2026-09-28). The
// mark itself lives here, in both renderings (PNG and inline SVG).

import zlib from 'node:zlib';

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An RGBA pixel buffer (4 bytes per pixel) as a PNG. */
export function pngFromRgba(rgba, width, height) {
  // Each row gets a leading filter byte 0 ("none"). Filters pay off on
  // photographs; on flat colour the compressor handles it alone.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // 8 bits per channel
  ihdr[9] = 6;   // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const rgb = (hex) => [
  parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
];

/**
 * The geometry of the mark, in a 1240 × 1240 field — ONE place, read by
 * both the PNG below and the inline SVG the dashboard draws
 * (`markSvg()`), so the two can never become two drawings.
 *
 * The C (a stroke with round caps: a top bar, a half circle, a bottom
 * bar) holding a three-node graph. The graph's three nodes and two
 * edges sit exactly where the sibling house puts them beside its L —
 * the owner's rule of 2026-09-27: "we only turn the mark from a C into
 * an L". The C is this house's; the graph is the shared idea.
 */
export const GEOMETRY = Object.freeze({
  field: 1240,
  c: Object.freeze({ x0: 975, x1: 550, yTop: 290, yBottom: 966, r: 338, width: 160 }),
  edges: Object.freeze([[470, 730, 690, 545], [690, 545, 910, 730]]),
  edgeWidth: 78,
  nodes: Object.freeze([[690, 545, 104], [470, 730, 88], [910, 730, 88]]),
});

/** The C's path, for SVG. */
export function cPath() {
  const { x0, x1, yTop, yBottom, r } = GEOMETRY.c;
  return `M${x0} ${yTop} H${x1} A${r} ${r} 0 0 0 ${x1} ${yBottom} H${x0}`;
}

/**
 * The mark as inline SVG, coloured by the page's own tokens
 * (`var(--text)` for the C, `var(--accent)` for the graph) — the
 * dashboard's sidebar draws it this way, like the sibling draws its L.
 */
export function markSvg({ cls = 'mark', label = 'cheap-mem' } = {}) {
  const g = GEOMETRY;
  const edges = `M${g.edges[0][0]} ${g.edges[0][1]} L${g.edges[0][2]} ${g.edges[0][3]} L${g.edges[1][2]} ${g.edges[1][3]}`;
  return `<svg class="${cls}" viewBox="0 0 ${g.field} ${g.field}" aria-label="${label}" role="img" fill="none">`
    + `<path d="${cPath()}" stroke="var(--text)" stroke-width="${g.c.width}" stroke-linecap="round" stroke-linejoin="round"/>`
    + `<path d="${edges}" stroke="var(--accent)" stroke-width="${g.edgeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`
    + g.nodes.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--accent)"/>`).join('')
    + '</svg>';
}

/** Distance from (px,py) to the segment (ax,ay)-(bx,by). */
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax; const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from a point to the C's centre line (two bars and the left half circle). */
function cDist(px, py) {
  const { x0, x1, yTop, yBottom, r } = GEOMETRY.c;
  const cy = (yTop + yBottom) / 2;
  const top = segDist(px, py, x1, yTop, x0, yTop);
  const bottom = segDist(px, py, x1, yBottom, x0, yBottom);
  // The arc is the LEFT half of the circle around (x1, cy).
  const arc = px <= x1
    ? Math.abs(Math.hypot(px - x1, py - cy) - r)
    : Math.min(Math.hypot(px - x1, py - yTop), Math.hypot(px - x1, py - yBottom));
  return Math.min(top, bottom, arc);
}

/**
 * The mark as a PNG — the same C and graph as `markSvg()`, in pixels.
 *
 * **Why this second rendering exists at all.** The manifest, the
 * apple-touch-icon and `/favicon.ico` cannot be an SVG with CSS
 * variables: a phone stores the image long before any page with a
 * palette is loaded. So the colours are burnt in here — from the brand's
 * two palettes (docs/assets/brand/logo-for-*-background.png).
 *
 * `maskable` fills the whole canvas (Android cuts its own shape out of
 * it) and pulls the content into the safe zone; otherwise a rounded
 * square with transparent corners is drawn. Every edge is anti-aliased
 * over one pixel from the exact distance, so the mark stays a C at 48 px.
 */
export function mark(size, { maskable = false, dark = false } = {}) {
  const n = size;
  const rgba = Buffer.alloc(n * n * 4);
  const ground = rgb(dark ? '#101917' : '#FAF9F6');
  const ink = rgb(dark ? '#F3F0E8' : '#192A2B');
  const accent = rgb(dark ? '#4EDBA6' : '#2FB888');
  const radius = maskable ? 0 : n * 0.22;
  const s = maskable ? 0.74 : 0.86;              // content scale inside the tile
  const unit = GEOMETRY.field / (n * s);         // field units per pixel
  const off = (GEOMETRY.field - GEOMETRY.field / s) / 2;

  const blend = (i, c, a) => {
    rgba[i] = Math.round(rgba[i] * (1 - a) + c[0] * a);
    rgba[i + 1] = Math.round(rgba[i + 1] * (1 - a) + c[1] * a);
    rgba[i + 2] = Math.round(rgba[i + 2] * (1 - a) + c[2] * a);
  };
  const cover = (dist, half) => Math.max(0, Math.min(1, (half - dist) / unit + 0.5));

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (radius > 0) {
        const dx = Math.max(radius - x - 0.5, x + 0.5 - (n - radius), 0);
        const dy = Math.max(radius - y - 0.5, y + 0.5 - (n - radius), 0);
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      const i = (y * n + x) * 4;
      rgba[i] = ground[0]; rgba[i + 1] = ground[1]; rgba[i + 2] = ground[2]; rgba[i + 3] = 255;
      const fx = off + (x + 0.5) * unit;
      const fy = off + (y + 0.5) * unit;
      const aC = cover(cDist(fx, fy), GEOMETRY.c.width / 2);
      if (aC > 0) blend(i, ink, aC);
      let dG = Infinity;
      for (const [ax, ay, bx, by] of GEOMETRY.edges) dG = Math.min(dG, segDist(fx, fy, ax, ay, bx, by) - GEOMETRY.edgeWidth / 2);
      for (const [cx, cy, r] of GEOMETRY.nodes) dG = Math.min(dG, Math.hypot(fx - cx, fy - cy) - r);
      const aG = cover(dG, 0);
      if (aG > 0) blend(i, accent, aG);
    }
  }
  return pngFromRgba(rgba, n, n);
}

/**
 * The mark as a ready `<link rel="icon">`, image and all.
 *
 * Without one, every browser asks for `/favicon.ico`: against the generated
 * file that goes nowhere, and against a host it is a 404 in the console —
 * and either way the tab stays blank. As a data: URI it is not a network
 * request, so the one-file promise is untouched.
 */
export function markLink(size = 64) {
  return `<link rel="icon" type="image/png" href="data:image/png;base64,${mark(size).toString('base64')}">`;
}

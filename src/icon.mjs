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
// file. cheap-mem does not ship one yet (lucky-mem does, in
// bin/mem-ansicht-server.mjs). Until it does, only the mark lives here, and
// the viewer uses it for the browser tab.

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
 * The mark.
 *
 * Not invented — lifted from the page. The vertical stroke is the trail
 * spine (`.trail`, 2px of --rule), which in the viewer stands wherever
 * something has a history. Beside it, three lines getting shorter: an entry
 * and what came before it. At 48px exactly that survives — a spine and
 * three lines.
 *
 * `maskable` fills the whole canvas (Android cuts its own shape out of it)
 * and pulls the content into the safe zone; otherwise a rounded square with
 * transparent corners is drawn.
 */
export function mark(size, { maskable = false, dark = false } = {}) {
  const n = size;
  const rgba = Buffer.alloc(n * n * 4);
  const ground = rgb(dark ? '#141716' : '#FAF9F6');
  const ink = rgb(dark ? '#E7EAE6' : '#1A1C1B');
  const accent = rgb(dark ? '#7FC3D4' : '#1F5E70');
  const radius = maskable ? 0 : n * 0.22;

  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    const i = (y * n + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
  };

  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      if (radius > 0) {
        const dx = Math.max(radius - x - 0.5, x + 0.5 - (n - radius), 0);
        const dy = Math.max(radius - y - 0.5, y + 0.5 - (n - radius), 0);
        if (dx * dx + dy * dy > radius * radius) continue;
      }
      put(x, y, ground);
    }
  }

  // Content sits tighter in the maskable version, so nothing is lost when
  // the shape is cropped.
  const s = maskable ? 0.74 : 1;
  const m = (v) => Math.round(n / 2 + (v - 0.5) * n * s);
  const bar = (x0, y0, x1, y1, c) => {
    for (let y = m(y0); y < m(y1); y += 1) for (let x = m(x0); x < m(x1); x += 1) put(x, y, c);
  };

  bar(0.255, 0.27, 0.305, 0.73, accent);   // the trail spine
  bar(0.37, 0.30, 0.76, 0.365, ink);       // the current entry
  bar(0.37, 0.4675, 0.68, 0.5325, ink);    // what came before
  bar(0.37, 0.635, 0.60, 0.70, ink);       // and before that
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

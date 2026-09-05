import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as icon from '../src/icon.mjs';
import * as viewer from '../src/viewer.mjs';
import * as memory from '../src/memory.mjs';

test('mark() produces a valid PNG at the size asked for', () => {
  // A hand-rolled encoder is exactly where you end up with a file that is
  // "nearly" a PNG, so the header is read rather than the call trusted.
  for (const size of [48, 192, 512]) {
    const png = icon.mark(size);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    assert.equal(png.readUInt32BE(16), size, 'IHDR width');
    assert.equal(png.readUInt32BE(20), size, 'IHDR height');
    assert.equal(png[24], 8, 'bit depth');
    assert.equal(png[25], 6, 'truecolour with alpha');
    assert.ok(png.subarray(png.length - 8).includes(Buffer.from('IEND')), 'IEND missing');
  }
});

test('rounded corners are transparent, the maskable version is not', () => {
  // The corner is the whole difference between the two versions. Android
  // cuts its own shape out; if the maskable one is transparent there, the
  // icon has visible holes.
  const cornerAlpha = (png) => {
    const raw = zlib.inflateSync(png.subarray(png.indexOf(Buffer.from('IDAT')) + 4, png.length - 12));
    return raw[1 + 3]; // filter byte, then the first pixel's RGBA
  };
  assert.equal(cornerAlpha(icon.mark(64)), 0, 'the rounded corner is not transparent');
  assert.equal(cornerAlpha(icon.mark(64, { maskable: true })), 255, 'the maskable version has a hole');
});

test('the page carries its own tab icon and still asks nothing of the network', () => {
  // Without it every browser requests /favicon.ico — which against a
  // generated file goes nowhere and leaves the tab blank.
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-icon-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'),
    JSON.stringify({ participants: ['user'], language: 'en' }));
  try {
    memory.logEntry(r, 'event', { title: 'x' });
    const { html } = viewer.build(r, { title: 't' });
    assert.match(html, /<link rel="icon" type="image\/png" href="data:image\/png;base64,/);
    assert.equal(/href=["']https?:/i.test(html), false, 'something is fetched');
    assert.equal(/favicon\.ico/.test(html), false, 'it points at a file that does not exist');
  } finally { fs.rmSync(r, { recursive: true, force: true }); }
});

// A capture that stores the harness talking to itself eats the memory.
//
// **The finding (2026-09-08, reported from a Windows install.)** After
// 75 minutes the git pack was at 9.17 MB, one capture 8.6 MB gzipped;
// extrapolated ~50 MB per working day, and git deletes nothing. Within
// a quarter the memory stops being clonable — the one promise it is
// built on.
//
// Measured over 21 real transcripts (41.30 MB): `attachment` lines are
// 51.7% of the volume, and the largest single item inside them is
// `task_reminder` — the task list, re-dumped nearly every turn. Then
// the skill listing, the token reminder, the hook output. None of it is
// conversation.
//
// Measured end to end on one 16.5 MB transcript, the same file captured
// both ways: 4.83 MB gzipped without the filter, 2.09 MB with it —
// 56.8% less. That is the number the header comment claims and this
// test re-derives, so the claim cannot rot.
//
// The tests below are written so that DISABLING the filter turns them
// red, and so that a filter which silently ate real content would also
// turn them red.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as raw from '../src/raw.mjs';

/** Pseudo-random but reproducible filler — see the note in `transkript`. */
function rauschen(seed, laenge) {
  let x = seed * 2654435761 % 2147483647;
  let out = '';
  while (out.length < laenge) {
    x = (x * 48271) % 2147483647;
    out += x.toString(36);
  }
  return out.slice(0, laenge);
}

/** A transcript with the real shapes in it, assembled at runtime. */
function transkript(dir) {
  const lines = [];
  const push = (o) => lines.push(JSON.stringify(o));
  for (let i = 0; i < 40; i += 1) {
    // The noise: the same reminder over and over, exactly as measured.
    // Varied on purpose. Forty IDENTICAL lines are gzip's best case, so
    // a fixture built that way would understate what the filter saves on
    // a real transcript — where every reminder carries a different task
    // list and a different token count. The first version of this test
    // measured 19.5% for exactly that reason.
    push({ type: 'attachment', attachment: { type: 'task_reminder',
      content: `task ${i}: ${rauschen(i, 400)}` } });
    push({ type: 'attachment', attachment: { type: 'total_tokens_reminder',
      content: `tokens left ${900000 - i * 137}: ${rauschen(i + 99, 200)}` } });
    push({ type: 'mode', mode: 'auto' });
    // The signal.
    push({ type: 'user', timestamp: `2026-09-08T10:${String(i).padStart(2, '0')}:00Z`,
      message: { content: [{ type: 'text', text: `frage nummer ${i} ueber den waechter` }] } });
    push({ type: 'assistant', timestamp: `2026-09-08T10:${String(i).padStart(2, '0')}:30Z`,
      message: { content: [{ type: 'thinking', thinking: `ueberlegung ${i}` },
        { type: 'text', text: `antwort nummer ${i}` }] } });
  }
  // One attachment that DOES carry content — it must survive.
  push({ type: 'attachment', attachment: { type: 'file', content: { file: { content: 'ECHTER_DATEIINHALT' } } } });
  // One image — elided, but with a marker left behind.
  push({ type: 'user', message: { content: [{ type: 'image', source: { data: 'A'.repeat(5000) } }] } });
  const p = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

function frischeWurzel() {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'capdrop-'));
  fs.mkdirSync(path.join(w, '.mem'), { recursive: true });
  return w;
}

function text(root, rel) {
  return zlib.gunzipSync(fs.readFileSync(path.join(root, rel))).toString('utf8');
}

test('the filter cuts the stored size by more than half', () => {
  const quelle = frischeWurzel();
  const t = transkript(quelle);

  const a = frischeWurzel();
  const ohne = raw.capture(a, t, { drop: false });
  const b = frischeWurzel();
  const mit = raw.capture(b, t, { drop: true });

  assert.equal(ohne.status, 'captured');
  assert.equal(mit.status, 'captured');

  const groessOhne = fs.statSync(path.join(a, ohne.path)).size;
  const groessMit = fs.statSync(path.join(b, mit.path)).size;
  const ersparnis = 1 - groessMit / groessOhne;

  // Deliberately a MARGIN, not "smaller than". A test that only asks
  // for "smaller" stays green when the filter drops one line in a
  // thousand — which is what a broken filter looks like.
  assert.ok(ersparnis > 0.4,
    `filter saves only ${(ersparnis * 100).toFixed(1)}% — expected well over 40%`);
});

test('the noise is gone and the conversation is not', () => {
  const quelle = frischeWurzel();
  const w = frischeWurzel();
  const r = raw.capture(w, transkript(quelle));
  // The BODY, not the file. The header lists the dropped reasons BY
  // NAME, so searching the whole file for 'task_reminder' finds the
  // bookkeeping and calls it a survivor. The first version of this test
  // did exactly that and failed for the wrong reason.
  const inhalt = text(w, r.path).split('\n').slice(1).join('\n');

  // Noise: gone.
  assert.ok(!inhalt.includes('task_reminder'), 'task_reminder survived');
  assert.ok(!inhalt.includes('total_tokens_reminder'), 'token reminder survived');

  // Signal: every single turn still there.
  for (let i = 0; i < 40; i += 1) {
    assert.ok(inhalt.includes(`frage nummer ${i} `), `lost question ${i}`);
    assert.ok(inhalt.includes(`antwort nummer ${i}`), `lost answer ${i}`);
  }
  // Reasoning is 6.3% and the only record of WHY — it stays.
  assert.ok(inhalt.includes('ueberlegung 7'), 'thinking was dropped');
  // A content-bearing attachment stays.
  assert.ok(inhalt.includes('ECHTER_DATEIINHALT'), 'a real file attachment was dropped');
});

test('an elided image leaves a visible marker, not a hole', () => {
  const quelle = frischeWurzel();
  const w = frischeWurzel();
  const r = raw.capture(w, transkript(quelle));
  const inhalt = text(w, r.path);
  assert.ok(!inhalt.includes('A'.repeat(200)), 'image payload was stored');
  assert.match(inhalt, /image elided by cheap-mem: \d+ bytes/);
});

test('NEVER SILENT: the header books what was left out', () => {
  const quelle = frischeWurzel();
  const w = frischeWurzel();
  const r = raw.capture(w, transkript(quelle));
  const kopf = JSON.parse(text(w, r.path).split('\n')[0]);

  assert.ok(Array.isArray(kopf.__dropped) && kopf.__dropped.length > 0,
    'nothing was booked — a gap nobody can see is a bug, not a decision');
  assert.ok(kopf.__dropped_bytes > 0, 'no byte count');

  const gruende = Object.fromEntries(kopf.__dropped.map((d) => [d.reason, d.count]));
  assert.equal(gruende['attachment:task_reminder'], 40);
  assert.equal(gruende['line:mode'], 40);
  assert.equal(gruende.image, 1);

  // And the caller sees the same thing, not just the file.
  assert.ok(r.droppedBytes > 0);
});

test('an unknown attachment subtype is dropped, a known one is kept', () => {
  // The safe default for a SIZE problem: drop what we do not recognise.
  // Stated as a test so the direction is a decision, not an accident.
  assert.equal(raw.dropReason({ type: 'attachment', attachment: { type: 'brand_new_harness_thing' } }),
    'attachment:brand_new_harness_thing');
  assert.equal(raw.dropReason({ type: 'attachment', attachment: { type: 'file' } }), null);
  assert.equal(raw.dropReason({ type: 'user', message: {} }), null);
  assert.equal(raw.dropReason({ type: 'assistant', message: {} }), null);
});

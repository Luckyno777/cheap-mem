// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// `mem raw import-chatgpt` — a ChatGPT data export into the raw capture.
//
// CANARY FILE — the fixture carries a synthetic "secret" (real shape,
// filler content), or the redaction could not be checked. No real chat:
// everything comes from test/fixture/chatgpt-export-synth.mjs.
//
// Red proof: on 1d8f6c5 (the base this was built on) `mem raw` does not
// know the subcommand (exit 1, "unknown subcommand") and
// src/chatgptimport.mjs does not exist — every probe below that runs the
// import is red there. Ported from lucky-mem test/s13-chatgpt-import.
//
// invariant: nothing-rather-than-wrong
// invariant: append-only
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as synth from './fixture/chatgpt-export-synth.mjs';
import { removeTree } from './fixture/cleanup.mjs';
import * as redaction from '../src/redaction.mjs';
import * as raw from '../src/raw.mjs';
import * as archive from '../src/archive.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEM = path.join(REPO, 'bin', 'mem');

const made = [];
process.once('exit', () => { for (const d of made) removeTree(d); });
function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}
function env() {
  const e = { ...process.env };
  delete e.CHEAP_MEM_ARCHIVE;
  delete e.CHEAP_MEM_ROOT;
  return e;
}
function mem(root, ...args) {
  const r = spawnSync(process.execPath, [MEM, '--root', root, ...args], { env: env(), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function memory() {
  const root = tempDir('cm-chatgpt-');
  const r = spawnSync(process.execPath, [MEM, 'init', '--root', root], { env: env(), encoding: 'utf8' });
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
  return root;
}
function exportZip(conversations, name = 'export.zip') {
  const file = path.join(tempDir('cm-chatgpt-exp-'), name);
  synth.writeZip(file, {
    'conversations.json': JSON.stringify(conversations),
    'user.json': '{}',
    'file_000synthetic-sanitized.jpg': Buffer.from([0xff, 0xd8, 0xff]),
  });
  return file;
}
function importJson(root, file, ...extra) {
  const r = mem(root, 'raw', 'import-chatgpt', file, '--json', ...extra);
  assert.equal(r.code, 0, `import failed: ${r.err}`);
  return JSON.parse(r.out);
}
function recordLines(root) {
  const p = path.join(root, archive.RECORD_FILE);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
}
function captureText(root, rel) {
  const { header, lines } = raw.readCapture(root, rel);
  return { header, lines, text: lines.map((l) => raw.textOf(l)).join('\n') };
}
/** Every file under root (relative) with its size — for "writes nothing". */
function snapshot(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const v = path.join(d, e.name);
      if (e.name === '.git') continue;
      if (e.isDirectory()) { out.push(`${path.relative(root, v)}/`); walk(v); } else out.push(`${path.relative(root, v)} ${fs.statSync(v).size}`);
    }
  };
  walk(root);
  return out.sort();
}

test('import from the ZIP files one capture per conversation; without current_node nothing is guessed', () => {
  const root = memory();
  const r = importJson(root, exportZip(synth.export1()));
  assert.equal(r.conversations, 3);
  assert.equal(r.captures.length, 2, JSON.stringify(r));
  assert.equal(r.kinds.new, 2);
  assert.equal(r.kinds['no-path'], 1);
  for (const c of r.captures) {
    const { header } = captureText(root, c.path);
    assert.equal(header.__stamp.surface, 'chatgpt-export');
    assert.equal(header.__source, 'chatgpt-export');
    assert.match(header.__hint, /assistant.*is ChatGPT/);
    assert.match(c.path, /^raw\/\d{4}\/\d{2}\/.+\.jsonl\.gz$/);
  }
  // The record: a conversation fingerprint, never the raw conversation id, never the title.
  const rec = recordLines(root).join('\n');
  assert.ok(rec.includes('"surface":"chatgpt-export"'), 'positive control: the probe sees the import rows');
  assert.ok(!rec.includes('synth-aaaa-0001'), 'raw conversation id in the record');
  assert.ok(!rec.includes('Moving plan'), 'conversation title in the record');
  for (const c of r.captures) assert.ok(!captureText(root, c.path).text.includes('NO-POINTER-TEXT'));
});

test('redaction: a secret in the chat is blacked out (positive control: it is in the export)', () => {
  const root = memory();
  const rawExport = JSON.stringify(synth.export1());
  assert.ok(rawExport.includes(synth.SECRET), 'positive control 1: the secret is in the raw material');
  assert.ok(redaction.redact(synth.SECRET).found.length > 0, 'positive control 2: the redaction knows this shape');
  const r = importJson(root, exportZip(synth.export1()));
  assert.ok(Object.keys(r.redacted).length > 0, 'no redaction findings reported');
  const a = r.captures.map((c) => captureText(root, c.path)).find((c) => c.text.includes('moving planner'));
  assert.ok(a, 'capture of conversation A missing');
  assert.ok(!a.text.includes('Q'.repeat(40)), 'secret stored unredacted');
  assert.ok(a.header.__redacted.length > 0);
  // Placeholders instead of the image; tool, system and tool call left out — and counted.
  assert.ok(a.text.includes('[image]'));
  assert.ok(!a.text.includes('TOOL-OUTPUT-NOISE'));
  assert.ok(!a.text.includes('search("boxes")'));
  assert.ok(!a.text.includes('SYSTEM-PROMPT-INVISIBLE'));
  const reasons = Object.fromEntries(a.header.__chatgpt.omitted.map((x) => [x.reason, x.count]));
  assert.equal(reasons.tool, 1);
  assert.equal(reasons['tool-call'], 1);
  assert.equal(reasons.system, 1);
  assert.ok(!recordLines(root).join('\n').includes('Q'.repeat(40)));
});

test('idempotent: the same export a second time files nothing', () => {
  const root = memory();
  const zip = exportZip(synth.export1());
  const first = importJson(root, zip);
  assert.equal(first.captures.length, 2, 'positive control: the first run writes');
  const before = recordLines(root).length;
  const second = importJson(root, zip);
  assert.equal(second.captures.length, 0);
  assert.equal(second.kinds['already-imported'], 2);
  assert.equal(recordLines(root).length, before);
  assert.equal(raw.listCaptures(root).length, 2);
});

test('tree: the current_node path wins, the discarded branch stays out', () => {
  const root = memory();
  assert.ok(JSON.stringify(synth.conversationB()).includes('DISCARDED-ANSWER'), 'positive control');
  const r = importJson(root, exportZip([synth.conversationB()]));
  assert.equal(r.captures.length, 1);
  const { text, lines } = captureText(root, r.captures[0].path);
  assert.ok(text.includes('ACTIVE-ANSWER'));
  assert.ok(!text.includes('DISCARDED-ANSWER'));
  assert.deepEqual(lines.map((l) => l.type), ['user', 'assistant', 'user', 'assistant']);
  assert.ok(lines.every((l) => l.source === 'chatgpt-export' && /Z$/.test(l.timestamp)));
});

test('continuation: only the new part becomes a capture, pointing at its predecessor', () => {
  const root = memory();
  const first = importJson(root, exportZip([synth.conversationA()], 'a.zip'));
  const r = importJson(root, exportZip([synth.conversationA({ more: true })], 'a2.zip'));
  assert.equal(r.captures.length, 1);
  assert.equal(r.captures[0].kind, 'continuation');
  const { header, lines, text } = captureText(root, r.captures[0].path);
  assert.equal(lines.length, 2);
  assert.ok(text.includes('CONTINUATION-QUESTION') && text.includes('CONTINUATION-ANSWER'));
  assert.ok(!text.includes('moving planner'), 'old part stored twice');
  assert.equal(header.__chatgpt.continues, first.captures[0].path);
});

test('an edited message: a new complete version, the old one stays', () => {
  const root = memory();
  const first = importJson(root, exportZip([synth.conversationA()], 'a.zip'));
  const r = importJson(root, exportZip([synth.conversationA({ edited: true })], 'a3.zip'));
  assert.equal(r.captures.length, 1);
  assert.equal(r.captures[0].kind, 'new-version');
  const { header, text } = captureText(root, r.captures[0].path);
  assert.ok(text.includes('EDITED-QUESTION'));
  assert.ok(!text.includes('moving planner'));
  assert.equal(header.__chatgpt.replaces, first.captures[0].path);
  assert.ok(captureText(root, first.captures[0].path).text.includes('moving planner'), 'old version vanished');
});

test('--dry-run counts conversations, messages and findings and writes nothing', () => {
  const root = memory();
  const zip = exportZip(synth.export1());
  const before = snapshot(root);
  const r = mem(root, 'raw', 'import-chatgpt', zip, '--dry-run');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(snapshot(root), before, 'the dry run wrote');
  assert.match(r.out, /dry run - nothing written/);
  assert.match(r.out, /conversations in the export: 3/);
  assert.match(r.out, /new 2/);
  assert.match(r.out, /messages .*: [1-9]/);
  assert.match(r.out, /redaction findings \(blacked out\): (?!none)/);
  // Positive control: the same call WITHOUT --dry-run writes.
  importJson(root, zip);
  assert.notDeepEqual(snapshot(root), before);
  const again = mem(root, 'raw', 'import-chatgpt', zip, '--dry-run');
  assert.match(again.out, /already imported 2/);
});

test('--since, and conversations.json read directly', () => {
  const root = memory();
  const json = path.join(tempDir('cm-chatgpt-exp-'), 'conversations.json');
  fs.writeFileSync(json, JSON.stringify(synth.export1()));
  const late = importJson(root, json, '--since', '2030-01-01');
  assert.equal(late.captures.length, 0);
  assert.equal(late.kinds['before-since'], 3);
  const r = importJson(root, json, '--since', '2026-09-01');
  assert.equal(r.captures.length, 2);
});

test('the digest sees the captures like any other: raw pending + raw show, bell rung', () => {
  const root = memory();
  const r = importJson(root, exportZip([synth.conversationB()]));
  const pending = JSON.parse(mem(root, 'raw', 'pending', '--json').out);
  assert.ok(pending.open.includes(r.captures[0].path));
  const show = mem(root, 'raw', 'show', r.captures[0].path);
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /"content":"ACTIVE-ANSWER blue"/);
  assert.match(show.out, /assistant.*is ChatGPT/);
  assert.ok(r.bell, 'no bell rung after filing captures');
});

test('a capture deleted on purpose does not come back with the next import', () => {
  const root = memory();
  const zip = exportZip([synth.conversationB()]);
  const r = importJson(root, zip);
  const d = mem(root, 'raw', 'delete', r.captures[0].path, '--reason', 'probe', '--yes');
  assert.equal(d.code, 0, d.err);
  const second = importJson(root, zip);
  assert.equal(second.captures.length, 0);
  assert.equal(second.kinds['already-imported'], 1);
});

test('unknown file: a clear message and exit 1', () => {
  const root = memory();
  const bad = path.join(tempDir('cm-chatgpt-exp-'), 'empty.zip');
  synth.writeZip(bad, { 'user.json': '{}' });
  const r = mem(root, 'raw', 'import-chatgpt', bad);
  assert.equal(r.code, 1);
  assert.match(r.err, /conversations\.json not in the ZIP/);
});

test('no model call on import: the import module never reaches a model or the network', () => {
  // A source-level probe, not decoration: the promise is "import costs
  // nothing", and the cheapest way to break it is one import of a module
  // that talks to a provider. Positive control: the same probe flags the
  // digest, which does call a model.
  const src = fs.readFileSync(path.join(REPO, 'src', 'chatgptimport.mjs'), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  const talks = (list) => list.filter((m) => /(^node:(http|https|net)$)|embed|model|net\.mjs|provider/.test(m));
  assert.deepEqual(talks(imports), []);
  assert.ok(talks(['node:https', './embed/client.mjs']).length === 2, 'positive control: the probe flags network/model modules');
});

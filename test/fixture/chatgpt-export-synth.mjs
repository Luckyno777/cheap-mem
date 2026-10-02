// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
/**
 * A synthetic ChatGPT data export for the import probes — NOT a real chat.
 *
 * Shape after the community schema (github.com/xuy/docs-for-agents,
 * ChatGPT_export_schema.md) and Help Center article 7260999: a list of
 * conversations with id/title/create_time/update_time/mapping/current_node;
 * nodes {id, message|null, parent, children}; a message with author.role,
 * content {content_type, parts}, create_time, weight, recipient, metadata.
 * Mirrors the sibling house's test/fixture/chatgpt-export-synth.mjs.
 *
 * CANARY FILE — the "secret" in conversation A is assembled at runtime
 * from pieces (synthetic filler), so the redaction can be checked without
 * a real-looking token sitting in the source.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export const T0 = 1790000000; // 2026-09-21, Unix seconds

/** Synthetic provider key: real shape, filler content. */
export const SECRET = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');

function node(id, parent, children, message) {
  return { id, message, parent, children };
}
function msg(id, role, text, dt, extra = {}) {
  return {
    id, author: { role, name: null, metadata: {} },
    create_time: T0 + dt, update_time: null,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully', end_turn: true, weight: 1.0,
    metadata: {}, recipient: 'all', channel: null, ...extra,
  };
}

/**
 * Conversation A: linear, with a secret, a hidden system node, an image,
 * a tool call and a tool answer. `more` appends messages (continuation);
 * `edited` replaces the first user question by a sibling branch (an edit
 * in the ChatGPT UI -> a different branch).
 */
export function conversationA({ more = false, edited = false } = {}) {
  const m = {
    'a-root': node('a-root', null, ['a-sys'], null),
    'a-sys': node('a-sys', 'a-root', ['a-u1'], {
      ...msg('a-sys', 'system', 'SYSTEM-PROMPT-INVISIBLE', 0),
      weight: 0.0, metadata: { is_visually_hidden_from_conversation: true },
    }),
    'a-u1': node('a-u1', 'a-sys', ['a-a1'], {
      ...msg('a-u1', 'user', '', 10),
      content: { content_type: 'multimodal_text', parts: [
        { content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_000synthetic', size_bytes: 10, width: 1, height: 1 },
        `My key for the moving planner is ${SECRET} - please remember it.`,
      ] },
    }),
    'a-a1': node('a-a1', 'a-u1', ['a-tool-call'], msg('a-a1', 'assistant', 'Do not share that key. Moving planner: count the boxes.', 20)),
    'a-tool-call': node('a-tool-call', 'a-a1', ['a-tool'], msg('a-tool-call', 'assistant', 'search("boxes")', 21, { recipient: 'browser' })),
    'a-tool': node('a-tool', 'a-tool-call', ['a-a2'], msg('a-tool', 'tool', 'TOOL-OUTPUT-NOISE', 22)),
    'a-a2': node('a-a2', 'a-tool', [], msg('a-a2', 'assistant', 'For two rooms plan on thirty boxes.', 30)),
  };
  let current = 'a-a2';
  let update = T0 + 30;
  if (more) {
    m['a-a2'].children = ['a-u3'];
    m['a-u3'] = node('a-u3', 'a-a2', ['a-a3'], msg('a-u3', 'user', 'And for three rooms? CONTINUATION-QUESTION', 100));
    m['a-a3'] = node('a-a3', 'a-u3', [], msg('a-a3', 'assistant', 'About forty-five boxes. CONTINUATION-ANSWER', 110));
    current = 'a-a3';
    update = T0 + 110;
  }
  if (edited) {
    m['a-sys'].children = ['a-u1', 'a-u1b'];
    m['a-u1b'] = node('a-u1b', 'a-sys', ['a-a1b'], msg('a-u1b', 'user', 'How many boxes for one room? EDITED-QUESTION', 200));
    m['a-a1b'] = node('a-a1b', 'a-u1b', [], msg('a-a1b', 'assistant', 'About fifteen. ANSWER-TO-EDIT', 210));
    current = 'a-a1b';
    update = T0 + 210;
  }
  return {
    id: 'synth-aaaa-0001', conversation_id: 'synth-aaaa-0001', title: 'Moving plan (synthetic)',
    create_time: T0, update_time: update, mapping: m, current_node: current,
  };
}

/** Conversation B: branched — two answers to the same question, the second is active. */
export function conversationB() {
  const m = {
    'b-root': node('b-root', null, ['b-u1'], null),
    'b-u1': node('b-u1', 'b-root', ['b-a1-old', 'b-a1-new'], msg('b-u1', 'user', 'Which colour for the bike?', 5)),
    'b-a1-old': node('b-a1-old', 'b-u1', [], msg('b-a1-old', 'assistant', 'DISCARDED-ANSWER red', 6)),
    'b-a1-new': node('b-a1-new', 'b-u1', ['b-u2'], msg('b-a1-new', 'assistant', 'ACTIVE-ANSWER blue', 7)),
    'b-u2': node('b-u2', 'b-a1-new', ['b-a2'], msg('b-u2', 'user', 'Why blue?', 8)),
    'b-a2': node('b-a2', 'b-u2', [], msg('b-a2', 'assistant', 'Blue is harder to see at night, so add reflectors.', 9)),
  };
  return {
    id: 'synth-bbbb-0002', title: 'Bike colour (synthetic)',
    create_time: T0, update_time: T0 + 9, mapping: m, current_node: 'b-a2',
  };
}

/** Conversation C: no current_node — must not be guessed. */
export function conversationC() {
  return {
    id: 'synth-cccc-0003', title: 'no pointer', create_time: T0, update_time: T0 + 1,
    mapping: { 'c-root': node('c-root', null, ['c-u'], null),
      'c-u': node('c-u', 'c-root', [], msg('c-u', 'user', 'NO-POINTER-TEXT', 1)) },
  };
}

export function export1() { return [conversationA(), conversationB(), conversationC()]; }

// --- a minimal ZIP writer (deflate), for the probe only ---------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Write a ZIP holding `{name: Buffer|string}`. */
export function writeZip(file, entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt32LE(0, 10); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(packed.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(0, 12);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(packed.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    local.push(lh, n, packed);
    central.push(ch, n);
    offset += lh.length + n.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = Object.keys(entries).length;
  end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...local, cd, end]));
}

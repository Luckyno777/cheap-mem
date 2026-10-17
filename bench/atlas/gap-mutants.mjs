// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// bench/atlas/gap-mutants.mjs — for every new record of the gap groups (bench/atlas/bridge-gaps.mjs,
// bench/atlas/silent-errors-gaps.mjs): the mutant that removes ONE guarantee at its SHARED SOURCE and the records that
// must turn red because of it. Data only: no imports, so `bench/mutation.mjs` can read it for free.
//
// **Two readers, one table.**
//   - test/atlas-gaps-mutants-cm.test.mjs applies each mutant to a scratch copy of the tree, asks the group again and
//     checks: the listed `red` records read `fail`, the listed `green` records (the controls and what the mutant does not
//     touch) still read `pass`, the listed `unmeasured` records read `not-measured` (their control fell). That is the
//     red proof of a record AND the proof that the record's control is a control.
//   - `bench/mutation.mjs` lists every mutant with ONE edit in its catalogue (`catalogue()` below), so the anchors are
//     held by test/mutation-anchors.test.mjs (each anchor matches exactly once) and the sweep can run them against the
//     live suites. A mutant with two edits (a guarantee with a second layer behind it) lives here only: neither edit alone
//     turns its record red, and the sweep applies one edit at a time.
//
// **Why "the shared source".** The sister house learned it on the same records: four mutants did not turn their record
// red at first, because a second layer stood behind the one they removed (the card shelf also checks in the write core;
// a rank is stopped by the field list AND by a named lock; a type is locked in two places). A record that is only red when
// the FIRST layer goes measures one layer. The mutants below sit where every road runs through (the limits constant of
// the card rules, the nine-control mask, the one start rule of src/webauth.mjs), or take away both layers (`edits` with
// two entries).
//
// Fields: `id`; `group` (the function the test asks); `suite` (the live test file that holds the record green); `name`;
// `edits` (`{file, from, to}`, each `from` matches exactly once); `red`, `green`, `unmeasured` (record ids).

const raw = String.raw;

export const GAP_MUTANTS = Object.freeze([
  // --- A8: the SDK peer range ------------------------------------------------------------------------------------
  {
    id: 'sdk-peer-wide', group: 'sdk', suite: 'bridge',
    name: 'atlas bridge A8: the SDK peer range falls back to ^1.0.0',
    edits: [{
      file: 'package.json',
      from: '"@modelcontextprotocol/sdk": "^1.30.0",\n    "better-sqlite3": "^11.0.0",',
      to: '"@modelcontextprotocol/sdk": "^1.0.0",\n    "better-sqlite3": "^11.0.0",',
    }],
    red: ['bridge.sdk.range'], green: ['bridge.sdk.installed'], unmeasured: [],
  },
  {
    id: 'sdk-peer-future', group: 'sdk', suite: 'bridge',
    name: 'atlas bridge A8: the SDK peer range demands a major that is not installed',
    edits: [{
      file: 'package.json',
      from: '"@modelcontextprotocol/sdk": "^1.30.0",\n    "better-sqlite3": "^11.0.0",',
      to: '"@modelcontextprotocol/sdk": "^9.0.0",\n    "better-sqlite3": "^11.0.0",',
    }],
    red: ['bridge.sdk.range', 'bridge.sdk.installed'], green: [], unmeasured: [],
  },

  // --- A9: the nine bidi controls ---------------------------------------------------------------------------------
  {
    id: 'bidi-mask-off', group: 'bidi', suite: 'bridge',
    name: 'atlas bridge A9: bidi.visible() hands every control back unchanged',
    edits: [{
      file: 'src/bidi.mjs',
      from: "  return text.replace(pattern('g'), (ch) => {",
      to: "  return text.replace(pattern('g'), (ch) => {\n    if (ch) return ch;",
    }],
    red: ['bridge.bidi.exits', 'bridge.bidi.structured', 'bridge.bidi.roundtrip', 'bridge.bidi.all-nine'],
    green: ['bridge.bidi.world', 'bridge.bidi.clean'], unmeasured: [],
  },
  {
    id: 'bidi-no-isolates', group: 'bidi', suite: 'bridge',
    name: 'atlas bridge A9: the mask misses the four isolate controls U+2066..U+2069',
    edits: [{
      file: 'src/bidi.mjs',
      from: raw`const RANGE = '\\u202A-\\u202E\\u2066-\\u2069';`,
      to: raw`const RANGE = '\\u202A-\\u202E';`,
    }],
    red: ['bridge.bidi.exits', 'bridge.bidi.structured', 'bridge.bidi.roundtrip', 'bridge.bidi.all-nine'],
    green: ['bridge.bidi.world', 'bridge.bidi.clean'], unmeasured: [],
  },
  {
    id: 'bidi-mask-too-wide', group: 'bidi', suite: 'bridge',
    name: 'atlas bridge A9: the mask takes the direction marks and all Arabic and Hebrew letters too',
    edits: [{
      file: 'src/bidi.mjs',
      from: raw`const RANGE = '\\u202A-\\u202E\\u2066-\\u2069';`,
      to: raw`const RANGE = '\\u202A-\\u202E\\u2066-\\u2069\\u200E\\u200F\\u0590-\\u06FF';`,
    }],
    red: ['bridge.bidi.clean'], green: ['bridge.bidi.world', 'bridge.bidi.exits', 'bridge.bidi.all-nine'], unmeasured: [],
  },

  // --- H11: the decision card over the bridge ------------------------------------------------------------------
  {
    id: 'card-control-off', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the card kind is not among the fields the bridge carries',
    edits: [{
      file: 'src/bridgefields.mjs',
      from: "const CARD = Object.freeze([...CARD_PROSE_FIELDS, 'card_kind']);",
      to: 'const CARD = Object.freeze([...CARD_PROSE_FIELDS]);',
    }],
    red: ['bridge.card.control'], green: [],
    unmeasured: ['bridge.card.limits-edge', 'bridge.card.limits', 'bridge.card.shape', 'bridge.card.rank', 'bridge.card.person-stage1', 'bridge.card.person-stage2'],
  },
  {
    id: 'card-limits-off', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the limits of the card rules are ten times as large',
    edits: [{
      file: 'src/cardrules.mjs',
      from: 'question: 160, context: 320, advice: 200, choice: 80, effect: 240, evidence: 160, optionsMax: 6, evidenceMax: 8,',
      to: 'question: 1600, context: 3200, advice: 2000, choice: 800, effect: 2400, evidence: 160, optionsMax: 60, evidenceMax: 80,',
    }],
    red: ['bridge.card.limits'], green: ['bridge.card.control', 'bridge.card.limits-edge', 'bridge.card.shape'], unmeasured: [],
  },
  {
    id: 'card-limits-tight', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the question limit of the card rules is 100, not 160',
    edits: [{
      file: 'src/cardrules.mjs',
      from: 'question: 160, context: 320, advice: 200,',
      to: 'question: 100, context: 320, advice: 200,',
    }],
    red: ['bridge.card.limits-edge'], green: ['bridge.card.control', 'bridge.card.limits', 'bridge.card.shape'], unmeasured: [],
  },
  {
    id: 'card-fields-open', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: every type may carry the card fields over the bridge',
    edits: [{
      file: 'src/bridgefields.mjs',
      from: 'Object.freeze([...COMMON, ...own, ...COUNTERPART_IDS])])));',
      to: 'Object.freeze([...COMMON, ...own, ...CARD, ...COUNTERPART_IDS])])));',
    }],
    red: ['bridge.card.shape'], green: ['bridge.card.control', 'bridge.card.limits', 'bridge.card.limits-edge'], unmeasured: [],
  },
  {
    id: 'card-field-shape-off', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the shape check of the mem_log fields does not refuse',
    edits: [{
      file: 'src/bridgefields.mjs',
      from: "    throw new Error(`Wrong shape over the bridge: ${bad.join(', ')} — nothing was written.`);",
      to: '    void bad;',
    }],
    red: ['bridge.card.shape'], green: ['bridge.card.control', 'bridge.card.limits', 'bridge.card.limits-edge'], unmeasured: [],
  },
  {
    id: 'card-kind-open', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the card kinds include "hear"',
    edits: [{
      file: 'src/cardrules.mjs',
      from: "export const KINDS = Object.freeze(['decide', 'approve', 'do-it']);",
      to: "export const KINDS = Object.freeze(['decide', 'approve', 'do-it', 'hear']);",
    }],
    red: ['bridge.card.shape'], green: ['bridge.card.control', 'bridge.card.limits-edge'], unmeasured: [],
  },
  {
    id: 'card-decline-open', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: "Maybe" counts as a No / not-now option',
    edits: [{
      file: 'src/cardrules.mjs',
      from: '(no|not|nothing|never|',
      to: '(no|not|maybe|nothing|never|',
    }],
    red: ['bridge.card.shape'], green: ['bridge.card.control', 'bridge.card.limits-edge'], unmeasured: [],
  },
  {
    id: 'card-target-unchecked', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: a card for an entry that does not exist is taken',
    edits: [{
      file: 'src/memory.mjs',
      from: "      if (!e) errors.push(`no entry with id '${target}' — nobody reads a card without a target`);",
      to: '      if (!e) { /* MUTANT: a missing target is no error */ }',
    }],
    red: ['bridge.card.shape'], green: ['bridge.card.control', 'bridge.card.limits', 'bridge.card.limits-edge'], unmeasured: [],
  },
  {
    id: 'card-rank-claim', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the bridge lets a claimed tier "user" stand',
    edits: [{
      file: 'bin/mem-mcp',
      from: "const BRIDGE_MAX_AUTHORITY = 'agent';",
      to: "const BRIDGE_MAX_AUTHORITY = 'user';",
    }],
    red: ['bridge.card.rank'], green: ['bridge.card.control', 'bridge.card.limits', 'bridge.card.shape'], unmeasured: [],
  },
  {
    id: 'card-rank-fields-open', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the bridge field list lets every field through',
    edits: [{
      file: 'src/bridgefields.mjs',
      from: '    if (WRITE_PATH_OWNS.includes(k) || allowed.includes(k)) continue;',
      to: '    continue;',
    }],
    red: ['bridge.card.rank', 'bridge.card.shape'], green: ['bridge.card.control', 'bridge.card.limits'], unmeasured: [],
  },
  {
    id: 'card-person-displaced', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: on the card shelf the younger card wins whatever its tier',
    edits: [{
      file: 'src/decisioncard.mjs',
      from: '  if (ra !== rb) return ra < rb;',
      to: '  if (false) return ra < rb;',
    }],
    red: ['bridge.card.rank'], green: ['bridge.card.control', 'bridge.card.limits'], unmeasured: [],
  },
  {
    id: 'card-person-rule-route', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: the card rule does not apply on the route "mcp"',
    edits: [{
      file: 'src/cardrule.mjs',
      from: "export const ROUTES = Object.freeze(['cli', 'mcp', 'task']);",
      to: "export const ROUTES = Object.freeze(['cli', 'task']);",
    }],
    red: ['bridge.card.person-stage1', 'bridge.card.person-stage2'], green: ['bridge.card.control', 'bridge.card.rank'], unmeasured: [],
  },
  {
    id: 'card-reject-switch-off', group: 'card', suite: 'bridge',
    name: 'atlas bridge H11: CHEAP_MEM_CARD_REJECT never refuses',
    edits: [{
      file: 'src/cardrule.mjs',
      from: '    reject: !has && sw.on, fallbackQuestion: has ? null : shown.question,',
      to: '    reject: false, fallbackQuestion: has ? null : shown.question,',
    }],
    red: ['bridge.card.person-stage2'], green: ['bridge.card.control', 'bridge.card.person-stage1'], unmeasured: [],
  },

  // --- A14: the HTTP doors ----------------------------------------------------------------------------------------
  {
    id: 'http-start-without-token', group: 'http', suite: 'http',
    name: 'atlas bridge A14: a start with no token and no switch is allowed',
    edits: [{ file: 'src/webauth.mjs', from: '  if (!localNoToken) {', to: '  if (false) {' }],
    red: ['bridge.http-token.start-refused', 'bridge.http-token.dashboard'],
    green: ['bridge.http-token.start-control', 'bridge.http-token.accepted', 'bridge.http-token.rejected'], unmeasured: [],
  },
  {
    id: 'http-public-bind-open', group: 'http', suite: 'http',
    name: 'atlas bridge A14: a bind to any address is allowed without a token',
    edits: [{ file: 'src/webauth.mjs', from: '  if (isLoopback(host)) return { ok: true };', to: '  return { ok: true };' }],
    red: ['bridge.http-token.start-refused', 'bridge.http-token.dashboard'],
    green: ['bridge.http-token.start-control', 'bridge.http-token.accepted', 'bridge.http-token.rejected'], unmeasured: [],
  },
  {
    id: 'http-any-token', group: 'http', suite: 'http',
    name: 'atlas bridge A14: any bearer token is accepted',
    edits: [{
      file: 'src/webauth.mjs',
      from: '  if (given && constantEqual(token, given)) return { allowed: true, setCookie: true };',
      to: '  if (given) return { allowed: true, setCookie: true };',
    }],
    red: ['bridge.http-token.rejected'], green: ['bridge.http-token.start-control', 'bridge.http-token.accepted', 'bridge.http-token.start-refused'], unmeasured: [],
  },
  {
    id: 'http-token-never-accepted', group: 'http', suite: 'http',
    name: 'atlas bridge A14: the right bearer token is not accepted either',
    edits: [{
      file: 'src/webauth.mjs',
      from: '  if (given && constantEqual(token, given)) return { allowed: true, setCookie: true };',
      to: '  if (false) return { allowed: true, setCookie: true };',
    }],
    red: ['bridge.http-token.accepted'], green: ['bridge.http-token.start-control', 'bridge.http-token.start-refused'],
    unmeasured: ['bridge.http-token.rejected'],
  },
  {
    id: 'http-start-never', group: 'http', suite: 'http',
    name: 'atlas bridge A14: a start with a token or a login is refused',
    edits: [{
      file: 'src/webauth.mjs',
      from: '  if (token || login) return { ok: true, withoutToken: false };',
      to: "  if (token || login) return { ok: false, reason: 'MUTANT' };",
    }],
    red: ['bridge.http-token.start-control'], green: [],
    unmeasured: ['bridge.http-token.start-refused', 'bridge.http-token.accepted', 'bridge.http-token.rejected', 'bridge.http-token.local-switch', 'bridge.http-token.read-only-default', 'bridge.http-token.dashboard'],
  },
  {
    id: 'http-login-not-counted', group: 'http', suite: 'http',
    name: 'atlas bridge A14: the dashboard login does not count as a credential',
    edits: [{
      file: 'src/webauth.mjs',
      from: '  if (token || login) return { ok: true, withoutToken: false };',
      to: '  if (token) return { ok: true, withoutToken: false };',
    }],
    red: ['bridge.http-token.dashboard'], green: ['bridge.http-token.start-control', 'bridge.http-token.start-refused', 'bridge.http-token.rejected'], unmeasured: [],
  },
  {
    id: 'http-proxy-header-local', group: 'http', suite: 'http',
    name: 'atlas bridge A14: a request with a proxy header counts as local',
    edits: [{ file: 'src/webauth.mjs', from: '  return !hasProxyHeader(req);', to: '  return true;' }],
    red: ['bridge.http-token.local-switch'], green: ['bridge.http-token.start-control', 'bridge.http-token.accepted', 'bridge.http-token.rejected'], unmeasured: [],
  },
  {
    id: 'http-host-open', group: 'http', suite: 'http',
    name: 'atlas bridge A14: any Host is allowed',
    edits: [{ file: 'src/webauth.mjs', from: '  return /^(127\\.0\\.0\\.1|localhost|\\[::1\\]|::1)(:\\d+)?$/.test(h);', to: '  return true;' }],
    red: ['bridge.http-token.local-switch'], green: ['bridge.http-token.start-control', 'bridge.http-token.accepted', 'bridge.http-token.rejected'], unmeasured: [],
  },
  {
    id: 'http-origin-open', group: 'http', suite: 'http',
    name: 'atlas bridge A14: any Origin is allowed',
    edits: [{ file: 'src/webauth.mjs', from: '  return Boolean(host) && from.host === String(host);', to: '  return true;' }],
    red: ['bridge.http-token.local-switch'], green: ['bridge.http-token.start-control', 'bridge.http-token.accepted', 'bridge.http-token.rejected'], unmeasured: [],
  },
  {
    id: 'http-profile-full', group: 'http', suite: 'http',
    name: 'atlas bridge A14: the HTTP bridge offers the full tool profile by default',
    edits: [{
      file: 'bin/mem-mcp',
      from: 'const PROFILE = HTTP_MODE && process.env.CHEAP_MEM_MCP_READONLY === undefined',
      to: 'const PROFILE = false && process.env.CHEAP_MEM_MCP_READONLY === undefined',
    }],
    red: ['bridge.http-token.read-only-default'], green: ['bridge.http-token.start-control', 'bridge.http-token.accepted', 'bridge.http-token.rejected'], unmeasured: [],
  },
  {
    id: 'http-token-printed', group: 'http', suite: 'http',
    name: 'atlas bridge A14: the start line prints the token value',
    edits: [{
      file: 'bin/mem-mcp',
      from: "token=${cfg.token ? 'set' : 'none (plain loopback only; a request with a proxy header is refused)'}",
      to: "token=${cfg.token ? cfg.token : 'none (plain loopback only; a request with a proxy header is refused)'}",
    }],
    red: ['bridge.http-token.start-control'], green: [],
    unmeasured: ['bridge.http-token.start-refused', 'bridge.http-token.accepted', 'bridge.http-token.rejected', 'bridge.http-token.local-switch', 'bridge.http-token.read-only-default', 'bridge.http-token.dashboard'],
  },

  // --- silent-errors: the gap groups -----------------------------------------------------------------------------
  {
    id: 'vis-unreadable-as-missing', group: 'vis-states', suite: 'silent',
    name: 'atlas silent-errors E1: an unreadable visibility journal reads as missing',
    edits: [{
      file: 'src/mcpvisibility.mjs',
      from: "    return { rows: [], broken: 0, state: 'unreadable', reason: e?.code || 'read error' };",
      to: "    return { rows: [], broken: 0, state: 'missing', reason: null };",
    }],
    red: ['silent-errors.visibility.states'], green: [], unmeasured: [],
  },
  {
    id: 'vis-broken-as-empty', group: 'vis-states', suite: 'silent',
    name: 'atlas silent-errors E1: a journal with no usable line reads as empty',
    edits: [{
      file: 'src/mcpvisibility.mjs',
      from: "  const state = rows.length ? 'good' : (broken ? 'broken' : 'empty');",
      to: "  const state = rows.length ? 'good' : 'empty';",
    }],
    red: ['silent-errors.visibility.states'], green: [], unmeasured: [],
  },
  {
    id: 'vis-bridge-throws', group: 'vis-bridge', suite: 'silent',
    name: 'atlas silent-errors E1: a journal that cannot be written stops the tool call (both layers)',
    edits: [
      { file: 'src/mcpvisibility.mjs', from: '    return { written: false, reason: e?.message || String(e) };', to: '    throw e;' },
      { file: 'bin/mem-mcp', from: '  } catch { /* the journal is an observation, never a gate */ }', to: '  } catch (e) { throw e; }' },
    ],
    red: ['silent-errors.visibility.bridge-unreadable'], green: ['silent-errors.visibility.bridge-control'], unmeasured: [],
  },
  {
    id: 'vis-journal-not-written', group: 'vis-bridge', suite: 'silent',
    name: 'atlas silent-errors E1: the bridge writes no sighting to its journal',
    edits: [{
      file: 'bin/mem-mcp',
      from: '    if (client) mcpvisibility.record(resolveRoot(), { method, tool, client });',
      to: '    if (false) mcpvisibility.record(resolveRoot(), { method, tool, client });',
    }],
    red: ['silent-errors.visibility.bridge-control'], green: [], unmeasured: ['silent-errors.visibility.bridge-unreadable'],
  },
  {
    id: 'doctor-missing-error', group: 'doctor', suite: 'silent',
    name: 'atlas silent-errors E2: the doctor calls a memory without log files an error',
    edits: [{ file: 'src/doctor.mjs', from: "    yield finding('drawers', LEVEL.WARN, 'no log files yet',", to: "    yield finding('drawers', LEVEL.ERROR, 'no log files yet',", }],
    red: ['silent-errors.doctor.missing'], green: ['silent-errors.doctor.ok', 'silent-errors.doctor.empty', 'silent-errors.doctor.broken'], unmeasured: [],
  },
  {
    id: 'doctor-empty-error', group: 'doctor', suite: 'silent',
    name: 'atlas silent-errors E2: the doctor calls an empty drawer an error',
    edits: [{
      file: 'src/doctor.mjs',
      from: "  yield finding('drawers', LEVEL.GOOD, `${files.length} files, ${scan.lines} lines`);",
      to: "  yield finding('drawers', scan.lines === 0 ? LEVEL.ERROR : LEVEL.GOOD, `${files.length} files, ${scan.lines} lines`, 'MUTANT');",
    }],
    red: ['silent-errors.doctor.empty'], green: ['silent-errors.doctor.ok', 'silent-errors.doctor.missing', 'silent-errors.doctor.broken'], unmeasured: [],
  },
  {
    id: 'task-always-null', group: 'task', suite: 'silent',
    name: 'atlas silent-errors E3: the task block is never built',
    edits: [{
      file: 'src/subagenttask.mjs',
      from: '  if (!notice) return chosen.text ? {',
      to: '  if (!notice) return null; if (!notice) return chosen.text ? {',
    }],
    red: ['silent-errors.task-lane.real-control'], green: [], unmeasured: ['silent-errors.task-lane.real-unreadable'],
  },
  {
    id: 'doctor-broken-silent', group: 'doctor', suite: 'silent',
    name: 'atlas silent-errors E2: the doctor does not report an unparsable line in a drawer',
    edits: [{ file: 'src/doctor.mjs', from: '  if (scan.broken.length > 0) {\n    const first = scan.broken[0];', to: '  if (false) {\n    const first = scan.broken[0];' }],
    red: ['silent-errors.doctor.broken'], green: ['silent-errors.doctor.ok', 'silent-errors.doctor.missing', 'silent-errors.doctor.empty'], unmeasured: [],
  },
  {
    id: 'doctor-unreadable-as-not-json', group: 'doctor', suite: 'silent',
    name: 'atlas silent-errors E2: the doctor calls a drawer whose read failed an unparsable line',
    edits: [{
      file: 'src/integrity.mjs',
      from: "      catch (e) { broken.push({ file: f.rel, line: 0, why: `unreadable: ${e?.code ?? 'ERROR'} ${e?.message ?? e}` }); continue; }",
      to: "      catch (e) { broken.push({ file: f.rel, line: 0, why: 'not JSON' }); continue; }",
    }],
    red: ['silent-errors.doctor.unreadable'], green: ['silent-errors.doctor.ok', 'silent-errors.doctor.broken'], unmeasured: [],
  },
  {
    id: 'doctor-clean-drawer-error', group: 'doctor', suite: 'silent',
    name: 'atlas silent-errors E2: the doctor reports an error for a drawer that is fine',
    edits: [{
      file: 'src/doctor.mjs',
      from: "  yield finding('drawers', LEVEL.GOOD, `${files.length} files, ${scan.lines} lines`);",
      to: "  yield finding('drawers', LEVEL.ERROR, `${files.length} files, ${scan.lines} lines`, 'MUTANT');",
    }],
    red: ['silent-errors.doctor.ok'], green: [],
    unmeasured: ['silent-errors.doctor.missing', 'silent-errors.doctor.empty', 'silent-errors.doctor.broken', 'silent-errors.doctor.unreadable'],
  },
  {
    id: 'task-notice-empty', group: 'task', suite: 'silent',
    name: 'atlas silent-errors E3: the notice of a failed lane is an empty string',
    edits: [{
      file: 'src/subagenttask.mjs',
      from: 'export function failureNotice({ failed = [], late = false } = {}) {',
      to: "export function failureNotice({ failed = [], late = false } = {}) {\n  if (!late) return '';",
    }],
    red: ['silent-errors.task-lane.real-unreadable'], green: ['silent-errors.task-lane.real-control'], unmeasured: [],
  },
  {
    id: 'task-failed-lane-dropped', group: 'task', suite: 'silent',
    name: 'atlas silent-errors E3: a lookup that fails before the searches is not noted',
    edits: [{
      file: 'src/subagenttask.mjs',
      from: '  } catch { failed.push(...TYPES); /* the extra never stops the start - but its failure is told (E3) */ }',
      to: '  } catch { /* MUTANT: silent */ }',
    }],
    red: ['silent-errors.task-lane.real-unreadable'], green: ['silent-errors.task-lane.real-control'], unmeasured: [],
  },
  {
    id: 'duties-swallow-unreadable', group: 'surfaces', suite: 'silent',
    name: 'atlas silent-errors: a duties drawer whose read failed reads as no open duties (the CLI and the bridge)',
    edits: [{
      file: 'src/memory.mjs',
      from: "    const lines = memoRows ? null : withoutBom(fs.readFileSync(file, 'utf8')).split('\\n');",
      to: "    const lines = memoRows ? null : (() => { try { return withoutBom(fs.readFileSync(file, 'utf8')).split('\\n'); } catch { return []; } })();",
    }],
    red: ['silent-errors.cli-duties.unreadable', 'silent-errors.bridge-duties.unreadable'],
    green: ['silent-errors.cli-duties.ok', 'silent-errors.bridge-duties.ok', 'silent-errors.cli-duties.missing', 'silent-errors.bridge-duties.missing'], unmeasured: [],
  },
]);

/** The test file that holds the records of a suite green on the live tree. */
export const SUITE_FILES = Object.freeze({
  bridge: 'test/atlas-gaps-bridge-cm.test.mjs',
  http: 'test/atlas-gaps-http-cm.test.mjs',
  silent: 'test/atlas-gaps-silent-cm.test.mjs',
});

/** The mutants with exactly one edit, in the shape of the catalogue of bench/mutation.mjs. */
export function catalogue() {
  return GAP_MUTANTS.filter((m) => m.edits.length === 1).map((m) => ({
    name: m.name, file: m.edits[0].file, from: m.edits[0].from, to: m.edits[0].to, tests: [SUITE_FILES[m.suite]],
  }));
}

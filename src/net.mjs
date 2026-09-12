/**
 * The net — what points at what inside the memory.
 *
 * ## Why boxes from paths and arrows from declared links
 *
 * The obvious drawing would be a net of tag co-occurrence: two entries
 * sharing a tag get an edge. That is measurably the wrong basis. In
 * the sibling memory on 2026-09-11: tags give 2544 edges and 70 %
 * connectedness — not because the memory is that densely woven, but
 * because one project tag sits in almost every entry. A net where
 * everything connects to everything shows nothing.
 *
 * So the DECLARED links, and only those: `derived_from`, `replaces`,
 * `closes`, and the hand-drawn ones (`causes`, `generalises`,
 * `resolves`, `contradicts`). Every single one was written by someone.
 * That is the difference from one a similarity measure found.
 *
 * The BOXES are `project/drawer` — that stands in the path and is
 * therefore also a fact, not a clustering procedure.
 *
 * ## Deterministic, not simulated
 *
 * The layout is a pure function of the data. No physics, no forces, no
 * randomness: a drawing you cannot recognise between two visits is not
 * a map of anything — and it cannot be tested either. Sorting is by a
 * stable key, not by the read order of files.
 *
 * The vertical is DIRECTION: what points at other things stands on
 * top. `learnings -> errors` is the most common path in a real body of
 * entries, and it should look that way: the lesson on top, the error
 * below.
 */

/** The link kinds that count as declared. Closed list. */
export const LINK_KINDS = Object.freeze([
  'derived_from', 'replaces', 'closes',
  'causes', 'generalises', 'resolves', 'contradicts',
]);

/**
 * The declared links of an entry. Only fields someone wrote — nothing
 * is invented from similarity.
 */
export function linksOf(e) {
  const out = [];
  if (!e || !e.id) return out;
  const q = e.provenance && (e.provenance.derived_from ?? e.provenance.inferred_from);
  if (Array.isArray(q)) {
    for (const x of q) if (typeof x === 'string') out.push({ kind: 'derived_from', from: e.id, to: x });
  }
  if (e.replaces_id) out.push({ kind: 'replaces', from: e.id, to: String(e.replaces_id) });
  if (e.closes_id) out.push({ kind: 'closes', from: e.id, to: String(e.closes_id) });
  if (e.retires_id) out.push({ kind: 'closes', from: e.id, to: String(e.retires_id) });
  // Links from the links book carry kind/from/to themselves.
  if (e.kind && e.from && e.to && LINK_KINDS.includes(e.kind)) {
    out.push({ kind: e.kind, from: String(e.from), to: String(e.to) });
  }
  return out;
}

/**
 * Build the net.
 *
 * `readAll` yields `[{ project, drawer, entry }]`. A link whose target
 * is not in the body is NOT thrown away — it is counted as `dangling`.
 * Swallowing it quietly would be the most convenient gap: it is
 * exactly how you spot a correction pointing at a deleted entry.
 */
export function build({ readAll }) {
  const where = new Map();
  const entries = [];
  for (const { project, drawer, entry } of readAll()) {
    if (entry?.id) where.set(entry.id, { project: project ?? 'global', drawer });
    entries.push(entry);
  }
  const links = [];
  let dangling = 0;
  for (const e of entries) {
    for (const l of linksOf(e)) {
      if (!where.has(l.from) || !where.has(l.to)) { dangling += 1; continue; }
      links.push(l);
    }
  }
  const boxes = new Map();
  const boxOf = (o) => {
    const name = `${o.project}/${o.drawer}`;
    if (!boxes.has(name)) boxes.set(name, { name, project: o.project, drawer: o.drawer, entries: 0 });
    return boxes.get(name);
  };
  for (const o of where.values()) boxOf(o).entries += 1;

  const pairs = new Map();
  for (const l of links) {
    const a = where.get(l.from); const b = where.get(l.to);
    const from = `${a.project}/${a.drawer}`;
    const to = `${b.project}/${b.drawer}`;
    // JSON as the key so a box name with odd characters cannot be
    // confused with another pair.
    const k = JSON.stringify([from, to]);
    if (!pairs.has(k)) pairs.set(k, { from, to, count: 0, kinds: {} });
    const p = pairs.get(k);
    p.count += 1;
    p.kinds[l.kind] = (p.kinds[l.kind] ?? 0) + 1;
  }
  return {
    boxes: [...boxes.values()].sort((a, b) => a.name.localeCompare(b.name)),
    pairs: [...pairs.values()].sort((a, b) => b.count - a.count
      || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    links: links.length,
    dangling,
  };
}

/**
 * The layers — a pure function of the pairs.
 *
 * What points at others stands on top. Cycles (including the common
 * self-references like `duties -> duties`) are NOT resolved but
 * REPORTED: a map that quietly cuts a cycle shows a direction that
 * does not exist.
 */
export function layers({ boxes = [], pairs = [] }) {
  const names = boxes.map((b) => b.name);
  const out = new Map(names.map((n) => [n, new Set()]));
  const into = new Map(names.map((n) => [n, new Set()]));
  for (const p of pairs) {
    if (p.from === p.to) continue;
    if (!out.has(p.from) || !into.has(p.to)) continue;
    out.get(p.from).add(p.to);
    into.get(p.to).add(p.from);
  }
  // Kahn, but deterministic: ties broken by name.
  const degree = new Map(names.map((n) => [n, into.get(n).size]));
  const layer = new Map();
  let rest = [...names];
  let depth = 0;
  while (rest.length) {
    const nowReady = rest.filter((n) => degree.get(n) === 0).sort();
    if (!nowReady.length) break; // cycle — the rest stays unlayered.
    for (const n of nowReady) {
      layer.set(n, depth);
      for (const z of out.get(n)) degree.set(z, degree.get(z) - 1);
    }
    const gone = new Set(nowReady);
    rest = rest.filter((n) => !gone.has(n));
    depth += 1;
  }
  // A box with NO link at all does not stand on top of the hierarchy —
  // it does not hang on it. In the first drawing 22 of 40 boxes sat on
  // level 0 and thus looked like sources, though most were simply
  // unconnected. Reported separately.
  const unlinked = names.filter((n) => out.get(n).size === 0 && into.get(n).size === 0).sort();
  const lonely = new Set(unlinked);

  return {
    depth,
    assignment: [...layer.entries()]
      .filter(([name]) => !lonely.has(name))
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([name, level]) => ({ name, level })),
    unlinked,
    in_cycle: rest.sort(),
    self_reference: [...new Set(pairs.filter((p) => p.from === p.to).map((p) => p.from))].sort(),
  };
}

/** Human text — for the shell, not the console. */
export function asText(net) {
  const l = layers(net);
  const z = [];
  z.push(`Net: ${net.boxes.length} boxes, ${net.links} declared links, ${net.pairs.length} box pairs`);
  if (net.dangling) z.push(`  ${net.dangling} links point out of the body (target not found)`);
  z.push('');
  if (!l.assignment.length) z.push('  (no layered boxes — all in a cycle or unconnected)');
  for (const { name, level } of l.assignment) {
    const b = net.boxes.find((x) => x.name === name);
    z.push(`  ${'  '.repeat(level)}${name}  (${b?.entries ?? 0})`);
  }
  if (l.unlinked.length) {
    z.push('');
    z.push(`  without any declared link (${l.unlinked.length}): ${l.unlinked.join(', ')}`);
    z.push('  — not "on top", but unconnected. Links are missing here.');
  }
  if (l.in_cycle.length) {
    z.push('');
    z.push(`  in a cycle (not layered, not cut): ${l.in_cycle.join(', ')}`);
  }
  if (l.self_reference.length) z.push(`  self-reference: ${l.self_reference.join(', ')}`);
  z.push('');
  z.push('Most common paths:');
  for (const p of net.pairs.slice(0, 10)) {
    const kinds = Object.entries(p.kinds).map(([k, n]) => `${k} ${n}`).join(', ');
    z.push(`  ${String(p.count).padStart(3)}  ${p.from} -> ${p.to}   (${kinds})`);
  }
  return z.join('\n');
}

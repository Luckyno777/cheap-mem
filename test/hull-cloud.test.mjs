// test/hull-cloud.test.mjs — the network hull is ONE cloud around ALL
// nodes (task huelle-wolke, 2026-09-28; replaces the two-lobed oval).
//
// Measured on the GENERATED geometry, not on the source text: the hull
// code from assets/dashboard/dashboard.js runs with the real three.js r180
// vendored in the repo (geometry only, no GPU); the vertices of all hull
// meshes are evaluated.
//
// Three measures:
//   1. Enclosure: every node position (layout formulas from initGraph,
//      real graphModel groups) lies INSIDE the hull — star test from the
//      hull's centroid.
//   2. No waist and no fissure along the mid plane x=0:
//      waist = R(seam)/min(R(35 deg left), R(35 deg right)) >= 0.8
//      (catches two lobes), groove = R(seam)/mean(R(+-12 deg)) >= 0.9
//      (catches a fissure; a smooth sphere measures ~0.96 here).
//   3. ONE shape: all hull meshes (skin and halo) share THE SAME centre —
//      no lobes, no add-ons; no more draw calls than before.
//
// Red proof against the FIXED commit ddca89d (the two-lobed oval): the
// lobes show as a waist (0.40) and a groove (0.61), two meshes with
// different centres. (The oval was wide enough to enclose these layouts;
// the test reports that instead of pretending otherwise.) Positive controls: the measures catch an invented two-lobe
// shape (waist) and an invented node outside (enclosure).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FILE = path.join(ROOT, 'assets', 'dashboard', 'dashboard.js');
const OLD_STATE = 'ddca89d5430b7c2866a93788edd6fe14822af337';
const T = (() => {
  const ctx = { window: {}, self: {}, console, AbortController, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'assets', 'three', 'three-r180.min.js'), 'utf8'), ctx);
  return ctx.window.MemThree || ctx.window.LuckyThree;
})();

function between(q, from, to) {
  const a = q.indexOf(from), b = q.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `anchor not found: ${from} .. ${to}`);
  return q.slice(a, b);
}

// graphModel from the source, with plain stand-ins for its surroundings
// (edges play no part in the positions).
function graphModelFrom(q) {
  const src = between(q, 'function graphModel(', 'function graphCaption(');
   
  return new Function('allEdges', 'byId', 'neuralPalette', 'types', 'incomingIndex', 'trailCenter', `${src}\nreturn graphModel;`)(
    () => [], () => null, ['#a', '#b', '#c', '#d', '#e', '#f', '#g'], {}, new Map(), () => null,
  );
}
const graphModel = graphModelFrom(fs.readFileSync(FILE, 'utf8'));

function store(n, projects) {
  const kinds = ['decision', 'error', 'learning', 'thought', 'event'];
  return Array.from({ length: n }, (_, i) => ({ id: 'e' + i, project: projects[i % projects.length], type: kinds[i % kinds.length], tags: ['t' + (i % 4)] }));
}

// Node positions as in initGraph/createUnits (groups without cells:
// members on the group sphere; with cells: cell centres AND — for focus —
// the members of every leaf cell), plus the cores.
function nodes(model) {
  const p = [[0, -0.03, 0.02]];
  model.shards.forEach((s) => p.push([s.center.x, s.center.y, s.center.z]));
  const cells = (list) => list.forEach((c) => {
    p.push([c.center.x, c.center.y, c.center.z]);
    if (c.cells.length) cells(c.cells);
    else c.members.forEach((e, j) => {
      const n = c.members.length, y = 1 - (2 * (j + 0.5)) / n, a = j * 2.399963, q = Math.sqrt(1 - y * y);
      p.push([c.center.x + Math.cos(a) * q * c.radius, c.center.y + y * c.radius, c.center.z + Math.sin(a) * q * c.radius]);
    });
  });
  model.groups.forEach((g) => {
    if (g.cells.length) return cells(g.cells);
    const n = g.members.length;
    g.members.forEach((e, j) => {
      const y = 1 - (2 * (j + 0.5)) / n, a = j * 2.399963, r = g.radius * (0.7 + 0.3 * (((j * 17) % 13) / 13)), ring = Math.sqrt(1 - y * y);
      p.push([g.center.x + Math.cos(a) * ring * r, g.center.y + y * r, g.center.z + Math.sin(a) * ring * r]);
    });
  });
  return p;
}

// Runs hull code and collects what gets attached to `cortex`.
function collect(run) {
  const objects = [];
  const cortex = { add: (o) => objects.push(o) };
  const v = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z);
  run(cortex, v, (o) => o);
  const meshes = objects.filter((o) => o.isMesh);
  const vertices = [];
  for (const m of meshes) {
    const a = m.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) vertices.push([a.getX(i), a.getY(i), a.getZ(i)]);
  }
  const centres = meshes.map((m) => {
    const a = m.geometry.attributes.position, c = [0, 0, 0];
    for (let i = 0; i < a.count; i++) { c[0] += a.getX(i) / a.count; c[1] += a.getY(i) / a.count; c[2] += a.getZ(i) / a.count; }
    return c;
  });
  const spread = Math.max(0, ...centres.map((c) => Math.hypot(c[0] - centres[0][0], c[1] - centres[0][1], c[2] - centres[0][2])));
  return { objects, meshes, vertices, spread, drawCalls: objects.filter((o) => o.isMesh || o.isPoints || o.isLine).length };
}
const NEW_ANCHOR = '// --- The network hull: ONE cloud';
function newHull(model) {
  const src = between(fs.readFileSync(FILE, 'utf8'), NEW_ANCHOR, 'function initGraph() {');
   
  const build = new Function('T', 'cortex', 'v', 'own', 'model', 'clock', `${src}\nreturn buildHull(T, cortex, own, v, model, clock);`);
  return collect((cortex, v, own) => build(T, cortex, v, own, model, { uTime: { value: 0 }, uMotion: { value: 1 } }));
}
function oldHull() {
  const q = execFileSync('git', ['show', `${OLD_STATE}:assets/dashboard/dashboard.js`], { cwd: ROOT, encoding: 'utf8' });
  const src = between(q, 'function buildHull(T, cortex, own, v) {', 'function initGraph() {');
   
  const build = new Function('T', 'cortex', 'v', 'own', `${src}\nreturn buildHull(T, cortex, own, v);`);
  return collect((cortex, v, own) => build(T, cortex, v, own));
}

// --- Measures ----------------------------------------------------------------
const centroid = (vs) => [0, 1, 2].map((k) => vs.reduce((s, e) => s + e[k], 0) / vs.length);
/** Hull radius in direction d (unit vector): farthest vertex within a cone of ~6 degrees. */
function radius(vs, c, d, cone = 0.9945) {
  let r = 0;
  for (const e of vs) {
    const x = e[0] - c[0], y = e[1] - c[1], z = e[2] - c[2], l = Math.hypot(x, y, z);
    if (l > 0 && (x * d[0] + y * d[1] + z * d[2]) / l >= cone) r = Math.max(r, l);
  }
  return r;
}
/** Nodes outside the hull (star test from the centroid). */
function outside(vs, points) {
  const c = centroid(vs);
  return points.filter((p) => {
    const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2], l = Math.hypot(x, y, z);
    return l > 1e-9 && radius(vs, c, [x / l, y / l, z / l]) < l;
  });
}
/** Narrowest waist along the mid plane: R(seam) / min (or mean) of R at +-deg. */
function waist(vs, deg = 35, mean = false) {
  const c = centroid(vs), k = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  let min = Infinity;
  for (let i = 0; i < 36; i++) {
    const phi = (i / 36) * Math.PI * 2, y = Math.cos(phi), z = Math.sin(phi);
    const mid = radius(vs, c, [0, y, z]);
    const left = radius(vs, c, [-s, y * k, z * k]), right = radius(vs, c, [s, y * k, z * k]);
    if (left && right && mid) min = Math.min(min, mid / (mean ? (left + right) / 2 : Math.min(left, right)));
  }
  return min;
}
/** Groove along the mid plane (fissure): R(seam) / mean(R(12 deg left), R(12 deg right)). */
const groove = (vs) => waist(vs, 12, true);

const CASES = [
  ['empty (fresh cheap-mem)', 0, ['a'], 'storage'],
  ['1 node', 1, ['a'], 'storage'],
  ['4 projects, 34 entries', 34, ['payments', 'infra', 'onboarding', 'global'], 'storage'],
  ['5 projects, 400 entries (sub-groups)', 400, ['a', 'b', 'c', 'd', 'e'], 'storage'],
  ['12 projects (ladder layout)', 240, 'abcdefghijkl'.split(''), 'storage'],
  ['overview', 120, ['a', 'b', 'c'], 'overview'],
  ['topics', 90, ['a', 'b'], 'topics'],
  ['structure', 90, ['a', 'b'], 'structure'],
];

test('POSITIVE CONTROL: the waist catches two lobes, enclosure catches a node outside', () => {
  const lobes = collect((cortex) => {
    for (const side of [-1, 1]) {
      const g = new T.SphereGeometry(1, 64, 48), a = g.attributes.position;
      for (let i = 0; i < a.count; i++) a.setXYZ(i, side * 0.6 + a.getX(i) * 0.69, a.getY(i) * 0.99, a.getZ(i) * 0.87);
      cortex.add(new T.Mesh(g));
    }
  });
  assert.ok(waist(lobes.vertices) < 0.8, `two lobes must show as a waist (waist ${waist(lobes.vertices).toFixed(2)})`);
  const ball = collect((cortex) => cortex.add(new T.Mesh(new T.SphereGeometry(1, 64, 48))));
  assert.ok(waist(ball.vertices) > 0.95 && groove(ball.vertices) > 0.93, 'a sphere has neither waist nor groove');
  assert.equal(outside(ball.vertices, [[0.5, 0.2, 0.1], [0, 0, -0.9]]).length, 0, 'inside stays inside');
  assert.equal(outside(ball.vertices, [[0.5, 0.2, 0.1], [0.9, 0.5, 0]]).length, 1, 'a point at 1.03 lies outside');
});

let oldDrawCalls = Infinity;
test('RED on the old state (ddca89d, two-lobed oval): a waist, a groove, two centres', () => {
  const old = oldHull();
  oldDrawCalls = old.drawCalls;
  // Reported, not asserted: the oval was wide enough for these layouts
  // (0 outside in every case) — its fault is the shape, not the size.
  const perCase = CASES.map(([name, n, projects, mode]) => [name, outside(old.vertices, nodes(graphModel(store(n, projects), mode))).length]);
  console.log(`   old: nodes outside per case ${JSON.stringify(perCase)}, ${old.meshes.length} meshes, waist ${waist(old.vertices).toFixed(2)}, groove ${groove(old.vertices).toFixed(2)}, centre spread ${old.spread.toFixed(2)}, ${old.drawCalls} draw calls`);
  assert.ok(waist(old.vertices) < 0.8, 'the two lobes show as a waist');
  assert.ok(groove(old.vertices) < 0.9, 'the seam between the lobes shows as a groove');
  assert.ok(old.spread > 0.1, 'two bodies with different centres');
});

for (const [name, n, projects, mode] of CASES) {
  test(`GREEN: ${name} — ONE hull, all nodes inside, no waist, no more draw calls than before`, () => {
    const model = graphModel(store(n, projects), mode);
    const hull = newHull(model);
    const points = nodes(model);
    const out = outside(hull.vertices, points);
    const w = waist(hull.vertices), g = groove(hull.vertices);
    console.log(`   ${name}: ${points.length} nodes, ${out.length} outside, waist ${w.toFixed(2)}, groove ${g.toFixed(2)}, ${hull.drawCalls} draw calls`);
    // Since sphaere (2026-09-28): one fog volume, no skin — at most three surfaces on the SAME geometry.
    assert.ok(hull.meshes.length >= 1 && hull.meshes.length <= 3, 'fog volume, nothing more');
    assert.ok(hull.spread < 1e-6, `all hull surfaces around ONE centre (spread ${hull.spread})`);
    assert.deepEqual(out, [], 'all nodes lie inside the cloud');
    assert.ok(w >= 0.8, `waist along the mid plane (waist ${w.toFixed(2)})`);
    assert.ok(g >= 0.9, `fissure/groove along the mid plane (groove ${g.toFixed(2)})`);
    assert.ok(hull.drawCalls <= Math.min(9, oldDrawCalls), `${hull.drawCalls} draw calls — more than before`);
  });
}

test('GREEN: the cloud grows with the store and stays a calm sphere when empty', () => {
  const src = between(fs.readFileSync(FILE, 'utf8'), NEW_ANCHOR, 'function initGraph() {');
   
  const cloudShape = new Function(`${src}\nreturn cloudShape;`)();
  const empty = cloudShape(graphModel([], 'storage'));
  const full = cloudShape(graphModel(store(64, ['a', 'b', 'c', 'd', 'e']), 'storage'));
  const ax = (f) => [f.axes.x, f.axes.y, f.axes.z];
  assert.ok(Math.max(...ax(empty)) / Math.min(...ax(empty)) < 1.001, 'empty: a sphere');
  assert.ok(Math.min(...ax(full)) > Math.max(...ax(empty)), 'with a store: larger than empty');
  assert.ok(Math.max(...ax(full)) / Math.min(...ax(full)) < 1.6, 'round: no cigar');
  // Fixed: built twice, identical.
  assert.deepEqual(cloudShape(graphModel([], 'storage')).point(0.3, 0.8, 0.52), empty.point(0.3, 0.8, 0.52));
  // Since sphaere (2026-09-28) the hull is light fog without a surface
  // (test/sphere-hull.test.mjs); it reaches beyond the nodes.
  assert.match(src, /const CLOUD_REACH = 1\.\d+;/, 'the fog reaches beyond the node ellipsoid (factor > 1)');
});

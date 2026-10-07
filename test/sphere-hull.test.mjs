// test/sphere-hull.test.mjs — the network hull is light FOG around all
// nodes, no surface (task sphaere, 2026-09-28; mirrors lucky-mem's
// test/sphaere-huelle.test.mjs).
//
// The owner: "the sphere looks too much like a soap bubble; we want a
// cloud-like look marked by light fog that fades out towards the edge and
// drifts a little inside … is 'pushed aside' when the camera zooms … a few
// glitter particles that do not glow themselves but only catch and reflect
// the light of the spheres".
//
// Measured on the BUILT scene (the real three.js r180 from the package,
// geometry and materials only, no GPU) and on the formulas that shader and
// test SHARE (CLOUD_DENSITY, CLOUD_NEAR — one source of truth):
//   1. No surface: no lines (latitude rings), no mesh whose front side is
//      drawn (skin/fresnel rim) — only the back-side volume in which the
//      ray march gathers the fog.
//   2. Density falls monotonically to 0 outwards (no visible edge) and
//      stays thin (cap); every node lies in the fog.
//   3. Closeness to the camera fades the fog (windscreen), more in the
//      middle than to the side; no effect far away.
//   4. Glitter does not glow itself: its colour comes only from the light
//      of the cores (positions/colours from the model).
//   5. The cores keep their brightness: every hull material blends purely
//      additively (target * 1), draws before the cores and writes no depth.
//   6. No more than 5 draw calls.
//
// Red proof against the FIXED commit 6154cd0 (the cloud from huelle-wolke):
// lines and skin present, the skin blends normally (darkens the cores), no
// closeness formula. Positive controls: the checkers recognise a front-side
// skin, normal blending and a non-monotonic envelope.
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
const OLD_STATE = '6154cd0abf46db073c298020f598d4f111c6a04b';
const T = (() => {
  const ctx = { window: {}, self: {}, console, AbortController, TextDecoder, TextEncoder, performance, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'assets', 'three', 'three-r180.min.js'), 'utf8'), ctx);
  return ctx.window.MemThree || ctx.window.LuckyThree;
})();
// three.js constants (the bundled build does not export them; fixed for years).
const BACK = 1, NORMAL_BLENDING = 1, CUSTOM_BLENDING = 5, ONE = 201;
const ANCHOR = '// --- The network hull: ONE cloud';

function between(q, from, to) {
  const a = q.indexOf(from), b = q.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `anchor not found: ${from} .. ${to}`);
  return q.slice(a, b);
}
function graphModelFrom(q) {
  const src = between(q, 'function graphModel(', 'function graphCaption(');
   
  return new Function('allEdges', 'byId', 'neuralPalette', 'types', 'incomingIndex', 'trailCenter', `${src}\nreturn graphModel;`)(
    () => [], () => null, ['#8fd694', '#8fb8f0', '#7fe0d0', '#c9a8f0', '#f0c890', '#f09090', '#d0d0d0'], {}, new Map(), () => null,
  );
}
const SOURCE = fs.readFileSync(FILE, 'utf8');
const BLOCK = between(SOURCE, ANCHOR, 'function initGraph() {');
const graphModel = graphModelFrom(SOURCE);

function store(n, projects) {
  const kinds = ['decision', 'error', 'learning', 'thought', 'event'];
  return Array.from({ length: n }, (_, i) => ({ id: 'e' + i, project: projects[i % projects.length], type: kinds[i % kinds.length], tags: ['t' + (i % 4)] }));
}
// Node positions as in initGraph/createUnits (see test/hull-cloud.test.mjs).
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

function collect(run) {
  const objects = [];
  const cortex = { add: (o) => objects.push(o) };
  const out = run(cortex, (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z), (o) => o);
  return { objects, out, drawCalls: objects.filter((o) => o.isMesh || o.isPoints || o.isLine).length };
}
function hull(model, source = SOURCE) {
  const src = between(source, ANCHOR, 'function initGraph() {');
   
  const build = new Function('T', 'cortex', 'v', 'own', 'model', 'clock', `${src}\nreturn buildHull(T, cortex, own, v, model, clock);`);
  return collect((cortex, v, own) => build(T, cortex, v, own, model, { uTime: { value: 0 }, uMotion: { value: 1 } }));
}
const OLD_SOURCE = () => execFileSync('git', ['show', `${OLD_STATE}:assets/dashboard/dashboard.js`], { cwd: ROOT, encoding: 'utf8' });

// --- checkers ----------------------------------------------------------------
/** Visible surfaces: lines, and meshes whose front or both sides are drawn. */
const surfaces = (objects) => objects.filter((o) => o.isLine || (o.isMesh && o.material.side !== BACK));
/** Materials that can darken the target (the cores behind). */
const darkens = (objects) => objects.filter((o) => {
  const m = o.material;
  if (!m.transparent) return true;
  if (m.blending === CUSTOM_BLENDING) return m.blendDst !== ONE || (m.blendDstAlpha ?? m.blendDst) !== ONE;
  return m.blending === NORMAL_BLENDING || m.blending === undefined;
});
const smoothstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** A GLSL formula from the block as a JS function (the very string the shader uses). */
function formula(name, args) {
   
  const expr = new Function(`${BLOCK}\nreturn ${name};`)();
   
  return { expr, f: new Function('smoothstep', ...args, `return ${expr};`).bind(null, smoothstep) };
}
function monotonicFalling(f, from, to, steps = 400) {
  let before = Infinity;
  for (let i = 0; i <= steps; i++) {
    const y = f(from + ((to - from) * i) / steps);
    if (y > before + 1e-12) return false;
    before = y;
  }
  return true;
}

const CASES = [
  ['empty (fresh install)', 0, ['a'], 'storage'],
  ['1 node', 1, ['a'], 'storage'],
  ['5 projects, 64 entries', 64, ['payments', 'onboarding', 'infra', 'team', 'docs'], 'storage'],
  ['5 projects, 400 entries (subgroups)', 400, ['a', 'b', 'c', 'd', 'e'], 'storage'],
  ['12 projects (ladder layout)', 240, 'abcdefghijkl'.split(''), 'storage'],
  ['Overview', 120, ['a', 'b', 'c'], 'overview'],
  ['Topics', 90, ['a', 'b'], 'topics'],
  ['Structure', 90, ['a', 'b'], 'structure'],
];

test('POSITIVE CONTROL: the checkers recognise skin, lines, normal blending and an envelope with an edge', () => {
  const skin = new T.Mesh(new T.SphereGeometry(1, 8, 6), new T.ShaderMaterial({ transparent: true }));
  const volume = new T.Mesh(new T.SphereGeometry(1, 8, 6), new T.ShaderMaterial({ transparent: true, side: BACK, blending: CUSTOM_BLENDING, blendSrc: ONE, blendDst: ONE, blendSrcAlpha: ONE, blendDstAlpha: ONE }));
  const line = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ transparent: true }));
  assert.equal(surfaces([skin, line, volume]).length, 2, 'skin and lines are surfaces, the volume is not');
  assert.deepEqual(darkens([skin, volume]), [skin], 'normal blending darkens, additive does not');
  assert.equal(monotonicFalling((r) => (r < 0.9 ? 1 - r * 0.5 : 0.8), 0.34, 1.2), false, 'an edge/rise is noticed');
  assert.equal(monotonicFalling((r) => 1 - smoothstep(0.3, 1, r), 0.3, 1.2), true);
});

test('RED on the old state (6154cd0, cloud): skin and rings, normal blending, no windscreen', () => {
  const model = graphModel(store(64, ['payments', 'onboarding', 'infra', 'team', 'docs']), 'storage');
  const q = OLD_SOURCE();
  const old = hull(model, q);
  console.log(`   old: ${surfaces(old.objects).length} surfaces (skin/lines), ${darkens(old.objects).length} darkening materials, ${old.drawCalls} draw calls`);
  assert.ok(surfaces(old.objects).length > 0, 'the cloud had a skin and latitude rings');
  assert.ok(darkens(old.objects).length > 0, 'the skin blended normally and darkened');
  assert.doesNotMatch(q, /CLOUD_NEAR/, 'no windscreen');
});

test('GREEN: density falls monotonically to 0 outwards, thin, never empty inside', () => {
  const { expr, f } = formula('CLOUD_DENSITY', ['r']);
  assert.ok(BLOCK.includes('float wDensity(float r){ return ${CLOUD_DENSITY}; }'), 'the shader uses the same formula');
  const peak = Math.max(...Array.from({ length: 101 }, (_, i) => f(i / 100)));
  assert.ok(peak <= 1 + 1e-9, `envelope at most 1 (${peak})`);
  const from = [...Array(101).keys()].map((i) => i / 100).find((r) => f(r) >= peak - 1e-9);
  assert.ok(monotonicFalling(f, from, 1.3), `from r=${from} the density falls monotonically (${expr})`);
  assert.ok(Math.abs(f(1)) < 1e-9 && Math.abs(f(1.2)) < 1e-9, 'exactly 0 at the fog edge — no rim');
  assert.ok(f(0) >= 0.4, 'the middle is not empty');
   
  const cap = new Function(`${BLOCK}\nreturn CLOUD_CAP;`)();
  assert.ok(cap > 0 && cap <= 0.35, `fog at most ${cap} bright per pixel`);
  assert.match(BLOCK, /\(1\.0 - exp\(-acc \* [\d.]+\)\) \* \$\{CLOUD_CAP/, 'soft saturation under the cap');
  assert.match(BLOCK, /float d = wDensity\(length\(q\)\) \*/, 'the ray march uses the envelope');
});

test('GREEN: closeness to the camera fades the fog (windscreen), more in the middle, no effect far away', () => {
  const { f } = formula('CLOUD_NEAR', ['t', 's']);
  assert.ok(BLOCK.includes('float wNear(float t, float s){ return ${CLOUD_NEAR}; }'), 'the shader uses the same formula');
  assert.equal(f(0, 0), 0, 'right in front of the camera: no fog');
  assert.ok(f(1, 0) === 1 && f(3, 0.2) === 1, 'from a good half fog radius away: undisturbed');
  assert.ok(monotonicFalling((t) => -f(t, 0), 0, 1), 'the closer, the less fog');
  assert.ok(f(0.1, 0.25) > f(0.1, 0), 'more stays to the side than in the middle — the fog parts');
  assert.match(BLOCK, /float near = wNear\(t, s\);/);
  assert.match(BLOCK, /\* near \* crowd \* dt;/, 'closeness acts on the density');
  assert.match(BLOCK, /vec3 away = side \/ max\(1e-4, length\(side\)\) \* \(1\.0 - near\)/, 'close fog is pushed sideways');
});

for (const [name, n, projects, mode] of CASES) {
  test(`GREEN: ${name} — only fog volume and glitter, every node in the fog, cores untouched, <= 5 draw calls`, () => {
    const model = graphModel(store(n, projects), mode);
    const h = hull(model), pts = nodes(model), shape = h.out;
    const { f } = formula('CLOUD_DENSITY', ['r']);
    const rr = pts.map((p) => Math.hypot((p[0] - shape.center.x) / shape.fog.x, (p[1] - shape.center.y) / shape.fog.y, (p[2] - shape.center.z) / shape.fog.z));
    const far = Math.max(...rr);
    console.log(`   ${name}: ${pts.length} nodes, farthest at r=${far.toFixed(2)} (density ${f(far).toFixed(2)}), ${h.drawCalls} draw calls`);
    assert.deepEqual(surfaces(h.objects), [], 'no skin, no rings');
    assert.deepEqual(darkens(h.objects), [], 'nothing darkens the cores');
    assert.ok(h.objects.every((o) => o.renderOrder < 0 && o.material.depthWrite === false), 'before the cores, no depth');
    assert.ok(rr.every((r) => f(r) >= 0.2), 'every node lies in the fog (density >= 0.2)');
    assert.ok(h.drawCalls <= 5, `${h.drawCalls} draw calls`);
  });
}

test('GREEN: glitter does not glow itself — colour only from the light of the cores', () => {
  const model = graphModel(store(64, ['payments', 'onboarding', 'infra']), 'storage');
  const h = hull(model);
  const glitter = h.objects.find((o) => o.isPoints);
  assert.ok(glitter, 'glitter present');
  const count = glitter.geometry.attributes.position.count;
  // Upper bound 180: the owner asked on 2026-10-02 for 50 % more glitter particles (110 -> 165).
  assert.ok(count > 0 && count <= 180, `a few particles (${count})`);
  const { vertexShader: vs, fragmentShader: fsh, uniforms: u } = glitter.material;
  assert.match(vs, /vLight = vec3\(0\.0\);/, 'black without light');
  assert.equal((vs.match(/vLight \+?=/g) || []).length, 2, 'only the start value and the sum over the cores');
  assert.match(vs, /vLight \+= uLightColour\[k\] \* \(gloss \* [\d.]+ \+ flash \* [\d.]+ \+ diffuse\)/, 'specular, flash and diffuse light of the cores');
  assert.match(fsh, /gl_FragColor = wOut\(vLight \* /, 'output = caught light, no glow of its own');
  const want = [[0, -0.03, 0.02], ...model.shards.map((s) => [s.center.x, s.center.y, s.center.z])];
  want.forEach((p, i) => assert.ok(u.uLight.value[i].distanceTo(new T.Vector3(...p)) < 1e-9, `light ${i} sits on the core`));
  const c = new T.Color(model.shards[0].color), l = u.uLightColour.value[1];
  assert.ok(l.x > 0 && Math.abs(l.x / l.y - c.r / c.g) < 1e-6, 'light colour = core colour');
  const fog = h.objects.find((o) => o.isMesh);
  assert.equal(fog.material.uniforms.uLight, u.uLight, 'fog and glitter catch the same light');
});

test('GREEN: the cores glow as in the cloud version, not harsher (CORE_GLOW dims the colour, not the opacity)', () => {
  // Measured (demo store, 1440x900, no motion): blown-out pixels in the network picture,
  // lucky-mem: cloud 5.45 ‰, fog undamped 11.35 ‰, with 0.62 5.16 ‰; here cloud 0.95 ‰, now 0.37 ‰.
  const glow = new Function(`${between(SOURCE, 'const CORE_GLOW', 'const CORE_FS')}\nreturn CORE_GLOW;`)();  
  assert.ok(glow >= 0.5 && glow <= 0.8, `CORE_GLOW ${glow}`);
  assert.match(between(SOURCE, 'const CORE_FS', 'const STRAND_VS'), /gl_FragColor = vec4\(c \* \$\{CORE_GLOW\.toFixed\(2\)\}, clamp\(a, 0\.0, 1\.0\) \* vDim\);/);
  assert.doesNotMatch(OLD_SOURCE(), /CORE_GLOW/, 'RED: the old state had no damping');
});

test('GREEN: glitter more visible (glimmer, 2026-09-28) — more, larger, a flash from the same mirror angle to the core', () => {
  // The owner: "the glitter may become a little more visible". Measured (fixed demo
  // store, 1440x900, no motion; pixels >12 levels brighter with glitter than
  // without): before 67, now 315. Blown-out core pixels 0.37 -> 0.40 per mille
  // (cores and fog unchanged; the rest is the glitter itself).
  const OLD = '3eff43cbd10ad661a97a9bfc87627d6a5c66ff0d';
  const old = execFileSync('git', ['show', `${OLD}:assets/dashboard/dashboard.js`], { cwd: ROOT, encoding: 'utf8' });
  // Since 2026-10-02 the number lives in CLOUD_GLITTER (COUNT = CLOUD_GLITTER); older states carry it directly.
  const count = (q) => Number((/const CLOUD_GLITTER = (\d+);/.exec(q) || /const COUNT = (\d+);/.exec(between(q, ANCHOR, 'function initGraph() {')))[1]);
  assert.equal(count(old), 70, 'RED: 70 particles before');
  assert.doesNotMatch(old, /flash = pow\(mirror/, 'RED: no flash before');
  assert.ok(count(SOURCE) >= 100 && count(SOURCE) <= 180, `now ${count(SOURCE)} particles — more visible, still few (owner, 2026-10-02: +50 %)`);
  assert.match(BLOCK, /float mirror = max\(0\.0, dot\(reflect\(-L, n\), V\)\);\n\s*float gloss = pow\(mirror, [\d.]+\), flash = pow\(mirror, [\d.]+\);/, 'gloss and flash from the mirror angle to the core — no glow of its own');
  const h = hull(graphModel(store(64, ['a', 'b', 'c']), 'storage'));
  assert.ok(h.drawCalls <= 2, `${h.drawCalls} draw calls`);
});

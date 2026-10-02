// test/glitter-focus.test.mjs — the glitter in the 3D network stays equally
// bright in every view (port of lucky-mem dash-glimmer-post-lm, 2026-10-02).
//
// Root cause measured in lucky-mem: cortexAlpha(true) (focus/zoom on a group
// or cell) set the alpha of ALL cloud shaders to 0.055, so the glitter was
// only visible in the whole view. The fog may dim in focus, the glitter not.
// Plus the owner's request: +50 % glitter particles (110 -> 165).
//
// The real cortexAlpha function is cut out of assets/dashboard/dashboard.js
// and run against fake scene objects. Red proof: the same cut from the
// committed state before the fix dims the glitter. Positive control: the fog
// is still dimmed in focus.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = 'assets/dashboard/dashboard.js';

function cortexAlphaFrom(src) {
  const m = src.match(/function cortexAlpha\(focused\) \{[\s\S]*?\n {4}\}\);\n {2}\}/);
  assert.ok(m, 'cortexAlpha found in dashboard.js');
  return (children) => new Function('cortex', `${m[0]}\nreturn cortexAlpha;`)({ children });
}

function scene() {
  const shader = (glitter) => ({ material: { uniforms: { alpha: { value: 0.15 } } }, userData: glitter ? { glitter: true } : {} });
  return { fog: shader(false), glitter: shader(true) };
}

function oldSource() {
  const rev = execFileSync('git', ['log', '-n', '1', '--format=%H', '-S', 'CLOUD_GLITTER', '--', FILE], { cwd: ROOT, encoding: 'utf8' }).trim();
  const before = rev ? `${rev}~1` : 'HEAD';
  return execFileSync('git', ['show', `${before}:${FILE}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

test('GREEN: in focus the fog dims, the glitter keeps its brightness', () => {
  const s = scene();
  const fn = cortexAlphaFrom(fs.readFileSync(path.join(ROOT, FILE), 'utf8'))([s.fog, s.glitter]);
  fn(true);
  assert.equal(s.fog.material.uniforms.alpha.value, 0.055, 'positive control: fog dims in focus');
  assert.equal(s.glitter.material.uniforms.alpha.value, 0.15, 'glitter stays at full alpha in focus');
  fn(false);
  assert.equal(s.fog.material.uniforms.alpha.value, 0.15);
});

test('GREEN: 165 glitter particles (+50 % over 110), and the glitter object is marked', () => {
  const src = fs.readFileSync(path.join(ROOT, FILE), 'utf8');
  assert.match(src, /const CLOUD_GLITTER = 165;/);
  assert.match(src, /const COUNT = CLOUD_GLITTER;/);
  assert.match(src, /glitter\.userData\.glitter = true;/);
});

test('RED on the state before the fix: focus dimmed the glitter too', (t) => {
  let src;
  try { src = oldSource(); } catch { t.skip('no git history in this checkout'); return; }
  if (/CLOUD_GLITTER/.test(src)) { t.skip('fix not committed yet, nothing to compare'); return; }
  const s = scene();
  cortexAlphaFrom(src)([s.fog, s.glitter])(true);
  assert.equal(s.glitter.material.uniforms.alpha.value, 0.055, 'old code dims the glitter');
});

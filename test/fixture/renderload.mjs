// test/fixture/renderload.mjs — measuring aid for the dashboard's render load
// (parity with the sibling's test/fixture/renderlast.mjs): counts real draw
// calls (WebGL draw*, both contexts), frames and requestAnimationFrame calls
// per time window, in a real page.
/* global window -- these run inside the page (browser), not in Node */
export const COUNTER = () => {
  window.__load = { draws: 0, raf: 0, frames: 0, ts: [] }; // ts: [canvas no., time] per frame
  const ids = new Map();
  const last = new Map(); // per canvas: time of the last draw call (calls < 8 ms apart = one frame)
  for (const K of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!K) continue;
    for (const f of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const o = K.prototype[f];
      if (typeof o !== 'function') continue;
      K.prototype[f] = function (...a) {
        window.__load.draws++;
        const t = performance.now(), c = this.canvas;
        if (t - (last.get(c) ?? -1e9) > 8) {
          window.__load.frames++;
          if (!ids.has(c)) ids.set(c, ids.size);
          window.__load.ts.push([ids.get(c), t]);
        }
        last.set(c, t);
        return o.apply(this, a);
      };
    }
  }
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => { window.__load.raf++; return orig(cb); };
};

// Draw calls, frames (network + background together) and rAF calls per second over `ms`.
export async function measureLoad(page, ms = 3000) {
  const a = await page.evaluate(() => ({ ...window.__load, ts: 0 }));
  await page.waitForTimeout(ms);
  const b = await page.evaluate(() => ({ ...window.__load, ts: 0 }));
  const s = ms / 1000;
  return { draws: (b.draws - a.draws) / s, raf: (b.raf - a.raf) / s, frames: (b.frames - a.frames) / s };
}

// Event, not clock: waits until `n` frames have been drawn (or `maxMs` ran out)
// and returns the smallest and the median gap between two consecutive frames of ONE canvas.
// A throttle is a MINIMUM gap: CPU load only makes gaps longer, so the verdict
// does not depend on how many frames fit into a fixed window.
export async function sampleFrames(page, n = 24, maxMs = 45000) {
  const from = await page.evaluate(() => window.__load.ts.length);
  const reached = await page.waitForFunction(([f, k]) => window.__load.ts.length >= f + k, [from, n], { polling: 100, timeout: maxMs }).then(() => true, () => false);
  const ts = await page.evaluate((f) => window.__load.ts.slice(f), from);
  const per = new Map();
  for (const [c, t] of ts) (per.get(c) ?? per.set(c, []).get(c)).push(t);
  const gaps = [];
  for (const list of per.values()) for (let i = 1; i < list.length; i++) gaps.push(list[i] - list[i - 1]);
  gaps.sort((a, b) => a - b);
  return { reached, count: ts.length, minGap: gaps.length ? gaps[0] : Infinity, medGap: gaps.length ? gaps[gaps.length >> 1] : Infinity };
}

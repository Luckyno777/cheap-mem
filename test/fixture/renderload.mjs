// test/fixture/renderload.mjs — measuring aid for the dashboard's render load
// (parity with the sibling's test/fixture/renderlast.mjs): counts real draw
// calls (WebGL draw*, both contexts), frames and requestAnimationFrame calls
// per time window, in a real page.
export const COUNTER = () => {
  window.__load = { draws: 0, raf: 0, frames: 0 };
  const last = new Map(); // per canvas: time of the last draw call (calls < 8 ms apart = one frame)
  for (const K of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!K) continue;
    for (const f of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const o = K.prototype[f];
      if (typeof o !== 'function') continue;
      K.prototype[f] = function (...a) {
        window.__load.draws++;
        const t = performance.now(), c = this.canvas;
        if (t - (last.get(c) ?? -1e9) > 8) window.__load.frames++;
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
  const a = await page.evaluate(() => ({ ...window.__load }));
  await page.waitForTimeout(ms);
  const b = await page.evaluate(() => ({ ...window.__load }));
  const s = ms / 1000;
  return { draws: (b.draws - a.draws) / s, raf: (b.raf - a.raf) / s, frames: (b.frames - a.frames) / s };
}

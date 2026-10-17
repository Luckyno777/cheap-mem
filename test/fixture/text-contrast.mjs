// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
//
// test/fixture/text-contrast.mjs - measures, inside a real page, the WCAG contrast of every visible text element whose
// colour is one of the given colour variables (job quiet-aa-cm). Used by test/quiet-aa-cm-browser.test.mjs and by the
// screenshot script of the job.
//
// What "the background" is: the colours are the ones the browser computed (getComputedStyle), never the values typed
// in the stylesheet. Every layer from the canvas down to the element is composited in paint order: background-color,
// then the gradient layers bottom to top. A gradient counts with EVERY colour stop as a possible background (the worst
// one decides), because the text can sit anywhere on it. Not counted: canvas drawings (#atmosphere), pseudo-elements
// (the 1px sheen line of a panel) and images. Elements under an opacity below 1, and disabled controls, are listed
// apart (`faded`, each with `disabled`): WCAG exempts inactive controls, and under an opacity the colour is not the
// variable any more. Any other faded text is a finding: `fadedText()` names it, and the probe holds that list empty.

/** The WCAG minimum for normal text (1.4.3, AA). */
export const AA = 4.5;

/* global sections, document, getComputedStyle -- the in-page functions below run inside the dashboard page */

/**
 * The faded rows that are NOT a disabled control, as readable lines. Such a text is not measured (its colour under
 * the opacity is no longer the variable), so a probe must hold this list empty: a new faded grey text would otherwise
 * slip past the measurement unseen. `rec` is a list of `{ page, faded }` records (or one measureInPage result).
 */
export function fadedText(rec) {
  const list = Array.isArray(rec) ? rec : [{ page: '', ...rec }];
  return list.flatMap((r) => r.faded.filter((x) => !x.disabled).map((x) => `${r.page}: ${x.variable} under opacity ${x.opacity} (${x.where} "${x.text}")`));
}

/** The pages of the dashboard: the overview plus every tab of every area, read from the page's own `sections`. */
export const PAGES_IN_PAGE = () => {
  return Object.entries(sections).flatMap(([area, v]) => (v.tabs.length ? v.tabs.map(([tab]) => `${area}/${tab}`) : [area]));
};

/**
 * Runs inside the page (page.evaluate). `names` are custom property names ("--quiet"); returns the resolved colour per
 * name and one row per visible text element that carries one of them, with the worst-case contrast.
 */
export function measureInPage(names) {
  const parse = (s) => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const lin = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  // The resolved colour of each variable, in the body's context (the light theme sets them on body.light).
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  const vars = {};
  for (const n of names) { probe.style.color = `var(${n})`; vars[n] = getComputedStyle(probe).color; }
  probe.remove();

  /** The colour layers of one element, bottom to top: background-color, then the gradients (the first one is on top). */
  const layers = (el) => {
    const cs = getComputedStyle(el);
    const out = [];
    const bg = parse(cs.backgroundColor);
    if (bg && bg[3] > 0) out.push([bg]);
    const img = cs.backgroundImage;
    if (img && img !== 'none') {
      const parts = img.split(/,(?![^(]*\))(?=\s*(?:repeating-)?(?:linear|radial|conic)-gradient|\s*url)/);
      for (const g of parts.reverse()) {
        if (!/gradient/.test(g)) continue;
        const stops = [...g.matchAll(/rgba?\([^)]+\)|transparent/g)].map((x) => (x[0] === 'transparent' ? [0, 0, 0, 0] : parse(x[0])));
        if (stops.length) out.push(stops);
      }
    }
    return out;
  };

  const rows = [];
  const faded = [];
  const cache = new Map();
  /** Every possible background under `el`, composited from the canvas down (deduplicated). */
  const backgrounds = (el) => {
    if (!el) return [[255, 255, 255]];
    if (cache.has(el)) return cache.get(el);
    let cands = backgrounds(el.parentElement);
    for (const stops of layers(el)) {
      const next = new Map();
      for (const c of cands) for (const s of stops) { const v = over(s, c); next.set(v.map((x) => Math.round(x)).join(','), v); }
      cands = [...next.values()];
    }
    cache.set(el, cands);
    return cands;
  };
  const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
  const label = (el) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const parent = el.parentElement;
    const pc = parent && typeof parent.className === 'string' && parent.className.trim() ? '.' + parent.className.trim().split(/\s+/)[0] : '';
    return `${parent ? parent.tagName.toLowerCase() + pc + ' > ' : ''}${el.tagName.toLowerCase()}${cls}`;
  };
  const wanted = new Map(Object.entries(vars).map(([n, c]) => [c, n]));
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'SVG', 'svg', 'path', 'CANVAS'].includes(el.tagName)) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    const field = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
    if (!own && !field) continue;
    const cs = getComputedStyle(el);
    const v = wanted.get(cs.color);
    if (!v) continue;
    if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const fg = parse(cs.color);
    let worst = null;
    for (const b of backgrounds(el)) { const q = ratio(fg, b); if (!worst || q < worst.ratio) worst = { ratio: q, bg: b }; }
    const row = {
      variable: v, where: label(el), text: (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      color: hex(fg), bg: hex(worst.bg), ratio: Math.round(worst.ratio * 100) / 100, size: cs.fontSize, weight: cs.fontWeight,
    };
    const o = opacityOf(el);
    const disabled = Boolean(el.disabled || el.closest('[disabled],[aria-disabled=true]'));
    if (o < 0.99 || disabled) faded.push({ ...row, opacity: Math.round(o * 100) / 100, disabled });
    else rows.push(row);
  }
  return { vars, rows, faded };
}

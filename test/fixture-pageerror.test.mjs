// test/fixture-pageerror.test.mjs — the page-exception guard of test/fixture/browser.mjs really sees an exception
// (palette-typeerror-cm, 2026-10-09). Without this a Playwright change (pages made without `newContext`) would leave
// the guard's list silently empty — a green that guards nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lazyBrowser, browserStartProbe, watchPageErrors, guardPageErrors } from './fixture/browser.mjs';

const B = lazyBrowser({ pageerror: true });
browserStartProbe(B);

test('fixture pageerror: an uncaught exception and an unhandled rejection land in the list; allow() needs a reason', async (t) => {
  const browser = await B.need(t);
  if (!browser) return;
  const list = watchPageErrors(browser);
  list.length = 0;
  const page = await browser.newPage();
  try {
    await page.setContent('<script>setTimeout(() => { null.boom; }, 0); Promise.reject(new TypeError("late reject"));</script>');
    await page.waitForFunction(() => true);
    for (let i = 0; i < 50 && list.length < 2; i++) await page.waitForTimeout(100);
  } finally {
    await page.close();
  }
  assert.equal(list.length, 2, `both seen: ${list.join(' || ')}`);
  assert.ok(list.some((m) => /boom/.test(m)) && list.some((m) => /late reject/.test(m)));
  list.length = 0;
  assert.throws(() => B.allow(t, { allowed: /x/, reason: '' }), /needs both/);
  assert.equal(typeof guardPageErrors, 'function');
});

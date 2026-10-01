// SPDX-FileCopyrightText: 2026 Lucky H.
// SPDX-License-Identifier: MIT
// frozenset.mjs — a set that is really immutable (audit A.7).
//
// `Object.freeze(new Set([...]))` freezes only the Set OBJECT (no new
// properties), not its contents: `.add()`, `.delete()` and `.clear()` still
// go through. Where a constant is called a "closed list", that is a silent
// break of the promise. This wrapper keeps the real Set in a closure (not
// reachable from outside) and shows only what an immutable set needs:
// `has`, `size`, `values` (a frozen array) and iteration. No
// `add`/`delete`/`clear` — calling one throws a TypeError instead of
// silently working.

/**
 * @param {Iterable<*>} items
 * @returns {{has: (x: *) => boolean, size: number, values: readonly *[]}}
 */
export function frozenSet(items) {
  const inner = new Set(items);
  const list = Object.freeze([...inner]);
  return Object.freeze({
    has: (x) => inner.has(x),
    get size() { return list.length; },
    values: list,
    [Symbol.iterator]: () => list[Symbol.iterator](),
  });
}

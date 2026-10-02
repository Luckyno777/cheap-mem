// SPDX-License-Identifier: MIT
// MEASUREMENT ONLY (agent/expand-measure-cm), POST-HOC variant: drop generic
// question/function words from asked_as phrases (MEM_EXPAND_STRIP=1). The list
// is generic English, chosen after seeing that "how do we release" made
// "how do bees make honey" answer — so this variant is fitted, not blind.
const QW = new Set(('how what which who whom where when why do does did we you i is are was be '
  + 'the a an to for of in on at it its our my your can there this that with by from about').split(' '));
export function strip(list) {
  if (process.env.MEM_EXPAND_STRIP !== '1') return list;
  return list.map((p) => p.split(/\s+/).filter((w) => !QW.has(w.toLowerCase())).join(' ')).filter(Boolean);
}

// test/authorship.test.mjs — the copyright holder is named the same way
// in every place that names one, and the notices travel with the package.
//
// Why this check exists (2026-09-27): the license's one condition is that the
// copyright notice travels with every copy. That condition only protects
// the author if the notice is (a) present, (b) the same everywhere, and
// (c) actually shipped. Three places name the holder — LICENSE, NOTICE,
// package.json "author" — and the package "files" list decides what an
// npm install carries. One truth: LICENSE's copyright line is the source,
// the other two must agree with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

export function holderFromLicense(text) {
  const m = /^Copyright \(c\) (\d{4}) (.+)$/m.exec(text);
  return m ? { year: m[1], holder: m[2].trim() } : null;
}

export function holderName(holder) {
  // "Lucky H. (GitHub: Luckyno777)" -> "Lucky H."
  return holder.replace(/\s*\(.*\)\s*$/, '').trim();
}

export function checkAuthorship({ license, notice, pkg }) {
  const problems = [];
  const lic = holderFromLicense(license);
  if (!lic) return ['LICENSE has no "Copyright (c) YEAR HOLDER" line'];
  if (!notice) problems.push('NOTICE is missing');
  else if (!notice.includes(`Copyright (c) ${lic.year} ${lic.holder}`)) {
    problems.push('NOTICE does not carry the same copyright line as LICENSE');
  }
  const name = holderName(lic.holder);
  if (typeof pkg.author !== 'string' || !pkg.author.startsWith(name)) {
    problems.push(`package.json "author" does not start with "${name}"`);
  }
  const files = pkg.files ?? [];
  for (const f of ['LICENSE', 'NOTICE']) {
    if (!files.includes(f)) problems.push(`package.json "files" does not ship ${f}`);
  }
  return problems;
}

const real = () => ({
  license: read('LICENSE'),
  notice: fs.existsSync(path.join(ROOT, 'NOTICE')) ? read('NOTICE') : null,
  pkg: JSON.parse(read('package.json')),
});

test('the copyright holder is named the same in LICENSE, NOTICE and package.json, and both notices ship', () => {
  assert.deepEqual(checkAuthorship(real()), []);
});

test('the holder is Lucky H.', () => {
  assert.equal(holderName(holderFromLicense(read('LICENSE')).holder), 'Lucky H.');
});

test('sabotage: a NOTICE with a different holder is caught', () => {
  const r = real();
  r.notice = r.notice.replace('Lucky H.', 'Someone Else');
  assert.ok(checkAuthorship(r).some((p) => p.includes('NOTICE')));
});

test('sabotage: dropping NOTICE from the package files is caught', () => {
  const r = real();
  r.pkg = { ...r.pkg, files: r.pkg.files.filter((f) => f !== 'NOTICE') };
  assert.ok(checkAuthorship(r).some((p) => p.includes('does not ship NOTICE')));
});

test('sabotage: a missing author is caught', () => {
  const r = real();
  r.pkg = { ...r.pkg, author: undefined };
  assert.ok(checkAuthorship(r).some((p) => p.includes('"author"')));
});

test('empty is not a pass: a LICENSE without a copyright line is reported, not accepted', () => {
  const r = real();
  r.license = 'MIT License\n\nno holder here\n';
  assert.equal(checkAuthorship(r).length, 1);
});

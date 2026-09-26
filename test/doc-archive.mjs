// Which documents are living, and which are records — ONE rule for
// every guard that counts claims in the docs.
//
// A file is an ARCHIVE if its name carries a date, or it is the
// changelog. Everything else is living and gets checked — including
// files that do not exist yet, which is the point: a new document is
// guarded the day someone writes it, without anyone remembering to add
// it here.
//
// Shared since 2026-09-26: test/tool-count-doc.test.mjs had no such
// exemption and went red on a dated 2026-09-08 report the moment its
// German "elf Werkzeuge" was translated to "eleven tools". Two guards
// with two ideas of "archive" are two truths.
export function isArchive(rel) {
  return rel === 'CHANGELOG.md' || /-\d{4}-\d{2}-\d{2}/.test(rel);
}

// The usual storage places, found by name.
//
// **Why this exists at all.** When the archive was built the note said:
// anything the operating system can mount is a path, so no adapter is
// needed. That is right for a NAS share and for a plain folder, and
// only half right for a consumer cloud drive — the half that is missing
// is what these tests pin down.
//
// Nobody can type `~/Library/CloudStorage/GoogleDrive-<account>/My
// Drive` from memory, so the path has to be FOUND. And a file in such a
// folder can stop being a local file at any moment (Files On-Demand,
// Optimise Storage), so the person choosing it has to be TOLD.
//
// The tests fake a home directory rather than looking at the real one:
// a test that only passes on a machine with Dropbox installed is not a
// test, it is a coincidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as stores from '../src/stores.mjs';

function fakeHome(bauen = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  for (const rel of bauen) fs.mkdirSync(path.join(home, rel), { recursive: true });
  return home;
}

test('a store that is not installed is reported as such, not omitted', () => {
  const home = fakeHome();
  const found = stores.discover({ platform: 'darwin', home });

  // Every known store appears, with an empty list. "Not installed" and
  // "we never looked" are different statements, and a caller that only
  // sees hits cannot tell them apart.
  const ids = found.map((s) => s.id);
  assert.deepEqual(ids, ['local', 'gdrive', 'icloud', 'onedrive', 'dropbox']);
  for (const s of found) assert.deepEqual(s.found, []);
});

test('Google Drive is found although the account is in the folder name', () => {
  // This is the case that makes a lookup necessary in the first place:
  // the path cannot be written down in advance.
  const home = fakeHome(['Library/CloudStorage/GoogleDrive-someone@example.com/My Drive']);
  const r = stores.resolve('gdrive', { platform: 'darwin', home });
  assert.equal(r.ok, true);
  assert.equal(r.path,
    path.join(home, 'Library/CloudStorage/GoogleDrive-someone@example.com/My Drive',
      stores.SUBFOLDER));
});

test('iCloud on macOS, OneDrive with a company suffix, Dropbox', () => {
  const home = fakeHome([
    'Library/Mobile Documents/com~apple~CloudDocs',
    'Library/CloudStorage/OneDrive-SomeCompany',
    'Dropbox',
  ]);
  const opts = { platform: 'darwin', home };
  assert.equal(stores.resolve('icloud', opts).ok, true);
  assert.equal(stores.resolve('onedrive', opts).ok, true);
  assert.equal(stores.resolve('dropbox', opts).ok, true);
});

test('two candidates are AMBIGUOUS, not silently the first one', () => {
  // "It went somewhere" is the exact failure this archive was built to
  // avoid. Two Google accounts on one machine is ordinary, not exotic.
  const home = fakeHome([
    'Library/CloudStorage/GoogleDrive-work@example.com/My Drive',
    'Library/CloudStorage/GoogleDrive-home@example.com/My Drive',
  ]);
  const r = stores.resolve('gdrive', { platform: 'darwin', home });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
  assert.equal(r.found.length, 2);
});

test('a store not installed here says so, and an unknown id lists the known ones', () => {
  const home = fakeHome();
  const nicht = stores.resolve('dropbox', { platform: 'linux', home });
  assert.equal(nicht.ok, false);
  assert.equal(nicht.reason, 'not-installed');

  const quatsch = stores.resolve('megaupload', { platform: 'linux', home });
  assert.equal(quatsch.ok, false);
  assert.equal(quatsch.reason, 'unknown-store');
  assert.ok(quatsch.known.includes('dropbox'), 'the error does not say what IS known');
});

test('a plain folder is not a cloud and asks for a path', () => {
  const r = stores.resolve('local', { platform: 'linux', home: fakeHome() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'needs-path');
});

test('the sync warning belongs to the PATH, not to the command', () => {
  // Someone who types the Dropbox path by hand must get the same
  // warning as someone who says `--set dropbox`. Otherwise the warning
  // is a property of how you phrased it, which is no property at all.
  const home = fakeHome(['Dropbox']);
  const opts = { platform: 'linux', home };
  const drin = path.join(home, 'Dropbox', 'cheap-mem-archive');
  const draussen = path.join(home, 'ganz-normal');

  assert.equal(stores.syncingStoreFor(drin, opts)?.id, 'dropbox');
  assert.equal(stores.syncingStoreFor(draussen, opts), null);
});

test('a sibling folder is not "inside" the store', () => {
  // `startsWith` on a bare string would call `~/Dropbox-backup` part of
  // `~/Dropbox`. It is not, and warning about it would train people to
  // ignore the warning.
  const home = fakeHome(['Dropbox', 'Dropbox-backup']);
  const opts = { platform: 'linux', home };
  assert.equal(stores.syncingStoreFor(path.join(home, 'Dropbox-backup'), opts), null);
});

test('the warning names all three consequences', () => {
  // A warning that only says "this is a cloud folder" is decoration.
  // The three facts are what the user actually has to weigh.
  const text = stores.SYNC_WARNING.join(' ');
  assert.match(text, /evicted/i, 'eviction not mentioned');
  assert.match(text, /did not|does not mean/i, 'the write barrier is not mentioned');
  assert.match(text, /Two machines/i, 'shared use is not mentioned');
});

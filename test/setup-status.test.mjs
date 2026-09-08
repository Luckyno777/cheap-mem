// What is between "installed" and "working".
//
// **Why this command exists.** Reported from a Windows install on
// 2026-09-08: a hook with the first machine's absolute path baked in,
// dead and SILENT on the second — the session started without its
// memory and looked exactly like one that never had any. Nobody had a
// command that would have said "the memory is not attached here".
//
// **Why it is called `status` and not `setup`.** `mem setup <agent>`
// already existed. I defined `setup` a second time; a duplicate object
// key wins silently, and the help kept printing the old command. The
// same class as `mem frage` in the sibling project on the same day.
// It was caught by the `no-dupe-keys` lint rule, one hour after that
// rule was added — its first real find. `setup` installs, `status`
// reports.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as setup from '../src/setup.mjs';

const MEM = path.join(import.meta.dirname, '..', 'bin', 'mem');

function frisch() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-status-'));
  fs.mkdirSync(path.join(r, '.mem'), { recursive: true });
  fs.writeFileSync(path.join(r, '.mem', 'config.json'), '{}');
  return r;
}

test('kein Befehl ist zweimal definiert', () => {
  // **Als TEXT gelesen, nicht als Objekt.** Genau darum geht es: im
  // geladenen Objekt ist eine Dublette unsichtbar, weil der zweite
  // Schluessel den ersten ersetzt hat. Nur die Datei selbst zeigt
  // beide.
  const quelle = fs.readFileSync(MEM, 'utf8');
  const namen = [...quelle.matchAll(/^ {2}([a-z-]+): async/gm)].map((m) => m[1]);
  const doppelt = namen.filter((n, i) => namen.indexOf(n) !== i);
  assert.deepEqual(doppelt, [], `doppelt definiert: ${doppelt.join(', ')}`);
  assert.ok(namen.length > 30, `nur ${namen.length} Befehle gefunden — die Sonde ist kaputt`);
});

test('jeder Schritt hat drei moegliche Zustaende, nicht zwei', () => {
  // "ok / nicht ok" wuerde "noch nicht eingerichtet" und "kaputt" in
  // einen Topf werfen. Die brauchen verschiedene Antworten: das eine
  // ist eine Aufgabe, das andere ein Fehler.
  assert.deepEqual(Object.values(setup.STATE).sort(), ['broken', 'ok', 'open']);
});

test('ein unlesbares config.json ist BROKEN, ein fehlendes OPEN', () => {
  const leer = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-status-'));
  const fehlt = setup.check(leer).steps.find((s) => s.id === 'memory');
  assert.equal(fehlt.state, setup.STATE.OPEN);

  const kaputt = frisch();
  fs.writeFileSync(path.join(kaputt, '.mem', 'config.json'), '{ das ist kein JSON');
  const b = setup.check(kaputt).steps.find((s) => s.id === 'memory');
  assert.equal(b.state, setup.STATE.BROKEN,
    'eine unlesbare Konfiguration gilt als "noch nicht eingerichtet"');
});

test('DER BEFUND VON WINDOWS: ein Hook auf einen toten Pfad ist BROKEN', () => {
  // Das ist der Fall, fuer den es diesen Befehl gibt. Ein Hook, der
  // einen Pfad nennt, den es hier nicht gibt, ist schlimmer als gar
  // kein Hook: er laeuft, findet nichts und beendet sich leise.
  const r = frisch();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'cheap-mem-session-start.sh'),
    'CHEAP_MEM_ROOT="/gibt/es/hier/nicht"\n');

  const s = setup.check(r, { env: {}, home }).steps.find((x) => x.id === 'hooks');
  assert.equal(s.state, setup.STATE.BROKEN);
  assert.match(s.detail, /gibt\/es\/hier\/nicht/, 'der tote Pfad wird nicht genannt');
  assert.ok(s.fix, 'kein Weg heraus angegeben');
});

test('ein Hook mit einem Pfad, den es GIBT, ist ok', () => {
  // Gegenprobe: sonst waere die Regel „jeder Hook ist kaputt".
  const r = frisch();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-home-'));
  const hooks = path.join(home, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'cheap-mem-session-start.sh'),
    `CHEAP_MEM_ROOT="${r}"\n`);

  const s = setup.check(r, { env: {}, home }).steps.find((x) => x.id === 'hooks');
  assert.equal(s.state, setup.STATE.OK);
});

test('alle Schritte laufen, auch wenn der erste scheitert', () => {
  // Ein Lauf, der beim ersten Problem abbricht, versteckt die anderen
  // vier — und dann repariert jemand eine Sache pro Sitzung.
  const leer = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-status-'));
  const res = setup.check(leer, { env: {}, home: leer });
  assert.equal(res.steps.length, 5);
  assert.equal(res.steps.filter((s) => s.state).length, 5);
});

test('OFFEN endet mit 0, KAPUTT nicht', () => {
  // Offen ist eine Aufgabenliste. Wenn die den Rueckgabewert rot macht,
  // bricht sie jedes Skript, das den Befehl aufruft — und dann nimmt
  // ihn niemand mehr ins Skript.
  const r = frisch();
  const a = spawnSync(process.execPath, [MEM, 'status'], { cwd: r, encoding: 'utf8' });
  assert.equal(a.status, 0, `offene Schritte machten den Lauf rot:\n${a.stdout}${a.stderr}`);
  assert.match(a.stdout, /of 5 in place/);
});

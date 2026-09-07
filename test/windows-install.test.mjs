// Zwei Defekte, gefunden bei einer frischen Windows-Installation.
//
// Am 2026-09-07 hat jemand cheap-mem auf einem Windows-Rechner
// installiert und dabei zwei Dinge gefunden, die keiner unserer 434
// Tests je beruehrt hatte. Beide sind hier festgehalten, weil beide
// die Bauform "sieht richtig aus, tut nichts" haben.
//
//   1. Jeder Windows-Pfad galt als Geheimnis. ENV_HARMLESS kannte
//      USER und LOGNAME, aber nicht USERNAME. Auf einem Konto namens
//      `Administrator` steckt der Name in jedem Pfad unter C:\Users\,
//      also ersetzte die Redaktion jeden Pfad — und der pre-commit-Hook
//      verweigerte jeden Commit, der einen erwaehnte. Unbenutzbar.
//
//   2. Die .gitignore ignorierte nichts. Sie wurde als
//      `<regel><fuellung># <grund>` geschrieben, und git kennt keine
//      nachgestellten Kommentare: `#` beginnt einen Kommentar nur am
//      ZEILENANFANG. Alle neun Regeln waren Muster, die auf nichts
//      passen — die erste davon `.mem/embed.env`, deren einzige Aufgabe
//      es ist, einen API-Schluessel aus dem Repo zu halten.
//
// Der zweite Fall ist der lehrreichere: die Datei sah richtig aus. Wer
// sie liest, sieht neun Regeln. Nur wer GIT fragt, sieht null.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as redaction from '../src/redaction.mjs';
import * as doctor from '../src/doctor.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const MEM = path.join(HIER, '..', 'bin', 'mem');

function bau({ git = true } = {}) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-win-'));
  if (git) execFileSync('git', ['init', '-q', '-b', 'main', r]);
  execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
  return r;
}
const weg = (r) => fs.rmSync(r, { recursive: true, force: true });
const ignoriert = (r, f) => spawnSync('git',
  ['-C', r, 'check-ignore', '-q', '--no-index', f]).status === 0;

// --- 1. Windows-Umgebungsnamen ---------------------------------------

test('DER FALL: der Windows-Benutzername ist kein Geheimnis', () => {
  const env = { USERNAME: 'Administrator', USERPROFILE: 'C:\\Users\\Administrator' };
  assert.deepEqual(redaction.envSecrets(env), [],
    'USERNAME/USERPROFILE wurden als Geheimnis gefuehrt');
});

test('DER FALL: ein Windows-Pfad ueberlebt die Redaktion unveraendert', () => {
  const env = { USERNAME: 'Administrator' };
  const text = 'Klon in C:\\Users\\Administrator\\cheap-mem';
  assert.equal(redaction.redactAgainstEnv(text, redaction.envSecrets(env)).text, text);
});

test('die Schreibweise ist egal — Windows-Namen sind es auch', () => {
  // Ein Programm reicht `Username` oder `UserProfile` herein, wie es
  // will. Eine Liste, die nur eine Schreibweise trifft, hat Loecher.
  for (const n of ['Username', 'userprofile', 'ComputerName', 'LOCALAPPDATA']) {
    assert.deepEqual(redaction.envSecrets({ [n]: 'WORKSTATION-Administrator' }), [],
      `${n} wurde als Geheimnis gefuehrt`);
  }
});

test('POSITIV: ein echter Schluessel bleibt ein Geheimnis', () => {
  // Ohne diese Kontrolle wuesste niemand, ob die Liste zu weit ist.
  for (const [k, v] of [['OPENAI_API_KEY', 'sk-proj-9f2Ab7QzX1mK'],
    ['GITHUB_TOKEN', 'ghp_9f2Ab7QzX1mKlmNo'], ['DB_PASSWORD', 'hunter2hunter2hunter']]) {
    assert.equal(redaction.envSecrets({ [k]: v }).length, 1, `${k} rutschte durch`);
  }
});

// --- 2. Die .gitignore, git gefragt statt gelesen ---------------------

test('DER FALL: git ignoriert .mem/embed.env wirklich', () => {
  const r = bau();
  try {
    assert.ok(ignoriert(r, '.mem/embed.env'),
      'die Datei mit den API-Schluesseln wird NICHT ignoriert');
  } finally { weg(r); }
});

test('git ignoriert jede geschriebene Regel', () => {
  const r = bau();
  try {
    const regeln = fs.readFileSync(path.join(r, '.gitignore'), 'utf8').split('\n')
      .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.ok(regeln.length >= 9, `nur ${regeln.length} Regeln gefunden`);
    for (const g of regeln) {
      const probe = g.endsWith('/') ? `${g}x` : g;
      assert.ok(ignoriert(r, probe), `Regel wirkungslos: ${JSON.stringify(g)}`);
    }
  } finally { weg(r); }
});

test('keine Regelzeile traegt einen nachgestellten Kommentar', () => {
  const r = bau();
  try {
    for (const l of fs.readFileSync(path.join(r, '.gitignore'), 'utf8').split('\n')) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      assert.ok(!t.includes('#'), `nachgestellter Kommentar: ${JSON.stringify(t)}`);
    }
  } finally { weg(r); }
});

test('REPARATUR: eine kaputte alte .gitignore wird beim naechsten init geheilt', () => {
  // Der wichtigste Test der Datei. Ein Gedaechtnis, das vor heute
  // angelegt wurde, traegt die kaputten Zeilen — und der alte
  // Vergleich hielt sie faelschlich fuer vorhanden, haette also genau
  // die Dateien uebersprungen, die die Reparatur brauchen.
  const r = bau();
  try {
    fs.writeFileSync(path.join(r, '.gitignore'),
      '# cheap-mem: derived state and secrets\n'
      + '.mem/embed.env            # API keys. NEVER commit this.\n'
      + '.mem/epoch.json           # Local rollback watermark. Never commit: a tracked one\n'
      + '     travels back with the checkout it is meant to detect.\n'
      + '.mem/search-index.json    # derived: rebuilt in milliseconds\n');
    assert.ok(!ignoriert(r, '.mem/embed.env'), 'Vorbedingung: soll kaputt sein');
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    assert.ok(ignoriert(r, '.mem/embed.env'), 'nicht geheilt');
    assert.ok(ignoriert(r, '.mem/epoch.json'), 'nicht geheilt');
    const text = fs.readFileSync(path.join(r, '.gitignore'), 'utf8');
    assert.ok(!/travels back with the checkout/.test(text.split('\n')
      .filter((l) => !l.trim().startsWith('#')).join('\n')),
    'die haengende Fortsetzungszeile steht noch als Muster da');
  } finally { weg(r); }
});

test('ein zweites init aendert an einer heilen Datei nichts', () => {
  const r = bau();
  try {
    const vorher = fs.readFileSync(path.join(r, '.gitignore'), 'utf8');
    execFileSync('node', [MEM, '--root', r, 'init'], { stdio: 'ignore' });
    assert.equal(fs.readFileSync(path.join(r, '.gitignore'), 'utf8'), vorher);
  } finally { weg(r); }
});

// --- Der Doktor sieht es jetzt ----------------------------------------

test('der Doktor fragt git und meldet eine wirkungslose .gitignore als Fehler', () => {
  const r = bau();
  try {
    assert.equal(doctor.checkGitignoreEffective(r).level, 'good');
    fs.writeFileSync(path.join(r, '.gitignore'),
      '.mem/embed.env            # API keys. NEVER commit this.\n');
    const f = doctor.checkGitignoreEffective(r);
    assert.equal(f.level, 'error');
    assert.match(f.text, /embed\.env/);
  } finally { weg(r); }
});

test('ohne git-Repo schweigt der Doktor, statt zu warnen', () => {
  // Ein Gedaechtnis ohne Versionierung kann daran nicht scheitern. Eine
  // Warnung dort erzoege nur, die Ausgabe zu ueberlesen.
  const r = bau({ git: false });
  try {
    assert.equal(doctor.checkGitignoreEffective(r).level, 'unknown');
  } finally { weg(r); }
});

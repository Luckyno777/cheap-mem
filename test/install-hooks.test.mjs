// Das Hook-Kommando nennt seinen Interpreter.
//
// Der Installer trug lange den nackten `.sh`-Pfad als Kommando ein.
// Das scheitert auf zwei Arten, und beide sind bezahlt:
//
//   Linux/macOS — Exit 126, sobald das x-Bit fehlt. Das passiert von
//   allein auf einem Klon mit core.fileMode=false. Wenigstens laut;
//   in lucky-mem am 2026-09-01 gefunden.
//
//   Windows — `bash` liegt nicht auf dem PATH, den cmd.exe sieht. Ein
//   Testlauf ueber cmd ist nicht gescheitert, sondern HAENGENGEBLIEBEN.
//   Ein UserPromptSubmit-Hook, der haengt, blockiert jede Nachricht bis
//   zum Timeout — das Gedaechtnis macht den Assistenten dann unbenutzbar,
//   statt nur stumm zu sein. Am 2026-09-07 von einer frischen
//   Windows-Installation gemeldet.
//
// Der Windows-Zweig (cygpath) laesst sich hier nicht fahren. Was sich
// hier fahren laesst, ist alles andere — und das ist genau der Teil,
// der auf jeder Plattform gleich sein muss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HIER, '..');
const MEM = path.join(REPO, 'bin', 'mem');
const INSTALL = path.join(REPO, 'install', 'claude-code.sh');
const EREIGNISSE = ['SessionStart', 'Stop', 'UserPromptSubmit'];

// `heim` darf ein Leerzeichen enthalten — auf Windows ist das der
// Normalfall, nicht die Ausnahme.
function installiere({ heimName = 'claude home' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-inst-'));
  const wurzel = path.join(tmp, 'memory');
  fs.mkdirSync(wurzel, { recursive: true });
  execFileSync('node', [MEM, '--root', wurzel, 'init'], { stdio: 'ignore' });
  const claudeHome = path.join(tmp, heimName);
  execFileSync('bash', [INSTALL], {
    env: { ...process.env, CHEAP_MEM_ROOT: wurzel, CLAUDE_HOME: claudeHome },
    stdio: 'ignore',
  });
  const cfg = JSON.parse(fs.readFileSync(path.join(claudeHome, 'settings.json'), 'utf8'));
  return { tmp, claudeHome, cfg };
}
const weg = (t) => fs.rmSync(t, { recursive: true, force: true });
const kommandos = (cfg) => EREIGNISSE.map((e) => cfg.hooks[e].at(-1).hooks[0].command);

test('DER FALL: kein Kommando ist ein nackter Skriptpfad', () => {
  const { tmp, cfg } = installiere();
  try {
    for (const cmd of kommandos(cfg)) {
      assert.ok(!/^\S*cheap-mem-[a-z-]+\.sh$/.test(cmd.trim()),
        `nackter Pfad als Kommando: ${cmd}`);
      assert.match(cmd, /bash/, `kein Interpreter genannt: ${cmd}`);
    }
  } finally { weg(tmp); }
});

test('ein Pfad mit Leerzeichen wird in Anfuehrungszeichen gesetzt', () => {
  // `C:\Program Files\Git\bin\bash.exe` ist auf Windows der Normalfall.
  const { tmp, cfg } = installiere({ heimName: 'claude home' });
  try {
    for (const cmd of kommandos(cfg)) {
      const teile = cmd.match(/"[^"]*"|\S+/g) ?? [];
      assert.equal(teile.length, 2, `nicht genau zwei Teile: ${cmd}`);
      assert.ok(teile[1].startsWith('"') && teile[1].endsWith('"'),
        `Pfad mit Leerzeichen ohne Anfuehrungszeichen: ${cmd}`);
    }
  } finally { weg(tmp); }
});

test('das Kommando zeigt auf die Datei, die wirklich dort liegt', () => {
  const { tmp, claudeHome, cfg } = installiere({ heimName: 'claudehome' });
  try {
    for (const cmd of kommandos(cfg)) {
      const skript = (cmd.match(/(\S+cheap-mem-[a-z-]+\.sh)/) ?? [])[1];
      assert.ok(skript, `kein Skriptpfad im Kommando: ${cmd}`);
      assert.ok(fs.existsSync(skript), `Kommando zeigt ins Leere: ${skript}`);
      assert.equal(path.dirname(skript), path.join(claudeHome, 'hooks'));
    }
  } finally { weg(tmp); }
});

test('das Kommando laeuft und liefert, was der Hook liefern soll', () => {
  // Der einzige Beweis, der zaehlt: nicht wie es aussieht, sondern ob
  // es laeuft. Ohne diesen Test bliebe "nennt einen Interpreter" eine
  // Behauptung ueber eine Zeichenkette.
  const { tmp, cfg } = installiere({ heimName: 'claudehome' });
  try {
    const cmd = cfg.hooks.UserPromptSubmit.at(-1).hooks[0].command;
    const aus = execFileSync('bash', ['-c', cmd], {
      input: JSON.stringify({ prompt: 'was ist mit dem gedaechtnis' }),
      encoding: 'utf8', timeout: 20000,
    });
    // Leere Ausgabe ist erlaubt (frisches Gedaechtnis, kein Treffer);
    // was NICHT erlaubt ist, ist ein Absturz oder Muell.
    if (aus.trim()) JSON.parse(aus);
  } finally { weg(tmp); }
});

test('ein zweiter Lauf ersetzt den Eintrag, statt einen zweiten anzuhaengen', () => {
  // Zwei Hooks auf UserPromptSubmit heisst: jede Nachricht zahlt
  // doppelt. Der alte Filter suchte nach dem PFAD — und der aendert
  // sich zwischen zwei Laeufen, sobald die Form wechselt.
  const { tmp, claudeHome, cfg } = installiere({ heimName: 'claudehome' });
  try {
    const vorher = Object.fromEntries(EREIGNISSE.map((e) => [e, cfg.hooks[e].length]));
    // Einen Eintrag in der alten Form unterschieben — und zwar mit einer
    // ANDEREN PFADFORM. Das ist der Fall, der zaehlt: unter Git Bash
    // schreibt der eine Lauf `/c/Users/...`, der naechste
    // `C:/Users/...`. Ein Filter, der den Pfad vergleicht, sieht darin
    // zwei verschiedene Hooks und laesst beide stehen.
    //
    // Eine erste Fassung dieses Tests hat den Pfad einfach nachgebaut,
    // wie ihn der Installer auch schreibt — und war damit auch mit dem
    // alten, pfadbasierten Filter gruen. Ein Test, den die Sabotage
    // nicht rot bekommt, prueft nichts.
    const datei = path.join(claudeHome, 'settings.json');
    const alt = JSON.parse(fs.readFileSync(datei, 'utf8'));
    alt.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command',
      command: 'C:/Users/Administrator/.claude/hooks/cheap-mem-user-prompt.sh' }] });
    fs.writeFileSync(datei, JSON.stringify(alt, null, 2));

    const wurzel = path.join(tmp, 'memory');
    execFileSync('bash', [INSTALL], {
      env: { ...process.env, CHEAP_MEM_ROOT: wurzel, CLAUDE_HOME: claudeHome },
      stdio: 'ignore',
    });
    const neu = JSON.parse(fs.readFileSync(datei, 'utf8'));
    for (const e of EREIGNISSE) {
      assert.equal(neu.hooks[e].length, vorher[e],
        `${e} hat jetzt ${neu.hooks[e].length} Eintraege statt ${vorher[e]}`);
    }
  } finally { weg(tmp); }
});

test('fremde Hooks bleiben unangetastet', () => {
  const { tmp, claudeHome } = installiere({ heimName: 'claudehome' });
  try {
    const datei = path.join(claudeHome, 'settings.json');
    const cfg = JSON.parse(fs.readFileSync(datei, 'utf8'));
    cfg.hooks.UserPromptSubmit.unshift({ hooks: [{ type: 'command', command: 'echo fremd' }] });
    fs.writeFileSync(datei, JSON.stringify(cfg, null, 2));
    execFileSync('bash', [INSTALL], {
      env: { ...process.env, CHEAP_MEM_ROOT: path.join(tmp, 'memory'), CLAUDE_HOME: claudeHome },
      stdio: 'ignore',
    });
    const neu = JSON.parse(fs.readFileSync(datei, 'utf8'));
    assert.ok(neu.hooks.UserPromptSubmit.some((e) => e.hooks[0].command === 'echo fremd'),
      'fremder Hook wurde entfernt');
  } finally { weg(tmp); }
});

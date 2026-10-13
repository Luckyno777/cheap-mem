// Driver for test/loadchild-leash.test.mjs: starts load children, writes their PIDs to a file, and waits
// until the probe ends it hard (SIGKILL). Usage:
//   node loadchild-driver.mjs <new|old> <pid-file>
// `new`: the helper (double leash). `old`: the shape BEFORE the fix (child without a parent leash) -- with a
// 20 s kill switch inside the child, so that the probe's own positive control never leaves a child behind
// should it die before cleaning up.
// Without arguments (the fixture sweep): quiet exit 0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { startLoadChildren } from './loadchild.mjs';

const [mode, pidFile] = process.argv.slice(2);
if (!mode || !pidFile) process.exit(0);

let pids;
if (mode === 'new') {
  pids = startLoadChildren(2, { maxLifetimeMs: 30000 }).pids;
} else {
  // loadchild-ok: deliberately WITHOUT a parent leash (red proof of the old shape); the child ends itself after 20 s
  const old = 'let x = 0; const end = Date.now() + 20000; for (;;) { for (let i = 0; i < 20000; i += 1) x += Math.sqrt(x + 1); if (Date.now() > end) process.exit(0); }';
  pids = [0, 1].map(() => spawn(process.execPath, ['-e', old], { stdio: 'ignore' }).pid);
}
fs.writeFileSync(pidFile, JSON.stringify({ driver: process.pid, children: pids }));
setTimeout(() => process.exit(0), 45000); // the driver itself ends after 45 s at the latest

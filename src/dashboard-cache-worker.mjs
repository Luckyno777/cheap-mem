// dashboard-cache-worker.mjs — the worker thread for the background build
// of `/dashboard.json` (see dashboard-cache.mjs). The same call as in the
// server, no second version of the data.

import { parentPort, workerData } from 'node:worker_threads';
import * as dashboardData from './dashboard-data.mjs';

try {
  const { root, options } = workerData;
  const data = dashboardData.collectDashboard(root, { ...options, env: options.env ?? process.env });
  parentPort.postMessage({ ok: true, data });
} catch (e) {
  parentPort.postMessage({ ok: false, reason: e?.message || String(e) });
}

// Brave lifecycle over CDP.
// Contract with the user: the daemon MAY close and relaunch Brave to attach CDP
// to the REAL logged-in profile. Tabs survive via graceful close + --restore-last-session.
// `brave off` always restores Brave WITHOUT the debug port (port is temporary).

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cdpVersion } from './client.js';

const execFileP = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cdpStatus(port) {
  try {
    const v = await cdpVersion(port);
    return { up: true, browser: v.Browser, protocol: v['Protocol-Version'] };
  } catch {
    return { up: false };
  }
}

export async function braveProcessCount() {
  try {
    const { stdout } = await execFileP(
      'tasklist',
      ['/FI', 'IMAGENAME eq brave.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true }
    );
    return (stdout.match(/brave\.exe/gi) || []).length;
  } catch {
    return 0;
  }
}

/** Graceful WM_CLOSE to all Brave windows (session is saved), escalate to /F on timeout. */
async function gracefulCloseAll(timeoutMs) {
  try { await execFileP('taskkill', ['/IM', 'brave.exe'], { windowsHide: true }); }
  catch { /* already closed or none running */ }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await braveProcessCount()) === 0) return true;
    await sleep(500);
  }
  try { await execFileP('taskkill', ['/IM', 'brave.exe', '/T', '/F'], { windowsHide: true }); }
  catch { /* noop */ }
  await sleep(1500);
  return (await braveProcessCount()) === 0;
}

function launchBrave(brave, extraArgs) {
  const child = spawn(brave.exe, extraArgs, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

/** Make sure Brave is running WITH the CDP port, reusing the logged-in profile. */
export async function ensureOn(brave, log = () => {}) {
  const { cdpPort, restoreArgs = [], gracefulCloseTimeoutMs = 20000 } = brave;
  const before = await cdpStatus(cdpPort);
  if (before.up) return { action: 'already-on', ...before };

  const wasRunning = (await braveProcessCount()) > 0;
  if (wasRunning) {
    log('brave', 'Brave dang chay khong co CDP -> dong nhe (luu session) va nap lai voi CDP');
    await gracefulCloseAll(gracefulCloseTimeoutMs);
  }
  launchBrave(brave, ['--remote-debugging-port=' + cdpPort, ...restoreArgs, ...(brave.extraArgs || [])]);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const st = await cdpStatus(cdpPort);
    if (st.up) return { action: wasRunning ? 'restarted-with-cdp' : 'launched-with-cdp', ...st };
    await sleep(700);
  }
  throw new Error(`Brave CDP khong len duoc tren port ${cdpPort}`);
}

/** Close the CDP-enabled instance and restore Brave normally (no debug port). */
export async function ensureOff(brave, log = () => {}) {
  const { cdpPort, restoreArgs = [], gracefulCloseTimeoutMs = 20000 } = brave;
  const st = await cdpStatus(cdpPort);
  if (!st.up) {
    const n = await braveProcessCount();
    return { action: n > 0 ? 'running-without-cdp' : 'not-running' };
  }
  log('brave', 'Dong Brave (co CDP) va nap lai binh thuong khong mo port');
  await gracefulCloseAll(gracefulCloseTimeoutMs);
  launchBrave(brave, [...restoreArgs, ...(brave.extraArgs || [])]);
  return { action: 'cdp-closed-and-relaunched-normal' };
}

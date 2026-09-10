/**
 * The desktop window.
 *
 * This used to be a second harness: its own renderer, its own turn loop, its
 * own idea of what a session was. Two implementations meant the laptop and the
 * phone showed different products, and every feature had to be built twice or
 * silently only existed in one place.
 *
 * It is now a window onto the same server the phone talks to. One harness, two
 * screens. The window starts the server if it is not already up, so opening the
 * app on a cold laptop is enough to bring everything back.
 */

import { app, BrowserWindow, shell } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.HARNESS_PORT ?? 8787);
const USER_DATA =
  process.env.HARNESS_DATA_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'harness');

let win = null;
let child = null;

/** Is the harness already answering on its port? */
function isUp(port = PORT) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(700);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/**
 * Start the server only if nothing is serving yet.
 *
 * The harness is meant to be reachable from the phone at all times, so a
 * desktop window must never take over a server that is already running — it
 * attaches to it.
 */
async function ensureServer() {
  if (await isUp()) return 'already running';

  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();

  for (let i = 0; i < 40; i += 1) {
    if (await isUp()) return 'started';
    await new Promise((r) => { setTimeout(r, 250); });
  }
  return 'failed';
}

async function harnessUrl() {
  // First load carries the token; the server sets a cookie so later
  // navigations inside the window are clean.
  const token = await readFile(path.join(USER_DATA, 'server-token'), 'utf8').then((t) => t.trim()).catch(() => '');
  return `http://127.0.0.1:${PORT}/${token ? `?t=${encodeURIComponent(token)}` : ''}`;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 420,
    minHeight: 480,
    title: 'Harness',
    backgroundColor: '#14161a',
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  const state = await ensureServer();
  if (state === 'failed') {
    await win.loadURL(`data:text/html,${encodeURIComponent(
      `<body style="background:#14161a;color:#e6e9ef;font:14px -apple-system;padding:40px">
       <h2>The harness server did not start</h2>
       <p style="color:#909aa6">Run <code>npm run serve</code> in ${ROOT} and reopen this window.</p></body>`,
    )}`);
    return;
  }

  await win.loadURL(await harnessUrl());

  // Links to an app the harness is serving, or anything external, belong in a
  // real browser rather than replacing the dashboard in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // Dev affordance: HARNESS_CAPTURE=<png path> screenshots the window and exits.
  // Uses the window's own compositor, so it needs no screen-recording grant.
  if (process.env.HARNESS_CAPTURE) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        await writeFile(process.env.HARNESS_CAPTURE, (await win.webContents.capturePage()).toPNG());
        app.quit();
      }, Number(process.env.HARNESS_CAPTURE_DELAY ?? 1200));
    });
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  // Closing the window must not take the harness down: the phone is still
  // using it. The server was started detached for exactly this reason.
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

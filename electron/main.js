import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTurn } from '../src/core/agent.js';
import { configPath, loadConfig } from '../src/core/config.js';
import { resetClients } from '../src/core/providers/index.js';
import * as store from '../src/core/store.js';
import { tally } from '../src/core/transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win = null;
const open = new Map();      // sessionId -> session object currently loaded
const running = new Map();   // sessionId -> AbortController for the in-flight turn

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Harness',
    backgroundColor: '#14161a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Dev affordance: HARNESS_CAPTURE=<png path> screenshots the window and exits.
  // Uses the window's own compositor, so it needs no screen-recording grant and
  // captures nothing but this app.
  if (process.env.HARNESS_CAPTURE) {
    win.webContents.once('did-finish-load', async () => {
      setTimeout(async () => {
        const image = await win.webContents.capturePage();
        await writeFile(process.env.HARNESS_CAPTURE, image.toPNG());
        app.quit();
      }, Number(process.env.HARNESS_CAPTURE_DELAY ?? 700));
    });
  }
}

app.whenReady().then(async () => {
  await store.init(app.getPath('userData'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ------------------------------------------------------------------- models

ipcMain.handle('models:list', async () => loadConfig(app.getPath('userData')));

ipcMain.handle('models:edit', async () => {
  const file = configPath(app.getPath('userData'));
  await shell.openPath(file);
  return file;
});

ipcMain.handle('models:reload', async () => {
  resetClients(); // pick up changed base URLs and keys
  return loadConfig(app.getPath('userData'));
});

// ----------------------------------------------------------------- sessions

ipcMain.handle('sessions:list', async () => store.list());

ipcMain.handle('sessions:create', async (_e, { name, model, projectDir, system }) => {
  const session = store.newSession({ name, model, projectDir, system });
  await store.save(session);
  open.set(session.id, session);
  return session;
});

ipcMain.handle('sessions:open', async (_e, id) => {
  const session = await store.load(id);
  open.set(id, session);
  return session;
});

ipcMain.handle('sessions:delete', async (_e, id) => {
  open.delete(id);
  await store.remove(id);
  return true;
});

ipcMain.handle('sessions:fork', async (_e, { id, model, name, projectDir }) => {
  const twin = await store.fork(id, { model, name, projectDir });
  open.set(twin.id, twin);
  return twin;
});

ipcMain.handle('sessions:update', async (_e, { id, patch }) => {
  const session = open.get(id) ?? (await store.load(id));
  Object.assign(session, patch);
  await store.save(session);
  open.set(id, session);
  return session;
});

ipcMain.handle('sessions:stats', async (_e, id) => {
  const session = open.get(id) ?? (await store.load(id));
  const { models } = await loadConfig(app.getPath('userData'));
  return tally(session.events, models);
});

// --------------------------------------------------------------------- turns

ipcMain.handle('session:send', async (_e, { id, text }) => {
  if (running.has(id)) return { ok: false, error: 'a turn is already running for this session' };

  const session = open.get(id) ?? (await store.load(id));
  open.set(id, session);

  const { models, error } = await loadConfig(app.getPath('userData'));
  if (error) return { ok: false, error };

  const controller = new AbortController();
  running.set(id, controller);

  const send = (channel, payload) => {
    if (!win?.isDestroyed()) win.webContents.send(channel, { id, ...payload });
  };

  try {
    await runTurn({
      session,
      models,
      userText: text,
      signal: controller.signal,
      save: (s) => store.save(s),
      onEvent: (event) => send('turn:event', { event }),
      onDelta: (delta) => send('turn:delta', { delta }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    running.delete(id);
    send('turn:done', {});
  }
});

ipcMain.handle('session:stop', async (_e, id) => {
  running.get(id)?.abort();
  return running.has(id);
});

// -------------------------------------------------------------------- misc

ipcMain.handle('dialog:chooseDir', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: defaultPath || app.getPath('home'),
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('shell:reveal', async (_e, target) => {
  await shell.openPath(target);
  return true;
});

ipcMain.handle('app:paths', async () => ({
  userData: app.getPath('userData'),
  home: app.getPath('home'),
}));

// CommonJS on purpose: Electron loads preload scripts as CJS.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('harness', {
  models: {
    list: () => invoke('models:list'),
    edit: () => invoke('models:edit'),
    reload: () => invoke('models:reload'),
  },
  sessions: {
    list: () => invoke('sessions:list'),
    create: (opts) => invoke('sessions:create', opts),
    open: (id) => invoke('sessions:open', id),
    remove: (id) => invoke('sessions:delete', id),
    fork: (opts) => invoke('sessions:fork', opts),
    update: (id, patch) => invoke('sessions:update', { id, patch }),
    stats: (id) => invoke('sessions:stats', id),
  },
  turn: {
    send: (id, text) => invoke('session:send', { id, text }),
    stop: (id) => invoke('session:stop', id),
    onEvent: (cb) => ipcRenderer.on('turn:event', (_e, p) => cb(p)),
    onDelta: (cb) => ipcRenderer.on('turn:delta', (_e, p) => cb(p)),
    onDone: (cb) => ipcRenderer.on('turn:done', (_e, p) => cb(p)),
  },
  chooseDir: (defaultPath) => invoke('dialog:chooseDir', defaultPath),
  reveal: (target) => invoke('shell:reveal', target),
  paths: () => invoke('app:paths'),
});

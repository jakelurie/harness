/**
 * Apps: the things that actually exist.
 *
 * A session is a worker — it starts, does something, and ends. An app outlives
 * every session that touched it: it has a directory, a repository, a port, a
 * command that starts it, and two addresses the user can open. Turning the
 * laptop off and on should lose nothing except the running process, which the
 * dashboard can start again.
 *
 * Several sessions attach to one app on purpose. That is how the user compares
 * models: one app, two sessions, a different agent in each.
 */

import { exec, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { refuseAsProjectDir } from './harness-guard.js';

const execAsync = promisify(exec);

/** The harness owns 8787 and its hostname on 80/443; an app may never take those. */
const HARNESS_PORTS = new Set([80, 443, 8787]);
const APP_PORT_RANGE = [4300, 4399];   // where an app's own server listens
const SERVE_PORT_RANGE = [8443, 8542]; // the HTTPS port Tailscale publishes it on

const TAILSCALE_SOCK = path.join(os.homedir(), '.tailscale-harness', 'tailscaled.sock');

export function appsPath(userDataDir) {
  return path.join(userDataDir, 'apps.json');
}

export async function load(userDataDir) {
  try {
    const raw = JSON.parse(await fs.readFile(appsPath(userDataDir), 'utf8'));
    return Array.isArray(raw.apps) ? raw.apps : [];
  } catch {
    return [];
  }
}

async function persist(userDataDir, apps) {
  await fs.mkdir(userDataDir, { recursive: true });
  const file = appsPath(userDataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify({ apps }, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return apps;
}

const slug = (s) => String(s || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'app';

function pickPort(taken, [lo, hi]) {
  for (let p = lo; p <= hi; p += 1) {
    if (!taken.has(p) && !HARNESS_PORTS.has(p)) return p;
  }
  throw new Error('no free port left in the app range');
}

/** The tailnet name this machine publishes under, or null if tailscale is not up. */
let cachedHost = null;
export async function tailnetHost() {
  if (cachedHost !== null) return cachedHost;
  try {
    const { stdout } = await execAsync(`tailscale --socket=${JSON.stringify(TAILSCALE_SOCK)} status --json`, { timeout: 5000 });
    cachedHost = JSON.parse(stdout)?.Self?.DNSName?.replace(/\.$/, '') ?? null;
  } catch {
    cachedHost = null;
  }
  return cachedHost;
}

/**
 * Both addresses, always together.
 *
 * The harness's tailscaled runs with userspace networking: it serves the
 * tailnet but creates no interface on this machine, so the laptop cannot
 * resolve its own .ts.net name. One address is therefore never enough — the
 * phone needs the tailnet one and the laptop needs the loopback one.
 */
export function urlsFor(app, host) {
  return {
    phone: host && app.servePort ? `https://${host}:${app.servePort}` : null,
    desktop: app.port ? `http://127.0.0.1:${app.port}` : null,
  };
}

/** Is anything listening on the app's port right now? */
export async function isRunning(app) {
  if (!app.port) return false;
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${app.port} -sTCP:LISTEN -t`, { timeout: 4000 });
    return stdout.trim().length > 0;
  } catch {
    return false;   // lsof exits non-zero when nothing matches
  }
}

/** The pids currently holding the app's port. */
async function pidsOnPort(port) {
  try {
    const { stdout } = await execAsync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { timeout: 4000 });
    return stdout.trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

export async function create(userDataDir, { name, dir, start = '', repo = null }) {
  const refusal = refuseAsProjectDir(dir);
  if (refusal) throw new Error(refusal);
  if (!dir) throw new Error('an app needs a directory');

  const apps = await load(userDataDir);
  if (apps.some((a) => path.resolve(a.dir) === path.resolve(dir))) {
    throw new Error('an app already exists for that directory');
  }

  const app = {
    id: `${slug(name)}-${Date.now().toString(36)}`,
    name: name || path.basename(dir),
    dir: path.resolve(dir),
    repo,
    start,
    port: pickPort(new Set(apps.map((a) => a.port)), APP_PORT_RANGE),
    servePort: pickPort(new Set(apps.map((a) => a.servePort)), SERVE_PORT_RANGE),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastStartedAt: null,
    pid: null,
  };
  await fs.mkdir(app.dir, { recursive: true });
  apps.push(app);
  await persist(userDataDir, apps);
  return app;
}

export async function update(userDataDir, id, patch) {
  const apps = await load(userDataDir);
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error('no such app');
  if (patch.dir) {
    const refusal = refuseAsProjectDir(patch.dir);
    if (refusal) throw new Error(refusal);
  }
  // Ports may be changed — an app already running on a port it chose itself
  // needs to be able to say so — but never onto the harness's, and never onto
  // one another app has already claimed.
  for (const key of ['port', 'servePort']) {
    if (patch[key] === undefined) continue;
    const port = Number(patch[key]);
    // The harness check comes first so 80 and 443 are refused for the real
    // reason rather than for being privileged ports.
    if (HARNESS_PORTS.has(port) || port === 8787) {
      throw new Error(`${port} belongs to the harness, which must stay reachable`);
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`${port} is not a usable port`);
    }
    if (apps.some((a) => a.id !== id && (a.port === port || a.servePort === port))) {
      throw new Error(`another app already uses port ${port}`);
    }
    patch[key] = port;
  }
  Object.assign(app, patch, { updatedAt: Date.now() });
  await persist(userDataDir, apps);
  return app;
}

export async function remove(userDataDir, id) {
  const apps = await load(userDataDir);
  const next = apps.filter((a) => a.id !== id);
  await persist(userDataDir, next);
  return next;
}

export function logPath(userDataDir, app) {
  return path.join(userDataDir, 'app-logs', `${app.id}.log`);
}

/** Publish the app on its own Tailscale port. Idempotent; never touches the harness's. */
async function ensureServe(app) {
  if (HARNESS_PORTS.has(app.servePort) || app.servePort === 8787) {
    throw new Error(`refusing to publish on ${app.servePort}: that belongs to the harness`);
  }
  try {
    await execAsync(
      `tailscale --socket=${JSON.stringify(TAILSCALE_SOCK)} serve --bg --https=${app.servePort} http://127.0.0.1:${app.port}`,
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;   // the app still works locally; say so rather than failing the start
  }
}

export async function start(userDataDir, id) {
  const apps = await load(userDataDir);
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error('no such app');
  if (!app.start?.trim()) throw new Error('this app has no start command yet');
  if (await isRunning(app)) return { app, already: true, served: await ensureServe(app) };

  const file = logPath(userDataDir, app);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const out = createWriteStream(file, { flags: 'a' });
  await new Promise((r) => out.on('open', r));
  out.write(`\n=== started ${new Date().toISOString()} ===\n`);

  // Detached, so the app outlives the turn that started it and the harness
  // restarting does not take every app down with it.
  const child = spawn('/bin/sh', ['-lc', app.start], {
    cwd: app.dir,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(app.port) },
  });
  child.unref();

  app.pid = child.pid;
  app.lastStartedAt = Date.now();
  await persist(userDataDir, apps);

  const served = await ensureServe(app);
  return { app, already: false, served };
}

export async function stop(userDataDir, id) {
  const apps = await load(userDataDir);
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error('no such app');

  // Whatever is actually holding the port, not just the pid recorded at start:
  // a dev server that re-execs itself leaves the original pid meaningless.
  const pids = new Set([...(await pidsOnPort(app.port)), ...(app.pid ? [app.pid] : [])]);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await new Promise((r) => { setTimeout(r, 600); });
  for (const pid of await pidsOnPort(app.port)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  app.pid = null;
  await persist(userDataDir, apps);

  // Fail closed: report what is true rather than claiming a stop we cannot see.
  const stillUp = await isRunning(app);
  return { app, stopped: !stillUp, unconfirmed: stillUp };
}

/** Everything the dashboard needs, with live status folded in. */
export async function listWithStatus(userDataDir) {
  const apps = await load(userDataDir);
  const host = await tailnetHost();
  return Promise.all(apps.map(async (app) => ({
    ...app,
    running: await isRunning(app),
    urls: urlsFor(app, host),
  })));
}

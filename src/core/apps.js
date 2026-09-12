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
import http from 'node:http';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { refuseAsProjectDir, isProtected, protectedRoots } from './harness-guard.js';

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

/**
 * Every listening process on the machine, with the folder it is working in.
 *
 * The folder is what ties a process to an app. Checking only the port the
 * registry allocated missed every server a session had started for itself on a
 * port of its own choosing — which is most of them, since sessions were
 * starting servers long before apps existed. An app whose service was plainly
 * up would still be listed as stopped.
 */
export async function listeningProcesses() {
  let listeners = '';
  try {
    ({ stdout: listeners } = await execAsync('lsof -nP -iTCP -sTCP:LISTEN -FpPn', { timeout: 6000 }));
  } catch {
    return [];
  }

  // lsof -F emits records as p<pid>, then n<addr> / P<proto> per file.
  const found = [];
  let pid = null;
  for (const line of listeners.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const port = Number(line.slice(1).split(':').pop());
      if (Number.isInteger(port)) found.push({ pid, port });
    }
  }
  if (!found.length) return [];

  // One more call for all of their working directories, rather than one each.
  const pids = [...new Set(found.map((f) => f.pid))];
  let cwds = '';
  try {
    ({ stdout: cwds } = await execAsync(`lsof -a -p ${pids.join(',')} -d cwd -Fpn`, { timeout: 6000 }));
  } catch { /* without cwds the port match still works */ }

  const byPid = new Map();
  let cur = null;
  for (const line of cwds.split('\n')) {
    if (line.startsWith('p')) cur = Number(line.slice(1));
    else if (line.startsWith('n') && cur) byPid.set(cur, line.slice(1));
  }
  return found.map((f) => ({ ...f, cwd: byPid.get(f.pid) ?? null }));
}

function isInsideDir(dir, candidate) {
  if (!candidate) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * May this directory be used to claim running processes as an app's?
 *
 * Only a directory specific enough to mean one project. A broad one — `/Users`,
 * a home folder, anything shallow — would match half the machine, and since
 * matching is what `stop` kills by, that is not a cosmetic mistake: it takes
 * down every unrelated server whose working directory happens to sit beneath
 * it. The same rule that guards deleting a folder guards claiming processes.
 */
function canMatchByDir(dir) {
  return Boolean(dir) && refuseToDeleteDir(dir) === null;
}

/**
 * Is this app up, and on which port really?
 *
 * A process counts as the app's when it is listening from inside the app's
 * folder, whatever port it chose. The allocated port still counts, so an app
 * the dashboard started is recognised too.
 */
export function runningInfo(app, procs) {
  const byDir = canMatchByDir(app.dir);
  const mine = procs.filter((p) => {
    if (p.pid === process.pid) return false;          // never the harness itself
    if (app.port && p.port === app.port) return true;
    return byDir && isInsideDir(app.dir, p.cwd);
  });
  if (!mine.length) return { running: false, port: app.port, pids: [], adopted: false };
  // Prefer the allocated port when it is one of them, so a dashboard-started
  // app keeps its own address.
  const onAllocated = mine.find((p) => p.port === app.port);
  const chosen = onAllocated ?? mine[0];
  return {
    running: true,
    port: chosen.port,
    pids: [...new Set(mine.map((p) => p.pid))],
    adopted: !onAllocated,   // started by a session, on a port of its own
  };
}

/** Is anything belonging to this app listening right now? */
export async function isRunning(app) {
  return runningInfo(app, await listeningProcesses()).running;
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

/** Retire the app's Tailscale entry, so its URL stops resolving to nothing. */
async function unserve(app) {
  if (!app.servePort || HARNESS_PORTS.has(app.servePort) || app.servePort === 8787) return false;
  try {
    await execAsync(
      `tailscale --socket=${JSON.stringify(TAILSCALE_SOCK)} serve --https=${app.servePort} off`,
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse to delete a folder that is not squarely the app's own.
 *
 * Deleting a directory tree is the one action here with no undo, so it is
 * gated on more than the caller meaning well: the path must be the app's
 * recorded directory, absolute, several levels deep, and nowhere near the home
 * folder or the harness.
 */
export function refuseToDeleteDir(dir, home = os.homedir()) {
  if (!dir) return 'no directory recorded';
  const abs = path.resolve(dir);
  if (abs === '/' || abs.split(path.sep).filter(Boolean).length < 3) {
    return `${abs} is too close to the root of the disk to delete`;
  }
  if (abs === path.resolve(home)) return 'that is your home folder';
  if (isProtected(abs)) return 'that is inside the harness itself';
  // A directory that contains the home folder or the harness is never an app.
  for (const root of [path.resolve(home), ...protectedRoots()]) {
    const rel = path.relative(abs, root);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return `${abs} contains ${root}`;
    }
  }
  return null;
}

/**
 * Remove an app for good.
 *
 * Forgetting the record alone left the process running, the Tailscale entry
 * pointing at a dead port, the log on disk and the folder untouched — so
 * "deleted" apps kept answering. Each part is reported separately rather than
 * summarised as success, because the folder is the one that cannot be undone.
 */
export async function destroy(userDataDir, id, { files = false } = {}) {
  const apps = await load(userDataDir);
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error('no such app');

  const done = { name: app.name, stopped: null, unserved: false, log: false, dir: null, dirError: null };

  if (await isRunning(app)) {
    const res = await stop(userDataDir, id);
    done.stopped = res.stopped;
  }
  done.unserved = await unserve(app);

  await fs.rm(logPath(userDataDir, app), { force: true }).then(() => { done.log = true; }).catch(() => {});

  if (files) {
    const refusal = refuseToDeleteDir(app.dir);
    if (refusal) {
      done.dirError = refusal;
    } else {
      try {
        await fs.rm(app.dir, { recursive: true, force: true });
        done.dir = app.dir;
      } catch (e) {
        done.dirError = e.message;
      }
    }
  }

  await remove(userDataDir, id);
  return done;
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

  // Already up — possibly on a port a session chose. Adopt it rather than
  // starting a second copy, and publish the port it is really on.
  const live = runningInfo(app, await listeningProcesses());
  if (live.running) {
    return { app, already: true, adopted: live.adopted, livePort: live.port,
      served: await ensureServe({ ...app, port: live.port }) };
  }
  if (!app.start?.trim()) throw new Error('this app has no start command yet');

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

  // Wait for it to claim a port before publishing. A dev server often ignores
  // PORT and uses one from its own config, and publishing the allocated port
  // then points the phone's link at nothing.
  let bound = null;
  for (let i = 0; i < 20 && !bound; i += 1) {
    await new Promise((r) => { setTimeout(r, 500); });
    const info = runningInfo(app, await listeningProcesses());
    if (info.running) bound = info.port;
  }

  const served = await ensureServe({ ...app, port: bound ?? app.port });
  return { app, already: false, served, livePort: bound, listening: Boolean(bound) };
}

/**
 * launchd jobs that supervise this app.
 *
 * A session can register a server with `launchctl submit` so it survives a
 * crash — which also means it survives being killed. When the harness sends
 * SIGTERM, launchd sees the process die and starts a fresh one, so the app
 * "comes back" a second after Stop and the whole thing looks broken. Stopping
 * for real means unregistering the job, not fighting its supervisor.
 *
 * Two gates before ever touching a job: the label must be in a user namespace
 * (`local.` or `harness.`), never Apple's, and the job's own configuration must
 * name this app's directory. Both must hold, so a system job can never match.
 */
async function launchdJobsFor(app) {
  if (process.platform !== 'darwin' || !app.dir) return [];
  let listing = '';
  try {
    ({ stdout: listing } = await execAsync('launchctl list', { timeout: 6000 }));
  } catch {
    return [];
  }
  const labels = listing.split('\n').slice(1)
    .map((line) => line.split('\t')[2])
    .filter((label) => label && (label.startsWith('local.') || label.startsWith('harness.')));

  const dir = path.resolve(app.dir);
  // The directory as a path component: at the end, or followed by a separator,
  // a closing quote, or whitespace. This catches it wherever launchd records
  // it — a log path (dir + "/"), a bare argument (dir + '"'), or embedded in a
  // command string (dir + " ") — without matching a longer path that merely
  // starts with the same characters.
  const boundary = new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[/"\\s]|$)`);

  const mine = [];
  for (const label of labels) {
    try {
      const { stdout: info } = await execAsync(`launchctl list ${JSON.stringify(label)}`, { timeout: 5000 });
      if (boundary.test(info)) mine.push(label);
    } catch { /* the job vanished between listing and inspecting it */ }
  }
  return mine;
}

export async function stop(userDataDir, id) {
  const apps = await load(userDataDir);
  const app = apps.find((a) => a.id === id);
  if (!app) throw new Error('no such app');

  // First unregister any launchd job supervising this app. Kill the process
  // while its supervisor is still live and launchd just respawns it — which is
  // exactly the "I hit Stop and it came back" bug. `launchctl remove` both
  // unloads the job and stops its process.
  const jobs = await launchdJobsFor(app);
  for (const label of jobs) {
    try { await execAsync(`launchctl remove ${JSON.stringify(label)}`, { timeout: 5000 }); } catch { /* already gone */ }
  }
  if (jobs.length) await new Promise((r) => { setTimeout(r, 400); });

  // Whatever is actually running for this app — matched by its folder as well
  // as its port, since a session-started server chose its own — not just the
  // pid recorded at launch, which a dev server that re-execs itself invalidates.
  const info = runningInfo(app, await listeningProcesses());
  const pids = new Set([
    ...info.pids,
    ...(await pidsOnPort(app.port)),
    ...(app.pid ? [app.pid] : []),
  ]);
  // Stopping an app must never be able to stop the harness that is running it.
  pids.delete(process.pid);
  pids.delete(process.ppid);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await new Promise((r) => { setTimeout(r, 600); });
  for (const pid of runningInfo(app, await listeningProcesses()).pids) {
    if (pid === process.pid || pid === process.ppid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }

  app.pid = null;
  await persist(userDataDir, apps);

  // Fail closed: report what is true rather than claiming a stop we cannot see.
  const stillUp = await isRunning(app);
  return { app, stopped: !stillUp, unconfirmed: stillUp, launchdRemoved: jobs };
}

/**
 * Everything the dashboard needs, with live status folded in.
 *
 * `livePort` is the port the app is actually answering on, which is not always
 * the one allocated to it: a session that started the server picked its own.
 * The links follow the live port, because a link to the allocated one would
 * simply fail while the app is plainly up.
 */
/**
 * The Tailscale serve table, as { publishedPort: localPort }.
 *
 * This is the truth about which phone URLs actually route somewhere. A card
 * that shows a phone link without a matching entry here is showing a dead URL —
 * which is exactly what happened when a session started an app itself and no
 * serve entry was ever created for it.
 */
export async function serveMap() {
  try {
    const { stdout } = await execAsync(
      `tailscale --socket=${JSON.stringify(TAILSCALE_SOCK)} serve status`, { timeout: 6000 });
    const map = {};
    let port = null;
    for (const line of stdout.split('\n')) {
      const h = line.match(/^https:\/\/[^\s:]+:(\d+)/);
      if (h) { port = Number(h[1]); continue; }
      const pr = line.match(/proxy http:\/\/127\.0\.0\.1:(\d+)/);
      if (pr && port) { map[port] = Number(pr[1]); port = null; }
    }
    return map;
  } catch {
    return null;   // tailscale down: phone links cannot be trusted, so none are shown
  }
}

/** Does the app actually answer HTTP on this port, or is the port merely held? */
function httpReachable(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 3500 }, (res) => {
      res.resume();
      resolve(true);   // any HTTP response, including a redirect or error page, means it is up
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

export async function listWithStatus(userDataDir) {
  const apps = await load(userDataDir);
  const host = await tailnetHost();
  const procs = await listeningProcesses();
  const map = await serveMap();

  return Promise.all(apps.map(async (app) => {
    const info = runningInfo(app, procs);
    let reachable = false;
    let served = false;
    let phone = null;
    let desktop = null;

    if (info.running) {
      // "Running" must mean it actually answers, not just that the port is held
      // while it starts up. A link is only offered once this is true.
      reachable = await httpReachable(info.port);

      if (map !== null) {
        // The phone link routes through Tailscale. Present it only when a serve
        // entry actually points at the live port — and if it is missing or
        // stale (a session started the app on its own port), heal it here so
        // the link the user is about to see works.
        if (map[app.servePort] === info.port) served = true;
        else served = await ensureServe({ ...app, port: info.port });
      }

      desktop = reachable ? `http://127.0.0.1:${info.port}` : null;
      phone = reachable && served && host ? `https://${host}:${app.servePort}` : null;
    }

    return {
      ...app,
      running: info.running,
      reachable,
      served,
      livePort: info.running ? info.port : null,
      adopted: info.adopted,
      pids: info.pids,
      urls: { phone, desktop },
    };
  }));
}

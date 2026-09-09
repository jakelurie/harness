/**
 * User- and agent-defined monitors.
 *
 * The built-in process list only knows the shapes it was taught, which is the
 * wrong design: the next job might be a Go binary, a container, a launchd
 * agent or an HTTP health check. So monitoring is data, not code. A monitor is
 * a small JSON record describing how to sample something; the phone renders
 * whatever records exist without knowing what they mean.
 *
 * Crucially the agent can write these itself with the file tools it already
 * has - no new capability, no code change - so "monitor this for me" is a
 * thing it can just do.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export const KINDS = ['command', 'file', 'process', 'http', 'panel'];

export function monitorsPath(userDataDir) {
  return path.join(userDataDir, 'monitors.json');
}

export async function loadMonitors(userDataDir, { session } = {}) {
  let all;
  try {
    const raw = JSON.parse(await fs.readFile(monitorsPath(userDataDir), 'utf8'));
    all = Array.isArray(raw) ? raw : (raw.monitors ?? []);
  } catch {
    return [];
  }
  if (session === undefined) return all;
  // A monitor with no session is global and shows everywhere; one carrying a
  // session id belongs to that session's own panel.
  return all.filter((m) => !m.session || m.session === session);
}

export async function saveMonitors(userDataDir, monitors) {
  const file = monitorsPath(userDataDir);
  await fs.mkdir(userDataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(monitors, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return monitors;
}

export async function upsertMonitor(userDataDir, monitor) {
  if (!monitor?.id) throw new Error('a monitor needs an id');
  if (!KINDS.includes(monitor.kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`);

  const all = await loadMonitors(userDataDir);
  const at = all.findIndex((m) => m.id === monitor.id);
  if (at === -1) all.push(monitor);
  else all[at] = { ...all[at], ...monitor };
  return saveMonitors(userDataDir, all);
}

export async function removeMonitor(userDataDir, id) {
  const all = await loadMonitors(userDataDir);
  return saveMonitors(userDataDir, all.filter((m) => m.id !== id));
}

/** This process and everything that spawned it, so a monitor never counts itself. */
async function selfAncestry() {
  const out = new Set([process.pid, process.ppid]);
  const listing = await new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid='], { timeout: 4000 }, (err, so) => resolve(err ? '' : so));
  });

  const parents = new Map();
  for (const line of listing.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(pid)) parents.set(pid, ppid);
  }
  let cursor = process.pid;
  for (let i = 0; i < 24 && parents.has(cursor); i += 1) {
    cursor = parents.get(cursor);
    if (!cursor || cursor <= 1) break;
    out.add(cursor);
  }
  return out;
}

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000, maxBuffer: 4e6, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '') + (stderr || ''), error: err?.message ?? null }));
  });

/** Sample one monitor. Never throws: a broken monitor reports, it does not crash. */
export async function sample(monitor, { tailBytes = 8000 } = {}) {
  const base = {
    id: monitor.id, label: monitor.label ?? monitor.id, kind: monitor.kind,
    session: monitor.session ?? null, role: monitor.role ?? null, at: Date.now(),
  };
  try {
    if (monitor.kind === 'command') {
      const r = await run('/bin/sh', ['-c', monitor.command], { cwd: monitor.cwd || undefined });
      return { ...base, ok: r.ok, text: r.out.slice(-tailBytes), error: r.error };
    }

    if (monitor.kind === 'file') {
      const st = await fs.stat(monitor.path);
      const span = Math.min(tailBytes, st.size);
      const fh = await fs.open(monitor.path, 'r');
      const buf = Buffer.alloc(span);
      await fh.read(buf, 0, span, Math.max(0, st.size - span));
      await fh.close();
      return { ...base, ok: true, text: buf.toString('utf8'), meta: { size: st.size, modified: st.mtimeMs } };
    }

    if (monitor.kind === 'process') {
      // A pattern matches any command line containing it - including this
      // process and the shell that asked, whose arguments carry the pattern
      // itself. Excluding our own ancestry stops a monitor reporting itself.
      const mine = await selfAncestry();
      const r = await run('/bin/sh', ['-c',
        `ps -eo pid=,etime=,pcpu=,rss=,command= | grep -F ${JSON.stringify(monitor.match)} | grep -v grep`]);

      const lines = (r.out.trim() ? r.out.trim().split('\n') : []).filter((l) => {
        const pid = Number(l.trim().split(/\s+/)[0]);
        return Number.isFinite(pid) && !mine.has(pid);
      });
      return { ...base, ok: true, count: lines.length, text: lines.join('\n') || 'not running' };
    }

    if (monitor.kind === 'http') {
      const started = Date.now();
      const res = await fetch(monitor.url, { signal: AbortSignal.timeout(8000) });
      const body = (await res.text()).slice(0, tailBytes);
      return { ...base, ok: res.ok, status: res.status, ms: Date.now() - started, text: body };
    }

    // A panel is the agent building its own UI: a command that prints HTML,
    // rendered as-is. Anything it can compute, it can display.
    if (monitor.kind === 'panel') {
      const r = await run('/bin/sh', ['-c', monitor.command], { cwd: monitor.cwd || undefined });
      return { ...base, ok: r.ok, html: r.out.slice(0, 200_000), error: r.error };
    }

    return { ...base, ok: false, error: `unknown kind "${monitor.kind}"` };
  } catch (e) {
    return { ...base, ok: false, error: e?.message ?? String(e) };
  }
}

export async function sampleAll(monitors, opts) {
  return Promise.all(monitors.map((m) => sample(m, opts)));
}

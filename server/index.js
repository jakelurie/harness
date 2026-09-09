/**
 * LAN server: the same harness core, driven from a phone.
 *
 * Everything here is a thin shell over src/core - the identical agent loop,
 * store and providers the desktop app uses, against the identical data
 * directory. A session started on the phone opens in the desktop app and the
 * other way round.
 *
 * Access control: this process runs shell commands on this machine, so every
 * request must carry the token printed at startup. The token is bound into the
 * URL once and then kept in a cookie.
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTurn } from '../src/core/agent.js';
import { loadConfig, patchModel } from '../src/core/config.js';
import { resetClients } from '../src/core/providers/index.js';
import { setSecret } from '../src/core/secrets.js';
import * as attachments from '../src/core/attachments.js';
import * as git from '../src/core/git.js';
import { loadNotify, saveNotify, send as sendNotify, summarise } from '../src/core/notify.js';
import * as store from '../src/core/store.js';
import { noteEvent, tally } from '../src/core/transcript.js';
import { normalizeProviderLimits, WINDOWS } from '../src/core/usage.js';
import * as usageStore from '../src/core/usage-store.js';
import {
  KINDS, loadMonitors, monitorsPath, removeMonitor, sampleAll, upsertMonitor,
} from '../src/core/monitors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');

const PORT = Number(process.env.HARNESS_PORT ?? 8787);

// Share the desktop app's data directory so both frontends see one set of
// sessions. This is Electron's app.getPath('userData') for productName Harness.
const USER_DATA =
  process.env.HARNESS_DATA_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'harness');

let TOKEN = '';              // resolved from disk at startup
let usage = null;            // the usage ledger, loaded at startup
let usageDirty = false;

/**
 * Fold whatever is new into the usage ledger.
 *
 * Only sessions that changed since their cursor are opened, so a quiet pass
 * reads nothing but the session index.
 */
async function collectUsage({ force = false } = {}) {
  if (!usage) return;
  const cfg = await loadConfig(USER_DATA);
  const listed = await store.list();
  const seen = new Set();
  let added = 0;

  for (const meta of listed) {
    seen.add(meta.id);
    const cursor = usage.cursors[meta.id];
    // Untouched since we last looked: nothing to read.
    if (!force && cursor && meta.updatedAt && meta.updatedAt <= cursor.ts) continue;

    const session = live.get(meta.id) ?? (await store.load(meta.id, { repair: false }).catch(() => null));
    if (session) added += usageStore.ingestSession(usage, session, cfg.models);
  }

  // Forget sessions that no longer exist, so cursors do not accumulate.
  for (const id of Object.keys(usage.cursors)) {
    if (!seen.has(id)) delete usage.cursors[id];
  }

  if (added || usageDirty) {
    usageStore.prune(usage);
    usage.updatedAt = Date.now();
    await usageStore.save(USER_DATA, usage);
    usageDirty = false;
  }
  return added;
}

const running = new Map();   // sessionId -> { controller, startedAt, last }
const live = new Map();      // sessionId -> the session object a turn is mutating
const providerLimits = new Map(); // model alias -> its last reported rate-limit info
const listeners = new Map(); // sessionId -> Set<ServerResponse>

/**
 * Open by default: on a home network the URL alone is the key, and a token in
 * the address bar is friction for the person who owns the machine.
 *
 * Set HARNESS_TOKEN=<secret> to require one, or HARNESS_TOKEN=auto to generate
 * one and keep it on disk so a bookmarked link survives restarts.
 */
async function resolveToken(dir) {
  const want = process.env.HARNESS_TOKEN;
  if (!want) return '';                 // no auth
  if (want !== 'auto') return want;

  const file = path.join(dir, 'server-token');
  try {
    const saved = (await fs.readFile(file, 'utf8')).trim();
    if (saved) return saved;
  } catch {
    // not yet created
  }
  const fresh = crypto.randomBytes(16).toString('hex');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${fresh}\n`, { encoding: 'utf8', mode: 0o600 });
  return fresh;
}

// ---------------------------------------------------------------- utilities

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4_000_000) throw new Error('request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req, url) {
  if (!TOKEN) return true; // open by default
  const supplied =
    url.searchParams.get('t') ||
    req.headers['x-harness-token'] ||
    (req.headers.cookie ?? '').match(/(?:^|;\s*)ht=([^;]+)/)?.[1];
  if (!supplied) return false;

  // Constant-time compare so the token can't be guessed a byte at a time.
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function broadcast(sessionId, payload) {
  const set = listeners.get(sessionId);
  if (!set) return;
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) res.write(frame);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

// Directories that are never a session's output and would swamp the useful
// results if walked.
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.next', '.cache', 'Library', 'screenshots', 'html']);

/** Files under `root` modified at or after `since`, newest first. */
async function filesChangedSince(root, since, max = 400) {
  const out = [];

  async function walk(dir, depth) {
    if (depth > 6 || out.length >= max) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;   // unreadable or vanished — not fatal
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile()) {
        const st = await fs.stat(full).catch(() => null);
        if (st && st.mtimeMs >= since) {
          out.push({
            name: e.name,
            path: full,
            rel: path.relative(root, full),
            size: st.size,
            modified: st.mtimeMs,
            kind: kindOf(e.name),
          });
        }
      }
    }
  }

  await walk(root, 0);
  return out.sort((a, b) => b.modified - a.modified);
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const TEXT_EXT = new Set([
  '.txt', '.md', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.py', '.sh', '.zsh', '.yml', '.yaml', '.toml', '.csv', '.tsv', '.log', '.xml', '.sql', '.env',
  '.gitignore', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.swift', '.kt', '.php',
]);

const MIME_FILE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.pdf': 'application/pdf',
};
for (const ext of TEXT_EXT) MIME_FILE[ext] = 'text/plain; charset=utf-8';

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext) || !ext) return 'text';
  return 'other';
}

/** Where the browser opens when nothing says otherwise. */
function state0Dir() {
  return os.homedir();
}

async function serveStatic(res, name) {
  try {
    const file = path.join(PUBLIC, name);
    if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': `${MIME[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// ------------------------------------------------------------------ routing

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (!authorized(req, url)) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<body style="background:#14161a;color:#d7dbe0;font:16px system-ui;padding:2rem">' +
      '<h2>Harness</h2><p>This link needs its access token. Open the full URL printed on the laptop.</p></body>');
  }

  // First hit carries ?t=; stow it in a cookie so later navigations are clean.
  if (url.searchParams.has('t')) {
    res.setHeader('Set-Cookie', `ht=${TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }

  try {
    // ---- static
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStatic(res, 'index.html');
    }
    if (req.method === 'GET' && /^\/(app\.js|styles\.css)$/.test(pathname)) {
      return serveStatic(res, pathname.slice(1));
    }

    // ---- state
    if (req.method === 'GET' && pathname === '/api/state') {
      const cfg = await loadConfig(USER_DATA);
      const models = Object.fromEntries(
        Object.entries(cfg.models).map(([k, m]) => [k, { ...m, apiKey: undefined }]), // never ship keys back
      );
      return json(res, 200, {
        models,
        default: cfg.default,
        error: cfg.error,
        sessions: (await store.list()).filter((x) => !x.id.endsWith('--monitor')),
        home: os.homedir(),
        running: [...running.keys()],
        // Elapsed time belongs to the turn, not to whoever happens to be
        // watching: a phone that reloads must not restart the clock at zero.
        turns: Object.fromEntries(
          [...running.entries()].map(([k, v]) => [k, { startedAt: v.startedAt, last: v.last }]),
        ),
      });
    }

    // ---- model config, editable from the phone
    if (req.method === 'POST' && pathname === '/api/models/key') {
      const { alias, apiKey } = await readBody(req);
      await setSecret(USER_DATA, alias, apiKey);
      resetClients();
      return json(res, 200, { ok: true });
    }
    // Ask an endpoint what it actually serves. Model ids move faster than
    // anyone's memory, so the authoritative list comes from the provider.
    if (req.method === 'POST' && pathname === '/api/models/discover') {
      const { alias } = await readBody(req);
      const cfg = await loadConfig(USER_DATA);
      const spec = cfg.models[alias];
      if (!spec) return json(res, 404, { error: `no model "${alias}"` });
      if (spec.provider !== 'openai') {
        return json(res, 400, { error: 'only OpenAI-compatible endpoints can be queried' });
      }

      const base = (spec.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
      try {
        const upstream = await fetch(`${base}/models`, {
          headers: spec.apiKey ? { Authorization: `Bearer ${spec.apiKey}` } : {},
          signal: AbortSignal.timeout(15_000),
        });
        const body = await upstream.json().catch(() => ({}));
        if (!upstream.ok) {
          return json(res, 200, {
            ok: false,
            status: upstream.status,
            error: body?.error?.message ?? `endpoint returned ${upstream.status}`,
          });
        }
        const ids = (body.data ?? []).map((m) => m.id).sort();
        return json(res, 200, { ok: true, base, count: ids.length, models: ids });
      } catch (e) {
        return json(res, 200, { ok: false, error: e?.message ?? String(e) });
      }
    }

    if (req.method === 'POST' && pathname === '/api/models/patch') {
      const { alias, patch } = await readBody(req);
      const block = await patchModel(USER_DATA, alias, patch);
      resetClients();
      return json(res, 200, { ok: true, block });
    }

    // ---- directory browsing (no native file dialog on a phone)
    if (req.method === 'GET' && pathname === '/api/dirs') {
      const asked = url.searchParams.get('path') || os.homedir();

      // A directory can be renamed or deleted out from under a saved path. Walk
      // up to the nearest place that still exists rather than failing: a broken
      // path should never be able to wedge the browser.
      let dir = path.resolve(asked);
      let note = null;
      while (dir !== path.dirname(dir)) {
        try {
          if ((await fs.stat(dir)).isDirectory()) break;
        } catch {
          // keep walking up
        }
        dir = path.dirname(dir);
      }
      if (dir !== path.resolve(asked)) note = `${asked} no longer exists — showing ${dir}`;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      return json(res, 200, {
        path: dir,
        note,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        dirs: entries
          .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
          .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    // ---- everything happening for one session, gathered on demand
    // Nothing here runs on a timer: it is sampled only when someone asks,
    // which is the point of the button that triggers it.
    if (req.method === 'GET' && pathname === '/api/activity') {
      const id = url.searchParams.get('session');
      const session = id ? (live.get(id) ?? (await store.load(id, { repair: false }).catch(() => null))) : null;
      const root = session?.projectDir;

      const ps = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid=,ppid=,etime=,pcpu=,rss=,command='], { maxBuffer: 8e6 },
          (err, out) => resolve(err ? '' : out));
      });

      const candidates = [];
      for (const line of ps.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, ppid, etime, pcpu, rss, command] = m;
        if (command.includes('server/index.js') || command.startsWith('ps ')) continue;
        if (!/\b(node|python3?|deno|bun|ruby|go|cargo|java|chromium|Chrome|playwright|ffmpeg|curl|wget|docker|claude)\b/i.test(command)) continue;
        candidates.push({
          pid: Number(pid), ppid: Number(ppid), detached: Number(ppid) === 1,
          etime, cpu: Number(pcpu), rssMb: Math.round(Number(rss) / 1024),
          command: command.slice(0, 300),
        });
      }

      // Belonging to this session means running out of its project directory.
      // That is what makes this per-session without the agent registering
      // anything: ask each candidate where it is working.
      const procs = [];
      await Promise.all(candidates.map((proc) => new Promise((resolve) => {
        execFile('lsof', ['-p', String(proc.pid), '-a', '-d', 'cwd,1', '-Fn'], { timeout: 5000 },
          (err, out) => {
            if (!err) {
              const names = (out ?? '').split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
              proc.cwd = names.find((n) => !n.includes('/dev/')) ?? null;
              proc.log = names.slice(1).find((n) => !n.includes('/dev/') && n !== proc.cwd) ?? null;
            }
            const inProject = root && proc.cwd
              && (proc.cwd === root || proc.cwd.startsWith(`${root}/`) || `/private${root}` === proc.cwd);
            const mentionsProject = root && proc.command.includes(root);
            if (inProject || mentionsProject) procs.push(proc);
            resolve();
          });
      })));
      procs.sort((a, b) => b.cpu - a.cpu);

      // `raw=1` skips monitor sampling. A custom view is itself sampled here, so
      // if it fetched the full endpoint it would re-enter this handler and run
      // itself forever. The view is told to use the raw form.
      const raw = url.searchParams.get('raw') === '1';
      const monitors = !raw && id ? await loadMonitors(USER_DATA, { session: id }) : [];
      const samples = (await sampleAll(monitors)).filter((sm) => sm.session === id);

      return json(res, 200, {
        session: id,
        projectDir: root ?? null,
        running: running.has(id),
        startedAt: running.get(id)?.startedAt ?? null,
        procs,
        samples,
        at: Date.now(),
      });
    }

    // ---- notifications
    if (req.method === 'GET' && pathname === '/api/notify') {
      return json(res, 200, await loadNotify(USER_DATA));
    }
    if (req.method === 'POST' && pathname === '/api/notify') {
      const body = await readBody(req);
      const cfg = await saveNotify(USER_DATA, { ...(await loadNotify(USER_DATA)), ...body });
      return json(res, 200, cfg);
    }
    if (req.method === 'POST' && pathname === '/api/notify/test') {
      const cfg = { ...(await loadNotify(USER_DATA)), ...(await readBody(req)), enabled: true };
      return json(res, 200, await sendNotify(cfg, 'Harness test — notifications are working.'));
    }

    // ---- git
    if (req.method === 'GET' && pathname === '/api/git') {
      const id = url.searchParams.get('session');
      const session = id ? (live.get(id) ?? (await store.load(id, { repair: false }).catch(() => null))) : null;
      if (!session) return json(res, 404, { error: 'no such session' });
      return json(res, 200, { ...(await git.status(session.projectDir)), enabled: Boolean(session.gitPush) });
    }

    if (req.method === 'POST' && pathname === '/api/git/connect') {
      const { session: id, remote } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      const res2 = await git.connect(session.projectDir, remote);
      return json(res, res2.ok ? 200 : 400, res2);
    }

    if (req.method === 'POST' && pathname === '/api/git/visibility') {
      const { session: id, visibility } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      const res2 = visibility
        ? await git.setVisibility(session.projectDir, visibility)
        : await git.visibility(session.projectDir);
      return json(res, 200, res2);
    }

    if (req.method === 'POST' && pathname === '/api/git/push') {
      const { session: id } = await readBody(req);
      const session = live.get(id) ?? (await store.load(id, { repair: false }));
      const last = [...session.events].reverse().find((e) => e.type === 'assistant');
      return json(res, 200, await git.commitAndPush(session.projectDir, {
        model: session.model, servedModel: last?.servedModel,
      }));
    }

    // ---- monitors: whatever the user or the agent asked to watch
    if (req.method === 'GET' && pathname === '/api/monitors') {
      const scope = url.searchParams.get('session') ?? undefined;
      const monitors = await loadMonitors(USER_DATA, { session: scope });
      return json(res, 200, {
        monitors,
        samples: await sampleAll(monitors),
        file: monitorsPath(USER_DATA),
        kinds: KINDS,
      });
    }
    if (req.method === 'POST' && pathname === '/api/monitors') {
      const monitors = await upsertMonitor(USER_DATA, await readBody(req));
      return json(res, 200, { ok: true, monitors });
    }
    if (req.method === 'DELETE' && pathname === '/api/monitors') {
      const { id } = await readBody(req);
      return json(res, 200, { ok: true, monitors: await removeMonitor(USER_DATA, id) });
    }

    // ---- background jobs the agent detached with nohup/&
    if (req.method === 'GET' && pathname === '/api/procs') {
      const ps = await new Promise((resolve) => {
        execFile('ps', ['-eo', 'pid=,ppid=,etime=,pcpu=,rss=,command='], { maxBuffer: 8e6 },
          (err, out) => resolve(err ? '' : out));
      });

      const mine = [];
      for (const line of ps.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        if (!m) continue;
        const [, pid, ppid, etime, pcpu, rss, command] = m;

        // Long-running work the agent started, not the whole machine: node,
        // python, playwright/chrome and the like. The harness's own server and
        // the ps call itself are noise.
        if (!/\b(node|python3?|deno|bun|ruby|playwright|chromium|Google Chrome Helper|curl|wget|ffmpeg)\b/i.test(command)) continue;
        if (command.includes('server/index.js') || command.startsWith('ps ')) continue;

        mine.push({
          pid: Number(pid),
          ppid: Number(ppid),
          detached: Number(ppid) === 1, // nohup'd: survives the turn that spawned it
          etime,
          cpu: Number(pcpu),
          rssMb: Math.round(Number(rss) / 1024),
          command: command.slice(0, 400),
        });
      }

      // A detached job's stdout is usually redirected to a log file; lsof can
      // name it, which is the difference between "something is running" and
      // being able to watch it.
      await Promise.all(mine.map((proc) => new Promise((resolve) => {
        execFile('lsof', ['-p', String(proc.pid), '-a', '-d', '1', '-Fn'], { timeout: 4000 },
          (err, out) => {
            if (!err) {
              const found = (out ?? '').split('\n').find((l) => l.startsWith('n/') && !l.includes('/dev/'));
              if (found) proc.log = found.slice(1);
            }
            resolve();
          });
      })));

      mine.sort((a, b) => b.cpu - a.cpu);
      return json(res, 200, { procs: mine, at: Date.now() });
    }

    if (req.method === 'POST' && pathname === '/api/procs/stop') {
      const { pid, force } = await readBody(req);
      if (!Number.isInteger(pid) || pid <= 1) return json(res, 400, { error: 'bad pid' });
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // ---- usage: a lookup against the ledger, not a scan of transcripts
    if (req.method === 'GET' && pathname === '/api/usage') {
      const window = url.searchParams.get('window') || 'seven_day';
      const cfg = await loadConfig(USER_DATA);

      // A read is a sum over buckets; no transcript is opened here. `refresh=1`
      // forces a collection first, for when a caller wants it up to the second.
      if (url.searchParams.get('refresh') === '1') await collectUsage();

      const span = usageStore.resolvePeriod(usage, window)
        ?? usageStore.resolvePeriod(usage, 'seven_day');
      const models = usageStore.query(usage, { from: span.from, to: span.to, models: cfg.models });

      for (const [alias, spec] of Object.entries(cfg.models)) {
        if (models.some((m) => m.alias === alias)) continue;
        models.push({
          alias, label: spec.label ?? alias, provider: spec.provider,
          turns: 0, input: 0, output: 0, cached: 0, ms: 0, tools: 0, cost: 0,
        });
      }

      const provider = {};
      for (const [alias, saved] of Object.entries(usage.limits ?? {})) {
        provider[alias] = { ...normalizeProviderLimits(saved.info), reportedAt: saved.at };
      }

      return json(res, 200, {
        window,
        windows: Object.keys(WINDOWS),
        models,
        provider,
        sessionCount: Object.keys(usage.cursors).length,
        collectedAt: usage.updatedAt,
      });
    }

    // ---- file browsing: folders AND files, with previews
    if (req.method === 'GET' && pathname === '/api/files') {
      const asked = url.searchParams.get('path') || state0Dir();
      let dir = path.resolve(asked);
      let note = null;
      while (dir !== path.dirname(dir)) {
        try {
          if ((await fs.stat(dir)).isDirectory()) break;
        } catch { /* keep walking up */ }
        dir = path.dirname(dir);
      }
      if (dir !== path.resolve(asked)) note = `${asked} no longer exists — showing ${dir}`;

      const entries = await fs.readdir(dir, { withFileTypes: true });
      const dirs = [];
      const files = [];
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          dirs.push({ name: e.name, path: full });
        } else if (e.isFile()) {
          const size = await fs.stat(full).then((st) => st.size).catch(() => 0);
          files.push({ name: e.name, path: full, size, kind: kindOf(e.name) });
        }
      }
      return json(res, 200, {
        path: dir,
        note,
        parent: path.dirname(dir) === dir ? null : path.dirname(dir),
        dirs: dirs.sort((a, b) => a.name.localeCompare(b.name)),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }

    // ---- one file's contents, for the phone to render
    if (req.method === 'GET' && pathname === '/api/file') {
      const file = path.resolve(url.searchParams.get('path') ?? '');
      const st = await fs.stat(file).catch(() => null);
      if (!st?.isFile()) return json(res, 404, { error: 'not a file' });

      const kind = kindOf(file);
      // A phone should not be asked to swallow a 20 MB page of HTML; text is
      // truncated with a note, images are sent whole.
      const TEXT_CAP = 400_000;
      // For a growing log the interesting end is the last one, so ?tail=1
      // reads from the back instead of the front.
      const wantTail = url.searchParams.get('tail') === '1';
      if (kind === 'text' && (st.size > TEXT_CAP || wantTail)) {
        const span = Math.min(TEXT_CAP, st.size);
        const from = wantTail ? Math.max(0, st.size - span) : 0;
        const fh = await fs.open(file, 'r');
        const buf = Buffer.alloc(span);
        await fh.read(buf, 0, span, from);
        await fh.close();
        const note = st.size > span
          ? (wantTail
            ? `--- showing the last ${span} of ${st.size} bytes ---\n\n`
            : `\n\n--- truncated: showing the first ${span} of ${st.size} bytes ---`)
          : '';
        const body = wantTail ? note + buf.toString('utf8') : buf.toString('utf8') + note;
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(body);
      }

      const body = await fs.readFile(file);
      const download = url.searchParams.get('download') === '1';
      res.writeHead(200, {
        'Content-Type': download
          ? 'application/octet-stream'
          : MIME_FILE[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        ...(download
          ? { 'Content-Disposition': `attachment; filename="${path.basename(file).replace(/"/g, '')}"` }
          : {}),
      });
      return res.end(body);
    }

    // ---- a look at the laptop's screen, for when a tool opens a window
    if (req.method === 'GET' && pathname === '/api/screen') {
      // With the lid shut and no external display, macOS powers the only
      // framebuffer down: screencapture succeeds but returns pure black. Say
      // so rather than handing back a black rectangle that reads as a bug.
      const asleep = await new Promise((resolve) => {
        execFile('system_profiler', ['SPDisplaysDataType'], { timeout: 8000 }, (err, out) =>
          resolve(!err && /Display Asleep:\s*Yes/i.test(out)));
      });
      if (asleep) {
        return json(res, 503, {
          error: 'display asleep',
          detail: 'The laptop screen is off (lid closed, no external display), so there is nothing to capture.',
        });
      }

      const shot = path.join(os.tmpdir(), `harness-screen-${process.pid}.jpg`);
      await new Promise((resolve, reject) => {
        // -x silences the shutter; -t jpg keeps it small enough to poll.
        execFile('screencapture', ['-x', '-t', 'jpg', shot], (err) => (err ? reject(err) : resolve()));
      });
      const body = await fs.readFile(shot);
      await fs.rm(shot, { force: true });
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    if (req.method === 'POST' && pathname === '/api/dirs') {
      const { parent, name } = await readBody(req);
      if (!name || /[/\\]/.test(name)) return json(res, 400, { error: 'invalid folder name' });
      const made = path.join(parent, name);
      await fs.mkdir(made, { recursive: true });
      return json(res, 200, { path: made });
    }

    // ---- sessions
    const m = pathname.match(/^\/api\/sessions(?:\/([^/]+))?(?:\/(\w+))?$/);
    if (m) {
      const [, id, verb] = m;

      if (req.method === 'POST' && !id) {
        const { name, model, projectDir, system, mode } = await readBody(req);
        // Typing a path that does not exist yet is a normal thing to do on a
        // phone; create it now rather than failing on the first tool call.
        if (projectDir) await fs.mkdir(projectDir, { recursive: true });
        const session = store.newSession({ name, model, projectDir, system, mode });
        await store.save(session);
        return json(res, 200, session);
      }
      if (req.method === 'GET' && id && !verb) {
        // While a turn runs, the in-memory copy is the truth; reading the file
        // would race the writer and trip the crash-repair path.
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        session.projectDirMissing = !(await fs
          .stat(session.projectDir)
          .then((st) => st.isDirectory())
          .catch(() => false));
        return json(res, 200, session);
      }
      if (req.method === 'DELETE' && id) {
        running.get(id)?.controller.abort();
        live.delete(id);
        await store.remove(id);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && id) {
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        const patch = await readBody(req);
        if (patch.projectDir) await fs.mkdir(patch.projectDir, { recursive: true });

        // Record a switch in the transcript. Without this there is no evidence
        // it happened, which is exactly how a silently-failed switch goes
        // unnoticed until the answers look wrong.
        const from = session.model;
        Object.assign(session, patch);
        if (patch.model && patch.model !== from) {
          session.events.push(noteEvent(`model switched from ${from} to ${patch.model} — history carries over`));
        }

        await store.save(session);
        return json(res, 200, session);
      }
      if (req.method === 'POST' && id && verb === 'fork') {
        const { model, name } = await readBody(req);
        return json(res, 200, await store.fork(id, { model, name }));
      }
      // The monitoring tab's chat: a companion session that edits the panel
      // instead of the project. Created on first open, not before.
      if (req.method === 'GET' && id && verb === 'monitor') {
        const monitorId = `${id}--monitor`;
        let companion = live.get(monitorId)
          ?? (await store.load(monitorId, { repair: !running.has(monitorId) }).catch(() => null));

        if (!companion) {
          const parent = live.get(id) ?? (await store.load(id, { repair: false }));
          companion = store.newSession({
            name: `monitor: ${parent.name}`,
            model: parent.model,
            projectDir: parent.projectDir,
            system: '',
          });
          companion.id = monitorId;          // deterministic, so it is found again
          companion.monitorFor = id;
          companion.confineToProjectDir = false; // monitors often watch /tmp logs
          await store.save(companion);
        }
        companion.projectDirMissing = !(await fs.stat(companion.projectDir)
          .then((st) => st.isDirectory()).catch(() => false));
        return json(res, 200, companion);
      }

      if (req.method === 'GET' && id && verb === 'stats') {
        const session = live.get(id) ?? (await store.load(id, { repair: !running.has(id) }));
        const { models } = await loadConfig(USER_DATA);
        return json(res, 200, tally(session.events, models));
      }
      if (req.method === 'POST' && id && verb === 'stop') {
        running.get(id)?.controller.abort();
        return json(res, 200, { ok: true });
      }

      // Live transcript. One stream per open phone; several may watch at once.
      if (req.method === 'GET' && id && verb === 'events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const live = running.get(id);
        res.write(`retry: 2000\n\ndata: ${JSON.stringify({
          kind: 'hello',
          running: Boolean(live),
          startedAt: live?.startedAt ?? null,
          last: live?.last ?? null,
        })}\n\n`);

        if (!listeners.has(id)) listeners.set(id, new Set());
        listeners.get(id).add(res);

        // Phones suspend radios aggressively; a heartbeat keeps NAT and the
        // browser from quietly dropping the connection.
        const beat = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(beat);
          listeners.get(id)?.delete(res);
        });
        return undefined;
      }

      // Raw-bytes upload. Multipart would mean a parser and an extra
      // dependency for no benefit; the filename rides in a header.
      if (req.method === 'POST' && id && verb === 'upload') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > attachments.MAX_BYTES) return json(res, 413, { error: 'image too large (25 MB limit)' });
          chunks.push(c);
        }
        if (!size) return json(res, 400, { error: 'empty upload' });

        const name = decodeURIComponent(String(req.headers['x-filename'] ?? 'image.jpg'));
        try {
          const att = await attachments.store(USER_DATA, id, { name, buffer: Buffer.concat(chunks) });
          return json(res, 200, att);
        } catch (e) {
          return json(res, 400, { error: e?.message ?? String(e) });
        }
      }

      if (req.method === 'POST' && id && verb === 'send') {
        if (running.has(id)) return json(res, 409, { error: 'a turn is already running' });

        const { text, attachments: atts } = await readBody(req);
        const session = await store.load(id);
        live.set(id, session);
        const cfg = await loadConfig(USER_DATA);
        if (cfg.error) return json(res, 400, { error: cfg.error });

        const sentAt = session.events.length;
        const controller = new AbortController();
        const turn = { controller, startedAt: Date.now(), last: null };
        running.set(id, turn);
        json(res, 200, { ok: true }); // answer now; the work streams over SSE

        runTurn({
          session,
          models: cfg.models,
          userText: text,
          attachments: Array.isArray(atts) ? atts : [],
          signal: controller.signal,
          save: (s) => store.save(s),
          monitorsFile: monitorsPath(USER_DATA),
          // A ready-to-run command for the monitor companion, so a custom view
          // can reuse the server's own process discovery instead of redoing it.
          activityCmd: `curl -s "http://127.0.0.1:${PORT}/api/activity?session=${
            encodeURIComponent(session.monitorFor ?? session.id)
          }&raw=1&t=$(cat ${JSON.stringify(path.join(USER_DATA, 'server-token'))})"`,
          onEvent: (event) => broadcast(id, { kind: 'event', event }),
          onDelta: (delta) => {
            if (delta.kind === 'tool_start') turn.last = delta.call?.name ?? null;
            if (delta.kind === 'rate_limit') {
              providerLimits.set(session.model, { info: delta.info, at: Date.now() });
              if (usage) {
                usage.limits[session.model] = { info: delta.info, at: Date.now() };
                usageDirty = true;
              }
            }
            broadcast(id, { kind: 'delta', delta });
          },
        })
          .catch((e) => broadcast(id, { kind: 'error', error: e?.message ?? String(e) }))
          .finally(async () => {
            running.delete(id);
            live.delete(id);

            // Commit whatever the turn changed on disk. Failures are reported
            // into the transcript rather than thrown: a git problem should not
            // look like the turn itself failed.
            if (session.gitPush) {
              try {
                const last = [...session.events].reverse().find((e) => e.type === 'assistant');
                const res = await git.commitAndPush(session.projectDir, {
                  model: session.model,
                  servedModel: last?.servedModel,
                });
                if (res.skipped === 'no changes') {
                  // Nothing to say: a turn that changed no files is normal.
                } else if (!res.ok) {
                  session.events.push(noteEvent(`git: ${res.error ?? res.skipped}`));
                } else {
                  const where = res.pushed ? 'pushed' : `committed (not pushed — ${res.reason})`;
                  session.events.push(noteEvent(
                    `git: ${where} ${res.files.length} file${res.files.length === 1 ? '' : 's'} · ${res.sha}`,
                  ));
                }
                if (session.events.at(-1)?.type === 'note') {
                  await store.save(session);
                  broadcast(id, { kind: 'event', event: session.events.at(-1) });
                }
              } catch (e) {
                broadcast(id, { kind: 'error', error: `git: ${e?.message ?? e}` });
              }
            }

            // What this turn actually produced. Asking for a file and then
            // hunting for it is the thing this avoids: it is attached to the
            // reply that made it.
            try {
              const made = await filesChangedSince(session.projectDir, turn.startedAt, 30);
              if (made.length) {
                session.events.push({
                  id: `f_${Date.now().toString(36)}`,
                  ts: Date.now(),
                  type: 'files',
                  files: made,
                });
                await store.save(session);
                broadcast(id, { kind: 'event', event: session.events.at(-1) });
              }
            } catch { /* a scan failure must not affect the turn */ }

            broadcast(id, { kind: 'done' });
            collectUsage().catch(() => {}); // fold the turn in; never block the reply

            // Tell the user it finished. Deliberately after `done`, and never
            // awaited by anything that matters: a notifier is not allowed to
            // delay or break a turn.
            (async () => {
              const cfg = await loadNotify(USER_DATA);
              const seconds = (Date.now() - turn.startedAt) / 1000;
              if (!cfg.enabled || seconds < (cfg.minSeconds ?? 0)) return;

              const since = session.events.slice(sentAt);
              const last = [...since].reverse().find((e) => e.type === 'assistant' && e.text?.trim());
              const res = await sendNotify(cfg, summarise({
                sessionName: session.name,
                model: session.model,
                steps: since.filter((e) => e.type === 'tool_result').length,
                seconds,
                failed: since.some((e) => e.type === 'note' && /error|failed/i.test(e.text)),
                lastText: last?.text,
              }));
              if (!res.ok) {
                session.events.push(noteEvent(`notify: ${res.reason}`));
                await store.save(session);
                broadcast(id, { kind: 'event', event: session.events.at(-1) });
              }
            })().catch(() => {});
          });
        return undefined;
      }
    }

    return json(res, 404, { error: `no route for ${req.method} ${pathname}` });
  } catch (e) {
    return json(res, 500, { error: e?.message ?? String(e) });
  }
});

// -------------------------------------------------------------------- start

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return '127.0.0.1';
}

await store.init(USER_DATA);
TOKEN = await resolveToken(USER_DATA);

usage = await usageStore.load(USER_DATA);
await collectUsage({ force: true });      // catch up on anything missed while down
setInterval(() => collectUsage().catch(() => {}), 60_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const host = `http://${lanAddress()}:${PORT}`;
  console.log(`\n  harness is up for this network\n`);
  console.log(`  ${host}/${TOKEN ? `?t=${TOKEN}` : ''}\n`);
  console.log(`  data: ${USER_DATA}`);
  console.log(TOKEN
    ? '  a token is required. bookmark the bare address; the cookie carries it.\n'
    : '  open to anyone on this network. HARNESS_TOKEN=auto requires a token.\n');
});

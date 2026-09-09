/**
 * Session persistence. A session is one project run: a name, a directory, a
 * model, and the neutral event transcript.
 *
 * Sessions are the unit of comparison. To A/B two models on the same work, run
 * two sessions - or fork one, which copies the history so the second model
 * starts from identical context.
 *
 * Files are written atomically after every event, so a crash costs at most the
 * turn in flight.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { danglingToolCalls, noteEvent, toolResultEvent } from './transcript.js';

let sessionsDir = null;

export function init(userDataDir) {
  sessionsDir = path.join(userDataDir, 'sessions');
  return fs.mkdir(sessionsDir, { recursive: true });
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20) || 'session'
  );
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fileFor(id) {
  return path.join(sessionsDir, `${id}.json`);
}

export function newSession({ name, model, projectDir, system = '', mode = 'agent' }) {
  return {
    id: `${stamp()}-${slug(name)}`,
    name: name || 'untitled',
    model,
    mode,
    projectDir,
    system,
    confineToProjectDir: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    forkedFrom: null,
    events: [],
  };
}

// One in-flight write per session. Steps from an agent backend arrive faster
// than a write completes, and two saves racing on a shared temp filename meant
// the second rename found nothing there — which crashed the server mid-turn.
const writing = new Map();
let writeSeq = 0;

export async function save(session) {
  const prior = writing.get(session.id) ?? Promise.resolve();

  const run = prior
    .catch(() => {})                       // one failed write must not poison the queue
    .then(async () => {
      session.updatedAt = Date.now();
      const file = fileFor(session.id);
      // Unique per write, so concurrent saves cannot collide on the same path.
      const tmp = `${file}.${process.pid}.${(writeSeq += 1)}.tmp`;
      try {
        await fs.writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
        await fs.rename(tmp, file);        // atomic: never a half-written transcript
      } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      return session;
    });

  writing.set(session.id, run);
  try {
    return await run;
  } finally {
    if (writing.get(session.id) === run) writing.delete(session.id);
  }
}

/**
 * @param repair  close out unanswered tool calls left by a crash. Must be off
 *                while a turn is in flight: a tool that has been recorded but
 *                has not returned yet is normal, not damage, and "repairing"
 *                it corrupts a live transcript.
 */
export async function load(id, { repair = true } = {}) {
  const session = JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
  if (!repair) return session;

  // Repair a transcript left mid-turn by a crash or a force-quit. Both APIs
  // reject unanswered tool calls, so the next send would fail with a confusing
  // error unless we close them out here.
  const dangling = danglingToolCalls(session.events ?? []);
  if (dangling.length) {
    for (const d of dangling) {
      session.events.push(
        toolResultEvent({
          callId: d.id,
          name: d.name,
          ok: false,
          output: 'interrupted - the app closed before this tool finished',
        }),
      );
    }
    session.events.push(noteEvent(`recovered ${dangling.length} interrupted tool call(s)`));
    await save(session);
  }

  return session;
}

export async function list() {
  let names;
  try {
    names = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const s = JSON.parse(await fs.readFile(path.join(sessionsDir, n), 'utf8'));
      out.push({
        id: s.id,
        name: s.name,
        model: s.model,
        projectDir: s.projectDir,
        updatedAt: s.updatedAt,
        forkedFrom: s.forkedFrom,
        turns: (s.events ?? []).filter((e) => e.type === 'assistant').length,
        modelsUsed: [...new Set((s.events ?? []).filter((e) => e.type === 'assistant').map((e) => e.model))],
      });
    } catch {
      // Skip a corrupt file rather than hiding every other session.
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function remove(id) {
  await fs.rm(fileFor(id), { force: true });
}

export async function fork(id, { model, name, projectDir }) {
  const src = await load(id);
  const twin = newSession({
    name: name || `${src.name} (${model})`,
    model,
    projectDir: projectDir || src.projectDir,
    system: src.system,
  });
  twin.forkedFrom = src.id;
  twin.confineToProjectDir = src.confineToProjectDir;
  twin.events = structuredClone(src.events);
  twin.events.push(noteEvent(`forked from ${src.name} at turn ${src.events.length} onto ${model}`));
  await save(twin);
  return twin;
}

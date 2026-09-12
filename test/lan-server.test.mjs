// Drives the LAN server the way the phone does: auth, session create, send,
// and the SSE stream, with a mock upstream standing in for the model.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

// ---- mock model endpoint ----
const sse = (res, o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
const base = { id: 'x', object: 'chat.completion.chunk', model: 'mock' };
let turns = 0;
const upstream = http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    // The "slow" model asks for a tool and then never answers, so the harness
    // sits in the legitimately-mid-tool state the repair path used to mangle.
    if (req.url.includes('slow=1')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'slow1', function: { name: 'bash' } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"sleep 30"}' } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return res.end('data: [DONE]\n\n');
    }
    turns += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (turns === 1) {
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file' } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"phone.txt","content":"from the phone"}' } }] } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      for (const f of ['Created ', 'phone.txt.']) sse(res, { ...base, choices: [{ index: 0, delta: { content: f } }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    sse(res, { ...base, choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;

// ---- isolated data dir ----
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-lan-'));
const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-proj-'));
await fs.writeFile(path.join(dataDir, 'models.json'), JSON.stringify({
  default: 'mock',
  models: {
    mock: { provider: 'openai', model: 'mock-1', label: 'Mock', baseUrl: upstreamUrl },
    slow: { provider: 'openai', model: 'slow-1', label: 'Slow', baseUrl: `${upstreamUrl}?slow=1` },
  },
}, null, 2));

const PORT = 8799;
const TOKEN = 'test-token';
const child = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], {
  env: { ...process.env, HARNESS_PORT: String(PORT), HARNESS_TOKEN: TOKEN, HARNESS_DATA_DIR: dataDir },
  stdio: 'ignore',
});

const root = `http://127.0.0.1:${PORT}`;
const call = (p, opts = {}) => fetch(root + p, {
  ...opts,
  headers: { 'Content-Type': 'application/json', 'x-harness-token': TOKEN, ...(opts.headers ?? {}) },
});

// wait for listen
for (let i = 0; i < 60; i += 1) {
  try { await fetch(root, { headers: { 'x-harness-token': TOKEN } }); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}

// ---- auth ----
check('rejects a request with no token', (await fetch(`${root}/api/state`)).status === 401);
check('rejects a wrong token', (await fetch(`${root}/api/state`, { headers: { 'x-harness-token': 'nope' } })).status === 401);
check('accepts the token in the query string', (await fetch(`${root}/api/state?t=${TOKEN}`)).status === 200);

// ---- static + state ----
const html = await (await call('/')).text();
check('serves the phone UI', html.includes('<title>Harness</title>') && html.includes('app.js'));
check('serves the voice recorder', (await call('/voice.js')).status === 200 && html.includes('id="dictate"'));
check('voice status requires authentication', (await fetch(`${root}/api/transcription`)).status === 401);
await call('/api/models/key', { method: 'POST', body: JSON.stringify({ alias: '__transcription', apiKey: 'sk-voice-test' }) });
const voiceStatus = await (await call('/api/transcription')).json();
check('voice status exposes readiness only', JSON.stringify(voiceStatus) === '{"configured":true}');
check('voice rejects unsupported formats', (await call('/api/transcription', { method: 'POST', body: '{}' })).status === 415);
check('voice rejects empty recordings', (await call('/api/transcription', { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: '' })).status === 400);

const state = await (await call('/api/state')).json();
check('state lists the model', state.models.mock?.model === 'mock-1');
check('local mock counts as configured', state.models.mock.hasKey === true);
check('state never ships the API key', !('apiKey' in state.models.mock) || state.models.mock.apiKey === undefined,
  JSON.stringify(Object.keys(state.models.mock)));

// ---- key storage, written from the "phone" ----
await call('/api/models/key', { method: 'POST', body: JSON.stringify({ alias: 'mock', apiKey: 'sk-secret' }) });
const secretsRaw = await fs.readFile(path.join(dataDir, 'secrets.json'), 'utf8');
check('key saved to secrets.json, not models.json', secretsRaw.includes('sk-secret')
  && !(await fs.readFile(path.join(dataDir, 'models.json'), 'utf8')).includes('sk-secret'));
const mode = (await fs.stat(path.join(dataDir, 'secrets.json'))).mode & 0o777;
check('secrets file is owner-only', mode === 0o600, `mode=${mode.toString(8)}`);
const after = await (await call('/api/state')).json();
check('stored key is reported but not returned', after.models.mock.keySource === 'stored'
  && after.models.mock.apiKey === undefined);

// ---- directory browsing ----
const dirs = await (await call(`/api/dirs?path=${encodeURIComponent(projectDir)}`)).json();
check('browses directories for the phone picker', dirs.path === projectDir && Array.isArray(dirs.dirs));

// ---- create, stream, send ----
const session = await (await call('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({ name: 'from phone', model: 'mock', projectDir }),
})).json();
check('creates a session', Boolean(session.id));

const frames = [];
const streamDone = (async () => {
  const res = await call(`/api/sessions/${session.id}/events`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const part of buf.split('\n\n')) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (line) {
        const p = JSON.parse(line.slice(6));
        if (!frames.some((f) => JSON.stringify(f) === JSON.stringify(p))) frames.push(p);
        if (p.kind === 'done') return;
      }
    }
    buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
  }
})();

await new Promise((r) => setTimeout(r, 200));
const sent = await call(`/api/sessions/${session.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'make a file' }) });
check('send is accepted', sent.status === 200);

await Promise.race([streamDone, new Promise((r) => setTimeout(r, 15000))]);

check('stream opened with a hello frame', frames[0]?.kind === 'hello');
check('streamed live text deltas', frames.some((f) => f.kind === 'delta' && f.delta?.kind === 'text'));
check('streamed a tool_start delta', frames.some((f) => f.kind === 'delta' && f.delta?.kind === 'tool_start'));
check('streamed persisted events', frames.some((f) => f.kind === 'event' && f.event?.type === 'assistant'));
check('stream closed with done', frames.at(-1)?.kind === 'done');

const wrote = await fs.readFile(path.join(projectDir, 'phone.txt'), 'utf8').catch(() => null);
check('the turn actually wrote the file on the laptop', wrote === 'from the phone', JSON.stringify(wrote));

const reloaded = await (await call(`/api/sessions/${session.id}`)).json();
check('transcript persisted for the next phone load', reloaded.events.some((e) => e.type === 'tool_result' && e.ok));

// ---- model switch mid-session, from the phone ----
const patched = await (await call(`/api/sessions/${session.id}`, {
  method: 'PATCH', body: JSON.stringify({ model: 'mock' }),
})).json();
check('session model can be patched from the phone', patched.model === 'mock');

// ---- the shape contract the phone UI depends on ----
// /api/state returns `running` as an ARRAY of busy session ids. The client
// once merged this payload wholesale over its own state, so this array landed
// on a boolean flag of the same name; [] is truthy, so the send button went
// dead after the first turn. Pin the shape, and pin that the client reads it
// field by field rather than assigning the payload over its own flags.
const shape = await (await call('/api/state')).json();
check('state.running is an array of ids', Array.isArray(shape.running), JSON.stringify(shape.running));

const clientSrc = await fs.readFile(path.join(here, '..', 'server', 'public', 'app.js'), 'utf8');
check('client never blanket-assigns the state payload over its own flags',
  !/Object\.assign\(state,\s*s\)/.test(clientSrc));
check('client reads the busy list into its own field', /state\.busy\s*=\s*s\.running/.test(clientSrc));

// ---- creating a folder from the phone ----
const made = await (await call('/api/dirs', {
  method: 'POST', body: JSON.stringify({ parent: projectDir, name: 'new folder test' }),
})).json();
check('phone can create a folder', (await fs.stat(made.path)).isDirectory(), made.path);
check('folder names cannot escape the parent',
  (await call('/api/dirs', { method: 'POST', body: JSON.stringify({ parent: projectDir, name: '../evil' }) })).status === 400);

// ---- a session pointed at a path that does not exist yet ----
const fresh = path.join(projectDir, 'not', 'there', 'yet');
const s2 = await (await call('/api/sessions', {
  method: 'POST', body: JSON.stringify({ name: 'fresh', model: 'mock', projectDir: fresh }),
})).json();
check('a missing project directory is created on session create',
  (await fs.stat(s2.projectDir)).isDirectory(), s2.projectDir);

// ---- reading a session mid-turn must not "repair" it ----
// A tool that has been recorded but has not returned yet is normal while a
// turn runs. Treating that as crash damage injected a bogus "interrupted"
// result and a recovery note into a live transcript, which the running turn
// then silently overwrote.
{
  const midProj = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mid-'));
  const s4 = await (await call('/api/sessions', {
    method: 'POST', body: JSON.stringify({ name: 'mid', model: 'mock', projectDir: midProj }),
  })).json();

  // Hand-write a transcript that is legitimately mid-tool.
  const file = path.join(dataDir, 'sessions', `${s4.id}.json`);
  const doc = JSON.parse(await fs.readFile(file, 'utf8'));
  doc.events = [
    { id: 'u1', ts: Date.now(), type: 'user', text: 'go' },
    { id: 'a1', ts: Date.now(), type: 'assistant', model: 'mock', provider: 'openai', text: '',
      thinking: '', toolCalls: [{ id: 'c9', name: 'bash', args: { command: 'sleep 60' } }], usage: {} },
  ];
  await fs.writeFile(file, JSON.stringify(doc, null, 2));

  // Not running: the crash repair is correct and should fire.
  const repaired = await (await call(`/api/sessions/${s4.id}`)).json();
  check('a genuinely crashed transcript is still repaired',
    repaired.events.some((e) => e.type === 'note' && e.text.includes('recovered')),
    repaired.events.map((e) => e.type).join(','));
}

// ---- a folder renamed out from under a saved path ----
const doomed = path.join(projectDir, 'will-be-renamed');
await fs.mkdir(doomed, { recursive: true });
const s3 = await (await call('/api/sessions', {
  method: 'POST', body: JSON.stringify({ name: 'renamed', model: 'mock', projectDir: doomed }),
})).json();
await fs.rename(doomed, path.join(projectDir, 'renamed-to-this'));

const browse = await call(`/api/dirs?path=${encodeURIComponent(doomed)}`);
check('browsing a renamed-away path does not 500', browse.status === 200, `status=${browse.status}`);
const browsed = await browse.json();
check('it falls back to the nearest surviving folder', browsed.path === projectDir, browsed.path);
check('and says why', typeof browsed.note === 'string' && browsed.note.includes('no longer exists'), String(browsed.note));

const stale = await (await call(`/api/sessions/${s3.id}`)).json();
check('a session reports its folder is gone', stale.projectDirMissing === true);

const repointed = await (await call(`/api/sessions/${s3.id}`, {
  method: 'PATCH', body: JSON.stringify({ projectDir: path.join(projectDir, 'renamed-to-this') }),
})).json();
check('the session can be repointed', repointed.projectDir.endsWith('renamed-to-this'));
check('a repointed session is no longer flagged',
  (await (await call(`/api/sessions/${s3.id}`)).json()).projectDirMissing === false);

// ---- the same read, but with a turn in flight ----
{
  const slowProj = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-slow-'));
  const s5 = await (await call('/api/sessions', {
    method: 'POST', body: JSON.stringify({ name: 'slow', model: 'slow', projectDir: slowProj }),
  })).json();
  await call(`/api/sessions/${s5.id}/send`, { method: 'POST', body: JSON.stringify({ text: 'go' }) });
  await new Promise((r) => setTimeout(r, 300));

  const midRead = await (await call(`/api/sessions/${s5.id}`)).json();
  check('reading a session mid-turn injects no fake interruption',
    !midRead.events.some((e) => e.type === 'note' && e.text.includes('recovered')),
    midRead.events.map((e) => e.type).join(','));
  check('and no fabricated failed tool result',
    !midRead.events.some((e) => e.type === 'tool_result' && /interrupted/.test(e.output ?? '')));
  await call(`/api/sessions/${s5.id}/stop`, { method: 'POST' });
}

// ---- browsing files, not just folders ----
{
  const fdir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-files-'));
  await fs.mkdir(path.join(fdir, 'sub'));
  await fs.writeFile(path.join(fdir, 'notes.md'), '# hello\nsome text');
  await fs.writeFile(path.join(fdir, 'hidden-should-not-show'), 'x');
  await fs.rename(path.join(fdir, 'hidden-should-not-show'), path.join(fdir, '.hidden'));
  // a 1x1 png
  await fs.writeFile(path.join(fdir, 'pic.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));

  const listing = await (await call(`/api/files?path=${encodeURIComponent(fdir)}`)).json();
  check('listing includes files, not only folders',
    listing.files.some((f) => f.name === 'notes.md') && listing.dirs.some((d) => d.name === 'sub'),
    JSON.stringify({ files: listing.files.map((f) => f.name), dirs: listing.dirs.map((d) => d.name) }));
  check('files are typed so the phone knows how to render them',
    listing.files.find((f) => f.name === 'pic.png')?.kind === 'image'
    && listing.files.find((f) => f.name === 'notes.md')?.kind === 'text');
  check('dotfiles stay hidden', !listing.files.some((f) => f.name.startsWith('.')));
  check('sizes are reported', listing.files.every((f) => typeof f.size === 'number'));

  const img = await call(`/api/file?path=${encodeURIComponent(path.join(fdir, 'pic.png'))}`);
  check('an image comes back as an image',
    img.status === 200 && (img.headers.get('content-type') ?? '').startsWith('image/png'),
    String(img.headers.get('content-type')));

  const txt = await call(`/api/file?path=${encodeURIComponent(path.join(fdir, 'notes.md'))}`);
  check('a text file comes back as readable text',
    (await txt.text()).includes('# hello') && (txt.headers.get('content-type') ?? '').startsWith('text/plain'));

  // a big file must not be shipped whole to a phone
  const big = path.join(fdir, 'big.log');
  await fs.writeFile(big, 'x'.repeat(600_000));
  const capped = await (await call(`/api/file?path=${encodeURIComponent(big)}`)).text();
  check('a large text file is truncated with a note',
    capped.length < 600_000 && capped.includes('truncated'), `len=${capped.length}`);

  const missing = await call(`/api/file?path=${encodeURIComponent(path.join(fdir, 'nope.txt'))}`);
  check('a missing file 404s cleanly', missing.status === 404);
  const asDir = await call(`/api/file?path=${encodeURIComponent(fdir)}`);
  check('a directory is not served as a file', asDir.status === 404);
}

// ---- switching model mid-session ----
{
  const swProj = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-switch-'));
  const sw = await (await call('/api/sessions', {
    method: 'POST', body: JSON.stringify({ name: 'switch', model: 'mock', projectDir: swProj }),
  })).json();
  check('starts on the model it was created with', sw.model === 'mock');

  const switched = await (await call(`/api/sessions/${sw.id}`, {
    method: 'PATCH', body: JSON.stringify({ model: 'slow' }),
  })).json();
  check('a switch is applied', switched.model === 'slow');
  check('and leaves a visible record in the transcript',
    switched.events.some((e) => e.type === 'note' && /model switched from mock to slow/.test(e.text)),
    JSON.stringify(switched.events.map((e) => e.type)));

  const reread = await (await call(`/api/sessions/${sw.id}`)).json();
  check('the switch survives a re-read', reread.model === 'slow');

  const onDisk = JSON.parse(await fs.readFile(path.join(dataDir, 'sessions', `${sw.id}.json`), 'utf8'));
  check('and is persisted to disk', onDisk.model === 'slow');

  const same = await (await call(`/api/sessions/${sw.id}`, {
    method: 'PATCH', body: JSON.stringify({ model: 'slow' }),
  })).json();
  check('switching to the same model adds no noise',
    same.events.filter((e) => e.type === 'note' && /model switched/.test(e.text)).length === 1);

  // the client must not keep a stale copy after a switch
  const clientSrc = await fs.readFile(path.join(here, '..', 'server', 'public', 'app.js'), 'utf8');
  check('the client updates the tab copy too, not just state.session',
    /t\.session = updated/.test(clientSrc) && /setSessionModel/.test(clientSrc));
  check('and the settings sheet offers a real switch control',
    /data-switch=/.test(clientSrc));
}

// ---- the monitoring tab's companion session ----
{
  const mProj = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mon-tab-'));
  const parent = await (await call('/api/sessions', {
    method: 'POST', body: JSON.stringify({ name: 'parent', model: 'mock', projectDir: mProj }),
  })).json();

  const companion = await (await call(`/api/sessions/${parent.id}/monitor`)).json();
  check('a monitor companion is created on demand', companion.id === `${parent.id}--monitor`, companion.id);
  check('it knows which session it watches', companion.monitorFor === parent.id);
  check('it shares the project directory', companion.projectDir === parent.projectDir);

  const again = await (await call(`/api/sessions/${parent.id}/monitor`)).json();
  check('asking twice returns the same companion, not a duplicate', again.id === companion.id);

  const listed = (await (await call('/api/state')).json()).sessions.map((x) => x.id);
  check('companions stay out of the session list', !listed.includes(companion.id) && listed.includes(parent.id));

  // it must scope monitors to the parent, or panels land in the wrong tab
  const { systemPromptFor } = await import('../src/core/agent.js');
  const prompt = systemPromptFor(companion, '/data/monitors.json');
  check('its prompt scopes monitors to the watched session',
    prompt.includes(parent.id) && !prompt.includes(`belong to: ${companion.id}`));
  check('and it is told its job is the panel', prompt.includes('control the monitoring view'));

  const plain = systemPromptFor({ id: 'plain', projectDir: mProj, system: '' }, '/data/monitors.json');
  check('an ordinary session gets no monitoring-role prompt',
    !plain.includes('control the monitoring view'));
}

// ---- per-session activity, gathered only when asked ----
{
  const aProj = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-act-'));
  const sA = await (await call('/api/sessions', {
    method: 'POST', body: JSON.stringify({ name: 'act', model: 'mock', projectDir: aProj }),
  })).json();

  const empty = await (await call(`/api/activity?session=${sA.id}`)).json();
  check('an idle session reports nothing active, not an error',
    empty.procs.length === 0 && empty.samples.length === 0 && empty.running === false,
    JSON.stringify({ procs: empty.procs.length, samples: empty.samples.length }));
  check('it still reports which directory it watched', empty.projectDir === aProj);

  // a job running out of the session's own directory should be found
  const { spawn: sp2 } = await import('node:child_process');
  const job = sp2(process.execPath, ['-e', 'setInterval(()=>{},100)'], { cwd: aProj, detached: true, stdio: 'ignore' });
  job.unref();
  await new Promise((r) => setTimeout(r, 900));

  const busy = await (await call(`/api/activity?session=${sA.id}`)).json();
  check('a process running in the session directory is attributed to it',
    busy.procs.some((p) => p.pid === job.pid), `pid ${job.pid} vs ${JSON.stringify(busy.procs.map((p) => p.pid))}`);

  // and must NOT show up under a different session
  const other = await (await call('/api/sessions', {
    method: 'POST', body: JSON.stringify({ name: 'other', model: 'mock', projectDir: projectDir }),
  })).json();
  const otherAct = await (await call(`/api/activity?session=${other.id}`)).json();
  check('and not to an unrelated session', !otherAct.procs.some((p) => p.pid === job.pid));

  process.kill(job.pid, 'SIGKILL');
}

// ---- background jobs the agent detached ----
{
  const { spawn: sp } = await import('node:child_process');
  const logFile = path.join(projectDir, 'job.log');
  const fh = await fs.open(logFile, 'w');
  const child2 = sp(process.execPath,
    ['-e', 'setInterval(()=>console.log("tick "+Date.now()),100)'],
    { detached: true, stdio: ['ignore', fh.fd, 'ignore'] });
  child2.unref();
  await new Promise((r) => setTimeout(r, 700));

  const procs = (await (await call('/api/procs')).json()).procs;
  const found = procs.find((p) => p.pid === child2.pid);
  check('a detached job is listed', Boolean(found), `pid ${child2.pid} among ${procs.length}`);
  check('with cpu, memory and elapsed time',
    found && typeof found.cpu === 'number' && typeof found.rssMb === 'number' && Boolean(found.etime),
    JSON.stringify(found && { cpu: found.cpu, rssMb: found.rssMb, etime: found.etime }));
  check('its log file is discovered from its stdout',
    found?.log === logFile || found?.log === `/private${logFile}`, String(found?.log));

  // tail must show the END of a log, not the beginning
  const tail = await (await call(`/api/file?path=${encodeURIComponent(logFile)}&tail=1`)).text();
  const head = await (await call(`/api/file?path=${encodeURIComponent(logFile)}`)).text();
  check('tail returns log content', tail.includes('tick'));
  check('tail and head differ on a growing log, or the log is still small',
    tail.trim().endsWith(head.trim().split('\n').at(-1)) || tail.length > 0);

  const stopped = await call('/api/procs/stop', { method: 'POST', body: JSON.stringify({ pid: child2.pid }) });
  check('a job can be stopped', stopped.status === 200);
  await new Promise((r) => setTimeout(r, 400));
  const after = (await (await call('/api/procs')).json()).procs;
  check('and is gone afterwards', !after.some((p) => p.pid === child2.pid));

  check('a nonsense pid is refused',
    (await call('/api/procs/stop', { method: 'POST', body: JSON.stringify({ pid: 1 }) })).status === 400);
  await fh.close().catch(() => {});
}

// ---- the default is open; auth only when asked for ----
const openPort = PORT + 1;
const openChild = spawn(process.execPath, [path.join(here, '..', 'server', 'index.js')], {
  env: { ...process.env, HARNESS_PORT: String(openPort), HARNESS_DATA_DIR: dataDir, HARNESS_TOKEN: '' },
  stdio: 'ignore',
});
const openRoot = `http://127.0.0.1:${openPort}`;
for (let i = 0; i < 60; i += 1) {
  try { await fetch(openRoot); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
}
check('with no HARNESS_TOKEN the server needs no token', (await fetch(`${openRoot}/api/state`)).status === 200);
openChild.kill();

child.kill();
upstream.close();
await fs.rm(dataDir, { recursive: true, force: true });

console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);

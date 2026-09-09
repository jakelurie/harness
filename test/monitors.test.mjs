// Monitoring must be data, not code: a new kind of job should be watchable
// without touching the harness.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadMonitors, sample, sampleAll, upsertMonitor, removeMonitor } from '../src/core/monitors.js';
import { systemPromptFor } from '../src/core/agent.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-mon-'));

check('no monitors file is an empty list, not a crash', (await loadMonitors(dir)).length === 0);

// command: the catch-all that covers anything with a CLI
await upsertMonitor(dir, { id: 'disk', label: 'Disk', kind: 'command', command: 'echo FREE=42' });
const cmd = await sample((await loadMonitors(dir))[0]);
check('a command monitor runs and returns output', cmd.ok && cmd.text.includes('FREE=42'), JSON.stringify(cmd.text));

// file: tail a log
const log = path.join(dir, 'a.log');
await fs.writeFile(log, `${'old\n'.repeat(5000)}NEWEST LINE\n`);
await upsertMonitor(dir, { id: 'log', label: 'Log', kind: 'file', path: log });
const fileSample = await sample({ id: 'log', kind: 'file', path: log });
check('a file monitor shows the end of the log', fileSample.text.includes('NEWEST LINE'));
check('and does not ship the whole file', fileSample.text.length <= 8000, String(fileSample.text.length));

// process
await upsertMonitor(dir, { id: 'self', label: 'This node', kind: 'process', match: 'node' });
const proc = await sample({ id: 'self', kind: 'process', match: 'node' });
check('a process monitor counts matches', proc.ok && proc.count > 0, `count=${proc.count}`);
const absent = await sample({ id: 'x', kind: 'process', match: 'definitely-not-a-real-process-xyz' });
check('an absent process reports not running', absent.count === 0 && absent.text === 'not running');

// http
const srv = http.createServer((_q, r) => { r.writeHead(200); r.end('HEALTHY'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const httpSample = await sample({ id: 'h', kind: 'http', url: `http://127.0.0.1:${srv.address().port}/` });
check('an http monitor reports status and body', httpSample.ok && httpSample.status === 200 && httpSample.text === 'HEALTHY');
srv.close();

// failure isolation
const broken = await sample({ id: 'b', kind: 'file', path: '/nope/nothing' });
check('a broken monitor reports instead of throwing', broken.ok === false && Boolean(broken.error));
const unknown = await sample({ id: 'u', kind: 'quantum' });
check('an unknown kind is reported, not fatal', unknown.ok === false && unknown.error.includes('quantum'));

const all = await sampleAll(await loadMonitors(dir));
check('all monitors sample together', all.length === 3);

await removeMonitor(dir, 'log');
check('a monitor can be removed', (await loadMonitors(dir)).length === 2);

// the agent has to be told it can do this, or it never will
const prompt = systemPromptFor(
  { projectDir: '/tmp/x', confineToProjectDir: true, system: '' }, '/data/monitors.json',
);
check('the system prompt teaches the agent to register monitors',
  prompt.includes('monitors file') || prompt.includes('Monitors file'));
// The full manual is the companion's, not every session's - spelling out every
// kind in each ordinary session cost ~580 tokens a turn for nothing.
const companionPrompt = systemPromptFor(
  { id: 's--monitor', monitorFor: 's', projectDir: '/tmp/x', system: '' }, '/data/monitors.json', 'CMD',
);
check('the companion documents every kind',
  ['command', 'file', 'process', 'http'].every((k) => companionPrompt.includes(`"${k}"`)));
check('an ordinary session gets a pointer, not the manual',
  !prompt.includes('"command"') && /monitors file/i.test(prompt),
  `${prompt.length} chars`);
check('without a monitors file the prompt stays clean',
  !systemPromptFor({ projectDir: '/tmp/x', system: '' }).includes('Monitors file'));

// ---- the agent building its own UI ----
await upsertMonitor(dir, {
  id: 'crawl-ui', label: 'Crawl', kind: 'panel', session: 'sess-1',
  command: 'printf "<table><tr><th>done</th><td>37/291</td></tr></table>"',
});
const panel = await sample({ id: 'crawl-ui', kind: 'panel', command: 'printf "<b>hi</b>"' });
check('a panel monitor returns renderable html', panel.ok && panel.html === '<b>hi</b>', String(panel.html));

// ---- a view takes over the whole panel ----
await upsertMonitor(dir, {
  id: 'the-view', label: 'Session view', kind: 'panel', role: 'view', session: 'sess-1',
  command: 'printf "<h3>mine</h3><button data-stop=\"123\">stop</button>"',
});
const viewSample = await sample((await loadMonitors(dir, { session: 'sess-1' })).find((m) => m.id === 'the-view'));
check('a view sample is flagged as the whole surface', viewSample.role === 'view', String(viewSample.role));
check('and carries its html', viewSample.html.includes('<h3>mine</h3>'));
check('it can keep the interactive controls', viewSample.html.includes('data-stop'));
const plainPanel = await sample({ id: 'p2', kind: 'panel', command: 'printf hi' });
check('an ordinary panel is not a view', plainPanel.role === null, String(plainPanel.role));

// ---- per-session scoping ----
await upsertMonitor(dir, { id: 'other', label: 'Other', kind: 'command', command: 'echo x', session: 'sess-2' });
const forOne = await loadMonitors(dir, { session: 'sess-1' });
check('a session sees its own monitors', forOne.some((m) => m.id === 'crawl-ui'));
check('and not another session\'s', !forOne.some((m) => m.id === 'other'),
  JSON.stringify(forOne.map((m) => m.id)));
check('global monitors show in every session', forOne.some((m) => m.id === 'disk'));
check('unscoped listing returns everything', (await loadMonitors(dir)).length >= 4);

const scoped = await sample(forOne.find((m) => m.id === 'crawl-ui'));
check('a sample carries its session so the UI can place it', scoped.session === 'sess-1');
const globalSample = await sample(forOne.find((m) => m.id === 'disk'));
check('a global monitor has no session', globalSample.session === null);

// the companion must be told about both, or it cannot use them
const p2 = systemPromptFor(
  { id: 'sess-9--monitor', monitorFor: 'sess-9', projectDir: '/tmp/x', system: '' },
  '/data/monitors.json', 'CMD',
);
check('the prompt explains panels', p2.includes('"panel"') && p2.includes('PRINTS HTML'));

// the monitor companion must be told it can own the surface, and how
const mp = systemPromptFor(
  { id: 'sess-9--monitor', monitorFor: 'sess-9', projectDir: '/tmp/x', system: '' },
  '/data/monitors.json',
  'curl -s http://127.0.0.1:8787/api/activity?session=sess-9',
);
check('the companion is told how to take over the view', mp.includes('"role":"view"'));
check('it is given the activity command rather than told to reinvent it',
  mp.includes('curl -s http://127.0.0.1:8787/api/activity?session=sess-9')
  && !mp.includes('ACTIVITY_CMD'));
check('it is told the button attributes survive',
  mp.includes('data-log=') && mp.includes('data-stop='));
check('and how to hand the panel back', mp.includes('hand the panel back'));
check('the prompt gives the watched session id for scoping', p2.includes('sess-9'));

await fs.rm(dir, { recursive: true, force: true });
console.log(`\n${fail.length ? `${fail.length} FAILED` : 'all green'}`);
process.exit(fail.length ? 1 : 0);

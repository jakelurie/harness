// Apps are the durable things: a session comes and goes, an app survives a
// reboot with its directory, repo, port and both of its addresses.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import * as apps from '../src/core/apps.js';
import { HARNESS_ROOT } from '../src/core/harness-guard.js';

const fail = [];
const check = (label, cond, extra = '') => {
  if (!cond) fail.push(label);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
};

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'apps-'));
const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'proj-'));

check('no apps to begin with', (await apps.load(data)).length === 0);

const a = await apps.create(data, { name: 'Job Applier', dir: proj, start: 'echo hi' });
check('an app gets an id', Boolean(a.id), a.id);
check('and its own app port', a.port >= 4300 && a.port <= 4399, String(a.port));
check('and its own publish port', a.servePort >= 8443, String(a.servePort));
check('never the harness port', a.port !== 8787 && a.servePort !== 8787);

const b = await apps.create(data, { name: 'Second', dir: `${proj}-two`, start: '' });
check('a second app gets different ports', b.port !== a.port && b.servePort !== a.servePort,
  `${a.port}/${a.servePort} vs ${b.port}/${b.servePort}`);

// ---- it must survive the process, which is the whole point
const reloaded = await apps.load(data);
check('apps persist to disk', reloaded.length === 2);
check('with their ports intact', reloaded.find((x) => x.id === a.id).port === a.port);

// ---- both addresses, always
const urls = apps.urlsFor(a, 'example-host.ts.net');
check('a phone address is published', urls.phone === `https://example-host.ts.net:${a.servePort}`, urls.phone);
check('a laptop address is too', urls.desktop === `http://127.0.0.1:${a.port}`, urls.desktop);
const noTs = apps.urlsFor(a, null);
check('with tailscale down, the laptop address still works', noTs.desktop && noTs.phone === null);

// ---- the harness protects itself here as well
let refused = false;
try { await apps.create(data, { name: 'evil', dir: HARNESS_ROOT }); } catch { refused = true; }
check('an app cannot be rooted on the harness', refused);
let dupe = false;
try { await apps.create(data, { name: 'again', dir: proj }); } catch { dupe = true; }
check('two apps cannot claim one directory', dupe);

// ---- ports can be corrected, but never onto the harness or another app
const patched = await apps.update(data, a.id, { name: 'Renamed', port: 4390 });
check('a rename sticks', patched.name === 'Renamed');
check('and a port can be corrected to a real one', patched.port === 4390, String(patched.port));

const refusals = [];
for (const patch of [{ port: 8787 }, { servePort: 443 }, { port: b.port }, { port: 99 }]) {
  try { await apps.update(data, a.id, patch); refusals.push(null); }
  catch (e) { refusals.push(e.message); }
}
check('the harness port is refused', /belongs to the harness/.test(refusals[0] ?? ''), refusals[0]);
check('so is 443', /belongs to the harness/.test(refusals[1] ?? ''), refusals[1]);
check("another app's port is refused", /already uses/.test(refusals[2] ?? ''), refusals[2]);
check('nonsense is refused', /not a usable port/.test(refusals[3] ?? ''), refusals[3]);
check('and none of that changed the app', (await apps.load(data)).find((x) => x.id === a.id).port === 4390);
await apps.update(data, a.id, { port: a.port });   // put it back for the run test

// ---- starting and stopping something real
const started = await apps.start(data, b.id).catch((e) => ({ error: e.message }));
check('an app with no start command refuses honestly', /no start command/.test(started.error ?? ''), started.error);

await apps.update(data, a.id, {
  start: `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.PORT)"`,
});
const run = await apps.start(data, a.id);
await new Promise((r) => { setTimeout(r, 1200); });
check('it is running', await apps.isRunning(run.app));
const res = await fetch(`http://127.0.0.1:${a.port}`).then((r) => r.text()).catch((e) => e.message);
check('and actually answering on its port', res === 'ok', res);

const listed = (await apps.listWithStatus(data)).find((x) => x.id === a.id);
check('the dashboard sees it as running', listed.running === true);

const stopped = await apps.stop(data, a.id);
check('stopping it is confirmed, not assumed', stopped.stopped === true && !stopped.unconfirmed);
check('and it is really gone', !(await apps.isRunning(run.app)));

await apps.remove(data, a.id);
check('deleting leaves the other app alone', (await apps.load(data)).length === 1);

await fs.rm(data, { recursive: true, force: true });
await fs.rm(proj, { recursive: true, force: true });
console.log(fail.length ? `\nFAILED: ${fail.join(', ')}` : '\nall green');
process.exit(fail.length ? 1 : 0);
